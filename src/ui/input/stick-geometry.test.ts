/**
 * STICK GEOMETRY
 *
 * The arithmetic behind the two questions that decide whether the movement
 * control works at all: does this touch belong to the stick, and where is the
 * stick. Both used to be one-liners buried in `TouchCore.onDown`, and both were
 * wrong in ways nobody could assert against — the zone was the whole left half
 * of the screen from top to bottom, and the origin was always the touch point.
 *
 * Everything here is pure and runs in Node. What CANNOT be checked here is
 * whether the RING lands on the anchor these functions compute; that needs a
 * layout engine and lives in `__tests__/overlay-browser.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import type { SafeAreaInsets } from '@/types';
import { DEFAULT_INPUT_TUNING, resolveTuning } from './config';
import {
  fixedStickAnchor,
  isStickZone,
  stickKnobTravelPx,
  stickOriginFor,
  stickReachPx,
  STICK_KNOB_RADIUS_PX,
  ZERO_SAFE_AREA,
} from './stick-geometry';

const T = DEFAULT_INPUT_TUNING;
const RIGHT_HANDED = resolveTuning({ stickHand: 'right' });
const FLOATING = resolveTuning({ floatingStick: true });

/**
 * The three viewports `harness/hud.verify.ts` shoots every screen at. Mirrored
 * here so the anchored stick is checked against the same devices the HUD is,
 * including the one whose insets are asymmetric — a left-notch landscape phone
 * is the shipping case and the only profile where a left/right mix-up shows.
 */
const PROFILES = [
  {
    id: 'phone-landscape',
    width: 844,
    height: 390,
    insets: { top: 0, right: 34, bottom: 21, left: 59 },
  },
  {
    id: 'phone-portrait',
    width: 390,
    height: 844,
    insets: { top: 59, right: 0, bottom: 34, left: 0 },
  },
  { id: 'tablet', width: 1024, height: 768, insets: { top: 0, right: 0, bottom: 0, left: 0 } },
] as const satisfies readonly {
  id: string;
  width: number;
  height: number;
  insets: SafeAreaInsets;
}[];

/* ========================================================================== */
/* Which touches belong to the stick                                          */
/* ========================================================================== */

describe('isStickZone', () => {
  const W = 1000;
  const H = 600;
  const edge = W * T.stickZoneFraction;
  const low = H * 0.9; // comfortably below the top band

  it('is exclusive at the boundary, and decides either side of it', () => {
    expect(isStickZone(edge - 1, low, W, H, T)).toBe(true);
    expect(isStickZone(edge, low, W, H, T)).toBe(false);
    expect(isStickZone(edge + 1, low, W, H, T)).toBe(false);
  });

  it('mirrors for a right-handed stick', () => {
    const mirrored = W - edge;
    expect(isStickZone(mirrored + 1, low, W, H, RIGHT_HANDED)).toBe(true);
    expect(isStickZone(mirrored, low, W, H, RIGHT_HANDED)).toBe(false);
    expect(isStickZone(mirrored - 1, low, W, H, RIGHT_HANDED)).toBe(false);
  });

  it('leaves each hand’s far side entirely to the camera', () => {
    expect(isStickZone(10, low, W, H, T)).toBe(true);
    expect(isStickZone(W - 10, low, W, H, T)).toBe(false);
    expect(isStickZone(10, low, W, H, RIGHT_HANDED)).toBe(false);
    expect(isStickZone(W - 10, low, W, H, RIGHT_HANDED)).toBe(true);
  });

  it('GIVES THE TOP BAND TO THE CAMERA, on both hands', () => {
    // The complaint this fixes: a swipe in the upper-left to look around walked
    // the character instead, because the stick zone ran the full height of the
    // screen. Nobody reaches for the top corner of a phone to walk.
    const top = H * T.stickZoneTopFraction;
    expect(isStickZone(50, top - 1, W, H, T)).toBe(false);
    expect(isStickZone(50, top + 1, W, H, T)).toBe(true);
    expect(isStickZone(W - 50, top - 1, W, H, RIGHT_HANDED)).toBe(false);
    expect(isStickZone(W - 50, top + 1, W, H, RIGHT_HANDED)).toBe(true);
  });

  it('still leaves the bottom corner of the stick hand to the stick', () => {
    // Where the anchored ring actually lives, on every shipping profile.
    for (const profile of PROFILES) {
      const anchor = fixedStickAnchor(T, profile.width, profile.height, profile.insets);
      expect(isStickZone(anchor.x, anchor.y, profile.width, profile.height, T), profile.id).toBe(
        true
      );
    }
  });
});

/* ========================================================================== */
/* Where the anchored stick is                                                */
/* ========================================================================== */

