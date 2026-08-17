/**
 * PUNCH — the bread-and-butter impact.
 *
 * Three layers, because that is what a real close-mic'd impact is made of and
 * because each one carries a different part of the perception:
 *
 *  1. SUB      — a sine swept 120 -> 45 Hz in 90 ms. Carries the *weight*.
 *                The downward sweep is the whole trick: a static low sine
 *                reads as a musical note, a falling one reads as mass.
 *  2. BODY     — bandpassed white noise, centre swept 900 -> 180 Hz. Carries
 *                the *material* — the thump of flesh and fabric.
 *  3. TRANSIENT— a triangle swept 3.8 kHz -> 700 Hz in 8 ms plus a highpassed
 *                noise tick. Carries the *contact*. Without it the punch
 *                sounds like it happened in the next room.
 *
 * Everything is dry: no reverb tail, no long release. A punch that rings is a
 * punch that feels soft, and this game's whole identity is the opposite.
 *
 * ZERO ALLOCATION: the two oscillators and the noise source run continuously
 * from construction. A trigger only writes envelopes and sweeps.
 */

import type { AudioCategory } from '@/types';
import { clamp, clamp01, lerp } from '@/util';
import { percussive, resetParam, sweep } from '../dsp';
import { createNoiseSource } from '../noise';
import { SynthVoice, type ITriggerParams } from '../voice';

/** Tuning for one punch flavour. */
interface PunchShape {
  /** Sub sweep start/end in Hz and sweep duration. */
  readonly subFrom: number;
  readonly subTo: number;
  readonly subSweep: number;
  readonly subDecay: number;
  readonly subGain: number;
  /** Body bandpass sweep. */
  readonly bodyFrom: number;
  readonly bodyTo: number;
  readonly bodyQ: number;
  readonly bodyDecay: number;
  readonly bodyGain: number;
  /** Contact transient. */
  readonly tickFrom: number;
  readonly tickTo: number;
  readonly tickDecay: number;
  readonly tickGain: number;
  readonly clickHz: number;
  readonly clickDecay: number;
  readonly clickGain: number;
}

/**
 * Variants. `normal` is the reference; the others are the same architecture
 * with the balance shifted, which keeps the family recognisably one sound.
 */
const SHAPES: Record<string, PunchShape> = {
  // Ordinary combat force.
  normal: {
    subFrom: 120,
    subTo: 45,
    subSweep: 0.09,
    subDecay: 0.16,
    subGain: 0.72,
    bodyFrom: 900,
    bodyTo: 180,
    bodyQ: 1.1,
    bodyDecay: 0.085,
    bodyGain: 0.34,
    tickFrom: 3800,
    tickTo: 700,
    tickDecay: 0.014,
    tickGain: 0.2,
    clickHz: 2600,
    clickDecay: 0.018,
    clickGain: 0.17,
  },
  // Pulled punch used around civilians: less sub, softer contact.
  restrained: {
    subFrom: 95,
    subTo: 52,
    subSweep: 0.06,
    subDecay: 0.1,
    subGain: 0.4,
    bodyFrom: 700,
    bodyTo: 220,
    bodyQ: 1.4,
    bodyDecay: 0.06,
    bodyGain: 0.3,
    tickFrom: 2600,
    tickTo: 800,
    tickDecay: 0.01,
    tickGain: 0.12,
    clickHz: 2200,
    clickDecay: 0.012,
    clickGain: 0.1,
  },
  // Committed strike — uppercut, slam. Deeper and longer, still dry.
  heavy: {
    subFrom: 150,
    subTo: 36,
    subSweep: 0.13,
    subDecay: 0.3,
    subGain: 0.8,
    bodyFrom: 1200,
    bodyTo: 140,
    bodyQ: 0.9,
    bodyDecay: 0.14,
    bodyGain: 0.4,
    tickFrom: 4600,
    tickTo: 600,
    tickDecay: 0.02,
    tickGain: 0.24,
    clickHz: 3000,
    clickDecay: 0.026,
    clickGain: 0.2,
  },
  // Generic body/ragdoll contact for `ImpulseApplied`: dull, no bright tick.
  body: {
    subFrom: 90,
    subTo: 42,
    subSweep: 0.07,
    subDecay: 0.13,
    subGain: 0.42,
    bodyFrom: 520,
    bodyTo: 130,
    bodyQ: 1.6,
    bodyDecay: 0.1,
    bodyGain: 0.34,
    tickFrom: 1400,
    tickTo: 400,
    tickDecay: 0.012,
    tickGain: 0.07,
    clickHz: 1200,
    clickDecay: 0.014,
    clickGain: 0.06,
  },
};

/** Names of every punch variant, for the harness and tests. */
export const PUNCH_VARIANTS = Object.keys(SHAPES);

