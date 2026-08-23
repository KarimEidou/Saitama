/**
 * QUADTREE — PLACEMENT, MUTATION, RANGE QUERIES AND RAYCASTS
 *
 * Every accelerated query is checked against the linear scan that defines it.
 * The two share their predicate (`packedIntersectsBox`, `packedDistanceSq2D`,
 * `packedRayEntry`) and read the same stored float32 bounds, so any divergence
 * is a bug in the traversal, which is exactly what these tests are for.
 */

import { describe, it, expect } from 'vitest';
import {
  Quadtree,
  createCullStats,
  type IQuadtreeOptions,
  type IQuadtreeRayHit,
} from '../quadtree';
import { Frustum } from '../frustum';
import { IndexList, FloatList } from '../index-list';
import {
  QUADTREE_DEPTH,
  QUADTREE_LEAF_SIZE,
  QUADTREE_NODE_COUNT,
  QUADTREE_CHUNK_DEPTH,
  WORLD_MIN,
  WORLD_SIZE,
  CHUNK_SIZE,
  CHUNK_COUNT,
  chunkIndex,
} from '../constants';
import { createRng } from '@/util';
import {
  randomBoxes,
  randomPoses,
  poseMatrix,
  sortedList,
  describeDifference,
  WIDE_LANDSCAPE_LENS,
} from './fixtures';

function buildTree(count: number, seed = 'quadtree'): Quadtree {
  const tree = new Quadtree({ initialCapacity: count });
  for (const box of randomBoxes(count, seed)) {
    tree.insert(box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ);
  }
  tree.pack();
  return tree;
}

