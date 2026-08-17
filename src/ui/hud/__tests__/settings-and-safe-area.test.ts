/**
 * SETTINGS AND SAFE-AREA TESTS
 *
 * Two things that look trivial and are not:
 *
 *   SETTINGS   have to survive a save file written by a build that had
 *              different palettes and a different resolution ladder. The
 *              coercion is what stops a stale value reaching the renderer.
 *
 *   INSETS     have to rotate correctly. Getting the landscape mapping wrong is
 *              invisible until somebody turns the phone the other way, and then
 *              the entire HUD is under the notch.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HUD_SETTINGS,
  HUD_SCALE_STEPS,
  RESOLUTION_STEPS,
  SENSITIVITY_STEPS,
  normaliseSettings,
  snapToStep,
  stepIndex,
} from '../settings-model';
import {
  EDGE_FLOOR_PX,
  NOTCHED_PORTRAIT_INSETS,
  normaliseInsets,
  rotateInsets,
  safeRect,
} from '../safe-area';
import { MIN_TAP_PX, STICK_RESERVE_PX, THUMB_RESERVE_PX } from '../tokens';

describe('settings coercion', () => {
  it('returns the defaults for nothing at all', () => {
    expect(normaliseSettings(undefined)).toEqual(DEFAULT_HUD_SETTINGS);
  });

  it('rejects a palette that no longer exists', () => {
    const settings = normaliseSettings({ palette: 'tetrachromacy' as never });
    expect(settings.palette).toBe('default');
  });

  it('rejects a quality tier from another axis', () => {
    // 'mobile' is a QualityTier (assets.ts), not an IQualityTier (engine.ts).
    // The three axes are deliberately not interchangeable and a save that mixes
    // them must not reach the renderer.
    expect(normaliseSettings({ qualityTier: 'mobile' as never }).qualityTier).toBe('medium');
  });

  it('snaps a continuous resolution onto the ladder', () => {
    // 0.83 lands the framebuffer between device pixels and shimmers, which is
    // the thing the player opened the screen to fix.
    expect(normaliseSettings({ resolutionScale: 0.83 }).resolutionScale).toBe(0.85);
    expect(normaliseSettings({ resolutionScale: Number.NaN }).resolutionScale).toBe(1);
    expect(normaliseSettings({ resolutionScale: 99 }).resolutionScale).toBe(1);
    expect(normaliseSettings({ resolutionScale: -3 }).resolutionScale).toBe(0.5);
  });

  it('treats booleans as opt-out where the default is on', () => {
    expect(normaliseSettings({}).hapticsEnabled).toBe(true);
    expect(normaliseSettings({ hapticsEnabled: false }).hapticsEnabled).toBe(false);
    expect(normaliseSettings({ showCollateralTicker: false }).showCollateralTicker).toBe(false);
    expect(normaliseSettings({ reducedMotion: true }).reducedMotion).toBe(true);
  });

  it('keeps stick layout and hand independent', () => {
    const settings = normaliseSettings({ stickLayout: 'fixed', stickHand: 'right' });
    expect(settings.stickLayout).toBe('fixed');
    expect(settings.stickHand).toBe('right');
  });

  it('snaps and indexes every ladder consistently', () => {
    for (const steps of [RESOLUTION_STEPS, SENSITIVITY_STEPS, HUD_SCALE_STEPS]) {
      for (const step of steps) {
        expect(snapToStep(step, steps)).toBe(step);
        expect(steps[stepIndex(step, steps)]).toBe(step);
      }
      expect(steps[stepIndex(-999, steps)]).toBe(steps[0]);
      expect(steps[stepIndex(999, steps)]).toBe(steps.at(-1));
    }
  });

  it('is frozen, so nothing downstream can mutate the shared object', () => {
    const settings = normaliseSettings({ hudScale: 1.15 });
    expect(Object.isFrozen(settings)).toBe(true);
  });
});

describe('safe area', () => {
  it('clamps rubbish to non-negative integers', () => {
    expect(normaliseInsets({ top: -4, right: 1.6, bottom: undefined, left: 3 })).toEqual({
      top: 0,
      right: 2,
      bottom: 0,
      left: 3,
    });
    expect(normaliseInsets(undefined)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it('puts the notch on the LEFT when the device is turned left', () => {
    const landscape = rotateInsets(NOTCHED_PORTRAIT_INSETS, 'left');
    expect(landscape.left).toBe(NOTCHED_PORTRAIT_INSETS.top);
    expect(landscape.right).toBe(NOTCHED_PORTRAIT_INSETS.bottom);
    expect(landscape.top).toBe(0);
  });

  it('and on the RIGHT when it is turned the other way', () => {
    const landscape = rotateInsets(NOTCHED_PORTRAIT_INSETS, 'right');
    expect(landscape.right).toBe(NOTCHED_PORTRAIT_INSETS.top);
    expect(landscape.left).toBe(NOTCHED_PORTRAIT_INSETS.bottom);
  });

  it('keeps a gesture bar on the bottom in both landscape orientations', () => {
    // The OS re-anchors the home indicator; a naive rotation loses it entirely
    // and the resume button ends up under the swipe-up zone.
    expect(rotateInsets(NOTCHED_PORTRAIT_INSETS, 'left').bottom).toBeGreaterThan(0);
    expect(rotateInsets(NOTCHED_PORTRAIT_INSETS, 'right').bottom).toBeGreaterThan(0);
  });

  it('computes the usable rectangle', () => {
    const rect = safeRect({ width: 390, height: 844 }, NOTCHED_PORTRAIT_INSETS);
    expect(rect).toEqual({ x: 0, y: 59, width: 390, height: 844 - 59 - 34 });
  });

  it('never returns a negative rectangle for absurd insets', () => {
    const rect = safeRect({ width: 100, height: 100 }, { top: 90, right: 90, bottom: 90, left: 90 });
    expect(rect.width).toBe(0);
    expect(rect.height).toBe(0);
  });
});

describe('thumb geometry', () => {
  it('reserves more than the input layer’s outermost button reaches', () => {
    // src/ui/input strikes its arc from a pivot 16 px inside the safe-area
    // corner; the outermost slot is at radius 166 with a 66 px diameter, so the
    // furthest painted pixel is 16 + 166 + 33 = 215. The harness asserts this
    // against the input layer's own exported constants; here we only assert the
    // reserve is bigger than the arithmetic, so a HUD element placed at the
    // reserve is outside the HAND and not merely outside the button.
    expect(THUMB_RESERVE_PX).toBeGreaterThan(16 + 166 + 33);
  });

  it('reserves a full stick deflection for the left thumb', () => {
    expect(STICK_RESERVE_PX).toBeGreaterThan(120);
  });

  it('sets the minimum tap target at the platform guidance', () => {
    expect(MIN_TAP_PX).toBeGreaterThanOrEqual(44);
  });

  it('gives every edge a typographic floor', () => {
    expect(EDGE_FLOOR_PX).toBeGreaterThan(0);
  });
});
