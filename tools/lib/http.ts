/**
 * HTTP TRANSFER LAYER
 *
 * Everything the asset pipeline needs to move ~1.7 GB off two public CDNs
 * without wedging, silently truncating, or hammering anyone.
 *
 * ── THE FOUR THINGS THAT ACTUALLY MATTER ───────────────────────────────────
 *
 * 1. CONCURRENCY. Measured on this network: 11.8 MB/s on one stream, 27.7 MB/s
 *    across six. That 2.3x is the single largest lever in the whole pipeline,
 *    so `Limiter` defaults to 6. Going wider buys little and starts to look
 *    like abuse of a free CC0 host.
 *
 * 2. TIMEOUTS THAT MEAN "STALLED", NOT "SLOW". A flat 60s wall clock would
 *    fail a legitimate 200 MB transfer on a thin link while still letting a
 *    half-dead socket hold a worker for a full minute. So 60s is applied
 *    twice, both as *inactivity*: once waiting for response headers, then
 *    again between body chunks. A transfer that keeps making progress is
 *    never killed; one that goes quiet for a minute always is.
 *
 * 3. RESUME. Poly Haven serves `Accept-Ranges: bytes`. Partial downloads land
 *    in `<dest>.part`, so a re-run after a dropped connection continues from
 *    the byte it stopped at instead of re-pulling 40 MB. Enabled for files
 *    over RESUME_THRESHOLD_BYTES, where the bookkeeping pays for itself.
 *
 * 4. RETRY THAT KNOWS WHEN TO STOP. Network errors, 5xx and 429 are retried
 *    3x with exponential backoff. A 404 is retried zero times — the URL is
 *    wrong and waiting will not fix it.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Inactivity budget for headers, and again between body chunks. */
export const TIMEOUT_MS = 60_000;
/** Total attempts per request, including the first. */
export const MAX_ATTEMPTS = 3;
/** Backoff before retry N: 1s, 2s, 4s. */
export const BACKOFF_BASE_MS = 1000;
/** Files at or above this size get `.part` + HTTP Range resume. */
export const RESUME_THRESHOLD_BYTES = 8 * 1024 * 1024;
/** Parallel transfers. 6 measured at 27.7 MB/s vs 11.8 MB/s single-stream. */
export const DEFAULT_CONCURRENCY = 6;

const USER_AGENT =
  'saitama-asset-pipeline/0.1 (+https://github.com/one-punch/saitama; CC0 asset fetch)';

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }

  /**
   * 4xx other than these will never succeed on retry — a 404 means the URL is
   * wrong, and waiting does not fix a wrong URL.
   *
   * 416 IS retryable because of how it arises here: it means our `.part` file
   * is longer than the resource, which the caller has already responded to by
   * deleting it. The retry then starts cleanly from zero and succeeds.
   */
  get retryable(): boolean {
    return (
      this.status === 0 ||
      this.status === 408 ||
      this.status === 416 ||
      this.status === 429 ||
      this.status >= 500
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Concurrency limiter                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A minimal promise pool.
 *
 * Two properties it has to get right, both of which are easy to get subtly
 * wrong:
 *
 *   NO LEAKS. `run()` releases its slot in a `finally`, so a task that throws
 *   cannot wedge the pool. Otherwise the first bad URL deadlocks the run.
 *
 *   NO OVER-SUBSCRIPTION. A finishing task HANDS its slot to the next waiter
 *   instead of decrementing and letting the waiter re-increment. Those look
 *   equivalent but are not: decrement-then-wake leaves a microtask gap in
 *   which a NEWLY arriving caller sees a free slot that has already been
 *   promised to someone else, and the pool quietly runs over its limit. This
 *   pipeline happens to submit every task up front, so nothing arrives in
 *   that gap — but the reusable version of a primitive should not depend on
 *   its first caller's timing to be correct.
 */
export class Limiter {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(readonly concurrency: number = DEFAULT_CONCURRENCY) {
    if (concurrency < 1) throw new Error(`concurrency must be >= 1, got ${concurrency}`);
  }

  /** Slots currently held. Never exceeds `concurrency`. */
  get inFlight(): number {
    return this.active;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      // Woken by a finishing task that transferred its slot; `active` already
      // counts us, so do NOT increment here.
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await task();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active -= 1;
    }
  }

  /** Run every task through the limiter, preserving input order in the result. */
  async all<T>(tasks: readonly (() => Promise<T>)[]): Promise<T[]> {
    return Promise.all(tasks.map((t) => this.run(t)));
  }
}

/* -------------------------------------------------------------------------- */
/* Retry                                                                      */
/* -------------------------------------------------------------------------- */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface IRetryOptions {
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  /** Called before each retry, for logging. */
  readonly onRetry?: (attempt: number, delayMs: number, error: Error) => void;
}

/** Retry with exponential backoff, honouring `HttpError.retryable`. */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: IRetryOptions = {}
): Promise<T> {
  const attempts = options.attempts ?? MAX_ATTEMPTS;
  const base = options.baseDelayMs ?? BACKOFF_BASE_MS;
  let lastError: Error = new Error('withRetry: no attempts made');

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const fatal = lastError instanceof HttpError && !lastError.retryable;
      if (fatal || attempt === attempts) break;
      const delay = base * 2 ** (attempt - 1);
      options.onRetry?.(attempt, delay, lastError);
      await sleep(delay);
    }
  }
  throw lastError;
}

/* -------------------------------------------------------------------------- */
/* Request primitives                                                         */
/* -------------------------------------------------------------------------- */

interface IRequestInit {
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
}

/**
 * One `fetch` with a header-phase inactivity timeout. The returned body is
 * NOT yet consumed; the caller applies its own chunk watchdog.
 */
