/**
 * ASSET PROCESSING — `npm run assets:process`
 *
 * Turns the verified source blobs under `assets/source/` into the GPU-native
 * build the game actually loads, under `public/assets/` (gitignored; Vite
 * serves `public/` at the web root, so a built file lands at `/assets/...`).
 *
 *   tex/<materialId>/<map>.<tier>.ktx2   PBR maps   (tools/process-textures.ts)
 *   env/<hdriId>.<tier>.ktx2 + .sh9.json environments (tools/process-hdri.ts)
 *   mdl/<modelId>.<tier>.glb             meshes     (tools/process-models.ts, other workstream)
 *   assets.runtime.json                  the index the game loads FIRST
 *
 * ── WHAT THIS FILE IS ──────────────────────────────────────────────────────
 * The orchestrator *and* the shared plumbing every processor needs: the ktx
 * runner, the KTX2 inspector/validator, the content-addressed skip cache, the
 * bounded worker pool, and the runtime-index writer. The per-kind processors
 * import from here; this file imports them back lazily, inside `main()`, so
 * there is no import cycle at module-evaluation time and a processor that has
 * not been written yet degrades to a warning instead of a crash.
 *
 * ── THE SKIP CACHE IS THE POINT ────────────────────────────────────────────
 * Encoding is expensive and profoundly repetitive: a 4096² albedo to ETC1S is
 * ~28 s, and nothing about it changes between runs unless the source bytes or
 * the encoder settings changed. Every output is therefore keyed by
 *
 *     sha256( srcSha256 | outPath | JSON(encode options) | TOOL_VERSION | ktx version )
 *
 * and a hit that still matches on disk (size + mtime) is reused untouched. A
 * warm re-run is a sub-second no-op; changing one encoder flag correctly
 * invalidates exactly the outputs that flag feeds.
 *
 * ── CONCURRENCY ────────────────────────────────────────────────────────────
 * `ktx` is internally multi-threaded and already saturates ~2.4 of the 4 cores
 * here, so a worker pool buys far less than its width: 2 concurrent encodes is
 * the sweet spot and the default. Raising it mostly steals cache and memory
 * bandwidth from the encode already running.
 *
 * ── USAGE ──────────────────────────────────────────────────────────────────
 *   npm run assets:process                      all tiers, everything
 *   npm run assets:process -- --tier mobile     just what ships in the APK
 *   npm run assets:process -- --only asphalt    subset by id substring
 *   npm run assets:process -- --concurrency 2   parallel encodes (default 2)
 *   npm run assets:process -- --force           ignore the skip cache
 *   npm run assets:process -- --skip models     omit a stage (textures|hdri|models)
 *   npm run assets:process -- --validate        ktx2check + ktx-parse every output
 *
 * Exit codes: 0 clean, 1 anything went wrong.
 */

import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { read as readKTX2 } from 'ktx-parse';
import type {
  AnyAssetEntry,
  IAssetManifest,
  IAssetOutput,
  QualityTier,
  TextureCodec,
} from '@/types';
import { Logger, REPO_ROOT, formatBytes, formatDuration, rel, sha256Of } from './lib/index.ts';

/* -------------------------------------------------------------------------- */
/* The processor contract                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What every stage is handed. Deliberately tiny — a stage that needs more
 * should derive it, not have it threaded through the orchestrator.
 */
export interface ProcessOptions {
  /** The quality tier to build. Stages are invoked once per requested tier. */
  readonly tier: QualityTier;
  /** Case-insensitive substrings; an entry is built if its id contains any. */
  readonly only?: readonly string[];
  /** Simultaneous encoder processes. */
  readonly concurrency: number;
  /** Ignore the skip cache and re-encode everything. */
  readonly force?: boolean;
}

/** What every stage reports back. */
export interface ProcessResult {
  /** Outputs actually encoded this run. */
  readonly written: number;
  /** Outputs served from the content-addressed skip cache. */
  readonly skipped: number;
  /** Bytes of every output the stage is responsible for, written or skipped. */
  readonly bytes: number;
  /** Human-readable failures. A non-empty array fails the build. */
  readonly errors: readonly string[];
  /**
   * Manifest rows to fold into `assets.runtime.json`. Optional so a stage that
   * only reports totals still satisfies the contract.
   */
  readonly outputs?: readonly IProducedOutput[];
  /** Extra per-environment data (SH irradiance). Only the HDRI stage sets it. */
  readonly environments?: Readonly<Record<string, IEnvironmentRuntime>>;
  /** Entries the stage synthesised that the source manifest does not contain. */
  readonly syntheticEntries?: readonly AnyAssetEntry[];
}

/** An `IAssetOutput` plus the id of the entry it belongs to. */
export interface IProducedOutput extends IAssetOutput {
  readonly assetId: string;
}

/** Per-environment runtime data that has no home in `IAssetOutput`. */
export interface IEnvironmentRuntime {
  /** 9 SH coefficients, RGB, row-major: [c0r,c0g,c0b, c1r,...]. 27 numbers. */
  readonly sh9: readonly number[];
  /** Path of the standalone SH JSON, relative to the generated root. */
  readonly shFile: string;
  /** Mean luminance of the source, for exposure sanity checks. */
  readonly meanLuminance: number;
  /** Peak luminance, i.e. the sun. */
  readonly maxLuminance: number;
}

/* -------------------------------------------------------------------------- */
/* Paths, binaries, versions                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Bump to invalidate every cached output.
 *
 * This is part of the skip-cache key, so any change to encoder settings,
 * procedural generators, or output layout that is NOT already captured by the
 * per-output options blob must bump this or stale files will be reused.
 */
export const TOOL_VERSION = '1.0.0';

/** Web-served build root. Gitignored; `npm run guard` keeps it out of git. */
export const PUBLIC_ASSETS_DIR = path.join(REPO_ROOT, 'public', 'assets');
export const TEX_DIR = path.join(PUBLIC_ASSETS_DIR, 'tex');
export const ENV_DIR = path.join(PUBLIC_ASSETS_DIR, 'env');
export const MODEL_DIR = path.join(PUBLIC_ASSETS_DIR, 'mdl');
/**
 * Scratch for intermediate PNG/raw files. Same filesystem, always cleaned.
 *
 * Namespaced by pid because more than one build can be in flight at once —
 * this repo is worked by parallel agents, and a second `assets:process` that
 * wiped a shared scratch directory on exit would delete the first one's
 * intermediates mid-encode. That failure looks like a random `vips2png: unable
 * to write to target`, which is a genuinely miserable thing to debug.
 */
