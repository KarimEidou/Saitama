/**
 * PRECOMPUTED VISIBILITY — STRUCTURE, CONSERVATISM AND MEASURED CULL RATE
 *
 * Three things have to hold for a PVS to be shippable, and they are checked in
 * increasing order of difficulty:
 *
 *  1. Structure — 8 KB, symmetric, every chunk sees itself and its ring.
 *  2. Conservatism — no false negatives against point-to-point ground truth.
 *     A false positive costs draw calls; a false negative deletes a building
 *     from in front of the player.
 *  3. Payoff — the cull rate it actually achieves on a grid city, measured
 *     rather than asserted, because a perfectly correct PVS that removes
 *     nothing is not worth 8 KB or the build time.
 */

import { describe, it, expect } from 'vitest';
import { buildPvs, PvsTable, groundTruthVisible } from '../pvs';
import { Quadtree } from '../quadtree';
import { Frustum, composeViewProjection } from '../frustum';
import { IndexList } from '../index-list';
import { generateSyntheticCity, sampleStreetCameras } from '../synthetic-city';
import { measureCullRates, formatCullReport } from '../diagnostics';
import {
  CHUNK_COUNT,
  CHUNK_GRID,
  PVS_MASK_WORDS,
  PVS_TOTAL_BYTES,
  chunkIndex,
  chunkChebyshev,
} from '../constants';
import { createRng } from '@/util';

const city = generateSyntheticCity();
const pvs = buildPvs(city.footprints, { rayCount: 128, originSamples: 9 });

function buildCityTree(): Quadtree {
  const tree = new Quadtree({ initialCapacity: city.instances.length });
  for (const instance of city.instances) {
    tree.insert(
      instance.minX,
      instance.minY,
      instance.minZ,
      instance.maxX,
      instance.maxY,
      instance.maxZ,
      instance
    );
  }
  tree.pack();
  return tree;
}

describe('Synthetic city fixture', () => {
  it('lays out a grid city at City Z dimensions', () => {
    expect(city.buildingCount).toBeGreaterThan(800);
    expect(city.instances.length).toBe(city.buildingCount + city.propCount);
    expect(city.footprints.length).toBe(city.buildingCount);
    expect(city.streetPoints.length).toBe(CHUNK_COUNT * 4);
    // Some chunks are parks, but the city must be mostly built up or the PVS
    // measurement below would be meaningless.
    expect(city.parkChunks.length).toBeLessThan(CHUNK_COUNT * 0.25);
  });

  it('regenerates identically from the same seed', () => {
    const again = generateSyntheticCity();
    expect(again.instances.length).toBe(city.instances.length);
    expect(JSON.stringify(again.footprints)).toBe(JSON.stringify(city.footprints));
  });
});

