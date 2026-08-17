/**
 * CROWD
 *
 * City ambience with people in it. Two pieces:
 *
 *  • THE BED — a continuous three-band murmur whose density is driven by the
 *    number of civilians actually near the player. This is a real gameplay
 *    signal, not decoration: the game's central tension is that fighting at
 *    full force near people is catastrophic, so the player needs to HEAR that
 *    a street is populated before they commit to a punch.
 *  • THE BLIPS — sparse, formant-shaped vocal fragments scheduled on top. A
 *    filtered-noise bed alone reads as air conditioning; it is the
 *    intermittent, pitched, human-shaped events that make it read as a crowd.
 *
 * Blips are scheduled with a LOOKAHEAD from `update()` rather than triggered
 * per frame, so their timing is exact and independent of frame rate. Onsets
 * come from the same exponential-interval scheduler the debris uses, for the
 * same reason: evenly spaced voices sound like a machine, not a street.
 */

import type { AudioCategory } from '@/types';
import { clamp01, createRng, lerp, type IRandom } from '@/util';
import { asr, poissonOnsets, resetParam, sweep } from '../dsp';
import { createNoiseSource } from '../noise';
import { SustainedVoice, SynthVoice, type ITriggerParams } from '../voice';

/** Concurrent vocal blips. */
const BLIP_UNITS = 6;

/**
 * One vocal fragment: a sawtooth through two formant bandpasses. Two formants
 * is enough to read as a vowel, which is enough to read as a person.
 */
class BlipUnit {
  readonly osc: OscillatorNode;
  private readonly f1: BiquadFilterNode;
  private readonly f2: BiquadFilterNode;
  private readonly g1: GainNode;
  private readonly g2: GainNode;
  readonly envelope: GainNode;
  readonly pan: StereoPannerNode;
  freeAt = -1;

  constructor(ctx: BaseAudioContext, destination: AudioNode) {
    this.pan = ctx.createStereoPanner();
    this.pan.connect(destination);
    this.envelope = ctx.createGain();
    this.envelope.gain.value = 0;
    this.envelope.connect(this.pan);

    this.osc = ctx.createOscillator();
    this.osc.type = 'sawtooth';
    this.osc.frequency.value = 220;
    this.osc.start();

    this.f1 = ctx.createBiquadFilter();
    this.f1.type = 'bandpass';
    this.f1.frequency.value = 700;
    this.f1.Q.value = 6;
    this.g1 = ctx.createGain();
    this.g1.gain.value = 1;

    this.f2 = ctx.createBiquadFilter();
    this.f2.type = 'bandpass';
    this.f2.frequency.value = 1600;
    this.f2.Q.value = 9;
    this.g2 = ctx.createGain();
    this.g2.gain.value = 0.5;

    this.osc.connect(this.f1).connect(this.g1).connect(this.envelope);
    this.osc.connect(this.f2).connect(this.g2).connect(this.envelope);
  }

  /**
   * Schedule one fragment. Returns the time it falls silent.
   * `bend` slides the pitch across the fragment, which is what makes it read
   * as speech rather than as a note.
   */
  say(
    t: number,
    hz: number,
    bend: number,
    formant1: number,
    formant2: number,
    gain: number,
    length: number,
    pan: number,
    nyquist: number
  ): number {
    sweep(this.osc.frequency, t, hz, hz * bend, length, nyquist);
    resetParam(this.f1.frequency, t, Math.min(formant1, nyquist * 0.45));
    resetParam(this.f2.frequency, t, Math.min(formant2, nyquist * 0.45));
    resetParam(this.pan.pan, t, pan);
    // Soft attack and release: a hard-edged vocal fragment sounds like a synth
    // stab, not a voice.
    this.freeAt = asr(this.envelope.gain, t, gain, length * 0.25, length * 0.35, length * 0.6);
    return this.freeAt;
  }

  dispose(): void {
    SynthVoice.stopSource(this.osc);
    this.f1.disconnect();
    this.f2.disconnect();
    this.g1.disconnect();
    this.g2.disconnect();
    this.envelope.disconnect();
    this.pan.disconnect();
  }
}

/** Vowel formant pairs. Enough variety that no two blips are the same person. */
const VOWELS: readonly (readonly [number, number])[] = [
  [730, 1090], // "ah"
  [530, 1840], // "eh"
  [270, 2290], // "ee"
  [570, 840], // "aw"
  [300, 870], // "oo"
  [660, 1720], // "a"
];