export const WORK_ROOT = path.join(PUBLIC_ASSETS_DIR, '.work');
export const WORK_DIR = path.join(WORK_ROOT, String(process.pid));

/**
 * Does a process with this pid exist?
 *
 * Signal 0 tests for existence without delivering anything. It throws ESRCH
 * when nothing is there and EPERM when the process EXISTS but belongs to
 * another user — so anything that is not ESRCH has to be read as "alive", or a
 * sweeper deletes the scratch of a build running under a different uid.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Delete this run's scratch, plus any left behind by a run that died.
 *
 * The pid namespacing that makes concurrent builds safe also means a build
 * that is killed — Ctrl-C, OOM, an agent stopping a long encode — strands its
 * subtree forever, and those subtrees hold 40 MB intermediate PNGs. So each
 * run sweeps siblings whose pid no longer exists.
 *
 * `process.kill(pid, 0)` only tests for existence. A recycled pid makes this
 * skip a directory that was in fact abandoned, which is the harmless direction
 * to be wrong in; it can never delete a live run's scratch.
 *
 * That last guarantee is why the error CODE is inspected rather than caught
 * bare: `kill` throws ESRCH for "no such process" but EPERM for "exists, owned
 * by another uid", which is exactly the shared build machine / rootless
 * container case. Treating EPERM as death would delete a live run's scratch.
 */
export async function cleanWorkDirs(): Promise<void> {
  await rm(WORK_DIR, { recursive: true, force: true });
  let siblings: string[];
  try {
    siblings = await readdir(WORK_ROOT);
  } catch {
    return; // never created, or already gone
  }
  for (const name of siblings) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (isPidAlive(pid)) continue; // still running: leave it alone
    await rm(path.join(WORK_ROOT, name), { recursive: true, force: true });
  }
  // `rmdir` refuses a non-empty directory, which is exactly the check wanted:
  // the root goes only once no other build is using it.
  await rmdir(WORK_ROOT).catch(() => {});
}

/** The index the game loads first. */
export const RUNTIME_INDEX = path.join(PUBLIC_ASSETS_DIR, 'assets.runtime.json');
/** Content-addressed skip cache. Lives beside the outputs it describes. */
export const PROCESS_CACHE = path.join(PUBLIC_ASSETS_DIR, '.process-cache.json');
/** Web-root-relative prefix the runtime index's `file` paths hang off. */
export const GENERATED_ROOT = 'assets';

/** `assets/source/manifest.resolved.json` — every source file, sha256 filled. */
export const RESOLVED_MANIFEST_PATH = path.join(
  REPO_ROOT,
  'assets',
  'source',
  'manifest.resolved.json'
);
export const SOURCE_ROOT = path.join(REPO_ROOT, 'assets', 'source');

/**
 * The ELF binaries, NOT the npm bin shims.
 *
 * The `ktx2tools` shims print a `Running: ...` banner to stdout, which
 * corrupts any attempt to parse tool output. Invoking the ELF directly is the
 * difference between a parser that works and one that mysteriously does not.
 */
const KTX_BIN_DIR = path.join(REPO_ROOT, 'node_modules', 'ktx2tools', 'bin', 'linux');
export const KTX_BIN = path.join(KTX_BIN_DIR, 'ktx');
export const KTX2CHECK_BIN = path.join(KTX_BIN_DIR, 'ktx2check');

let cachedKtxVersion: string | undefined;

/** `ktx --version`, cached. Part of the skip-cache key. */
export async function ktxVersion(): Promise<string> {
  if (cachedKtxVersion === undefined) {
    const { stdout } = await run(KTX_BIN, ['--version']);
    cachedKtxVersion = stdout.trim().replace(/\s+/g, ' ');
  }
  return cachedKtxVersion;
}

/* -------------------------------------------------------------------------- */
/* Subprocess                                                                 */
/* -------------------------------------------------------------------------- */

export class ToolError extends Error {
  constructor(
    readonly bin: string,
    readonly args: readonly string[],
    readonly code: number | null,
    readonly stdout: string,
    readonly stderr: string
  ) {
    const detail = (stderr.trim() || stdout.trim() || '(no output)').split('\n').slice(0, 6);
    super(`${path.basename(bin)} exited ${code}: ${detail.join(' / ')}`);
    this.name = 'ToolError';
  }
}

/** Run a binary to completion, capturing both streams. Throws on non-zero. */
export async function run(
  bin: string,
  args: readonly string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new ToolError(bin, args, code, stdout, stderr));
    });
  });
}

/** `ktx <args>`. */
export async function ktx(args: readonly string[]): Promise<void> {
  await run(KTX_BIN, args);
}

/* -------------------------------------------------------------------------- */
/* KTX2 inspection and validation                                             */
/* -------------------------------------------------------------------------- */

/** VkFormat values this pipeline emits or expects. */
export const VK_FORMAT_UNDEFINED = 0;
export const VK_FORMAT_R16G16B16A16_SFLOAT = 97;

/** KHR_DF colour models. Basis payloads carry these instead of a vkFormat. */
export const KHR_DF_MODEL_ETC1S = 163;
export const KHR_DF_MODEL_UASTC = 166;

/** KHR_DF transfer functions. */
export const KHR_DF_TRANSFER_LINEAR = 1;
export const KHR_DF_TRANSFER_SRGB = 2;

/** Everything worth asserting about a built KTX2, read straight from bytes. */
export interface IKtx2Facts {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly vkFormat: number;
  readonly width: number;
  readonly height: number;
  readonly levelCount: number;
  /** The full chain for these dimensions: floor(log2(max(w,h))) + 1. */
  readonly expectedLevelCount: number;
  readonly colorModel: number;
  readonly transferFunction: number;
  readonly supercompressionScheme: number;
  readonly orientation?: string;
}

