/**
 * DSP PRIMITIVES
 *
 * Every sound in this game is SYNTHESISED AT RUNTIME. There are zero audio
 * files in the repository and zero audio bytes in the shipped bundle. This
 * file holds the low-level helpers every voice is built from: unit
 * conversions, `AudioParam` envelope shaping and waveshaper curve generation.
 *
 * ── WHY THESE HELPERS EXIST ────────────────────────────────────────────────
 * Web Audio's automation API has three sharp edges that bite every hand-rolled
 * synth, and every one of them is handled here exactly once:
 *
 *  1. `exponentialRampToValueAtTime` throws (or silently no-ops) when either
 *     endpoint is <= 0. Percussive envelopes therefore ramp to `SILENCE`
 *     (-80 dB) rather than 0, and only then snap to a true 0.
 *  2. Re-triggering a pooled voice must cancel the previous envelope, but
 *     `cancelScheduledValues` alone leaves the param interpolating from a
 *     stale event. Always anchor with a `setValueAtTime` immediately after.
 *  3. `cancelAndHoldAtTime` is the correct primitive for an interrupting
 *     fade-out but is not universally implemented, so it is feature-detected.
 *
 * Nothing here allocates on the audio thread: curve tables are built once and
 * envelopes are pure `AudioParam` automation on pre-built graphs.
 */

import { clamp } from '@/util';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Envelope floor. Exponential ramps cannot reach zero, so this stands in for
 * silence: -80 dB, far below the noise floor of any phone speaker.
 */
export const SILENCE = 1e-4;

/** Lowest legal value for a frequency `AudioParam` ramp. */
export const MIN_FREQ = 1e-3;

/** Reference tuning. */
export const A4_HZ = 440;

/* -------------------------------------------------------------------------- */
/* Unit conversion                                                            */
/* -------------------------------------------------------------------------- */

/** Decibels (relative to unity) to linear gain. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** Linear gain to decibels, floored so silence returns a finite value. */
export function gainToDb(gain: number): number {
  return 20 * Math.log10(Math.max(Math.abs(gain), 1e-9));
}

/** MIDI note number to frequency in Hz. 69 = A4 = 440 Hz. */
export function midiToFreq(midi: number): number {
  return A4_HZ * Math.pow(2, (midi - 69) / 12);
}

/** Frequency ratio for a signed number of semitones. */
export function semitoneRatio(semitones: number): number {
  return Math.pow(2, semitones / 12);
}

/** Frequency ratio for a signed number of cents. */
export function centRatio(cents: number): number {
  return Math.pow(2, cents / 1200);
}

/**
 * Clamp a frequency into the audible/legal range for a filter or oscillator.
 * `nyquist` guards against Chromium clamping (and the resulting zipper noise)
 * when a sweep overshoots.
 */
export function clampFreq(hz: number, nyquist: number): number {
  return clamp(hz, MIN_FREQ, nyquist * 0.49);
}

/* -------------------------------------------------------------------------- */
/* AudioParam automation                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Freeze a param at `time`: drop every event at or after it, keep the value it
 * had reached, and leave an anchor there for the next ramp.
 *
 * This is the ONLY correct way to interrupt a pooled voice mid-tail.
 * `cancelScheduledValues` alone removes the in-flight ramp *event*, which
 * makes the param revert to the value it held before the ramp started — a
 * decaying impact would jump back to full level for the remainder of its tail.
 * `cancelAndHoldAtTime` exists precisely to avoid that, and is feature-
 * detected because a few WebViews still lack it.
 */
export function holdAt(param: AudioParam, time: number): void {
  const holdable = param as AudioParam & { cancelAndHoldAtTime?: (t: number) => void };
  if (typeof holdable.cancelAndHoldAtTime === 'function') {
    holdable.cancelAndHoldAtTime(time);
  } else {
    param.cancelScheduledValues(time);
  }
  // ANCHOR — do not remove.
  //
  // `cancelAndHoldAtTime` only inserts a hold event when there was automation
  // to cancel. On a param that has never been automated it leaves the timeline
  // EMPTY, and a `linearRampToValueAtTime` that follows then has no preceding
  // event to start from, so it interpolates all the way from time zero.
  //
  // In a pooled synthesiser that is catastrophic and almost invisible: the
  // FIRST hit on a voice sounds correct because the voice's output gain is
  // still closed, while every later hit spends the whole preceding buffer
  // fading in at its oscillator's construction frequency. The offline probe
  // saw it as a punch chain pinned to a steady 129 Hz — the default value of
  // its sub oscillator — with no low end at all.
  //
  // Writing an explicit anchor covers both cases: when the hold did insert
  // one, this same-time write is ignored; when it did not, `param.value` is
  // the param's true constant value, which is exactly what should be held.
  param.setValueAtTime(param.value, time);
}

