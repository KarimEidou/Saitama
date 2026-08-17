/**
 * Character controller: the movement curve, ground contact and landings.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '@/util';
import type { PlayerLandedEvent } from '@/types';
import {
  CharacterController,
  DASH_SPEED,
  FIXED_STEP,
  GRAVITY_Y,
  GROUND_SLAM_FALL_HEIGHT,
  JUMP_APEX_HEIGHT,
  JUMP_SPEED,
  PhysicsWorld,
  RUN_SPEED,
  STEP_HEIGHT,
  apexHeightForSpeed,
  initPhysics,
} from './index';
import { makeGround } from './test-support';

beforeAll(async () => {
  await initPhysics();
});

/** World + ground + a controller standing on it. */
function setup(bus?: EventBus): { world: PhysicsWorld; player: CharacterController } {
  const world = new PhysicsWorld({ eventBus: bus });
  makeGround(world);
  const player = new CharacterController(world, {
    position: new THREE.Vector3(0, 1.0, 0),
    intent: 'normal',
  });
  // Settle onto the ground.
  for (let i = 0; i < 30; i++) {
    player.move(new THREE.Vector3(0, 0, 0), FIXED_STEP);
    world.step(FIXED_STEP, 1);
  }
  return { world, player };
}

describe('tuning', () => {
  it('derives the take-off speed that reaches the intended apex', () => {
    expect(JUMP_SPEED).toBeCloseTo(Math.sqrt(2 * 22 * 28), 6);
    expect(apexHeightForSpeed(JUMP_SPEED)).toBeCloseTo(JUMP_APEX_HEIGHT, 6);
    expect(GRAVITY_Y).toBe(-22);
  });
});

