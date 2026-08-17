/**
 * Tuning invariants.
 *
 * The interesting assertions here are the ones about RELATIONSHIPS between
 * numbers, not the numbers themselves. A designer may move `hopSpeed`; what
 * they must not do is move it above the crater threshold, because that would
 * silently turn every casual hop into a ground slam.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CAMERA_TUNING,
  DEFAULT_LOCOMOTION_TUNING,
  DEFAULT_PLAYER_TUNING,
  apexForLaunchSpeed,
  heldJumpApex,
  heldJumpSpeedCeiling,
  landingRecoverySeconds,
  resolvePlayerTuning,
  turnRateRadPerSec,
} from '../tuning';

const L = DEFAULT_LOCOMOTION_TUNING;
const C = DEFAULT_CAMERA_TUNING;

describe('values mirrored from other systems', () => {
  it('matches the physics movement curve', () => {
    // src/physics/constants.ts — RUN_SPEED, DASH_SPEED, COYOTE_TIME,
    // GROUND_SLAM_FALL_HEIGHT, JUMP_SPEED. The harness re-checks these against
    // the live module; this catches a typo without booting a browser.
    expect(L.runSpeed).toBe(9);
    expect(L.dashSpeed).toBe(22);
    expect(L.coyoteSeconds).toBe(0.12);
    expect(L.hardLandFallHeightM).toBe(15);
    expect(L.jumpSpeed).toBeCloseTo(Math.sqrt(2 * 22 * 28), 10);
    expect(apexForLaunchSpeed(L.jumpSpeed)).toBeCloseTo(28, 6);
  });

  it('matches the input look rate and charge threshold', () => {
    // src/ui/input/config.ts — lookFullRateDegPerSec, chargeStartSec.
    expect(C.lookFullRateDegPerSec).toBe(220);
    expect(C.chargeStartSeconds).toBe(0.22);
  });
});

describe('jump shape', () => {
  it('puts a tap below the crater threshold and a hold well above it', () => {
    const hop = apexForLaunchSpeed(L.hopSpeed);
    const held = heldJumpApex(L);
    expect(hop).toBeLessThan(L.hardLandFallHeightM);
    expect(held).toBeGreaterThan(L.hardLandFallHeightM * 1.5);
    // A tap must still be a useful traversal jump, not a shuffle.
    expect(hop).toBeGreaterThan(8);
  });

  it('reaches high enough for the camera to fully extend at apex', () => {
    expect(heldJumpApex(L)).toBeGreaterThan(C.apexArmFullHeightM);
  });

  it('ramps the hold ceiling continuously from hop to full', () => {
    expect(heldJumpSpeedCeiling(L, 0)).toBeCloseTo(L.hopSpeed, 10);
    // At the end of the ramp the ceiling has converged onto the free-flight
    // curve of a full-power launch, which is what makes further re-issues a
    // no-op instead of a kick.
    const t = L.jumpRampSeconds;
    expect(heldJumpSpeedCeiling(L, t)).toBeCloseTo(L.jumpSpeed - 22 * t, 10);

    let previous = Number.POSITIVE_INFINITY;
    for (let i = 0; i <= 20; i++) {
      const v = heldJumpSpeedCeiling(L, (i / 20) * t);
      expect(Number.isFinite(v)).toBe(true);
      previous = v;
    }
    expect(previous).toBeGreaterThan(L.hopSpeed);
  });
});

describe('landing recovery', () => {
  it('is short for an ordinary landing and longer for a crater', () => {
    expect(landingRecoverySeconds(L, 2)).toBe(L.landRecoverySeconds);
    expect(landingRecoverySeconds(L, 14.99)).toBe(L.landRecoverySeconds);
    expect(landingRecoverySeconds(L, 15)).toBe(L.hardLandRecoveryBaseSeconds);
    expect(landingRecoverySeconds(L, 28)).toBeGreaterThan(L.hardLandRecoveryBaseSeconds);
  });

  it('is capped however far the fall', () => {
    expect(landingRecoverySeconds(L, 10_000)).toBe(L.hardLandRecoveryMaxSeconds);
  });
});

describe('turn rate', () => {
  it('falls off with speed on the ground and is lower in the air', () => {
    const standing = turnRateRadPerSec(L, 0, true);
    const sprinting = turnRateRadPerSec(L, L.dashSpeed, true);
    expect(sprinting).toBeLessThan(standing);
    expect(sprinting / standing).toBeCloseTo(L.turnRateAtTopSpeedRatio, 6);
    expect(turnRateRadPerSec(L, 0, false)).toBeLessThan(standing);
  });
});

describe('overrides', () => {
  it('merges a partial patch and leaves the defaults frozen', () => {
    const patched = resolvePlayerTuning({ locomotion: { runSpeed: 12 } });
    expect(patched.locomotion.runSpeed).toBe(12);
    expect(patched.locomotion.dashSpeed).toBe(L.dashSpeed);
    expect(patched.camera.armLengthM).toBe(C.armLengthM);
    expect(DEFAULT_PLAYER_TUNING.locomotion.runSpeed).toBe(9);
    expect(Object.isFrozen(DEFAULT_LOCOMOTION_TUNING)).toBe(true);
  });

  it('returns the shared default when there is nothing to patch', () => {
    expect(resolvePlayerTuning()).toBe(DEFAULT_PLAYER_TUNING);
  });
});

describe('camera arm ordering', () => {
  it('keeps the three arm lengths in the documented order', () => {
    expect(C.armLengthMinM).toBeLessThan(C.armLengthM);
    expect(C.armLengthM).toBeLessThan(C.armLengthChargingM);
    expect(C.armLengthChargingM).toBeLessThan(C.armLengthApexM);
    expect(C.fovBaseDeg).toBeLessThan(C.fovMaxDeg);
  });
});
