/**
 * CHARACTER CONTRACT
 *
 * Humanoid rig conventions, body proportions, character construction and
 * animation playback.
 *
 * TYPE-ONLY file. No runtime exports.
 *
 * RIGGING CONVENTION (binding): all humanoid characters use a
 * Mixamo-compatible skeleton. Bone names in the source GLB are expected to
 * carry the `mixamorig:` prefix; the character factory strips it, so code
 * always refers to the unprefixed `BoneName` values below.
 */

import type * as THREE from 'three';

/* -------------------------------------------------------------------------- */
/* Skeleton                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Canonical humanoid bone names (Mixamo-compatible, prefix stripped).
 *
 * Deliberately a string-literal UNION rather than a TypeScript `enum`: enums
 * emit runtime code, and every file in `src/types/` must erase completely at
 * build time. The runtime lookup table lives with the character factory.
 */
export type BoneName =
  | 'Hips'
  | 'Spine'
  | 'Spine1'
  | 'Spine2'
  | 'Neck'
  | 'Head'
  | 'HeadTop_End'
  // Left arm
  | 'LeftShoulder'
  | 'LeftArm'
  | 'LeftForeArm'
  | 'LeftHand'
  | 'LeftHandIndex1'
  | 'LeftHandThumb1'
  // Right arm
  | 'RightShoulder'
  | 'RightArm'
  | 'RightForeArm'
  | 'RightHand'
  | 'RightHandIndex1'
  | 'RightHandThumb1'
  // Left leg
  | 'LeftUpLeg'
  | 'LeftLeg'
  | 'LeftFoot'
  | 'LeftToeBase'
  // Right leg
  | 'RightUpLeg'
  | 'RightLeg'
  | 'RightFoot'
  | 'RightToeBase';

/** Bones that carry combat sockets (VFX attachment, hit origins). */
export type SocketBone = Extract<
  BoneName,
  'LeftHand' | 'RightHand' | 'LeftFoot' | 'RightFoot' | 'Head' | 'Hips'
>;

/* -------------------------------------------------------------------------- */
/* Body proportions                                                           */
/* -------------------------------------------------------------------------- */

/** Broad silhouette archetype driving mesh generation and scale. */
export type BodyArchetype =
  'hero' | 'civilian' | 'child' | 'heavy' | 'lithe' | 'monsterHumanoid' | 'monsterBeast';

/**
 * Proportional description of a character body. Used both to scale a shared
 * base mesh and to drive procedural civilian variety.
 *
 * All measurements are in METRES; `height` is the authoritative overall scale
 * and other fields are multipliers unless stated otherwise.
 */
export interface BodyProfile {
  readonly archetype: BodyArchetype;
  /** Total standing height in metres. Adult humans ~1.6–1.9. */
  readonly height: number;
  /** Shoulder width multiplier; 1.0 is the base mesh. */
  readonly shoulderWidth: number;
  /** Torso thickness multiplier. */
  readonly bulk: number;
  /** Limb length multiplier. */
  readonly limbLength: number;
  /** Head size multiplier. Stylised heroes trend >1. */
  readonly headScale: number;
  /** Uniform scale applied after all other proportions. */
  readonly uniformScale: number;
  /** Skin tone as a hex integer, for procedural civilians. */
  readonly skinTone?: number;
  /** Primary clothing colour as a hex integer. */
  readonly primaryColor?: number;
  /** Secondary/accent clothing colour. */
  readonly secondaryColor?: number;
  /** Deterministic seed used to derive this profile. */
  readonly seed?: number;
}

/* -------------------------------------------------------------------------- */
/* Animation clips                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Logical animation slots. These are SLOT names, not the clip names inside a
 * GLB — `IAnimationSet` in entity.ts maps each slot to a concrete clip name.
 * Keep this union and `IAnimationSet`'s keys in sync.
 */
export type ClipName =
  | 'idle'
  | 'walk'
  | 'run'
  | 'sprint'
  | 'jump'
  | 'fall'
  | 'land'
  | 'attack'
  | 'heavyAttack'
  | 'block'
  | 'dodge'
  | 'hit'
  | 'stagger'
  | 'death'
  | 'flee'
  | 'taunt'
  | 'special';

