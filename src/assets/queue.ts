/**
 * PRIORITY LOAD SCHEDULER
 *
 * Every asset fetch in the game goes through here, so three things are true at
 * once:
 *
 *   DE-DUPLICATION — `IAssetRegistry.load()` is documented as idempotent. Two
 *     callers asking for the same building at the same moment must share one
 *     fetch and one transcode, not race to decode the same 4 MB twice.
 *
 *   PRIORITY — the boot screen's core set must not queue behind a speculative
 *     prefetch that was scheduled first. Lower number runs first; ties break
 *     FIFO by insertion sequence, so ordering is deterministic and testable.
 *
 *   BACKPRESSURE — a fixed number of slots. Firing 200 `fetch()` calls at once
 *     on a mobile WebView makes every one of them slower and starves the KTX2
 *     worker pool of main-thread time to hand results back.
 *
 * Progress is reported in BYTES as well as counts. A count-only progress bar
 * over assets that differ by two orders of magnitude in size is a bar that
 * sits at 90% for most of the load.
 */

import type { IAssetLoadProgress } from '@/types';
import { DEFAULT_CONCURRENCY, PRIORITY, type PriorityName } from './constants';

/* -------------------------------------------------------------------------- */
/* Scheduler                                                                  */
/* -------------------------------------------------------------------------- */

interface IQueued<T> {
  readonly key: string;
  readonly priority: number;
  readonly sequence: number;
  readonly run: () => Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

/** Resolve a named or numeric priority to its numeric weight. */
export function priorityValue(priority: PriorityName | number | undefined): number {
  if (typeof priority === 'number') return priority;
  if (priority === undefined) return PRIORITY.normal;
  return PRIORITY[priority];
}

/**
 * Concurrency-limited, priority-ordered, de-duplicated task runner.
 *
 * Not asset-aware on purpose: it schedules opaque thunks keyed by a string, so
 * it is equally usable for textures, GLBs, audio and the manifest itself, and
 * unit-testable with no assets at all.
 */
export class LoadScheduler {
  private readonly pendingQueue: IQueued<unknown>[] = [];
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private sequence = 0;
  private active = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(private concurrency: number = DEFAULT_CONCURRENCY) {}

  /** Tasks waiting for a slot. */
  get queued(): number {
    return this.pendingQueue.length;
  }

  /** Tasks currently running. */
  get running(): number {
    return this.active;
  }

  get slots(): number {
    return this.concurrency;
  }

  setConcurrency(slots: number): void {
    this.concurrency = Math.max(1, Math.floor(slots));
    this.pump();
  }

  /** Keys queued right now, in the order they will run. */
  get plannedOrder(): readonly string[] {
    return [...this.pendingQueue]
      .sort((a, b) => a.priority - b.priority || a.sequence - b.sequence)
      .map((task) => task.key);
  }

  /**
   * Schedule `run` under `key`.
   *
   * A second call with a key already queued or running returns the SAME
   * promise and never invokes `run` twice. Raising the priority of a task that
   * is still queued does re-order it — a chunk the player has just walked into
   * should overtake the prefetch that requested it speculatively.
   */
  schedule<T>(key: string, priority: PriorityName | number, run: () => Promise<T>): Promise<T> {
    const weight = priorityValue(priority);

    const existing = this.inFlight.get(key);
    if (existing) {
      // Still queued? A more urgent request re-orders it. Already running is
      // left alone — there is nothing left to re-order.
      const index = this.pendingQueue.findIndex((task) => task.key === key);
      const queued = index >= 0 ? this.pendingQueue[index] : undefined;
      if (queued !== undefined && weight < queued.priority) {
        // `priority` is readonly, so replace the record rather than mutate it.
        this.pendingQueue[index] = { ...queued, priority: weight };
      }
      return existing as Promise<T>;
    }

    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.inFlight.set(key, promise as Promise<unknown>);
    this.pendingQueue.push({
      key,
      priority: weight,
      sequence: this.sequence++,
      run: run as () => Promise<unknown>,
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    this.pump();
    return promise;
  }

  /** The promise for an already-scheduled key, if any. */
  promiseOf(key: string): Promise<unknown> | undefined {
    return this.inFlight.get(key);
  }

  has(key: string): boolean {
    return this.inFlight.has(key);
  }

  /** Resolves when nothing is queued or running. */
  async idle(): Promise<void> {
    if (this.active === 0 && this.pendingQueue.length === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private pump(): void {
    while (this.active < this.concurrency && this.pendingQueue.length > 0) {
      let bestIndex = 0;
      for (let i = 1; i < this.pendingQueue.length; i++) {
        const candidate = this.pendingQueue[i]!;
        const best = this.pendingQueue[bestIndex]!;
        if (
          candidate.priority < best.priority ||
          (candidate.priority === best.priority && candidate.sequence < best.sequence)
        ) {
          bestIndex = i;
        }
      }
      const task = this.pendingQueue.splice(bestIndex, 1)[0]!;
      this.active++;
      void this.execute(task);
    }
    if (this.active === 0 && this.pendingQueue.length === 0 && this.idleWaiters.length > 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const waiter of waiters) waiter();
    }
  }

  private async execute(task: IQueued<unknown>): Promise<void> {
    try {
      task.resolve(await task.run());
    } catch (error) {
      task.reject(error);
    } finally {
      this.active--;
      this.inFlight.delete(task.key);
      this.pump();
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Progress                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Accumulates an `IAssetLoadProgress` across a batch.
 *
 * `bytesTotal` comes from the manifest's per-output byte counts, so the bar is
 * weighted by real download size before a single byte has arrived.
 */
export class ProgressTracker {
  private loadedCount = 0;
  private bytesDone = 0;
  private current: string | undefined;

  constructor(
    private readonly total: number,
    private readonly bytesTotal: number,
    private readonly onProgress?: (progress: IAssetLoadProgress) => void
  ) {}

  /** Report that work has started on `key`. */
  begin(key: string): void {
    this.current = key;
    this.emit();
  }

  /** Report `key` finished, having transferred `bytes`. */
  complete(key: string, bytes: number): void {
    this.loadedCount++;
    this.bytesDone += bytes;
    this.current = key;
    this.emit();
  }

  get snapshot(): IAssetLoadProgress {
    const total = Math.max(1, this.total);
    return {
      loaded: this.loadedCount,
      total: this.total,
      fraction: Math.min(1, this.loadedCount / total),
      current: this.current,
      bytesLoaded: this.bytesDone,
      bytesTotal: this.bytesTotal,
    };
  }

  private emit(): void {
    this.onProgress?.(this.snapshot);
  }
}
