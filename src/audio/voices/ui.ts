/**
 * UI AND STINGERS
 *
 * Interface sound has one job: confirm, instantly and without demanding
 * attention. That means short, quiet, band-limited and — critically —
 * consistent. Every sound here is built from the same three ingredients so
 * they read as one family:
 *
 *  • NOTES  — a small polyphonic bank of filtered oscillators. Pitch material
 *    is drawn from one tuning so nothing ever clashes with the music.
 *  • TICK   — a highpassed noise transient. Gives a note a physical onset;
 *    without it a UI beep sounds like a test tone.
 *  • SHIMMER— a pair of detuned saws through a sweeping bandpass. Reserved for
 *    the moments that deserve weight: promotion, victory.
 *
 * The stingers (`rankUp`, `victory`, `dark`) are the exception to "don't
 * demand attention" — they are narrative punctuation, and they duck the music
 * rather than fight it.
 */

import type { AudioCategory } from '@/types';
import { clamp01, lerp } from '@/util';
import { asr, midiToFreq, percussive, resetParam, sweep } from '../dsp';
import { createNoiseSource } from '../noise';
import { SynthVoice, type ITriggerParams } from '../voice';

/** Polyphony. Six covers the densest stinger without ever stealing. */
const NOTE_UNITS = 6;

/** One playable note. */
class NoteUnit {
  readonly osc: OscillatorNode;
  readonly filter: BiquadFilterNode;
  readonly gain: GainNode;
  freeAt = -1;

  constructor(ctx: BaseAudioContext, destination: AudioNode) {
    this.osc = ctx.createOscillator();
    this.osc.type = 'triangle';
    this.osc.frequency.value = 440;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 6000;
    this.filter.Q.value = 0.8;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.osc.connect(this.filter).connect(this.gain).connect(destination);
    this.osc.start();
  }

  play(
    t: number,
    hz: number,
    gain: number,
    attack: number,
    hold: number,
    release: number,
    type: OscillatorType,
    cutoff: number,
    nyquist: number
  ): number {
    // The oscillator type is a scheduled-free property, so it changes
    // immediately. Changing it during a previous note's tail is inaudible
    // because the tail is already below -40 dB by the time a unit is reused.
    this.osc.type = type;
    resetParam(this.osc.frequency, t, Math.min(hz, nyquist * 0.45));
    resetParam(this.filter.frequency, t, Math.min(cutoff, nyquist * 0.45));
    this.freeAt = asr(this.gain.gain, t, gain, attack, hold, release);
    return this.freeAt;
  }

  /** A note that bends: used by `deny` and the dark stinger. */
  bend(t: number, fromHz: number, toHz: number, seconds: number, nyquist: number): void {
    sweep(this.osc.frequency, t, fromHz, toHz, seconds, nyquist);
  }

  dispose(): void {
    SynthVoice.stopSource(this.osc);
    this.filter.disconnect();
    this.gain.disconnect();
  }
}

/** A step in a UI motif: MIDI note, offset in seconds, and shaping. */
interface MotifStep {
  readonly midi: number;
  readonly at: number;
  readonly gain: number;
  readonly attack: number;
  readonly hold: number;
  readonly release: number;
  readonly type: OscillatorType;
  readonly cutoff: number;
  /** Optional pitch bend, as a ratio applied over the note's length. */
  readonly bendTo?: number;
}

interface UiShape {
  readonly steps: readonly MotifStep[];
  readonly tickGain: number;
  readonly tickHz: number;
  readonly tickDecay: number;
  readonly shimmerGain: number;
  readonly shimmerFrom: number;
  readonly shimmerTo: number;
  readonly shimmerLength: number;
  readonly noiseSwellGain: number;
  readonly noiseSwellHz: number;
  readonly noiseSwellLength: number;
}

const soft = (
  midi: number,
  at: number,
  gain: number,
  hold: number,
  release: number,
  type: OscillatorType = 'triangle',
  cutoff = 6000
): MotifStep => ({ midi, at, gain, attack: 0.004, hold, release, type, cutoff });

