/**
 * HIERARCHICAL FRUSTUM CULLING — EQUIVALENCE AND SPEED
 *
 * Two claims are made about this culler and both are load-bearing:
 *
 *  1. It returns EXACTLY what a brute-force scan returns. A false positive
 *     wastes a draw call; a false negative makes a building vanish while the
 *     player is looking at it, which is unshippable. "Exactly" is checked as
 *     set equality over 10,000 instances and hundreds of camera poses, not as
 *     a spot check.
 *
 *  2. It is dramatically faster than that scan on the shipping camera.
 *
 * Claim 1 is a HARD assertion and must never be relaxed. Claim 2 is measured,
 * printed and — only when the machine looks quiet — gated at a deliberately
 * loose 5x. This suite runs on a small box shared with several other build
 * jobs, and a wall-clock ratio there swings by more than a factor of two; a
 * performance test that fails at random teaches everyone to ignore a red
 * suite, which costs more than the assertion is worth. The real figure is in
 * the log line either way.
 *
 * The brute-force reference is the same code path minus the tree: the same
 * stored float32 bounds, the same `Frustum.testPacked` predicate called the
 * same way, and a strictly sequential sweep — the best a linear culler can do
 * on this data. The hierarchy is allowed to optimise its NODE test freely,
 * because node testing is overhead the linear scan does not have; the per-item
 * predicate is shared verbatim, which is what makes the comparison a
 * measurement of the algorithm rather than of hand-tuning.
 */

import { describe, it, expect } from 'vitest';
import { Quadtree } from '../quadtree';
import { Frustum, ALL_PLANES, INSIDE, OUTSIDE, INTERSECTING, classifyCode } from '../frustum';
import { IndexList } from '../index-list';
import {
  randomBoxes,
  randomPoses,
  poseMatrix,
  sortedList,
  describeDifference,
  compare,
  machineIsContended,
  MOBILE_PORTRAIT_LENS,
  WIDE_LANDSCAPE_LENS,
  type ILens,
} from './fixtures';

const INSTANCE_COUNT = 10_000;

function buildTree(count = INSTANCE_COUNT): Quadtree {
  const tree = new Quadtree({ initialCapacity: count });
  for (const box of randomBoxes(count)) {
    tree.insert(box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ);
  }
  tree.pack();
  return tree;
}

describe('Frustum primitives', () => {
  it('classifies contained, straddling and outside boxes', () => {
    const frustum = new Frustum();
    const matrix = new Float64Array(16);
    poseMatrix(matrix, { x: 0, y: 2, z: 0, yaw: 0, pitch: 0 }, MOBILE_PORTRAIT_LENS);
    frustum.setFromViewProjection(matrix);

    // Straight ahead is -Z with yaw 0.
    const ahead = frustum.classifyBox(-1, 1, -50, 1, 3, -48, ALL_PLANES);
    expect(classifyCode(ahead)).toBe(INSIDE);

    const behind = frustum.classifyBox(-1, 1, 40, 1, 3, 42, ALL_PLANES);
    expect(classifyCode(behind)).toBe(OUTSIDE);

    // A box spanning from behind the camera to well in front must straddle.
    const straddling = frustum.classifyBox(-1, 1, -60, 1, 3, 60, ALL_PLANES);
    expect(classifyCode(straddling)).toBe(INTERSECTING);

    // Beyond the far plane.
    const tooFar = frustum.classifyBox(-1, 1, -400, 1, 3, -390, ALL_PLANES);
    expect(classifyCode(tooFar)).toBe(OUTSIDE);
  });

  it('agrees with containsPoint on the frustum interior', () => {
    const frustum = new Frustum();
    const matrix = new Float64Array(16);
    poseMatrix(matrix, { x: 100, y: 5, z: -200, yaw: 1.2, pitch: 0 }, MOBILE_PORTRAIT_LENS);
    frustum.setFromViewProjection(matrix);

    expect(frustum.containsPoint(100, 5, -200)).toBe(false); // at the apex, before near
    const forwardX = 100 - Math.sin(1.2) * 50;
    const forwardZ = -200 - Math.cos(1.2) * 50;
    expect(frustum.containsPoint(forwardX, 5, forwardZ)).toBe(true);
  });

  it('never reports INSIDE for a box that fails the per-item test', () => {
    // Cross-check the two predicates against each other over random boxes.
    const frustum = new Frustum();
    const matrix = new Float64Array(16);
    const boxes = randomBoxes(2000, 'classify-cross-check');
    for (const pose of randomPoses(20, 'classify-poses')) {
      poseMatrix(matrix, pose, WIDE_LANDSCAPE_LENS);
      frustum.setFromViewProjection(matrix);
      for (const b of boxes) {
        const code = classifyCode(
          frustum.classifyBox(b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ, ALL_PLANES)
        );
        const visible = frustum.testBox(b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ);
        if (code === INSIDE) expect(visible).toBe(true);
        if (code === OUTSIDE) expect(visible).toBe(false);
      }
    }
  });
});

