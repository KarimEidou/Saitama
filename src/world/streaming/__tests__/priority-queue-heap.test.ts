/**
 * PRIORITY QUEUE MECHANICS
 *
 * `priority.test.ts` pins the ORDERING POLICY (ring, angle, PVS). This file
 * pins the DATA STRUCTURE: the heap array and the chunk -> position map must
 * agree after every operation, because a desync between them is silent and
 * hands `dispatch()` the wrong chunk for the rest of the session.
 *
 * Every write path — `push`, `pop`, `remove`, `siftUp`, `siftDown`, `clear` —
 * touches both structures. Nothing throws when they disagree; the queue simply
 * starts answering `get`/`remove` with the wrong entry, which reads downstream
 * as "streaming loaded the chunk behind the player first" and nothing else.
 */

import { describe, expect, it } from 'vitest';
import { createRng } from '@/util';
import { ChunkPriorityQueue, type IQueuedChunk } from '../priority-queue';

function entry(chunk: number, score: number): IQueuedChunk {
  return {
    chunk,
    ring: 0,
    score,
    distance: score,
    angleTerm: 0,
    pvsVisible: true,
    enqueuedFrame: 0,
  };
}

/** Heap property plus position-map consistency. Called after every mutation. */
function assertConsistent(queue: ChunkPriorityQueue): void {
  const heap = queue.entries();
  expect(heap.length).toBe(queue.size);
  for (let i = 0; i < heap.length; i++) {
    const left = i * 2 + 1;
    const right = left + 1;
    if (left < heap.length) expect(heap[i]!.score).toBeLessThanOrEqual(heap[left]!.score);
    if (right < heap.length) expect(heap[i]!.score).toBeLessThanOrEqual(heap[right]!.score);
    // The map must resolve every entry back to itself.
    expect(queue.has(heap[i]!.chunk)).toBe(true);
    expect(queue.get(heap[i]!.chunk)).toBe(heap[i]);
  }
}

/** Pop everything, returning the entries in the order the queue gave them up. */
function drain(queue: ChunkPriorityQueue): IQueuedChunk[] {
  const out: IQueuedChunk[] = [];
  for (;;) {
    const popped = queue.pop();
    if (popped === undefined) break;
    out.push(popped);
  }
  return out;
}

/** The eight-entry fixture the `remove` cases share. */
function fixture(): ChunkPriorityQueue {
  const queue = new ChunkPriorityQueue();
  const scores = [5, 1, 9, 3, 7, 2, 8, 4];
  scores.forEach((score, chunk) => queue.push(entry(chunk, score)));
  return queue;
}

describe('ChunkPriorityQueue heap mechanics', () => {
  it('sifts DOWN when an entry is re-pushed with a worse score', () => {
    // `priority.test.ts` only ever lowers a score, so the `siftDown` half of the
    // update branch is a no-op there. Raising one is what the assignment pass
    // does whenever a queued chunk drifts further from the camera.
    const queue = new ChunkPriorityQueue();
    for (let chunk = 0; chunk < 5; chunk++) queue.push(entry(chunk, chunk + 1));
    assertConsistent(queue);

    queue.push(entry(0, 100));
    expect(queue.size).toBe(5);
    expect(queue.peek()!.chunk).toBe(1);
    assertConsistent(queue);

    expect(drain(queue).map((e) => e.chunk)).toEqual([1, 2, 3, 4, 0]);
  });

  it('removes the root and keeps the heap valid', () => {
    const queue = fixture();
    const top = queue.peek()!.chunk;
    expect(queue.remove(top)).toBe(true);
    expect(queue.size).toBe(7);
    assertConsistent(queue);

    let previous = -Infinity;
    for (const popped of drain(queue)) {
      expect(popped.chunk).not.toBe(top);
      expect(popped.score).toBeGreaterThanOrEqual(previous);
      previous = popped.score;
    }
  });

  it('removes the last heap slot without corrupting the map', () => {
    // `remove` pops the tail first, so removing the tail itself must NOT write
    // `heap[at]` — `at` is one past the end by then.
    const queue = fixture();
    const heap = queue.entries();
    const last = heap[heap.length - 1]!.chunk;
    expect(queue.remove(last)).toBe(true);
    expect(queue.has(last)).toBe(false);
    expect(queue.size).toBe(7);
    assertConsistent(queue);

    let previous = -Infinity;
    for (const popped of drain(queue)) {
      expect(popped.chunk).not.toBe(last);
      expect(popped.score).toBeGreaterThanOrEqual(previous);
      previous = popped.score;
    }
  });

  it('clear() empties the position map as well as the heap', () => {
    // A `positions` entry outliving `clear()` sends the next push of that chunk
    // down the UPDATE branch, where it writes into a heap slot that no longer
    // exists — the queue's one genuinely silent corruption.
    const queue = new ChunkPriorityQueue();
    for (let chunk = 0; chunk < 5; chunk++) queue.push(entry(chunk, chunk + 1));

    queue.clear();
    expect(queue.size).toBe(0);
    expect(queue.peek()).toBeUndefined();
    expect(queue.pop()).toBeUndefined();
    for (let chunk = 0; chunk < 5; chunk++) {
      expect(queue.has(chunk)).toBe(false);
      expect(queue.get(chunk)).toBeUndefined();
    }

    queue.push(entry(3, 42));
    expect(queue.size).toBe(1);
    expect(queue.peek()!.chunk).toBe(3);
    expect(queue.get(3)!.score).toBe(42);
    assertConsistent(queue);
  });

  it('keeps the heap valid through a randomised op sequence', () => {
    const rng = createRng(0x51e4d1);
    const queue = new ChunkPriorityQueue();
    /** Chunk -> score, the answer the queue must agree with. */
    const reference = new Map<number, number>();

    for (let i = 0; i < 2000; i++) {
      const id = rng.int(0, 63);
      const roll = rng.next();
      if (roll < 0.5) {
        const score = rng.range(0, 1000);
        queue.push(entry(id, score));
        reference.set(id, score);
      } else if (rng.next() < 0.5) {
        expect(queue.remove(id)).toBe(reference.delete(id));
      } else {
        const popped = queue.pop();
        if (popped === undefined) {
          expect(reference.size).toBe(0);
        } else {
          expect(popped.score).toBe(Math.min(...reference.values()));
          expect(reference.delete(popped.chunk)).toBe(true);
        }
      }
      expect(queue.size).toBe(reference.size);
      if (i % 50 === 0) assertConsistent(queue);
    }

    const drained = drain(queue);
    expect(drained.length).toBe(reference.size);
    let previous = -Infinity;
    for (const popped of drained) {
      expect(popped.score).toBeGreaterThanOrEqual(previous);
      previous = popped.score;
      expect(reference.get(popped.chunk)).toBe(popped.score);
      reference.delete(popped.chunk);
    }
    expect(reference.size).toBe(0);
    expect(queue.size).toBe(0);
  });

  it('peek and get are undefined on an empty queue', () => {
    const queue = new ChunkPriorityQueue();
    expect(queue.size).toBe(0);
    expect(queue.peek()).toBeUndefined();
    expect(queue.pop()).toBeUndefined();
    expect(queue.get(0)).toBeUndefined();
    expect(queue.has(0)).toBe(false);
    expect(queue.remove(0)).toBe(false);
    expect(queue.entries()).toEqual([]);
    expect(queue.sortedEntries()).toEqual([]);
  });
});
