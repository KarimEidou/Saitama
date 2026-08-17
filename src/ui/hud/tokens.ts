/**
 * HUD DESIGN TOKENS
 *
 * Every colour, size and duration the HUD uses, in one place, as data.
 *
 * ── WHY TOKENS AND NOT LITERALS IN THE STYLESHEET ──────────────────────────
 * The colourblind palettes are not a cosmetic setting: they swap the meaning
 * of the two colours a player reads fastest — SAVED and LOST. That swap has to
 * be verifiable, which means the palettes have to be values a test can walk
 * rather than strings buried in a template literal. `__tests__/palette.test.ts`
 * walks them and asserts perceptual separation under simulated dichromacy.
 *
 * ── THE ONE COLOUR THAT IS NOT NEGOTIABLE ──────────────────────────────────
 * `#ffd230` is already the accent in `index.html` and in the input overlay's
 * stick and punch button. The HUD adopts it rather than introducing a second
 * yellow; two nearly-identical accents on one screen read as a rendering bug.
 *
 * ── ORDINAL COLOUR IS NEVER ALONE ──────────────────────────────────────────
 * Threat tiers are an ORDERED severity ramp, and no five-hue ramp survives
 * dichromacy intact. Every place a tier colour appears, the tier NAME appears
 * with it. Colour is the accelerator; the word is the message.
 */

import type { HeroClass, LethalIntent, ThreatTier } from '@/types';

/* -------------------------------------------------------------------------- */
/* Palettes                                                                   */
/* -------------------------------------------------------------------------- */

/** Selectable colour treatments. */
export type PaletteName = 'default' | 'deuteranopia' | 'protanopia' | 'tritanopia' | 'highContrast';

export const PALETTE_NAMES: readonly PaletteName[] = [
  'default',
  'deuteranopia',
  'protanopia',
  'tritanopia',
  'highContrast',
];

/** Human-readable palette labels for the settings screen. */
export const PALETTE_LABELS: Readonly<Record<PaletteName, string>> = {
  default: 'Standard',
  deuteranopia: 'Deuteranopia',
  protanopia: 'Protanopia',
  tritanopia: 'Tritanopia',
  highContrast: 'High contrast',
};

/**
 * The semantic slots a palette fills.
 *
 * `saved` / `lost` are the pair that has to survive everything: they sit side
 * by side in the civilian ledger and the player reads them in under a second
 * while a monster is swinging at them.
 */
export interface IHudPalette {
  /** Hero Association yellow. Shared with the input overlay. */
  readonly accent: string;
  /** Civilians saved. */
  readonly saved: string;
  /** Civilians lost. */
  readonly lost: string;
  /** Property damage / collateral. */
  readonly collateral: string;
  /** Serious-punch commitment. */
  readonly commit: string;
  /** Rival ahead of the player on the ladder. */
  readonly rival: string;
  /** Primary text. */
  readonly ink: string;
  /** Secondary text. */
  readonly inkMuted: string;
  /** Panel fill. */
  readonly surface: string;
  /** Panel hairline. */
  readonly line: string;
}

/**
 * Standard palette.
 *
 * Green/red for saved/lost, which is the fastest pairing for trichromats and
 * the reason the alternates below exist at all.
 */
const DEFAULT_PALETTE: IHudPalette = {
  accent: '#ffd230',
  saved: '#54e08a',
  lost: '#ff5a63',
  collateral: '#ff9f43',
  commit: '#7ef0ff',
  rival: '#c58bff',
  ink: '#f2f5fa',
  inkMuted: '#93a2ba',
  surface: 'rgba(7,10,17,0.82)',
  line: 'rgba(255,255,255,0.14)',
};

/**
 * Red-green dichromacy (deuteranopia and protanopia).
 *
 * The fix is not "make the green bluer" — it is to move the pair onto the
 * BLUE/ORANGE axis, which both dichromacies retain, and to widen the lightness
 * gap so the pair separates in greyscale too.
 */
