/**
 * MONSTER VOCALISATIONS
 *
 * A parametric throat. One graph produces every creature in the game, from a
 * wolf-tier thug to a god-tier calamity, by moving five knobs: fundamental,
 * formant set, FM index, growl rate and length.
 *
 * ── THE SYNTHESIS MODEL ────────────────────────────────────────────────────
 * Real animal vocalisation is a source-filter system: a buzzing source (vocal
 * folds) shaped by resonances (the vocal tract). That is exactly what this
 * builds, plus two devices that push it away from "synthesiser" and towards
 * "creature":
 *
 *  • SOURCE — a sawtooth, frequency-modulated by a second oscillator at a
 *    NON-INTEGER ratio. Integer ratios give musical, harmonic results; 1.47
 *    and 2.76 give the inharmonic, unsettling clangour that makes something
 *    sound wrong to be alive.
 *  • FORMANTS — three parallel bandpass filters. Their absolute frequencies
 *    are what the ear reads as body size: a formant set an octave lower is
 *    heard as an animal twice as large, regardless of pitch. This is the
 *    single most important parameter for threat tier.
 *  • GROWL — amplitude modulation at 20-45 Hz. Below ~50 Hz the ear stops
 *    hearing modulation as tremolo and starts hearing it as ROUGHNESS. This
 *    is where the growl actually comes from.
 *  • RASP — a bandpassed noise layer riding the same envelope: breath.
 *  • DRIVE — an asymmetric waveshaper adding even harmonics, which is what
 *    stops the result sounding like a filtered sawtooth.
 *
 * Threat tier moves all of it together: `god` is 45 Hz with 320 Hz formants
 * over two and a half seconds; `wolf` is 260 Hz with 700 Hz formants over
 * half a second. The render tests assert that the tiers are spectrally
 * ordered — lower tier, higher energy centre.
 */

import type { AudioCategory, ThreatTier } from '@/types';
import { clamp01, lerp } from '@/util';
import { asr, growlCurve, resetParam, sweep, sweep3 } from '../dsp';
import { createNoiseSource } from '../noise';
import { SynthVoice, type ITriggerParams } from '../voice';

/** What the creature is doing. Selects the pitch contour and length. */
export type MonsterUtterance = 'roar' | 'screech' | 'hurt' | 'death';

/** Per-threat-tier body. */
interface TierBody {
  /** Fundamental in Hz. */
  readonly f0: number;
  /** Formant centres in Hz — the ear reads these as physical size. */
  readonly formants: readonly [number, number, number];
  /** FM depth as a multiple of the carrier frequency. */
  readonly modIndex: number;
  /** FM ratio. Deliberately non-integer. */
  readonly modRatio: number;
  /** Amplitude-modulation rate producing the growl roughness. */
  readonly growlHz: number;
  /** Length multiplier. */
  readonly length: number;
  /** Sub-octave layer level — only the largest creatures get one. */
  readonly subGain: number;
  readonly drive: number;
}

const TIERS: Record<ThreatTier, TierBody> = {
  wolf: {
    f0: 260,
    formants: [720, 1550, 2700],
    modIndex: 0.6,
    modRatio: 1.47,
    growlHz: 42,
    length: 0.55,
    subGain: 0,
    drive: 0.35,
  },
  tiger: {
    f0: 175,
    formants: [600, 1300, 2400],
    modIndex: 0.9,
    modRatio: 1.61,
    growlHz: 36,
    length: 0.75,
    subGain: 0.08,
    drive: 0.45,
  },
  demon: {
    f0: 108,
    formants: [500, 1100, 2100],
    modIndex: 1.35,
    modRatio: 1.83,
    growlHz: 29,
    length: 1.05,
    subGain: 0.18,
    drive: 0.58,
  },
  dragon: {
    f0: 68,
    formants: [400, 900, 1800],
    modIndex: 2.1,
    modRatio: 2.11,
    growlHz: 24,
    length: 1.5,
    subGain: 0.3,
    drive: 0.68,
  },
  god: {
    f0: 44,
    formants: [320, 760, 1500],
    modIndex: 3,
    modRatio: 2.76,
    growlHz: 19,
    length: 2.3,
    subGain: 0.42,
    drive: 0.78,
  },
};

/** Every threat tier, in ascending danger. */
export const THREAT_TIERS: readonly ThreatTier[] = ['wolf', 'tiger', 'demon', 'dragon', 'god'];

/** Pitch contour and envelope per utterance. */
interface UtteranceShape {
  /** Pitch multipliers at start / middle / end of the contour. */
  readonly contour: readonly [number, number, number];
  readonly attack: number;
  readonly sustain: number;
  readonly release: number;
  readonly raspGain: number;
  readonly gain: number;
  /** Extra FM on top of the tier's index — screeches are more inharmonic. */
  readonly modScale: number;
  readonly formantScale: number;
}

