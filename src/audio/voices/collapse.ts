/**
 * BUILDING COLLAPSE
 *
 * The longest and lowest voice in the game. A tower coming down is not an
 * impact — it is an EVENT with a shape: a groan as the structure fails, a
 * swelling rumble as mass accelerates, a shower of crackling material, and a
 * final settling thud once it is over.
 *
 *  1. GROAN   — ring-modulated low sines. Two oscillators multiplied together
 *               produce sum-and-difference tones with no fundamental, which is
 *               exactly the inharmonic, straining quality of a steel frame
 *               yielding. It leads the collapse by a beat.
 *  2. RUMBLE  — brown noise (-6 dB/oct, almost all energy under 200 Hz)
 *               through a lowpass whose cutoff is itself modulated by a slow
 *               LFO, so the rumble breathes instead of sitting still. Slow
 *               attack, very long decay.
 *  3. CRACKLE — a grain cloud in the 800 Hz - 7 kHz range whose density falls
 *               away over the collapse. This is the concrete and glass.
 *  4. SETTLE  — one last sub thud as the pile stops moving.
 *
 * The rumble is deliberately the loudest element and the crackle the busiest:
 * on a phone speaker, which reproduces almost nothing below 150 Hz, the
 * crackle is what carries the event, while on headphones the rumble is what
 * makes it enormous. Both have to work.
 */

import type { AudioCategory } from '@/types';
import { clamp01, lerp } from '@/util';
import { asr, percussive, poissonOnsets, resetParam, sweep } from '../dsp';
import { createNoiseSource } from '../noise';
import { SynthVoice, type ITriggerParams } from '../voice';

/** Concurrent crackle grains. */
const CRACKLE_UNITS = 10;

interface CollapseShape {
  readonly rumbleCutoff: number;
  readonly rumbleAttack: number;
  readonly rumbleSustain: number;
  readonly rumbleDecay: number;
  readonly rumbleGain: number;
  readonly groanHz: number;
  readonly groanModHz: number;
  readonly groanGain: number;
  readonly crackleCount: number;
  readonly crackleSpread: number;
  readonly settleHz: number;
}

const SHAPES: Record<string, CollapseShape> = {
  /** A mid-rise office block. The reference collapse. */
  building: {
    rumbleCutoff: 130,
    rumbleAttack: 0.35,
    rumbleSustain: 0.9,
    rumbleDecay: 3.2,
    rumbleGain: 0.5,
    groanHz: 58,
    groanModHz: 6.5,
    groanGain: 0.2,
    crackleCount: 105,
    crackleSpread: 3.2,
    settleHz: 70,
  },
  /** A tower. Longer, lower, more material. */
  tower: {
    rumbleCutoff: 100,
    rumbleAttack: 0.6,
    rumbleSustain: 1.6,
    rumbleDecay: 5,
    rumbleGain: 0.55,
    groanHz: 42,
    groanModHz: 4.5,
    groanGain: 0.24,
    crackleCount: 165,
    crackleSpread: 5,
    settleHz: 54,
  },
  /** A wall or facade shedding. Short, dominated by material.  */
  facade: {
    rumbleCutoff: 180,
    rumbleAttack: 0.12,
    rumbleSustain: 0.25,
    rumbleDecay: 1.4,
    rumbleGain: 0.36,
    groanHz: 80,
    groanModHz: 11,
    groanGain: 0.12,
    crackleCount: 70,
    crackleSpread: 1.5,
    settleHz: 90,
  },
};

/** Every collapse variant, for the harness and tests. */
export const COLLAPSE_VARIANTS = Object.keys(SHAPES);

/** One crackle grain. */
class CrackleUnit {
  readonly bp: BiquadFilterNode;
  readonly gain: GainNode;
  readonly pan: StereoPannerNode;
  freeAt = -1;

  constructor(ctx: BaseAudioContext, noise: AudioBufferSourceNode, destination: AudioNode) {
    this.pan = ctx.createStereoPanner();
    this.pan.connect(destination);
    this.bp = ctx.createBiquadFilter();
    this.bp.type = 'bandpass';
    this.bp.frequency.value = 2000;
    this.bp.Q.value = 6;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    noise.connect(this.bp).connect(this.gain).connect(this.pan);
  }

  dispose(): void {
    this.bp.disconnect();
    this.gain.disconnect();
    this.pan.disconnect();
  }
}

export class CollapseVoice extends SynthVoice {
  private readonly trim: GainNode;

