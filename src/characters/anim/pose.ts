/**
 * POSE BUFFERS
 *
 * A pose is 27 local rotations plus 27 local translations in two flat
 * Float32Arrays, and every operation here writes into a caller-supplied
 * output. Nothing in this file allocates after startup, because these run
 * several times per character per frame and again for every frame the VAT
 * baker emits.
 *
 * ── WHY NLERP, NOT SLERP ──────────────────────────────────────────────────
 * Blending is normalised-lerp with a hemisphere fix, not slerp. Slerp is the
 * constant-angular-velocity answer, but it costs an acos, a sin and two
 * divides per bone and only differs measurably from nlerp beyond ~60° of
 * separation. Poses being blended are crossfades between neighbouring
 * performances or a mask between body halves — a few degrees apart, where the
 * two are indistinguishable. The hemisphere fix is NOT optional: without it a
 * blend between q and -q (the same orientation) takes the long way round and
 * the character folds inside out for the duration of the fade.
 */

import * as THREE from 'three';
import type { BoneName } from '@/types';
import { clamp01 } from '@/util';
import type { AnimRig, BoneMask, Pose } from './types';

/* -------------------------------------------------------------------------- */
/* Construction                                                               */
/* -------------------------------------------------------------------------- */

/** An identity pose: every rotation identity, every translation zero. */
export function createPose(boneCount: number): Pose {
  const rot = new Float32Array(boneCount * 4);
  for (let i = 0; i < boneCount; i++) rot[i * 4 + 3] = 1;
  return { boneCount, rot, pos: new Float32Array(boneCount * 3) };
}

/** Copy `src` into `dst`. */
export function copyPose(dst: Pose, src: Pose): Pose {
  dst.rot.set(src.rot);
  dst.pos.set(src.pos);
  return dst;
}

/** Reset `dst` to the rig's rest pose. */
export function resetPose(dst: Pose, rig: AnimRig): Pose {
  return copyPose(dst, rig.rest);
}

/* -------------------------------------------------------------------------- */
/* Accessors                                                                  */
/* -------------------------------------------------------------------------- */

/** Read one bone's rotation into `out`. */
export function getRotation(pose: Pose, bone: number, out: THREE.Quaternion): THREE.Quaternion {
  const o = bone * 4;
  return out.set(pose.rot[o]!, pose.rot[o + 1]!, pose.rot[o + 2]!, pose.rot[o + 3]!);
}

/** Write one bone's rotation. */
export function setRotation(pose: Pose, bone: number, q: THREE.Quaternion): void {
  const o = bone * 4;
  pose.rot[o] = q.x;
  pose.rot[o + 1] = q.y;
  pose.rot[o + 2] = q.z;
  pose.rot[o + 3] = q.w;
}

/** Read one bone's translation into `out`. */
export function getTranslation(pose: Pose, bone: number, out: THREE.Vector3): THREE.Vector3 {
  const o = bone * 3;
  return out.set(pose.pos[o]!, pose.pos[o + 1]!, pose.pos[o + 2]!);
}

/** Write one bone's translation. */
export function setTranslation(pose: Pose, bone: number, v: THREE.Vector3): void {
  const o = bone * 3;
  pose.pos[o] = v.x;
  pose.pos[o + 1] = v.y;
  pose.pos[o + 2] = v.z;
}

/**
 * Compose an Euler-style rotation onto a bone, in the bone's own local frame.
 *
 * The rig rests with identity rotations (see the mesh generator's `rig.ts`),
 * which is precisely what makes this useful: "bend the elbow" is one axis and
 * one angle, with no per-bone roll basis to consult.
 */
export function rotateBone(
  pose: Pose,
  bone: number,
  axis: 'x' | 'y' | 'z',
  angle: number,
  scratch = _q0
): void {
  if (angle === 0) return;
  const half = angle * 0.5;
  const s = Math.sin(half);
  scratch.set(axis === 'x' ? s : 0, axis === 'y' ? s : 0, axis === 'z' ? s : 0, Math.cos(half));
  const o = bone * 4;
  _q1.set(pose.rot[o]!, pose.rot[o + 1]!, pose.rot[o + 2]!, pose.rot[o + 3]!);
  _q1.multiply(scratch);
  setRotation(pose, bone, _q1);
}

