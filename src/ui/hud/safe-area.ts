/**
 * SAFE AREA
 *
 * ── WHY THIS IS THE FIRST THING THE HUD GETS RIGHT ─────────────────────────
 * A notch does not clip content, it DRAWS OVER it, and a gesture bar does not
 * block taps, it STEALS them. Both failures ship looking fine on the developer's
 * device and arrive as "the timer is behind the camera hole" and "the pause
 * button does nothing" from everyone else.
 *
 * ── THE THREE LAYERS, IN PRECEDENCE ORDER ──────────────────────────────────
 *   1. `env(safe-area-inset-*)` — the browser's own value. Correct whenever the
 *      WebView reports it, which is most of the time, and free.
 *   2. A PROGRAMMATIC OVERRIDE — `IPlatformAdapter.safeArea`, which Capacitor
 *      can fill from the native side. Needed because several Android WebViews
 *      report `env()` as 0 on devices that plainly have a cutout.
 *   3. A FLOOR — a couple of pixels so a HUD flush against a bezel-less edge
 *      does not look like a printing error.
 *
 * They compose as `max(env, override, floor)` in CSS, which is why the override
 * is exposed as four custom properties rather than as four `padding` values:
 * `max()` inside a `calc()` costs nothing and needs no JS to re-resolve when the
 * device rotates.
 *
 * ── ROTATION ───────────────────────────────────────────────────────────────
 * Insets do not rotate with the device — on a phone held in landscape, the
 * notch is on the LEFT or the RIGHT, and the home indicator stays on the
 * bottom. `rotateInsets` exists so a caller holding portrait-frame numbers can
 * produce the landscape ones without getting the mapping wrong, which is a
 * mistake that is invisible until someone turns the phone the other way.
 */

import type { SafeAreaInsets } from '@/types';

/** Custom properties the HUD stylesheet reads. */
export const SAFE_AREA_VARS = {
  top: '--hud-sa-ot',
  right: '--hud-sa-or',
  bottom: '--hud-sa-ob',
  left: '--hud-sa-ol',
} as const;

/**
 * Minimum breathing room on every edge, CSS px.
 *
 * Not a safety margin — a typographic one. Text hard against the panel edge of
 * a bezel-less phone reads as clipped even when it is not.
 */
export const EDGE_FLOOR_PX = 8;

export const ZERO_INSETS: SafeAreaInsets = Object.freeze({
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
});

/**
 * Reference insets for the notched-phone profile the harness screenshots.
 *
 * These are the real iPhone 14 Pro portrait values: 59 px of Dynamic Island,
 * 34 px of home indicator. Landscape is derived with {@link rotateInsets}
 * rather than typed out again, because typing it out again is how the two
 * drift.
 */
export const NOTCHED_PORTRAIT_INSETS: SafeAreaInsets = Object.freeze({
  top: 59,
  right: 0,
  bottom: 34,
  left: 0,
});

/** Which way the device was turned to reach landscape. */
export type RotationDirection = 'left' | 'right';

/**
 * Portrait insets -> landscape insets.
 *
 * Rotating the device LEFT (counter-clockwise, top edge goes to the left) puts
 * the notch on the left. The home indicator ends up on the bottom in both
 * landscape orientations because the OS re-anchors it, so `bottom` survives the
 * rotation and the old `bottom` becomes the trailing edge's inset.
 */
export function rotateInsets(
  insets: SafeAreaInsets,
  direction: RotationDirection = 'left'
): SafeAreaInsets {
  const gestureBar = 21; // the landscape home indicator is shorter than portrait
  return direction === 'left'
    ? { top: 0, right: insets.bottom, bottom: gestureBar, left: insets.top }
    : { top: 0, right: insets.top, bottom: gestureBar, left: insets.bottom };
}

/** Clamp to non-negative integers. Negative insets are always a bug upstream. */
export function normaliseInsets(insets: Partial<SafeAreaInsets> | undefined): SafeAreaInsets {
  return {
    top: Math.max(0, Math.round(insets?.top ?? 0)),
    right: Math.max(0, Math.round(insets?.right ?? 0)),
    bottom: Math.max(0, Math.round(insets?.bottom ?? 0)),
    left: Math.max(0, Math.round(insets?.left ?? 0)),
  };
}

/**
 * Write the override onto a root element.
 *
 * Not a 60 Hz path — this runs on boot and on orientation change, so it is
 * allowed to be a plain style write. It still only writes custom properties,
 * because the stylesheet is what turns them into padding.
 */
export function applySafeArea(root: HTMLElement, insets: Partial<SafeAreaInsets> | undefined): void {
  const value = normaliseInsets(insets);
  root.style.setProperty(SAFE_AREA_VARS.top, `${value.top}px`);
  root.style.setProperty(SAFE_AREA_VARS.right, `${value.right}px`);
  root.style.setProperty(SAFE_AREA_VARS.bottom, `${value.bottom}px`);
  root.style.setProperty(SAFE_AREA_VARS.left, `${value.left}px`);
}

/**
 * The rectangle, in viewport coordinates, that content may occupy.
 *
 * Used by the harness to assert that no HUD element crosses into a cutout. The
 * floor is deliberately NOT included: it is a typographic margin, and a test
 * that demanded it would be testing taste rather than correctness.
 */
export function safeRect(
  viewport: { readonly width: number; readonly height: number },
  insets: SafeAreaInsets
): { x: number; y: number; width: number; height: number } {
  return {
    x: insets.left,
    y: insets.top,
    width: Math.max(0, viewport.width - insets.left - insets.right),
    height: Math.max(0, viewport.height - insets.top - insets.bottom),
  };
}

/** The CSS the safe-area contract needs. Composed into the HUD stylesheet. */
export const SAFE_AREA_STYLES = `
.hud-root{
  --hud-sa-ot:0px;--hud-sa-or:0px;--hud-sa-ob:0px;--hud-sa-ol:0px;
  --hud-sa-t:max(env(safe-area-inset-top,0px),var(--hud-sa-ot),${EDGE_FLOOR_PX}px);
  --hud-sa-r:max(env(safe-area-inset-right,0px),var(--hud-sa-or),${EDGE_FLOOR_PX}px);
  --hud-sa-b:max(env(safe-area-inset-bottom,0px),var(--hud-sa-ob),${EDGE_FLOOR_PX}px);
  --hud-sa-l:max(env(safe-area-inset-left,0px),var(--hud-sa-ol),${EDGE_FLOOR_PX}px);
}
`;