const SHAPES: Record<string, UiShape> = {
  /** Every button. As small as a sound can be and still register. */
  tap: {
    steps: [soft(86, 0, 0.16, 0.005, 0.03)],
    tickGain: 0.1,
    tickHz: 5200,
    tickDecay: 0.008,
    shimmerGain: 0,
    shimmerFrom: 0,
    shimmerTo: 0,
    shimmerLength: 0,
    noiseSwellGain: 0,
    noiseSwellHz: 0,
    noiseSwellLength: 0,
  },
  /** Accepted. A rising perfect fifth — the most unambiguous "yes" interval. */
  confirm: {
    steps: [soft(76, 0, 0.16, 0.02, 0.07), soft(83, 0.06, 0.18, 0.03, 0.14)],
    tickGain: 0.07,
    tickHz: 4200,
    tickDecay: 0.008,
    shimmerGain: 0,
    shimmerFrom: 0,
    shimmerTo: 0,
    shimmerLength: 0,
    noiseSwellGain: 0,
    noiseSwellHz: 0,
    noiseSwellLength: 0,
  },
  /** Rejected. A falling minor third with a bend and some grit. */
  deny: {
    steps: [
      { midi: 64, at: 0, gain: 0.18, attack: 0.004, hold: 0.05, release: 0.1, type: 'square', cutoff: 1800 },
      {
        midi: 59,
        at: 0.09,
        gain: 0.16,
        attack: 0.004,
        hold: 0.06,
        release: 0.22,
        type: 'square',
        cutoff: 1400,
        bendTo: 0.94,
      },
    ],
    tickGain: 0.05,
    tickHz: 2600,
    tickDecay: 0.01,
    shimmerGain: 0,
    shimmerFrom: 0,
    shimmerTo: 0,
    shimmerLength: 0,
    noiseSwellGain: 0,
    noiseSwellHz: 0,
    noiseSwellLength: 0,
  },
  /**
   * Threat detected. Two pulses of a falling major second, repeated. Square
   * waves and a repeated figure are how "attention" is encoded almost
   * universally in interface sound.
   */
  alert: {
    steps: [
      { midi: 81, at: 0, gain: 0.15, attack: 0.003, hold: 0.06, release: 0.05, type: 'square', cutoff: 3000 },
      { midi: 76, at: 0.13, gain: 0.15, attack: 0.003, hold: 0.06, release: 0.05, type: 'square', cutoff: 2600 },
      { midi: 81, at: 0.3, gain: 0.15, attack: 0.003, hold: 0.06, release: 0.05, type: 'square', cutoff: 3000 },
      { midi: 76, at: 0.43, gain: 0.16, attack: 0.003, hold: 0.08, release: 0.16, type: 'square', cutoff: 2600 },
    ],
    tickGain: 0.05,
    tickHz: 3800,
    tickDecay: 0.006,
    shimmerGain: 0,
    shimmerFrom: 0,
    shimmerTo: 0,
    shimmerLength: 0,
    noiseSwellGain: 0,
    noiseSwellHz: 0,
    noiseSwellLength: 0,
  },
  /** Promotion. An ascending major arpeggio over a rising shimmer. */
  rankUp: {
    steps: [
      soft(72, 0, 0.14, 0.04, 0.16),
      soft(76, 0.1, 0.15, 0.04, 0.18),
      soft(79, 0.2, 0.16, 0.05, 0.22),
      soft(84, 0.32, 0.2, 0.22, 0.7),
      soft(88, 0.34, 0.09, 0.2, 0.7, 'sine', 9000),
    ],
    tickGain: 0.05,
    tickHz: 5000,
    tickDecay: 0.01,
    shimmerGain: 0.09,
    shimmerFrom: 500,
    shimmerTo: 6000,
    shimmerLength: 0.9,
    noiseSwellGain: 0.05,
    noiseSwellHz: 3000,
    noiseSwellLength: 1,
  },
  /** Encounter won. Shorter and warmer than a promotion. */
  victory: {
    steps: [
      soft(69, 0, 0.15, 0.05, 0.16),
      soft(73, 0.11, 0.15, 0.05, 0.18),
      soft(76, 0.22, 0.17, 0.3, 0.6),
      soft(81, 0.24, 0.1, 0.3, 0.6, 'sine', 8000),
    ],
    tickGain: 0.04,
    tickHz: 4400,
    tickDecay: 0.01,
    shimmerGain: 0.06,
    shimmerFrom: 700,
    shimmerTo: 4200,
    shimmerLength: 0.7,
    noiseSwellGain: 0.04,
    noiseSwellHz: 2400,
    noiseSwellLength: 0.8,
  },
  /**
   * Something went wrong: a civilian died, an ally fell. Two tones a semitone
   * apart, beating against each other, sinking. Deliberately uncomfortable.
   */
  dark: {
    steps: [
      {
        midi: 45,
        at: 0,
        gain: 0.2,
        attack: 0.05,
        hold: 0.5,
        release: 1.4,
        type: 'sawtooth',
        cutoff: 600,
        bendTo: 0.94,
      },
      {
        midi: 46,
        at: 0.02,
        gain: 0.15,
        attack: 0.08,
        hold: 0.5,
        release: 1.4,
        type: 'sawtooth',
        cutoff: 500,
        bendTo: 0.96,
      },
      soft(57, 0.15, 0.07, 0.4, 1.1, 'sine', 1200),
    ],
    tickGain: 0,
    tickHz: 2000,
    tickDecay: 0.01,
    shimmerGain: 0,
    shimmerFrom: 0,
    shimmerTo: 0,
    shimmerLength: 0,
    noiseSwellGain: 0.07,
    noiseSwellHz: 400,
    noiseSwellLength: 1.8,
  },
};

