/**
 * REVERB — a feedback delay network, generated like everything else.
 *
 * A 1.5 km city that is entirely dry reads as small and flat: an alley, a
 * covered arcade and the middle of an open street all sound identical, and a
 * punch thrown in a crater sounds like a punch thrown in a vacuum. This is the
 * one thing distance attenuation cannot supply.
 *
 * ── WHY AN FDN AND NOT A CONVOLVER ─────────────────────────────────────────
 * `ConvolverNode` with a procedurally generated impulse response would sound
 * better and would still ship zero bytes. It is also partitioned FFT
 * convolution over a multi-second stereo response, which is one of the most
 * expensive things the Web Audio graph can do — not a sensible standing cost
 * on a mid-range Android that is also running the renderer and the physics.
 *
 * A feedback delay network gets most of the way there for a handful of nodes:
 * four delay lines, each damped in its feedback path, cross-coupled so that
 * energy circulates between them and the echo density builds up into a
 * diffuse tail instead of a discrete slapback.
 *
 * ── THE CHEAP MIXING MATRIX ────────────────────────────────────────────────
 * The cross-coupling is a Householder reflection:
 *
 *     y = x - (2/N) * (sum of x)
 *
 * It is orthogonal, so it preserves energy and the decay is governed purely by
 * the feedback gain — but unlike a Hadamard matrix it needs no N x N grid of
 * gain nodes. One summing node and one scaling node implement the whole thing,
 * which turns 16 connections into 2. That is the difference between a reverb
 * that is affordable on a phone and one that is not.
 *
 * ── ROUTING ────────────────────────────────────────────────────────────────
 * This is a SEND, not an insert. Each voice contributes an amount set per
 * sound key, so the punch family stays as dry as it was designed to be while
 * a collapse or a monster roar fills the street. Sends pass through the mixer
 * strips first, so turning a bus down turns its reverb down with it.
 */

import { clamp, clamp01, lerp } from '@/util';

/** Delay lines. Four is the smallest count that diffuses convincingly. */
const LINES = 4;

/**
 * Base delay times in seconds, scaled by room size.
 *
 * Mutually incommensurate on purpose: delay lengths sharing a common factor
 * make their echoes coincide, which is heard as a metallic ring rather than as
 * a room. These are near-prime millisecond values.
 */
const BASE_DELAYS: readonly number[] = [0.0297, 0.0371, 0.0411, 0.0437];

/**
 * Resonance of the damping filter, IN DECIBELS.
 *
 * For `lowpass` and `highpass` the Web Audio specification defines `Q` as a
 * resonance in dB rather than as a quality factor, so any positive value puts
 * a peak ABOVE UNITY into the filter. This filter sits inside the feedback
 * loop, where gain above unity is not a colouration but an oscillator: the
 * offline probe caught an "alley" whose tail decayed to -53 dB and then
 * climbed back to +22 dB over the next five seconds.
 *
 * A negative value is therefore mandatory, not stylistic. -3 dB is
 * comfortably over-damped, and the loss it contributes is accounted for by
 * calibrating the presets against measured decay rather than trusting the
 * analytic feedback formula alone.
 */
const DAMPING_Q = -3;

/** Stereo placement per line, so the tail is wide rather than centred. */
const LINE_PAN: readonly number[] = [-0.85, 0.8, -0.4, 0.45];

/** Named acoustic environments. */
export type ReverbPreset =
  | 'none'
  | 'openStreet'
  | 'arcade'
  | 'alley'
  | 'indoor'
  | 'crater'
  | 'openField';

/** What an environment sounds like. */
export interface IReverbSettings {
  /** Multiplier on the base delay times: how big the space is. */
  readonly size: number;
  /** Target -60 dB decay time in seconds. */
  readonly rt60: number;
  /** Feedback-path lowpass cutoff: how absorbent the surfaces are. */
  readonly damping: number;
  /** Gap before the first reflection, in seconds. */
  readonly preDelay: number;
  /** Output level of the wet signal. */
  readonly wet: number;
  /** One line, surfaced in the audition harness. */
  readonly description: string;
}

