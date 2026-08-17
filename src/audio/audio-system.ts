/**
 * AUDIO SYSTEM — the implementation of `IAudioSystem`.
 *
 * Owns the `AudioContext`, the mixer, every voice pool, the music director and
 * the ambience beds, and translates the event bus into sound.
 *
 * ── ZERO AUDIO FILES ───────────────────────────────────────────────────────
 * Nothing here loads anything. `play('shockwave.serious')` does not look up an
 * asset; it leases a pre-built synthesis graph and writes an envelope onto it.
 * The `key` in `IAudioSystem.play` names a SYNTHESISER PATCH rather than a
 * sample, which is why `unlocked` is the only readiness state that exists —
 * there is no loading state, because there is nothing to load.
 *
 * ── HOW GAMEPLAY REACHES IT ────────────────────────────────────────────────
 * Only through the event bus. `attach(bus)` subscribes to every `GameEvent`
 * and runs it through the pure rules in `event-map.ts`. This module imports no
 * other system, and no other system imports it.
 *
 * ── TWO THINGS THAT NEED SPECIAL HANDLING ──────────────────────────────────
 *  1. DEBRIS is aggregated. `ChunkDetached` fires once per fracture piece, so
 *     a collapse produces a burst of them in a single frame. Playing one voice
 *     each would exhaust the budget instantly and sound like a machine gun.
 *     Instead they are accumulated per frame and flushed as ONE grain cloud
 *     whose density is derived from the chunk count.
 *  2. IMPULSES are rate-limited. Ragdolls emit `ImpulseApplied` continuously
 *     while they settle; without a limiter they would drown everything else.
 */

import type {
  AudioCategory,
  GameEvent,
  IAudioBus,
  IAudioSystem,
  IEventBus,
  IPlayOptions,
  ISoundHandle,
  Vec3,
} from '@/types';
import { clamp, clamp01, createLogger, createRng, lerp, type IRandom } from '@/util';
import { Mixer } from './mixer';
import { SustainedVoice, SynthVoice, VoiceBank, type IVoiceLease } from './voice';
import {
  SOUND_KEYS,
  SOUND_SPECS,
  VOICE_CLASSES,
  soundSpec,
  type ISoundSpec,
  type SoundKey,
  type VoiceClassId,
} from './voices/registry';
import { CrowdBedVoice } from './voices/crowd';
import { WindVoice } from './voices/locomotion';
import { MusicDirector } from './music/director';
import { ReverbSend, REVERB_PRESETS, type ReverbPreset } from './reverb';
import { MUSIC_STATES, type MusicState } from './music/patterns';
import { resolveEventAudio, type IAudioCue } from './event-map';

const log = createLogger('audio');

/** Scheduling lookahead for the music and crowd schedulers, in seconds. */
const LOOKAHEAD = 0.25;

/** Voice classes warmed at unlock so common sounds never hitch on first use. */
const WARM_CLASSES: readonly VoiceClassId[] = ['punch', 'footstep', 'ui', 'debris', 'shockwave'];

/** Maximum `ImpulseApplied` sounds per second. Ragdolls emit far more. */
const IMPULSE_RATE_LIMIT = 10;

/** Chunks within the rolling window that imply a structure is coming down. */
const COLLAPSE_CHUNK_THRESHOLD = 55;

/** Rolling window for the collapse heuristic, in seconds. */
const COLLAPSE_WINDOW = 0.8;

/** Default randomisation seed. Fixed so offline renders are reproducible. */
const DEFAULT_SEED = 0x5a1741;

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Play options, extended with the two knobs a synthesiser needs that a
 * sample player does not. Every added field is optional, so this remains
 * interchangeable with `IPlayOptions` in both directions.
 */
