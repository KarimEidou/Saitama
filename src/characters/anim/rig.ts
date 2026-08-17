/**
 * RIG RESOLUTION — measuring the body the animation has to fit
 *
 * Turns a `THREE.Skeleton` into flat arrays plus a table of MEASURED body
 * dimensions. Everything downstream — stride length, cadence, arm swing,
 * ankle lift, IK reach — is expressed as a multiple of a number taken from
 * here rather than as a constant in metres.
 *
 * ── WHY MEASURE INSTEAD OF READING `BodyProfile` ──────────────────────────
 * `BodyProfile` states intent ("height 1.75, limbLength 1.0"). The skeleton
 * states what was built, after archetype tweaks, head-scale renormalisation
 * and the height clamp. Locomotion cares about the built leg, not the
 * requested one — a monster's `limbLength: 1.08` combined with its archetype
 * tweak produces a leg the profile never names. Measuring also means this
 * system works on ANY Mixamo-named skeleton, including one that arrives from
 * a GLB rather than from the generator.
 *
 * ── BIND POSE FROM THE INVERSE MATRICES ───────────────────────────────────
 * Model-space bind positions come from `skeleton.boneInverses`, not from the
 * bones' current transforms. By the time an animator attaches, something may
 * already have posed the skeleton; the inverse-bind matrices are the one
 * snapshot that cannot have drifted, because the skinned mesh is defined
 * against them.
 */

import * as THREE from 'three';
import type { BodyProfile, BoneName } from '@/types';
import { createLogger } from '@/util';
import { createPose } from './pose';
import type { AnimRig, BodyMetrics, Pose, RigLike } from './types';

const log = createLogger('anim:rig');

/** Canonical bone order. Parents strictly before children. */
export const ANIM_BONE_ORDER: readonly BoneName[] = [
  'Hips',
  'Spine',
  'Spine1',
  'Spine2',
  'Neck',
  'Head',
  'HeadTop_End',
  'LeftShoulder',
  'LeftArm',
  'LeftForeArm',
  'LeftHand',
  'LeftHandIndex1',
  'LeftHandThumb1',
  'RightShoulder',
  'RightArm',
  'RightForeArm',
  'RightHand',
  'RightHandIndex1',
  'RightHandThumb1',
  'LeftUpLeg',
  'LeftLeg',
  'LeftFoot',
  'LeftToeBase',
  'RightUpLeg',
  'RightLeg',
  'RightFoot',
  'RightToeBase',
];

/** The reference adult every duration and amplitude constant was tuned on. */
export const REFERENCE_HEIGHT = 1.75;
/** Leg length of that reference adult, metres. */
export const REFERENCE_LEG = 0.86;

/* -------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a skeleton into the flattened rig the evaluator works on.
 *
 * Tolerant by design: a rig missing fingers, toes or even a shoulder still
 * animates, because asset coverage lands incrementally across workstreams and
 * an animator that throws on a partial rig blocks everyone downstream.
 */
export function resolveRig(source: RigLike): AnimRig {
  const bones = source.skeleton.bones;
  const boneCount = bones.length;

  const index: Partial<Record<BoneName, number>> = {};
  const byObject = new Map<THREE.Object3D, number>();
  for (let i = 0; i < boneCount; i++) {
    const bone = bones[i]!;
    byObject.set(bone, i);
    const name = stripMixamoPrefix(bone.name) as BoneName;
    if (index[name] === undefined) index[name] = i;
  }

  const parent = new Int32Array(boneCount);
  for (let i = 0; i < boneCount; i++) {
    const p = bones[i]!.parent;
    const found = p === null ? undefined : byObject.get(p);
    parent[i] = found === undefined ? -1 : found;
  }
  assertParentsFirst(parent);

  // Rest pose: the bones' own local transforms. An animator attaches straight
  // after construction, so these are the bind locals.
  const rest: Pose = createPose(boneCount);
  let identityRest = true;
  for (let i = 0; i < boneCount; i++) {
    const bone = bones[i]!;
    const o4 = i * 4;
    const o3 = i * 3;
    rest.rot[o4] = bone.quaternion.x;
    rest.rot[o4 + 1] = bone.quaternion.y;
    rest.rot[o4 + 2] = bone.quaternion.z;
    rest.rot[o4 + 3] = bone.quaternion.w;
    rest.pos[o3] = bone.position.x;
    rest.pos[o3 + 1] = bone.position.y;
    rest.pos[o3 + 2] = bone.position.z;
    if (Math.abs(bone.quaternion.w) < 0.99999) identityRest = false;
  }

  const boneInverses = source.skeleton.boneInverses;
  const bindModel = new Float32Array(boneCount * 3);
  const scratch = new THREE.Matrix4();
  const position = new THREE.Vector3();
  for (let i = 0; i < boneCount; i++) {
    const inverse = boneInverses[i];
    if (inverse !== undefined) {
      scratch.copy(inverse).invert();
      position.setFromMatrixPosition(scratch);
    } else {
      position.set(rest.pos[i * 3]!, rest.pos[i * 3 + 1]!, rest.pos[i * 3 + 2]!);
    }
    bindModel[i * 3] = position.x;
    bindModel[i * 3 + 1] = position.y;
    bindModel[i * 3 + 2] = position.z;
  }

  const metrics = measureBody(index, bindModel, source.profile);
  if (!identityRest) {
    log.warn(
      'rig rests with non-identity bone rotations; procedural hinge axes are approximate'
    );
  }

  return {
    bones,
    boneCount,
    index,
    parent,
    rest,
    bindModel,
    boneInverses,
    metrics,
    profile: source.profile,
    identityRest,
  };
}

