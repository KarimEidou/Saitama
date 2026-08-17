/**
 * QUADTREE — PLACEMENT, MUTATION, RANGE QUERIES AND RAYCASTS
 *
 * Every accelerated query is checked against the linear scan that defines it.
 * The two share their predicate (`packedIntersectsBox`, `packedDistanceSq2D`,
 * `packedRayEntry`) and read the same stored float32 bounds, so any divergence
 * is a bug in the traversal, which is exactly what these tests are for.
 */

import { describe, it, expect } from 'vitest';
import { Quadtree, type IQuadtreeRayHit } from '../quadtree';
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
import { randomBoxes, sortedList, describeDifference } from './fixtures';

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
      const expected = tree.bruteForceRaycastFirst(
        ox,
        oy,
        oz,
        dx,
        dy,
        dz,
        maxDistance,
        reference
      );
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
