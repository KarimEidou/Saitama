/**
 * Ragdolls: construction, pose blending, stability and the 8-ragdoll budget.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import {
  FIXED_STEP,
  MAX_ACTIVE_RAGDOLLS,
  PhysicsWorld,
  RAGDOLL_BLEND_SECONDS,
  RAGDOLL_BODY_COUNT,
  RAGDOLL_SEGMENTS,
  Ragdoll,
  RagdollManager,
  createRagdoll,
  createReferenceRig,
  estimateRigHeight,
  initPhysics,
  poseRigIdle,
} from './index';
import { makeGround } from './test-support';

beforeAll(async () => {
  await initPhysics();
});

/** Build a rig standing at `x`, posed out of its T-pose. */
function rigAt(x: number): ReturnType<typeof createReferenceRig> {
  const rig = createReferenceRig(1.75, new THREE.Vector3(x, 0, 0));
  poseRigIdle(rig);
  return rig;
}

/** Simulate `seconds` of world + ragdoll time. */
function simulate(world: PhysicsWorld, ragdolls: readonly Ragdoll[], seconds: number): void {
  const steps = Math.round(seconds / FIXED_STEP);
  for (let i = 0; i < steps; i++) {
    world.step(FIXED_STEP, 1);
    for (const ragdoll of ragdolls) ragdoll.update(FIXED_STEP);
  }
}

/** Largest linear speed across a ragdoll's limbs. */
function maxSpeed(ragdoll: Ragdoll): number {
  const v = new THREE.Vector3();
  let max = 0;
  for (const segment of ragdoll.segments) {
    segment.body.getLinearVelocity(v);
    max = Math.max(max, v.length());
  }
  return max;
}

/** Largest gap between a joint's two anchor points, in metres. */
function maxJointSeparation(ragdoll: Ragdoll): number {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const q = new THREE.Quaternion();
  let worst = 0;
  for (const segment of ragdoll.segments) {
    if (segment.joint === undefined) continue;
    const j = segment.joint;
    const p1 = j.body1().translation();
    const r1 = j.body1().rotation();
    const p2 = j.body2().translation();
    const r2 = j.body2().rotation();
    const anchor1 = j.anchor1();
    const anchor2 = j.anchor2();
    a.set(anchor1.x, anchor1.y, anchor1.z)
      .applyQuaternion(q.set(r1.x, r1.y, r1.z, r1.w))
      .add(new THREE.Vector3(p1.x, p1.y, p1.z));
    b.set(anchor2.x, anchor2.y, anchor2.z)
      .applyQuaternion(q.set(r2.x, r2.y, r2.z, r2.w))
      .add(new THREE.Vector3(p2.x, p2.y, p2.z));
    worst = Math.max(worst, a.distanceTo(b));
  }
  return worst;
}

describe('ragdoll rig', () => {
  it('describes exactly 13 segments with 12 joints', () => {
    expect(RAGDOLL_SEGMENTS).toHaveLength(RAGDOLL_BODY_COUNT);
    expect(RAGDOLL_BODY_COUNT).toBe(13);
    const rooted = RAGDOLL_SEGMENTS.filter((s) => s.parent === undefined);
    expect(rooted).toHaveLength(1);
    expect(rooted[0]!.name).toBe('pelvis');

    // Every parent must be declared before the child that references it.
    const seen = new Set<string>();
    for (const spec of RAGDOLL_SEGMENTS) {
      if (spec.parent !== undefined) expect(seen.has(spec.parent)).toBe(true);
      seen.add(spec.name);
    }
  });

  it('maps onto the humanoid skeleton', () => {
    const rig = createReferenceRig();
    for (const spec of RAGDOLL_SEGMENTS) {
      expect(rig.getBone(spec.bone), `missing ${spec.bone}`).toBeDefined();
      expect(rig.getBone(spec.tipBone), `missing ${spec.tipBone}`).toBeDefined();
    }
    // Every bone in the `BoneName` union is present in the reference rig.
    expect(rig.bones.size).toBe(27);
    expect(estimateRigHeight(rig)).toBeGreaterThan(1.6);
  });
});

