/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  PLAYER FEEL — EVERY TUNABLE NUMBER, IN ONE FILE                         ║
 * ║                                                                          ║
 * ║  Nothing else under `src/entities/player/` is allowed to hard-code a     ║
 * ║  threshold, a rate or a curve. If you need one, add it here so a         ║
 * ║  designer can find it, the harness can print it, and a device profile    ║
 * ║  can override it.                                                        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Units are explicit in every field name: `Speed` is m/s, `Accel` is m/s²,
 * `Seconds`, `Metres`, `Deg`, `DegPerSec`, `Ratio`, `Smoothing`.
 *
 * `Smoothing` fields are the FRACTION OF ERROR REMAINING AFTER ONE SECOND,
 * fed to `damp()` / `dampAngle()` in `@/util`. Smaller = snappier. They are
 * frame-rate independent, which is why no raw lerp factor appears anywhere in
 * this workstream.
 *
 * ── THE DESIGN BRIEF THESE NUMBERS SERVE ───────────────────────────────────
 * Saitama's traversal signature is JUMPING, not running. Running is how you
 * cross a street; leaping is how you cross a district. So the ground curve is
 * tuned for *crispness* (reach top speed in a fifth of a second, stop almost
 * as fast) while the air curve is tuned for *commitment* (you steer a leap,
 * you do not fly it) and the jump itself is enormous — a full-hold leap clears
 * a twenty-storey building and craters the pavement on the way down.
 *
 * ── VALUES THAT MUST MATCH ANOTHER SYSTEM ──────────────────────────────────
 * Three numbers here are duplicated from `src/physics/constants.ts` ON PURPOSE:
 * this workstream may not import another system's implementation, so it cannot
 * read them directly. They are marked `MIRRORS PHYSICS` below, and
 * `harness/player.ts` asserts each one against the physics module at runtime —
 * so a drift is a failed harness run, not a silent feel regression.
 */

import { clamp01, DEG2RAD } from '@/util';

/* -------------------------------------------------------------------------- */
/* Locomotion                                                                 */
/* -------------------------------------------------------------------------- */

/** Everything the ground/air movement model reads. */
export interface IPlayerLocomotionTuning {
  /* ---- speeds ---- */
  /**
   * Top ground speed at full stick.
   * MIRRORS PHYSICS `RUN_SPEED` (9 m/s).
   */
  readonly runSpeed: number;
  /**
   * Top ground speed while the dash action is held.
   * MIRRORS PHYSICS `DASH_SPEED` (22 m/s).
   */
  readonly dashSpeed: number;
  /**
   * Stick magnitude at which the run speed is already reached. Deflection past
   * this is wasted travel; 0.9 means the outer 10% of the stick is a comfort
   * margin, which is what stops a thumb at the rim of the pad from feeling
   * like it is fighting for the last half a metre per second.
   */
  readonly stickFullSpeedAt: number;

  /* ---- ground acceleration ---- */
  /**
   * Ground acceleration toward the target velocity. 46 m/s² reaches 9 m/s in
   * ~0.20 s, which is the window where a control still reads as "instant" but
   * a heavy character still reads as having mass. Below ~30 the character
   * feels like it is on ice; above ~70 the run has no launch at all.
   */
  readonly groundAccelMps2: number;
  /** Ground deceleration when the target is slower than the current speed. */
  readonly groundDecelMps2: number;
  /** Acceleration used while dashing. Higher: the dash is a burst, not a ramp. */
  readonly dashAccelMps2: number;
  /**
   * EXTRA deceleration applied in proportion to how far the wanted direction
   * is from the current one (0 when aligned, this value when fully reversed).
   *
   * This is the single most important number for how a third-person character
   * reads on a thumbstick. Without it, reversing describes a wide arc because
   * the same acceleration has to cancel the old velocity and build the new
   * one. With it, a 180° flick pivots on the spot.
   */
  readonly turnBrakeMps2: number;

