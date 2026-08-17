/**
 * PERSISTENT DAMAGE
 *
 * The property under test is one sentence long and is the reason the system
 * exists: **a destroyed fracture piece stays destroyed across an unload and a
 * reload.** Everything else here — the bit addressing, the serialisation, the
 * lazy allocation — is in service of it.
 */

import { describe, expect, it } from 'vitest';
import { ChunkDamageState, DAMAGE_TOTAL_BYTES, damageSlot } from '../damage-state';
import { buildChunkGeometry } from '../chunk-geometry';
import {
  DAMAGE_BITS_PER_CHUNK,
  FRACTURE_PIECES_PER_BUILDING,
  MAX_BUILDINGS_PER_CHUNK,
  RING_R0,
} from '../constants';
import { CHUNK_COUNT } from '@/spatial/constants';

const SEED = 0x0c17972;

describe('ChunkDamageState', () => {
  it('addresses exactly 256 slots per chunk', () => {
    expect(DAMAGE_BITS_PER_CHUNK).toBe(MAX_BUILDINGS_PER_CHUNK * FRACTURE_PIECES_PER_BUILDING);
    expect(DAMAGE_BITS_PER_CHUNK).toBe(256);
    // 256 chunks x 256 bits = 8 KB for the whole city's destruction record.
    expect(DAMAGE_TOTAL_BYTES).toBe(CHUNK_COUNT * 32);
    expect(DAMAGE_TOTAL_BYTES).toBe(8192);
  });

  it('records and reads back individual pieces', () => {
    const damage = new ChunkDamageState();
    expect(damage.isDestroyed(12, damageSlot(3, 7))).toBe(false);
    expect(damage.setDestroyed(12, damageSlot(3, 7))).toBe(true);
    expect(damage.setDestroyed(12, damageSlot(3, 7))).toBe(false); // idempotent
    expect(damage.isDestroyed(12, damageSlot(3, 7))).toBe(true);
    // Neighbouring slots and chunks are untouched.
    expect(damage.isDestroyed(12, damageSlot(3, 8))).toBe(false);
    expect(damage.isDestroyed(13, damageSlot(3, 7))).toBe(false);
    expect(damage.stats().destroyedPieces).toBe(1);
  });

  it('allocates masks lazily', () => {
    const damage = new ChunkDamageState();
    expect(damage.stats().residentBytes).toBe(0);
    damage.setDestroyed(200, 0);
    expect(damage.stats().residentBytes).toBe(32);
    damage.clearDestroyed(200, 0);
    // Back to pristine: the allocation is released too.
    expect(damage.stats().residentBytes).toBe(0);
  });

  it('levels a whole building', () => {
    const damage = new ChunkDamageState();
    expect(damage.destroyBuilding(5, 2)).toBe(FRACTURE_PIECES_PER_BUILDING);
    expect(damage.destroyedCount(5)).toBe(FRACTURE_PIECES_PER_BUILDING);
    for (let p = 0; p < FRACTURE_PIECES_PER_BUILDING; p++) {
      expect(damage.isDestroyed(5, damageSlot(2, p))).toBe(true);
    }
  });

  it('round-trips through a snapshot', () => {
    const damage = new ChunkDamageState();
    damage.destroyBuilding(0, 0);
    damage.setDestroyed(255, damageSlot(15, 15));
    damage.setDestroyed(137, damageSlot(7, 3));

    const bytes = damage.serialize();
    expect(bytes.byteLength).toBe(DAMAGE_TOTAL_BYTES + 16);

    const restored = ChunkDamageState.deserialize(bytes);
    expect(restored.stats()).toEqual(damage.stats());
    expect(restored.isDestroyed(255, damageSlot(15, 15))).toBe(true);
    expect(restored.isDestroyed(137, damageSlot(7, 3))).toBe(true);
    expect(restored.destroyedCount(0)).toBe(FRACTURE_PIECES_PER_BUILDING);
    expect(restored.isDestroyed(1, 0)).toBe(false);
  });

  it('rejects a corrupted snapshot', () => {
    const damage = new ChunkDamageState();
    damage.setDestroyed(3, 3);
    const bytes = damage.serialize();
    bytes[64] = bytes[64]! ^ 0xff;
    expect(() => ChunkDamageState.deserialize(bytes)).toThrow(/checksum/);
  });

  it('tracks dirty chunks so the streamer knows what to rebuild', () => {
    const damage = new ChunkDamageState();
    damage.setDestroyed(9, 1);
    damage.setDestroyed(9, 2);
    damage.setDestroyed(40, 1);
    expect(damage.dirtyCount).toBe(2);
    expect(damage.takeDirty().sort((a, b) => a - b)).toEqual([9, 40]);
    expect(damage.dirtyCount).toBe(0);
  });
});

describe('damage survives a rebuild', () => {
  it('suppresses destroyed pieces every time the chunk is generated', () => {
    const damage = new ChunkDamageState();
    const chunk = 0;
    const pristine = buildChunkGeometry(SEED, -8, -8, RING_R0, undefined);
    expect(pristine.standingBuildings).toBeGreaterThan(0);

    // Level building 0 — the streaming system's `destroyBuilding` path.
    damage.destroyBuilding(chunk, 0);

    const first = buildChunkGeometry(SEED, -8, -8, RING_R0, damage.cloneMask(chunk));
    expect(first.standingBuildings).toBe(pristine.standingBuildings - 1);
    expect(first.destroyedPieces).toBe(FRACTURE_PIECES_PER_BUILDING);
    expect(first.buffers.vertexCount).toBeLessThan(pristine.buffers.vertexCount);

    // Unload and reload: a second generation from the same persistent state
    // must be identical, not merely similar.
    const second = buildChunkGeometry(SEED, -8, -8, RING_R0, damage.cloneMask(chunk));
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.standingBuildings).toBe(first.standingBuildings);

    // And the coarse rings agree about what is gone.
    const coarse = buildChunkGeometry(SEED, -8, -8, 2, damage.cloneMask(chunk));
    expect(coarse.standingBuildings).toBe(first.standingBuildings);
  });

  it('shortens a building when only its upper bands are destroyed', () => {
    const damage = new ChunkDamageState();
    const full = buildChunkGeometry(SEED, 0, 0, 1, undefined);
    // Bands 2 and 3 are the top half: slots 8..15 of the building.
    for (let p = 8; p < 16; p++) damage.setDestroyed(136, damageSlot(0, p));
    const topped = buildChunkGeometry(SEED, 0, 0, 1, damage.cloneMask(136));

    expect(topped.standingBuildings).toBe(full.standingBuildings);
    // The bounding box must have come down, because the tallest surviving band
    // of that building is now half its original height.
    expect(topped.bounds[4]).toBeLessThanOrEqual(full.bounds[4]);
    expect(topped.contentHash).not.toBe(full.contentHash);
  });
});