describe('fixedStickAnchor', () => {
  it('measures from the SAFE-AREA corner on every shipping profile', () => {
    for (const profile of PROFILES) {
      const { width, height, insets } = profile;
      const anchor = fixedStickAnchor(T, width, height, insets);
      expect(anchor.x, profile.id).toBe(insets.left + T.stickFixedInsetPx);
      expect(anchor.y, profile.id).toBe(height - insets.bottom - T.stickFixedInsetPx);
      // ...and the whole ring is still on the screen, which is the point of
      // measuring from the corner rather than clamping afterwards.
      expect(anchor.x - T.stickBaseRadiusPx, profile.id).toBeGreaterThanOrEqual(0);
      expect(anchor.y + T.stickBaseRadiusPx, profile.id).toBeLessThanOrEqual(height);
    }
  });

  it('takes the other corner for a right-handed stick', () => {
    for (const profile of PROFILES) {
      const { width, height, insets } = profile;
      const anchor = fixedStickAnchor(RIGHT_HANDED, width, height, insets);
      expect(anchor.x, profile.id).toBe(width - insets.right - T.stickFixedInsetPx);
      expect(anchor.y, profile.id).toBe(height - insets.bottom - T.stickFixedInsetPx);
    }
  });

  it('is a plain corner offset when there are no insets', () => {
    const anchor = fixedStickAnchor(T, 1000, 600, ZERO_SAFE_AREA);
    expect(anchor).toEqual({ x: 96, y: 504 });
  });

  it('ignores a negative inset rather than pulling the anchor off-screen', () => {
    const anchor = fixedStickAnchor(T, 1000, 600, {
      top: 0,
      right: 0,
      bottom: -50,
      left: -50,
    });
    expect(anchor).toEqual({ x: 96, y: 504 });
  });
});

describe('stickReachPx', () => {
  it('is the diagonal to the anchor plus the painted radius', () => {
    expect(stickReachPx(T)).toBeCloseTo(Math.hypot(96, 96) + 76, 6);
  });

  it('stays under the HUD’s mirrored reservation', () => {
    // `src/ui/hud/tokens.ts` sets STICK_RESERVE_PX = 225 from this arithmetic
    // and cannot import it (the HUD is forbidden from importing `@/ui/input`),
    // so this is the input layer's half of that hand-maintained mirror. Grow
    // the stick past 225 and the HUD's bottom-corner panel ends up under the
    // ring; the harness compares the two numbers directly.
    expect(stickReachPx(T)).toBeLessThan(225);
  });
});

/* ========================================================================== */
/* Where the origin goes                                                      */
/* ========================================================================== */

describe('stickOriginFor', () => {
  const W = 1000;
  const H = 600;
  const anchor = fixedStickAnchor(T, W, H, ZERO_SAFE_AREA);

  it('FLOATING always lands under the thumb', () => {
    for (const [x, y] of [
      [10, 590],
      [anchor.x, anchor.y],
      [430, 250],
    ] as const) {
      expect(stickOriginFor(x, y, W, H, ZERO_SAFE_AREA, FLOATING)).toEqual({
        x,
        y,
        captured: false,
      });
    }
  });

  it('ANCHORED captures a touch inside the capture radius', () => {
    const inside = T.stickCaptureRadiusPx - 1;
    const origin = stickOriginFor(anchor.x + inside, anchor.y, W, H, ZERO_SAFE_AREA, T);
    expect(origin).toEqual({ x: anchor.x, y: anchor.y, captured: true });
  });

  it('ANCHORED captures right up to the radius, and not past it', () => {
    const on = stickOriginFor(anchor.x, anchor.y - T.stickCaptureRadiusPx, W, H, ZERO_SAFE_AREA, T);
    expect(on.captured).toBe(true);
    const past = stickOriginFor(
      anchor.x,
      anchor.y - T.stickCaptureRadiusPx - 1,
      W,
      H,
      ZERO_SAFE_AREA,
      T
    );
    expect(past.captured).toBe(false);
  });

  it('ANCHORED FALLS BACK to the touch point for a far thumb', () => {
    // Not the anchor. Snapping a thumb that landed 200px away onto the anchor
    // would report near-full deflection the instant it touched down — a sprint
    // the player did not ask for.
    const far = { x: 380, y: 200 };
    const origin = stickOriginFor(far.x, far.y, W, H, ZERO_SAFE_AREA, T);
    expect(origin).toEqual({ x: far.x, y: far.y, captured: false });
  });

  it('ANCHORED captures against the INSET corner, not the glass corner', () => {
    const insets: SafeAreaInsets = { top: 0, right: 34, bottom: 21, left: 59 };
    const shifted = fixedStickAnchor(T, W, H, insets);
    // A touch on the un-inset anchor is 59+21 away from the real one, which is
    // still inside the capture radius, but the ORIGIN must be the real anchor.
    const origin = stickOriginFor(anchor.x, anchor.y, W, H, insets, T);
    expect(origin).toEqual({ x: shifted.x, y: shifted.y, captured: true });
    expect(shifted.x).not.toBe(anchor.x);
  });
});

/* ========================================================================== */
/* Knob travel                                                                */
/* ========================================================================== */

describe('stickKnobTravelPx', () => {
  it('keeps the knob inside its own base at full deflection', () => {
    // The reason the visual radius is a separate field at all. Travel plus the
    // knob's radius has to equal the ring's radius exactly: any more and the
    // knob hangs outside its base, any less and the ring has dead margin.
    expect(stickKnobTravelPx(T) + STICK_KNOB_RADIUS_PX).toBe(T.stickBaseRadiusPx);
  });

  it('is NOT the input radius — that is the bug it exists to prevent', () => {
    expect(stickKnobTravelPx(T)).toBeLessThan(T.stickFullDeflectionPx);
  });

  it('refuses to go negative for a knob larger than its base', () => {
    expect(stickKnobTravelPx(resolveTuning({ stickBaseRadiusPx: 10 }))).toBe(0);
  });
});
