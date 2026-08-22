/**
 * LOAD PRIORITY
 *
 * Two chunks per frame is only acceptable if they are the right two. These
 * tests pin the ordering properties the design promises — ring is absolute,
 * angle bends distance, the PVS is a tiebreak — and the heap mechanics that
 * make re-scoring every frame affordable.
 */

import { describe, expect, it } from 'vitest';
import {
  ChunkPriorityQueue,
  chunkDistanceUnits,
  scoreChunk,
  type IPriorityView,
} from '../priority-queue';
import { chunkIndex, CHUNK_SIZE, chunkCentreX, chunkCentreZ } from '@/spatial/constants';
import { RING_PRIORITY_STRIDE } from '../constants';

/** Camera at the centre of chunk (0,0), looking north (-Z). */
const view: IPriorityView = {
  x: chunkCentreX(chunkIndex(0, 0)),
  z: chunkCentreZ(chunkIndex(0, 0)),
  forwardX: 0,
  forwardZ: -1,
  viewChunk: chunkIndex(0, 0),
};

describe('scoreChunk', () => {
  it('loads what is in front before what is behind, at equal distance', () => {
    const ahead = scoreChunk(chunkIndex(0, -3), 1, view, true);
    const behind = scoreChunk(chunkIndex(0, 3), 1, view, true);

    expect(ahead.distance).toBeCloseTo(behind.distance, 6);
    expect(ahead.angleTerm).toBeCloseTo(0, 6);
    expect(behind.angleTerm).toBeCloseTo(2, 6);
    expect(ahead.score).toBeLessThan(behind.score);
  });

  it('prefers a distant chunk ahead over a nearer one behind', () => {
    // 3 chunks ahead beats 1 chunk behind: the angle weight makes "behind"
    // count as 4x the distance, so 288 m ahead outranks 96 m behind.
    const farAhead = scoreChunk(chunkIndex(0, -3), 1, view, true);
    const nearBehind = scoreChunk(chunkIndex(0, 1), 1, view, true);
    expect(farAhead.score).toBeLessThan(nearBehind.score);
  });

  it('still prefers a near chunk slightly off-axis over a far one dead ahead', () => {
    // The counter-property: angle must BEND distance, not replace it. A chunk
    // one ring away at 45 degrees must beat one six rings away dead ahead.
    const nearDiagonal = scoreChunk(chunkIndex(1, -1), 1, view, true);
    const farAhead = scoreChunk(chunkIndex(0, -6), 1, view, true);
    expect(nearDiagonal.score).toBeLessThan(farAhead.score);
  });

  it('makes ring membership absolute', () => {
    // The worst possible R0 chunk still outranks the best possible R1 chunk.
    const worstR0 = scoreChunk(chunkIndex(7, 7), 0, view, false);
    const bestR1 = scoreChunk(chunkIndex(0, -1), 1, view, true);
    expect(worstR0.score).toBeLessThan(bestR1.score);
    expect(bestR1.score).toBeGreaterThan(RING_PRIORITY_STRIDE);
  });

  it('penalises PVS-occluded chunks without excluding them', () => {
    const visible = scoreChunk(chunkIndex(0, -2), 1, view, true);
    const occluded = scoreChunk(chunkIndex(0, -2), 1, view, false);
    expect(occluded.score).toBeGreaterThan(visible.score);
    // Still in the same ring band — a penalty, not a demotion.
    expect(occluded.score).toBeLessThan(2 * RING_PRIORITY_STRIDE);
  });

  it('treats the chunk under the camera as dead ahead', () => {
    const here = scoreChunk(view.viewChunk, 0, view, true);
    expect(here.angleTerm).toBe(0);
    expect(here.score).toBeLessThan(1);
  });
});