describe('Quadtree geometry', () => {
  it('matches the City Z dimensions exactly', () => {
    const tree = new Quadtree();
    expect(tree.size).toBe(WORLD_SIZE);
    expect(tree.size).toBe(1536);
    expect(tree.depth).toBe(QUADTREE_DEPTH);
    expect(QUADTREE_LEAF_SIZE).toBe(24);
    expect(tree.nodeCount).toBe(QUADTREE_NODE_COUNT);
    expect(tree.nodeCount).toBe(5461);
    expect(tree.originX).toBe(WORLD_MIN);
    expect(tree.canonical).toBe(true);
  });

  it('maps depth-4 nodes onto the 96 m streaming chunks', () => {
    const tree = new Quadtree();
    const cell = new Float64Array(3);
    expect(tree.levelEnd(QUADTREE_CHUNK_DEPTH) - tree.levelStart(QUADTREE_CHUNK_DEPTH)).toBe(
      CHUNK_COUNT
    );

    for (const [cx, cz] of [
      [-8, -8],
      [0, 0],
      [7, 7],
      [3, -5],
    ] as const) {
      const index = chunkIndex(cx, cz);
      const node = tree.chunkNode(index);
      expect(node).toBeGreaterThanOrEqual(0);
      expect(tree.getNodeDepth(node)).toBe(QUADTREE_CHUNK_DEPTH);
      tree.getNodeCell(node, cell);
      expect(cell[2]).toBe(CHUNK_SIZE);
      expect(cell[0]).toBe(cx * CHUNK_SIZE);
      expect(cell[1]).toBe(cz * CHUNK_SIZE);
    }
  });

  it('places instances at the deepest loose cell that fits them', () => {
    const tree = buildTree(10_000);
    const info = tree.describe();
    // Loose placement means a 24 m footprint still reaches a 24 m leaf, so
    // nothing should be stranded high in the tree where it would be re-tested
    // on every cull regardless of camera direction.
    expect(info.itemsAtDepth[0]).toBe(0);
    expect(info.itemsAtDepth[1]).toBe(0);
    expect(info.itemsAtDepth[2]).toBe(0);
    expect(info.itemsAtDepth[QUADTREE_DEPTH]).toBeGreaterThan(9000);
  });

  it('keeps instances outside the world queryable', () => {
    const tree = new Quadtree();
    const handle = tree.insert(5000, 0, 5000, 5010, 10, 5010, 'far-away');
    const out = new IndexList();
    tree.queryBox(4990, -10, 4990, 5020, 20, 5020, out);
    expect(out.toArray()).toEqual([handle]);
    expect(tree.getChunk(handle)).toBe(-1);
  });

  it('indexes the deepest level of a deeper-than-default tree', () => {
    // The root-to-node path scratch used to be sized from the module constant
    // rather than from the instance depth, so in a tree deeper than 7 the last
    // level fell off the end of the path: its subtree counts stayed 0, `pack`
    // skipped it and every query short-circuited past items the tree still
    // counted as present.
    const tree = new Quadtree({ depth: 8, initialCapacity: 512 });
    const rng = createRng('deep-quadtree');
    const handles: number[] = [];
    for (let i = 0; i < 200; i++) {
      const x = rng.range(WORLD_MIN + 20, -WORLD_MIN - 20);
      const z = rng.range(WORLD_MIN + 20, -WORLD_MIN - 20);
      handles.push(tree.insert(x - 0.5, 0, z - 0.5, x + 0.5, 4, z + 0.5, i));
    }
    tree.pack();

    // 6 m cells at depth 8, so a 1 m box reaches the bottom.
    expect(tree.describe().itemsAtDepth[8]).toBeGreaterThan(150);
    expect(tree.getNodeTotal(0)).toBe(200);

    const out = new IndexList();
    expect(tree.queryBox(-1e5, -1e5, -1e5, 1e5, 1e5, 1e5, out)).toBe(200);
    expect(sortedList(out)).toEqual(handles.slice().sort((a, b) => a - b));
  });

  it('parks a degenerate AABB instead of corrupting the counts', () => {
    // An un-populated THREE.Box3 arrives as min +Inf / max -Inf, which makes
    // the placement centre NaN. The descent must fail its containment test and
    // park the item at the root; letting NaN through produced `node = NaN`,
    // which inflated the root count by one per level, filed the item under a
    // phantom bucket and made `remove` evict an unrelated live item.
    const tree = new Quadtree({ initialCapacity: 16 });
    const a = tree.insert(5000, 0, 5000, 5010, 10, 5010, 'A');
    const b = tree.insert(5020, 0, 5020, 5030, 10, 5030, 'B');
    const empty = tree.insert(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity, 'bad');

    expect(tree.getChunk(empty)).toBe(-1);
    // One increment per item, not one per level.
    expect(tree.getNodeTotal(0)).toBe(3);

    expect(tree.remove(empty)).toBe(true);
    expect(tree.count).toBe(2);
    expect(tree.getNodeTotal(0)).toBe(2);

    // Both live items must survive the degenerate one's removal.
    const out = new IndexList();
    tree.queryBox(4990, -10, 4990, 5040, 20, 5040, out);
    expect(sortedList(out)).toEqual([a, b].sort((x, y) => x - y));
  });
});

