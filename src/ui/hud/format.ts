/**
 * HUD FORMATTERS
 *
 * Pure functions. No DOM, no state, no imports beyond the type contracts —
 * which is what makes them the only part of the HUD that is unit-testable
 * without a browser, and therefore where every rounding decision lives.
 *
 * ── THE YEN PROBLEM ────────────────────────────────────────────────────────
 * `IEncounterResult.propertyDamageYen` is an invoice and it is enormous: one
 * fully-charged serious punch downtown bills about ¥15,000,000,000. There are
 * two correct ways to show that and they are correct in different places:
 *
 *   LIVE TICKER    `formatYenCompact` -> "¥15.0B". Glanceable in one saccade
 *                  while something is swinging at you. Nobody reads eleven
 *                  digits mid-fight.
 *   THE INVOICE    `formatYenFull`    -> "¥15,000,000,000". The end-of-fight
 *                  card prints every digit ON PURPOSE. The absurdity is the
 *                  content; compacting it throws the joke away.
 *
 * Neither is ever fed into a score. `propertyDamageScore` (0..1) is what the
 * bounded meter reads, and `formatYen*` is display only.
 */

import type { HeroClass, ThreatTier } from '@/types';

/* -------------------------------------------------------------------------- */
/* Money                                                                      */
/* -------------------------------------------------------------------------- */

const YEN = '¥';

/**
 * Coerce a non-finite figure to zero.
 *
 * These functions are the last thing between an upstream number and a glyph, and
 * a `NaN` that reaches the screen prints `¥NaN` / `NaN:NaN` — an unreadable
 * value that also looks like a rendering fault rather than a bad input. `clamp01`
 * does not stop it: `NaN < 0` and `NaN > 1` are both false, so it passes through.
 */
function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** Compact magnitude suffixes. Deliberately stops at T; nothing bills higher. */
const MAGNITUDES: readonly { readonly at: number; readonly suffix: string }[] = [
  { at: 1e12, suffix: 'T' },
  { at: 1e9, suffix: 'B' },
  { at: 1e6, suffix: 'M' },
  { at: 1e3, suffix: 'K' },
];

/**
 * Glanceable yen, for the live collateral ticker.
 *
 * `¥0` stays `¥0` rather than becoming `¥0.0` — a restrained fight billing
 * exactly nothing is a result the player should be able to read instantly.
 */
export function formatYenCompact(yen: number): string {
  const value = Math.max(0, finite(yen));
  for (const step of MAGNITUDES) {
    if (value >= step.at) {
      const scaled = value / step.at;
      // 3 significant figures below 10, 1 decimal below 100, integer above.
      const decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
      return `${YEN}${scaled.toFixed(decimals)}${step.suffix}`;
    }
  }
  // Rounding can push a sub-K figure to 1000, which would print four ungrouped
  // digits into a ticker that is supposed to be a fixed three. Promote it.
  const rounded = Math.round(value);
  return rounded >= 1000 ? `${YEN}1.00K` : `${YEN}${rounded}`;
}

/** Every digit, grouped. The end-of-encounter invoice, and only that. */
export function formatYenFull(yen: number): string {
  const value = Math.max(0, Math.round(finite(yen)));
  return `${YEN}${groupDigits(value)}`;
}

/**
 * The same figure in the units a Japanese invoice would actually use.
 *
 * 億 = 10^8. `¥15,000,000,000` is `150億円`, which is how the Association's
 * accounts department would write it and is a nice second line under the
 * grouped figure.
 */
export function formatYenOku(yen: number): string {
  const yenSafe = Math.max(0, finite(yen));
  const oku = yenSafe / 1e8;
  if (oku >= 10000) return `${(oku / 10000).toFixed(2)}兆円`;
  if (oku < 0.01) return `${Math.round(yenSafe)}円`;
  return `${oku.toFixed(oku < 10 ? 2 : 1)}億円`;
}

/** Thousands separators without pulling in Intl (which allocates per call). */
export function groupDigits(value: number): string {
  const safe = finite(value);
  const negative = safe < 0;
  const digits = Math.abs(Math.round(safe)).toString();
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return negative ? `-${out}` : out;
}

/* -------------------------------------------------------------------------- */
/* Time                                                                       */
/* -------------------------------------------------------------------------- */

/** Split seconds into the integer parts a CSS counter can render. */
export interface IClockParts {
  readonly minutes: number;
  readonly seconds: number;
  /** Tenths, for sub-minute timers where a tenth is the drama. */
  readonly tenths: number;
}

