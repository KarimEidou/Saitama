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
    expect(resolveTuning({ stickDeadZonePx: Number.NaN }).stickDeadZonePx).toBe(56);
  });

  it('repairs the dead zone AFTER the stickRadius mirror, not before', () => {
    // A 40px stick is smaller than the default 56px dead zone, so the repair
    // has to run on the mirrored value or it leaves an inverted pair behind.
    const tuning = resolveTuning({ stickRadius: 40 });
    expect(tuning.stickFullDeflectionPx).toBe(40);
    expect(tuning.stickDeadZonePx).toBeLessThan(40);
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
});
