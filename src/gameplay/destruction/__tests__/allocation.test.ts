/**
 * ZERO ALLOCATION PER DETACH
 *
 * Garbage collection is the main cause of frame hitches in a long-running
 * WebGL session on a phone, and a building collapse is precisely the moment
 * the frame can least afford one — hundreds of pieces born together while the
 * renderer is already at its most expensive. A destruction system that
 * allocates per detach schedules its own hitch for the frame after the
 * best-looking thing in the game.
 *
 * ── HOW IT IS MEASURED, AND WHY NOT THE OBVIOUS WAY ────────────────────────
 * The obvious measurement — `heapUsed` before and after, with a GC on each
 * side — measures RETENTION, not allocation. Short-lived garbage is collected
 * by the very GC that brackets the measurement, so a hot path churning a
 * megabyte of temporaries reads as zero. That is a leak check, and it is worth
 * having, but it is not this claim.
 *
 * So the primary instrument is V8's SAMPLING HEAP PROFILER, driven through
 * `node:inspector`. It reports bytes ALLOCATED, attributed to the call frames
 * that allocated them, whether or not they survived. Both measurements run:
 *
 *   ALLOCATION  bytes created per detached chunk. The real claim.
 *   RETENTION   bytes still reachable after the dust settles. The leak check.
 */

import { describe, expect, it } from 'vitest';
import inspector from 'node:inspector';
import v8 from 'node:v8';
import vm from 'node:vm';
import type { GameEventPayload, GameEventType, IEventBus } from '@/types';
import { createEventBus } from '@/util';
import { collapsingFloors as cityCollapsingFloors } from '@/world/city';
import { DestructionSystem } from '../destruction-system';
import { FakeDebrisPool, makeTower } from './fixtures';

/* -------------------------------------------------------------------------- */
/* Instruments                                                                */
/* -------------------------------------------------------------------------- */

interface ISite {
  readonly size: number;
  readonly fn: string;
  readonly where: string;
}

interface ISamplingProfiler {
  start(): Promise<void>;
  /**
   * `bytes` excludes the profiler's own `node:` frames — the inspector
   * protocol allocates while collecting, and billing the instrument to the
   * workload would be measuring the thermometer.
   */
  stop(): Promise<{ bytes: number; overhead: number; sites: ISite[] }>;
  dispose(): void;
}

/** V8's sampling heap profiler, or `undefined` where it cannot be attached. */
function openProfiler(): ISamplingProfiler | undefined {
  let session: inspector.Session;
  try {
    session = new inspector.Session();
    session.connect();
  } catch {
    return undefined;
  }

  const post = (method: string, params?: object): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      (session as unknown as {
        post(m: string, p: object | undefined, cb: (e: unknown, r: unknown) => void): void;
      }).post(method, params, (error, result) =>
        error ? reject(error as Error) : resolve(result as Record<string, unknown>)
      );
    });

  interface INode {
    selfSize?: number;
    callFrame: { functionName: string; url: string; lineNumber: number };
    children?: INode[];
  }

  const isInstrument = (url: string): boolean => url.startsWith('node:');

  const walk = (node: INode, sites: ISite[], totals: { bytes: number; overhead: number }): void => {
    const size = node.selfSize ?? 0;
    if (size > 0) {
      if (isInstrument(node.callFrame.url)) {
        totals.overhead += size;
      } else {
        totals.bytes += size;
        sites.push({
          size,
          fn: node.callFrame.functionName || '(anonymous)',
          where: String(node.callFrame.url).split('/').slice(-2).join('/'),
        });
      }
    }
    for (const child of node.children ?? []) walk(child, sites, totals);
  };

  return {
    async start() {
      // 256-byte sampling interval: fine enough that a per-detach object
      // could not hide, coarse enough not to distort the run.
      await post('HeapProfiler.startSampling', { samplingInterval: 256 });
    },
    async stop() {
      const result = await post('HeapProfiler.stopSampling');
      const sites: ISite[] = [];
      const totals = { bytes: 0, overhead: 0 };
      walk((result.profile as { head: INode }).head, sites, totals);
      sites.sort((a, b) => b.size - a.size);
      return { bytes: totals.bytes, overhead: totals.overhead, sites };
    },
    dispose() {
      session.disconnect();
    },
  };
}

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

