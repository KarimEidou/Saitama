/**
 * CONSECUTIVE NORMAL PUNCHES
 *
 * A barrage, not a sound effect. One trigger schedules a whole chain of hits,
 * because the chain is the gesture: individual punches fired from gameplay
 * code at 12 Hz would drift with the frame rate and never lock together.
 * Scheduling the whole burst onto the audio timeline in one go makes the
 * rhythm exact regardless of what the renderer is doing.
 *
 * Two things make a chain read as a chain rather than as repetition:
 *
 *  1. PITCH RISES per hit (~0.8 semitone). This is the standard trick for
 *     conveying acceleration and mounting force, and it is what stops the
 *     twelfth punch sounding identical to the first. The render tests verify
 *     it by measuring each hit's dominant sub frequency and asserting the
 *     sequence rises.
 *  2. The LAST hit is a finisher: louder, longer, pitched slightly down
 *     against the rise. The chain resolves instead of just stopping.
 *
 * Hits are round-robined across four internal hit units so that overlapping
 * tails never interrupt one another — at 45 ms spacing with a 90 ms decay,
 * three hits are sounding at once.
 */

import type { AudioCategory } from '@/types';
import { clamp, clamp01, lerp } from '@/util';
import { percussive, sweep } from '../dsp';
import { createNoiseSource } from '../noise';
import { SynthVoice, type ITriggerParams } from '../voice';

/** Number of overlapping hit units. Four covers the fastest chain we schedule. */
const HIT_UNITS = 4;

/** One re-usable hit: sub thump, mid body, contact tick. */
class HitUnit {
  readonly sub: OscillatorNode;
  readonly subGain: GainNode;
  readonly tick: OscillatorNode;
  readonly tickGain: GainNode;
  readonly bodyFilter: BiquadFilterNode;
  readonly bodyGain: GainNode;

  constructor(ctx: BaseAudioContext, noise: AudioBufferSourceNode, destination: AudioNode) {
    this.sub = ctx.createOscillator();
    this.sub.type = 'sine';
    this.sub.frequency.value = 130;
    this.subGain = ctx.createGain();
    this.subGain.gain.value = 0;
    this.sub.connect(this.subGain).connect(destination);
    this.sub.start();

    this.tick = ctx.createOscillator();
    this.tick.type = 'triangle';
    this.tick.frequency.value = 3000;
    this.tickGain = ctx.createGain();
    this.tickGain.gain.value = 0;
    this.tick.connect(this.tickGain).connect(destination);
    this.tick.start();

    this.bodyFilter = ctx.createBiquadFilter();
    this.bodyFilter.type = 'bandpass';
    this.bodyFilter.frequency.value = 800;
    this.bodyFilter.Q.value = 1.4;
    this.bodyGain = ctx.createGain();
    this.bodyGain.gain.value = 0;
    noise.connect(this.bodyFilter).connect(this.bodyGain).connect(destination);
  }

  /**
   * Schedule one hit. Returns the time at which it falls silent.
   *
   * ── WHERE THE WEIGHT COMES FROM ──────────────────────────────────────
   * The sub's pitch drop has to LAND while the amplitude envelope is still
   * loud. What matters is not the sweep's duration in the abstract but how
   * early it crosses 100 Hz relative to the decay, because everything after
   * that point is what the ear reads as weight.
   *
   * This was measured wrong twice. Sweeping over a fixed FRACTION of the
   * decay works for a fast chain (short decay, short sweep) and fails badly
   * for a slow one: at 100 ms spacing the flurry's decay is 80 ms, so a
   * 32 % sweep only reached the bottom at -23 dB and the probe measured
   * 0.4 % of its attack power below 100 Hz against 94 % in 100-200 Hz. The
   * hits had no weight at all.
   *
   * So the sweep is now capped at an ABSOLUTE 22 ms — the range a real
   * percussive pitch envelope actually falls in, regardless of how long the
   * tail rings — and the endpoints are per-variant, so a slow chain can
   * start below 100 Hz and be weighty from its first millisecond while a
   * fast chain starts higher and stays legible instead of turning to mud.
   */
  hit(
    t: number,
    pitch: number,
    gain: number,
    decay: number,
    subFrom: number,
    subTo: number,
    nyquist: number
  ): number {
    sweep(this.sub.frequency, t, subFrom * pitch, subTo * pitch, Math.min(decay * 0.32, 0.022), nyquist);
    const subEnd = percussive(this.subGain.gain, t, 0.68 * gain, 0.0012, decay);

    sweep(this.bodyFilter.frequency, t, 1100 * pitch, 260 * pitch, decay * 0.35, nyquist);
    const bodyEnd = percussive(this.bodyGain.gain, t, 0.26 * gain, 0.0015, decay * 0.55);

    sweep(this.tick.frequency, t, 3400 * pitch, 900 * pitch, 0.006, nyquist);
    const tickEnd = percussive(this.tickGain.gain, t, 0.17 * gain, 0.0004, 0.012);

    return Math.max(subEnd, bodyEnd, tickEnd);
  }

