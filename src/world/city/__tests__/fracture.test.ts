/**
 * FRACTURE PARTITION
 *
 * The scheme is only correct if the fracture chunks PARTITION the geometry:
 * every triangle owned by exactly one chunk, every vertex owned by exactly one
 * chunk. Both halves matter and they fail differently.
 *
 *   • A triangle in two chunks means destroying either one leaves the other
 *     holding triangles that have already been turned into debris — the same
 *     concrete falls twice.
 *   • An orphaned triangle can never be destroyed, so a punched-out building
 *     keeps a floating sliver of wall.
 *   • A vertex shared between two chunks means destroying one chunk silently
 *     deletes triangles from an intact neighbour, because the `destroyed` flag
 *     lives per vertex.
 *
 * None of these are visible in a screenshot until the moment someone punches
 * the building, which is exactly why they get a test.
 */

import { describe, expect, it } from 'vitest';
import { generateBuilding } from '../building';
import {
  QUADRANTS,
  collapsingFloors,
  neighboursOf,
  remainingSupport,
  verifyPartition,
} from '../fracture';
import { CITY_MATERIALS } from '../materials';
import type { BuildingDetail } from '../building';
import type { Polygon } from '../polygon';
import { combineLayouts, makeGenerator, SAMPLE_CHUNKS } from './fixtures';

function rect(w: number, d: number): Polygon {
  return [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [w / 2, d / 2],
    [-w / 2, d / 2],
  ];
}

function makeBuilding(floors: number, detail: BuildingDetail, seed: number, footprint = rect(19, 14)) {
  return generateBuilding({
    id: `test-${floors}-${detail}-${seed}`,
    footprint,
    floors,
    floorHeight: 3.3,
    groundFloorScale: 1.3,
    style: 'apartment',
    facadeMaterial: CITY_MATERIALS.wall.concretePlain,
    roofMaterial: CITY_MATERIALS.roof.bitumen,
    glassMaterial: CITY_MATERIALS.glass,
    tint: 0xd8d2c6,
    seed,
    detail,
    panelWeights: { window: 10, blank: 4, balcony: 3, ac_unit: 3, fire_escape_anchor: 2 },
    groundWeights: { shopfront: 4, door: 3, window: 3, blank: 2 },
    rooftopClutter: 0.9,
    parapetHeight: 0.9,
    litWindowChance: 0.2,
    structureMaterial: 'concrete',
  });
}

