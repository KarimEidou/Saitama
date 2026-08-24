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
      expect(
        isStickZone(anchor.x, anchor.y, profile.width, profile.height, T, profile.insets),
        profile.id
      ).toBe(true);
    }
  });

  /* ------------------------------------------------------------------------ */
  /* ring-outside-zone                                                        */
  /* ------------------------------------------------------------------------ */

  /**
   * Viewports narrow enough for `stickZoneFraction` to fall short of the ring.
   * The ring's inboard edge is `insets + stickFixedInsetPx + stickBaseRadiusPx`
   * = 172px on an un-notched phone, a CONSTANT; 45% of the width passes under
   * it at 382px and keeps falling. The first two entries are, between them,
   * most of the phones this game will ever run on.
   */
  const NARROW = [
    { id: '360x640 — Galaxy S / Pixel, the most common Android width', width: 360, height: 640 },
    { id: '375x667 — iPhone SE and mini', width: 375, height: 667 },
    { id: '320x568 — the narrowest phone still in the wild', width: 320, height: 568 },
  ] as const;

  /**
   * The outermost PIXEL CENTRES of the painted ring: the band is exclusive at
   * its edge, and the last pixel the ring actually paints is half a pixel
   * inside the geometric outline.
   */
  function ringOutline(tuning: typeof T, width: number, height: number, insets: SafeAreaInsets) {
    const anchor = fixedStickAnchor(tuning, width, height, insets);
    const r = tuning.stickBaseRadiusPx - 0.5;
    return Array.from({ length: 16 }, (_, i) => {
      const angle = (i / 16) * Math.PI * 2;
      return { x: anchor.x + Math.cos(angle) * r, y: anchor.y + Math.sin(angle) * r };
    });
  }

  it('CONTAINS ITS OWN ARTWORK on a narrow phone, in either hand', () => {
    // The regression: on a 360px Android the ring spans x 20..172 and the zone
    // stopped at 162, so a 10px crescent of joystick — its inboard edge, the
    // side the thumb pushes into to walk across the screen — was CAMERA. The
    // player pressed the control they could see and the horizon swung instead.
    for (const { id, width, height } of NARROW) {
      for (const [hand, tuning] of [
        ['left', T],
        ['right', RIGHT_HANDED],
      ] as const) {
        for (const point of ringOutline(tuning, width, height, ZERO_SAFE_AREA)) {
          expect(
            isStickZone(point.x, point.y, width, height, tuning, ZERO_SAFE_AREA),
            `${id} ${hand} (${point.x.toFixed(1)},${point.y.toFixed(1)})`
          ).toBe(true);
        }
      }
    }
  });

  it('contains the artwork the SAFE AREA pushed inboard, not where the glass is', () => {
    // A notch moves the ring further into the screen, so the zone has to move
    // with it. Derived from the raw edge, the widening would be short by
    // exactly the inset — on precisely the phones that have one.
    const insets: SafeAreaInsets = { top: 0, right: 0, bottom: 34, left: 44 };
    for (const point of ringOutline(T, 390, 844, insets)) {
      expect(isStickZone(point.x, point.y, 390, 844, T, insets)).toBe(true);
    }
  });

  it('widens only as far as the artwork, and not across the screen', () => {
    // The fraction is the comfort margin and the ring is the floor; the floor
    // must not become the ceiling. At 360 the zone reaches the ring's edge at
    // 172 and stops, leaving the rest of a small screen to the camera.
    const ringEdge = T.stickFixedInsetPx + T.stickBaseRadiusPx;
    expect(isStickZone(ringEdge - 1, 544, 360, 640, T)).toBe(true);
    expect(isStickZone(ringEdge, 544, 360, 640, T)).toBe(false);
    expect(isStickZone(220, 544, 360, 640, T)).toBe(false);
    // ...and the top band is untouched: nobody walks from up there.
    expect(isStickZone(60, 640 * T.stickZoneTopFraction - 1, 360, 640, T)).toBe(false);
  });

  it('leaves the fraction in charge wherever the fraction is the wider of the two', () => {
    // 382px is where the two cross. Above it nothing about this changed, which
    // is the whole point of `max` rather than a re-tune of the fraction.
    for (const { width, height, insets } of PROFILES) {
      const band = Math.max(
        width * T.stickZoneFraction,
        fixedStickAnchor(T, width, height, insets).x + T.stickBaseRadiusPx
      );
      expect(isStickZone(band - 1, height * 0.9, width, height, T, insets)).toBe(true);
      expect(isStickZone(band, height * 0.9, width, height, T, insets)).toBe(false);
    }
    expect(844 * T.stickZoneFraction).toBeGreaterThan(59 + 96 + 76);
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

  /* ------------------------------------------------------------------------ */
  /* tap-without-drag                                                         */
  /* ------------------------------------------------------------------------ */

  it('ANCHORED gives a STATIONARY TOUCH nothing to be deflected from, anywhere', () => {
    // The symptom: a finger that never moved commanded movement. Capture
    // snapped the origin onto the anchor for anything within 122px, and the
    // landing offset became deflection with no drag at all — 0.800 on the
    // ring's painted edge, a flat 1.000 in the 92..122px annulus outside the
    // artwork. Held, not a flicker: for as long as the thumb rested there.
    //
    // The invariant that kills it: wherever the origin ends up, the distance
    // from it to the LANDING POINT is inside the dead zone. That is true of a
    // touch-point origin trivially (distance 0) and of a captured one because
    // `stickCaptureRadiusPx <= stickDeadZonePx`.
    for (const radius of [0, 6, T.stickCaptureRadiusPx, 13, 40, 60, 76, 85, 92, 110, 122, 200]) {
      for (const angle of [0, Math.PI / 3, Math.PI, -Math.PI / 2]) {
        const x = anchor.x + Math.cos(angle) * radius;
        const y = anchor.y + Math.sin(angle) * radius;
        const origin = stickOriginFor(x, y, W, H, ZERO_SAFE_AREA, T);
        expect(
          Math.hypot(x - origin.x, y - origin.y),
          `r=${radius} angle=${angle.toFixed(2)}`
        ).toBeLessThanOrEqual(T.stickDeadZonePx);
      }
    }
  });

  it('ANCHORED hands a touch on the artwork the touch point, not the anchor', () => {
    // The other half of the same fix, stated as geometry: everything from the
    // aim tolerance outwards is a RELATIVE pad — wherever the thumb lands is
    // that touch's neutral, exactly as the floating layout has always worked.
    const onTheRing = { x: anchor.x + 60, y: anchor.y - 30 };
    expect(stickOriginFor(onTheRing.x, onTheRing.y, W, H, ZERO_SAFE_AREA, T)).toEqual({
      ...onTheRing,
      captured: false,
    });
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
    expect(shifted.x).not.toBe(anchor.x);
    // A thumb on the ring's real, inset centre is captured...
    expect(stickOriginFor(shifted.x, shifted.y, W, H, insets, T)).toEqual({
      x: shifted.x,
      y: shifted.y,
      captured: true,
    });
    // ...and one on the centre the GLASS corner would have given is 62px away
    // from it, which is a miss. It reads as a touch of its own rather than
    // being snapped to a ring that is nowhere near it.
    expect(Math.hypot(anchor.x - shifted.x, anchor.y - shifted.y)).toBeGreaterThan(
      T.stickCaptureRadiusPx
    );
    expect(stickOriginFor(anchor.x, anchor.y, W, H, insets, T)).toEqual({
      x: anchor.x,
      y: anchor.y,
      captured: false,
    });
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
