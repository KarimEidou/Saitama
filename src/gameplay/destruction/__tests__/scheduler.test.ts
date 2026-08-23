/**
 * THE COLLAPSE QUEUE — WHAT IS ACTUALLY STILL COMING DOWN
 *
 * Claims about the queue itself, all invisible until several buildings fall at
 * once, which is exactly when a collapse is most worth looking at:
 *
 *  1. `pending` counts chunks that will fall. A structure that streamed out
 *     mid-collapse took its queued chunks with it, and a diagnostic that keeps
 *     reporting them shows a collapse that never drains.
 *  2. A wave that is due NOW runs now. The queue is one FIFO whose due frames
 *     are only ordered within a single `enqueue`, so a tower that started
 *     falling one frame after its neighbour sits behind entries that are not
 *     due yet — and if the drain stops at the first of those, that tower's
 *     three-beat collapse arrives in two.
 *  3. The two RESIZE paths — `grow()` past the 512-entry initial capacity and
 *     `compact()` once the window has walked forward — move every live entry
 *     and lose none. They are only ever reached on the frame the system is most
 *     loaded, and a chunk dropped there is a building that never finishes
 *     falling; one duplicated is a piece detached twice.
 *
 * The resize and ceiling tests all drain at a FULLY-DUE frame and loop until
 * the queue is empty, so none of them depends on the queue's ordering between
 * separate `enqueue` calls.
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

/** Every callback the queue produces, drained at a frame everything is due on. */
function drainAll(scheduler: CollapseScheduler): {
  seen: { id: string; chunkIndex: number }[];
  perCall: number[];
} {
  const seen: { id: string; chunkIndex: number }[] = [];
  const perCall: number[] = [];
  for (let guard = 0; guard < 500; guard++) {
    const done = scheduler.drain(1_000_000, (s, chunkIndex) => {
      seen.push({ id: s.id, chunkIndex });
    });
    if (done === 0) return { seen, perCall };
    perCall.push(done);
  }
  throw new Error('queue did not drain in 500 passes');
}

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