export interface ISynthPlayOptions extends Omit<IPlayOptions, 'position'> {
  /**
   * World position for 3D playback.
   *
   * Widened from the contract's `THREE.Vector3` to the structural `Vec3`:
   * a `Vector3` still satisfies it, but the audio system never needs three.js
   * and event payloads carry plain vectors.
   */
  readonly position?: Vec3;
  /** Voice variant: material, threat tier, surface, motif. */
  readonly variant?: string;
  /** 0..1 "how hard". Overrides the key's default. */
  readonly intensity?: number;
  /**
   * Reverb send override 0..1. Defaults to the key's own value. Useful when
   * the same sound is heard from a different acoustic position — a punch
   * heard from inside a building sends far more than one heard in the open.
   */
  readonly send?: number;
}

export interface IAudioSystemOptions {
  /**
   * Use an existing context. Supply an `OfflineAudioContext` to render the
   * whole engine to PCM — which is exactly how the render tests work.
   */
  readonly context?: BaseAudioContext;
  readonly masterVolume?: number;
  /** Hard ceiling on concurrent voices. */
  readonly maxVoices?: number;
  /** Seed for every per-instance randomisation, so renders are reproducible. */
  readonly seed?: number;
  /** Skip the master limiter and clipper. Measurement only. */
  readonly bypassMaster?: boolean;
  /** Start the ambience beds as soon as the system unlocks. */
  readonly autoStartAmbience?: boolean;
  /**
   * Acoustic environment at construction. Pass `'none'` to render voices dry,
   * which is what the per-voice offline probes do so that they measure the
   * VOICE rather than the room around it.
   */
  readonly environment?: ReverbPreset;
}

/* -------------------------------------------------------------------------- */
/* Sound handle                                                               */
/* -------------------------------------------------------------------------- */

/** Live handle to one triggered voice. */
class SynthSoundHandle implements ISoundHandle {
  readonly id: number;
  readonly key: string;
  readonly category: AudioCategory;
  readonly priority: number;
  readonly startTime: number;
  duration: number;

  private readonly ctx: BaseAudioContext;
  private readonly bank: VoiceBank<SynthVoice> | undefined;
  private readonly lease: IVoiceLease | undefined;
  private readonly voice: SynthVoice;
  private readonly callbacks: (() => void)[] = [];
  private endedFired = false;
  private stopped = false;
  private pausedVolume: number | undefined;
  private volume: number;

  constructor(params: {
    id: number;
    key: string;
    category: AudioCategory;
    priority: number;
    startTime: number;
    duration: number;
    volume: number;
    ctx: BaseAudioContext;
    voice: SynthVoice;
    bank?: VoiceBank<SynthVoice>;
    lease?: IVoiceLease;
  }) {
    this.id = params.id;
    this.key = params.key;
    this.category = params.category;
    this.priority = params.priority;
    this.startTime = params.startTime;
    this.duration = params.duration;
    this.volume = params.volume;
    this.ctx = params.ctx;
    this.voice = params.voice;
    this.bank = params.bank;
    this.lease = params.lease;
  }

  /** True while this handle still owns its voice slot. */
  get isCurrent(): boolean {
    if (this.stopped) return false;
    if (!this.bank || !this.lease) return true;
    return this.bank.isCurrent(this.lease);
  }

  get isPlaying(): boolean {
    if (!this.isCurrent) return false;
    if (!Number.isFinite(this.duration)) return true;
    return this.ctx.currentTime < this.startTime + this.duration;
  }

  get currentTime(): number {
    return Math.max(0, this.ctx.currentTime - this.startTime);
  }

  stop(fadeOut = 0.02): void {
    if (this.stopped) return;
    this.stopped = true;
    const now = this.ctx.currentTime;
    if (this.bank && this.lease) this.bank.release(this.lease, now, fadeOut);
    else this.voice.stopAt(now, fadeOut);
    this.fireEnded();
  }

  /**
   * Mute the voice.
   *
   * Web Audio has no per-voice transport, so a scheduled envelope cannot be
   * frozen: the timeline keeps running underneath. This mutes and remembers
   * the level, which is the audible behaviour callers want (and is exact for
   * the sustained beds, where there is no envelope to freeze).
   */
  pause(): void {
    if (this.pausedVolume !== undefined) return;
    this.pausedVolume = this.volume;
    this.voice.setVolume(0, this.ctx.currentTime, 0.01);
  }

