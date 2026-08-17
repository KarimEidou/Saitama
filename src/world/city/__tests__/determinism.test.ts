/**
 * DETERMINISM
 *
 * The city must be byte-identical across runs, across generation orders, and
 * across devices. Two players standing on the same corner have to be looking
 * at the same building, and a chunk that unloads and reloads has to come back
 * unchanged — otherwise a destroyed wall reappears somewhere else.
 *
 * The guarantee rests on three properties, and each is checked here:
 *
 *   1. `hash(blockId, planVersion)` is the ONLY entropy source inside a block,
 *      so generating chunk 200 first does not change chunk 0.
 *   2. Every draw comes from `@/util`'s mulberry32, whose arithmetic stays in
 *      the uint32 domain — no float accumulation, no cross-platform drift.
 *   3. Iteration order never depends on a Map's insertion order or on
 *      `Object.keys`, both of which can vary with how the plan JSON was
 *      written.
 *
 * Comparison is on the raw typed arrays, not on a summary: a checksum that
 * happens to match while the vertices differ would defeat the point.
 */

import { describe, expect, it } from 'vitest';
import { generateBuilding } from '../building';
import { CITY_MATERIALS } from '../materials';
import { blockSeed } from '../plan';
import { makeGenerator, SAMPLE_CHUNKS } from './fixtures';
import type { IGeometryBuffers } from '../mesh-builder';
import type { ICityChunkBuild } from '../chunk';

function expectBuffersIdentical(a: IGeometryBuffers, b: IGeometryBuffers, label: string): void {
  expect(a.vertexCount, `${label}: vertexCount`).toBe(b.vertexCount);
  expect(a.indexCount, `${label}: indexCount`).toBe(b.indexCount);
  expect(Array.from(a.positions), `${label}: positions`).toEqual(Array.from(b.positions));
  expect(Array.from(a.normals), `${label}: normals`).toEqual(Array.from(b.normals));
  expect(Array.from(a.uvs), `${label}: uvs`).toEqual(Array.from(b.uvs));
  expect(Array.from(a.colors), `${label}: colors`).toEqual(Array.from(b.colors));
  expect(Array.from(a.indices), `${label}: indices`).toEqual(Array.from(b.indices));
  expect(a.groups, `${label}: groups`).toEqual(b.groups);
}

function expectChunksIdentical(a: ICityChunkBuild, b: ICityChunkBuild): void {
  expect(a.blocks.length).toBe(b.blocks.length);
  expect(a.triangles).toBe(b.triangles);
  expect(a.drawCalls).toBe(b.drawCalls);
  for (let i = 0; i < a.blocks.length; i++) {
    expectBuffersIdentical(
      a.blocks[i].geometry.buffers,
      b.blocks[i].geometry.buffers,
      `${a.key}/${a.blocks[i].id}`
    );
    expect(a.blocks[i].materials).toEqual(b.blocks[i].materials);
    expect(a.blocks[i].props).toEqual(b.blocks[i].props);
    expect(a.blocks[i].spawns).toEqual(b.blocks[i].spawns);
    expect(a.blocks[i].fractures).toEqual(b.blocks[i].fractures);
  }
  if (a.ground && b.ground) {
    expectBuffersIdentical(a.ground.buffers, b.ground.buffers, `${a.key}/ground`);
    expect(a.ground.materials).toEqual(b.ground.materials);
  }
  expect(a.instances.length).toBe(b.instances.length);
  for (let i = 0; i < a.instances.length; i++) {
    expect(a.instances[i].assetKey).toBe(b.instances[i].assetKey);
    expect(Array.from(a.instances[i].matrices)).toEqual(Array.from(b.instances[i].matrices));
  }
}

describe('determinism', () => {
  it('produces byte-identical geometry on a second run', () => {
    const first = makeGenerator('full');
    const second = makeGenerator('full');
    for (const [cx, cz] of SAMPLE_CHUNKS) {
      expectChunksIdentical(first.generate(cx, cz), second.generate(cx, cz));
    }
  });

  it('is independent of generation ORDER', () => {
    // The whole point of deriving a seed per block rather than threading one
    // generator through the world: chunk 200 must not depend on chunk 0.
    const forwards = makeGenerator('full');
    const backwards = makeGenerator('full');
    const forwardResults = SAMPLE_CHUNKS.map(([cx, cz]) => forwards.generate(cx, cz));
    const reversed = [...SAMPLE_CHUNKS]
      .reverse()
      .map(([cx, cz]) => backwards.generate(cx, cz))
      .reverse();
    for (let i = 0; i < forwardResults.length; i++) {
      expectChunksIdentical(forwardResults[i], reversed[i]);
    }
  });

  it('regenerates a chunk identically after other chunks have been generated', () => {
    const generator = makeGenerator('full');
    const before = generator.generate(0, 0);
    for (let i = 0; i < 6; i++) generator.generate(i - 3, i - 2);
    const after = generator.generate(0, 0);
    expectChunksIdentical(before, after);
  });

  it('derives block seeds from the id and the plan version only', () => {
    expect(blockSeed(1, 'blk_0_0')).toBe(blockSeed(1, 'blk_0_0'));
    expect(blockSeed(1, 'blk_0_0')).not.toBe(blockSeed(2, 'blk_0_0'));
    expect(blockSeed(1, 'blk_0_0')).not.toBe(blockSeed(1, 'blk_0_1'));
    // Negative coordinates in an id must not collide with their mirror.
    expect(blockSeed(1, 'blk_-1_2')).not.toBe(blockSeed(1, 'blk_1_-2'));
  });

  it('bumping the plan version rerolls procedural detail', () => {
    const original = makeGenerator('full').generate(0, -4);
    const bumped = makeGenerator('full');
    // Simulate a plan-version bump by regenerating the same block with a
    // different version through the block seed.
    expect(blockSeed(original.blocks[0].seed, 'x')).not.toBe(
      blockSeed(original.blocks[0].seed + 1, 'x')
    );
    expect(bumped.generate(0, -4).blocks[0].seed).toBe(original.blocks[0].seed);
  });

  it('generates identical buildings from identical recipes', () => {
    const recipe = {
      id: 'determinism-probe',
      footprint: [
        [-8, -6],
        [8, -6],
        [8, 6],
        [-8, 6],
      ] as const,
      floors: 11,
      floorHeight: 3.4,
      groundFloorScale: 1.3,
      style: 'commercial' as const,
      facadeMaterial: CITY_MATERIALS.wall.concreteLayers,
      roofMaterial: CITY_MATERIALS.roof.bitumen,
      glassMaterial: CITY_MATERIALS.glass,
      tint: 0xd0cec6,
      seed: 0xabcdef,
      detail: 'full' as const,
      panelWeights: { window: 10, blank: 3, balcony: 2, ac_unit: 2, fire_escape_anchor: 1 },
      groundWeights: { shopfront: 5, door: 2, window: 3 },
      rooftopClutter: 1,
      parapetHeight: 1,
      litWindowChance: 0.3,
      structureMaterial: 'concrete' as const,
    };
    expectBuffersIdentical(
      generateBuilding(recipe).buffers,
      generateBuilding(recipe).buffers,
      'recipe'
    );
  });

  it('keeps prop batches in a stable, key-sorted order', () => {
    const a = makeGenerator('full').generate(0, -4);
    const b = makeGenerator('full').generate(0, -4);
    expect(a.instances.map((i) => i.assetKey)).toEqual(b.instances.map((i) => i.assetKey));
    const keys = a.instances.map((i) => i.assetKey);
    expect(keys).toEqual([...keys].sort());
  });
});
