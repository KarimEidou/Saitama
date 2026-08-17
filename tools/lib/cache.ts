/**
 * CONTENT-ADDRESSED SOURCE CACHE
 *
 * Downloads land in `assets/source/cas/<sha256[0:2]>/<sha256>` and are then
 * hardlinked into the human-readable tree at `assets/source/<path>`.
 *
 * ── WHY BOTH ──────────────────────────────────────────────────────────────
 * The CAS gives dedup and O(1) "do I already have these exact bytes?". That
 * matters more than it sounds: Poly Haven serves the *same* `.bin` URL for
 * every resolution of a model, and several props share texture files, so the
 * store collapses those automatically.
 *
 * But a glTF document references its images by relative path
 * (`textures/foo_2k.jpg`), so a loader pointed at a hash-named blob cannot
 * resolve anything. The materialised tree exists for that: real names, real
 * layout, zero extra bytes because it is hardlinks into the CAS (with a copy
 * fallback for filesystems that refuse).
 *
 * ── WHY A WARM RUN IS INSTANT ─────────────────────────────────────────────
 * `index.json` maps url -> {sha256, md5, bytes, fetchedAt}. On a warm run the
 * fetcher looks up the URL, confirms the recorded md5 matches what the
 * provider API currently publishes, confirms the blob exists at the right
 * size, and stops. No network, no re-hashing of gigabytes. `--verify` forces
 * a full re-hash when you want proof rather than a claim.
 */