export const REVERB_PRESETS: Record<ReverbPreset, IReverbSettings> = {
  none: {
    size: 1,
    rt60: 0.4,
    damping: 4000,
    preDelay: 0.01,
    wet: 0,
    description: 'Anechoic. No send reaches the master.',
  },
  /** The default city exterior: hard surfaces, a long street, open above. */
  openStreet: {
    size: 1,
    rt60: 1.5,
    damping: 3800,
    preDelay: 0.018,
    wet: 0.55,
    description: 'Open city street: hard facades, sky above, medium tail.',
  },
  /**
   * A covered shopping arcade. Smaller and brighter than the street, with a
   * much earlier first reflection — the ceiling is right there.
   */
  arcade: {
    size: 0.62,
    rt60: 1.15,
    damping: 2600,
    preDelay: 0.009,
    wet: 0.6,
    description: 'Covered shopping arcade: close ceiling, early reflections, warm.',
  },
  /** Narrow, parallel walls, very short path lengths. Tight and edgy. */
  alley: {
    size: 0.32,
    rt60: 0.45,
    damping: 3200,
    preDelay: 0.004,
    wet: 0.52,
    description: 'Narrow alley: short, tight, close walls.',
  },
  /** An ordinary room. Soft furnishings eat the top end quickly. */
  indoor: {
    size: 0.42,
    rt60: 0.5,
    damping: 1900,
    preDelay: 0.006,
    wet: 0.5,
    description: 'Interior room: small, damped, dark.',
  },
  /**
   * The hole a serious punch leaves. Large, enclosing, and dark, because
   * broken earth absorbs the top end that concrete would return.
   */
  crater: {
    size: 1.65,
    rt60: 5,
    damping: 1900,
    preDelay: 0.03,
    wet: 0.62,
    description: 'Impact crater: enormous, dark, the longest tail in the city.',
  },
  /** Outside the city. Distant, sparse, mostly air. */
  openField: {
    size: 2.1,
    rt60: 2,
    damping: 5200,
    preDelay: 0.055,
    wet: 0.3,
    description: 'Open ground outside the city: distant, sparse, bright.',
  },
};

/** Every preset name, for the harness and tests. */
export const REVERB_PRESET_NAMES = Object.keys(REVERB_PRESETS) as ReverbPreset[];

/**
 * Feedback gain that decays by 60 dB over `rt60` for a given mean delay.
 *
 * This is the lossless-prototype answer and it is only a starting point: the
 * damping filter in the loop contributes its own insertion loss, so the real
 * decay is always faster than the formula predicts. The `rt60` values in the
 * presets are therefore calibrated against MEASURED decay slopes rather than
 * being treated as ground truth — the measured figures are what the tests
 * assert on.
 *
 * Clamped below 1 so the network can never self-oscillate, whatever a caller
 * asks for.
 */
export function feedbackForRt60(meanDelay: number, rt60: number): number {
  if (rt60 <= 0) return 0;
  return clamp(Math.pow(10, (-3 * meanDelay) / rt60), 0, 0.93);
}

/** One send-effect reverb. Create exactly one per audio system. */
export class ReverbSend {
  /** Voices and bus sends connect here. */
  readonly input: GainNode;
  /** Wet output; connect this to the master bus. */
  readonly output: GainNode;

  private readonly ctx: BaseAudioContext;
  private readonly preDelay: DelayNode;
  private readonly lineIn: GainNode[] = [];
  private readonly delays: DelayNode[] = [];
  private readonly damping: BiquadFilterNode[] = [];
  private readonly feedback: GainNode[] = [];
  private readonly pans: StereoPannerNode[] = [];
  private readonly mixBus: GainNode;
  private readonly householder: GainNode;
  private readonly wetSum: GainNode;
  private readonly lowCut: BiquadFilterNode;

  private currentPreset: ReverbPreset = 'openStreet';

  constructor(ctx: BaseAudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.input.gain.value = 1;

    this.preDelay = ctx.createDelay(0.5);
    this.preDelay.delayTime.value = 0.018;
    this.input.connect(this.preDelay);

    this.wetSum = ctx.createGain();
    this.wetSum.gain.value = 1;

    // Householder plumbing: everything sums into `mixBus`, which is scaled
    // once and fed back into every line. Two nodes instead of sixteen.
    this.mixBus = ctx.createGain();
    this.mixBus.gain.value = 1;
    this.householder = ctx.createGain();
    this.householder.gain.value = 0;
    this.mixBus.connect(this.householder);

    for (let i = 0; i < LINES; i++) {
      const lineIn = ctx.createGain();
      lineIn.gain.value = 1;
      // Maximum delay is generous so the largest preset still fits.
      const delay = ctx.createDelay(1);
      delay.delayTime.value = BASE_DELAYS[i]!;
      const damp = ctx.createBiquadFilter();
      damp.type = 'lowpass';
      damp.frequency.value = 3800;
      // Q MUST be 0 here, and that is not a "no resonance" spelling of 0.707.
      //
      // For `lowpass` and `highpass` the Web Audio specification defines Q as a
      // RESONANCE IN DECIBELS, not as a quality factor. Any positive value
      // therefore puts a peak above unity gain into the filter — and this
      // filter sits inside the feedback loop, so a peak of a fraction of a dB
      // makes the whole network self-oscillate. The offline probe caught it as
      // an "alley" whose tail decayed to -53 dB and then climbed back to
      // +22 dB over the following five seconds.
      damp.Q.value = DAMPING_Q;
      const fb = ctx.createGain();
      fb.gain.value = 0;
      const pan = ctx.createStereoPanner();
      pan.pan.value = LINE_PAN[i]!;

      this.preDelay.connect(lineIn);
      lineIn.connect(delay).connect(damp);
      // Own feedback, shared Householder term, and the tap to the output.
      // Every one of these loops passes through `delay`, which is what makes
      // the cycle legal in the Web Audio graph.
      damp.connect(fb).connect(lineIn);
      damp.connect(this.mixBus);
      this.householder.connect(lineIn);
      damp.connect(pan).connect(this.wetSum);

      this.lineIn.push(lineIn);
      this.delays.push(delay);
      this.damping.push(damp);
      this.feedback.push(fb);
      this.pans.push(pan);
    }

    // Keep the tail out of the sub band. Reverb below ~160 Hz turns every
    // impact into mud, and this game's impacts live down there.
    this.lowCut = ctx.createBiquadFilter();
    this.lowCut.type = 'highpass';
    this.lowCut.frequency.value = 170;
    this.lowCut.Q.value = 0.7;

    this.output = ctx.createGain();
    this.output.gain.value = 0;
    this.wetSum.connect(this.lowCut).connect(this.output).connect(destination);

    this.apply(REVERB_PRESETS.openStreet, 0, 0);
  }