/** Full mip chain length for a base level of these dimensions. */
export function fullMipLevels(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

/** Parse a built KTX2 and hash it, in one read. */
export async function inspectKtx2(file: string): Promise<IKtx2Facts> {
  const bytes = await readFile(file);
  const container = readKTX2(new Uint8Array(bytes));
  const dfd = container.dataFormatDescriptor[0];
  return {
    file,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    vkFormat: container.vkFormat,
    width: container.pixelWidth,
    height: container.pixelHeight,
    levelCount: container.levels.length,
    expectedLevelCount: fullMipLevels(container.pixelWidth, container.pixelHeight),
    colorModel: dfd?.colorModel ?? -1,
    transferFunction: dfd?.transferFunction ?? -1,
    supercompressionScheme: container.supercompressionScheme,
    orientation: container.keyValue?.KTXorientation as string | undefined,
  };
}

/** What a built file is required to be. Anything unset is not checked. */
export interface IKtx2Expectation {
  readonly vkFormat?: number;
  readonly colorModel?: number;
  readonly transferFunction?: number;
  readonly width?: number;
  readonly height?: number;
  /** Require the complete mip chain down to 1×1. */
  readonly fullMipChain?: boolean;
  readonly supercompressionScheme?: number;
  /**
   * The `KTXorientation` key the container must carry — `'ru'` for everything
   * this pipeline publishes (right, up: a bottom-left origin). An empty string
   * asserts the key is ABSENT, which is what glTF-embedded textures want.
   */
  readonly orientation?: string;
}

/**
 * Assert a built KTX2 is what the encoder was asked for.
 *
 * The four things worth checking are exactly the four that are silently wrong
 * often enough to ship: the format, the transfer function (an albedo tagged
 * linear is washed out, a normal map tagged sRGB is subtly wrong everywhere),
 * the mip chain (a missing chain shimmers at distance and costs bandwidth that
 * was supposedly already paid), and the orientation — the one thing the
 * pipeline flips by hand, differently per stage, and which
 * `assets.runtime.json` republishes as a hard contract the renderer must match.
 */
export function checkKtx2(facts: IKtx2Facts, expect: IKtx2Expectation): string[] {
  const problems: string[] = [];
  const where = rel(facts.file);
  if (expect.vkFormat !== undefined && facts.vkFormat !== expect.vkFormat) {
    problems.push(`${where}: vkFormat ${facts.vkFormat}, expected ${expect.vkFormat}`);
  }
  if (expect.colorModel !== undefined && facts.colorModel !== expect.colorModel) {
    problems.push(`${where}: DFD colorModel ${facts.colorModel}, expected ${expect.colorModel}`);
  }
  if (expect.transferFunction !== undefined && facts.transferFunction !== expect.transferFunction) {
    problems.push(
      `${where}: transfer function ${facts.transferFunction}, expected ${expect.transferFunction} ` +
        `(1=linear, 2=sRGB) — colour-space bugs are invisible until they are not`
    );
  }
  if (expect.width !== undefined && facts.width !== expect.width) {
    problems.push(`${where}: width ${facts.width}, expected ${expect.width}`);
  }
  if (expect.height !== undefined && facts.height !== expect.height) {
    problems.push(`${where}: height ${facts.height}, expected ${expect.height}`);
  }
  if (expect.fullMipChain && facts.levelCount !== facts.expectedLevelCount) {
    problems.push(
      `${where}: levelCount ${facts.levelCount}, expected ${facts.expectedLevelCount} ` +
        `for ${facts.width}×${facts.height}`
    );
  }
  if (
    expect.supercompressionScheme !== undefined &&
    facts.supercompressionScheme !== expect.supercompressionScheme
  ) {
    problems.push(
      `${where}: supercompressionScheme ${facts.supercompressionScheme}, ` +
        `expected ${expect.supercompressionScheme}`
    );
  }
  if (expect.orientation !== undefined && (facts.orientation ?? '') !== expect.orientation) {
    problems.push(
      `${where}: KTXorientation ${facts.orientation ?? '(absent)'}, expected ` +
        `${expect.orientation || '(absent)'} — an upside-down texture passes every ` +
        `other check in this file`
    );
  }
  return problems;
}

/** Run the reference validator over a built file. Returns its findings. */
export async function ktx2check(file: string): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await run(KTX2CHECK_BIN, ['--warn-as-error', file]);
    return { ok: true, output: (stdout + stderr).trim() };
  } catch (error) {
    if (error instanceof ToolError) {
      return { ok: false, output: (error.stdout + error.stderr).trim() };
    }
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Content-addressed skip cache                                               */
/* -------------------------------------------------------------------------- */

/** One cached output. `mtimeMs` is the tripwire against edits under our feet. */
export interface IProcessCacheRecord {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly mtimeMs: number;
  readonly width?: number;
  readonly height?: number;
  readonly codec?: TextureCodec;
  readonly levels?: number;
  readonly builtAt: string;
}

interface IProcessCacheFile {
  readonly version: number;
  readonly toolVersion: string;
  readonly entries: Record<string, IProcessCacheRecord>;
}

/**
 * Maps an output key to the file that key already produced.
 *
 * Validation is deliberately cheap — size and mtime, never a re-hash. The
 * whole point is that a warm run costs nothing; re-reading 150 MB of KTX2 to
 * prove it is still 150 MB of KTX2 would defeat the exercise. `mtimeMs`
 * catches the one case size alone misses: a file rewritten to the same length.
 */
export class ProcessCache {
  private entries = new Map<string, IProcessCacheRecord>();
  private dirty = false;

  static async open(file: string = PROCESS_CACHE): Promise<ProcessCache> {
    const cache = new ProcessCache(file);
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as IProcessCacheFile;
      if (parsed.version === 1 && parsed.toolVersion === TOOL_VERSION) {
        for (const [key, record] of Object.entries(parsed.entries ?? {})) {
          cache.entries.set(key, record);
        }
      }
    } catch {
      // No cache, unreadable cache, or a cache from another tool version: all
      // mean the same thing — build everything.
    }
    return cache;
  }

  private constructor(private readonly file: string) {}

  get size(): number {
    return this.entries.size;
  }

  /** A usable hit, or undefined. Confirms the file still exists unchanged. */
  async lookup(key: string): Promise<IProcessCacheRecord | undefined> {
    const record = this.entries.get(key);
    if (!record) return undefined;
    try {
      const info = await stat(record.file);
      if (info.size !== record.bytes) return undefined;
      if (Math.abs(info.mtimeMs - record.mtimeMs) > 1) return undefined;
      return record;
    } catch {
      return undefined;
    }
  }

  /** Record a freshly built output. Hashes and stats it once. */
  async record(
    key: string,
    file: string,
    extra: Pick<IProcessCacheRecord, 'width' | 'height' | 'codec' | 'levels'> & { sha256?: string }
  ): Promise<IProcessCacheRecord> {
    const info = await stat(file);
    const sha256 = extra.sha256 ?? (await sha256File(file));
    const record: IProcessCacheRecord = {
      file,
      bytes: info.size,
      sha256,
      mtimeMs: info.mtimeMs,
      width: extra.width,
      height: extra.height,
      codec: extra.codec,
      levels: extra.levels,
      builtAt: new Date().toISOString(),
    };
    this.entries.set(key, record);
    this.dirty = true;
    return record;
  }

  /**
   * Persist, folding in anything another build wrote since `open()`.
   *
   * `writeFileAtomic` makes the write atomic but does nothing about the lost
   * update: two concurrent `assets:process` runs both read N entries and the
   * slower one's save would drop everything the faster one added, costing the
   * next run a re-encode of outputs that are perfectly current on disk. Keys
   * are content-addressed, so a key present on both sides describes the same
   * bytes and this run's record — freshly stat'd — wins.
   */
  async save(): Promise<void> {
    if (!this.dirty) return;
    const merged = new Map<string, IProcessCacheRecord>();
    try {
      const onDisk = JSON.parse(await readFile(this.file, 'utf8')) as IProcessCacheFile;
      if (onDisk.version === 1 && onDisk.toolVersion === TOOL_VERSION) {
        for (const [key, record] of Object.entries(onDisk.entries ?? {})) merged.set(key, record);
      }
    } catch {
      // Nothing readable there: this run's entries are the whole cache.
    }
    for (const [key, record] of this.entries) merged.set(key, record);
    this.entries = merged;

    const payload: IProcessCacheFile = {
      version: 1,
      toolVersion: TOOL_VERSION,
      entries: Object.fromEntries([...merged].sort(([a], [b]) => (a < b ? -1 : 1))),
    };
    await writeFileAtomic(this.file, JSON.stringify(payload, null, 2) + '\n');
    this.dirty = false;
  }
}