import { constants as fsConstants } from 'node:fs';
import {
  copyFile,
  link,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { CACHE_INDEX, CAS_DIR, SOURCE_DIR, casPath } from './paths.ts';
import { hashFile } from './hash.ts';
import type { ICacheIndex, ICacheRecord } from './types.ts';

const INDEX_VERSION = 1;

/** Whether a blob is usable, and why not when it is not. */
export type BlobState = 'ok' | 'missing' | 'wrong-size' | 'corrupt';

/** Result of checking a blob, with the mtime the index should now remember. */
export interface IBlobCheck {
  readonly state: BlobState;
  /** Current mtime in ms; write it back to the index when the state is 'ok'. */
  readonly mtimeMs: number;
  /** True when the check had to re-hash the file rather than trust metadata. */
  readonly hashed: boolean;
}

export class SourceCache {
  private index: ICacheIndex = { version: INDEX_VERSION, entries: {} };
  private dirty = false;
  private loaded = false;

  /** Read `index.json`. A missing or unreadable index is not fatal — it is a
   *  pure cache, and the worst case is that everything re-downloads. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(CACHE_INDEX, 'utf8');
      const parsed = JSON.parse(raw) as ICacheIndex;
      if (parsed?.version === INDEX_VERSION && parsed.entries) {
        this.index = { version: INDEX_VERSION, entries: { ...parsed.entries } };
      }
    } catch {
      this.index = { version: INDEX_VERSION, entries: {} };
    }
  }

  /** Persist the index atomically (temp file + rename). */
  async save(): Promise<void> {
    if (!this.dirty) return;
    await mkdir(SOURCE_DIR, { recursive: true });
    const sorted: Record<string, ICacheRecord> = {};
    for (const key of Object.keys(this.index.entries).sort()) {
      sorted[key] = this.index.entries[key];
    }
    const temp = `${CACHE_INDEX}.tmp`;
    await writeFile(
      temp,
      `${JSON.stringify({ version: INDEX_VERSION, entries: sorted }, null, 2)}\n`
    );
    await rename(temp, CACHE_INDEX);
    this.dirty = false;
  }

  /** What the cache believes about a URL. */
  lookup(url: string): ICacheRecord | undefined {
    return this.index.entries[url];
  }

  record(url: string, entry: ICacheRecord): void {
    this.index.entries[url] = entry;
    this.dirty = true;
  }

  forget(url: string): void {
    if (url in this.index.entries) {
      delete this.index.entries[url];
      this.dirty = true;
    }
  }

  get size(): number {
    return Object.keys(this.index.entries).length;
  }

  /** Every url -> record pair, for lockfile assembly and reporting. */
  entries(): readonly (readonly [string, ICacheRecord])[] {
    return Object.entries(this.index.entries);
  }

  /**
   * Is the blob for `sha256` present, the right length, and untouched?
   *
   * Three levels of paranoia, and the middle one is the interesting part:
   *
   *   size          free. Catches truncation and partial writes.
   *   mtime         free — the `stat` already happened. The index remembers
   *                 the mtime the blob had when it was verified, so ANY later
   *                 write to it forces a re-hash. That is what makes same-size
   *                 in-place corruption detectable without reading 1.7 GB on
   *                 every run: a corrupting write cannot avoid moving mtime.
   *   full re-hash  `--verify`, or automatically whenever mtime has moved.
   *
   * So the warm path stays O(1) per file and still refuses to hand back bytes
   * that changed under it.
   */
  async checkBlob(
    sha256: string,
    expectedBytes: number,
    options: { deep?: boolean; expectedMtimeMs?: number } = {}
  ): Promise<IBlobCheck> {
    const blob = casPath(sha256);
    let size: number;
    let mtimeMs: number;
    try {
      const info = await stat(blob);
      size = info.size;
      mtimeMs = info.mtimeMs;
    } catch {
      return { state: 'missing', mtimeMs: 0, hashed: false };
    }
    if (size !== expectedBytes) return { state: 'wrong-size', mtimeMs, hashed: false };

    const touched =
      options.expectedMtimeMs !== undefined && Math.abs(options.expectedMtimeMs - mtimeMs) > 1;
    if (!options.deep && !touched) return { state: 'ok', mtimeMs, hashed: false };

    const digests = await hashFile(blob);
    return {
      state: digests.sha256 === sha256 ? 'ok' : 'corrupt',
      mtimeMs,
      hashed: true,
    };
  }

  /** Absolute path of a blob. */
  blobPath(sha256: string): string {
    return casPath(sha256);
  }

  /**
   * Move a freshly downloaded file into the CAS under its sha256.
   *
   * If the blob already exists the incoming file is simply discarded — same
   * hash means same bytes, so there is nothing to write and nothing to lose.
   */
  async store(tempPath: string, sha256: string): Promise<{ path: string; mtimeMs: number }> {
    const blob = casPath(sha256);
    await mkdir(path.dirname(blob), { recursive: true });
    try {
      const existing = await stat(blob);
      await rm(tempPath, { force: true });
      return { path: blob, mtimeMs: existing.mtimeMs };
    } catch {
      /* not present yet — fall through and install it */
    }
    try {
      await rename(tempPath, blob);
    } catch {
      // Cross-device rename: copy then drop the original.
      await copyFile(tempPath, blob);
      await rm(tempPath, { force: true });
    }
    return { path: blob, mtimeMs: (await stat(blob)).mtimeMs };
  }

  /**
   * Expose a blob at its real name and relative layout under
   * `assets/source/<relativePath>`.
   *
   * Hardlink first (no extra bytes, no extra I/O), copy as a fallback for
   * filesystems that do not support links.
   *
   * An existing destination is only left alone when it is the SAME INODE as
   * the blob, not merely the same length. Identity, not similarity: if the
   * tree file has drifted into a separate copy, it is no longer covered by the
   * blob's integrity check and gets relinked. That keeps exactly one set of
   * bytes per file, so verifying the CAS verifies the tree too.
   */
  async materialize(sha256: string, relativePath: string, expectedBytes: number): Promise<string> {
    const blob = casPath(sha256);
    const dest = path.join(SOURCE_DIR, relativePath);
    let blobIno: number | undefined;
    try {
      blobIno = (await stat(blob)).ino;
    } catch {
      throw new Error(`cache.materialize: blob ${sha256} is missing`);
    }
    try {
      const existing = await stat(dest);
      if (existing.size === expectedBytes && existing.ino === blobIno) return dest;
      await unlink(dest);
    } catch {
      /* not there yet */
    }
    await mkdir(path.dirname(dest), { recursive: true });
    try {
      await link(blob, dest);
    } catch {
      await copyFile(blob, dest, fsConstants.COPYFILE_FICLONE);
    }
    return dest;
  }

  /** Delete a blob. Used when md5 verification fails — a bad blob must never
   *  survive to be trusted by the next run's cheap path. */
  async evict(sha256: string): Promise<void> {
    await rm(casPath(sha256), { force: true });
  }

  /** Ensure the CAS directory exists. */
  static async ensureDirs(): Promise<void> {
    await mkdir(CAS_DIR, { recursive: true });
  }
}

/* -------------------------------------------------------------------------- */
/* Small TTL cache for provider API responses                                 */
/* -------------------------------------------------------------------------- */

interface ITtlEnvelope<T> {
  readonly fetchedAt: string;
  readonly ttlMs: number;
  readonly value: T;
}

/** Read a TTL-cached JSON document, or undefined when absent or stale. */
export async function readJsonCache<T>(filePath: string): Promise<T | undefined> {
  try {
    const envelope = JSON.parse(await readFile(filePath, 'utf8')) as ITtlEnvelope<T>;
    const age = Date.now() - Date.parse(envelope.fetchedAt);
    if (!Number.isFinite(age) || age < 0 || age > envelope.ttlMs) return undefined;
    return envelope.value;
  } catch {
    return undefined;
  }
}

/** Write a TTL-cached JSON document. */
export async function writeJsonCache<T>(filePath: string, value: T, ttlMs: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const envelope: ITtlEnvelope<T> = {
    fetchedAt: new Date().toISOString(),
    ttlMs,
    value,
  };
  const temp = `${filePath}.tmp`;
  await writeFile(temp, JSON.stringify(envelope));
  await rename(temp, filePath);
}
