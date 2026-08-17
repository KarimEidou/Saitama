/**
 * ASSET LOCKFILE
 *
 * `assets/assets.lock.json` is committed; the bytes it describes are not.
 *
 * That is the whole point. `assets/source/` is ~1.7 GB of CC0 downloads and
 * has no business in git history — but "re-fetchable" is worthless unless
 * you can prove the re-fetch produced the same bytes as the build that was
 * tested. The lockfile is that proof: sha256 and length for every source
 * file, plus a per-entry digest, in a deterministic, diffable form.
 *
 * With `--frozen` it becomes an assertion instead of a record: fetching
 * anything the lockfile does not already vouch for is an error. That is the
 * mode CI should run in, so an upstream asset being reprocessed shows up as a
 * failed build and a reviewable diff rather than as art that quietly changed.
 *
 * Key order is sorted on write, so the file only ever diffs where something
 * genuinely changed.
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import { LOCKFILE } from './paths.ts';
import type { IAssetLockFile, IFetchedEntry, ILockAssetRecord, ILockFileRecord } from './types.ts';

export const LOCKFILE_VERSION = 1;

/** Read the committed lockfile, or undefined when there is not one yet. */
export async function readLockFile(
  filePath: string = LOCKFILE
): Promise<IAssetLockFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as IAssetLockFile;
    if (parsed.version !== LOCKFILE_VERSION) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Build a lockfile from fetch results. Pure — takes no I/O and no clock
 *  beyond the single timestamp, so it is trivially testable. */
export function buildLockFile(
  fetched: readonly IFetchedEntry[],
  options: { generator?: string; generatedAt?: string } = {}
): IAssetLockFile {
  const files: Record<string, ILockFileRecord> = {};
  const assets: Record<string, ILockAssetRecord> = {};
  let totalBytes = 0;

  for (const result of fetched) {
    const urls: string[] = [];
    for (const member of result.files) {
      files[member.file.url] = {
        sha256: member.sha256,
        md5: member.md5,
        bytes: member.bytes,
        assetId: result.entry.id,
        key: member.file.key,
        path: member.file.path,
      };
      urls.push(member.file.url);
      totalBytes += member.bytes;
    }
    assets[result.entry.id] = {
      provider: result.entry.provider,
      providerAssetId: result.entry.providerAssetId,
      kind: result.entry.kind,
      digest: result.digest,
      bytes: result.bytes,
      files: urls.sort(),
    };
  }

  return {
    version: LOCKFILE_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    generator: options.generator ?? 'tools/fetch-assets.ts',
    files: sortKeys(files),
    assets: sortKeys(assets),
    totals: {
      entries: Object.keys(assets).length,
      files: Object.keys(files).length,
      bytes: totalBytes,
    },
  };
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key];
  return out;
}

/**
 * Merge a partial run into an existing lockfile.
 *
 * A subset fetch (`--only asphalt`) must not delete the 370 entries it did not
 * touch — that would turn a convenience flag into a silent lockfile wipe.
 * Entries present in the new run win; everything else is carried forward.
 */
export function mergeLockFiles(
  previous: IAssetLockFile | undefined,
  next: IAssetLockFile
): IAssetLockFile {
  if (!previous) return next;

  const files = { ...previous.files };
  const assets = { ...previous.assets };
  // Drop stale file rows belonging to entries this run refreshed, so a
  // material that swapped a map does not keep the old map's row forever.
  const refreshed = new Set(Object.keys(next.assets));
  for (const [url, record] of Object.entries(files)) {
    if (refreshed.has(record.assetId)) delete files[url];
  }
  Object.assign(files, next.files);
  Object.assign(assets, next.assets);

  const sortedFiles = sortKeys(files);
  return {
    version: LOCKFILE_VERSION,
    generatedAt: next.generatedAt,
    generator: next.generator,
    files: sortedFiles,
    assets: sortKeys(assets),
    totals: {
      entries: Object.keys(assets).length,
      files: Object.keys(sortedFiles).length,
      bytes: Object.values(sortedFiles).reduce((sum, f) => sum + f.bytes, 0),
    },
  };
}

/** Serialise deterministically. */
export function serializeLockFile(lock: IAssetLockFile): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

/**
 * Serialise the way `npm run format` would.
 *
 * Without this the lockfile churns forever: `assets:fetch` writes 2-space
 * JSON, `format` collapses the short arrays back onto one line, and the next
 * fetch expands them again — a permanent phantom diff that trains reviewers to
 * ignore lockfile changes, which is the one file where that habit is
 * expensive. Prettier is a devDependency and this is a dev-only tool, but the
 * import is still optional: if it cannot be loaded the plain serialisation is
 * used and the only cost is cosmetic.
 */
async function serializeFormatted(lock: IAssetLockFile, filePath: string): Promise<string> {
  const plain = serializeLockFile(lock);
  try {
    const prettier = (await import('prettier')) as {
      resolveConfig: (p: string) => Promise<Record<string, unknown> | null>;
      format: (source: string, options: Record<string, unknown>) => Promise<string>;
    };
    const config = (await prettier.resolveConfig(filePath)) ?? {};
    return await prettier.format(plain, { ...config, parser: 'json', filepath: filePath });
  } catch {
    return plain;
  }
}

/** Write atomically (temp + rename). */
export async function writeLockFile(
  lock: IAssetLockFile,
  filePath: string = LOCKFILE
): Promise<void> {
  const temp = `${filePath}.tmp`;
  await writeFile(temp, await serializeFormatted(lock, filePath));
  await rename(temp, filePath);
}

/**
 * Would writing this lockfile change anything of substance?
 *
 * `generatedAt` is excluded on purpose: a timestamp that churns on every run
 * would make every warm re-run look like a change and would put a pointless
 * diff in front of every reviewer.
 */
export function lockFilesDiffer(a: IAssetLockFile | undefined, b: IAssetLockFile): boolean {
  if (!a) return true;
  const strip = (lock: IAssetLockFile): string =>
    JSON.stringify({ version: lock.version, files: lock.files, assets: lock.assets });
  return strip(a) !== strip(b);
}
