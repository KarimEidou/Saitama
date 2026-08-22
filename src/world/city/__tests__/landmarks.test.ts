/**
 * LANDMARK GENERATORS
 *
 * The bespoke generators sit outside every other test in this directory:
 * `fracture.test.ts` samples chunks, and the arcade's chunk is not among them,
 * so the shotengai canopy — the single largest hand-authored object in the
 * district, 168 m of it down a street the player walks the length of — had no
 * coverage at all. What it needs asserted is what its own code cannot show:
 *
 *   • MASS. The canopy is one fracture chunk, so one punch detaches all of it.
 *     If its mass is a literal rather than volume x density, the whole street
 *     sails away like a sheet of paper and nothing in the physics layer can
 *     tell that it should not have.
 *   • UV DENSITY. Roof panels are the biggest single surface in the landmark;
 *     a transposed UV rectangle is invisible in code review and prints the
 *     panel texture across the street at the wrong scale and the wrong way up.
 *   • NOTHING FLOATING. Structure emitted at a fixed height under a sloping
 *     roof pokes through it, which reads as a bug from the pavement.
 */

import { describe, expect, it } from 'vitest';
import { generateLandmark } from '../landmarks';
import { CityGenerator } from '../city';
import { STRUCTURE_DENSITY } from '../fracture';
import { MATERIAL_TILE_SIZE, CITY_MATERIALS } from '../materials';
import { polygonBounds } from '../polygon';
import { CITY_Z_PLAN } from './fixtures';
import type { IPlanLandmark } from '../plan-types';

function landmark(id: string): IPlanLandmark {
  const found = CITY_Z_PLAN.landmarks.find((l) => l.id === id);
  if (!found) throw new Error(`no landmark ${id}`);
  return found;
}

describe('shotengai arcade', () => {
  const arcade = landmark('shotengai-arcade');
  const built = generateLandmark(arcade, CITY_Z_PLAN.planVersion, 'full');
  const build = built.buildings[0];

  it('weighs its own steel rather than a hard-coded 620 kg', () => {
    const layout = build.fracture;
    expect(layout.structureMaterial).toBe('metal');
    const chunk = layout.chunks[0];
    // Volume comes from `addVolume` on every member emitted; nothing called it
    // before, so `span.volume` was 0, `Math.max(1, 0)` was 1 m^3, and the
    // literal density it was multiplied by (620) was the density of WOOD.
    expect(chunk.volume).toBeGreaterThan(50);
    expect(chunk.mass).toBeCloseTo(chunk.volume * STRUCTURE_DENSITY.metal, 3);
    expect(layout.totalMass).toBeCloseTo(chunk.mass, 3);
    expect(layout.totalMass).toBeGreaterThan(100_000);
  });

  it('samples the roof panels at real-world density', () => {
    // UVs are metres over the tile size, so the mapping must be an isometry
    // scaled by 1 / tileSize: every triangle edge's UV length has to match its
    // length in metres. A transposed rectangle fails on both axes at once.
    const tile = MATERIAL_TILE_SIZE[CITY_MATERIALS.glass];
    expect(tile).toBeGreaterThan(0);
    const { positions, uvs, indices, groups } = build.buffers;
    const glass = groups.find((g) => g.slot === 1);
    expect(glass).toBeDefined();

    let edges = 0;
    for (let i = glass!.start; i < glass!.start + glass!.count; i += 3) {
      for (const [a, b] of [
        [indices[i], indices[i + 1]],
        [indices[i + 1], indices[i + 2]],
        [indices[i + 2], indices[i]],
      ]) {
        const metres = Math.hypot(
          positions[b * 3] - positions[a * 3],
          positions[b * 3 + 1] - positions[a * 3 + 1],
          positions[b * 3 + 2] - positions[a * 3 + 2]
        );
        if (metres < 0.05) continue;
        const tiles = Math.hypot(uvs[b * 2] - uvs[a * 2], uvs[b * 2 + 1] - uvs[a * 2 + 1]);
        expect(tiles * tile, `edge of ${metres.toFixed(2)} m`).toBeCloseTo(metres, 3);
        edges++;
      }
    }
    expect(edges).toBeGreaterThan(100);
  });

  it('keeps its structure under the roof it is supposed to hold up', () => {
    // The eaves are at 5.4 m and the ridge at 7.6 m, so a horizontal member at
    // the mid-height of the slope stands nearly a metre PROUD of the panel out
    // at the eaves — 56 dark bars floating over the glass down 168 m of street.
    const halfSpan = 9;
    const eaves = 5.4;
    const ridge = 7.6;
    const roofY = (x: number) => eaves + (ridge - eaves) * Math.max(0, 1 - Math.abs(x) / halfSpan);
    const { positions, vertexCount } = build.buffers;
    for (let v = 0; v < vertexCount; v++) {
      const x = positions[v * 3];
      const y = positions[v * 3 + 1];
      // 0.2 m of slack for the 0.28 m ridge beam, which straddles the apex.
      expect(y, `vertex at x=${x.toFixed(2)}`).toBeLessThanOrEqual(roofY(x) + 0.2);
    }
  });
});

describe('landmark placement', () => {
  it('rotates the published outline and AABB with the geometry', () => {
    // `mergeGeometries` yaws a landmark's buildings into place, but the block
    // wrapper only TRANSLATED the local footprint and AABB. At 45 degrees that
    // reports a box sqrt(2) too narrow on both axes for geometry that is
    // sitting right there, and publishes an outline that is simply the wrong
    // polygon. Every landmark in the committed plan is at rotationY 0, so this
    // is the only thing that would ever catch it.
    const target = landmark('saitama-apartment');
    const rotated = new CityGenerator(
      {
        ...CITY_Z_PLAN,
        landmarks: CITY_Z_PLAN.landmarks.map((l) =>
          l.id === target.id ? { ...l, rotationY: Math.PI / 4 } : l
        ),
      },
      { defaultDetail: 'box', includeProps: false }
    );
    const cx = Math.floor(target.position[0] / CITY_Z_PLAN.chunkSize);
    const cz = Math.floor(target.position[1] / CITY_Z_PLAN.chunkSize);
    const block = rotated.generate(cx, cz).blocks.find((b) => b.id === `landmark:${target.id}`);
    expect(block).toBeDefined();

    const { positions, vertexCount } = block!.geometry.buffers;
    for (let v = 0; v < vertexCount; v++) {
      expect(positions[v * 3]).toBeGreaterThanOrEqual(block!.bounds[0] - 1e-3);
      expect(positions[v * 3]).toBeLessThanOrEqual(block!.bounds[3] + 1e-3);
      expect(positions[v * 3 + 2]).toBeGreaterThanOrEqual(block!.bounds[2] - 1e-3);
      expect(positions[v * 3 + 2]).toBeLessThanOrEqual(block!.bounds[5] + 1e-3);
    }

    // The outline is the rotated footprint, so its box is wider than the
    // unrotated one by the rotation, not equal to it.
    const outline = polygonBounds(block!.outline);
    const local = polygonBounds(target.footprint);
    expect(outline.maxX - outline.minX).toBeGreaterThan((local.maxX - local.minX) * 1.1);
    for (const b of block!.buildings) {
      expect(b.rotationY).toBeCloseTo(Math.PI / 4, 6);
    }
  }, 30_000);
});
