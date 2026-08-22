/**
 * THE COLLAPSE QUEUE — WHAT IS ACTUALLY STILL COMING DOWN
 *
 * Two claims about the queue itself, both invisible until several buildings
 * fall at once, which is exactly when a collapse is most worth looking at:
 *
 *  1. `pending` counts chunks that will fall. A structure that streamed out
 *     mid-collapse took its queued chunks with it, and a diagnostic that keeps
 *     reporting them shows a collapse that never drains.
 *  2. A wave that is due NOW runs now. The queue is one FIFO whose due frames
 *     are only ordered within a single `enqueue`, so a tower that started
 *     falling one frame after its neighbour sits behind entries that are not
 *     due yet — and if the drain stops at the first of those, that tower's
 *     three-beat collapse arrives in two.
 */

import { describe, expect, it } from 'vitest';
import { CollapseScheduler } from '../collapse-scheduler';
import { RegisteredStructure } from '../structure';
import { makeTower } from './fixtures';

function structure(id: string, floors: number): RegisteredStructure {
  const { layout, attribute } = makeTower({ floors });
  return new RegisteredStructure({
    id,
    layout,
    target: { destroyed: attribute },
    position: { x: 0, y: 0, z: 0 },
  });
}

const allFloors = (count: number): number[] => Array.from({ length: count }, (_, f) => f);

describe('pending', () => {
  it('drops the chunks of a structure that was removed', () => {
    const scheduler = new CollapseScheduler();
    const tower = structure('a', 6);
    const queued = scheduler.enqueue(tower, allFloors(6), 1);
    expect(queued).toBe(24);
    expect(scheduler.pending).toBe(24);

    scheduler.removeStructure(tower);
    // Nothing is going to fall any more, and the readout has to say so on the
    // frame the chunk unloaded — not once the drain happens to walk past it.
    expect(scheduler.pending).toBe(0);

    const drained: number[] = [];
    expect(scheduler.drain(9, (_s, chunkIndex) => drained.push(chunkIndex))).toBe(0);
    expect(drained).toEqual([]);
    expect(scheduler.pending).toBe(0);
  });

  it('counts down as the waves come due', () => {
    const scheduler = new CollapseScheduler();
    const tower = structure('a', 6);
    scheduler.enqueue(tower, allFloors(6), 10);
    expect(scheduler.pending).toBe(24);

    scheduler.drain(10, () => {});
    expect(scheduler.pending).toBe(16);
    scheduler.drain(11, () => {});
    expect(scheduler.pending).toBe(8);
    scheduler.drain(12, () => {});
    expect(scheduler.pending).toBe(0);
  });
});

describe('two collapses one frame apart', () => {
  it("runs the second tower's wave when it is due, not behind the first's", () => {
    const scheduler = new CollapseScheduler();
    const a = structure('a', 6);
    const b = structure('b', 6);

    // A fails on frame 10 (waves due 11, 12, 13); B one street over fails on
    // frame 11 (waves due 12, 13, 14), appended behind A's.
    scheduler.enqueue(a, allFloors(6), 11);
    scheduler.enqueue(b, allFloors(6), 12);

    const seen: string[] = [];
    scheduler.drain(11, (s) => seen.push(s.id));
    expect(seen.filter((id) => id === 'a').length).toBe(8);
    expect(seen.filter((id) => id === 'b').length).toBe(0);

    seen.length = 0;
    scheduler.drain(12, (s) => seen.push(s.id));
    // A's second wave AND B's first, both due on frame 12. Stopping at A's
    // not-yet-due third wave would have left B's first for frame 13, where it
    // would arrive together with B's second.
    expect(seen.filter((id) => id === 'a').length).toBe(8);
    expect(seen.filter((id) => id === 'b').length).toBe(8);

    seen.length = 0;
    scheduler.drain(13, (s) => seen.push(s.id));
    expect(seen.filter((id) => id === 'a').length).toBe(8);
    expect(seen.filter((id) => id === 'b').length).toBe(8);

    seen.length = 0;
    scheduler.drain(14, (s) => seen.push(s.id));
    expect(seen.filter((id) => id === 'b').length).toBe(8);
    expect(scheduler.pending).toBe(0);
  });

  it('never runs a wave before it is due', () => {
    const scheduler = new CollapseScheduler();
    const a = structure('a', 6);
    const b = structure('b', 6);
    scheduler.enqueue(a, allFloors(6), 11);
    scheduler.enqueue(b, allFloors(6), 12);

    expect(scheduler.drain(10, () => {})).toBe(0);
    expect(scheduler.pending).toBe(48);
  });
});