describe('ChunkPriorityQueue', () => {
  const push = (queue: ChunkPriorityQueue, chunk: number, score: number): void => {
    queue.push({
      chunk,
      ring: 0,
      score,
      distance: score,
      angleTerm: 0,
      pvsVisible: true,
      enqueuedFrame: 0,
    });
  };

  it('pops in ascending score order', () => {
    const queue = new ChunkPriorityQueue();
    const scores = [42, 7, 99, 1, 63, 12, 55, 3];
    scores.forEach((score, i) => push(queue, i, score));

    const popped: number[] = [];
    for (;;) {
      const entry = queue.pop();
      if (entry === undefined) break;
      popped.push(entry.score);
    }
    expect(popped).toEqual([...scores].sort((a, b) => a - b));
    expect(queue.size).toBe(0);
  });

  it('updates an already-queued chunk instead of duplicating it', () => {
    const queue = new ChunkPriorityQueue();
    push(queue, 5, 100);
    push(queue, 6, 50);
    push(queue, 5, 10);
    expect(queue.size).toBe(2);
    expect(queue.pop()!.chunk).toBe(5);
    expect(queue.pop()!.chunk).toBe(6);
  });

  it('removes an arbitrary entry and keeps the heap valid', () => {
    const queue = new ChunkPriorityQueue();
    for (let i = 0; i < 32; i++) push(queue, i, (i * 37) % 101);
    expect(queue.remove(17)).toBe(true);
    expect(queue.remove(17)).toBe(false);
    expect(queue.size).toBe(31);

    let previous = -Infinity;
    for (;;) {
      const entry = queue.pop();
      if (entry === undefined) break;
      expect(entry.score).toBeGreaterThanOrEqual(previous);
      expect(entry.chunk).not.toBe(17);
      previous = entry.score;
    }
  });

  it('keeps an explicit pin ahead of everything through a re-score', () => {
    // The queue is re-scored before EVERY dispatch, so a score written once at
    // enqueue time is erased before anything acts on it. A chunk pinned by
    // `requestChunk` for a fast-travel destination in R2 would be rescored to
    // ~2e5 and land behind every R0 and R1 entry in the queue — hundreds of
    // frames of waiting for a call documented as "load now".
    const queue = new ChunkPriorityQueue();
    const near = chunkIndex(0, -1);
    const far = chunkIndex(7, 7);
    push(queue, near, 0);
    queue.push({
      chunk: far,
      ring: 2,
      score: -1e9,
      distance: 0,
      angleTerm: 0,
      pvsVisible: true,
      pinned: true,
      enqueuedFrame: 0,
    });

    queue.rescore(view, () => true);
    expect(queue.peek()!.chunk).toBe(far);
    expect(queue.peek()!.score).toBe(-1e9);
    // The distance fields still track the camera — only the score is held.
    expect(queue.get(far)!.distance).toBeGreaterThan(0);
  });

  it('does not let the next plain push erase a pin', () => {
    // The assignment pass re-queues a wanted chunk every frame until it is
    // dispatched, which is the other half of the same erasure.
    const queue = new ChunkPriorityQueue();
    const pinnedChunk = chunkIndex(4, 4);
    queue.push({
      chunk: pinnedChunk,
      ring: 1,
      score: -1e9,
      distance: 0,
      angleTerm: 0,
      pvsVisible: true,
      pinned: true,
      enqueuedFrame: 0,
    });
    push(queue, pinnedChunk, 5000);
    expect(queue.peek()!.score).toBe(-1e9);
  });

  it('re-applies a prefetch bias so a hint never outranks real work', () => {
    const queue = new ChunkPriorityQueue();
    const hint = chunkIndex(0, -1);
    const real = chunkIndex(6, 6);
    // The hint is the NEAREST chunk of the two, so only the bias can hold it
    // back once the queue is re-scored.
    queue.push({
      chunk: hint,
      ring: 0,
      score: 0,
      distance: 0,
      angleTerm: 0,
      pvsVisible: true,
      bias: 4 * RING_PRIORITY_STRIDE,
      enqueuedFrame: 0,
    });
    push(queue, real, 0);

    queue.rescore(view, () => true);
    expect(queue.peek()!.chunk).toBe(real);
    expect(queue.get(hint)!.score).toBeGreaterThan(4 * RING_PRIORITY_STRIDE);

    // Re-pushed by the assignment pass without a bias: the handicap is gone,
    // because by then the system wants the chunk for real.
    push(queue, hint, 12);
    queue.rescore(view, () => true);
    expect(queue.peek()!.chunk).toBe(hint);
  });

  it('re-scores against a new view in one heapify', () => {
    const queue = new ChunkPriorityQueue();
    const ahead = chunkIndex(0, -3);
    const behind = chunkIndex(0, 3);
    push(queue, behind, 0);
    push(queue, ahead, 1000);
    expect(queue.peek()!.chunk).toBe(behind);

    queue.rescore(view, () => true);
    // With the real view applied, the chunk in front now leads.
    expect(queue.peek()!.chunk).toBe(ahead);

    // Turn around; the order must follow the camera.
    queue.rescore({ ...view, forwardZ: 1 }, () => true);
    expect(queue.peek()!.chunk).toBe(behind);
  });
});

describe('chunkDistanceUnits', () => {
  it('is Chebyshev distance in chunk units from the chunk centre', () => {
    const centreX = chunkCentreX(chunkIndex(0, 0));
    const centreZ = chunkCentreZ(chunkIndex(0, 0));
    expect(chunkDistanceUnits(chunkIndex(0, 0), centreX, centreZ)).toBeCloseTo(0, 6);
    expect(chunkDistanceUnits(chunkIndex(1, 0), centreX, centreZ)).toBeCloseTo(1, 6);
    expect(chunkDistanceUnits(chunkIndex(1, 1), centreX, centreZ)).toBeCloseTo(1, 6);
    expect(chunkDistanceUnits(chunkIndex(3, -2), centreX, centreZ)).toBeCloseTo(3, 6);
    // Half a chunk of camera drift moves the metric by exactly half a unit.
    expect(chunkDistanceUnits(chunkIndex(1, 0), centreX + CHUNK_SIZE * 0.5, centreZ)).toBeCloseTo(
      0.5,
      6
    );
  });
});
