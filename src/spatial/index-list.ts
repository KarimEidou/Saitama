/**
 * GROWABLE INT32 LIST
 *
 * Query results are produced tens of times per frame. Returning a fresh
 * `number[]` from each query would hand the GC a few hundred KB per second and
 * show up as a periodic hitch, which is exactly the failure mode object pooling
 * exists to prevent.
 *
 * So every query in `src/spatial/` writes into a caller-owned `IndexList`:
 * an `Int32Array` plus a length. `clear()` resets the length without touching
 * the backing store, so a list reused across frames settles at its high-water
 * capacity and never allocates again.
 *
 * Values are always small non-negative integers — instance handles, chunk
 * indices, entity slots — so Int32 is the right storage.
 */

/** A reusable, growable list of int32 indices. */
export class IndexList {
  private buffer: Int32Array;
  private count = 0;

  constructor(capacity = 256) {
    this.buffer = new Int32Array(Math.max(1, capacity | 0));
  }

  /** Number of valid entries. */
  get length(): number {
    return this.count;
  }

  /** Backing store. Only `[0, length)` is meaningful; may be reallocated. */
  get data(): Int32Array {
    return this.buffer;
  }

  /** Current allocated capacity. */
  get capacity(): number {
    return this.buffer.length;
  }

  /** Reset the length. The backing store is retained for reuse. */
  clear(): void {
    this.count = 0;
  }

  /** Read entry `i`. No bounds check — callers loop over `length`. */
  at(i: number): number {
    return this.buffer[i]!;
  }

  /** Append one value, growing geometrically when full. */
  push(value: number): void {
    if (this.count === this.buffer.length) this.grow(this.count * 2);
    this.buffer[this.count++] = value;
  }

  /**
   * Append `n` values from `src` starting at `offset`.
   * Used when a fully-contained subtree is accepted wholesale.
   */
  pushRange(src: Int32Array | readonly number[], offset: number, n: number): void {
    this.reserve(this.count + n);
    const buf = this.buffer;
    let w = this.count;
    for (let i = 0; i < n; i++) buf[w++] = src[offset + i]!;
    this.count = w;
  }

  /** Ensure capacity for at least `n` total entries. */
  reserve(n: number): void {
    if (n > this.buffer.length) this.grow(n);
  }

  private grow(target: number): void {
    let next = this.buffer.length * 2;
    if (next < target) next = target;
    if (next < 8) next = 8;
    const bigger = new Int32Array(next);
    bigger.set(this.buffer);
    this.buffer = bigger;
  }

  /** Sort the valid range ascending, in place. Test/diagnostic helper. */
  sort(): void {
    this.buffer.subarray(0, this.count).sort();
  }

  /** Copy out to a plain array. ALLOCATES — tests and debug UI only. */
  toArray(): number[] {
    const out = new Array<number>(this.count);
    for (let i = 0; i < this.count; i++) out[i] = this.buffer[i]!;
    return out;
  }

  /** Linear membership test. Debug only; O(n). */
  includes(value: number): boolean {
    for (let i = 0; i < this.count; i++) if (this.buffer[i] === value) return true;
    return false;
  }
}

/**
 * Parallel float payload for a list of hits (ray distances, entity distances).
 *
 * Kept separate from `IndexList` rather than interleaved so the common case —
 * a query that only wants the indices — never pays for the float writes.
 */
export class FloatList {
  private buffer: Float64Array;
  private count = 0;

  constructor(capacity = 256) {
    this.buffer = new Float64Array(Math.max(1, capacity | 0));
  }

  get length(): number {
    return this.count;
  }

  get data(): Float64Array {
    return this.buffer;
  }

  clear(): void {
    this.count = 0;
  }

  at(i: number): number {
    return this.buffer[i]!;
  }

  push(value: number): void {
    if (this.count === this.buffer.length) {
      const bigger = new Float64Array(Math.max(8, this.count * 2));
      bigger.set(this.buffer);
      this.buffer = bigger;
    }
    this.buffer[this.count++] = value;
  }

  toArray(): number[] {
    const out = new Array<number>(this.count);
    for (let i = 0; i < this.count; i++) out[i] = this.buffer[i]!;
    return out;
  }
}
