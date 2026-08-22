/**
 * THE FETCH ENGINE
 *
 * Takes validated source entries and turns them into verified bytes on disk,
 * plus the facts needed to write the lockfile.
 *
 * ── THE INTEGRITY CHAIN ────────────────────────────────────────────────────
 * Three independent claims have to agree before a file is accepted:
 *
 *   manifest.md5   what the committed manifest says the bytes are
 *   api.md5        what api.polyhaven.com says the bytes are, right now
 *   actual md5     what the bytes on disk actually hash to
 *
 * The API is the authority — it is the provider describing its own file — so
 * the actual md5 is checked against it. The manifest is checked against the
 * API too, but as *drift detection*: if Poly Haven reprocesses an asset the
 * manifest goes stale, and that deserves a loud warning rather than a silent
 * mismatch or a wrong-file download.
 *
 * ── FAILURE IS LOUD AND CLEAN ──────────────────────────────────────────────
 * An md5 mismatch deletes the blob, retries exactly once, and then fails the
 * build. It never keeps the bad bytes, and it never carries on with a
 * corrupt texture — a silently corrupt asset is far more expensive than a
 * failed build, because it surfaces as an inexplicable visual bug days later.
 *
 * ── WHY A WARM RUN COSTS NOTHING ───────────────────────────────────────────
 * The cache index remembers url -> {sha256, md5, bytes, mtimeMs}. A warm run
 * confirms the recorded md5 still matches the API, confirms the blob is
 * present at the right size AND with the mtime it was verified at, re-links
 * it if the materialised tree was cleaned, and moves on. No network, and no
 * re-hashing unless a blob has been written to since it was last checked.
 * Measured: 376 files / 1.65 GB in 0.6s. `--verify` forces a full re-hash of
 * everything (4.4s for the same 1.65 GB) when you want proof, not a claim.
 */

import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { SourceCache } from './cache.ts';
import { entryDigest, hashFile, sha256Of } from './hash.ts';
import { Limiter, downloadToFile } from './http.ts';
import type { Logger, ProgressTracker } from './log.ts';
import { SOURCE_DIR } from './paths.ts';
import { PolyHavenClient } from './polyhaven.ts';
import type {
  AnySourceEntry,
  IAssetLockFile,
  IFetchedEntry,
  IFetchedFile,
  ISourceFile,
} from './types.ts';

/** Scratch area for in-flight downloads, inside the ignored source tree. */
const TEMP_DIR = path.join(SOURCE_DIR, '.tmp');

/**
 * Content digest for one entry.
 *
 * Normally this is the sha256 fold over its member files. A PROCEDURAL entry
 * has no files, and folding an empty list would give every procedural entry
 * the identical digest of the empty string — which would then land in
 * `IAssetEntry.sha256` and make two distinct materials look like the same
 * content to any cache keyed on it. Their content is their spec, so that is
 * what gets hashed.
 */
function digestFor(entry: AnySourceEntry, files: readonly IFetchedFile[]): string {
  if (files.length > 0) {
    return entryDigest(files.map((f) => ({ sha256: f.sha256, path: f.file.path })));
  }
  const spec = entry.kind === 'material' ? entry.spec : undefined;
  return sha256Of(`procedural:${entry.id}:${JSON.stringify(spec ?? {})}`);
}

export class IntegrityError extends Error {
  constructor(
    readonly url: string,
    readonly expectedMd5: string,
    readonly actualMd5: string
  ) {
    super(
      `md5 mismatch for ${url}\n` +
        `      expected ${expectedMd5} (published by the provider)\n` +
        `      actual   ${actualMd5} (bytes on disk)`
    );
    this.name = 'IntegrityError';
  }
}

export class FrozenLockError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `--frozen: ${problems.length} file(s) are not satisfied by assets.lock.json:\n  - ` +
        problems.join('\n  - ')
    );
    this.name = 'FrozenLockError';
  }
}

export interface IFetcherOptions {
  readonly logger: Logger;
  readonly cache: SourceCache;
  readonly client: PolyHavenClient;
  readonly concurrency: number;
  /** Re-hash every cached blob instead of trusting the index. */
  readonly verify: boolean;
  /** Refuse to fetch anything absent from (or mismatched in) the lockfile. */
  readonly frozen: boolean;
  /** Existing lockfile, when one is on disk. */
  readonly lock?: IAssetLockFile;
  /** Resolve and verify, but transfer nothing. */
  readonly dryRun: boolean;
}