/** Mixamo GLBs prefix every bone; the canonical vocabulary does not. */
function stripMixamoPrefix(name: string): string {
  return name.startsWith('mixamorig:') ? name.slice(10) : name;
}

/**
 * The evaluator does forward kinematics in one pass over the bone array, which
 * is only correct when parents precede children. The generator guarantees it;
 * a GLB might not, so it is checked rather than assumed.
 */
function assertParentsFirst(parent: Int32Array): void {
  for (let i = 0; i < parent.length; i++) {
    if (parent[i]! >= i) {
      throw new Error(
        `anim: bone ${i} has parent ${parent[i]} — skeletons must list parents before children`
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Measurement                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Ratio of heel-behind-ankle to toe-ahead-of-ankle.
 *
 * The heel is not a bone, so it cannot be measured. In an adult foot the ankle
 * sits about a quarter of the way back along the sole, which is where this
 * number comes from; it only affects where the foot pivots at heel strike.
 */
const HEEL_RATIO = 0.28;

function measureBody(
  index: Partial<Record<BoneName, number>>,
  bindModel: Float32Array,
  profile: BodyProfile
): BodyMetrics {
  const at = (name: BoneName, out: THREE.Vector3): THREE.Vector3 => {
    const i = index[name];
    if (i === undefined) return out.set(0, 0, 0);
    return out.set(bindModel[i * 3]!, bindModel[i * 3 + 1]!, bindModel[i * 3 + 2]!);
  };
  const has = (name: BoneName): boolean => index[name] !== undefined;

  const hip = at('LeftUpLeg', _a);
  const knee = at('LeftLeg', _b);
  const ankle = at('LeftFoot', _c);
  const toe = at('LeftToeBase', _d);

  const thigh = hip.distanceTo(knee) || 0.42;
  const shank = knee.distanceTo(ankle) || 0.42;
  const hipHeight = hip.y > 0 ? hip.y : profile.height * 0.53;
  const ankleHeight = Math.max(ankle.y, 0.012 * profile.height);
  const legLength = Math.max(hipHeight - ankleHeight, 0.2);

  // The toe bone sits forward and slightly below the ankle; the forward
  // component is the part that matters for the foot roll.
  const footForward = has('LeftToeBase') ? Math.abs(toe.z - ankle.z) : 0.1 * profile.height;
  const heelBack = footForward * HEEL_RATIO;

  const shoulderL = at('LeftArm', _a);
  const shoulderR = at('RightArm', _b);
  const elbow = at('LeftForeArm', _c);
  const wrist = at('LeftHand', _d);
  const upperArm = shoulderL.distanceTo(elbow) || 0.3;
  const foreArm = elbow.distanceTo(wrist) || 0.25;
  const armRestDir = elbow.clone().sub(shoulderL);
  if (armRestDir.lengthSq() < 1e-10) armRestDir.set(-1, 0, 0);
  armRestDir.normalize();

  const hipL = at('LeftUpLeg', _a);
  const hipR = at('RightUpLeg', _b);
  const hipHalfWidth = Math.max(Math.abs(hipL.x - hipR.x) * 0.5, 0.02 * profile.height);
  const shoulderHalfWidth = Math.max(
    Math.abs(shoulderL.x - shoulderR.x) * 0.5,
    hipHalfWidth * 1.05
  );

  const hips = at('Hips', _a);
  const neck = at('Neck', _b);
  const spineHeight = Math.max(neck.y - hips.y, 0.1);

  const crown = has('HeadTop_End') ? at('HeadTop_End', _c).y : at('Head', _c).y * 1.14;
  const height = crown > 0.2 ? crown : profile.height;

  return {
    height,
    hipHeight,
    legLength,
    thigh,
    shank,
    ankleHeight,
    footForward,
    heelBack,
    hipHalfWidth,
    shoulderHalfWidth,
    upperArm,
    foreArm,
    armLength: upperArm + foreArm,
    spineHeight,
    armRestDir,
    scale: height / REFERENCE_HEIGHT,
  };
}

/* -------------------------------------------------------------------------- */
/* Derived timing                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Time scale for the fixed-duration clips.
 *
 * A limb is a pendulum, and a pendulum's period goes as the square root of its
 * length. That single fact is why a child's punch is snappier than a monster's
 * without either being animated separately: the clip is the same function of
 * normalised time, and only the clock changes. Scaling by height instead —
 * the obvious guess — makes small characters look like fast-forwarded adults
 * and large ones look like slow motion, which is exactly the artefact this
 * avoids.
 */
export function clipTimeScale(metrics: BodyMetrics): number {
  return Math.sqrt(Math.max(metrics.legLength, 0.05) / REFERENCE_LEG);
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
