/**
 * ANIMATION — INTERNAL VOCABULARY
 *
 * The public, cross-system contracts (`ClipName`, `IAnimator`, `BoneName`,
 * `BodyProfile`) live in `@/types`. Nothing in this file is part of the shared
 * architecture; it is the vocabulary this system uses to talk to itself.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY THERE ARE NO KEYFRAMES IN THIS SYSTEM
 *
 *  A keyframed clip encodes a body. Ours are generated, and `BodyProfile`
 *  spans a 1.22 m child and a 2.45 m monster — a factor of two in leg length
 *  and a different mass regime. One authored walk cycle retargeted across that
 *  range slides, over-strides, or minces, and no amount of scaling fixes it,
 *  because stride length and cadence do not scale linearly with height: they
 *  scale with sqrt(leg length) through the Froude number. So the clips are
 *  FUNCTIONS of the body, evaluated at runtime.
 *
 *  Everything downstream follows from that: a pose is a plain buffer rather
 *  than a mixer binding, blending is ours, and the VAT baker can ask for the
 *  pose at any time without a scene graph existing.
 * ══════════════════════════════════════════════════════════════════════════
 */

import type * as THREE from 'three';
import type { BodyProfile, BoneName, ClipName } from '@/types';

/* -------------------------------------------------------------------------- */
/* Pose                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A skeleton's local transforms, laid out flat.
 *
 * Flat typed arrays rather than an array of `THREE.Quaternion`: a pose is
 * blended, copied and masked several times per character per frame, and the
 * VAT baker walks thousands of them. Structure-of-arrays keeps all of that
 * allocation-free and cache-friendly.
 *
 * `rot` is xyzw per bone (three.js order). `pos` is the bone's LOCAL
 * translation — for every bone except `Hips` it stays at the rest offset,
 * because a humanoid rig animates by rotation. `Hips` is the exception and
 * carries the whole body's translation.
 */
export interface Pose {
  readonly boneCount: number;
  /** Local rotation quaternions, 4 floats per bone (x, y, z, w). */
  readonly rot: Float32Array;
  /** Local translations, 3 floats per bone. */
  readonly pos: Float32Array;
}

/** Per-bone blend weights in 0..1. Used to mask a layer to part of the body. */
export type BoneMask = Float32Array;

/* -------------------------------------------------------------------------- */
/* Rig                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The minimum this system needs from a built character.
 *
 * Deliberately STRUCTURAL. `CharacterParts` from the mesh generator satisfies
 * it without either module importing the other — the architectural rule of the
 * codebase is that systems talk through `@/types` and the event bus, and a
 * structural seam is how an animator attaches to a mesh without breaking it.
 */
export interface RigLike {
  readonly skeleton: THREE.Skeleton;
  readonly profile: BodyProfile;
  getBone(name: BoneName): THREE.Bone | undefined;
}

/**
 * Measurements taken off the BIND POSE, in metres.
 *
 * Every one of these is read from the skeleton rather than from `BodyProfile`,
 * because the profile describes intent and the skeleton describes what was
 * actually built. Procedural locomotion is only body-agnostic if it measures.
 */
export interface BodyMetrics {
  /** Crown height, estimated from the head-top bone or the head bone. */
  readonly height: number;
  /** Hip JOINT height above the ground plane (`LeftUpLeg` bind y). */
  readonly hipHeight: number;
  /** Hip joint to ankle, straight-legged. The gait's characteristic length. */
  readonly legLength: number;
  readonly thigh: number;
  readonly shank: number;
  /** Ankle joint height above the sole. */
  readonly ankleHeight: number;
  /** Ankle to toe tip along the foot's forward axis. */
  readonly footForward: number;
  /** Ankle to the back of the heel. */
  readonly heelBack: number;
  /** Half the distance between the two hip joints. */
  readonly hipHalfWidth: number;
  /** Half the distance between the two shoulder joints. */
  readonly shoulderHalfWidth: number;
  readonly upperArm: number;
  readonly foreArm: number;
  /** Shoulder joint to wrist, straight-armed. */
  readonly armLength: number;
  /** Hips bone to neck. */
  readonly spineHeight: number;
  /** Bind-pose direction of the LEFT upper arm, in model space. */
  readonly armRestDir: THREE.Vector3;
  /** Body scale relative to a 1.75 m reference adult. */
  readonly scale: number;
}