/**
 * The key an output is addressed by.
 *
 * Everything that decides WHAT was asked for goes in: the source digest, where
 * the file lands, the encoder options that shape the result, this tool's
 * version, and the encoder's own version. It must not depend on the clock or on
 * the order entries happen to be processed in.
 *
 * One deliberate omission: `--threads`. It is derived from `os.cpus()` and
 * `--concurrency`, `ktx` copies it verbatim into `KTXwriterScParams`, and the
 * UASTC RDO pass breaks ties differently across thread counts — so equal key
 * means "the same encode was requested of the same bytes", NOT byte-identical
 * output across machines. Putting it in the key would buy that stronger promise
 * at the price of re-encoding the whole set whenever the box or `--concurrency`
 * changes, which is precisely the cost this cache exists to avoid.
 */
export function outputKey(parts: {
  srcSha256: string;
  outFile: string;
  options: unknown;
  toolVersion?: string;
  encoderVersion: string;
}): string {
  return sha256Of(
    [
      parts.srcSha256,
      path.relative(PUBLIC_ASSETS_DIR, parts.outFile).split(path.sep).join('/'),
      JSON.stringify(parts.options),
      parts.toolVersion ?? TOOL_VERSION,
      parts.encoderVersion,
    ].join('|')
  );
}

/**
 * Write via a temp file and rename.
 *
 * `rename` within a filesystem is atomic, so a reader never sees a half-written
 * index and a second build racing the first loses cleanly rather than leaving
 * behind truncated JSON that fails to parse on every subsequent run.
 */
async function writeFileAtomic(file: string, contents: string): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(temp, contents);
  await rename(temp, file);
}

/** Streaming sha256 of a file on disk. */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(file, { highWaterMark: 1 << 20 })
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', resolve);
  });
  return hash.digest('hex');
}

/* -------------------------------------------------------------------------- */
/* Bounded worker pool                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Run `fn` over every item with at most `limit` in flight, preserving order in
 * the result. Rejections are captured per item rather than aborting the batch:
 * one broken texture should not cost you the other 122.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<Array<{ ok: true; value: R } | { ok: false; error: Error }>> {
  const results = new Array<{ ok: true; value: R } | { ok: false; error: Error }>(items.length);
  let next = 0;
  // A non-finite `limit` (`Number('two')` from an unvalidated CLI flag) would
  // make `width` NaN, `Array.from({ length: NaN })` empty, and every slot of
  // `results` a hole that the caller then dereferences. One worker is the
  // conservative reading of "I could not tell how many you wanted".
  const requested = Number.isFinite(limit) ? Math.floor(limit) : 1;
  const width = Math.max(1, Math.min(requested, items.length));

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await fn(items[index]!, index) };
      } catch (error) {
        results[index] = { ok: false, error: error as Error };
      }
    }
  }

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

/* -------------------------------------------------------------------------- */
/* Manifest access                                                            */
/* -------------------------------------------------------------------------- */

/** Read `assets/source/manifest.resolved.json`, produced by `assets:fetch`. */
export async function loadResolvedManifest(): Promise<IAssetManifest> {
  let raw: string;
  try {
    raw = await readFile(RESOLVED_MANIFEST_PATH, 'utf8');
  } catch {
    throw new Error(
      `${rel(RESOLVED_MANIFEST_PATH)} is missing. Run \`npm run assets:fetch\` first — ` +
        `processing needs the verified source blobs and their sha256s.`
    );
  }
  const manifest = JSON.parse(raw) as IAssetManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.entries)) {
    throw new Error(`${rel(RESOLVED_MANIFEST_PATH)}: unsupported shape`);
  }
  return manifest;
}

/** Case-insensitive substring filter over entry ids. Empty filter = keep all. */
export function matchesOnly(id: string, only?: readonly string[]): boolean {
  if (!only || only.length === 0) return true;
  const lower = id.toLowerCase();
  return only.some((needle) => lower.includes(needle.toLowerCase()));
}

/** Absolute path of a materialised source file. */
export function sourceFilePath(relative: string): string {
  return path.join(SOURCE_ROOT, relative);
}

/** Path of a built output relative to the generated root, with forward slashes. */
export function outputRelPath(absolute: string): string {
  return path.relative(PUBLIC_ASSETS_DIR, absolute).split(path.sep).join('/');
}

/* -------------------------------------------------------------------------- */
/* Runtime index                                                              */
/* -------------------------------------------------------------------------- */

