/**
 * VOICE MODEL — pre-built graphs, zero allocation per trigger.
 *
 * ── THE CENTRAL PERFORMANCE CONSTRAINT ─────────────────────────────────────
 * A building collapse can request a hundred impacts in a single frame. The
 * obvious implementation — build an oscillator + filter + gain graph per
 * impact and let it garbage-collect — allocates dozens of objects per frame,
 * churns the audio thread's node list, and produces exactly the kind of GC
 * hitch that shows up as a dropped frame at 60 fps on a mid-range Android.
 *
 * So no voice in this game ever allocates a node on a trigger.
 *
 * Every voice is a PERSISTENT graph built once, with its signal generators
 * (oscillators, looping noise sources) FREE-RUNNING for the voice's entire
 * lifetime. Triggering a voice writes `AudioParam` automation — an envelope on
 * a gain, a sweep on a filter — onto that existing graph. Web Audio's
 * `OscillatorNode` and `AudioBufferSourceNode` are one-shot by specification
 * (`stop()` is terminal), which is precisely why they must be started once and
 * gated by a VCA rather than started per sound. Between triggers the VCA sits
 * at hard zero, so an idle voice contributes literal silence.
 *
 * ── ROUTING ────────────────────────────────────────────────────────────────
 *   layers -> output (per-trigger VCA) ->  spatialGain -> panner -\
 *                                      \-> dryGain --------------- > bus
 *
 * The 2D/3D choice is a gain write, not a reconnect: `connect`/`disconnect`
 * mutate the audio thread's graph and are far more expensive than setting a
 * value, and this flip happens on every single trigger.
 */

import type { AudioCategory, Vec3 } from '@/types';
import type { IRandom } from '@/util';
import { fadeOut } from './dsp';
import { configurePanner, createSpatialPanner, SPATIAL_DEFAULTS, type ISpatialSettings } from './panner';

/* -------------------------------------------------------------------------- */
/* Trigger parameters                                                         */
/* -------------------------------------------------------------------------- */

/** Everything a voice needs to render one instance of itself. */
export interface ITriggerParams {
  /** Absolute context time to start at. */
  readonly time: number;
  /** Linear gain 0..1 for this instance. */
  readonly gain: number;
  /** Pitch/rate multiplier. 1 is the voice's natural pitch. */
  readonly rate: number;
  /**
   * Generic 0..1 "how hard" knob. Mapped per voice: impact force, monster
   * size, debris count, crowd density. Voices must remain audible at 0 and
   * must not clip at 1.
   */
  readonly intensity: number;
  /** Voice-specific variant selector (material, threat tier, surface, ...). */
  readonly variant?: string;
  /** Deterministic randomness for this instance. */
  readonly rng: IRandom;
  /** World position for 3D playback. Omit for a 2D (UI/music) sound. */
  readonly position?: Vec3;
  /** Distance attenuation override. */
  readonly spatial?: ISpatialSettings;
}

/* -------------------------------------------------------------------------- */
/* Base voice                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Shared graph tail and routing for every synthesised voice.
 *
 * Subclasses build their generators in the constructor and implement
 * `schedule()` to write automation for one instance.
 */
export abstract class SynthVoice {
  readonly key: string;
  readonly category: AudioCategory;
  protected readonly ctx: BaseAudioContext;
  /** Half the sample rate — every frequency ramp is clamped against this. */
  protected readonly nyquist: number;

  /** Per-trigger VCA. Subclass layers must connect here. */
  readonly output: GainNode;
  private readonly spatialGain: GainNode;
  private readonly dryGain: GainNode;
  readonly panner: PannerNode;

  private disposed = false;