/* -------------------------------------------------------------------------- */
/* The workload                                                               */
/* -------------------------------------------------------------------------- */

interface IScene {
  readonly system: DestructionSystem;
  readonly debris: FakeDebrisPool;
  readonly towers: number;
}

/**
 * A row of twelve-storey towers, fully warmed.
 *
 * The warm-up matters: it drives the collapse queue to its high-water mark,
 * fills the shape pool's free list and lets V8 settle its inline caches, so
 * the measured phase contains only steady-state work.
 */
function buildScene(bus: IEventBus, towers: number): IScene {
  const debris = new FakeDebrisPool(300);
  const system = new DestructionSystem({
    bus,
    debris,
    collapsingFloors: cityCollapsingFloors,
    seed: 'allocation',
  });

  for (let i = 0; i < 40; i++) {
    const { layout, attribute } = makeTower({ floors: 12, footprint: 10 });
    system.register({
      id: `warm-${String(i).padStart(4, '0')}`,
      layout,
      target: { destroyed: attribute },
      position: { x: -6000 + i * 14, y: 0, z: 0 },
    });
  }
  system.applyShockwave({ x: -6100, y: 2, z: 0 }, { x: 1, y: 0, z: 0 }, 900, 0.4, 2.5e6, 'full');
  for (let frame = 0; frame < 80; frame++) {
    system.update(1 / 60);
    debris.retire(debris.count);
  }

  for (let i = 0; i < towers; i++) {
    const { layout, attribute } = makeTower({ floors: 12, footprint: 10 });
    system.register({
      id: `tower-${String(i).padStart(4, '0')}`,
      layout,
      target: { destroyed: attribute },
      position: { x: 12 + i * 14, y: 0, z: 0 },
    });
  }
  return { system, debris, towers };
}

