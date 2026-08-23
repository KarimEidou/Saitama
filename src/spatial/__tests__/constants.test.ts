/**
 * CHUNK ADDRESS ARITHMETIC
 *
 * `constants.ts` is the address arithmetic the PVS bit index, the quadtree's
 * depth-4 chunk mapping and the whole streaming workstream all agree on.
 * Eleven exported functions live there and most are consumed outside this
 * unit, so a sign error or an inclusive/exclusive slip at the world edge
 * mis-files an entire chunk's geometry — in a place where every caller looks
 * correct.
 *
 * The dimensional invariants in the module header ("the alignment that matters
 * most") are asserted here too: they are what lets the PVS be applied INSIDE
 * the frustum walk, and nothing else in the suite would notice them drifting.
 */

import { describe, it, expect } from 'vitest';
import {
  WORLD_SIZE,
  WORLD_MIN,
  WORLD_MAX,
  CHUNK_SIZE,
  CHUNK_GRID,
  CHUNK_COUNT,
  CHUNK_COORD_MIN,
  CHUNK_COORD_MAX,
  QUADTREE_DEPTH,
  QUADTREE_LEAF_SIZE,
  QUADTREE_CHUNK_DEPTH,
  QUADTREE_NODE_COUNT,
  ENTITY_CELL_SIZE,
  ENTITY_GRID_DIM,
  PVS_MASK_BITS,
  PVS_MASK_WORDS,
  PVS_TOTAL_BYTES,
  isChunkInWorld,
  chunkIndex,
  chunkIndexAt,
  chunkIndexToX,
  chunkIndexToZ,
  chunkMinX,
  chunkMinZ,
  chunkCentreX,
  chunkCentreZ,
  chunkChebyshev,
  chunkKeyFromIndex,
  worldToChunkX,
  worldToChunkZ,
} from '../constants';

describe('Dimensional invariants', () => {
  it('lines the hierarchy up with no remainders', () => {
    expect(CHUNK_GRID * CHUNK_SIZE).toBe(WORLD_SIZE);
    expect(CHUNK_GRID * CHUNK_GRID).toBe(CHUNK_COUNT);
    expect(WORLD_MAX - WORLD_MIN).toBe(WORLD_SIZE);
    expect(WORLD_SIZE / (1 << QUADTREE_DEPTH)).toBe(QUADTREE_LEAF_SIZE);
    // The alignment the PVS-inside-the-walk trick depends on.
    expect(WORLD_SIZE / (1 << QUADTREE_CHUNK_DEPTH)).toBe(CHUNK_SIZE);
    expect(1 << QUADTREE_CHUNK_DEPTH).toBe(CHUNK_GRID);
    expect(QUADTREE_NODE_COUNT).toBe(5461);
    expect(ENTITY_GRID_DIM * ENTITY_CELL_SIZE).toBe(WORLD_SIZE);
    expect(CHUNK_COUNT).toBeLessThanOrEqual(PVS_MASK_BITS);
    expect(PVS_TOTAL_BYTES).toBe(CHUNK_COUNT * PVS_MASK_WORDS * 4);
    expect(PVS_TOTAL_BYTES).toBe(8192);
  });
});

describe('Chunk addressing', () => {
  it('round-trips every dense index through coords, edges and centres', () => {
    for (let i = 0; i < CHUNK_COUNT; i++) {
      const cx = chunkIndexToX(i);
      const cz = chunkIndexToZ(i);
      expect(cx).toBeGreaterThanOrEqual(CHUNK_COORD_MIN);
      expect(cx).toBeLessThanOrEqual(CHUNK_COORD_MAX);
      expect(chunkIndex(cx, cz)).toBe(i);
      expect(chunkIndexAt(chunkMinX(i), chunkMinZ(i))).toBe(i); // inclusive edge
      expect(chunkIndexAt(chunkCentreX(i), chunkCentreZ(i))).toBe(i);
      expect(chunkCentreX(i) - chunkMinX(i)).toBe(CHUNK_SIZE * 0.5);
      expect(chunkKeyFromIndex(i)).toBe(`${cx},${cz}`);
    }
  });

  it('rejects positions and coords outside the world', () => {
    expect(isChunkInWorld(CHUNK_COORD_MIN, CHUNK_COORD_MIN)).toBe(true);
    expect(isChunkInWorld(CHUNK_COORD_MAX, CHUNK_COORD_MAX)).toBe(true);
    expect(isChunkInWorld(CHUNK_COORD_MIN - 1, 0)).toBe(false);
    expect(isChunkInWorld(0, CHUNK_COORD_MAX + 1)).toBe(false);
    expect(chunkIndex(CHUNK_COORD_MAX + 1, 0)).toBe(-1);
    // WORLD_MAX is the exclusive upper edge.
    expect(worldToChunkX(WORLD_MIN)).toBe(CHUNK_COORD_MIN);
    expect(worldToChunkZ(WORLD_MAX)).toBe(CHUNK_COORD_MAX + 1);
    expect(chunkIndexAt(WORLD_MAX, 0)).toBe(-1);
    expect(chunkIndexAt(WORLD_MIN - 0.001, 0)).toBe(-1);
    expect(chunkIndexAt(WORLD_MAX - 0.001, WORLD_MAX - 0.001)).toBe(CHUNK_COUNT - 1);
  });

  it('measures Chebyshev distance symmetrically', () => {
    expect(chunkChebyshev(0, 0)).toBe(0);
    expect(chunkChebyshev(0, CHUNK_COUNT - 1)).toBe(CHUNK_GRID - 1);
    for (let i = 0; i < CHUNK_COUNT; i += 7) {
      for (let j = 0; j < CHUNK_COUNT; j += 11) {
        expect(chunkChebyshev(i, j)).toBe(chunkChebyshev(j, i));
      }
    }
    expect(chunkChebyshev(chunkIndex(0, 0), chunkIndex(2, -1))).toBe(2);
  });
});