describe('Hierarchical cull equals brute force', () => {
  const tree = buildTree();

  it(`indexes all ${INSTANCE_COUNT} instances`, () => {
    expect(tree.count).toBe(INSTANCE_COUNT);
    const info = tree.describe();
    expect(info.nodes).toBe(5461);
    // Nothing should have been dropped on the way down the tree.
    expect(info.itemsAtDepth.reduce((a, b) => a + b, 0)).toBe(INSTANCE_COUNT);
  });

  for (const lens of [MOBILE_PORTRAIT_LENS, WIDE_LANDSCAPE_LENS] as ILens[]) {
    it(`returns exactly the brute-force set over 250 poses (${lens.name})`, () => {
      const frustum = new Frustum();
      const matrix = new Float64Array(16);
      const fast = new IndexList(4096);
      const slow = new IndexList(4096);
      const poses = randomPoses(250, `equivalence-${lens.name}`);

      let totalVisible = 0;
      let posesWithContent = 0;

      for (const pose of poses) {
        poseMatrix(matrix, pose, lens);
        frustum.setFromViewProjection(matrix);

        tree.cullFrustum(frustum, fast);
        tree.bruteForceCull(frustum, slow);

        const actual = sortedList(fast);
        const expected = sortedList(slow);
        const difference = describeDifference(actual, expected);
        expect(
          difference,
          `pose (${pose.x.toFixed(1)}, ${pose.z.toFixed(1)}) yaw ${pose.yaw.toFixed(3)}: ${difference}`
        ).toBeUndefined();

        totalVisible += expected.length;
        if (expected.length > 0) posesWithContent++;
      }

      // Guard against a vacuous pass: the sweep must actually see geometry.
      expect(posesWithContent).toBeGreaterThan(240);
      expect(totalVisible / poses.length).toBeGreaterThan(20);
    });
  }

  it('stays exact after removals and a refit', () => {
    const mutable = new Quadtree({ initialCapacity: 4096 });
    const handles: number[] = [];
    for (const box of randomBoxes(4000, 'mutation')) {
      handles.push(mutable.insert(box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ));
    }
    // Remove every third instance, as a wave of destruction would.
    for (let i = 0; i < handles.length; i += 3) mutable.remove(handles[i]!);
    expect(mutable.count).toBe(4000 - Math.ceil(4000 / 3));

    const frustum = new Frustum();
    const matrix = new Float64Array(16);
    const fast = new IndexList();
    const slow = new IndexList();
    for (const pose of randomPoses(60, 'mutation-poses')) {
      poseMatrix(matrix, pose, WIDE_LANDSCAPE_LENS);
      frustum.setFromViewProjection(matrix);
      mutable.cullFrustum(frustum, fast);
      mutable.bruteForceCull(frustum, slow);
      expect(describeDifference(sortedList(fast), sortedList(slow))).toBeUndefined();
    }

    // Re-inserting into freed slots must not corrupt the packed layout.
    for (const box of randomBoxes(500, 'reinsert')) {
      mutable.insert(box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ);
    }
    for (const pose of randomPoses(40, 'reinsert-poses')) {
      poseMatrix(matrix, pose, WIDE_LANDSCAPE_LENS);
      frustum.setFromViewProjection(matrix);
      mutable.cullFrustum(frustum, fast);
      mutable.bruteForceCull(frustum, slow);
      expect(describeDifference(sortedList(fast), sortedList(slow))).toBeUndefined();
    }
  });
});

