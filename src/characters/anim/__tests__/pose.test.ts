/**
 * POSE PRIMITIVES
 *
 * `pose.ts` is the most reused code in this workstream — every clip
 * evaluation, every crossfade, every masked overlay, the VAT baker and the IK
 * all pass through it — and every other suite exercises it only incidentally.
 * That is exactly the shape of code that rots silently: the hemisphere fix in
 * `blendPose` could be deleted outright and the rest of the animation suite
 * would stay green, while every crossfade between a quaternion and its
 * negation folded the character inside out for the length of the fade.
 *
 * A note on tolerances. Poses are Float32, so a stored quaternion is only unit
 * to about 1e-7, and `poseAngleDelta`'s `2·acos` amplifies that into ~5e-4 rad
 * of apparent difference between a pose and ITSELF. Anything that has to
 * resolve finer than that is asserted componentwise instead.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { BoneName } from '@/types';
import {
  applyPose,
  blendPose,
  blendPoseMasked,
  boneModelPosition,
  capturePose,
  copyPose,
  createPose,
  getRotation,
  lowerBodyMask,
  poseAngleDelta,
  poseEquals,
  poseToModelMatrices,
  rotateBone,
  setEuler,
  setRotation,
  skinningMatrices,
  subtreeMask,
  upperBodyMask,
} from '../pose';
import { maskFor } from '../bake';
import type { Pose } from '../types';
import { heroFixture } from './support';

const { rig } = heroFixture('saitama');
const N = rig.boneCount;

/** Largest absolute componentwise difference between two poses. */
function worstComponent(a: Pose, b: Pose): number {
  let worst = 0;
  for (let i = 0; i < a.rot.length; i++) worst = Math.max(worst, Math.abs(a.rot[i]! - b.rot[i]!));
  for (let i = 0; i < a.pos.length; i++) worst = Math.max(worst, Math.abs(a.pos[i]! - b.pos[i]!));
  return worst;
}

/** How far one bone rotated between two poses, radians. */
function boneAngle(a: Pose, b: Pose, bone: number): number {
  const qa = getRotation(a, bone, new THREE.Quaternion());
  const qb = getRotation(b, bone, new THREE.Quaternion());
  return qa.angleTo(qb);
}

/**
 * Componentwise distance from a bone's stored rotation to an expected one.
 *
 * Used instead of `Quaternion.angleTo` wherever the assertion has to be tight:
 * `angleTo` is `2·acos(dot)`, whose derivative is infinite at dot = 1, so the
 * ~6e-8 of Float32 rounding in a stored quaternion shows up as up to ~1e-3 rad
 * of phantom error. The components themselves stay accurate to the rounding.
 */
function quatDelta(pose: Pose, bone: number, expected: THREE.Quaternion): number {
  const q = getRotation(pose, bone, new THREE.Quaternion());
  const flip = q.dot(expected) < 0 ? -1 : 1;
  return Math.max(
    Math.abs(q.x * flip - expected.x),
    Math.abs(q.y * flip - expected.y),
    Math.abs(q.z * flip - expected.z),
    Math.abs(q.w * flip - expected.w)
  );
}

/** True when two poses hold bit-identical rotations for one bone. */
function boneRotEquals(a: Pose, b: Pose, bone: number): boolean {
  for (let k = 0; k < 4; k++) if (a.rot[bone * 4 + k] !== b.rot[bone * 4 + k]) return false;
  return true;
}

const axisAngle = (axis: THREE.Vector3, angle: number): THREE.Quaternion =>
  new THREE.Quaternion().setFromAxisAngle(axis, angle);

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);

/** A rest pose with a handful of bones moved, so nothing under test is trivial. */
function posed(seedAngle = 0.4): Pose {
  const pose = copyPose(createPose(N), rig.rest);
  const bones: BoneName[] = ['Spine', 'Spine1', 'LeftArm', 'LeftForeArm', 'RightUpLeg', 'Head'];
  bones.forEach((name, k) => {
    const i = rig.index[name];
    if (i === undefined) return;
    setRotation(pose, i, axisAngle(k % 2 === 0 ? X : Y, seedAngle + k * 0.11));
  });
  const hips = rig.index.Hips!;
  pose.pos[hips * 3] = 0.03;
  pose.pos[hips * 3 + 1] = 0.9;
  pose.pos[hips * 3 + 2] = -0.02;
  return pose;
}