/** Replace a bone's rotation with an XYZ Euler triple (applied Z, then Y, then X). */
export function setEuler(pose: Pose, bone: number, x: number, y: number, z: number): void {
  _e0.set(x, y, z, 'XYZ');
  _q0.setFromEuler(_e0);
  setRotation(pose, bone, _q0);
}

/* -------------------------------------------------------------------------- */
/* Blending                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `out = lerp(a, b, t)` over the whole skeleton.
 *
 * Safe when `out` aliases `a` or `b`.
 */
export function blendPose(out: Pose, a: Pose, b: Pose, t: number): Pose {
  const w = clamp01(t);
  if (w <= 0) return out === a ? out : copyPose(out, a);
  if (w >= 1) return out === b ? out : copyPose(out, b);
  const n = out.boneCount;
  const ar = a.rot;
  const br = b.rot;
  const or_ = out.rot;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const ax = ar[o]!;
    const ay = ar[o + 1]!;
    const az = ar[o + 2]!;
    const aw = ar[o + 3]!;
    let bx = br[o]!;
    let by = br[o + 1]!;
    let bz = br[o + 2]!;
    let bw = br[o + 3]!;
    // Hemisphere fix: q and -q are the same orientation but lerp between them
    // passes through zero and comes out the long way.
    if (ax * bx + ay * by + az * bz + aw * bw < 0) {
      bx = -bx;
      by = -by;
      bz = -bz;
      bw = -bw;
    }
    let x = ax + (bx - ax) * w;
    let y = ay + (by - ay) * w;
    let z = az + (bz - az) * w;
    let s = aw + (bw - aw) * w;
    const len = Math.sqrt(x * x + y * y + z * z + s * s);
    if (len > 1e-8) {
      const inv = 1 / len;
      x *= inv;
      y *= inv;
      z *= inv;
      s *= inv;
    } else {
      x = 0;
      y = 0;
      z = 0;
      s = 1;
    }
    or_[o] = x;
    or_[o + 1] = y;
    or_[o + 2] = z;
    or_[o + 3] = s;
  }
  const ap = a.pos;
  const bp = b.pos;
  const op = out.pos;
  for (let i = 0; i < n * 3; i++) op[i] = ap[i]! + (bp[i]! - ap[i]!) * w;
  return out;
}

/**
 * `out = lerp(out, b, t * mask[bone])` — a layered blend.
 *
 * This is what lets Saitama punch while running: the lower body keeps the
 * locomotion pose at mask 0 and the arms take the punch at mask 1, with the
 * spine feathered in between so the two halves do not shear at the waist.
 */
