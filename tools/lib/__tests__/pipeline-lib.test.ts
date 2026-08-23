/**
 * THE FETCH LIBRARY'S PURE CORE
 *
 * `tools/lib/` is the integrity spine of the asset pipeline — the digest that
 * lands in the committed lockfile, the concurrency limiter 376 downloads queue
 * on, the compression profile that decides every texture's colour space — and
 * the functions that matter most are pure and take no I/O. They are covered
 * here, imported from their individual modules so a failure names one module.
 *
 * Two behaviours filed as bugs elsewhere are deliberately NOT asserted here:
 * `mergeLockFiles`/`totals.bytes` and the `--only` subset paths. Pinning
 * today's behaviour there would bake in a filed defect. `tools/lib/__tests__/
 * lockfile.test.ts` owns the merge semantics; this file owns the build,
 * comparison and serialisation of a lockfile, plus the pieces nobody disputes.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readJsonCache, writeJsonCache } from '../cache.ts';
import { entryDigest, sha256Of } from '../hash.ts';
import { DEFAULT_CONCURRENCY, Limiter } from '../http.ts';
import { buildLockFile, lockFilesDiffer, serializeLockFile } from '../lockfile.ts';
import { formatBytes, formatDuration, formatRate } from '../log.ts';
import { compressionProfileFor, meshProfileFor } from '../manifest.ts';
import { memoizeAsync } from '../polyhaven.ts';
import { REPO_ROOT, casPath, rel } from '../paths.ts';
import type { IFetchedEntry, ISourceFile, ITierTarget } from '../types.ts';

/* -------------------------------------------------------------------------- */
/* hash.ts                                                                    */
/* -------------------------------------------------------------------------- */

describe('entryDigest', () => {
  const A = { sha256: 'aa', path: 'b' };
  const B = { sha256: 'bb', path: 'a' };

  it('is independent of member order', () => {
    // The sort is what makes the lockfile machine-independent: two machines
    // that download the same bytes must agree whatever order they arrived in.
    expect(entryDigest([A, B])).toBe(entryDigest([B, A]));
  });

  it('is the sha256 of the sha256sum-format listing, sorted by path', () => {
    expect(entryDigest([A, B])).toBe(sha256Of('bb  a\naa  b'));
  });

  it('changes when a member path changes', () => {
    expect(entryDigest([A, B])).not.toBe(entryDigest([A, { ...B, path: 'a2' }]));
  });

  it('changes when a member sha256 changes', () => {
    expect(entryDigest([A, B])).not.toBe(entryDigest([A, { ...B, sha256: 'bc' }]));
  });
});