describe('blendPose', () => {
  it('takes the short way round between a quaternion and its negation', () => {
    // `q` and `-q` are the SAME orientation. Without the hemisphere fix the
    // lerp between them collapses to zero length, the fallback writes identity,
    // and the character folds inside out for the duration of the fade. The
    // docstring calls the fix "NOT optional"; this is what says so in code.
    const bone = rig.index.LeftForeArm!;
    const q = axisAngle(X, 0.6);
    const a = copyPose(createPose(N), rig.rest);
    const b = copyPose(createPose(N), rig.rest);
    setRotation(a, bone, q);
    setRotation(b, bone, new THREE.Quaternion(-q.x, -q.y, -q.z, -q.w));

    const out = blendPose(createPose(N), a, b, 0.5);
    // Without the fix this bone lands on identity: 0.6 rad away, three orders
    // of magnitude above the Float32 floor.
    expect(quatDelta(out, bone, q)).toBeLessThan(1e-6);
    expect(poseAngleDelta(out, a)).toBeLessThan(0.01);
  });

  it('is safe when the output aliases either input', () => {
    // `animator.update` relies on this: the crossfade writes into a buffer it
    // is also reading.
    const a = posed(0.4);
    const b = posed(-0.3);
    const ref = blendPose(createPose(N), a, b, 0.37);

    const aliasedA = copyPose(createPose(N), a);
    blendPose(aliasedA, aliasedA, b, 0.37);
    expect(poseEquals(aliasedA, ref)).toBe(true);

    const aliasedB = copyPose(createPose(N), b);
    blendPose(aliasedB, a, aliasedB, 0.37);
    expect(poseEquals(aliasedB, ref)).toBe(true);
  });

  it('returns the endpoints exactly, including outside 0..1', () => {
    const a = posed(0.4);
    const b = posed(-0.3);
    for (const t of [0, -1, -1e9]) {
      expect(poseEquals(blendPose(createPose(N), a, b, t), a), `t=${t}`).toBe(true);
    }
    for (const t of [1, 2, 1e9]) {
      expect(poseEquals(blendPose(createPose(N), a, b, t), b), `t=${t}`).toBe(true);
    }
  });

  it('leaves an aliased output untouched at its own endpoint', () => {
    const a = posed(0.4);
    const b = posed(-0.3);
    const aliased = copyPose(createPose(N), a);
    expect(poseEquals(blendPose(aliased, aliased, b, 0), a)).toBe(true);
  });
});

describe('masks', () => {
  it('partitions the skeleton between upper and lower', () => {
    const upper = upperBodyMask(rig);
    const lower = lowerBodyMask(rig);
    expect(upper).toHaveLength(N);
    for (let i = 0; i < N; i++) expect(upper[i]! + lower[i]!, `bone ${i}`).toBeCloseTo(1, 6);
  });

  it('feathers 35 / 70 / 100 down the spine stack', () => {
    // Masking hard at Spine2 puts a whole punch rotation into one joint and the
    // waist visibly snaps.
    const mask = upperBodyMask(rig);
    expect(mask[rig.index.Hips!]).toBe(0);
    expect(mask[rig.index.Spine!]).toBeCloseTo(0.35, 6);
    expect(mask[rig.index.Spine1!]).toBeCloseTo(0.7, 6);
    expect(mask[rig.index.Spine2!]).toBe(1);
    expect(mask[rig.index.RightHand!]).toBe(1);
    expect(mask[rig.index.LeftUpLeg!]).toBe(0);
  });

  it('selects a bone and everything under it', () => {
    const mask = subtreeMask(rig, 'LeftArm');
    for (const name of [
      'LeftArm',
      'LeftForeArm',
      'LeftHand',
      'LeftHandIndex1',
      'LeftHandThumb1',
    ] as const) {
      expect(mask[rig.index[name]!], name).toBe(1);
    }
    for (const name of ['LeftShoulder', 'Hips', 'RightArm', 'Spine2', 'LeftUpLeg'] as const) {
      expect(mask[rig.index[name]!], name).toBe(0);
    }
  });

  it('honours the weight argument and a bone the rig does not have', () => {
    const mask = subtreeMask(rig, 'LeftArm', 0.5);
    expect(mask[rig.index.LeftHand!]).toBe(0.5);
    // `resolveRig` is tolerant of missing bones, so this must not throw.
    const missing = subtreeMask(rig, 'NotABone' as BoneName);
    expect(Array.from(missing).every((w) => w === 0)).toBe(true);
  });

  it('agrees with the baker cached copy', () => {
    // `bake.maskFor` caches per rig; it must still hand back the same weights.
    expect(Array.from(maskFor(rig, 'lower')!)).toEqual(Array.from(lowerBodyMask(rig)));
    expect(Array.from(maskFor(rig, 'upper')!)).toEqual(Array.from(upperBodyMask(rig)));
    expect(maskFor(rig, 'full')).toBeUndefined();
  });
});

