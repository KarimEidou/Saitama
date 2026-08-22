/**
 * The third-person spring arm: arm length by state, the collision sweep, the
 * speed-driven FOV and its stand-down, look rate, and the impact lag.
 *
 * The probe is analytic (`wallProbe`), not a solver, so every clearance
 * assertion here is exact rather than approximate. The messy case — a real
 * BVH, a real alley, a real character — is measured in `harness/player.*`.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { EventBus, wrapAngle } from '@/util';
import type { IPhysicsWorld } from '@/types';
import { ThirdPersonCameraRig, createPhysicsCameraProbe, type ICameraTarget } from '../camera-rig';
import { DEFAULT_CAMERA_TUNING, DEFAULT_PLAYER_TUNING } from '../tuning';
import { InputScript, wallProbe } from './stubs';

const DT = 1 / 60;
const C = DEFAULT_CAMERA_TUNING;

class MutableTarget implements ICameraTarget {
  readonly position = new THREE.Vector3(0, 0.875, 0);
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  heightAboveGround = 0;
  isCharging = false;
}

interface Rig {
  readonly rig: ThirdPersonCameraRig;
  readonly camera: THREE.PerspectiveCamera;
  readonly target: MutableTarget;
  readonly input: InputScript;
  run(frames: number, observe?: (frame: number) => void): void;
}

function setup(
  options: { probe?: ReturnType<typeof wallProbe>; bus?: EventBus; yaw?: number } = {}
): Rig {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  const target = new MutableTarget();
  const input = new InputScript();
  const rig = new ThirdPersonCameraRig({
    camera,
    target,
    probe: options.probe ?? null,
    bus: options.bus,
    yaw: options.yaw ?? 0,
  });
  return {
    rig,
    camera,
    target,
    input,
    run(frames: number, observe?: (frame: number) => void): void {
      for (let i = 0; i < frames; i++) {
        rig.update(input.poll(DT), DT);
        observe?.(i);
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Placement                                                                  */
/* -------------------------------------------------------------------------- */

describe('placement', () => {
  it('sits behind and above the character at the resting arm length', () => {
    const r = setup();
    r.run(120);
    const pivot = r.rig.pivotPosition;
    expect(r.camera.position.distanceTo(pivot)).toBeCloseTo(C.armLengthM, 3);
    // Yaw 0 puts the camera at +Z, i.e. behind a character facing -Z.
    expect(r.camera.position.z).toBeGreaterThan(pivot.z);
    expect(r.camera.position.y).toBeGreaterThan(pivot.y);
  });

  it('leads the look-at point along the character’s velocity', () => {
    const r = setup();
    r.run(60);
    const still = r.rig.diagnostics().lookAhead;
    r.target.velocity.set(0, 0, -DEFAULT_PLAYER_TUNING.locomotion.dashSpeed);
    r.run(120);
    const moving = r.rig.diagnostics().lookAhead;
    expect(still).toBeLessThan(0.01);
    expect(moving).toBeGreaterThan(1);
    expect(moving).toBeLessThanOrEqual(C.lookAheadMaxM + 1e-6);
  });
});

/* -------------------------------------------------------------------------- */
/* Arm length by state                                                        */
/* -------------------------------------------------------------------------- */

describe('arm length', () => {
  it('extends to the charging length while a serious punch winds up', () => {
    const r = setup();
    r.run(60);
    expect(r.rig.armLength).toBeCloseTo(C.armLengthM, 2);
    r.target.isCharging = true;
    r.run(180);
    expect(r.rig.armLength).toBeCloseTo(C.armLengthChargingM, 1);
    r.target.isCharging = false;
    r.run(240);
    expect(r.rig.armLength).toBeCloseTo(C.armLengthM, 1);
  });

  it('extends to the apex length high above the ground', () => {
    const r = setup();
    r.run(60);
    r.target.heightAboveGround = 27;
    r.run(180);
    expect(r.rig.armLength).toBeCloseTo(C.armLengthApexM, 1);
    expect(r.rig.diagnostics().apexFactor).toBe(1);
  });

  it('takes the maximum of the three demands, not the last one evaluated', () => {
    const r = setup();
    r.target.heightAboveGround = 27;
    r.target.isCharging = true;
    r.run(240);
    expect(r.rig.armLength).toBeCloseTo(C.armLengthApexM, 1);
  });

  it('reaches the apex length within the time a real leap spends climbing', () => {
    const r = setup();
    r.run(30);
    // Height rises the way a held jump does: past the start threshold in
    // ~0.45 s and to apex in ~1.4 s.
    let reached = -1;
    const climbFrames = 84; // 1.4 s
    r.run(climbFrames, (i) => {
      r.target.heightAboveGround = 27 * Math.sin((Math.PI / 2) * ((i + 1) / climbFrames));
      if (reached < 0 && r.rig.armLength > C.armLengthApexM - 0.5) reached = i + 1;
    });
    expect(reached).toBeGreaterThan(0);
    expect(reached).toBeLessThanOrEqual(climbFrames);
  });

  it('pinch rescales the resting arm, within limits', () => {
    const r = setup();
    r.run(60);
    for (let i = 0; i < 30; i++) {
      r.input.setPinch(1.2);
      r.run(1);
    }
    r.run(180);
    expect(r.rig.armLength).toBeLessThan(C.armLengthM);
    expect(r.rig.armLength).toBeGreaterThanOrEqual(C.armLengthM * 0.6 - 1e-6);
  });
});

