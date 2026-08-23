/**
 * REVERB — the pure maths and the preset table.
 *
 * The FDN itself is judged by ear and by the offline probes; what this file
 * pins is the part of `reverb.ts` that is arithmetic and data:
 *
 *  • `feedbackForRt60` is the single SAFETY property of the whole file —
 *    "clamped below 1 so the network can never self-oscillate, whatever a
 *    caller asks for". The probe once caught an "alley" whose tail decayed to
 *    -53 dB and then climbed back to +22 dB. It is a three-line pure function,
 *    so it can be swept exhaustively here in a millisecond instead.
 *  • `apply()` silently re-clamps the table (`damping` into [200, 18000],
 *    `preDelay` into [0, 0.45], each scaled delay into [0.001, 0.95]). A
 *    preset authored outside those bounds produces a room that does not match
 *    its own declared numbers — and the audition harness then reports the
 *    DECLARED ones. `registry.test.ts` does this job for the sound registry;
 *    this is the reverb's equivalent.
 *  • `setPreset` resolves a caller-supplied string against an object literal,
 *    which inherits truthy junk from `Object.prototype`.
 */

import { describe, expect, it } from 'vitest';
import {
  feedbackForRt60,
  isReverbPreset,
  REVERB_PRESETS,
  REVERB_PRESET_NAMES,
  type IReverbSettings,
} from '../reverb';

describe('feedbackForRt60', () => {
  it('produces no feedback at all for a zero or negative decay time', () => {
    expect(feedbackForRt60(0.03, 0)).toBe(0);
    expect(feedbackForRt60(0.03, -1)).toBe(0);
  });

  it('STABILITY SWEEP: never leaves [0, 0.93] for any delay/decay pair', () => {
    // A feedback gain >= 1 is an oscillator, not a room: the loop adds energy
    // every pass and the tail grows without bound. 0.93 is the ceiling the
    // function is documented to hold whatever a caller asks for.
    const delays = [0.001, 0.005, 0.01, 0.03, 0.05, 0.1, 0.5, 0.95];
    const decays = [0.01, 0.1, 0.45, 1.5, 5, 20, 100];
    for (const meanDelay of delays) {
      for (const rt60 of decays) {
        const g = feedbackForRt60(meanDelay, rt60);
        expect(Number.isFinite(g)).toBe(true);
        expect(g).toBeGreaterThanOrEqual(0);
        expect(g).toBeLessThanOrEqual(0.93);
      }
    }
  });

  it('rises with rt60 while unclamped, then sits on the ceiling', () => {
    expect(feedbackForRt60(0.03, 0.5)).toBeLessThan(feedbackForRt60(0.03, 1.5));
    expect(feedbackForRt60(0.03, 0.5)).toBeCloseTo(0.6607, 4);
    expect(feedbackForRt60(0.03, 1.5)).toBeCloseTo(0.871, 4);
    expect(feedbackForRt60(0.03, 5)).toBe(0.93);
  });

  it('falls as the loop gets longer: more delay needs less gain', () => {
    expect(feedbackForRt60(0.1, 1)).toBeLessThan(feedbackForRt60(0.05, 1));
    expect(feedbackForRt60(0.05, 1)).toBeLessThan(feedbackForRt60(0.01, 1));
    expect(feedbackForRt60(0.1, 1)).toBeCloseTo(0.5012, 4);
    expect(feedbackForRt60(0.05, 1)).toBeCloseTo(0.7079, 4);
    expect(feedbackForRt60(0.01, 1)).toBe(0.93);
  });
});

describe('preset table', () => {
  it('lists every key exactly once', () => {
    expect(REVERB_PRESET_NAMES).toEqual(Object.keys(REVERB_PRESETS));
    expect(new Set(REVERB_PRESET_NAMES).size).toBe(REVERB_PRESET_NAMES.length);
  });

  it('stays inside the ranges apply() will honour', () => {
    for (const name of REVERB_PRESET_NAMES) {
      const s = REVERB_PRESETS[name];
      expect(s.wet).toBeGreaterThanOrEqual(0);
      expect(s.wet).toBeLessThanOrEqual(1);
      expect(s.rt60).toBeGreaterThan(0);
      expect(s.size).toBeGreaterThan(0);
      // The exact clamps in `apply()`: a preset outside them would be silently
      // re-tuned while the harness still reported the declared figure.
      expect(s.damping).toBeGreaterThanOrEqual(200);
      expect(s.damping).toBeLessThanOrEqual(18000);
      expect(s.preDelay).toBeGreaterThanOrEqual(0);
      expect(s.preDelay).toBeLessThanOrEqual(0.45);
      expect(s.description.length).toBeGreaterThan(15);
    }
  });

  it('keeps `none` genuinely anechoic', () => {
    // "No send reaches the master" — the render suite expects a tail RMS of
    // exactly 0 here, and every dry per-voice probe relies on it.
    expect(REVERB_PRESETS.none.wet).toBe(0);
  });

  it('encodes the size ordering the environments are designed around', () => {
    expect(REVERB_PRESETS.crater.rt60).toBeGreaterThan(REVERB_PRESETS.openStreet.rt60);
    expect(REVERB_PRESETS.openStreet.rt60).toBeGreaterThan(REVERB_PRESETS.alley.rt60);
    expect(REVERB_PRESETS.crater.size).toBeGreaterThan(REVERB_PRESETS.alley.size);
  });
});

describe('preset resolution', () => {
  it('accepts every declared name', () => {
    for (const name of REVERB_PRESET_NAMES) expect(isReverbPreset(name)).toBe(true);
  });

  it('rejects inherited Object.prototype members', () => {
    // `REVERB_PRESETS['toString']` is truthy, so a truthiness guard let it
    // through: `currentPreset` became 'toString', every `settings.*` read came
    // back undefined, and the whole delay network was written with NaN.
    expect(isReverbPreset('toString')).toBe(false);
    expect(isReverbPreset('constructor')).toBe(false);
    expect(isReverbPreset('valueOf')).toBe(false);
    expect(isReverbPreset('hasOwnProperty')).toBe(false);
    expect(isReverbPreset('__proto__')).toBe(false);
  });

  it('rejects an empty or misspelt name, case-sensitively', () => {
    expect(isReverbPreset('')).toBe(false);
    expect(isReverbPreset('openstreet')).toBe(false);
    expect(isReverbPreset('Crater')).toBe(false);
  });

  it('narrows a plain string to a usable key', () => {
    const p: string = 'crater';
    expect(isReverbPreset(p)).toBe(true);
    if (isReverbPreset(p)) {
      const s: IReverbSettings = REVERB_PRESETS[p];
      expect(s.rt60).toBe(5);
    }
  });
});
