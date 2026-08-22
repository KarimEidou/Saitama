/**
 * OBJECT POOL — THE DOUBLE-RELEASE GUARD
 *
 * Releasing one instance twice puts it on the free list twice, so the next two
 * `acquire()` calls hand ONE object to two independent callers. Nothing throws
 * and `stats` still looks healthy while the pool is handing out aliases: an
 * NPC's steering target and a camera's look-at target become the same vector
 * and the second writer silently wins.
 *
 * The module header promised a development-build guard. These prove it exists,
 * and that it costs correct callers nothing.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ObjectPool } from '../pool';
import { resetLogState } from '../logger';

interface Slot {
  id: number;
}

describe('ObjectPool double release', () => {
  beforeEach(() => {
    resetLogState();
  });

  it('never hands one instance to two callers after a double release', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let next = 0;
      const pool = new ObjectPool<Slot>({ factory: () => ({ id: next++ }) });

      const item = pool.acquire();
      pool.release(item);
      pool.release(item); // the bug

      expect(warn).toHaveBeenCalledTimes(1);
      expect(pool.stats.free).toBe(1);

      const a = pool.acquire();
      const b = pool.acquire();
      expect(a).not.toBe(b);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not decrement `active` for a release that was rejected', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const pool = new ObjectPool<Slot>({ factory: () => ({ id: 0 }) });
      const a = pool.acquire();
      const b = pool.acquire();
      pool.release(a);
      pool.release(a); // rejected: `a` is not checked out any more
      expect(pool.stats.active).toBe(1);
      pool.release(b);
      expect(pool.stats.active).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('accepts an instance released, re-acquired and released again', () => {
    const pool = new ObjectPool<Slot>({ factory: () => ({ id: 0 }) });
    const item = pool.acquire();
    pool.release(item);
    expect(pool.acquire()).toBe(item);
    pool.release(item);
    expect(pool.stats.free).toBe(1);
    expect(pool.stats.active).toBe(0);
  });
});

describe('ObjectPool accounting', () => {
  it('leaves ordinary acquire/release/reset behaviour untouched', () => {
    const resets: Slot[] = [];
    const pool = new ObjectPool<Slot>({
      factory: () => ({ id: 0 }),
      reset: (item) => resets.push(item),
      initialSize: 2,
    });

    expect(pool.stats.free).toBe(2);
    expect(pool.stats.created).toBe(2);

    const a = pool.acquire();
    const b = pool.acquire();
    const c = pool.acquire();
    expect(pool.stats.active).toBe(3);
    expect(pool.stats.reused).toBe(2);
    expect(pool.stats.created).toBe(3);

    pool.release(a);
    pool.release(b);
    pool.release(c);
    expect(resets).toEqual([a, b, c]);
    expect(pool.stats.active).toBe(0);
    expect(pool.stats.free).toBe(3);
  });

  it('destroys releases past maxSize rather than retaining them', () => {
    const destroyed: Slot[] = [];
    const pool = new ObjectPool<Slot>({
      factory: () => ({ id: 0 }),
      destroy: (item) => destroyed.push(item),
      maxSize: 1,
    });

    const a = pool.acquire();
    const b = pool.acquire();
    pool.release(a);
    pool.release(b);

    expect(pool.stats.free).toBe(1);
    expect(pool.stats.discarded).toBe(1);
    expect(destroyed).toEqual([b]);
  });
});
