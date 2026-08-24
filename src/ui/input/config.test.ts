/**
 * TUNING RESOLUTION
 *
 * `resolveTuning` is the one place an override is allowed to reshape the input
 * layer's constants, so it is also the one place that can stop a nonsensical
 * value reaching the maths. Two divisions downstream are guarded only by an
 * epsilon — `radialDeflection`'s `(full - dead)` and `LookSmoother`'s
 * `lookFullRateDegPerSec` — which turns a bad knob into a control that looks
 * plausible and is not: a stick with no analogue band, a camera pinned at full
 * rate. Both are reachable from the shipped `window.__INPUT__.setConfig`.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_INPUT_TUNING, resolveTuning } from './config';

describe('resolveTuning', () => {
  it('returns the shared defaults untouched when there is no patch', () => {
    expect(resolveTuning()).toBe(DEFAULT_INPUT_TUNING);
  });

  it('passes a valid override straight through', () => {
    expect(resolveTuning({ stickDeadZonePx: 20 })).toMatchObject({ stickDeadZonePx: 20 });
  });

  it('keeps stickRadius and stickFullDeflectionPx in sync, from either name', () => {
    expect(resolveTuning({ stickRadius: 240 })).toMatchObject({
      stickRadius: 240,
      stickFullDeflectionPx: 240,
    });
    expect(resolveTuning({ stickFullDeflectionPx: 90 })).toMatchObject({
      stickRadius: 90,
      stickFullDeflectionPx: 90,
    });
  });

  it('repairs a dead zone that swallows the whole stick', () => {
    const tuning = resolveTuning({ stickDeadZonePx: 200 });
    expect(tuning.stickDeadZonePx).toBeLessThan(tuning.stickFullDeflectionPx);
  });

  it('repairs a NaN dead zone back to the default ratio', () => {
    expect(resolveTuning({ stickDeadZonePx: Number.NaN }).stickDeadZonePx).toBe(12);
  });

  it('repairs the dead zone AFTER the stickRadius mirror, not before', () => {
    // A 10px stick is smaller than the default dead zone, so the repair has to
    // run on the mirrored value or it leaves an inverted pair behind.
    const tuning = resolveTuning({ stickRadius: 10 });
    expect(tuning.stickFullDeflectionPx).toBe(10);
    expect(tuning.stickDeadZonePx).toBeLessThan(10);
    expect(tuning.stickDeadZonePx).toBeGreaterThan(0);
  });

  it('refuses a look rate of zero, which would pin the camera at full speed', () => {
    expect(resolveTuning({ lookFullRateDegPerSec: 0 }).lookFullRateDegPerSec).toBe(220);
    expect(resolveTuning({ lookFullRateDegPerSec: -1 }).lookFullRateDegPerSec).toBe(220);
    expect(resolveTuning({ lookFullRateDegPerSec: Number.NaN }).lookFullRateDegPerSec).toBe(220);
  });

  it('merges a patch over a live base rather than over the defaults', () => {
    const base = resolveTuning({ stickDeadZonePx: 20 });
    const next = resolveTuning({ lookSensitivity: 2 }, base);
    expect(next.stickDeadZonePx).toBe(20);
    expect(next.lookSensitivity).toBe(2);
  });

  /* ------------------------------------------------------------------------ */
  /* The number the whole control divides by                                  */
  /* ------------------------------------------------------------------------ */

  it('repairs stickFullDeflectionPx, which this block used to skip entirely', () => {
    // It guarded the base radius, the fixed inset, the capture radius, both
    // zone fractions and the idle opacity — and not the one number the stick
    // maths is a function of. `NaN` gave a permanently dead stick (every
    // magnitude 0, forever); `0` and any negative gave magnitude 1.000 from
    // the first pixel of travel, which is a character that can only sprint.
    for (const bad of [Number.NaN, 0, -50, Number.POSITIVE_INFINITY]) {
      const tuning = resolveTuning({ stickFullDeflectionPx: bad });
      expect(tuning.stickFullDeflectionPx, String(bad)).toBe(92);
      // ...and the two names for that one distance do not part company.
      expect(tuning.stickRadius, String(bad)).toBe(92);
    }
    expect(resolveTuning({ stickRadius: Number.NaN }).stickFullDeflectionPx).toBe(92);
    expect(resolveTuning({ stickRadius: Number.NaN }).stickRadius).toBe(92);
  });

  it('never launders a non-finite deflection into the dead zone', () => {
    // The repair below it multiplied the bad value by the default ratio and
    // wrote the result into a SECOND field, in the commit family whose whole
    // subject was "stop the clamp family laundering NaN into the simulation".
    // Ordering the deflection repair first is what makes that unreachable.
    for (const bad of [Number.NaN, 0, -50]) {
      const tuning = resolveTuning({ stickFullDeflectionPx: bad });
      expect(Number.isFinite(tuning.stickDeadZonePx), String(bad)).toBe(true);
      expect(tuning.stickDeadZonePx, String(bad)).toBeGreaterThanOrEqual(0);
      expect(tuning.stickDeadZonePx, String(bad)).toBeLessThan(tuning.stickFullDeflectionPx);
    }
  });

  it('refuses a NEGATIVE dead zone, which is a stick that drifts at rest', () => {
    expect(resolveTuning({ stickDeadZonePx: -8 }).stickDeadZonePx).toBe(12);
    // Zero stays a legitimate setting: no insurance, no premium.
    expect(resolveTuning({ stickDeadZonePx: 0 }).stickDeadZonePx).toBe(0);
  });

  /* ------------------------------------------------------------------------ */
  /* tap-without-drag                                                         */
  /* ------------------------------------------------------------------------ */

  it('holds the capture radius at or below the dead zone', () => {
    // Capture snaps the origin onto the anchor, so whatever distance the thumb
    // landed from the anchor becomes deflection WITH NO DRAG AT ALL. Bounded
    // by the dead zone that deflection is always zero. Unbounded it shipped at
    // 122px against a 92px full deflection, and a finger that never moved
    // commanded 0.800 on the ring's edge and 1.000 beyond it.
    expect(resolveTuning({ stickCaptureRadiusPx: 122 }).stickCaptureRadiusPx).toBe(12);
    expect(resolveTuning({ stickCaptureRadiusPx: 6 }).stickCaptureRadiusPx).toBe(6);
    // Clamped against the REPAIRED dead zone, not the one in the patch.
    expect(
      resolveTuning({ stickCaptureRadiusPx: 200, stickDeadZonePx: 500 }).stickCaptureRadiusPx
    ).toBe(12);
    expect(
      resolveTuning({ stickCaptureRadiusPx: 40, stickDeadZonePx: 60 }).stickCaptureRadiusPx
    ).toBe(40);
  });

  it('SHIPS a tuning that survives its own repair block unchanged', () => {
    // The defaults never pass through `resolveTuning`, so every invariant this
    // function enforces is one the frozen literal is only assumed to satisfy.
    // It did not: `stickCaptureRadiusPx: 122` broke the bound above, and no
    // test could see it because no test resolved the defaults. This one does.
    expect(resolveTuning({})).toEqual(DEFAULT_INPUT_TUNING);
  });
});
