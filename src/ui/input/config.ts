/**
 * INPUT TUNING
 *
 * Every magic number the input layer uses lives here, with the reasoning
 * attached. Nothing else in `src/ui/input/` is allowed to hard-code a
 * threshold — if you need a new one, add it to `IInputTuning` so it is
 * overridable per-device and visible to the harness.
 *
 * Units are explicit in every field name: `Px`, `Sec`, `Deg`, `Ratio`.
 * "CSS pixels" everywhere, never device pixels — the whole point of a
 * thumb-sized control is that it stays thumb-sized on a 3x display.
 */

import type { IInputConfig } from '@/types';

/* -------------------------------------------------------------------------- */
/* Tuning                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `IInputConfig` plus the concrete pixel/second thresholds the touch backend
 * needs. `IInputConfig` deliberately speaks in normalised units (it has to
 * serve gamepads too); the touch layer needs real screen distances.
 */
export interface IInputTuning extends IInputConfig {
  /* ---- virtual stick ---- */
  /**
   * Radius (from the floating origin) inside which the stick reads as centred.
   * 56px ~= a resting thumb's involuntary wobble on a 5-6" phone. Smaller and
   * the character drifts while you hold still; larger and the stick feels dead.
   */
  readonly stickDeadZonePx: number;
  /**
   * Radius at which the stick reads magnitude 1.0. Mirrors `stickRadius`.
   * Deflection is measured RADIALLY, so a diagonal drag of this distance is
   * full-magnitude — diagonals are never clamped short (see `axis.ts`).
   */
  readonly stickFullDeflectionPx: number;
  /**
   * When true the floating origin is dragged along behind the thumb once the
   * thumb passes full deflection, so pulling back immediately eases off
   * instead of having to retrace the whole overshoot. Costs nothing, and is
   * the difference between a stick that feels attached to your thumb and one
   * that feels attached to the glass.
   */
  readonly stickOriginFollows: boolean;
  /** Fraction of viewport width belonging to the stick. Left of it = stick. */
  readonly stickZoneFraction: number;

  /* ---- camera ---- */
  /**
   * Degrees of camera rotation per CSS pixel of drag. 0.18 is the value that
   * makes a 200px thumb sweep turn ~36 degrees, i.e. a comfortable quarter
   * turn per swipe without the horizon whipping.
   */
  readonly cameraDegPerPx: number;
  /**
   * Look rate (deg/sec) that corresponds to `look.x === 1`. Consumers recover
   * real degrees with `deg = look.x * lookFullRateDegPerSec * dt`.
   */
  readonly lookFullRateDegPerSec: number;
  /**
   * Exponential smoothing for the look rate: the FRACTION OF ERROR REMAINING
   * after one second (see `damp()` in `@/util`). 1e-7 ~= a 62 ms time
   * constant: enough to sand off touch-digitiser stair-stepping, short enough
   * that the camera still feels bolted to the thumb.
   */
  readonly lookSmoothing: number;
  /** Below this rate (deg/sec) the smoothed look snaps to zero. */
  readonly lookRestDegPerSec: number;

  /* ---- pinch ---- */
  /** Ignore pinch distance changes below this many pixels per frame (jitter). */
  readonly pinchMinDeltaPx: number;
  /** Clamp per-frame pinch ratio into [1/max, max] so a glitch can't teleport the camera. */
  readonly pinchMaxRatioPerFrame: number;

  /* ---- punch charge ---- */
  /** Hold longer than this and the punch starts charging (ring appears). */
  readonly chargeStartSec: number;
  /** Hold time at which the charge is full (ring closed, haptic fires). */
  readonly chargeFullSec: number;

  /* ---- gestures ---- */
  /** A press shorter than this, that moved less than `tapMaxMovePx`, is a tap. */
  readonly tapMaxDurationSec: number;
  /** Maximum travel for a press to still count as a tap. */
  readonly tapMaxMovePx: number;
  /** Two taps within `doubleTapWindow` and this distance = double tap. */
  readonly doubleTapMaxDistPx: number;
  /** Both fingers must land within this window to count as a two-finger tap. */
  readonly twoFingerTapWindowSec: number;
  /** Upward travel on the punch button that fires the uppercut. */
  readonly swipeUpMinPx: number;
  /** The uppercut swipe must complete within this long. */
  readonly swipeUpMaxSec: number;
  /** Horizontal travel above this fraction of the vertical travel is not a swipe-up. */
  readonly swipeUpMaxSkewRatio: number;

  /* ---- gamepad ---- */
  /** Analogue trigger value above which a trigger counts as pressed. */
  readonly triggerThreshold: number;
  /** Radial dead zone for gamepad sticks (normalised, not pixels). */
  readonly gamepadDeadZone: number;
}

/* -------------------------------------------------------------------------- */
/* Defaults                                                                   */
/* -------------------------------------------------------------------------- */

/** Shipping defaults. Frozen: nobody mutates the shared config in place. */
export const DEFAULT_INPUT_TUNING: IInputTuning = Object.freeze({
  /* IInputConfig */
  deadZone: 0.15,
  lookSensitivity: 1,
  invertLookY: false,
  holdThreshold: 0.18,
  doubleTapWindow: 0.28,
  stickRadius: 120,
  floatingStick: true,
  hapticsEnabled: true,

  /* stick */
  stickDeadZonePx: 56,
  stickFullDeflectionPx: 120,
  stickOriginFollows: true,
  stickZoneFraction: 0.5,

  /* camera */
  cameraDegPerPx: 0.18,
  lookFullRateDegPerSec: 220,
  lookSmoothing: 1e-7,
  lookRestDegPerSec: 0.5,

  /* pinch */
  pinchMinDeltaPx: 1.5,
  pinchMaxRatioPerFrame: 1.5,

  /* charge */
  chargeStartSec: 0.22,
  chargeFullSec: 1.0,

  /* gestures */
  tapMaxDurationSec: 0.25,
  tapMaxMovePx: 18,
  doubleTapMaxDistPx: 90,
  twoFingerTapWindowSec: 0.2,
  swipeUpMinPx: 46,
  swipeUpMaxSec: 0.4,
  swipeUpMaxSkewRatio: 0.8,

  /* gamepad */
  triggerThreshold: 0.35,
  gamepadDeadZone: 0.15,
} satisfies IInputTuning);

/**
 * Merge a partial override over the defaults, keeping `stickRadius` and
 * `stickFullDeflectionPx` in sync (they are the same distance expressed for
 * two different audiences, and drifting them apart is a classic bug).
 */
export function resolveTuning(patch?: Partial<IInputTuning>): IInputTuning {
  if (!patch) return DEFAULT_INPUT_TUNING;
  const merged = { ...DEFAULT_INPUT_TUNING, ...patch };
  if (patch.stickFullDeflectionPx !== undefined && patch.stickRadius === undefined) {
    merged.stickRadius = patch.stickFullDeflectionPx;
  } else if (patch.stickRadius !== undefined && patch.stickFullDeflectionPx === undefined) {
    merged.stickFullDeflectionPx = patch.stickRadius;
  }
  return Object.freeze(merged);
}
