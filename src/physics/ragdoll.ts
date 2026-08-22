/**
 * RAGDOLLS
 *
 * 13 rigid bodies — pelvis, chest, head, and left/right upper arm, forearm,
 * thigh, shin and foot — joined by 12 spherical joints with per-axis angular
 * limits, mapped onto the 27-bone Mixamo humanoid skeleton.
 *
 * ── WHY 13 AND NOT 27 ──────────────────────────────────────────────────────
 * One body per bone is four times the solver cost for a silhouette nobody can
 * tell apart in motion. Fingers, toes, shoulders and the individual spine
 * segments are driven kinematically from their parent segment instead.
 *
 * ── LIMITS ─────────────────────────────────────────────────────────────────
 * Rapier's JS wrapper exposes no `setLimits` on a spherical joint, but the
 * underlying generic joint supports limits on all three angular axes and the
 * raw set does expose them. Each joint's local frames are re-based onto the
 * BIND POSE (`setLocalFrame1(anchor, qRel)`), so a limit of +/-25 degrees means
 * 25 degrees away from the pose the character was in, not away from
 * "both bodies aligned" — which for a T-posed arm would be 90 degrees off.
 * Without that re-basing every limb starts outside its own limits and the
 * ragdoll snaps into a pretzel on the first step.
 *
 * ── BLENDING ───────────────────────────────────────────────────────────────
 * Snapping from the animated pose to physics on one frame is the classic
 * ragdoll "pop". `activate()` seeds body velocities from the pose motion of
 * the previous frames and then blends bone transforms from animated to
 * simulated over `RAGDOLL_BLEND_SECONDS` (120 ms).
 *
 * ── BUDGET ─────────────────────────────────────────────────────────────────
 * `RagdollManager` caps simultaneous ragdolls at 8. The ninth freezes the
 * oldest (bodies go fixed, joints stop solving) and fades it out, which is
 * both cheaper and less noticeable than deleting a body mid-view.
 */

import * as THREE from 'three';
import type { ImpulseJoint, RigidBody as RapierRigidBody } from '@dimforge/rapier3d-compat';
import type { BoneName, EntityId, IRagdoll, IRigidBody } from '@/types';
import { clamp01, smoothstep } from '@/util';
import { PhysicsBody } from './body';
import { groupsFor } from './layers';
import type { IRagdollRigSource } from './reference-rig';
import type { PhysicsWorld } from './world';
import {
  MAX_ACTIVE_RAGDOLLS,
  RAGDOLL_ANGULAR_DAMPING,
  RAGDOLL_BLEND_SECONDS,
  RAGDOLL_BODY_COUNT,
  RAGDOLL_DENSITY,
  RAGDOLL_FADE_SECONDS,
  RAGDOLL_LINEAR_DAMPING,
  RAGDOLL_MAX_IMPULSE_SPEED,
  RAGDOLL_SOLVER_ITERATIONS,
} from './constants';

/* -------------------------------------------------------------------------- */
/* Segment table                                                              */
/* -------------------------------------------------------------------------- */

/** The 13 simulated segments. */
export type RagdollSegmentName =
  | 'pelvis'
  | 'chest'
  | 'head'
  | 'leftUpperArm'
  | 'leftForeArm'
  | 'rightUpperArm'
  | 'rightForeArm'
  | 'leftThigh'
  | 'leftShin'
  | 'leftFoot'
  | 'rightThigh'
  | 'rightShin'
  | 'rightFoot';

/** Per-axis angular limit in radians, as [min, max]. */
export type AxisLimit = readonly [number, number];

/** Static description of one segment. */
export interface IRagdollSegmentSpec {
  readonly name: RagdollSegmentName;
  /** Bone the segment starts at; the body is anchored here. */
  readonly bone: BoneName;
  /** Bone the segment ends at; defines its direction and length. */
  readonly tipBone: BoneName;
  /** Parent segment, or undefined for the root. */
  readonly parent: RagdollSegmentName | undefined;
  /** Capsule radius as a fraction of total character height. */
  readonly radiusScale: number;
  /** Fallback length as a fraction of height, when the tip bone is missing. */
  readonly lengthScale: number;
  /** Angular limits about the joint frame's X/Y/Z, relative to the bind pose. */
  readonly limits: readonly [AxisLimit, AxisLimit, AxisLimit];
  /**
   * True for elbows and knees. The body's local X is aligned with the hinge
   * axis (the normal of the plane the parent and child bones span), so the
   * wide limit on AngX really is flexion and the tight limits on AngY/AngZ
   * really are twist and splay. Without this the axes mean whatever the
   * capsule alignment happened to produce.
   */
  readonly hinge?: boolean;
  /**
   * Hinge axis for a `hinge` segment, in the PARENT SEGMENT's local frame.
   *
   * The plane the two bones span cannot be the definition of the axis. It does
   * not exist at all for a straight limb — an exact T-pose, or any death pose
   * with an extended arm — and for a limb bent a degree the WRONG way its
   * normal points the wrong way, which mirrors the authored range and folds the
   * corpse backwards. This anatomical reference fixes the direction instead: a
   * positive rotation about it is flexion. The bone plane then only refines it.
   */
  readonly hingeAxis?: readonly [number, number, number];
}

const D = Math.PI / 180;

