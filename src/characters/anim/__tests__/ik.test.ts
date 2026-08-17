/**
 * TWO-BONE IK
 *
 * The solver's contract is exactness: for any reachable target, the end
 * effector must land ON it, not near it. The one place a games IK solver is
 * allowed to be approximate is out-of-reach, and there it has to REPORT the
 * shortfall rather than pretend.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { makeChain, solveChain, twoBoneJointPositions } from '../ik';
import { copyPose, createPose, poseToModelMatrices } from '../pose';
import { createRng } from '@/util';
import { heroFixture, showcaseFixtures } from './support';

const X = new THREE.Vector3(1, 0, 0);

describe('two-bone IK', () => {
  const { rig } = heroFixture('saitama');
  const hip = rig.index.LeftUpLeg!;
  const knee = rig.index.LeftLeg!;
  const ankle = rig.index.LeftFoot!;
  const chain = makeChain(rig, hip, knee, ankle, X, -1);

  it('measures segment lengths from the rest pose', () => {
    expect(chain.upper).toBeCloseTo(rig.metrics.thigh, 6);
    expect(chain.lower).toBeCloseTo(rig.metrics.shank, 6);
  });

  it('lands the ankle exactly on 500 reachable targets', () => {
    const rng = createRng(1234).derive('ik');
    const pose = createPose(rig.boneCount);
    const model: THREE.Matrix4[] = [];
    const target = new THREE.Vector3();
    const achieved = new THREE.Vector3();
    const reach = (chain.upper + chain.lower) * 0.98;
    let worst = 0;

    for (let i = 0; i < 500; i++) {
      copyPose(pose, rig.rest);
      poseToModelMatrices(pose, rig, model);
      const hipPos = new THREE.Vector3().setFromMatrixPosition(model[hip]!);
      // Uniformly inside the reachable ball, biased below the hip so the
      // targets are the ones a leg actually visits.
      const radius = reach * Math.cbrt(rng.next()) * 0.98 + 0.02;
      const theta = rng.range(0, Math.PI * 2);
      const phi = Math.acos(rng.range(-1, 0.35));
      target.set(
        hipPos.x + radius * Math.sin(phi) * Math.cos(theta),
        hipPos.y + radius * Math.cos(phi),
        hipPos.z + radius * Math.sin(phi) * Math.sin(theta)
      );

      const result = solveChain(pose, rig, model, chain, target, { maxExtension: 0.995 });
      poseToModelMatrices(pose, rig, model);
      achieved.setFromMatrixPosition(model[ankle]!);
      worst = Math.max(worst, achieved.distanceTo(target));
      expect(result.clamped).toBe(false);
    }
    // Sub-micron. Anything larger would mean the closed form is not closed.
    expect(worst).toBeLessThan(1e-6);
  });

  it('preserves bone lengths under every solve', () => {
    const rng = createRng(99).derive('ik-len');
    const pose = createPose(rig.boneCount);
    const model: THREE.Matrix4[] = [];
    const target = new THREE.Vector3();
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();

    for (let i = 0; i < 200; i++) {
      copyPose(pose, rig.rest);
      poseToModelMatrices(pose, rig, model);
      const hipPos = new THREE.Vector3().setFromMatrixPosition(model[hip]!);
      target.set(
        hipPos.x + rng.range(-1, 1),
        hipPos.y + rng.range(-1.2, 0.4),
        hipPos.z + rng.range(-1, 1)
      );
      solveChain(pose, rig, model, chain, target);
      poseToModelMatrices(pose, rig, model);
      a.setFromMatrixPosition(model[hip]!);
      b.setFromMatrixPosition(model[knee]!);
      expect(a.distanceTo(b)).toBeCloseTo(chain.upper, 6);
      a.setFromMatrixPosition(model[ankle]!);
      expect(a.distanceTo(b)).toBeCloseTo(chain.lower, 6);
    }
  });

  it('reports the shortfall instead of hiding an unreachable target', () => {
    const pose = createPose(rig.boneCount);
    const model: THREE.Matrix4[] = [];
    copyPose(pose, rig.rest);
    poseToModelMatrices(pose, rig, model);
    const hipPos = new THREE.Vector3().setFromMatrixPosition(model[hip]!);
    const target = hipPos.clone().add(new THREE.Vector3(0, -3, 0));
    const result = solveChain(pose, rig, model, chain, target, { maxExtension: 0.99 });
    expect(result.clamped).toBe(true);
    // The leg extends to its ceiling and the caller is told exactly how far
    // short it is — which is what lets the locomotion release a foot lock.
    const reach = (chain.upper + chain.lower) * 0.99;
    expect(result.slip).toBeCloseTo(3 - reach, 3);
  });

  it('keeps the knee out of hyperextension', () => {
    const pose = createPose(rig.boneCount);
    const model: THREE.Matrix4[] = [];
    copyPose(pose, rig.rest);
    poseToModelMatrices(pose, rig, model);
    const hipPos = new THREE.Vector3().setFromMatrixPosition(model[hip]!);
    for (const distance of [0.2, 0.4, 0.6, 0.8, 0.849]) {
      copyPose(pose, rig.rest);
      poseToModelMatrices(pose, rig, model);
      const target = hipPos.clone().add(new THREE.Vector3(0, -distance, 0));
      const result = solveChain(pose, rig, model, chain, target);
      expect(result.flexion).toBeGreaterThanOrEqual(0);
      expect(result.flexion).toBeLessThan(Math.PI);
    }
  });

  it('honours the pole vector for the knee direction', () => {
    const pose = createPose(rig.boneCount);
    const model: THREE.Matrix4[] = [];
    copyPose(pose, rig.rest);
    poseToModelMatrices(pose, rig, model);
    const hipPos = new THREE.Vector3().setFromMatrixPosition(model[hip]!);
    const target = hipPos.clone().add(new THREE.Vector3(0, -0.62, 0));

    // Forward is -Z. A forward pole must put the knee in front of the hip.
    solveChain(pose, rig, model, chain, target, {
      pole: new THREE.Vector3(0, 0, -1),
      poleWeight: 1,
    });
    poseToModelMatrices(pose, rig, model);
    const forwardKnee = new THREE.Vector3().setFromMatrixPosition(model[knee]!);
    expect(forwardKnee.z).toBeLessThan(hipPos.z - 0.05);

    copyPose(pose, rig.rest);
    poseToModelMatrices(pose, rig, model);
    solveChain(pose, rig, model, chain, target, {
      pole: new THREE.Vector3(0, 0, 1),
      poleWeight: 1,
    });
    poseToModelMatrices(pose, rig, model);
    const backKnee = new THREE.Vector3().setFromMatrixPosition(model[knee]!);
    expect(backKnee.z).toBeGreaterThan(hipPos.z + 0.05);
  });

  it('solves arms as readily as legs', () => {
    // Same solver, a different hinge axis: an elbow folds about the bind-frame
    // Y because the bind arm points sideways.
    const shoulder = rig.index.LeftArm!;
    const elbow = rig.index.LeftForeArm!;
    const wrist = rig.index.LeftHand!;
    const armChain = makeChain(rig, shoulder, elbow, wrist, new THREE.Vector3(0, 1, 0), -1);
    const pose = createPose(rig.boneCount);
    const model: THREE.Matrix4[] = [];
    const rng = createRng(7).derive('arm-ik');
    const achieved = new THREE.Vector3();
    let worst = 0;

    for (let i = 0; i < 120; i++) {
      copyPose(pose, rig.rest);
      poseToModelMatrices(pose, rig, model);
      const root = new THREE.Vector3().setFromMatrixPosition(model[shoulder]!);
      const radius = (armChain.upper + armChain.lower) * rng.range(0.25, 0.94);
      const theta = rng.range(0, Math.PI * 2);
      const phi = Math.acos(rng.range(-1, 1));
      const target = root
        .clone()
        .add(
          new THREE.Vector3(
            radius * Math.sin(phi) * Math.cos(theta),
            radius * Math.cos(phi),
            radius * Math.sin(phi) * Math.sin(theta)
          )
        );
      solveChain(pose, rig, model, armChain, target);
      poseToModelMatrices(pose, rig, model);
      achieved.setFromMatrixPosition(model[wrist]!);
      worst = Math.max(worst, achieved.distanceTo(target));
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it('works on every body in the showcase', () => {
    for (const fixture of showcaseFixtures()) {
      const r = fixture.rig;
      const c = makeChain(r, r.index.RightUpLeg!, r.index.RightLeg!, r.index.RightFoot!, X, -1);
      const pose = createPose(r.boneCount);
      const model: THREE.Matrix4[] = [];
      copyPose(pose, r.rest);
      poseToModelMatrices(pose, r, model);
      const hipPos = new THREE.Vector3().setFromMatrixPosition(model[c.root]!);
      const target = hipPos
        .clone()
        .add(new THREE.Vector3(0.1 * r.metrics.legLength, -0.75 * r.metrics.legLength, -0.3 * r.metrics.legLength));
      solveChain(pose, r, model, c, target);
      poseToModelMatrices(pose, r, model);
      const achieved = new THREE.Vector3().setFromMatrixPosition(model[c.end]!);
      expect(achieved.distanceTo(target), fixture.name).toBeLessThan(1e-6);
    }
  });
});

describe('geometric two-bone helper', () => {
  it('places the mid joint on the correct circle', () => {
    const root = new THREE.Vector3(0, 1, 0);
    const target = new THREE.Vector3(0, 0.2, 0);
    const mid = new THREE.Vector3();
    const result = twoBoneJointPositions(root, target, 0.45, 0.45, new THREE.Vector3(0, 0, -1), mid);
    expect(result.reachable).toBe(true);
    expect(mid.distanceTo(root)).toBeCloseTo(0.45, 9);
    expect(mid.distanceTo(target)).toBeCloseTo(0.45, 9);
    expect(mid.z).toBeLessThan(0);
  });

  it('reports unreachable targets', () => {
    const mid = new THREE.Vector3();
    const result = twoBoneJointPositions(
      new THREE.Vector3(),
      new THREE.Vector3(0, -5, 0),
      0.4,
      0.4,
      new THREE.Vector3(0, 0, -1),
      mid
    );
    expect(result.reachable).toBe(false);
    expect(result.distance).toBeCloseTo(5, 9);
  });
});