describe('PVS structure', () => {
  it('is exactly 8 KB of masks for 256 chunks', () => {
    expect(pvs.masks.length).toBe(CHUNK_COUNT * PVS_MASK_WORDS);
    expect(pvs.masks.byteLength).toBe(PVS_TOTAL_BYTES);
    expect(pvs.masks.byteLength).toBe(8192);
  });

  it('lets every chunk see itself and its whole 3x3 ring', () => {
    for (let c = 0; c < CHUNK_COUNT; c++) {
      expect(pvs.isVisible(c, c), `chunk ${c} cannot see itself`).toBe(true);
    }
    for (let c = 0; c < CHUNK_COUNT; c++) {
      const cx = c % CHUNK_GRID;
      const cz = (c / CHUNK_GRID) | 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const nz = cz + dz;
          if (nx < 0 || nx >= CHUNK_GRID || nz < 0 || nz >= CHUNK_GRID) continue;
          expect(pvs.isVisible(c, nz * CHUNK_GRID + nx)).toBe(true);
        }
      }
    }
  });

  it('is symmetric — visibility is a physical relation, not a viewpoint', () => {
    expect(pvs.isSymmetric()).toBe(true);
  });

  it('actually occludes: no chunk sees the whole city', () => {
    const stats = pvs.stats();
    console.log(
      `[pvs] built in ${stats.buildMs.toFixed(0)} ms, ${stats.bytes} bytes, ` +
        `visible per chunk min ${stats.minVisible} / mean ${stats.averageVisible.toFixed(1)} / ` +
        `max ${stats.maxVisible} of ${CHUNK_COUNT}, ` +
        `pairwise occlusion ${(stats.occlusionRate * 100).toFixed(1)}%`
    );
    expect(stats.maxVisible).toBeLessThan(CHUNK_COUNT);
    expect(stats.minVisible).toBeGreaterThanOrEqual(4);
    expect(stats.occlusionRate).toBeGreaterThan(0.2);
  });

  it('enumerates the same set that isVisible reports', () => {
    const out = new IndexList(CHUNK_COUNT);
    const rng = createRng('pvs-enumerate');
    for (let i = 0; i < 24; i++) {
      const from = rng.int(0, CHUNK_COUNT - 1);
      pvs.collectVisible(from, out);
      expect(out.length).toBe(pvs.visibleCount(from));
      const listed = new Set(out.toArray());
      for (let to = 0; to < CHUNK_COUNT; to++) {
        expect(listed.has(to)).toBe(pvs.isVisible(from, to));
      }
    }
  });

  it('survives a serialise / deserialise round trip', () => {
    const bytes = pvs.serialize();
    expect(bytes.length).toBe(PVS_TOTAL_BYTES + 16);
    const restored = PvsTable.deserialize(bytes);
    expect(Array.from(restored.masks)).toEqual(Array.from(pvs.masks));

    // A corrupted payload must be rejected, not silently mis-culled.
    const corrupt = bytes.slice();
    corrupt[100] = corrupt[100]! ^ 0xff;
    expect(() => PvsTable.deserialize(corrupt)).toThrow(/checksum/);
    expect(() => PvsTable.deserialize(bytes.slice(0, 40))).toThrow();
  });

  it('falls back safely to everything-visible', () => {
    const open = PvsTable.everythingVisible();
    for (let i = 0; i < 64; i++) {
      expect(open.isVisible(i, (i * 7 + 3) % CHUNK_COUNT)).toBe(true);
    }
    // Out-of-range indices must never cause a cull.
    expect(pvs.isVisible(-1, 5)).toBe(true);
    expect(pvs.isVisible(5, 999)).toBe(true);
  });
});

describe('PVS conservatism', () => {
  it('has no false negatives against point-to-point ground truth', () => {
    // Ground truth is O(n^4) segment tests per pair, so a seeded sample of
    // pairs is audited rather than all 65,536 — weighted towards mid-range
    // pairs, where occlusion decisions are actually being made.
    const rng = createRng('pvs-audit');
    let audited = 0;
    let trulyVisible = 0;
    let falseNegatives = 0;
    let conservativePositives = 0;

    for (let i = 0; i < 700; i++) {
      const from = rng.int(0, CHUNK_COUNT - 1);
      const to = rng.int(0, CHUNK_COUNT - 1);
      if (from === to) continue;
      const distance = chunkChebyshev(from, to);
      if (distance > 6) continue;

      audited++;
      const truth = groundTruthVisible(city.footprints, from, to, 6);
      const claimed = pvs.isVisible(from, to);
      if (truth) {
        trulyVisible++;
        if (!claimed) falseNegatives++;
      } else if (claimed) {
        conservativePositives++;
      }
    }

    console.log(
      `[pvs audit] ${audited} chunk pairs, ${trulyVisible} genuinely visible, ` +
        `${falseNegatives} false negatives, ` +
        `${conservativePositives} conservative false positives`
    );
    expect(audited).toBeGreaterThan(100);
    expect(trulyVisible).toBeGreaterThan(20);
    expect(falseNegatives).toBe(0);
  });

  it('is deterministic for a given seed and geometry', () => {
    const again = buildPvs(city.footprints, { rayCount: 128, originSamples: 9 });
    expect(Array.from(again.masks)).toEqual(Array.from(pvs.masks));

    // A different seed changes the sampling but not the structural invariants.
    const other = buildPvs(city.footprints, { rayCount: 128, originSamples: 9, seed: 12345 });
    expect(other.isSymmetric()).toBe(true);
    for (let c = 0; c < CHUNK_COUNT; c++) expect(other.isVisible(c, c)).toBe(true);
  });

  it('marks everything visible when there is nothing to occlude', () => {
    const open = buildPvs([], { rayCount: 128, originSamples: 1 });
    // With no footprints every ray runs to the world edge, so the table should
    // be close to fully dense; the corners are the only places 128 rays can
    // miss a chunk entirely.
    const stats = open.stats();
    expect(stats.averageVisible).toBeGreaterThan(CHUNK_COUNT * 0.95);
  });
});

