/**
 * BUDGETS — THE 300 BODIES AND THE 8 RAGDOLLS
 *
 * A destruction system that only holds its budget on a modest punch is not a
 * destruction system, it is a demo. These tests fire punches that detach far
 * more than the budget allows and require that:
 *
 *   • the debris pool is never asked for a 301st body;
 *   • every chunk over the budget STILL LEAVES THE BUILDING. The cap costs
 *     you a rigid body, never a hole. A collapse that stops removing geometry
 *     once the budget runs out is the exact failure this design exists to
 *     avoid;
 *   • the 9th simultaneous death is not thrown, and destruction does not even
 *     ask — pushing the manager into freezing somebody mid-flight would be
 *     worse than declining.
 */

import { describe, expect, it } from 'vitest';
import { createEventBus } from '@/util';
import { collapsingFloors as cityCollapsingFloors } from '@/world/city';
import { DestructionSystem } from '../destruction-system';
import { DEBRIS_HARD_CAP, MAX_ACTIVE_RAGDOLLS } from '../constants';
import { FakeDebrisPool, FakeRagdollSink, makeTower } from './fixtures';

/** A city block: 24 twelve-storey towers, 1152 fracture chunks in one cone. */
function buildBlock(system: DestructionSystem, towers = 24): number {
  let chunks = 0;
  for (let i = 0; i < towers; i++) {
    const { layout, attribute } = makeTower({ floors: 12, footprint: 10 });
    system.register({
      id: `tower-${String(i).padStart(2, '0')}`,
      layout,
      target: { destroyed: attribute },
      position: { x: 14 + i * 13, y: 0, z: 0 },
    });
    chunks += layout.chunks.length;
  }
  return chunks;
}