/**
 * `assets.runtime.json` — an `IAssetManifest` with `outputs` filled in, plus
 * the handful of pipeline facts a loader cannot infer from the files.
 */
export interface IRuntimeManifest extends IAssetManifest {
  /** Tiers present in this index. */
  readonly tiersBuilt: readonly QualityTier[];
  /** Conventions the renderer must match. Getting these wrong is invisible. */
  readonly pipeline: {
    readonly toolVersion: string;
    readonly encoder: string;
    /**
     * Where texel (0,0) sits. Everything here is written bottom-left
     * (`KTXorientation: ru`) so a KTX2 is a drop-in replacement for the source
     * JPEG loaded with `TextureLoader`, whose default is `flipY: true`.
     * `KTX2Loader` forces `flipY: false`, so the flip is baked into the bytes.
     */
    readonly textureOrigin: 'bottom-left' | 'top-left';
    /** What the consumer must leave `texture.flipY` set to. */
    readonly flipY: boolean;
    /** Advice a loader cannot derive from the container. */
    readonly notes: readonly string[];
  };
  /** SH irradiance and luminance stats, keyed by HDRI id. */
  readonly environments: Readonly<Record<string, IEnvironmentRuntime>>;
}

const RUNTIME_NOTES: readonly string[] = [
  'ARM maps are pre-packed AO(R)/roughness(G)/metalness(B): bind one texture to ' +
    'aoMap + roughnessMap + metalnessMap and set `aoMap.channel = 0` — three defaults ' +
    'AO to UV1, which these meshes do not have.',
  'Normal maps are UASTC RGB, NOT --normal-mode two-channel: KTX2Loader transcodes ' +
    'Basis payloads to RGBA formats only, and three reads normalMap.xyz, so a packed ' +
    'X+Y map would arrive as (X,X,X). Bind them directly as normalMap.',
  'Environment maps transcode to an uncompressed DataTexture, which KTX2Loader gives ' +
    'NearestFilter. Set minFilter = LinearMipmapLinearFilter and magFilter = LinearFilter ' +
    'before use, and mapping = EquirectangularReflectionMapping.',
  'On the mobile tier prefer the baked SH9 irradiance in `environments` over PMREM: it ' +
    'is 27 floats already in this file, versus a ~12 MB cubemap chain and its build cost.',
];

/**
 * Fold this run's outputs into `assets.runtime.json`, preserving tiers built by
 * earlier runs.
 *
 * Merging matters because building one tier at a time is the normal workflow:
 * a `--tier mobile` run must not delete the ultra outputs a previous run
 * produced. Outputs are replaced per (assetId, tier, file), so re-running a
 * tier updates it in place rather than duplicating it.
 */
export async function writeRuntimeIndex(options: {
  sourceManifest: IAssetManifest;
  produced: readonly IProducedOutput[];
  environments: Readonly<Record<string, IEnvironmentRuntime>>;
  syntheticEntries: readonly AnyAssetEntry[];
  tiers: readonly QualityTier[];
  encoder: string;
}): Promise<{
  file: string;
  bytes: number;
  totalBytes: Partial<Record<QualityTier, number>>;
  /** Ids the previous index carried that no longer have a source manifest row. */
  dropped: readonly string[];
}> {
  let previous: IRuntimeManifest | undefined;
  try {
    previous = JSON.parse(await readFile(RUNTIME_INDEX, 'utf8')) as IRuntimeManifest;
  } catch {
    previous = undefined;
  }

  const previousOutputs = new Map<string, IProducedOutput[]>();
  for (const entry of previous?.entries ?? []) {
    if (entry.outputs?.length) {
      previousOutputs.set(
        entry.id,
        entry.outputs.map((o) => ({ ...o, assetId: entry.id }))
      );
    }
  }

  // Replace per (tier, file); everything else from a previous run survives.
  const byAsset = new Map<string, Map<string, IProducedOutput>>();
  for (const [assetId, outputs] of previousOutputs) {
    const map = new Map<string, IProducedOutput>();
    for (const output of outputs) map.set(`${output.tier} ${output.file}`, output);
    byAsset.set(assetId, map);
  }
  for (const output of options.produced) {
    let map = byAsset.get(output.assetId);
    if (!map) byAsset.set(output.assetId, (map = new Map()));
    map.set(`${output.tier} ${output.file}`, output);
  }

  const synthetic = new Map(options.syntheticEntries.map((e) => [e.id, e]));
  const seen = new Set<string>();
  const entries: AnyAssetEntry[] = [];
  const tierOrder: Record<QualityTier, number> = { mobile: 0, high: 1, ultra: 2 };

  const attach = (entry: AnyAssetEntry): AnyAssetEntry => {
    const outputs = [...(byAsset.get(entry.id)?.values() ?? [])]
      .map(({ assetId: _assetId, ...output }) => output)
      .sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier] || (a.file < b.file ? -1 : 1));
    return { ...entry, outputs } as AnyAssetEntry;
  };

  const previousById = new Map((previous?.entries ?? []).map((e) => [e.id, e]));

  /**
   * Which version of an entry to publish, most-authoritative first.
   *
   *   1. one this run synthesised — freshest, and the only one that can
   *      reflect encoder settings that just changed;
   *   2. the previous index's, IF it describes the same source bytes —
   *      a stage that did not run this time still enriched it last time
   *      (procedural materials gain `textureKeys`, HDRIs gain
   *      `targetFormat: 'ktx2'`), and dropping back to the raw manifest row
   *      would quietly un-enrich it;
   *   3. the source manifest's, which is correct but bare.
   *
   * The sha256 guard on (2) is what keeps this from going stale: once
   * `assets:fetch` pulls different bytes for an id, the carried-forward
   * enrichment no longer describes them and the manifest row wins.
   */
  const publishable = (entry: AnyAssetEntry): AnyAssetEntry => {
    const fresh = synthetic.get(entry.id);
    if (fresh) return fresh;
    const carried = previousById.get(entry.id);
    if (carried && carried.sha256 === entry.sha256) return carried;
    return entry;
  };

  for (const entry of options.sourceManifest.entries) {
    seen.add(entry.id);
    entries.push(attach(publishable(entry)));
  }
  for (const entry of options.syntheticEntries) {
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      entries.push(attach(entry));
    }
  }
  /**
   * Entries an earlier run synthesised that this one did not regenerate — the
   * procedural materials' texture rows, when only the HDRI stage ran, or a
   * `--validate`-only invocation. Without this they would silently vanish from
   * the index while their files sat perfectly good on disk.
   *
   * Carried forward only while the SOURCE they were derived from still exists.
   * "Not produced by this run" on its own conflates a stage that did not run
   * with an asset the curator deleted from the manifest, and the second one
   * would then be republished forever: preloaded by the game, credited on the
   * attribution screen, and 404ing the moment someone tidies up its directory.
   * Synthetic ids are `<sourceId>.<role>`, so one segment of ancestry is enough.
   */
  const sourceIds = new Set(options.sourceManifest.entries.map((e) => e.id));
  const derivedFromSource = (id: string): boolean => {
    const cut = id.lastIndexOf('.');
    return cut > 0 && sourceIds.has(id.slice(0, cut));
  };
  const dropped: string[] = [];
  for (const entry of previous?.entries ?? []) {
    if (seen.has(entry.id)) continue;
    if (!derivedFromSource(entry.id)) {
      dropped.push(entry.id);
      continue;
    }
    seen.add(entry.id);
    entries.push(attach(entry));
  }

  // Byte totals dedupe by file: a shared output referenced by several tiers
  // (an environment's SH, an identical high/ultra sky) is real bytes once.
  const totalBytes: Partial<Record<QualityTier, number>> = {};
  const counted = new Map<QualityTier, Set<string>>();
  for (const entry of entries) {
    for (const output of entry.outputs ?? []) {
      let files = counted.get(output.tier);
      if (!files) counted.set(output.tier, (files = new Set()));
      if (files.has(output.file)) continue;
      files.add(output.file);
      totalBytes[output.tier] = (totalBytes[output.tier] ?? 0) + output.bytes;
    }
  }

  const tiersBuilt = [...new Set([...(previous?.tiersBuilt ?? []), ...options.tiers])].sort(
    (a, b) => tierOrder[a] - tierOrder[b]
  );

  const manifest: IRuntimeManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    generator: `tools/process-assets.ts@${TOOL_VERSION}`,
    generatedRoot: GENERATED_ROOT,
    tiersBuilt,
    pipeline: {
      toolVersion: TOOL_VERSION,
      encoder: options.encoder,
      textureOrigin: 'bottom-left',
      flipY: false,
      notes: RUNTIME_NOTES,
    },
    environments: { ...(previous?.environments ?? {}), ...options.environments },
    entries,
    totalBytes,
  };

  const json = JSON.stringify(manifest, null, 2) + '\n';
  await writeFileAtomic(RUNTIME_INDEX, json);
  return { file: RUNTIME_INDEX, bytes: Buffer.byteLength(json), totalBytes, dropped };
}