describe('blendPoseMasked', () => {
  it('changes nothing at all under an all-zero mask', () => {
    const out = posed(0.4);
    const before = copyPose(createPose(N), out);
    blendPoseMasked(out, posed(-0.3), 1, new Float32Array(N));
    expect(poseEquals(out, before)).toBe(true);
  });

  it('lands on the source under a full mask at full weight', () => {
    const out = posed(0.4);
    const b = posed(-0.3);
    blendPoseMasked(out, b, 1, new Float32Array(N).fill(1));
    expect(poseAngleDelta(out, b)).toBeLessThan(1e-3);
    for (let i = 0; i < out.pos.length; i++) {
      expect(Math.abs(out.pos[i]! - b.pos[i]!), `pos ${i}`).toBeLessThan(1e-6);
    }
  });

  it('feathers the spine and leaves the legs alone', () => {
    // The same rotation is asked of every bone, so the only thing separating
    // the three spine joints in the result is the mask.
    const target = copyPose(createPose(N), rig.rest);
    const moved: BoneName[] = ['Spine', 'Spine1', 'Spine2', 'LeftUpLeg', 'RightUpLeg'];
    for (const name of moved) setRotation(target, rig.index[name]!, axisAngle(X, 0.5));

    const out = copyPose(createPose(N), rig.rest);
    const before = copyPose(createPose(N), out);
    blendPoseMasked(out, target, 1, upperBodyMask(rig));

    const spine = boneAngle(before, out, rig.index.Spine!);
    const spine1 = boneAngle(before, out, rig.index.Spine1!);
    const spine2 = boneAngle(before, out, rig.index.Spine2!);
    expect(spine).toBeGreaterThan(0.05);
    expect(spine).toBeLessThan(spine1 - 0.05);
    expect(spine1).toBeLessThan(spine2 - 0.05);
    expect(spine2).toBeCloseTo(0.5, 3);
    // Mask 0 means the bytes are not touched at all, not "moved a little".
    expect(boneRotEquals(before, out, rig.index.LeftUpLeg!)).toBe(true);
    expect(boneRotEquals(before, out, rig.index.RightUpLeg!)).toBe(true);
  });
});

describe('forward kinematics', () => {
  it('resolves one bone the same way as the whole chain', () => {
    const pose = posed(0.4);
    const model = poseToModelMatrices(pose, rig, []);
    const out = new THREE.Vector3();
    const expected = new THREE.Vector3();
    for (let b = 0; b < N; b++) {
      boneModelPosition(pose, rig, b, out);
      expected.setFromMatrixPosition(model[b]!);
      expect(out.distanceTo(expected), `bone ${b}`).toBeLessThan(1e-9);
    }
  });

  it('grows the output array rather than requiring it pre-sized', () => {
    const pose = posed(0.4);
    const out: THREE.Matrix4[] = [];
    expect(poseToModelMatrices(pose, rig, out)).toHaveLength(N);
    expect(out).toHaveLength(N);
  });

  it('produces model times inverse-bind for the GPU', () => {
    const pose = posed(0.4);
    const model = poseToModelMatrices(pose, rig, []);
    const skin = skinningMatrices(model, rig.boneInverses, []);
    const expected = new THREE.Matrix4();
    for (let b = 0; b < N; b++) {
      expected.multiplyMatrices(model[b]!, rig.boneInverses[b]!);
      expect(skin[b]!.elements, `bone ${b}`).toEqual(expected.elements);
    }
  });
});