/** How a clip behaves when it reaches its end. */
export type ClipLoopMode = 'once' | 'repeat' | 'pingpong';

/** Playback options for a single clip. */
export interface IClipOptions {
  /** Crossfade duration in seconds. 0 snaps. */
  readonly fade?: number;
  readonly loop?: ClipLoopMode;
  /** Playback rate multiplier. */
  readonly timeScale?: number;
  /** Blend weight in 0..1 for additive/layered playback. */
  readonly weight?: number;
  /** Hold the final pose instead of resetting. Use for death. */
  readonly clampWhenFinished?: boolean;
  /** Start offset in seconds. */
  readonly startAt?: number;
}

/**
 * Animation playback facade over THREE.AnimationMixer.
 *
 * Implementations must tolerate MISSING clips: if a slot has no clip, fall
 * back to `idle` and warn once rather than throwing — asset coverage lands
 * incrementally across workstreams.
 */
export interface IAnimator {
  /** Underlying mixer. */
  readonly mixer: THREE.AnimationMixer;
  /** Slot currently playing on the base layer. */
  readonly current: ClipName | undefined;
  /** Slots that actually resolved to a clip on this character. */
  readonly available: readonly ClipName[];

  /** Play a slot on the base layer. No-op if already current and looping. */
  play(clip: ClipName, options?: IClipOptions): void;
  /** Play on an additive layer without disturbing the base layer. */
  playAdditive(clip: ClipName, options?: IClipOptions): void;
  /** Stop an additive layer. */
  stopAdditive(clip: ClipName, fade?: number): void;
  /** True when the slot resolved to a real clip. */
  has(clip: ClipName): boolean;
  /** Advance the mixer. Called by the animation system. */
  update(dt: number): void;
  /** Fired when a non-looping clip finishes. Returns an unsubscribe fn. */
  onFinished(cb: (clip: ClipName) => void): () => void;
  /** Global playback rate. Used for slow-motion finishers. */
  timeScale: number;
  dispose(): void;
}

/* -------------------------------------------------------------------------- */
/* Character construction                                                     */
/* -------------------------------------------------------------------------- */

/** A fully constructed, animatable character instance. */
export interface ICharacterInstance {
  /** Scene root. Parent this to the entity's root. */
  readonly root: THREE.Object3D;
  /** The skinned mesh(es) making up the body. */
  readonly meshes: readonly THREE.SkinnedMesh[];
  /** Bound skeleton. */
  readonly skeleton: THREE.Skeleton;
  /** Animation facade. */
  readonly animator: IAnimator;
  /** Proportions this instance was built from. */
  readonly profile: BodyProfile;
  /** Look up a bone by canonical name. Undefined when the rig lacks it. */
  getBone(name: BoneName): THREE.Bone | undefined;
  /**
   * World-space position of a combat socket, written into `out` to avoid
   * per-frame allocation. Used as the origin for punch events.
   */
  getSocketWorldPosition(bone: SocketBone, out: THREE.Vector3): THREE.Vector3;
  /** Release GPU resources. Skeletons shared with the pool are not freed. */
  dispose(): void;
}

/**
 * Builds character instances. Implementations should share geometry and
 * skeletons across instances wherever possible — hundreds of civilians must
 * be affordable on a mid-tier phone.
 */
export interface ICharacterFactory {
  /**
   * Build a character from an asset key and a body profile.
   * @param assetKey Must match an `ICharacterAsset.id` in the asset manifest.
   */
  create(assetKey: string, profile: BodyProfile): Promise<ICharacterInstance>;
  /** Build a randomised civilian from a deterministic seed. */
  createProceduralCivilian(seed: number): Promise<ICharacterInstance>;
  /** Warm the cache for an asset so later `create` calls do not hitch. */
  preload(assetKey: string): Promise<void>;
  /** Return an instance to the pool for reuse. */
  release(instance: ICharacterInstance): void;
  /** Drop all cached geometry/skeletons. */
  dispose(): void;
}
