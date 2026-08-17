/**
 * SHOCKWAVE — the serious punch. The signature sound of the game.
 *
 * This is the one sound the player will remember, so it gets five layers and
 * the most care. The design goal: it should not read as "a loud punch" but as
 * *the air itself failing*. That means the energy has to MOVE — from a
 * brilliant crack down to a subsonic pressure wave — over a long, unhurried
 * decay, while everything else in the mix gets out of its way.
 *
 *  1. CRACK      — 12 ms of highpassed noise. The wavefront leaving the fist.
 *  2. SWEEP      — the core. Shaped noise through a resonant lowpass whose
 *                  cutoff falls 3.5 kHz -> 55 Hz over ~1.3 s at Q≈9. The
 *                  resonance means the filter itself sings as it descends,
 *                  which is what produces the falling "whoooom" rather than a
 *                  simple fade. The render tests verify this by measuring the
 *                  spectral centroid over four time slices and asserting it
 *                  falls monotonically.
 *  3. SUB DROP   — a sine falling 90 -> 20 Hz. A second oscillator tracks it
 *                  an octave up: 20 Hz is inaudible through a phone speaker,
 *                  and the octave gives the ear a harmonic to reconstruct the
 *                  missing fundamental from.
 *  4. AIR        — brown noise through a low lowpass, slow swell, ~2.5 s tail.
 *                  This is the rumble that arrives *after* the impact.
 *  5. RESONANCE  — a high-Q bandpass ping around 1.2 kHz, 0.25 s. Metallic
 *                  edge; keeps the sound from being purely soft.
 *
 * The music bus is ducked under this voice by the audio system — see
 * `event-map.ts`. That ducking is part of the sound design, not mixing
 * hygiene: the silence around the impact is what sells the scale.
 */

import type { AudioCategory } from '@/types';
import { clamp01, lerp } from '@/util';
import { asr, percussive, resetParam, sweep } from '../dsp';
import { createNoiseSource } from '../noise';
import { SynthVoice, type ITriggerParams } from '../voice';

interface ShockShape {
  /** Resonant lowpass sweep. */
  readonly lpFrom: number;
  readonly lpTo: number;
  readonly lpSweep: number;
  readonly lpQ: number;
  readonly lpDecay: number;
  readonly lpGain: number;
  /** Sub drop. */
  readonly subFrom: number;
  readonly subTo: number;
  readonly subSweep: number;
  readonly subDecay: number;
  readonly subGain: number;
  /** Air rumble. */
  readonly airCutoff: number;
  readonly airAttack: number;
  readonly airDecay: number;
  readonly airGain: number;
  /** Crack transient. */
  readonly crackHz: number;
  readonly crackDecay: number;
  readonly crackGain: number;
  /** Metallic resonance. */
  readonly ringHz: number;
  readonly ringQ: number;
  readonly ringDecay: number;
  readonly ringGain: number;
}

const SHAPES: Record<string, ShockShape> = {
  /** The reference serious punch. */
  serious: {
    lpFrom: 3500,
    lpTo: 55,
    lpSweep: 1.3,
    lpQ: 9,
    lpDecay: 2.2,
    lpGain: 0.5,
    subFrom: 90,
    subTo: 20,
    subSweep: 1.1,
    subDecay: 2.6,
    subGain: 0.62,
    airCutoff: 210,
    airAttack: 0.12,
    airDecay: 1.9,
    airGain: 0.34,
    crackHz: 4200,
    crackDecay: 0.05,
    crackGain: 0.3,
    ringHz: 1200,
    ringQ: 14,
    ringDecay: 0.25,
    ringGain: 0.16,
  },
  /**
   * Serious Series: Serious Punch — Table Flip. Everything longer, lower and
   * wider. Reserved for the moments the game wants to feel apocalyptic.
   */
  tableflip: {
    lpFrom: 5200,
    lpTo: 38,
    lpSweep: 2.2,
    lpQ: 11,
    lpDecay: 4,
    lpGain: 0.52,
    subFrom: 110,
    subTo: 16,
    subSweep: 2,
    subDecay: 4.2,
    subGain: 0.66,
    airCutoff: 160,
    airAttack: 0.25,
    airDecay: 3.4,
    airGain: 0.4,
    crackHz: 5200,
    crackDecay: 0.09,
    crackGain: 0.32,
    ringHz: 900,
    ringQ: 18,
    ringDecay: 0.5,
    ringGain: 0.18,
  },
  /** A smaller blast: the wake of a heavy (not serious) strike. */
  blast: {
    lpFrom: 2600,
    lpTo: 90,
    lpSweep: 0.6,
    lpQ: 6,
    lpDecay: 0.9,
    lpGain: 0.44,
    subFrom: 80,
    subTo: 32,
    subSweep: 0.45,
    subDecay: 1.05,
    subGain: 0.5,
    airCutoff: 280,
    airAttack: 0.05,
    airDecay: 0.75,
    airGain: 0.26,
    crackHz: 3400,
    crackDecay: 0.03,
    crackGain: 0.26,
    ringHz: 1500,
    ringQ: 10,
    ringDecay: 0.15,
    ringGain: 0.14,
  },
};

