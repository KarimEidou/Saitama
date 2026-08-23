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
  DEG2RAD,
  EPSILON,
  RAD2DEG,
  TAU,
  angleDelta,
  applyDeadZone,
  approximately,
  clamp,
  clamp01,
  damp,
  dampAngle,
  distanceSq2,
  distanceSq3,
  falloff,
  inverseLerp,
  isPowerOfTwo,
  lerp,
  lerpAngle,
  mod,
  moveTowards,
  nextPowerOfTwo,
  remap,
  remapClamped,
  saturate,
  smootherstep,
  smoothstep,
  snap,
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

/**
 * The suites below cover the rest of `math.ts` — the helpers 60, 26 and 25
 * modules import and nothing pinned. `damp` carries a PROPERTY rather than a
 * value: it promises frame-rate independence, which survives a refactor
 * visually and then breaks on a device with a different frame budget.
 *
 * DELIBERATE GAPS, so nobody "helpfully" fills them while those rewrites are in
 * flight: `wrapAngle`, `nextPowerOfTwo`, `isPowerOfTwo`, `inverseLerp`'s
 * degenerate-range guard and `falloff` are each owned by the suites above.
 * Nothing below touches a degenerate range, an exact antipode, a non-integer
 * power-of-two argument, or `falloff`.
 */

describe('constants', () => {
  it('are internally consistent', () => {
    expect(TAU).toBe(Math.PI * 2);
    expect(EPSILON).toBe(1e-6);
    expect(DEG2RAD * RAD2DEG).toBeCloseTo(1, 15);
    expect(180 * DEG2RAD).toBeCloseTo(Math.PI, 15);
  });
});

describe('clamp / clamp01 / lerp', () => {
  it('clamps inclusively at both bounds', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });

  it('clamps to the unit range', () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(0.25)).toBe(0.25);
    expect(clamp01(0)).toBe(0);
    expect(clamp01(1)).toBe(1);
  });

  it('interpolates without clamping `t`', () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(10, 0, 0.25)).toBe(7.5);
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
    // Documented: `t` is NOT clamped. Callers relying on extrapolation exist.
    expect(lerp(0, 10, 2)).toBe(20);
    expect(lerp(0, 10, -1)).toBe(-10);
  });
});

/**
 * NaN MUST NOT SURVIVE A CLAMP
 *
 * EVERY comparison against NaN is false, so the two obvious implementations of
 * a clamp — `Math.min(1, Math.max(0, x))` and `x < 0 ? 0 : x > 1 ? 1 : x` —
 * both return NaN for NaN. A function whose entire job is "give me a number in
 * this range" then returns something that is not a number, and 230-odd call
 * sites assume it cannot.
 *
 * The consequences are not local, which is what makes this worth a test file's
 * worth of noise. `clamp01(boredom)` feeds `setLocomotion`'s `slouch`, which
 * reaches every `poseArm`/`poseSpine`/`poseLeg` angle and then `applyPose` — a
 * NaN quaternion has no orientation, the bounding sphere goes NaN, the frustum
 * test rejects it, and the character does not degrade, he VANISHES. In
 * progression the same NaN reaches `publishRank`, whose "did anything change?"
 * early-out is `next.rank === previous.rank`: `NaN === NaN` is false, so a NaN
 * standing always looks like a change and always publishes.
 *
 * IF YOU ARE HERE BECAUSE THESE TESTS FAIL AFTER YOU SIMPLIFIED `math.ts`:
 * that is what they are for. Put the comparison-first form back.
 */
