/**
 * POSTURE VOCABULARY
 *
 * Anatomical joint controls, so a clip reads as "left arm flexed 80°, elbow
 * 100°" rather than as a page of quaternion algebra. Every clip in the library
 * is written against these six functions.
 *
 * ── WHY THE HINGE AXES ARE WHAT THEY ARE ──────────────────────────────────
 * The rig rests with IDENTITY rotations and the character faces -Z, so every
 * bone's local frame is axis-aligned with the model and a joint's hinge is
 * whichever model axis is perpendicular to that limb's plane of motion IN THE
 * BIND POSE — not in the current pose. That distinction is the whole trick:
 *
 *   KNEE   bind direction is straight down, so flexion is about X. Folding is
 *          NEGATIVE X, because a knee bends backwards.
 *   ELBOW  bind direction is out to the SIDE (the mesh generator's bind pose
 *          is a shallow T), so flexion is about Y, mirrored per side. Once the
 *          shoulder has adducted the arm to hang at the side, that same local
 *          Y has been carried round to point sideways in the world, and the
 *          elbow folds forward exactly as it should. Choosing the hinge from
 *          the POSED direction instead is the classic mistake and produces an
 *          elbow that bends sideways whenever the arm is raised.
 *   SHOULDER  adduction about Z (mirrored), then fore/aft about X. In that
 *          order, because fore/aft on a horizontal arm is a different motion
 *          from fore/aft on a hanging one, and the hanging one is what a
 *          humanoid clip means.
 *
 * Mirroring: reflecting across the YZ plane preserves rotations about X and
 * flips those about Y and Z. Every `sign` in this file is that rule and
 * nothing else.
 */

import * as THREE from 'three';
import type { BoneName } from '@/types';
import { setRotation } from './pose';
import type { AnimRig, Pose } from './types';

/** -1 for the character's left (which is -X), +1 for the right. */
export type SideSign = -1 | 1;

/** Shoulder and elbow. Angles in radians. */
export interface ArmPose {
  /** Fore/aft swing of the hanging arm. Positive is forward. */
  readonly flex?: number;
  /** Out from the body's side. 0 hangs straight down, PI/2 is horizontal. */
  readonly abduct?: number;
  /** Rotation about the arm's own long axis. */
  readonly twist?: number;
  /** Elbow flexion. 0 is straight, PI/2 is a right angle. */
  readonly elbow?: number;
  /** Wrist pitch, positive is knuckles up. */
  readonly wrist?: number;
  /** Clavicle shrug, positive lifts the shoulder. */
  readonly shrug?: number;
}

/** Hip, knee and ankle. */
export interface LegPose {
  /** Hip flexion. Positive swings the thigh forward. */
  readonly flex?: number;
  /** Hip abduction, outward from the midline. */
  readonly abduct?: number;
  /** Hip rotation about the thigh's long axis; positive is toes-out. */
  readonly twist?: number;
  /** Knee flexion. Always positive; the sign is handled here. */
  readonly knee?: number;
  /** Ankle pitch. Positive is toes-up. */
  readonly ankle?: number;
  /** Toe (metatarsal) extension. */
  readonly toe?: number;
}

/** Spine stack, distributed over Spine / Spine1 / Spine2. */
export interface SpinePose {
  /** Forward bend, positive folds the chest down. */
  readonly bend?: number;
  /** Axial twist; positive turns the chest to the character's right. */
  readonly twist?: number;
  /** Lateral bend; positive leans the chest to the character's right. */
  readonly side?: number;
}

/* -------------------------------------------------------------------------- */
/* Joints                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Pose one arm.
 *
 * `abduct` is measured from HANGING, not from the bind pose, so a clip never
 * has to know that the generator's bind arms droop 7° off horizontal. The
 * droop is measured off the rig and subtracted here.
 */
