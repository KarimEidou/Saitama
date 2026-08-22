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

/**
 * Read the committed lockfile, or undefined when there is not one yet.
 *
 * ONLY "there is no lockfile" is undefined. A lockfile that exists but cannot
 * be understood — conflict markers left by a merge, a truncated write, a
 * version from a newer pipeline — throws instead, because the caller's answer
 * to `undefined` is to overwrite the file with whatever this machine happened
 * to fetch. That would destroy the project's only record of 376 sha256
 * anchors, and `--frozen` would meanwhile report "does not exist" about a file
 * sitting right there.
 */
export async function readLockFile(
  filePath: string = LOCKFILE
): Promise<IAssetLockFile | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`${filePath}: cannot be read — ${(error as Error).message}`, { cause: error });
  }

  let parsed: IAssetLockFile;
  try {
    parsed = JSON.parse(raw) as IAssetLockFile;
  } catch (error) {
    throw new Error(
      `${filePath}: is not valid JSON (${(error as Error).message}). Refusing to overwrite a ` +
        `lockfile that cannot be read — fix or delete it first.`,
      { cause: error }
    );
  }
  if (parsed?.version !== LOCKFILE_VERSION) {
    throw new Error(
      `${filePath}: lockfile version ${JSON.stringify(parsed?.version)} is not supported ` +
        `(this pipeline writes version ${LOCKFILE_VERSION}). Refusing to overwrite it.`
    );
  }
  return parsed;
}

/** Build a lockfile from fetch results. Pure — takes no I/O and no clock
 *  beyond the single timestamp, so it is trivially testable. */
export function buildLockFile(
  fetched: readonly IFetchedEntry[],
  options: { generator?: string; generatedAt?: string } = {}
): IAssetLockFile {
  const files: Record<string, ILockFileRecord> = {};
  const assets: Record<string, ILockAssetRecord> = {};

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

  const sortedFiles = sortKeys(files);
  return {
    version: LOCKFILE_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    generator: options.generator ?? 'tools/fetch-assets.ts',
    files: sortedFiles,
    assets: sortKeys(assets),
    totals: {
      entries: Object.keys(assets).length,
      // Counted over the DE-DUPLICATED file map, exactly like `totals.files`
      // beside it and exactly like `mergeLockFiles` — two entries that share a
      // URL are one row and one set of bytes. Summing per member instead made
      // a full run and a subset run of the same tree disagree about their own
      // totals.
      files: Object.keys(sortedFiles).length,
      bytes: Object.values(sortedFiles).reduce((sum, f) => sum + f.bytes, 0),
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
  Object.assign(assets, next.assets);

  // Drop stale file rows belonging to entries this run refreshed, so a
  // material that swapped a map does not keep the old map's row forever.
  //
  // Pruned by "no surviving entry lists this URL any more", NOT by the row's
  // single `assetId` back-reference: a URL can be shared by several entries
  // (Poly Haven serves one `.bin` for every resolution of a model) while the
  // row records only whichever entry wrote it last. Pruning on that reference
  // deletes rows that other, untouched entries still list, leaving an
  // `assets.<id>.files` URL with no `files` row — a dangling lockfile that
  // then fails the next `--frozen` CI run and blames the manifest for it.
  const referenced = new Set<string>();
  for (const record of Object.values(assets)) {
    for (const url of record.files) referenced.add(url);
  }
  for (const url of Object.keys(files)) {
    if (!referenced.has(url)) delete files[url];
  }
  Object.assign(files, next.files);

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
