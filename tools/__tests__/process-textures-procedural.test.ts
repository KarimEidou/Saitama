/**
 * PROCEDURAL MAP GENERATION — THE PER-(MATERIAL, SIZE) MEMO
 *
 * Every generator produces albedo, normal and ORM together, but the encoder
 * asks for one role at a time and `planJobs` emits one job per role, so each
 * procedural material used to be generated three times per tier with two thirds
 * of the work discarded. Measured on this box: `generateGlass(2048)` is 10.8 s
 * and `generateGlass(1024)` is 2.5 s, ~128 s of pure waste across a full
 * three-tier run of the two procedural materials.
 *
 * The memo is only safe because the generators are pure and seeded from the
 * material id. The determinism-after-eviction case below is what proves that:
 * if regenerating produced different bytes, sharing one result between three
 * jobs would change the build's output, and the whole optimisation would be
 * unsound rather than merely fast.
 *
 * Sizes here are 64/128 so the file runs in well under a second.
 */

import { describe, expect, it } from 'vitest';
import { clearProceduralCache, proceduralMapsFor } from '../process-textures.ts';

const GLASS = 'mat.glass.window';
const MARKINGS = 'mat.road.markings';

describe('proceduralMapsFor', () => {
  it('returns the same object for a repeated (material, size)', () => {
    clearProceduralCache();
    const first = proceduralMapsFor(GLASS, 64);
    expect(proceduralMapsFor(GLASS, 64)).toBe(first);
  });

  it('keys on size, not just material', () => {
    clearProceduralCache();
    const small = proceduralMapsFor(GLASS, 64);
    const large = proceduralMapsFor(GLASS, 128);

    expect(large).not.toBe(small);
    expect(small.albedo.data.length).toBe(64 * 64 * 3);
    expect(large.albedo.data.length).toBe(128 * 128 * 3);
  });

  it('regenerates byte-identical maps after the cache is dropped', () => {
    clearProceduralCache();
    const before = proceduralMapsFor(GLASS, 64);
    clearProceduralCache();
    const after = proceduralMapsFor(GLASS, 64);

    expect(after).not.toBe(before);
    for (const role of ['albedo', 'normal', 'orm'] as const) {
      expect(Buffer.compare(before[role].data, after[role].data)).toBe(0);
    }
  });

  it('preserves the channel count each material declares', () => {
    clearProceduralCache();
    // The road-markings albedo carries the wear mask in alpha; glass does not.
    expect(proceduralMapsFor(MARKINGS, 64).albedo.channels).toBe(4);
    expect(proceduralMapsFor(GLASS, 64).albedo.channels).toBe(3);
  });

  it('refuses a material with no generator', () => {
    expect(() => proceduralMapsFor('mat.nope', 64)).toThrow(/no procedural generator/);
  });
});

describe('clearProceduralCache', () => {
  it('really empties the cache, so the memory is released between tiers', () => {
    clearProceduralCache();
    const first = proceduralMapsFor(GLASS, 64);
    clearProceduralCache();
    expect(proceduralMapsFor(GLASS, 64)).not.toBe(first);
  });
});