  private readonly rumbleNoise: AudioBufferSourceNode;
  private readonly rumbleHp: BiquadFilterNode;
  private readonly rumbleLp: BiquadFilterNode;
  private readonly rumbleGain: GainNode;
  private readonly rumbleLfo: OscillatorNode;
  private readonly rumbleLfoGain: GainNode;

  private readonly groanCarrier: OscillatorNode;
  private readonly groanModulator: OscillatorNode;
  private readonly groanRing: GainNode;
  private readonly groanGain: GainNode;

  private readonly crackleNoise: AudioBufferSourceNode;
  private readonly crackles: CrackleUnit[] = [];

  private readonly settle: OscillatorNode;
  private readonly settleGain: GainNode;

  constructor(
    ctx: BaseAudioContext,
    destination: AudioNode,
    key = 'collapse.building',
    category: AudioCategory = 'sfx',
    noiseOffset = 0
  ) {
    super(ctx, key, category, destination);
    this.trim = ctx.createGain();
    this.trim.gain.value = 0.75;
    this.trim.connect(this.output);

    // --- Rumble ---------------------------------------------------------
    this.rumbleNoise = createNoiseSource(ctx, 'brown', noiseOffset, 4);
    // Brown noise keeps rising at -6 dB/octave below hearing. A tower collapse
    // was putting a ninth of its total power under 10 Hz, where it is
    // inaudible on every device but still consumes headroom and makes a phone
    // speaker distort. Strip it at the source.
    this.rumbleHp = ctx.createBiquadFilter();
    this.rumbleHp.type = 'highpass';
    this.rumbleHp.frequency.value = 26;
    this.rumbleHp.Q.value = 0.7;
    this.rumbleLp = ctx.createBiquadFilter();
    this.rumbleLp.type = 'lowpass';
    this.rumbleLp.frequency.value = 130;
    this.rumbleLp.Q.value = 1.2;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    this.rumbleNoise
      .connect(this.rumbleHp)
      .connect(this.rumbleLp)
      .connect(this.rumbleGain)
      .connect(this.trim);

    // LFO on the cutoff so the rumble breathes. Audio-rate parameter
    // modulation, free-running like everything else.
    this.rumbleLfo = ctx.createOscillator();
    this.rumbleLfo.type = 'sine';
    this.rumbleLfo.frequency.value = 1.7;
    this.rumbleLfoGain = ctx.createGain();
    this.rumbleLfoGain.gain.value = 45;
    this.rumbleLfo.connect(this.rumbleLfoGain).connect(this.rumbleLp.frequency);
    this.rumbleLfo.start();

    // --- Groan (ring modulation) ----------------------------------------
    // `groanRing.gain` starts at 0 and is driven by the modulator, so the
    // node computes carrier * modulator: true ring modulation, which produces
    // sum/difference sidebands with the original tones suppressed.
    this.groanCarrier = ctx.createOscillator();
    this.groanCarrier.type = 'sine';
    this.groanCarrier.frequency.value = 58;
    this.groanModulator = ctx.createOscillator();
    this.groanModulator.type = 'sine';
    this.groanModulator.frequency.value = 6.5;
    this.groanRing = ctx.createGain();
    this.groanRing.gain.value = 0;
    this.groanGain = ctx.createGain();
    this.groanGain.gain.value = 0;
    this.groanCarrier.connect(this.groanRing);
    this.groanModulator.connect(this.groanRing.gain);
    this.groanRing.connect(this.groanGain).connect(this.trim);
    this.groanCarrier.start();
    this.groanModulator.start();

    // --- Crackle --------------------------------------------------------
    this.crackleNoise = createNoiseSource(ctx, 'white', (noiseOffset + 0.5) % 1, 3);
    for (let i = 0; i < CRACKLE_UNITS; i++) {
      this.crackles.push(new CrackleUnit(ctx, this.crackleNoise, this.trim));
    }

    // --- Settle ---------------------------------------------------------
    this.settle = ctx.createOscillator();
    this.settle.type = 'sine';
    this.settle.frequency.value = 70;
    this.settleGain = ctx.createGain();
    this.settleGain.gain.value = 0;
    this.settle.connect(this.settleGain).connect(this.trim);
    this.settle.start();

    this.tune(this.groanCarrier, this.groanModulator, this.settle);
  }

