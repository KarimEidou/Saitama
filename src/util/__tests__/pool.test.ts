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
import { FixedPool, ObjectPool } from '../pool';
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

/**
 * The suites below cover the retention/teardown surface and all of `FixedPool`.
 *
 * `IPoolStats` is offered to the debug overlay, so its counters are a
 * diagnostic surface rather than decoration — a wrong `discarded` sends whoever
 * is chasing a hitch to the wrong subsystem. `FixedPool` had no consumer and no
 * test at all, which means its `inUse` bookkeeping — the thing that makes its
 * "double-release is ignored" promise true — had never been executed.
 */

describe('ObjectPool retention and teardown', () => {
  it('runs `reset` on release, before the instance can be handed out again', () => {
    const pool = new ObjectPool<{ id: number; v: number }>({
      factory: () => ({ id: 0, v: 0 }),
      reset: (item) => {
        item.v = 0;
      },
    });

    const item = pool.acquire();
    item.v = 7;
    pool.release(item);
    expect(item.v).toBe(0);
  });

  it('returns a batch through releaseAll', () => {
    const pool = new ObjectPool<Slot>({ factory: () => ({ id: 0 }) });
    const items = [pool.acquire(), pool.acquire(), pool.acquire()];
    expect(pool.stats.active).toBe(3);

    pool.releaseAll(items);
    expect(pool.stats.active).toBe(0);
    expect(pool.stats.free).toBe(3);
  });

  it('counts every discard past maxSize', () => {
    const destroyed: Slot[] = [];
    const pool = new ObjectPool<Slot>({
      factory: () => ({ id: 0 }),
      destroy: (item) => destroyed.push(item),
      maxSize: 1,
    });

    const items = [pool.acquire(), pool.acquire(), pool.acquire()];
    pool.releaseAll(items);

    expect(destroyed).toHaveLength(2);
    expect(pool.stats.free).toBe(1);
    expect(pool.stats.discarded).toBe(2);
  });

  it('retains without bound when no maxSize is configured', () => {
    const pool = new ObjectPool<Slot>({ factory: () => ({ id: 0 }) });
    const items = [...Array(100)].map(() => pool.acquire());
    pool.releaseAll(items);

    expect(pool.stats.free).toBe(100);
    expect(pool.stats.discarded).toBe(0);
  });

  it('destroys the free list on clear()', () => {
    const destroy = vi.fn();
    const pool = new ObjectPool<Slot>({ factory: () => ({ id: 0 }), destroy, initialSize: 4 });

    pool.clear();
    expect(destroy).toHaveBeenCalledTimes(4);
    expect(pool.stats.free).toBe(0);
  });

  it('leaves checked-out instances untouched by clear()', () => {
    const destroyed: Slot[] = [];
    let next = 0;
    const pool = new ObjectPool<Slot>({
      factory: () => ({ id: next++ }),
      destroy: (item) => destroyed.push(item),
      initialSize: 4,
    });

    const held = pool.acquire();
    pool.clear();
    // Only the three still on the free list were destroyed. `toContain` compares
    // by reference, which is the point — every instance is structurally equal.
    expect(destroyed).toHaveLength(3);
    expect(destroyed).not.toContain(held);
    expect(pool.stats.free).toBe(0);

    pool.release(held);
    expect(pool.stats.free).toBe(1);
    expect(pool.acquire()).toBe(held);
  });
});

describe('FixedPool', () => {
  const makePool = (
    capacity = 3
  ): {
    pool: FixedPool<{ slot: number; v: number }>;
    factoryIndices: number[];
    resets: number[];
  } => {
    const factoryIndices: number[] = [];
    const resets: number[] = [];
    const pool = new FixedPool(
      capacity,
      (index) => {
        factoryIndices.push(index);
        return { slot: index, v: 0 };
      },
      (item) => {
        resets.push(item.slot);
        item.v = 0;
      }
    );
    return { pool, factoryIndices, resets };
  };

  it('pre-builds every slot exactly once at construction', () => {
    const { pool, factoryIndices } = makePool();
    expect(pool.capacity).toBe(3);
    expect(pool.activeCount).toBe(0);
    expect(factoryIndices).toHaveLength(3);
    expect([...factoryIndices].sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it('hands out distinct slots and then FAILS rather than allocating', () => {
    const { pool } = makePool();
    const handles = [pool.acquire(), pool.acquire(), pool.acquire()];

    for (const handle of handles) {
      expect(handle).toBeDefined();
      expect(handle!.item.slot).toBe(handle!.index);
    }
    expect([...handles.map((h) => h!.index)].sort((a, b) => a - b)).toEqual([0, 1, 2]);
    expect(pool.activeCount).toBe(3);

    // The whole point of the class: exceeding the budget must not allocate.
    expect(pool.acquire()).toBeUndefined();
    expect(pool.activeCount).toBe(3);
  });

  it('exposes a slot through get() only while it is checked out', () => {
    const { pool } = makePool();
    const handle = pool.acquire()!;
    expect(pool.get(handle.index)).toBe(handle.item);

    pool.release(handle.index);
    expect(pool.get(handle.index)).toBeUndefined();
  });

  it('runs `reset` on release and not on acquire', () => {
    const { pool, resets } = makePool();
    const handle = pool.acquire()!;
    expect(resets).toEqual([]);

    handle.item.v = 9;
    pool.release(handle.index);
    expect(resets).toEqual([handle.index]);
    expect(handle.item.v).toBe(0);
  });

  it('ignores an out-of-range release', () => {
    const { pool, resets } = makePool();
    pool.acquire();
    pool.release(-1);
    pool.release(3);
    expect(pool.activeCount).toBe(1);
    expect(resets).toEqual([]);
  });

  it('ignores a double release instead of duplicating a slot', () => {
    const { pool, resets } = makePool();
    const handle = pool.acquire()!;
    pool.release(handle.index);
    pool.release(handle.index);

    expect(pool.activeCount).toBe(0);
    expect(resets).toEqual([handle.index]);

    // A duplicated free entry would hand one slot to two callers.
    const indices = [pool.acquire()!.index, pool.acquire()!.index, pool.acquire()!.index];
    expect([...indices].sort((a, b) => a - b)).toEqual([0, 1, 2]);
    expect(pool.acquire()).toBeUndefined();
  });

  it('iterates exactly the checked-out slots, ascending by index', () => {
    const { pool } = makePool();
    const first = pool.acquire()!;
    const second = pool.acquire()!;
    const third = pool.acquire()!;
    pool.release(second.index);

    const active = [...pool.active()];
    expect(active.map((entry) => entry.index)).toEqual(
      [first.index, third.index].sort((a, b) => a - b)
    );
    for (const entry of active) expect(entry.item.slot).toBe(entry.index);

    pool.releaseAll();
    expect(pool.activeCount).toBe(0);
    expect([...pool.active()]).toEqual([]);
  });
});
