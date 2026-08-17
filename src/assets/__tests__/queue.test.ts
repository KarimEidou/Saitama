/**
 * PRIORITY SCHEDULING
 *
 * Three properties the streaming system depends on and cannot verify itself:
 * de-duplication (load() is documented idempotent), priority ordering (the
 * boot set must not queue behind a prefetch), and a hard concurrency cap.
 */

import { describe, it, expect, vi } from 'vitest';
import { LoadScheduler, ProgressTracker, priorityValue } from '../queue';
import { PRIORITY } from '../constants';

/** A task that resolves when the test says so. */
function gate<T>(value: T): { run: () => Promise<T>; open: () => void; started: () => boolean } {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  return {
    run: async () => {
      entered = true;
      await pending;
      return value;
    },
    open: release,
    started: () => entered,
  };
}

describe('LoadScheduler', () => {
  it('runs one task per key however many times it is scheduled', async () => {
    const scheduler = new LoadScheduler(4);
    const run = vi.fn(async () => 'done');
    const results = await Promise.all([
      scheduler.schedule('a', 'normal', run),
      scheduler.schedule('a', 'normal', run),
      scheduler.schedule('a', 'high', run),
    ]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(results).toEqual(['done', 'done', 'done']);
  });

  it('never exceeds its concurrency', async () => {
    const scheduler = new LoadScheduler(2);
    const gates = [gate(1), gate(2), gate(3), gate(4)];
    const promises = gates.map((task, index) =>
      scheduler.schedule(`k${index}`, 'normal', task.run)
    );

    await Promise.resolve();
    expect(gates.filter((task) => task.started()).length).toBe(2);
    expect(scheduler.running).toBe(2);

    for (const task of gates) task.open();
    await Promise.all(promises);
    expect(scheduler.running).toBe(0);
  });

  it('runs higher priority first among queued work', async () => {
    const scheduler = new LoadScheduler(1);
    const order: string[] = [];
    const blocker = gate('block');

    const first = scheduler.schedule('blocker', 'normal', blocker.run);
    const low = scheduler.schedule('low', PRIORITY.low, async () => {
      order.push('low');
    });
    const critical = scheduler.schedule('critical', PRIORITY.critical, async () => {
      order.push('critical');
    });
    const normal = scheduler.schedule('normal', PRIORITY.normal, async () => {
      order.push('normal');
    });

    blocker.open();
    await Promise.all([first, low, critical, normal]);
    expect(order).toEqual(['critical', 'normal', 'low']);
  });

  it('breaks priority ties in FIFO order', async () => {
    const scheduler = new LoadScheduler(1);
    const order: string[] = [];
    const blocker = gate('block');
    const promises = [scheduler.schedule('blocker', 'normal', blocker.run)];
    for (const name of ['a', 'b', 'c']) {
      promises.push(
        scheduler.schedule(name, 'normal', async () => {
          order.push(name);
          return name;
        })
      );
    }
    blocker.open();
    await Promise.all(promises);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('re-prioritises a task that is still queued', async () => {
    const scheduler = new LoadScheduler(1);
    const order: string[] = [];
    const blocker = gate('block');
    const promises = [scheduler.schedule('blocker', 'normal', blocker.run)];

    promises.push(
      scheduler.schedule('late', PRIORITY.idle, async () => {
        order.push('late');
      })
    );
    promises.push(
      scheduler.schedule('other', PRIORITY.normal, async () => {
        order.push('other');
      })
    );
    // The player just walked into the chunk we were lazily prefetching.
    promises.push(scheduler.schedule('late', PRIORITY.critical, async () => undefined));

    blocker.open();
    await Promise.all(promises);
    expect(order).toEqual(['late', 'other']);
  });

  it('surfaces a task rejection to every caller and keeps running', async () => {
    const scheduler = new LoadScheduler(2);
    await expect(
      scheduler.schedule('bad', 'normal', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    await expect(scheduler.schedule('good', 'normal', async () => 'ok')).resolves.toBe('ok');
  });

  it('resolves idle() once the queue drains', async () => {
    const scheduler = new LoadScheduler(1);
    const task = gate('x');
    const running = scheduler.schedule('x', 'normal', task.run);
    const idle = scheduler.idle();
    task.open();
    await running;
    await idle;
    expect(scheduler.queued).toBe(0);
    expect(scheduler.running).toBe(0);
  });
});

describe('priorityValue', () => {
  it('maps names to weights and passes numbers through', () => {
    expect(priorityValue('critical')).toBe(PRIORITY.critical);
    expect(priorityValue(undefined)).toBe(PRIORITY.normal);
    expect(priorityValue(7)).toBe(7);
  });
});

describe('ProgressTracker', () => {
  it('reports counts and bytes together', () => {
    const seen: number[] = [];
    const tracker = new ProgressTracker(2, 1000, (progress) => seen.push(progress.fraction));
    tracker.begin('a');
    tracker.complete('a', 400);
    tracker.complete('b', 600);
    expect(seen.at(-1)).toBe(1);
    expect(tracker.snapshot.bytesLoaded).toBe(1000);
    expect(tracker.snapshot.bytesTotal).toBe(1000);
    expect(tracker.snapshot.loaded).toBe(2);
  });

  it('never reports a fraction above 1', () => {
    const tracker = new ProgressTracker(1, 10);
    tracker.complete('a', 10);
    tracker.complete('b', 10);
    expect(tracker.snapshot.fraction).toBe(1);
  });
});