describe('the queue resizes without losing a chunk', () => {
  it('grows past its initial 512 entries and still delivers all 800', () => {
    // 200 floors x 4 = 800 chunks, well past `INITIAL_CAPACITY`, so `push`
    // takes the `grow()` branch with `head === 0`.
    const scheduler = new CollapseScheduler();
    const tower = structure('tall', 200);
    expect(scheduler.enqueue(tower, allFloors(200), 0)).toBe(800);
    expect(scheduler.pending).toBe(800);

    const { seen } = drainAll(scheduler);
    expect(seen.length).toBe(800);
    for (const entry of seen) expect(entry.id).toBe('tall');
    // Every chunk index exactly once — nothing dropped by the copy, nothing
    // delivered twice by a stale slot the grow left behind.
    expect(new Set(seen.map((e) => e.chunkIndex)).size).toBe(800);
    expect([...seen].map((e) => e.chunkIndex).sort((x, y) => x - y)).toEqual(
      Array.from({ length: 800 }, (_, i) => i)
    );
    expect(scheduler.pending).toBe(0);
  });

  it('compacts a walked-forward window rather than growing, and keeps every entry', () => {
    // 128 floors x 4 = 512 chunks, filling the queue exactly.
    const scheduler = new CollapseScheduler(10);
    const a = structure('a', 128);
    expect(scheduler.enqueue(a, allFloors(128), 0)).toBe(512);

    // One fully-due pass takes the ceiling's worth and leaves `head === 10`.
    const first: number[] = [];
    expect(scheduler.drain(1_000_000, (_s, chunkIndex) => first.push(chunkIndex))).toBe(10);
    expect(scheduler.pending).toBe(502);

    // `tail` is still 512, so the next push has nowhere to go and — because
    // `head > 0` — slides the window instead of doubling the arrays.
    const b = structure('b', 2);
    expect(scheduler.enqueue(b, allFloors(2), 0)).toBe(8);
    expect(scheduler.pending).toBe(510);

    const { seen } = drainAll(scheduler);
    expect(seen.length).toBe(510);
    const fromA = seen.filter((e) => e.id === 'a').map((e) => e.chunkIndex);
    const fromB = seen.filter((e) => e.id === 'b').map((e) => e.chunkIndex);
    expect(fromB.sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // A's 512 chunks arrived exactly once between the two passes, with the
    // right structure attached to each.
    expect(new Set([...first, ...fromA]).size).toBe(512);
    expect(fromA.length).toBe(502);
    expect(scheduler.pending).toBe(0);
  });
});

describe('the per-frame ceiling', () => {
  it('never exceeds it, and still delivers everything', () => {
    const scheduler = new CollapseScheduler(8);
    const tower = structure('a', 12);
    expect(scheduler.enqueue(tower, allFloors(12), 0)).toBe(48);

    const { seen, perCall } = drainAll(scheduler);
    for (const done of perCall) expect(done).toBeLessThanOrEqual(8);
    expect(perCall.reduce((sum, n) => sum + n, 0)).toBe(48);
    // A three-block collapse degrades into a longer collapse, never a dropped
    // frame and never a dropped chunk.
    expect(new Set(seen.map((e) => e.chunkIndex)).size).toBe(48);
    expect(scheduler.pending).toBe(0);
  });

  it('clamps a nonsense ceiling to at least one chunk a frame', () => {
    const scheduler = new CollapseScheduler(0);
    const tower = structure('a', 2);
    expect(scheduler.enqueue(tower, allFloors(2), 0)).toBe(8);
    const { seen, perCall } = drainAll(scheduler);
    expect(seen.length).toBe(8);
    for (const done of perCall) expect(done).toBe(1);
  });
});

describe('enqueue skip rules', () => {
  it('queues a storey once, however many chunks fall out of it', () => {
    const scheduler = new CollapseScheduler();
    const tower = structure('a', 6);
    expect(scheduler.enqueue(tower, [2, 3], 0)).toBe(8);
    // `collapsed[f]` is already 1: the cascade is queued once and not re-queued
    // by every chunk that falls out of it.
    expect(scheduler.enqueue(tower, [2, 3], 1)).toBe(0);
    expect(scheduler.enqueue(tower, [2, 3, 4], 2)).toBe(4);
    expect(scheduler.pending).toBe(12);
  });

  it('queues nothing for a storey that has already come off', () => {
    const scheduler = new CollapseScheduler();
    const tower = structure('a', 6);
    for (const chunkIndex of tower.layout.floors[3]!.chunks) tower.markDestroyed(chunkIndex);
    expect(scheduler.enqueue(tower, [3], 0)).toBe(0);
    expect(scheduler.pending).toBe(0);
  });

  it('takes an empty set and an out-of-range storey without throwing', () => {
    const scheduler = new CollapseScheduler();
    const tower = structure('a', 6);
    expect(scheduler.enqueue(tower, [], 0)).toBe(0);
    expect(scheduler.enqueue(tower, [99, -1], 0)).toBe(0);
    expect(scheduler.enqueue(tower, [-1, 2, 99], 0)).toBe(4);
    expect(scheduler.pending).toBe(4);
  });
});

describe('removeStructure and clear', () => {
  it('drops one structure and delivers the other in full', () => {
    const scheduler = new CollapseScheduler();
    const a = structure('a', 6);
    const b = structure('b', 6);
    scheduler.enqueue(a, allFloors(6), 0);
    scheduler.enqueue(b, allFloors(6), 0);

    scheduler.removeStructure(a);
    const { seen } = drainAll(scheduler);
    // Not one callback carries the structure that streamed out...
    expect(seen.some((e) => e.id === 'a')).toBe(false);
    // ...and its neighbour lost nothing to the removal walking the window.
    expect(seen.length).toBe(24);
    expect(new Set(seen.map((e) => e.chunkIndex)).size).toBe(24);
    expect(scheduler.pending).toBe(0);
  });

  it('forgets everything on clear', () => {
    const scheduler = new CollapseScheduler();
    scheduler.enqueue(structure('a', 6), allFloors(6), 0);
    scheduler.enqueue(structure('b', 6), allFloors(6), 0);
    expect(scheduler.pending).toBe(48);

    scheduler.clear();
    expect(scheduler.pending).toBe(0);
    const { seen } = drainAll(scheduler);
    expect(seen).toEqual([]);

    // ...and the emptied queue still works.
    const c = structure('c', 3);
    expect(scheduler.enqueue(c, allFloors(3), 0)).toBe(12);
    expect(drainAll(scheduler).seen.length).toBe(12);
  });
});
