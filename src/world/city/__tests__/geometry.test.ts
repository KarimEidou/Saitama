/**
 * GEOMETRY ORIENTATION AND SCALE
 *
 * Two classes of bug that no amount of reading catches and that a screenshot
 * only half catches:
 *
 *   1. INVERTED WINDING. The panel frame (along-wall, up, outward) is
 *      left-handed, so the "obvious" corner order produces walls whose normals
 *      point into the building. With backface culling on you see straight
 *      through the city; with it off you see a city lit from the inside. The
 *      fix is one swapped pair per emitter, which is exactly the kind of thing
 *      that gets undone by a later edit.
 *   2. WRONG UV DENSITY. Merged geometry cannot carry a per-material
 *      `uvRepeat`, so metres are converted to tile units at generation time. A
 *      factor-of-N error there is invisible in code review and turns brick
 *      into either wallpaper or a smear.
 *
 * `box` detail is used for the winding checks because it emits ONLY exterior
 * surfaces — no reveals, no parapet inner faces, no door leaves — so every
 * triangle has an unambiguous correct direction.
 */

import { describe, expect, it } from 'vitest';
import { generateBuilding } from '../building';
import { generateGround } from '../ground';
import { MatSlot } from '../mesh-builder';
import { CITY_MATERIALS, MATERIAL_TILE_SIZE, uvScaleFor } from '../materials';
import { indexPlan } from '../plan';
import {
  offsetPolygon,
  polygonArea,
  polygonCentroid,
  polygonPerimeter,
  triangulate,
  type Polygon,
} from '../polygon';
import { CITY_Z_PLAN } from './fixtures';

function box(w: number, d: number): Polygon {
  return [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [w / 2, d / 2],
    [-w / 2, d / 2],
  ];
}

