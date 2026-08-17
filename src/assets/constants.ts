/**
 * ASSET RUNTIME CONSTANTS
 *
 * Budgets, orderings and well-known paths. Everything here is a number or a
 * string the rest of `src/assets/` reads — no logic, no imports beyond the
 * type contract, so it is safe to pull into a test without a GPU.
 */

import type { QualityTier } from '@/types';

/* -------------------------------------------------------------------------- */
/* Tiers                                                                      */
/* -------------------------------------------------------------------------- */

/** Ascending quality. Index doubles as the rank. */
export const TIER_ORDER: readonly QualityTier[] = ['mobile', 'high', 'ultra'];

/** Rank of each tier; higher is more expensive. */
export const TIER_RANK: Readonly<Record<QualityTier, number>> = {
  mobile: 0,
  high: 1,
  ultra: 2,
};

/* -------------------------------------------------------------------------- */
/* Paths                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Default web root for generated assets, relative to `document.baseURI`.
 *
 * Vite serves `public/` at the web root and the pipeline writes into
 * `public/assets/`, so this matches both the dev server and the Capacitor
 * bundle. It is deliberately RELATIVE: `vite.config.ts` sets `base: './'`
 * because Capacitor loads the app over a non-root origin on Android, where a
 * leading slash resolves outside the bundle and 404s.
 */
export const DEFAULT_ASSET_ROOT = 'assets';

/** Manifest emitted by `tools/process-assets.ts`, under the asset root. */
export const RUNTIME_MANIFEST_FILE = 'assets.runtime.json';

/**
 * Index emitted by the SEPARATE character pipeline (`tools/build-characters.ts`).
 * Characters are not in `assets.runtime.json` — see `characters.ts`.
 */
export const CHARACTER_INDEX_FILE = 'chr/characters.runtime.json';

/**
 * Where `KTX2Loader` fetches `basis_transcoder.js` + `.wasm` from, under the
 * asset root. The files are copied out of
 * `node_modules/three/examples/jsm/libs/basis/` by the build/harness; they
 * must be served verbatim, so they cannot be imported through the bundler
 * (Vite would rewrite the UMD bundle into an ES module and break it).
 */
export const BASIS_TRANSCODER_DIR = 'basis/';

/* -------------------------------------------------------------------------- */
/* Memory                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Resident texture-memory ceiling per asset tier, in bytes.
 *
 * These are GPU bytes after transcoding, mip chain included — not download
 * size. Crossing the ceiling evicts least-recently-used, UNREFERENCED handles
 * until the budget is met again; a referenced handle is never evicted, so a
 * pathological scene can exceed the budget. That case is logged rather than
 * enforced, because dropping a texture something is actively drawing with is
 * worse than a high-water mark.
 */
export const TEXTURE_MEMORY_BUDGET_BYTES: Readonly<Record<QualityTier, number>> = {
  mobile: 300 * 1024 * 1024,
  high: 550 * 1024 * 1024,
  ultra: 1200 * 1024 * 1024,
};

/**
 * Fraction of the budget the LRU trims down to once it has to evict.
 *
 * Evicting to exactly 100% means the very next load evicts again; 90% buys
 * headroom for a batch without a second pass.
 */
export const EVICTION_TARGET_FRACTION = 0.9;

/* -------------------------------------------------------------------------- */
/* Scheduling                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Parallel fetch/decode slots.
 *
 * Six matches the per-origin HTTP/1.1 connection limit mobile WebViews still
 * enforce, and keeps the KTX2 worker pool (4 workers by default) fed without
 * queueing behind itself.
 */
export const DEFAULT_CONCURRENCY = 6;

/** Scheduling priorities. LOWER runs first. */
export const PRIORITY = {
  /** Blocking the boot screen. */
  critical: 0,
  /** Needed for the next frame the player will see. */
  high: 10,
  /** Ordinary streaming. */
  normal: 20,
  /** Speculative prefetch. */
  low: 30,
  /** Only when nothing else is queued. */
  idle: 40,
} as const;

export type PriorityName = keyof typeof PRIORITY;

/* -------------------------------------------------------------------------- */
/* Fallbacks                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Edge of the fallback checker, in pixels.
 *
 * The checker is deliberately COARSE and carries a diagonal slash: a flat
 * magenta fill is indistinguishable from stylised art at a glance and has
 * shipped in real games as a result. See `fallback.ts`.
 */
export const FALLBACK_TEXTURE_SIZE = 64;

/** Checker cell size within the fallback texture. */
export const FALLBACK_CHECKER_CELL = 8;
