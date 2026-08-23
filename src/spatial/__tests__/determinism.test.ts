/**
 * DETERMINISM AND THE SPATIAL INDEX FACADE
 *
 * The whole world is generated from seeds, so anything derived from it —
 * quadtree layout, PVS masks, sampled camera sweeps — must be byte-identical
 * across runs and independent of the order work happens in. A structure that
 * is only *usually* identical produces a save file that loads into a slightly
 * different city, and bugs that reproduce on one machine and not another.
 *
 * `Math.random()` never appears in `src/spatial/`; everything seeded goes
 * through `@/util`'s mulberry32 streams.
 */

import { describe, it, expect, vi } from 'vitest';
import { SpatialIndex } from '../spatial-index';
import { Quadtree } from '../quadtree';
import { Frustum, composeViewProjection } from '../frustum';
import { IndexList } from '../index-list';
import { buildPvs, PvsTable } from '../pvs';
import { DynamicEntityGrid } from '../entity-grid';
import { generateSyntheticCity, sampleStreetCameras } from '../synthetic-city';
import { CHUNK_COUNT, CHUNK_SIZE, PVS_MASK_WORDS, chunkIndexAt } from '../constants';
import { createRng, resetLogState } from '@/util';
import { randomBoxes, randomPoses, poseMatrix, MOBILE_PORTRAIT_LENS } from './fixtures';

/** A stable fingerprint of an index list, order included. */
function fingerprint(list: IndexList): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < list.length; i++) {
    h = (Math.imul(h ^ list.at(i), 0x01000193) >>> 0) ^ i;
  }
  return `${list.length}:${(h >>> 0).toString(16)}`;
}

function buildIndexedTree(seed: string): { tree: Quadtree; digest: string } {
  const tree = new Quadtree({ initialCapacity: 4096 });
  for (const box of randomBoxes(4000, seed)) {
    tree.insert(box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ);
  }
  tree.pack();

  const frustum = new Frustum();
  const matrix = new Float64Array(16);
  const out = new IndexList(1024);
  const parts: string[] = [];
  for (const pose of randomPoses(40, `${seed}-poses`)) {
    poseMatrix(matrix, pose, MOBILE_PORTRAIT_LENS);
    frustum.setFromViewProjection(matrix);
    tree.cullFrustum(frustum, out);
    parts.push(fingerprint(out));
  }
  return { tree, digest: parts.join('|') };
}