  constructor(ctx: BaseAudioContext, key: string, category: AudioCategory, destination: AudioNode) {
    this.ctx = ctx;
    this.key = key;
    this.category = category;
    this.nyquist = ctx.sampleRate * 0.5;

    this.output = ctx.createGain();
    this.output.gain.value = 0;
    this.spatialGain = ctx.createGain();
    this.spatialGain.gain.value = 0;
    this.dryGain = ctx.createGain();
    this.dryGain.gain.value = 1;
    this.panner = createSpatialPanner(ctx);

    this.output.connect(this.spatialGain).connect(this.panner).connect(destination);
    this.output.connect(this.dryGain).connect(destination);
  }

  /**
   * Write the automation for one instance.
   * @returns the instance's duration in seconds, including its tail.
   */
  protected abstract schedule(p: ITriggerParams): number;

  /**
   * Fire the voice. Sets up routing and level, then delegates the sound
   * itself to `schedule`.
   * @returns duration in seconds.
   */
  trigger(p: ITriggerParams): number {
    if (this.disposed) return 0;
    const t = p.time;

    // Routing: 3D when a position is supplied, 2D otherwise.
    if (p.position) {
      configurePanner(this.panner, p.spatial ?? SPATIAL_DEFAULTS);
      this.setPosition(p.position, t);
      this.spatialGain.gain.setValueAtTime(1, t);
      this.dryGain.gain.setValueAtTime(0, t);
    } else {
      this.spatialGain.gain.setValueAtTime(0, t);
      this.dryGain.gain.setValueAtTime(1, t);
    }

    // The per-trigger VCA is a plain multiplier; the shape lives in the layers.
    this.output.gain.cancelScheduledValues(t);
    this.output.gain.setValueAtTime(Math.max(p.gain, 0), t);

    return this.schedule(p);
  }

  /** Move a playing 3D instance (used by `attachTo` follow behaviour). */
  setPosition(position: Vec3, time = this.ctx.currentTime): void {
    if (this.panner.positionX) {
      this.panner.positionX.setValueAtTime(position.x, time);
      this.panner.positionY.setValueAtTime(position.y, time);
      this.panner.positionZ.setValueAtTime(position.z, time);
    } else {
      this.panner.setPosition?.(position.x, position.y, position.z);
    }
  }

  /**
   * Every oscillator whose pitch should follow a live rate change.
   *
   * Subclasses register theirs with `tune()`. Note that `detune` is a
   * SEPARATE additive parameter from `frequency` in the Web Audio spec, so
   * writing it re-pitches the voice without disturbing any frequency sweep
   * already scheduled on the timeline — which is exactly what a live rate
   * change needs, and what a direct frequency write would destroy.
   */
  private readonly tuned: OscillatorNode[] = [];

  /** Register oscillators that should follow `setRate`. */
  protected tune(...oscillators: readonly OscillatorNode[]): void {
    for (const osc of oscillators) this.tuned.push(osc);
  }

  /** Re-pitch a sounding instance. `rate` is a frequency multiplier. */
  setRate(rate: number, time = this.ctx.currentTime): void {
    const cents = 1200 * Math.log2(Math.max(rate, 1e-4));
    for (const osc of this.tuned) {
      osc.detune.cancelScheduledValues(time);
      osc.detune.setValueAtTime(cents, time);
    }
  }

  /** Change the level of a playing instance. */
  setVolume(volume: number, time = this.ctx.currentTime, fadeSeconds = 0): void {
    const g = this.output.gain;
    if (fadeSeconds <= 0) {
      g.cancelScheduledValues(time);
      g.setValueAtTime(Math.max(volume, 0), time);
      return;
    }
    g.cancelScheduledValues(time);
    g.setValueAtTime(g.value, time);
    g.linearRampToValueAtTime(Math.max(volume, 0), time + fadeSeconds);
  }

  /**
   * Cut the voice short — used when the budget steals it, or when a caller
   * stops a handle. A short linear fade rather than a hard mute, because a
   * discontinuity in a loud voice is an audible click.
   */
  stopAt(time: number, fadeSeconds = 0.012): void {
    fadeOut(this.output.gain, time, fadeSeconds);
  }