/** Every shockwave variant, for the harness and tests. */
export const SHOCKWAVE_VARIANTS = Object.keys(SHAPES);

export class ShockwaveVoice extends SynthVoice {
  private readonly trim: GainNode;

  private readonly sweepNoise: AudioBufferSourceNode;
  private readonly lp: BiquadFilterNode;
  private readonly lpGain: GainNode;

  private readonly sub: OscillatorNode;
  private readonly subOctave: OscillatorNode;
  private readonly subGain: GainNode;
  private readonly subOctaveGain: GainNode;

  private readonly airNoise: AudioBufferSourceNode;
  private readonly airLp: BiquadFilterNode;
  private readonly airGain: GainNode;

  private readonly crackHp: BiquadFilterNode;
  private readonly crackGain: GainNode;

  private readonly ringBp: BiquadFilterNode;
  private readonly ringGain: GainNode;

  constructor(
    ctx: BaseAudioContext,
    destination: AudioNode,
    key = 'shockwave.serious',
    category: AudioCategory = 'sfx',
    noiseOffset = 0
  ) {
    super(ctx, key, category, destination);

    this.trim = ctx.createGain();
    this.trim.gain.value = 0.72;
    this.trim.connect(this.output);

    // --- Sweep core -----------------------------------------------------
    // Pink rather than white: a -3 dB/octave source through a descending
    // lowpass keeps low-mid weight through the whole sweep instead of
    // thinning out as the cutoff drops.
    this.sweepNoise = createNoiseSource(ctx, 'pink', noiseOffset, 4);
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 3500;
    this.lp.Q.value = 9;
    this.lpGain = ctx.createGain();
    this.lpGain.gain.value = 0;
    this.sweepNoise.connect(this.lp).connect(this.lpGain).connect(this.trim);

    // Crack and ring tap the same noise source — one generator, three uses.
    this.crackHp = ctx.createBiquadFilter();
    this.crackHp.type = 'highpass';
    this.crackHp.frequency.value = 4200;
    this.crackHp.Q.value = 0.6;
    this.crackGain = ctx.createGain();
    this.crackGain.gain.value = 0;
    this.sweepNoise.connect(this.crackHp).connect(this.crackGain).connect(this.trim);

    this.ringBp = ctx.createBiquadFilter();
    this.ringBp.type = 'bandpass';
    this.ringBp.frequency.value = 1200;
    this.ringBp.Q.value = 14;
    this.ringGain = ctx.createGain();
    this.ringGain.gain.value = 0;
    this.sweepNoise.connect(this.ringBp).connect(this.ringGain).connect(this.trim);

    // --- Sub drop -------------------------------------------------------
    this.sub = ctx.createOscillator();
    this.sub.type = 'sine';
    this.sub.frequency.value = 90;
    this.subGain = ctx.createGain();
    this.subGain.gain.value = 0;
    this.sub.connect(this.subGain).connect(this.trim);
    this.sub.start();

    this.subOctave = ctx.createOscillator();
    this.subOctave.type = 'sine';
    this.subOctave.frequency.value = 180;
    this.subOctaveGain = ctx.createGain();
    this.subOctaveGain.gain.value = 0;
    this.subOctave.connect(this.subOctaveGain).connect(this.trim);
    this.subOctave.start();

    // --- Air rumble -----------------------------------------------------
    this.airNoise = createNoiseSource(ctx, 'brown', (noiseOffset + 0.37) % 1, 4);
    this.airLp = ctx.createBiquadFilter();
    this.airLp.type = 'lowpass';
    this.airLp.frequency.value = 300;
    this.airLp.Q.value = 0.9;
    this.airGain = ctx.createGain();
    this.airGain.gain.value = 0;
    this.airNoise.connect(this.airLp).connect(this.airGain).connect(this.trim);

    this.tune(this.sub, this.subOctave);
  }

