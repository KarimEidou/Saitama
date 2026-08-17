/**
 * TWO-BONE IK
 *
 * Analytic, closed-form, no iteration. A leg or an arm is a triangle with two
 * known sides, so the knee angle falls straight out of the law of cosines and
 * the only remaining question is where to point the whole triangle.
 *
 * ── THE TRICK THAT MAKES THIS CHEAP ───────────────────────────────────────
 * Most two-bone solvers construct the mid-joint position from a pole vector
 * and then derive both rotations from scratch, which throws away whatever the
 * animation had already decided about hip twist. This one works the other way
 * round:
 *
 *   1. Set the knee angle from the law of cosines.
 *   2. Read where the ankle ENDED UP under the pose's existing hip rotation.
 *   3. Rotate the hip by the single minimal-arc rotation that carries that
 *      ankle onto the target.
 *
 * Step 2's ankle and the target are the same distance from the hip — the
 * triangle is rigid once the knee angle is fixed — so step 3's rotation is
 * exact, not an approximation, and it is the SMALLEST correction that works.
 * Everything the procedural gait decided about the leg's plane and twist
 * survives; the IK only fixes what it must. The pole vector then becomes an
 * optional extra twist rather than a mandatory input, which matters because a
 * procedural gait already knows which way the knee should face and a pole
 * vector guessed from the hip axis does not.
 *
 * ── OUT OF REACH IS NOT AN ERROR ──────────────────────────────────────────
 * When the target is further away than the leg is long, the solver extends to
 * `maxExtension` and REPORTS the shortfall as `slip`. Silently snapping to
 * full extension is how procedural locomotion ends up with feet that skate:
 * the shortfall is real, it is measurable, and the caller needs it in order to
 * release the foot lock and take a shorter step.
 */

import * as THREE from 'three';
import { clamp } from '@/util';
import { setRotation } from './pose';
import type { AnimRig, Pose } from './types';

/** A resolved root/mid/end bone triple. */
export interface IKChain {
  readonly root: number;
  readonly mid: number;
  readonly end: number;
  /** Root-to-mid length, metres. */
  readonly upper: number;
  /** Mid-to-end length, metres. */
  readonly lower: number;
  /** Hinge axis in the MID bone's local frame. Unit length. */
  readonly hinge: THREE.Vector3;
  /**
   * Sign convention: `hingeSign * flexion` is the rotation about `hinge` that
   * folds the joint. A knee folds backwards, an elbow forwards.
   */
  readonly hingeSign: number;
}

/** Options for one solve. */
export interface IKOptions {
  /** Fraction of full extension the chain may reach. Below 1 to keep a bend. */
  readonly maxExtension?: number;
  /** Model-space direction the mid joint should point toward. */
  readonly pole?: THREE.Vector3;
  /** 0..1 authority of the pole over the pose's own knee plane. */
  readonly poleWeight?: number;
  /** 0..1 blend between the incoming pose and the solved one. */
  readonly weight?: number;
}

/** What the solve achieved. */
export interface IKResult {
  /** Distance from the end effector to the requested target after solving. */
  readonly slip: number;
  /** Knee/elbow flexion applied, radians. */
  readonly flexion: number;
  /** True when the target was beyond `maxExtension * (upper + lower)`. */
  readonly clamped: boolean;
}

/**
 * Build a chain descriptor from three bones, taking the segment lengths from
 * the rest pose. Lengths are constant under animation because bones only
 * rotate — that is exactly why the closed form is available at all.
 */
export function makeChain(
  rig: AnimRig,
  root: number,
  mid: number,
  end: number,
  hinge: THREE.Vector3,
  hingeSign: number
): IKChain {
  const upper = Math.hypot(
    rig.rest.pos[mid * 3]!,
    rig.rest.pos[mid * 3 + 1]!,
    rig.rest.pos[mid * 3 + 2]!
  );
  const lower = Math.hypot(
    rig.rest.pos[end * 3]!,
    rig.rest.pos[end * 3 + 1]!,
    rig.rest.pos[end * 3 + 2]!
  );
  return { root, mid, end, upper, lower, hinge: hinge.clone().normalize(), hingeSign };
}

/* -------------------------------------------------------------------------- */
/* The solver                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Solve one chain so `end` lands on `target` (model space).
 *
 * `model` must already hold model-space matrices for at least `parent(root)`;
 * the solver rewrites the three chain matrices in place so the caller can read
 * the achieved positions or continue down the chain (e.g. the foot).
 */
