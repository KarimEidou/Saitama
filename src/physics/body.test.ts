/**
 * Rigid body wrapper: render interpolation, teleports and wrapper state.
 *
 * `getRenderTransform` runs for every rendered body on every frame and is the
 * only non-trivial maths in the wrapper — alpha clamping, a position lerp, a
 * quaternion nlerp with a shortest-arc sign flip and a degenerate-length
 * fallback. It is also the thing that would break first if the module-level
 * read scratches handed to Rapier's accessors were ever shared across two live
 * reads, so the velocity cases below check those explicitly.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { PhysicsBody, PhysicsWorld, initPhysics } from './index';

beforeAll(async () => {
  await initPhysics();
});

/** A world with no gravity, so nothing moves except when a test moves it. */
function makeWorld(): PhysicsWorld {
  return new PhysicsWorld({ gravity: new THREE.Vector3(0, 0, 0), contactEvents: false });
}

/** A plain dynamic sphere at `position`. */
function makeBody(world: PhysicsWorld, position: THREE.Vector3): PhysicsBody {
  return world.createBody({
    type: 'dynamic',
    shape: { kind: 'sphere', radius: 0.2 },
    position,
    layer: 'debris',
    collidesWith: ['world'],
  });
}

/** Drive the wrapper's prev/curr interpolation slots explicitly. */
function setInterpolation(
  body: PhysicsBody,
  prevPos: THREE.Vector3,
  prevRot: THREE.Quaternion,
  currPos: THREE.Vector3,
  currRot: THREE.Quaternion
): void {
  body.raw.setTranslation({ x: prevPos.x, y: prevPos.y, z: prevPos.z }, false);
  body.raw.setRotation({ x: prevRot.x, y: prevRot.y, z: prevRot.z, w: prevRot.w }, false);
  body.snapshot();
  body.advanceInterpolation();
  body.raw.setTranslation({ x: currPos.x, y: currPos.y, z: currPos.z }, false);
  body.raw.setRotation({ x: currRot.x, y: currRot.y, z: currRot.z, w: currRot.w }, false);
  body.snapshot();
}

const IDENTITY = new THREE.Quaternion();