export function blendPoseMasked(out: Pose, b: Pose, t: number, mask: BoneMask): Pose {
  const n = out.boneCount;
  const or_ = out.rot;
  const br = b.rot;
  for (let i = 0; i < n; i++) {
    const w = clamp01(t * mask[i]!);
    if (w <= 0) continue;
    const o = i * 4;
    const ax = or_[o]!;
    const ay = or_[o + 1]!;
    const az = or_[o + 2]!;
    const aw = or_[o + 3]!;
    let bx = br[o]!;
    let by = br[o + 1]!;
    let bz = br[o + 2]!;
    let bw = br[o + 3]!;
    if (ax * bx + ay * by + az * bz + aw * bw < 0) {
      bx = -bx;
      by = -by;
      bz = -bz;
      bw = -bw;
    }
    let x = ax + (bx - ax) * w;
    let y = ay + (by - ay) * w;
    let z = az + (bz - az) * w;
    let s = aw + (bw - aw) * w;
    const len = Math.sqrt(x * x + y * y + z * z + s * s);
    const inv = len > 1e-8 ? 1 / len : 0;
    or_[o] = len > 1e-8 ? x * inv : 0;
    or_[o + 1] = len > 1e-8 ? y * inv : 0;
    or_[o + 2] = len > 1e-8 ? z * inv : 0;
    or_[o + 3] = len > 1e-8 ? s * inv : 1;
  }
  const op = out.pos;
  const bp = b.pos;
  for (let i = 0; i < n; i++) {
    const w = clamp01(t * mask[i]!);
    if (w <= 0) continue;
    const o = i * 3;
    op[o] = op[o]! + (bp[o]! - op[o]!) * w;
    op[o + 1] = op[o + 1]! + (bp[o + 1]! - op[o + 1]!) * w;
    op[o + 2] = op[o + 2]! + (bp[o + 2]! - op[o + 2]!) * w;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Masks                                                                      */
/* -------------------------------------------------------------------------- */

/** Bones the upper-body layer owns outright. */
export const UPPER_BODY_BONES: readonly BoneName[] = [
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
];

/** Feathered weights on the spine, so the two halves meet without a shear. */
const SPINE_FEATHER: Readonly<Partial<Record<BoneName, number>>> = {
  Hips: 0,
  Spine: 0.35,
  Spine1: 0.7,
};

/**
 * Build the upper-body mask.
 *
 * The feather matters more than it looks: masking hard at `Spine2` puts the
 * entire punch rotation into one joint, and the character's waist visibly
 * snaps. Spreading 35 % / 70 % / 100 % down the spine stack costs nothing and
 * is the difference between a layered punch reading as one motion and reading
 * as two animations glued together.
 */
export function upperBodyMask(rig: AnimRig): BoneMask {
  const mask = new Float32Array(rig.boneCount);
  for (const name of UPPER_BODY_BONES) {
    const i = rig.index[name];
    if (i !== undefined) mask[i] = 1;
  }
  for (const [name, weight] of Object.entries(SPINE_FEATHER)) {
    const i = rig.index[name as BoneName];
    if (i !== undefined) mask[i] = weight;
  }
  return mask;
}

/** The complement of `upperBodyMask`, for lower-body-only layers. */
export function lowerBodyMask(rig: AnimRig): BoneMask {
  const upper = upperBodyMask(rig);
  const mask = new Float32Array(rig.boneCount);
  for (let i = 0; i < rig.boneCount; i++) mask[i] = 1 - upper[i]!;
  return mask;
}

/** A mask that selects a bone and everything under it. */
export function subtreeMask(rig: AnimRig, root: BoneName, weight = 1): BoneMask {
  const mask = new Float32Array(rig.boneCount);
  const rootIndex = rig.index[root];
  if (rootIndex === undefined) return mask;
  mask[rootIndex] = weight;
  for (let i = rootIndex + 1; i < rig.boneCount; i++) {
    const parent = rig.parent[i]!;
    if (parent >= 0 && mask[parent]! > 0) mask[i] = weight;
  }
  return mask;
}

/* -------------------------------------------------------------------------- */
/* Forward kinematics                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Model-space matrix per bone.
 *
 * Written by hand rather than by pushing the pose through the scene graph:
 * the VAT baker evaluates thousands of frames with no `Object3D` involved,
 * and the IK solver needs the chain resolved mid-pose without disturbing the
 * bones the renderer is reading. `rig.parent` is ordered parents-first, so one
 * forward pass is enough.
 */
export function poseToModelMatrices(pose: Pose, rig: AnimRig, out: THREE.Matrix4[]): THREE.Matrix4[] {
  const n = rig.boneCount;
  for (let i = 0; i < n; i++) {
    const o4 = i * 4;
    const o3 = i * 3;
    _q0.set(pose.rot[o4]!, pose.rot[o4 + 1]!, pose.rot[o4 + 2]!, pose.rot[o4 + 3]!);
    _v0.set(pose.pos[o3]!, pose.pos[o3 + 1]!, pose.pos[o3 + 2]!);
    const local = out[i] ?? (out[i] = new THREE.Matrix4());
    local.compose(_v0, _q0, _ONE);
    const parent = rig.parent[i]!;
    if (parent >= 0) local.premultiply(out[parent]!);
  }
  return out;
}

/** Model-space position of one bone under a pose, without building the rest. */
export function boneModelPosition(
  pose: Pose,
  rig: AnimRig,
  bone: number,
  out: THREE.Vector3
): THREE.Vector3 {
  _chain.length = 0;
  for (let i: number = bone; i >= 0; i = rig.parent[i]!) {
    _chain.push(i);
    if (rig.parent[i]! < 0) break;
  }
  _m0.identity();
  for (let k = _chain.length - 1; k >= 0; k--) {
    const i = _chain[k]!;
    const o4 = i * 4;
    const o3 = i * 3;
    _q0.set(pose.rot[o4]!, pose.rot[o4 + 1]!, pose.rot[o4 + 2]!, pose.rot[o4 + 3]!);
    _v0.set(pose.pos[o3]!, pose.pos[o3 + 1]!, pose.pos[o3 + 2]!);
    _m1.compose(_v0, _q0, _ONE);
    _m0.multiply(_m1);
  }
  return out.setFromMatrixPosition(_m0);
}

/**
 * Skinning matrices: `modelMatrix * inverseBind` per bone.
 *
 * This is exactly what the GPU wants and exactly what the VAT texture stores.
 */
export function skinningMatrices(
  modelMatrices: readonly THREE.Matrix4[],
  boneInverses: readonly THREE.Matrix4[],
  out: THREE.Matrix4[]
): THREE.Matrix4[] {
  for (let i = 0; i < modelMatrices.length; i++) {
    const m = out[i] ?? (out[i] = new THREE.Matrix4());
    m.multiplyMatrices(modelMatrices[i]!, boneInverses[i]!);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Scene-graph application                                                    */
/* -------------------------------------------------------------------------- */

/** Push a pose onto the live bones. The only place this system writes them. */
export function applyPose(pose: Pose, rig: AnimRig): void {
  const bones = rig.bones;
  for (let i = 0; i < bones.length; i++) {
    const bone = bones[i]!;
    const o4 = i * 4;
    const o3 = i * 3;
    bone.quaternion.set(pose.rot[o4]!, pose.rot[o4 + 1]!, pose.rot[o4 + 2]!, pose.rot[o4 + 3]!);
    bone.position.set(pose.pos[o3]!, pose.pos[o3 + 1]!, pose.pos[o3 + 2]!);
    bone.matrixWorldNeedsUpdate = true;
  }
}

/** Read the live bones back into a pose. Used for the ragdoll handoff. */
export function capturePose(rig: AnimRig, out: Pose): Pose {
  const bones = rig.bones;
  for (let i = 0; i < bones.length; i++) {
    const bone = bones[i]!;
    const o4 = i * 4;
    const o3 = i * 3;
    out.rot[o4] = bone.quaternion.x;
    out.rot[o4 + 1] = bone.quaternion.y;
    out.rot[o4 + 2] = bone.quaternion.z;
    out.rot[o4 + 3] = bone.quaternion.w;
    out.pos[o3] = bone.position.x;
    out.pos[o3 + 1] = bone.position.y;
    out.pos[o3 + 2] = bone.position.z;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Comparison                                                                 */
/* -------------------------------------------------------------------------- */

/** Largest per-bone angular difference between two poses, radians. */
export function poseAngleDelta(a: Pose, b: Pose): number {
  let worst = 0;
  for (let i = 0; i < a.boneCount; i++) {
    const o = i * 4;
    const dot = Math.abs(
      a.rot[o]! * b.rot[o]! +
        a.rot[o + 1]! * b.rot[o + 1]! +
        a.rot[o + 2]! * b.rot[o + 2]! +
        a.rot[o + 3]! * b.rot[o + 3]!
    );
    const angle = 2 * Math.acos(Math.min(1, dot));
    if (angle > worst) worst = angle;
  }
  return worst;
}

/** True when two poses are bit-identical. The determinism assertion. */
export function poseEquals(a: Pose, b: Pose): boolean {
  if (a.boneCount !== b.boneCount) return false;
  for (let i = 0; i < a.rot.length; i++) if (a.rot[i] !== b.rot[i]) return false;
  for (let i = 0; i < a.pos.length; i++) if (a.pos[i] !== b.pos[i]) return false;
  return true;
}

/* -------------------------------------------------------------------------- */
/* Module scratch                                                             */
/* -------------------------------------------------------------------------- */

const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _v0 = new THREE.Vector3();
const _e0 = new THREE.Euler();
const _m0 = new THREE.Matrix4();
const _m1 = new THREE.Matrix4();
const _ONE = new THREE.Vector3(1, 1, 1);
const _chain: number[] = [];
