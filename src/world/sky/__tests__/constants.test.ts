/**
 * TUNING-CONSTANT INVARIANTS
 *
 * `constants.ts` makes structural promises in prose — ascending keyframes, a
 * seamless midnight wrap, times pinned to the solar model — that
 * `sampleSkyBlend` and `phaseForTime` both rely on and neither validates.
 * `sampleSkyBlend`'s scan is `while (i < keys.length - 2 && t >= keys[i + 1].t)`
 * and `phaseForTime` keeps the LAST boundary that matched, so an out-of-order
 * edit produces a wrong sky for part of the day and no failure anywhere. These
 * are those promises, as assertions.
 */

import { describe, expect, it } from 'vitest';
import {
  EVENING_START,
  MAX_BLEND_RADIANCE,
  PHASE_BOUNDARIES,
  SKY_ASSET_IDS,
  SUN_EXTINCTION_ELEVATION,
  TIME_KEYFRAMES,
} from '../constants';
import { phaseForTime } from '../sky-lighting';
import { sunPosition } from '../solar';

const RAD2DEG = 180 / Math.PI;

/** Bisect the elevation-zero crossing of the shipped solar configuration. */
function crossing(lo: number, hi: number): number {
  const f = (t: number): number => sunPosition(t).elevation;
  let a = lo;
  let b = hi;
  for (let i = 0; i < 60; i++) {
    const m = (a + b) / 2;
    if (f(a) * f(m) <= 0) b = m;
    else a = m;
  }
  return (a + b) / 2;
}

describe('TIME_KEYFRAMES', () => {
  it('is strictly ascending and spans the whole cycle', () => {
    expect(TIME_KEYFRAMES[0]!.t).toBe(0);
    expect(TIME_KEYFRAMES[TIME_KEYFRAMES.length - 1]!.t).toBe(1);
    for (let i = 1; i < TIME_KEYFRAMES.length; i++) {
      expect(TIME_KEYFRAMES[i]!.t).toBeGreaterThan(TIME_KEYFRAMES[i - 1]!.t);
    }
  });

  it('wraps seamlessly: first and last keyframe agree', () => {
    const first = TIME_KEYFRAMES[0]!;
    const last = TIME_KEYFRAMES[TIME_KEYFRAMES.length - 1]!;
    expect(last.sky).toBe(first.sky);
    expect(last.luminance).toBeCloseTo(first.luminance, 9);
  });

  it('names only real skies and stays on a positive luminance', () => {
    const keys = Object.keys(SKY_ASSET_IDS);
    for (const frame of TIME_KEYFRAMES) {
      expect(keys).toContain(frame.sky);
      // Log-space interpolation: a zero or negative luminance is -Infinity or
      // NaN in `sampleSkyBlend`.
      expect(frame.luminance).toBeGreaterThan(0);
    }
  });

  it('puts the 1.0 luminance reference at noon', () => {
    const noon = TIME_KEYFRAMES.find((f) => f.t === 0.5);
    expect(noon).toBeDefined();
    expect(noon!.luminance).toBe(1);
    expect(noon!.sky).toBe('day');
  });
});

describe('PHASE_BOUNDARIES', () => {
  it('is strictly ascending and inside the cycle', () => {
    for (let i = 0; i < PHASE_BOUNDARIES.length; i++) {
      expect(PHASE_BOUNDARIES[i]!.start).toBeGreaterThan(0);
      expect(PHASE_BOUNDARIES[i]!.start).toBeLessThan(1);
      if (i > 0) {
        expect(PHASE_BOUNDARIES[i]!.start).toBeGreaterThan(PHASE_BOUNDARIES[i - 1]!.start);
      }
    }
  });

  it('names every boundary phase exactly at its start', () => {
    for (const boundary of PHASE_BOUNDARIES) {
      expect(phaseForTime(boundary.start)).toBe(boundary.phase);
    }
  });
});

describe('the curve is pinned to the solar model', () => {
  it('starts dawn at sunrise', () => {
    const sunrise = crossing(0.1, 0.3); // 0.187605 -> 04:30
    expect(sunrise).toBeCloseTo(0.1876, 4);
    expect(Math.abs(PHASE_BOUNDARIES[0]!.start - sunrise)).toBeLessThan(0.002); // ~3 min
    expect(PHASE_BOUNDARIES[0]!.phase).toBe('dawn');
  });

  it('starts the window-lighting evening at sunset', () => {
    const sunset = crossing(0.7, 0.9); // 0.788129 -> 18:55
    expect(sunset).toBeCloseTo(0.7881, 4);
    expect(Math.abs(EVENING_START - sunset)).toBeLessThan(0.003); // ~4 min
  });

  it('extinguishes direct sun at civil twilight, not at the horizon', () => {
    // The disc is still refracted into view at elevation 0, so a hard cut there
    // is the single most obvious "this is a game" tell in a day/night cycle.
    expect(SUN_EXTINCTION_ELEVATION * RAD2DEG).toBeLessThan(-5);
    expect(SUN_EXTINCTION_ELEVATION * RAD2DEG).toBeGreaterThan(-7);
  });
});

describe('MAX_BLEND_RADIANCE', () => {
  it('stays under the half-float ceiling it exists to respect', () => {
    // One +Infinity anywhere in a PMREM convolution poisons the whole mip chain
    // with NaN, and the day map's normalised sun disc lands at ~89 000.
    expect(MAX_BLEND_RADIANCE).toBeGreaterThan(0);
    expect(MAX_BLEND_RADIANCE).toBeLessThan(65504);
  });
});