  /** Release the graph. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardown();
    this.output.disconnect();
    this.spatialGain.disconnect();
    this.dryGain.disconnect();
    this.panner.disconnect();
  }

  /** Subclasses stop their free-running generators here. */
  protected teardown(): void {
    /* default: nothing beyond the shared tail */
  }

  /**
   * Stop a free-running source and forget it. Safe to call twice.
   * Public because the small helper units inside composite voices (grains,
   * hits, blips, notes) own oscillators too and are not subclasses.
   */
  static stopSource(node: AudioScheduledSourceNode | undefined): void {
    if (!node) return;
    try {
      node.stop();
    } catch {
      // Already stopped, or never started — either is fine at teardown.
    }
    node.disconnect();
  }
}

/* -------------------------------------------------------------------------- */
/* Sustained voices                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A voice that runs continuously and is steered by a parameter rather than
 * re-triggered: wind at speed, the crowd bed, the city ambience.
 */
export abstract class SustainedVoice extends SynthVoice {
  protected running = false;

  /** Sustained voices are not "triggered"; `schedule` starts them. */
  protected override schedule(p: ITriggerParams): number {
    this.start(p.time, p.intensity);
    return Number.POSITIVE_INFINITY;
  }

  /** Begin playing, ramping in from silence. */
  start(time: number, intensity = 0.5, fadeSeconds = 0.6): void {
    if (!this.running) {
      this.running = true;
      this.output.gain.cancelScheduledValues(time);
      this.output.gain.setValueAtTime(this.output.gain.value, time);
      this.output.gain.linearRampToValueAtTime(1, time + fadeSeconds);
    }
    this.setIntensity(intensity, time, fadeSeconds);
  }

  /** Fade out and idle. The graph stays built for a cheap restart. */
  stop(time: number, fadeSeconds = 0.6): void {
    if (!this.running) return;
    this.running = false;
    this.output.gain.cancelScheduledValues(time);
    this.output.gain.setValueAtTime(this.output.gain.value, time);
    this.output.gain.linearRampToValueAtTime(0, time + fadeSeconds);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Steer the voice. Implementations must glide, never jump. */
  abstract setIntensity(intensity: number, time: number, glideSeconds?: number): void;
}

/* -------------------------------------------------------------------------- */
/* Voice bank                                                                 */
/* -------------------------------------------------------------------------- */

/** A checked-out voice instance. */
export interface IVoiceLease {
  readonly voice: SynthVoice;
  readonly slot: number;
  /** Incremented on every acquisition; stale handles compare against it. */
  readonly generation: number;
}

/**
 * A fixed pool of identical voices.
 *
 * Fixed rather than growing: a growing pool under a debris burst would
 * allocate exactly when the frame budget is tightest. When every slot is
 * busy the bank STEALS the least valuable one — the oldest of the
 * lowest-priority voices — which is how real game audio engines behave and is
 * what the `IAudioSystem` contract mandates.
 */
export class VoiceBank<T extends SynthVoice> {
  readonly key: string;
  /**
   * Instances are built LAZILY, up to `size`.
   *
   * Every instance holds free-running oscillators for the lifetime of the
   * session, so building all sixteen pools eagerly would cost a few hundred
   * permanently-running nodes on a phone — most of them for sounds a given
   * session never makes (glass debris, tower collapses, god-tier roars).
   * Building on first use bounds that cost to what is actually played, and
   * `preallocate` lets the audio system warm the handful of pools that must
   * never hitch on their first trigger.
   */
  private readonly voices: (T | undefined)[] = [];
  private readonly freeAt: number[] = [];
  private readonly priority: number[] = [];
  private readonly generation: number[] = [];
  private readonly factory: (index: number) => T;
  private nextGeneration = 1;

  constructor(key: string, size: number, factory: (index: number) => T) {
    this.key = key;
    this.factory = factory;
    for (let i = 0; i < size; i++) {
      this.voices.push(undefined);
      this.freeAt.push(-1);
      this.priority.push(0);
      this.generation.push(0);
    }
  }