describe('Quadtree insert and remove', () => {
  it('reuses freed handles and keeps counts consistent', () => {
    const tree = new Quadtree({ initialCapacity: 64 });
    const handles: number[] = [];
    for (const box of randomBoxes(500, 'insert-remove')) {
      handles.push(tree.insert(box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ, 'x'));
    }
    expect(tree.count).toBe(500);
    expect(new Set(handles).size).toBe(500);

    for (let i = 0; i < 200; i++) expect(tree.remove(handles[i]!)).toBe(true);
    expect(tree.count).toBe(300);
    // A second removal of the same handle must be a no-op, not a corruption.
    expect(tree.remove(handles[0]!)).toBe(false);
    expect(tree.isAlive(handles[0]!)).toBe(false);
    expect(tree.isAlive(handles[400]!)).toBe(true);

    const reused: number[] = [];
    for (const box of randomBoxes(50, 'reinsert-2')) {
      reused.push(tree.insert(box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ));
    }
    expect(tree.count).toBe(350);
    // Freed slots come back rather than growing the watermark.
    expect(Math.max(...reused)).toBeLessThan(500);
  });

  it('tightens node bounds on refit after removals', () => {
    const tree = new Quadtree({ initialCapacity: 16 });
    const tall = tree.insert(-10, 0, -10, 10, 400, 10);
    tree.insert(-10, 0, -10, 10, 5, 10);
    tree.pack();

    const before = new Float64Array(6);
    tree.getNodeBounds(0, before);
    expect(before[4]).toBeCloseTo(400, 3);

    tree.remove(tall);
    const after = new Float64Array(6);
    tree.getNodeBounds(0, after);
    expect(after[4]).toBeCloseTo(5, 3);
  });

  it('tightens node extents when refit runs without a pending repack', () => {
    // `nodeCentreExtent` is what the frustum walk classifies nodes against, and
    // `refit()` rewrites the `nodeBounds` it is derived from. The stale form is
    // conservatively LARGE, so results stay exact — but the walk keeps
    // descending into subtrees it should have rejected outright. `pack()` being
    // public is what makes the window reachable: it clears `packDirty` while
    // `boundsDirty` is still set, so the later lazy `refit()` finds no repack
    // pending and nothing refreshes the derived form.
    const tree = new Quadtree({ initialCapacity: 8 });
    const tall = tree.insert(-10, 0, -10, 10, 400, 10);
    tree.insert(-10, 0, -10, 10, 5, 10);
    tree.pack();
    tree.remove(tall);
    tree.pack(); // extents rebuilt from the stale 400 m-tall bounds

    // Camera at y = 300 looking down -Z: the frustum covers y ~ 242..358 where
    // the geometry is, so the STALE 0..400 root box straddles it while the real
    // 0..5 box is far below the bottom plane.
    const frustum = new Frustum();
    const matrix = new Float64Array(16);
    poseMatrix(
      matrix,
      { x: 0, y: 300, z: 100, yaw: 0, pitch: 0 },
      { name: 'refit-probe', fovDegrees: 60, aspect: 1, near: 0.3, far: 400 }
    );
    frustum.setFromViewProjection(matrix);

    const out = new IndexList(8);
    const stats = createCullStats();
    tree.cullFrustum(frustum, out, stats);

    expect(out.length).toBe(0); // exact either way
    expect(stats.itemsTested).toBe(0); // 1 before the fix, 0 after
    expect(stats.nodesRejected).toBe(1); // 0 before the fix, 1 after
  });

  it('clears completely', () => {
    const tree = buildTree(1000, 'clearable');
    tree.clear();
    expect(tree.count).toBe(0);
    const out = new IndexList();
    expect(tree.queryBox(WORLD_MIN, -1e4, WORLD_MIN, -WORLD_MIN, 1e4, -WORLD_MIN, out)).toBe(0);
  });
});

