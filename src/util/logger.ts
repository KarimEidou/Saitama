/**
 * LOGGER
 *
 * Namespaced, level-filtered logging with rate limiting.
 *
 * Why not bare `console.log`: on a mobile WebView, a warning fired from inside
 * an update loop runs 60 times a second and will itself tank the frame rate.
 * `warnOnce`/`throttle` exist so diagnosing a problem cannot cause a worse one.
 *
 * Production builds default to `warn`, so debug logging can be left in place.
 */

/** Severity, ascending. */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  silent: 5,
};

/** A namespaced logger. */
export interface ILogger {
  readonly namespace: string;
  trace(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  /** Log a warning only the FIRST time this `key` is seen. */
  warnOnce(key: string, message: string, ...args: unknown[]): void;
  /** Log at most once per `intervalMs` for this `key`. */
  throttle(key: string, intervalMs: number, message: string, ...args: unknown[]): void;
  /** Create a nested logger, e.g. `world` -> `world:streaming`. */
  child(namespace: string): ILogger;
}

/** Global minimum level. Anything below is dropped before formatting. */
let globalLevel: LogLevel = import.meta.env?.PROD ? 'warn' : 'debug';

/** Namespaces explicitly silenced. */
const mutedNamespaces = new Set<string>();

/** Keys already emitted via `warnOnce`. */
const onceKeys = new Set<string>();

/** Last emission time per `throttle` key. */
const throttleTimes = new Map<string, number>();

/** Set the global minimum level. */
export function setLogLevel(level: LogLevel): void {
  globalLevel = level;
}

export function getLogLevel(): LogLevel {
  return globalLevel;
}

/** Silence a namespace and all its children. */
export function muteNamespace(namespace: string): void {
  mutedNamespaces.add(namespace);
}

export function unmuteNamespace(namespace: string): void {
  mutedNamespaces.delete(namespace);
}

/** Clear `warnOnce`/`throttle` memory. Used between tests. */
export function resetLogState(): void {
  onceKeys.clear();
  throttleTimes.clear();
}

function isMuted(namespace: string): boolean {
  if (mutedNamespaces.size === 0) return false;
  if (mutedNamespaces.has(namespace)) return true;
  // A muted parent silences its children: 'world' mutes 'world:streaming'.
  for (const muted of mutedNamespaces) {
    if (namespace.startsWith(`${muted}:`)) return true;
  }
  return false;
}

class Logger implements ILogger {
  constructor(readonly namespace: string) {}

  private enabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[globalLevel] && !isMuted(this.namespace);
  }

  private prefix(): string {
    return `[${this.namespace}]`;
  }

  trace(message: string, ...args: unknown[]): void {
    if (this.enabled('trace')) console.debug(this.prefix(), message, ...args);
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.enabled('debug')) console.debug(this.prefix(), message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    if (this.enabled('info')) console.info(this.prefix(), message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.enabled('warn')) console.warn(this.prefix(), message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    if (this.enabled('error')) console.error(this.prefix(), message, ...args);
  }

  warnOnce(key: string, message: string, ...args: unknown[]): void {
    const fullKey = `${this.namespace}:${key}`;
    if (onceKeys.has(fullKey)) return;
    onceKeys.add(fullKey);
    this.warn(message, ...args);
  }

  throttle(key: string, intervalMs: number, message: string, ...args: unknown[]): void {
    const fullKey = `${this.namespace}:${key}`;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const last = throttleTimes.get(fullKey);
    if (last !== undefined && now - last < intervalMs) return;
    throttleTimes.set(fullKey, now);
    this.warn(message, ...args);
  }

  child(namespace: string): ILogger {
    return new Logger(`${this.namespace}:${namespace}`);
  }
}

/**
 * Create a namespaced logger. Convention: one per module, named for its
 * system, e.g. `createLogger('world:streaming')`.
 */
export function createLogger(namespace: string): ILogger {
  return new Logger(namespace);
}

/** Fallback logger for code without its own namespace. */
export const log: ILogger = createLogger('game');