  /* ---- air ---- */
  /**
   * Air acceleration. Roughly a third of the ground value: enough to adjust a
   * landing spot, nowhere near enough to fly. This IS the "reduced authority"
   * requirement — a leap is a commitment.
   */
  readonly airAccelMps2: number;
  /**
   * Air deceleration. Deliberately tiny so a dash-jump keeps its momentum for
   * the whole arc; killing horizontal speed mid-flight is what makes a big
   * jump read as floaty-and-useless instead of floaty-and-enormous.
   */
  readonly airDecelMps2: number;
  /** Fraction of `turnBrakeMps2` that applies while airborne. */
  readonly airTurnBrakeRatio: number;

  /* ---- facing ---- */
  /** Yaw slew rate toward the movement direction at a standstill. */
  readonly turnRateDegPerSec: number;
  /** Fraction of the turn rate still available at `dashSpeed`. */
  readonly turnRateAtTopSpeedRatio: number;
  /** Yaw slew rate while airborne. Committing to a leap includes its heading. */
  readonly airTurnRateDegPerSec: number;

  /* ---- jump ---- */
  /**
   * Take-off speed of a FULLY HELD jump.
   * MIRRORS PHYSICS `JUMP_SPEED` = sqrt(2 * 22 * 28) ≈ 35.1 m/s → ~28 m apex.
   */
  readonly jumpSpeed: number;
  /**
   * Take-off speed of a TAPPED jump. 22.9 m/s puts the apex at ~11.9 m, which
   * is deliberately BELOW `hardLandFallHeight`: a hop is traversal, a held
   * leap is a weapon. That one threshold is the whole reason variable jump
   * height exists in this game.
   */
  readonly hopSpeed: number;
  /**
   * How long the ceiling takes to ramp from `hopSpeed` to `jumpSpeed`. THIS is
   * the modulation window: release inside it and the apex scales smoothly
   * between a ~12 m hop and a ~27 m leap. 0.12 s is a little over seven
   * frames, which is the same order as a Mario variable jump and about as
   * short as a thumb can reliably aim.
   *
   * Every millisecond spent below full speed costs apex height, so a longer
   * ramp is a lower ceiling: 0.12 s lands the full-hold apex at ~27.3 m
   * against the 28 m a single-shot launch would reach.
   */
  readonly jumpRampSeconds: number;
  /**
   * How long the boost may keep being re-issued. Anything past
   * `jumpRampSeconds` is a no-op (the ceiling has converged onto the
   * free-flight curve by then), so this is purely slack against frame jitter.
   *
   * Implemented by re-issuing `ICharacterController.jump()` with a rising
   * ceiling — the contract's `jump()` only ever RAISES vertical speed, so this
   * is the only way to get a variable jump without reaching into the physics
   * implementation. See `player-controller.ts`.
   */
  readonly jumpHoldSeconds: number;
  /**
   * Grace period after walking off a ledge during which jump still works.
   * MIRRORS PHYSICS `COYOTE_TIME` (0.12 s). Without it, every ledge exit reads
   * as the controls dropping an input.
   */
  readonly coyoteSeconds: number;
  /**
   * How early a jump press is remembered so it can fire on touchdown. 0.15 s
   * is a little over nine frames — long enough to cover a mistimed thumb,
   * short enough that a stale press never fires a jump you did not want.
   */
  readonly jumpBufferSeconds: number;

