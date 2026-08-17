/**
 * COLLAPSE — DOES IT FALL, AND DOES IT FALL OVER THREE FRAMES
 *
 * The two claims that decide whether a collapse reads as a collapse:
 *
 *  1. Losing more than 60% of a floor's supports brings that floor and
 *     everything above it down. Not the punched floor — the LOWEST failing
 *     one, which is what makes a building fold rather than lose a slice.
 *  2. It arrives spread over three frames, lowest storey first. All at once is
 *     a pop; three frames is a wave travelling up the building.
 */

import { describe, expect, it } from 'vitest';
import { createEventBus } from '@/util';
import type { GameEventOf } from '@/types';
import { collapsingFloors as cityCollapsingFloors } from '@/world/city';
import { DestructionSystem } from '../destruction-system';
import { COLLAPSE_STAGGER_FRAMES } from '../constants';
import { makeTower } from './fixtures';

function setup(floors = 12) {
  const { layout, attribute } = makeTower({ floors });
  const bus = createEventBus();
  const detached: GameEventOf<'ChunkDetached'>[] = [];
  bus.on('ChunkDetached', (event) => detached.push(event));
  const system = new DestructionSystem({
    bus,
    // The authority, injected exactly as the bootstrap does it.
    collapsingFloors: cityCollapsingFloors,
    seed: 'collapse-test',
  });
  const structure = system.register({
    id: 'tower',
    layout,
    target: { destroyed: attribute },
    position: { x: 0, y: 0, z: 0 },
  });
  return { bus, system, structure, layout, attribute, detached };
}

describe('structural collapse', () => {
  it('does not collapse while half of a floor still stands', () => {
    const { system, structure } = setup(10);
    system.detachChunk(structure, 0, 'blast');
    system.detachChunk(structure, 1, 'blast');
    // Detaching alone does not evaluate; the sweep does. Force it the way the
    // external-event path does.
    system.update(1 / 60);
    expect(system.diagnostics.collapsesTriggered).toBe(0);
    expect(structure.destroyedCount).toBe(2);
    system.dispose();
  });

  it('brings the whole building down once a floor loses 75% of its supports', () => {
    const { bus, system, structure, layout } = setup(12);

    // A cone aimed straight through the ground floor.
    bus.emit('ShockwaveFired', {
      origin: { x: -40, y: 1.7, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      power: 2.5e6,
      range: 120,
      angle: 0.2,
      intent: 'full',
      punchKind: 'serious',
    });

    expect(system.diagnostics.collapsesTriggered).toBeGreaterThan(0);
    expect(system.diagnostics.pendingCollapseChunks).toBeGreaterThan(0);

    // Drain the waves.
    for (let frame = 0; frame < COLLAPSE_STAGGER_FRAMES + 2; frame++) system.update(1 / 60);

    expect(structure.destroyedCount).toBe(layout.chunks.length);
    expect(system.diagnostics.pendingCollapseChunks).toBe(0);
    system.dispose();
  });

  it('staggers the collapse across three frames, lowest storey first', () => {
    const { bus, system, structure, detached } = setup(12);

    bus.emit('ShockwaveFired', {
      origin: { x: -40, y: 1.7, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      power: 2.5e6,
      range: 120,
      angle: 0.2,
      intent: 'full',
      punchKind: 'serious',
    });

    const perFrame: number[] = [];
    const lowestFloorPerFrame: number[] = [];
    const highestFloorPerFrame: number[] = [];
    for (let frame = 0; frame < 6; frame++) {
      const before = detached.length;
      system.update(1 / 60);
      const wave = detached.slice(before);
      perFrame.push(wave.length);
      if (wave.length > 0) {
        const floors = wave.map((e) => structure.layout.chunks[e.chunkIndex]!.floor);
        lowestFloorPerFrame.push(Math.min(...floors));
        highestFloorPerFrame.push(Math.max(...floors));
      }
    }

    const activeFrames = perFrame.filter((n) => n > 0).length;
    expect(activeFrames).toBe(COLLAPSE_STAGGER_FRAMES);

    // Each wave is strictly higher up the building than the last.
    for (let i = 1; i < lowestFloorPerFrame.length; i++) {
      expect(lowestFloorPerFrame[i]!).toBeGreaterThan(highestFloorPerFrame[i - 1]!);
    }
    // And no single frame carries the whole building.
    const total = perFrame.reduce((a, b) => a + b, 0);
    for (const n of perFrame) expect(n).toBeLessThan(total);
    system.dispose();
  });

  it('emits one ChunkDetached per piece, and only once per piece', () => {
    const { bus, system, structure, detached } = setup(12);

    bus.emit('ShockwaveFired', {
      origin: { x: -40, y: 1.7, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      power: 2.5e6,
      range: 120,
      angle: 0.2,
      intent: 'full',
      punchKind: 'serious',
    });
    for (let frame = 0; frame < 6; frame++) system.update(1 / 60);

    expect(detached.length).toBe(structure.chunkCount);
    const seen = new Set(detached.map((e) => e.chunkIndex));
    expect(seen.size).toBe(structure.chunkCount);
    for (const event of detached) {
      expect(event.structureId).toBe('tower');
      expect(event.mass).toBeGreaterThan(0);
      expect(event.material).toBe('concrete');
      expect(event.collateralCost).toBeGreaterThan(0);
      expect(Number.isFinite(event.impulse.x)).toBe(true);
    }
    system.dispose();
  });

  it('collapse debris falls; blast debris is thrown along the axis', () => {
    const { bus, system, detached } = setup(12);

    bus.emit('ShockwaveFired', {
      origin: { x: -40, y: 1.7, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      power: 2.5e6,
      range: 120,
      angle: 0.2,
      intent: 'full',
      punchKind: 'serious',
    });
    const blastWave = detached.slice();
    expect(blastWave.length).toBeGreaterThan(0);

    detached.length = 0;
    for (let frame = 0; frame < 6; frame++) system.update(1 / 60);
    const collapseWave = detached.slice();
    expect(collapseWave.length).toBeGreaterThan(0);

    // The punch throws pieces down +X and upward.
    const blastMeanX =
      blastWave.reduce((sum, e) => sum + e.impulse.x / e.mass, 0) / blastWave.length;
    const blastMeanY =
      blastWave.reduce((sum, e) => sum + e.impulse.y / e.mass, 0) / blastWave.length;
    expect(blastMeanX).toBeGreaterThan(5);
    expect(blastMeanY).toBeGreaterThan(2);

    // The collapse drops them.
    const collapseMeanY =
      collapseWave.reduce((sum, e) => sum + e.impulse.y / e.mass, 0) / collapseWave.length;
    expect(collapseMeanY).toBeLessThan(0);
    expect(Math.abs(collapseMeanY)).toBeLessThan(Math.abs(blastMeanY));
    system.dispose();
  });

  it('a restrained punch leaves the city alone', () => {
    const { bus, system, structure } = setup(8);
    bus.emit('ShockwaveFired', {
      origin: { x: -40, y: 1.7, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      power: 2.5e6,
      range: 120,
      angle: 0.6,
      intent: 'restrained',
      punchKind: 'normal',
    });
    expect(structure.destroyedCount).toBe(0);
    system.dispose();
  });
});
