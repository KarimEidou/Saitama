/**
 * ZERO ALLOCATION PER DETACH
 *
 * Garbage collection is the main cause of frame hitches in a long-running
 * WebGL session on a phone, and a building collapse is precisely the moment
 * the frame can least afford one — hundreds of pieces, all born together,
 * while the renderer is already at its most expensive. A destruction system
 * that allocates per detach schedules its own hitch for the frame after the
 * best-looking thing in the game.
 *
 * So this measures rather than asserts a policy. V8's GC is exposed
 * explicitly (`--expose_gc` via `v8.setFlagsFromString`, so the suite needs no
 * special runner), the heap is settled, and 20 000 detaches are driven through
 * the real code path.
 *
 * ── WHAT IS AND IS NOT BEING CLAIMED ───────────────────────────────────────
 * The claim is about THIS SYSTEM. `IEventBus.emit` builds a fresh event object
 * and copies its vectors on every emit — that is the bus's documented contract
 * ("callers may pass reused scratch vectors"), it belongs to `src/util`, and
 * destruction cannot opt out of it. The test therefore measures both:
 *
 *   • with a null bus, destruction's own allocation must be ~zero;
 *   • with the real bus, the delta is reported so the bus's per-event cost is
 *     visible rather than hidden inside a passing test.
 */

import { describe, expect, it } from 'vitest';
import v8 from 'node:v8';
import vm from 'node:vm';
import type { GameEventPayload, GameEventType, IEventBus } from '@/types';
import { createEventBus } from '@/util';
import { collapsingFloors as cityCollapsingFloors } from '@/world/city';
import { DestructionSystem } from '../destruction-system';
import { FakeDebrisPool, makeTower } from './fixtures';

/** Expose V8's GC without demanding a special node invocation. */
function getGc(): (() => void) | undefined {
  const existing = (globalThis as { gc?: () => void }).gc;
  if (existing !== undefined) return existing;
  try {
    v8.setFlagsFromString('--expose_gc');
    const gc = vm.runInNewContext('gc') as () => void;
    v8.setFlagsFromString('--no-expose_gc');
    return gc;
  } catch {
    return undefined;
  }
}

/** A bus that dispatches nothing, so only destruction's own garbage is seen. */
function nullBus(): IEventBus {
  return {
    on: () => () => {},
    once: () => () => {},
    off: () => {},
    emit: <T extends GameEventType>(_type: T, _payload: GameEventPayload<T>) => {},
    onAny: () => () => {},
    clear: () => {},
    listenerCount: () => 0,
    setFrame: () => {},
  };
}

interface IRun {
  readonly detaches: number;
  readonly bytesPerDetach: number;
  readonly totalBytes: number;
}

/**
 * Drive `towers` twelve-storey buildings to rubble and measure the heap.
 *
 * Structures are all registered UP FRONT and the heap is settled after that,
 * so registration (which does allocate — one Uint8Array and one Float64Array
 * per building, once) is outside the measurement. What is inside is the sweep,
 * the detach, the debris hand-off, the collapse scheduling and the emit.
 */
function measure(bus: IEventBus, towers: number, gc: () => void): IRun {
  const debris = new FakeDebrisPool(300);
  const system = new DestructionSystem({
    bus,
    debris,
    collapsingFloors: cityCollapsingFloors,
    seed: 'allocation',
  });

  for (let i = 0; i < towers; i++) {
    const { layout, attribute } = makeTower({ floors: 12, footprint: 10 });
    system.register({
      id: `tower-${String(i).padStart(4, '0')}`,
      layout,
      target: { destroyed: attribute },
      position: { x: 12 + i * 14, y: 0, z: 0 },
    });
  }
  // Warm every code path — the collapse queue's high-water mark, the shape
  // pool's free list, V8's inline caches — before the baseline is taken.
  system.applyShockwave(
    { x: -20, y: 2, z: 0 },
    { x: 1, y: 0, z: 0 },
    120,
    0.3,
    2.5e6,
    'full'
  );
  for (let frame = 0; frame < 20; frame++) {
    system.update(1 / 60);
    debris.retire(debris.count);
  }

  gc();
  gc();
  const before = process.memoryUsage().heapUsed;
  const startDetaches = system.diagnostics.chunksDestroyed;

  // Sustained destruction: walk the punch down the row of buildings, one
  // frame at a time, exactly as a fight would.
  for (let step = 0; step < towers; step++) {
    system.applyShockwave(
      { x: 12 + step * 14 - 40, y: 2, z: 0 },
      { x: 1, y: 0, z: 0 },
      140,
      0.35,
      2.5e6,
      'full'
    );
    for (let frame = 0; frame < 4; frame++) {
      system.update(1 / 60);
      // Retire debris so the pool keeps accepting, which keeps the debris
      // hand-off inside the measured path instead of short-circuiting.
      debris.retire(debris.count);
    }
  }

  gc();
  gc();
  const after = process.memoryUsage().heapUsed;
  const detaches = system.diagnostics.chunksDestroyed - startDetaches;
  system.dispose();

  const totalBytes = Math.max(0, after - before);
  return { detaches, bytesPerDetach: totalBytes / Math.max(1, detaches), totalBytes };
}