  get size(): number {
    return this.voices.length;
  }

  /** Instances actually constructed so far. */
  get builtCount(): number {
    let n = 0;
    for (const v of this.voices) if (v) n++;
    return n;
  }

  /** Build the first `count` instances up front, to avoid a first-use hitch. */
  preallocate(count: number): void {
    for (let i = 0; i < Math.min(count, this.voices.length); i++) this.at(i);
  }

  private at(index: number): T {
    let voice = this.voices[index];
    if (!voice) {
      voice = this.factory(index);
      this.voices[index] = voice;
    }
    return voice;
  }

  /** Instances still sounding at `now`. */
  activeCount(now: number): number {
    let n = 0;
    for (let i = 0; i < this.freeAt.length; i++) if (this.freeAt[i]! > now) n++;
    return n;
  }

  /**
   * Take a voice.
   *
   * @param priority 0..1; a request only steals from something of lower or
   *                 equal priority, so a boss roar never loses to footsteps.
   * @returns undefined when every slot is busy with something more important.
   */
  acquire(now: number, priority: number): IVoiceLease | undefined {
    // Prefer a genuinely idle slot.
    let bestIdle = -1;
    let bestIdleFreeAt = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.voices.length; i++) {
      if (this.freeAt[i]! <= now && this.freeAt[i]! < bestIdleFreeAt) {
        bestIdle = i;
        bestIdleFreeAt = this.freeAt[i]!;
      }
    }
    if (bestIdle >= 0) return this.checkout(bestIdle, priority);

    // All busy: steal the lowest-priority, then the one that started earliest.
    let victim = -1;
    let victimPriority = Number.POSITIVE_INFINITY;
    let victimFreeAt = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.voices.length; i++) {
      const p = this.priority[i]!;
      if (p < victimPriority || (p === victimPriority && this.freeAt[i]! < victimFreeAt)) {
        victim = i;
        victimPriority = p;
        victimFreeAt = this.freeAt[i]!;
      }
    }
    if (victim < 0 || victimPriority > priority) return undefined;

    this.at(victim).stopAt(now, 0.008);
    return this.checkout(victim, priority);
  }

  private checkout(slot: number, priority: number): IVoiceLease {
    const generation = this.nextGeneration++;
    this.generation[slot] = generation;
    this.priority[slot] = priority;
    // Marked busy for a nominal span; `markBusyUntil` refines it once the
    // voice reports its real duration.
    this.freeAt[slot] = Number.POSITIVE_INFINITY;
    return { voice: this.at(slot), slot, generation };
  }

  /** Record when a checked-out slot becomes reusable. */
  markBusyUntil(slot: number, time: number): void {
    this.freeAt[slot] = time;
  }

  /** True when the lease still refers to the instance it was issued for. */
  isCurrent(lease: IVoiceLease): boolean {
    return this.generation[lease.slot] === lease.generation;
  }

  /** Stop a specific instance early. */
  release(lease: IVoiceLease, time: number, fadeSeconds = 0.02): void {
    if (!this.isCurrent(lease)) return;
    lease.voice.stopAt(time, fadeSeconds);
    this.freeAt[lease.slot] = time + fadeSeconds;
  }

  /** Stop every instance. */
  stopAll(time: number, fadeSeconds = 0.05): void {
    for (let i = 0; i < this.voices.length; i++) {
      const voice = this.voices[i];
      if (voice && this.freeAt[i]! > time) {
        voice.stopAt(time, fadeSeconds);
        this.freeAt[i] = time + fadeSeconds;
      }
    }
  }

  /** Visit every CONSTRUCTED instance. */
  forEach(fn: (voice: T, slot: number) => void): void {
    for (let i = 0; i < this.voices.length; i++) {
      const voice = this.voices[i];
      if (voice) fn(voice, i);
    }
  }

  dispose(): void {
    for (const v of this.voices) v?.dispose();
    this.voices.length = 0;
  }
}
