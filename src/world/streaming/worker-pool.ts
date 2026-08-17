/**
 * CHUNK BUILD WORKER POOL
 *
 * Two workers, a bounded number of jobs in flight, and cancellation.
 *
 * ── WHY BOUNDED IN FLIGHT ──────────────────────────────────────────────────
 * The obvious pool hands every queued job to a worker immediately. That is
 * wrong here for a reason specific to streaming: the priority order changes
 * every time the camera turns. A job dispatched thirty frames ago was the most
 * important chunk in the world when it was queued and may be behind the player
 * now, and a worker that is three jobs deep cannot be redirected. Holding
 * dispatch at `MAX_IN_FLIGHT_JOBS` keeps the priority queue — which is
 * re-scored every frame — as the real decision-maker, and the workers as
 * nothing but muscle.
 *
 * ── CANCELLATION ───────────────────────────────────────────────────────────
 * A worker cannot be interrupted mid-build, so cancellation is recorded rather
 * than enforced: the id is added to a cancelled set and the result is dropped
 * on arrival. The buffers it carried are garbage immediately, which is cheaper
 * than the alternative (terminating and respawning a worker, at ~10 ms of
 * module re-parse each).
 *
 * ── INLINE FALLBACK ────────────────────────────────────────────────────────
 * Without `Worker` — unit tests under Node, or a hostile embedded webview — the
 * pool runs `handleRequest` directly and delivers results asynchronously via a
 * microtask, so callers cannot accidentally depend on synchronous completion.
 * It runs the exact same function the worker runs, so a test that passes inline
 * is testing the shipping code path, not a simulation of it.
 */

import { MAX_IN_FLIGHT_JOBS, STREAMING_WORKER_COUNT } from './constants';
import { handleRequest } from './chunk-worker';
import type { WorkerRequest, WorkerResponse } from './protocol';

/** Pool construction options. */
export interface IWorkerPoolOptions {
  /** Workers to spawn. Defaults to `STREAMING_WORKER_COUNT`. */
  readonly workerCount?: number;
  /** Jobs allowed in flight across all workers. */
  readonly maxInFlight?: number;
  /** Force the inline path even where `Worker` exists. For tests. */
  readonly inline?: boolean;
  /** Called for every result that was not cancelled. */
  readonly onResult: (response: WorkerResponse) => void;
  /** Called when a worker itself fails (module error, OOM). */
  readonly onError?: (error: string) => void;
}

/** Pool telemetry. */
export interface IWorkerPoolStats {
  readonly workers: number;
  readonly inFlight: number;
  readonly queued: number;
  readonly completed: number;
  readonly cancelled: number;
  readonly inline: boolean;
  /** Milliseconds workers spent generating, summed. Never main-thread time. */
  readonly workerTimeMs: number;
}

interface IWorkerSlot {
  readonly worker: Worker;
  /** Job ids currently assigned to this worker. */
  readonly jobs: Set<number>;
}

export class ChunkWorkerPool {
  private readonly slots: IWorkerSlot[] = [];
  private readonly pending: WorkerRequest[] = [];
  private readonly cancelled = new Set<number>();
  /** Job id -> the slot it went to, so completion can free the right worker. */
  private readonly assignment = new Map<number, IWorkerSlot>();
  private readonly onResult: (response: WorkerResponse) => void;
  private readonly onError: (error: string) => void;
  private readonly maxInFlight: number;
  private readonly useInline: boolean;
  private inFlightInline = 0;
  private completed = 0;
  private cancelledCount = 0;
  private workerTimeMs = 0;
  private disposed = false;

  constructor(options: IWorkerPoolOptions) {
    this.onResult = options.onResult;
    this.onError = options.onError ?? ((message) => console.error(`[streaming] worker: ${message}`));
    this.maxInFlight = options.maxInFlight ?? MAX_IN_FLIGHT_JOBS;

    const wanted = options.workerCount ?? STREAMING_WORKER_COUNT;
    this.useInline = options.inline === true || typeof Worker === 'undefined' || wanted <= 0;

    if (!this.useInline) {
      for (let i = 0; i < wanted; i++) {
        const slot = this.spawn();
        if (slot === undefined) {
          // Spawning failed part-way (CSP, blob restrictions). Fall back
          // wholesale rather than limping along with a partial pool.
          for (const existing of this.slots) existing.worker.terminate();
          this.slots.length = 0;
          this.useInline = true;
          break;
        }
        this.slots.push(slot);
      }
    }
  }