  /* ---- landings ---- */
  /**
   * Fall height above which a landing craters and the ground-slam path fires.
   * MIRRORS PHYSICS `GROUND_SLAM_FALL_HEIGHT` (15 m).
   */
  readonly hardLandFallHeightM: number;
  /** Recovery beat after an ordinary landing. Short: it is punctuation. */
  readonly landRecoverySeconds: number;
  /** Recovery after a cratering landing, before the per-metre term. */
  readonly hardLandRecoveryBaseSeconds: number;
  /** Extra recovery per metre fallen beyond `hardLandFallHeightM`. */
  readonly hardLandRecoveryPerMetre: number;
  /** Ceiling on hard-landing recovery, however far the fall. */
  readonly hardLandRecoveryMaxSeconds: number;
  /** Fraction of horizontal speed kept through an ordinary landing. */
  readonly landSpeedRetention: number;
  /** Fraction kept through a cratering landing. He plants his feet. */
  readonly hardLandSpeedRetention: number;
  /** Movement authority at the START of an ordinary landing recovery. */
  readonly landControlFloor: number;
  /** Movement authority at the START of a hard-landing recovery. */
  readonly hardLandControlFloor: number;

  /* ---- state thresholds ---- */
  /** Planar speed below which the character reads as idle. */
  readonly idleSpeedThreshold: number;
  /** Planar speed above which `walk` becomes `run`. */
  readonly runSpeedThreshold: number;
  /** Seconds the launch pose holds before the state becomes `fall`. */
  readonly jumpLaunchSeconds: number;
  /**
   * Ground contact may flicker off for this long without the character being
   * considered to have left the ground.
   *
   * Not a nicety — a measured necessity. Rapier's sweep occasionally reports a
   * shortened or redirected movement for a single step on perfectly flat
   * ground, and at 9 m/s that is enough to drop contact for one frame. Without
   * this filter the character enters `fall`, lands again 16 ms later, plays a
   * landing, and eats a recovery window: a visible stutter caused entirely by
   * solver noise. Kept well under `coyoteSeconds` so it cannot extend the
   * jump-forgiveness window.
   */
  readonly groundGraceSeconds: number;
}

/* -------------------------------------------------------------------------- */
/* Camera                                                                     */
/* -------------------------------------------------------------------------- */

/** Everything the third-person spring arm reads. */
export interface IPlayerCameraTuning {
  /* ---- arm ---- */
  /** Resting arm length. */
  readonly armLengthM: number;
  /** Arm length while a serious punch is being charged — the wind-up reads wide. */
  readonly armLengthChargingM: number;
  /**
   * Arm length at the apex of a leap.
   *
   * 14 m is not a comfort number, it is a design statement: at the top of a
   * jump the whole district should be in frame. It is also the streaming and
   * impostor-ring stress test — if the world cannot fill a 14 m pull-back at
   * 28 m altitude, that is a world bug this camera is meant to expose.
   */
  readonly armLengthApexM: number;
  /**
   * Hard floor on the arm when geometry forces it in.
   *
   * 0.4 m is just outside the player capsule (radius 0.3 m). It is NOT a
   * comfortable distance — the character fills the frame and the near plane
   * cuts into it — but the alternative is worse: a floor generous enough to
   * look good is a floor that puts the camera inside a wall in a 2.4 m alley,
   * and one frame inside a wall is a bug report. Fading the character out at
   * short arm lengths is the fix, and belongs to whoever owns the material.
   */
  readonly armLengthMinM: number;
  /** Smoothing on arm EXTENSION (fraction remaining after one second). */
  readonly armExtendSmoothing: number;
  /** Ceiling on how fast the arm may push back out after a collision. */
  readonly armRecoverSpeedMps: number;

  /* ---- pivot ---- */
  /**
   * Height of the look pivot above the target's POSITION — which is the
   * physics capsule's CENTRE, not its soles.
   *
   * Getting this wrong is invisible in every number the harness prints and
   * obvious the moment you look at a screenshot: aim a metre too high and the
   * character sinks to the bottom of the frame with a wall of empty sky above
   * him. 0.6 m above the capsule centre is ~1.48 m above the soles, i.e. the
   * base of the neck on a 1.75 m character, which puts his chest at frame
   * centre and his head just above it.
   */
  readonly pivotHeightM: number;
  /** Over-the-shoulder lateral offset, in the camera's right direction. */
  readonly pivotSideM: number;
  /** Smoothing on the pivot chasing the character. */
  readonly pivotSmoothing: number;

