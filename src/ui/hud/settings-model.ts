/**
 * SETTINGS
 *
 * The HUD owns the SETTINGS SCREEN, not the settings. It renders controls,
 * validates values and emits a changed snapshot; the renderer, the input layer
 * and the platform adapter apply them.
 *
 * That split matters because two of these settings are not cosmetic:
 * `qualityTier` and `resolutionScale` change what the GPU is asked to do, and a
 * UI that mutated them directly would be reaching across three workstreams to
 * do it. So `IHudSettings` is a value, `onChange` is the only exit, and nothing
 * in `src/ui/hud/` imports a renderer.
 *
 * ── WHY RESOLUTION SCALE IS A DISCRETE LADDER ──────────────────────────────
 * A continuous slider invites 0.83, which lands the framebuffer on a
 * non-integer device-pixel boundary and produces exactly the shimmering the
 * player was trying to fix. Five rungs, all clean fractions.
 */

import type { IQualityTier } from '@/types';
import { PALETTE_NAMES, type PaletteName } from './tokens';

/** Where the movement stick lives. */
export type StickLayout = 'floating' | 'fixed';

/** Which hand holds the stick. Left-handed players exist and get forgotten. */
export type StickHand = 'left' | 'right';

/** Everything the settings screen can change. */
export interface IHudSettings {
  /* -- render -- */
  readonly qualityTier: IQualityTier;
  /** Multiplier on the render buffer. 0.5 .. 1.0. */
  readonly resolutionScale: number;
  /* -- controls -- */
  readonly stickLayout: StickLayout;
  readonly stickHand: StickHand;
  readonly invertLookY: boolean;
  /** 0.4 .. 2.0, multiplier on the look rate. */
  readonly lookSensitivity: number;
  readonly hapticsEnabled: boolean;
  /* -- presentation -- */
  readonly palette: PaletteName;
  /** Scales HUD typography and control chrome. 0.85 .. 1.3. */
  readonly hudScale: number;
  /** Suppresses the boredom breath, alert pulses and screen transitions. */
  readonly reducedMotion: boolean;
  /** Draws the damage/collateral figures the fight is accruing. */
  readonly showCollateralTicker: boolean;
}

export const DEFAULT_HUD_SETTINGS: IHudSettings = Object.freeze({
  qualityTier: 'medium',
  resolutionScale: 1,
  stickLayout: 'floating',
  stickHand: 'left',
  invertLookY: false,
  lookSensitivity: 1,
  hapticsEnabled: true,
  palette: 'default',
  hudScale: 1,
  reducedMotion: false,
  showCollateralTicker: true,
});

/** The rungs of the resolution ladder, coarsest first. */
export const RESOLUTION_STEPS: readonly number[] = [0.5, 0.6, 0.75, 0.85, 1];

/** Look-sensitivity rungs. */
export const SENSITIVITY_STEPS: readonly number[] = [0.4, 0.6, 0.8, 1, 1.3, 1.6, 2];

/** HUD-scale rungs. */
export const HUD_SCALE_STEPS: readonly number[] = [0.85, 1, 1.15, 1.3];

export const QUALITY_TIERS: readonly IQualityTier[] = ['low', 'medium', 'high'];

/** What each tier costs, in the player's terms rather than the renderer's. */
export const QUALITY_BLURB: Readonly<Record<IQualityTier, string>> = {
  low: 'No shadows, no post. Longest battery.',
  medium: 'Shadows and bloom. The default.',
  high: 'Everything on. Warm phone.',
};

/** Snap a value onto the nearest rung of a ladder. */
export function snapToStep(value: number, steps: readonly number[]): number {
  let best = steps[0] ?? value;
  let bestGap = Infinity;
  for (const step of steps) {
    const gap = Math.abs(step - value);
    if (gap < bestGap) {
      bestGap = gap;
      best = step;
    }
  }
  return best;
}

/** Index of the rung a value sits on, for a stepper control. */
export function stepIndex(value: number, steps: readonly number[]): number {
  const snapped = snapToStep(value, steps);
  const index = steps.indexOf(snapped);
  return index < 0 ? 0 : index;
}

/**
 * Coerce an arbitrary partial — from a save file, a URL, or a future version —
 * into settings the UI can render without crashing.
 *
 * Save files outlive builds. A palette that was removed, a quality tier that
 * was renamed and a resolution scale of `NaN` all have to land somewhere
 * sensible rather than propagate into the renderer.
 */
export function normaliseSettings(patch: Partial<IHudSettings> | undefined): IHudSettings {
  const base = DEFAULT_HUD_SETTINGS;
  if (!patch) return base;
  return Object.freeze({
    qualityTier: QUALITY_TIERS.includes(patch.qualityTier as IQualityTier)
      ? (patch.qualityTier as IQualityTier)
      : base.qualityTier,
    resolutionScale: snapToStep(finite(patch.resolutionScale, base.resolutionScale), RESOLUTION_STEPS),
    stickLayout: patch.stickLayout === 'fixed' ? 'fixed' : 'floating',
    stickHand: patch.stickHand === 'right' ? 'right' : 'left',
    invertLookY: patch.invertLookY === true,
    lookSensitivity: snapToStep(
      finite(patch.lookSensitivity, base.lookSensitivity),
      SENSITIVITY_STEPS
    ),
    hapticsEnabled: patch.hapticsEnabled !== false,
    palette: PALETTE_NAMES.includes(patch.palette as PaletteName)
      ? (patch.palette as PaletteName)
      : base.palette,
    hudScale: snapToStep(finite(patch.hudScale, base.hudScale), HUD_SCALE_STEPS),
    reducedMotion: patch.reducedMotion === true,
    showCollateralTicker: patch.showCollateralTicker !== false,
  });
}

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
