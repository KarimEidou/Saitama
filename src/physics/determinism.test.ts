/**
 * DETERMINISM
 *
 * The city generates from a seed, so the simulation on top of it must be
 * reproducible: same seed in, byte-identical state out. This suite is the
 * enforcement.
 *
 * The bar here is EXACT equality, not a tolerance. Rapier's solver is
 * deterministic given an identical construction sequence, so any drift would
 * mean the wrapper introduced non-determinism of its own — unseeded randomness,
 * wall-clock time, or an iteration order that depends on hash traversal. A
 * tolerance-based assertion would hide exactly those bugs until they had grown
 * large enough to be expensive.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { EventBus, createRng } from '@/util';
import {
  DebrisPool,
  FIXED_STEP,
  ImpulsePropagator,
  PhysicsWorld,
  RagdollManager,
  createReferenceRig,
  initPhysics,
  poseRigIdle,
} from './index';
import { generateDebrisField, makeGround, maxAbsDifference, snapshotPositions } from './test-support';

beforeAll(async () => {
  await initPhysics();
});

/** Drop `count` debris pieces from `seed`, settle, and snapshot every body. */
function runDebrisScenario(seed: string, count: number, steps: number): Float64Array {
  const world = new PhysicsWorld({ contactEvents: false });
  makeGround(world);
  const pool = new DebrisPool(world, {
    capacity: count,
    rng: createRng(`${seed}:debris`),
    restSeconds: 1e6,
  });

  const rng = createRng(seed);
  const specs = generateDebrisField(rng, count, {
    spread: 4,
    minHeight: 2,
    maxHeight: 16,
    minSize: 0.22,
    maxSize: 0.5,
    impulse: 40,
  });
  for (const spec of specs) pool.spawn(spec.chunk, spec.matrix, spec.impulse);

  for (let i = 0; i < steps; i++) {
    world.step(FIXED_STEP, 1);
    pool.update(FIXED_STEP);
  }

  const bodies = pool.pieces.map((piece) => world.getBody(piece.bodyHandle)!);
  const snapshot = snapshotPositions(bodies);

  for (const spec of specs) spec.geometry.dispose();
  pool.dispose();
  world.dispose();
  return snapshot;
}

/** Fire a shockwave into a settled field and snapshot the result. */
function runShockwaveScenario(seed: string, count: number): Float64Array {
  const bus = new EventBus();
  const world = new PhysicsWorld({ eventBus: bus, contactEvents: false });
  makeGround(world);
  const pool = new DebrisPool(world, {
    capacity: count,
    rng: createRng(`${seed}:debris`),
    restSeconds: 1e6,
  });
  const propagator = new ImpulsePropagator(world, { rng: createRng(`${seed}:shock`) });
  propagator.attach(bus);

  const rng = createRng(seed);
  const specs = generateDebrisField(rng, count, {
    spread: 3,
    minHeight: 1,
    maxHeight: 6,
    minSize: 0.25,
    maxSize: 0.45,
  });
  for (const spec of specs) pool.spawn(spec.chunk, spec.matrix, spec.impulse);

  for (let i = 0; i < 180; i++) world.step(FIXED_STEP, 1);
  bus.emit('ShockwaveFired', {
    origin: { x: 0, y: 0.5, z: 0 },
    direction: { x: 1, y: 0, z: 0 },
    power: 250_000,
    range: 14,
    angle: Math.PI * 0.5,
    intent: 'serious',
    punchKind: 'serious',
  });
  for (let i = 0; i < 180; i++) world.step(FIXED_STEP, 1);

  const bodies = pool.pieces.map((piece) => world.getBody(piece.bodyHandle)!);
  const snapshot = snapshotPositions(bodies);

  for (const spec of specs) spec.geometry.dispose();
  propagator.detach();
  pool.dispose();
  world.dispose();
  return snapshot;
}

