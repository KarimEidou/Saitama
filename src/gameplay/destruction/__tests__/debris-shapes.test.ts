/**
 * THE POOLED DEBRIS BOXES — THE SLOT LIFETIME, AND THE BOX ITSELF
 *
 * `debris-shapes.ts` opens with the pool's central safety property: "A box may
 * not be resized while the piece using it is still on screen… A ring buffer
 * would be cheaper and is NOT safe." `caps.test.ts` checks that a slot comes
 * back after a retire; it does not check that the slot handed back is one whose
 * piece is GONE rather than one whose piece is still falling, and that is the
 * entire claim.
 *
 * The 24-corner/36-index box construction is the other untested half. A single
 * flipped bit in `CORNER_SELECT` or `buildBoxIndices` turns a face inside out,
 * and back-face culling then hides it — a debris shard with a hole in it that
 * nobody notices until a screenshot.
 *
 * And the normals and index buffers are SHARED between every slot, which is
 * worth ~105 KB of VRAM and 598 buffer creations at the 300-slot default.
 * Sharing is only invisible while nothing mutates them per slot, so the
 * identity is asserted here as well as the values.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DebrisShapePool } from '../debris-shapes';
import type { IStructureChunk } from '../ports';
import { FakeDebrisPool, makeTower } from './fixtures';

/** A structure chunk with an arbitrary local AABB, for the geometry cases. */
function chunkWithAabb(
  index: number,
  aabb: readonly [number, number, number, number, number, number]
): IStructureChunk {
  return {
    index,
    floor: 0,
    quadrant: index & 3,
    start: 0,
    count: 96,
    parts: [{ slot: 0, start: 0, count: 96 }],
    vertexStart: index * 32,
    vertexCount: 32,
    centroid: [(aabb[0] + aabb[3]) * 0.5, (aabb[1] + aabb[4]) * 0.5, (aabb[2] + aabb[5]) * 0.5],
    volume: 2,
    mass: 4800,
    aabb,
    grounded: false,
    neighbours: [],
    supportShare: 0.25,
  };
}

const AABB = [-1, 2, -3, 4, 5, 6] as const;