export function poseArm(pose: Pose, rig: AnimRig, side: SideSign, arm: ArmPose): void {
  const prefix = side < 0 ? 'Left' : 'Right';
  const mirror = side < 0 ? 1 : -1;
  const shoulder = rig.index[`${prefix}Arm` as BoneName];
  if (shoulder === undefined) return;

  const droop = Math.atan2(-rig.metrics.armRestDir.y, Math.abs(rig.metrics.armRestDir.x));
  const adduct = Math.PI / 2 - droop - (arm.abduct ?? 0);

  _q0.setFromAxisAngle(_X, arm.flex ?? 0);
  _q1.setFromAxisAngle(_Z, mirror * adduct);
  _q2.setFromAxisAngle(_X, mirror * (arm.twist ?? 0));
  _q0.multiply(_q1).multiply(_q2);
  setRotation(pose, shoulder, _q0);

  const fore = rig.index[`${prefix}ForeArm` as BoneName];
  if (fore !== undefined) {
    _q0.setFromAxisAngle(_Y, -mirror * (arm.elbow ?? 0));
    setRotation(pose, fore, _q0);
  }
  const hand = rig.index[`${prefix}Hand` as BoneName];
  if (hand !== undefined && arm.wrist !== undefined) {
    _q0.setFromAxisAngle(_Z, mirror * arm.wrist);
    setRotation(pose, hand, _q0);
  }
  const clavicle = rig.index[`${prefix}Shoulder` as BoneName];
  if (clavicle !== undefined && arm.shrug !== undefined) {
    _q0.setFromAxisAngle(_Z, mirror * arm.shrug);
    setRotation(pose, clavicle, _q0);
  }
}

/** Pose one leg. */
export function poseLeg(pose: Pose, rig: AnimRig, side: SideSign, leg: LegPose): void {
  const prefix = side < 0 ? 'Left' : 'Right';
  const hip = rig.index[`${prefix}UpLeg` as BoneName];
  if (hip === undefined) return;

  _q0.setFromAxisAngle(_X, leg.flex ?? 0);
  _q1.setFromAxisAngle(_Z, side * (leg.abduct ?? 0));
  _q2.setFromAxisAngle(_Y, -side * (leg.twist ?? 0));
  _q0.multiply(_q1).multiply(_q2);
  setRotation(pose, hip, _q0);

  const knee = rig.index[`${prefix}Leg` as BoneName];
  if (knee !== undefined) {
    // A knee folds backwards: negative rotation about the bind X axis.
    _q0.setFromAxisAngle(_X, -Math.abs(leg.knee ?? 0));
    setRotation(pose, knee, _q0);
  }
  const ankle = rig.index[`${prefix}Foot` as BoneName];
  if (ankle !== undefined) {
    _q0.setFromAxisAngle(_X, leg.ankle ?? 0);
    setRotation(pose, ankle, _q0);
  }
  const toe = rig.index[`${prefix}ToeBase` as BoneName];
  if (toe !== undefined) {
    _q0.setFromAxisAngle(_X, leg.toe ?? 0);
    setRotation(pose, toe, _q0);
  }
}

/**
 * Pose the spine stack.
 *
 * Distributed 30 / 35 / 35 rather than concentrated: a lumbar spine bends a
 * little at many joints. Putting the whole bend into one bone gives the
 * hinged-at-the-waist look that reads as a mannequin.
 */
export function poseSpine(pose: Pose, rig: AnimRig, spine: SpinePose): void {
  const bend = spine.bend ?? 0;
  const twist = spine.twist ?? 0;
  const side = spine.side ?? 0;
  for (const [name, share] of SPINE_SHARE) {
    const i = rig.index[name];
    if (i === undefined) continue;
    _q0.setFromAxisAngle(_Y, -twist * share);
    _q1.setFromAxisAngle(_X, bend * share);
    _q2.setFromAxisAngle(_Z, -side * share);
    _q0.multiply(_q1).multiply(_q2);
    setRotation(pose, i, _q0);
  }
}