  dispose(): void {
    SynthVoice.stopSource(this.sub);
    SynthVoice.stopSource(this.tick);
    this.subGain.disconnect();
    this.tickGain.disconnect();
    this.bodyFilter.disconnect();
    this.bodyGain.disconnect();
  }
}

/** Chain shaping per variant. */
interface ChainShape {
  readonly minHits: number;
  readonly maxHits: number;
  readonly interval: number;
  readonly intervalTighten: number;
  /** Frequency multiplier applied per hit index. */
  readonly pitchStep: number;
  readonly decay: number;
  /**
   * Sub sweep endpoints in Hz. Per-variant because how early the sweep
   * crosses 100 Hz — not its duration — is what decides whether a hit has
   * weight, and that depends on how far apart the hits are.
   */
  readonly subFrom: number;
  readonly subTo: number;
}

const SHAPES: Record<string, ChainShape> = {
  /** Consecutive Normal Punches. */
  consecutive: {
    minHits: 5,
    maxHits: 16,
    interval: 0.075,
    intervalTighten: 0.03,
    pitchStep: 1.045,
    decay: 0.1,
    subFrom: 108,
    subTo: 41,
  },
  /** A short two-to-four hit flurry used for ordinary combos. */
  /**
   * A short two-to-four hit combo. Widely spaced, so its sub starts BELOW
   * 100 Hz and is weighty from the first millisecond — a fast chain can rely
   * on accumulating tails for its low end, a slow one cannot.
   */
  flurry: {
    minHits: 2,
    maxHits: 5,
    interval: 0.11,
    intervalTighten: 0.02,
    pitchStep: 1.06,
    decay: 0.13,
    subFrom: 94,
    subTo: 36,
  },
  /** Machine-gun tier: the fastest the character throws them. */
  barrage: {
    minHits: 12,
    maxHits: 32,
    interval: 0.05,
    intervalTighten: 0.018,
    pitchStep: 1.028,
    decay: 0.075,
    subFrom: 118,
    subTo: 46,
  },
};

/** Every chain variant, for the harness and tests. */
export const CONSECUTIVE_VARIANTS = Object.keys(SHAPES);

/** One scheduled hit in a chain. */
export interface IChainHit {
  /** Offset from the chain's start, in seconds, before humanising jitter. */
  readonly offset: number;
  /** Pitch multiplier applied to this hit's layers. */
  readonly pitch: number;
  readonly gain: number;
  /**
   * Amplitude decay for this hit.
   *
   * CAPPED AGAINST THE CHAIN SPACING. Left uncapped, a 100 ms decay at 57 ms
   * spacing means each hit's sub is re-triggered before the previous one has
   * gone, and the chain accumulates into a continuous low drone that buries
   * the rising pitch entirely — the offline probe measured the chain's
   * low-band centre FALLING across the chain instead of rising. Capping the
   * decay just under the spacing keeps the hits separate, which is what makes
   * the rise audible and the chain read as distinct punches.
   */
  readonly decay: number;
  /** Sub sweep start in Hz, before the per-hit pitch multiplier. */
  readonly subFrom: number;
  /** Sub sweep end in Hz, before the per-hit pitch multiplier. */
  readonly subTo: number;
  readonly isFinisher: boolean;
}

