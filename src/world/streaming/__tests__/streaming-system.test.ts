/**
 * THE STREAMING SYSTEM, END TO END
 *
 * Runs the real `StreamingSystem` against a real `THREE.Scene` under Node. No
 * WebGL context is needed: everything the budget governs — building geometry,
 * wrapping transferred buffers in `BufferAttribute`s, attaching to the scene,
 * tearing down and disposing — is CPU work that happens identically with or
 * without a GPU. The browser harness then measures the same code path with a
 * live context; this file is where the LOGIC is pinned.
 *
 * The worker pool runs inline here, which is not a simulation: `handleRequest`
 * is the exact function the worker's `onmessage` calls, so a bug in generation
 * fails here rather than only in the browser.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { IChunk } from '@/types';
import { EventBus } from '@/util';
import { CHUNK_SIZE, chunkIndex } from '@/spatial/constants';
import {
  StreamingSystem,
  type IColliderSink,
  type ICrowdSink,
  type IStreamingSystemOptions,
} from '../streaming-system';
import { ChunkDamageState } from '../damage-state';
import { MAX_UPLOADS_PER_FRAME, RING_R0, RING_R1, RING_R2, UPLOAD_BUDGET_MS } from '../constants';
import type { ColliderMode, CrowdMode } from '../constants';
import type { IColliderBox, ICrowdSlot } from '../protocol';

const SEED = 0x0c17972;

/** Flush the microtask queue the inline pool delivers results on. */
async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

interface IFrameSample {
  readonly uploads: number;
  readonly uploadMs: number;
  readonly unloads: number;
}

/** Run `frames` frames, sampling the budget counters each one. */
async function advance(system: StreamingSystem, frames: number): Promise<IFrameSample[]> {
  const samples: IFrameSample[] = [];
  for (let i = 0; i < frames; i++) {
    system.update(1 / 60);
    const stats = system.getDetailedStats();
    samples.push({
      uploads: stats.uploadsLastFrame,
      uploadMs: stats.uploadMsLastFrame,
      unloads: stats.unloadsLastFrame,
    });
    await tick();
  }
  return samples;
}

/**
 * Drive frames until the system is fully quiescent.
 *
 * Quiescent means nothing left to build AND nothing left to tear down. Waiting
 * only on the build side is the mistake it is easy to make here: eviction is
 * budgeted at four chunks a frame, so after a long jump the loads finish long
 * before the unloads and a build-only wait returns to a half-torn-down world.
 */
async function settle(system: StreamingSystem, limit = 4000): Promise<number> {
  for (let i = 0; i < limit; i++) {
    system.update(1 / 60);
    await tick();
    const stats = system.getDetailedStats();
    if (
      stats.queued === 0 &&
      stats.inFlight === 0 &&
      stats.readyToUpload === 0 &&
      stats.unloadsLastFrame === 0
    ) {
      return i + 1;
    }
  }
  throw new Error('streaming system never settled');
}

class RecordingColliderSink implements IColliderSink {
  readonly byChunk = new Map<number, { mode: ColliderMode; boxes: readonly IColliderBox[] }>();
  setChunkColliders(chunk: number, mode: ColliderMode, boxes: readonly IColliderBox[]): void {
    this.byChunk.set(chunk, { mode, boxes });
  }
  clearChunkColliders(chunk: number): void {
    this.byChunk.delete(chunk);
  }
}

class RecordingCrowdSink implements ICrowdSink {
  readonly byChunk = new Map<number, { mode: CrowdMode; slots: readonly ICrowdSlot[] }>();
  setChunkCrowd(chunk: number, mode: CrowdMode, slots: readonly ICrowdSlot[]): void {
    this.byChunk.set(chunk, { mode, slots });
  }
  clearChunkCrowd(chunk: number): void {
    this.byChunk.delete(chunk);
  }
}

let active: StreamingSystem | undefined;