describe('sha256Of', () => {
  it('is really sha256', () => {
    // Guards against a hashing-algorithm swap, which would silently invalidate
    // every digest in the committed lockfile.
    expect(sha256Of('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

/* -------------------------------------------------------------------------- */
/* http.ts — Limiter                                                          */
/* -------------------------------------------------------------------------- */

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('Limiter', () => {
  it('refuses a concurrency below 1', () => {
    expect(() => new Limiter(0)).toThrow(/concurrency must be >= 1/);
  });

  it('defaults to the measured sweet spot', () => {
    expect(new Limiter().concurrency).toBe(DEFAULT_CONCURRENCY);
    expect(DEFAULT_CONCURRENCY).toBe(6);
  });

  it('never runs more than `concurrency` tasks at once, and preserves order', async () => {
    const limiter = new Limiter(3);
    const gates = Array.from({ length: 10 }, deferred);
    const observed: number[] = [];

    const running = Promise.all(
      gates.map((gate, i) =>
        limiter.run(async () => {
          observed.push(limiter.inFlight);
          await gate.promise;
          return i;
        })
      )
    );

    for (const gate of gates) gate.resolve();
    await expect(running).resolves.toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(Math.max(...observed)).toBe(3);
    expect(limiter.inFlight).toBe(0);
  });

  it('is not wedged by a task that throws', async () => {
    // A slot released outside a `finally` deadlocks the whole run on the first
    // bad URL, with nothing printed and nothing to time out.
    const limiter = new Limiter(2);
    const settled = await Promise.allSettled(
      [0, 1, 2, 3, 4].map((i) =>
        limiter.run(async () => {
          if (i === 1) throw new Error('boom');
          return i;
        })
      )
    );

    expect(settled).toHaveLength(5);
    expect(settled.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(limiter.inFlight).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* manifest.ts — derived profiles                                             */
/* -------------------------------------------------------------------------- */

const TARGET: ITierTarget = { maxDimension: 2048, codec: 'etc1s', quality: 80 };

function file(overrides: Partial<ISourceFile> = {}): ISourceFile {
  return {
    key: 'k',
    path: 'textures/x.jpg',
    url: 'https://example.test/x.jpg',
    md5: 'a'.repeat(32),
    bytes: 1,
    format: 'jpg',
    ...overrides,
  };
}

describe('compressionProfileFor', () => {
  it('keeps colour data in sRGB and leaves it a normal-map-free profile', () => {
    const profile = compressionProfileFor(file({ role: 'albedo', colorSpace: 'srgb' }), TARGET);
    expect(profile.colorSpace).toBe('srgb');
    expect(profile.isNormalMap).toBe(false);
    expect(profile.hasAlpha).toBe(false);
    expect(profile.generateMipmaps).toBe(true);
  });

  it('flags a normal map so the encoder takes its two-channel path', () => {
    const profile = compressionProfileFor(file({ role: 'normal', colorSpace: 'linear' }), TARGET);
    expect(profile.isNormalMap).toBe(true);
    expect(profile.colorSpace).toBe('linear');
  });

  it('defaults an unroled file to linear', () => {
    const profile = compressionProfileFor(file(), TARGET);
    expect(profile.colorSpace).toBe('linear');
    expect(profile.isNormalMap).toBe(false);
  });

  it('detects alpha from an upper-case format and from the role', () => {
    expect(compressionProfileFor(file({ format: 'PNG' }), TARGET).hasAlpha).toBe(true);
    expect(
      compressionProfileFor(file({ role: 'alpha', colorSpace: 'linear' }), TARGET).hasAlpha
    ).toBe(true);
  });

  it('supplies zstd defaults the manifest need not repeat', () => {
    const defaults = compressionProfileFor(file(), TARGET);
    expect(defaults.zstd).toBe(true);
    expect(defaults.zstdLevel).toBe(18);

    const overridden = compressionProfileFor(file(), { ...TARGET, zstd: false, zstdLevel: 3 });
    expect(overridden.zstd).toBe(false);
    expect(overridden.zstdLevel).toBe(3);
  });
});

describe('meshProfileFor', () => {
  it('defaults to no decimation, no draco, meshopt on', () => {
    expect(meshProfileFor(TARGET)).toEqual({
      simplifyRatio: 1,
      draco: false,
      meshopt: true,
      positionBits: undefined,
      normalBits: undefined,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* lockfile.ts — build, compare, serialise                                    */
/* -------------------------------------------------------------------------- */

function sourceFile(url: string, filePath: string, bytes: number): ISourceFile {
  return { key: filePath, path: filePath, url, md5: 'a'.repeat(32), bytes, format: 'bin' };
}

function fetchedEntry(id: string, files: readonly ISourceFile[]): IFetchedEntry {
  const members = files.map((f) => ({
    file: f,
    sha256: `sha-${f.path}`,
    md5: f.md5,
    bytes: f.bytes,
    cached: false,
    transferred: 0,
  }));
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
    bytes: members.reduce((sum, m) => sum + m.bytes, 0),
  };
}

// Declared out of order on purpose: sorting is the property under test.
const TWO_A = sourceFile('https://example.test/z.bin', 'z.bin', 20);
const TWO_B = sourceFile('https://example.test/m.bin', 'm.bin', 30);
const ONE_A = sourceFile('https://example.test/a.bin', 'a.bin', 10);
const AT = '2024-01-01T00:00:00.000Z';

const buildTwo = (at = AT) =>
  buildLockFile([fetchedEntry('b.two', [TWO_A, TWO_B]), fetchedEntry('a.one', [ONE_A])], {
    generatedAt: at,
    generator: 'test-generator',
  });

describe('buildLockFile', () => {
  const lock = buildTwo();

  it('sorts both key spaces, so the file only diffs where content changed', () => {
    expect(Object.keys(lock.files)).toEqual([...Object.keys(lock.files)].sort());
    expect(Object.keys(lock.assets)).toEqual(['a.one', 'b.two']);
  });

  it('counts entries and distinct urls', () => {
    expect(lock.totals.entries).toBe(2);
    expect(lock.totals.files).toBe(3);
  });

  it("sorts each asset's file list", () => {
    expect(lock.assets['b.two'].files).toEqual([
      'https://example.test/m.bin',
      'https://example.test/z.bin',
    ]);
  });

  it('honours the options object', () => {
    expect(lock.generatedAt).toBe(AT);
    expect(lock.generator).toBe('test-generator');
  });
});

describe('lockFilesDiffer', () => {
  it('is true when there is nothing to compare against', () => {
    expect(lockFilesDiffer(undefined, buildTwo())).toBe(true);
  });

  it('ignores generatedAt', () => {
    // This is the property that keeps a phantom diff off every reviewer's
    // screen on a warm re-run.
    expect(lockFilesDiffer(buildTwo(AT), buildTwo('2025-06-06T12:00:00.000Z'))).toBe(false);
  });

  it('is true when a recorded sha256 changes', () => {
    const changed = buildTwo();
    const url = 'https://example.test/a.bin';
    const mutated = {
      ...changed,
      files: { ...changed.files, [url]: { ...changed.files[url], sha256: 'different' } },
    };
    expect(lockFilesDiffer(buildTwo(), mutated)).toBe(true);
  });
});

describe('serializeLockFile', () => {
  it('ends with exactly one newline and round-trips', () => {
    const lock = buildTwo();
    const text = serializeLockFile(lock);

    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(JSON.parse(text)).toEqual(lock);
  });
});

/* -------------------------------------------------------------------------- */
/* log.ts — formatters                                                        */
/* -------------------------------------------------------------------------- */

describe('formatters', () => {
  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [1048576, '1.0 MB'],
    [1073741824, '1.00 GB'],
    [Number.NaN, '?'],
    [Number.POSITIVE_INFINITY, '?'],
  ])('formatBytes(%p) is %p', (input, expected) => {
    expect(formatBytes(input)).toBe(expected);
  });

  it.each([
    [-1, '--'],
    [Number.POSITIVE_INFINITY, '--'],
    [59_000, '59s'],
    [61_000, '1m01s'],
    [3_661_000, '1h01m'],
  ])('formatDuration(%p) is %p', (input, expected) => {
    expect(formatDuration(input)).toBe(expected);
  });

  it('formats a transfer rate, and refuses to divide by no time at all', () => {
    expect(formatRate(1048576, 1000)).toBe('1.0 MB/s');
    expect(formatRate(1048576, 0)).toBe('--');
  });
});

/* -------------------------------------------------------------------------- */
/* paths.ts                                                                   */
/* -------------------------------------------------------------------------- */

describe('paths', () => {
  it('shards the CAS two characters deep', () => {
    const sha = 'abcdef0123456789';
    expect(casPath(sha).endsWith(path.join('cas', 'ab', sha))).toBe(true);
  });

  it('shortens a path inside the repo and leaves anything outside alone', () => {
    expect(rel(path.join(REPO_ROOT, 'tools', 'x.ts'))).toBe(path.join('tools', 'x.ts'));
    expect(rel('/somewhere/else')).toBe('/somewhere/else');
  });
});

/* -------------------------------------------------------------------------- */
/* cache.ts — the 24h API envelope                                            */
/* -------------------------------------------------------------------------- */

describe('readJsonCache', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ttl-cache-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Write a hand-built envelope, bypassing `writeJsonCache`'s own shape. */
  async function envelope(name: string, content: unknown): Promise<string> {
    const file = path.join(dir, name);
    await writeFile(file, JSON.stringify(content));
    return file;
  }

  it('round-trips what writeJsonCache wrote', async () => {
    const file = path.join(dir, 'ok.json');
    await writeJsonCache(file, { a: 1 }, 60_000);
    await expect(readJsonCache(file)).resolves.toEqual({ a: 1 });
  });

  it('treats a null value as no cache at all', async () => {
    // A provider answering 200 with `null` during an outage would otherwise be
    // believed for the full 24h TTL, and every file it covers would quietly
    // drop to manifest-only verification with no way to clear it.
    const file = await envelope('null.json', {
      fetchedAt: new Date().toISOString(),
      ttlMs: 1000,
      value: null,
    });
    await expect(readJsonCache(file)).resolves.toBeUndefined();
  });

  it('rejects an envelope with no ttl, which would never expire', async () => {
    const file = await envelope('nottl.json', {
      fetchedAt: new Date().toISOString(),
      value: { a: 1 },
    });
    await expect(readJsonCache(file)).resolves.toBeUndefined();
  });

  it('rejects a non-numeric ttl', async () => {
    const file = await envelope('badttl.json', {
      fetchedAt: new Date().toISOString(),
      ttlMs: 'soon',
      value: { a: 1 },
    });
    await expect(readJsonCache(file)).resolves.toBeUndefined();
  });

  it('rejects a file that is not an envelope', async () => {
    await expect(
      readJsonCache(await envelope('str.json', 'just a string'))
    ).resolves.toBeUndefined();
  });

  it('rejects unparseable content and a path that does not exist', async () => {
    const broken = path.join(dir, 'broken.json');
    await writeFile(broken, 'not json');
    await expect(readJsonCache(broken)).resolves.toBeUndefined();
    await expect(readJsonCache(path.join(dir, 'absent.json'))).resolves.toBeUndefined();
  });

  it('rejects a stale envelope', async () => {
    const file = await envelope('stale.json', {
      fetchedAt: new Date(Date.now() - 10_000).toISOString(),
      ttlMs: 1000,
      value: { a: 1 },
    });
    await expect(readJsonCache(file)).resolves.toBeUndefined();
  });

  it('rejects an envelope written by a clock ahead of ours', async () => {
    const file = await envelope('future.json', {
      fetchedAt: new Date(Date.now() + 60_000).toISOString(),
      ttlMs: 60_000,
      value: { a: 1 },
    });
    await expect(readJsonCache(file)).resolves.toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* polyhaven.ts — the provider-metadata memo                                  */
/* -------------------------------------------------------------------------- */

describe('memoizeAsync', () => {
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('shares one in-flight success between concurrent callers', async () => {
    const store = new Map<string, Promise<unknown>>();
    let calls = 0;
    const make = async (): Promise<string> => {
      calls += 1;
      await tick();
      return 'value';
    };

    const [a, b] = await Promise.all([
      memoizeAsync(store, 'k', make),
      memoizeAsync(store, 'k', make),
    ]);
    expect([a, b]).toEqual(['value', 'value']);
    expect(calls).toBe(1);

    await expect(memoizeAsync(store, 'k', make)).resolves.toBe('value');
    expect(calls).toBe(1);
    expect(store.has('k')).toBe(true);
  });

  it('forgets a rejection so the next caller can retry', async () => {
    // Without this, one 503 that slips past withRetry while the first of 39
    // entries sharing an id resolves makes the other 38 fail instantly with
    // that same stale error, and no retry can ever run.
    const store = new Map<string, Promise<unknown>>();
    let calls = 0;
    const make = async (): Promise<string> => {
      calls += 1;
      if (calls === 1) throw new Error('503');
      return 'recovered';
    };

    await expect(memoizeAsync(store, 'k', make)).rejects.toThrow('503');
    await tick(); // let the eviction microtask run
    expect(store.has('k')).toBe(false);

    await expect(memoizeAsync(store, 'k', make)).resolves.toBe('recovered');
    expect(calls).toBe(2);
  });

  it('never mixes two keys', async () => {
    const store = new Map<string, Promise<unknown>>();
    const make = (value: string) => async (): Promise<string> => value;

    await expect(memoizeAsync(store, 'a', make('a'))).resolves.toBe('a');
    await expect(memoizeAsync(store, 'b', make('b'))).resolves.toBe('b');
    await expect(memoizeAsync(store, 'a', make('changed'))).resolves.toBe('a');
  });
});