describe('Hierarchical cull speed', () => {
  const tree = buildTree();
  const POSES = 200;
  /**
   * Loose enough to survive a busy box. Measured on a quiet one the shipping
   * lens reaches 22-25x; the assertion exists to catch an accidental
   * order-of-magnitude regression, not to police the last factor of two.
   */
  const MIN_SPEEDUP = 5;
  const load = machineIsContended();

  function measure(lens: ILens): {
    fastMs: number;
    slowMs: number;
    speedup: number;
    meanVisible: number;
    meanNodes: number;
  } {
    const frustum = new Frustum();
    const matrix = new Float64Array(16);
    const out = new IndexList(4096);
    const poses = randomPoses(POSES, `bench-${lens.name}`);
    const matrices = poses.map((pose) => poseMatrix(new Float64Array(16), pose, lens));

    let visible = 0;
    let nodes = 0;
    const stats = {
      nodesVisited: 0,
      nodesRejected: 0,
      nodesAccepted: 0,
      chunksRejectedByPvs: 0,
      itemsTested: 0,
      itemsVisible: 0,
    };
    for (const m of matrices) {
      frustum.setFromViewProjection(m);
      tree.cullFrustum(frustum, out, stats);
      visible += out.length;
      nodes += stats.nodesVisited;
    }

    const timing = compare(
      () => {
        for (const m of matrices) {
          frustum.setFromViewProjection(m);
          tree.cullFrustum(frustum, out);
        }
      },
      () => {
        for (const m of matrices) {
          frustum.setFromViewProjection(m);
          tree.bruteForceCull(frustum, out);
        }
      }
    );

    void matrix;
    return {
      fastMs: timing.aMs,
      slowMs: timing.bMs,
      speedup: timing.ratio,
      meanVisible: visible / POSES,
      meanNodes: nodes / POSES,
    };
  }

  function report(lens: ILens, result: ReturnType<typeof measure>): void {
    console.log(
      `[cull ${lens.name}] ` +
        `hierarchical ${(result.fastMs / POSES * 1000).toFixed(2)} us/cull, ` +
        `brute ${(result.slowMs / POSES * 1000).toFixed(2)} us/cull, ` +
        `SPEEDUP ${result.speedup.toFixed(1)}x` +
        `${load.contended ? ' (machine contended — informational only)' : ''}, ` +
        `mean visible ${result.meanVisible.toFixed(1)} / ${INSTANCE_COUNT}, ` +
        `mean nodes ${result.meanNodes.toFixed(1)}, ` +
        `load spread ${load.spread.toFixed(2)}`
    );
  }

  it(`beats brute force on the shipping lens (${MOBILE_PORTRAIT_LENS.name})`, () => {
    const result = measure(MOBILE_PORTRAIT_LENS);
    report(MOBILE_PORTRAIT_LENS, result);

    // Always true regardless of load: the hierarchy must never LOSE.
    expect(result.speedup).toBeGreaterThan(1);
    if (!load.contended) expect(result.speedup).toBeGreaterThanOrEqual(MIN_SPEEDUP);
  });

  it(`still beats brute force on a hostile lens (${WIDE_LANDSCAPE_LENS.name})`, () => {
    const result = measure(WIDE_LANDSCAPE_LENS);
    report(WIDE_LANDSCAPE_LENS, result);

    // A 500 m frustum over a 1536 m world keeps a tenth of the instances, so
    // there is far less for the tree to reject and the ceiling is lower.
    expect(result.speedup).toBeGreaterThan(1);
    if (!load.contended) expect(result.speedup).toBeGreaterThanOrEqual(MIN_SPEEDUP);
  });

  it('does not grow its output buffer once warm', () => {
    const frustum = new Frustum();
    const matrix = new Float64Array(16);
    const out = new IndexList(16);
    const poses = randomPoses(120, 'alloc-poses');

    for (const pose of poses) {
      poseMatrix(matrix, pose, WIDE_LANDSCAPE_LENS);
      frustum.setFromViewProjection(matrix);
      tree.cullFrustum(frustum, out);
    }
    const warmCapacity = out.capacity;

    for (const pose of poses) {
      poseMatrix(matrix, pose, WIDE_LANDSCAPE_LENS);
      frustum.setFromViewProjection(matrix);
      tree.cullFrustum(frustum, out);
    }
    expect(out.capacity).toBe(warmCapacity);
  });
});
