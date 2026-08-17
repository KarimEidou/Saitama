/**
 * DYNAMIC ENTITY GRID — RADIUS AND CONE QUERIES
 *
 * Both queries are verified against a linear scan using the identical
 * predicate, so what is under test is the cell pruning: whether widening the
 * search by the largest entity radius really does catch every entity that a
 * centre-binned grid could otherwise miss.
 *
 * The cone query exists for the shockwave broad phase. Combat decides what a
 * hit MEANS; this file only proves the candidate set is complete.
 */

import { describe, it, expect } from 'vitest';
import { DynamicEntityGrid, sphereInCone, ALL_LAYERS } from '../entity-grid';
import { IndexList } from '../index-list';
import { ENTITY_CELL_SIZE, ENTITY_GRID_DIM, WORLD_MIN, WORLD_SIZE } from '../constants';
import { createRng, type IRandom } from '@/util';
import { sortedList, describeDifference } from './fixtures';

interface IFakeEntity {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
  readonly layer: number;
}

/** `count` entities uniformly filling a `spread`-metre square centred on the
 * origin (or on the whole world when `spread` is the world size). */
function makeEntities(count: number, rng: IRandom, spread = WORLD_SIZE): IFakeEntity[] {
  const base = spread === WORLD_SIZE ? WORLD_MIN : -spread * 0.5;
  const out: IFakeEntity[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      id: `e${i}`,
      x: base + rng.next() * spread,
      y: rng.range(0, 40),
      z: base + rng.next() * spread,
      radius: rng.range(0.3, 3.5),
      layer: 1 << rng.int(0, 3),
    });
  }
  return out;
}

function fill(grid: DynamicEntityGrid, entities: readonly IFakeEntity[]): void {
  grid.beginFrame();
  for (const e of entities) grid.add(e, e.x, e.y, e.z, e.radius, e.layer);
  grid.build();
}

describe('Dynamic entity grid structure', () => {
  it('uses 24 m cells over the 1536 m world', () => {
    const grid = new DynamicEntityGrid();
    expect(grid.cellSize).toBe(ENTITY_CELL_SIZE);
    expect(grid.cellSize).toBe(24);
    expect(grid.dim).toBe(ENTITY_GRID_DIM);
    expect(grid.dim).toBe(64);
    expect(grid.stats().cells).toBe(64 * 64);
  });

  it('rebuilds cleanly every frame', () => {
    const rng = createRng('grid-rebuild');
    const grid = new DynamicEntityGrid(64);
    const out = new IndexList();

    for (let frame = 0; frame < 5; frame++) {
      const entities = makeEntities(300, rng);
      fill(grid, entities);
      expect(grid.size).toBe(300);
      expect(grid.stats().entities).toBe(300);
      grid.queryRadius(0, 0, 0, 5000, out);
      expect(out.length).toBe(300);
    }

    // An empty frame must leave nothing behind from the previous one.
    grid.beginFrame();
    grid.build();
    expect(grid.size).toBe(0);
    expect(grid.queryRadius(0, 0, 0, 5000, out)).toBe(0);
  });

  it('grows past its initial capacity without losing entities', () => {
    const rng = createRng('grid-grow');
    const grid = new DynamicEntityGrid(16);
    const entities = makeEntities(2000, rng);
    fill(grid, entities);
    const out = new IndexList();
    expect(grid.queryRadius(0, 0, 0, 1e5, out)).toBe(2000);
    // Refs must survive the reallocation.
    expect((grid.getRef(0) as IFakeEntity).id).toBe('e0');
    expect((grid.getRef(1999) as IFakeEntity).id).toBe('e1999');
  });

  it('clamps entities knocked outside the world into the edge cells', () => {
    const grid = new DynamicEntityGrid(8);
    grid.beginFrame();
    const slot = grid.add({ id: 'launched' }, 99_999, 400, -99_999, 1);
    grid.build();
    const out = new IndexList();
    // Still findable from where it actually is.
    expect(grid.queryRadius(99_999, 400, -99_999, 5, out)).toBe(1);
    expect(out.at(0)).toBe(slot);
  });
});