describe('Determinism', () => {
  it('builds an identical quadtree and produces identical culls from one seed', () => {
    const a = buildIndexedTree('determinism');
    const b = buildIndexedTree('determinism');
    expect(a.digest).toBe(b.digest);
    expect(JSON.stringify(a.tree.describe())).toBe(JSON.stringify(b.tree.describe()));
  });

  it('produces a different structure from a different seed', () => {
    const a = buildIndexedTree('determinism');
    const c = buildIndexedTree('determinism-other');
    expect(a.digest).not.toBe(c.digest);
  });

  it('is insertion-order independent for the resulting query answers', () => {
    // The tree's HANDLES depend on insertion order, but the SET of instances a
    // query returns must not. Shuffle the input and compare the answers by the
    // payloads they carry rather than by handle.
    const boxes = randomBoxes(1500, 'order-independence');
    const rng = createRng('shuffle');
    const shuffled = rng.shuffle(boxes.map((box, index) => ({ box, index })));

    const forward = new Quadtree({ initialCapacity: 2048 });
    boxes.forEach((box, index) =>
      forward.insert(box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ, index)
    );
    forward.pack();

    const jumbled = new Quadtree({ initialCapacity: 2048 });
    for (const { box, index } of shuffled) {
      jumbled.insert(box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ, index);
    }
    jumbled.pack();

    const frustum = new Frustum();
    const matrix = new Float64Array(16);
    const outA = new IndexList(512);
    const outB = new IndexList(512);

    for (const pose of randomPoses(40, 'order-poses')) {
      poseMatrix(matrix, pose, MOBILE_PORTRAIT_LENS);
      frustum.setFromViewProjection(matrix);
      forward.cullFrustum(frustum, outA);
      jumbled.cullFrustum(frustum, outB);

      const setA = new Set<number>();
      for (let i = 0; i < outA.length; i++) setA.add(forward.getRef(outA.at(i)) as number);
      const setB = new Set<number>();
      for (let i = 0; i < outB.length; i++) setB.add(jumbled.getRef(outB.at(i)) as number);
      expect(setB.size).toBe(setA.size);
      for (const value of setA) expect(setB.has(value)).toBe(true);
    }
  });

  it('builds byte-identical PVS masks across runs', () => {
    const city = generateSyntheticCity({ seed: 4242 });
    const first = buildPvs(city.footprints, { rayCount: 96, originSamples: 5, seed: 7 });
    const second = buildPvs(city.footprints, { rayCount: 96, originSamples: 5, seed: 7 });
    expect(Array.from(first.masks)).toEqual(Array.from(second.masks));
    expect(first.serialize()).toEqual(second.serialize());
  });

  it('samples identical camera sweeps across runs', () => {
    const city = generateSyntheticCity({ seed: 99 });
    const a = sampleStreetCameras(city, 50);
    const b = sampleStreetCameras(city, 50);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('never calls Math.random', () => {
    // A blunt but effective guard: replace the global and exercise everything
    // seeded. Any accidental use fails loudly instead of silently making the
    // world non-reproducible.
    const original = Math.random;
    Math.random = (): number => {
      throw new Error('Math.random() is banned in src/spatial');
    };
    try {
      const city = generateSyntheticCity({ seed: 5 });
      buildPvs(city.footprints, { rayCount: 32, originSamples: 1, seed: 3 });
      sampleStreetCameras(city, 10);
      const tree = new Quadtree({ initialCapacity: 256 });
      for (const box of randomBoxes(200, 'no-random')) {
        tree.insert(box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ);
      }
      tree.pack();
      const frustum = new Frustum();
      const matrix = new Float64Array(16);
      poseMatrix(matrix, { x: 0, y: 2, z: 0, yaw: 0.4, pitch: 0 }, MOBILE_PORTRAIT_LENS);
      frustum.setFromViewProjection(matrix);
      tree.cullFrustum(frustum, new IndexList());
    } finally {
      Math.random = original;
    }
  });
});

describe('SpatialIndex facade', () => {
  const city = generateSyntheticCity({ seed: 777 });
  const pvs = buildPvs(city.footprints, { rayCount: 96, originSamples: 9, seed: 5 });

  function buildIndex(): SpatialIndex {
    const index = new SpatialIndex({
      quadtree: { initialCapacity: city.instances.length },
      pvs,
    });
    for (const instance of city.instances) {
      index.insertStatic(
        instance.minX,
        instance.minY,
        instance.minZ,
        instance.maxX,
        instance.maxY,
        instance.maxZ,
        instance
      );
    }
    index.refit();
    return index;
  }

  it('culls instances and chunks in one pass', () => {
    const index = buildIndex();
    const matrix = new Float64Array(16);
    const cameras = sampleStreetCameras(city, 40);

    let totalInstances = 0;
    let totalChunks = 0;
    for (const cam of cameras) {
      composeViewProjection(
        matrix,
        cam.x,
        cam.y,
        cam.z,
        cam.yaw,
        cam.pitch,
        (60 * Math.PI) / 180,
        900 / 1600,
        0.3,
        300
      );
      const stats = index.cullFromViewProjection(matrix, cam.x, cam.z);
      expect(index.currentChunk).toBe(chunkIndexAt(cam.x, cam.z));
      expect(stats.itemsVisible).toBe(index.visibleInstances.length);
      expect(index.visibleChunks.length).toBeLessThanOrEqual(CHUNK_COUNT);

      // Every visible instance must belong to a chunk the pass also reported,
      // or to none at all (an instance overhanging a chunk boundary).
      const chunks = new Set(index.visibleChunks.toArray());
      let orphaned = 0;
      for (let i = 0; i < index.visibleInstances.length; i++) {
        const chunk = index.quadtree.getChunk(index.visibleInstances.at(i));
        if (chunk >= 0 && !chunks.has(chunk)) orphaned++;
      }
      // The chunk list is derived from tight per-chunk bounds, so an instance
      // may legitimately survive while its chunk box does not — but it should
      // be rare, not the norm.
      expect(orphaned).toBeLessThan(Math.max(4, index.visibleInstances.length * 0.25));

      totalInstances += index.visibleInstances.length;
      totalChunks += index.visibleChunks.length;
    }
    expect(totalInstances).toBeGreaterThan(0);
    expect(totalChunks).toBeGreaterThan(0);
    console.log(
      `[facade] mean visible instances ${(totalInstances / cameras.length).toFixed(1)}, ` +
        `mean visible chunks ${(totalChunks / cameras.length).toFixed(1)} of ${CHUNK_COUNT}`
    );
  });

  it('reports coherent stats and disposes cleanly', () => {
    const index = buildIndex();
    index.entities.beginFrame();
    index.entities.add({ id: 'saitama' }, 0, 0, 0, 0.5);
    index.entities.build();

    const stats = index.getStats();
    expect(stats.staticInstances).toBe(city.instances.length);
    expect(stats.quadtreeNodes).toBe(5461);
    expect(stats.pvsBytes).toBe(8192);
    expect(stats.dynamicEntities).toBe(1);
    expect(stats.quadtreeBytes).toBeGreaterThan(0);

    index.dispose();
    expect(index.getStats().staticInstances).toBe(0);
  });

  it('hands out a stats snapshot that does not change under the caller', () => {
    // `getStats()` is documented as a snapshot and every other field in
    // `ISpatialStats` is a copied number. `lastCull` used to hand back the live
    // object `cullFrustum` rewrites in place every frame, so a debug overlay
    // that captured it and rendered a frame later showed the NEXT frame's cull
    // counters beside seven fields that were a frame old.
    const index = buildIndex();
    const matrix = new Float64Array(16);
    composeViewProjection(matrix, 0, 2, 0, 0, 0, (60 * Math.PI) / 180, 1, 0.3, 400);
    index.cullFromViewProjection(matrix, 0, 0);

    const snapshot = index.getStats().lastCull;
    const visited = snapshot.nodesVisited;
    const visible = snapshot.itemsVisible;

    composeViewProjection(matrix, 300, 40, -300, 2.1, -0.3, (60 * Math.PI) / 180, 1, 0.3, 400);
    index.cullFromViewProjection(matrix, 300, -300);

    expect(snapshot.nodesVisited).toBe(visited);
    expect(snapshot.itemsVisible).toBe(visible);
    // ...and the live field did move on.
    expect(index.cullStats).not.toBe(snapshot);
  });

  it('warns once when the quadtree cannot map onto streaming chunks', () => {
    // A non-canonical tree makes `chunkNode()` -1 for every chunk, so
    // `visibleChunks` — the documented handoff to the streaming workstream —
    // stays empty forever. The observable failure is "nothing ever streams",
    // with no error and no clue where to look.
    resetLogState();
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ok = new SpatialIndex();
      expect(ok.quadtree.canonical).toBe(true);
      expect(spy).not.toHaveBeenCalled();

      const odd = new SpatialIndex({ quadtree: { size: 512, depth: 5 } });
      expect(odd.quadtree.canonical).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
      // warnOnce: a second offender does not repeat.
      new SpatialIndex({ quadtree: { depth: 3 } });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      resetLogState();
    }
  });

  it('reports a chunk whose contents overhang it even when the PVS hides it', () => {
    // The quadtree walk refuses a PVS rejection when a chunk's contents spill
    // past its own cell, because the bit only speaks for the cell's footprint.
    // The chunk pass had no such guard, so one cull produced two disagreeing
    // outputs: instances emitted from a chunk `visibleChunks` had dropped.
    const index = new SpatialIndex({ quadtree: { initialCapacity: 8 } });
    // A prop straddling the x = 0 chunk boundary, centred just east of it.
    const overhanging = index.insertStatic(-0.25, 0, 100, 0.75, 6, 101, 'kerbside');
    // A building wholly inside its own chunk, two chunks further along.
    const contained = index.insertStatic(20, 0, 200, 30, 20, 210, 'block');

    const overhangChunk = chunkIndexAt(0.25, 100.5);
    const containedChunk = chunkIndexAt(25, 205);
    const eyeChunk = chunkIndexAt(10, 10);
    expect(new Set([overhangChunk, containedChunk, eyeChunk]).size).toBe(3);

    // A table that hides both chunks from the camera's chunk.
    const table = PvsTable.everythingVisible();
    for (const hidden of [overhangChunk, containedChunk]) {
      const word = eyeChunk * PVS_MASK_WORDS + (hidden >>> 5);
      table.masks[word] = table.masks[word]! & ~(1 << (hidden & 31));
    }
    index.setPvs(table);

    const matrix = new Float64Array(16);
    // Looking down +Z from the camera's chunk, so both boxes are ahead.
    composeViewProjection(matrix, 10, 2, 10, Math.PI, 0, (60 * Math.PI) / 180, 1, 0.3, 400);
    index.cullFromViewProjection(matrix, 10, 10);
    expect(index.currentChunk).toBe(eyeChunk);

    const instances = index.visibleInstances.toArray();
    const chunks = index.visibleChunks.toArray();
    // The prop survives the walk, so the chunk it lives in must be reported
    // too — the streaming system must not release a chunk this same pass is
    // still drawing instances from.
    expect(instances).toContain(overhanging);
    expect(chunks).toContain(overhangChunk);
    // The bit is still honoured where it speaks for the whole chunk.
    expect(contained).toBeGreaterThanOrEqual(0);
    expect(chunks).not.toContain(containedChunk);
  });

  it('keeps every chunk visible when no PVS is installed', () => {
    const index = buildIndex();
    index.setPvs(undefined);
    expect(index.isChunkPotentiallyVisible(0, 255)).toBe(true);
    index.setPvs(pvs);
    // With a table installed the answer is whatever the table says.
    expect(index.isChunkPotentiallyVisible(0, 0)).toBe(true);
  });

  it('removes static instances without disturbing the rest', () => {
    const index = buildIndex();
    const handles: number[] = [];
    for (let h = 0; h < 200; h++) if (index.quadtree.isAlive(h)) handles.push(h);
    for (const h of handles) expect(index.removeStatic(h)).toBe(true);
    index.refit();
    expect(index.quadtree.count).toBe(city.instances.length - handles.length);

    const matrix = new Float64Array(16);
    composeViewProjection(matrix, 0, 2, 0, 0, 0, (60 * Math.PI) / 180, 1, 0.3, 400);
    index.cullFromViewProjection(matrix, 0, 0);
    for (let i = 0; i < index.visibleInstances.length; i++) {
      expect(index.quadtree.isAlive(index.visibleInstances.at(i))).toBe(true);
    }
  });
});

describe('Allocation discipline', () => {
  it('reuses grid and list storage across simulated frames', () => {
    const grid = new DynamicEntityGrid(256);
    const out = new IndexList(64);
    const rng = createRng('alloc-frames');

    // Warm up so both structures reach their high-water capacity.
    for (let frame = 0; frame < 20; frame++) {
      grid.beginFrame();
      for (let i = 0; i < 240; i++) {
        grid.add(null, rng.range(-700, 700), 0, rng.range(-700, 700), 1);
      }
      grid.build();
      grid.queryRadius(0, 0, 0, CHUNK_SIZE * 4, out);
    }
    const gridCapacity = grid.stats().capacity;
    const listCapacity = out.capacity;

    for (let frame = 0; frame < 60; frame++) {
      grid.beginFrame();
      for (let i = 0; i < 240; i++) {
        grid.add(null, rng.range(-700, 700), 0, rng.range(-700, 700), 1);
      }
      grid.build();
      grid.queryRadius(0, 0, 0, CHUNK_SIZE * 4, out);
      grid.queryCone(0, 0, 0, 1, 0, 0, 30, 0.8, out);
    }

    expect(grid.stats().capacity).toBe(gridCapacity);
    expect(out.capacity).toBe(listCapacity);
  });
});
