/**
 * MATH HELPERS — DOMAIN EDGES
 *
 * Everything here is a guard against a helper quietly returning a plausible
 * wrong number. The bit tricks coerce through `ToInt32`/`ToUint32`, which
 * truncates fractions and wraps past 2^31, so a texture dimension derived from
 * a device pixel ratio or a byte budget above 2 GB comes back smaller than the
 * argument — or negative. Nothing throws; the atlas is just allocated too
 * small and the last row of faces samples outside its region.
 */

import { describe, it, expect } from 'vitest';
import {
  angleDelta,
  falloff,
  inverseLerp,
  isPowerOfTwo,
  nextPowerOfTwo,
  remapClamped,
  smoothstep,
  wrapAngle,
} from '../math';

describe('nextPowerOfTwo', () => {
  it('never returns a value below its argument', () => {
    for (const value of [1.5, 2.5, 1023.4, 2 ** 30 + 1, 2 ** 31, 2 ** 31 + 1, 3_000_000_000]) {
      const result = nextPowerOfTwo(value);
      expect(result).toBeGreaterThanOrEqual(value);
      expect(isPowerOfTwo(result)).toBe(true);
    }
  });

  it('rounds fractional inputs up', () => {
    expect(nextPowerOfTwo(1.5)).toBe(2);
    expect(nextPowerOfTwo(2.5)).toBe(4);
    expect(nextPowerOfTwo(1024 * 1.5)).toBe(2048);
  });

  it('stays positive above the 32-bit signed boundary', () => {
    expect(nextPowerOfTwo(2 ** 30 + 1)).toBe(2 ** 31);
    expect(nextPowerOfTwo(2 ** 31)).toBe(2 ** 31);
    expect(nextPowerOfTwo(2 ** 31 + 1)).toBe(2 ** 32);
    expect(nextPowerOfTwo(3_000_000_000)).toBe(2 ** 32);
  });

  it('is the identity on exact powers of two', () => {
    for (let exponent = 0; exponent <= 45; exponent++) {
      expect(nextPowerOfTwo(2 ** exponent)).toBe(2 ** exponent);
    }
  });

  it('agrees with the old bit trick everywhere the bit trick was correct', () => {
    for (let value = 2; value <= 1 << 20; value = value * 3 + 1) {
      expect(nextPowerOfTwo(value)).toBe(1 << (32 - Math.clz32(value - 1)));
    }
  });

  it('clamps degenerate inputs to 1', () => {
    expect(nextPowerOfTwo(1)).toBe(1);
    expect(nextPowerOfTwo(0)).toBe(1);
    expect(nextPowerOfTwo(-8)).toBe(1);
    expect(nextPowerOfTwo(NaN)).toBe(1);
    expect(nextPowerOfTwo(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('isPowerOfTwo', () => {
  it('rejects non-integers', () => {
    for (const value of [1.5, 4.5, 1024.7]) expect(isPowerOfTwo(value)).toBe(false);
  });

  it('rejects values that do not fit in 32 bits but look aligned there', () => {
    expect(isPowerOfTwo(4294967297)).toBe(false); // 2^32 + 1
    expect(isPowerOfTwo(2 ** 40 + 1)).toBe(false);
  });

  it('accepts exact powers of two on both sides of the 32-bit boundary', () => {
    for (const exponent of [0, 1, 10, 30, 31, 32, 40, 52]) {
      expect(isPowerOfTwo(2 ** exponent)).toBe(true);
    }
  });

  it('rejects zero, negatives and non-powers', () => {
    for (const value of [0, -4, -1, 3, 5, 1000]) expect(isPowerOfTwo(value)).toBe(false);
  });
});

describe('wrapAngle', () => {
  it('returns the documented half-open range [-PI, PI)', () => {
    expect(wrapAngle(Math.PI)).toBe(-Math.PI);
    expect(wrapAngle(-Math.PI)).toBe(-Math.PI);
    expect(angleDelta(0, Math.PI)).toBe(-Math.PI);

    for (const radians of [0, 1, -1, 7, -7, 100.25, -100.25, 1e6]) {
      const wrapped = wrapAngle(radians);
      expect(wrapped).toBeGreaterThanOrEqual(-Math.PI);
      expect(wrapped).toBeLessThan(Math.PI);
    }
  });

  it('is the shortest arc for ordinary deltas', () => {
    expect(angleDelta(0, 0.5)).toBeCloseTo(0.5, 12);
    expect(angleDelta(0.5, 0)).toBeCloseTo(-0.5, 12);
    expect(angleDelta(-3, 3)).toBeCloseTo(-2 * Math.PI + 6, 12);
  });
});

describe('falloff', () => {
  it('is 1 at the origin even when the radius is degenerate', () => {
    expect(falloff(0, 0)).toBe(1);
    expect(falloff(0, -1)).toBe(1);
    expect(falloff(0, 10)).toBe(1);
  });

  it('is a quadratic ease-out with finite support', () => {
    expect(falloff(5, 10)).toBeCloseTo(0.25, 12);
    expect(falloff(10, 10)).toBe(0);
    expect(falloff(11, 10)).toBe(0);
  });
});

describe('inverseLerp', () => {
  it('resolves a legitimately small range instead of pinning it to the low end', () => {
    // Fog density is quoted in 1/metres and lives around 1e-6.
    expect(inverseLerp(0, 1e-7, 5e-8)).toBeCloseTo(0.5, 6);
    expect(remapClamped(1e-7, 0, 2e-7, 0, 1)).toBeCloseTo(0.5, 6);
  });

  it('still guards a genuinely degenerate range at any scale', () => {
    expect(inverseLerp(5, 5, 10)).toBe(0);
    expect(inverseLerp(0, 0, 10)).toBe(0);
    expect(inverseLerp(1e9, 1e9, 5)).toBe(0);
  });

  it('is unchanged for the unit-scale ranges the codebase actually uses', () => {
    expect(inverseLerp(0, 1, 0.25)).toBe(0.25);
    expect(inverseLerp(0.62, 1.3, 0.96)).toBeCloseTo(0.5, 12);
    expect(smoothstep(0, 0.26, 0.13)).toBeCloseTo(0.5, 12);
    expect(smoothstep(-0.05, 0.15, 0.05)).toBeCloseTo(0.5, 12);
  });
});