const UTTERANCES: Record<MonsterUtterance, UtteranceShape> = {
  /** A declaration. Rises into the throat, holds, falls away. */
  roar: {
    contour: [0.72, 1.12, 0.86],
    attack: 0.09,
    sustain: 0.35,
    release: 0.55,
    raspGain: 0.16,
    gain: 0.66,
    modScale: 1,
    formantScale: 1,
  },
  /** A shriek: fast, high, painfully inharmonic. */
  screech: {
    contour: [1.6, 2.9, 2.2],
    attack: 0.02,
    sustain: 0.18,
    release: 0.3,
    raspGain: 0.26,
    gain: 0.5,
    modScale: 1.8,
    formantScale: 1.45,
  },
  /** Took a hit and survived: short, clipped, falling. */
  hurt: {
    contour: [1.25, 0.95, 0.6],
    attack: 0.012,
    sustain: 0.05,
    release: 0.22,
    raspGain: 0.22,
    gain: 0.5,
    modScale: 1.2,
    formantScale: 1.1,
  },
  /** The end: pitch collapses, the growl rate slows, the throat rattles out. */
  death: {
    contour: [1.05, 0.7, 0.22],
    attack: 0.03,
    sustain: 0.3,
    release: 1.1,
    raspGain: 0.3,
    gain: 0.58,
    modScale: 0.8,
    formantScale: 0.85,
  },
};

/** Every utterance kind. */
export const MONSTER_UTTERANCES: readonly MonsterUtterance[] = [
  'roar',
  'screech',
  'hurt',
  'death',
];

/** Coerce an arbitrary string to a threat tier, defaulting to the mid tier. */
export function resolveTier(name: string | undefined): ThreatTier {
  if (name && (THREAT_TIERS as readonly string[]).includes(name)) return name as ThreatTier;
  return 'demon';
}

export class MonsterVoice extends SynthVoice {
  readonly utterance: MonsterUtterance;

  private readonly trim: GainNode;
  private readonly carrier: OscillatorNode;
  private readonly modulator: OscillatorNode;
  private readonly modDepth: GainNode;
  private readonly sub: OscillatorNode;
  private readonly subGain: GainNode;

  private readonly formant: BiquadFilterNode[] = [];
  private readonly formantGain: GainNode[] = [];
  private readonly throat: BiquadFilterNode;

  private readonly growlLfo: OscillatorNode;
  private readonly growlDepth: GainNode;
  private readonly am: GainNode;

  private readonly shaper: WaveShaperNode;
  private readonly envelope: GainNode;

  private readonly raspNoise: AudioBufferSourceNode;
  private readonly raspFilter: BiquadFilterNode;
  private readonly raspGain: GainNode;

  constructor(
    ctx: BaseAudioContext,
    destination: AudioNode,
    utterance: MonsterUtterance,
    key = `monster.${utterance}`,
    category: AudioCategory = 'voice',
    noiseOffset = 0
  ) {
    super(ctx, key, category, destination);
    this.utterance = utterance;

    this.trim = ctx.createGain();
    this.trim.gain.value = 0.8;
    this.trim.connect(this.output);

    // --- Source: FM sawtooth --------------------------------------------
    this.carrier = ctx.createOscillator();
    this.carrier.type = 'sawtooth';
    this.carrier.frequency.value = 110;
    this.modulator = ctx.createOscillator();
    this.modulator.type = 'sine';
    this.modulator.frequency.value = 200;
    this.modDepth = ctx.createGain();
    this.modDepth.gain.value = 0;
    this.modulator.connect(this.modDepth).connect(this.carrier.frequency);
    this.carrier.start();
    this.modulator.start();

    this.sub = ctx.createOscillator();
    this.sub.type = 'sine';
    this.sub.frequency.value = 55;
    this.subGain = ctx.createGain();
    this.subGain.gain.value = 0;
    this.sub.start();

    // --- Formant bank ---------------------------------------------------
    this.throat = ctx.createBiquadFilter();
    this.throat.type = 'lowpass';
    this.throat.frequency.value = 4000;
    this.throat.Q.value = 0.7;
    this.carrier.connect(this.throat);

    const formantQ = [7, 9, 11];
    const formantLevel = [1, 0.65, 0.35];
    for (let i = 0; i < 3; i++) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 500;
      bp.Q.value = formantQ[i]!;
      const g = ctx.createGain();
      g.gain.value = formantLevel[i]!;
      this.throat.connect(bp).connect(g);
      this.formant.push(bp);
      this.formantGain.push(g);
    }

    // --- Growl (sub-audio-rate amplitude modulation) --------------------
    this.am = ctx.createGain();
    this.am.gain.value = 0.68;
    this.growlLfo = ctx.createOscillator();
    this.growlLfo.type = 'sine';
    this.growlLfo.frequency.value = 30;
    this.growlDepth = ctx.createGain();
    this.growlDepth.gain.value = 0.32;
    this.growlLfo.connect(this.growlDepth).connect(this.am.gain);
    this.growlLfo.start();

    for (const g of this.formantGain) g.connect(this.am);
    this.subGain.connect(this.am);
    this.sub.connect(this.subGain);

    // --- Drive + envelope ------------------------------------------------
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = growlCurve(4096, 0.6);
    this.shaper.oversample = '2x';
    this.envelope = ctx.createGain();
    this.envelope.gain.value = 0;
    this.am.connect(this.shaper).connect(this.envelope).connect(this.trim);

