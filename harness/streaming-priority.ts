/**
 * ARRIVAL-ORDER PRIORITY ANALYSIS
 *
 * The maths behind the streaming harness's four "did the city load in front of
 * the camera?" assertions, extracted from `harness/streaming.ts` so it can be
 * unit-tested. It depends only on `@/spatial/constants`, which is pure, so it
 * imports nothing that touches `document` and runs under Vitest unchanged.
 */

import { CHUNK_SIZE, chunkCentreX, chunkCentreZ } from '@/spatial/constants';

/** Ahead-vs-behind arrival comparison for one band of equal distance. */
export interface IPriorityBand {
  /** Chebyshev distance from the cold-start camera, in whole chunks. */
  readonly distanceChunks: number;
  readonly ahead: number;
  readonly behind: number;
  readonly aheadMeanRank: number;
  readonly behindMeanRank: number;
  /** Every chunk ahead arrived before every chunk behind, within this band. */
  readonly strictlySeparated: boolean;
}

export interface IPriorityReport {
  readonly sampled: number;
  readonly aheadMeanRank: number;
  readonly behindMeanRank: number;
  readonly aheadWorstRank: number;
  readonly behindBestRank: number;
  /** Across the whole sample. Expected FALSE — see the note on `analyseArrivalOrder`. */
  readonly strictlyOrdered: boolean;
  readonly bands: readonly IPriorityBand[];
  /** Bands with enough chunks on both sides to compare. */
  readonly bandsComparable: number;
  /** Comparable bands where the mean arrival rank ahead beat the mean behind. */
  readonly bandsOrderedByMean: number;
  /** Comparable bands where the separation was total. */
  readonly bandsStrictlySeparated: number;
  /** Of the first 20 direction-classified arrivals, the fraction facing the camera. */
  readonly firstTwentyAheadFraction: number;
}

/**
 * Did the city assemble in front of the camera?
 *
 * Fed the COLD-START arrival order recorded from boot, when nothing was
 * resident and every chunk in range had to be built, so the order chunks
 * arrived in is the scheduler's own answer rather than a consequence of where
 * the camera happened to fly.
 *
 * ── THE COMPARISON HAS TO BE MADE AT EQUAL DISTANCE ────────────────────────
 * Comparing every chunk ahead against every chunk behind is the obvious test
 * and it is the WRONG one, because it contradicts a deliberate design
 * decision: ring membership is absolute, so a chunk one ring behind the camera
 * is supposed to outrank a chunk six rings ahead of it. Detail near the player
 * is never traded for coverage far from them. A whole-sample strict test
 * therefore fails on a system that is behaving exactly as designed — which is
 * precisely what an earlier revision of this harness reported.
 *
 * So chunks are bucketed by whole-chunk distance first, and ahead is compared
 * against behind WITHIN each band, where ring and distance are held roughly
 * constant and the view direction is the only variable left. That is the real
 * claim: all else equal, what you are looking at loads first.
 *
 * @param arrivalOrder Dense chunk indices in the order they became resident.
 * @param start        Camera position at cold start (only `x`/`z` are read).
 * @param direction    Camera forward, flattened and normalised (`x`/`z`).
 */
export function analyseArrivalOrder(
  arrivalOrder: readonly number[],
  start: { readonly x: number; readonly z: number },
  direction: { readonly x: number; readonly z: number }
): IPriorityReport {
  const rank = new Map<number, number>();
  arrivalOrder.forEach((index, at) => rank.set(index, at));

  const ahead: number[] = [];
  const behind: number[] = [];
  const byBand = new Map<number, { ahead: number[]; behind: number[] }>();
  const classified: { rank: number; ahead: boolean }[] = [];

  for (const [index, at] of rank) {
    const dx = chunkCentreX(index) - start.x;
    const dz = chunkCentreZ(index) - start.z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    // Inside two chunks there is no meaningful "direction" to a chunk centre,
    // and those chunks are all R0 anyway.
    if (distance < CHUNK_SIZE * 2) continue;
    const dot = (dx * direction.x + dz * direction.z) / distance;
    const isAhead = dot > 0.6;
    const isBehind = dot < -0.6;
    if (!isAhead && !isBehind) continue;

    const band = Math.round(Math.max(Math.abs(dx), Math.abs(dz)) / CHUNK_SIZE);
    let bucket = byBand.get(band);
    if (bucket === undefined) {
      bucket = { ahead: [], behind: [] };
      byBand.set(band, bucket);
    }
    (isAhead ? bucket.ahead : bucket.behind).push(at);
    (isAhead ? ahead : behind).push(at);
    classified.push({ rank: at, ahead: isAhead });
  }

  const mean = (values: number[]): number =>
    values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

  const bands: IPriorityBand[] = [...byBand.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([distanceChunks, bucket]) => ({
      distanceChunks,
      ahead: bucket.ahead.length,
      behind: bucket.behind.length,
      aheadMeanRank: mean(bucket.ahead),
      behindMeanRank: mean(bucket.behind),
      strictlySeparated:
        bucket.ahead.length > 0 &&
        bucket.behind.length > 0 &&
        Math.max(...bucket.ahead) < Math.min(...bucket.behind),
    }));

  const comparable = bands.filter((band) => band.ahead >= 2 && band.behind >= 2);
  classified.sort((a, b) => a.rank - b.rank);
  const firstTwenty = classified.slice(0, 20);

  return {
    sampled: ahead.length + behind.length,
    aheadMeanRank: mean(ahead),
    behindMeanRank: mean(behind),
    aheadWorstRank: ahead.length === 0 ? 0 : Math.max(...ahead),
    behindBestRank: behind.length === 0 ? 0 : Math.min(...behind),
    strictlyOrdered:
      ahead.length > 0 && behind.length > 0 && Math.max(...ahead) < Math.min(...behind),
    bands,
    bandsComparable: comparable.length,
    bandsOrderedByMean: comparable.filter((b) => b.aheadMeanRank < b.behindMeanRank).length,
    bandsStrictlySeparated: comparable.filter((b) => b.strictlySeparated).length,
    firstTwentyAheadFraction:
      firstTwenty.length === 0
        ? 0
        : firstTwenty.filter((entry) => entry.ahead).length / firstTwenty.length,
  };
}