/** Everything a test may override. The scene and bus are supplied here. */
type TestOptions = Partial<Omit<IStreamingSystemOptions, 'scene' | 'bus'>>;

function makeSystem(options: TestOptions = {}): {
  system: StreamingSystem;
  scene: THREE.Scene;
  bus: EventBus;
} {
  const scene = new THREE.Scene();
  const bus = new EventBus();
  const system = new StreamingSystem({
    scene,
    bus,
    seed: SEED,
    inlineWorkers: true,
    buildImpostor: false,
    quality: 'high',
    ...options,
  });
  active = system;
  return { system, scene, bus };
}

afterEach(() => {
  active?.dispose();
  active = undefined;
});

describe('frame budget', () => {
  it('never exceeds the upload count cap, even from a cold start', async () => {
    const { system } = makeSystem();
    system.setView(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 0, -1));

    const samples = await advance(system, 400);
    const max = Math.max(...samples.map((s) => s.uploads));
    const total = samples.reduce((sum, s) => sum + s.uploads, 0);

    expect(max).toBeLessThanOrEqual(MAX_UPLOADS_PER_FRAME);
    // A cold start at the high tier has the whole 17x17 neighbourhood to build,
    // so the cap must actually be binding rather than incidentally satisfied.
    expect(total).toBeGreaterThan(200);
  });

  it('holds the millisecond budget through admission control', async () => {
    const { system } = makeSystem();
    system.setView(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 0, -1));
    const samples = await advance(system, 400);

    // The first upload of a frame is always admitted (an upload cannot be
    // split), so a single chunk may exceed the budget on its own. Every frame
    // that CHOSE to start a second upload was an admission-control decision,
    // and those must hold the declared cap — not four times it. A 4x tolerance
    // here is exactly the window a mispredicting admission test hides in: two
    // uploads totalling 10 ms against a 4 ms cap would never even be counted.
    for (const sample of samples) {
      if (sample.uploads > 1) expect(sample.uploadMs).toBeLessThanOrEqual(UPLOAD_BUDGET_MS);
    }
    const busted = samples.filter((s) => s.uploadMs > UPLOAD_BUDGET_MS * 4);
    for (const sample of busted) expect(sample.uploads).toBe(1);
    expect(system.getDetailedStats().peakUploadMs).toBeLessThan(50);
  });

  it('predicts admission from the chunk in hand, not from a global average', async () => {
    // A downtown R0 chunk carries ~100x the payload of a park R2 chunk, so a
    // single per-chunk average describes nothing in the queue. Feed the pass a
    // budget that only the smallest chunks fit in and it must still refuse to
    // stack a second upload behind a large one.
    const { system } = makeSystem({ uploadBudgetMs: 0.001 });
    system.setView(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 0, -1));
    const samples = await advance(system, 200);
    // Something uploaded — the first of a frame is always admitted...
    expect(samples.reduce((sum, s) => sum + s.uploads, 0)).toBeGreaterThan(50);
    // ...and nothing was ever admitted on top of it.
    expect(Math.max(...samples.map((s) => s.uploads))).toBe(1);
  });

  it('bounds teardown per frame as well as upload', async () => {
    const { system } = makeSystem({ quality: 'low' });
    system.setView(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 0, -1));
    await settle(system);

    // Jump far enough that the entire resident set is out of range at once.
    system.setView(new THREE.Vector3(700, 2, 700), new THREE.Vector3(0, 0, -1));
    const samples = await advance(system, 200);
    const maxUnloads = Math.max(...samples.map((s) => s.unloads));
    expect(maxUnloads).toBeLessThanOrEqual(4);
  });
});