export function solveChain(
  pose: Pose,
  rig: AnimRig,
  model: THREE.Matrix4[],
  chain: IKChain,
  target: THREE.Vector3,
  options: IKOptions = {}
): IKResult {
  const maxExtension = options.maxExtension ?? 0.995;
  const weight = options.weight ?? 1;
  const { root, mid, end, upper, lower } = chain;

  _rootBefore.set(
    pose.rot[root * 4]!,
    pose.rot[root * 4 + 1]!,
    pose.rot[root * 4 + 2]!,
    pose.rot[root * 4 + 3]!
  );
  _midBefore.set(
    pose.rot[mid * 4]!,
    pose.rot[mid * 4 + 1]!,
    pose.rot[mid * 4 + 2]!,
    pose.rot[mid * 4 + 3]!
  );

  const parentIndex = rig.parent[root]!;
  const parentMatrix = parentIndex >= 0 ? model[parentIndex]! : _identity;
  parentMatrix.decompose(_v0, _parentRot, _v1);

  // --- 1. Root joint position ----------------------------------------------
  composeLocal(pose, root, _local);
  model[root]!.multiplyMatrices(parentMatrix, _local);
  _rootPos.setFromMatrixPosition(model[root]!);

  // --- 2. Knee/elbow angle from the law of cosines --------------------------
  const reach = _delta.subVectors(target, _rootPos).length();
  const maxReach = (upper + lower) * maxExtension;
  const minReach = Math.abs(upper - lower) * 1.02 + 1e-4;
  const d = clamp(reach, minReach, maxReach);
  const clamped = reach > maxReach + 1e-9;

  const cosInterior = clamp((upper * upper + lower * lower - d * d) / (2 * upper * lower), -1, 1);
  const flexion = Math.PI - Math.acos(cosInterior);

  _bend.setFromAxisAngle(chain.hinge, chain.hingeSign * flexion);
  _midRest.set(
    rig.rest.rot[mid * 4]!,
    rig.rest.rot[mid * 4 + 1]!,
    rig.rest.rot[mid * 4 + 2]!,
    rig.rest.rot[mid * 4 + 3]!
  );
  _midSolved.copy(_midRest).multiply(_bend);
  setRotation(pose, mid, _midSolved);

  // --- 3. Where did the end effector land? ---------------------------------
  composeLocal(pose, mid, _local);
  model[mid]!.multiplyMatrices(model[root]!, _local);
  composeLocal(pose, end, _local);
  model[end]!.multiplyMatrices(model[mid]!, _local);
  _endPos.setFromMatrixPosition(model[end]!);

  // --- 4. One minimal-arc rotation carries it onto the target --------------
  _from.subVectors(_endPos, _rootPos);
  _to.subVectors(target, _rootPos);
  if (_from.lengthSq() > 1e-12 && _to.lengthSq() > 1e-12) {
    _from.normalize();
    _to.normalize();
    _correction.setFromUnitVectors(_from, _to);
    applyModelRotation(pose, root, _correction, _parentRot);
    refreshChain(pose, rig, model, chain, parentMatrix);
  }

  // --- 5. Optional pole twist about the root-to-target axis ----------------
  const pole = options.pole;
  const poleWeight = options.poleWeight ?? 1;
  if (pole !== undefined && poleWeight > 0) {
    _axis.subVectors(target, _rootPos);
    if (_axis.lengthSq() > 1e-10) {
      _axis.normalize();
      _midPos.setFromMatrixPosition(model[chain.mid]!);
      _from.subVectors(_midPos, _rootPos).addScaledVector(_axis, -_from.dot(_axis));
      _to.copy(pole).addScaledVector(_axis, -pole.dot(_axis));
      if (_from.lengthSq() > 1e-10 && _to.lengthSq() > 1e-10) {
        _from.normalize();
        _to.normalize();
        const cos = clamp(_from.dot(_to), -1, 1);
        const sign = Math.sign(_cross.crossVectors(_from, _to).dot(_axis)) || 1;
        const twist = Math.acos(cos) * sign * poleWeight;
        if (Math.abs(twist) > 1e-5) {
          _correction.setFromAxisAngle(_axis, twist);
          applyModelRotation(pose, chain.root, _correction, _parentRot);
          refreshChain(pose, rig, model, chain, parentMatrix);
        }
      }
    }
  }

  // --- 6. Optional partial authority ---------------------------------------
  if (weight < 1) {
    _rootSolved.set(
      pose.rot[root * 4]!,
      pose.rot[root * 4 + 1]!,
      pose.rot[root * 4 + 2]!,
      pose.rot[root * 4 + 3]!
    );
    _midSolved.set(
      pose.rot[mid * 4]!,
      pose.rot[mid * 4 + 1]!,
      pose.rot[mid * 4 + 2]!,
      pose.rot[mid * 4 + 3]!
    );
    _rootSolved.copy(_rootBefore.slerp(_rootSolved, weight));
    _midSolved.copy(_midBefore.slerp(_midSolved, weight));
    setRotation(pose, root, _rootSolved);
    setRotation(pose, mid, _midSolved);
    refreshChain(pose, rig, model, chain, parentMatrix);
  }

  _endPos.setFromMatrixPosition(model[end]!);
  return { slip: _endPos.distanceTo(target), flexion, clamped };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Rotate a bone by a MODEL-space rotation, expressed in its local frame.
 *
 * `qLocal' = parentRot⁻¹ · qModel · parentRot · qLocal`. Written out because
 * getting the conjugation the wrong way round produces a character that
 * rotates correctly only when its parent happens to be at identity — a bug
 * that hides perfectly in a T-pose test and appears the moment anything turns.
 */
function applyModelRotation(
  pose: Pose,
  bone: number,
  rotation: THREE.Quaternion,
  parentRot: THREE.Quaternion
): void {
  _inv.copy(parentRot).invert();
  _tmp.copy(_inv).multiply(rotation).multiply(parentRot);
  _cur.set(
    pose.rot[bone * 4]!,
    pose.rot[bone * 4 + 1]!,
    pose.rot[bone * 4 + 2]!,
    pose.rot[bone * 4 + 3]!
  );
  _cur.premultiply(_tmp);
  setRotation(pose, bone, _cur);
}

function refreshChain(
  pose: Pose,
  rig: AnimRig,
  model: THREE.Matrix4[],
  chain: IKChain,
  parentMatrix: THREE.Matrix4
): void {
  composeLocal(pose, chain.root, _local);
  model[chain.root]!.multiplyMatrices(parentMatrix, _local);
  composeLocal(pose, chain.mid, _local);
  model[chain.mid]!.multiplyMatrices(model[chain.root]!, _local);
  composeLocal(pose, chain.end, _local);
  model[chain.end]!.multiplyMatrices(model[chain.mid]!, _local);
  _rootPos.setFromMatrixPosition(model[chain.root]!);
}

function composeLocal(pose: Pose, bone: number, out: THREE.Matrix4): THREE.Matrix4 {
  const o4 = bone * 4;
  const o3 = bone * 3;
  _q.set(pose.rot[o4]!, pose.rot[o4 + 1]!, pose.rot[o4 + 2]!, pose.rot[o4 + 3]!);
  _p.set(pose.pos[o3]!, pose.pos[o3 + 1]!, pose.pos[o3 + 2]!);
  return out.compose(_p, _q, _SCALE_ONE);
}

/**
 * Rewrite a bone's local rotation so its MODEL-space orientation equals
 * `desired`. Used to plant the foot flat regardless of what the leg did.
 */
export function setModelRotation(
  pose: Pose,
  bone: number,
  desired: THREE.Quaternion,
  parentModel: THREE.Matrix4
): void {
  parentModel.decompose(_v0, _parentRot, _v1);
  _inv.copy(_parentRot).invert();
  _tmp.copy(_inv).multiply(desired);
  setRotation(pose, bone, _tmp);
}

/**
 * Joint positions for a two-bone chain, solved from geometry alone.
 *
 * Independent of the pose pipeline, so tests can check the solver's geometry
 * without a skeleton in the way.
 */
export function twoBoneJointPositions(
  root: THREE.Vector3,
  target: THREE.Vector3,
  upper: number,
  lower: number,
  pole: THREE.Vector3,
  outMid: THREE.Vector3
): { reachable: boolean; distance: number } {
  const delta = _delta.subVectors(target, root);
  const raw = delta.length();
  const d = clamp(raw, Math.abs(upper - lower) + 1e-6, upper + lower - 1e-6);
  const reachable = raw <= upper + lower;
  const axis = _axis.copy(delta).normalize();
  const cosAlpha = clamp((upper * upper + d * d - lower * lower) / (2 * upper * d), -1, 1);
  const alpha = Math.acos(cosAlpha);

  _to.copy(pole).addScaledVector(axis, -pole.dot(axis));
  if (_to.lengthSq() < 1e-12) {
    _to.set(0, 1, 0).addScaledVector(axis, -axis.y);
    if (_to.lengthSq() < 1e-12) _to.set(1, 0, 0).addScaledVector(axis, -axis.x);
  }
  _to.normalize();

  outMid
    .copy(root)
    .addScaledVector(axis, Math.cos(alpha) * upper)
    .addScaledVector(_to, Math.sin(alpha) * upper);
  return { reachable, distance: raw };
}

/* -------------------------------------------------------------------------- */
/* Module scratch                                                             */
/* -------------------------------------------------------------------------- */

const _identity = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _SCALE_ONE = new THREE.Vector3(1, 1, 1);
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _parentRot = new THREE.Quaternion();
const _rootPos = new THREE.Vector3();
const _midPos = new THREE.Vector3();
const _endPos = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _cross = new THREE.Vector3();
const _correction = new THREE.Quaternion();
const _bend = new THREE.Quaternion();
const _midRest = new THREE.Quaternion();
const _midSolved = new THREE.Quaternion();
const _midBefore = new THREE.Quaternion();
const _rootBefore = new THREE.Quaternion();
const _rootSolved = new THREE.Quaternion();
const _inv = new THREE.Quaternion();
const _tmp = new THREE.Quaternion();
const _cur = new THREE.Quaternion();