  protected override schedule(p: ITriggerParams): number {
    const shape = SHAPES[p.variant ?? 'serious'] ?? SHAPES.serious!;
    const t = p.time;
    const nq = this.nyquist;
    const power = clamp01(p.intensity);
    const rate = p.rate;
    // Intensity stretches the whole event in time as well as level. A weak
    // shockwave is not a quiet shockwave, it is a SHORTER one.
    const stretch = lerp(0.55, 1.15, power);

    // 1. Crack.
    resetParam(this.crackHp.frequency, t, Math.min(shape.crackHz * rate, nq * 0.45));
    const crackEnd = percussive(
      this.crackGain.gain,
      t,
      shape.crackGain * lerp(0.5, 1, power),
      0.0008,
      shape.crackDecay
    );

    // 2. Resonant lowpass sweep — the core gesture.
    sweep(
      this.lp.frequency,
      t,
      shape.lpFrom * rate,
      shape.lpTo * rate,
      shape.lpSweep * stretch,
      nq
    );
    resetParam(this.lp.Q, t, shape.lpQ);
    // Sustain briefly at full so the top of the sweep has body, then a long
    // exponential release that outlives the sweep itself.
    const sweepEnd = asr(
      this.lpGain.gain,
      t,
      shape.lpGain * lerp(0.65, 1, power),
      0.006,
      0.06 * stretch,
      shape.lpDecay * stretch
    );

    // 3. Sub drop, plus its octave for small speakers.
    sweep(this.sub.frequency, t, shape.subFrom * rate, shape.subTo * rate, shape.subSweep * stretch, nq);
    sweep(
      this.subOctave.frequency,
      t,
      shape.subFrom * 2 * rate,
      shape.subTo * 2 * rate,
      shape.subSweep * stretch,
      nq
    );
    const subEnd = percussive(
      this.subGain.gain,
      t,
      shape.subGain * lerp(0.6, 1, power),
      0.004,
      shape.subDecay * stretch
    );
    percussive(
      this.subOctaveGain.gain,
      t,
      shape.subGain * 0.28 * lerp(0.6, 1, power),
      0.004,
      shape.subDecay * 0.7 * stretch
    );

    // 4. Air rumble — swells in behind the impact.
    resetParam(this.airLp.frequency, t, Math.min(shape.airCutoff * rate, nq * 0.45));
    const airEnd = asr(
      this.airGain.gain,
      t,
      shape.airGain * lerp(0.5, 1, power),
      shape.airAttack * stretch,
      0.05,
      shape.airDecay * stretch
    );

    // 5. Metallic resonance.
    resetParam(this.ringBp.frequency, t, Math.min(shape.ringHz * rate, nq * 0.45));
    resetParam(this.ringBp.Q, t, shape.ringQ);
    const ringEnd = percussive(this.ringGain.gain, t, shape.ringGain, 0.002, shape.ringDecay);

    return Math.max(crackEnd, sweepEnd, subEnd, airEnd, ringEnd) - t;
  }

  protected override teardown(): void {
    SynthVoice.stopSource(this.sub);
    SynthVoice.stopSource(this.subOctave);
    SynthVoice.stopSource(this.sweepNoise);
    SynthVoice.stopSource(this.airNoise);
    this.trim.disconnect();
    this.lp.disconnect();
    this.lpGain.disconnect();
    this.subGain.disconnect();
    this.subOctaveGain.disconnect();
    this.airLp.disconnect();
    this.airGain.disconnect();
    this.crackHp.disconnect();
    this.crackGain.disconnect();
    this.ringBp.disconnect();
    this.ringGain.disconnect();
  }
}
