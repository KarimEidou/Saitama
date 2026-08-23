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
import { clamp, createLogger } from '@/util';

const log = createLogger('input.config');

/* -------------------------------------------------------------------------- */
/* Tuning                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Which hand holds the movement stick. Mirrors `IHudSettings.stickHand`, which
 * cannot be imported here: the HUD is forbidden from importing `@/ui/input` and
 * the dependency does not run the other way either.
 */
export type StickHand = 'left' | 'right';

/**
 * `IInputConfig` plus the concrete pixel/second thresholds the touch backend
 * needs. `IInputConfig` deliberately speaks in normalised units (it has to
 * serve gamepads too); the touch layer needs real screen distances.
 */
export interface IInputTuning extends IInputConfig {
  /* ---- virtual stick ---- */
  /**
   * Radius (from the origin) inside which the stick reads as centred.
   *
   * 12px is a thumb's involuntary wobble while holding still, and nothing more.
   * It used to be 56 against a 120px full deflection — 47% of the whole travel
   * — on the theory that a resting thumb needs that much slack. What it
   * actually bought was the single worst bug this control has had: a short,
   * natural thumb drag deflected the knob visibly, reported `active: true`, and
   * still handed gameplay `magnitude: 0`. Players reported it as "the character
   * cannot be moved", which is exactly what it was. A dead zone is insurance
   * against drift, and the premium is the first few pixels of every input the
   * player makes; 13% of the travel is as much as that is worth.
   */
  readonly stickDeadZonePx: number;
  /**
   * Radius at which the stick reads magnitude 1.0. Mirrors `stickRadius`.
   * Deflection is measured RADIALLY, so a diagonal drag of this distance is
   * full-magnitude — diagonals are never clamped short (see `axis.ts`).
   *
   * This is an INPUT distance, not a drawn one: see `stickBaseRadiusPx`.
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
  /**
   * Fraction of viewport width belonging to the stick, measured from the
   * stick hand's edge. The rest of the width is camera.
   */
  readonly stickZoneFraction: number;
  /**
   * Fraction of viewport HEIGHT, measured from the top, that is camera on both
   * sides regardless of `stickZoneFraction`.
   *
   * Nobody reaches for the top corner of a phone to walk. A swipe up there is
   * someone looking around, and claiming it for the stick both walked the
   * character when the player wanted the camera and squeezed the camera into
   * the right half — most of which is already the button arc.
   */
  readonly stickZoneTopFraction: number;
  /** Which side of the screen the stick lives on; also mirrors the button arc. */
  readonly stickHand: StickHand;
  /**
   * Radius of the RING that gets painted, CSS px — deliberately not
   * `stickFullDeflectionPx`.
   *
   * The two used to be the same number, which meant the ring was drawn at
   * `120 * 2 = 240px` across: an enormous dinner plate sitting under the
   * player's thumb, and the reason the stick looked wrong even in the frames
   * where it did render. They are different measurements of different things —
   * the artwork is sized for the EYE and the input for the THUMB — so they get
   * different fields. The knob's travel is rescaled from input space into ring
   * space (`stickKnobTravelPx`), which is what keeps the knob inside its own
   * base once the two diverge.
   */
  readonly stickBaseRadiusPx: number;
  /**
   * Anchored layout only: the stick centre's inset from the SAFE-AREA corner,
   * on both axes. `src/ui/hud/tokens.ts` mirrors this by hand in
   * `STICK_RESERVE_PX`; retuning it without retuning that puts the HUD's
   * bottom-corner panel underneath the ring.
   */
  readonly stickFixedInsetPx: number;
  /**
   * Opacity the stick is painted at with no finger down. 0..1.
   *
   * `0` is what shipped, and `0` is why the bug report said "the joystick is
   * not even rendering" — because it was not. A control the player has to
   * already know about before it will appear is not discoverable; it is a
   * secret. Half-lit is enough to read as an affordance and quiet enough not to
   * compete with the game.
   */
  readonly stickIdleOpacity: number;
  /**
   * Anchored layout only: how close to the anchor a touch must land to count as
   * grabbing the stick rather than as a touch somewhere else in the stick zone.
   * Beyond it the origin falls back to the touch point. See `stickOriginFor`.
   */
  readonly stickCaptureRadiusPx: number;

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
  stickRadius: 92,
  // ANCHORED by default, and floating is the setting rather than the law.
  // A floating stick that is invisible until you already know to drag is a
  // control only the people who wrote it can find; see `stickIdleOpacity`.
  floatingStick: false,
  hapticsEnabled: true,