  resume(): void {
    if (this.pausedVolume === undefined) return;
    this.voice.setVolume(this.pausedVolume, this.ctx.currentTime, 0.01);
    this.pausedVolume = undefined;
  }

  setVolume(volume: number, fadeSeconds = 0): void {
    this.volume = Math.max(volume, 0);
    if (this.pausedVolume !== undefined) {
      this.pausedVolume = this.volume;
      return;
    }
    this.voice.setVolume(this.volume, this.ctx.currentTime, fadeSeconds);
  }

  /**
   * Re-pitch a sounding voice.
   *
   * Implemented as a detune offset in cents applied to every oscillator the
   * voice owns. `detune` is summed with `frequency` by the spec, so this
   * shifts the pitch WITHOUT disturbing any frequency sweep already scheduled
   * on the timeline — which a direct frequency write would destroy.
   */
  setRate(rate: number): void {
    this.voice.setRate(rate, this.ctx.currentTime);
  }

  setPosition(position: Vec3): void {
    this.voice.setPosition(position, this.ctx.currentTime);
  }

  onEnded(cb: () => void): () => void {
    if (this.endedFired) {
      cb();
      return () => {};
    }
    this.callbacks.push(cb);
    return () => {
      const i = this.callbacks.indexOf(cb);
      if (i !== -1) this.callbacks.splice(i, 1);
    };
  }

