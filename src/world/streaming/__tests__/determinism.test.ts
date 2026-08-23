/**
 * DETERMINISM
 *
 * The load-order independence the whole streaming design rests on. If a chunk's
 * content depends on when it was generated, then every other guarantee in this
 * workstream is void: damage bits point at the wrong masonry, two devices in
 * the same session disagree about where a wall is, and a save file is a lie.
 *
 * These tests check the property directly rather than checking that the RNG was
 * used "correctly", because the bug this prevents is always an accidental
 * dependency — a cached value, a shared generator, a `Math.random` — and only a
 * differential test catches those.
 */

import { describe, expect, it } from 'vitest';
import { buildChunkGeometry, buildImpostorGeometry } from '../chunk-geometry';
import { layoutChunk } from '../chunk-layout';
import { damageSlot } from '../damage-state';
import {
  DAMAGE_WORDS_PER_CHUNK,
  FRACTURE_HEIGHT_BANDS,
  FRACTURE_PLAN_DIVISIONS,
  RING_R0,
  RING_R1,
  RING_R2,
} from '../constants';

const SEED = 0x0c17972;

function maskWith(slots: readonly number[]): Uint32Array {
  const mask = new Uint32Array(DAMAGE_WORDS_PER_CHUNK);
  for (const slot of slots) mask[slot >>> 5] = (mask[slot >>> 5]! | (1 << (slot & 31))) >>> 0;
  return mask;
}

