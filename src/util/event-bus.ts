/**
 * TYPED EVENT BUS — the concrete implementation of `IEventBus`.
 *
 * This is the ONLY sanctioned channel for cross-system communication. See the
 * architectural rule in `src/types/events.ts`.
 *
 * Guarantees implemented here, all of which systems are entitled to rely on:
 *
 *  1. SYNCHRONOUS dispatch — handlers run before `emit()` returns.
 *  2. HANDLER ISOLATION — a throwing handler is caught and logged; it can
 *     never break sibling handlers or kill the frame.
 *  3. MUTATION SAFETY — subscribing/unsubscribing during dispatch is safe and
 *     takes effect on the NEXT emit. We iterate a snapshot, so a handler that
 *     unsubscribes itself does not shift the array out from under the loop.
 *  4. VECTOR COPYING — `Vec3` fields are copied on emit, so callers may pass
 *     reused scratch vectors (e.g. a `THREE.Vector3` temp) without handlers
 *     observing mutated values later.
 *  5. ORDERING — handlers for a type run in subscription order.
 */

import type {
  GameEvent,
  GameEventOf,
  GameEventPayload,
  GameEventType,
  EventHandler,
  IEventBus,
  Vec3,
} from '@/types';
import { createLogger } from './logger';

const log = createLogger('event-bus');

/**
 * Minimum gap between two logged handler failures OF THE SAME TYPE.
 *
 * A handler that throws every frame would otherwise serialise a stack trace 60
 * times a second into a mobile WebView console, which costs more frame time
 * than the bug being reported — the exact failure guarantee #2 rules out.
 */
const HANDLER_ERROR_LOG_INTERVAL_MS = 1000;

/** Keys whose values are copied defensively when present on a payload. */
const VECTOR_KEYS = [
  'origin',
  'direction',
  'position',
  'point',
  'impulse',
] as const satisfies readonly string[];

function isVec3(value: unknown): value is Vec3 {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number';
}

/** Plain copy of a vector-like, dropping any class identity (e.g. Vector3). */
function copyVec3(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

/** Handler registration record. */
interface Registration {
  handler: (event: GameEvent) => void;
  once: boolean;
}

export interface IEventBusOptions {
  /**
   * Warn when a single type exceeds this many handlers. Almost always a leak
   * (a system re-subscribing without unsubscribing on dispose).
   */
  readonly leakThreshold?: number;
  /** Called for handler exceptions. Defaults to a rate-limited logger line. */
  readonly onError?: (error: unknown, type: GameEventType) => void;
}

/** Typed publish/subscribe bus. Create exactly one and pass it around. */
export class EventBus implements IEventBus {
  private readonly handlers = new Map<GameEventType, Registration[]>();
  private readonly anyHandlers: ((event: GameEvent) => void)[] = [];
  private frame = 0;
  private time = 0;
  private readonly leakThreshold: number;
  private readonly onError: (error: unknown, type: GameEventType) => void;
  /** Types already warned about, so a leak warns once rather than every frame. */
  private readonly warned = new Set<GameEventType>();

  constructor(options: IEventBusOptions = {}) {
    this.leakThreshold = options.leakThreshold ?? 64;
    this.onError =
      options.onError ??
      ((error, type) => {
        log.throttle(
          `handler-threw:${type}`,
          HANDLER_ERROR_LOG_INTERVAL_MS,
          `handler for "${type}" threw:`,
          error
        );
      });
  }

  on<T extends GameEventType>(type: T, handler: EventHandler<T>): () => void {
    return this.add(type, handler as (event: GameEvent) => void, false);
  }

  once<T extends GameEventType>(type: T, handler: EventHandler<T>): () => void {
    return this.add(type, handler as (event: GameEvent) => void, true);
  }

  private add(type: GameEventType, handler: (event: GameEvent) => void, once: boolean): () => void {
    let list = this.handlers.get(type);
    if (!list) {
      list = [];
      this.handlers.set(type, list);
    }
    // Hold the RECORD, not just the function. The same function may be
    // registered more than once for a type — including once with `once: true`
    // and once without — so removal has to target this exact registration or
    // it silently deletes somebody else's subscription.
    const registration: Registration = { handler, once };
    list.push(registration);

    if (list.length > this.leakThreshold && !this.warned.has(type)) {
      this.warned.add(type);
      console.warn(
        `[EventBus] "${type}" has ${list.length} handlers — likely a leak. ` +
          `Systems must call their unsubscribe function on dispose.`
      );
    }

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this.removeRecord(type, registration);
    };
  }

  /**
   * Remove by FUNCTION identity.
   *
   * When the same function is registered more than once for a type this
   * removes the oldest matching registration only, and cannot tell an `on`
   * record from a `once` one. Prefer the unsubscribe function returned by
   * `on`/`once`: it always removes exactly the registration it created.
   */
  off<T extends GameEventType>(type: T, handler: EventHandler<T>): void {
    const list = this.handlers.get(type);
    if (!list) return;
    const index = list.findIndex((r) => r.handler === (handler as (event: GameEvent) => void));
    if (index !== -1) list.splice(index, 1);
    if (list.length === 0) this.handlers.delete(type);
  }

  /** Remove one exact registration record, leaving every other one alone. */
  private removeRecord(type: GameEventType, registration: Registration): void {
    const list = this.handlers.get(type);
    if (!list) return;
    const index = list.indexOf(registration);
    if (index !== -1) list.splice(index, 1);
    if (list.length === 0) this.handlers.delete(type);
  }

  onAny(handler: (event: GameEvent) => void): () => void {
    this.anyHandlers.push(handler);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const i = this.anyHandlers.indexOf(handler);
      if (i !== -1) this.anyHandlers.splice(i, 1);
    };
  }

  emit<T extends GameEventType>(type: T, payload: GameEventPayload<T>): void {
    // Build the full event, stamping bus-owned fields and copying vectors so
    // handlers never observe a caller's reused scratch vector.
    const event = { ...(payload as object), type, time: this.time, frame: this.frame } as Record<
      string,
      unknown
    >;
    for (const key of VECTOR_KEYS) {
      const value = event[key];
      if (isVec3(value)) event[key] = copyVec3(value);
    }
    const finalEvent = event as unknown as GameEventOf<T>;

    const list = this.handlers.get(type);
    if (list && list.length > 0) {
      // Snapshot: handlers may subscribe/unsubscribe during dispatch.
      const snapshot = list.slice();
      for (const reg of snapshot) {
        if (reg.once) this.removeRecord(type, reg);
        try {
          reg.handler(finalEvent as GameEvent);
        } catch (error) {
          this.onError(error, type);
        }
      }
    }

    if (this.anyHandlers.length > 0) {
      for (const handler of this.anyHandlers.slice()) {
        try {
          handler(finalEvent as GameEvent);
        } catch (error) {
          this.onError(error, type);
        }
      }
    }
  }

  clear(type?: GameEventType): void {
    if (type === undefined) {
      this.handlers.clear();
      this.anyHandlers.length = 0;
      this.warned.clear();
    } else {
      this.handlers.delete(type);
      this.warned.delete(type);
    }
  }

  listenerCount(type?: GameEventType): number {
    if (type !== undefined) return this.handlers.get(type)?.length ?? 0;
    let total = this.anyHandlers.length;
    for (const list of this.handlers.values()) total += list.length;
    return total;
  }

  setFrame(frame: number, time: number): void {
    this.frame = frame;
    this.time = time;
  }
}

/** Convenience factory. */
export function createEventBus(options?: IEventBusOptions): IEventBus {
  return new EventBus(options);
}
