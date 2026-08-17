/**
 * THE NORMALISED-UINT8 TRAP
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  This file exists because of one bug, and it will keep existing.
 *
 *  `aDestroyed` is a per-vertex Uint8 attribute uploaded NORMALISED. The
 *  shader therefore reads `byte / 255` and tests `> 0.5`. Writing the obvious
 *  `1` gives it 0.0039, the test fails, and NOTHING DISAPPEARS — while every
 *  buffer, every update range and every `needsUpdate` flag looks perfect. The
 *  symptom is indistinguishable from "destruction was never wired up", which
 *  is exactly how it costs an afternoon.
 *
 *  So the arithmetic is asserted, not the constant. A test that only said
 *  `expect(DESTROYED_FLAG).toBe(255)` would pass just as happily if somebody
 *  changed the shader threshold instead.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { describe, expect, it } from 'vitest';
import { createEventBus } from '@/util';
import { DestructionSystem } from '../destruction-system';
import { DESTROYED_FLAG, DESTROYED_SHADER_THRESHOLD, UNORM8_SCALE } from '../constants';
import { FakeDestroyedAttribute, makeTower } from './fixtures';

describe('the normalised-Uint8 trap', () => {
  it('DESTROYED_FLAG survives normalisation; 1 does not', () => {
    expect(DESTROYED_FLAG / UNORM8_SCALE).toBeGreaterThan(DESTROYED_SHADER_THRESHOLD);
    // The bug, stated as an assertion. If this ever fails, the shader's
    // threshold moved and the constant needs revisiting with it.
    expect(1 / UNORM8_SCALE).toBeLessThan(DESTROYED_SHADER_THRESHOLD);
    expect(1 / UNORM8_SCALE).toBeCloseTo(0.00392, 5);
  });

  it('writes 255, not 1, into the attribute', () => {
    const { layout, attribute } = makeTower({ floors: 4 });
    const bus = createEventBus();
    const system = new DestructionSystem({ bus });
    const structure = system.register({
      id: 'tower',
      layout,
      target: { destroyed: attribute },
      position: { x: 0, y: 0, z: 0 },
    });

    const chunk = layout.chunks[5]!;
    expect(system.detachChunk(structure, 5, 'external')).toBe(true);

    for (let v = chunk.vertexStart; v < chunk.vertexStart + chunk.vertexCount; v++) {
      expect(attribute.array[v]).toBe(255);
    }
    system.dispose();
  });

  it('the shader test actually hides exactly the detached chunk', () => {
    const { layout, attribute, vertexCount } = makeTower({ floors: 6, verticesPerChunk: 24 });
    const bus = createEventBus();
    const system = new DestructionSystem({ bus });
    const structure = system.register({
      id: 'tower',
      layout,
      target: { destroyed: attribute },
      position: { x: 0, y: 0, z: 0 },
    });

    expect(attribute.visibleCount()).toBe(vertexCount);

    system.detachChunk(structure, 9, 'external');
    const chunk = layout.chunks[9]!;

    // Every vertex of the chunk is hidden...
    for (let v = chunk.vertexStart; v < chunk.vertexStart + chunk.vertexCount; v++) {
      expect(attribute.isHidden(v)).toBe(true);
    }
    // ...and not one vertex outside it.
    expect(attribute.visibleCount()).toBe(vertexCount - chunk.vertexCount);
    system.dispose();
  });

  it('a hypothetical flag of 1 would hide nothing — the regression, run', () => {
    // Deliberately reproduces the bug with the same machinery, so the test
    // proves the difference rather than asserting a number.
    const { layout, vertexCount } = makeTower({ floors: 3 });
    const buggy = new FakeDestroyedAttribute(vertexCount);
    const chunk = layout.chunks[4]!;
    buggy.array.fill(1, chunk.vertexStart, chunk.vertexStart + chunk.vertexCount);

    expect(buggy.visibleCount()).toBe(vertexCount);
    for (let v = chunk.vertexStart; v < chunk.vertexStart + chunk.vertexCount; v++) {
      expect(buggy.isHidden(v)).toBe(false);
    }
  });

  it('uploads only the touched range', () => {
    const { layout, attribute } = makeTower({ floors: 8, verticesPerChunk: 40 });
    const bus = createEventBus();
    const system = new DestructionSystem({ bus });
    const structure = system.register({
      id: 'tower',
      layout,
      target: { destroyed: attribute },
      position: { x: 0, y: 0, z: 0 },
    });

    system.detachChunk(structure, 12, 'external');
    // The upload is REQUESTED immediately...
    expect(attribute.needsUpdate).toBe(true);
    // ...and the range is recorded when the batch flushes, coalesced across
    // however many chunks the batch took. One chunk here, so one exact range.
    system.update(1 / 60);
    expect(attribute.uploads).toBe(1);
    expect(attribute.updateRanges[0]).toEqual({ start: 12 * 40, count: 40 });
    system.dispose();
  });

  it('is idempotent — a second detach of the same chunk is a no-op', () => {
    const { layout, attribute } = makeTower({ floors: 4 });
    const bus = createEventBus();
    const system = new DestructionSystem({ bus });
    const structure = system.register({
      id: 'tower',
      layout,
      target: { destroyed: attribute },
      position: { x: 0, y: 0, z: 0 },
    });

    expect(system.detachChunk(structure, 2, 'external')).toBe(true);
    expect(system.detachChunk(structure, 2, 'external')).toBe(false);
    system.update(1 / 60);
    expect(attribute.uploads).toBe(1);
    expect(system.diagnostics.chunksDestroyed).toBe(1);
    system.dispose();
  });
});