describe('the clamp family floors NaN instead of passing it through', () => {
  // The two rewrites this suite exists to prevent, kept executable so the
  // claim is demonstrated rather than asserted in a comment. Taking `x` as a
  // parameter is not incidental: an inline `NaN < 0` trips eslint's `use-isnan`
  // — the linter knows the comparison is meaningless, which is precisely the
  // property that makes it a silent hole once the NaN arrives at runtime.
  const naiveMinMax = (x: number): number => Math.min(1, Math.max(0, x));
  const naiveTernary = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

  it('clamp01(NaN) is 0, not NaN', () => {
    expect(clamp01(Number.NaN)).toBe(0);
    expect(naiveMinMax(Number.NaN)).toBeNaN();
    expect(naiveTernary(Number.NaN)).toBeNaN();
    // ...and both agree with the real thing everywhere else, which is why the
    // bug survived: nothing but NaN distinguishes them.
    for (const value of [-5, -0.5, 0, 0.25, 1, 1.5, 5]) {
      expect(naiveMinMax(value)).toBe(clamp01(value));
      expect(naiveTernary(value)).toBe(clamp01(value));
    }
  });

  it('clamp01 pins both infinities to the end of the range they came from', () => {
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clamp01(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('clamp01 returns the canonical +0, never -0', () => {
    // `toBe` is `Object.is`, so this really does distinguish the two zeroes.
    // A -0 leaking out flips the sign of `1 / t` and `Math.atan2(t, -1)` for
    // reasons the caller cannot see from its own arguments.
    expect(Object.is(clamp01(-0), 0)).toBe(true);
    expect(Object.is(clamp01(0), 0)).toBe(true);
    expect(Object.is(clamp01(Number.NaN), 0)).toBe(true);
    expect(Object.is(clamp01(-1), 0)).toBe(true);
  });

  it('clamp01 is unchanged for every finite input', () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(0.25)).toBe(0.25);
    expect(clamp01(1)).toBe(1);
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(Number.MIN_VALUE)).toBe(Number.MIN_VALUE);
    expect(clamp01(1 - Number.EPSILON)).toBe(1 - Number.EPSILON);
  });

  it('clamp(NaN, min, max) is `min` — a survivable frame, not a poisoned one', () => {
    // `min` rather than NaN because a wrong number is recoverable and a NaN is
    // not: the next frame overwrites a pinned camera pitch, but nothing
    // overwrites a NaN that has already been folded into an accumulator.
    expect(clamp(Number.NaN, 0, 10)).toBe(0);
    expect(clamp(Number.NaN, -1, 1)).toBe(-1);
    expect(clamp(Number.NaN, 5, 5)).toBe(5);
  });

  it('clamp handles both infinities and an inverted range as before', () => {
    expect(clamp(Number.POSITIVE_INFINITY, 0, 10)).toBe(10);
    expect(clamp(Number.NEGATIVE_INFINITY, 0, 10)).toBe(0);
    expect(clamp(5, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY)).toBe(5);
    // An inverted range is nonsense, but it must stay the SAME nonsense the
    // `<`/`>` form produced, since callers derive bounds from live state.
    expect(clamp(5, 10, 0)).toBe(10);
    expect(clamp(15, 10, 0)).toBe(0);
    expect(clamp(-5, 10, 0)).toBe(10);
  });

  it('clamp does NOT launder a non-finite bound', () => {
    // Deliberate: with a broken range there is no in-range answer to return,
    // and inventing one hides the caller's bug. A NaN VALUE is the case this
    // family exists to absorb; a NaN BOUND is a different bug entirely.
    expect(clamp(5, Number.NaN, 10)).toBeNaN();
  });

  it('saturate(NaN) is 0 and saturate(Infinity) is 1 — never NaN', () => {
    // `value <= 0` is false for NaN, so the old guard fell through to
    // `NaN / NaN`; and `Infinity / Infinity` is NaN too, so the curve's own
    // limit has to be stated rather than computed.
    expect(saturate(Number.NaN, 100)).toBe(0);
    expect(saturate(Number.NEGATIVE_INFINITY, 100)).toBe(0);
    expect(saturate(Number.POSITIVE_INFINITY, 100)).toBe(1);
    expect(Object.is(saturate(-0, 100), 0)).toBe(true);
  });

  it('falloff is 0 for a non-finite distance OR radius', () => {
    // Out of range is the safe end: an effect that did not happen, rather than
    // one applied at unknown strength to every rigid body in the scene.
    expect(falloff(Number.NaN, 10)).toBe(0);
    expect(falloff(10, Number.NaN)).toBe(0);
    expect(falloff(Number.NaN, Number.NaN)).toBe(0);
    expect(falloff(Number.POSITIVE_INFINITY, 10)).toBe(0);
    // ...and the documented origin/degenerate-radius cases are untouched.
    expect(falloff(0, 0)).toBe(1);
    expect(falloff(0, -1)).toBe(1);
    expect(falloff(5, 10)).toBeCloseTo(0.25, 12);
    expect(falloff(10, 10)).toBe(0);
  });

  it('carries the fix into everything built on clamp01', () => {
    // These need no guard of their own, and must not grow one: the clamp is
    // the choke point, and this test is what says so.
    expect(smoothstep(0, 1, Number.NaN)).toBe(0);
    expect(smoothstep(Number.NaN, 1, 0.5)).toBe(0);
    expect(smootherstep(0, 1, Number.NaN)).toBe(0);
    expect(remapClamped(Number.NaN, 0, 1, 10, 20)).toBe(10);
    expect(applyDeadZone(Number.NaN, 0.1)).toBe(0);
    expect(applyDeadZone(0.5, Number.NaN)).toBe(0);
    // `smoothing` is the clamped argument; a NaN one degrades to "no
    // smoothing at all" (snap to target) rather than to a NaN camera.
    expect(damp(1, 2, Number.NaN, 0.016)).toBe(2);
    expect(dampAngle(1, 2, Number.NaN, 0.016)).toBe(2);
  });

  it('leaves `lerp` propagating, on purpose', () => {
    // `lerp` promises no output range — extrapolation past both ends is a
    // documented feature — so there is no bound to fall back to and nothing to
    // guard. If this ever starts returning a number, someone has given the
    // hottest call in the file a branch it does not need.
    expect(lerp(0, 10, Number.NaN)).toBeNaN();
  });
});