/** Neck and head. Angles are the TOTAL, split between the two joints. */
export function poseHead(
  pose: Pose,
  rig: AnimRig,
  pitch: number,
  yaw = 0,
  roll = 0,
  neckShare = 0.45
): void {
  const neck = rig.index.Neck;
  const head = rig.index.Head;
  if (neck !== undefined) {
    _q0.setFromAxisAngle(_Y, -yaw * neckShare);
    _q1.setFromAxisAngle(_X, pitch * neckShare);
    _q2.setFromAxisAngle(_Z, -roll * neckShare);
    _q0.multiply(_q1).multiply(_q2);
    setRotation(pose, neck, _q0);
  }
  if (head !== undefined) {
    const share = 1 - neckShare;
    _q0.setFromAxisAngle(_Y, -yaw * share);
    _q1.setFromAxisAngle(_X, pitch * share);
    _q2.setFromAxisAngle(_Z, -roll * share);
    _q0.multiply(_q1).multiply(_q2);
    setRotation(pose, head, _q0);
  }
}

/** Root transform. `y` is the hip JOINT height; the bone offset is handled. */
export function posePelvis(
  pose: Pose,
  rig: AnimRig,
  x: number,
  y: number,
  z: number,
  pitch = 0,
  yaw = 0,
  roll = 0
): void {
  const hips = rig.index.Hips;
  if (hips === undefined) return;
  const o = hips * 3;
  pose.pos[o] = rig.rest.pos[o]! + x;
  pose.pos[o + 1] = y - (rig.metrics.hipHeight - rig.rest.pos[o + 1]!);
  pose.pos[o + 2] = rig.rest.pos[o + 2]! + z;
  _q0.setFromAxisAngle(_Y, yaw);
  _q1.setFromAxisAngle(_X, pitch);
  _q2.setFromAxisAngle(_Z, roll);
  _q0.multiply(_q1).multiply(_q2);
  setRotation(pose, hips, _q0);
}

/* -------------------------------------------------------------------------- */
/* Shaping helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Anticipation-action-settle curve over 0..1.
 *
 * Every strike in the library uses this: a slow drift back (`wind`), a fast
 * strike to the peak (`hit`), then an overshoot that settles. The alternative,
 * a plain ease, is what makes a procedural punch look like a robot extending
 * an arm — there is no wind-up, so there is no weight.
 */
export function strikeCurve(t: number, wind = 0.34, hit = 0.5): number {
  if (t <= 0) return 0;
  if (t < wind) {
    const s = t / wind;
    return -0.28 * (s * s * (3 - 2 * s));
  }
  if (t < hit) {
    const s = (t - wind) / (hit - wind);
    // Cubic ease-out: almost all the travel happens in the first third, which
    // is what gives the strike its snap.
    return -0.28 + 1.28 * (1 - Math.pow(1 - s, 3));
  }
  const s = (t - hit) / (1 - hit);
  return 1 - 1 * (s * s * (3 - 2 * s)) * 0.92 - 0.08 * (1 - Math.cos(s * Math.PI * 2)) * 0.25;
}

/** Damped oscillation, for recoils and settles. */
export function springDecay(t: number, cycles = 2.2, decay = 5): number {
  return Math.exp(-decay * t) * Math.sin(Math.PI * 2 * cycles * t);
}

/** Smooth 0 -> 1 -> 0 bump with flat ends. */
export function bump(t: number, power = 1.4): number {
  if (t <= 0 || t >= 1) return 0;
  return Math.pow(Math.sin(Math.PI * t), power);
}

const SPINE_SHARE: ReadonlyArray<readonly [BoneName, number]> = [
  ['Spine', 0.3],
  ['Spine1', 0.35],
  ['Spine2', 0.35],
];

const _X = new THREE.Vector3(1, 0, 0);
const _Y = new THREE.Vector3(0, 1, 0);
const _Z = new THREE.Vector3(0, 0, 1);
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