/** How the API described a file the manifest asked for. */
export interface IResolved {
  readonly file: ISourceFile;
  /** md5 the provider publishes right now. Falls back to the manifest's when
   *  the entry is procedural or the API has no opinion. */
  readonly apiMd5: string;
  readonly apiBytes: number;
  /** True when the API and the manifest disagree — the manifest is stale. */
  readonly drifted: boolean;
}

/** Every entry, cross-checked against the provider, before anything transfers. */
export interface IResolvedPlan {
  readonly entries: readonly { entry: AnySourceEntry; files: readonly IResolved[] }[];
  /** Bytes the provider currently reports for everything in the plan. */
  readonly totalBytes: number;
  readonly totalFiles: number;
  /** Files whose manifest md5/bytes no longer match the API. */
  readonly drifted: number;
}

export class Fetcher {
  private readonly limiter: Limiter;
  /** Separate, narrower pool for API metadata so 84 entries do not open 84
   *  sockets to api.polyhaven.com the moment the run starts. */
  private readonly apiLimiter: Limiter;
  private readonly warnings: string[] = [];
  /** Set by `fetchPlan` on the first failure; read by every queued `acquire`. */
  private cancelled = false;

  constructor(private readonly options: IFetcherOptions) {
    this.limiter = new Limiter(options.concurrency);
    this.apiLimiter = new Limiter(Math.min(options.concurrency, 6));
  }

  get warningLog(): readonly string[] {
    return this.warnings;
  }

  /* ---------------------------------------------------------------------- */
  /* Resolution                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Cross-check every declared file against the live provider API.
   *
   * Runs before any transfer so a stale manifest is reported in one batch
   * instead of one failure per gigabyte.
   */
  async resolve(entry: AnySourceEntry): Promise<IResolved[]> {
    if (entry.provider !== 'polyhaven' || entry.files.length === 0) {
      return entry.files.map((file) => ({
        file,
        apiMd5: file.md5,
        apiBytes: file.bytes,
        drifted: false,
      }));
    }

    const files = await this.options.client.files(entry.providerAssetId);
    // Flatten every {url, size, md5} the API published for this asset, including
    // the nested `include` maps on glTF entries, and index it by URL. Matching
    // on URL sidesteps the shape differences between textures, models and HDRIs.
    //
    // `size` is guarded exactly as hard as `url` and `md5`: a missing or
    // non-numeric one used to coerce to NaN, and NaN poisons everything it
    // touches — `NaN !== bytes` reports a fresh manifest as STALE, `totalBytes`
    // becomes NaN so the whole progress line reads `?`, and the size check in
    // `downloadToFile` fails a perfect download three times before the build
    // dies quoting "manifest declares NaN".
    const byUrl = new Map<string, { md5: string; size: number | undefined }>();
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      if (typeof record.url === 'string' && typeof record.md5 === 'string') {
        const size = Number(record.size);
        byUrl.set(record.url, {
          md5: record.md5,
          size: Number.isFinite(size) && size > 0 ? size : undefined,
        });
      }
      for (const value of Object.values(record)) walk(value);
    };
    walk(files);