  /* stick */
  stickDeadZonePx: 12,
  stickFullDeflectionPx: 92,
  stickOriginFollows: true,
  stickZoneFraction: 0.45,
  stickZoneTopFraction: 0.28,
  stickHand: 'left',
  stickBaseRadiusPx: 76,
  stickFixedInsetPx: 96,
  stickIdleOpacity: 0.5,
  stickCaptureRadiusPx: 122,

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

/** Default dead-zone fraction, reused when an override inverts the two radii. */
const DEAD_ZONE_RATIO =
  DEFAULT_INPUT_TUNING.stickDeadZonePx / DEFAULT_INPUT_TUNING.stickFullDeflectionPx;

/**
 * Merge a partial override over `base` (the shipping defaults unless told
 * otherwise), keeping `stickRadius` and `stickFullDeflectionPx` in sync (they
 * are the same distance expressed for two different audiences, and drifting
 * them apart is a classic bug).
 *
 * `base` exists so a LIVE re-tune goes through the same mirroring: the sync
 * below can only fire on fields absent from `patch`, so a caller that spreads
 * the current tuning into the patch itself — every field then defined — would
 * silently skip it and drift the two apart. Pass the current tuning as `base`
 * and the incoming patch as `patch` instead.
 */
export function resolveTuning(
  patch?: Partial<IInputTuning>,
  base: IInputTuning = DEFAULT_INPUT_TUNING
): IInputTuning {
  if (!patch) return base;
  const merged = { ...base, ...patch };
  if (patch.stickFullDeflectionPx !== undefined && patch.stickRadius === undefined) {
    merged.stickRadius = patch.stickFullDeflectionPx;
  } else if (patch.stickRadius !== undefined && patch.stickFullDeflectionPx === undefined) {
    merged.stickFullDeflectionPx = patch.stickRadius;
  }

  // Invariants the maths silently depends on. `radialDeflection` divides by
  // (full - dead) and `LookSmoother` divides by `lookFullRateDegPerSec`; both
  // clamp the denominator with an epsilon, which turns an inverted or zeroed
  // knob into a stick with no analogue band and a camera pinned at full rate.
  // Repair loudly rather than shipping a control that looks right and is not.
  // (`!(a < b)` also rejects NaN.) Stays LAST so it repairs whatever the
  // stickRadius mirror above produced.
  if (!(merged.stickDeadZonePx < merged.stickFullDeflectionPx)) {
    log.warn(
      `stickDeadZonePx (${merged.stickDeadZonePx}) must be below stickFullDeflectionPx ` +
        `(${merged.stickFullDeflectionPx}); repairing to the default ratio`
    );
    merged.stickDeadZonePx = merged.stickFullDeflectionPx * DEAD_ZONE_RATIO;
  }
  if (!(merged.lookFullRateDegPerSec > 0)) {
    log.warn(
      `lookFullRateDegPerSec (${merged.lookFullRateDegPerSec}) must be positive; ` +
        `falling back to the default`
    );
    merged.lookFullRateDegPerSec = DEFAULT_INPUT_TUNING.lookFullRateDegPerSec;
  }

  // The stick's GEOMETRY, repaired on the same principle. None of these divide
  // by anything, so a bad value does not produce a NaN — it produces a control
  // painted off-screen, or one whose ring is somewhere its origin is not, which
  // is harder to notice and worse to play. `window.__INPUT__.setConfig` reaches
  // every one of them from the console.
  merged.stickHand = merged.stickHand === 'right' ? 'right' : 'left';
  merged.stickBaseRadiusPx = positive(
    merged.stickBaseRadiusPx,
    DEFAULT_INPUT_TUNING.stickBaseRadiusPx,
    'stickBaseRadiusPx'
  );
  merged.stickFixedInsetPx = positive(
    merged.stickFixedInsetPx,
    DEFAULT_INPUT_TUNING.stickFixedInsetPx,
    'stickFixedInsetPx'
  );
  merged.stickCaptureRadiusPx = positive(
    merged.stickCaptureRadiusPx,
    DEFAULT_INPUT_TUNING.stickCaptureRadiusPx,
    'stickCaptureRadiusPx'
  );
  // Silent, all three: a value outside its range is a clamp, not a mistake
  // worth a console line, and `0` is a legitimate setting for each of them.
  // (`stickIdleOpacity: 0` restores the invisible-at-rest stick on purpose.)
  merged.stickIdleOpacity = Number.isFinite(merged.stickIdleOpacity)
    ? clamp(merged.stickIdleOpacity, 0, 1)
    : DEFAULT_INPUT_TUNING.stickIdleOpacity;
  merged.stickZoneFraction = Number.isFinite(merged.stickZoneFraction)
    ? clamp(merged.stickZoneFraction, 0, 1)
    : DEFAULT_INPUT_TUNING.stickZoneFraction;
  merged.stickZoneTopFraction = Number.isFinite(merged.stickZoneTopFraction)
    ? clamp(merged.stickZoneTopFraction, 0, 1)
    : DEFAULT_INPUT_TUNING.stickZoneTopFraction;

  return Object.freeze(merged);
}

/** Repair a distance that has to be a positive, finite number of pixels. */
function positive(value: number, fallback: number, field: string): number {
  if (Number.isFinite(value) && value > 0) return value;
  log.warn(`${field} (${value}) must be a positive length; falling back to ${fallback}`);
  return fallback;
}
