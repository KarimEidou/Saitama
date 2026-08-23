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
   * True when the touch was close enough to the anchor to be treated as a grab
   * OF the anchored stick. False means the thumb landed too far away and the
   * origin fell back to the touch point (see `stickOriginFor`).
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
  return (
    Math.hypot(tuning.stickFixedInsetPx, tuning.stickFixedInsetPx) + tuning.stickBaseRadiusPx
  );
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
 */
export function isStickZone(
  x: number,
  y: number,
  viewportW: number,
  viewportH: number,
  tuning: IInputTuning
): boolean {
  if (y < viewportH * tuning.stickZoneTopFraction) return false;
  const band = viewportW * tuning.stickZoneFraction;
  return tuning.stickHand === 'right' ? x > viewportW - band : x < band;
}

/**
 * Where the stick's origin goes for a touch at (x, y).
 *
 * FLOATING is the simple case and the old behaviour: the origin materialises
 * exactly under the thumb.
 *
 * ANCHORED has to answer a question floating never had to. The ring is painted
 * at a fixed place, but the thumb does not always land on it — and neither
 * obvious answer is acceptable on its own:
 *
 *   • Always use the anchor. A thumb landing 200px away is then already at
 *     full deflection the instant it touches down, and the character sprints
 *     off in whatever direction the player happened to tap. That is a sprint
 *     nobody asked for, and it is how a lot of anchored sticks actually feel.
 *   • Always use the touch point. Then the ring is decoration: it is painted
 *     over there while the stick reads from over here, and the player's thumb
 *     is being lied to.
 *
 * So: inside `stickCaptureRadiusPx` of the anchor the touch is a grab OF the
 * anchored stick and snaps to it — which is what makes the ring meaningful,
 * because a thumb placed anywhere on the artwork centres it. Beyond that
 * radius the touch is not a grab at all, and the origin falls back to the
 * touch point while the ring stays painted where it belongs, working as a
 * deflection gauge rather than a thumb-follower. The capture radius (122px) is
 * deliberately a little larger than the painted ring (76px), so the generous
 * miss that lands just outside the artwork still counts as grabbing it.
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
