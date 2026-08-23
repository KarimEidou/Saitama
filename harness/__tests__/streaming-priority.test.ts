/**
 * ARRIVAL-ORDER PRIORITY ANALYSIS
 *
 * `analyseArrivalOrder` is the sole source of four assertions in
 * `harness/streaming.verify.ts` — "load order ignored the view direction",
 * "only N distance bands had chunks on both sides", "N band(s) loaded what was
 * behind the camera first" and "only N% of the first 20 arrivals were in front
 * of the camera". The driver only ever sees the aggregate this function itself
 * produced, so a sign flip in the forward dot or an off-by-one in the Chebyshev
 * band would invert what all four MEAN while leaving every one of them green.
 *
 * These cases pin the three unobvious constants (the `CHUNK_SIZE * 2`
 * near-field exclusion, the `|dot| > 0.6` cone, the `ahead >= 2 && behind >= 2`
 * comparability filter) and both sign conventions, by feeding hand-built
 * arrival orders whose answer is known by construction.
 *
 * GEOMETRY. The camera sits at the centre of chunk (0,0) — `{ x: 48, z: 48 }`,
 * which is where `boot()` puts it in `harness/streaming.ts` — facing
 * `{ x: 0, z: -1 }`. With `CHUNK_SIZE = 96` and `chunkCentre* = coord * 96 + 48`
 * that origin makes the deltas exact multiples of the chunk size
 * (`dz = 96 * cz`), so band membership is unambiguous: NEGATIVE cz is ahead.
 */

import { describe, it, expect } from 'vitest';
import { CHUNK_SIZE, chunkIndex } from '@/spatial/constants';
import { analyseArrivalOrder } from '../streaming-priority';

/** Centre of chunk (0,0) — the cold-start camera position `boot()` uses. */
const ORIGIN = { x: 48, z: 48 } as const;
/** Flattened, normalised camera forward: down-Z, so negative cz is "ahead". */
const FORWARD = { x: 0, z: -1 } as const;

const at = (cx: number, cz: number): number => chunkIndex(cx, cz);

/** Three chunks abreast, at whole-chunk band `cz`. */
const row = (cz: number): number[] => [at(0, cz), at(1, cz), at(-1, cz)];

/** Bands 3 and 4 in front of the camera, then the same two behind it. */
const AHEAD_FIRST = [...row(-3), ...row(-4), ...row(3), ...row(4)];
/** The same twelve chunks with the behind-camera half arriving first. */
const BEHIND_FIRST = [...row(3), ...row(4), ...row(-3), ...row(-4)];

describe('analyseArrivalOrder', () => {
  it('reads a front-first arrival order as ordered, in every band', () => {
    const report = analyseArrivalOrder(AHEAD_FIRST, ORIGIN, FORWARD);

    expect(report.sampled).toBe(12);
    // Bands 3 and 4, three chunks a side: both clear the >= 2 filter.
    expect(report.bands.map((band) => band.distanceChunks)).toEqual([3, 4]);
    expect(report.bandsComparable).toBe(2);
    expect(report.bandsOrderedByMean).toBe(2);
    expect(report.bandsStrictlySeparated).toBe(2);
    expect(report.strictlyOrdered).toBe(true);
    // Ranks 0-5 ahead, 6-11 behind.
    expect(report.aheadMeanRank).toBe(2.5);
    expect(report.behindMeanRank).toBe(8.5);
    expect(report.aheadWorstRank).toBe(5);
    expect(report.behindBestRank).toBe(6);
  });

  it('reads a back-first arrival order as unordered, in every band', () => {
    const report = analyseArrivalOrder(BEHIND_FIRST, ORIGIN, FORWARD);

    expect(report.sampled).toBe(12);
    expect(report.bandsComparable).toBe(2);
    expect(report.bandsOrderedByMean).toBe(0);
    expect(report.bandsStrictlySeparated).toBe(0);
    expect(report.strictlyOrdered).toBe(false);
    // Only twelve chunks are classified, so the "first twenty" window is the
    // whole sample and its fraction is order-independent at 6/12. The window
    // discriminates only once more than twenty arrivals are classified — see
    // the wide-fan case below.
    expect(report.firstTwentyAheadFraction).toBe(0.5);
    expect(analyseArrivalOrder(AHEAD_FIRST, ORIGIN, FORWARD).firstTwentyAheadFraction).toBe(0.5);
  });

  it('measures the first-twenty window as a genuine prefix when the fan is wide enough', () => {
    // Five columns x five bands a side = 25 classified arrivals per side, so
    // the twenty-arrival window is a strict prefix of the arrival order.
    const wideRow = (cz: number): number[] => [-2, -1, 0, 1, 2].map((cx) => at(cx, cz));
    const front = [-3, -4, -5, -6, -7].flatMap(wideRow);
    const back = [3, 4, 5, 6, 7].flatMap(wideRow);

    expect(analyseArrivalOrder([...front, ...back], ORIGIN, FORWARD)).toMatchObject({
      sampled: 50,
      firstTwentyAheadFraction: 1,
    });
    expect(analyseArrivalOrder([...back, ...front], ORIGIN, FORWARD)).toMatchObject({
      sampled: 50,
      firstTwentyAheadFraction: 0,
    });
  });

  it('excludes the near field, where a chunk centre has no meaningful direction', () => {
    // Chunk (0,-1) is dead ahead but only 96 m out — inside `CHUNK_SIZE * 2`.
    const nearField = at(0, -1);
    expect(CHUNK_SIZE * 2).toBe(192);

    const report = analyseArrivalOrder([nearField, ...AHEAD_FIRST], ORIGIN, FORWARD);
    expect(report.sampled).toBe(12);
    expect(report.bandsComparable).toBe(2);
  });

  it('excludes chunks outside the +/- 0.6 cone', () => {
    // Chunk (3,0) is 288 m away — well past the near field — but exactly
    // perpendicular to the view direction, so `dot === 0`: neither side.
    const report = analyseArrivalOrder([at(3, 0), ...AHEAD_FIRST], ORIGIN, FORWARD);
    expect(report.sampled).toBe(12);
    expect(report.bands.map((band) => band.distanceChunks)).toEqual([3, 4]);
  });

  it('returns finite zeroes for an empty arrival order', () => {
    const report = analyseArrivalOrder([], ORIGIN, FORWARD);

    expect(report.sampled).toBe(0);
    expect(report.bands).toHaveLength(0);
    expect(report.bandsComparable).toBe(0);
    expect(report.bandsOrderedByMean).toBe(0);
    expect(report.bandsStrictlySeparated).toBe(0);
    expect(report.firstTwentyAheadFraction).toBe(0);
    expect(report.strictlyOrdered).toBe(false);
    // The `Math.max(...[])` / `Math.min(...[])` paths must stay guarded.
    for (const value of [
      report.aheadMeanRank,
      report.behindMeanRank,
      report.aheadWorstRank,
      report.behindBestRank,
    ]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBe(0);
    }
  });
});