/* -------------------------------------------------------------------------- */
/* The bed                                                                    */
/* -------------------------------------------------------------------------- */

/** Continuous crowd murmur whose density tracks nearby civilian count. */
export class CrowdBedVoice extends SustainedVoice {
  private readonly trim: GainNode;
  private readonly murmurNoise: AudioBufferSourceNode;
  private readonly murmurNoiseRight: AudioBufferSourceNode;
  private readonly murmurBp: BiquadFilterNode;
  private readonly murmurBpRight: BiquadFilterNode;
  private readonly murmurGain: GainNode;
  private readonly murmurPanLeft: StereoPannerNode;
  private readonly murmurPanRight: StereoPannerNode;
  private readonly chatterBp: BiquadFilterNode;
  private readonly chatterGain: GainNode;
  private readonly trafficNoise: AudioBufferSourceNode;
  private readonly trafficLp: BiquadFilterNode;
  private readonly trafficGain: GainNode;
  private readonly blips: BlipUnit[] = [];
  private readonly rng: IRandom;

  /** 0..1 density, driven by nearby civilian count. */
  private density = 0.3;
  /** Lookahead cursor: blips are scheduled up to here. */
  private scheduledTo = 0;

  constructor(
    ctx: BaseAudioContext,
    destination: AudioNode,
    key = 'ambience.crowd',
    category: AudioCategory = 'ambience',
    noiseOffset = 0,
    seed = 0xc0ffee
  ) {
    super(ctx, key, category, destination);
    this.rng = createRng(seed);
    this.trim = ctx.createGain();
    this.trim.gain.value = 0.85;
    this.trim.connect(this.output);

    // TWO decorrelated murmur channels, hard-ish panned.
    //
    // One mono noise band read as a crowd inside the listener's head rather
    // than a street around them. Two independent noise streams through
    // slightly different bandpasses have no correlation, which is exactly what
    // a real diffuse field is, and it costs three nodes.
    this.murmurNoise = createNoiseSource(ctx, 'pink', noiseOffset, 4);
    this.murmurNoiseRight = createNoiseSource(ctx, 'pink', (noiseOffset + 0.63) % 1, 4);
    this.murmurGain = ctx.createGain();
    this.murmurGain.gain.value = 0;
    this.murmurGain.connect(this.trim);

    this.murmurPanLeft = ctx.createStereoPanner();
    this.murmurPanLeft.pan.value = -0.75;
    this.murmurPanRight = ctx.createStereoPanner();
    this.murmurPanRight.pan.value = 0.75;
    this.murmurPanLeft.connect(this.murmurGain);
    this.murmurPanRight.connect(this.murmurGain);

    this.murmurBp = ctx.createBiquadFilter();
    this.murmurBp.type = 'bandpass';
    this.murmurBp.frequency.value = 480;
    this.murmurBp.Q.value = 0.8;
    this.murmurBpRight = ctx.createBiquadFilter();
    this.murmurBpRight.type = 'bandpass';
    this.murmurBpRight.frequency.value = 540;
    this.murmurBpRight.Q.value = 0.8;
    this.murmurNoise.connect(this.murmurBp).connect(this.murmurPanLeft);
    this.murmurNoiseRight.connect(this.murmurBpRight).connect(this.murmurPanRight);

    this.chatterBp = ctx.createBiquadFilter();
    this.chatterBp.type = 'bandpass';
    this.chatterBp.frequency.value = 1800;
    this.chatterBp.Q.value = 1.2;
    this.chatterGain = ctx.createGain();
    this.chatterGain.gain.value = 0;
    this.murmurNoise.connect(this.chatterBp).connect(this.chatterGain).connect(this.trim);

    this.trafficNoise = createNoiseSource(ctx, 'brown', (noiseOffset + 0.27) % 1, 4);
    this.trafficLp = ctx.createBiquadFilter();
    this.trafficLp.type = 'lowpass';
    this.trafficLp.frequency.value = 180;
    this.trafficGain = ctx.createGain();
    this.trafficGain.gain.value = 0;
    this.trafficNoise.connect(this.trafficLp).connect(this.trafficGain).connect(this.trim);

    for (let i = 0; i < BLIP_UNITS; i++) {
      const blip = new BlipUnit(ctx, this.trim);
      this.blips.push(blip);
      this.tune(blip.osc);
    }
  }

  /** Map a nearby-civilian count onto the 0..1 density knob. */
  static densityForCount(count: number): number {
    // Logarithmic: the difference between 0 and 5 people is far more audible
    // than the difference between 60 and 65.
    return clamp01(Math.log10(1 + Math.max(count, 0)) / Math.log10(81));
  }