describe('LOD rings', () => {
  it('assigns the documented ring populations around the focus', async () => {
    const { system } = makeSystem();
    system.setView(
      new THREE.Vector3(CHUNK_SIZE * 0.5, 2, CHUNK_SIZE * 0.5),
      new THREE.Vector3(0, 0, -1)
    );
    await settle(system);

    const stats = system.getDetailedStats();
    // Focus at a chunk centre: R0 is the 3x3 block, R1 the 9x9 shell around it,
    // R2 the 17x17 shell around that, all clipped to the 16x16 world.
    expect(stats.chunksByRing[RING_R0]).toBe(9);
    expect(stats.chunksByRing[RING_R1]).toBe(9 * 9 - 9);
    expect(stats.chunksByRing[RING_R2]).toBeGreaterThan(100);
    expect(stats.residentChunks).toBe(
      stats.chunksByRing[RING_R0]! + stats.chunksByRing[RING_R1]! + stats.chunksByRing[RING_R2]!
    );
  });

  it('gives R0 per-building colliders and R1 exactly one merged block collider', async () => {
    const colliders = new RecordingColliderSink();
    const crowd = new RecordingCrowdSink();
    const { system } = makeSystem({ colliderSink: colliders, crowdSink: crowd });
    system.setView(
      new THREE.Vector3(CHUNK_SIZE * 0.5, 2, CHUNK_SIZE * 0.5),
      new THREE.Vector3(0, 0, -1)
    );
    await settle(system);

    let r0Chunks = 0;
    let r1Chunks = 0;
    for (const [index, entry] of colliders.byChunk) {
      const chunk = system.chunkAtIndex(index)!;
      if (chunk.builtRing === RING_R0) {
        r0Chunks++;
        expect(entry.mode).toBe('per-building');
        // One box per standing building, and every box names its building.
        expect(entry.boxes.length).toBe(chunk.standingBuildings);
        for (const box of entry.boxes) expect(box.buildingIndex).toBeGreaterThanOrEqual(0);
      } else if (chunk.builtRing === RING_R1) {
        r1Chunks++;
        expect(entry.mode).toBe('merged-block');
        expect(entry.boxes.length).toBe(1);
        expect(entry.boxes[0]!.buildingIndex).toBe(-1);
      } else {
        throw new Error(`ring ${chunk.builtRing} must not publish colliders`);
      }
    }
    // Nine chunks sit in R0, but the origin block is a park with nothing to
    // collide with, and an empty parcel deliberately registers nothing at all.
    let r0WithBuildings = 0;
    for (let index = 0; index < 256; index++) {
      const chunk = system.chunkAtIndex(index);
      if (chunk?.builtRing === RING_R0 && chunk.standingBuildings > 0) r0WithBuildings++;
    }
    expect(r0Chunks).toBe(r0WithBuildings);
    expect(r0Chunks).toBeGreaterThanOrEqual(8);
    expect(r1Chunks).toBeGreaterThan(0);

    // Crowd follows the same policy: skinned near, instanced mid, nothing far.
    for (const [index, entry] of crowd.byChunk) {
      const ring = system.chunkAtIndex(index)!.builtRing;
      expect(entry.mode).toBe(ring === RING_R0 ? 'skinned' : 'instanced');
      expect(ring).toBeLessThanOrEqual(RING_R1);
    }
  });

  it('rebuilds a chunk when it crosses a ring boundary', async () => {
    const { system } = makeSystem({ quality: 'low' });
    system.setView(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 0, -1));
    await settle(system);

    const far = chunkIndex(3, 0);
    expect(system.chunkAtIndex(far)!.builtRing).toBe(RING_R1);

    // Walk east until that chunk is under the camera.
    system.setView(new THREE.Vector3(3 * CHUNK_SIZE + 48, 2, 0), new THREE.Vector3(1, 0, 0));
    await settle(system);
    expect(system.chunkAtIndex(far)!.builtRing).toBe(RING_R0);
  });
});