/* -------------------------------------------------------------------------- */
/* Collision                                                                  */
/* -------------------------------------------------------------------------- */

describe('collision', () => {
  /** Face the camera at +X so the wall probe is in the arm's path. */
  function facingWall(planeX: number): Rig {
    return setup({ probe: wallProbe(planeX), yaw: Math.PI / 2 });
  }

  it('shortens the arm rather than putting the camera through a wall', () => {
    const r = facingWall(2);
    r.run(120);
    const pivot = r.rig.pivotPosition;
    expect(r.camera.position.x).toBeLessThan(2);
    expect(r.rig.armLength).toBeLessThan(C.armLengthM);
    expect(r.rig.isOccluded).toBe(true);
    // The clearance the tuning promises, measured along the arm.
    const distance = r.camera.position.distanceTo(pivot);
    expect(2 - r.camera.position.x).toBeGreaterThan(C.probeClearanceM * 0.5);
    expect(distance).toBeCloseTo(r.rig.armLength, 6);
  });

  it('pulls in on the SAME frame the wall appears — no smoothing inward', () => {
    let planeX = 100;
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    const target = new MutableTarget();
    const input = new InputScript();
    const rig = new ThirdPersonCameraRig({
      camera,
      target,
      yaw: Math.PI / 2,
      probe: {
        probe(origin, direction, maxDistance): number {
          if (direction.x <= 1e-6) return Number.POSITIVE_INFINITY;
          const d = (planeX - origin.x) / direction.x;
          return d < 0 || d > maxDistance ? Number.POSITIVE_INFINITY : d;
        },
      },
    });
    for (let i = 0; i < 60; i++) rig.update(input.poll(DT), DT);
    expect(rig.armLength).toBeCloseTo(C.armLengthM, 3);

    planeX = 1.5;
    rig.update(input.poll(DT), DT);
    expect(rig.armLength).toBeLessThan(1.5);
    expect(camera.position.x).toBeLessThan(1.5);
  });

  it('pushes back out under a rate limit once the wall is gone', () => {
    let planeX = 2;
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    const target = new MutableTarget();
    const input = new InputScript();
    const rig = new ThirdPersonCameraRig({
      camera,
      target,
      yaw: Math.PI / 2,
      probe: {
        probe(origin, direction, maxDistance): number {
          if (direction.x <= 1e-6) return Number.POSITIVE_INFINITY;
          const d = (planeX - origin.x) / direction.x;
          return d < 0 || d > maxDistance ? Number.POSITIVE_INFINITY : d;
        },
      },
    });
    for (let i = 0; i < 60; i++) rig.update(input.poll(DT), DT);
    const shortened = rig.armLength;
    expect(shortened).toBeLessThan(C.armLengthM);

    planeX = 100;
    // EVERY frame of the recovery, not just the first. Sampling only the frame
    // after the wall vanishes cannot see the real failure: the cap used to be
    // gated on last frame's occlusion flag, which the (short) sweep cleared the
    // instant the blocker left its range, so frame two snapped the whole way
    // back to the resting length at 22x the cap.
    let previous = shortened;
    let frames = 0;
    for (let i = 0; i < 200 && previous < C.armLengthM - 1e-6; i++) {
      rig.update(input.poll(DT), DT);
      const step = rig.armLength - previous;
      expect(step, `frame ${i}`).toBeLessThanOrEqual(C.armRecoverSpeedMps * DT + 1e-6);
      previous = rig.armLength;
      frames++;
    }
    // Which also means the recovery cannot be quicker than the cap allows.
    expect(frames * DT).toBeGreaterThanOrEqual(
      (C.armLengthM - shortened) / C.armRecoverSpeedMps - DT
    );

    for (let i = 0; i < 120; i++) rig.update(input.poll(DT), DT);
    expect(rig.armLength).toBeCloseTo(C.armLengthM, 3);
    expect(rig.isOccluded).toBe(false);
  });

  it('keeps the cap while a receding blocker is still inside the arm it wants', () => {
    // The sweep has to reach as far as the arm is trying to grow back to, or
    // the rig is blind to the very blocker it is recovering away from.
    let planeX = 2;
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    const target = new MutableTarget();
    const input = new InputScript();
    const rig = new ThirdPersonCameraRig({
      camera,
      target,
      yaw: Math.PI / 2,
      probe: {
        probe(origin, direction, maxDistance): number {
          if (direction.x <= 1e-6) return Number.POSITIVE_INFINITY;
          const d = (planeX - origin.x) / direction.x;
          return d < 0 || d > maxDistance ? Number.POSITIVE_INFINITY : d;
        },
      },
    });
    for (let i = 0; i < 60; i++) rig.update(input.poll(DT), DT);
    expect(rig.armLength).toBeLessThan(C.armLengthM);

    // The wall steps back to 3 m — still well inside the 4.5 m resting arm.
    planeX = 3;
    rig.update(input.poll(DT), DT);
    expect(rig.isOccluded).toBe(true);
    expect(rig.armLength).toBeLessThan(3);
  });

  it('never goes below the minimum arm even flush against geometry', () => {
    const r = facingWall(0.05);
    r.run(120);
    expect(r.rig.armLength).toBeGreaterThanOrEqual(C.armLengthMinM - 1e-6);
  });

  it('does not shorten for geometry the arm never reaches', () => {
    const r = facingWall(40);
    r.run(120);
    expect(r.rig.armLength).toBeCloseTo(C.armLengthM, 3);
    expect(r.rig.isOccluded).toBe(false);
    expect(r.rig.diagnostics().nearestBlocker).toBe(Number.POSITIVE_INFINITY);
  });
});

