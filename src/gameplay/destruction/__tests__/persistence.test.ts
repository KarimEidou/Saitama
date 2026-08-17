/**
 * PERSISTENCE — THE CITY STAYS BROKEN
 *
 * The thing that makes an open world feel like the player's rather than a
 * backdrop is that it remembers. Punch the corner off a tower block, walk a
 * kilometre so the chunk unloads, come back: the corner is still gone.
 *
 * Streaming's premise is the opposite — a chunk is disposable and rebuildable
 * from its seed — so this is the one piece of state that has to survive the
 * round trip, and the tests below run the real round trip:
 *
 *   punch -> unregister (stream out) -> register a FRESH mesh (stream in)
 *
 * against the real `ChunkDamageState` from `@/world/streaming`, including a
 * serialize/deserialize pass so the save-file path is exercised too.
 *
 * Two tiers, both checked:
 *   EXACT   the in-memory ledger. Within a session the building comes back
 *           damaged chunk-for-chunk.
 *   COARSE  the 8 KB bitmask alone, i.e. a city restored from a save. It is a
 *           band-granularity approximation and the test says so out loud
 *           rather than pretending otherwise.
 */

import { describe, expect, it } from 'vitest';
import { ChunkDamageState, damageSlot as streamingDamageSlot } from '@/world/streaming';
import { collapsingFloors as cityCollapsingFloors } from '@/world/city';
import { createEventBus } from '@/util';
import { DestructionSystem } from '../destruction-system';
import { damageSlot, pieceForChunk } from '../damage-address';
import { makeTower } from './fixtures';

const CHUNK_INDEX = 137;
const BUILDING_INDEX = 3;

function punchedSystem(damage: ChunkDamageState) {
  const bus = createEventBus();
  const system = new DestructionSystem({
    bus,
    damage,
    collapsingFloors: cityCollapsingFloors,
    seed: 'persistence',
  });
  return { bus, system };
}

describe('slot addressing agrees with the streaming system', () => {
  it('computes the same slot index streaming does', () => {
    for (let building = 0; building < 16; building++) {
      for (let piece = 0; piece < 16; piece++) {
        expect(damageSlot(building, piece)).toBe(streamingDamageSlot(building, piece));
      }
    }
  });

  it('maps every fracture chunk into a valid 0..15 piece', () => {
    for (const floors of [1, 2, 5, 12, 20]) {
      for (let floor = 0; floor < floors; floor++) {
        for (let quadrant = 0; quadrant < 4; quadrant++) {
          const piece = pieceForChunk(floor, quadrant, floors);
          expect(piece).toBeGreaterThanOrEqual(0);
          expect(piece).toBeLessThan(16);
        }
      }
    }
  });

  it('a whole storey of a short building clears a whole band', () => {
    const seen = new Set<number>();
    for (let quadrant = 0; quadrant < 4; quadrant++) seen.add(pieceForChunk(0, quadrant, 4));
    // Four faces -> four distinct plan quarters of band 0.
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });
});

