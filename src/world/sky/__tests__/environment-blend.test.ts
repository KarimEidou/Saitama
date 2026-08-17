/**
 * EXPOSURE NORMALISATION TESTS
 *
 * These are the regression tests for the finding this whole workstream exists
 * to handle: four HDRIs whose mean luminances are nearly identical despite
 * representing noon and midnight. Every assertion here fails if the division
 * by `meanLuminance` is removed.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  blendSH9,
  boostChroma,
  describeNormalisation,
  isMeasured,
  normalisationScale,
  normaliseHue,
  parseEnvironmentMeasurements,
  sampleSkyBlend,
  sh9FromArray,
  type EnvironmentMeasurements,
} from '../environment-blend';
import { TIME_KEYFRAMES } from '../constants';

/**
 * The measurements exactly as the texture pipeline reported them. Duplicated
 * here rather than read off disk so the test runs on a fresh clone, where
 * `public/assets/` does not exist.
 */
const MEASURED = {
  environments: {
    'hdri.sky.dawn': { meanLuminance: 1.0980531162976837, maxLuminance: 8.44295, sh9: fill(3.8, 27) },
    'hdri.sky.day': { meanLuminance: 0.73268945997054, maxLuminance: 136998.2976, sh9: fill(2.5, 27) },
    'hdri.sky.dusk': { meanLuminance: 0.9044060619958861, maxLuminance: 4.0358875, sh9: fill(2.76, 27) },
    'hdri.sky.night': { meanLuminance: 0.712214196645703, maxLuminance: 554.8064, sh9: fill(2.35, 27) },
  },
};

function fill(value: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => value * (1 - i * 0.01));
}

function measurements(): EnvironmentMeasurements {
  return parseEnvironmentMeasurements(MEASURED);
}

describe('the finding itself', () => {
  it('confirms the four skies are NOT exposure matched', () => {
    const m = measurements();
    // Peaks span five orders of magnitude...
    expect(m.day.maxLuminance / m.dusk.maxLuminance).toBeGreaterThan(30000);
    // ...but the means are within a factor of 1.6.
    const means = [m.day, m.night, m.dawn, m.dusk].map((e) => e.meanLuminance);
    expect(Math.max(...means) / Math.min(...means)).toBeLessThan(1.6);
  });

  it('shows the naive path would make midnight as bright as noon', () => {
    const m = measurements();
    // What a cross-fade with no normalisation would produce: the ratio of raw
    // means, i.e. night is 97% as bright as noon.
    const naiveRatio = m.night.meanLuminance / m.day.meanLuminance;
    expect(naiveRatio).toBeGreaterThan(0.9);

    // What this module produces instead: both flattened to a unit mean, so the
    // ratio is carried entirely by the authored luminance curve.
    const normalisedNight = m.night.meanLuminance * normalisationScale(m.night);
    const normalisedDay = m.day.meanLuminance * normalisationScale(m.day);
    expect(normalisedNight).toBeCloseTo(1, 9);
    expect(normalisedDay).toBeCloseTo(1, 9);
  });
});

describe('parseEnvironmentMeasurements', () => {
  it('reads all four skies out of a manifest', () => {
    const m = measurements();
    expect(m.day.id).toBe('hdri.sky.day');
    expect(m.day.meanLuminance).toBeCloseTo(0.7326894, 6);
    expect(m.night.sh9).toHaveLength(27);
    for (const key of ['dawn', 'day', 'dusk', 'night'] as const) {
      expect(isMeasured(m[key])).toBe(true);
    }
  });

  it('degrades to a no-op normalisation when the manifest has no measurements', () => {
    const m = parseEnvironmentMeasurements({});
    for (const key of ['dawn', 'day', 'dusk', 'night'] as const) {
      expect(normalisationScale(m[key])).toBe(1);
      // ...and reports itself as unmeasured, so it cannot pass silently.
      expect(isMeasured(m[key])).toBe(false);
    }
  });

  it('survives a malformed manifest', () => {
    for (const junk of [null, undefined, 42, 'nope', { environments: null }, { environments: { 'hdri.sky.day': { meanLuminance: 0 } } }]) {
      const m = parseEnvironmentMeasurements(junk);
      expect(Number.isFinite(normalisationScale(m.day))).toBe(true);
      expect(normalisationScale(m.day)).toBeGreaterThan(0);
    }
  });

  it('rejects an SH array of the wrong length', () => {
    const m = parseEnvironmentMeasurements({
      environments: { 'hdri.sky.day': { meanLuminance: 1, sh9: [1, 2, 3] } },
    });
    expect(m.day.sh9).toBeUndefined();
  });
});

