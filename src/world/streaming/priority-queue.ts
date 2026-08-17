/**
 * LOAD PRIORITY — WHAT THE PLAYER IS LOOKING AT ARRIVES FIRST
 *
 * A streaming system with the right budget and the wrong order still feels
 * broken: the budget guarantees that two chunks arrive this frame, and priority
 * decides whether they are the two in front of the camera or the two behind it.
 * Everything in this file exists to make that second question have an obvious
 * answer.
 *
 * ── THE SCORE ──────────────────────────────────────────────────────────────
 *
 *     score = ring * RING_PRIORITY_STRIDE + effectiveDistance
 *
 *     effectiveDistance = trueDistance
 *                       * (1 + ANGLE_PRIORITY_WEIGHT * (1 - dot(toChunk, view)))
 *                       * (pvsVisible ? 1 : PVS_PRIORITY_PENALTY)
 *
 * Three properties fall out of that shape, and all three are deliberate:
 *
 *  • **Ring is absolute.** The stride is larger than any achievable effective
 *    distance, so no R1 chunk can ever overtake an R0 chunk. Detail near the
 *    player is never traded for coverage far from them.
 *  • **Angle bends distance instead of replacing it.** A chunk directly behind
 *    the camera is treated as 4x further away than one dead ahead. It still
 *    loads — the player can turn around — but it queues behind everything they
 *    can currently see. Sorting on angle *first* would be worse: it would load
 *    a distant chunk dead ahead before a near one at 30 degrees off, which is
 *    the opposite of what the eye notices.
 *  • **The PVS is a tiebreak, not a filter.** `isChunkPotentiallyVisible` from
 *    `src/spatial/` says a chunk cannot be seen from where the camera stands;
 *    that is worth a 2x penalty, not exclusion, because the camera moves and a
 *    chunk that was invisible one frame is around the corner the next.
 *
 * ── WHY A HEAP AND NOT A SORT ──────────────────────────────────────────────
 * The queue is re-scored whenever the camera moves enough to matter, and a full
 * re-score is `heapify`, which is O(n) — cheaper than the O(n log n) sort the
 * obvious implementation would do, on a structure that changes every frame.
 */

import { CHUNK_SIZE, chunkCentreX, chunkCentreZ } from '@/spatial/constants';
import {
  ANGLE_PRIORITY_WEIGHT,
  PVS_PRIORITY_PENALTY,
  RING_PRIORITY_STRIDE,
} from './constants';

/** One queued chunk build. */
export interface IQueuedChunk {
  /** Dense chunk index 0..255. */
  readonly chunk: number;
  /** Ring the chunk should be built at. */
  ring: number;
  /** Current score. Lower loads sooner. */
  score: number;
  /** True distance in metres, kept for stats and for the harness assertions. */
  distance: number;
  /** `1 - dot(toChunk, viewForward)`, in 0..2. 0 is dead ahead. */
  angleTerm: number;
  /** False when the cached PVS says this chunk cannot be seen from the camera. */
  pvsVisible: boolean;
  /** Frame the entry was enqueued on, for starvation diagnostics. */
  readonly enqueuedFrame: number;
}

/** The view state priority is computed against. */
export interface IPriorityView {
  readonly x: number;
  readonly z: number;
  /** Unit forward direction on the XZ plane. */
  readonly forwardX: number;
  readonly forwardZ: number;
  /** Dense chunk index the camera stands in, or -1 outside the world. */
  readonly viewChunk: number;
}

/**
 * Score one chunk. Exported because the harness asserts the ordering property
 * directly against it, and a test that recomputes the formula would only be
 * testing its own copy of the formula.
 */
export function scoreChunk(
  chunk: number,
  ring: number,
  view: IPriorityView,
  pvsVisible: boolean
): { score: number; distance: number; angleTerm: number } {
  const dx = chunkCentreX(chunk) - view.x;
  const dz = chunkCentreZ(chunk) - view.z;
  const distance = Math.sqrt(dx * dx + dz * dz);

  // A chunk the camera stands inside has no meaningful direction; treat it as
  // dead ahead rather than dividing by a distance of nearly zero.
  let angleTerm = 0;
  if (distance > 1e-3) {
    const dot = (dx * view.forwardX + dz * view.forwardZ) / distance;
    angleTerm = 1 - Math.max(-1, Math.min(1, dot));
  }

  const effective =
    distance * (1 + ANGLE_PRIORITY_WEIGHT * angleTerm) * (pvsVisible ? 1 : PVS_PRIORITY_PENALTY);

  return { score: ring * RING_PRIORITY_STRIDE + effective, distance, angleTerm };
}

/**
 * Binary min-heap of pending chunk builds, with an index so an entry can be
 * found, re-scored or removed in O(log n) without a linear scan.
 */
export class ChunkPriorityQueue {
  private readonly heap: IQueuedChunk[] = [];
  /** Chunk index -> position in `heap`. */
  private readonly positions = new Map<number, number>();

  get size(): number {
    return this.heap.length;
  }