  protected override schedule(p: ITriggerParams): number {
    const shape = SHAPES[p.variant ?? 'building'] ?? SHAPES.building!;
    const t = p.time;
    const nq = this.nyquist;
    const power = clamp01(p.intensity);
    const scale = lerp(0.6, 1.15, power);
    const rng = p.rng;

    // Groan leads by 150 ms — the structure complains before it falls.
    const groanStart = Math.max(t - 0, 0);
    sweep(
      this.groanCarrier.frequency,
      groanStart,
      shape.groanHz * 1.35 * p.rate,
      shape.groanHz * 0.7 * p.rate,
      1.2 * scale,
      nq
    );
    sweep(
      this.groanModulator.frequency,
      groanStart,
      shape.groanModHz * p.rate,
      shape.groanModHz * 2.4 * p.rate,
      1.2 * scale,
      nq
    );
    const groanEnd = asr(
      this.groanGain.gain,
      groanStart,
      shape.groanGain * lerp(0.5, 1, power),
      0.15,
      0.5 * scale,
      1.1 * scale
    );

    // Rumble.
    resetParam(this.rumbleLp.frequency, t, shape.rumbleCutoff * p.rate);
    const rumbleEnd = asr(
      this.rumbleGain.gain,
      t,
      shape.rumbleGain * lerp(0.55, 1, power),
      shape.rumbleAttack * scale,
      shape.rumbleSustain * scale,
      shape.rumbleDecay * scale
    );

    // Crackle: density decays across the collapse, so the shower thins out.
    const count = Math.round(shape.crackleCount * lerp(0.5, 1.2, power));
    const spread = shape.crackleSpread * scale;
    const onsets = poissonOnsets(count, spread, () => rng.next(), 0.005);
    let crackleEnd = t;
    let cursor = 0;
    for (const offset of onsets) {
      const gt = t + offset;
      let unit = this.crackles[cursor % CRACKLE_UNITS]!;
      for (let probe = 0; probe < CRACKLE_UNITS; probe++) {
        const candidate = this.crackles[(cursor + probe) % CRACKLE_UNITS]!;
        if (candidate.freeAt <= gt) {
          unit = candidate;
          cursor = cursor + probe + 1;
          break;
        }
        if (probe === CRACKLE_UNITS - 1) cursor++;
      }
      const centre = 800 * Math.pow(9, rng.next()) * p.rate;
      const decay = lerp(0.01, 0.09, rng.next() * rng.next());
      // Thinning: later grains are quieter and rarer-sounding.
      const fade = Math.pow(1 - offset / Math.max(spread, 1e-3), 1.3);
      // The crackle is what carries a collapse on a phone speaker, which
      // reproduces almost nothing below 150 Hz. It has to hold its own against
      // the rumble rather than sit politely under it.
      const gain = 1.15 * lerp(0.4, 1, rng.next()) * lerp(0.35, 1, fade);
      resetParam(unit.bp.frequency, gt, Math.min(centre, nq * 0.45));
      // Lower Q than the debris grains: a narrow band passes almost no energy,
      // and the crackle has to be heard THROUGH the rumble, not under it.
      resetParam(unit.bp.Q, gt, lerp(1.4, 5.5, rng.next()));
      resetParam(unit.pan.pan, gt, (rng.next() * 2 - 1) * 0.85);
      unit.freeAt = percussive(unit.gain.gain, gt, gain, 0.001, decay);
      crackleEnd = Math.max(crackleEnd, unit.freeAt);
    }

    // Settle: one final thud as the pile stops.
    const settleAt = t + spread * 0.85;
    sweep(this.settle.frequency, settleAt, shape.settleHz * p.rate, shape.settleHz * 0.55 * p.rate, 0.3, nq);
    const settleEnd = percussive(this.settleGain.gain, settleAt, 0.5 * lerp(0.5, 1, power), 0.01, 0.6);

    return Math.max(groanEnd, rumbleEnd, crackleEnd, settleEnd) - t;
  }

  protected override teardown(): void {
    SynthVoice.stopSource(this.rumbleNoise);
    SynthVoice.stopSource(this.rumbleLfo);
    SynthVoice.stopSource(this.groanCarrier);
    SynthVoice.stopSource(this.groanModulator);
    SynthVoice.stopSource(this.crackleNoise);
    SynthVoice.stopSource(this.settle);
    for (const c of this.crackles) c.dispose();
    this.crackles.length = 0;
    this.trim.disconnect();
    this.rumbleHp.disconnect();
    this.rumbleLp.disconnect();
    this.rumbleGain.disconnect();
    this.rumbleLfoGain.disconnect();
    this.groanRing.disconnect();
    this.groanGain.disconnect();
    this.settleGain.disconnect();
  }
}