describe('PVS payoff on a grid city', () => {
  const tree = buildCityTree();
  const cameras = sampleStreetCameras(city, 220);

  /**
   * Cull rates across draw distances.
   *
   * The PVS's value GROWS with draw distance, and the reason is worth stating:
   * frustum culling already removes 97% of a 1536 m city at a 300 m far plane,
   * so there is little left for anything else to remove. Push the far plane
   * out and the frustum keeps a large wedge of the map while the set of chunks
   * a street-level viewer can actually see barely changes — that gap is what
   * the PVS collects.
   *
   * These numbers are measured on the harshest possible layout for a 2D PVS: a
   * perfectly regular grid whose 16 m avenues run unbroken across all 1536 m,
   * so a viewer at any intersection genuinely sees to the world edge in four
   * directions. Any irregularity — a superblock, a jog in a street, a collapsed
   * building — only adds occlusion.
   */
  const DISTANCES = [
    { far: 300, fov: 60, aspect: 900 / 1600, label: 'mobile portrait 300 m' },
    { far: 500, fov: 70, aspect: 16 / 9, label: 'landscape 500 m' },
    { far: 900, fov: 70, aspect: 16 / 9, label: 'landscape 900 m' },
  ];

  it('eliminates a growing fraction of what frustum culling keeps', () => {
    const eliminations: number[] = [];

    for (const lens of DISTANCES) {
      const report = measureCullRates(tree, pvs, cameras, {
        fovDegrees: lens.fov,
        aspect: lens.aspect,
        near: 0.3,
        far: lens.far,
      });
      console.log(`\n[pvs cull rates — ${lens.label}]\n` + formatCullReport(report));

      expect(report.samples).toBe(cameras.length);
      expect(report.occupiedChunks).toBeGreaterThan(200);
      // The PVS is a filter on top of the frustum: it can only ever remove.
      expect(report.chunksAfterPvs).toBeLessThanOrEqual(report.chunksAfterFrustum);
      expect(report.instancesAfterPvs).toBeLessThanOrEqual(report.instancesAfterFrustum);
      eliminations.push(report.pvsEliminationRate);
    }

    // Frustum culling alone is already removing the bulk of the world.
    expect(eliminations.length).toBe(3);
    // The PVS adds a real, measurable reduction at every distance...
    for (const rate of eliminations) expect(rate).toBeGreaterThan(0.1);
    // ...and its value increases monotonically with draw distance.
    expect(eliminations[1]!).toBeGreaterThan(eliminations[0]!);
    expect(eliminations[2]!).toBeGreaterThan(eliminations[1]!);
    // At a long draw distance it must remove the majority of the survivors.
    expect(eliminations[2]!).toBeGreaterThan(0.5);
  });

  it('never removes an instance the frustum-only cull would have kept and drawn', () => {
    // A PVS cull is a subset of a frustum cull, always. If this ever fails the
    // renderer is dropping geometry the camera can see.
    const frustumOnly = new IndexList(4096);
    const withPvs = new IndexList(4096);
    const frustum = new Frustum();
    const matrix = new Float64Array(16);

    for (const cam of cameras.slice(0, 60)) {
      composeViewProjection(
        matrix,
        cam.x,
        cam.y,
        cam.z,
        cam.yaw,
        cam.pitch,
        (60 * Math.PI) / 180,
        900 / 1600,
        0.3,
        300
      );
      frustum.setFromViewProjection(matrix);
      tree.cullFrustum(frustum, frustumOnly);
      tree.cullFrustum(frustum, withPvs, undefined, pvs, cam.chunk);

      const kept = new Set(frustumOnly.toArray());
      for (let i = 0; i < withPvs.length; i++) {
        expect(kept.has(withPvs.at(i))).toBe(true);
      }
      expect(withPvs.length).toBeLessThanOrEqual(frustumOnly.length);
    }
  });
});

describe('Chunk addressing', () => {
  it('round-trips signed coords through dense indices', () => {
    let seen = 0;
    for (let cz = -8; cz <= 7; cz++) {
      for (let cx = -8; cx <= 7; cx++) {
        const index = chunkIndex(cx, cz);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(CHUNK_COUNT);
        seen++;
      }
    }
    expect(seen).toBe(CHUNK_COUNT);
    expect(chunkIndex(-9, 0)).toBe(-1);
    expect(chunkIndex(8, 0)).toBe(-1);
  });
});