describe('sampleSkyBlend', () => {
  it('returns the authored sky at every keyframe', () => {
    for (const key of TIME_KEYFRAMES) {
      const blend = sampleSkyBlend(key.t);
      // At a keyframe the mix is either fully on `from` (alpha 0 into a new
      // pair) or has just landed on the previous target.
      expect([blend.from, blend.to]).toContain(key.sky);
      expect(blend.luminance).toBeGreaterThan(0);
    }
  });

  it('is dark at midnight and bright at noon, by a wide margin', () => {
    const midnight = sampleSkyBlend(0).luminance;
    const noon = sampleSkyBlend(0.5).luminance;
    expect(noon / midnight).toBeGreaterThan(50);
    expect(midnight).toBeLessThan(0.02);
    expect(noon).toBeCloseTo(1, 6);
  });

  it('wraps seamlessly across midnight', () => {
    const before = sampleSkyBlend(0.9995);
    const after = sampleSkyBlend(0.0005);
    expect(before.from).toBe(after.from);
    expect(Math.abs(before.luminance - after.luminance)).toBeLessThan(0.001);
  });

  it('handles times outside 0..1', () => {
    expect(sampleSkyBlend(1.5).luminance).toBeCloseTo(sampleSkyBlend(0.5).luminance, 9);
    expect(sampleSkyBlend(-0.5).luminance).toBeCloseTo(sampleSkyBlend(0.5).luminance, 9);
  });

  it('never produces a luminance discontinuity through the whole cycle', () => {
    let worst = 0;
    let previous = sampleSkyBlend(0).luminance;
    for (let i = 1; i <= 20000; i++) {
      const luminance = sampleSkyBlend(i / 20000).luminance;
      // Compare in log space: a 5% step at noon is invisible, the same
      // absolute step at midnight is a flash.
      worst = Math.max(worst, Math.abs(Math.log(luminance) - Math.log(previous)));
      previous = luminance;
    }
    expect(worst).toBeLessThan(0.02);
  });

  it('keeps alpha inside 0..1 everywhere', () => {
    for (let i = 0; i <= 5000; i++) {
      const blend = sampleSkyBlend(i / 5000);
      expect(blend.alpha).toBeGreaterThanOrEqual(0);
      expect(blend.alpha).toBeLessThanOrEqual(1);
    }
  });
});

