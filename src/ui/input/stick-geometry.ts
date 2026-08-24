/**
 * STICK GEOMETRY — every spatial decision the virtual stick makes, as pure
 * functions with no DOM and no state.
 *
 * This module exists because the same three questions are asked from two
 * places that must never import each other:
 *
 *   • `touch-core.ts` is deliberately DOM-free (see its header) and decides
 *     WHERE THE ORIGIN IS — the number the character actually moves by.
 *   • `touch-overlay.ts` is deliberately logic-free and decides WHERE THE RING
 *     IS PAINTED — the number the player actually sees.
 *
 * If those two answers are derived separately they drift, and the failure mode
 * is the worst one this control has: a ring drawn in one place and a stick that
 * reads from another. So the arithmetic lives here, once, and both sides call
 * it. It is also the whole reason the anchored layout is testable in Node at
 * all — every case below is a function of five numbers.
 *
 * All distances are CSS pixels, all coordinates are relative to the input root
 * (which is `position:fixed;inset:0`, so they are viewport coordinates).
 */

import type { SafeAreaInsets } from '@/types';
import type { IInputTuning } from './config';

/** No insets. Shared so callers do not each allocate a zeroed literal. */
export const ZERO_SAFE_AREA: SafeAreaInsets = Object.freeze({
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
});

/**
 * Radius of the painted knob, CSS px. Mirrors the `.opm-stick-knob` rule in
 * `touch-overlay.ts` (70px across) and is exported because the knob's TRAVEL
 * depends on it: the knob has to stop where its own edge meets the ring's, not
 * where its centre does, or it climbs out of its base at full deflection.
 */
export const STICK_KNOB_RADIUS_PX = 35;

/** A point in input-root (viewport) coordinates. */
export interface IStickPoint {
  readonly x: number;
  readonly y: number;
}

/** Where the origin came from, so the overlay and the tests can tell them apart. */
export interface IStickOrigin extends IStickPoint {
  /**
   * True when the touch landed within the anchor's aim tolerance and the
   * origin was snapped ONTO the painted centre. False means the origin is the
   * touch point — which is every floating touch, and every anchored touch that
   * landed further out than `stickCaptureRadiusPx` (see `stickOriginFor`).
   */
  readonly captured: boolean;
}

/**
 * Centre of the anchored stick, in viewport coordinates.
 *
 * Measured from the SAFE-AREA corner, not the raw viewport corner. This is the
 * whole reason `TouchCore` had to learn about insets: on a notched phone in
 * landscape the left inset is 44px, and an anchor computed from the raw edge
 * sits 44px outside the ring the CSS paints — the stick would read from one
 * place and be drawn in another, on precisely the devices this game ships to.
 *
 * `stickHand` picks the corner. The stick is a thumb control and the thumb in
 * question belongs to a specific hand; left-handed players exist and currently
 * get a stick under their camera hand.
 */
export function fixedStickAnchor(
  tuning: IInputTuning,
  viewportW: number,
  viewportH: number,
  insets: SafeAreaInsets = ZERO_SAFE_AREA
): IStickPoint {
  const inset = tuning.stickFixedInsetPx;
  const x =
    tuning.stickHand === 'right'
      ? viewportW - Math.max(0, insets.right) - inset
      : Math.max(0, insets.left) + inset;
  return { x, y: viewportH - Math.max(0, insets.bottom) - inset };
}

/**
 * Distance from the safe-area corner to the furthest PAINTED pixel of the
 * anchored stick: the diagonal out to the anchor plus the ring's own radius.
 *
 * `src/ui/hud/tokens.ts` reserves a square of exactly this shape for the stick
 * hand (`STICK_RESERVE_PX`) and cannot import this module — the HUD is forbidden
 * from importing `@/ui/input` at all — so it mirrors the arithmetic by hand and
 * the harness compares the two. Retune the stick and that comparison is what
 * fails, instead of the HUD quietly ending up underneath the ring.
 */
export function stickReachPx(tuning: IInputTuning): number {
  return Math.hypot(tuning.stickFixedInsetPx, tuning.stickFixedInsetPx) + tuning.stickBaseRadiusPx;
}

/**
 * Does a touch at (x, y) belong to the stick?
 *
 * Two constraints, and the second one is newer and less obvious:
 *
 *   WIDTH  — the stick owns `stickZoneFraction` of the width on its own hand's
 *            side. The other side is camera.
 *   HEIGHT — the stick owns only the LOWER part of that band. The top
 *            `stickZoneTopFraction` of the screen is camera on both sides.
 *
 * The height constraint fixes a real complaint. A left-half swipe near the top
 * of the screen is, every time, someone trying to look around — nobody reaches
 * to the top-left corner of a phone to walk. Claiming it for the stick meant
 * the character lurched off instead of the camera turning, and it squeezed the
 * camera into the right half, most of which is already button arc. It also
 * matters for the artwork: the input overlay paints UNDER the HUD, so a
 * floating origin that lands up there is drawn beneath the rank chip and
 * clipped by it.
 *
 * ── THE ZONE MUST CONTAIN ITS OWN ARTWORK ──────────────────────────────────
 * Both constraints are widened, where they have to be, so that every painted
 * pixel of the ring is inside the zone. A bare `0.45 * viewportW` does not
 * know where the ring is: the ring's far edge is at
 * `insets.left + stickFixedInsetPx + stickBaseRadiusPx` = 172px, a CONSTANT,
 * while 45% of the width is 162px at 360 CSS px and 169 at 375. 360 is the
 * most common Android width there is (every Galaxy S, every Pixel) and 375 is
 * the iPhone SE and mini, so on the two most numerous phone widths in the
 * world a 10px crescent of the visible joystick — its INBOARD edge, the side
 * the thumb pushes into to walk across the screen — was CAMERA. The player put
 * a thumb on the control they could plainly see and the horizon swung. That is
 * the original bug report ("the character cannot be moved") arriving through a
 * different door.
 *
 * So the zone is `max(fraction, the ring's far edge)` — the fraction is the
 * COMFORT margin, generous on a wide screen, and the artwork is the FLOOR. The
 * same reasoning applies to the top band on a very short viewport, where 28%
 * of the height could in principle reach down over the ring; `min` keeps the
 * camera's band above it. Neither `max` nor `min` binds on any shipping
 * profile wider than 382px, so this costs the camera nothing where the camera
 * was already fine.
 *
 * `insets` matters for the same reason `fixedStickAnchor` takes it: on a
 * notched phone in landscape the ring is pushed 59px inboard, and a zone
 * derived from the raw edge would be 59px short of it.
 */
