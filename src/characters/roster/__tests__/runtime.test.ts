/**
 * THE RUNTIME LOADER — a missing bake is a steady state, not a retry loop
 *
 * A fresh clone that has never run `tools/build-characters.ts` must still boot,
 * so `load()` resolving `false` is normal and callers poll it on every spawn
 * (`if (!isResident(id)) void load(id)`). That makes two things load-bearing:
 * a failure has to be REMEMBERED, or every monster spawn re-issues the same
 * 404s for the whole session, and whatever did decode before the failure has to
 * be RELEASED, or each attempt strands an ImageBitmap.
 */

import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import type { QualityTier } from '@/types';
import { RosterRuntime, type IBakedAssetSource } from '../runtime';

const source: IBakedAssetSource = {
  resolveFile: (file) => `https://roster.test/${file}`,
  selectTier: (): QualityTier => 'mobile',
};

interface Stubs {
  readonly fetched: string[];
  /** Bitmaps handed out by `createImageBitmap` that were closed again. */
  readonly closed: string[];
}

const originalFetch = globalThis.fetch;
const originalCreateImageBitmap = globalThis.createImageBitmap;

/** Serve only the files in `available`; everything else 404s. */
function stubNetwork(available: readonly string[]): Stubs {
  const fetched: string[] = [];
  const closed: string[] = [];
  let current = '';

  globalThis.fetch = ((url: string) => {
    fetched.push(url);
    current = url;
    const ok = available.some((name) => url.endsWith(name));
    return Promise.resolve({
      ok,
      status: ok ? 200 : 404,
      blob: () => Promise.resolve({}),
    });
  }) as unknown as typeof fetch;

  globalThis.createImageBitmap = (() => {
    const name = current;
    return Promise.resolve({ width: 4, height: 4, close: () => closed.push(name) });
  }) as unknown as typeof createImageBitmap;

  return { fetched, closed };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.createImageBitmap = originalCreateImageBitmap;
});

describe('roster runtime loading', () => {
  it('remembers a missing bake instead of re-fetching it on every spawn', async () => {
    const stubs = stubNetwork([]);
    const runtime = new RosterRuntime({ source });

    expect(await runtime.load('chr.saitama')).toBe(false);
    const firstAttempt = stubs.fetched.length;
    expect(firstAttempt).toBeGreaterThan(0);
    expect(runtime.failed.has('chr.saitama')).toBe(true);
    expect(runtime.isResident('chr.saitama')).toBe(false);

    // Five more spawns of the same character: not one more request.
    for (let i = 0; i < 5; i++) expect(await runtime.load('chr.saitama')).toBe(false);
    expect(stubs.fetched.length).toBe(firstAttempt);

    // `retry` is the deliberate escape hatch for the transient case.
    expect(await runtime.retry('chr.saitama')).toBe(false);
    expect(stubs.fetched.length).toBeGreaterThan(firstAttempt);
    runtime.dispose();
  });

  it('releases the maps that did decode when a structural map fails', async () => {
    // Albedo lands, the normal map 404s. The albedo texture is now unreachable
    // and its ImageBitmap is not reclaimed by `dispose()` alone.
    const stubs = stubNetwork(['albedo.mobile.png']);
    const runtime = new RosterRuntime({ source });

    expect(await runtime.load('chr.saitama')).toBe(false);
    expect(stubs.closed).toEqual(['https://roster.test/chr/saitama/albedo.mobile.png']);
    runtime.dispose();
  });

  it('binds the crowd tint mask with point sampling', async () => {
    // The mask holds class ids that the shader decodes with band tests, so any
    // filtering — including a mip's box filter — decodes a different tint slot.
    const stubs = stubNetwork([
      'albedo.mobile.png',
      'normal.mobile.png',
      'orm.mobile.png',
      'face.mobile.png',
      'mask.mobile.png',
    ]);
    const runtime = new RosterRuntime({ source });

    expect(await runtime.load('chr.civilian')).toBe(true);
    expect(stubs.fetched.some((url) => url.endsWith('mask.mobile.png'))).toBe(true);

    const material = runtime.createMaterial('chr.civilian', { u0: 0, v0: 0, u1: 1, v1: 1 });
    const mask = material?.userData.roster.crowdMask.value as THREE.Texture;
    expect(mask.generateMipmaps).toBe(false);
    expect(mask.minFilter).toBe(THREE.NearestFilter);
    expect(mask.magFilter).toBe(THREE.NearestFilter);
    expect(mask.anisotropy).toBe(1);
    // Everything else is a colour map and keeps its mip chain.
    expect(material?.map?.generateMipmaps).toBe(true);
    expect(material?.map?.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    runtime.dispose();
  });
});
