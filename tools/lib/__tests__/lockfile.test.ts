/**
 * LOCKFILE MERGE, TOTALS AND READBACK
 *
 * Three regressions, all of them in the paths that only run when something is
 * unusual — a subset fetch, a shared URL, a lockfile that will not parse:
 *
 *   1. `mergeLockFiles` pruned file rows by their single `assetId`
 *      back-reference. A URL listed by two entries carries only the id of
 *      whichever wrote it last, so refreshing THAT entry deleted a row the
 *      other entry still lists — a dangling lockfile that fails the next
 *      `--frozen` CI run and blames the manifest for it.
 *   2. `buildLockFile` summed `totals.bytes` per member while
 *      `mergeLockFiles` summed it over the de-duplicated map, so a full run
 *      and a subset run of the same tree wrote different totals for the same
 *      content.
 *   3. `readLockFile` collapsed "absent", "unparseable" and "written by a
 *      newer pipeline" into `undefined`, and the caller's answer to
 *      `undefined` is to OVERWRITE — destroying the project's only record of
 *      376 sha256 anchors while reporting success.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildLockFile, mergeLockFiles, readLockFile } from '../lockfile.ts';
import type { IFetchedEntry, IFetchedFile, ISourceFile } from '../types.ts';

function sourceFile(url: string, filePath: string, bytes: number): ISourceFile {
  return { key: filePath, path: filePath, url, md5: 'a'.repeat(32), bytes, format: 'bin' };
}

function fetchedFile(file: ISourceFile): IFetchedFile {
  return {
    file,
    sha256: `sha-${file.path}`,
    md5: file.md5,
    bytes: file.bytes,
    cached: false,
    transferred: 0,
  };
}

function fetchedEntry(id: string, files: readonly ISourceFile[]): IFetchedEntry {
  const members = files.map(fetchedFile);
  return {
    entry: {
      id,
      kind: 'model',
      name: id,
      provider: 'polyhaven',
      providerAssetId: id,
      targetFormat: 'glb',
      attribution: {
        license: 'CC0-1.0',
        author: 'nobody',
        sourceUrl: `https://example.test/${id}`,
      },
      sourceUrl: `https://example.test/${id}`,
      tags: [],
      tiers: {},
      files,
    },
    files: members,
    digest: `digest-${id}`,
    bytes: members.reduce((sum, member) => sum + member.bytes, 0),
  };
}

/** One `.bin` listed by BOTH entries — what Poly Haven does for model LODs. */
const SHARED = sourceFile('https://example.test/shared.bin', 'shared.bin', 100);
const A_ONLY = sourceFile('https://example.test/a.jpg', 'a.jpg', 10);
const B_ONLY = sourceFile('https://example.test/b.jpg', 'b.jpg', 20);

const AT = '2024-01-01T00:00:00.000Z';
const lockOf = (...entries: IFetchedEntry[]) => buildLockFile(entries, { generatedAt: AT });

describe('buildLockFile totals', () => {
  it('counts a shared url once, like totals.files beside it', () => {
    const full = lockOf(fetchedEntry('A', [SHARED, A_ONLY]), fetchedEntry('B', [SHARED, B_ONLY]));
    expect(full.totals.files).toBe(3);
    expect(full.totals.bytes).toBe(130);
  });

  it('agrees with mergeLockFiles on the same content', () => {
    const full = lockOf(fetchedEntry('A', [SHARED, A_ONLY]), fetchedEntry('B', [SHARED, B_ONLY]));
    expect(mergeLockFiles(full, full).totals).toEqual(full.totals);
  });
});

describe('mergeLockFiles', () => {
  it('keeps a shared file row that an untouched entry still references', () => {
    // The row for a shared URL records only ONE assetId — whichever entry
    // wrote it last, here B. Refreshing B after it stopped needing that file
    // used to delete the row outright, leaving A's `files` list pointing at a
    // URL with no record: the dangling lockfile that fails the next --frozen.
    const full = lockOf(fetchedEntry('A', [SHARED, A_ONLY]), fetchedEntry('B', [SHARED, B_ONLY]));
    expect(full.files[SHARED.url].assetId).toBe('B');

    const merged = mergeLockFiles(full, lockOf(fetchedEntry('B', [B_ONLY])));

    expect(merged.files[SHARED.url]).toBeDefined();
    const dangling = Object.values(merged.assets).flatMap((asset) =>
      asset.files.filter((url) => merged.files[url] === undefined)
    );
    expect(dangling).toEqual([]);
  });

  it('still drops a row nothing references any more', () => {
    const before = lockOf(fetchedEntry('A', [SHARED, A_ONLY]));
    const after = mergeLockFiles(before, lockOf(fetchedEntry('A', [A_ONLY])));

    expect(after.files[SHARED.url]).toBeUndefined();
    expect(after.totals.files).toBe(1);
    expect(after.totals.bytes).toBe(10);
  });

  it('carries entries a subset run did not touch forward', () => {
    const full = lockOf(fetchedEntry('A', [A_ONLY]), fetchedEntry('B', [B_ONLY]));
    const merged = mergeLockFiles(full, lockOf(fetchedEntry('A', [A_ONLY])));

    expect(Object.keys(merged.assets).sort()).toEqual(['A', 'B']);
    expect(merged.totals.entries).toBe(2);
  });
});

describe('readLockFile', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'lockfile-test-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns undefined only when there is no lockfile', async () => {
    await expect(readLockFile(path.join(dir, 'absent.json'))).resolves.toBeUndefined();
  });

  it('refuses to hand back undefined for a lockfile it cannot parse', async () => {
    const file = path.join(dir, 'conflicted.json');
    await writeFile(file, '<<<<<<< HEAD\n{"version": 1}\n');
    await expect(readLockFile(file)).rejects.toThrow(/not valid JSON/);
  });

  it('refuses a lockfile from a version it does not understand', async () => {
    const file = path.join(dir, 'future.json');
    await writeFile(file, '{"version": 99}');
    await expect(readLockFile(file)).rejects.toThrow(/not supported/);
  });

  it('round-trips a lockfile it wrote', async () => {
    const file = path.join(dir, 'good.json');
    const lock = lockOf(fetchedEntry('A', [A_ONLY]));
    await writeFile(file, `${JSON.stringify(lock, null, 2)}\n`);
    await expect(readLockFile(file)).resolves.toEqual(lock);
  });
});
