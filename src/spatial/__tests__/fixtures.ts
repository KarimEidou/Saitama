/**
 * SHARED TEST FIXTURES
 *
 * Seeded generators and comparison helpers used by more than one spec. Not a
 * spec itself — vitest only picks up `*.test.ts`.
 */

import { createRng, type IRandom } from '@/util';
import { WORLD_MIN, WORLD_SIZE } from '../constants';
import { composeViewProjection } from '../frustum';
import type { IndexList } from '../index-list';

/** One random static instance. */
export interface IRandomBox {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

/**
 * `count` random AABBs scattered over the world.
 *
 * Sizes span 1.5-24 m footprints and 3-60 m heights — the range City Z's
 * instances actually occupy, from a bollard to a mid-rise — so the tree's
 * item-placement distribution is representative rather than uniform.
 */
export function randomBoxes(count: number, seed: number | string = 'spatial-boxes'): IRandomBox[] {
  const rng: IRandom = createRng(seed);
  const boxes: IRandomBox[] = [];
  for (let i = 0; i < count; i++) {
    const cx = WORLD_MIN + rng.next() * WORLD_SIZE;
    const cz = WORLD_MIN + rng.next() * WORLD_SIZE;
    const halfX = rng.range(0.75, 12);
    const halfZ = rng.range(0.75, 12);
    const base = rng.range(0, 4);
    const height = rng.range(3, 60);
    boxes.push({
      minX: cx - halfX,
      minY: base,
      minZ: cz - halfZ,
      maxX: cx + halfX,
      maxY: base + height,
      maxZ: cz + halfZ,
    });
  }
  return boxes;
}

/** A camera pose for the culling benchmarks. */
export interface IPose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
}

/** Seeded street-level camera poses spread over the whole world. */
export function randomPoses(count: number, seed: number | string = 'spatial-poses'): IPose[] {
  const rng = createRng(seed);
  const poses: IPose[] = [];
  for (let i = 0; i < count; i++) {
    poses.push({
      x: WORLD_MIN + rng.next() * WORLD_SIZE,
      y: rng.range(1.6, 12),
      z: WORLD_MIN + rng.next() * WORLD_SIZE,
      yaw: rng.range(0, Math.PI * 2),
      pitch: rng.range(-0.35, 0.2),
    });
  }
  return poses;
}

/** Camera intrinsics for a benchmark sweep. */
export interface ILens {
  readonly name: string;
  readonly fovDegrees: number;
  readonly aspect: number;
  readonly near: number;
  readonly far: number;
}

/** The shipping configuration: portrait phone, mobile draw distance. */
export const MOBILE_PORTRAIT_LENS: ILens = {
  name: 'mobile portrait 9:16, 300 m',
  fovDegrees: 60,
  aspect: 900 / 1600,
  near: 0.3,
  far: 300,
};

/** A deliberately hostile lens: wide landscape, long draw distance. */
export const WIDE_LANDSCAPE_LENS: ILens = {
  name: 'landscape 16:9, 500 m',
  fovDegrees: 70,
  aspect: 16 / 9,
  near: 0.3,
  far: 500,
};

/** Fill `out` with the view-projection matrix for a pose and lens. */
export function poseMatrix(out: Float64Array, pose: IPose, lens: ILens): Float64Array {
  return composeViewProjection(
    out,
    pose.x,
    pose.y,
    pose.z,
    pose.yaw,
    pose.pitch,
    (lens.fovDegrees * Math.PI) / 180,
    lens.aspect,
    lens.near,
    lens.far
  );
}

/** Sorted copy of a result list, for order-insensitive set comparison. */
export function sortedList(list: IndexList): number[] {
  const out = list.toArray();
  out.sort((a, b) => a - b);
  return out;
}

/**
 * Compare two result sets and describe the first divergence.
 * Returns `undefined` when they are identical.
 */
export function describeDifference(
  actual: readonly number[],
  expected: readonly number[]
): string | undefined {
  if (actual.length === expected.length) {
    for (let i = 0; i < actual.length; i++) {
      if (actual[i] !== expected[i]) {
        return `diverges at index ${i}: got ${actual[i]}, expected ${expected[i]}`;
      }
    }
    return undefined;
  }
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((v) => !actualSet.has(v));
  const extra = actual.filter((v) => !expectedSet.has(v));
  return (
    `size ${actual.length} vs ${expected.length}; ` +
    `${missing.length} false negatives (first: ${missing[0] ?? 'none'}), ` +
    `${extra.length} false positives (first: ${extra[0] ?? 'none'})`
  );
}

