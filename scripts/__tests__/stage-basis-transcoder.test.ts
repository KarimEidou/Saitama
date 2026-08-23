/**
 * BASIS TRANSCODER STAGING
 *
 * The regression these cover is invisible from the build log: nothing imports
 * `basis_transcoder.js`, so a build with no staging step exits 0 and ships a
 * city rendered entirely as the missing-asset checker. The copy has to be
 * BYTE-exact (a truncated wasm fails the same silent way), it has to survive
 * being run twice — `vite dev` fires `buildStart` on every restart — and, the
 * part that actually broke, the plugin has to be REGISTERED in vite.config.ts
 * rather than merely existing on disk.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASIS_TRANSCODER_FILES,
  basisTranscoderPlugin,
  stageBasisTranscoder,
} from '../stage-basis-transcoder';
import viteConfig from '../../vite.config';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASIS_SRC = path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis');

/** Every scratch tree made during a test, torn down in `afterEach`. */
const scratch: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'basis-stage-'));
  scratch.push(dir);
  return dir;
}

/**
 * Vite types every hook as an `ObjectHook` (function OR `{ handler, order }`).
 * Ours are plain methods, so narrow once here instead of at each call site.
 */
function hookFn(hook: unknown): (...args: never[]) => unknown {
  if (typeof hook !== 'function') throw new Error('expected a plain function hook');
  return hook as (...args: never[]) => unknown;
}

afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true });
});

describe('stageBasisTranscoder', () => {
  it('writes both transcoder files byte-for-byte into <assetRoot>/basis', () => {
    const dir = freshDir();
    const written = stageBasisTranscoder(dir);

    expect(written).toEqual(BASIS_TRANSCODER_FILES.map((file) => path.join(dir, 'basis', file)));
    for (const file of BASIS_TRANSCODER_FILES) {
      const staged = path.join(dir, 'basis', file);
      expect(existsSync(staged)).toBe(true);
      // Compare bytes, not lengths: a truncated wasm still "exists" and still
      // produces a checkerboard city, just with an uglier console message.
      expect(Buffer.compare(readFileSync(staged), readFileSync(path.join(BASIS_SRC, file)))).toBe(
        0
      );
    }
  });

  it('is idempotent — a second pass leaves the same bytes', () => {
    const dir = freshDir();
    stageBasisTranscoder(dir);
    const written = stageBasisTranscoder(dir);

    expect(written).toHaveLength(BASIS_TRANSCODER_FILES.length);
    for (const file of BASIS_TRANSCODER_FILES) {
      expect(
        Buffer.compare(
          readFileSync(path.join(dir, 'basis', file)),
          readFileSync(path.join(BASIS_SRC, file))
        )
      ).toBe(0);
    }
  });

  it('overwrites a stale or truncated staged copy', () => {
    const dir = freshDir();
    stageBasisTranscoder(dir);
    // A truncated wasm "exists" and still produces a checkerboard city — the
    // copy has to be unconditional, not existence-guarded.
    writeFileSync(path.join(dir, 'basis', 'basis_transcoder.wasm'), Buffer.alloc(16));
    stageBasisTranscoder(dir);
    expect(
      Buffer.compare(
        readFileSync(path.join(dir, 'basis', 'basis_transcoder.wasm')),
        readFileSync(path.join(BASIS_SRC, 'basis_transcoder.wasm'))
      )
    ).toBe(0);
  });

  it('throws loudly when the transcoder is absent from node_modules', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const real = await importOriginal<typeof import('node:fs')>();
      return { ...real, default: real, existsSync: () => false };
    });
    try {
      const mod = await import('../stage-basis-transcoder');
      expect(() => mod.stageBasisTranscoder(freshDir())).toThrow(/Basis transcoder missing/);
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });
});

describe('basisTranscoderPlugin', () => {
  it('exposes both build hooks under its documented name', () => {
    const plugin = basisTranscoderPlugin();
    expect(plugin.name).toBe('stage-basis-transcoder');
    expect(plugin.buildStart).toBeDefined();
    expect(plugin.closeBundle).toBeDefined();
  });

  it('stages nothing while VITEST is set, so `npm test` never writes into the tree', () => {
    // The guard is load-bearing: with no vitest.config.ts, `vitest run` loads
    // vite.config.ts and its dev server fires buildStart on the real repo.
    expect(process.env.VITEST).toBeDefined();

    const dir = freshDir();
    const plugin = basisTranscoderPlugin();
    hookFn(plugin.configResolved)({
      root: dir,
      publicDir: path.join(dir, 'public'),
      build: { outDir: path.join(dir, 'dist'), assetsDir: 'assets' },
    } as never);
    hookFn(plugin.buildStart)();
    hookFn(plugin.closeBundle)();

    expect(existsSync(path.join(dir, 'public'))).toBe(false);
    expect(existsSync(path.join(dir, 'dist'))).toBe(false);
  });

  it('with publicDir disabled, stages into the build output only — never beside the cwd', () => {
    const dir = freshDir();
    const plugin = basisTranscoderPlugin();
    // `publicDir: false` resolves to '' — path.join('', 'assets') is the
    // RELATIVE 'assets', which would land in whatever cwd the build ran from.
    hookFn(plugin.configResolved)({
      root: dir,
      publicDir: '',
      build: { outDir: path.join(dir, 'dist'), assetsDir: 'assets' },
    } as never);

    const vitest = process.env.VITEST;
    delete process.env.VITEST; // the hooks no-op otherwise; restored below
    try {
      hookFn(plugin.buildStart)();
      hookFn(plugin.closeBundle)();
    } finally {
      if (vitest !== undefined) process.env.VITEST = vitest;
    }

    for (const file of BASIS_TRANSCODER_FILES) {
      expect(existsSync(path.join(dir, 'dist', 'assets', 'basis', file))).toBe(true);
    }
    // The stray-staging regression: <repo>/assets exists, <repo>/assets/basis must not.
    expect(existsSync(path.join(process.cwd(), 'assets', 'basis'))).toBe(false);
  });
});

describe('vite.config.ts', () => {
  it('registers the staging plugin — the build is the only thing that stages it', () => {
    const plugins = (viteConfig.plugins ?? []) as unknown as ReadonlyArray<{ name?: string }>;
    expect(plugins.map((plugin) => plugin.name)).toContain('stage-basis-transcoder');
  });
});
