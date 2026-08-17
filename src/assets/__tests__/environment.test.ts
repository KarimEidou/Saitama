/**
 * ENVIRONMENT MEASUREMENTS
 *
 * The four HDRIs are NOT exposure-matched. Their peaks span five orders of
 * magnitude (4.04 at dusk to 136 998 at noon) while their means are all within
 * 1.5x of each other, so anything that compares or cross-fades them must
 * divide by `meanLuminance` first. These are the real measured numbers from
 * `assets.runtime.json`.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { normalisationScale, sphericalHarmonicsFromArray } from '../environment';

const MEASURED = {
  dawn: { meanLuminance: 1.0980531162976837, maxLuminance: 8.44295 },
  day: { meanLuminance: 0.73268945997054, maxLuminance: 136998.2976 },
  dusk: { meanLuminance: 0.9044060619958861, maxLuminance: 4.0358875 },
  night: { meanLuminance: 0.712214196645703, maxLuminance: 554.8064 },
};

describe('normalisationScale', () => {
  it('puts every sky on a unit mean', () => {
    for (const measurement of Object.values(MEASURED)) {
      const normalised = measurement.meanLuminance * normalisationScale(measurement);
      expect(normalised).toBeCloseTo(1, 12);
    }
  });

  it('closes a peak spread of five orders of magnitude', () => {
    const peaks = Object.values(MEASURED).map((entry) => entry.maxLuminance);
    expect(Math.max(...peaks) / Math.min(...peaks)).toBeGreaterThan(30_000);

    const means = Object.values(MEASURED).map((entry) => entry.meanLuminance);
    expect(Math.max(...means) / Math.min(...means)).toBeLessThan(1.6);
  });

  it('degrades to a no-op rather than dividing the world by zero', () => {
    expect(normalisationScale({ meanLuminance: 0 })).toBe(1e6);
    expect(Number.isFinite(normalisationScale({ meanLuminance: 0 }))).toBe(true);
    expect(normalisationScale({ meanLuminance: 1 })).toBe(1);
  });
});

describe('sphericalHarmonicsFromArray', () => {
  const coefficients = Array.from({ length: 27 }, (_unused, index) => index + 1);

  it('reads 27 interleaved floats in THREE.SphericalHarmonics3 order', () => {
    const sh = sphericalHarmonicsFromArray(coefficients);
    expect(sh).toBeInstanceOf(THREE.SphericalHarmonics3);
    expect(sh!.coefficients[0]!.toArray()).toEqual([1, 2, 3]);
    expect(sh!.coefficients[8]!.toArray()).toEqual([25, 26, 27]);
  });

  it('matches three own fromArray, so a LightProbe built either way agrees', () => {
    const mine = sphericalHarmonicsFromArray(coefficients)!;
    const theirs = new THREE.SphericalHarmonics3().fromArray(coefficients);
    for (let i = 0; i < 9; i++) {
      expect(mine.coefficients[i]!.toArray()).toEqual(theirs.coefficients[i]!.toArray());
    }
  });

  it('scales in place, which is how the sky normalises before blending', () => {
    const sh = sphericalHarmonicsFromArray(coefficients, 0.5)!;
    expect(sh.coefficients[0]!.toArray()).toEqual([0.5, 1, 1.5]);
  });

  it('refuses a coefficient set of the wrong length', () => {
    expect(sphericalHarmonicsFromArray([1, 2, 3])).toBeUndefined();
    expect(sphericalHarmonicsFromArray([])).toBeUndefined();
  });

  it('produces a probe with non-zero irradiance from real coefficients', () => {
    // The day sky's real SH set, first band dominant and positive.
    const day = [
      2.516466218293156, 2.6010236083058973, 2.79869285602809, 2.914533853697665,
      2.87239040365585, 2.868046020480648, 1.4999091825837874, 1.489417501373016,
      1.4892487674204422, 2.0666213279725754, 2.049442587129088, 2.045878366054197,
      3.341926940010107, 3.2540479417040284, 3.1676450322334038, 2.4192515384828766,
      2.3566582428570055, 2.2955697524109815, -1.3143876723442784, -1.258412551338918,
      -1.201337248033019, 1.704132224119622, 1.6749886671308876, 1.6519182520425093,
      -1.1464247572468864, -1.0709741643518604, -0.9905193045923496,
    ];
    const sh = sphericalHarmonicsFromArray(day)!;
    const irradiance = new THREE.Vector3();
    sh.getIrradianceAt(new THREE.Vector3(0, 1, 0), irradiance);
    expect(irradiance.x).toBeGreaterThan(0);
    expect(irradiance.y).toBeGreaterThan(0);
    expect(irradiance.z).toBeGreaterThan(0);
    expect(new THREE.LightProbe(sh).sh).toBe(sh);
  });
});