  private spawn(): IWorkerSlot | undefined {
    try {
      // `new URL(..., import.meta.url)` is the form Vite statically detects and
      // rewrites into a bundled worker chunk. It must stay a literal.
      const worker = new Worker(new URL('./chunk-worker.ts', import.meta.url), {
        type: 'module',
        name: 'chunk-builder',
      });
      const slot: IWorkerSlot = { worker, jobs: new Set() };
      worker.onmessage = (event: MessageEvent): void => {
        this.receive(slot, event.data as WorkerResponse);
      };
      worker.onerror = (event: ErrorEvent): void => {
        this.onError(event.message);
        // Free whatever this worker was holding so the pipeline does not wedge.
        for (const id of slot.jobs) this.assignment.delete(id);
        slot.jobs.clear();
        this.pump();
      };
      return slot;
    } catch (error) {
      this.onError(`spawn failed: ${String(error)}`);
      return undefined;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Submission                                                         */
  /* ------------------------------------------------------------------ */

  /** Queue a job. Dispatch happens here or as earlier jobs complete. */
  submit(request: WorkerRequest): void {
    if (this.disposed) return;
    this.pending.push(request);
    this.pump();
  }

  /**
   * Drop a job. Safe at any point: queued jobs are removed outright, in-flight
   * jobs have their result discarded on arrival.
   */
  cancel(id: number): void {
    const queuedAt = this.pending.findIndex((job) => job.id === id);
    if (queuedAt !== -1) {
      this.pending.splice(queuedAt, 1);
      this.cancelledCount++;
      return;
    }
    if (this.assignment.has(id) || this.inFlightInline > 0) {
      this.cancelled.add(id);
      this.cancelledCount++;
    }
  }

  /** True when nothing is queued and nothing is in flight. */
  get idle(): boolean {
    return this.pending.length === 0 && this.inFlight === 0;
  }

  /** Jobs handed to a worker (or inline) and not yet returned. */
  get inFlight(): number {
    return this.useInline ? this.inFlightInline : this.assignment.size;
  }

  /** Jobs queued but not yet dispatched. */
  get queued(): number {
    return this.pending.length;
  }

  /* ------------------------------------------------------------------ */
  /* Dispatch                                                           */
  /* ------------------------------------------------------------------ */

  private pump(): void {
    while (this.pending.length > 0 && this.inFlight < this.maxInFlight) {
      const request = this.pending.shift()!;
      if (this.useInline) {
        this.runInline(request);
      } else {
        const slot = this.leastBusySlot();
        if (slot === undefined) return;
        slot.jobs.add(request.id);
        this.assignment.set(request.id, slot);
        slot.worker.postMessage(request, transferablesFor(request));
      }
    }
  }

  private leastBusySlot(): IWorkerSlot | undefined {
    let best: IWorkerSlot | undefined;
    for (const slot of this.slots) {
      if (best === undefined || slot.jobs.size < best.jobs.size) best = slot;
    }
    return best;
  }

  private runInline(request: WorkerRequest): void {
    this.inFlightInline++;
    // A microtask, not a synchronous call: callers must not be able to depend
    // on inline completion ordering that the real worker path cannot provide.
    void Promise.resolve().then(() => {
      if (this.disposed) {
        this.inFlightInline--;
        return;
      }
      const response = handleRequest(request);
      this.inFlightInline--;
      this.deliver(response);
      this.pump();
    });
  }

  private receive(slot: IWorkerSlot, response: WorkerResponse): void {
    slot.jobs.delete(response.id);
    this.assignment.delete(response.id);
    this.deliver(response);
    this.pump();
  }

  private deliver(response: WorkerResponse): void {
    if (this.cancelled.delete(response.id)) return;
    if (response.kind === 'error') {
      this.onError(response.message);
      return;
    }
    if (response.kind === 'chunk' || response.kind === 'impostor') {
      this.workerTimeMs += response.generationTimeMs;
      this.completed++;
    }
    this.onResult(response);
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  stats(): IWorkerPoolStats {
    return {
      workers: this.useInline ? 0 : this.slots.length,
      inFlight: this.inFlight,
      queued: this.pending.length,
      completed: this.completed,
      cancelled: this.cancelledCount,
      inline: this.useInline,
      workerTimeMs: this.workerTimeMs,
    };
  }

  /** Terminate every worker and drop every queued job. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.slots) {
      slot.worker.onmessage = null;
      slot.worker.onerror = null;
      slot.worker.terminate();
    }
    this.slots.length = 0;
    this.pending.length = 0;
    this.assignment.clear();
    this.cancelled.clear();
  }
}

/**
 * Transfer list for a request. The damage mask is the only buffer travelling
 * outbound, and it is already a copy (`ChunkDamageState.cloneMask`), so moving
 * it costs nothing and saves a clone of 32 bytes per damaged chunk.
 */
function transferablesFor(request: WorkerRequest): Transferable[] {
  if (request.kind === 'chunk' && request.damage !== undefined) {
    return [request.damage.buffer as ArrayBuffer];
  }
  return [];
}
