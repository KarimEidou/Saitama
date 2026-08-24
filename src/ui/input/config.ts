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
   * FLOATING ONLY. When true the floating origin is dragged along behind the
   * thumb once the thumb passes full deflection, so pulling back immediately
   * eases off instead of having to retrace the whole overshoot. Costs nothing,
   * and is the difference between a stick that feels attached to your thumb
   * and one that feels attached to the glass.
   *
   * "Floating only" is load-bearing, not decorative. What makes the walk safe
   * is that `sync()` paints the floating ring FROM the origin, so the artwork
   * walks with it and the ring's centre is still the truth. The anchored ring
   * is placed by CSS and the per-frame path deliberately never writes to it —
   * so an origin that walked while anchored left the ring behind, permanently,
   * for the rest of that touch: after a 200px drag and a return to the painted
   * centre the origin sat a full 92px away from it, and the stick read
   * magnitude 1.000 in the OPPOSITE direction with the knob jammed against the
   * ring's far edge. `TouchCore.updateStickOrigin` is where the layout gate
   * lives; this note is here because the field is reachable from
   * `window.__INPUT__.setConfig` and reads like a free improvement.
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
   * Anchored layout only: the AIM TOLERANCE for a touch meant for the painted
   * centre. Land within it and the origin snaps onto the anchor, so the ring's
   * centre is neutral to the pixel; land outside it and the origin is the
   * touch point. See `stickOriginFor`.
   *
   * Must not exceed `stickDeadZonePx`, and `resolveTuning` holds it there.
   * That bound is what makes a stationary touch read zero NO MATTER WHERE IT
   * LANDS: snapping the origin turns the landing offset into deflection, and
   * an offset the dead zone already forgives cannot become movement. 122px is
   * what shipped — a third larger than full deflection — and it meant a finger
   * that never moved commanded 0.800 on the ring's edge and a full sprint
   * anywhere in the 30px annulus beyond the artwork, in whatever direction the
   * player happened to tap.
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
  // The aim tolerance, and no larger than the wobble the dead zone already
  // forgives — the two are the same 12px for the same reason. It was 122,
  // which snapped the origin onto the anchor for touches up to 46px OUTSIDE
  // the painted ring and turned every one of them into deflection the player
  // never dragged for. See the field's doc.
  stickCaptureRadiusPx: 12,

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
  // (`!(a < b)` also rejects NaN.) Runs after the stickRadius mirror above, so
  // it repairs whatever the mirror produced rather than what the patch said.
  //
  // `stickFullDeflectionPx` goes FIRST, and it is the one this block used to
  // skip: it is the numerator's scale and half the denominator, so a bad value
  // here is not a control that feels wrong, it is a control that does not
  // exist. `NaN` gave a stick permanently dead in every direction; `0` and any
  // negative gave magnitude 1.000 from the first pixel of travel — a character
  // that only ever sprints. Worse, the dead-zone repair below then FIRED on
  // the bad number and wrote `NaN * DEAD_ZONE_RATIO` into a second field,
  // laundering one poisoned knob into two. Repairing the deflection first is
  // what stops that, so the order of these two blocks is load-bearing.
  const repairedFull = positive(
    merged.stickFullDeflectionPx,
    DEFAULT_INPUT_TUNING.stickFullDeflectionPx,
    'stickFullDeflectionPx'
  );
  if (repairedFull !== merged.stickFullDeflectionPx) {
    merged.stickFullDeflectionPx = repairedFull;
    // The mirror above may have copied the bad value across under its other
    // name; they are one distance and must not survive as two.
    merged.stickRadius = repairedFull;
  }
  merged.stickRadius = positive(merged.stickRadius, merged.stickFullDeflectionPx, 'stickRadius');
  // A dead zone must be a real, non-negative distance BELOW full deflection.
  // Negative is not a setting anyone means — it is an anti-dead-zone, and it
  // makes a resting thumb drift the character — and `>= 0` also rejects NaN,
  // so the repair below can no longer be reached by a value that would make
  // its own output non-finite. `stickFullDeflectionPx` is now known good, so
  // the product is too.
  if (!(merged.stickDeadZonePx >= 0 && merged.stickDeadZonePx < merged.stickFullDeflectionPx)) {
    log.warn(
      `stickDeadZonePx (${merged.stickDeadZonePx}) must be at least 0 and below ` +
        `stickFullDeflectionPx (${merged.stickFullDeflectionPx}); repairing to the default ratio`
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
  // The one geometric invariant that IS a gameplay invariant, and the reason
  // it is checked here rather than left to taste: capture snaps the origin
  // onto the anchor, so the distance the thumb landed from the anchor becomes
  // deflection with no drag at all. Bounded by the dead zone, that deflection
  // is always zero and a stationary touch is always still. Unbounded, it was
  // 122px against a 92px full deflection, and a tap anywhere on the joystick —
  // the tap that a first-time player makes, and the tap that the double-tap
  // jump gesture is built out of — ran the character off in whatever direction
  // the thumb happened to be from centre. Runs after both radii are repaired
  // so it clamps against a dead zone that is itself known good.
  if (merged.stickCaptureRadiusPx > merged.stickDeadZonePx) {
    log.warn(
      `stickCaptureRadiusPx (${merged.stickCaptureRadiusPx}) must not exceed stickDeadZonePx ` +
        `(${merged.stickDeadZonePx}), or a touch that never moves commands movement; clamping`
    );
    merged.stickCaptureRadiusPx = merged.stickDeadZonePx;
  }
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