/**
 * The chain's schedule as pure data.
 *
 * Extracted from the voice so the *musical* decisions — how many hits, how
 * fast, how much the pitch rises — can be asserted directly by a unit test
 * with no audio context, and so the render test can slice the rendered audio
 * at exactly the times the voice used rather than guessing them from onset
 * detection.
 */
export function chainSchedule(variant: string, intensity: number, rate = 1): IChainHit[] {
  const shape = SHAPES[variant] ?? SHAPES.consecutive!;
  const power = clamp01(intensity);
  const count = Math.round(lerp(shape.minHits, shape.maxHits, power));
  const interval = shape.interval - shape.intervalTighten * power;
  const hits: IChainHit[] = [];
  // The finisher rings out; every other hit must clear before the next lands.
  const bodyDecay = Math.min(shape.decay, interval * 0.8);
  for (let i = 0; i < count; i++) {
    const isFinisher = i === count - 1;
    const rise = Math.pow(shape.pitchStep, i);
    hits.push({
      offset: i * interval,
      // The finisher lands a little lower and a lot harder — the chain has to
      // resolve, not just stop.
      pitch: clamp(rate * (isFinisher ? rise * 0.82 : rise), 0.25, 4),
      gain: isFinisher ? 1.15 : lerp(0.7, 1, i / Math.max(count - 1, 1)),
      decay: isFinisher ? shape.decay * 2.6 : bodyDecay,
      subFrom: shape.subFrom,
      subTo: shape.subTo,
      isFinisher,
    });
  }
  return hits;
}

/** The nominal spacing between hits for a variant at a given intensity. */
export function chainInterval(variant: string, intensity: number): number {
  const shape = SHAPES[variant] ?? SHAPES.consecutive!;
  return shape.interval - shape.intervalTighten * clamp01(intensity);
}

export class ConsecutiveVoice extends SynthVoice {
  private readonly trim: GainNode;
  private readonly noise: AudioBufferSourceNode;
  private readonly units: HitUnit[] = [];
  /** Hits scheduled by the most recent trigger — asserted on by the tests. */
  private lastHitCount = 0;

  constructor(
    ctx: BaseAudioContext,
    destination: AudioNode,
    key = 'punch.consecutive',
    category: AudioCategory = 'sfx',
    noiseOffset = 0
  ) {
    super(ctx, key, category, destination);
    this.trim = ctx.createGain();
    // Raised from 0.55 once the envelope-anchor bug was fixed: the chain had
    // been carrying a spurious fade-in tone that inflated its level, and with
    // that gone the real hits were quieter than a single punch.
    this.trim.gain.value = 0.9;
    this.trim.connect(this.output);

    this.noise = createNoiseSource(ctx, 'white', noiseOffset);
    for (let i = 0; i < HIT_UNITS; i++) {
      const unit = new HitUnit(ctx, this.noise, this.trim);
      this.units.push(unit);
      this.tune(unit.sub, unit.tick);
    }
  }

  /** Hits scheduled by the most recent trigger. */
  get hitCount(): number {
    return this.lastHitCount;
  }

  protected override schedule(p: ITriggerParams): number {
    const variant = p.variant ?? 'consecutive';
    const hits = chainSchedule(variant, p.intensity, p.rate);
    const interval = chainInterval(variant, p.intensity);
    const nq = this.nyquist;
    this.lastHitCount = hits.length;

    let end = p.time;
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i]!;
      const unit = this.units[i % HIT_UNITS]!;
      // A touch of humanised timing so the chain is not a metronome, but far
      // less than the debris scheduler: a punch chain SHOULD be tight.
      const jitter = (p.rng.next() - 0.5) * interval * 0.12;
      const t = p.time + hit.offset + jitter;
      end = Math.max(end, unit.hit(t, hit.pitch, hit.gain, hit.decay, hit.subFrom, hit.subTo, nq));
    }
    return end - p.time;
  }

  protected override teardown(): void {
    for (const u of this.units) u.dispose();
    this.units.length = 0;
    SynthVoice.stopSource(this.noise);
    this.trim.disconnect();
  }
}