/** Drop three ragdolls and snapshot every limb. */
function runRagdollScenario(seed: string): Float64Array {
  const world = new PhysicsWorld({ contactEvents: false });
  makeGround(world);
  const manager = new RagdollManager(world);
  const rng = createRng(seed);

  const ragdolls = [];
  for (let i = 0; i < 3; i++) {
    const rig = createReferenceRig(
      1.7 + rng.range(0, 0.2),
      new THREE.Vector3(rng.range(-2, 2), 0, rng.range(-2, 2))
    );
    poseRigIdle(rig);
    ragdolls.push(
      manager.spawn(rig, { driveSkeleton: false }, new THREE.Vector3(rng.range(-200, 200), 300, 0))
    );
  }

  for (let i = 0; i < 300; i++) {
    world.step(FIXED_STEP, 1);
    manager.update(FIXED_STEP);
  }

  const bodies = ragdolls.flatMap((r) => r.segments.map((s) => s.body));
  const snapshot = snapshotPositions(bodies);
  manager.dispose();
  world.dispose();
  return snapshot;
}

describe('determinism', () => {
  it('reproduces a 300-body debris settle exactly across two runs', () => {
    const a = runDebrisScenario('saitama-city-z', 300, 600);
    const b = runDebrisScenario('saitama-city-z', 300, 600);

    expect(a.length).toBe(300 * 7);
    const drift = maxAbsDifference(a, b);
    // EXACT. Not "close enough".
    expect(drift).toBe(0);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('produces a different result for a different seed', () => {
    const a = runDebrisScenario('saitama-city-z', 60, 240);
    const c = runDebrisScenario('saitama-city-y', 60, 240);
    expect(maxAbsDifference(a, c)).toBeGreaterThan(0.1);
  });

  it('reproduces shockwave propagation exactly', () => {
    const a = runShockwaveScenario('shock-seed', 80);
    const b = runShockwaveScenario('shock-seed', 80);
    expect(maxAbsDifference(a, b)).toBe(0);
  });

  it('reproduces ragdoll simulation exactly', () => {
    const a = runRagdollScenario('ragdoll-seed');
    const b = runRagdollScenario('ragdoll-seed');
    expect(a.length).toBe(3 * 13 * 7);
    expect(maxAbsDifference(a, b)).toBe(0);
  });

  it('is unaffected by a query issued mid-simulation', () => {
    // A query forces a BVH refresh; it must not perturb the simulation.
    const plain = runDebrisScenario('query-seed', 40, 120);

    const world = new PhysicsWorld({ contactEvents: false });
    makeGround(world);
    const pool = new DebrisPool(world, {
      capacity: 40,
      rng: createRng('query-seed:debris'),
      restSeconds: 1e6,
    });
    const specs = generateDebrisField(createRng('query-seed'), 40, {
      spread: 4,
      minHeight: 2,
      maxHeight: 16,
      minSize: 0.22,
      maxSize: 0.5,
      impulse: 40,
    });
    for (const spec of specs) pool.spawn(spec.chunk, spec.matrix, spec.impulse);
    for (let i = 0; i < 120; i++) {
      world.step(FIXED_STEP, 1);
      pool.update(FIXED_STEP);
      if (i % 17 === 0) world.overlapSphere(new THREE.Vector3(0, 1, 0), 6, ['debris']);
    }
    const queried = snapshotPositions(pool.pieces.map((p) => world.getBody(p.bodyHandle)!));
    for (const spec of specs) spec.geometry.dispose();
    pool.dispose();
    world.dispose();

    expect(maxAbsDifference(plain, queried)).toBe(0);
  });

  it('keeps overlap ordering stable regardless of insertion order', () => {
    const world = new PhysicsWorld({ contactEvents: false });
    const handles: number[] = [];
    for (let i = 0; i < 30; i++) {
      handles.push(
        world.createBody({
          type: 'dynamic',
          shape: { kind: 'sphere', radius: 0.2 },
          position: new THREE.Vector3(Math.sin(i) * 3, 1 + (i % 5) * 0.5, Math.cos(i) * 3),
          layer: 'debris',
          collidesWith: ['world', 'debris'],
        }).handle
      );
    }
    const first = world.overlapSphere(new THREE.Vector3(0, 1, 0), 10, ['debris']).map((b) => b.handle);
    world.step(FIXED_STEP, 20);
    const second = world
      .overlapSphere(new THREE.Vector3(0, 1, 0), 10, ['debris'])
      .map((b) => b.handle);
    expect(first).toEqual(second);
    expect(first).toEqual([...first].sort((a, b) => a - b));
    world.dispose();
  });
});