describe('the 300-debris cap', () => {
  it('holds under a punch that detaches four times the budget', () => {
    const bus = createEventBus();
    const debris = new FakeDebrisPool(DEBRIS_HARD_CAP);
    const system = new DestructionSystem({
      bus,
      debris,
      collapsingFloors: cityCollapsingFloors,
      seed: 'caps',
    });
    const totalChunks = buildBlock(system);
    expect(totalChunks).toBeGreaterThan(DEBRIS_HARD_CAP * 3);

    bus.emit('ShockwaveFired', {
      origin: { x: -20, y: 2, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      power: 2.5e6,
      range: 400,
      angle: 0.35,
      intent: 'full',
      punchKind: 'serious',
    });
    for (let frame = 0; frame < 30; frame++) system.update(1 / 60);

    const stats = system.diagnostics;
    expect(debris.peakCount).toBeLessThanOrEqual(DEBRIS_HARD_CAP);
    expect(debris.count).toBeLessThanOrEqual(DEBRIS_HARD_CAP);
    // The pool is never even asked once it is full: `spawnCalls` equals the
    // number of pieces that got a body, not the number of chunks detached.
    expect(debris.spawnCalls).toBe(stats.debrisSpawned);
    expect(stats.debrisSpawned).toBeLessThanOrEqual(DEBRIS_HARD_CAP);

    // ...and the building still lost every chunk the cone reached.
    expect(stats.chunksDestroyed).toBeGreaterThan(DEBRIS_HARD_CAP * 2);
    expect(stats.visualOnlyDetaches).toBe(stats.chunksDestroyed - stats.debrisSpawned);
    expect(stats.visualOnlyDetaches).toBeGreaterThan(0);
    system.dispose();
  });

  it('spawns again once pieces fade out of the pool', () => {
    const bus = createEventBus();
    const debris = new FakeDebrisPool(64);
    const system = new DestructionSystem({
      bus,
      debris,
      collapsingFloors: cityCollapsingFloors,
      seed: 'caps-refill',
    });
    buildBlock(system, 8);

    bus.emit('ShockwaveFired', {
      origin: { x: -20, y: 2, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      power: 2.5e6,
      range: 400,
      angle: 0.35,
      intent: 'full',
      punchKind: 'serious',
    });
    system.update(1 / 60);
    const firstWave = system.diagnostics.debrisSpawned;
    expect(firstWave).toBe(64);

    // The 12 s fade retires the oldest pieces; the collapse still queued
    // should pick the slots straight back up.
    debris.retire(32);
    for (let frame = 0; frame < 10; frame++) system.update(1 / 60);
    expect(system.diagnostics.debrisSpawned).toBeGreaterThan(firstWave);
    expect(debris.peakCount).toBeLessThanOrEqual(64);
    system.dispose();
  });

  it('reclaims a debris box only after the piece using it is gone', () => {
    const bus = createEventBus();
    const debris = new FakeDebrisPool(16);
    const system = new DestructionSystem({
      bus,
      debris,
      collapsingFloors: cityCollapsingFloors,
      seed: 'caps-shapes',
    });
    buildBlock(system, 4);

    bus.emit('ShockwaveFired', {
      origin: { x: -20, y: 2, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      power: 2.5e6,
      range: 400,
      angle: 0.4,
      intent: 'full',
      punchKind: 'serious',
    });
    system.update(1 / 60);
    expect(system.shapes.lentCount).toBe(16);
    expect(system.shapes.freeCount).toBe(0);

    debris.retire(16);
    system.update(1 / 60);
    expect(system.shapes.freeCount).toBeGreaterThan(0);
    system.dispose();
  });
});

describe('the 8-ragdoll cap', () => {
  it('throws at most eight bodies from one punch that kills forty', () => {
    const bus = createEventBus();
    const ragdolls = new FakeRagdollSink(MAX_ACTIVE_RAGDOLLS);
    const system = new DestructionSystem({ bus, ragdolls, seed: 'ragdoll-cap' });
    system.update(1 / 60);

    bus.emit('ShockwaveFired', {
      origin: { x: 0, y: 2, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      power: 2.5e6,
      range: 180,
      angle: 0.4,
      intent: 'full',
      punchKind: 'serious',
    });

    for (let i = 0; i < 40; i++) {
      bus.emit('EntityKilled', {
        entityId: `mob-${i}`,
        entityType: 'monster',
        faction: 'monster',
        position: { x: 3 + (i % 8), y: 1, z: (i % 5) - 2 },
        intent: 'full',
        rewardPoints: 10,
      });
    }

    expect(ragdolls.launches.length).toBe(MAX_ACTIVE_RAGDOLLS);
    expect(ragdolls.activeCount).toBe(MAX_ACTIVE_RAGDOLLS);
    // Refusals are zero because the ceiling is checked BEFORE asking.
    expect(ragdolls.refusals).toBe(0);
    expect(system.diagnostics.ragdollsLaunched).toBe(MAX_ACTIVE_RAGDOLLS);
    expect(system.diagnostics.ragdollsSuppressed).toBe(40 - MAX_ACTIVE_RAGDOLLS);
    system.dispose();
  });

  it('ignores a death that was nowhere near an impact', () => {
    const bus = createEventBus();
    const ragdolls = new FakeRagdollSink();
    const system = new DestructionSystem({ bus, ragdolls, seed: 'ragdoll-far' });
    system.update(1 / 60);

    bus.emit('ShockwaveFired', {
      origin: { x: 0, y: 2, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      power: 2.5e6,
      range: 180,
      angle: 0.4,
      intent: 'full',
      punchKind: 'serious',
    });
    bus.emit('EntityKilled', {
      entityId: 'far-away',
      entityType: 'monster',
      faction: 'monster',
      position: { x: 900, y: 1, z: 900 },
      intent: 'full',
      rewardPoints: 10,
    });
    expect(ragdolls.launches.length).toBe(0);
    system.dispose();
  });

  it('ignores a death long after the impact', () => {
    const bus = createEventBus();
    const ragdolls = new FakeRagdollSink();
    const system = new DestructionSystem({ bus, ragdolls, seed: 'ragdoll-late' });
    system.update(1 / 60);

    bus.emit('ShockwaveFired', {
      origin: { x: 0, y: 2, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      power: 2.5e6,
      range: 180,
      angle: 0.4,
      intent: 'full',
      punchKind: 'serious',
    });
    for (let frame = 0; frame < 180; frame++) system.update(1 / 60);
    bus.emit('EntityKilled', {
      entityId: 'late',
      entityType: 'monster',
      faction: 'monster',
      position: { x: 4, y: 1, z: 0 },
      intent: 'full',
      rewardPoints: 10,
    });
    expect(ragdolls.launches.length).toBe(0);
    system.dispose();
  });

  it('launches away from the impact and upward', () => {
    const bus = createEventBus();
    const ragdolls = new FakeRagdollSink();
    const system = new DestructionSystem({ bus, ragdolls, seed: 'ragdoll-dir' });
    system.update(1 / 60);

    bus.emit('ShockwaveFired', {
      origin: { x: 0, y: 1, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      power: 2.5e6,
      range: 180,
      angle: 0.4,
      intent: 'full',
      punchKind: 'serious',
    });
    bus.emit('EntityKilled', {
      entityId: 'victim',
      entityType: 'monster',
      faction: 'monster',
      position: { x: 6, y: 1, z: 0 },
      intent: 'full',
      rewardPoints: 10,
    });

    const launch = ragdolls.launches[0]!;
    expect(launch.impulse[0]).toBeGreaterThan(0);
    expect(launch.impulse[1]).toBeGreaterThan(0);
    system.dispose();
  });
});
