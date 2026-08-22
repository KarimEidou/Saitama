/**
 * THE WORKER POOL WHEN A WORKER DIES
 *
 * The pool's happy path is covered wherever the streaming system is exercised —
 * the inline fallback runs `handleRequest`, the same function the worker's
 * `onmessage` calls. What is NOT reachable that way is the failure path: a
 * module worker on a hostile embedded WebView (CSP blocking the worker chunk, a
 * 404 on the bundled URL, an OOM) fires `error` on the `Worker` OBJECT rather
 * than throwing from the constructor, and everything downstream of that has to
 * be driven by a stub.
 *
 * The property under test is that a dead worker stops being a worker. An empty
 * job set is by definition the least busy one, so a corpse left in the rotation
 * is handed every subsequent job while the healthy worker idles — and the jobs
 * it was holding vanish with nobody told.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChunkWorkerPool } from '../worker-pool';
import { DEFAULT_GENERATOR } from '../chunk-worker';
import { JOBS_PER_WORKER } from '../constants';
import type { WorkerRequest, WorkerResponse } from '../protocol';

/** A `Worker` that does nothing but record what it was asked to do. */
class FakeWorker {
  static readonly spawned: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: WorkerRequest[] = [];
  terminated = false;

  constructor() {
    FakeWorker.spawned.push(this);
  }

  postMessage(request: WorkerRequest): void {
    this.posted.push(request);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** What the browser fires when a module worker fails to come up. */
  fail(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

const realWorker = globalThis.Worker;

beforeEach(() => {
  FakeWorker.spawned.length = 0;
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
});

afterEach(() => {
  if (realWorker === undefined) delete (globalThis as { Worker?: unknown }).Worker;
  else (globalThis as { Worker?: unknown }).Worker = realWorker;
});

/** A well-formed chunk job. The stub never runs it; only the pool sees it. */
function job(id: number): WorkerRequest {
  return {
    kind: 'chunk',
    id,
    generator: DEFAULT_GENERATOR,
    chunk: id,
    cx: 0,
    cz: 0,
    seed: 1,
    ring: 2,
  };
}

describe('ChunkWorkerPool capacity', () => {
  it('scales the in-flight cap with the worker count it actually spawned', () => {
    // The cap used to be a module constant derived from the DEFAULT worker
    // count, so six workers bought four idle module graphs and one worker took
    // four jobs — "a worker three jobs deep cannot be redirected", which is the
    // whole reason the cap exists.
    const one = new ChunkWorkerPool({ workerCount: 1, onResult: () => {} });
    expect(one.capacity).toBe(JOBS_PER_WORKER);
    one.dispose();

    const six = new ChunkWorkerPool({ workerCount: 6, onResult: () => {} });
    expect(six.capacity).toBe(6 * JOBS_PER_WORKER);
    six.dispose();
  });
});

describe('a worker that fails', () => {
  it('leaves the rotation and reports the jobs it was holding', () => {
    const results: WorkerResponse[] = [];
    const errors: string[] = [];
    const pool = new ChunkWorkerPool({
      workerCount: 2,
      onResult: (response) => results.push(response),
      onError: (message) => errors.push(message),
    });
    expect(FakeWorker.spawned.length).toBe(2);
    const [dead, alive] = FakeWorker.spawned as [FakeWorker, FakeWorker];

    // Four jobs fill the pool (2 workers x 2), spread round-robin; the fifth
    // waits in `pending`.
    for (let id = 1; id <= 5; id++) pool.submit(job(id));
    expect(dead.posted.map((r) => r.id)).toEqual([1, 3]);
    expect(alive.posted.map((r) => r.id)).toEqual([2, 4]);
    expect(pool.queued).toBe(1);

    dead.fail('boom');

    // The owners are told, so the chunks are not wedged in 'loading' forever.
    expect(results.map((r) => [r.kind, r.id])).toEqual([
      ['error', 1],
      ['error', 3],
    ]);
    expect(errors[0]).toBe('boom');
    expect(dead.terminated).toBe(true);
    expect(pool.stats().workers).toBe(1);

    // And the queue drains onto the SURVIVOR. An emptied-but-retained slot is
    // the least busy one, so this is where every subsequent job used to go.
    expect(alive.posted.map((r) => r.id)).toEqual([2, 4, 5]);
    expect(dead.posted.length).toBe(2);

    pool.submit(job(6));
    expect(alive.posted.map((r) => r.id)).toEqual([2, 4, 5, 6]);
    pool.dispose();
  });

  it('falls back to the inline path once no worker is left', async () => {
    const results: WorkerResponse[] = [];
    const pool = new ChunkWorkerPool({
      workerCount: 1,
      onResult: (response) => results.push(response),
      onError: () => {},
    });
    const only = FakeWorker.spawned[0]!;
    only.fail('module load failed');
    expect(pool.stats().inline).toBe(true);

    // The documented fallback was previously reachable only from a SYNCHRONOUS
    // `new Worker()` throw, so an async module failure left the pool with
    // nowhere to send work and `idle` reporting that there was none.
    pool.submit(job(9));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const built = results.find((r) => r.kind === 'chunk');
    expect(built).toBeDefined();
    expect(built!.id).toBe(9);
    expect(only.posted.length).toBe(0);
    pool.dispose();
  });

  it('does not deliver a job that was cancelled before its worker died', () => {
    const results: WorkerResponse[] = [];
    const pool = new ChunkWorkerPool({
      workerCount: 1,
      onResult: (response) => results.push(response),
      onError: () => {},
    });
    const only = FakeWorker.spawned[0]!;
    pool.submit(job(1));
    pool.submit(job(2));
    pool.cancel(1);

    only.fail('boom');

    // Only the live job is reported. The cancelled id is also removed from the
    // cancelled set on its way past, which is where it used to stay forever.
    expect(results.map((r) => r.id)).toEqual([2]);
    pool.dispose();
  });
});

describe('spawn failure', () => {
  it('falls back wholesale when the constructor throws', () => {
    const spy = vi.spyOn(FakeWorker.prototype, 'postMessage');
    (globalThis as { Worker?: unknown }).Worker = class {
      constructor() {
        throw new Error('blocked by CSP');
      }
    };
    const pool = new ChunkWorkerPool({ workerCount: 2, onResult: () => {}, onError: () => {} });
    expect(pool.stats().inline).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    pool.dispose();
    spy.mockRestore();
  });
});