describe('scene-graph round trip', () => {
  it('reads back exactly what it wrote', () => {
    const pose = posed(0.4);
    applyPose(pose, rig);
    const out = capturePose(rig, createPose(N));
    expect(poseEquals(out, pose)).toBe(true);
    // Restore, so nothing later in the file inherits a posed skeleton.
    applyPose(rig.rest, rig);
  });
});

describe('small helpers', () => {
  it('creates an identity pose', () => {
    const pose = createPose(5);
    expect(pose.boneCount).toBe(5);
    for (let i = 0; i < 5; i++) {
      expect(Array.from(pose.rot.slice(i * 4, i * 4 + 4))).toEqual([0, 0, 0, 1]);
      expect(Array.from(pose.pos.slice(i * 3, i * 3 + 3))).toEqual([0, 0, 0]);
    }
  });

  it('measures the worst per-bone angle', () => {
    const identity = createPose(N);
    expect(poseAngleDelta(identity, identity)).toBe(0);

    const rotated = createPose(N);
    setRotation(rotated, rig.index.LeftForeArm!, axisAngle(X, 0.4));
    // Float32 storage puts a floor of ~5e-4 rad on anything measured this way.
    expect(poseAngleDelta(identity, rotated)).toBeCloseTo(0.4, 3);
    // ...and it is the WORST bone, not the last or the average.
    setRotation(rotated, rig.index.Head!, axisAngle(Y, 0.2));
    expect(poseAngleDelta(identity, rotated)).toBeCloseTo(0.4, 3);
  });

  it('compares poses bit for bit', () => {
    const a = posed(0.4);
    const b = copyPose(createPose(N), a);
    expect(poseEquals(a, b)).toBe(true);
    b.rot[7] = b.rot[7]! + 1e-6;
    expect(poseEquals(a, b)).toBe(false);
    const c = copyPose(createPose(N), a);
    c.pos[4] = c.pos[4]! + 1e-6;
    expect(poseEquals(a, c)).toBe(false);
    expect(poseEquals(a, createPose(N + 1))).toBe(false);
  });

  it('composes a single-axis rotation onto a bone', () => {
    const bone = rig.index.LeftForeArm!;
    const pose = createPose(N);
    rotateBone(pose, bone, 'x', 0.5);
    expect(quatDelta(pose, bone, axisAngle(X, 0.5))).toBeLessThan(1e-6);
    // A zero angle is a no-op rather than a renormalisation.
    const before = copyPose(createPose(N), pose);
    rotateBone(pose, bone, 'y', 0);
    expect(poseEquals(pose, before)).toBe(true);
    // ...and it COMPOSES: two partial turns about one axis make the whole.
    rotateBone(pose, bone, 'x', 0.25);
    expect(quatDelta(pose, bone, axisAngle(X, 0.75))).toBeLessThan(1e-6);
  });

  it('sets an XYZ Euler triple the same way three.js does', () => {
    const bone = rig.index.Spine1!;
    const pose = createPose(N);
    setEuler(pose, bone, 0.3, -0.2, 0.44);
    const expected = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -0.2, 0.44, 'XYZ'));
    expect(quatDelta(pose, bone, expected)).toBeLessThan(1e-6);
  });

  it('copies without aliasing the source buffers', () => {
    const a = posed(0.4);
    const b = copyPose(createPose(N), a);
    b.rot[0] = 0.5;
    expect(a.rot[0]).not.toBe(0.5);
    expect(worstComponent(a, b)).toBeGreaterThan(0);
  });
});