const DEUTERANOPIA_PALETTE: IHudPalette = {
  ...DEFAULT_PALETTE,
  saved: '#66c9ff',
  lost: '#ffb01f',
  collateral: '#ff7043',
  commit: '#b9a2ff',
  rival: '#8fd4ff',
};

/** Protanopia additionally loses red LUMINANCE, so `lost` is lifted further. */
const PROTANOPIA_PALETTE: IHudPalette = {
  ...DEUTERANOPIA_PALETTE,
  saved: '#5cc0ff',
  lost: '#ffc233',
  collateral: '#ff8a5c',
};

/**
 * Tritanopia loses the blue/yellow axis, so blue/orange is exactly the wrong
 * choice here and red/cyan is the right one.
 */
const TRITANOPIA_PALETTE: IHudPalette = {
  ...DEFAULT_PALETTE,
  saved: '#3fd7d0',
  lost: '#ff5b7a',
  collateral: '#ff8fa8',
  commit: '#8fe8ff',
  rival: '#ff9fbf',
};

/**
 * High contrast: maximum luminance separation, minimum chroma reliance.
 * Also the palette to pick in direct sunlight, which is the actual condition a
 * phone game gets played in.
 */
const HIGH_CONTRAST_PALETTE: IHudPalette = {
  accent: '#ffe066',
  saved: '#9dfbff',
  lost: '#ff9a9a',
  collateral: '#ffd08a',
  commit: '#ffffff',
  rival: '#e0c9ff',
  ink: '#ffffff',
  inkMuted: '#cfd8e6',
  surface: 'rgba(0,0,0,0.92)',
  line: 'rgba(255,255,255,0.4)',
};

export const PALETTES: Readonly<Record<PaletteName, IHudPalette>> = {
  default: DEFAULT_PALETTE,
  deuteranopia: DEUTERANOPIA_PALETTE,
  protanopia: PROTANOPIA_PALETTE,
  tritanopia: TRITANOPIA_PALETTE,
  highContrast: HIGH_CONTRAST_PALETTE,
};

/* -------------------------------------------------------------------------- */
/* Threat tiers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Severity ramp, ordered wolf -> god.
 *
 * Ordered by HEAT and by LIGHTNESS together, so the order survives greyscale.
 * Never rendered without the tier word beside it.
 */
export const TIER_COLOR: Readonly<Record<ThreatTier, string>> = {
  wolf: '#8fa6bd',
  tiger: '#ffd230',
  demon: '#ff8a3d',
  dragon: '#ff4d4d',
  god: '#ff5ce1',
};

/** Ascending danger. Used for sorting and for the alert's urgency treatment. */
export const TIER_ORDER: readonly ThreatTier[] = ['wolf', 'tiger', 'demon', 'dragon', 'god'];

/** Association shorthand shown on the alert banner. */
export const TIER_LABEL: Readonly<Record<ThreatTier, string>> = {
  wolf: 'WOLF',
  tiger: 'TIGER',
  demon: 'DEMON',
  dragon: 'DRAGON',
  god: 'GOD',
};

/** How the alert reads out loud. The Association's own wording. */
export const TIER_ADVISORY: Readonly<Record<ThreatTier, string>> = {
  wolf: 'Potential threat to citizens',
  tiger: 'Threat to a large number of people',
  demon: 'Threat to an entire city',
  dragon: 'Threat to multiple cities',
  god: 'Threat to the survival of humanity',
};

/* -------------------------------------------------------------------------- */
/* Hero class                                                                 */
/* -------------------------------------------------------------------------- */

/** Class badge tint. S is the only one that gets to be gold. */
export const CLASS_COLOR: Readonly<Record<HeroClass, string>> = {
  C: '#8fa6bd',
  B: '#7ec8ff',
  A: '#b48bff',
  S: '#ffd230',
};

/* -------------------------------------------------------------------------- */
/* Intent                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The charge arc's colour by the intent the current charge would commit.
 *
 * This is the whole point of the arc: the player is not watching a bar fill,
 * they are watching a decision cross two thresholds.
 */
export const INTENT_COLOR: Readonly<Record<LethalIntent, string>> = {
  restrained: '#54e08a',
  normal: '#7ef0ff',
  serious: '#ff9f43',
  full: '#ff4d4d',
};