describe('Quadtree range queries vs brute force', () => {
  const tree = buildTree(10_000);
  const rng = createRng('range-queries');
  const fast = new IndexList(1024);
  const slow = new IndexList(1024);

  it('box queries match over 400 random boxes', () => {
    let totalHits = 0;
    for (let i = 0; i < 400; i++) {
      const cx = WORLD_MIN + rng.next() * WORLD_SIZE;
      const cz = WORLD_MIN + rng.next() * WORLD_SIZE;
      const cy = rng.range(-10, 80);
      const half = rng.range(2, 180);
      const halfY = rng.range(2, 120);
      const [minX, maxX] = [cx - half, cx + half];
      const [minZ, maxZ] = [cz - half, cz + half];
      const [minY, maxY] = [cy - halfY, cy + halfY];

      tree.queryBox(minX, minY, minZ, maxX, maxY, maxZ, fast);
      tree.bruteForceBox(minX, minY, minZ, maxX, maxY, maxZ, slow);
      const difference = describeDifference(sortedList(fast), sortedList(slow));
      expect(difference, `box query ${i}: ${difference}`).toBeUndefined();
      totalHits += slow.length;
    }
    expect(totalHits).toBeGreaterThan(1000);
  });

  it('a world-sized box returns everything', () => {
    tree.queryBox(-1e5, -1e5, -1e5, 1e5, 1e5, 1e5, fast);
    expect(fast.length).toBe(10_000);
  });

  it('2D radius queries match over 400 random circles', () => {
    let totalHits = 0;
    for (let i = 0; i < 400; i++) {
      const x = WORLD_MIN + rng.next() * WORLD_SIZE;
      const z = WORLD_MIN + rng.next() * WORLD_SIZE;
      const radius = rng.range(1, 220);

      tree.queryRadius2D(x, z, radius, fast);
      tree.bruteForceRadius2D(x, z, radius, slow);
      const difference = describeDifference(sortedList(fast), sortedList(slow));
      expect(difference, `radius query ${i}: ${difference}`).toBeUndefined();
      totalHits += slow.length;
    }
    expect(totalHits).toBeGreaterThan(1000);
  });

  it('a zero radius still finds boxes containing the point', () => {
    const tree2 = new Quadtree({ initialCapacity: 8 });
    const h = tree2.insert(-5, 0, -5, 5, 10, 5);
    tree2.queryRadius2D(0, 0, 0, fast);
    expect(fast.toArray()).toEqual([h]);
    tree2.queryRadius2D(50, 50, 0, fast);
    expect(fast.length).toBe(0);
  });
});

describe('Quadtree raycasts vs brute force', () => {
  const tree = buildTree(10_000);
  const rng = createRng('raycasts');
  const fast = new IndexList(256);
  const slow = new IndexList(256);
  const fastDist = new FloatList(256);
  const slowDist = new FloatList(256);

  it('raycastAll matches over 400 random rays', () => {
    let totalHits = 0;
    for (let i = 0; i < 400; i++) {
      const ox = WORLD_MIN + rng.next() * WORLD_SIZE;
      const oz = WORLD_MIN + rng.next() * WORLD_SIZE;
      const oy = rng.range(0, 60);
      const yaw = rng.range(0, Math.PI * 2);
      const pitch = rng.range(-0.6, 0.6);
      const dx = Math.cos(pitch) * Math.sin(yaw);
      const dy = Math.sin(pitch);
      const dz = Math.cos(pitch) * Math.cos(yaw);
      const maxDistance = rng.range(20, 900);

      tree.raycastAll(ox, oy, oz, dx, dy, dz, maxDistance, fast, fastDist);
      tree.bruteForceRaycast(ox, oy, oz, dx, dy, dz, maxDistance, slow, slowDist);
      const difference = describeDifference(sortedList(fast), sortedList(slow));
      expect(difference, `ray ${i}: ${difference}`).toBeUndefined();
      totalHits += slow.length;
    }
    expect(totalHits).toBeGreaterThan(200);
  });

  it('raycastFirst finds the same nearest hit as the linear scan', () => {
    const hit: IQuadtreeRayHit = { handle: -1, distance: Infinity };
    const reference: IQuadtreeRayHit = { handle: -1, distance: Infinity };
    let hits = 0;

    for (let i = 0; i < 600; i++) {
      const ox = WORLD_MIN + rng.next() * WORLD_SIZE;
      const oz = WORLD_MIN + rng.next() * WORLD_SIZE;
      const oy = rng.range(0, 40);
      const yaw = rng.range(0, Math.PI * 2);
      const pitch = rng.range(-0.5, 0.5);
      const dx = Math.cos(pitch) * Math.sin(yaw);
      const dy = Math.sin(pitch);
      const dz = Math.cos(pitch) * Math.cos(yaw);
      const maxDistance = rng.range(50, 1200);

      const found = tree.raycastFirst(ox, oy, oz, dx, dy, dz, maxDistance, hit);
      const expected = tree.bruteForceRaycastFirst(ox, oy, oz, dx, dy, dz, maxDistance, reference);
      expect(found).toBe(expected);
      expect(hit.handle, `ray ${i} handle`).toBe(reference.handle);
      if (found) {
        expect(hit.distance).toBeCloseTo(reference.distance, 9);
        hits++;
      }
    }
    expect(hits).toBeGreaterThan(100);
  });

  it('handles axis-aligned rays that graze slab planes', () => {
    // Grid-aligned geometry plus an axis-aligned ray is the case a naive
    // `1 / 0 -> Infinity` slab test silently drops.
    const tree2 = new Quadtree({ initialCapacity: 8 });
    const h = tree2.insert(0, 0, 0, 10, 10, 10);
    const hit: IQuadtreeRayHit = { handle: -1, distance: Infinity };

    // Ray running exactly along the box's minimum X face.
    expect(tree2.raycastFirst(0, 5, -50, 0, 0, 1, 100, hit)).toBe(true);
    expect(hit.handle).toBe(h);
    expect(hit.distance).toBeCloseTo(50, 6);

    // Ray running along the face but outside the box in Y.
    expect(tree2.raycastFirst(0, 50, -50, 0, 0, 1, 100, hit)).toBe(false);

    // Origin inside the box.
    expect(tree2.raycastFirst(5, 5, 5, 1, 0, 0, 100, hit)).toBe(true);
    expect(hit.distance).toBe(0);
  });

  it('respects maxDistance', () => {
    const tree2 = new Quadtree({ initialCapacity: 8 });
    tree2.insert(0, 0, 100, 10, 10, 110);
    const hit: IQuadtreeRayHit = { handle: -1, distance: Infinity };
    expect(tree2.raycastFirst(5, 5, 0, 0, 0, 1, 99, hit)).toBe(false);
    expect(tree2.raycastFirst(5, 5, 0, 0, 0, 1, 101, hit)).toBe(true);
  });
});