/** One full-charge punch down the row, then the collapse drained to nothing. */
function destroyEverything(scene: IScene): number {
  const start = scene.system.diagnostics.chunksDestroyed;
  scene.system.applyShockwave(
    { x: -60, y: 2, z: 0 },
    { x: 1, y: 0, z: 0 },
    scene.towers * 15 + 400,
    0.4,
    2.5e6,
    'full'
  );
  for (let frame = 0; frame < scene.towers * 3 + 120; frame++) {
    scene.system.update(1 / 60);
    scene.debris.retire(scene.debris.count);
  }
  return scene.system.diagnostics.chunksDestroyed - start;
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('allocation under sustained destruction', () => {
  const profiler = openProfiler();
  const gc = getGc();

  it.skipIf(profiler === undefined)('creates no object per detached chunk', async () => {
    const scene = buildScene(nullBus(), 260);
    await profiler!.start();
    const detaches = destroyEverything(scene);
    const { bytes, overhead, sites } = await profiler!.stop();
    scene.system.dispose();

    const perDetach = bytes / detaches;
    console.log(
      `[destruction] ${detaches} detaches allocated ${bytes} B — ` +
        `${perDetach.toFixed(2)} B/detach (profiler overhead ${overhead} B, excluded)`
    );
    for (const site of sites.slice(0, 5)) {
      console.log(`    ${String(site.size).padStart(7)} B  ${site.fn}  (${site.where})`);
    }

    expect(detaches).toBeGreaterThan(10_000);
    // THE THRESHOLD, AND WHY IT IS 32.
    //
    // The smallest object V8 can put on the heap is 16 bytes and a plain
    // two-field literal measures around 72. "Under 32 bytes per detach" is
    // therefore not a soft budget — it is the statement that NO OBJECT IS
    // CREATED PER DETACH AT ALL. What the profiler does attribute is V8
    // boxing doubles inside the arithmetic (`sqrt`, the cone test, the
    // velocity solve) and occasional array growth, neither of which is
    // removable from JavaScript.
    expect(perDetach).toBeLessThan(32);
  }, 180_000);

  it.skipIf(profiler === undefined)('stays under budget with the real event bus', async () => {
    // The bus builds a fresh event and copies its vectors on every emit — its
    // own documented contract, which destruction cannot opt out of. Measured
    // here rather than hidden, with a real subscriber attached so V8 cannot
    // escape-analyse the event away and flatter the number.
    const bus = createEventBus();
    let seen = 0;
    bus.on('ChunkDetached', () => {
      seen++;
    });
    const scene = buildScene(bus, 260);
    await profiler!.start();
    const detaches = destroyEverything(scene);
    const { bytes } = await profiler!.stop();
    scene.system.dispose();

    const perDetach = bytes / detaches;
    console.log(
      `[destruction] with the real EventBus and a live subscriber: ` +
        `${perDetach.toFixed(1)} B/detach across ${detaches} detaches`
    );
    expect(seen).toBeGreaterThan(10_000);
    // One event object plus two copied vectors is the bus's floor. A ceiling
    // of 400 B catches destruction starting to hand it something expensive
    // (a per-event array, a formatted string) without pretending the bus
    // itself is free.
    expect(perDetach).toBeLessThan(400);
  }, 180_000);

  it.skipIf(gc === undefined)('retains nothing per detach — the leak check', () => {
    const scene = buildScene(nullBus(), 220);
    gc!();
    gc!();
    const before = process.memoryUsage().heapUsed;
    const detaches = destroyEverything(scene);
    gc!();
    gc!();
    const retained = Math.max(0, process.memoryUsage().heapUsed - before);
    scene.system.dispose();

    console.log(
      `[destruction] retained after ${detaches} detaches: ${retained} B ` +
        `(${(retained / detaches).toFixed(2)} B/detach)`
    );
    expect(detaches).toBeGreaterThan(8_000);
    // Retention scales with buildings touched (one coalesced update range
    // each), never with chunks.
    expect(retained / detaches).toBeLessThan(16);
  }, 180_000);

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

    const original = bus.emit.bind(bus);
    bus.emit = ((type, payload) => {
      seen.add(payload as object);
      original(type, payload);
    }) as IEventBus['emit'];

    for (let i = 0; i < structure.chunkCount; i++) system.detachChunk(structure, i, 'blast');
    expect(seen.size).toBe(1);
    system.dispose();
  });

  it('never retains the collapse queue after a collapse finishes', () => {
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
    expect(system.diagnostics.pendingCollapseChunks).toBe(0);
    system.dispose();
  });
});

describe('coalesced upload ranges', () => {
  it('records ONE update range per structure per batch, not one per chunk', () => {
    const bus = createEventBus();
    const system = new DestructionSystem({
      bus,
      collapsingFloors: cityCollapsingFloors,
      seed: 'ranges',
    });
    const towers: ReturnType<typeof makeTower>[] = [];
    for (let i = 0; i < 6; i++) {
      const tower = makeTower({ floors: 12, footprint: 10 });
      towers.push(tower);
      system.register({
        id: `t-${i}`,
        layout: tower.layout,
        target: { destroyed: tower.attribute },
        position: { x: 12 + i * 14, y: 0, z: 0 },
      });
    }

    system.applyShockwave({ x: -30, y: 2, z: 0 }, { x: 1, y: 0, z: 0 }, 200, 0.35, 2.5e6, 'full');

    let touched = 0;
    for (const tower of towers) {
      const destroyedVertices = [...tower.attribute.array].filter((b) => b === 255).length;
      if (destroyedVertices === 0) continue;
      touched++;
      // One range for the whole sweep, however many chunks it took.
      expect(tower.attribute.uploads).toBe(1);
      // ...and the range really does cover every blanked vertex.
      const range = tower.attribute.updateRanges[0]!;
      for (let v = 0; v < tower.attribute.array.length; v++) {
        if (tower.attribute.array[v] === 255) {
          expect(v).toBeGreaterThanOrEqual(range.start);
          expect(v).toBeLessThan(range.start + range.count);
        }
      }
      // The attribute is flagged for upload the instant a chunk is blanked, so
      // nothing can be a frame late even if the flush were delayed.
      expect(tower.attribute.needsUpdate).toBe(true);
    }
    expect(touched).toBeGreaterThan(2);
    system.dispose();
  });
});