/* -------------------------------------------------------------------------- */
/* Whole-build validation                                                     */
/* -------------------------------------------------------------------------- */

export interface IValidationReport {
  readonly checked: number;
  readonly problems: readonly string[];
  /** Per-tier byte totals measured from the files on disk, not the index. */
  readonly bytesByTier: Partial<Record<QualityTier, number>>;
}

/**
 * Re-derive every claim in `assets.runtime.json` from the bytes on disk.
 *
 * Two independent checks per file, because they catch different failures.
 * `ktx2check` is the reference validator and knows the container spec far
 * better than this pipeline does — level index arithmetic, DFD consistency,
 * padding, the lot. `ktx-parse` is used to assert the things only this
 * pipeline knows it asked for: the format, the transfer function, the full mip
 * chain, and that the sha256 in the index still describes the file next to it.
 *
 * The last one is what makes the index trustworthy rather than merely present:
 * a stale entry pointing at a file that has since been rebuilt is exactly the
 * kind of drift that ships broken assets while every individual tool passes.
 */
export async function validateOutputs(
  tiers: readonly QualityTier[],
  log: Logger
): Promise<IValidationReport> {
  const manifest = JSON.parse(await readFile(RUNTIME_INDEX, 'utf8')) as IRuntimeManifest;
  const wanted = new Set(tiers);
  const problems: string[] = [];
  const bytesByTier: Partial<Record<QualityTier, number>> = {};
  const seen = new Set<string>();
  let checked = 0;

  interface ICheckItem {
    readonly entry: AnyAssetEntry;
    readonly output: IAssetOutput;
  }
  const items: ICheckItem[] = [];
  for (const entry of manifest.entries) {
    for (const output of entry.outputs ?? []) {
      if (!wanted.has(output.tier)) continue;
      if (output.format !== 'ktx2') continue;
      items.push({ entry, output });
    }
  }

  for (const [index, { entry, output }] of items.entries()) {
    const file = path.join(PUBLIC_ASSETS_DIR, output.file);
    log.status(`validate  ${index + 1}/${items.length}  ${output.file}`);

    const check = await ktx2check(file);
    if (!check.ok) problems.push(`${output.file}: ktx2check — ${check.output.split('\n')[0]}`);

    let facts: IKtx2Facts;
    try {
      facts = await inspectKtx2(file);
    } catch (error) {
      problems.push(`${output.file}: unreadable — ${(error as Error).message}`);
      continue;
    }

    // Every KTX2 this pipeline publishes is written bottom-left-origin, either
    // by converting (textures) or by asserting a buffer that was already
    // flipped (environments). `pipeline.textureOrigin` in the index promises
    // exactly this to the renderer.
    const expectation: IKtx2Expectation = { fullMipChain: true, orientation: 'ru' };
    if (entry.kind === 'hdri') {
      Object.assign(expectation, {
        vkFormat: VK_FORMAT_R16G16B16A16_SFLOAT,
        transferFunction: KHR_DF_TRANSFER_LINEAR,
        supercompressionScheme: 2,
      });
    } else if (entry.kind === 'texture') {
      Object.assign(expectation, {
        vkFormat: VK_FORMAT_UNDEFINED,
        colorModel: output.codec === 'uastc' ? KHR_DF_MODEL_UASTC : KHR_DF_MODEL_ETC1S,
        transferFunction:
          entry.colorSpace === 'srgb' ? KHR_DF_TRANSFER_SRGB : KHR_DF_TRANSFER_LINEAR,
      });
    }
    if (output.width) Object.assign(expectation, { width: output.width });
    if (output.height) Object.assign(expectation, { height: output.height });
    problems.push(...checkKtx2(facts, expectation));

    if (facts.sha256 !== output.sha256) {
      problems.push(
        `${output.file}: sha256 on disk ${facts.sha256.slice(0, 12)} does not match the ` +
          `${output.sha256.slice(0, 12)} recorded in assets.runtime.json — the index is stale`
      );
    }
    if (facts.bytes !== output.bytes) {
      problems.push(`${output.file}: ${facts.bytes} bytes on disk, index says ${output.bytes}`);
    }

    if (!seen.has(output.file)) {
      seen.add(output.file);
      bytesByTier[output.tier] = (bytesByTier[output.tier] ?? 0) + facts.bytes;
    }
    checked += 1;
  }
  log.endStatus();

  problems.push(...(await validateEnvironments(manifest)));

  return { checked, problems, bytesByTier };
}