  get preset(): ReverbPreset {
    return this.currentPreset;
  }

  /** Current settings, after any manual overrides. */
  get settings(): IReverbSettings {
    return REVERB_PRESETS[this.currentPreset];
  }

  /**
   * Switch environment. The glide is deliberate: delay times are ramped rather
   * than jumped, so a transition sounds like walking out of an alley rather
   * than like a cut.
   */
  setPreset(preset: ReverbPreset, time = this.ctx.currentTime, glideSeconds = 0.5): void {
    if (!REVERB_PRESETS[preset]) return;
    this.currentPreset = preset;
    this.apply(REVERB_PRESETS[preset], time, glideSeconds);
  }

  /** Scale the wet level without changing the environment. */
  setWet(amount: number, time = this.ctx.currentTime, glideSeconds = 0.2): void {
    const target = clamp01(amount) * REVERB_PRESETS[this.currentPreset].wet;
    ramp(this.output.gain, target, time, glideSeconds);
  }

  private apply(settings: IReverbSettings, time: number, glide: number): void {
    let meanDelay = 0;
    for (let i = 0; i < LINES; i++) {
      const seconds = clamp(BASE_DELAYS[i]! * settings.size, 0.001, 0.95);
      meanDelay += seconds;
      ramp(this.delays[i]!.delayTime, seconds, time, glide);
      ramp(this.damping[i]!.frequency, clamp(settings.damping, 200, 18000), time, glide);
    }
    meanDelay /= LINES;

    const g = feedbackForRt60(meanDelay, settings.rt60);
    for (let i = 0; i < LINES; i++) ramp(this.feedback[i]!.gain, g, time, glide);
    // -2/N scaled by the same feedback gain keeps the reflection orthogonal,
    // so the decay is set by `g` alone and the network stays stable.
    ramp(this.householder.gain, (-2 / LINES) * g, time, glide);

    ramp(this.preDelay.delayTime, clamp(settings.preDelay, 0, 0.45), time, glide);
    // Bigger spaces are wider; a small room collapses towards the centre.
    const width = clamp01(lerp(0.45, 1, Math.min(settings.size, 1.6) / 1.6));
    for (let i = 0; i < LINES; i++) ramp(this.pans[i]!.pan, LINE_PAN[i]! * width, time, glide);

    ramp(this.output.gain, settings.wet, time, glide);
  }

  dispose(): void {
    this.input.disconnect();
    this.preDelay.disconnect();
    for (const n of this.lineIn) n.disconnect();
    for (const n of this.delays) n.disconnect();
    for (const n of this.damping) n.disconnect();
    for (const n of this.feedback) n.disconnect();
    for (const n of this.pans) n.disconnect();
    this.mixBus.disconnect();
    this.householder.disconnect();
    this.wetSum.disconnect();
    this.lowCut.disconnect();
    this.output.disconnect();
  }
}

/** Glide a param, or set it outright when the glide is zero. */
function ramp(param: AudioParam, value: number, time: number, seconds: number): void {
  param.cancelScheduledValues(time);
  if (seconds <= 0) {
    param.setValueAtTime(value, time);
    return;
  }
  param.setValueAtTime(param.value, time);
  param.linearRampToValueAtTime(value, time + seconds);
}
