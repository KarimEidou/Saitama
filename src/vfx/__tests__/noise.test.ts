/**
 * The numeric floor under the generated atlases and the camera shake.
 *
 * The atlas tests can only observe these properties indirectly, through 128x128
 * texel dumps, so the promises the module header makes in prose are pinned here
 * directly: hashes stay in [0, 1) and reproduce exactly for a seed, value noise
 * is TOROIDAL so a rotated atlas tile has no seam at the quad edge, and the
 * local `smoothstep` ramps DOWNWARD for descending edges — which is a behaviour
 * GLSL leaves undefined and `atlas.ts` nonetheless depends on.
 */

import { describe, expect, it } from 'vitest';
import {
  distanceToSegmentSq,
  fbm,
  hash1,
  hash2,
  ridgedFbm,
  smoothstep,
  valueNoise,
} from '../noise';

describe('hash1 / hash2', () => {
  it('lands in [0, 1) over a few hundred lattice points', () => {
    for (let x = -8; x < 8; x++) {
      for (let y = -8; y < 8; y++) {
        const a = hash2(x, y, 1234);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThan(1);
        const b = hash1(x * 16 + y, 1234);
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThan(1);
      }
    }
  });

  it('reproduces exactly for a seed and differs for another', () => {
    const sample = (seed: number): number[] => {
      const out: number[] = [];
      for (let i = 0; i < 64; i++) out.push(hash2(i, i * 3, seed), hash1(i, seed));
      return out;
    };
    expect(sample(7)).toEqual(sample(7));
    expect(sample(8)).not.toEqual(sample(7));
  });
});

describe('valueNoise', () => {
  it('wraps on the cell torus, so a rotated tile has no seam', () => {
    const cells = 8;
    for (const [x, y] of [
      [1.25, 2.5],
      [0.75, 6.125],
      [5.5, 0.25],
    ]) {
      const base = valueNoise(x!, y!, cells, 99);
      expect(valueNoise(x! + cells, y!, cells, 99)).toBeCloseTo(base, 12);
      expect(valueNoise(x!, y! + cells, cells, 99)).toBeCloseTo(base, 12);
      expect(valueNoise(x! + cells, y! + cells, cells, 99)).toBeCloseTo(base, 12);
    }
  });

  it('stays inside [0, 1] and is deterministic', () => {
    for (let i = 0; i <= 16; i++) {
      for (let j = 0; j <= 16; j++) {
        const x = (i / 16) * 4;
        const y = (j / 16) * 4;
        const n = valueNoise(x, y, 4, 5150);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(1);
        expect(valueNoise(x, y, 4, 5150)).toBe(n);
      }
    }
  });
});

describe('fbm / ridgedFbm', () => {
  it('stay inside [0, 1] over a sampled grid and repeat exactly', () => {
    for (let i = 0; i <= 12; i++) {
      for (let j = 0; j <= 12; j++) {
        const u = i / 12;
        const v = j / 12;
        const a = fbm(u, v, 4242);
        const b = ridgedFbm(u, v, 4242);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(1);
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThanOrEqual(1);
        expect(fbm(u, v, 4242)).toBe(a);
        expect(ridgedFbm(u, v, 4242)).toBe(b);
      }
    }
  });
});

describe('distanceToSegmentSq', () => {
  it('is zero on the segment', () => {
    expect(distanceToSegmentSq(5, 0, 0, 0, 10, 0)).toBeCloseTo(0, 12);
    expect(distanceToSegmentSq(0, 0, 0, 0, 10, 0)).toBeCloseTo(0, 12);
    expect(distanceToSegmentSq(10, 0, 0, 0, 10, 0)).toBeCloseTo(0, 12);
  });

  it('is the perpendicular distance beside it', () => {
    expect(distanceToSegmentSq(5, 3, 0, 0, 10, 0)).toBeCloseTo(9, 12);
  });

  it('clamps to the nearer endpoint beyond it', () => {
    expect(distanceToSegmentSq(15, 0, 0, 0, 10, 0)).toBeCloseTo(25, 12);
    expect(distanceToSegmentSq(-4, 3, 0, 0, 10, 0)).toBeCloseTo(25, 12);
  });

  it('degrades to the distance to `a` for a zero-length segment', () => {
    expect(distanceToSegmentSq(5, 6, 2, 2, 2, 2)).toBeCloseTo(25, 12);
  });
});

describe('smoothstep', () => {
  it('matches GLSL for ascending edges', () => {
    expect(smoothstep(0, 1, 0)).toBe(0);
    expect(smoothstep(0, 1, 1)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 12);
    expect(smoothstep(0, 1, -5)).toBe(0);
    expect(smoothstep(0, 1, 5)).toBe(1);
  });

  it('ramps DOWNWARD for descending edges, which atlas.ts depends on', () => {
    expect(smoothstep(1, 0.84, 1)).toBe(0);
    expect(smoothstep(1, 0.84, 0.84)).toBe(1);
    let previous = smoothstep(1, 0.84, 1);
    for (const x of [0.97, 0.94, 0.91, 0.88, 0.85]) {
      const current = smoothstep(1, 0.84, x);
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }
    // i.e. the falloff decreases as `dist` grows — the tile painters' idiom.
    expect(smoothstep(1, 0.84, 0.9)).toBeGreaterThan(smoothstep(1, 0.84, 0.95));
  });

  it('degrades equal edges to a hard step rather than to zero', () => {
    // This is the difference from `@/util`'s smoothstep, and the reason this
    // local copy exists.
    expect(smoothstep(0.5, 0.5, 0.6)).toBe(1);
    expect(smoothstep(0.5, 0.5, 0.4)).toBe(0);
  });
});