export function isStickZone(
  x: number,
  y: number,
  viewportW: number,
  viewportH: number,
  tuning: IInputTuning,
  insets: SafeAreaInsets = ZERO_SAFE_AREA
): boolean {
  const anchor = fixedStickAnchor(tuning, viewportW, viewportH, insets);
  const ringTop = anchor.y - tuning.stickBaseRadiusPx;
  if (y < Math.min(viewportH * tuning.stickZoneTopFraction, ringTop)) return false;
  // How far in from the stick hand's edge the zone reaches: the fraction, or
  // the ring's inboard edge, whichever is further in.
  const band = Math.max(
    viewportW * tuning.stickZoneFraction,
    tuning.stickHand === 'right'
      ? viewportW - (anchor.x - tuning.stickBaseRadiusPx)
      : anchor.x + tuning.stickBaseRadiusPx
  );
  return tuning.stickHand === 'right' ? x > viewportW - band : x < band;
}

/**
 * Where the stick's origin goes for a touch at (x, y).
 *
 * FLOATING is the simple case and the old behaviour: the origin materialises
 * exactly under the thumb.
 *
 * ANCHORED has to answer a question floating never had to. The ring is painted
 * at a fixed place, but the thumb does not always land on it — and there are
 * only two things the origin can be:
 *
 *   • THE ANCHOR — an absolute pad. The ring's painted centre is neutral, and
 *     where on the pad your thumb sits IS the reading. This is what shipped,
 *     with a 122px capture radius, and it is why a stationary tap on the
 *     joystick made the character run: a touch that never moved read 0.800 on
 *     the ring's outer edge and a flat 1.000 anywhere in the 92..122px
 *     annulus OUTSIDE the artwork, held for as long as the finger rested
 *     there. A first-time player's instinct is to tap the control they can now
 *     see, and the double-tap-to-jump gesture is *deliberately* a tap on this
 *     same surface — so the two most likely first interactions with the stick
 *     both sprinted the character sideways. That is a sprint nobody asked for,
 *     which is precisely the failure this docblock used to claim it rejected.
 *
 *   • THE TOUCH POINT — a relative pad. Wherever you put your thumb is
 *     neutral, and you drag from there. Nothing can move until the thumb does,
 *     which is the property that makes a tap a tap. It is also exactly how the
 *     floating stick has always behaved, so the anchored/floating setting now
 *     moves the ARTWORK and not the physics, and a player who switches it does
 *     not have to relearn the control.
 *
 * The relative pad wins, and the cost is honest: after landing off-centre, the
 * painted centre is no longer the neutral point for that touch. The knob still
 * shows the true deflection (`sync()` draws it from the ring's centre by the
 * vector gameplay receives), the thumb is covering the middle of the ring
 * anyway, and the player's way of stopping is to LIFT — which always
 * re-centres. Compare that with a control that walks off when you tap it.
 *
 * `stickCaptureRadiusPx` survives as the AIM TOLERANCE and nothing more: a
 * thumb that lands within it is taken to have meant the exact centre, so the
 * origin snaps to the anchor and the painted centre is then neutral to the
 * pixel. `resolveTuning` holds it at or below `stickDeadZonePx`, which is the
 * bound that makes "capture cannot manufacture movement" true by arithmetic
 * rather than by taste: a landing the dead zone already forgives reads zero
 * wherever the origin is put.
 */
export function stickOriginFor(
  x: number,
  y: number,
  viewportW: number,
  viewportH: number,
  insets: SafeAreaInsets,
  tuning: IInputTuning
): IStickOrigin {
  if (tuning.floatingStick) return { x, y, captured: false };
  const anchor = fixedStickAnchor(tuning, viewportW, viewportH, insets);
  const captured = Math.hypot(x - anchor.x, y - anchor.y) <= tuning.stickCaptureRadiusPx;
  return captured ? { x: anchor.x, y: anchor.y, captured: true } : { x, y, captured: false };
}

/**
 * How far the knob's CENTRE may travel from the ring's centre, CSS px.
 *
 * NOT `stickFullDeflectionPx`. The input radius (92px) and the visual radius
 * (76px) are deliberately different numbers — the artwork is sized for the eye
 * and the input for the thumb — so the knob's travel is a RING-space distance:
 * the ring's radius less the knob's own, which parks the knob's edge exactly on
 * the ring's edge at full deflection instead of half of it hanging outside.
 *
 * Clamped at zero for a pathological tuning where the knob is bigger than its
 * base; a negative travel would send the knob backwards.
 */
export function stickKnobTravelPx(tuning: IInputTuning): number {
  return Math.max(0, tuning.stickBaseRadiusPx - STICK_KNOB_RADIUS_PX);
}