function faceNormal(p: Float32Array, a: number, b: number, c: number): [number, number, number] {
  const ux = p[b * 3] - p[a * 3];
  const uy = p[b * 3 + 1] - p[a * 3 + 1];
  const uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[c * 3] - p[a * 3];
  const vy = p[c * 3 + 1] - p[a * 3 + 1];
  const vz = p[c * 3 + 2] - p[a * 3 + 2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

function centroidOf(p: Float32Array, a: number, b: number, c: number): [number, number, number] {
  return [
    (p[a * 3] + p[b * 3] + p[c * 3]) / 3,
    (p[a * 3 + 1] + p[b * 3 + 1] + p[c * 3 + 1]) / 3,
    (p[a * 3 + 2] + p[b * 3 + 2] + p[c * 3 + 2]) / 3,
  ];
}

const BASE_RECIPE = {
  floorHeight: 3.3,
  groundFloorScale: 1.25,
  style: 'apartment' as const,
  facadeMaterial: CITY_MATERIALS.wall.brickRed,
  roofMaterial: CITY_MATERIALS.roof.bitumen,
  glassMaterial: CITY_MATERIALS.glass,
  tint: 0xffffff,
  panelWeights: { blank: 1 },
  groundWeights: { blank: 1 },
  rooftopClutter: 0,
  parapetHeight: 0,
  litWindowChance: 0,
  structureMaterial: 'concrete' as const,
};

describe('face orientation', () => {
  it('points every exterior wall outward', () => {
    const build = generateBuilding({
      ...BASE_RECIPE,
      id: 'winding',
      footprint: box(20, 14),
      floors: 5,
      seed: 7,
      detail: 'box',
    });
    const { positions, indices, groups } = build.buffers;
    const facade = groups.find((g) => g.slot === MatSlot.Facade);
    expect(facade).toBeDefined();

    let walls = 0;
    for (let i = facade!.start; i < facade!.start + facade!.count; i += 3) {
      const n = faceNormal(positions, indices[i], indices[i + 1], indices[i + 2]);
      if (Math.abs(n[1]) > 0.5) continue; // slab / roof triangle
      const c = centroidOf(positions, indices[i], indices[i + 1], indices[i + 2]);
      // Local space is centred on the footprint, so "outward" is the radial
      // direction from the origin at that height.
      const len = Math.hypot(c[0], c[2]) || 1;
      const dot = (n[0] * c[0] + n[2] * c[2]) / len;
      expect(dot, `wall triangle at ${c.map((v) => v.toFixed(1)).join(',')} faces inward`).toBeGreaterThan(0.2);
      walls++;
    }
    expect(walls).toBeGreaterThan(20);
  });

  it('points roof decks and floor slabs upward', () => {
    const build = generateBuilding({
      ...BASE_RECIPE,
      id: 'roof-winding',
      footprint: box(18, 12),
      floors: 4,
      seed: 11,
      detail: 'box',
    });
    const { positions, indices, groups } = build.buffers;
    let horizontal = 0;
    for (const group of groups) {
      for (let i = group.start; i < group.start + group.count; i += 3) {
        const n = faceNormal(positions, indices[i], indices[i + 1], indices[i + 2]);
        if (Math.abs(n[1]) < 0.9) continue;
        expect(n[1], 'horizontal surface faces down').toBeGreaterThan(0);
        horizontal++;
      }
    }
    expect(horizontal).toBeGreaterThanOrEqual(build.floors * 2);
  });

  it('points the ground plane, sidewalks and markings upward', () => {
    const index = indexPlan(CITY_Z_PLAN);
    const blocks = index.blocksByChunk[(0 + 8) * 16 + (0 + 8)];
    const ground = generateGround({
      plan: CITY_Z_PLAN,
      chunkX: 0,
      chunkZ: 0,
      blocks,
      zones: blocks.map((b) => index.zoneOfBlock(b)),
      roads: index.roadsByChunk[(0 + 8) * 16 + (0 + 8)],
      craters: [],
      sidewalkWidth: blocks[0].sidewalk,
    });
    const { positions, indices } = ground.buffers;
    let up = 0;
    let down = 0;
    for (let i = 0; i < indices.length; i += 3) {
      const n = faceNormal(positions, indices[i], indices[i + 1], indices[i + 2]);
      if (n[1] > 0.9) up++;
      else if (n[1] < -0.9) down++;
    }
    expect(up).toBeGreaterThan(30);
    expect(down, 'ground surfaces facing down').toBe(0);
  });

  it('agrees with the stored vertex normals', () => {
    const build = generateBuilding({
      ...BASE_RECIPE,
      id: 'normals',
      footprint: box(16, 10),
      floors: 3,
      seed: 3,
      detail: 'box',
    });
    const { positions, normals, indices } = build.buffers;
    for (let i = 0; i < indices.length; i += 3) {
      const computed = faceNormal(positions, indices[i], indices[i + 1], indices[i + 2]);
      const stored = [
        normals[indices[i] * 3],
        normals[indices[i] * 3 + 1],
        normals[indices[i] * 3 + 2],
      ];
      const dot = computed[0] * stored[0] + computed[1] * stored[1] + computed[2] * stored[2];
      expect(dot).toBeGreaterThan(0.99);
    }
  });
});

describe('uv density', () => {
  it('converts metres to tile units at the material scale', () => {
    const material = CITY_MATERIALS.wall.brickRed;
    const tile = MATERIAL_TILE_SIZE[material];
    expect(tile).toBeGreaterThan(0);
    expect(uvScaleFor(material)).toBeCloseTo(1 / tile, 10);

    const width = 24;
    const build = generateBuilding({
      ...BASE_RECIPE,
      id: 'uv',
      facadeMaterial: material,
      footprint: box(width, width),
      floors: 3,
      seed: 5,
      detail: 'box',
    });
    // A wall spanning `width` metres must span `width / tile` UV units.
    const { uvs } = build.buffers;
    let minU = Infinity;
    let maxU = -Infinity;
    for (let i = 0; i < uvs.length; i += 2) {
      if (uvs[i] < minU) minU = uvs[i];
      if (uvs[i] > maxU) maxU = uvs[i];
    }
    expect(maxU - minU).toBeGreaterThan(width / tile / 2);
  });

  it('scales every referenced material with a real tile size', () => {
    for (const [id, tile] of Object.entries(MATERIAL_TILE_SIZE)) {
      expect(tile, id).toBeGreaterThan(0);
      expect(tile, id).toBeLessThan(64);
    }
  });
});

describe('polygon utilities', () => {
  it('measures area, centroid and perimeter', () => {
    const square: Polygon = [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ];
    expect(polygonArea(square)).toBeCloseTo(16);
    expect(polygonCentroid(square)).toEqual([2, 2]);
    expect(polygonPerimeter(square)).toBeCloseTo(16);
  });

  it('offsets inward for positive distances and outward for negative', () => {
    const square: Polygon = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    expect(polygonArea(offsetPolygon(square, 1))).toBeCloseTo(64);
    expect(polygonArea(offsetPolygon(square, -1))).toBeCloseTo(144);
  });

  it('triangulates a ring into n-2 triangles covering its area', () => {
    const ring: Polygon = [
      [0, 0],
      [6, 0],
      [8, 4],
      [6, 8],
      [0, 8],
      [-2, 4],
    ];
    const tris = triangulate(ring);
    expect(tris.length / 3).toBe(ring.length - 2);
    let area = 0;
    for (let i = 0; i < tris.length; i += 3) {
      const a = ring[tris[i]];
      const b = ring[tris[i + 1]];
      const c = ring[tris[i + 2]];
      area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) * 0.5;
    }
    expect(area).toBeCloseTo(Math.abs(polygonArea(ring)), 5);
  });
});