  /* ---- collision ---- */
  /**
   * Radius of the virtual sphere swept along the arm. The five-ray cross is a
   * cheap stand-in for a sphere cast: the contract exposes rays, not shape
   * casts, and five rays cost ~8 µs against the BVH.
   */
  readonly probeRadiusM: number;
  /** Extra gap kept between the camera and whatever the probe hit. */
  readonly probeClearanceM: number;

  /* ---- orientation ---- */
  readonly minPitchDeg: number;
  /**
   * Steepest downward look.
   *
   * 55 degrees, not more: past about sixty the horizon leaves the frame and a
   * third-person shot turns into a top-down one, which loses every cue about
   * which way forward is. Verified by looking at the alley screenshot with it
   * set to 64.
   */
  readonly maxPitchDeg: number;
  readonly defaultPitchDeg: number;
  /** Pitch the camera eases to at the top of a leap, so you look DOWN at the city. */
  readonly apexPitchDeg: number;
  /** Smoothing on the automatic apex pitch. Player look input is never smoothed away. */
  readonly autoPitchSmoothing: number;
  /**
   * Degrees per second corresponding to `look` == 1.
   * MIRRORS INPUT `IInputTuning.lookFullRateDegPerSec` (220 °/s). `look` is a
   * RATE, never a delta — see `src/ui/input/config.ts`.
   */
  readonly lookFullRateDegPerSec: number;

  /* ---- height-driven pull-back ---- */
  /** Height above the last ground contact at which the arm starts extending. */
  readonly apexArmStartHeightM: number;
  /** Height at which the arm reaches `armLengthApexM`. */
  readonly apexArmFullHeightM: number;

  /* ---- field of view ---- */
  readonly fovBaseDeg: number;
  readonly fovMaxDeg: number;
  /** Planar speed that maps to `fovMaxDeg`. */
  readonly fovMaxAtSpeed: number;
  /**
   * Extra FOV added in proportion to how far collision has collapsed the arm.
   *
   * A partial answer to the one framing problem this rig cannot solve: in a
   * 2.4 m alley the arm is forced to ~1.5 m and the character fills the frame.
   * Widening the lens as the arm shortens buys back some of the field of view
   * the wall took away. It does not stop the character occluding the shot —
   * that needs a dither/fade on the character material, which belongs to
   * whoever owns it, and `ICameraDiagnostics.armCollapseRatio` is published
   * here so they can drive it.
   */
  readonly armCollapseFovBoostDeg: number;
  readonly fovSmoothing: number;

  /* ---- look-ahead ---- */
  /** Seconds of velocity extrapolated in front of the character. */
  readonly lookAheadSeconds: number;
  /** Ceiling on the look-ahead offset. */
  readonly lookAheadMaxM: number;
  readonly lookAheadSmoothing: number;

  /* ---- impact lag ---- */
  /** Frames the camera position lags behind on a serious punch. */
  readonly impactLagFrames: number;
  /** Seconds the full lag is held. */
  readonly impactLagHoldSeconds: number;
  /** Seconds spent easing the lag back out. */
  readonly impactLagReleaseSeconds: number;

  /* ---- charge detection ---- */
  /**
   * Punch hold time at which the wind-up counts as "charging a serious punch".
   * MIRRORS INPUT `IInputTuning.chargeStartSec` (0.22 s).
   */
  readonly chargeStartSeconds: number;
  /** Charge ratio at or above which a released punch triggers the impact lag. */
  readonly seriousChargeRatio: number;
}

/** The whole player feel surface. */
export interface IPlayerTuning {
  readonly locomotion: IPlayerLocomotionTuning;
  readonly camera: IPlayerCameraTuning;
}

/* -------------------------------------------------------------------------- */
/* Shipping defaults                                                          */
/* -------------------------------------------------------------------------- */