/** Every UI sound key, for the harness, the event map and the tests. */
export const UI_VARIANTS = Object.keys(SHAPES);

export class UiVoice extends SynthVoice {
  private readonly trim: GainNode;
  private readonly notes: NoteUnit[] = [];
  private readonly noise: AudioBufferSourceNode;
  private readonly tickHp: BiquadFilterNode;
  private readonly tickGain: GainNode;
  private readonly swellBp: BiquadFilterNode;
  private readonly swellGain: GainNode;
  private readonly shimmerA: OscillatorNode;
  private readonly shimmerB: OscillatorNode;
  private readonly shimmerBp: BiquadFilterNode;
  private readonly shimmerGain: GainNode;

  constructor(
    ctx: BaseAudioContext,
    destination: AudioNode,
    key = 'ui.tap',
    category: AudioCategory = 'ui',
    noiseOffset = 0
  ) {
    super(ctx, key, category, destination);
    this.trim = ctx.createGain();
    this.trim.gain.value = 0.9;
    this.trim.connect(this.output);

    for (let i = 0; i < NOTE_UNITS; i++) {
      const note = new NoteUnit(ctx, this.trim);
      this.notes.push(note);
      this.tune(note.osc);
    }

    this.noise = createNoiseSource(ctx, 'white', noiseOffset, 2);
    this.tickHp = ctx.createBiquadFilter();
    this.tickHp.type = 'highpass';
    this.tickHp.frequency.value = 5000;
    this.tickGain = ctx.createGain();
    this.tickGain.gain.value = 0;
    this.noise.connect(this.tickHp).connect(this.tickGain).connect(this.trim);

    this.swellBp = ctx.createBiquadFilter();
    this.swellBp.type = 'bandpass';
    this.swellBp.frequency.value = 2400;
    this.swellBp.Q.value = 0.8;
    this.swellGain = ctx.createGain();
    this.swellGain.gain.value = 0;
    this.noise.connect(this.swellBp).connect(this.swellGain).connect(this.trim);

    this.shimmerA = ctx.createOscillator();
    this.shimmerA.type = 'sawtooth';
    this.shimmerA.frequency.value = 440;
    this.shimmerB = ctx.createOscillator();
    this.shimmerB.type = 'sawtooth';
    this.shimmerB.frequency.value = 443;
    this.shimmerBp = ctx.createBiquadFilter();
    this.shimmerBp.type = 'bandpass';
    this.shimmerBp.frequency.value = 1200;
    this.shimmerBp.Q.value = 3;
    this.shimmerGain = ctx.createGain();
    this.shimmerGain.gain.value = 0;
    this.shimmerA.connect(this.shimmerBp);
    this.shimmerB.connect(this.shimmerBp);
    this.shimmerBp.connect(this.shimmerGain).connect(this.trim);
    this.shimmerA.start();
    this.shimmerB.start();

    this.tune(this.shimmerA, this.shimmerB);
  }

