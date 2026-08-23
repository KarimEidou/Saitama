/**
 * EVENT BUS — SUBSCRIPTION IDENTITY AND HANDLER ISOLATION
 *
 * Removal has to target the exact registration RECORD, not the function. The
 * same function may be subscribed twice for one type — "count every kill, and
 * also run a one-shot on the first" is the natural way to write it — and a
 * removal that searches by function identity then deletes whichever record
 * happens to come first. That silently destroys the permanent subscription and
 * leaves the one-shot firing forever, with nothing thrown and a
 * `listenerCount()` that looks entirely healthy.
 *
 * The rest of the file covers guarantee #2: a throwing handler is isolated AND
 * rate-limited. An unthrottled stack trace per emit is precisely the mobile
 * frame-killer `src/util/logger.ts` exists to prevent.
 *
 * The suites below that pin the five header guarantees exist because 27 systems
 * take this bus as a fixture and would silently inherit a regression in it: a
 * break in snapshot semantics or vector copying surfaces as an unreproducible
 * gameplay bug in a completely different system, days later.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus, createEventBus } from '../event-bus';
import { resetLogState } from '../logger';
import type { GameEvent, Vec3 } from '@/types';

/** Smallest real payload on the bus; nothing here depends on its contents. */
const BOREDOM = { value: 0.5, previous: 0.4, reason: 'idle' } as const;

/** Every field `PlayerLandedEvent` requires, so the payload stays readable. */
const landed = (
  position: Vec3 = { x: 0, y: 0, z: 0 }
): {
  position: Vec3;
  impactSpeed: number;
  fallHeight: number;
  createsCrater: boolean;
  intent: 'normal';
} => ({ position, impactSpeed: 12, fallHeight: 30, createsCrater: true, intent: 'normal' });

describe('EventBus subscription identity', () => {
  it('removes only the `once` record when one function is registered both ways', () => {
    const bus = new EventBus();
    let calls = 0;
    const handler = (): void => {
      calls++;
    };

    bus.on('BoredomChanged', handler);
    bus.once('BoredomChanged', handler);
    expect(bus.listenerCount('BoredomChanged')).toBe(2);

    bus.emit('BoredomChanged', BOREDOM);
    expect(calls).toBe(2);
    // The one-shot went. The persistent subscription must NOT have been the
    // record that got spliced out.
    expect(bus.listenerCount('BoredomChanged')).toBe(1);

    bus.emit('BoredomChanged', BOREDOM);
    bus.emit('BoredomChanged', BOREDOM);
    expect(calls).toBe(4);
    expect(bus.listenerCount('BoredomChanged')).toBe(1);
  });

  it('unsubscribes exactly the registration its own closure came from', () => {
    const bus = new EventBus();
    let calls = 0;
    const handler = (): void => {
      calls++;
    };

    // `once` first, so a removal that searches by function identity would find
    // the one-shot and leave the persistent subscription firing forever.
    bus.once('BoredomChanged', handler);
    const offPersistent = bus.on('BoredomChanged', handler);

    offPersistent();
    expect(bus.listenerCount('BoredomChanged')).toBe(1);

    // What survived is the one-shot: it fires once and then the type is empty.
    bus.emit('BoredomChanged', BOREDOM);
    bus.emit('BoredomChanged', BOREDOM);
    expect(calls).toBe(1);
    expect(bus.listenerCount('BoredomChanged')).toBe(0);
  });

  it('removes one record per unsubscribe when a function is subscribed twice', () => {
    const bus = new EventBus();
    let calls = 0;
    const handler = (): void => {
      calls++;
    };

    const offA = bus.on('BoredomChanged', handler);
    const offB = bus.on('BoredomChanged', handler);

    offA();
    expect(bus.listenerCount('BoredomChanged')).toBe(1);
    bus.emit('BoredomChanged', BOREDOM);
    expect(calls).toBe(1);

    offB();
    expect(bus.listenerCount('BoredomChanged')).toBe(0);
    // A second call to an already-spent unsubscribe must not remove anything.
    offB();
    bus.on('BoredomChanged', handler);
    offA();
    expect(bus.listenerCount('BoredomChanged')).toBe(1);
  });

  it('still supports removal by function identity via off()', () => {
    const bus = new EventBus();
    const handler = (): void => {};
    bus.on('BoredomChanged', handler);
    expect(bus.listenerCount('BoredomChanged')).toBe(1);
    bus.off('BoredomChanged', handler);
    expect(bus.listenerCount('BoredomChanged')).toBe(0);
  });
});