/** Random boxes confined to a given square extent, so items actually descend. */
function boxesIn(
  count: number,
  seed: string,
  originX: number,
  originZ: number,
  size: number
): { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }[] {
  const rng = createRng(seed);
  const out: {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
  }[] = [];
  for (let i = 0; i < count; i++) {
    const cx = originX + rng.next() * size;
    const cz = originZ + rng.next() * size;
    const hx = rng.range(0.75, 12);
    const hz = rng.range(0.75, 12);
    const base = rng.range(0, 4);
    const h = rng.range(3, 60);
    out.push({
      minX: cx - hx,
      minY: base,
      minZ: cz - hz,
      maxX: cx + hx,
      maxY: base + h,
      maxZ: cz + hz,
    });
  }
  return out;
}

/**
 * `IQuadtreeOptions` documents five tunables and the constructor validates
 * `depth` — that is a public contract, and every other test in the unit builds
 * a default tree. These configurations are what reach `levelOffset`'s
 * non-canonical branch, the `canonical` gate in `buildTopology`,
 * `chunkOfCentre`'s early -1, and the `nodeChild0 < 0` leaf-sweep disjunct in
 * every walk — none of which the default tree exercises. Each is guarded by
 * the same brute-force reference the default tree is.
 *
 * Deliberately no `depth >= 8` here: depth 7 is the deepest currently-correct
 * value, and the deeper ones have their own filed regression.
 */