async function requestOnce(url: string, init: IRequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('header timeout')), TIMEOUT_MS);
  const onOuterAbort = (): void => controller.abort(init.signal?.reason);
  init.signal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    return await fetch(url, {
      headers: { 'user-agent': USER_AGENT, ...init.headers },
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (error) {
    // Network-level failures share the retryable path with 5xx.
    throw new HttpError(url, 0, `network error: ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', onOuterAbort);
  }
}

/** GET a JSON document, with retry. */
export async function fetchJson<T = unknown>(
  url: string,
  options: IRetryOptions & IRequestInit = {}
): Promise<T> {
  return withRetry(async () => {
    const response = await requestOnce(url, options);
    if (!response.ok) {
      throw new HttpError(url, response.status, `GET ${url} -> HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }, options);
}

/* -------------------------------------------------------------------------- */
/* File download                                                              */
/* -------------------------------------------------------------------------- */

export interface IDownloadOptions extends IRetryOptions {
  /** Expected size, from the manifest. Enables resume and a truncation check. */
  readonly expectedBytes?: number;
  /** Called with each chunk's length, for live progress. */
  readonly onProgress?: (deltaBytes: number) => void;
  /** Force resume behaviour on/off instead of the size heuristic. */
  readonly resume?: boolean;
  readonly signal?: AbortSignal;
}

export interface IDownloadResult {
  /** Bytes on disk after the transfer. */
  readonly bytes: number;
  /** Bytes actually pulled over the wire this call (excludes resumed prefix). */
  readonly transferred: number;
  /** True when an existing `.part` was continued rather than restarted. */
  readonly resumed: boolean;
}

/**
 * Stream a URL to `destPath`, resuming a partial `.part` file when possible.
 *
 * The file is only moved into place once the transfer completes, so a killed
 * process can never leave a truncated file at the real path masquerading as a
 * finished download. Hash verification is the caller's job — this function is
 * only responsible for getting the bytes down intact and completely.
 */
export async function downloadToFile(
  url: string,
  destPath: string,
  options: IDownloadOptions = {}
): Promise<IDownloadResult> {
  await mkdir(path.dirname(destPath), { recursive: true });
  const partPath = `${destPath}.part`;
  const wantResume = options.resume ?? (options.expectedBytes ?? 0) >= RESUME_THRESHOLD_BYTES;

  return withRetry(async () => {
    let startAt = 0;
    if (wantResume) {
      try {
        const existing = await stat(partPath);
        startAt = existing.size;
        // A `.part` that is already complete (or longer) is not resumable —
        // start over rather than reason about a mid-file state we cannot hash.
        if (options.expectedBytes !== undefined && startAt >= options.expectedBytes) {
          await rm(partPath, { force: true });
          startAt = 0;
        }
      } catch {
        startAt = 0;
      }
    } else {
      await rm(partPath, { force: true });
    }

    const headers: Record<string, string> = {};
    if (startAt > 0) headers.range = `bytes=${startAt}-`;

    const response = await requestOnce(url, { headers, signal: options.signal });

    if (response.status === 416) {
      // Range unsatisfiable: our `.part` is stale. Wipe it and let retry redo it.
      await rm(partPath, { force: true });
      throw new HttpError(url, 416, `GET ${url} -> 416, discarded stale partial`);
    }
    if (!response.ok) {
      throw new HttpError(url, response.status, `GET ${url} -> HTTP ${response.status}`);
    }
    if (!response.body) {
      throw new HttpError(url, response.status, `GET ${url} -> empty body`);
    }

    // Asked to resume but the server ignored Range: the body is the WHOLE file,
    // so the partial has to go or we would concatenate a prefix onto a full copy.
    let appending = startAt > 0;
    if (appending && response.status !== 206) {
      await rm(partPath, { force: true });
      appending = false;
    }

    let transferred = 0;
    const source = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
    const sink = createWriteStream(partPath, { flags: appending ? 'a' : 'w' });

    // Per-chunk inactivity watchdog: a socket that stops delivering data is
    // killed after TIMEOUT_MS, no matter how long the transfer has been running.
    let watchdog: NodeJS.Timeout | undefined;
    const arm = (): void => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        source.destroy(new Error(`stalled for ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
    };
    source.on('data', (chunk: Buffer) => {
      transferred += chunk.length;
      options.onProgress?.(chunk.length);
      arm();
    });
    arm();

    try {
      await pipeline(source, sink);
    } catch (error) {
      throw new HttpError(url, 0, `transfer failed: ${(error as Error).message}`);
    } finally {
      clearTimeout(watchdog);
    }

    const finalBytes = (await stat(partPath)).size;
    if (options.expectedBytes !== undefined && finalBytes !== options.expectedBytes) {
      // Truncated or over-long: never promote it, and never keep the partial —
      // a wrong-length `.part` would poison the next resume attempt too.
      await rm(partPath, { force: true });
      throw new HttpError(
        url,
        0,
        `size mismatch: got ${finalBytes} bytes, manifest declares ${options.expectedBytes}`
      );
    }

    await rm(destPath, { force: true });
    await rename(partPath, destPath);
    return { bytes: finalBytes, transferred, resumed: appending };
  }, options);
}

/**
 * True when the host serves HTTP Range requests. Not used on the hot path —
 * Poly Haven always does — but useful when wiring up a new provider.
 */
export async function supportsRange(url: string): Promise<boolean> {
  const response = await requestOnce(url, { headers: { range: 'bytes=0-0' } });
  await response.body?.cancel();
  return response.status === 206;
}

/** Read a file's size, or undefined when it does not exist. */
export async function fileSize(filePath: string): Promise<number | undefined> {
  try {
    const handle = await open(filePath, 'r');
    try {
      return (await handle.stat()).size;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}