describe('damp', () => {
  it('is frame-rate independent: one step of dt equals two of dt/2', () => {
    // The property the function exists for. A raw `lerp(current, target, 0.1)`
    // fails this, and the camera then behaves differently at 30fps and 60fps.
    const once = damp(0, 10, 0.01, 1);
    const twice = damp(damp(0, 10, 0.01, 0.5), 10, 0.01, 0.5);
    expect(twice).toBeCloseTo(once, 12);
  });

  it('treats `smoothing` as the fraction remaining after one second', () => {
    expect(damp(0, 10, 0.01, 1)).toBeCloseTo(9.9, 12);
  });

  it('is a no-op for dt 0', () => {
    expect(damp(3, 10, 0.01, 0)).toBe(3);
  });

  it('converges monotonically and never overshoots', () => {
    let value = 0;
    for (let i = 0; i < 100; i++) {
      const next = damp(value, 10, 0.5, 1 / 60);
      expect(next).toBeGreaterThanOrEqual(value);
      expect(next).toBeLessThanOrEqual(10);
      value = next;
    }
  });
});

describe('moveTowards', () => {
  it('steps by at most maxDelta and never overshoots', () => {
    expect(moveTowards(0, 10, 3)).toBe(3);
    expect(moveTowards(0, 10, 20)).toBe(10);
    expect(moveTowards(10, 0, 3)).toBe(7);
    expect(moveTowards(5, 5, 1)).toBe(5);
    expect(moveTowards(0, 10, 0)).toBe(0);
  });
});

describe('mod', () => {
  it('takes the sign of the divisor', () => {
    expect(mod(5, 4)).toBe(1);
    expect(mod(-1, 4)).toBe(3);
    expect(mod(-0.5, 1)).toBe(0.5);
    expect(mod(4, 4)).toBe(0);
  });
});

describe('approximately', () => {
  it('compares within the default and an explicit tolerance', () => {
    expect(approximately(1, 1 + 1e-9)).toBe(true);
    expect(approximately(1, 1.001)).toBe(false);
    expect(approximately(1, 1.001, 0.01)).toBe(true);
  });
});

describe('distanceSq2 / distanceSq3', () => {
  it('are symmetric and zero for identical points', () => {
    expect(distanceSq2(0, 0, 3, 4)).toBe(25);
    expect(distanceSq2(3, 4, 0, 0)).toBe(25);
    expect(distanceSq2(2, 2, 2, 2)).toBe(0);

    expect(distanceSq3(0, 0, 0, 1, 2, 2)).toBe(9);
    expect(distanceSq3(1, 2, 2, 0, 0, 0)).toBe(9);
    expect(distanceSq3(1, 2, 3, 1, 2, 3)).toBe(0);
  });
});