  override setIntensity(intensity: number, time: number, glideSeconds = 1.2): void {
    this.density = clamp01(intensity);
    const g = Math.max(glideSeconds, 0.05);
    const ramp = (param: AudioParam, value: number): void => {
      param.cancelScheduledValues(time);
      param.setValueAtTime(param.value, time);
      param.linearRampToValueAtTime(value, time + g);
    };
    ramp(this.murmurGain.gain, lerp(0.02, 0.3, this.density));
    ramp(this.chatterGain.gain, lerp(0.005, 0.12, this.density * this.density));
    // Traffic is a property of the city, not of the crowd, so it barely moves.
    ramp(this.trafficGain.gain, lerp(0.1, 0.2, this.density));
    if (this.scheduledTo < time) this.scheduledTo = time;
  }

  /**
   * Fill the blip schedule up to `horizon`. Called from the audio system's
   * per-frame update with a lookahead of a couple of hundred milliseconds.
   *
   * @returns how many blips were scheduled.
   */
  scheduleBlips(horizon: number): number {
    if (!this.isRunning) {
      this.scheduledTo = Math.max(this.scheduledTo, horizon);
      return 0;
    }
    if (horizon <= this.scheduledTo) return 0;
    const from = this.scheduledTo;
    const span = horizon - from;
    // 0.4 blips/second in an empty street, 7/second in a packed one.
    const rate = lerp(0.4, 7, this.density * this.density);
    const expected = rate * span;
    const onsets = poissonOnsets(Math.max(1, Math.round(expected * 2)), span, () =>
      this.rng.next()
    );
    let scheduled = 0;
    for (const offset of onsets) {
      if (scheduled >= Math.ceil(expected) + 1) break;
      const t = from + offset;
      const unit = this.blips.find((b) => b.freeAt <= t);
      if (!unit) continue;
      const vowel = VOWELS[this.rng.int(0, VOWELS.length - 1)]!;
      // Adults and children: two octaves of fundamental spread.
      const hz = lerp(110, 340, this.rng.next());
      const bend = lerp(0.82, 1.22, this.rng.next());
      const length = lerp(0.11, 0.3, this.rng.next());
      const gain = lerp(0.02, 0.1, this.rng.next()) * lerp(0.4, 1.2, this.density);
      unit.say(
        t,
        hz,
        bend,
        vowel[0] * lerp(0.9, 1.15, this.rng.next()),
        vowel[1] * lerp(0.9, 1.15, this.rng.next()),
        gain,
        length,
        (this.rng.next() * 2 - 1) * 0.9,
        this.nyquist
      );
      scheduled++;
    }
    this.scheduledTo = horizon;
    return scheduled;
  }

  protected override teardown(): void {
    SynthVoice.stopSource(this.murmurNoise);
    SynthVoice.stopSource(this.murmurNoiseRight);
    SynthVoice.stopSource(this.trafficNoise);
    for (const b of this.blips) b.dispose();
    this.blips.length = 0;
    this.trim.disconnect();
    this.murmurBp.disconnect();
    this.murmurBpRight.disconnect();
    this.murmurPanLeft.disconnect();
    this.murmurPanRight.disconnect();
    this.murmurGain.disconnect();
    this.chatterBp.disconnect();
    this.chatterGain.disconnect();
    this.trafficLp.disconnect();
    this.trafficGain.disconnect();
  }
}

/* -------------------------------------------------------------------------- */
/* Reactions                                                                  */
/* -------------------------------------------------------------------------- */

interface ReactionShape {
  readonly count: number;
  readonly spread: number;
  readonly hzLo: number;
  readonly hzHi: number;
  readonly bendLo: number;
  readonly bendHi: number;
  readonly lengthLo: number;
  readonly lengthHi: number;
  readonly gain: number;
  /** Broadband swell riding under the voices. */
  readonly swellGain: number;
  readonly swellHz: number;
  readonly swellAttack: number;
  readonly swellRelease: number;
}