    return entry.files.map((file) => {
      const published = byUrl.get(file.url);
      if (!published) {
        this.warnings.push(
          `${entry.id}: ${file.key} — url is not in the current /files/${entry.providerAssetId} ` +
            `response; falling back to the manifest md5 (${file.url})`
        );
        return { file, apiMd5: file.md5, apiBytes: file.bytes, drifted: false };
      }
      if (published.size === undefined) {
        this.warnings.push(
          `${entry.id}: ${file.key} — the API published no usable size for ${file.url}; ` +
            `using the manifest's ${file.bytes} bytes. The md5 still comes from the API.`
        );
      }
      const apiBytes = published.size ?? file.bytes;
      const drifted = published.md5 !== file.md5 || apiBytes !== file.bytes;
      if (drifted) {
        this.warnings.push(
          `${entry.id}: ${file.key} — MANIFEST IS STALE. api md5=${published.md5} ` +
            `bytes=${apiBytes}, manifest md5=${file.md5} bytes=${file.bytes}. ` +
            `The API value wins; regenerate the manifest.`
        );
      }
      return { file, apiMd5: published.md5, apiBytes, drifted };
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Per-file acquisition                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Enforce `--frozen` across the whole plan at once.
   *
   * Reporting every offending URL in one error beats failing on the first and
   * making the caller re-run to discover the second.
   */
  assertFrozen(plan: IResolvedPlan): void {
    if (!this.options.frozen) return;
    const lock = this.options.lock;
    const problems: string[] = [];
    if (!lock) {
      throw new FrozenLockError(['assets.lock.json does not exist — nothing is locked']);
    }
    for (const { entry, files } of plan.entries) {
      for (const resolved of files) {
        const record = lock.files[resolved.file.url];
        if (!record) {
          problems.push(`${entry.id}: ${resolved.file.url} is absent from assets.lock.json`);
        } else if (record.md5 !== resolved.apiMd5) {
          problems.push(
            `${entry.id}: ${resolved.file.url} md5 ${resolved.apiMd5} does not match locked ${record.md5}`
          );
        } else if (record.bytes !== resolved.apiBytes) {
          problems.push(
            `${entry.id}: ${resolved.file.url} is ${resolved.apiBytes} bytes, locked at ${record.bytes}`
          );
        }
      }
    }
    if (problems.length > 0) throw new FrozenLockError(problems);
  }

  /**
   * Get one file into the CAS, verified.
   *
   * Fast path: the index already knows this URL, the recorded md5 matches what
   * the API publishes, and the blob is on disk at the right size. Nothing is
   * transferred and nothing is re-hashed.
   */
  private async acquire(
    entryId: string,
    resolved: IResolved,
    progress: ProgressTracker
  ): Promise<IFetchedFile> {
    const { file, apiMd5, apiBytes } = resolved;
    const label = path.basename(file.path);
    const log = this.options.logger;
    const cache = this.options.cache;

    // An earlier file already failed the run. Everything still queued behind it
    // is wasted bandwidth whose bookkeeping would land after the caller has
    // saved the cache index, so it never starts.
    if (this.cancelled) {
      throw new Error(`${entryId}: ${label} was not started — an earlier file failed`);
    }
    progress.start(label);

    const known = cache.lookup(file.url);

    // `--dry-run` reports; it does not write. This has to sit AHEAD of the
    // cache fast path below, which materialises files, rewrites the index and
    // can evict a blob — none of which belongs in a run whose banner says
    // "nothing will be transferred". `checkBlob` is read-only, so the report
    // stays honest about what is and is not already cached.
    if (this.options.dryRun) {
      let cached = false;
      if (known && known.md5 === apiMd5) {
        const check = await cache.checkBlob(known.sha256, known.bytes, {
          deep: this.options.verify,
          expectedMtimeMs: known.mtimeMs,
        });
        cached = check.state === 'ok';
      }
      progress.finish(label, apiBytes, cached);
      return {
        file,
        sha256: cached && known ? known.sha256 : `dry-run:${apiMd5}`,
        md5: apiMd5,
        bytes: cached && known ? known.bytes : apiBytes,
        cached,
        transferred: 0,
      };
    }

    if (known && known.md5 === apiMd5) {
      const check = await cache.checkBlob(known.sha256, known.bytes, {
        deep: this.options.verify,
        expectedMtimeMs: known.mtimeMs,
      });
      if (check.state === 'ok') {
        await cache.materialize(known.sha256, file.path, known.bytes);
        // The blob was re-hashed (either --verify, or its mtime had moved and
        // it still checked out). Re-baseline the mtime so the next run does
        // not pay for the same re-hash again.
        if (check.hashed && check.mtimeMs !== known.mtimeMs) {
          cache.record(file.url, { ...known, mtimeMs: check.mtimeMs });
        }
        progress.finish(label, apiBytes, true);
        return {
          file,
          sha256: known.sha256,
          md5: known.md5,
          bytes: known.bytes,
          cached: true,
          transferred: 0,
        };
      }
      log.warn(`${entryId}: cached blob for ${label} is ${check.state}; re-fetching`);
      cache.forget(file.url);
      await cache.evict(known.sha256);
    }

    // The scratch name is keyed on the FILE, not on its content. Two entries
    // may legitimately declare the same URL — Poly Haven serves one `.bin` for
    // every resolution of a model — and an md5-keyed name would have both
    // downloads streaming into the same `.part`, interleaving two byte streams
    // and surfacing as a bogus md5 mismatch or an ENOENT rename. It still has
    // to be STABLE across runs, or the Range resume never finds its partial.
    const scratch = sha256Of(`${entryId}::${file.path}`).slice(0, 32);

    // Download, verify, and on a mismatch destroy the evidence and try once
    // more — a single retry distinguishes a flaky transfer from a genuinely
    // wrong file, and anything beyond that is just slow failure.
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await mkdir(TEMP_DIR, { recursive: true });
      const temp = path.join(TEMP_DIR, `${scratch}-${attempt}.part`);
      const result = await downloadToFile(file.url, temp, {
        expectedBytes: apiBytes,
        // The retry exists because the bytes were WRONG, and when the first
        // attempt resumed a partial left by an earlier run the bad bytes may
        // be in that retained prefix. Scratch partials now survive a failed
        // run (that is what makes resume work at all), so the retry has to
        // refuse them or it reproduces the same mismatch forever.
        resume: attempt > 1 ? false : undefined,
        onProgress: (delta) => progress.advance(delta),
        onRetry: (n, delay, error) =>
          log.warn(
            `${entryId}: ${label} attempt ${n} failed (${error.message}); retry in ${delay}ms`
          ),
      });

      const digests = await hashFile(temp);
      if (digests.md5 !== apiMd5) {
        await rm(temp, { force: true });
        lastError = new IntegrityError(file.url, apiMd5, digests.md5);
        if (attempt === 1) {
          log.warn(`${entryId}: md5 mismatch on ${label}; blob deleted, retrying once`);
          continue;
        }
        break;
      }

      const stored = await cache.store(temp, digests.sha256);
      await cache.materialize(digests.sha256, file.path, digests.bytes);
      cache.record(file.url, {
        sha256: digests.sha256,
        md5: digests.md5,
        bytes: digests.bytes,
        fetchedAt: new Date().toISOString(),
        mtimeMs: stored.mtimeMs,
      });
      progress.finish(label, apiBytes, false);
      return {
        file,
        sha256: digests.sha256,
        md5: digests.md5,
        bytes: digests.bytes,
        cached: false,
        transferred: result.transferred,
      };
    }

    throw lastError ?? new Error(`${entryId}: ${label} failed for an unknown reason`);
  }

  /* ---------------------------------------------------------------------- */
  /* Entry acquisition                                                      */
  /* ---------------------------------------------------------------------- */

  /**
   * PHASE 1 — cross-check every entry against the provider API.
   *
   * Deliberately a separate pass: a stale manifest, a dead URL or a frozen-lock
   * violation is then reported in one batch, before a single byte moves.
   */
  async resolveAll(entries: readonly AnySourceEntry[]): Promise<IResolvedPlan> {
    const resolvedEntries = await Promise.all(
      entries.map((entry) =>
        this.apiLimiter.run(async () => ({ entry, files: await this.resolve(entry) }))
      )
    );
    let totalBytes = 0;
    let totalFiles = 0;
    let drifted = 0;
    for (const { files } of resolvedEntries) {
      for (const file of files) {
        totalBytes += file.apiBytes;
        totalFiles += 1;
        if (file.drifted) drifted += 1;
      }
    }
    return { entries: resolvedEntries, totalBytes, totalFiles, drifted };
  }

  /**
   * PHASE 2 — acquire every file in the plan.
   *
   * All files queue on ONE shared limiter rather than one per entry: 84
   * entries x 6 would otherwise open ~500 sockets and collapse throughput.
   *
   * ── A FAILURE ENDS THE RUN, NOT JUST THE REPORT ─────────────────────────
   * Every task is submitted up front, so a bare `Promise.all` would reject on
   * the first bad file while ~370 queued transfers carried on behind it. By
   * then the caller's `finally` has already saved the cache index and cleaned
   * the scratch directory, so those late downloads re-create the directory
   * that was just removed, land as blobs the index never records (making the
   * next run re-transfer every byte of them), and keep repainting a progress
   * bar underneath the error message. So the first rejection trips
   * `cancelled` — which every not-yet-started `acquire()` observes — and this
   * method does not resolve or reject until every task has settled.
   */
  async fetchPlan(plan: IResolvedPlan, progress: ProgressTracker): Promise<IFetchedEntry[]> {
    this.cancelled = false;
    let failure: { error: unknown } | undefined;

    const submitted = plan.entries.map(({ entry, files }) => ({
      entry,
      tasks: files.map((resolved) =>
        this.limiter.run(async () => {
          try {
            return await this.acquire(entry.id, resolved, progress);
          } catch (error) {
            // Keep the FIRST failure: it is the one that explains the run.
            failure ??= { error };
            this.cancelled = true;
            throw error;
          }
        })
      ),
    }));

    await Promise.allSettled(submitted.flatMap((item) => item.tasks));
    if (failure) throw failure.error;

    return Promise.all(
      submitted.map(async ({ entry, tasks }) => {
        const fetched = await Promise.all(tasks);
        return {
          entry,
          files: fetched,
          digest: digestFor(entry, fetched),
          bytes: fetched.reduce((sum, f) => sum + f.bytes, 0),
        };
      })
    );
  }

  /**
   * Remove the temp scratch directory.
   *
   * Only safe on a SUCCESSFUL run: the `.part` files in here are what the
   * Range resume in `downloadToFile` continues from, so wiping them after a
   * failed run re-pulls the 80 MB that already made it across the wire.
   */
  static async cleanTemp(): Promise<void> {
    await rm(TEMP_DIR, { recursive: true, force: true });
  }
}