describe('snap', () => {
  it('rounds to the nearest multiple, and passes a zero step through', () => {
    expect(snap(7.3, 0.5)).toBe(7.5);
    expect(snap(7.2, 0.5)).toBe(7);
    expect(snap(-7.3, 0.5)).toBe(-7.5);
    expect(snap(5, 0)).toBe(5);
    expect(snap(12, 4)).toBe(12);
  });
});

describe('applyDeadZone', () => {
  it('treats the boundary as inside the zone and rescales the remainder', () => {
    expect(applyDeadZone(0.2, 0.25)).toBe(0);
    expect(applyDeadZone(0.25, 0.25)).toBe(0);
    expect(applyDeadZone(1, 0.25)).toBe(1);
    expect(applyDeadZone(0.5, 0.25)).toBeCloseTo(1 / 3, 12);
    expect(applyDeadZone(0, 0)).toBe(0);
  });

  it('stays inside [0, 1] across a full sweep', () => {
    for (let i = 0; i <= 100; i++) {
      const result = applyDeadZone(i / 100, 0.25);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(1);
    }
  });
});

describe('saturate', () => {
  it('maps `half` to 0.5 and approaches but never reaches 1', () => {
    expect(saturate(0, 100)).toBe(0);
    expect(saturate(-5, 100)).toBe(0);
    expect(saturate(100, 100)).toBe(0.5);
    expect(saturate(1e6, 100)).toBeGreaterThan(0.999);
    expect(saturate(1e6, 100)).toBeLessThan(1);
  });

  it('is strictly increasing', () => {
    const values = [1, 10, 100, 1e3, 1e6].map((value) => saturate(value, 100));
    for (let i = 1; i < values.length; i++) expect(values[i]!).toBeGreaterThan(values[i - 1]!);
  });
});

describe('smoothstep / smootherstep', () => {
  it('hit the edges exactly and clamp outside them', () => {
    for (const fn of [smoothstep, smootherstep]) {
      expect(fn(0, 1, 0)).toBe(0);
      expect(fn(0, 1, 1)).toBe(1);
      expect(fn(0, 1, 0.5)).toBe(0.5);
      expect(fn(0, 1, -1)).toBe(0);
      expect(fn(0, 1, 2)).toBe(1);
    }
  });

  it('are monotonic across the range', () => {
    for (const fn of [smoothstep, smootherstep]) {
      let previous = -1;
      for (let i = 0; i <= 100; i++) {
        const value = fn(0, 1, i / 100);
        expect(value).toBeGreaterThanOrEqual(previous);
        previous = value;
      }
    }
  });

  it('smootherstep is flatter than smoothstep near the ends', () => {
    expect(smootherstep(0, 1, 0.1)).toBeLessThan(smoothstep(0, 1, 0.1));
  });
});

describe('remap / remapClamped', () => {
  it('remaps without clamping, and clamps only in the clamped form', () => {
    expect(remap(5, 0, 10, 0, 100)).toBe(50);
    expect(remap(15, 0, 10, 0, 100)).toBe(150);
    expect(remapClamped(15, 0, 10, 0, 100)).toBe(100);
    expect(remapClamped(-5, 0, 10, 0, 100)).toBe(0);
  });

  it('handles an inverted output range', () => {
    expect(remap(5, 0, 10, 100, 0)).toBe(50);
  });
});

describe('lerpAngle / dampAngle', () => {
  it('interpolate ordinary angles', () => {
    expect(lerpAngle(0, 1, 0.5)).toBe(0.5);
    expect(lerpAngle(0, 1, 0)).toBe(0);
    expect(dampAngle(0, 1, 0.01, 1)).toBeCloseTo(0.99, 12);
  });

  it('take the short arc across the wrap', () => {
    // 3 -> -3 is 0.28rad the short way, not 6rad the long way, so the midpoint
    // lands near +/-PI rather than near 0.
    expect(Math.cos(lerpAngle(3, -3, 0.5))).toBeLessThan(-0.9);
  });
});
