/**
 * World, layers, collider helpers and the lazy loader.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '@/util';
import {
  ALL_LAYERS,
  DEFAULT_COLLISION_MATRIX,
  FIXED_STEP,
  ImpulsePropagator,
  LAYER_BIT,
  PhysicsWorld,
  aabbHullPoints,
  groupsFor,
  heightfieldDesc,
  initPhysics,
  interactionGroups,
  isPhysicsReady,
  layerMask,
  layersInteract,
  physicsInitDurationMs,
  queryGroups,
} from './index';
import { makeGround } from './test-support';

beforeAll(async () => {
  await initPhysics();
});

describe('lazy loader', () => {
  it('reports ready and is idempotent', async () => {
    expect(isPhysicsReady()).toBe(true);
    const a = await initPhysics();
    const b = await initPhysics();
    expect(a).toBe(b);
    expect(physicsInitDurationMs()).toBeGreaterThan(0);
  });
});

describe('layers', () => {
  it('packs membership into the high bits and filter into the low bits', () => {
    const groups = interactionGroups(LAYER_BIT.debris, LAYER_BIT.world);
    expect(groups >>> 16).toBe(LAYER_BIT.debris);
    expect(groups & 0xffff).toBe(LAYER_BIT.world);
  });

  it('folds a layer list into a mask, defaulting to everything', () => {
    expect(layerMask(['world', 'player'])).toBe(LAYER_BIT.world | LAYER_BIT.player);
    expect(layerMask(undefined)).toBe(ALL_LAYERS);
    expect(layerMask([])).toBe(ALL_LAYERS);
  });

  it('builds query groups that see every layer asked for', () => {
    const groups = queryGroups(['debris']);
    expect(groups >>> 16).toBe(ALL_LAYERS);
    expect(groups & 0xffff).toBe(LAYER_BIT.debris);
  });

  it('keeps the default collision matrix symmetric', () => {
    for (const [layer, others] of Object.entries(DEFAULT_COLLISION_MATRIX)) {
      for (const other of others) {
        const back = DEFAULT_COLLISION_MATRIX[other];
        expect(
          back.includes(layer as keyof typeof DEFAULT_COLLISION_MATRIX),
          `${layer} lists ${other} but ${other} does not list ${layer}`
        ).toBe(true);
      }
    }
    expect(layersInteract('debris', 'world')).toBe(true);
    expect(layersInteract('debris', 'npc')).toBe(false);
  });

  it('produces rapier-compatible groups from a body description', () => {
    const groups = groupsFor('player', ['world', 'debris']);
    expect(groups >>> 16).toBe(LAYER_BIT.player);
    expect(groups & 0xffff).toBe(LAYER_BIT.world | LAYER_BIT.debris);
  });
});

describe('collider helpers', () => {
  it('emits eight AABB corners', () => {
    const points = aabbHullPoints(-1, -2, -3, 1, 2, 3, new Float32Array(24));
    expect(points).toHaveLength(24);
    let minX = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < 24; i += 3) {
      minX = Math.min(minX, points[i]!);
      maxZ = Math.max(maxZ, points[i + 2]!);
    }
    expect(minX).toBe(-1);
    expect(maxZ).toBe(3);
  });

  it('rejects a heightfield whose sample count does not match the grid', async () => {
    const rapier = await initPhysics();
    expect(() =>
      heightfieldDesc(rapier, 4, 4, new Float32Array(20), new THREE.Vector3(10, 1, 10))
    ).toThrow(/25 samples, got 20/);
    expect(() =>
      heightfieldDesc(rapier, 4, 4, new Float32Array(25), new THREE.Vector3(10, 1, 10))
    ).not.toThrow();
  });
});

describe('PhysicsWorld', () => {
  it('creates, finds and removes bodies', () => {
    const world = new PhysicsWorld();
    const body = world.createBody({
      type: 'dynamic',
      shape: { kind: 'sphere', radius: 0.5 },
      position: new THREE.Vector3(0, 10, 0),
      layer: 'debris',
      collidesWith: ['world'],
      entityId: 'rock-1',
      density: 2400,
    });
    expect(world.bodyCount).toBe(1);
    expect(world.getBody(body.handle)).toBe(body);
    expect(world.getBodyByEntity('rock-1')).toBe(body);
    expect(body.mass).toBeGreaterThan(1000);

    world.removeBody(body.handle);
    expect(world.bodyCount).toBe(0);
    expect(world.getBody(body.handle)).toBeUndefined();
    world.dispose();
  });

  it('drains the accumulator in whole fixed steps and exposes alpha', () => {
    const world = new PhysicsWorld();
    // Two-and-a-half steps of time buys exactly two steps.
    world.update(FIXED_STEP * 2.5);
    expect(world.lastStepCount).toBe(2);
    expect(world.alpha).toBeCloseTo(0.5, 5);

    // Less than one step buys none, and alpha keeps climbing.
    world.update(FIXED_STEP * 0.25);
    expect(world.lastStepCount).toBe(0);
    expect(world.alpha).toBeCloseTo(0.75, 5);
    world.dispose();
  });

  it('shows the newest state after an explicit step batch', () => {
    // `step()` has no leftover time, so alpha is 1 and the render transform is
    // the state just simulated rather than the one before it.
    const world = new PhysicsWorld();
    world.step(FIXED_STEP, 3);
    expect(world.alpha).toBe(1);
    world.dispose();
  });

  it('survives being disposed before the pools that live in it', () => {
    const world = new PhysicsWorld();
    const body = world.createBody({
      type: 'dynamic',
      shape: { kind: 'sphere', radius: 0.3 },
      position: new THREE.Vector3(0, 2, 0),
      layer: 'debris',
      collidesWith: ['world'],
    });
    world.dispose();
    // Removing a body from a freed world must be a no-op, not a wasm trap.
    expect(() => world.removeBody(body.handle)).not.toThrow();
    expect(world.isDisposed).toBe(true);
  });

  it('caps sub-steps so a long stall cannot spiral', () => {
    const world = new PhysicsWorld({ maxSubSteps: 4 });
    world.update(1.0);
    expect(world.lastStepCount).toBe(4);
    // Surplus time is discarded rather than owed forward.
    expect(world.alpha).toBeLessThanOrEqual(1);
    world.dispose();
  });

  it('interpolates render transforms between fixed steps', () => {
    const world = new PhysicsWorld({ gravity: new THREE.Vector3(0, -10, 0) });
    const body = world.createBody({
      type: 'dynamic',
      shape: { kind: 'sphere', radius: 0.2 },
      position: new THREE.Vector3(0, 50, 0),
      layer: 'debris',
      collidesWith: ['world'],
      canSleep: false,
    });
    world.step(FIXED_STEP, 30);

    const solver = new THREE.Vector3();
    const rot = new THREE.Quaternion();
    body.getTransform(solver, rot);

    const at1 = new THREE.Vector3();
    body.getRenderTransform(at1, rot, 1);
    expect(at1.y).toBeCloseTo(solver.y, 6);

    const at0 = new THREE.Vector3();
    body.getRenderTransform(at0, rot, 0);
    expect(at0.y).toBeGreaterThan(solver.y); // the previous step was higher up

    const half = new THREE.Vector3();
    body.getRenderTransform(half, rot, 0.5);
    expect(half.y).toBeCloseTo((at0.y + at1.y) / 2, 6);
    world.dispose();
  });

  it('raycasts against the world layer and honours exclusions', () => {
    const world = new PhysicsWorld();
    makeGround(world);
    const hit = world.raycast({
      origin: new THREE.Vector3(0, 5, 0),
      direction: new THREE.Vector3(0, -1, 0),
      maxDistance: 20,
      layers: ['world'],
    });
    expect(hit).toBeDefined();
    expect(hit!.distance).toBeCloseTo(5, 1);
    expect(hit!.normal.y).toBeGreaterThan(0.9);
    expect(hit!.layer).toBe('world');

    const excluded = world.raycast({
      origin: new THREE.Vector3(0, 5, 0),
      direction: new THREE.Vector3(0, -1, 0),
      maxDistance: 20,
      layers: ['world'],
      exclude: [hit!.body.handle],
    });
    expect(excluded).toBeUndefined();
    world.dispose();
  });

  it('returns overlap results sorted by handle so impulses stay ordered', () => {
    const world = new PhysicsWorld();
    for (let i = 0; i < 12; i++) {
      world.createBody({
        type: 'dynamic',
        shape: { kind: 'sphere', radius: 0.3 },
        position: new THREE.Vector3(i * 0.4 - 2, 1, 0),
        layer: 'debris',
        collidesWith: ['world', 'debris'],
      });
    }
    const found = world.overlapSphere(new THREE.Vector3(0, 1, 0), 5, ['debris']);
    expect(found.length).toBe(12);
    const handles = found.map((b) => b.handle);
    expect(handles).toEqual([...handles].sort((a, b) => a - b));
    world.dispose();
  });

  it('reports contacts above the force threshold', () => {
    const world = new PhysicsWorld({ contactForceThreshold: 100 });
    makeGround(world);
    world.createBody({
      type: 'dynamic',
      shape: { kind: 'box', halfExtents: new THREE.Vector3(0.4, 0.4, 0.4) },
      position: new THREE.Vector3(0, 6, 0),
      layer: 'monster',
      collidesWith: ['world'],
      density: 2400,
      canSleep: false,
    });

    let seen = 0;
    const off = world.onContact(0, () => {
      seen++;
    });
    world.step(FIXED_STEP, 120);
    off();
    expect(seen).toBeGreaterThan(0);
    world.dispose();
  });

  it('clears one-shot forces after the step that consumed them', () => {
    const world = new PhysicsWorld({ gravity: new THREE.Vector3(0, 0, 0) });
    const body = world.createBody({
      type: 'dynamic',
      shape: { kind: 'sphere', radius: 0.5 },
      position: new THREE.Vector3(0, 0, 0),
      layer: 'debris',
      collidesWith: ['world'],
      mass: 1,
      canSleep: false,
    });
    body.applyForce(new THREE.Vector3(0, 0, 100));
    world.step(FIXED_STEP, 1);
    const after1 = new THREE.Vector3();
    body.getLinearVelocity(after1);

    world.step(FIXED_STEP, 30);
    const after30 = new THREE.Vector3();
    body.getLinearVelocity(after30);
    // Velocity must be unchanged: the force lasted exactly one step.
    expect(after30.z).toBeCloseTo(after1.z, 5);
    world.dispose();
  });
});

describe('impulse propagation', () => {
  it('pushes bodies in a cone away from a shockwave on the bus', () => {
    const bus = new EventBus();
    const world = new PhysicsWorld({ eventBus: bus, gravity: new THREE.Vector3(0, 0, 0) });
    const inCone = world.createBody({
      type: 'dynamic',
      shape: { kind: 'sphere', radius: 0.3 },
      position: new THREE.Vector3(0, 0, -5),
      layer: 'debris',
      collidesWith: ['world'],
      mass: 10,
      canSleep: false,
    });
    const behind = world.createBody({
      type: 'dynamic',
      shape: { kind: 'sphere', radius: 0.3 },
      position: new THREE.Vector3(0, 0, 5),
      layer: 'debris',
      collidesWith: ['world'],
      mass: 10,
      canSleep: false,
    });

    const propagator = new ImpulsePropagator(world);
    const detach = propagator.attach(bus);

    bus.emit('ShockwaveFired', {
      origin: { x: 0, y: 0, z: 0 },
      direction: { x: 0, y: 0, z: -1 },
      power: 50_000,
      range: 12,
      angle: Math.PI / 4,
      intent: 'serious',
      punchKind: 'normal',
    });

    const v = new THREE.Vector3();
    inCone.getLinearVelocity(v);
    expect(v.length()).toBeGreaterThan(5);
    expect(v.z).toBeLessThan(0); // pushed further away, down -Z

    behind.getLinearVelocity(v);
    expect(v.length()).toBe(0); // outside the cone entirely

    expect(propagator.shockwaveCount).toBe(1);
    expect(propagator.lastAffectedCount).toBe(1);
    detach();
    world.dispose();
  });

  it('routes ImpulseApplied to the body owning the entity', () => {
    const bus = new EventBus();
    const world = new PhysicsWorld({ eventBus: bus, gravity: new THREE.Vector3(0, 0, 0) });
    const body = world.createBody({
      type: 'dynamic',
      shape: { kind: 'sphere', radius: 0.3 },
      position: new THREE.Vector3(0, 0, 0),
      layer: 'monster',
      collidesWith: ['world'],
      mass: 5,
      entityId: 'monster-7',
      canSleep: false,
    });
    const propagator = new ImpulsePropagator(world);
    const detach = propagator.attach(bus);

    bus.emit('ImpulseApplied', {
      targetId: 'monster-7',
      impulse: { x: 0, y: 50, z: 0 },
      point: { x: 0, y: 0, z: 0 },
    });

    const v = new THREE.Vector3();
    body.getLinearVelocity(v);
    expect(v.y).toBeCloseTo(10, 3); // 50 Ns / 5 kg
    detach();
    world.dispose();
  });
});