describe('Radius queries vs brute force', () => {
  const rng = createRng('grid-radius');
  const grid = new DynamicEntityGrid(1024);
  const fast = new IndexList(256);
  const slow = new IndexList(256);

  it('matches over 400 random spheres and 4 entity populations', () => {
    let totalHits = 0;
    for (let population = 0; population < 4; population++) {
      fill(grid, makeEntities(400, rng));
      for (let i = 0; i < 100; i++) {
        const x = WORLD_MIN + rng.next() * WORLD_SIZE;
        const y = rng.range(-10, 60);
        const z = WORLD_MIN + rng.next() * WORLD_SIZE;
        const range = rng.range(0.5, 140);

        grid.queryRadius(x, y, z, range, fast);
        grid.queryRadiusBrute(x, y, z, range, slow);
        const difference = describeDifference(sortedList(fast), sortedList(slow));
        expect(difference, `radius query ${population}/${i}: ${difference}`).toBeUndefined();
        totalHits += slow.length;
      }
    }
    expect(totalHits).toBeGreaterThan(500);
  });

  it('honours the layer mask', () => {
    fill(grid, makeEntities(500, rng));
    for (const mask of [1, 2, 4, 8, 5, ALL_LAYERS]) {
      grid.queryRadius(0, 0, 0, 1e5, fast, mask);
      grid.queryRadiusBrute(0, 0, 0, 1e5, slow, mask);
      expect(describeDifference(sortedList(fast), sortedList(slow))).toBeUndefined();
      for (let i = 0; i < fast.length; i++) {
        expect(grid.getLayer(fast.at(i)) & mask).not.toBe(0);
      }
    }
  });

  it('includes an entity whose volume reaches into range even when its centre does not', () => {
    const grid2 = new DynamicEntityGrid(8);
    grid2.beginFrame();
    const big = grid2.add({ id: 'boss' }, 60, 0, 0, 12);
    grid2.build();
    // Centre 60 m away, radius 12, query range 50: 60 <= 50 + 12.
    expect(grid2.queryRadius(0, 0, 0, 50, fast)).toBe(1);
    expect(fast.at(0)).toBe(big);
    expect(grid2.queryRadius(0, 0, 0, 47, fast)).toBe(0);
  });

  it('finds the nearest entity', () => {
    const rng2 = createRng('grid-nearest');
    const entities = makeEntities(300, rng2, 400);
    fill(grid, entities);
    for (let i = 0; i < 40; i++) {
      const x = rng2.range(-200, 200);
      const y = rng2.range(0, 40);
      const z = rng2.range(-200, 200);
      const range = rng2.range(10, 300);

      const nearest = grid.queryNearest(x, y, z, range);
      grid.queryRadiusBrute(x, y, z, range, slow);
      if (slow.length === 0) {
        expect(nearest).toBe(-1);
        continue;
      }
      let best = -1;
      let bestDist = Infinity;
      for (let k = 0; k < slow.length; k++) {
        const slot = slow.at(k);
        const dx = grid.getX(slot) - x;
        const dy = grid.getY(slot) - y;
        const dz = grid.getZ(slot) - z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestDist) {
          bestDist = d2;
          best = slot;
        }
      }
      expect(nearest).toBe(best);
    }
  });
});

describe('Cone queries vs brute force', () => {
  const rng = createRng('grid-cone');
  const grid = new DynamicEntityGrid(1024);
  const fast = new IndexList(256);
  const slow = new IndexList(256);

  it('matches over 600 random cones', () => {
    let totalHits = 0;
    for (let population = 0; population < 4; population++) {
      // Cluster entities so combat-range cones actually contain something.
      fill(grid, makeEntities(500, rng, 600));

      for (let i = 0; i < 150; i++) {
        const ox = rng.range(-300, 300);
        const oy = rng.range(0, 20);
        const oz = rng.range(-300, 300);
        const yaw = rng.range(0, Math.PI * 2);
        const pitch = rng.range(-0.8, 0.8);
        const dx = Math.cos(pitch) * Math.sin(yaw);
        const dy = Math.sin(pitch);
        const dz = Math.cos(pitch) * Math.cos(yaw);
        const range = rng.range(3, 120);
        const halfAngle = rng.range(0.08, Math.PI * 0.5);

        grid.queryCone(ox, oy, oz, dx, dy, dz, range, halfAngle, fast);
        grid.queryConeBrute(ox, oy, oz, dx, dy, dz, range, halfAngle, slow);
        const difference = describeDifference(sortedList(fast), sortedList(slow));
        expect(difference, `cone ${population}/${i}: ${difference}`).toBeUndefined();
        totalHits += slow.length;
      }
    }
    expect(totalHits).toBeGreaterThan(500);
  });

  it('a full-sphere cone equals a radius query', () => {
    fill(grid, makeEntities(400, rng, 800));
    grid.queryCone(0, 0, 0, 1, 0, 0, 400, Math.PI, fast);
    grid.queryRadiusBrute(0, 0, 0, 400, slow);
    expect(describeDifference(sortedList(fast), sortedList(slow))).toBeUndefined();
  });

  it('rejects targets behind the apex', () => {
    const grid2 = new DynamicEntityGrid(8);
    grid2.beginFrame();
    const ahead = grid2.add({ id: 'ahead' }, 0, 0, -20, 1);
    grid2.add({ id: 'behind' }, 0, 0, 20, 1);
    grid2.build();
    // 45-degree half-angle cone pointing down -Z.
    expect(grid2.queryCone(0, 0, 0, 0, 0, -1, 50, Math.PI / 4, fast)).toBe(1);
    expect(fast.at(0)).toBe(ahead);
  });

  it('rejects a zero-length direction rather than dividing by zero', () => {
    fill(grid, makeEntities(50, rng));
    expect(grid.queryCone(0, 0, 0, 0, 0, 0, 100, 1, fast)).toBe(0);
  });
});

describe('sphereInCone predicate', () => {
  it('accepts a point exactly on the cone surface and rejects just outside', () => {
    const half = Math.PI / 6;
    const dist = 10;
    // A zero-radius point at exactly the half-angle.
    const onAxisX = Math.cos(half) * dist;
    const onAxisY = Math.sin(half) * dist;
    expect(sphereInCone(onAxisX, onAxisY, 0, 0, 1, 0, 0, 20, half)).toBe(true);
    const outsideY = Math.sin(half + 0.05) * dist;
    const outsideX = Math.cos(half + 0.05) * dist;
    expect(sphereInCone(outsideX, outsideY, 0, 0, 1, 0, 0, 20, half)).toBe(false);
    // Give it a radius and the same point comes back inside.
    expect(sphereInCone(outsideX, outsideY, 0, 2, 1, 0, 0, 20, half)).toBe(true);
  });

  it('accepts a sphere containing the apex', () => {
    expect(sphereInCone(0.5, 0, 0, 5, 0, 0, -1, 30, 0.01)).toBe(true);
  });

  it('rejects beyond range even on axis', () => {
    expect(sphereInCone(0, 0, -100, 1, 0, 0, -1, 50, Math.PI)).toBe(false);
    expect(sphereInCone(0, 0, -50, 1, 0, 0, -1, 50, Math.PI)).toBe(true);
  });
});