  /** Called by the system when the voice's tail has finished. */
  fireEnded(): void {
    if (this.endedFired) return;
    this.endedFired = true;
    for (const cb of this.callbacks.slice()) {
      try {
        cb();
      } catch (error) {
        log.error('onEnded handler threw', error);
      }
    }
    this.callbacks.length = 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Debris aggregation                                                         */
/* -------------------------------------------------------------------------- */

interface DebrisAccumulator {
  key: SoundKey;
  variant: string;
  count: number;
  maxIntensity: number;
  x: number;
  y: number;
  z: number;
}

/* -------------------------------------------------------------------------- */
/* The system                                                                 */
/* -------------------------------------------------------------------------- */

export class AudioSystem implements IAudioSystem {
  readonly ctx: BaseAudioContext;
  readonly mixer: Mixer;
  readonly music: MusicDirector;
  readonly reverb: ReverbSend;

  readonly maxVoices: number;

  private readonly banks = new Map<VoiceClassId, VoiceBank<SynthVoice>>();
  private readonly sustainedVoices = new Map<VoiceClassId, SustainedVoice>();
  private readonly handles: SynthSoundHandle[] = [];
  private readonly rng: IRandom;

  private unlockedValue = false;
  private suspended = false;
  private disposed = false;
  private nextHandleId = 1;
  private unsubscribe: (() => void) | undefined;

  /** Debris accumulated this frame, keyed by material. */
  private readonly debris = new Map<string, DebrisAccumulator>();
  /** Rolling chunk count, for the collapse heuristic. */
  private chunkWindow: { time: number; count: number }[] = [];
  private lastCollapseAt = -Infinity;

  private impulseTokens = IMPULSE_RATE_LIMIT;
  private lastMusicKey: string | undefined;
  private ambienceRunning = false;
  private crowdDensity = 0.3;
  private ambientWind = 0.15;
  private speedWind = 0;
  private readonly listenerPosition = { x: 0, y: 0, z: 0 };
  private readonly autoStartAmbience: boolean;
  /** Unknown keys are reported once each, not once per frame. */
  private readonly warnedKeys = new Set<string>();

  constructor(options: IAudioSystemOptions = {}) {
    this.ctx = options.context ?? createLiveContext();
    this.maxVoices = options.maxVoices ?? 32;
    this.rng = createRng(options.seed ?? DEFAULT_SEED);
    this.autoStartAmbience = options.autoStartAmbience ?? true;

    this.mixer = new Mixer(this.ctx, {
      masterVolume: options.masterVolume ?? 1,
      bypassMaster: options.bypassMaster ?? false,
    });
    this.music = new MusicDirector(this.ctx, this.mixer.input('music'), {
      seed: (options.seed ?? DEFAULT_SEED) ^ 0xc0da,
    });

    // The wet return lands on the master bus, below the per-bus faders that
    // already scaled the sends, so it is neither double-attenuated nor able to
    // escape the master limiter.
    this.reverb = new ReverbSend(this.ctx, this.mixer.masterBus);
    this.mixer.connectSends(this.reverb.input);
    this.reverb.setPreset(options.environment ?? 'openStreet', 0, 0);

    // An offline context has no autoplay policy and no user gesture: it is
    // unlocked by definition, which is what lets the render tests drive the
    // whole system without faking anything.
    this.unlockedValue = !isLiveContext(this.ctx);
  }

  /* ---------------------------------------------------------------------- */
  /* IAudioSystem: state                                                    */
  /* ---------------------------------------------------------------------- */

  get unlocked(): boolean {
    return this.unlockedValue;
  }

  get voiceCount(): number {
    let n = 0;
    for (const h of this.handles) if (h.isPlaying) n++;
    return n;
  }

  get masterVolume(): number {
    return this.mixer.masterVolume;
  }

  set masterVolume(value: number) {
    this.mixer.masterVolume = value;
  }

  /**
   * Resume the context. MUST be called from a real user gesture on mobile.
   * Also warms the pools that must not hitch on their first trigger.
   */
  async unlock(): Promise<void> {
    if (this.disposed) return;
    const live = this.ctx as AudioContext;
    if (isLiveContext(this.ctx) && live.state !== 'running') {
      try {
        await live.resume();
      } catch (error) {
        log.warn('AudioContext.resume() rejected; audio stays locked', error);
        return;
      }
    }
    this.unlockedValue = true;
    for (const id of WARM_CLASSES) this.bank(id).preallocate(2);
    if (this.autoStartAmbience) this.playAmbience('ambience.city');
  }

  bus(category: AudioCategory): IAudioBus {
    return this.mixer.bus(category);
  }

  /* ---------------------------------------------------------------------- */
  /* IAudioSystem: playback                                                 */
  /* ---------------------------------------------------------------------- */

  play(key: string, options: ISynthPlayOptions = {}): ISoundHandle | undefined {
    if (this.disposed || this.suspended) return undefined;
    const spec = soundSpec(key);
    if (!spec) {
      if (!this.warnedKeys.has(key)) {
        this.warnedKeys.add(key);
        log.warn(`unknown sound key "${key}" — nothing to synthesise`);
      }
      return undefined;
    }
    const classSpec = VOICE_CLASSES[spec.voiceClass];
    return classSpec.sustained ? this.playSustained(spec, options) : this.playOneShot(spec, options);
  }

  playAt(key: string, position: Vec3, options: ISynthPlayOptions = {}): ISoundHandle | undefined {
    return this.play(key, { ...options, position });
  }

  private playOneShot(spec: ISoundSpec, options: ISynthPlayOptions): ISoundHandle | undefined {
    const priority = clamp01(options.priority ?? spec.priority);
    const now = this.ctx.currentTime;
    const time = now + Math.max(options.delay ?? 0, 0);

    if (!this.makeRoom(priority, now)) return undefined;

    const bank = this.bank(spec.voiceClass);
    const lease = bank.acquire(now, priority);
    if (!lease) return undefined;

    const variation = options.pitchVariation ?? spec.pitchVariation;
    const rate =
      (options.rate ?? 1) * (variation > 0 ? lerp(1 - variation, 1 + variation, this.rng.next()) : 1);
    const volume = spec.gain * clamp(options.volume ?? 1, 0, 4);
    const intensity = clamp01(options.intensity ?? spec.intensity);

    const duration = lease.voice.trigger({
      time,
      gain: volume,
      rate,
      intensity,
      variant: options.variant ?? spec.variant,
      rng: this.rng.derive(spec.key),
      position: options.position ?? options.attachTo?.position,
      spatial: spec.spatial,
      send: options.send ?? spec.reverbSend,
    });

    const endTime = time + duration + (options.fadeIn ?? 0);
    bank.markBusyUntil(lease.slot, endTime);

    const handle = new SynthSoundHandle({
      id: this.nextHandleId++,
      key: spec.key,
      category: VOICE_CLASSES[spec.voiceClass].category,
      priority,
      startTime: time,
      duration,
      volume,
      ctx: this.ctx,
      voice: lease.voice,
      bank,
      lease,
    });
    this.handles.push(handle);
    return handle;
  }

  private playSustained(spec: ISoundSpec, options: ISynthPlayOptions): ISoundHandle | undefined {
    const voice = this.sustained(spec.voiceClass);
    const now = this.ctx.currentTime;
    const intensity = clamp01(options.intensity ?? spec.intensity);
    voice.start(now, intensity, options.fadeIn ?? 0.6);
    voice.setSend(options.send ?? spec.reverbSend, now);
    const handle = new SynthSoundHandle({
      id: this.nextHandleId++,
      key: spec.key,
      category: VOICE_CLASSES[spec.voiceClass].category,
      priority: spec.priority,
      startTime: now,
      duration: Number.POSITIVE_INFINITY,
      volume: spec.gain * clamp(options.volume ?? 1, 0, 4),
      ctx: this.ctx,
      voice,
    });
    this.handles.push(handle);
    return handle;
  }

  /**
   * Enforce the global voice budget by stealing.
   *
   * The per-bank pools already bound each individual sound; this bounds the
   * TOTAL, which is what actually protects a low-end device when a collapse,
   * a boss and a crowd all land on the same frame.
   */
  private makeRoom(priority: number, now: number): boolean {
    if (this.voiceCount < this.maxVoices) return true;
    let victim: SynthSoundHandle | undefined;
    for (const h of this.handles) {
      if (!h.isPlaying) continue;
      if (!victim || h.priority < victim.priority) victim = h;
    }
    if (!victim || victim.priority > priority) return false;
    victim.stop(0.01);
    void now;
    return true;
  }

  /** Music key -> intensity state. Accepts `'combat'` and `'music.combat'`. */
  playMusic(key: string | undefined, fadeSeconds = 1.5): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    if (key === undefined) {
      this.lastMusicKey = undefined;
      this.music.stop(now, fadeSeconds);
      return;
    }
    const name = key.startsWith('music.') ? key.slice('music.'.length) : key;
    if (!(MUSIC_STATES as readonly string[]).includes(name)) {
      if (!this.warnedKeys.has(key)) {
        this.warnedKeys.add(key);
        log.warn(`unknown music key "${key}"; expected one of ${MUSIC_STATES.join(', ')}`);
      }
      return;
    }
    this.lastMusicKey = `music.${name}`;
    if (!this.music.isRunning) {
      this.music.setStateImmediate(name as MusicState, now);
      this.music.start(now);
    } else {
      this.music.setState(name as MusicState);
    }
  }

  /** The music key currently requested, if any. */
  get musicKey(): string | undefined {
    return this.lastMusicKey;
  }

  /**
   * Ambience is the crowd bed plus the wind bed. `'ambience.city'` starts
   * both; `undefined` fades both out.
   */
  playAmbience(key: string | undefined, fadeSeconds = 1.5): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    if (key === undefined) {
      this.ambienceRunning = false;
      this.sustainedVoices.get('crowdBed')?.stop(now, fadeSeconds);
      this.sustainedVoices.get('wind')?.stop(now, fadeSeconds);
      return;
    }
    this.ambienceRunning = true;
    this.crowd().start(now, this.crowdDensity, fadeSeconds);
    this.wind().start(now, Math.max(this.ambientWind, this.speedWind), fadeSeconds);
  }

