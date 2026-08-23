/**
 * FETCH CLI — ENTRY-POINT GUARD, ARGUMENT PARSING, SELECTION
 *
 * This file existing at all is the point of the guard it tests.
 *
 * `tools/fetch-assets.ts` used to call `main()` at module scope with nothing
 * around it, so importing the module — from a test, from an editor's
 * auto-import, from a future tool wanting `parseArgs` — silently started
 * downloading 1.774 GB and rewriting `assets/assets.lock.json`. That is why the
 * `--only` / `--kind` / `--limit` / `--concurrency` semantics, which several
 * filed bugs revolve around, had no coverage: they could not be imported
 * without launching the pipeline.
 *
 * The run finishing in milliseconds with no network traffic and no write under
 * `assets/` IS the assertion that the guard works.
 */

import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONCURRENCY, isEntryPoint } from '../lib/index.ts';
import type { AnySourceEntry } from '../lib/index.ts';
import { parseArgs, selectEntries } from '../fetch-assets.ts';

describe('isEntryPoint', () => {
  it('is false when there is no argv[1] at all', () => {
    expect(isEntryPoint(undefined, 'file:///x.ts')).toBe(false);
  });

  it('is true for the module that was invoked', () => {
    expect(isEntryPoint('/a/b.ts', pathToFileURL('/a/b.ts').href)).toBe(true);
  });

  it('is false for a different module', () => {
    expect(isEntryPoint('/a/other.ts', pathToFileURL('/a/b.ts').href)).toBe(false);
  });

  it('still matches a checkout whose path needs percent-encoding', () => {
    // The regression this helper exists for: comparing
    // `new URL(import.meta.url).pathname` (percent-ENCODED) against a raw
    // `process.argv[1]` is false for every path containing a space, so the CLI
    // loads, runs nothing and exits 0.
    const file = '/home/u/My Projects/s/tools/f.ts';
    expect(isEntryPoint(file, pathToFileURL(file).href)).toBe(true);
  });
});

describe('parseArgs', () => {
  it('defaults to a full, non-frozen, online run', () => {
    expect(parseArgs([])).toEqual({
      only: [],
      kinds: [],
      limit: undefined,
      frozen: false,
      verify: false,
      dryRun: false,
      offline: false,
      quiet: false,
      help: false,
      concurrency: DEFAULT_CONCURRENCY,
    });
  });

  it('splits and trims --only in both the spaced and inline forms', () => {
    expect(parseArgs(['--only', 'a, b']).only).toEqual(['a', 'b']);
    expect(parseArgs(['--only=a,b']).only).toEqual(['a', 'b']);
  });

  it('splits --kind', () => {
    expect(parseArgs(['--kind', 'hdri,model']).kinds).toEqual(['hdri', 'model']);
  });

  it('accepts a positive --limit and rejects anything else', () => {
    expect(parseArgs(['--limit', '3']).limit).toBe(3);
    expect(() => parseArgs(['--limit', '0'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--limit', 'x'])).toThrow(/positive integer/);
  });

  it('bounds --concurrency to 1..32', () => {
    expect(parseArgs(['--concurrency', '6']).concurrency).toBe(6);
    expect(() => parseArgs(['--concurrency', '0'])).toThrow(/1\.\.32/);
    expect(() => parseArgs(['--concurrency', '33'])).toThrow(/1\.\.32/);
  });

  it('sets every boolean flag', () => {
    const options = parseArgs(['--frozen', '--verify', '--dry-run', '--offline', '--quiet']);
    expect(options.frozen).toBe(true);
    expect(options.verify).toBe(true);
    expect(options.dryRun).toBe(true);
    expect(options.offline).toBe(true);
    expect(options.quiet).toBe(true);
  });

  it('accepts --dryrun as an alias of --dry-run', () => {
    expect(parseArgs(['--dryrun']).dryRun).toBe(true);
  });

  it('accepts both spellings of help', () => {
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it('rejects an unknown flag rather than ignoring it', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown flag/);
  });
});

describe('selectEntries', () => {
  const entry = (id: string, providerAssetId: string, kind: string): AnySourceEntry =>
    ({ id, providerAssetId, kind }) as unknown as AnySourceEntry;

  const ENTRIES = [
    entry('mat.a.asphalt', 'asphalt_02', 'material'),
    entry('model.prop.hydrant', 'fire_hydrant', 'model'),
    entry('hdri.sky.day', 'kloofendal', 'hdri'),
  ];

  /** `parseArgs([])` shape, so a case only states the filter it is about. */
  const options = (overrides: Partial<ReturnType<typeof parseArgs>> = {}) => ({
    ...parseArgs([]),
    ...overrides,
  });

  it('returns everything when nothing is filtered', () => {
    expect(selectEntries(ENTRIES, options())).toHaveLength(3);
  });

  it('filters by kind', () => {
    const selected = selectEntries(ENTRIES, options({ kinds: ['hdri'] }));
    expect(selected.map((e) => e.id)).toEqual(['hdri.sky.day']);
  });

  it('matches --only against the id', () => {
    expect(selectEntries(ENTRIES, options({ only: ['asphalt'] })).map((e) => e.id)).toEqual([
      'mat.a.asphalt',
    ]);
  });

  it('matches --only against the provider asset id', () => {
    expect(selectEntries(ENTRIES, options({ only: ['fire_hydrant'] })).map((e) => e.id)).toEqual([
      'model.prop.hydrant',
    ]);
  });

  it('returns nothing when --only matches nothing', () => {
    expect(selectEntries(ENTRIES, options({ only: ['nope'] }))).toEqual([]);
  });

  it('truncates to --limit', () => {
    expect(selectEntries(ENTRIES, options({ limit: 2 }))).toHaveLength(2);
  });

  it('composes kind, only and limit', () => {
    const selected = selectEntries(
      ENTRIES,
      options({ kinds: ['material', 'model'], only: ['a'], limit: 1 })
    );
    expect(selected.map((e) => e.id)).toEqual(['mat.a.asphalt']);
  });
});