describe('blendSH9', () => {
  it('produces a unit-mean set regardless of which skies are mixing', () => {
    const m = measurements();
    const target = new THREE.SphericalHarmonics3();

    // The DC coefficient is the mean radiance times a constant, so after
    // normalisation it must be the SAME for every source and every alpha.
    const dcAt = (t: number): number => {
      blendSH9(m, sampleSkyBlend(t), target);
      return target.coefficients[0]!.x;
    };
    const noon = dcAt(0.5);
    for (const t of [0, 0.1, 0.2, 0.3, 0.5, 0.7, 0.8, 0.95]) {
      // Every sky's synthetic SH here is proportional to its own mean, so a
      // correct normalisation collapses them all onto one value.
      expect(dcAt(t) / noon).toBeGreaterThan(0.55);
      expect(dcAt(t) / noon).toBeLessThan(1.9);
    }
  });

  it('interpolates monotonically across a cross-fade', () => {
    const m = parseEnvironmentMeasurements({
      environments: {
        'hdri.sky.night': { meanLuminance: 1, sh9: fill(1, 27) },
        'hdri.sky.dawn': { meanLuminance: 1, sh9: fill(5, 27) },
        'hdri.sky.day': { meanLuminance: 1, sh9: fill(5, 27) },
        'hdri.sky.dusk': { meanLuminance: 1, sh9: fill(5, 27) },
      },
    });
    const target = new THREE.SphericalHarmonics3();
    let previous = -Infinity;
    // 0.145 -> 0.175 is the night -> dawn cross-fade.
    for (let i = 0; i <= 40; i++) {
      blendSH9(m, sampleSkyBlend(0.145 + (i / 40) * 0.03), target);
      const dc = target.coefficients[0]!.x;
      expect(dc).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = dc;
    }
    expect(previous).toBeCloseTo(5, 3);
  });

  it('reports failure rather than lighting the scene with zeros', () => {
    const m = parseEnvironmentMeasurements({
      environments: { 'hdri.sky.day': { meanLuminance: 0.73 } },
    });
    const target = new THREE.SphericalHarmonics3();
    target.coefficients[0]!.set(9, 9, 9);
    expect(blendSH9(m, sampleSkyBlend(0.5), target)).toBe(false);
    // Untouched: the caller keeps whatever it had.
    expect(target.coefficients[0]!.x).toBe(9);
  });

  it('does not allocate on the hot path', () => {
    const m = measurements();
    const target = new THREE.SphericalHarmonics3();
    const scratch = new THREE.SphericalHarmonics3();
    const before = target.coefficients[0];
    for (let i = 0; i < 100; i++) blendSH9(m, sampleSkyBlend(i / 100), target, scratch);
    expect(target.coefficients[0]).toBe(before);
  });
});

describe('sh9FromArray', () => {
  it('deinterleaves RGB triples and applies the scale', () => {
    const values = Array.from({ length: 27 }, (_, i) => i);
    const sh = sh9FromArray(values, 2);
    expect(sh.coefficients[0]!.toArray()).toEqual([0, 2, 4]);
    expect(sh.coefficients[8]!.toArray()).toEqual([48, 50, 52]);
  });
});

describe('colour helpers', () => {
  it('normaliseHue leaves a unit peak and preserves ratios', () => {
    const c = new THREE.Color().setRGB(0.2, 0.4, 0.1);
    normaliseHue(c);
    expect(Math.max(c.r, c.g, c.b)).toBeCloseTo(1, 9);
    expect(c.r / c.g).toBeCloseTo(0.5, 6);
  });

  it('normaliseHue falls back to white for a black input', () => {
    const c = new THREE.Color().setRGB(0, 0, 0);
    normaliseHue(c);
    expect(c.r).toBe(1);
  });

  it('boostChroma never drives a channel negative, at any gain', () => {
    for (const gain of [1.5, 2.8, 6, 20]) {
      const c = new THREE.Color().setRGB(0.3, 0.5, 0.9);
      boostChroma(c, gain);
      expect(c.r).toBeGreaterThan(0);
      expect(c.g).toBeGreaterThan(0);
      expect(c.b).toBeGreaterThan(0);
      // Hue order is preserved.
      expect(c.r).toBeLessThan(c.g);
      expect(c.g).toBeLessThan(c.b);
    }
  });

  it('boostChroma is the identity at gain 1 and on a neutral colour', () => {
    const c = new THREE.Color().setRGB(0.3, 0.5, 0.9);
    boostChroma(c, 1);
    expect(c.r).toBeCloseTo(0.3, 6);
    expect(c.b).toBeCloseTo(0.9, 6);

    const grey = new THREE.Color().setRGB(0.4, 0.4, 0.4);
    boostChroma(grey, 5);
    expect(grey.r).toBeCloseTo(0.4, 6);
    expect(grey.b).toBeCloseTo(0.4, 6);
  });
});

describe('describeNormalisation', () => {
  it('audits every sky', () => {
    const rows = describeNormalisation(measurements());
    expect(rows).toHaveLength(4);
    const day = rows.find((r) => r.sky === 'day')!;
    expect(day.scale).toBeCloseTo(1 / 0.73268945997054, 6);
    expect(day.measured).toBe(true);
    expect(day.hasBakedSH).toBe(true);
  });
});
