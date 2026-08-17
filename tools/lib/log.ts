/**
 * PIPELINE LOGGING AND PROGRESS
 *
 * A cold fetch moves ~1.7 GB across ~376 files. A pipeline that prints
 * nothing for four minutes is indistinguishable from a pipeline that has
 * deadlocked, so progress reporting here is a correctness feature, not a
 * nicety.
 *
 * Two output modes, chosen automatically:
 *   TTY      — one in-place status line, repainted ~8x/second.
 *   non-TTY  — a timestamped line every few seconds (CI logs, pipes, files).
 *
 * ETA is computed from the *measured* rate of the current run rather than a
 * constant, because the two regimes differ by more than 2x: ~11.8 MB/s on a
 * single stream, ~27.7 MB/s across six.
 */

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '--';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m${String(rem).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

export function formatRate(bytes: number, ms: number): string {
  if (ms <= 0) return '--';
  return `${(bytes / 1048576 / (ms / 1000)).toFixed(1)} MB/s`;
}

/* -------------------------------------------------------------------------- */
/* Logger                                                                     */
/* -------------------------------------------------------------------------- */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const ANSI = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
};

export interface ILoggerOptions {
  readonly level?: LogLevel;
  /** Force plain output even on a TTY. */
  readonly plain?: boolean;
}

export class Logger {
  private readonly level: number;
  readonly isTTY: boolean;
  private readonly color: boolean;
  /** True while an in-place status line is on screen and must be cleared. */
  private statusActive = false;

  constructor(options: ILoggerOptions = {}) {
    this.level = LEVEL_ORDER[options.level ?? 'info'];
    this.isTTY = !options.plain && Boolean(process.stdout.isTTY);
    this.color = this.isTTY && process.env.NO_COLOR === undefined;
  }

  private paint(code: string, text: string): string {
    return this.color ? `${code}${text}${ANSI.reset}` : text;
  }

  /** Erase any in-place status line so a normal message starts on a clean row. */
  private clearStatus(): void {
    if (this.statusActive) {
      process.stdout.write('\r\u001b[2K');
      this.statusActive = false;
    }
  }

  private emit(level: LogLevel, prefix: string, message: string): void {
    if (LEVEL_ORDER[level] < this.level) return;
    this.clearStatus();
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    stream.write(`${prefix}${message}\n`);
  }

  debug(message: string): void {
    this.emit('debug', this.paint(ANSI.dim, '  · '), this.paint(ANSI.dim, message));
  }

  info(message: string): void {
    this.emit('info', '  ', message);
  }

  ok(message: string): void {
    this.emit('info', this.paint(ANSI.green, '  ✓ '), message);
  }

  warn(message: string): void {
    this.emit('warn', this.paint(ANSI.yellow, '  ! '), message);
  }

  error(message: string): void {
    this.emit('error', this.paint(ANSI.red, '  ✗ '), message);
  }

  /** Section heading. */
  heading(message: string): void {
    if (LEVEL_ORDER.info < this.level) return;
    this.clearStatus();
    process.stdout.write(`\n${this.paint(ANSI.cyan, message)}\n`);
  }

  /** Repaint the single in-place status line (TTY) or print it (non-TTY). */
  status(message: string): void {
    if (LEVEL_ORDER.info < this.level) return;
    if (this.isTTY) {
      const width = process.stdout.columns ?? 100;
      process.stdout.write(`\r\u001b[2K${message.slice(0, Math.max(20, width - 1))}`);
      this.statusActive = true;
    } else {
      process.stdout.write(`  ${message}\n`);
    }
  }