/** Median of a numeric sample. */
export function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Time `fn` over `rounds` timed runs after `warmup` untimed ones, returning
 * the FASTEST round in milliseconds.
 *
 * Best-of, not mean: on a shared box the noise is one-sided — a round can be
 * slowed by a neighbouring process but never sped up — so the minimum is the
 * most stable estimate of the code's actual cost.
 */
export function benchmark(fn: () => void, rounds = 7, warmup = 3): number {
  for (let i = 0; i < warmup; i++) fn();
  let best = Infinity;
  for (let i = 0; i < rounds; i++) {
    const started = performance.now();
    fn();
    const elapsed = performance.now() - started;
    if (elapsed < best) best = elapsed;
  }
  return best;
}

/** Result of an A/B timing comparison. */
export interface IComparison {
  /** Fastest round of `a`, in milliseconds. */
  readonly aMs: number;
  /** Fastest round of `b`, in milliseconds. */
  readonly bMs: number;
  /** Median of the PER-ROUND ratios — the robust estimate. */
  readonly ratio: number;
  /** Slowest per-round ratio observed, i.e. the worst case for `a`. */
  readonly worstRatio: number;
}

/**
 * Compare two implementations by interleaving their timed rounds and taking
 * the MEDIAN OF THE PER-ROUND RATIOS.
 *
 * Both details matter on this box, which is shared with other build jobs and
 * whose effective clock drifts by 50% over a few hundred milliseconds. Timing
 * all of A and then all of B lets that drift land entirely on one side; taking
 * `min(a) / min(b)` across separately-timed blocks does the same. Measuring
 * `tb / ta` from two adjacent runs cancels the drift almost exactly, and the
 * median over rounds then discards the occasional round that was interrupted.
 *
 * Rounds are kept small for the same reason: the finer the interleaving, the
 * less clock drift can accumulate inside one measurement.
 */
export function compare(a: () => void, b: () => void, rounds = 15, warmup = 4): IComparison {
  for (let i = 0; i < warmup; i++) {
    a();
    b();
  }
  const ratios: number[] = [];
  let bestA = Infinity;
  let bestB = Infinity;
  for (let i = 0; i < rounds; i++) {
    let t = performance.now();
    a();
    const ta = performance.now() - t;
    t = performance.now();
    b();
    const tb = performance.now() - t;
    if (ta > 0) ratios.push(tb / ta);
    if (ta < bestA) bestA = ta;
    if (tb < bestB) bestB = tb;
  }
  const sorted = ratios.slice().sort((x, y) => x - y);
  return {
    aMs: bestA,
    bMs: bestB,
    ratio: median(ratios),
    worstRatio: sorted[0] ?? 0,
  };
}

/**
 * Rough check for whether this machine is currently contended.
 *
 * The test suite runs on a small shared box alongside other build jobs, some
 * of them driving software GL. Under that load wall-clock ratios swing by more
 * than a factor of two, which makes a hard speedup assertion a coin flip — and
 * a flaky performance test is worse than none, because everyone downstream
 * learns to ignore a red suite.
 *
 * So the speedup is always MEASURED and always REPORTED, and only gated when
 * the machine looks quiet. Quiet is defined empirically: run a fixed
 * arithmetic loop repeatedly and compare its median to its best. On an idle
 * core those agree closely; when other processes are competing for the core,
 * the median drifts well above the minimum.
 */
export function machineIsContended(threshold = 1.35): { contended: boolean; spread: number } {
  const samples: number[] = [];
  for (let round = 0; round < 12; round++) {
    const started = performance.now();
    let acc = 0;
    for (let i = 1; i < 400_000; i++) acc += Math.sqrt(i) / i;
    samples.push(performance.now() - started);
    if (acc === Number.POSITIVE_INFINITY) throw new Error('unreachable');
  }
  const best = Math.min(...samples);
  const mid = median(samples);
  const spread = best > 0 ? mid / best : 1;
  return { contended: spread > threshold, spread };
}