    // --- Rasp ------------------------------------------------------------
    this.raspNoise = createNoiseSource(ctx, 'pink', noiseOffset, 3);
    this.raspFilter = ctx.createBiquadFilter();
    this.raspFilter.type = 'bandpass';
    this.raspFilter.frequency.value = 1600;
    this.raspFilter.Q.value = 1.1;
    this.raspGain = ctx.createGain();
    this.raspGain.gain.value = 0;
    this.raspNoise.connect(this.raspFilter).connect(this.raspGain).connect(this.envelope);

    // Carrier and modulator together, so a rate change preserves the FM ratio.
    this.tune(this.carrier, this.modulator, this.sub);
  }

  protected override schedule(p: ITriggerParams): number {
    const tier = TIERS[resolveTier(p.variant)];
    const shape = UTTERANCES[this.utterance];
    const t = p.time;
    const nq = this.nyquist;
    const power = clamp01(p.intensity);
    const rng = p.rng;

    // Per-instance variation so two monsters of the same tier are not clones.
    const detune = lerp(0.9, 1.12, rng.next());
    const f0 = tier.f0 * detune * p.rate;
    const length = tier.length * lerp(0.85, 1.15, rng.next()) * lerp(0.75, 1.15, power);

    const attack = shape.attack * length;
    const sustain = shape.sustain * length;
    const release = shape.release * length;
    const total = attack + sustain + release;

    // Pitch contour across the utterance.
    sweep3(
      this.carrier.frequency,
      t,
      f0 * shape.contour[0],
      f0 * shape.contour[1],
      f0 * shape.contour[2],
      total * 0.32,
      total * 0.68,
      nq
    );
    // The modulator tracks the contour so the timbre stays coherent as the
    // pitch moves, rather than the FM ratio drifting.
    sweep3(
      this.modulator.frequency,
      t,
      f0 * tier.modRatio * shape.contour[0],
      f0 * tier.modRatio * shape.contour[1],
      f0 * tier.modRatio * shape.contour[2],
      total * 0.32,
      total * 0.68,
      nq
    );
    // FM depth swells with the envelope: the creature strains hardest in the
    // middle of the sound.
    const modAmount = f0 * tier.modIndex * shape.modScale * lerp(0.55, 1.25, power);
    asr(this.modDepth.gain, t, modAmount, attack, sustain, release * 0.6);

    // Sub layer for the big tiers.
    sweep(this.sub.frequency, t, f0 * 0.5, f0 * 0.5 * shape.contour[2], total, nq);
    if (tier.subGain > 0) {
      asr(this.subGain.gain, t, tier.subGain * lerp(0.6, 1, power), attack, sustain, release);
    } else {
      resetParam(this.subGain.gain, t, 0);
    }

    // Formants: fixed absolute frequencies (they encode body size), nudged by
    // the utterance and by per-instance variation.
    for (let i = 0; i < this.formant.length; i++) {
      const centre = tier.formants[i]! * shape.formantScale * lerp(0.94, 1.06, rng.next());
      resetParam(this.formant[i]!.frequency, t, Math.min(centre, nq * 0.45));
    }
    resetParam(this.throat.frequency, t, Math.min(tier.formants[2]! * 2.4, nq * 0.45));

    // Growl roughness: slows down over the utterance, and slows a lot on death.
    const growlEnd = this.utterance === 'death' ? tier.growlHz * 0.35 : tier.growlHz * 0.8;
    sweep(this.growlLfo.frequency, t, tier.growlHz * lerp(0.9, 1.1, rng.next()), growlEnd, total, nq);
    resetParam(this.growlDepth.gain, t, lerp(0.18, 0.4, power));

    // Rasp.
    sweep(
      this.raspFilter.frequency,
      t,
      Math.min(tier.formants[1]! * 1.4, nq * 0.45),
      Math.min(tier.formants[0]! * 1.2, nq * 0.45),
      total,
      nq
    );
    asr(this.raspGain.gain, t, shape.raspGain * lerp(0.6, 1.1, power), attack * 0.6, sustain, release);

    // Main envelope.
    const end = asr(
      this.envelope.gain,
      t,
      shape.gain * lerp(0.6, 1, power),
      attack,
      sustain,
      release
    );
    return end - t;
  }

  protected override teardown(): void {
    SynthVoice.stopSource(this.carrier);
    SynthVoice.stopSource(this.modulator);
    SynthVoice.stopSource(this.sub);
    SynthVoice.stopSource(this.growlLfo);
    SynthVoice.stopSource(this.raspNoise);
    this.trim.disconnect();
    this.modDepth.disconnect();
    this.subGain.disconnect();
    this.throat.disconnect();
    for (const f of this.formant) f.disconnect();
    for (const g of this.formantGain) g.disconnect();
    this.growlDepth.disconnect();
    this.am.disconnect();
    this.shaper.disconnect();
    this.envelope.disconnect();
    this.raspFilter.disconnect();
    this.raspGain.disconnect();
  }
}