/**
 * The rig. Limits are deliberately tighter than human range: a ragdoll that
 * can reach its true anatomical extremes finds them, and a corpse folded in
 * half backwards reads as a bug, not as physics.
 */
export const RAGDOLL_SEGMENTS: readonly IRagdollSegmentSpec[] = [
  {
    name: 'pelvis',
    bone: 'Hips',
    tipBone: 'Spine1',
    parent: undefined,
    radiusScale: 0.075,
    lengthScale: 0.13,
    limits: [
      [0, 0],
      [0, 0],
      [0, 0],
    ],
  },
  {
    name: 'chest',
    bone: 'Spine1',
    tipBone: 'Neck',
    parent: 'pelvis',
    radiusScale: 0.085,
    lengthScale: 0.15,
    limits: [
      [-25 * D, 25 * D],
      [-30 * D, 30 * D],
      [-20 * D, 20 * D],
    ],
  },
  {
    name: 'head',
    bone: 'Head',
    tipBone: 'HeadTop_End',
    parent: 'chest',
    radiusScale: 0.065,
    lengthScale: 0.11,
    limits: [
      [-35 * D, 35 * D],
      [-45 * D, 45 * D],
      [-30 * D, 30 * D],
    ],
  },

  {
    name: 'leftUpperArm',
    bone: 'LeftArm',
    tipBone: 'LeftForeArm',
    parent: 'chest',
    radiusScale: 0.035,
    lengthScale: 0.16,
    limits: [
      [-80 * D, 80 * D],
      [-80 * D, 80 * D],
      [-80 * D, 80 * D],
    ],
  },
  {
    // Elbow: a hinge. Tight on two axes, one-directional on the third.
    // Flexion swings the hand toward the character's front, which is -X of the
    // upper arm's own frame on both sides.
    name: 'leftForeArm',
    hinge: true,
    hingeAxis: [-1, 0, 0],
    bone: 'LeftForeArm',
    tipBone: 'LeftHand',
    parent: 'leftUpperArm',
    radiusScale: 0.03,
    lengthScale: 0.15,
    limits: [
      [-5 * D, 125 * D],
      [-8 * D, 8 * D],
      [-8 * D, 8 * D],
    ],
  },
  {
    name: 'rightUpperArm',
    bone: 'RightArm',
    tipBone: 'RightForeArm',
    parent: 'chest',
    radiusScale: 0.035,
    lengthScale: 0.16,
    limits: [
      [-80 * D, 80 * D],
      [-80 * D, 80 * D],
      [-80 * D, 80 * D],
    ],
  },
  {
    name: 'rightForeArm',
    hinge: true,
    hingeAxis: [-1, 0, 0],
    bone: 'RightForeArm',
    tipBone: 'RightHand',
    parent: 'rightUpperArm',
    radiusScale: 0.03,
    lengthScale: 0.15,
    limits: [
      [-5 * D, 125 * D],
      [-8 * D, 8 * D],
      [-8 * D, 8 * D],
    ],
  },

  {
    name: 'leftThigh',
    bone: 'LeftUpLeg',
    tipBone: 'LeftLeg',
    parent: 'pelvis',
    radiusScale: 0.05,
    lengthScale: 0.24,
    limits: [
      [-60 * D, 60 * D],
      [-30 * D, 30 * D],
      [-35 * D, 35 * D],
    ],
  },
  {
    // Knee: hinge, bends one way only — the heel swings BACKWARDS, which is the
    // opposite world direction to an elbow and therefore +X of the thigh frame.
    name: 'leftShin',
    hinge: true,
    hingeAxis: [1, 0, 0],
    bone: 'LeftLeg',
    tipBone: 'LeftFoot',
    parent: 'leftThigh',
    radiusScale: 0.04,
    lengthScale: 0.24,
    limits: [
      [-5 * D, 130 * D],
      [-8 * D, 8 * D],
      [-8 * D, 8 * D],
    ],
  },
  {
    name: 'leftFoot',
    bone: 'LeftFoot',
    tipBone: 'LeftToeBase',
    parent: 'leftShin',
    radiusScale: 0.035,
    lengthScale: 0.09,
    limits: [
      [-30 * D, 30 * D],
      [-15 * D, 15 * D],
      [-15 * D, 15 * D],
    ],
  },
  {
    name: 'rightThigh',
    bone: 'RightUpLeg',
    tipBone: 'RightLeg',
    parent: 'pelvis',
    radiusScale: 0.05,
    lengthScale: 0.24,
    limits: [
      [-60 * D, 60 * D],
      [-30 * D, 30 * D],
      [-35 * D, 35 * D],
    ],
  },
  {
    name: 'rightShin',
    hinge: true,
    hingeAxis: [1, 0, 0],
    bone: 'RightLeg',
    tipBone: 'RightFoot',
    parent: 'rightThigh',
    radiusScale: 0.04,
    lengthScale: 0.24,
    limits: [
      [-5 * D, 130 * D],
      [-8 * D, 8 * D],
      [-8 * D, 8 * D],
    ],
  },
  {
    name: 'rightFoot',
    bone: 'RightFoot',
    tipBone: 'RightToeBase',
    parent: 'rightShin',
    radiusScale: 0.035,
    lengthScale: 0.09,
    limits: [
      [-30 * D, 30 * D],
      [-15 * D, 15 * D],
      [-15 * D, 15 * D],
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* Runtime segment                                                            */
/* -------------------------------------------------------------------------- */

/** A built segment: one body, its bone binding and its joint to the parent. */
export interface IRagdollSegment {
  readonly spec: IRagdollSegmentSpec;
  readonly body: PhysicsBody;
  readonly bone: THREE.Bone | undefined;
  /**
   * Joint attaching this segment to its parent; undefined for the root.
   * MUTABLE: cleared on dispose, because a freed Rapier joint handle traps the
   * wasm module the moment anything touches it.
   */
  joint: ImpulseJoint | undefined;
  /** Bone origin in the body's local frame. */
  readonly boneOffsetPosition: THREE.Vector3;
  /** Bone orientation in the body's local frame. */
  readonly boneOffsetRotation: THREE.Quaternion;
  /** Bone local transform at activation, blended out of over 120 ms. */
  readonly poseLocalPosition: THREE.Vector3;
  readonly poseLocalRotation: THREE.Quaternion;
  /** Previous world position of the bone, for velocity seeding. */
  readonly previousWorldPosition: THREE.Vector3;
}

export interface IRagdollOptions {
  /** Character height in metres; drives capsule sizing. */
  readonly height?: number;
  /** Total ragdoll mass in kg. Omit to derive from capsule volume. */
  readonly mass?: number;
  readonly entityId?: EntityId;
  /** Blend duration from animated pose to physics. */
  readonly blendSeconds?: number;
  /** Track bone motion while inactive so `activate` can seed velocities. */
  readonly seedVelocitiesFromPose?: boolean;
  /** Write body transforms back onto the skeleton. Off for headless tests. */
  readonly driveSkeleton?: boolean;
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpQuatB = new THREE.Quaternion();
const tmpMat = new THREE.Matrix4();
const tmpMatB = new THREE.Matrix4();
const REF_Z = new THREE.Vector3(0, 0, 1);
const REF_X = new THREE.Vector3(1, 0, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

let nextRagdollId = 1;

/* -------------------------------------------------------------------------- */
/* Ragdoll                                                                    */
/* -------------------------------------------------------------------------- */

export class Ragdoll implements IRagdoll {
  readonly id: number;
  readonly segments: readonly IRagdollSegment[];
  readonly entityId: EntityId | undefined;

  /** Seconds since the ragdoll was activated. */
  age = 0;
  /** 1 while visible, ramping to 0 once frozen. */
  fadeAlpha = 1;

  private readonly world: PhysicsWorld;
  private readonly rig: IRagdollRigSource;
  private readonly blendSeconds: number;
  private readonly seedVelocities: boolean;
  private readonly driveSkeleton: boolean;
  private readonly segmentByName = new Map<RagdollSegmentName, IRagdollSegment>();

  private activeFlag = false;
  private frozenFlag = false;
  private fadeElapsed = 0;
  private blendElapsed = 0;
  private poseTracked = false;
  /** `dt` of the `update()` that last recorded `previousWorldPosition`. */
  private lastTrackDt = 0;
  private disposed = false;

  constructor(
    world: PhysicsWorld,
    rig: IRagdollRigSource,
    segments: readonly IRagdollSegment[],
    options: IRagdollOptions
  ) {
    this.id = nextRagdollId++;
    this.world = world;
    this.rig = rig;
    this.segments = segments;
    this.entityId = options.entityId;
    this.blendSeconds = options.blendSeconds ?? RAGDOLL_BLEND_SECONDS;
    this.seedVelocities = options.seedVelocitiesFromPose ?? true;
    this.driveSkeleton = options.driveSkeleton ?? true;
    for (const segment of segments) this.segmentByName.set(segment.spec.name, segment);
  }

  get bodies(): readonly IRigidBody[] {
    return this.segments.map((s) => s.body);
  }

  get active(): boolean {
    return this.activeFlag;
  }

  /** True once the manager froze this ragdoll to stay within budget. */
  get frozen(): boolean {
    return this.frozenFlag;
  }

  /** 0 at activation, 1 once physics fully owns the pose. */
  get blend(): number {
    return this.blendSeconds <= 0 ? 1 : clamp01(this.blendElapsed / this.blendSeconds);
  }

  segment(name: RagdollSegmentName): IRagdollSegment | undefined {
    return this.segmentByName.get(name);
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Hand control to physics.
   *
   * Bodies are teleported onto the current bone transforms, seeded with the
   * velocity the bones were already moving at (so a character knocked out
   * mid-sprint keeps its momentum), then the optional impulse is applied.
   */
  activate(initialImpulse?: THREE.Vector3, impulsePoint?: THREE.Vector3): void {
    if (this.disposed || this.activeFlag) return;
    this.rig.root.updateMatrixWorld(true);

    for (const segment of this.segments) {
      this.placeBodyOnBone(segment);
      segment.body.setEnabled(true);
      // Through the wrapper, so `PhysicsBody.type` stays truthful after a
      // freeze/activate cycle.
      segment.body.setType('dynamic', this.world.rapier.RigidBodyType.Dynamic, true);

      // Capture the animated pose we are blending away from.
      if (segment.bone !== undefined) {
        segment.poseLocalPosition.copy(segment.bone.position);
        segment.poseLocalRotation.copy(segment.bone.quaternion);
      }
    }

    // `previousWorldPosition` was recorded one `update()` ago, so the bone
    // delta has to be divided by THAT frame's dt. Dividing by a hardcoded 1/60
    // seeds half the momentum on a 120 Hz phone and double it at 30 fps, which
    // is both wrong and frame-rate dependent — `update()` is driven with the
    // render delta, not `FIXED_STEP`.
    if (this.seedVelocities && this.poseTracked && this.lastTrackDt > 0) {
      const inverseDt = 1 / this.lastTrackDt;
      for (const segment of this.segments) {
        if (segment.bone === undefined) continue;
        segment.bone.getWorldPosition(tmpA);
        // Velocity over the last tracked frame; clamped so a teleporting
        // animation cannot launch the ragdoll into orbit.
        tmpB.subVectors(tmpA, segment.previousWorldPosition).multiplyScalar(inverseDt);
        if (tmpB.lengthSq() > 900) tmpB.setLength(30);
        segment.body.setLinearVelocity(tmpB);
      }
    }

    if (initialImpulse !== undefined) {
      const target = this.pickImpulseTarget(impulsePoint);
      target.wake();
      // Clamp to a speed the joints can actually hold; see the constant.
      const ceiling = target.mass * RAGDOLL_MAX_IMPULSE_SPEED;
      tmpB.copy(initialImpulse);
      if (tmpB.lengthSq() > ceiling * ceiling) tmpB.setLength(ceiling);
      target.applyImpulse(tmpB, impulsePoint);
    }

    this.activeFlag = true;
    this.blendElapsed = 0;
    this.age = 0;
  }

  /** Return control to the animator. Bodies stop simulating but survive. */
  deactivate(): void {
    if (!this.activeFlag) return;
    this.activeFlag = false;
    for (const segment of this.segments) {
      segment.body.setLinearVelocity(tmpA.set(0, 0, 0));
      segment.body.setAngularVelocity(tmpA.set(0, 0, 0));
      segment.body.setEnabled(false);
    }
  }

  /**
   * Stop simulating and start fading.
   *
   * Freezing rather than despawning is deliberate: the corpse stays exactly
   * where the player last saw it, costs nothing but a transform read, and the
   * fade hides the eventual removal.
   */
  freeze(): void {
    if (this.frozenFlag || this.disposed) return;
    this.frozenFlag = true;
    this.fadeElapsed = 0;
    for (const segment of this.segments) {
      segment.body.setLinearVelocity(tmpA.set(0, 0, 0));
      segment.body.setAngularVelocity(tmpA.set(0, 0, 0));
      // Fixed rather than disabled: the pose stays queryable and rendered.
      segment.body.setType('fixed', this.world.rapier.RigidBodyType.Fixed, false);
    }
  }

  /** Advance blending, fading and pose tracking. */
  update(dt: number): void {
    if (this.disposed) return;

    // The fade runs ahead of the activity check on purpose: a ragdoll frozen
    // while it was never active (adopted ahead of time, or handed back to the
    // animator) would otherwise never reach `expired`, and the manager would
    // hold its 13 bodies and 12 joints for the rest of the session.
    if (this.frozenFlag) {
      this.fadeElapsed += dt;
      this.fadeAlpha = clamp01(1 - this.fadeElapsed / RAGDOLL_FADE_SECONDS);
    }

    if (!this.activeFlag) {
      if (this.seedVelocities) {
        this.trackPose();
        this.lastTrackDt = dt;
      }
      return;
    }

    this.age += dt;
    if (this.blendElapsed < this.blendSeconds) this.blendElapsed += dt;

    if (this.driveSkeleton) this.syncToSkeleton();
  }

  /** True once a frozen ragdoll has finished fading and can be disposed. */
  get expired(): boolean {
    return this.frozenFlag && this.fadeAlpha <= 0;
  }

  /** True once disposed. Bodies and joints must not be touched after this. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /* ------------------------------------------------------------------ */
  /* Skeleton                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Copy body transforms onto the bones.
   *
   * Segments are processed root-first so a parent bone's world matrix is
   * current before a child converts its own world transform into local space.
   */
  syncToSkeleton(): void {
    const weight = smoothstep(0, 1, this.blend);
    const alpha = this.world.alpha;

    for (const segment of this.segments) {
      const bone = segment.bone;
      if (bone === undefined) continue;

      segment.body.getRenderTransform(tmpPos, tmpQuat, alpha);
      // Bone world transform = body transform * bind-time bone offset.
      tmpQuatB.copy(tmpQuat).multiply(segment.boneOffsetRotation);
      tmpA.copy(segment.boneOffsetPosition).applyQuaternion(tmpQuat).add(tmpPos);

      const parent = bone.parent;
      if (parent === null) continue;
      parent.updateWorldMatrix(true, false);
      tmpMatB.copy(parent.matrixWorld).invert();

      tmpMat.compose(tmpA, tmpQuatB, tmpScale.set(1, 1, 1));
      tmpMat.premultiply(tmpMatB);
      tmpMat.decompose(tmpA, tmpQuatB, tmpScale);

      if (weight >= 1) {
        bone.position.copy(tmpA);
        bone.quaternion.copy(tmpQuatB);
      } else {
        bone.position.lerpVectors(segment.poseLocalPosition, tmpA, weight);
        bone.quaternion.slerpQuaternions(segment.poseLocalRotation, tmpQuatB, weight);
      }
      bone.updateMatrix();
      bone.matrixWorld.multiplyMatrices(parent.matrixWorld, bone.matrix);
    }
  }

  /** Record bone world positions so `activate` can derive velocities. */
  private trackPose(): void {
    for (const segment of this.segments) {
      if (segment.bone === undefined) continue;
      segment.bone.getWorldPosition(segment.previousWorldPosition);
    }
    this.poseTracked = true;
  }

  private placeBodyOnBone(segment: IRagdollSegment): void {
    const bone = segment.bone;
    if (bone === undefined) return;
    bone.matrixWorld.decompose(tmpA, tmpQuat, tmpScale);
    // Undo the bind-time offset to recover the body transform.
    tmpQuatB.copy(tmpQuat).multiply(segment.boneOffsetRotation.clone().invert());
    tmpB.copy(segment.boneOffsetPosition).applyQuaternion(tmpQuatB);
    tmpA.sub(tmpB);
    segment.body.raw.setTranslation({ x: tmpA.x, y: tmpA.y, z: tmpA.z }, true);
    segment.body.raw.setRotation(
      { x: tmpQuatB.x, y: tmpQuatB.y, z: tmpQuatB.z, w: tmpQuatB.w },
      true
    );
    segment.body.setLinearVelocity(tmpB.set(0, 0, 0));
    segment.body.setAngularVelocity(tmpB.set(0, 0, 0));
    segment.body.snapshot();
    segment.body.advanceInterpolation();
  }

  /** Segment nearest an impulse point, or the pelvis when none is given. */
  private pickImpulseTarget(point: THREE.Vector3 | undefined): PhysicsBody {
    const root = this.segments[0]!.body;
    if (point === undefined) return root;
    let best = root;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const segment of this.segments) {
      segment.body.getTransform(tmpA, tmpQuat);
      const distance = tmpA.distanceToSquared(point);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = segment.body;
      }
    }
    return best;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.world.isDisposed) return;
    for (const segment of this.segments) {
      if (segment.joint !== undefined) {
        this.world.raw.removeImpulseJoint(segment.joint, false);
        // Drop the reference: reading a freed joint traps the wasm module.
        segment.joint = undefined;
      }
    }
    for (const segment of this.segments) this.world.removeBody(segment.body.handle);
    this.segmentByName.clear();
  }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build a ragdoll for a rig. Bodies start DISABLED — call `activate()` to hand
 * the skeleton over to physics.
 */
export function createRagdoll(
  world: PhysicsWorld,
  rig: IRagdollRigSource,
  options: IRagdollOptions = {}
): Ragdoll {
  const R = world.rapier;
  rig.root.updateMatrixWorld(true);

  const height = options.height ?? estimateRigHeight(rig);
  const segments: IRagdollSegment[] = [];
  const byName = new Map<RagdollSegmentName, IRagdollSegment>();
  /** Bone direction per segment, so a hinge child can see its parent's. */
  const directions = new Map<RagdollSegmentName, THREE.Vector3>();
  /** Segment tip per segment, so a child missing its start bone can anchor. */
  const segmentEnds = new Map<RagdollSegmentName, THREE.Vector3>();

  for (const spec of RAGDOLL_SEGMENTS) {
    const bone = rig.getBone(spec.bone);
    const tip = rig.getBone(spec.tipBone);

    // Segment geometry: start at the bone, end at the tip bone.
    const start = new THREE.Vector3();
    const end = new THREE.Vector3();
    if (bone !== undefined) {
      bone.getWorldPosition(start);
    } else {
      // A missing START bone must not leave the segment at the world origin:
      // the capsule would span from (0,0,0) to the character, and its joint
      // anchor there would drag the whole ragdoll across the map on the first
      // step. Anchor it on the parent's tip instead, which is where the bone
      // would have been.
      const parentEnd = spec.parent === undefined ? undefined : segmentEnds.get(spec.parent);
      if (parentEnd !== undefined) {
        start.copy(parentEnd);
      } else if (tip !== undefined) {
        tip.getWorldPosition(start);
        start.y += spec.lengthScale * height;
      } else {
        rig.root.getWorldPosition(start);
      }
    }
    if (tip !== undefined) {
      tip.getWorldPosition(end);
    } else {
      end.copy(start).addScaledVector(DOWN, spec.lengthScale * height);
    }

    let length = start.distanceTo(end);
    if (length < 1e-4) {
      length = spec.lengthScale * height;
      end.copy(start).addScaledVector(DOWN, length);
    }
    segmentEnds.set(spec.name, end.clone());
    const radius = Math.max(0.02, spec.radiusScale * height);
    const halfHeight = Math.max(0.01, length * 0.5 - radius);

    // Body sits at the segment midpoint, its local +Y along the bone.
    const centre = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
    const direction = new THREE.Vector3().subVectors(end, start).normalize();
    directions.set(spec.name, direction);

    const parentDirection = spec.parent === undefined ? undefined : directions.get(spec.parent);
    const parentSegmentForBasis = spec.parent === undefined ? undefined : byName.get(spec.parent);
    const rotation = segmentOrientation(spec, direction, parentDirection, parentSegmentForBasis);
    /**
     * Bind-pose bend at a hinge, in radians, SIGNED about the hinge axis the
     * rotation above encodes (its local +X). 0 when the limb starts straight,
     * negative when it starts hyperextended.
     */
    const bindBend =
      spec.hinge === true && parentDirection !== undefined
        ? signedBend(parentDirection, direction, REF_X.clone().applyQuaternion(rotation))
        : 0;

    const bodyDesc = R.RigidBodyDesc.dynamic()
      .setTranslation(centre.x, centre.y, centre.z)
      .setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w })
      .setLinearDamping(RAGDOLL_LINEAR_DAMPING)
      .setAngularDamping(RAGDOLL_ANGULAR_DAMPING)
      .setCanSleep(true)
      // Extra iterations only for ragdolls: joint chains are the one thing in
      // this game that genuinely needs them, and there are at most 8 of them.
      .setAdditionalSolverIterations(RAGDOLL_SOLVER_ITERATIONS)
      .setEnabled(false);
    const raw = world.raw.createRigidBody(bodyDesc);

    const colliderDesc = R.ColliderDesc.capsule(halfHeight, radius)
      .setDensity(RAGDOLL_DENSITY)
      .setFriction(0.8)
      .setRestitution(0.0)
      .setCollisionGroups(groupsFor('ragdoll', ['world', 'debris', 'player', 'monster']));
    const collider = world.raw.createCollider(colliderDesc, raw);

    // Only the ROOT carries the entity id. `world.byEntity` is single-valued, so
    // tagging all 13 would leave the last one registered — the right foot —
    // answering `getBodyByEntity`, and a bus-routed `ImpulseApplied` would yank
    // the corpse by one ankle instead of shoving it bodily. It also makes the
    // mapping survive: removing any one limb no longer orphans the entity.
    const segmentEntityId = spec.parent === undefined ? options.entityId : undefined;
    const body = new PhysicsBody(raw, collider, 'dynamic', 'ragdoll', segmentEntityId, () => {
      /* ragdolls never take continuous forces */
    });
    world.register(body);

    // Bind-time bone offset, so the bone can be recovered from the body later.
    const boneOffsetPosition = new THREE.Vector3();
    const boneOffsetRotation = new THREE.Quaternion();
    if (bone !== undefined) {
      const boneWorldQuat = new THREE.Quaternion();
      bone.getWorldQuaternion(boneWorldQuat);
      const invBody = rotation.clone().invert();
      boneOffsetPosition.copy(start).sub(centre).applyQuaternion(invBody);
      boneOffsetRotation.copy(invBody).multiply(boneWorldQuat);
    }

    let joint: ImpulseJoint | undefined;
    if (spec.parent !== undefined) {
      const parentSegment = byName.get(spec.parent);
      if (parentSegment !== undefined) {
        joint = attachJoint(world, parentSegment, body, rotation, start, spec, bindBend);
      }
    }

    const segment: IRagdollSegment = {
      spec,
      body,
      bone,
      joint,
      boneOffsetPosition,
      boneOffsetRotation,
      poseLocalPosition: bone !== undefined ? bone.position.clone() : new THREE.Vector3(),
      poseLocalRotation: bone !== undefined ? bone.quaternion.clone() : new THREE.Quaternion(),
      previousWorldPosition: start.clone(),
    };
    segments.push(segment);
    byName.set(spec.name, segment);
  }

  if (segments.length !== RAGDOLL_BODY_COUNT) {
    throw new Error(
      `createRagdoll: expected ${RAGDOLL_BODY_COUNT} segments, built ${segments.length}`
    );
  }

  // Optional exact total mass: scale every segment by the same factor.
  if (options.mass !== undefined && options.mass > 0) {
    let total = 0;
    for (const segment of segments) total += segment.body.mass;
    if (total > 0) {
      const factor = options.mass / total;
      for (const segment of segments) {
        segment.body.collider?.setDensity(RAGDOLL_DENSITY * factor);
        segment.body.raw.recomputeMassPropertiesFromColliders();
      }
    }
  }

  return new Ragdoll(world, rig, segments, options);
}

/**
 * Orientation for a segment's body: local +Y along the bone.
 *
 * The remaining roll is NOT arbitrary. Two rules:
 *
 *  • HINGES (elbows, knees) put local +X on the hinge axis, oriented so a
 *    positive rotation is more flexion. That is what makes "AngX in [-5, 125]
 *    degrees" mean "bends one way, does not hyperextend" rather than something
 *    arbitrary. The DIRECTION comes from `spec.hingeAxis`, an anatomical
 *    reference in the parent's frame; the normal of the plane the two bones
 *    span refines the exact axis, but only when it exists (the limb is bent)
 *    and agrees with anatomy. Deriving the axis from the bend alone mirrors the
 *    whole authored range for a straight or slightly hyperextended bind pose.
 *  • EVERYTHING ELSE picks a stable reference axis. `setFromUnitVectors(UP, d)`
 *    would be the obvious choice and is a trap: for a bone pointing straight
 *    DOWN — which is most of them — the source and target are antiparallel, the
 *    rotation axis is degenerate, and two nearly identical bones can end up
 *    180 degrees apart. Deriving an explicit basis avoids that entirely.
 */
function segmentOrientation(
  spec: IRagdollSegmentSpec,
  direction: THREE.Vector3,
  parentDirection: THREE.Vector3 | undefined,
  parentSegment: IRagdollSegment | undefined
): THREE.Quaternion {
  const y = direction.clone().normalize();
  const x = new THREE.Vector3();

  let haveHinge = false;
  if (spec.hinge === true) {
    const anatomical = anatomicalHingeAxis(spec, parentSegment, y);
    // Plane of the two bones: the exact hinge normal when the limb is bent, but
    // with a sign that says nothing about which way flexion goes.
    let bend: THREE.Vector3 | undefined;
    if (parentDirection !== undefined) {
      const candidate = new THREE.Vector3().crossVectors(parentDirection, y);
      if (candidate.lengthSq() > 1e-4) bend = candidate.normalize();
    }
    if (bend !== undefined && (anatomical === undefined || bend.dot(anatomical) > 0)) {
      x.copy(bend);
      haveHinge = true;
    } else if (anatomical !== undefined) {
      x.copy(anatomical);
      haveHinge = true;
    } else if (parentSegment !== undefined) {
      // Neither an authored axis nor a plane: inherit the parent's own frame so
      // at least the two hinges line up with each other.
      const r = parentSegment.body.raw.rotation();
      x.copy(REF_X).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
      haveHinge = x.lengthSq() > 1e-6;
    }
  }
  if (!haveHinge) {
    // Any axis not nearly parallel to the bone works and stays continuous.
    const reference = Math.abs(y.z) < 0.9 ? REF_Z : REF_X;
    x.copy(reference).cross(y);
    if (x.lengthSq() < 1e-8) x.copy(REF_X).cross(y);
  }

  // Re-orthogonalise, then complete a right-handed basis.
  x.addScaledVector(y, -x.dot(y));
  if (x.lengthSq() < 1e-8) x.set(1, 0, 0);
  x.normalize();
  const z = new THREE.Vector3().crossVectors(x, y);

  const basis = new THREE.Matrix4().makeBasis(x, y, z);
  return new THREE.Quaternion().setFromRotationMatrix(basis);
}

/**
 * `spec.hingeAxis` in world space, made perpendicular to the segment it swings.
 *
 * Undefined when the segment declares no axis or has no parent body to read a
 * frame from, which is the signal to fall back to the bone plane.
 */
function anatomicalHingeAxis(
  spec: IRagdollSegmentSpec,
  parentSegment: IRagdollSegment | undefined,
  boneDirection: THREE.Vector3
): THREE.Vector3 | undefined {
  const axis = spec.hingeAxis;
  if (axis === undefined || parentSegment === undefined) return undefined;
  const r = parentSegment.body.raw.rotation();
  const out = new THREE.Vector3(axis[0], axis[1], axis[2]).applyQuaternion(
    new THREE.Quaternion(r.x, r.y, r.z, r.w)
  );
  out.addScaledVector(boneDirection, -out.dot(boneDirection));
  return out.lengthSq() < 1e-8 ? undefined : out.normalize();
}

/** Clamp a dot product into acos's domain. */
function clampCos(value: number): number {
  return value < -1 ? -1 : value > 1 ? 1 : value;
}

/**
 * Angle from `a` to `b` measured about `axis`, in (-pi, pi].
 *
 * Signed, unlike `acos(a . b)`: a limb whose bind pose is bent the wrong way
 * reports a NEGATIVE bend, and its authored limits shift the other way instead
 * of being mirrored onto the hyperextension side.
 */
function signedBend(a: THREE.Vector3, b: THREE.Vector3, axis: THREE.Vector3): number {
  const cross = new THREE.Vector3().crossVectors(a, b);
  return Math.atan2(cross.dot(axis), clampCos(a.dot(b)));
}

/**
 * Spherical joint from `child` to `parentSegment`, re-based onto the bind pose
 * and limited on all three angular axes.
 *
 * `bindBend` is how far a hinge is already flexed in the bind pose, signed
 * about the hinge axis (negative for a hyperextended one). Hinge
 * limits are authored FROM STRAIGHT, so they are shifted by that amount here:
 * a knee bent 11 degrees in the death pose still gets its full "straighten to
 * 5 degrees of hyperextension, flex to 130" range rather than being locked
 * into whatever it happened to be doing when the character died.
 */
function attachJoint(
  world: PhysicsWorld,
  parentSegment: IRagdollSegment,
  child: PhysicsBody,
  childRotation: THREE.Quaternion,
  jointWorldPosition: THREE.Vector3,
  spec: IRagdollSegmentSpec,
  bindBend: number
): ImpulseJoint {
  const parentBody: RapierRigidBody = parentSegment.body.raw;
  const parentPos = parentBody.translation();
  const parentRot = parentBody.rotation();
  const parentQuat = tmpQuat.set(parentRot.x, parentRot.y, parentRot.z, parentRot.w);

  // Joint position in each body's local frame.
  const anchor1 = new THREE.Vector3(
    jointWorldPosition.x - parentPos.x,
    jointWorldPosition.y - parentPos.y,
    jointWorldPosition.z - parentPos.z
  ).applyQuaternion(tmpQuatB.copy(parentQuat).invert());

  const childPos = child.raw.translation();
  const anchor2 = new THREE.Vector3(
    jointWorldPosition.x - childPos.x,
    jointWorldPosition.y - childPos.y,
    jointWorldPosition.z - childPos.z
  ).applyQuaternion(tmpQuatB.copy(childRotation).invert());

  const R = world.rapier;
  const data = R.JointData.spherical(
    { x: anchor1.x, y: anchor1.y, z: anchor1.z },
    { x: anchor2.x, y: anchor2.y, z: anchor2.z }
  );
  const joint = world.raw.createImpulseJoint(data, parentBody, child.raw, true);

  // Re-base the joint frame onto the bind pose: frame1 = qParent^-1 * qChild,
  // frame2 = identity. Limits are then measured from the pose, not from
  // "both bodies aligned".
  const relative = tmpQuatB.copy(parentQuat).invert().multiply(childRotation);
  joint.setLocalFrame1(
    { x: anchor1.x, y: anchor1.y, z: anchor1.z },
    { x: relative.x, y: relative.y, z: relative.z, w: relative.w }
  );
  joint.setLocalFrame2({ x: anchor2.x, y: anchor2.y, z: anchor2.z }, { x: 0, y: 0, z: 0, w: 1 });

  for (let axis = 0; axis < 3; axis++) {
    let [min, max] = spec.limits[axis]!;
    if (axis === 0 && spec.hinge === true && bindBend !== 0) {
      min -= bindBend;
      max -= bindBend;
      // Never invert the range if the bind pose is already past the limit.
      if (max < min) max = min;
    }
    // Angular axes are 3, 4, 5 (AngX/AngY/AngZ) in Rapier's axis enum.
    setJointAngularLimit(world, joint.handle, 3 + axis, min, max);
  }
  return joint;
}

/**
 * Set an angular limit on a joint axis.
 *
 * Rapier's typed wrapper only surfaces `setLimits` on single-axis joints
 * (revolute, prismatic), yet the underlying generic joint — which is what a
 * spherical joint actually is — supports limits on all three angular axes, and
 * the raw joint set exposes them. `RawJointAxis` is not re-exported from the
 * package root, so the axis index is passed as a plain number through this one
 * narrow, documented cast rather than sprinkling `any` at each call site.
 */
interface IRawJointLimits {
  jointSetLimits(handle: number, axis: number, min: number, max: number): void;
}

function setJointAngularLimit(
  world: PhysicsWorld,
  jointHandle: number,
  axis: number,
  min: number,
  max: number
): void {
  const raw = world.raw.impulseJoints.raw as unknown as IRawJointLimits;
  raw.jointSetLimits(jointHandle, axis, min, max);
}

/** Height of a rig, measured from its lowest foot to the top of the head. */
export function estimateRigHeight(rig: IRagdollRigSource): number {
  const head = rig.getBone('HeadTop_End') ?? rig.getBone('Head');
  const foot = rig.getBone('LeftFoot') ?? rig.getBone('RightFoot');
  if (head === undefined || foot === undefined) return 1.75;
  head.getWorldPosition(tmpA);
  foot.getWorldPosition(tmpB);
  return Math.max(0.5, tmpA.y - tmpB.y + 0.1);
}

/* -------------------------------------------------------------------------- */
/* Manager                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Budget keeper for ragdolls.
 *
 * A city fight can drop a dozen bodies in a second. Simulating all of them is
 * both unaffordable and pointless — the player is looking at one. The manager
 * keeps the `maxActive` most recent simulating and freezes the rest.
 */
export class RagdollManager {
  readonly maxActive: number;
  private readonly world: PhysicsWorld;
  /** Active ragdolls, oldest first. */
  private readonly live: Ragdoll[] = [];
  private disposed = false;

  constructor(world: PhysicsWorld, maxActive = MAX_ACTIVE_RAGDOLLS) {
    this.world = world;
    this.maxActive = maxActive;
  }

  /**
   * Ragdolls currently simulating (frozen ones do not count).
   *
   * `active` matters as much as `frozen`: a ragdoll built ahead of a boss death
   * or handed back to the animator costs the solver nothing, so it must neither
   * consume budget nor be picked as a freeze victim.
   */
  get activeCount(): number {
    let n = 0;
    for (const ragdoll of this.live) if (ragdoll.active && !ragdoll.frozen) n++;
    return n;
  }

  /** Every ragdoll the manager owns, including fading ones. */
  get all(): readonly Ragdoll[] {
    return this.live;
  }

  /**
   * Build and activate a ragdoll, freezing the oldest if that would exceed the
   * budget.
   */
  spawn(
    rig: IRagdollRigSource,
    options: IRagdollOptions = {},
    initialImpulse?: THREE.Vector3,
    impulsePoint?: THREE.Vector3
  ): Ragdoll {
    const ragdoll = createRagdoll(this.world, rig, options);
    // Activate BEFORE adopting: the budget is counted over active ragdolls, so
    // an inactive newcomer would not push the count over the cap and the oldest
    // would never be frozen.
    ragdoll.activate(initialImpulse, impulsePoint);
    this.adopt(ragdoll);
    return ragdoll;
  }

  /** Track an externally created ragdoll under the same budget. */
  adopt(ragdoll: Ragdoll): void {
    this.live.push(ragdoll);
    this.enforceBudget();
  }

  private enforceBudget(): void {
    let over = this.activeCount - this.maxActive;
    if (over <= 0) return;
    for (const ragdoll of this.live) {
      if (over <= 0) break;
      if (!ragdoll.active || ragdoll.frozen) continue;
      ragdoll.freeze();
      over--;
    }
  }

  update(dt: number): void {
    if (this.disposed) return;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const ragdoll = this.live[i]!;
      ragdoll.update(dt);
      if (ragdoll.expired) {
        ragdoll.dispose();
        this.live.splice(i, 1);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const ragdoll of this.live) ragdoll.dispose();
    this.live.length = 0;
  }
}