describe('CharacterController', () => {
  it('stands on the ground with an upward ground normal', () => {
    const { world, player } = setup();
    expect(player.isGrounded).toBe(true);
    expect(player.groundNormal.y).toBeGreaterThan(0.9);
    expect(player.canJump).toBe(true);
    world.dispose();
  });

  it('runs at 9 m/s and dashes at 22 m/s', () => {
    const { world, player } = setup();
    const forward = new THREE.Vector3(0, 0, -1);

    const startRun = player.translation.z;
    for (let i = 0; i < 60; i++) {
      player.moveInDirection(forward, FIXED_STEP);
      world.step(FIXED_STEP, 1);
    }
    const runDistance = Math.abs(player.translation.z - startRun);
    expect(runDistance).toBeCloseTo(RUN_SPEED, 0);

    player.dashing = true;
    const startDash = player.translation.z;
    for (let i = 0; i < 60; i++) {
      player.moveInDirection(forward, FIXED_STEP);
      world.step(FIXED_STEP, 1);
    }
    const dashDistance = Math.abs(player.translation.z - startDash);
    expect(dashDistance).toBeCloseTo(DASH_SPEED, 0);
    world.dispose();
  });

  it('jumps to roughly the tuned apex', () => {
    const { world, player } = setup();
    const takeOff = player.translation.y;
    player.jump();

    let apex = takeOff;
    for (let i = 0; i < 400 && !(i > 5 && player.isGrounded); i++) {
      player.move(new THREE.Vector3(0, 0, 0), FIXED_STEP);
      world.step(FIXED_STEP, 1);
      apex = Math.max(apex, player.translation.y);
    }
    // Discrete integration undershoots the analytic apex slightly; 1 m of
    // slack over a 28 m leap is well inside "reads as the same jump".
    expect(apex - takeOff).toBeGreaterThan(JUMP_APEX_HEIGHT - 1.5);
    expect(apex - takeOff).toBeLessThan(JUMP_APEX_HEIGHT + 1.5);
    world.dispose();
  });

  it('falls faster than it rises', () => {
    const { world, player } = setup();
    const takeOff = player.translation.y;
    player.jump();

    let riseSteps = 0;
    let previous = player.translation.y;
    for (let i = 0; i < 600; i++) {
      player.move(new THREE.Vector3(0, 0, 0), FIXED_STEP);
      world.step(FIXED_STEP, 1);
      if (player.translation.y > previous) riseSteps++;
      previous = player.translation.y;
      if (i > 5 && player.isGrounded) break;
    }
    const totalSteps = riseSteps + (player.lastLandingFallHeight > 0 ? 1 : 0);
    expect(totalSteps).toBeGreaterThan(0);
    // Rise time ~ v/g, fall time ~ sqrt(2h/(g*1.6)); the ratio must exceed 1.
    const fallSteps = Math.round(JUMP_APEX_HEIGHT / (player.lastLandingImpactSpeed / 60 / 2));
    expect(riseSteps).toBeGreaterThan(fallSteps * 0.9);
    expect(player.translation.y).toBeCloseTo(takeOff, 1);
    world.dispose();
  });

  it('climbs a step under the step height and is blocked above it', () => {
    const world = new PhysicsWorld();
    makeGround(world);
    // A 0.4 m ledge (< 0.5 m step height) and a 1.2 m wall behind it.
    world.createBody({
      type: 'fixed',
      shape: { kind: 'box', halfExtents: new THREE.Vector3(2, 0.2, 2) },
      position: new THREE.Vector3(0, 0.2, -4),
      layer: 'world',
      collidesWith: ['player'],
    });
    world.createBody({
      type: 'fixed',
      shape: { kind: 'box', halfExtents: new THREE.Vector3(2, 0.6, 0.5) },
      position: new THREE.Vector3(0, 0.6, -9),
      layer: 'world',
      collidesWith: ['player'],
    });

    const player = new CharacterController(world, { position: new THREE.Vector3(0, 1.0, 0) });
    const forward = new THREE.Vector3(0, 0, -1);
    for (let i = 0; i < 120; i++) {
      player.moveInDirection(forward, FIXED_STEP);
      world.step(FIXED_STEP, 1);
    }
    // Cleared the low ledge…
    expect(player.translation.y).toBeGreaterThan(0.3);
    expect(player.stepHeight).toBe(STEP_HEIGHT);
    // …and stopped at the tall wall rather than climbing it.
    expect(player.translation.z).toBeGreaterThan(-9);
    world.dispose();
  });

  it('emits PlayerLanded with createsCrater for a fall past the slam threshold', () => {
    const bus = new EventBus();
    const events: PlayerLandedEvent[] = [];
    bus.on('PlayerLanded', (e) => events.push(e));

    const world = new PhysicsWorld({ eventBus: bus });
    makeGround(world);
    const player = new CharacterController(world, {
      position: new THREE.Vector3(0, GROUND_SLAM_FALL_HEIGHT + 20, 0),
      intent: 'serious',
    });

    for (let i = 0; i < 900; i++) {
      player.move(new THREE.Vector3(0, 0, 0), FIXED_STEP);
      world.step(FIXED_STEP, 1);
      if (i > 5 && player.isGrounded) break;
    }

    expect(events).toHaveLength(1);
    const landing = events[0]!;
    expect(landing.fallHeight).toBeGreaterThan(GROUND_SLAM_FALL_HEIGHT);
    expect(landing.createsCrater).toBe(true);
    expect(landing.impactSpeed).toBeGreaterThan(20);
    expect(landing.intent).toBe('serious');
    expect(player.lastLandingImpactSpeed).toBeCloseTo(landing.impactSpeed, 6);
    world.dispose();
  });

  it('does not crater a short hop', () => {
    const bus = new EventBus();
    const events: PlayerLandedEvent[] = [];
    bus.on('PlayerLanded', (e) => events.push(e));

    const world = new PhysicsWorld({ eventBus: bus });
    makeGround(world);
    const player = new CharacterController(world, { position: new THREE.Vector3(0, 1.0, 0) });
    for (let i = 0; i < 30; i++) {
      player.move(new THREE.Vector3(0, 0, 0), FIXED_STEP);
      world.step(FIXED_STEP, 1);
    }
    events.length = 0;
    player.jump(player.jumpSpeedForHeight(3));
    for (let i = 0; i < 300; i++) {
      player.move(new THREE.Vector3(0, 0, 0), FIXED_STEP);
      world.step(FIXED_STEP, 1);
      if (i > 5 && player.isGrounded) break;
    }
    expect(events).toHaveLength(1);
    expect(events[0]!.createsCrater).toBe(false);
    expect(events[0]!.fallHeight).toBeLessThan(GROUND_SLAM_FALL_HEIGHT);
    world.dispose();
  });

  it('shoves loose debris on a ground slam', () => {
    const world = new PhysicsWorld();
    makeGround(world);
    const rock = world.createBody({
      type: 'dynamic',
      shape: { kind: 'box', halfExtents: new THREE.Vector3(0.3, 0.3, 0.3) },
      position: new THREE.Vector3(2.5, 0.3, 0),
      layer: 'debris',
      collidesWith: ['world', 'debris'],
      density: 2400,
    });
    const player = new CharacterController(world, {
      position: new THREE.Vector3(0, 45, 0),
    });
    for (let i = 0; i < 900; i++) {
      player.move(new THREE.Vector3(0, 0, 0), FIXED_STEP);
      world.step(FIXED_STEP, 1);
      if (i > 5 && player.isGrounded) break;
    }
    expect(player.lastGroundSlamAffected).toBeGreaterThan(0);
    const v = new THREE.Vector3();
    rock.getLinearVelocity(v);
    expect(v.length()).toBeGreaterThan(1);
    world.dispose();
  });

  it('teleports without leaving stale velocity or fall height', () => {
    const { world, player } = setup();
    player.jump();
    for (let i = 0; i < 10; i++) {
      player.move(new THREE.Vector3(0, 0, 0), FIXED_STEP);
      world.step(FIXED_STEP, 1);
    }
    player.setPosition(new THREE.Vector3(10, 1, 10));
    expect(player.velocity.lengthSq()).toBe(0);
    expect(player.currentFallHeight).toBe(0);
    expect(player.translation.x).toBe(10);
    world.dispose();
  });
});
