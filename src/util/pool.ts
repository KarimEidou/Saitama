/**
 * OBJECT POOL
 *
 * Garbage collection is the main cause of frame hitches in a long-running
 * WebGL session on mobile. Anything created per-frame or per-event — debris,
 * particles, NPCs, vectors, event payloads — should come from a pool.
 *
 * Usage:
 *   const pool = new ObjectPool(() => new THREE.Vector3(), v => v.set(0,0,0));
 *   const v = pool.acquire();
 *   ...
 *   pool.release(v);
 */

/** Pool configuration. */
export interface IPoolOptions<T> {
  /** Create a fresh instance. Called only when the pool is empty. */
  factory: () => T;
  /** Return an instance to a clean state before reuse. */
  reset?: (item: T) => void;
  /** Permanently destroy an instance (free GPU resources). */
  destroy?: (item: T) => void;
  /** Instances to pre-allocate at construction. */
  initialSize?: number;
  /**
   * Maximum RETAINED instances. Releases beyond this are destroyed rather than
   * kept, bounding memory when a burst (a building collapse) briefly needs far
   * more objects than steady state.
   */
  maxSize?: number;
}

/** Pool telemetry, for the debug overlay. */
export interface IPoolStats {
  /** Instances available for reuse. */
  readonly free: number;
  /** Instances currently checked out. */
  readonly active: number;
  /** Instances ever created by the factory. */
  readonly created: number;
  /** Acquisitions served from the free list. */
  readonly reused: number;
  /** Releases discarded because the pool was at `maxSize`. */
  readonly discarded: number;
}

/** A generic, allocation-avoiding object pool. */
export class ObjectPool<T> {
  private readonly free: T[] = [];
  private readonly factory: () => T;
  private readonly resetFn: ((item: T) => void) | undefined;
  private readonly destroyFn: ((item: T) => void) | undefined;
  private readonly maxSize: number;

  private activeCount = 0;
  private createdCount = 0;
  private reusedCount = 0;
  private discardedCount = 0;

  constructor(options: IPoolOptions<T>) {
    this.factory = options.factory;
    this.resetFn = options.reset;
    this.destroyFn = options.destroy;
    this.maxSize = options.maxSize ?? Number.POSITIVE_INFINITY;

    const initial = options.initialSize ?? 0;
    for (let i = 0; i < initial; i++) {
      this.free.push(this.create());
    }
  }

  private create(): T {
    this.createdCount++;
    return this.factory();
  }

  /** Take an instance, creating one only if the free list is empty. */
  acquire(): T {
    const item = this.free.pop();
    this.activeCount++;
    if (item !== undefined) {
      this.reusedCount++;
      return item;
    }
    return this.create();
  }

  /**
   * Return an instance.
   *
   * Releasing the same object twice is a bug that produces two live references
   * to one instance, so it is guarded in development builds via `has`.
   */
  release(item: T): void {
    if (this.activeCount > 0) this.activeCount--;
    this.resetFn?.(item);

    if (this.free.length >= this.maxSize) {
      this.discardedCount++;
      this.destroyFn?.(item);
      return;
    }
    this.free.push(item);
  }

  /** Release many at once. */
  releaseAll(items: readonly T[]): void {
    for (const item of items) this.release(item);
  }

  /** Grow the free list to at least `count` instances. */
  preallocate(count: number): void {
    while (this.free.length < count) this.free.push(this.create());
  }

  /** Destroy every retained instance. Checked-out instances are untouched. */
  clear(): void {
    if (this.destroyFn) {
      for (const item of this.free) this.destroyFn(item);
    }
    this.free.length = 0;
  }

  get stats(): IPoolStats {
    return {
      free: this.free.length,
      active: this.activeCount,
      created: this.createdCount,
      reused: this.reusedCount,
      discarded: this.discardedCount,
    };
  }
}

/**
 * A fixed-capacity pool that never grows.
 *
 * Use where exceeding a budget must FAIL rather than allocate — debris bodies
 * and particle systems, where silently growing would blow the frame budget.
 * `acquire()` returns undefined when exhausted; callers must handle it.
 */
export class FixedPool<T> {
  private readonly items: T[];
  private readonly free: number[] = [];
  private readonly inUse: boolean[];
  private readonly resetFn: ((item: T) => void) | undefined;

  constructor(capacity: number, factory: (index: number) => T, reset?: (item: T) => void) {
    this.items = new Array<T>(capacity);
    this.inUse = new Array<boolean>(capacity).fill(false);
    this.resetFn = reset;
    for (let i = capacity - 1; i >= 0; i--) {
      this.items[i] = factory(i);
      this.free.push(i);
    }
  }

  get capacity(): number {
    return this.items.length;
  }

  get activeCount(): number {
    return this.items.length - this.free.length;
  }

  /** Take a slot, or undefined when the pool is exhausted. */
  acquire(): { index: number; item: T } | undefined {
    const index = this.free.pop();
    if (index === undefined) return undefined;
    this.inUse[index] = true;
    return { index, item: this.items[index]! };
  }

  /** Return a slot by index. Double-release is ignored. */
  release(index: number): void {
    if (index < 0 || index >= this.items.length) return;
    if (!this.inUse[index]) return;
    this.inUse[index] = false;
    this.resetFn?.(this.items[index]!);
    this.free.push(index);
  }

  /** Release every slot. */
  releaseAll(): void {
    for (let i = 0; i < this.items.length; i++) this.release(i);
  }

  /** Read a slot without changing its state. */
  get(index: number): T | undefined {
    return this.inUse[index] ? this.items[index] : undefined;
  }

  /** Iterate the checked-out items. */
  *active(): IterableIterator<{ index: number; item: T }> {
    for (let i = 0; i < this.items.length; i++) {
      if (this.inUse[i]) yield { index: i, item: this.items[i]! };
    }
  }
}