describe('Quadtree non-default configurations', () => {
  const CONFIGS: readonly { name: string; options: IQuadtreeOptions; canonical: boolean }[] = [
    { name: 'depth 0 (root only)', options: { depth: 0 }, canonical: false },
    { name: 'depth 3 (shallower than the chunk level)', options: { depth: 3 }, canonical: false },
    { name: 'depth 7', options: { depth: 7 }, canonical: true },
    {
      name: 'custom extent',
      options: { originX: 0, originZ: 0, size: 512, depth: 5 },
      canonical: false,
    },
    { name: 'strict placement', options: { looseFactor: 1 }, canonical: true },
    { name: 'leafThreshold 1', options: { leafThreshold: 1 }, canonical: true },
  ];

  for (const config of CONFIGS) {
    it(`matches brute force for ${config.name}`, () => {
      const originX = config.options.originX ?? WORLD_MIN;
      const originZ = config.options.originZ ?? WORLD_MIN;
      const size = config.options.size ?? WORLD_SIZE;
      const tree = new Quadtree({ ...config.options, initialCapacity: 1200 });
      expect(tree.canonical).toBe(config.canonical);

      for (const b of boxesIn(1200, `nondefault-${config.name}`, originX, originZ, size)) {
        tree.insert(b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ);
      }
      tree.pack();

      expect(tree.count).toBe(1200);
      const info = tree.describe();
      expect(info.itemsAtDepth.reduce((a, b) => a + b, 0)).toBe(1200);
      if (!config.canonical) {
        expect(tree.chunkNode(0)).toBe(-1);
        expect(tree.getChunk(0)).toBe(-1);
      }
      // Not vacuous: unless the tree is too shallow to descend at all, the
      // items must actually reach the lower levels rather than pile up at the
      // root, where every query would degenerate to a linear scan.
      if (tree.depth >= 3) {
        expect(info.itemsAtDepth.slice(3).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(900);
      } else {
        expect(info.itemsAtDepth[0]).toBe(1200);
      }

      const frustum = new Frustum();
      const matrix = new Float64Array(16);
      const fast = new IndexList(1024);
      const slow = new IndexList(1024);
      const rngQ = createRng(`nondefault-queries-${config.name}`);
      let seen = 0;

      for (const pose of randomPoses(30, `nondefault-poses-${config.name}`)) {
        poseMatrix(matrix, pose, WIDE_LANDSCAPE_LENS);
        frustum.setFromViewProjection(matrix);
        tree.cullFrustum(frustum, fast);
        tree.bruteForceCull(frustum, slow);
        expect(describeDifference(sortedList(fast), sortedList(slow))).toBeUndefined();
        seen += slow.length;
      }
      expect(seen).toBeGreaterThan(0);

      for (let i = 0; i < 60; i++) {
        const x = originX + rngQ.next() * size;
        const z = originZ + rngQ.next() * size;
        const half = rngQ.range(2, 180);
        const y = rngQ.range(-10, 80);
        const halfY = rngQ.range(2, 120);
        tree.queryBox(x - half, y - halfY, z - half, x + half, y + halfY, z + half, fast);
        tree.bruteForceBox(x - half, y - halfY, z - half, x + half, y + halfY, z + half, slow);
        expect(describeDifference(sortedList(fast), sortedList(slow))).toBeUndefined();

        const radius = rngQ.range(1, 220);
        tree.queryRadius2D(x, z, radius, fast);
        tree.bruteForceRadius2D(x, z, radius, slow);
        expect(describeDifference(sortedList(fast), sortedList(slow))).toBeUndefined();

        const yaw = rngQ.range(0, Math.PI * 2);
        const pitch = rngQ.range(-0.6, 0.6);
        const dx = Math.cos(pitch) * Math.sin(yaw);
        const dy = Math.sin(pitch);
        const dz = Math.cos(pitch) * Math.cos(yaw);
        const maxDistance = rngQ.range(20, 900);
        tree.raycastAll(x, y, z, dx, dy, dz, maxDistance, fast);
        tree.bruteForceRaycast(x, y, z, dx, dy, dz, maxDistance, slow);
        expect(describeDifference(sortedList(fast), sortedList(slow))).toBeUndefined();
      }
    });
  }
});
