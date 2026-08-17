/**
 * AUDIO CONTRACT
 *
 * TYPE-ONLY file. No runtime exports.
 *
 * MOBILE AUTOPLAY: browsers suspend the AudioContext until a user gesture.
 * `IAudioSystem.unlock()` must be called from a real input handler before any
 * sound will play; treat audio as unavailable until `unlocked` is true.
 */

import type * as THREE from 'three';
import type { IUpdatable, IDisposable } from './engine';

/* -------------------------------------------------------------------------- */
/* Buses                                                                      */
/* -------------------------------------------------------------------------- */

/** Mixer bus. Each has an independent user-facing volume. */
export type AudioCategory = 'sfx' | 'music' | 'ambience' | 'voice' | 'ui';

/** Per-bus mixer settings. */
export interface IAudioBus {
  readonly category: AudioCategory;
  /** Linear gain 0..1. */
  volume: number;
  muted: boolean;
}

/* -------------------------------------------------------------------------- */
/* Playback                                                                   */
/* -------------------------------------------------------------------------- */

/** Options for a single playback. */
export interface IPlayOptions {
  /** Linear gain 0..1, multiplied by the bus volume. */
  readonly volume?: number;
  /** Playback rate; also shifts pitch. */
  readonly rate?: number;
  /** Random pitch variation ±this fraction. Avoids machine-gun repetition. */
  readonly pitchVariation?: number;
  readonly loop?: boolean;
  /** Fade-in seconds. */
  readonly fadeIn?: number;
  /** Delay before starting, in seconds. */
  readonly delay?: number;
  /** World position for 3D audio. Omit for a 2D sound. */
  readonly position?: THREE.Vector3;
  /** Distance in metres at which attenuation begins. */
  readonly refDistance?: number;
  /** Distance beyond which the sound is inaudible. */
  readonly maxDistance?: number;
  /** Follow this object as it moves. */
  readonly attachTo?: THREE.Object3D;
  /**
   * Priority 0..1. When the voice limit is reached, the lowest-priority
   * playing sound is stolen. Critical hits should be near 1.
   */
  readonly priority?: number;
}

/** Handle to a playing sound. */
export interface ISoundHandle {
  readonly id: number;
  readonly key: string;
  readonly category: AudioCategory;
  readonly isPlaying: boolean;
  /** Seconds elapsed. */
  readonly currentTime: number;
  readonly duration: number;

  stop(fadeOut?: number): void;
  pause(): void;
  resume(): void;
  setVolume(volume: number, fadeSeconds?: number): void;
  setRate(rate: number): void;
  /** Update the world position of a 3D sound. */
  setPosition(position: THREE.Vector3): void;
  /** Fired when playback ends naturally. Returns an unsubscribe fn. */
  onEnded(cb: () => void): () => void;
}

/* -------------------------------------------------------------------------- */
/* System                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Central audio system.
 *
 * VOICE BUDGET: mobile devices choke well before the Web Audio spec's limits.
 * Implementations must enforce `maxVoices` with priority-based stealing rather
 * than letting concurrent sounds grow without bound — a building collapse can
 * otherwise request hundreds of debris impacts in one frame.
 */
export interface IAudioSystem extends IUpdatable, IDisposable {
  /** False until a user gesture has resumed the AudioContext. */
  readonly unlocked: boolean;
  /** Currently playing voices. */
  readonly voiceCount: number;
  /** Hard ceiling on concurrent voices. */
  readonly maxVoices: number;
  /** Master gain 0..1, applied above every bus. */
  masterVolume: number;

  /** Resume the AudioContext. MUST be called from a real user gesture. */
  unlock(): Promise<void>;
  /** Mixer bus by category. */
  bus(category: AudioCategory): IAudioBus;

  /**
   * Play a sound by asset key. Returns undefined when the asset is not
   * resident or the voice budget rejected it — always handle undefined.
   */
  play(key: string, options?: IPlayOptions): ISoundHandle | undefined;
  /** Play a 3D one-shot at a world position. */
  playAt(key: string, position: THREE.Vector3, options?: IPlayOptions): ISoundHandle | undefined;
  /** Crossfade the music bed. Passing undefined fades music out. */
  playMusic(key: string | undefined, fadeSeconds?: number): void;
  /** Crossfade the ambience bed. */
  playAmbience(key: string | undefined, fadeSeconds?: number): void;
  /** Stop every voice using an asset key. */
  stop(key: string, fadeOut?: number): void;
  /** Stop everything, optionally on one bus only. */
  stopAll(category?: AudioCategory, fadeOut?: number): void;

  /** Move the 3D listener. Called each frame from the camera. */
  setListener(position: THREE.Vector3, forward: THREE.Vector3, up: THREE.Vector3): void;
  /** Duck a bus, e.g. lower music under a boss roar. */
  duck(category: AudioCategory, toVolume: number, seconds: number): void;
  /** Release a duck applied by `duck`. */
  unduck(category: AudioCategory, seconds: number): void;
  /** Suspend all audio when the app is backgrounded. */
  setSuspended(suspended: boolean): void;
}
