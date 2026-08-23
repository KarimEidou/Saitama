/**
 * The composition root: the FRAME ORDER `PlayerRig` exists to write down once.
 *
 * `player-controller.test.ts` and `camera-rig.test.ts` each exercise one half
 * in isolation, and both halves keep passing when the pairing is wired the
 * wrong way round — which is exactly what makes this file worth having. The
 * order under test is:
 *
 *   1. camera yaw into the controller (the stick is camera-relative)
 *   2. the controller decides and commands one kinematic move
 *   3. the caller steps physics
 *   4. the controller re-reads the solved transform
 *   5. only then does the camera frame it
 *
 * Plus the two things only the rig owns: one tuning object forked into two
 * consumers, and a `dispose()` that has to reach two bus subscriptions.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '@/util';
import { PlayerRig } from '../player';
import { DEFAULT_CAMERA_TUNING, resolvePlayerTuning } from '../tuning';
import { InputScript, StubCharacterController } from './stubs';

const DT = 1 / 60;

function makeRig(
  options: { bus?: EventBus; tuning?: ReturnType<typeof resolvePlayerTuning> } = {}
): {
  stub: StubCharacterController;
  camera: THREE.PerspectiveCamera;
  rig: PlayerRig;
  script: InputScript;
  frame: (dt?: number) => void;
} {
  const stub = new StubCharacterController();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  const rig = new PlayerRig({ controller: stub, camera, bus: options.bus, tuning: options.tuning });
  const script = new InputScript();
  const frame = (dt = DT): void => {
    const input = script.poll(dt);
    rig.update(input, dt);
    // The stub applies the move synchronously, so "stepping the world" between
    // the two calls is a no-op here; the call sites are still contract-correct.
    rig.postPhysics(input, dt);
  };
  return { stub, camera, rig, script, frame };
}

/* -------------------------------------------------------------------------- */
/* Frame order                                                                */
/* -------------------------------------------------------------------------- */

describe('frame order', () => {
  it('adopts the camera yaw before the controller resolves intent', () => {
    const h = makeRig();
    h.rig.camera.yaw = Math.PI / 2;
    h.script.setMove(0, 1);
    h.rig.update(h.script.poll(DT), DT);

    expect(h.rig.controller.cameraYaw).toBeCloseTo(Math.PI / 2, 12);
    // Basis pi/2 puts forward on -X, so one frame of ground acceleration is
    // -46 * dt on X and nothing at all on Z. Resolve intent against a stale
    // basis and this frame travels along -Z instead.
    expect(h.rig.controller.velocity.x).toBeCloseTo(-46 * DT, 6);
    expect(Math.abs(h.rig.controller.velocity.z)).toBeLessThan(1e-9);
  });

  it('frames the transform the solver produced, not the one before the step', () => {
    const h = makeRig();
    h.script.setMove(0, 1);
    const input = h.script.poll(DT);

    h.rig.update(input, DT);
    expect(h.rig.controller.position.z).toBe(0); // cached, pre-postStep

    h.rig.postPhysics(input, DT);
    expect(h.rig.controller.position.z).toBeLessThan(-1e-3);
    // First frame: the pivot is SET, not damped, and yaw 0 puts the whole side
    // offset on X — so the pivot's z is the solved z exactly. Frame the camera
    // before re-reading the transform and it stays at 0, a 0.0128 m miss.
    expect(h.rig.camera.pivotPosition.z).toBeCloseTo(h.rig.controller.position.z, 9);
    expect(h.rig.camera.pivotPosition.y).toBeCloseTo(
      h.rig.controller.position.y + DEFAULT_CAMERA_TUNING.pivotHeightM,
      9
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Construction                                                               */
/* -------------------------------------------------------------------------- */

describe('construction', () => {
  it('starts the camera behind the controller’s facing', () => {
    const rig = new PlayerRig({
      controller: new StubCharacterController(),
      camera: new THREE.PerspectiveCamera(60, 1, 0.1, 1000),
      yaw: 0.7,
    });
    expect(rig.camera.yaw).toBeCloseTo(0.7, 12);
    expect(rig.controller.yaw).toBeCloseTo(0.7, 12);
    expect(rig.controller.cameraYaw).toBeCloseTo(0.7, 12);
  });

  it('lets an explicit camera yaw override only the camera’s', () => {
    const rig = new PlayerRig({
      controller: new StubCharacterController(),
      camera: new THREE.PerspectiveCamera(60, 1, 0.1, 1000),
      yaw: 0.7,
      cameraYaw: -0.4,
    });
    expect(rig.controller.yaw).toBeCloseTo(0.7, 12);
    expect(rig.camera.yaw).toBeCloseTo(-0.4, 12);
    expect(rig.controller.cameraYaw).toBeCloseTo(-0.4, 12);
  });

  it('hands the same tuning to both halves', () => {
    const h = makeRig({
      tuning: resolvePlayerTuning({ locomotion: { runSpeed: 12 }, camera: { armLengthM: 8 } }),
    });
    h.script.setMove(0, 1);
    for (let i = 0; i < 180; i++) h.frame();
    expect(h.rig.controller.speed).toBeCloseTo(12, 3);
    expect(h.rig.camera.armLength).toBeCloseTo(8, 6);

    const plain = makeRig();
    for (let i = 0; i < 60; i++) plain.frame();
    expect(plain.rig.camera.armLength).toBeCloseTo(DEFAULT_CAMERA_TUNING.armLengthM, 6);
  });
});

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

describe('lifecycle', () => {
  it('disposes both halves and goes inert', () => {
    const bus = new EventBus();
    const h = makeRig({ bus });
    expect(bus.listenerCount('PlayerLanded')).toBe(1);
    expect(bus.listenerCount('ShockwaveFired')).toBe(1);

    h.script.setMove(0, 1);
    for (let i = 0; i < 30; i++) h.frame();
    const at = h.rig.controller.position.clone();
    const cameraAt = h.camera.position.clone();

    h.rig.dispose();
    expect(bus.listenerCount()).toBe(0);
    expect(() => {
      for (let i = 0; i < 10; i++) h.frame();
    }).not.toThrow();
    expect(h.rig.controller.position.equals(at)).toBe(true);
    expect(h.camera.position.equals(cameraAt)).toBe(true);
    expect(() => h.rig.dispose()).not.toThrow();
  });
});
