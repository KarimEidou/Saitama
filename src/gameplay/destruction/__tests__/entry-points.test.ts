/**
 * ENTRY POINTS — THE FOUR WAYS DAMAGE ARRIVES, AND THE STATE THEY SHARE
 *
 * A cone punch off the bus, a cone punch from a scripted set-piece, a radial
 * crater, and a `ChunkDetached` raised by somebody else. They all end up in the
 * same `detachChunk`, reading the same instance fields, so the interesting
 * failures are not inside any one of them — they are the state one entry point
 * sets and another reads without setting:
 *
 *   • a foreign `ChunkDetached` must be APPLIED, not echoed. The event is
 *     already on the bus; emitting it again bills every other subscriber twice.
 *   • a crater has no axis. Reading the previous cone punch's axis throws the
 *     whole rim east because the last punch happened to be thrown east.
 *   • an impact is recorded on the same terms whichever door the blast came
 *     through, or the ragdolls depend on which door that was.
 *   • the frame counter has to survive the `update()` that follows the punch,
 *     because that is when everybody reads it.
 */

import { describe, expect, it } from 'vitest';
import { createEventBus } from '@/util';
import type { GameEventOf } from '@/types';
import { collapsingFloors as cityCollapsingFloors } from '@/world/city';
import { DestructionSystem } from '../destruction-system';
import { FakeRagdollSink, makeTower } from './fixtures';

function setup(seed: string, position = { x: 0, y: 0, z: 0 }, floors = 12) {
  const bus = createEventBus();
  const detached: GameEventOf<'ChunkDetached'>[] = [];
  bus.on('ChunkDetached', (event) => detached.push(event));
  const system = new DestructionSystem({
    bus,
    collapsingFloors: cityCollapsingFloors,
    seed,
  });
  const tower = makeTower({ floors });
  const structure = system.register({
    id: 'tower',
    layout: tower.layout,
    target: { destroyed: tower.attribute },
    position,
  });
  return { bus, system, structure, tower, detached };
}

describe('a ChunkDetached raised by somebody else', () => {
  it('applies the detach without emitting a second event for the same piece', () => {
    const { bus, system, structure, tower, detached } = setup('external');

    bus.emit('ChunkDetached', {
      structureId: 'tower',
      chunkIndex: 7,
      position: { x: 0, y: 6, z: 0 },
      mass: 5200,
      impulse: { x: 0, y: 0, z: 0 },
      material: 'concrete',
      collateralCost: 5200,
    });

    // One piece, one event — the contract in `src/types/events.ts`. A replay of
    // a recorded bus log has to reproduce the log, not double it.
    expect(detached.length).toBe(1);
    expect(system.diagnostics.chunksDestroyed).toBe(1);

    // ...and the piece really did come off: geometry blanked, mass counted.
    expect(structure.destroyed[7]).toBe(1);
    const chunk = tower.layout.chunks[7]!;
    expect(tower.attribute.array[chunk.vertexStart]).toBe(255);
    expect(system.diagnostics.destroyedMassKg).toBe(chunk.mass);
    system.dispose();
  });

  it('ignores the same foreign event replayed twice', () => {
    const { bus, system, detached } = setup('external-twice');
    const event = {
      structureId: 'tower',
      chunkIndex: 3,
      position: { x: 0, y: 1, z: 0 },
      mass: 5200,
      impulse: { x: 0, y: 0, z: 0 },
      material: 'concrete',
      collateralCost: 5200,
    } as const;

    bus.emit('ChunkDetached', event);
    bus.emit('ChunkDetached', event);

    expect(detached.length).toBe(2); // both foreign emits, neither echoed
    expect(system.diagnostics.chunksDestroyed).toBe(1);
    system.dispose();
  });
});