/* -------------------------------------------------------------------------- */
/* Orientation                                                                */
/* -------------------------------------------------------------------------- */

describe('orientation', () => {
  it('treats look as a RATE: one second at full deflection is the full rate', () => {
    const r = setup();
    r.run(1);
    r.input.setLook(1, 0);
    // Summed along the shortest arc: a 220 degree sweep passes through the
    // +-180 degree wrap, so a raw subtraction would report 140.
    let previous = r.rig.yaw;
    let swept = 0;
    r.run(60, () => {
      swept += Math.abs(wrapAngle(r.rig.yaw - previous));
      previous = r.rig.yaw;
    });
    expect((swept * 180) / Math.PI).toBeCloseTo(C.lookFullRateDegPerSec, 0);
  });

  it('is frame-rate independent', () => {
    const spin = (dt: number, frames: number): number => {
      const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
      const rig = new ThirdPersonCameraRig({ camera, target: new MutableTarget(), yaw: 0 });
      const input = new InputScript().setLook(1, 0);
      for (let i = 0; i < frames; i++) rig.update(input.poll(dt), dt);
      return rig.yaw;
    };
    expect(spin(1 / 60, 30)).toBeCloseTo(spin(1 / 30, 15), 6);
  });

  it('clamps pitch to the tuned band', () => {
    const r = setup();
    r.input.setLook(0, 1);
    r.run(300);
    expect(r.rig.diagnostics().pitchDeg).toBeGreaterThanOrEqual(C.minPitchDeg - 1e-6);
    r.input.setLook(0, -1);
    r.run(300);
    expect(r.rig.diagnostics().pitchDeg).toBeLessThanOrEqual(C.maxPitchDeg + 1e-6);
  });

  it('eases the pitch down at apex without overriding the player', () => {
    const r = setup();
    r.run(60);
    const resting = r.rig.diagnostics().pitchDeg;
    r.target.heightAboveGround = 27;
    r.run(240);
    expect(r.rig.diagnostics().pitchDeg).toBeGreaterThan(resting + 10);
    // Coming back down returns the bias, leaving the player's pitch untouched.
    r.target.heightAboveGround = 0;
    r.run(240);
    expect(r.rig.diagnostics().pitchDeg).toBeCloseTo(resting, 1);
  });

  it('gives back every degree the apex bias borrowed, at the band edge too', () => {
    // The bias is ADDITIVE by design. Clamping the stored player value against
    // a band shifted by the bias made it destructive instead: a player looking
    // down at the tuned maximum lost 22 degrees to every leap and never got
    // them back, so the camera crept upward over a session.
    const r = setup();
    r.input.setLook(0, -1);
    r.run(300);
    r.input.setLook(0, 0);
    const authored = r.rig.diagnostics().pitchDeg;
    expect(authored).toBeCloseTo(C.maxPitchDeg, 3);

    r.target.heightAboveGround = 27;
    r.run(240);
    // The total stays inside the tuned band even at full bias.
    expect(r.rig.diagnostics().pitchDeg).toBeLessThanOrEqual(C.maxPitchDeg + 1e-6);

    r.target.heightAboveGround = 0;
    r.run(240);
    expect(r.rig.diagnostics().pitchDeg).toBeCloseTo(authored, 3);
  });

  it('recentres behind the character on demand', () => {
    const r = setup();
    r.run(30);
    r.target.yaw = 1.2;
    r.input.press('cameraReset');
    r.run(1);
    r.input.release('cameraReset');
    expect(r.rig.yaw).toBeCloseTo(1.2, 6);
  });
});