export const INTENT_LABEL: Readonly<Record<LethalIntent, string>> = {
  restrained: 'RESTRAINED',
  normal: 'NORMAL',
  serious: 'SERIOUS',
  full: 'NO RESTRAINT',
};

/**
 * Charge ratio at which a hold crosses into each intent.
 *
 * Mirrors how the combat system reads a hold; the HUD only has to be
 * DIRECTIONALLY right, because it is describing a decision, not resolving one.
 * `intentForCharge` is the single place this mapping lives.
 */
export const INTENT_THRESHOLDS: readonly { readonly at: number; readonly intent: LethalIntent }[] =
  [
    { at: 0, intent: 'normal' },
    { at: 0.45, intent: 'serious' },
    { at: 0.85, intent: 'full' },
  ];

/** Which intent a charge ratio currently commits. */
export function intentForCharge(ratio: number): LethalIntent {
  let intent: LethalIntent = 'normal';
  for (const step of INTENT_THRESHOLDS) {
    if (ratio >= step.at) intent = step.intent;
  }
  return intent;
}

/* -------------------------------------------------------------------------- */
/* Boredom                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Boredom bands.
 *
 * The meter is the game's real progress bar, so it is labelled as a MOOD and
 * never as a percentage. A number would invite optimising it; a word invites
 * noticing it.
 *
 * The top band is where `BOREDOM_FUN_FIGHT_LOCK` (0.72) starts refusing fun
 * fights, which is why the band boundary sits there rather than at a round
 * number.
 */
export interface IBoredomBand {
  /** Lower bound, inclusive. */
  readonly from: number;
  readonly label: string;
  /** Colour of the fill in this band. Drains towards grey as boredom rises. */
  readonly color: string;
  /** Seconds per breath of the meter's idle pulse. Slows as he stops caring. */
  readonly breathSeconds: number;
}

export const BOREDOM_BANDS: readonly IBoredomBand[] = [
  { from: 0, label: 'ENGAGED', color: '#54e08a', breathSeconds: 2.4 },
  { from: 0.25, label: 'RESTLESS', color: '#a8d84f', breathSeconds: 3.6 },
  { from: 0.5, label: 'GOING THROUGH THE MOTIONS', color: '#c8b45a', breathSeconds: 5.4 },
  { from: 0.72, label: 'NOTHING FEELS LIKE ANYTHING', color: '#8b8b93', breathSeconds: 8.2 },
  { from: 0.92, label: 'NUMB', color: '#6a6a72', breathSeconds: 12 },
];

/** The band a boredom value falls in. Never returns undefined. */
export function boredomBand(value: number): IBoredomBand {
  let band = BOREDOM_BANDS[0]!;
  for (const candidate of BOREDOM_BANDS) {
    if (value >= candidate.from) band = candidate;
  }
  return band;
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Reserved corner for the right thumb, in CSS px from the safe-area corner.
 *
 * `src/ui/input/touch-overlay.ts` strikes its button arc from a pivot 16 px
 * inside the safe-area corner, and the outermost button (`interact`) sits at
 * radius 166 with a 66 px diameter. 16 + 166 + 33 = 215, plus a 25 px margin so
 * the HUD is not merely *outside* the buttons but outside the HAND.
 *
 * Nothing the player has to read may enter this square. Asserted in the
 * harness against the input overlay's own exported geometry, so if the arc is
 * ever retuned this number fails loudly instead of quietly overlapping.
 */
export const THUMB_RESERVE_PX = 240;

/**
 * The same reservation for the left thumb.
 *
 * The stick is FLOATING: its origin is wherever the thumb lands in the left
 * half, so there is no fixed rectangle to avoid. What can be said is that the
 * hand covers the bottom-left corner out to roughly a full-deflection radius
 * (120 px) plus the palm.
 */
export const STICK_RESERVE_PX = 200;

/** Minimum tap target, CSS px. Anything smaller is a bug, not a style. */
export const MIN_TAP_PX = 44;