const REACTIONS: Record<string, ReactionShape> = {
  /** Relief and applause when the player saves someone. Rising, bright. */
  cheer: {
    count: 14,
    spread: 0.9,
    hzLo: 200,
    hzHi: 520,
    bendLo: 1.05,
    bendHi: 1.45,
    lengthLo: 0.2,
    lengthHi: 0.5,
    gain: 0.22,
    swellGain: 0.2,
    swellHz: 1400,
    swellAttack: 0.25,
    swellRelease: 0.9,
  },
  /** A collective intake of breath. Short, falling, unsettled. */
  gasp: {
    count: 8,
    spread: 0.35,
    hzLo: 180,
    hzHi: 420,
    bendLo: 0.7,
    bendHi: 0.95,
    lengthLo: 0.12,
    lengthHi: 0.28,
    gain: 0.24,
    swellGain: 0.18,
    swellHz: 2600,
    swellAttack: 0.05,
    swellRelease: 0.35,
  },
  /** Screaming and scattering. The sound of a fight going wrong. */
  panic: {
    count: 18,
    spread: 1.4,
    hzLo: 260,
    hzHi: 780,
    bendLo: 1.1,
    bendHi: 1.8,
    lengthLo: 0.25,
    lengthHi: 0.7,
    gain: 0.24,
    swellGain: 0.18,
    swellHz: 1800,
    swellAttack: 0.15,
    swellRelease: 1.3,
  },
};

/** Every crowd reaction, for the harness, the event map and the tests. */
export const CROWD_REACTIONS = Object.keys(REACTIONS);

/** A one-shot collective reaction: cheer, gasp or panic. */
export class CrowdReactionVoice extends SynthVoice {
  private readonly trim: GainNode;
  private readonly blips: BlipUnit[] = [];
  private readonly swellNoise: AudioBufferSourceNode;
  private readonly swellBp: BiquadFilterNode;
  private readonly swellGain: GainNode;

  constructor(
    ctx: BaseAudioContext,
    destination: AudioNode,
    key = 'crowd.cheer',
    category: AudioCategory = 'ambience',
    noiseOffset = 0
  ) {
    super(ctx, key, category, destination);
    this.trim = ctx.createGain();
    this.trim.gain.value = 0.85;
    this.trim.connect(this.output);

    // More units than the bed: a reaction is many people at once.
    for (let i = 0; i < 10; i++) {
      const blip = new BlipUnit(ctx, this.trim);
      this.blips.push(blip);
      this.tune(blip.osc);
    }

    this.swellNoise = createNoiseSource(ctx, 'pink', noiseOffset, 3);
    this.swellBp = ctx.createBiquadFilter();
    this.swellBp.type = 'bandpass';
    this.swellBp.frequency.value = 1400;
    this.swellBp.Q.value = 0.7;
    this.swellGain = ctx.createGain();
    this.swellGain.gain.value = 0;
    this.swellNoise.connect(this.swellBp).connect(this.swellGain).connect(this.trim);
  }

  protected override schedule(p: ITriggerParams): number {
    const s = REACTIONS[p.variant ?? 'cheer'] ?? REACTIONS.cheer!;
    const t = p.time;
    const nq = this.nyquist;
    const power = clamp01(p.intensity);
    const rng = p.rng;
    const count = Math.max(2, Math.round(s.count * lerp(0.45, 1.2, power)));
    const onsets = poissonOnsets(count, s.spread, () => rng.next(), 0.01);

    let end = t;
    for (const offset of onsets) {
      const at = t + offset;
      const unit = this.blips.find((b) => b.freeAt <= at) ?? this.blips[0]!;
      const vowel = VOWELS[rng.int(0, VOWELS.length - 1)]!;
      const hz = lerp(s.hzLo, s.hzHi, rng.next()) * p.rate;
      const bend = lerp(s.bendLo, s.bendHi, rng.next());
      const length = lerp(s.lengthLo, s.lengthHi, rng.next());
      const gain = s.gain * lerp(0.5, 1, rng.next()) * lerp(0.6, 1.15, power);
      end = Math.max(
        end,
        unit.say(at, hz, bend, vowel[0]!, vowel[1]!, gain, length, (rng.next() * 2 - 1) * 0.9, nq)
      );
    }

    resetParam(this.swellBp.frequency, t, Math.min(s.swellHz, nq * 0.45));
    const swellEnd = asr(
      this.swellGain.gain,
      t,
      s.swellGain * lerp(0.5, 1, power),
      s.swellAttack,
      s.spread * 0.4,
      s.swellRelease
    );

    return Math.max(end, swellEnd) - t;
  }

  protected override teardown(): void {
    for (const b of this.blips) b.dispose();
    this.blips.length = 0;
    SynthVoice.stopSource(this.swellNoise);
    this.trim.disconnect();
    this.swellBp.disconnect();
    this.swellGain.disconnect();
  }
}
