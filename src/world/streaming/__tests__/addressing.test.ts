/**
 * CHUNK ADDRESSING
 *
 * The dense chunk index is the one number every system in the game has to
 * agree on: it is the PVS bit, the damage-mask key and the residency texel.
 * `chunkIndexForPosition` and `coordForChunkIndex` are the two addressing
 * exports streaming publishes to its callers (`city-streamer`, the destruction
 * harness), and until now neither had a test.
 *
 * These pin the round trip and the agreement with `@/spatial/constants`, which
 * is what makes delegating to it — rather than keeping a second copy of the
 * formula — a change nobody has to re-verify.
 */

import { describe, expect, it } from 'vitest';
import {
  CHUNK_COUNT,
  CHUNK_SIZE,
  WORLD_MAX,
  WORLD_MIN,
  chunkCentreX,
  chunkCentreZ,
  chunkIndexAt,
  chunkIndexToX,
  chunkIndexToZ,
  chunkMinX,
  chunkMinZ,
} from '@/spatial/constants';
import { chunkIndexForPosition, coordForChunkIndex } from '../streaming-system';

describe('streaming chunk addressing', () => {
  it('round-trips every chunk centre', () => {
    for (let index = 0; index < CHUNK_COUNT; index++) {
      expect(chunkIndexForPosition(chunkCentreX(index), chunkCentreZ(index))).toBe(index);
      expect(coordForChunkIndex(index)).toEqual({
        x: chunkIndexToX(index),
        z: chunkIndexToZ(index),
      });
    }
  });

  it('agrees with the spatial index everywhere, including the corners', () => {
    for (let index = 0; index < CHUNK_COUNT; index++) {
      // The min corner belongs to the chunk; the max corner belongs to the next.
      const x = chunkMinX(index);
      const z = chunkMinZ(index);
      expect(chunkIndexForPosition(x, z)).toBe(index);
      expect(chunkIndexForPosition(x, z)).toBe(chunkIndexAt(x, z));
      expect(chunkIndexForPosition(x + CHUNK_SIZE - 0.001, z + CHUNK_SIZE - 0.001)).toBe(index);
    }
  });

  it('returns -1 outside the world', () => {
    expect(chunkIndexForPosition(WORLD_MIN - 0.001, 0)).toBe(-1);
    expect(chunkIndexForPosition(0, WORLD_MIN - 0.001)).toBe(-1);
    // WORLD_MAX is the exclusive upper edge: the last chunk ends there.
    expect(chunkIndexForPosition(WORLD_MAX, 0)).toBe(-1);
    expect(chunkIndexForPosition(0, WORLD_MAX)).toBe(-1);
    expect(chunkIndexForPosition(1e9, 1e9)).toBe(-1);
  });
});