describe('events', () => {
  it('announces every arrival and departure on the bus', async () => {
    const { system, bus } = makeSystem({ quality: 'low' });
    const streamedIn: string[] = [];
    const streamedOut: string[] = [];
    bus.on('ChunkStreamedIn', (event) => streamedIn.push(event.key));
    bus.on('ChunkStreamedOut', (event) => streamedOut.push(event.key));

    system.setView(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 0, -1));
    await settle(system);
    expect(streamedIn.length).toBeGreaterThan(50);
    expect(streamedOut.length).toBe(0);

    system.setView(new THREE.Vector3(700, 2, 700), new THREE.Vector3(1, 0, 1));
    await settle(system);
    expect(streamedOut.length).toBeGreaterThan(50);
    // Every departure names a chunk that had previously arrived.
    for (const key of streamedOut) expect(streamedIn).toContain(key);
  });
});

describe('priority order', () => {
  it('streams in what the camera faces before what is behind it', async () => {
    const { system, bus } = makeSystem({ quality: 'low' });
    const order: number[] = [];
    bus.on('ChunkStreamedIn', (event) => {
      order.push(chunkIndex(event.coord.x, event.coord.z));
    });

    // Standing at the world centre looking north (-Z).
    system.setView(new THREE.Vector3(48, 2, 48), new THREE.Vector3(0, 0, -1));
    await settle(system);

    const rank = new Map<number, number>();
    order.forEach((index, at) => rank.set(index, at));

    // Compare the two halves of the R1/R2 shell: the chunks four rings ahead
    // against the chunks four rings behind, at identical true distance.
    const ahead: number[] = [];
    const behind: number[] = [];
    for (let dx = -2; dx <= 2; dx++) {
      const front = rank.get(chunkIndex(dx, -4));
      const back = rank.get(chunkIndex(dx, 4));
      if (front !== undefined) ahead.push(front);
      if (back !== undefined) behind.push(back);
    }
    expect(ahead.length).toBeGreaterThan(0);
    expect(behind.length).toBeGreaterThan(0);

    const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
    expect(mean(ahead)).toBeLessThan(mean(behind));
    // And the very worst chunk in front still beats the best chunk behind.
    expect(Math.max(...ahead)).toBeLessThan(Math.min(...behind));
  });
});

describe('damage persistence', () => {
  it('keeps destroyed pieces destroyed across an unload and a reload', async () => {
    const damage = new ChunkDamageState();
    const { system } = makeSystem({ quality: 'low', damage });
    // Chunk (-1, 0): a nine-tower downtown block, one chunk west of the origin.
    const target = chunkIndex(-1, 0);

    system.setView(new THREE.Vector3(-48, 2, 48), new THREE.Vector3(0, 0, -1));
    await settle(system);

    const before = system.chunkAtIndex(target)!;
    expect(before.builtRing).toBe(RING_R0);
    const pristineBuildings = before.standingBuildings;
    const pristineHash = before.contentHash;
    expect(pristineBuildings).toBeGreaterThan(0);

    // Level two buildings, then let the live rebuild happen.
    expect(system.destroyBuilding(target, 0)).toBe(16);
    expect(system.destroyBuilding(target, 1)).toBe(16);
    await settle(system);

    const damaged = system.chunkAtIndex(target)!;
    expect(damaged.standingBuildings).toBe(pristineBuildings - 2);
    expect(damaged.destroyedPieces).toBe(32);
    const damagedHash = damaged.contentHash;
    expect(damagedHash).not.toBe(pristineHash);

    // Walk away far enough for the chunk to be evicted entirely.
    system.setView(new THREE.Vector3(700, 2, 700), new THREE.Vector3(1, 0, 1));
    await settle(system);
    expect(system.chunkAtIndex(target)).toBeUndefined();

    // Walk back. The chunk is regenerated from the seed plus the damage bits.
    system.setView(new THREE.Vector3(-48, 2, 48), new THREE.Vector3(0, 0, -1));
    await settle(system);

    const reloaded = system.chunkAtIndex(target)!;
    expect(reloaded.builtRing).toBe(RING_R0);
    expect(reloaded.standingBuildings).toBe(pristineBuildings - 2);
    expect(reloaded.destroyedPieces).toBe(32);
    // Byte-identical to the damaged build: reload is not an approximation.
    expect(reloaded.contentHash).toBe(damagedHash);
  });

  it('survives a save/load round trip of the bitmask', async () => {
    const damage = new ChunkDamageState();
    damage.destroyBuilding(chunkIndex(-1, 0), 0);
    const snapshot = damage.serialize();

    const restored = ChunkDamageState.deserialize(snapshot);
    const { system } = makeSystem({ quality: 'low', damage: restored });
    system.setView(new THREE.Vector3(-48, 2, 48), new THREE.Vector3(0, 0, -1));
    await settle(system);

    const chunk = system.chunkAtIndex(chunkIndex(-1, 0))!;
    expect(chunk.destroyedPieces).toBe(16);
  });
});