describe('EventBus handler isolation', () => {
  beforeEach(() => {
    resetLogState();
  });

  it('rate-limits the default error log instead of writing one line per emit', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bus = new EventBus();
      let sibling = 0;
      bus.on('BoredomChanged', () => {
        throw new Error('boom');
      });
      bus.on('BoredomChanged', () => {
        sibling++;
      });

      for (let i = 0; i < 60; i++) bus.emit('BoredomChanged', BOREDOM);

      // Isolation: the throw never reached the sibling or the caller.
      expect(sibling).toBe(60);
      // Rate limit: one line for the burst, not sixty stack traces.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('still routes to an injected onError when one is supplied', () => {
    const seen: string[] = [];
    const bus = new EventBus({
      onError: (_error, type) => {
        seen.push(type);
      },
    });
    bus.on('BoredomChanged', () => {
      throw new Error('boom');
    });
    bus.emit('BoredomChanged', BOREDOM);
    bus.emit('BoredomChanged', BOREDOM);
    expect(seen).toEqual(['BoredomChanged', 'BoredomChanged']);
  });
});

describe('EventBus guarantee 1 — synchronous dispatch', () => {
  it('runs handlers before emit() returns', () => {
    const bus = new EventBus();
    let ran = false;
    bus.on('PlayerLanded', () => {
      ran = true;
    });
    bus.emit('PlayerLanded', landed());
    // No await, no timer: the flag is already set on the very next line.
    expect(ran).toBe(true);
  });
});

describe('EventBus guarantee 2 — handler isolation', () => {
  it('runs later handlers after an earlier one throws, and never evicts it', () => {
    const errors: [unknown, string][] = [];
    // Explicit onError so this never depends on the default logger behaviour.
    const bus = new EventBus({ onError: (error, type) => errors.push([error, type]) });
    const order: string[] = [];

    bus.on('PlayerLanded', () => {
      order.push('a');
      throw new Error('boom');
    });
    bus.on('PlayerLanded', () => {
      order.push('b');
    });

    bus.emit('PlayerLanded', landed());
    expect(order).toEqual(['a', 'b']);
    expect(errors).toHaveLength(1);
    expect(errors[0]![1]).toBe('PlayerLanded');
    expect(errors[0]![0]).toBeInstanceOf(Error);
    expect((errors[0]![0] as Error).message).toBe('boom');

    // A throwing handler is isolated, not quarantined: it still runs next time.
    bus.emit('PlayerLanded', landed());
    expect(order).toEqual(['a', 'b', 'a', 'b']);
    expect(errors).toHaveLength(2);
  });
});

describe('EventBus guarantee 3 — mutation safety during dispatch', () => {
  it('defers a subscription made inside a handler to the next emit', () => {
    const bus = new EventBus();
    const log: string[] = [];
    const late = (): void => {
      log.push('late');
    };
    bus.on('PlayerLanded', () => {
      log.push('first');
      bus.on('PlayerLanded', late);
    });

    bus.emit('PlayerLanded', landed());
    expect(log).toEqual(['first']);

    bus.emit('PlayerLanded', landed());
    expect(log).toEqual(['first', 'first', 'late']);
  });

  it('still delivers to a handler that unsubscribed itself mid-dispatch', () => {
    const bus = new EventBus();
    const log: string[] = [];
    const off = bus.on('PlayerLanded', () => {
      log.push('h1');
      off();
    });
    bus.on('PlayerLanded', () => {
      log.push('h2');
    });

    bus.emit('PlayerLanded', landed());
    // The snapshot was taken before h1 ran, so h2 is not skipped by the splice.
    expect(log).toEqual(['h1', 'h2']);
    expect(bus.listenerCount('PlayerLanded')).toBe(1);

    bus.emit('PlayerLanded', landed());
    expect(log).toEqual(['h1', 'h2', 'h2']);
  });

  it('treats a second call to an unsubscribe function as a no-op', () => {
    const bus = new EventBus();
    const off = bus.on('PlayerLanded', () => {});
    bus.on('PlayerLanded', () => {});
    off();
    off();
    expect(bus.listenerCount('PlayerLanded')).toBe(1);
  });

  it('fires a `once` handler exactly once', () => {
    const bus = new EventBus();
    let calls = 0;
    bus.once('PlayerLanded', () => {
      calls++;
    });
    bus.emit('PlayerLanded', landed());
    expect(calls).toBe(1);
    expect(bus.listenerCount('PlayerLanded')).toBe(0);
    bus.emit('PlayerLanded', landed());
    expect(calls).toBe(1);
  });
});

