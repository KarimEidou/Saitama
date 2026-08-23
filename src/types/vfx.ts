/**
 * VFX CONTRACT
 *
 * Particles, decals, trails, impact effects and camera shake.
 *
 * TYPE-ONLY file. No runtime exports.
 *
 * BUDGET: every effect must be poolable and cancellable. A serious punch can
 * request dozens of effects in one frame; the system caps by
 * `IQualitySettings.maxParticleSystems` and drops the lowest-priority
 * requests rather than degrading the frame rate.
 */

import type * as THREE from 'three';
import type { IUpdatable, IDisposable } from './engine';
import type { LethalIntent } from './combat';

/* -------------------------------------------------------------------------- */
/* Effects                                                                    */
/* -------------------------------------------------------------------------- */

/** Named effects. Extend here rather than passing bare strings. */
export type VFXEffectName =
  | 'punchImpact'
  | 'shockwaveRing'
  | 'shockwaveCone'
  | 'debrisBurst'
  | 'dustCloud'
  | 'groundCrack'
  | 'crater'
  | 'bloodSpray'
  | 'sparks'
  | 'explosion'
  | 'speedLines'
  | 'airDistortion'
  | 'landingDust'
  | 'monsterDeath'
  | 'healPulse'
  | 'rankUpBurst';

/** Parameters for spawning one effect. */
export interface IVFXSpawnOptions {
  readonly position: THREE.Vector3;
  /** Orientation; defaults to +Y. */
  readonly direction?: THREE.Vector3;
  /** Uniform scale multiplier. */
  readonly scale?: number;
  /** Intensity 0..1; drives particle count, brightness and lifetime. */
  readonly intensity?: number;
  /**
   * Tint as an sRGB hex integer.
   *
   * Honoured by the FLASH and SPARK populations only. Dust, debris shells and
   * ground cracks are art-directed and ignore it: a tinted dust cloud reads as
   * coloured fog rather than as a coloured impact. Omit to keep every module
   * default.
   */
  readonly color?: number;
  /** Follow this object as it moves. */
  readonly attachTo?: THREE.Object3D;
  /** Override the effect's default lifetime, in seconds. */
  readonly lifetime?: number;
  /**
   * Priority 0..1. Under budget pressure the lowest-priority requests are
   * dropped first. A serious-punch shockwave should be near 1.
   */
  readonly priority?: number;
  /** Force commitment; scales the visual drama. */
  readonly intent?: LethalIntent;
}

/** Handle to a live effect instance. */
export interface IVFXHandle {
  readonly id: number;
  readonly effect: VFXEffectName;
  readonly alive: boolean;
  /** Stop emitting; existing particles finish naturally. */
  stop(): void;
  /** Remove immediately. */
  kill(): void;
  /**
   * Move an unattached effect or trail.
   *
   * On a TRAIL this also resets the velocity differencing: the trail treats
   * the new position as a fresh start rather than as one frame's motion, so a
   * teleport lays down a jump-length streak. Already-emitted particles keep
   * the position they were emitted at.
   */
  setPosition(position: THREE.Vector3): void;
}

/* -------------------------------------------------------------------------- */
/* Decals                                                                     */
/* -------------------------------------------------------------------------- */

/** Persistent surface marks: scorch, cracks, craters. */
export interface IDecalOptions {
  readonly position: THREE.Vector3;
  /** Surface normal to project along. */
  readonly normal: THREE.Vector3;
  /** Size in metres. */
  readonly size: number;
  /** Rotation about the normal, in radians. */
  readonly rotation?: number;
  /** Material asset key. */
  readonly materialKey: string;
  /** Seconds before fading out. Omit for permanent (budget permitting). */
  readonly lifetime?: number;
}

/* -------------------------------------------------------------------------- */
/* Camera shake                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Trauma-based camera shake.
 *
 * Callers add TRAUMA, not displacement; the system squares it and decays it
 * over time, which reads far better than raw offsets and composes cleanly when
 * several impacts land at once.
 */
export interface ICameraShake extends IUpdatable {
  /** Current trauma 0..1. */
  readonly trauma: number;
  /** Add trauma, clamped to 1. */
  add(trauma: number): void;
  /**
   * Add trauma attenuated by distance from the camera — a distant collapse
   * should barely register.
   */
  addAtPosition(trauma: number, position: THREE.Vector3, falloffRadius: number): void;
  /** Clear immediately, e.g. on cutscene entry. */
  reset(): void;
  /** Trauma decay per second. */
  decayRate: number;
}

/* -------------------------------------------------------------------------- */
/* System                                                                     */
/* -------------------------------------------------------------------------- */

/** Central VFX manager. */
export interface IVFXSystem extends IUpdatable, IDisposable {
  readonly shake: ICameraShake;
  /** Live effect instances. */
  readonly activeCount: number;
  /** Ceiling from the active quality tier. */
  readonly capacity: number;

  /** Spawn an effect. Returns undefined when the budget rejected it. */
  spawn(effect: VFXEffectName, options: IVFXSpawnOptions): IVFXHandle | undefined;
  /**
   * Project a decal.
   *
   * Returns false ONLY when the tier has zero decal capacity. A full buffer
   * recycles its oldest entry and still returns true — losing the oldest crack
   * is correct, refusing to draw the newest one is not — so a false return
   * means "this tier draws no decals at all", not "try again later".
   */
  addDecal(options: IDecalOptions): boolean;
  /** Attach a motion trail to an object, e.g. a fist during a punch. */
  addTrail(target: THREE.Object3D, materialKey: string, lifetime: number): IVFXHandle | undefined;
  /** Stop every instance of an effect. */
  stopAll(effect?: VFXEffectName): void;
  /** Clear everything, e.g. on fast travel. */
  clear(): void;
  /**
   * Pre-warm pools so the first punch of a session does not hitch.
   *
   * POOLS ONLY. The hitch that matters is shader linking, and this signature
   * carries no renderer, scene or camera, so an implementation cannot compile
   * a program from here — it warns rather than resolving silently, because a
   * caller who asked for no hitch and got a resolved promise would have no
   * reason to look further. Render one frame with the VFX meshes visible
   * before the loading screen clears, or call the implementation's own
   * `compile(renderer, scene, camera)`.
   */
  preload(effects: readonly VFXEffectName[]): Promise<void>;
}