describe('a crater is radial, whatever the last punch was', () => {
  it('throws the rim outward after a cone punch aimed somewhere else', () => {
    // The tower sits due north of the crater. A cone punch is thrown EAST
    // first, well out of reach of anything, purely to leave an axis behind.
    const { system, detached } = setup('crater', { x: 0, y: 0, z: 30 });
    system.applyShockwave(
      { x: -500, y: 2, z: -500 },
      { x: 1, y: 0, z: 0 },
      40,
      0.3,
      2.5e6,
      'serious'
    );
    expect(detached.length).toBe(0);

    const took = system.applyRadial({ x: 0, y: 1, z: 0 }, 60, 2.5e6, 'full');
    expect(took).toBeGreaterThan(0);

    const meanX = detached.reduce((sum, e) => sum + e.impulse.x / e.mass, 0) / detached.length;
    const meanZ = detached.reduce((sum, e) => sum + e.impulse.z / e.mass, 0) / detached.length;
    // Outward from the crater is +Z. If the stale axis were still in play, 70%
    // of every piece's direction would be +X and `meanX` would be in the tens.
    expect(meanZ).toBeGreaterThan(4);
    expect(Math.abs(meanX)).toBeLessThan(2);
    expect(Math.abs(meanX)).toBeLessThan(meanZ);
    system.dispose();
  });
});

describe('impacts are recorded on the same terms by every path', () => {
  it('throws ragdolls for a set-piece that calls applyShockwave directly', () => {
    const bus = createEventBus();
    const ragdolls = new FakeRagdollSink();
    const system = new DestructionSystem({ bus, ragdolls, seed: 'set-piece' });

    system.applyShockwave({ x: 0, y: 2, z: 0 }, { x: 1, y: 0, z: 0 }, 180, 0.4, 2.5e6, 'full');
    bus.emit('EntityKilled', {
      entityId: 'mob',
      entityType: 'monster',
      faction: 'monster',
      position: { x: 6, y: 1, z: 0 },
      intent: 'full',
      rewardPoints: 10,
    });

    expect(ragdolls.launches.length).toBe(1);
    system.dispose();
  });

  it('records nothing for a pulled punch, so a death beside one is not launched', () => {
    const bus = createEventBus();
    const ragdolls = new FakeRagdollSink();
    const system = new DestructionSystem({ bus, ragdolls, seed: 'pulled' });

    bus.emit('ShockwaveFired', {
      origin: { x: 0, y: 2, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      power: 2.5e6,
      range: 180,
      angle: 0.4,
      intent: 'restrained',
      punchKind: 'normal',
    });
    bus.emit('EntityKilled', {
      entityId: 'mob',
      entityType: 'monster',
      faction: 'monster',
      position: { x: 6, y: 1, z: 0 },
      intent: 'restrained',
      rewardPoints: 10,
    });

    // A restrained punch leaves the city alone; it does not get to launch
    // bodies at 34 m/s either.
    expect(ragdolls.launches.length).toBe(0);
    system.dispose();
  });
});

describe('chunksDestroyedThisFrame', () => {
  it('still reports the punch on the update that follows it', () => {
    const { bus, system } = setup('frame-counter');

    bus.emit('ShockwaveFired', {
      origin: { x: -40, y: 1.7, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      power: 2.5e6,
      range: 120,
      angle: 0.2,
      intent: 'full',
      punchKind: 'serious',
    });
    const atPunch = system.diagnostics.chunksDestroyedThisFrame;
    expect(atPunch).toBeGreaterThan(0);

    // The blast lands BETWEEN updates, and every consumer of `diagnostics`
    // reads it after the system update. The punch has to still be in there.
    system.update(1 / 60);
    expect(system.diagnostics.chunksDestroyedThisFrame).toBeGreaterThanOrEqual(atPunch);

    // ...and a frame in which nothing detached at all reports zero.
    for (let frame = 0; frame < 8; frame++) system.update(1 / 60);
    expect(system.diagnostics.chunksDestroyedThisFrame).toBe(0);
    system.dispose();
  });
});