describe('EventBus guarantee 4 — vector copying', () => {
  it('copies `position` so a reused scratch vector cannot leak into a handler', () => {
    const bus = new EventBus();
    const scratch = { x: 1, y: 2, z: 3 };
    let captured: Vec3 | undefined;
    bus.on('PlayerLanded', (event) => {
      captured = event.position;
    });

    bus.emit('PlayerLanded', landed(scratch));
    scratch.x = 999;

    expect(captured).toEqual({ x: 1, y: 2, z: 3 });
    expect(captured).not.toBe(scratch);
  });

  it('copies `origin` and `direction` on ShockwaveFired', () => {
    const bus = new EventBus();
    const origin = { x: 1, y: 2, z: 3 };
    const direction = { x: 0, y: 1, z: 0 };
    let event: { origin: Vec3; direction: Vec3 } | undefined;
    bus.on('ShockwaveFired', (e) => {
      event = { origin: e.origin, direction: e.direction };
    });

    bus.emit('ShockwaveFired', {
      origin,
      direction,
      power: 1000,
      range: 50,
      angle: 0.5,
      intent: 'serious',
      punchKind: 'normal',
    });
    origin.x = 999;
    direction.y = 999;

    expect(event?.origin).toEqual({ x: 1, y: 2, z: 3 });
    expect(event?.direction).toEqual({ x: 0, y: 1, z: 0 });
    expect(event?.origin).not.toBe(origin);
    expect(event?.direction).not.toBe(direction);
  });

  it('copies `impulse` and `point` on ImpulseApplied', () => {
    const bus = new EventBus();
    const impulse = { x: 5, y: 6, z: 7 };
    const point = { x: 8, y: 9, z: 10 };
    let event: { impulse: Vec3; point: Vec3 } | undefined;
    bus.on('ImpulseApplied', (e) => {
      event = { impulse: e.impulse, point: e.point };
    });

    bus.emit('ImpulseApplied', { targetId: 'debris-1', impulse, point });
    impulse.x = 999;
    point.z = 999;

    expect(event?.impulse).toEqual({ x: 5, y: 6, z: 7 });
    expect(event?.point).toEqual({ x: 8, y: 9, z: 10 });
  });

  it('passes non-Vec3 structured fields BY REFERENCE — the actual contract', () => {
    // `IChunkCoord` is `{ x, z }` with no `y`, so `isVec3` rejects it and the
    // emitter's object reaches the handler unchanged. Documented rather than
    // "fixed": copying every structured field on every emit is hot-path cost.
    const bus = new EventBus();
    const coord = { x: 3, z: -4 };
    let captured: { x: number; z: number } | undefined;
    bus.on('ChunkStreamedIn', (event) => {
      captured = event.coord;
    });

    bus.emit('ChunkStreamedIn', { key: '3,-4', coord, loadTimeMs: 12, memoryBytes: 1024 });
    expect(captured).toBe(coord);
  });
});

describe('EventBus guarantee 5 — ordering', () => {
  it('runs a type’s handlers in subscription order, every emit', () => {
    const bus = new EventBus();
    const log: string[] = [];
    for (const name of ['a', 'b', 'c', 'd']) {
      bus.on('PlayerLanded', () => {
        log.push(name);
      });
    }

    bus.emit('PlayerLanded', landed());
    expect(log.join('')).toBe('abcd');
    bus.emit('PlayerLanded', landed());
    expect(log.join('')).toBe('abcdabcd');
  });
});

describe('EventBus stamping', () => {
  it('stamps `type`, `frame` and `time` without disturbing the payload', () => {
    const bus = new EventBus();
    let seen: { type: string; frame: number; time: number; impactSpeed: number } | undefined;
    bus.on('PlayerLanded', (event) => {
      seen = {
        type: event.type,
        frame: event.frame,
        time: event.time,
        impactSpeed: event.impactSpeed,
      };
    });

    bus.setFrame(42, 7.5);
    bus.emit('PlayerLanded', landed());

    expect(seen).toEqual({ type: 'PlayerLanded', frame: 42, time: 7.5, impactSpeed: 12 });
  });

  it('stamps frame 0 / time 0 on a bus that has never been advanced', () => {
    const bus = new EventBus();
    let seen: { frame: number; time: number } | undefined;
    bus.on('PlayerLanded', (event) => {
      seen = { frame: event.frame, time: event.time };
    });
    bus.emit('PlayerLanded', landed());
    expect(seen).toEqual({ frame: 0, time: 0 });
  });
});

