/**
 * DETERMINISM — SAME SEED, SAME PUNCH, SAME RUBBLE
 *
 * Replay, netcode, save files and every "it only happens sometimes" bug report
 * depend on this. Three separate things have to hold, and the third is the one
 * that is usually quietly false:
 *
 *  1. Repeating a punch on a fresh world reproduces it exactly — same chunks,
 *     same impulses, same order.
 *  2. Different seeds actually differ, so the test above is not passing
 *     because the jitter is dead.
 *  3. REGISTRATION ORDER DOES NOT MATTER. Buildings are registered in the
 *     order streaming loads chunks, which is the order the player walked. If
 *     the sweep or the jitter depended on that, the same punch would produce
 *     different rubble depending on which street you arrived from — and it
 *     would reproduce perfectly in a test that always registers in the same
 *     order.
 *
 * `Math.random()` is banned outright; everything here is seeded through
 * `src/util/rng.ts`.
 */

import { describe, expect, it } from 'vitest';
import { createEventBus, createRng } from '@/util';
import type { GameEventOf } from '@/types';
import { collapsingFloors as cityCollapsingFloors } from '@/world/city';
import { DestructionSystem } from '../destruction-system';
import { makeTower } from './fixtures';

interface IRecord {
  readonly structureId: string;
  readonly chunkIndex: number;
  readonly position: [number, number, number];
  readonly impulse: [number, number, number];
  readonly mass: number;
}

const PUNCH = {
  origin: { x: -30, y: 3, z: 0 },
  direction: { x: 1, y: 0.05, z: 0.1 },
  power: 2.5e6,
  range: 220,
  angle: 0.32,
  intent: 'full',
  punchKind: 'serious',
} as const;

function run(seed: string, order: number[]): IRecord[] {
  const bus = createEventBus();
  const log: IRecord[] = [];
  bus.on('ChunkDetached', (event: GameEventOf<'ChunkDetached'>) => {
    log.push({
      structureId: event.structureId,
      chunkIndex: event.chunkIndex,
      position: [event.position.x, event.position.y, event.position.z],
      impulse: [event.impulse.x, event.impulse.y, event.impulse.z],
      mass: event.mass,
    });
  });
  const system = new DestructionSystem({
    bus,
    collapsingFloors: cityCollapsingFloors,
    seed,
  });

  for (const i of order) {
    const { layout, attribute } = makeTower({ floors: 8 + (i % 5), footprint: 9 + (i % 3) });
    system.register({
      id: `tower-${String(i).padStart(2, '0')}`,
      layout,
      target: { destroyed: attribute },
      position: { x: 12 + i * 15, y: 0, z: (i % 3) - 1 },
    });
  }

  bus.emit('ShockwaveFired', PUNCH);
  for (let frame = 0; frame < 12; frame++) system.update(1 / 60);
  system.dispose();
  return log;
}

const IN_ORDER = [0, 1, 2, 3, 4, 5, 6, 7];

describe('determinism', () => {
  it('reproduces a punch exactly from the same seed', () => {
    const a = run('city-z', IN_ORDER);
    const b = run('city-z', IN_ORDER);
    expect(a.length).toBeGreaterThan(50);
    expect(b).toEqual(a);
    // Byte-equal, not merely deep-equal: a float that differs in the last
    // bit deep-equals only because `toEqual` is exact for numbers, which is
    // what we want — this is a restatement for the reader, not a weaker check.
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('produces different rubble from a different seed', () => {
    const a = run('city-z', IN_ORDER);
    const b = run('city-y', IN_ORDER);
    expect(b.length).toBe(a.length);
    // Same chunks come off — the geometry did not change — but with different
    // jitter, so the impulses differ.
    expect(b.map((r) => r.chunkIndex)).toEqual(a.map((r) => r.chunkIndex));
    expect(JSON.stringify(b)).not.toBe(JSON.stringify(a));
  });

  it('is independent of the order buildings were registered in', () => {
    const rng = createRng('registration-order');
    const shuffled = rng.shuffle(IN_ORDER);
    expect(shuffled).not.toEqual(IN_ORDER);

    const a = run('city-z', IN_ORDER);
    const b = run('city-z', shuffled);
    expect(b).toEqual(a);
  });

  it('gives the same chunk the same jitter whenever it detaches', () => {
    // Detach one chunk alone, then detach the whole building; the shared
    // chunk's impulse must be identical in both runs.
    const solo = (() => {
      const bus = createEventBus();
      let record: IRecord | undefined;
      bus.on('ChunkDetached', (event) => {
        if (event.chunkIndex === 17) {
          record = {
            structureId: event.structureId,
            chunkIndex: event.chunkIndex,
            position: [event.position.x, event.position.y, event.position.z],
            impulse: [event.impulse.x, event.impulse.y, event.impulse.z],
            mass: event.mass,
          };
        }
      });
      const system = new DestructionSystem({ bus, seed: 'jitter' });
      const { layout, attribute } = makeTower({ floors: 12 });
      const structure = system.register({
        id: 'tower',
        layout,
        target: { destroyed: attribute },
        position: { x: 0, y: 0, z: 0 },
      });
      system.detachChunk(structure, 17, 'collapse');
      system.dispose();
      return record;
    })();

    const inCollapse = (() => {
      const bus = createEventBus();
      let record: IRecord | undefined;
      bus.on('ChunkDetached', (event) => {
        if (event.chunkIndex === 17 && record === undefined) {
          record = {
            structureId: event.structureId,
            chunkIndex: event.chunkIndex,
            position: [event.position.x, event.position.y, event.position.z],
            impulse: [event.impulse.x, event.impulse.y, event.impulse.z],
            mass: event.mass,
          };
        }
      });
      const system = new DestructionSystem({
        bus,
        collapsingFloors: cityCollapsingFloors,
        seed: 'jitter',
      });
      const { layout, attribute } = makeTower({ floors: 12 });
      system.register({
        id: 'tower',
        layout,
        target: { destroyed: attribute },
        position: { x: 0, y: 0, z: 0 },
      });
      // Gut three of floor 0's four quadrants through the EXTERNAL event path,
      // which is the one that evaluates the support model.
      for (let q = 0; q < 3; q++) {
        bus.emit('ChunkDetached', {
          structureId: 'tower',
          chunkIndex: q,
          position: { x: 0, y: 0, z: 0 },
          mass: 1,
          impulse: { x: 0, y: 0, z: 0 },
          material: 'concrete',
          collateralCost: 0,
        });
      }
      for (let frame = 0; frame < 8; frame++) system.update(1 / 60);
      system.dispose();
      return record;
    })();

    expect(solo).toBeDefined();
    expect(inCollapse).toBeDefined();
    expect(inCollapse!.impulse).toEqual(solo!.impulse);
  });
});