/* -------------------------------------------------------------------------- */
/* Field of view                                                              */
/* -------------------------------------------------------------------------- */

describe('field of view', () => {
  it('widens with speed and settles at both ends', () => {
    const r = setup();
    r.run(120);
    expect(r.camera.fov).toBeCloseTo(C.fovBaseDeg, 2);
    r.target.velocity.set(0, 0, -DEFAULT_PLAYER_TUNING.locomotion.dashSpeed);
    r.run(300);
    expect(r.camera.fov).toBeCloseTo(C.fovMaxDeg, 1);
  });

  it('stands down while another system owns the FOV, then resumes cleanly', () => {
    const r = setup();
    r.run(120);
    const owned = r.camera.fov;

    // Stand in for the impact freeze: snapshot, punch in, hold.
    const snapshot = r.camera.fov;
    r.camera.fov = snapshot - 8;
    r.target.velocity.set(0, 0, -20);
    r.run(30);
    expect(r.rig.diagnostics().fovSuspended).toBe(true);
    // The rig has not touched it: the freeze's own restore value is still valid.
    expect(r.camera.fov).toBeCloseTo(snapshot - 8, 6);

    // Freeze ends and restores exactly what it snapshotted.
    r.camera.fov = snapshot;
    r.run(1);
    expect(r.rig.diagnostics().fovSuspended).toBe(false);
    // No pop: the rig resumes from the value it stood down at and eases toward
    // the speed target, rather than snapping to it.
    const resumed = r.camera.fov;
    expect(resumed).toBeGreaterThanOrEqual(owned - 1e-6);
    expect(resumed - owned).toBeLessThan(2);
    r.run(600);
    expect(r.camera.fov).toBeGreaterThan(owned + 10);
  });

  it('widens as collision crushes the arm, and only then', () => {
    const open = setup({ probe: wallProbe(60), yaw: Math.PI / 2 });
    open.run(200);
    expect(open.camera.fov).toBeCloseTo(C.fovBaseDeg, 1);
    expect(open.rig.diagnostics().armCollapseRatio).toBe(0);

    const tight = setup({ probe: wallProbe(1.6), yaw: Math.PI / 2 });
    tight.run(200);
    expect(tight.rig.diagnostics().armCollapseRatio).toBeGreaterThan(0.5);
    expect(tight.camera.fov).toBeGreaterThan(C.fovBaseDeg + 4);
    expect(tight.camera.fov).toBeLessThanOrEqual(C.fovBaseDeg + C.armCollapseFovBoostDeg + 1e-6);
  });

  it('leaves FOV entirely alone when asked to', () => {
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 1000);
    const target = new MutableTarget();
    const rig = new ThirdPersonCameraRig({ camera, target, driveFov: false });
    const input = new InputScript();
    target.velocity.set(0, 0, -22);
    for (let i = 0; i < 120; i++) rig.update(input.poll(DT), DT);
    expect(camera.fov).toBe(42);
  });
});

/* -------------------------------------------------------------------------- */
/* Impact lag                                                                 */
/* -------------------------------------------------------------------------- */

