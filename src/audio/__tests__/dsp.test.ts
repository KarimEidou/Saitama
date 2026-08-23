/**
 * DSP AUTOMATION CONTRACT — the SCHEDULE, not the sound.
 *
 * `render.test.ts` renders the real graph in headless Chromium and is the
 * authority on how anything SOUNDS. It is also tens of seconds per run, which
 * makes it the wrong place to pin the parts of `dsp.ts` that are not DSP at
 * all: the ORDER and TIMES of the events a helper writes onto an `AudioParam`,
 * the minimum-duration floors, the `SILENCE`-not-zero rule that keeps
 * `exponentialRampToValueAtTime` legal, and the durations `VoiceBank`
 * schedules its slot bookkeeping against.
 *
 * All of that is event bookkeeping, so a recording fake param tests the real
 * logic in milliseconds and in Node. Nothing here asserts a sample value; the
 * sample-level claims stay in `render.test.ts` where they belong.
 */

import { describe, expect, it } from 'vitest';
import {
  asr,
  centRatio,
  clampFreq,
  dbToGain,
  fadeOut,
  gainToDb,
  growlCurve,
  holdAt,
  midiToFreq,
  MIN_FREQ,
  percussive,
  resetParam,
  semitoneRatio,
  SILENCE,
  softClipCurve,
  sweep,
  sweep3,
} from '../dsp';

/* -------------------------------------------------------------------------- */
/* Recording fake param                                                       */
/* -------------------------------------------------------------------------- */

/** One automation write, in the order it was made. */
interface IParamEvent {
  readonly kind: 'set' | 'linear' | 'exponential' | 'cancel' | 'hold';
  readonly value: number;
  readonly time: number;
}

interface IFakeParam {
  value: number;
  readonly events: IParamEvent[];
}

/**
 * A param that records rather than renders.
 *
 * `withHold` exists because `holdAt` FEATURE-DETECTS `cancelAndHoldAtTime`,
 * and both branches must be covered: Chromium always has it, so the offline
 * probes can only ever exercise the first. The legacy branch is what runs on
 * the older WebViews this game ships to.
 */
function fakeParam(initial = 0, withHold = true): AudioParam & IFakeParam {
  const events: IParamEvent[] = [];
  const p: Record<string, unknown> = {
    value: initial,
    events,
    setValueAtTime(value: number, time: number) {
      events.push({ kind: 'set', value, time });
      p.value = value;
      return p;
    },
    linearRampToValueAtTime(value: number, time: number) {
      events.push({ kind: 'linear', value, time });
      return p;
    },
    exponentialRampToValueAtTime(value: number, time: number) {
      events.push({ kind: 'exponential', value, time });
      return p;
    },
    cancelScheduledValues(time: number) {
      events.push({ kind: 'cancel', value: 0, time });
      return p;
    },
  };
  if (withHold) {
    p.cancelAndHoldAtTime = (time: number) => {
      events.push({ kind: 'hold', value: 0, time });
      return p;
    };
  }
  return p as unknown as AudioParam & IFakeParam;
}

const kinds = (p: IFakeParam): string[] => p.events.map((e) => e.kind);
const last = (p: IFakeParam): IParamEvent => p.events[p.events.length - 1]!;

/* -------------------------------------------------------------------------- */

describe('holdAt', () => {
  it('holds then anchors when cancelAndHoldAtTime exists', () => {
    const p = fakeParam(0.3, true);
    holdAt(p, 2);
    expect(kinds(p)).toEqual(['hold', 'set']);
    expect(last(p)).toEqual({ kind: 'set', value: 0.3, time: 2 });
  });

  it('cancels then anchors when cancelAndHoldAtTime is missing', () => {
    const p = fakeParam(0.3, false);
    holdAt(p, 2);
    expect(kinds(p)).toEqual(['cancel', 'set']);
    expect(last(p)).toEqual({ kind: 'set', value: 0.3, time: 2 });
  });

  it('REGRESSION: both branches end in a setValueAtTime at exactly `time`', () => {
    // This is the "ANCHOR — do not remove" block. Without it a subsequent
    // ramp has no preceding event and interpolates from time zero, which
    // pinned every punch in the chain to its sub oscillator's construction
    // frequency (a steady 129 Hz with no low end at all).
    for (const withHold of [true, false]) {
      const p = fakeParam(0.42, withHold);
      holdAt(p, 7.5);
      const final = last(p);
      expect(final.kind).toBe('set');
      expect(final.time).toBe(7.5);
      expect(final.value).toBe(0.42);
    }
  });
});

