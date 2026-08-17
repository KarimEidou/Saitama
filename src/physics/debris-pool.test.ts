/**
 * Debris pool: budget enforcement, LRU recycling, fading and the ballistic path.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { createRng } from '@/util';
import {
  DEBRIS_FADE_SECONDS,
  DEBRIS_HARD_CAP,
  DEBRIS_MIN_PHYSICS_SIZE,
  DebrisPool,
  FIXED_STEP,
  PhysicsWorld,
  initPhysics,
} from './index';
import { generateDebrisField, makeChunk, makeGround } from './test-support';

beforeAll(async () => {
  await initPhysics();
});

const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
const identity = new THREE.Matrix4();
const noImpulse = new THREE.Vector3(0, 0, 0);

/** A chunk large enough to be simulated. */
function bigChunk(index = 0): ReturnType<typeof makeChunk> {
  return makeChunk(index, new THREE.Vector3(0.2, 0.2, 0.2), boxGeometry);
}

/** A chunk small enough to take the ballistic path. */
function gravelChunk(index = 0): ReturnType<typeof makeChunk> {
  return makeChunk(index, new THREE.Vector3(0.04, 0.04, 0.04), boxGeometry);
}

describe('DebrisPool', () => {
  it('clamps its capacity to the hard cap', () => {
    const world = new PhysicsWorld();
    const pool = new DebrisPool(world, { capacity: 5000 });
    expect(pool.capacity).toBe(DEBRIS_HARD_CAP);
    pool.dispose();
    world.dispose();
  });

  it('pre-allocates bodies up front so a collapse allocates none', () => {
    const world = new PhysicsWorld();
    const before = world.bodyCount;
    const pool = new DebrisPool(world, { capacity: 24 });
    expect(world.bodyCount).toBe(before + 24);

    for (let i = 0; i < 24; i++) {
      pool.spawn(bigChunk(i), identity, noImpulse);
    }
    // Spawning created colliders, never bodies.
    expect(world.bodyCount).toBe(before + 24);
    expect(pool.count).toBe(24);
    pool.dispose();
    world.dispose();
  });

  it('never exceeds capacity, recycling the oldest instead', () => {
    const world = new PhysicsWorld();
    makeGround(world);
    const pool = new DebrisPool(world, { capacity: 10 });

    const ids: number[] = [];
    for (let i = 0; i < 40; i++) {
      const piece = pool.spawn(bigChunk(i), identity, noImpulse);
      expect(piece).toBeDefined();
      ids.push(piece!.id);
      expect(pool.count).toBeLessThanOrEqual(10);
    }
    expect(pool.count).toBe(10);
    // The 30 oldest are gone; the 10 newest survive.
    for (const id of ids.slice(0, 30)) expect(pool.get(id)).toBeUndefined();
    for (const id of ids.slice(30)) expect(pool.get(id)).toBeDefined();
    pool.dispose();
    world.dispose();
  });

  it('gives each recycled slot the new chunk mass, not the old one', () => {
    const world = new PhysicsWorld();
    const pool = new DebrisPool(world, { capacity: 1 });

    const small = pool.spawn(bigChunk(0), identity, noImpulse)!;
    const smallMass = world.getBody(small.bodyHandle)!.mass;

    const large = makeChunk(1, new THREE.Vector3(0.6, 0.6, 0.6), boxGeometry);
    const big = pool.spawn(large, identity, noImpulse)!;
    const bigMass = world.getBody(big.bodyHandle)!.mass;

    // 1.2 m cube vs 0.4 m cube: 27x the volume, and no residue from the first.
    expect(bigMass / smallMass).toBeCloseTo(27, 0);
    pool.dispose();
    world.dispose();
  });

  it('sends sub-threshold pieces down the ballistic path', () => {
    const world = new PhysicsWorld();
    makeGround(world);
    const pool = new DebrisPool(world, { capacity: 20 });

    const gravel = pool.spawn(gravelChunk(0), identity, noImpulse)!;
    const rock = pool.spawn(bigChunk(1), identity, noImpulse)!;
    expect(gravel.ballistic).toBe(true);
    expect(gravel.bodyHandle).toBe(-1);
    expect(rock.ballistic).toBe(false);
    expect(pool.ballisticCount).toBe(1);
    expect(pool.simulatedCount).toBe(1);
    expect(DEBRIS_MIN_PHYSICS_SIZE).toBeGreaterThan(0.08);
    pool.dispose();
    world.dispose();
  });

  it('lands a ballistic piece with exactly one bounce and then stops', () => {
    const world = new PhysicsWorld();
    const pool = new DebrisPool(world, { capacity: 4, groundY: 0 });

    const matrix = new THREE.Matrix4().makeTranslation(0, 6, 0);
    const piece = pool.spawn(gravelChunk(0), matrix, new THREE.Vector3(0, 0, 0))!;
    expect(piece.ballistic).toBe(true);

    const heights: number[] = [];
    for (let i = 0; i < 300; i++) {
      pool.update(FIXED_STEP);
      heights.push(piece.mesh.position.y);
      if (piece.settled) break;
    }
    expect(piece.settled).toBe(true);

    // Exactly one direction reversal: down, bounce up, down, stop.
    let reversals = 0;
    for (let i = 2; i < heights.length; i++) {
      const before = heights[i - 1]! - heights[i - 2]!;
      const after = heights[i]! - heights[i - 1]!;
      if (before < -1e-6 && after > 1e-6) reversals++;
    }
    expect(reversals).toBe(1);
    expect(piece.mesh.position.y).toBeGreaterThan(0);
    pool.dispose();
    world.dispose();
  });

  it('fades a piece out over the fade window before recycling it', () => {
    const world = new PhysicsWorld();
    makeGround(world);
    const pool = new DebrisPool(world, { capacity: 4, restSeconds: 0.5, fadeSeconds: 1 });
    const piece = pool.spawn(bigChunk(0), identity, noImpulse)!;
    expect(piece.fadeAlpha).toBe(1);

    for (let i = 0; i < 45; i++) {
      world.step(FIXED_STEP, 1);
      pool.update(FIXED_STEP);
    }
    expect(piece.fadeAlpha).toBeLessThan(1);
    expect(piece.fadeAlpha).toBeGreaterThan(0);

    for (let i = 0; i < 120; i++) {
      world.step(FIXED_STEP, 1);
      pool.update(FIXED_STEP);
    }
    expect(pool.count).toBe(0);
    expect(DEBRIS_FADE_SECONDS).toBe(12);
    pool.dispose();
    world.dispose();
  });

  it('settles a 300-piece pile and puts it to sleep', () => {
    const world = new PhysicsWorld();
    makeGround(world);
    const pool = new DebrisPool(world, { capacity: DEBRIS_HARD_CAP, restSeconds: 1e6 });
    const rng = createRng('debris-pile-test');
    const specs = generateDebrisField(rng, DEBRIS_HARD_CAP, {
      spread: 4,
      minHeight: 2,
      maxHeight: 18,
      minSize: 0.22,
      maxSize: 0.5,
    });
    for (const spec of specs) pool.spawn(spec.chunk, spec.matrix, spec.impulse);
    expect(pool.count).toBe(DEBRIS_HARD_CAP);
    expect(pool.simulatedCount).toBe(DEBRIS_HARD_CAP);

    for (let i = 0; i < 600; i++) {
      world.step(FIXED_STEP, 1);
      pool.update(FIXED_STEP);
    }

    // Everything has landed and nothing tunnelled through the floor.
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    let lowest = Infinity;
    let highest = -Infinity;
    for (const piece of pool.pieces) {
      const body = world.getBody(piece.bodyHandle)!;
      body.getTransform(position, rotation);
      lowest = Math.min(lowest, position.y);
      highest = Math.max(highest, position.y);
    }
    expect(lowest).toBeGreaterThan(-0.3);
    expect(highest).toBeLessThan(8);
    expect(pool.settledCount).toBeGreaterThan(DEBRIS_HARD_CAP * 0.9);

    for (const spec of specs) spec.geometry.dispose();
    pool.dispose();
    world.dispose();
  });

  it('clears everything on demand and returns slots to the free list', () => {
    const world = new PhysicsWorld();
    const pool = new DebrisPool(world, { capacity: 8 });
    for (let i = 0; i < 8; i++) pool.spawn(bigChunk(i), identity, noImpulse);
    expect(pool.count).toBe(8);
    pool.clear();
    expect(pool.count).toBe(0);
    // Slots are reusable straight away.
    const piece = pool.spawn(bigChunk(99), identity, noImpulse);
    expect(piece).toBeDefined();
    pool.dispose();
    world.dispose();
  });
});