describe('impact lag', () => {
  it('falls behind on a serious shockwave and catches back up', () => {
    const bus = new EventBus();
    const r = setup({ bus });
    r.target.velocity.set(0, 0, -20);
    r.run(60);

    const beforeLag = r.camera.position.clone();
    bus.emit('ShockwaveFired', {
      origin: { x: 0, y: 1, z: 0 },
      direction: { x: 0, y: 0, z: -1 },
      power: 5e5,
      range: 40,
      angle: 0.6,
      intent: 'serious',
      punchKind: 'serious',
    });
    r.run(1);
    const lagged = r.camera.position.clone();
    // The character is moving at 20 m/s, so three frames is a metre of lag.
    expect(r.rig.diagnostics().impactLag).toBeGreaterThan(0.5);
    expect(lagged.distanceTo(beforeLag)).toBeLessThan(0.34 * 3);

    r.run(60);
    expect(r.rig.diagnostics().impactLag).toBe(0);
  });

  it('ignores a restrained shockwave', () => {
    const bus = new EventBus();
    const r = setup({ bus });
    r.run(30);
    bus.emit('ShockwaveFired', {
      origin: { x: 0, y: 1, z: 0 },
      direction: { x: 0, y: 0, z: -1 },
      power: 10,
      range: 4,
      angle: 0.6,
      intent: 'restrained',
      punchKind: 'normal',
    });
    r.run(1);
    expect(r.rig.diagnostics().impactLag).toBe(0);
  });

  it('fires on a released charged punch straight from input', () => {
    const r = setup();
    r.run(30);
    r.input.press('heavyPunch', 0.9);
    r.run(1);
    expect(r.rig.diagnostics().impactLag).toBeGreaterThan(0.9);
    r.input.release('heavyPunch');
  });

  it('keeps the lagged camera out of geometry, not just the desired one', () => {
    // Both ends of the blend were collision-valid when they were computed; the
    // straight line between them never was. Here the wall arrives (destruction
    // rebuilds a chunk) between the stale frame and the current one, so the
    // three-frame-old position the lag blends toward is now inside it.
    const bus = new EventBus();
    let planeX = 100;
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    const target = new MutableTarget();
    const input = new InputScript();
    const rig = new ThirdPersonCameraRig({
      camera,
      target,
      bus,
      yaw: Math.PI / 2,
      probe: {
        probe(origin, direction, maxDistance): number {
          if (direction.x <= 1e-6) return Number.POSITIVE_INFINITY;
          const d = (planeX - origin.x) / direction.x;
          return d < 0 || d > maxDistance ? Number.POSITIVE_INFINITY : d;
        },
      },
    });
    for (let i = 0; i < 60; i++) rig.update(input.poll(DT), DT);
    expect(camera.position.x).toBeGreaterThan(4);

    bus.emit('ShockwaveFired', {
      origin: { x: 0, y: 1, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      power: 5e5,
      range: 40,
      angle: 0.6,
      intent: 'serious',
      punchKind: 'serious',
    });
    planeX = 1.5;
    rig.update(input.poll(DT), DT);

    expect(rig.diagnostics().impactLag).toBeGreaterThan(0.5);
    expect(camera.position.x).toBeLessThan(1.5);
  });

  it('ignores a barely-charged punch', () => {
    const r = setup();
    r.run(30);
    r.input.press('heavyPunch', 0.1);
    r.run(1);
    expect(r.rig.diagnostics().impactLag).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

describe('physics probe', () => {
  it('allocates nothing per probe, as `ICameraProbe.probe` promises', () => {
    // Six probes a frame, 360 a second, is a steady contribution to exactly the
    // young-generation churn whose GC hitches truncate a held jump elsewhere.
    const seen = new Set<object>();
    const world = {
      raycast(options: object): undefined {
        seen.add(options);
        return undefined;
      },
    } as unknown as IPhysicsWorld;

    const probe = createPhysicsCameraProbe(world, { layers: ['world'] });
    const origin = new THREE.Vector3();
    const direction = new THREE.Vector3(1, 0, 0);
    for (let i = 0; i < 6; i++) {
      expect(probe.probe(origin, direction, 4 + i)).toBe(Number.POSITIVE_INFINITY);
    }
    expect(seen.size).toBe(1);
  });
});

describe('lifecycle', () => {
  it('unsubscribes from the bus on dispose', () => {
    const bus = new EventBus();
    const r = setup({ bus });
    expect(bus.listenerCount('ShockwaveFired')).toBe(1);
    r.rig.dispose();
    expect(bus.listenerCount('ShockwaveFired')).toBe(0);
    expect(() => r.run(5)).not.toThrow();
  });
});
