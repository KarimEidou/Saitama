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
import { MatSlot, MeshBuilder } from '../mesh-builder';
import { CITY_MATERIALS, MATERIAL_TILE_SIZE, uvScaleFor } from '../materials';
import { indexPlan } from '../plan';
import {
  offsetPolygon,
  polygonArea,
  polygonCentroid,
  polygonPerimeter,
  resampleSpline,
  triangulate,
  type Polygon,
} from '../polygon';
import { CITY_Z_PLAN, SAMPLE_CHUNKS, makeGenerator } from './fixtures';
import { CHUNK_SIZE } from '../../../spatial/constants';

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
      expect(
        dot,
        `wall triangle at ${c.map((v) => v.toFixed(1)).join(',')} faces inward`
      ).toBeGreaterThan(0.2);
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

  it('welds the crater bowl at every ring and segment seam', () => {
    // The rubble jitter has to be a property of the LATTICE POINT. Drawn per
    // quad, the two quads either side of a seam put the same XZ position at
    // two different heights — a 0.6 m crack at every one of the ~370 internal
    // seams, and a physics proxy with holes in it.
    const generator = makeGenerator('box');
    const ground = generator.generate(5, 1).ground!;
    const { positions, vertexCount } = ground.buffers;
    const heights = new Map<string, number>();
    let shared = 0;
    for (let v = 0; v < vertexCount; v++) {
      const y = positions[v * 3 + 1];
      const key = `${positions[v * 3].toFixed(4)},${positions[v * 3 + 2].toFixed(4)}`;
      const seen = heights.get(key);
      if (seen === undefined) heights.set(key, y);
      else {
        expect(y, `two heights at ${key}`).toBeCloseTo(seen, 6);
        shared++;
      }
    }
    // The bowl is a lattice, so most of its vertices are shared.
    expect(shared).toBeGreaterThan(100);
  }, 30_000);

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

  it('runs U as a continuous distance along a wall, not mirrored per quad', () => {
    // `MeshBuilder.quad` maps corner `a` to (u0, v0), and a wall quad's corner
    // `a` is its FAR corner — so handing the UV rectangle over in u0..u1 order
    // mirrors the texture about each quad's midpoint. The global U range stays
    // the same, which is why the density test above cannot see it; what breaks
    // is continuity, and every 2.4 m panel seam then jumps by twice the panel
    // width in tile units.
    const material = CITY_MATERIALS.wall.brickRed;
    const scale = uvScaleFor(material);
    const build = generateBuilding({
      ...BASE_RECIPE,
      id: 'uv-continuity',
      facadeMaterial: material,
      footprint: box(20, 14),
      floors: 3,
      parapetHeight: 0.9,
      seed: 19,
      // `reduced` keeps the wall plane clear of downpipes and window frames,
      // so every surviving vertex there belongs to a wall quad or the parapet.
      detail: 'reduced',
    });
    const { positions, normals, uvs, indices, groups } = build.buffers;
    const facade = groups.find((g) => g.slot === MatSlot.Facade)!;
    // South wall: the edge runs from x = -10 to x = +10 at z = -7, so a vertex
    // at x carries the texel for (x + 10) metres along the edge.
    let checked = 0;
    for (let i = facade.start; i < facade.start + facade.count; i++) {
      const v = indices[i];
      if (Math.abs(positions[v * 3 + 2] + 7) > 1e-6) continue;
      if (normals[v * 3 + 2] > -0.9) continue;
      const expected = (positions[v * 3] + 10) * scale;
      expect(uvs[v * 2], `vertex ${v} at x=${positions[v * 3]}`).toBeCloseTo(expected, 5);
      checked++;
    }
    expect(checked).toBeGreaterThan(40);
  });

  it('gives every box face the texel of its own world coordinate', () => {
    // Box UVs are world-planar, so two boxes sharing a plane only line up if
    // each corner takes su() of its OWN coordinate; three of the six faces
    // wind backwards and had the pair handed to them in min..max order.
    const builder = new MeshBuilder(1);
    builder.beginChunk();
    builder.box(0, 3, 2, -5, 1.5, 0.5, 2.5, 0.25);
    builder.endChunk();
    const { positions, normals, uvs, vertexCount } = builder.build();
    expect(vertexCount).toBe(24);
    for (let v = 0; v < vertexCount; v++) {
      const [x, y, z] = [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]];
      const n = [normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]];
      // +-X faces map (z, y); +-Y map (x, z); +-Z map (x, y).
      const [eu, ev] = Math.abs(n[0]) > 0.5 ? [z, y] : Math.abs(n[1]) > 0.5 ? [x, z] : [x, y];
      expect(uvs[v * 2], `vertex ${v} u`).toBeCloseTo(eu * 0.25, 6);
      expect(uvs[v * 2 + 1], `vertex ${v} v`).toBeCloseTo(ev * 0.25, 6);
    }
  });

  it('scales every referenced material with a real tile size', () => {
    for (const [id, tile] of Object.entries(MATERIAL_TILE_SIZE)) {
      expect(tile, id).toBeGreaterThan(0);
      expect(tile, id).toBeLessThan(64);
    }
  });
});

