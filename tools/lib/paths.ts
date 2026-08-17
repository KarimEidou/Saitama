/**
 * PIPELINE PATHS
 *
 * One place that knows the on-disk layout, so no other module has to guess a
 * relative path from wherever it happens to be imported.
 *
 *   tools/manifest/              committed  hand-curated source manifests
 *   assets/assets.lock.json      committed  sha256 of every source file
 *   assets/source/               ignored    content-addressed blobs + tree
 *   assets/source/index.json     ignored    url -> blob map
 *   assets/source/api/           ignored    24h provider-API response cache
 *   assets/generated/            ignored    transcoded output
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root: this file lives at `<root>/tools/lib/paths.ts`. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const MANIFEST_DIR = path.join(REPO_ROOT, 'tools', 'manifest');
export const ASSETS_DIR = path.join(REPO_ROOT, 'assets');
export const SOURCE_DIR = path.join(ASSETS_DIR, 'source');
export const GENERATED_DIR = path.join(ASSETS_DIR, 'generated');

/** Content-addressed blob store: `<CAS_DIR>/<sha[0:2]>/<sha>`. */
export const CAS_DIR = path.join(SOURCE_DIR, 'cas');
/** url -> {sha256, md5, bytes, fetchedAt}. */
export const CACHE_INDEX = path.join(SOURCE_DIR, 'index.json');
/** Provider-API response cache, 24h TTL. */
export const API_CACHE_DIR = path.join(SOURCE_DIR, 'api');
/** Committed lockfile. */
export const LOCKFILE = path.join(ASSETS_DIR, 'assets.lock.json');
/**
 * Resolved `IAssetManifest` written after a successful fetch. Gitignored: it
 * is fully derived from the source manifests plus the lockfile, and exists so
 * `process-assets` can pick up entries with `sha256` already filled in.
 */
export const RESOLVED_MANIFEST = path.join(SOURCE_DIR, 'manifest.resolved.json');

/** Absolute path of a materialised source file from its manifest-relative path. */
export function sourcePath(relative: string): string {
  return path.join(SOURCE_DIR, relative);
}

/** Path of a blob in the content-addressed store. */
export function casPath(sha256: string): string {
  return path.join(CAS_DIR, sha256.slice(0, 2), sha256);
}

/** Shorten an absolute path for log output. */
export function rel(absolute: string): string {
  const r = path.relative(REPO_ROOT, absolute);
  return r.startsWith('..') ? absolute : r;
}