describe('explicit requests', () => {
  it('loads a chunk beyond the resident radius and holds it until it uploads', async () => {
    const { system } = makeSystem({ quality: 'low' });
    system.setView(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 0, -1));
    await settle(system);

    // 7.5 chunk units from the focus, against a resident radius of 4.5: the
    // assignment pass wants this chunk evicted, which is what a fast-travel
    // destination always looks like. Without a pin it was torn down on the very
    // next frame and the caller's promise resolved on a disposed chunk.
    const coord = { x: 7, z: 7 };
    const index = chunkIndex(coord.x, coord.z);
    let landed: IChunk | undefined;
    const pending = system.requestChunk(coord).then((chunk) => {
      landed = chunk;
    });

    for (let i = 0; i < 300 && landed === undefined; i++) {
      system.update(1 / 60);
      await tick();
    }
    await pending;

    expect(landed).toBeDefined();
    expect(landed!.state).toBe('active');
    expect(landed!.memoryBytes).toBeGreaterThan(0);
    expect(system.chunkAtIndex(index)!.builtRing).toBe(RING_R2);
  });

  it('honours the priority the caller asked for instead of a distance score', async () => {
    const { system, bus } = makeSystem({ quality: 'low' });
    const order: number[] = [];
    bus.on('ChunkStreamedIn', (event) => order.push(chunkIndex(event.coord.x, event.coord.z)));
    system.setView(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 0, -1));

    // Requested on the cold start, when ~80 nearer chunks are already queued.
    // The queue is re-scored before every dispatch, so a score written once at
    // enqueue time is gone before anything acts on it.
    const coord = { x: 4, z: 4 };
    void system.requestChunk(coord).catch(() => undefined);
    await settle(system);

    expect(order.indexOf(chunkIndex(coord.x, coord.z))).toBe(0);
  });

  it('rejects a request whose chunk is dropped before the build lands', async () => {
    const { system } = makeSystem({ quality: 'low' });
    system.setView(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 0, -1));

    const coord = { x: 5, z: 5 };
    const pending = system.requestChunk(coord);
    system.evictChunk(coord);

    // Resolving here handed the caller a chunk with no mesh, no colliders and
    // no crowd, with no way to tell that anything had gone wrong.
    await expect(pending).rejects.toThrow(/unloaded/);
  });
});