describe('Ragdoll', () => {
  it('builds 13 bodies and 12 joints, disabled until activated', () => {
    const world = new PhysicsWorld();
    makeGround(world);
    const ragdoll = createRagdoll(world, rigAt(0));

    expect(ragdoll.bodies).toHaveLength(13);
    expect(ragdoll.segments.filter((s) => s.joint !== undefined)).toHaveLength(12);
    expect(ragdoll.active).toBe(false);
    for (const segment of ragdoll.segments) expect(segment.body.isEnabled).toBe(false);

    ragdoll.activate();
    expect(ragdoll.active).toBe(true);
    for (const segment of ragdoll.segments) expect(segment.body.isEnabled).toBe(true);
    ragdoll.dispose();
    world.dispose();
  });

  it('has a plausible total mass for a 1.75 m adult', () => {
    const world = new PhysicsWorld();
    const ragdoll = createRagdoll(world, rigAt(0));
    let total = 0;
    for (const body of ragdoll.bodies) total += body.mass;
    expect(total).toBeGreaterThan(35);
    expect(total).toBeLessThan(130);
    ragdoll.dispose();
    world.dispose();
  });

  it('settles under gravity without exploding or jittering', () => {
    const world = new PhysicsWorld();
    makeGround(world);
    const ragdoll = createRagdoll(world, rigAt(0));
    ragdoll.activate();

    const start = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    ragdoll.segments[0]!.body.getTransform(start, rotation);

    simulate(world, [ragdoll], 4);

    const end = new THREE.Vector3();
    for (const segment of ragdoll.segments) {
      segment.body.getTransform(end, rotation);
      expect(Number.isFinite(end.x) && Number.isFinite(end.y) && Number.isFinite(end.z)).toBe(true);
      // Nothing may be launched: a 4 s settle from a standing pose stays local.
      expect(end.distanceTo(start)).toBeLessThan(4);
      // Nothing may fall through the floor either.
      expect(end.y).toBeGreaterThan(-0.5);
    }

    // Settled means slow. Not necessarily asleep — contact chatter in a limb
    // pile can keep one body awake — but nothing may still be moving fast.
    expect(maxSpeed(ragdoll)).toBeLessThan(0.6);
    ragdoll.dispose();
    world.dispose();
  });

  it('keeps its joints together under a heavy impulse', () => {
    const world = new PhysicsWorld();
    makeGround(world);
    const ragdoll = createRagdoll(world, rigAt(0));
    // A Saitama-scale hit: 3000 Ns into the chest.
    ragdoll.activate(new THREE.Vector3(1800, 1200, 0), new THREE.Vector3(0, 1.3, 0));

    let worstSeparation = 0;
    for (let i = 0; i < 240; i++) {
      world.step(FIXED_STEP, 1);
      ragdoll.update(FIXED_STEP);
      worstSeparation = Math.max(worstSeparation, maxJointSeparation(ragdoll));
    }
    // Spherical joints are hard constraints; a few centimetres of solver
    // stretch is normal, limbs coming off is not.
    expect(worstSeparation).toBeLessThan(0.2);
    ragdoll.dispose();
    world.dispose();
  });

  it('respects its joint limits instead of folding backwards', () => {
    const world = new PhysicsWorld();
    makeGround(world);
    const rig = rigAt(0);
    const ragdoll = createRagdoll(world, rig);
    ragdoll.activate();
    simulate(world, [ragdoll], 3);

    // The knee is a hinge: the shin must not have rotated a long way out of
    // the thigh's plane, which is what an unlimited spherical joint permits.
    const thigh = ragdoll.segment('leftThigh')!;
    const shin = ragdoll.segment('leftShin')!;
    const qThigh = new THREE.Quaternion();
    const qShin = new THREE.Quaternion();
    const p = new THREE.Vector3();
    thigh.body.getTransform(p, qThigh);
    shin.body.getTransform(p, qShin);
    const relative = qThigh.clone().invert().multiply(qShin);
    const angle = 2 * Math.acos(Math.min(1, Math.abs(relative.w)));
    // Well under the 130 degree flexion limit plus solver slack.
    expect(angle).toBeLessThan((150 * Math.PI) / 180);
    ragdoll.dispose();
    world.dispose();
  });

  it('blends from the animated pose over ~120 ms', () => {
    const world = new PhysicsWorld();
    makeGround(world);
    const rig = rigAt(0);
    const ragdoll = createRagdoll(world, rig);

    const head = rig.getBone('Head')!;
    const poseRotation = head.quaternion.clone();

    ragdoll.activate();
    expect(ragdoll.blend).toBe(0);

    // One frame in: physics owns almost none of the pose yet.
    world.step(FIXED_STEP, 1);
    ragdoll.update(FIXED_STEP);
    expect(ragdoll.blend).toBeLessThan(0.2);
    expect(head.quaternion.angleTo(poseRotation)).toBeLessThan(0.05);

    // Past the blend window, physics owns all of it.
    simulate(world, [ragdoll], RAGDOLL_BLEND_SECONDS * 2);
    expect(ragdoll.blend).toBe(1);
    ragdoll.dispose();
    world.dispose();
  });

  it('seeds limb velocity from the pose motion before activation', () => {
    const world = new PhysicsWorld();
    makeGround(world);
    const rig = rigAt(0);
    const ragdoll = createRagdoll(world, rig);

    // Two tracked frames of the character sprinting along +X.
    ragdoll.update(FIXED_STEP);
    rig.root.position.x += 6 * FIXED_STEP;
    rig.root.updateMatrixWorld(true);
    ragdoll.activate();

    const v = new THREE.Vector3();
    ragdoll.segments[0]!.body.getLinearVelocity(v);
    expect(v.x).toBeGreaterThan(3);
    expect(v.x).toBeLessThan(9);
    ragdoll.dispose();
    world.dispose();
  });
});