/**
 * Jump a param to `value` at `time`, discarding anything scheduled after it.
 * Used for parameters that must restart EXACTLY — an oscillator or filter
 * frequency at the top of a sweep — rather than glide from wherever the
 * previous instance left them.
 *
 * ── WHY NOT `cancelAndHoldAtTime` HERE ─────────────────────────────────────
 * It looks like the better primitive, and for the gain envelopes it is. But
 * `cancelAndHoldAtTime(t)` inserts an implicit event AT t holding the current
 * value, and a `setValueAtTime(v, t)` immediately afterwards lands on the same
 * instant. The specification says the later insertion wins; Chromium keeps the
 * hold. The consequence is silent and severe: the jump is ignored and every
 * sweep starts from whatever the node was constructed with instead of from its
 * intended value.
 *
 * The offline probe caught this as a punch chain whose sub sat at a steady
 * 129 Hz — its oscillator's constructor default — instead of sweeping from
 * 94 Hz down through the sub band. It was invisible in the voices whose
 * construction value happened to equal their sweep start, which is most of
 * them, which is exactly what made it hard to see.
 *
 * `cancelScheduledValues` has no such ambiguity. The trade-off it brings —
 * an interrupted ramp reverts for the interval before `time` — only affects
 * the pitch of a tail that is being replaced anyway.
 */
export function resetParam(param: AudioParam, time: number, value: number): void {
  param.cancelScheduledValues(time);
  param.setValueAtTime(value, time);
}

/**
 * Interrupting fade to zero — used when a voice is stolen mid-tail by the
 * voice budget. Holds the *current* automated value where supported so the
 * fade starts from wherever the envelope actually was, avoiding a click.
 */
export function fadeOut(param: AudioParam, time: number, seconds: number): void {
  holdAt(param, time);
  param.linearRampToValueAtTime(0, time + Math.max(seconds, 0.001));
}

/**
 * Percussive attack/decay envelope on a gain param.
 *
 * Shape: 0 -> `peak` over `attack` (linear, so the transient stays crisp),
 * then an exponential decay to silence over `decay` (exponential, because
 * that is how physical impacts actually die away), then a hard 0 so a
 * free-running oscillator contributes nothing at all between hits.
 *
 * @returns the absolute time at which the envelope reaches true zero.
 */
export function percussive(
  param: AudioParam,
  t0: number,
  peak: number,
  attack: number,
  decay: number
): number {
  const top = Math.max(peak, SILENCE * 2);
  const a = Math.max(attack, 0.0002);
  const d = Math.max(decay, 0.002);
  // Ramp up FROM the held value rather than snapping to zero first: a
  // re-triggered voice must not click, and starting the attack from a
  // still-decaying tail is what a fast double-hit actually sounds like.
  holdAt(param, t0);
  param.linearRampToValueAtTime(top, t0 + a);
  param.exponentialRampToValueAtTime(SILENCE, t0 + a + d);
  param.setValueAtTime(0, t0 + a + d + 0.001);
  return t0 + a + d + 0.001;
}

/**
 * Attack / sustain / release envelope for voices that hold, such as a monster
 * roar or a music pad. Sustain is flat (not decaying) so the shape is fully
 * determined by the caller.
 *
 * @returns the absolute time at which the envelope reaches true zero.
 */
export function asr(
  param: AudioParam,
  t0: number,
  peak: number,
  attack: number,
  sustain: number,
  release: number
): number {
  const top = Math.max(peak, SILENCE * 2);
  const a = Math.max(attack, 0.0005);
  const s = Math.max(sustain, 0);
  const r = Math.max(release, 0.005);
  holdAt(param, t0);
  param.linearRampToValueAtTime(top, t0 + a);
  param.setValueAtTime(top, t0 + a + s);
  param.exponentialRampToValueAtTime(SILENCE, t0 + a + s + r);
  param.setValueAtTime(0, t0 + a + s + r + 0.001);
  return t0 + a + s + r + 0.001;
}