/** Ground/air movement defaults. Frozen — nobody mutates shared tuning. */
export const DEFAULT_LOCOMOTION_TUNING: IPlayerLocomotionTuning = Object.freeze({
  runSpeed: 9,
  dashSpeed: 22,
  stickFullSpeedAt: 0.9,

  groundAccelMps2: 46,
  groundDecelMps2: 62,
  dashAccelMps2: 78,
  turnBrakeMps2: 38,

  airAccelMps2: 15,
  airDecelMps2: 1.6,
  airTurnBrakeRatio: 0.22,

  turnRateDegPerSec: 900,
  turnRateAtTopSpeedRatio: 0.42,
  airTurnRateDegPerSec: 320,

  jumpSpeed: Math.sqrt(2 * 22 * 28),
  hopSpeed: 22.9,
  jumpRampSeconds: 0.12,
  jumpHoldSeconds: 0.26,
  coyoteSeconds: 0.12,
  jumpBufferSeconds: 0.15,

  hardLandFallHeightM: 15,
  landRecoverySeconds: 0.09,
  hardLandRecoveryBaseSeconds: 0.34,
  hardLandRecoveryPerMetre: 0.004,
  hardLandRecoveryMaxSeconds: 0.55,
  landSpeedRetention: 0.85,
  hardLandSpeedRetention: 0.25,
  landControlFloor: 0.55,
  hardLandControlFloor: 0.08,

  idleSpeedThreshold: 0.15,
  runSpeedThreshold: 4.2,
  jumpLaunchSeconds: 0.18,
  groundGraceSeconds: 0.08,
} satisfies IPlayerLocomotionTuning);

/** Third-person camera defaults. Frozen. */
export const DEFAULT_CAMERA_TUNING: IPlayerCameraTuning = Object.freeze({
  armLengthM: 4.5,
  armLengthChargingM: 9,
  armLengthApexM: 14,
  armLengthMinM: 0.4,
  // 1e-3 ≈ a 145 ms time constant: the pull-back at apex is a move you notice.
  armExtendSmoothing: 1e-3,
  armRecoverSpeedMps: 7,

  pivotHeightM: 0.6,
  pivotSideM: 0.45,
  // 1e-5 ≈ a 87 ms time constant. Fast enough that the character never drifts
  // off-centre at dash speed, slow enough to sand off the step-height pops.
  pivotSmoothing: 1e-5,

  probeRadiusM: 0.34,
  probeClearanceM: 0.22,

  minPitchDeg: -32,
  maxPitchDeg: 55,
  defaultPitchDeg: 12,
  apexPitchDeg: 34,
  autoPitchSmoothing: 5e-2,
  lookFullRateDegPerSec: 220,

  apexArmStartHeightM: 9,
  apexArmFullHeightM: 21,

  fovBaseDeg: 55,
  fovMaxDeg: 72,
  fovMaxAtSpeed: 22,
  armCollapseFovBoostDeg: 12,
  fovSmoothing: 2e-3,

  lookAheadSeconds: 0.16,
  lookAheadMaxM: 3,
  lookAheadSmoothing: 1e-3,

  impactLagFrames: 3,
  impactLagHoldSeconds: 0.18,
  impactLagReleaseSeconds: 0.22,

  chargeStartSeconds: 0.22,
  seriousChargeRatio: 0.5,
} satisfies IPlayerCameraTuning);

/** The shipping player feel profile. */
export const DEFAULT_PLAYER_TUNING: IPlayerTuning = Object.freeze({
  locomotion: DEFAULT_LOCOMOTION_TUNING,
  camera: DEFAULT_CAMERA_TUNING,
});

/** Deeply-partial override, for device profiles and harness experiments. */
export interface IPlayerTuningPatch {
  readonly locomotion?: Partial<IPlayerLocomotionTuning>;
  readonly camera?: Partial<IPlayerCameraTuning>;
}