/**
 * A skeleton resolved into everything the evaluator needs, with the scene
 * graph flattened into parallel arrays.
 */
export interface AnimRig {
  readonly bones: readonly THREE.Bone[];
  readonly boneCount: number;
  /** Canonical name to bone index. Missing bones are simply absent. */
  readonly index: Readonly<Partial<Record<BoneName, number>>>;
  /** Parent bone index, or -1 for a root. Parents always precede children. */
  readonly parent: Int32Array;
  /** The rest (bind) pose, as a `Pose`. */
  readonly rest: Pose;
  /** Model-space bind translation per bone, 3 floats each. */
  readonly bindModel: Float32Array;
  /** Inverse bind matrices, shared with the skeleton. */
  readonly boneInverses: readonly THREE.Matrix4[];
  readonly metrics: BodyMetrics;
  readonly profile: BodyProfile;
  /**
   * True when every bone rests with an identity quaternion. The procedural
   * clip library assumes this (see `rig.ts` in the mesh generator, which
   * guarantees it); a rig without it still animates, but hinge axes are
   * approximate.
   */
  readonly identityRest: boolean;
}

/* -------------------------------------------------------------------------- */
/* Gaits                                                                      */
/* -------------------------------------------------------------------------- */

/** The three locomotion regimes the parametric model interpolates between. */
export type GaitName = 'stand' | 'walk' | 'jog' | 'run';

/** Everything the gait model derives from speed and body size. */
export interface GaitSolution {
  /** Dominant regime, for reporting and for choosing an upper-body posture. */
  readonly gait: GaitName;
  /** Ground speed in m/s this solution was built for. */
  readonly speed: number;
  /** Froude-normalised speed, `v / sqrt(g * legLength)`. Body-size agnostic. */
  readonly normalisedSpeed: number;
  /** Full gait cycles per second (one cycle is TWO steps). */
  readonly cycleFrequency: number;
  /** Distance covered per full cycle, metres. */
  readonly strideLength: number;
  /** Fraction of the cycle each foot spends on the ground, 0..1. */
  readonly duty: number;
  /** Fore-aft travel of a planted foot relative to the body, metres. */
  readonly excursion: number;
  /** Peak ankle lift during swing, metres. */
  readonly swingLift: number;
  /** 0 at a standstill, 1 at full locomotion. Scales every amplitude. */
  readonly activity: number;
  /** Blend across the walk/run transition: 0 = pure walk, 1 = pure run. */
  readonly runBlend: number;
}

/* -------------------------------------------------------------------------- */
/* Locomotion I/O                                                             */
/* -------------------------------------------------------------------------- */

/** Per-frame drive for the locomotion solver. */
export interface LocomotionInput {
  /** Horizontal ground speed, m/s. */
  readonly speed: number;
  /** Yaw rate in rad/s. Drives banking and foot placement on turns. */
  readonly turnRate?: number;
  /** False while airborne — planting and the gait cycle both suspend. */
  readonly grounded?: boolean;
  /** Ground height under the character, metres. Defaults to 0. */
  readonly groundY?: number;
  /** Strafe component, -1 (left) to 1 (right), for a sidestep blend. */
  readonly strafe?: number;
  /** 0..1 posture degradation. Saitama's Boredom state drives this. */
  readonly slouch?: number;
}

/** Which half of the cycle a foot is in. */
export type FootPhase = 'stance' | 'swing';

/** What the solver did with one foot this frame. Consumed by tests and audio. */
export interface FootReport {
  readonly side: 'left' | 'right';
  readonly phase: FootPhase;
  /** 0..1 through the current stance or swing. */
  readonly progress: number;
  /** World position the contact point is pinned to while planted. */
  readonly plantWorld: THREE.Vector3;
  /**
   * How far the IK had to give up on the plant, metres. Non-zero means the
   * leg could not reach the locked position and the foot slid.
   */
  readonly slip: number;
  /** Ankle pitch in radians. Positive is toes-up. */
  readonly pitch: number;
}

/** Result of one locomotion update. */
export interface LocomotionReport {
  readonly solution: GaitSolution;
  /** Cycle phase in 0..1. 0 is right-foot touchdown. */
  readonly phase: number;
  readonly left: FootReport;
  readonly right: FootReport;
  /** How far the pelvis had to drop below its authored height to keep the
   *  stance leg inside its reach, metres. Large values read as a crouch. */
  readonly reachDrop: number;
  /** Model-space pelvis height this frame. */
  readonly pelvisY: number;
}