  stop(key: string, fadeOut = 0.05): void {
    for (const h of this.handles) {
      if (h.key === key) h.stop(fadeOut);
    }
  }

  stopAll(category?: AudioCategory, fadeOut = 0.1): void {
    for (const h of this.handles) {
      if (category === undefined || h.category === category) h.stop(fadeOut);
    }
    if (category === undefined || category === 'music') {
      this.music.stop(this.ctx.currentTime, fadeOut);
    }
    if (category === undefined || category === 'ambience') {
      this.playAmbience(undefined, fadeOut);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* IAudioSystem: mix control                                              */
  /* ---------------------------------------------------------------------- */

  setListener(position: Vec3, forward: Vec3, up: Vec3): void {
    this.listenerPosition.x = position.x;
    this.listenerPosition.y = position.y;
    this.listenerPosition.z = position.z;
    this.mixer.setListener(position, forward, up, this.ctx.currentTime);
  }

  duck(category: AudioCategory, toVolume: number, seconds: number): void {
    this.mixer.duck(category, toVolume, seconds, this.ctx.currentTime);
  }

  unduck(category: AudioCategory, seconds: number): void {
    this.mixer.unduck(category, seconds, this.ctx.currentTime);
  }

  setSuspended(suspended: boolean): void {
    if (this.suspended === suspended) return;
    this.suspended = suspended;
    if (!isLiveContext(this.ctx)) return;
    const live = this.ctx as AudioContext;
    if (suspended) void live.suspend().catch(() => undefined);
    else void live.resume().catch(() => undefined);
  }

  /* ---------------------------------------------------------------------- */
  /* Continuous gameplay parameters                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * How fast the player is moving, in metres per second. Drives the wind bed.
   * Called every frame; the voice glides internally so this never zippers.
   */
  setPlayerSpeed(metresPerSecond: number): void {
    // 45 m/s is roughly the top of the character's traversal range.
    this.speedWind = clamp01(metresPerSecond / 45);
    if (this.ambienceRunning) {
      this.wind().setIntensity(
        Math.max(this.ambientWind, this.speedWind),
        this.ctx.currentTime,
        0.2
      );
    }
  }

  /**
   * How many civilians are near the listener. Drives the crowd bed's density,
   * which is the player's cue that a street is populated.
   */
  setNearbyCivilians(count: number): void {
    this.setCrowdDensity(CrowdBedVoice.densityForCount(count));
  }

  /** Set crowd density directly, 0..1. */
  setCrowdDensity(density: number): void {
    this.crowdDensity = clamp01(density);
    if (this.ambienceRunning) {
      this.crowd().setIntensity(this.crowdDensity, this.ctx.currentTime, 1.5);
    }
  }

  /**
   * Set the acoustic environment.
   *
   * The city is 1.5 km across and the spaces in it are not interchangeable: a
   * covered arcade, a narrow alley, an open street and the crater a serious
   * punch just left should not sound alike. This is a per-frame parameter like
   * crowd density and player speed — the world system calls it as the listener
   * moves between spaces, and the reverb glides rather than cutting.
   */
  setEnvironment(preset: ReverbPreset, glideSeconds = 0.6): void {
    this.reverb.setPreset(preset, this.ctx.currentTime, glideSeconds);
  }

  /** The acoustic environment currently in force. */
  get environment(): ReverbPreset {
    return this.reverb.preset;
  }

  /** Every selectable environment, for the audition harness. */
  get environments(): Readonly<typeof REVERB_PRESETS> {
    return REVERB_PRESETS;
  }

  /** Ambient (not speed-driven) wind level, 0..1. */
  setAmbientWind(level: number): void {
    this.ambientWind = clamp01(level);
    if (this.ambienceRunning) {
      this.wind().setIntensity(
        Math.max(this.ambientWind, this.speedWind),
        this.ctx.currentTime,
        2
      );
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Event bus                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Subscribe to every game event. Returns an unsubscribe function; calling
   * `attach` twice replaces the previous subscription rather than doubling it.
   */
  attach(bus: IEventBus): () => void {
    this.unsubscribe?.();
    this.unsubscribe = bus.onAny((event) => this.handleEvent(event));
    return () => {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
    };
  }

  /** Route one event through the pure rules and act on the result. */
  handleEvent(event: GameEvent): void {
    if (this.disposed) return;
    const response = resolveEventAudio(event);

    // Debris is accumulated rather than played: see the header note.
    if (event.type === 'ChunkDetached') {
      this.accumulateDebris(response.cues, event.position);
    } else if (event.type === 'ImpulseApplied') {
      if (this.impulseTokens < 1) return;
      this.impulseTokens -= 1;
      for (const cue of response.cues) this.playCue(cue);
    } else {
      for (const cue of response.cues) this.playCue(cue);
    }

    if (response.music) this.playMusic(response.music);
    if (response.boredom !== undefined) this.music.setBoredom(response.boredom);
    if (response.duck) {
      this.mixer.duckFor(
        response.duck.category,
        response.duck.to,
        response.duck.attack,
        response.duck.hold,
        response.duck.release,
        this.ctx.currentTime
      );
    }
    if (response.ambience) {
      const a = response.ambience;
      if (a.crowdDensity !== undefined) this.setCrowdDensity(a.crowdDensity);
      if (a.wind !== undefined) this.setAmbientWind(a.wind);
    }
  }

  private playCue(cue: IAudioCue): ISoundHandle | undefined {
    return this.play(cue.key, {
      variant: cue.variant,
      intensity: cue.intensity,
      volume: cue.gain,
      rate: cue.rate,
      position: cue.position,
      delay: cue.delay,
      priority: cue.priority,
    });
  }

  private accumulateDebris(cues: readonly IAudioCue[], position: Vec3): void {
    for (const cue of cues) {
      const id = `${cue.key}:${cue.variant ?? ''}`;
      let acc = this.debris.get(id);
      if (!acc) {
        acc = {
          key: cue.key,
          variant: cue.variant ?? SOUND_SPECS[cue.key].variant,
          count: 0,
          maxIntensity: 0,
          x: 0,
          y: 0,
          z: 0,
        };
        this.debris.set(id, acc);
      }
      acc.count++;
      acc.maxIntensity = Math.max(acc.maxIntensity, cue.intensity ?? 0.3);
      acc.x += position.x;
      acc.y += position.y;
      acc.z += position.z;
    }
  }

  /**
   * Turn this frame's accumulated chunks into grain clouds.
   *
   * Density comes mostly from the COUNT, logarithmically: three chunks is a
   * scatter, sixty is a shower. Mass only tilts it.
   */
  private flushDebris(now: number): void {
    if (this.debris.size === 0) return;
    let total = 0;
    for (const acc of this.debris.values()) {
      total += acc.count;
      const countDrive = clamp01(Math.log10(1 + acc.count) / Math.log10(1 + 60));
      const intensity = clamp01(countDrive * 0.75 + acc.maxIntensity * 0.35);
      this.play(acc.key, {
        variant: acc.variant,
        intensity,
        position: { x: acc.x / acc.count, y: acc.y / acc.count, z: acc.z / acc.count },
        priority: 0.35 + intensity * 0.2,
      });
    }
    this.debris.clear();

    // Collapse heuristic: sustained heavy fracturing IS a building coming
    // down, and there is no dedicated event for it on the bus.
    this.chunkWindow.push({ time: now, count: total });
    this.chunkWindow = this.chunkWindow.filter((w) => now - w.time <= COLLAPSE_WINDOW);
    let windowed = 0;
    for (const w of this.chunkWindow) windowed += w.count;
    if (windowed >= COLLAPSE_CHUNK_THRESHOLD && now - this.lastCollapseAt > 4) {
      this.lastCollapseAt = now;
      const scale = clamp01(windowed / (COLLAPSE_CHUNK_THRESHOLD * 3));
      this.play(scale > 0.75 ? 'collapse.tower' : 'collapse.building', {
        intensity: clamp01(0.45 + scale * 0.55),
        position: { ...this.listenerPosition },
      });
      this.mixer.duckFor('music', 0.35, 0.2, 1.2, 1.5, now);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Frame                                                                  */
  /* ---------------------------------------------------------------------- */

  update(dt: number): void {
    if (this.disposed || this.suspended) return;
    const now = this.ctx.currentTime;

    // Refill the impulse budget.
    this.impulseTokens = Math.min(
      IMPULSE_RATE_LIMIT,
      this.impulseTokens + IMPULSE_RATE_LIMIT * Math.max(dt, 0)
    );

    this.flushDebris(now);

    // Retire finished handles and fire their callbacks.
    for (let i = this.handles.length - 1; i >= 0; i--) {
      const h = this.handles[i]!;
      if (!h.isPlaying) {
        h.fireEnded();
        this.handles.splice(i, 1);
      }
    }

    // Fill the schedulers' lookahead windows.
    const horizon = now + LOOKAHEAD;
    this.music.advanceTo(horizon);
    const crowd = this.sustainedVoices.get('crowdBed') as CrowdBedVoice | undefined;
    crowd?.scheduleBlips(horizon);
  }

  /* ---------------------------------------------------------------------- */
  /* Pools                                                                  */
  /* ---------------------------------------------------------------------- */

  /** The pool for a voice class, created on first use. */
  bank(id: VoiceClassId): VoiceBank<SynthVoice> {
    let bank = this.banks.get(id);
    if (!bank) {
      const spec = VOICE_CLASSES[id];
      const destination = this.mixer.input(spec.category);
      const sendTarget = this.mixer.sendInput(spec.category);
      bank = new VoiceBank<SynthVoice>(id, spec.poolSize, (index) => {
        const voice = spec.create(this.ctx, destination, index);
        voice.attachSend(sendTarget);
        return voice;
      });
      this.banks.set(id, bank);
    }
    return bank;
  }

  private sustained(id: VoiceClassId): SustainedVoice {
    let voice = this.sustainedVoices.get(id);
    if (!voice) {
      const spec = VOICE_CLASSES[id];
      voice = spec.create(this.ctx, this.mixer.input(spec.category), 0) as SustainedVoice;
      voice.attachSend(this.mixer.sendInput(spec.category));
      this.sustainedVoices.set(id, voice);
    }
    return voice;
  }

  /** The crowd bed, created on first use. */
  crowd(): CrowdBedVoice {
    return this.sustained('crowdBed') as CrowdBedVoice;
  }

  /** The wind bed, created on first use. */
  wind(): WindVoice {
    return this.sustained('wind') as WindVoice;
  }

  /** Every playable key. */
  get keys(): readonly SoundKey[] {
    return SOUND_KEYS;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const h of this.handles) h.fireEnded();
    this.handles.length = 0;
    for (const bank of this.banks.values()) bank.dispose();
    this.banks.clear();
    for (const voice of this.sustainedVoices.values()) voice.dispose();
    this.sustainedVoices.clear();
    this.music.dispose();
    this.reverb.dispose();
    this.mixer.dispose();
    if (isLiveContext(this.ctx)) {
      void (this.ctx as AudioContext).close().catch(() => undefined);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Context helpers                                                            */
/* -------------------------------------------------------------------------- */

/** True for a real, device-backed context (as opposed to an offline render). */
function isLiveContext(ctx: BaseAudioContext): boolean {
  return typeof (ctx as AudioContext).resume === 'function' && 'baseLatency' in ctx;
}

/**
 * Create the live context.
 *
 * `latencyHint: 'interactive'` asks for the smallest buffer the device will
 * give: this game's whole feel depends on an impact landing with the frame
 * that caused it, and the default hint can add tens of milliseconds.
 */
function createLiveContext(): AudioContext {
  const Ctor =
    (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
    (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error('[audio] Web Audio is unavailable in this environment');
  return new Ctor({ latencyHint: 'interactive' });
}