describe('resetParam', () => {
  it('never holds, even where cancelAndHoldAtTime is available', () => {
    // Deliberately asymmetric with `holdAt`: a hold event inserted AT `time`
    // wins over a same-instant `setValueAtTime` in Chromium, so the jump
    // would be silently ignored and every sweep would start from the node's
    // construction value instead of its intended one.
    const p = fakeParam(0, true);
    resetParam(p, 1, 94);
    expect(kinds(p)).toEqual(['cancel', 'set']);
    expect(kinds(p)).not.toContain('hold');
    expect(last(p)).toEqual({ kind: 'set', value: 94, time: 1 });
  });
});

describe('fadeOut', () => {
  it('floors the fade length so the ramp is never instantaneous', () => {
    const p = fakeParam(0.5);
    fadeOut(p, 5, 0);
    const final = last(p);
    expect(final.kind).toBe('linear');
    expect(final.value).toBe(0);
    expect(final.time).toBeCloseTo(5.001, 9);
  });

  it('honours a requested fade length', () => {
    const p = fakeParam(0.5);
    fadeOut(p, 5, 0.25);
    expect(last(p).time).toBeCloseTo(5.25, 9);
  });
});

describe('percussive', () => {
  it('writes attack, exponential decay and a hard zero', () => {
    const p = fakeParam();
    const end = percussive(p, 0, 0.8, 0.01, 0.2);
    expect(end).toBeCloseTo(0.211, 9);

    const tail = p.events.slice(-3);
    expect(tail[0]!.kind).toBe('linear');
    expect(tail[0]!.value).toBeCloseTo(0.8, 12);
    expect(tail[0]!.time).toBeCloseTo(0.01, 9);
    expect(tail[1]!.kind).toBe('exponential');
    expect(tail[1]!.value).toBe(SILENCE);
    expect(tail[1]!.time).toBeCloseTo(0.21, 9);
    expect(tail[2]!.kind).toBe('set');
    expect(tail[2]!.value).toBe(0);
    expect(tail[2]!.time).toBeCloseTo(0.211, 9);
  });

  it('floors attack and decay to non-zero durations', () => {
    const p = fakeParam();
    // attack -> 0.0002, decay -> 0.002, plus the 0.001 zero-snap.
    expect(percussive(p, 0, 1, 0, 0)).toBeCloseTo(0.0032, 9);
  });

  it('keeps both ramp endpoints legal for a zero peak', () => {
    // An exponential ramp to 0 throws in Chromium; that is why the floors
    // exist. The linear target is lifted to `SILENCE * 2` and the exponential
    // target is exactly `SILENCE`, never 0.
    const p = fakeParam();
    percussive(p, 0, 0, 0.01, 0.1);
    const linear = p.events.find((e) => e.kind === 'linear')!;
    const exponential = p.events.find((e) => e.kind === 'exponential')!;
    expect(linear.value).toBeGreaterThan(0);
    expect(linear.value).toBe(SILENCE * 2);
    expect(exponential.value).toBe(SILENCE);
  });

  it('returns exactly the time of its final zero, which the voice budget reads', () => {
    // `VoiceBank.markBusyUntil` is fed this number: if it disagreed with the
    // schedule the pool would either recycle a still-sounding slot or hold a
    // silent one.
    const p = fakeParam();
    const end = percussive(p, 3.25, 0.6, 0.004, 0.35);
    const final = last(p);
    expect(final.kind).toBe('set');
    expect(final.value).toBe(0);
    expect(final.time).toBe(end);
  });
});

describe('asr', () => {
  it('writes attack, a FLAT sustain, release and a hard zero', () => {
    const p = fakeParam();
    const end = asr(p, 0, 0.5, 0.02, 1, 0.3);
    expect(end).toBeCloseTo(1.321, 9);

    const tail = p.events.slice(-4);
    expect(tail.map((e) => e.kind)).toEqual(['linear', 'set', 'exponential', 'set']);
    expect(tail[0]!.value).toBeCloseTo(0.5, 12);
    expect(tail[0]!.time).toBeCloseTo(0.02, 9);
    // Flat sustain: the hold value equals the attack target.
    expect(tail[1]!.value).toBe(tail[0]!.value);
    expect(tail[1]!.time).toBeCloseTo(1.02, 9);
    expect(tail[2]!.value).toBe(SILENCE);
    expect(tail[2]!.time).toBeCloseTo(1.32, 9);
    expect(tail[3]!.value).toBe(0);
    expect(tail[3]!.time).toBe(end);
  });

  it('floors attack and release, and clamps a negative sustain to zero', () => {
    const p = fakeParam();
    // a -> 0.0005, s -> 0, r -> 0.005, plus the 0.001 zero-snap.
    expect(asr(p, 0, 1, 0, -5, 0)).toBeCloseTo(0.0065, 9);
  });
});