export class PunchVoice extends SynthVoice {
  private readonly sub: OscillatorNode;
  private readonly subGain: GainNode;
  private readonly tick: OscillatorNode;
  private readonly tickGain: GainNode;
  private readonly noise: AudioBufferSourceNode;
  private readonly bodyFilter: BiquadFilterNode;
  private readonly bodyGain: GainNode;
  private readonly clickFilter: BiquadFilterNode;
  private readonly clickGain: GainNode;
  private readonly trim: GainNode;

  constructor(
    ctx: BaseAudioContext,
    destination: AudioNode,
    key = 'punch.normal',
    category: AudioCategory = 'sfx',
    noiseOffset = 0
  ) {
    super(ctx, key, category, destination);

    // Trim keeps the summed layers inside sane gain staging before the bus,
    // so a single punch never asks the master limiter to do any work.
    this.trim = ctx.createGain();
    this.trim.gain.value = 0.62;
    this.trim.connect(this.output);

    // --- Layer 1: sub ---------------------------------------------------
    this.sub = ctx.createOscillator();
    this.sub.type = 'sine';
    this.sub.frequency.value = 120;
    this.subGain = ctx.createGain();
    this.subGain.gain.value = 0;
    this.sub.connect(this.subGain).connect(this.trim);
    this.sub.start();

    // --- Layer 2: body (bandpassed noise) -------------------------------
    this.noise = createNoiseSource(ctx, 'white', noiseOffset);
    this.bodyFilter = ctx.createBiquadFilter();
    this.bodyFilter.type = 'bandpass';
    this.bodyFilter.frequency.value = 900;
    this.bodyFilter.Q.value = 1.1;
    this.bodyGain = ctx.createGain();
    this.bodyGain.gain.value = 0;
    this.noise.connect(this.bodyFilter).connect(this.bodyGain).connect(this.trim);

    // --- Layer 3: contact transient -------------------------------------
    this.tick = ctx.createOscillator();
    this.tick.type = 'triangle';
    this.tick.frequency.value = 3800;
    this.tickGain = ctx.createGain();
    this.tickGain.gain.value = 0;
    this.tick.connect(this.tickGain).connect(this.trim);
    this.tick.start();

    this.clickFilter = ctx.createBiquadFilter();
    this.clickFilter.type = 'highpass';
    this.clickFilter.frequency.value = 2600;
    this.clickFilter.Q.value = 0.7;
    this.clickGain = ctx.createGain();
    this.clickGain.gain.value = 0;
    this.noise.connect(this.clickFilter).connect(this.clickGain).connect(this.trim);

    this.tune(this.sub, this.tick);
  }

  protected override schedule(p: ITriggerParams): number {
    const shape = SHAPES[p.variant ?? 'normal'] ?? SHAPES.normal!;
    const t = p.time;
    const nq = this.nyquist;
    const power = clamp01(p.intensity);
    // Harder hits go slightly lower and last longer — the same gesture a
    // foley artist makes when a hit needs to feel bigger.
    const rate = clamp(p.rate * lerp(1.08, 0.9, power), 0.3, 3);
    const lengthen = lerp(0.85, 1.25, power);

    // Sub.
    sweep(this.sub.frequency, t, shape.subFrom * rate, shape.subTo * rate, shape.subSweep, nq);
    const subEnd = percussive(
      this.subGain.gain,
      t,
      shape.subGain * lerp(0.6, 1, power),
      0.0015,
      shape.subDecay * lengthen
    );

    // Body.
    sweep(
      this.bodyFilter.frequency,
      t,
      shape.bodyFrom * rate,
      shape.bodyTo * rate,
      shape.bodyDecay * 0.9,
      nq
    );
    resetParam(this.bodyFilter.Q, t, shape.bodyQ);
    const bodyEnd = percussive(
      this.bodyGain.gain,
      t,
      shape.bodyGain * lerp(0.7, 1, power),
      0.002,
      shape.bodyDecay * lengthen
    );

    // Contact.
    sweep(this.tick.frequency, t, shape.tickFrom * rate, shape.tickTo * rate, 0.008, nq);
    const tickEnd = percussive(this.tickGain.gain, t, shape.tickGain, 0.0005, shape.tickDecay);
    resetParam(this.clickFilter.frequency, t, Math.min(shape.clickHz * rate, nq * 0.45));
    const clickEnd = percussive(
      this.clickGain.gain,
      t,
      shape.clickGain * lerp(0.6, 1, power),
      0.0004,
      shape.clickDecay
    );

    return Math.max(subEnd, bodyEnd, tickEnd, clickEnd) - t;
  }

  protected override teardown(): void {
    SynthVoice.stopSource(this.sub);
    SynthVoice.stopSource(this.tick);
    SynthVoice.stopSource(this.noise);
    this.trim.disconnect();
    this.subGain.disconnect();
    this.bodyFilter.disconnect();
    this.bodyGain.disconnect();
    this.clickFilter.disconnect();
    this.clickGain.disconnect();
    this.tickGain.disconnect();
  }
}