/**
 * Exponential frequency sweep — the workhorse behind every impact in the
 * game. Both endpoints are clamped away from zero and Nyquist because a ramp
 * that touches either produces audible aliasing artefacts in Chromium.
 */
export function sweep(
  param: AudioParam,
  t0: number,
  from: number,
  to: number,
  seconds: number,
  nyquist: number
): void {
  const a = clampFreq(from, nyquist);
  const b = clampFreq(to, nyquist);
  resetParam(param, t0, a);
  param.exponentialRampToValueAtTime(b, t0 + Math.max(seconds, 0.001));
}

/**
 * Three-point exponential sweep: rise then fall (or fall then rise). Used for
 * the dash whoosh and the jump, where a single monotonic sweep sounds flat.
 */
export function sweep3(
  param: AudioParam,
  t0: number,
  from: number,
  mid: number,
  to: number,
  firstSeconds: number,
  secondSeconds: number,
  nyquist: number
): void {
  const a = clampFreq(from, nyquist);
  const b = clampFreq(mid, nyquist);
  const c = clampFreq(to, nyquist);
  resetParam(param, t0, a);
  param.exponentialRampToValueAtTime(b, t0 + Math.max(firstSeconds, 0.001));
  param.exponentialRampToValueAtTime(c, t0 + Math.max(firstSeconds, 0.001) + Math.max(secondSeconds, 0.001));
}

/* -------------------------------------------------------------------------- */
/* Waveshaper curves                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `tanh` soft-clip curve.
 *
 * This is the master safety net. `DynamicsCompressorNode` is a *limiter*, not
 * a clipper: it has finite attack and will let a fast transient through above
 * threshold. Feeding its output through this curve makes |output| < 1
 * mathematically unconditional, which is what lets the render tests assert a
 * hard peak ceiling rather than hoping the mix behaves.
 *
 * `drive` > 1 adds harmonic saturation before the ceiling, which also makes
 * loud impacts read as *bigger* on a phone speaker rather than just louder.
 */
export function softClipCurve(length = 8192, drive = 1.5): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(length);
  const norm = Math.tanh(drive);
  for (let i = 0; i < length; i++) {
    const x = (i / (length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / norm;
  }
  return curve;
}

/**
 * Asymmetric drive curve. Adds even harmonics, which is what makes a monster
 * growl sound like a throat rather than a synthesiser.
 */
export function growlCurve(length = 4096, amount = 0.7): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(length);
  const k = clamp(amount, 0, 0.999) * 40;
  for (let i = 0; i < length; i++) {
    const x = (i / (length - 1)) * 2 - 1;
    const shaped = ((1 + k) * x) / (1 + k * Math.abs(x));
    // Asymmetry: compress the negative half harder than the positive half.
    curve[i] = x >= 0 ? shaped : shaped * 0.72;
  }
  return curve;
}

/* -------------------------------------------------------------------------- */
/* Scheduling helpers                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Poisson-ish onset times over `seconds`, used by every granular voice.
 *
 * Regular intervals are the single most obvious tell of synthetic debris — a
 * uniform grid reads as a machine gun, not as rubble. Drawing inter-onset
 * intervals from an exponential distribution gives the clustered, irregular
 * arrival pattern of real falling material. `jitterFloor` keeps a minimum
 * separation so grains do not pile into a single transient.
 *
 * Deterministic given the supplied uniform stream, so offline renders and the
 * render tests are exactly reproducible.
 */
export function poissonOnsets(
  count: number,
  seconds: number,
  next: () => number,
  jitterFloor = 0.004
): number[] {
  const n = Math.max(0, Math.floor(count));
  const out: number[] = [];
  if (n === 0) return out;
  const meanGap = Math.max(seconds / n, jitterFloor);
  let t = 0;
  for (let i = 0; i < n; i++) {
    // Inverse-CDF sample of an exponential distribution.
    const u = Math.max(next(), 1e-6);
    t += jitterFloor + -Math.log(u) * meanGap * 0.9;
    if (t > seconds) break;
    out.push(t);
  }
  return out;
}