describe('sweep', () => {
  it('clamps both endpoints strictly away from zero and Nyquist', () => {
    const p = fakeParam();
    sweep(p, 0, 0, 1e9, 0.1, 22050);
    expect(kinds(p)).toEqual(['cancel', 'set', 'exponential']);
    const set = p.events[1]!;
    const ramp = p.events[2]!;
    expect(set.value).toBe(MIN_FREQ);
    expect(ramp.value).toBe(22050 * 0.49);
    expect(set.value).toBeGreaterThan(0);
    expect(ramp.value).toBeGreaterThan(0);
  });

  it('floors the sweep duration', () => {
    const p = fakeParam();
    sweep(p, 0, 400, 60, 0, 22050);
    expect(last(p).time).toBeCloseTo(0.001, 9);
  });

  it('sweep3 writes two ramps after the reset anchor', () => {
    const p = fakeParam();
    sweep3(p, 0, 200, 900, 120, 0.05, 0.2, 22050);
    expect(kinds(p)).toEqual(['cancel', 'set', 'exponential', 'exponential']);
    expect(p.events[1]!.value).toBe(200);
    expect(p.events[2]!.time).toBeCloseTo(0.05, 9);
    expect(p.events[3]!.time).toBeCloseTo(0.25, 9);
  });
});

describe('unit conversion', () => {
  it('round-trips gain and decibels', () => {
    expect(dbToGain(0)).toBe(1);
    expect(gainToDb(1)).toBe(0);
    expect(gainToDb(dbToGain(-12))).toBeCloseTo(-12, 9);
  });

  it('floors gainToDb so silence is finite', () => {
    expect(Number.isFinite(gainToDb(0))).toBe(true);
    expect(gainToDb(0)).toBe(-180);
    // The -80 dB envelope floor the module documents.
    expect(gainToDb(SILENCE)).toBeCloseTo(-80, 9);
  });

  it('tunes to A440 and converts intervals', () => {
    expect(midiToFreq(69)).toBe(440);
    expect(midiToFreq(81)).toBeCloseTo(880, 9);
    expect(semitoneRatio(0)).toBe(1);
    expect(semitoneRatio(12)).toBeCloseTo(2, 12);
    expect(centRatio(1200)).toBeCloseTo(2, 12);
  });

  it('clampFreq pins both endpoints and passes the middle through', () => {
    expect(clampFreq(0, 22050)).toBe(MIN_FREQ);
    expect(clampFreq(1e9, 22050)).toBe(22050 * 0.49);
    expect(clampFreq(1000, 22050)).toBe(1000);
  });
});

describe('waveshaper curves', () => {
  it('softClipCurve is bounded by unity everywhere', () => {
    // The master safety chain rests on "|output| < 1 is mathematically
    // unconditional"; today that is only checked through rendered audio.
    const curve = softClipCurve();
    expect(curve.length).toBe(8192);
    let worst = 0;
    let finite = true;
    for (let i = 0; i < curve.length; i++) {
      const v = curve[i]!;
      if (!Number.isFinite(v)) finite = false;
      worst = Math.max(worst, Math.abs(v));
    }
    expect(finite).toBe(true);
    expect(worst).toBeLessThanOrEqual(1);
  });

  it('softClipCurve is monotone from -1 to +1', () => {
    const curve = softClipCurve();
    let monotone = true;
    for (let i = 0; i + 1 < curve.length; i++) {
      if (curve[i]! > curve[i + 1]!) monotone = false;
    }
    expect(monotone).toBe(true);
    expect(curve[0]!).toBeCloseTo(-1, 12);
    expect(curve[8191]!).toBeCloseTo(1, 12);
  });

  it('growlCurve is bounded and ASYMMETRIC', () => {
    // The asymmetry is the whole reason the function exists: even harmonics
    // are what make a monster read as a throat rather than a synthesiser.
    const curve = growlCurve();
    expect(curve.length).toBe(4096);
    let worst = 0;
    let finite = true;
    for (let i = 0; i < curve.length; i++) {
      const v = curve[i]!;
      if (!Number.isFinite(v)) finite = false;
      worst = Math.max(worst, Math.abs(v));
    }
    expect(finite).toBe(true);
    expect(worst).toBeLessThanOrEqual(1);
    expect(Math.abs(curve[0]!)).toBeLessThan(curve[4095]!);
  });
});