describe('chunk determinism', () => {
  it('produces byte-identical geometry for the same seed and address', () => {
    const a = buildChunkGeometry(SEED, -3, 4, RING_R0, undefined);
    const b = buildChunkGeometry(SEED, -3, 4, RING_R0, undefined);

    expect(a.contentHash).toBe(b.contentHash);
    expect(a.buffers.vertexCount).toBe(b.buffers.vertexCount);
    expect(Array.from(a.buffers.positions)).toEqual(Array.from(b.buffers.positions));
    expect(Array.from(a.buffers.indices)).toEqual(Array.from(b.buffers.indices));
    expect(Array.from(a.buffers.colors)).toEqual(Array.from(b.buffers.colors));
  });

  it('does not depend on generation order', () => {
    const forward = [
      buildChunkGeometry(SEED, 0, 0, RING_R0, undefined).contentHash,
      buildChunkGeometry(SEED, 1, 0, RING_R0, undefined).contentHash,
      buildChunkGeometry(SEED, 2, 0, RING_R0, undefined).contentHash,
    ];
    // Same three chunks, generated back to front, interleaved with unrelated
    // work that would perturb any shared generator.
    buildChunkGeometry(SEED, -7, -7, RING_R2, undefined);
    const backward = [
      buildChunkGeometry(SEED, 2, 0, RING_R0, undefined).contentHash,
      buildChunkGeometry(SEED, 1, 0, RING_R0, undefined).contentHash,
      buildChunkGeometry(SEED, 0, 0, RING_R0, undefined).contentHash,
    ].reverse();

    expect(backward).toEqual(forward);
  });

  it('gives different seeds different cities', () => {
    const a = buildChunkGeometry(SEED, 0, 0, RING_R0, undefined);
    const b = buildChunkGeometry(SEED + 1, 0, 0, RING_R0, undefined);
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it('keeps the layout identical across LOD rings', () => {
    // The rings emit different geometry for the SAME buildings. If the layout
    // itself moved with the ring, a chunk would visibly rearrange as the player
    // walked towards it.
    const layout = layoutChunk(SEED, 2, -5);
    const r0 = buildChunkGeometry(SEED, 2, -5, RING_R0, undefined);
    const r1 = buildChunkGeometry(SEED, 2, -5, RING_R1, undefined);
    const r2 = buildChunkGeometry(SEED, 2, -5, RING_R2, undefined);

    expect(r0.standingBuildings).toBe(layout.buildings.length);
    expect(r1.standingBuildings).toBe(layout.buildings.length);
    expect(r2.standingBuildings).toBe(layout.buildings.length);
    // Detail must fall monotonically as the ring gets coarser.
    expect(r0.buffers.vertexCount).toBeGreaterThan(r1.buffers.vertexCount);
    expect(r1.buffers.vertexCount).toBeGreaterThan(r2.buffers.vertexCount);
  });

  it('is deterministic with damage applied', () => {
    // Chunk (-1, 0) is a downtown block with nine buildings. Damage tests must
    // pick a chunk that actually HAS masonry to remove — the world contains
    // parks, and "nothing changed" would pass vacuously in one.
    const slots = [damageSlot(0, 0), damageSlot(0, 5), damageSlot(1, 12)];
    const a = buildChunkGeometry(SEED, -1, 0, RING_R0, maskWith(slots));
    const b = buildChunkGeometry(SEED, -1, 0, RING_R0, maskWith(slots));
    expect(a.contentHash).toBe(b.contentHash);

    const pristine = buildChunkGeometry(SEED, -1, 0, RING_R0, undefined);
    expect(pristine.standingBuildings).toBe(9);
    expect(a.contentHash).not.toBe(pristine.contentHash);
    expect(a.buffers.vertexCount).toBeLessThan(pristine.buffers.vertexCount);
  });

  it('does not leave a parapet floating over a destroyed roof quadrant', () => {
    // Chunk (-1, 0) is the nine-tower downtown block. Destroy ONLY the top
    // band's +X/+Z plan cell of building 0: three cells of that band survive, so
    // `survivingHeight` is unchanged and the parapet is still emitted at the
    // full height. The question is whether it covers the hole.
    const topBand = FRACTURE_HEIGHT_BANDS - 1;
    const topCell =
      topBand * FRACTURE_PLAN_DIVISIONS * FRACTURE_PLAN_DIVISIONS + 1 * FRACTURE_PLAN_DIVISIONS + 1;
    const built = buildChunkGeometry(SEED, -1, 0, RING_R0, maskWith([damageSlot(0, topCell)]));

    const building = layoutChunk(SEED, -1, 0).buildings[0]!;
    const midX = (building.minX + building.maxX) * 0.5;
    const midZ = (building.minZ + building.maxZ) * 0.5;
    const bandTop = (building.height / FRACTURE_HEIGHT_BANDS) * topBand;

    // The buffer holds the whole chunk, so the window is clamped to building 0's
    // own footprint (plus the parapet's 0.25 m overhang and the 0.06 m a window
    // pane stands proud) — otherwise every neighbouring tower to the +X/+Z is
    // swept up and the case fails vacuously.
    const margin = 0.3;
    const p = built.buffers.positions;
    let sampled = 0;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i]!;
      const z = p[i + 2]!;
      if (x <= midX + 1e-3 || x > building.maxX + margin) continue;
      if (z <= midZ + 1e-3 || z > building.maxZ + margin) continue;
      // Nothing may sit above the destroyed cell's floor in that quadrant.
      expect(p[i + 1]!).toBeLessThanOrEqual(bandTop + 1e-3);
      sampled++;
    }
    // The quadrant is not empty: the surviving bands below it are still there,
    // so an assertion that never ran would be the real failure.
    expect(sampled).toBeGreaterThan(0);
  });

  it('bakes the same impostor ring every time', () => {
    const a = buildImpostorGeometry(SEED);
    const b = buildImpostorGeometry(SEED);
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.buildingCount).toBe(b.buildingCount);
    expect(a.buffers.vertexCount).toBe(b.buffers.vertexCount);
    expect(Array.from(a.chunkIds)).toEqual(Array.from(b.chunkIds));
  });

  it('tags every impostor vertex with a chunk id', () => {
    const impostor = buildImpostorGeometry(SEED);
    expect(impostor.chunkIds.length).toBe(impostor.buffers.vertexCount);
    // The first four vertices are the world ground quad, never suppressed.
    expect(impostor.chunkIds[0]).toBe(0xffff);
    let tagged = 0;
    for (let i = 0; i < impostor.chunkIds.length; i++) {
      const id = impostor.chunkIds[i]!;
      if (id !== 0xffff) {
        expect(id).toBeLessThan(256);
        tagged++;
      }
    }
    expect(tagged).toBeGreaterThan(1000);
  });
});
