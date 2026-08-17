/**
 * RING BUFFER
 *
 * Fixed-capacity circular buffer. Writing past capacity overwrites the oldest
 * entry, so it never allocates after construction and never grows without
 * bound — exactly what frame-time histories, event replay logs and rolling
 * telemetry need.
 */

/** Fixed-capacity circular buffer of arbitrary values. */
export class RingBuffer<T> implements Iterable<T> {
  private readonly buffer: (T | undefined)[];
  private head = 0;
  private size = 0;

  constructor(readonly capacity: number) {
    if (capacity <= 0) throw new Error('RingBuffer: capacity must be > 0');
    this.buffer = new Array<T | undefined>(capacity);
  }

  /** Entries currently stored, up to `capacity`. */
  get length(): number {
    return this.size;
  }

  get isFull(): boolean {
    return this.size === this.capacity;
  }

  get isEmpty(): boolean {
    return this.size === 0;
  }

  /** Append, overwriting the oldest entry when full. */
  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  /**
   * Read by age: index 0 is the OLDEST retained entry,
   * `length - 1` is the newest. Returns undefined when out of range.
   */
  get(index: number): T | undefined {
    if (index < 0 || index >= this.size) return undefined;
    const start = (this.head - this.size + this.capacity) % this.capacity;
    return this.buffer[(start + index) % this.capacity];
  }

  /** Most recently pushed entry. */
  get last(): T | undefined {
    return this.size === 0
      ? undefined
      : this.buffer[(this.head - 1 + this.capacity) % this.capacity];
  }

  /** Oldest retained entry. */
  get first(): T | undefined {
    return this.get(0);
  }

  /** Drop everything. */
  clear(): void {
    this.buffer.fill(undefined);
    this.head = 0;
    this.size = 0;
  }

  /** Copy out, oldest first. Allocates — avoid in hot paths. */
  toArray(): T[] {
    const out: T[] = new Array<T>(this.size);
    for (let i = 0; i < this.size; i++) out[i] = this.get(i)!;
    return out;
  }

  /** Iterate oldest to newest. */
  *[Symbol.iterator](): IterableIterator<T> {
    for (let i = 0; i < this.size; i++) yield this.get(i)!;
  }
}

/**
 * Numeric ring buffer backed by a Float64Array.
 *
 * Zero allocation and no boxing, with running statistics — the right choice
 * for per-frame metrics such as frame time and FPS, which are sampled every
 * single frame for the whole session.
 */
export class NumericRingBuffer {
  private readonly buffer: Float64Array;
  private head = 0;
  private size = 0;
  private sum = 0;

  constructor(readonly capacity: number) {
    if (capacity <= 0) throw new Error('NumericRingBuffer: capacity must be > 0');
    this.buffer = new Float64Array(capacity);
  }

  get length(): number {
    return this.size;
  }

  /** Append, evicting the oldest sample when full. */
  push(value: number): void {
    if (this.size === this.capacity) {
      // Subtract the sample about to be overwritten to keep `sum` exact.
      this.sum -= this.buffer[this.head]!;
    } else {
      this.size++;
    }
    this.buffer[this.head] = value;
    this.sum += value;
    this.head = (this.head + 1) % this.capacity;
  }

  /** Index 0 is the oldest retained sample. */
  get(index: number): number | undefined {
    if (index < 0 || index >= this.size) return undefined;
    const start = (this.head - this.size + this.capacity) % this.capacity;
    return this.buffer[(start + index) % this.capacity];
  }

  /** Mean of retained samples; 0 when empty. */
  get average(): number {
    return this.size === 0 ? 0 : this.sum / this.size;
  }

  get min(): number {
    if (this.size === 0) return 0;
    let m = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.size; i++) m = Math.min(m, this.get(i)!);
    return m;
  }

  get max(): number {
    if (this.size === 0) return 0;
    let m = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < this.size; i++) m = Math.max(m, this.get(i)!);
    return m;
  }

  /**
   * Percentile in 0..1 via nearest-rank on a sorted copy.
   * `percentile(0.99)` is the metric that actually matters for frame time —
   * the average hides exactly the hitches players notice.
   */
  percentile(p: number): number {
    if (this.size === 0) return 0;
    const sorted = Array.from({ length: this.size }, (_, i) => this.get(i)!).sort((a, b) => a - b);
    const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[rank]!;
  }

  /** Most recent sample. */
  get last(): number | undefined {
    return this.size === 0
      ? undefined
      : this.buffer[(this.head - 1 + this.capacity) % this.capacity];
  }

  clear(): void {
    this.buffer.fill(0);
    this.head = 0;
    this.size = 0;
    this.sum = 0;
  }
}