describe('build failures', () => {
  it('does not wedge the world when every build fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // The documented generator seam, pointed at an id nobody registered:
      // every job comes back `{kind:'error'}`.
      const { system } = makeSystem({ quality: 'low', generator: 'no-such-generator' });
      system.setView(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 0, -1));
      await advance(system, 120);

      const chunk = system.chunkAtIndex(chunkIndex(0, 0))!;
      // Not 'loading' forever: the failure reaches the chunk that owns the job.
      expect(chunk.state).toBe('error');
      expect(chunk.error).toBeDefined();
      expect(chunk.jobId).toBe(-1);
      expect(errors).toHaveBeenCalled();

      // And it stops after a bounded number of attempts rather than re-queuing
      // the whole world every frame for the rest of the session.
      const stats = system.getDetailedStats();
      expect(stats.queued).toBe(0);
      expect(stats.inFlight).toBe(0);
      expect(stats.activeChunks).toBe(0);
      // `waitForIdle` may now honestly report that there is nothing left to do.
      await expect(system.waitForIdle()).resolves.toBeUndefined();
    } finally {
      errors.mockRestore();
    }
  });

  it('settles an outstanding load() with the failure instead of hanging', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { system } = makeSystem({ quality: 'low', generator: 'no-such-generator' });
      system.setView(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 0, -1));
      const pending = system.requestChunk({ x: 0, z: 0 });
      const settled = pending.then(
        () => 'resolved',
        () => 'rejected'
      );
      await advance(system, 20);
      await expect(settled).resolves.toBe('rejected');
    } finally {
      errors.mockRestore();
    }
  });
});

describe('stats', () => {
  it('reports activeChunks as chunks in the scene, in both snapshots', async () => {
    const { system, scene } = makeSystem({ quality: 'low' });
    const impostorChildren = scene.children.length;
    system.setView(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 0, -1));

    // Frame one creates the whole neighbourhood and attaches none of it yet.
    // Reporting every resident chunk here told a HUD or a harness gated on
    // `activeChunks > 0` that the world was up while the scene was empty.
    system.update(1 / 60);
    expect(system.getStats().activeChunks).toBe(scene.children.length - impostorChildren);
    expect(system.getDetailedStats().residentChunks).toBeGreaterThan(
      system.getStats().activeChunks
    );

    await settle(system);
    const stats = system.getDetailedStats();
    expect(stats.activeChunks).toBe(scene.children.length - impostorChildren);
    expect(stats.activeChunks).toBeGreaterThan(0);
    // And `getDetailedStats` must not redefine an inherited field.
    expect(system.getStats().activeChunks).toBe(stats.activeChunks);
  });

  it('publishes a resident radius that follows the quality tier', () => {
    const { system } = makeSystem({ quality: 'high' });
    expect(system.config.streamingRadiusChunks).toBe(8.5);

    system.applyQuality('low');
    // Stale here meant every consumer sizing a working set, a debug overlay or
    // a spawn radius from `config` over-read by 90% after a thermal downgrade.
    expect(system.config.streamingRadiusChunks).toBe(4.5);
    expect(system.config.evictionRadiusChunks).toBeGreaterThan(system.config.streamingRadiusChunks);
    expect(system.getDetailedStats().residentRadiusChunks).toBe(
      system.config.streamingRadiusChunks
    );
  });
});

describe('teardown', () => {
  it('leaves nothing in the scene and nothing accounted after a full lap', async () => {
    const { system, scene } = makeSystem({ quality: 'low' });
    const impostorChildren = scene.children.length;

    // Three laps of the same 1500 m traverse, exactly like the browser harness.
    for (let lap = 0; lap < 3; lap++) {
      for (let step = 0; step <= 10; step++) {
        const t = step / 10;
        system.setView(
          new THREE.Vector3(-750 + t * 1500, 2, -300 + t * 600),
          new THREE.Vector3(1, 0, 0.4)
        );
        await advance(system, 40);
      }
    }
    await settle(system);

    const stats = system.getDetailedStats();
    expect(stats.residentChunks).toBeGreaterThan(0);
    expect(stats.residentChunks).toBe(scene.children.length - impostorChildren);
    // Bytes accounted must match the bytes actually held by resident chunks.
    let held = 0;
    for (const chunk of system.loadedChunks.values()) held += chunk.memoryBytes;
    expect(stats.totalMemoryBytes).toBe(held);

    system.dispose();
    active = undefined;
    expect(scene.children.length).toBe(0);
    expect(system.loadedChunks.size).toBe(0);
  });
});
