/**
 * THE COLLAPSE SCHEDULER
 *
 * When a floor loses more than 60% of its supports, everything from that floor
 * upward comes down. Doing that in one frame is the single easiest way to make
 * an expensive destruction system look cheap: forty chunks born on the same
 * frame with the same velocity phase read as the building being SWITCHED OFF,
 * not as it falling.
 *
 * So a collapse is spread over `COLLAPSE_STAGGER_FRAMES` (3, i.e. 50 ms at
 * 60 Hz), lowest storey first:
 *
 *   frame n      the lowest third of the failing storeys let go
 *   frame n + 1  the middle third follows into the gap
 *   frame n + 2  the top third arrives last
 *
 * That ordering is not arbitrary — it is what a pancake collapse actually
 * does, and it is why the eye reads a wave travelling up the building instead
 * of a deletion. 50 ms is far too short to look like a stutter and just long
 * enough to be unmistakable.
 *
 * The queue is three parallel arrays and a write cursor. Entries are
 * overwritten in place, so a collapse costs no allocation once the queue has
 * reached its high-water mark.
 */

import { COLLAPSE_MAX_DETACH_PER_FRAME, COLLAPSE_STAGGER_FRAMES } from './constants';
import type { RegisteredStructure } from './structure';

/** One queued detach. */
export interface ICollapseEntry {
  readonly structure: RegisteredStructure;
  readonly chunkIndex: number;
}

/** Called for each chunk as its wave comes due. */
export type CollapseDrainFn = (structure: RegisteredStructure, chunkIndex: number) => void;

const INITIAL_CAPACITY = 512;

export class CollapseScheduler {
  /** Structures, chunk indices and due frames, index-aligned. */
  private structures: (RegisteredStructure | undefined)[] = new Array(INITIAL_CAPACITY).fill(
    undefined
  );
  private chunkIndices = new Int32Array(INITIAL_CAPACITY);
  private dueFrames = new Int32Array(INITIAL_CAPACITY);

  /** Live entries occupy `[head, tail)`. */
  private head = 0;
  private tail = 0;

  private readonly maxPerFrame: number;

  constructor(maxPerFrame = COLLAPSE_MAX_DETACH_PER_FRAME) {
    this.maxPerFrame = Math.max(1, maxPerFrame | 0);
  }

  /** Chunks waiting to fall. */
  get pending(): number {
    return this.tail - this.head;
  }

  /**
   * Queue every surviving chunk on `floors`, staggered into
   * `COLLAPSE_STAGGER_FRAMES` waves, lowest storey first.
   *
   * Returns the number of chunks queued. Floors are expected in ascending
   * order — the generator's `collapsingFloors` returns them that way, and the
   * wave assignment depends on it.
   */
  enqueue(
    structure: RegisteredStructure,
    floors: readonly number[],
    currentFrame: number
  ): number {
    if (floors.length === 0) return 0;
    let queued = 0;
    for (let i = 0; i < floors.length; i++) {
      const floorIndex = floors[i]!;
      const floor = structure.layout.floors[floorIndex];
      if (floor === undefined) continue;
      if (structure.collapsed[floorIndex] === 1) continue;
      structure.collapsed[floorIndex] = 1;

      // Wave from the storey's position in the failing set, not from its
      // absolute height: a two-storey shopfront still collapses in a wave, and
      // a 20-storey tower does not spend 20 frames doing it.
      const wave = Math.min(
        COLLAPSE_STAGGER_FRAMES - 1,
        Math.floor((i * COLLAPSE_STAGGER_FRAMES) / floors.length)
      );
      const due = currentFrame + wave;

      for (const chunkIndex of floor.chunks) {
        if (structure.destroyed[chunkIndex] === 1) continue;
        this.push(structure, chunkIndex, due);
        queued++;
      }
    }
    return queued;
  }

  /**
   * Detach everything due on or before `frame`, up to the per-frame ceiling.
   * Anything over the ceiling stays queued and arrives next frame — a
   * three-block collapse degrades into a slightly longer collapse rather than
   * into a dropped frame.
   */
  drain(frame: number, detach: CollapseDrainFn): number {
    let done = 0;
    while (this.head < this.tail && done < this.maxPerFrame) {
      if (this.dueFrames[this.head]! > frame) break;
      const structure = this.structures[this.head];
      const chunkIndex = this.chunkIndices[this.head]!;
      this.structures[this.head] = undefined;
      this.head++;
      if (structure !== undefined) {
        detach(structure, chunkIndex);
        done++;
      }
    }
    if (this.head === this.tail) {
      this.head = 0;
      this.tail = 0;
    }
    return done;
  }

  /** Drop every queued detach belonging to a structure being unregistered. */
  removeStructure(structure: RegisteredStructure): void {
    for (let i = this.head; i < this.tail; i++) {
      if (this.structures[i] === structure) this.structures[i] = undefined;
    }
  }

  clear(): void {
    for (let i = this.head; i < this.tail; i++) this.structures[i] = undefined;
    this.head = 0;
    this.tail = 0;
  }

  private push(structure: RegisteredStructure, chunkIndex: number, due: number): void {
    if (this.tail === this.structures.length) {
      if (this.head > 0) {
        this.compact();
      } else {
        this.grow();
      }
    }
    this.structures[this.tail] = structure;
    this.chunkIndices[this.tail] = chunkIndex;
    this.dueFrames[this.tail] = due;
    this.tail++;
  }

  /** Slide live entries back to zero. Cheaper than growing, and allocation-free. */
  private compact(): void {
    const live = this.tail - this.head;
    for (let i = 0; i < live; i++) {
      this.structures[i] = this.structures[this.head + i];
      this.chunkIndices[i] = this.chunkIndices[this.head + i]!;
      this.dueFrames[i] = this.dueFrames[this.head + i]!;
    }
    for (let i = live; i < this.tail; i++) this.structures[i] = undefined;
    this.head = 0;
    this.tail = live;
  }

  /**
   * Double the queue. Happens at most a handful of times in a session, and
   * never inside the steady state a frame-budget test measures.
   */
  private grow(): void {
    const size = this.structures.length * 2;
    const structures: (RegisteredStructure | undefined)[] = new Array(size).fill(undefined);
    for (let i = 0; i < this.structures.length; i++) structures[i] = this.structures[i];
    const chunkIndices = new Int32Array(size);
    chunkIndices.set(this.chunkIndices);
    const dueFrames = new Int32Array(size);
    dueFrames.set(this.dueFrames);
    this.structures = structures;
    this.chunkIndices = chunkIndices;
    this.dueFrames = dueFrames;
  }
}