describe('facade coverage', () => {
  it('leaves no hole in a shopfront bay', () => {
    // "It produces a city you can see straight through from outside" is this
    // module's own warning, and the shopfront had two of them: a full-width
    // 8 cm transom band between the glazing head and the fascia, and a 5 cm
    // slot at each end of the fascia where nothing was emitted at all. Both
    // show the skybox, since every interior face is backfacing.
    const width = 2.4;
    const depth = 8;
    const build = generateBuilding({
      ...BASE_RECIPE,
      id: 'shopfront-coverage',
      footprint: box(width, depth),
      floors: 1,
      floorHeight: 3.2,
      groundFloorScale: 1.5,
      groundWeights: { shopfront: 1 },
      seed: 23,
      // `reduced` drops the awning and the reveal, so nothing accidentally
      // covers a hole from outside and the test measures the wall itself.
      detail: 'reduced',
    });
    const { positions, indices } = build.buffers;

    // Triangles on the south wall (z = -depth/2) that face the street.
    const tris: [number, number][][] = [];
    for (let i = 0; i < indices.length; i += 3) {
      const v = [indices[i], indices[i + 1], indices[i + 2]];
      if (v.some((k) => Math.abs(positions[k * 3 + 2] + depth / 2) > 0.2)) continue;
      const n = faceNormal(positions, v[0], v[1], v[2]);
      if (n[2] > -0.5) continue;
      tris.push(v.map((k) => [positions[k * 3], positions[k * 3 + 1]] as [number, number]));
    }
    expect(tris.length).toBeGreaterThan(4);

    const inside = (p: [number, number], t: [number, number][]): boolean => {
      const side = (a: [number, number], b: [number, number]) =>
        (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
      const d = [side(t[0], t[1]), side(t[1], t[2]), side(t[2], t[0])];
      return d.every((v) => v >= -1e-9) || d.every((v) => v <= 1e-9);
    };

    const height = 3.2 * 1.5;
    const holes: string[] = [];
    for (let ix = 0; ix <= 24; ix++) {
      for (let iy = 0; iy <= 40; iy++) {
        const x = -width / 2 + 0.01 + ((width - 0.02) * ix) / 24;
        const y = 0.01 + ((height - 0.02) * iy) / 40;
        if (!tris.some((t) => inside([x, y], t))) holes.push(`${x.toFixed(2)},${y.toFixed(2)}`);
      }
    }
    expect(holes.slice(0, 8).join(' ')).toBe('');
  });
});

describe('bounds', () => {
  it('covers the rooftop plant and the facade projections, not just the footprint', () => {
    // The mast is the tallest thing on a building and the whole reason the
    // roofline reads; a footprint-derived AABB says it is not there, and every
    // culler and spatial index downstream folds that box up unchanged.
    let sawPlantAboveParapet = false;
    for (const seed of [3, 11, 29, 47, 91]) {
      const build = generateBuilding({
        ...BASE_RECIPE,
        id: `bounds-${seed}`,
        footprint: box(22, 16),
        floors: 9,
        rooftopClutter: 1,
        parapetHeight: 0.9,
        seed,
        detail: 'full',
      });
      const { positions, vertexCount } = build.buffers;
      const b = build.bounds;
      for (let v = 0; v < vertexCount; v++) {
        expect(positions[v * 3]).toBeGreaterThanOrEqual(b[0] - 1e-4);
        expect(positions[v * 3 + 1]).toBeGreaterThanOrEqual(b[1] - 1e-4);
        expect(positions[v * 3 + 2]).toBeGreaterThanOrEqual(b[2] - 1e-4);
        expect(positions[v * 3]).toBeLessThanOrEqual(b[3] + 1e-4);
        expect(positions[v * 3 + 1]).toBeLessThanOrEqual(b[4] + 1e-4);
        expect(positions[v * 3 + 2]).toBeLessThanOrEqual(b[5] + 1e-4);
      }
      if (b[4] > build.height + 0.9 + 1e-3) sawPlantAboveParapet = true;
    }
    expect(sawPlantAboveParapet, 'no sampled building reported plant above its parapet').toBe(true);
  });

  it('keeps a chunk of ground inside the chunk it belongs to', () => {
    // Road markings are painted from the road GRAPH, and `ctx.roads` holds
    // every road whose padded box touches the chunk — the committed plan's
    // segments are 768 m long. Unclipped, one chunk's ground carried stripes
    // running most of the way across the district, which put an ~800 m
    // bounding sphere on a 96 m mesh and made the chunk AABB a fiction.
    const generator = makeGenerator('box');
    for (const [cx, cz] of SAMPLE_CHUNKS) {
      const ground = generator.generate(cx, cz).ground!;
      const slack = 30; // zebra crossings reach out to the junction radius
      expect(ground.bounds[0], `chunk ${cx},${cz} minX`).toBeGreaterThan(cx * CHUNK_SIZE - slack);
      expect(ground.bounds[2], `chunk ${cx},${cz} minZ`).toBeGreaterThan(cz * CHUNK_SIZE - slack);
      expect(ground.bounds[3], `chunk ${cx},${cz} maxX`).toBeLessThan(
        (cx + 1) * CHUNK_SIZE + slack
      );
      expect(ground.bounds[5], `chunk ${cx},${cz} maxZ`).toBeLessThan(
        (cz + 1) * CHUNK_SIZE + slack
      );
    }
  }, 30_000);

  it('reports a chunk AABB that contains everything the chunk drew', () => {
    const generator = makeGenerator('box');
    // (1, -5) owns the 168 m shotengai arcade, whose canopy runs 72 m past the
    // chunk's own square.
    for (const [cx, cz] of [...SAMPLE_CHUNKS, [1, -5] as const]) {
      const chunk = generator.generate(cx, cz);
      for (const block of chunk.blocks) {
        expect(block.bounds[0], `${block.id} minX`).toBeGreaterThanOrEqual(chunk.bounds[0] - 1e-6);
        expect(block.bounds[2], `${block.id} minZ`).toBeGreaterThanOrEqual(chunk.bounds[2] - 1e-6);
        expect(block.bounds[3], `${block.id} maxX`).toBeLessThanOrEqual(chunk.bounds[3] + 1e-6);
        expect(block.bounds[4], `${block.id} maxY`).toBeLessThanOrEqual(chunk.bounds[4] + 1e-6);
        expect(block.bounds[5], `${block.id} maxZ`).toBeLessThanOrEqual(chunk.bounds[5] + 1e-6);
      }
    }
  }, 30_000);
});

describe('mesh builder', () => {
  it('gives an empty chunk a real centroid rather than NaN', () => {
    // `generateBuilding` opens a chunk per (floor, quadrant) unconditionally,
    // so a footprint degenerate in one axis leaves one empty — and a NaN
    // centroid becomes a NaN rigid-body translation the moment it is punched.
    const builder = new MeshBuilder(1);
    builder.beginChunk();
    const span = builder.endChunk();
    expect(span.vertexCount).toBe(0);
    for (const v of span.centroid) expect(Number.isFinite(v)).toBe(true);
    expect(span.centroid).toEqual([0, 0, 0]);
    expect(span.bounds).toEqual([0, 0, 0, 0, 0, 0]);
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

  it('resamples a spline without overshooting unevenly spaced control points', () => {
    // The centripetal parameterisation exists for exactly this input: with the
    // uniform basis the short-then-long transition swings the curve 2.2 m past
    // the last control point (and loops back on itself at finer spacing),
    // which in a road graph is a carriageway that crosses itself.
    const control: Polygon = [
      [0, 0],
      [1, 0],
      [40, 0],
      [41, 6],
    ];
    const out = resampleSpline(control, 1);
    expect(out[0]).toEqual(control[0]);
    expect(out[out.length - 1]).toEqual(control[control.length - 1]);
    for (const p of out) {
      expect(p[0]).toBeGreaterThan(-0.25);
      expect(p[0]).toBeLessThan(41.25);
      expect(p[1]).toBeLessThan(6.25);
    }
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