/**
 * Split a duration for the timer readouts.
 *
 * Rounds DOWN, always. A countdown that shows 0:01 while the quest has already
 * failed is a lie the player will notice; one that shows 0:00 for the last
 * second is merely tense.
 */
export function clockParts(seconds: number): IClockParts {
  const total = Math.max(0, finite(seconds));
  const whole = Math.floor(total);
  return {
    minutes: Math.floor(whole / 60),
    seconds: whole % 60,
    tenths: Math.floor((total - whole) * 10),
  };
}

/** `1:07` / `12:00`. Padded to two digits of seconds. */
export function formatClock(seconds: number): string {
  const parts = clockParts(seconds);
  return `${parts.minutes}:${parts.seconds.toString().padStart(2, '0')}`;
}

/**
 * How long the fight took, at the precision the fight deserves.
 *
 * Under ten seconds — which is most of them — the tenth is the whole story:
 * "1.4s" and "9.0s" are different fights and "0:01" and "0:09" are not.
 */
export function formatDuration(seconds: number): string {
  const value = Math.max(0, finite(seconds));
  if (value < 10) return `${value.toFixed(1)}s`;
  if (value < 60) return `${Math.round(value)}s`;
  return formatClock(value);
}

/* -------------------------------------------------------------------------- */
/* Rank                                                                       */
/* -------------------------------------------------------------------------- */

/** `C-388`. The only rank string in the game. */
export function formatRank(heroClass: HeroClass, rank: number): string {
  return `${heroClass}-${Math.max(1, Math.round(finite(rank)))}`;
}

/**
 * A signed point movement.
 *
 * The sign is ALWAYS shown, including on zero: `+0.0` after two hundred
 * unwitnessed kills is the single most informative number the ranking system
 * produces, and dropping the sign would make it look like a missing value
 * rather than a verdict.
 */
export function formatPoints(delta: number): string {
  const value = finite(delta);
  const rounded = Math.abs(value) < 0.05 ? 0 : value;
  const sign = rounded < 0 ? '−' : '+';
  return `${sign}${Math.abs(rounded).toFixed(1)}`;
}

/** Seats moved on the ladder, phrased as the Association would. */
export function formatSeatDelta(seats: number): string {
  const value = Math.round(finite(seats));
  if (value === 0) return 'held';
  return value > 0 ? `up ${value}` : `down ${Math.abs(value)}`;
}

/**
 * Magnitude at or above which a seat movement is a CLASS SENTINEL.
 *
 * `HudStore.seatDelta` encodes a class change as ±1000 rather than as a seat
 * count, because the HUD does not know the class sizes and must not invent
 * them. Mirrored here rather than imported so the formatters stay a leaf
 * module; the two only have to agree on an order of magnitude.
 */
export const CLASS_MOVE_SEATS = 900;

/**
 * A seat movement, with the class sentinel decoded.
 *
 * Every display site must go through this rather than testing the sentinel
 * itself: the one-sided `seats > 900 ? 1 : seats` guard this replaces printed a
 * correct "up 1" on promotion and a fabricated "down 1000" on demotion, which
 * is the exact number `seatDelta` promises never to invent.
 */
export function formatSeatMove(seats: number): string {
  if (seats >= CLASS_MOVE_SEATS) return 'up a class';
  if (seats <= -CLASS_MOVE_SEATS) return 'down a class';
  return formatSeatDelta(seats);
}

/* -------------------------------------------------------------------------- */
/* World                                                                      */
/* -------------------------------------------------------------------------- */

/** Metres under a kilometre, kilometres above it. */
export function formatDistance(metres: number): string {
  const value = Math.max(0, finite(metres));
  if (value < 1000) return `${Math.round(value)} m`;
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} km`;
}

/** Sentence-case tier name for prose lines. */
export function formatTier(tier: ThreatTier): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

/** A plain count with its noun, pluralised. */
export function formatCount(count: number, singular: string, plural?: string): string {
  const n = Math.round(finite(count));
  return `${n} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
}

/* -------------------------------------------------------------------------- */
/* Percentages                                                                */
/* -------------------------------------------------------------------------- */

/** `0.153` -> `x0.15`. The boredom throttle, as the player experiences it. */
export function formatMultiplier(value: number): string {
  return `×${finite(value).toFixed(2)}`;
}

/** `0..1` -> `86%`. Never used for boredom — boredom is a mood, not a number. */
export function formatPercent(fraction: number): string {
  return `${Math.round(Math.max(0, Math.min(1, finite(fraction))) * 100)}%`;
}