describe('the box a slot hands out', () => {
  it('is 24 vertices standing on the eight corners of the source AABB', () => {
    const pool = new DebrisShapePool(2);
    const chunk = pool.acquire(chunkWithAabb(0, AABB))!;
    expect(chunk).toBeDefined();

    const positions = chunk.geometry.getAttribute('position').array;
    expect(positions.length).toBe(72);

    // Every vertex is one of the eight corners, and each corner carries the
    // three faces that meet on it — that is what hard per-face normals cost.
    const seen = new Map<string, number>();
    for (let v = 0; v < 24; v++) {
      const x = positions[v * 3]!;
      const y = positions[v * 3 + 1]!;
      const z = positions[v * 3 + 2]!;
      expect([AABB[0], AABB[3]]).toContain(x);
      expect([AABB[1], AABB[4]]).toContain(y);
      expect([AABB[2], AABB[5]]).toContain(z);
      const key = `${x},${y},${z}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    expect(seen.size).toBe(8);
    for (const count of seen.values()) expect(count).toBe(3);

    expect(chunk.geometry.getIndex()!.count).toBe(36);
    pool.dispose();
  });

  it('carries bounds the physics hull and the culler can trust', () => {
    const pool = new DebrisShapePool(2);
    const chunk = pool.acquire(chunkWithAabb(0, AABB))!;

    const boundingBox = chunk.geometry.boundingBox!;
    expect(boundingBox.min.toArray()).toEqual([AABB[0], AABB[1], AABB[2]]);
    expect(boundingBox.max.toArray()).toEqual([AABB[3], AABB[4], AABB[5]]);

    const sphere = chunk.geometry.boundingSphere!;
    const dx = AABB[3] - AABB[0];
    const dy = AABB[4] - AABB[1];
    const dz = AABB[5] - AABB[2];
    expect(sphere.radius).toBeCloseTo(0.5 * Math.hypot(dx, dy, dz), 6);
    expect(sphere.center.toArray()).toEqual([
      (AABB[0] + AABB[3]) * 0.5,
      (AABB[1] + AABB[4]) * 0.5,
      (AABB[2] + AABB[5]) * 0.5,
    ]);

    // The record handed to the debris pool repeats them, because that is what
    // the collider is built from.
    expect(chunk.bounds.min.toArray()).toEqual([AABB[0], AABB[1], AABB[2]]);
    expect(chunk.bounds.max.toArray()).toEqual([AABB[3], AABB[4], AABB[5]]);
    pool.dispose();
  });

  it('winds every triangle outward, so back-face culling keeps the outside', () => {
    const pool = new DebrisShapePool(2);
    const chunk = pool.acquire(chunkWithAabb(0, AABB))!;
    const positions = chunk.geometry.getAttribute('position').array;
    const normals = chunk.geometry.getAttribute('normal').array;
    const indices = chunk.geometry.getIndex()!.array;

    const at = (buffer: ArrayLike<number>, i: number): THREE.Vector3 =>
      new THREE.Vector3(buffer[i * 3]!, buffer[i * 3 + 1]!, buffer[i * 3 + 2]!);

    expect(indices.length).toBe(36);
    for (let t = 0; t < 12; t++) {
      const i0 = indices[t * 3]!;
      const i1 = indices[t * 3 + 1]!;
      const i2 = indices[t * 3 + 2]!;
      const p0 = at(positions, i0);
      const cross = at(positions, i1).sub(p0).cross(at(positions, i2).sub(p0));
      // Counter-clockwise as seen from outside means the geometric normal
      // agrees with the stored one. A flipped face reads as a hole.
      expect(cross.dot(at(normals, i0))).toBeGreaterThan(0);
    }

    // All four vertices of a face carry the identical stored normal — that is
    // what makes the shading hard-edged rather than smoothed into a pillow.
    for (let face = 0; face < 6; face++) {
      const first = at(normals, face * 4);
      expect(first.length()).toBeCloseTo(1, 6);
      for (let corner = 1; corner < 4; corner++) {
        expect(at(normals, face * 4 + corner).toArray()).toEqual(first.toArray());
      }
    }
    pool.dispose();
  });
});

describe('slot allocation', () => {
  it('hands out every slot once, then refuses', () => {
    const pool = new DebrisShapePool(4);
    expect(pool.freeCount).toBe(4);
    expect(pool.lentCount).toBe(0);

    const records = [0, 1, 2, 3].map((i) => pool.acquire(chunkWithAabb(i, AABB)));
    for (const record of records) expect(record).toBeDefined();
    expect(new Set(records).size).toBe(4);
    expect(pool.lentCount).toBe(4);
    expect(pool.freeCount).toBe(0);

    // "Detach visually, spawn no body" — the caller's contract for a refusal.
    expect(pool.acquire(chunkWithAabb(4, AABB))).toBeUndefined();
    pool.dispose();
  });

  it('returns the slot immediately when the spawn was refused', () => {
    const pool = new DebrisShapePool(4);
    pool.acquire(chunkWithAabb(0, AABB));
    pool.bind(1);
    expect(pool.lentCount).toBe(1);
    expect(pool.freeCount).toBe(3);

    pool.acquire(chunkWithAabb(1, AABB));
    expect(pool.freeCount).toBe(2);
    pool.bind(undefined);
    // Back where it was: the refused slot is free again and the live one is
    // untouched.
    expect(pool.freeCount).toBe(3);
    expect(pool.lentCount).toBe(1);
    pool.dispose();
  });
});

describe('the slot lifetime invariant', () => {
  it('reclaims only the slots whose pieces are gone, never one still falling', () => {
    const debris = new FakeDebrisPool(4);
    const shapes = new DebrisShapePool(4);
    const { layout } = makeTower({ floors: 2 });
    const matrix = new THREE.Matrix4();
    const impulse = new THREE.Vector3();

    // Mirror what `spawnDebris` does, in lend order.
    const records = [];
    for (let i = 0; i < 4; i++) {
      const record = shapes.acquire(layout.chunks[i]!)!;
      expect(record).toBeDefined();
      const piece = debris.spawn(record, matrix, impulse);
      shapes.bind(piece?.id);
      records.push(record);
    }
    expect(shapes.lentCount).toBe(4);
    expect(shapes.freeCount).toBe(0);

    // Nothing has faded, so nothing may come back.
    shapes.reclaim(debris);
    expect(shapes.lentCount).toBe(4);
    expect(shapes.freeCount).toBe(0);

    // The two OLDEST pieces fade. A ring buffer would hand back the two oldest
    // SLOTS regardless — which happens to be the same two here — so the test
    // that discriminates is the one below, on which records come back.
    debris.retire(2);
    shapes.reclaim(debris);
    expect(shapes.freeCount).toBe(2);
    expect(shapes.lentCount).toBe(2);

    const reacquired = [shapes.acquire(layout.chunks[4]!)!, shapes.acquire(layout.chunks[5]!)!];
    expect(shapes.freeCount).toBe(0);
    // Exactly the two whose pieces retired, and neither of the two still live.
    expect(new Set(reacquired)).toEqual(new Set([records[0], records[1]]));
    expect(reacquired).not.toContain(records[2]);
    expect(reacquired).not.toContain(records[3]);
    shapes.dispose();
  });

  it('holds when the piece that fades is not the oldest', () => {
    // The case a ring buffer gets wrong: the debris pool's LRU can keep an old
    // piece alive across a whole capacity's worth of spawns.
    const shapes = new DebrisShapePool(3);
    const { layout } = makeTower({ floors: 2 });
    const live = new Set<number>([10, 11, 12]);
    const sink = {
      capacity: 3,
      get count(): number {
        return live.size;
      },
      spawn: (): { id: number } | undefined => undefined,
      get: (id: number): unknown => (live.has(id) ? { id } : undefined),
    };

    const records = [];
    for (let i = 0; i < 3; i++) {
      records.push(shapes.acquire(layout.chunks[i]!)!);
      shapes.bind(10 + i);
    }
    expect(shapes.lentCount).toBe(3);

    // The MIDDLE piece dies. Slot 1 is the one that may be reused.
    live.delete(11);
    shapes.reclaim(sink);
    expect(shapes.freeCount).toBe(1);
    expect(shapes.lentCount).toBe(2);
    expect(shapes.acquire(layout.chunks[3]!)).toBe(records[1]);
    shapes.dispose();
  });
});

describe('normals and indices are shared, not copied per slot', () => {
  it('is one attribute each across every slot, with distinct positions', () => {
    const pool = new DebrisShapePool(8);
    const records = [];
    for (let i = 0; i < 8; i++) records.push(pool.acquire(chunkWithAabb(i, AABB))!);

    const normal = records[0]!.geometry.getAttribute('normal');
    const index = records[0]!.geometry.getIndex();
    const positions = new Set<unknown>();
    for (const record of records) {
      // `WebGLAttributes` keys its buffer cache on the attribute OBJECT, so
      // identity here is exactly what decides whether the driver holds one
      // copy or eight.
      expect(record.geometry.getAttribute('normal')).toBe(normal);
      expect(record.geometry.getIndex()).toBe(index);
      positions.add(record.geometry.getAttribute('position'));
    }
    // ...and the corners must NOT be shared — rewriting them per slot is the
    // whole point of the pool.
    expect(positions.size).toBe(8);
    pool.dispose();
  });

  it('leaves the shared values exactly what they were per slot', () => {
    const pool = new DebrisShapePool(8);
    const record = pool.acquire(chunkWithAabb(0, AABB))!;
    const normals = record.geometry.getAttribute('normal').array;
    const indices = record.geometry.getIndex()!.array;

    const faceNormals = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    for (let face = 0; face < 6; face++) {
      for (let corner = 0; corner < 4; corner++) {
        const v = (face * 4 + corner) * 3;
        expect([normals[v], normals[v + 1], normals[v + 2]]).toEqual(faceNormals[face]);
      }
      const base = face * 4;
      expect([...indices.slice(face * 6, face * 6 + 6)]).toEqual([
        base,
        base + 1,
        base + 2,
        base,
        base + 2,
        base + 3,
      ]);
    }
    pool.dispose();
  });

  it('keeps two slots holding two different boxes', () => {
    // Sharing changed nothing observable: the corners are still per-slot.
    const pool = new DebrisShapePool(4);
    const small = [-1, -1, -1, 1, 1, 1] as const;
    const large = [0, 10, 0, 20, 40, 30] as const;
    const a = pool.acquire(chunkWithAabb(0, small))!;
    const b = pool.acquire(chunkWithAabb(1, large))!;

    const cornersOf = (geometry: THREE.BufferGeometry): Set<string> => {
      const array = geometry.getAttribute('position').array;
      const out = new Set<string>();
      for (let v = 0; v < 24; v++) {
        out.add(`${array[v * 3]},${array[v * 3 + 1]},${array[v * 3 + 2]}`);
      }
      return out;
    };
    expect(cornersOf(a.geometry)).toEqual(
      new Set(['-1,-1,-1', '1,-1,-1', '-1,1,-1', '1,1,-1', '-1,-1,1', '1,-1,1', '-1,1,1', '1,1,1'])
    );
    expect(cornersOf(b.geometry)).toEqual(
      new Set([
        '0,10,0',
        '20,10,0',
        '0,40,0',
        '20,40,0',
        '0,10,30',
        '20,10,30',
        '0,40,30',
        '20,40,30',
      ])
    );
    expect(a.geometry.boundingBox!.max.toArray()).toEqual([1, 1, 1]);
    expect(b.geometry.boundingBox!.max.toArray()).toEqual([20, 40, 30]);
    pool.dispose();
  });
});