describe('allocation under sustained destruction', () => {
  const gc = getGc();

  it.skipIf(gc === undefined)('allocates nothing per detach of its own', () => {
    const run = measure(nullBus(), 220, gc!);
    console.log(
      `[destruction] own allocation: ${run.detaches} detaches, ` +
        `${run.totalBytes} B total, ${run.bytesPerDetach.toFixed(2)} B/detach`
    );
    expect(run.detaches).toBeGreaterThan(8_000);
    // Anything above a handful of bytes per detach means a temporary escaped
    // into the hot path. The threshold is generous enough to absorb V8's own
    // bookkeeping drift across a 10 000-iteration run and tight enough that a
    // single object literal per detach (>= 32 B) fails it.
    expect(run.bytesPerDetach).toBeLessThan(8);
  }, 120_000);

  it.skipIf(gc === undefined)('reports the event bus cost separately', () => {
    const own = measure(nullBus(), 160, gc!);
    const withBus = measure(createEventBus(), 160, gc!);
    const busCost = withBus.bytesPerDetach - own.bytesPerDetach;
    console.log(
      `[destruction] with the real EventBus: ${withBus.bytesPerDetach.toFixed(1)} B/detach ` +
        `(bus contributes ~${busCost.toFixed(1)} B/detach, from the event object and ` +
        `its two copied vectors)`
    );
    expect(withBus.detaches).toBe(own.detaches);
    // Not a pass/fail on the bus, but a ceiling that would catch destruction
    // starting to hand it something expensive (a per-event array, a string).
    expect(withBus.bytesPerDetach).toBeLessThan(400);
  }, 120_000);

  it('reuses the same event payload object every emit', () => {
    const seen = new Set<object>();
    const bus = createEventBus();
    const system = new DestructionSystem({ bus, seed: 'payload' });
    const { layout, attribute } = makeTower({ floors: 12 });
    const structure = system.register({
      id: 'tower',
      layout,
      target: { destroyed: attribute },
      position: { x: 0, y: 0, z: 0 },
    });

    // `onAny` sees the bus's copy, so reach for the payload the bus was
    // handed: patch `emit` and record identity.
    const original = bus.emit.bind(bus);
    bus.emit = ((type, payload) => {
      seen.add(payload as object);
      original(type, payload);
    }) as IEventBus['emit'];

    for (let i = 0; i < structure.chunkCount; i++) system.detachChunk(structure, i, 'blast');
    expect(seen.size).toBe(1);
    system.dispose();
  });

  it('never grows the collapse queue in the steady state', () => {
    const bus = createEventBus();
    const system = new DestructionSystem({
      bus,
      collapsingFloors: cityCollapsingFloors,
      seed: 'queue',
    });
    for (let i = 0; i < 12; i++) {
      const { layout, attribute } = makeTower({ floors: 12 });
      system.register({
        id: `t-${i}`,
        layout,
        target: { destroyed: attribute },
        position: { x: 12 + i * 14, y: 0, z: 0 },
      });
    }
    for (let step = 0; step < 12; step++) {
      system.applyShockwave(
        { x: 12 + step * 14 - 40, y: 2, z: 0 },
        { x: 1, y: 0, z: 0 },
        140,
        0.35,
        2.5e6,
        'full'
      );
      for (let frame = 0; frame < 4; frame++) system.update(1 / 60);
    }
    // Everything queued has been drained, so the queue is empty rather than
    // quietly retaining every collapse the session ever scheduled.
    expect(system.diagnostics.pendingCollapseChunks).toBe(0);
    system.dispose();
  });
});
