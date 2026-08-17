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
    name: 'leftForeArm',
    hinge: true,
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
    // Knee: hinge, bends one way only.
    name: 'leftShin',
    hinge: true,
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
      segment.body.raw.setBodyType(this.world.rapier.RigidBodyType.Dynamic, true);

      // Capture the animated pose we are blending away from.
      if (segment.bone !== undefined) {
        segment.poseLocalPosition.copy(segment.bone.position);
        segment.poseLocalRotation.copy(segment.bone.quaternion);
      }
    }

    if (this.seedVelocities && this.poseTracked) {
      for (const segment of this.segments) {
        if (segment.bone === undefined) continue;
        segment.bone.getWorldPosition(tmpA);
        // Velocity over the last tracked frame; clamped so a teleporting
        // animation cannot launch the ragdoll into orbit.
        tmpB.subVectors(tmpA, segment.previousWorldPosition).multiplyScalar(60);
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
      segment.body.raw.setBodyType(this.world.rapier.RigidBodyType.Fixed, false);
    }
  }

  /** Advance blending, fading and pose tracking. */
  update(dt: number): void {
    if (this.disposed) return;

    if (!this.activeFlag) {
      if (this.seedVelocities) this.trackPose();
      return;
    }

    this.age += dt;
    if (this.blendElapsed < this.blendSeconds) this.blendElapsed += dt;

    if (this.frozenFlag) {
      this.fadeElapsed += dt;
      this.fadeAlpha = clamp01(1 - this.fadeElapsed / RAGDOLL_FADE_SECONDS);
    }

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

  for (const spec of RAGDOLL_SEGMENTS) {
    const bone = rig.getBone(spec.bone);
    const tip = rig.getBone(spec.tipBone);

    // Segment geometry: start at the bone, end at the tip bone.
    const start = new THREE.Vector3();
    const end = new THREE.Vector3();
    if (bone !== undefined) bone.getWorldPosition(start);
    if (tip !== undefined) {
      tip.getWorldPosition(end);
    } else {
      end.copy(start).addScaledVector(new THREE.Vector3(0, -1, 0), spec.lengthScale * height);
    }

    let length = start.distanceTo(end);
    if (length < 1e-4) {
      length = spec.lengthScale * height;
      end.copy(start).addScaledVector(new THREE.Vector3(0, -1, 0), length);
    }
    const radius = Math.max(0.02, spec.radiusScale * height);
    const halfHeight = Math.max(0.01, length * 0.5 - radius);

    // Body sits at the segment midpoint, its local +Y along the bone.
    const centre = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
    const direction = new THREE.Vector3().subVectors(end, start).normalize();
    directions.set(spec.name, direction);

    const parentDirection =
      spec.parent === undefined ? undefined : directions.get(spec.parent);
    const parentSegmentForBasis = spec.parent === undefined ? undefined : byName.get(spec.parent);
    const rotation = segmentOrientation(
      spec,
      direction,
      parentDirection,
      parentSegmentForBasis
    );
    /** Bind-pose bend at a hinge, in radians. 0 when the limb starts straight. */
    const bindBend =
      spec.hinge === true && parentDirection !== undefined
        ? Math.acos(clampCos(parentDirection.dot(direction)))
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

    const body = new PhysicsBody(raw, collider, 'dynamic', 'ragdoll', options.entityId, () => {
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
    throw new Error(`createRagdoll: expected ${RAGDOLL_BODY_COUNT} segments, built ${segments.length}`);
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
 *  • HINGES (elbows, knees) put local +X on the hinge axis — the normal of the
 *    plane the parent and child bones span, oriented so a positive rotation is
 *    more flexion. That is what makes "AngX in [-5, 125] degrees" mean
 *    "bends one way, does not hyperextend" rather than something arbitrary.
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
  if (spec.hinge === true && parentDirection !== undefined) {
    x.copy(parentDirection).cross(y);
    // Colinear bones (a straight limb in the bind pose) give no plane; fall
    // back to the parent's own hinge frame so the axes still line up.
    if (x.lengthSq() > 1e-4) {
      x.normalize();
      haveHinge = true;
    }
  }
  if (!haveHinge && parentSegment !== undefined && spec.hinge === true) {
    const parentRotation = parentSegment.body.raw.rotation();
    x.set(1, 0, 0).applyQuaternion(
      new THREE.Quaternion(parentRotation.x, parentRotation.y, parentRotation.z, parentRotation.w)
    );
    haveHinge = x.lengthSq() > 1e-6;
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

/** Clamp a dot product into acos's domain. */
function clampCos(value: number): number {
  return value < -1 ? -1 : value > 1 ? 1 : value;
}

/**
 * Spherical joint from `child` to `parentSegment`, re-based onto the bind pose
 * and limited on all three angular axes.
 *
 * `bindBend` is how far a hinge is already flexed in the bind pose. Hinge
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

  /** Ragdolls currently simulating (frozen ones do not count). */
  get activeCount(): number {
    let n = 0;
    for (const ragdoll of this.live) if (!ragdoll.frozen) n++;
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
    this.adopt(ragdoll);
    ragdoll.activate(initialImpulse, impulsePoint);
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
      if (ragdoll.frozen) continue;
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