describe('stream out and back in', () => {
  it('restores the damage exactly onto a freshly built mesh', () => {
    const damage = new ChunkDamageState();
    const { bus, system } = punchedSystem(damage);

    const first = makeTower({ floors: 12 });
    system.register({
      id: 'block.b1',
      layout: first.layout,
      target: { destroyed: first.attribute },
      position: { x: 0, y: 0, z: 0 },
      chunkIndex: CHUNK_INDEX,
      buildingIndex: BUILDING_INDEX,
    });

    // A glancing punch: takes a corner, does not level the building.
    bus.emit('ShockwaveFired', {
      origin: { x: -30, y: 22, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      power: 4e5,
      range: 60,
      angle: 0.12,
      intent: 'serious',
      punchKind: 'serious',
    });
    for (let frame = 0; frame < 8; frame++) system.update(1 / 60);

    const before = system.structures.get('block.b1')!;
    const destroyedIndices = [...before.destroyed]
      .map((flag, index) => (flag === 1 ? index : -1))
      .filter((index) => index >= 0);
    expect(destroyedIndices.length).toBeGreaterThan(0);
    expect(destroyedIndices.length).toBeLessThan(first.layout.chunks.length);

    // ---- stream out ----
    expect(system.unregister('block.b1')).toBe(true);
    expect(system.structures.has('block.b1')).toBe(false);

    // ---- stream in: the generator hands back a PRISTINE mesh ----
    const second = makeTower({ floors: 12 });
    expect(second.attribute.visibleCount()).toBe(second.vertexCount);

    const restored = system.register({
      id: 'block.b1',
      layout: second.layout,
      target: { destroyed: second.attribute },
      position: { x: 0, y: 0, z: 0 },
      chunkIndex: CHUNK_INDEX,
      buildingIndex: BUILDING_INDEX,
    });

    expect([...restored.destroyed]).toEqual([...before.destroyed]);
    expect(restored.destroyedCount).toBe(destroyedIndices.length);

    // And the freshly built geometry really is holed, byte for byte.
    for (const index of destroyedIndices) {
      const chunk = second.layout.chunks[index]!;
      for (let v = chunk.vertexStart; v < chunk.vertexStart + chunk.vertexCount; v++) {
        expect(second.attribute.array[v]).toBe(255);
        expect(second.attribute.isHidden(v)).toBe(true);
      }
    }
    expect(second.attribute.visibleCount()).toBeLessThan(second.vertexCount);
    system.dispose();
  });

  it('writes bits into the real 8 KB bitmask', () => {
    const damage = new ChunkDamageState();
    const { bus, system } = punchedSystem(damage);
    const tower = makeTower({ floors: 12 });
    system.register({
      id: 'block.b2',
      layout: tower.layout,
      target: { destroyed: tower.attribute },
      position: { x: 0, y: 0, z: 0 },
      chunkIndex: CHUNK_INDEX,
      buildingIndex: BUILDING_INDEX,
    });

    expect(damage.isChunkDamaged(CHUNK_INDEX)).toBe(false);

    bus.emit('ShockwaveFired', {
      origin: { x: -30, y: 2, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      power: 2.5e6,
      range: 120,
      angle: 0.25,
      intent: 'full',
      punchKind: 'serious',
    });
    for (let frame = 0; frame < 8; frame++) system.update(1 / 60);

    expect(damage.isChunkDamaged(CHUNK_INDEX)).toBe(true);
    expect(damage.destroyedCount(CHUNK_INDEX)).toBeGreaterThan(0);
    expect(damage.destroyedCount(CHUNK_INDEX)).toBeLessThanOrEqual(16);
    expect(system.diagnostics.persistedPieces).toBeGreaterThan(0);
    system.dispose();
  });

  it('survives a save-file round trip through serialize/deserialize', () => {
    const damage = new ChunkDamageState();
    const { bus, system } = punchedSystem(damage);
    const tower = makeTower({ floors: 12 });
    system.register({
      id: 'block.b3',
      layout: tower.layout,
      target: { destroyed: tower.attribute },
      position: { x: 0, y: 0, z: 0 },
      chunkIndex: CHUNK_INDEX,
      buildingIndex: BUILDING_INDEX,
    });
    bus.emit('ShockwaveFired', {
      origin: { x: -30, y: 2, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      power: 2.5e6,
      range: 120,
      angle: 0.25,
      intent: 'full',
      punchKind: 'serious',
    });
    for (let frame = 0; frame < 8; frame++) system.update(1 / 60);
    const originalDestroyed = [...system.structures.get('block.b3')!.destroyed];
    const bitsBefore = damage.destroyedCount(CHUNK_INDEX);
    system.dispose();

    // ---- save, quit, reload ----
    const bytes = damage.serialize();
    const reloaded = ChunkDamageState.deserialize(bytes);
    expect(reloaded.destroyedCount(CHUNK_INDEX)).toBe(bitsBefore);

    // A brand new session: no ledger at all, only the 8 KB mask.
    const bus2 = createEventBus();
    const system2 = new DestructionSystem({
      bus: bus2,
      damage: reloaded,
      collapsingFloors: cityCollapsingFloors,
      seed: 'persistence',
    });
    const rebuilt = makeTower({ floors: 12 });
    const structure = system2.register({
      id: 'block.b3',
      layout: rebuilt.layout,
      target: { destroyed: rebuilt.attribute },
      position: { x: 0, y: 0, z: 0 },
      chunkIndex: CHUNK_INDEX,
      buildingIndex: BUILDING_INDEX,
    });

    // Every chunk that was destroyed is still destroyed.
    for (let i = 0; i < originalDestroyed.length; i++) {
      if (originalDestroyed[i] === 1) expect(structure.destroyed[i]).toBe(1);
    }
    // The coarse tier is an OVER-approximation, and that is the honest
    // statement of what 16 bits per building buys: it may take down a whole
    // band where the exact record took one storey.
    expect(structure.destroyedCount).toBeGreaterThanOrEqual(
      originalDestroyed.filter((f) => f === 1).length
    );
    system2.dispose();
  });

  it('does not fire debris, events or a collapse while restoring', () => {
    const damage = new ChunkDamageState();
    const { bus, system } = punchedSystem(damage);
    const tower = makeTower({ floors: 12 });
    system.register({
      id: 'block.b4',
      layout: tower.layout,
      target: { destroyed: tower.attribute },
      position: { x: 0, y: 0, z: 0 },
      chunkIndex: CHUNK_INDEX,
      buildingIndex: BUILDING_INDEX,
    });
    bus.emit('ShockwaveFired', {
      origin: { x: -30, y: 2, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      power: 2.5e6,
      range: 120,
      angle: 0.25,
      intent: 'full',
      punchKind: 'serious',
    });
    for (let frame = 0; frame < 8; frame++) system.update(1 / 60);
    system.unregister('block.b4');

    const detached: number[] = [];
    bus.on('ChunkDetached', (event) => detached.push(event.chunkIndex));
    const chunksBefore = system.diagnostics.chunksDestroyed;
    const collapsesBefore = system.diagnostics.collapsesTriggered;

    const rebuilt = makeTower({ floors: 12 });
    system.register({
      id: 'block.b4',
      layout: rebuilt.layout,
      target: { destroyed: rebuilt.attribute },
      position: { x: 0, y: 0, z: 0 },
      chunkIndex: CHUNK_INDEX,
      buildingIndex: BUILDING_INDEX,
    });

    // Restoring is re-establishing a settled state, not new damage: no dust,
    // no invoice, no second collapse.
    expect(detached).toEqual([]);
    expect(system.diagnostics.chunksDestroyed).toBe(chunksBefore);
    expect(system.diagnostics.collapsesTriggered).toBe(collapsesBefore);
    expect(system.diagnostics.restoredChunks).toBeGreaterThan(0);
    system.dispose();
  });

  it('leaves an undamaged building untouched across a round trip', () => {
    const damage = new ChunkDamageState();
    const { system } = punchedSystem(damage);
    const tower = makeTower({ floors: 6 });
    system.register({
      id: 'pristine',
      layout: tower.layout,
      target: { destroyed: tower.attribute },
      position: { x: 0, y: 0, z: 0 },
      chunkIndex: 9,
      buildingIndex: 0,
    });
    system.unregister('pristine');

    const rebuilt = makeTower({ floors: 6 });
    const structure = system.register({
      id: 'pristine',
      layout: rebuilt.layout,
      target: { destroyed: rebuilt.attribute },
      position: { x: 0, y: 0, z: 0 },
      chunkIndex: 9,
      buildingIndex: 0,
    });
    expect(structure.destroyedCount).toBe(0);
    expect(rebuilt.attribute.visibleCount()).toBe(rebuilt.vertexCount);
    expect(system.ledgerSize).toBe(0);
    system.dispose();
  });
});

describe('an unchanged fresh instance is byte-identical', () => {
  it('serializes to the same bytes after a no-op round trip', () => {
    const damage = new ChunkDamageState();
    const a = damage.serialize();
    const b = ChunkDamageState.deserialize(a).serialize();
    expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
  });
});