  protected override schedule(p: ITriggerParams): number {
    const s = SHAPES[p.variant ?? 'tap'] ?? SHAPES.tap!;
    const t = p.time;
    const nq = this.nyquist;
    const level = lerp(0.6, 1, clamp01(p.intensity));
    let end = t;

    for (let i = 0; i < s.steps.length; i++) {
      const step = s.steps[i]!;
      const unit = this.notes[i % NOTE_UNITS]!;
      const at = t + step.at;
      const hz = midiToFreq(step.midi) * p.rate;
      const noteEnd = unit.play(
        at,
        hz,
        step.gain * level,
        step.attack,
        step.hold,
        step.release,
        step.type,
        step.cutoff,
        nq
      );
      if (step.bendTo !== undefined) {
        unit.bend(at, hz, hz * step.bendTo, step.hold + step.release, nq);
      }
      end = Math.max(end, noteEnd);
    }

    if (s.tickGain > 0) {
      resetParam(this.tickHp.frequency, t, Math.min(s.tickHz, nq * 0.45));
      end = Math.max(end, percussive(this.tickGain.gain, t, s.tickGain * level, 0.0004, s.tickDecay));
    } else {
      resetParam(this.tickGain.gain, t, 0);
    }

    if (s.noiseSwellGain > 0) {
      resetParam(this.swellBp.frequency, t, Math.min(s.noiseSwellHz, nq * 0.45));
      end = Math.max(
        end,
        asr(
          this.swellGain.gain,
          t,
          s.noiseSwellGain * level,
          s.noiseSwellLength * 0.3,
          s.noiseSwellLength * 0.2,
          s.noiseSwellLength * 0.6
        )
      );
    } else {
      resetParam(this.swellGain.gain, t, 0);
    }

    if (s.shimmerGain > 0) {
      // The detune between the pair is what makes the shimmer move; a single
      // saw through a sweeping filter just sounds like a filter sweep.
      resetParam(this.shimmerA.frequency, t, 220 * p.rate);
      resetParam(this.shimmerB.frequency, t, 220 * p.rate * 1.008);
      sweep(this.shimmerBp.frequency, t, s.shimmerFrom, s.shimmerTo, s.shimmerLength, nq);
      end = Math.max(
        end,
        asr(
          this.shimmerGain.gain,
          t,
          s.shimmerGain * level,
          s.shimmerLength * 0.35,
          s.shimmerLength * 0.15,
          s.shimmerLength * 0.7
        )
      );
    } else {
      resetParam(this.shimmerGain.gain, t, 0);
    }

    return end - t;
  }

  protected override teardown(): void {
    for (const n of this.notes) n.dispose();
    this.notes.length = 0;
    SynthVoice.stopSource(this.noise);
    SynthVoice.stopSource(this.shimmerA);
    SynthVoice.stopSource(this.shimmerB);
    this.trim.disconnect();
    this.tickHp.disconnect();
    this.tickGain.disconnect();
    this.swellBp.disconnect();
    this.swellGain.disconnect();
    this.shimmerBp.disconnect();
    this.shimmerGain.disconnect();
  }
}
