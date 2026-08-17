/**
 * THE HERO ASSOCIATION LADDER
 *
 * 546 seats in one ordered list: C-390 at the bottom through S-1 at the top.
 * Everything here is a pure function of a point total, which is what makes the
 * player and every rival comparable, saves exact, and the whole thing testable
 * without a game running.
 *
 * ── WHY ONE FLAT INDEX ─────────────────────────────────────────────────────
 * `IHeroRank` presents class and rank separately, and rank counts DOWN (rank 1
 * is the top). Doing arithmetic in that space means special-casing every class
 * boundary, in both directions, in promotion and in demotion. Instead there is
 * one ascending index, and class/rank are derived at the edges. Promotion
 * across a class boundary is then just "index went up by one".
 *
 * ── SPENDING vs. STANDING ──────────────────────────────────────────────────
 * Points are a STANDING, not a currency: they are never spent, and the rank is
 * always recomputed from the total. So a demotion is a real fall — losing
 * points can drop a hero back through a class boundary — and there is no way
 * for the ladder and the points to disagree.
 */

import type { HeroClass, IHeroRank } from '@/types';
import { clamp } from '@/util';
import {
  CLASS_ORDER,
  CLASS_PROMOTION_COST,
  CLASS_SIZES,
  CLASS_STEP_COST,
  START_HERO_CLASS,
  START_HERO_NAME,
  START_HERO_RANK,
} from './constants';

/** Total seats on the ladder. */
export const LADDER_SIZE = CLASS_ORDER.reduce((sum, c) => sum + CLASS_SIZES[c], 0);

/**
 * Cumulative points required to occupy each index, index 0 first.
 *
 * Built once at module load — 546 entries — so every lookup afterwards is a
 * binary search over a flat array rather than a loop of pow() calls.
 */
const THRESHOLDS: readonly number[] = buildThresholds();

function buildThresholds(): number[] {
  const out: number[] = [0];
  let total = 0;
  for (let index = 1; index < LADDER_SIZE; index++) {
    // The step INTO `index` is priced by the class the hero is leaving.
    const from = classForIndex(index - 1);
    const to = classForIndex(index);
    total += CLASS_STEP_COST[from];
    if (from !== to) total += CLASS_PROMOTION_COST[from];
    out.push(total);
  }
  return out;
}

/** Ladder index -> class. Index 0 is the bottom of C-class. */
export function classForIndex(index: number): HeroClass {
  let remaining = clamp(Math.floor(index), 0, LADDER_SIZE - 1);
  for (const heroClass of CLASS_ORDER) {
    if (remaining < CLASS_SIZES[heroClass]) return heroClass;
    remaining -= CLASS_SIZES[heroClass];
  }
  return 'S';
}

/** Ladder index -> rank within the class, counting DOWN from the class size. */
export function rankForIndex(index: number): number {
  let remaining = clamp(Math.floor(index), 0, LADDER_SIZE - 1);
  for (const heroClass of CLASS_ORDER) {
    const size = CLASS_SIZES[heroClass];
    if (remaining < size) return size - remaining;
    remaining -= size;
  }
  return 1;
}

/** Class + rank -> ladder index. The inverse of the two functions above. */
export function indexForRank(heroClass: HeroClass, rank: number): number {
  let base = 0;
  for (const candidate of CLASS_ORDER) {
    if (candidate === heroClass) {
      const size = CLASS_SIZES[heroClass];
      return base + (size - clamp(Math.round(rank), 1, size));
    }
    base += CLASS_SIZES[candidate];
  }
  return 0;
}

/** Cumulative points needed to hold a ladder index. */
export function pointsForIndex(index: number): number {
  return THRESHOLDS[clamp(Math.floor(index), 0, LADDER_SIZE - 1)]!;
}

/**
 * Ladder index a point total buys.
 *
 * Binary search rather than a linear scan: this is called on every award, and
 * every rival's award, and once per frame by the HUD.
 */
export function indexForPoints(points: number): number {
  // NaN compares false against everything and would silently walk the binary
  // search into an arbitrary seat; +Infinity legitimately means "the top".
  if (Number.isNaN(points) || points <= 0) return 0;
  let low = 0;
  let high = LADDER_SIZE - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (THRESHOLDS[mid]! <= points) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** Points the player starts with: exactly enough to hold C-388. */
export const START_POINTS = pointsForIndex(indexForRank(START_HERO_CLASS, START_HERO_RANK));

/** Build the full `IHeroRank` view of a point total. */
export function rankFromPoints(points: number, heroName: string = START_HERO_NAME): IHeroRank {
  const clamped = Math.max(0, points);
  const index = indexForPoints(clamped);
  const nextIndex = Math.min(LADDER_SIZE - 1, index + 1);
  return {
    heroClass: classForIndex(index),
    rank: rankForIndex(index),
    points: clamped,
    // At the very top there is no next rank; report 0 rather than a negative.
    pointsToNextRank: index >= LADDER_SIZE - 1 ? 0 : Math.max(0, pointsForIndex(nextIndex) - clamped),
    heroName,
  };
}

/**
 * Compare two standings. Positive when `a` outranks `b`.
 *
 * Exists because `IHeroRank.rank` counts DOWN and is only meaningful inside a
 * class: sorting a mixed list by `rank` ascending puts S-1 and C-1 next to
 * each other, and every naive leaderboard gets this wrong once.
 */
export function compareRank(a: IHeroRank, b: IHeroRank): number {
  const ai = indexForRank(a.heroClass, a.rank);
  const bi = indexForRank(b.heroClass, b.rank);
  return ai - bi;
}

/** Seats between two standings; positive when `a` is above `b`. */
export function rankGap(a: IHeroRank, b: IHeroRank): number {
  return indexForRank(a.heroClass, a.rank) - indexForRank(b.heroClass, b.rank);
}

/** Human-readable standing, e.g. "C-Class Rank 388". */
export function formatRank(rank: IHeroRank): string {
  return `${rank.heroClass}-Class Rank ${rank.rank}`;
}