describe('fracture chunk layout', () => {
  it('emits one chunk per floor per quadrant', () => {
    for (const floors of [1, 3, 7, 12, 20]) {
      const build = makeBuilding(floors, 'full', 1234 + floors);
      expect(build.fracture.chunks.length).toBe(floors * QUADRANTS);
      expect(build.fracture.floors.length).toBe(floors);
      // A 12-floor building is the ~48 chunks the design calls for.
      if (floors === 12) expect(build.fracture.chunks.length).toBe(48);
    }
  });

  it('partitions every triangle and every vertex exactly once', () => {
    for (const detail of ['full', 'reduced', 'box'] as const) {
      for (const floors of [1, 2, 5, 9, 14]) {
        const build = makeBuilding(floors, detail, 900 + floors * 7);
        const report = verifyPartition(
          build.fracture,
          build.buffers.indexCount,
          build.buffers.vertexCount
        );
        expect(
          report.ok,
          `${detail}/${floors}f: dup=${report.duplicated} orphan=${report.orphaned} ` +
            `dupV=${report.duplicatedVertices} orphanV=${report.orphanedVertices} ` +
            `of ${report.totalTriangles} tris / ${report.totalVertices} verts`
        ).toBe(true);
        expect(report.totalTriangles).toBeGreaterThan(0);
      }
    }
  });

  it('partitions non-rectangular footprints too', () => {
    const hexagon: Polygon = [
      [-9, -6],
      [0, -9],
      [9, -6],
      [9, 6],
      [0, 9],
      [-9, 6],
    ];
    const build = makeBuilding(6, 'full', 77, hexagon);
    const report = verifyPartition(
      build.fracture,
      build.buffers.indexCount,
      build.buffers.vertexCount
    );
    expect(report.ok, JSON.stringify(report)).toBe(true);
  });

  it('holds after buildings merge into a block', () => {
    const generator = makeGenerator('full');
    let checked = 0;
    for (const [cx, cz] of SAMPLE_CHUNKS) {
      const chunk = generator.generate(cx, cz);
      for (const block of chunk.blocks) {
        if (block.buildings.length === 0) continue;
        const combined = combineLayouts(block.fractures);
        const report = verifyPartition(
          combined,
          block.geometry.buffers.indexCount,
          block.geometry.buffers.vertexCount
        );
        expect(
          report.ok,
          `${block.id}: dup=${report.duplicated} orphan=${report.orphaned} ` +
            `dupV=${report.duplicatedVertices} orphanV=${report.orphanedVertices}`
        ).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('keeps every chunk vertex range inside its own triangles', () => {
    // The debris path rebases indices by subtracting `vertexStart`; if a
    // chunk's triangles referenced a vertex outside its range that subtraction
    // would produce a negative index and the debris mesh would be garbage.
    const build = makeBuilding(8, 'full', 4242);
    for (const chunk of build.fracture.chunks) {
      for (const part of chunk.parts) {
        for (let i = part.start; i < part.start + part.count; i++) {
          const v = build.buffers.indices[i];
          expect(v).toBeGreaterThanOrEqual(chunk.vertexStart);
          expect(v).toBeLessThan(chunk.vertexStart + chunk.vertexCount);
        }
      }
    }
  });
});

describe('structural support', () => {
  it('normalises each floor to a support share summing to 1', () => {
    const build = makeBuilding(10, 'full', 31337);
    for (const floor of build.fracture.floors) {
      const sum = floor.chunks.reduce(
        (n, index) => n + build.fracture.chunks[index].supportShare,
        0
      );
      expect(sum).toBeCloseTo(1, 5);
    }
  });

  it('collapses a floor once more than 60% of its support is gone', () => {
    const build = makeBuilding(9, 'full', 5150);
    const destroyed = new Set<number>();
    const isDestroyed = (i: number) => destroyed.has(i);

    expect(remainingSupport(build.fracture, 3, isDestroyed)).toBeCloseTo(1, 5);
    expect(collapsingFloors(build.fracture, isDestroyed)).toEqual([]);

    // Take out three of floor 3's four quadrants: > 60% of the support.
    for (let q = 0; q < 3; q++) destroyed.add(3 * QUADRANTS + q);
    const remaining = remainingSupport(build.fracture, 3, isDestroyed);
    expect(remaining).toBeLessThan(build.fracture.collapseSupportRatio);

    const collapsing = collapsingFloors(build.fracture, isDestroyed);
    expect(collapsing[0]).toBe(3);
    // Everything above comes down with it.
    expect(collapsing).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it('grounds only the lowest storey', () => {
    const build = makeBuilding(5, 'full', 606);
    for (const chunk of build.fracture.chunks) {
      expect(chunk.grounded).toBe(chunk.floor === 0);
    }
  });

  it('links neighbours symmetrically within a floor and vertically between them', () => {
    const floors = 6;
    for (let f = 0; f < floors; f++) {
      for (let q = 0; q < QUADRANTS; q++) {
        for (const n of neighboursOf(f, q, floors)) {
          const nf = Math.floor(n / QUADRANTS);
          const nq = n % QUADRANTS;
          expect(neighboursOf(nf, nq, floors)).toContain(f * QUADRANTS + q);
        }
      }
    }
  });

  it('gives every chunk a positive mass and a real AABB', () => {
    const build = makeBuilding(7, 'full', 8080);
    for (const chunk of build.fracture.chunks) {
      expect(chunk.mass).toBeGreaterThan(0);
      expect(Number.isFinite(chunk.mass)).toBe(true);
      expect(chunk.aabb[3]).toBeGreaterThanOrEqual(chunk.aabb[0]);
      expect(chunk.aabb[4]).toBeGreaterThanOrEqual(chunk.aabb[1]);
      expect(chunk.aabb[5]).toBeGreaterThanOrEqual(chunk.aabb[2]);
      // The centroid must be inside the chunk's own bounds.
      expect(chunk.centroid[1]).toBeGreaterThanOrEqual(chunk.aabb[1] - 1e-3);
      expect(chunk.centroid[1]).toBeLessThanOrEqual(chunk.aabb[4] + 1e-3);
    }
  });
});
