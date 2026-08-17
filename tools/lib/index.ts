/**
 * ASSET PIPELINE LIBRARY
 *
 * Shared plumbing for every tool under `tools/`. Import from here rather than
 * reaching into individual modules:
 *
 *   import { loadSourceManifests, SourceCache, Logger } from './lib/index.ts';
 *
 * ── WHAT IS IN HERE ────────────────────────────────────────────────────────
 *   types.ts      the `tools/manifest/*.json` schema, cache and lockfile shapes
 *   paths.ts      every on-disk location the pipeline knows about
 *   log.ts        levelled logging + a progress line with a measured ETA
 *   hash.ts       single-pass streaming sha256 + md5, and the entry digest
 *   http.ts       retry, stall-aware timeouts, Range resume, concurrency
 *   cache.ts      content-addressed blob store + 24h API response cache
 *   polyhaven.ts  api.polyhaven.com client
 *   manifest.ts   load, validate, and compile to `IAssetManifest`
 *   lockfile.ts   `assets/assets.lock.json` read/build/merge/write
 *   fetcher.ts    resolve -> download -> verify -> materialise
 *
 * `process-assets.ts` and any other consumer should depend on this barrel and
 * on `@/types`, and on nothing else from the pipeline.
 */

export * from './types.ts';
export * from './paths.ts';
export * from './log.ts';
export * from './hash.ts';
export * from './http.ts';
export * from './cache.ts';
export * from './polyhaven.ts';
export * from './manifest.ts';
export * from './lockfile.ts';
export * from './fetcher.ts';