  /** Drop the status line for good; call once a phase finishes. */
  endStatus(): void {
    if (this.statusActive) {
      process.stdout.write('\r\u001b[2K');
      this.statusActive = false;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Progress tracker                                                           */
/* -------------------------------------------------------------------------- */

export interface IProgressOptions {
  /** Number of items (files) expected. */
  readonly totalItems: number;
  /** Total bytes expected, from the manifest. */
  readonly totalBytes: number;
  readonly logger: Logger;
  /** Minimum ms between repaints. TTY default 120, non-TTY default 3000. */
  readonly throttleMs?: number;
  /** Label shown before the counters. */
  readonly label?: string;
}

/**
 * Tracks a bulk transfer and renders a single line:
 *
 *   fetch  38/376  412.6 MB / 1.65 GB (24%)  26.4 MB/s  eta 48s  <- asphalt_02_arm_4k.jpg
 *
 * `bytesDone` counts manifest-declared bytes for every completed file,
 * including cache hits, so the percentage tracks *work remaining* rather than
 * network traffic. `transferred`/`elapsed` gives the true wire rate, and the
 * ETA is derived from that rate applied to the bytes still to transfer.
 */
export class ProgressTracker {
  private readonly startedAt = Date.now();
  private itemsDone = 0;
  private bytesDone = 0;
  private transferred = 0;
  private cachedItems = 0;
  private lastPaint = 0;
  private readonly throttleMs: number;
  private readonly log: Logger;
  private readonly label: string;
  private readonly totalItems: number;
  private readonly totalBytes: number;
  /** Files currently in flight, for the trailing "<- name" hint. */
  private readonly inFlight = new Set<string>();

  constructor(options: IProgressOptions) {
    this.log = options.logger;
    this.totalItems = options.totalItems;
    this.totalBytes = options.totalBytes;
    this.label = options.label ?? 'fetch';
    this.throttleMs = options.throttleMs ?? (options.logger.isTTY ? 120 : 3000);
  }

  start(name: string): void {
    this.inFlight.add(name);
    this.paint(false);
  }

  /**
   * Record a finished file.
   *
   * Takes no byte count for the wire: `advance()` is the single source of
   * truth for `transferred`, so adding the total again here would double every
   * throughput figure the run reports.
   *
   * `cached` is passed explicitly rather than inferred from `transferred === 0`:
   * a dry run also transfers nothing, and reporting 376 phantom cache hits
   * would be a lie in exactly the situation where you are checking the plan.
   */
  finish(name: string, declaredBytes: number, cached: boolean): void {
    this.inFlight.delete(name);
    this.itemsDone += 1;
    this.bytesDone += declaredBytes;
    if (cached) this.cachedItems += 1;
    this.paint(false);
  }

  /**
   * Live byte counter, called per chunk. Counts bytes that later get thrown
   * away by a failed md5 check too — they crossed the wire, so they belong in
   * the throughput measurement.
   */
  advance(delta: number): void {
    this.transferred += delta;
    this.paint(false);
  }

  private paint(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastPaint < this.throttleMs) return;
    this.lastPaint = now;

    const elapsed = now - this.startedAt;
    const pct = this.totalBytes > 0 ? Math.min(100, (this.bytesDone / this.totalBytes) * 100) : 0;
    // ETA from the measured wire rate, applied to the bytes still to move.
    const rate = elapsed > 0 ? this.transferred / elapsed : 0; // bytes/ms
    const remaining = Math.max(0, this.totalBytes - this.bytesDone);
    const eta = rate > 0 ? remaining / rate : Number.POSITIVE_INFINITY;

    const current = this.inFlight.size > 0 ? `  <- ${[...this.inFlight][0]}` : '';
    this.log.status(
      `${this.label}  ${this.itemsDone}/${this.totalItems}  ` +
        `${formatBytes(this.bytesDone)} / ${formatBytes(this.totalBytes)} (${pct.toFixed(0)}%)  ` +
        `${formatRate(this.transferred, elapsed)}  eta ${formatDuration(eta)}${current}`
    );
  }

  /** Final tallies for the summary block. */
  summary(): {
    items: number;
    cached: number;
    downloaded: number;
    bytesDone: number;
    transferred: number;
    elapsedMs: number;
  } {
    return {
      items: this.itemsDone,
      cached: this.cachedItems,
      downloaded: this.itemsDone - this.cachedItems,
      bytesDone: this.bytesDone,
      transferred: this.transferred,
      elapsedMs: Date.now() - this.startedAt,
    };
  }

  done(): void {
    this.paint(true);
    this.log.endStatus();
  }
}