describe('EventBus listenerCount and clear', () => {
  it('counts `onAny` only in the no-argument form', () => {
    const bus = new EventBus();
    bus.on('PlayerLanded', () => {});
    bus.onAny(() => {});

    expect(bus.listenerCount('PlayerLanded')).toBe(1);
    expect(bus.listenerCount()).toBe(2);
    expect(bus.listenerCount('EntityKilled')).toBe(0);
  });

  it('leaves `onAny` installed when clearing a single type', () => {
    const bus = new EventBus();
    const log: string[] = [];
    bus.on('PlayerLanded', () => {
      log.push('typed');
    });
    bus.onAny(() => {
      log.push('any');
    });

    bus.clear('PlayerLanded');
    bus.emit('PlayerLanded', landed());
    expect(log).toEqual(['any']);
    expect(bus.listenerCount()).toBe(1);
  });

  it('removes everything, `onAny` included, with no argument', () => {
    const bus = new EventBus();
    const log: string[] = [];
    bus.on('PlayerLanded', () => {
      log.push('typed');
    });
    bus.onAny(() => {
      log.push('any');
    });

    bus.clear();
    bus.emit('PlayerLanded', landed());
    expect(log).toEqual([]);
    expect(bus.listenerCount()).toBe(0);
  });
});

describe('EventBus onAny mutation safety', () => {
  it('defers an `onAny` subscription made by a typed handler to the next emit', () => {
    const bus = new EventBus();
    const log: string[] = [];
    const late = (): void => {
      log.push('any-late');
    };
    let installed = false;
    bus.on('PlayerLanded', () => {
      log.push('typed');
      if (!installed) {
        installed = true;
        bus.onAny(late);
      }
    });

    bus.emit('PlayerLanded', landed());
    expect(log).toEqual(['typed']);

    bus.emit('PlayerLanded', landed());
    expect(log).toEqual(['typed', 'typed', 'any-late']);
  });

  it('still delivers to an `onAny` handler removed by a typed handler mid-dispatch', () => {
    const bus = new EventBus();
    const log: string[] = [];
    const offAny = bus.onAny(() => {
      log.push('any');
    });
    bus.on('PlayerLanded', () => {
      log.push('typed');
      offAny();
    });

    // Symmetric with a typed handler that unsubscribes itself: the snapshot was
    // already taken, so the removal takes effect on the NEXT emit.
    bus.emit('PlayerLanded', landed());
    expect(log).toEqual(['typed', 'any']);

    bus.emit('PlayerLanded', landed());
    expect(log).toEqual(['typed', 'any', 'typed']);
  });

  it('isolates a throwing `onAny` handler from its siblings', () => {
    const errors: string[] = [];
    const bus = new EventBus({ onError: (_error, type) => errors.push(type) });
    const log: string[] = [];
    bus.onAny(() => {
      log.push('first');
      throw new Error('boom');
    });
    bus.onAny(() => {
      log.push('second');
    });

    bus.emit('PlayerLanded', landed());
    expect(log).toEqual(['first', 'second']);
    expect(errors).toEqual(['PlayerLanded']);
  });
});

describe('EventBus leak detection', () => {
  it('warns once, naming the type, when a type crosses the threshold', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const bus = new EventBus({ leakThreshold: 2 });
      for (let i = 0; i < 4; i++) bus.on('PlayerLanded', () => {});

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('PlayerLanded');
    } finally {
      warn.mockRestore();
    }
  });

  it('stays at one warning while a type only ever grows', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const bus = new EventBus({ leakThreshold: 2 });
      for (let i = 0; i < 10; i++) bus.on('PlayerLanded', () => {});
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('re-arms once the type falls back under the threshold', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const bus = new EventBus({ leakThreshold: 2 });
      const offs = [...Array(4)].map(() => bus.on('PlayerLanded', () => {}));
      expect(warn).toHaveBeenCalledTimes(1);

      // The ordinary lifecycle: a system unsubscribes everything on dispose,
      // a later one re-subscribes. The detector must not stay latched off.
      for (const off of offs) off();
      for (let i = 0; i < 4; i++) bus.on('PlayerLanded', () => {});

      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('re-arms after removals made through off() as well', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const bus = new EventBus({ leakThreshold: 2 });
      const handlers = [...Array(4)].map(() => () => {});
      for (const handler of handlers) bus.on('PlayerLanded', handler);
      expect(warn).toHaveBeenCalledTimes(1);

      for (const handler of handlers) bus.off('PlayerLanded', handler);
      for (let i = 0; i < 4; i++) bus.on('PlayerLanded', () => {});

      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('createEventBus', () => {
  it('produces a working IEventBus, which is how most modules construct one', () => {
    const bus = createEventBus();
    const seen: GameEvent[] = [];
    bus.onAny((event) => seen.push(event));
    const off = bus.on('PlayerLanded', () => {});

    expect(bus.listenerCount()).toBe(2);
    bus.setFrame(3, 0.25);
    bus.emit('PlayerLanded', landed());

    expect(seen).toHaveLength(1);
    expect(seen[0]!.type).toBe('PlayerLanded');
    expect(seen[0]!.frame).toBe(3);

    off();
    bus.clear();
    expect(bus.listenerCount()).toBe(0);
  });
});