describe('RagdollManager', () => {
  it('caps active ragdolls, freezing and fading the oldest', () => {
    const world = new PhysicsWorld();
    makeGround(world);
    const manager = new RagdollManager(world);
    expect(manager.maxActive).toBe(MAX_ACTIVE_RAGDOLLS);

    const spawned: Ragdoll[] = [];
    for (let i = 0; i < MAX_ACTIVE_RAGDOLLS; i++) {
      spawned.push(manager.spawn(rigAt(i * 3)));
    }
    expect(manager.activeCount).toBe(MAX_ACTIVE_RAGDOLLS);
    expect(spawned.every((r) => !r.frozen)).toBe(true);

    // The ninth pushes the oldest out.
    const ninth = manager.spawn(rigAt(-4));
    expect(manager.activeCount).toBe(MAX_ACTIVE_RAGDOLLS);
    expect(spawned[0]!.frozen).toBe(true);
    expect(ninth.frozen).toBe(false);

    // The frozen one fades and is reaped.
    expect(spawned[0]!.fadeAlpha).toBe(1);
    for (let i = 0; i < 200; i++) {
      world.step(FIXED_STEP, 1);
      manager.update(FIXED_STEP);
    }
    expect(spawned[0]!.fadeAlpha).toBeLessThan(1);

    for (let i = 0; i < 200; i++) {
      world.step(FIXED_STEP, 1);
      manager.update(FIXED_STEP);
    }
    expect(manager.all.includes(spawned[0]!)).toBe(false);
    manager.dispose();
    world.dispose();
  });

  it('removes every body and joint on dispose', () => {
    const world = new PhysicsWorld();
    makeGround(world);
    const before = world.bodyCount;
    const manager = new RagdollManager(world);
    manager.spawn(rigAt(0));
    expect(world.bodyCount).toBe(before + 13);
    manager.dispose();
    expect(world.bodyCount).toBe(before);
    expect(world.raw.impulseJoints.len()).toBe(0);
    world.dispose();
  });
});
