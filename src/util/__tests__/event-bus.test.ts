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
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus } from '../event-bus';
import { resetLogState } from '../logger';

/** Smallest real payload on the bus; nothing here depends on its contents. */
const BOREDOM = { value: 0.5, previous: 0.4, reason: 'idle' } as const;

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