describe('PhysicsBody', () => {
  it('seeds both interpolation ends at construction', () => {
    const world = makeWorld();
    const body = makeBody(world, new THREE.Vector3(0, 7, 0));

    // Frame 0 must not blend in from the origin.
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    body.getRenderTransform(p, q, 0);
    expect(p.y).toBeCloseTo(7, 6);
    world.dispose();
  });

  it('clamps alpha to the simulated interval', () => {
    const world = makeWorld();
    const body = makeBody(world, new THREE.Vector3(0, 0, 0));
    setInterpolation(
      body,
      new THREE.Vector3(0, 0, 0),
      IDENTITY,
      new THREE.Vector3(10, 0, 0),
      IDENTITY
    );

    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    // Never extrapolate: an alpha outside [0,1] pins to an end.
    body.getRenderTransform(p, q, -1);
    expect(p.x).toBeCloseTo(0, 6);
    body.getRenderTransform(p, q, 2);
    expect(p.x).toBeCloseTo(10, 6);
    world.dispose();
  });

  it('lerps position between the two fixed steps', () => {
    const world = makeWorld();
    const body = makeBody(world, new THREE.Vector3(0, 0, 0));
    setInterpolation(
      body,
      new THREE.Vector3(0, 0, 0),
      IDENTITY,
      new THREE.Vector3(10, 0, 0),
      IDENTITY
    );

    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    body.getRenderTransform(p, q, 0.5);
    expect(p.x).toBeCloseTo(5, 6);
    world.dispose();
  });

  it('nlerps rotation and returns a unit quaternion', () => {
    const world = makeWorld();
    const body = makeBody(world, new THREE.Vector3(0, 0, 0));
    const zero = new THREE.Vector3(0, 0, 0);
    // 90 degrees about Y.
    const turned = new THREE.Quaternion(0, Math.SQRT1_2, 0, Math.SQRT1_2);
    setInterpolation(body, zero, IDENTITY, zero, turned);

    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    body.getRenderTransform(p, q, 0.5);
    // nlerp is exact at the midpoint, so half the arc is 45 degrees.
    expect(q.angleTo(IDENTITY)).toBeCloseTo(Math.PI / 4, 6);
    expect(q.length()).toBeCloseTo(1, 12);
    world.dispose();
  });

  it('takes the shorter arc through a negated quaternion', () => {
    const world = makeWorld();
    const body = makeBody(world, new THREE.Vector3(0, 0, 0));
    const zero = new THREE.Vector3(0, 0, 0);
    // The SAME orientation as the case above, written as -q. Rapier stores it
    // verbatim, so without the `dot < 0` sign flip the blend goes the long way
    // round and lands at 135 degrees instead of 45.
    const negated = new THREE.Quaternion(0, -Math.SQRT1_2, 0, -Math.SQRT1_2);
    setInterpolation(body, zero, IDENTITY, zero, negated);

    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    body.getRenderTransform(p, q, 0.5);
    expect(q.angleTo(IDENTITY)).toBeCloseTo(Math.PI / 4, 6);
    expect(q.length()).toBeCloseTo(1, 12);
    world.dispose();
  });

  it('collapses interpolation on a teleport', () => {
    const world = makeWorld();
    const body = makeBody(world, new THREE.Vector3(0, 0, 0));
    setInterpolation(
      body,
      new THREE.Vector3(0, 0, 0),
      IDENTITY,
      new THREE.Vector3(10, 0, 0),
      IDENTITY
    );

    body.setTransform(new THREE.Vector3(3, 4, 5));

    // A teleport has no continuity to blend, so every alpha is the new pose.
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    body.getRenderTransform(p, q, 0);
    expect(p.x).toBeCloseTo(3, 6);
    expect(p.y).toBeCloseTo(4, 6);
    expect(p.z).toBeCloseTo(5, 6);
    body.getRenderTransform(p, q, 1);
    expect(p.x).toBeCloseTo(3, 6);
    expect(p.y).toBeCloseTo(4, 6);
    expect(p.z).toBeCloseTo(5, 6);
    world.dispose();
  });

  it('reports -1 as the collider handle while a body has no collider', () => {
    const world = makeWorld();
    const raw = world.raw.createRigidBody(world.rapier.RigidBodyDesc.dynamic());
    const bare = new PhysicsBody(raw, undefined, 'dynamic', 'debris', undefined, () => {});
    expect(bare.colliderHandle).toBe(-1);

    const withCollider = makeBody(world, new THREE.Vector3(0, 0, 0));
    expect(withCollider.colliderHandle).toBe(withCollider.collider?.handle);
    expect(withCollider.colliderHandle).not.toBe(-1);
    world.dispose();
  });

  it('mirrors the solver enabled state', () => {
    const world = makeWorld();
    const body = makeBody(world, new THREE.Vector3(0, 0, 0));
    expect(body.isEnabled).toBe(true);

    body.setEnabled(false);
    expect(body.isEnabled).toBe(false);
    expect(body.raw.isEnabled()).toBe(false);

    // Setting the state it already has is a no-op, not a second solver call.
    body.setEnabled(false);
    expect(body.isEnabled).toBe(false);
    expect(body.raw.isEnabled()).toBe(false);

    body.setEnabled(true);
    expect(body.isEnabled).toBe(true);
    expect(body.raw.isEnabled()).toBe(true);
    world.dispose();
  });

  it('notifies the force tracker once per pending force', () => {
    const world = makeWorld();
    const raw = world.raw.createRigidBody(world.rapier.RigidBodyDesc.dynamic());
    let notified = 0;
    const body = new PhysicsBody(raw, undefined, 'dynamic', 'debris', undefined, () => {
      notified++;
    });

    const push = new THREE.Vector3(0, 10, 0);
    body.applyForce(push);
    body.applyForce(push);
    // One registration per accumulation window, however many forces land in it.
    expect(notified).toBe(1);
    expect(body.forcesPending).toBe(true);

    // What `PhysicsWorld.stepOnce` does once it has reset the solver's forces.
    body.forcesPending = false;
    body.applyForce(push);
    expect(notified).toBe(2);
    expect(body.forcesPending).toBe(true);
    world.dispose();
  });

  it('fills the caller vector on velocity reads without cross-talk', () => {
    const world = makeWorld();
    const a = makeBody(world, new THREE.Vector3(0, 0, 0));
    const b = makeBody(world, new THREE.Vector3(5, 0, 0));
    a.setLinearVelocity(new THREE.Vector3(1, 2, 3));
    b.setLinearVelocity(new THREE.Vector3(-4, -5, -6));
    a.setAngularVelocity(new THREE.Vector3(7, 8, 9));
    b.setAngularVelocity(new THREE.Vector3(-1, -2, -3));

    const va = new THREE.Vector3();
    const vb = new THREE.Vector3();
    // The accessors hand Rapier a shared module scratch; reading two bodies
    // back to back must still give each caller its own values.
    expect(a.getLinearVelocity(va)).toBe(va);
    expect(b.getLinearVelocity(vb)).toBe(vb);
    expect(va.toArray()).toEqual([1, 2, 3]);
    expect(vb.toArray()).toEqual([-4, -5, -6]);

    const wa = new THREE.Vector3();
    const wb = new THREE.Vector3();
    expect(a.getAngularVelocity(wa)).toBe(wa);
    expect(b.getAngularVelocity(wb)).toBe(wb);
    expect(wa.toArray()).toEqual([7, 8, 9]);
    expect(wb.toArray()).toEqual([-1, -2, -3]);
    world.dispose();
  });
});