/** Merge a patch over the defaults. Returns a frozen profile. */
export function resolvePlayerTuning(patch?: IPlayerTuningPatch): IPlayerTuning {
  if (patch === undefined) return DEFAULT_PLAYER_TUNING;
  return Object.freeze({
    locomotion: Object.freeze({ ...DEFAULT_LOCOMOTION_TUNING, ...patch.locomotion }),
    camera: Object.freeze({ ...DEFAULT_CAMERA_TUNING, ...patch.camera }),
  });
}

/* -------------------------------------------------------------------------- */
/* Derived values                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Ballistic apex above the take-off point for a given launch speed.
 *
 * Uses the RISE gravity only. The physics module applies a 1.6x multiplier on
 * the way back down, which changes airtime but not apex height.
 */
export function apexForLaunchSpeed(launchSpeed: number, riseGravity = 22): number {
  return (launchSpeed * launchSpeed) / (2 * Math.abs(riseGravity));
}

/**
 * The vertical-speed ceiling a held jump is entitled to, `t` seconds after
 * take-off.
 *
 * The ceiling interpolates from `hopSpeed` to `jumpSpeed` across
 * `jumpRampSeconds` and then decays at exactly the rise gravity, so
 * re-issuing `jump()` with this value each held frame produces a CONTINUOUS
 * trajectory: there is no step in vertical velocity at the moment the player
 * lets go, whatever moment that is, and once the ramp completes the ceiling
 * has converged onto the free-flight curve and stops doing anything at all.
 */
export function heldJumpSpeedCeiling(
  tuning: IPlayerLocomotionTuning,
  elapsed: number,
  riseGravity = 22
): number {
  const t = clamp01(elapsed / Math.max(1e-4, tuning.jumpRampSeconds));
  const ceiling = tuning.hopSpeed + (tuning.jumpSpeed - tuning.hopSpeed) * t;
  return ceiling - Math.abs(riseGravity) * elapsed;
}

/**
 * Apex a fully-held jump reaches, integrated rather than assumed.
 *
 * Closed form for the two-phase trajectory the held jump actually flies: a
 * linear velocity ramp during `jumpRampSeconds`, then ballistic. Exported so
 * tests and the harness can compare a MEASURED apex against the number the
 * tuning implies, instead of against a hand-written constant that drifts.
 */
export function heldJumpApex(tuning: IPlayerLocomotionTuning, riseGravity = 22): number {
  const g = Math.abs(riseGravity);
  const T = Math.max(1e-4, tuning.jumpRampSeconds);
  // v(t) = hop + ((jump - hop)/T - g) * t   for t in [0, T]
  const slope = (tuning.jumpSpeed - tuning.hopSpeed) / T - g;
  const vAtRampEnd = tuning.hopSpeed + slope * T;
  const heightAtRampEnd = tuning.hopSpeed * T + 0.5 * slope * T * T;
  return heightAtRampEnd + (vAtRampEnd * vAtRampEnd) / (2 * g);
}

/** Recovery duration for a landing that fell `fallHeight` metres. */
export function landingRecoverySeconds(
  tuning: IPlayerLocomotionTuning,
  fallHeight: number
): number {
  if (fallHeight < tuning.hardLandFallHeightM) return tuning.landRecoverySeconds;
  const over = fallHeight - tuning.hardLandFallHeightM;
  return Math.min(
    tuning.hardLandRecoveryMaxSeconds,
    tuning.hardLandRecoveryBaseSeconds + over * tuning.hardLandRecoveryPerMetre
  );
}

/** Radians per second the character may yaw at, given its current speed. */
export function turnRateRadPerSec(
  tuning: IPlayerLocomotionTuning,
  speed: number,
  grounded: boolean
): number {
  if (!grounded) return tuning.airTurnRateDegPerSec * DEG2RAD;
  const t = clamp01(speed / Math.max(1e-4, tuning.dashSpeed));
  const scale = 1 + (tuning.turnRateAtTopSpeedRatio - 1) * t;
  return tuning.turnRateDegPerSec * scale * DEG2RAD;
}