/* -------------------------------------------------------------------------- */
/* Clips                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Character-specific flavours of a slot.
 *
 * `ClipName` is the game-wide slot vocabulary and cannot grow (it is a
 * contract). Variants are how one slot carries several performances: `idle`
 * is a different animal for a bored Saitama, an alert hero and a panicking
 * civilian, and all three still answer to `play('idle')`.
 */
export type ClipVariant =
  | 'default'
  | 'bored'
  | 'combat'
  | 'civilian'
  | 'panicked'
  | 'heavy'
  | 'serious';

/** Named moments inside a clip. Consumers map these onto game systems. */
export type AnimEventName =
  | 'footfall'
  | 'footlift'
  | 'windup'
  | 'impact'
  | 'release'
  | 'launch'
  | 'landImpact'
  | 'ragdoll'
  | 'voice'
  | 'whoosh';

/** A fired animation event. */
export interface AnimEvent {
  readonly name: AnimEventName;
  readonly clip: ClipName;
  /** Cycle phase 0..1 the event fired at. */
  readonly phase: number;
  /** Foot events only. */
  readonly foot?: 'left' | 'right';
  /** World position, when the event has one (footfall, impact). */
  readonly position?: THREE.Vector3;
  /** 0..1 strength — footfall weight, punch power, landing severity. */
  readonly strength: number;
  /** Bone the event originates from, for VFX attachment. */
  readonly bone?: BoneName;
}

/** Subscriber signature. */
export type AnimEventListener = (event: AnimEvent) => void;

/** A scheduled event inside a procedural clip's normalised timeline. */
export interface ClipMarker {
  readonly name: AnimEventName;
  /** Normalised time 0..1 within the clip. */
  readonly at: number;
  readonly strength?: number;
  readonly bone?: BoneName;
}

/** Static description of one procedural clip. */
export interface ClipDefinition {
  readonly slot: ClipName;
  readonly variant: ClipVariant;
  /**
   * Duration in seconds AT THE REFERENCE BODY. Scaled per character by
   * `sqrt(legLength / referenceLegLength)` — the pendulum period — so a small
   * body moves quicker and a huge one moves slower, which is what stops a
   * 2.45 m monster from looking like a sped-up human.
   */
  readonly duration: number;
  readonly loop: boolean;
  /** Events fired at fixed points in the timeline. */
  readonly markers: readonly ClipMarker[];
  /** True when the slot is driven by the locomotion solver, not a pose fn. */
  readonly locomotive: boolean;
  /**
   * Reference speed for locomotive slots, Froude-normalised (`v/sqrt(g·L)`).
   * See `clips.ts` for why this unit and not metres per second.
   */
  readonly referenceSpeed?: number;
  /** Which bones the clip is intended to drive. */
  readonly region: 'full' | 'upper' | 'lower';
}

/** Per-character tuning the clip functions read. */
export interface ClipParams {
  /** 0..1 — Saitama's boredom. Degrades posture and slows everything down. */
  boredom: number;
  /** 0..1 — combat readiness. Raises the guard and tightens the stance. */
  alertness: number;
  /** Per-instance phase offset so a crowd does not breathe in unison. */
  phaseOffset: number;
  /** Per-instance amplitude jitter, around 1. */
  vigour: number;
}

/* -------------------------------------------------------------------------- */
/* Ragdoll handoff                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The animated pose at the instant physics takes over.
 *
 * The physics system blends from this to the simulated pose over ~120 ms. It
 * needs MODEL-SPACE matrices, not local rotations, because a ragdoll's bodies
 * are placed in world space and a local-rotation pose would force physics to
 * re-derive the forward kinematics it is about to throw away.
 */
export interface RagdollHandoff {
  /** Model-space matrix per bone, in skeleton order. */
  readonly modelMatrices: readonly THREE.Matrix4[];
  /** Local rotations at the handoff instant, for a return-to-animation blend. */
  readonly pose: Pose;
  /** 0 at the handoff instant, 1 once physics owns the character outright. */
  readonly blend: number;
  /** Seconds the blend takes. */
  readonly duration: number;
  /** Estimated model-space velocity per bone at the handoff, m/s. */
  readonly velocities: Float32Array;
}