  /** True when the chunk is queued. */
  has(chunk: number): boolean {
    return this.positions.has(chunk);
  }

  /** The queued entry for a chunk, if any. */
  get(chunk: number): IQueuedChunk | undefined {
    const at = this.positions.get(chunk);
    return at === undefined ? undefined : this.heap[at];
  }

  /**
   * Queue a chunk, or update the ring of one already queued. Re-queuing at a
   * different ring is the normal path when a chunk crosses a ring boundary
   * before its first build has been dispatched.
   */
  push(entry: IQueuedChunk): void {
    const at = this.positions.get(entry.chunk);
    if (at !== undefined) {
      const existing = this.heap[at]!;
      existing.ring = entry.ring;
      existing.score = entry.score;
      existing.distance = entry.distance;
      existing.angleTerm = entry.angleTerm;
      existing.pvsVisible = entry.pvsVisible;
      this.siftUp(at);
      this.siftDown(this.positions.get(entry.chunk)!);
      return;
    }
    this.heap.push(entry);
    this.positions.set(entry.chunk, this.heap.length - 1);
    this.siftUp(this.heap.length - 1);
  }

  /** Remove and return the highest-priority entry. */
  pop(): IQueuedChunk | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0]!;
    const last = this.heap.pop()!;
    this.positions.delete(top.chunk);
    if (this.heap.length > 0 && last !== top) {
      this.heap[0] = last;
      this.positions.set(last.chunk, 0);
      this.siftDown(0);
    }
    return top;
  }

  /** The highest-priority entry without removing it. */
  peek(): IQueuedChunk | undefined {
    return this.heap[0];
  }

  /** Drop a chunk from the queue. Returns true when it was queued. */
  remove(chunk: number): boolean {
    const at = this.positions.get(chunk);
    if (at === undefined) return false;
    const last = this.heap.pop()!;
    this.positions.delete(chunk);
    if (at < this.heap.length) {
      this.heap[at] = last;
      this.positions.set(last.chunk, at);
      this.siftDown(at);
      this.siftUp(this.positions.get(last.chunk)!);
    }
    return true;
  }

  /**
   * Re-score every entry against a new view and restore the heap in O(n).
   *
   * `pvsFor` is the streaming system's wrapper around
   * `SpatialIndex.isChunkPotentiallyVisible`, passed in rather than imported so
   * the queue stays a pure data structure with no knowledge of the spatial
   * index.
   */
  rescore(view: IPriorityView, pvsFor: (chunk: number) => boolean): void {
    for (const entry of this.heap) {
      const scored = scoreChunk(entry.chunk, entry.ring, view, pvsFor(entry.chunk));
      entry.score = scored.score;
      entry.distance = scored.distance;
      entry.angleTerm = scored.angleTerm;
      entry.pvsVisible = pvsFor(entry.chunk);
    }
    // Floyd's heapify: O(n), against O(n log n) for repeated sift-ups.
    for (let i = (this.heap.length >> 1) - 1; i >= 0; i--) this.siftDown(i);
  }

  /** Empty the queue. */
  clear(): void {
    this.heap.length = 0;
    this.positions.clear();
  }

  /** Entries in heap order. Diagnostics only — NOT sorted. */
  entries(): readonly IQueuedChunk[] {
    return this.heap;
  }

  /** Entries sorted by priority. Diagnostics and the harness overlay. */
  sortedEntries(): IQueuedChunk[] {
    return this.heap.slice().sort((a, b) => a.score - b.score);
  }

  /* ------------------------------------------------------------------ */
  /* Heap internals                                                     */
  /* ------------------------------------------------------------------ */

  private siftUp(start: number): void {
    let at = start;
    const item = this.heap[at]!;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      const other = this.heap[parent]!;
      if (other.score <= item.score) break;
      this.heap[at] = other;
      this.positions.set(other.chunk, at);
      at = parent;
    }
    this.heap[at] = item;
    this.positions.set(item.chunk, at);
  }

  private siftDown(start: number): void {
    const length = this.heap.length;
    let at = start;
    const item = this.heap[at]!;
    for (;;) {
      const left = at * 2 + 1;
      if (left >= length) break;
      const right = left + 1;
      let child = left;
      if (right < length && this.heap[right]!.score < this.heap[left]!.score) child = right;
      const other = this.heap[child]!;
      if (other.score >= item.score) break;
      this.heap[at] = other;
      this.positions.set(other.chunk, at);
      at = child;
    }
    this.heap[at] = item;
    this.positions.set(item.chunk, at);
  }
}

/**
 * Chebyshev distance from a world position to a chunk centre, in chunk units.
 * The metric the ring bands are defined in; see `constants.ts`.
 */
export function chunkDistanceUnits(chunk: number, x: number, z: number): number {
  const dx = Math.abs(chunkCentreX(chunk) - x);
  const dz = Math.abs(chunkCentreZ(chunk) - z);
  return (dx > dz ? dx : dz) / CHUNK_SIZE;
}