/**
 * Check the SH sidecars the index publishes inline.
 *
 * `environments[id].sh9` is the mobile tier's entire diffuse lighting path and
 * it is a COPY of `env/<id>.sh9.json`. Nothing else in this file looks at those
 * sidecars — `validateOutputs` walks `format === 'ktx2'` rows only — so a
 * truncated or older-schema sidecar reaches the runtime as a silently absent
 * probe: `coefficientsFlat` parses as `undefined`, `JSON.stringify` drops the
 * key, and the game falls back to a flat ambient with no error anywhere.
 */
async function validateEnvironments(manifest: IRuntimeManifest): Promise<string[]> {
  const problems: string[] = [];
  const isSH9 = (value: unknown): value is number[] =>
    Array.isArray(value) && value.length === 27 && value.every((v) => Number.isFinite(v));

  for (const [id, env] of Object.entries(manifest.environments ?? {})) {
    const where = `environments.${id}`;
    const indexed: unknown = env.sh9;
    if (!isSH9(indexed)) {
      problems.push(`${where}: sh9 in the index is not 27 finite numbers`);
    }
    if (!env.shFile) {
      problems.push(`${where}: no shFile recorded`);
      continue;
    }

    const file = path.join(PUBLIC_ASSETS_DIR, env.shFile);
    let sidecar: unknown;
    try {
      sidecar = (JSON.parse(await readFile(file, 'utf8')) as { coefficientsFlat?: unknown })
        .coefficientsFlat;
    } catch (error) {
      problems.push(`${where}: ${env.shFile} unreadable — ${(error as Error).message}`);
      continue;
    }
    if (!isSH9(sidecar)) {
      problems.push(`${where}: ${env.shFile} coefficientsFlat is not 27 finite numbers`);
      continue;
    }
    if (isSH9(indexed) && sidecar.some((v, i) => v !== indexed[i])) {
      problems.push(
        `${where}: sh9 in the index disagrees with ${env.shFile} — one of them is stale`
      );
    }
  }
  return problems;
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

type StageName = 'textures' | 'hdri' | 'models';
const ALL_STAGES: readonly StageName[] = ['textures', 'hdri', 'models'];
const ALL_TIERS: readonly QualityTier[] = ['mobile', 'high', 'ultra'];

/**
 * Validate a `--tier` flag. Shared with the stages' standalone entry points.
 *
 * They used to cast the raw string straight to `QualityTier`, so `--tier mobil`
 * reached `TIER_TARGETS[tier]` as `undefined` and surfaced as `Cannot read
 * properties of undefined (reading 'albedo')` from inside the planner — a
 * message that points at the planner rather than at the typo.
 */
export function parseTier(raw: string | undefined): QualityTier {
  if (raw === undefined) return 'mobile';
  if (!ALL_TIERS.includes(raw as QualityTier)) {
    throw new Error(`unknown tier '${raw}' (expected ${ALL_TIERS.join(' | ')})`);
  }
  return raw as QualityTier;
}

/**
 * Validate a `--concurrency` flag. Shared with the stages' standalone entry
 * points, where `Number('two')` used to reach `mapPool` as NaN.
 */
export function parseConcurrency(raw: string | undefined, fallback = 2): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 16) {
    throw new Error(`--concurrency must be an integer 1..16, got '${raw}'`);
  }
  return n;
}

interface ICliOptions {
  readonly tiers: readonly QualityTier[];
  readonly stages: readonly StageName[];
  readonly only: readonly string[];
  readonly concurrency: number;
  readonly force: boolean;
  readonly validate: boolean;
  readonly clean: boolean;
}

function parseArgs(argv: readonly string[]): ICliOptions {
  let tiers: QualityTier[] = [...ALL_TIERS];
  const skip = new Set<StageName>();
  let only: string[] = [];
  let concurrency = 2;
  let force = false;
  let validate = false;
  let clean = false;

  const list = (value: string): string[] =>
    value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    switch (arg) {
      case '--tier': {
        const raw = value();
        if (raw === 'all') {
          tiers = [...ALL_TIERS];
          break;
        }
        const parsed = list(raw);
        for (const t of parsed) {
          if (!ALL_TIERS.includes(t as QualityTier)) {
            throw new Error(`unknown tier '${t}' (expected ${ALL_TIERS.join(' | ')} | all)`);
          }
        }
        tiers = parsed as QualityTier[];
        break;
      }
      case '--only':
        only = list(value());
        break;
      case '--concurrency': {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 1 || n > 16) throw new Error('--concurrency must be 1..16');
        concurrency = n;
        break;
      }
      case '--skip': {
        for (const s of list(value())) {
          if (!ALL_STAGES.includes(s as StageName)) throw new Error(`unknown stage '${s}'`);
          skip.add(s as StageName);
        }
        break;
      }
      case '--force':
        force = true;
        break;
      case '--validate':
        validate = true;
        break;
      case '--clean':
        clean = true;
        break;
      case '--help':
      case '-h':
        console.log(
          [
            'usage: npm run assets:process -- [options]',
            '',
            '  --tier <t[,t]|all>   tiers to build (default: all)',
            '  --only <a,b>         id substrings to include',
            '  --concurrency <n>    parallel encodes (default 2; ktx is already threaded)',
            '  --skip <stage[,..]>  omit textures | hdri | models',
            '  --force              ignore the content-addressed skip cache',
            '  --validate           run ktx2check over every output',
            "  --clean              delete this pipeline's outputs (tex/, env/, mdl/,",
            '                       the runtime index and the skip cache) before building',
          ].join('\n')
        );
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option '${arg}'`);
    }
  }

  return {
    tiers,
    stages: ALL_STAGES.filter((s) => !skip.has(s)),
    only,
    concurrency,
    force,
    validate,
    clean,
  };
}

/** The shape a stage module must export. */
type StageFn = (opts: ProcessOptions) => Promise<ProcessResult>;

/**
 * Resolve a stage's entry point.
 *
 * `process-models.ts` belongs to another workstream and may simply not exist
 * yet. That is a normal state during parallel development, not an error, so it
 * is imported lazily and its absence downgrades to a warning.
 */
async function loadStage(name: StageName, log: Logger): Promise<StageFn | undefined> {
  try {
    switch (name) {
      case 'textures': {
        const mod = await import('./process-textures.ts');
        return mod.processTextures;
      }
      case 'hdri': {
        const mod = await import('./process-hdri.ts');
        return mod.processHdri;
      }
      case 'models': {
        const mod = (await import('./process-models.ts')) as { processModels?: StageFn };
        if (typeof mod.processModels !== 'function') {
          log.warn(
            `models processor not yet available — tools/process-models.ts exports no ` +
              `processModels(); skipping the mesh stage.`
          );
          return undefined;
        }
        return mod.processModels;
      }
    }
  } catch (error) {
    const message = (error as Error).message;
    if (name === 'models') {
      log.warn(
        `models processor not yet available (${message}) — skipping the mesh stage. ` +
          `It is owned by the mesh workstream and must export ` +
          `processModels(opts: ProcessOptions): Promise<ProcessResult>.`
      );
      return undefined;
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  const log = new Logger();
  let options: ICliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    log.error((error as Error).message);
    process.exit(1);
  }

  log.heading('asset processing');

  const encoder = await ktxVersion();
  log.info(`encoder     ${encoder}  (${rel(KTX_BIN)})`);
  log.info(`tiers       ${options.tiers.join(', ')}`);
  log.info(`stages      ${options.stages.join(', ')}`);
  log.info(`concurrency ${options.concurrency}`);
  if (options.only.length) log.info(`only        ${options.only.join(', ')}`);
  if (options.force) log.warn('--force: the skip cache is ignored, everything is re-encoded');

  if (options.clean) {
    // Named subtrees, never `rm -rf public/assets`: WORK_ROOT lives in there,
    // and wiping it would delete a concurrent build's live scratch mid-encode —
    // the exact failure the pid namespacing of WORK_DIR exists to prevent.
    // `.work/` is `cleanWorkDirs`' to own and is left alone here.
    for (const target of [TEX_DIR, ENV_DIR, MODEL_DIR, RUNTIME_INDEX, PROCESS_CACHE]) {
      await rm(target, { recursive: true, force: true });
    }
    log.info(`cleaned     ${rel(TEX_DIR)}, ${rel(ENV_DIR)}, ${rel(MODEL_DIR)} and the index`);
  }
  await mkdir(PUBLIC_ASSETS_DIR, { recursive: true });

  const stages = new Map<StageName, StageFn>();
  for (const name of options.stages) {
    const fn = await loadStage(name, log);
    if (fn) stages.set(name, fn);
  }

  const sourceManifest = await loadResolvedManifest();
  const produced: IProducedOutput[] = [];
  const environments: Record<string, IEnvironmentRuntime> = {};
  const syntheticEntries: AnyAssetEntry[] = [];
  const errors: string[] = [];
  let written = 0;
  let skipped = 0;

  for (const tier of options.tiers) {
    for (const [name, fn] of stages) {
      const stageStarted = Date.now();
      log.heading(`${name} · ${tier}`);
      let result: ProcessResult;
      try {
        result = await fn({
          tier,
          only: options.only,
          concurrency: options.concurrency,
          force: options.force,
        });
      } catch (error) {
        const message = `${name}/${tier}: ${(error as Error).message}`;
        log.error(message);
        errors.push(message);
        continue;
      }
      written += result.written;
      skipped += result.skipped;
      errors.push(...result.errors);
      if (result.outputs) produced.push(...result.outputs);
      if (result.environments) Object.assign(environments, result.environments);
      if (result.syntheticEntries) syntheticEntries.push(...result.syntheticEntries);
      for (const problem of result.errors) log.error(problem);
      log.ok(
        `${name} ${tier}: ${result.written} written, ${result.skipped} cached, ` +
          `${formatBytes(result.bytes)} in ${formatDuration(Date.now() - stageStarted)}`
      );
    }
  }

  await cleanWorkDirs();

  const index = await writeRuntimeIndex({
    sourceManifest,
    produced,
    environments,
    syntheticEntries,
    tiers: options.tiers,
    encoder,
  });
  if (index.dropped.length > 0) {
    log.warn(
      `dropped ${index.dropped.length} index entr(ies) with no source manifest row: ` +
        index.dropped.join(', ')
    );
  }

  if (options.validate) {
    log.heading('validate');
    const report = await validateOutputs(options.tiers, log);
    for (const problem of report.problems) log.error(problem);
    errors.push(...report.problems);
    if (report.problems.length === 0) {
      log.ok(
        `${report.checked} KTX2 outputs pass ktx2check and match the format, transfer ` +
          `function, mip chain and sha256 recorded in the index`
      );
    }
  }

  log.heading('summary');
  for (const tier of ALL_TIERS) {
    const bytes = index.totalBytes[tier];
    if (bytes !== undefined) log.info(`${tier.padEnd(7)} ${formatBytes(bytes)}`);
  }
  log.info(`index    ${rel(index.file)} (${formatBytes(index.bytes)})`);
  log.info(`outputs  ${written} written, ${skipped} served from cache`);
  log.info(`wall     ${formatDuration(Date.now() - started)}`);

  if (errors.length > 0) {
    log.error(`${errors.length} failure(s)`);
    process.exit(1);
  }
  log.ok('asset processing complete');
}

/**
 * Only run the CLI when invoked directly, never when imported by a stage.
 *
 * `fileURLToPath`, never `new URL(import.meta.url).pathname`: a URL pathname is
 * percent-encoded and `process.argv[1]` is not, so the naive comparison is
 * false for every checkout whose path contains a space, `#` or a non-ASCII
 * character — and the CLI then loads, evaluates, runs nothing and exits 0.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(`\nasset processing failed: ${(error as Error).stack ?? String(error)}\n`);
    process.exit(1);
  });
}
