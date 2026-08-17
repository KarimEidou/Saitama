/**
 * MAIN-THREAD RUNTIME
 *
 * Exercises the path a punch actually takes, headlessly: packed buffers ->
 * `BufferGeometry` -> destroy a fracture chunk -> extract the debris geometry.
 *
 * The one thing this catches that nothing else does is the NORMALISED
 * ATTRIBUTE trap. `aDestroyed` is a Uint8 uploaded normalised, so the shader
 * sees `byte / 255`. Writing 1 into it gives 0.0039, the `> 0.5` test in the
 * vertex shader fails, and destruction silently does nothing — which looks
 * exactly like "the shader hook is not wired up" and is invisible in every
 * geometry test. That is why `DESTROYED_FLAG` exists and why it is asserted
 * here rather than trusted.
 *
 * No renderer is constructed: everything under test is CPU-side.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { generateBuilding } from '../building';
import { CITY_MATERIALS } from '../materials';
import {
  DESTROYED_FLAG,
  buildBlockMesh,
  destroyFractureChunk,
  extractDebrisGeometry,
  repairBlock,
  toBufferGeometry,
} from '../runtime';
import { makeGenerator } from './fixtures';
import type { Polygon } from '../polygon';

const FOOTPRINT: Polygon = [
  [-9, -7],
  [9, -7],
  [9, 7],
  [-9, 7],
];

function makeBuilding(floors = 8) {
  return generateBuilding({
    id: 'runtime-probe',
    footprint: FOOTPRINT,
    floors,
    floorHeight: 3.3,
    groundFloorScale: 1.3,
    style: 'apartment',
    facadeMaterial: CITY_MATERIALS.wall.concretePlain,
    roofMaterial: CITY_MATERIALS.roof.bitumen,
    glassMaterial: CITY_MATERIALS.glass,
    tint: 0xd8d2c6,
    seed: 0x1234,
    detail: 'full',
    panelWeights: { window: 8, blank: 3, balcony: 2, ac_unit: 2 },
    groundWeights: { shopfront: 4, door: 2, window: 3 },
    rooftopClutter: 0.8,
    parapetHeight: 0.9,
    litWindowChance: 0.2,
    structureMaterial: 'concrete',
  });
}

describe('geometry conversion', () => {
  it('carries every attribute, the index and the material groups', () => {
    const build = makeBuilding();
    const geometry = toBufferGeometry(build.buffers);
    expect(geometry.getAttribute('position').count).toBe(build.buffers.vertexCount);
    expect(geometry.getAttribute('normal').count).toBe(build.buffers.vertexCount);
    expect(geometry.getAttribute('uv').count).toBe(build.buffers.vertexCount);
    expect(geometry.getAttribute('color').count).toBe(build.buffers.vertexCount);
    expect(geometry.getIndex()!.count).toBe(build.buffers.indexCount);
    expect(geometry.groups.length).toBe(build.buffers.groups.length);
    for (let i = 0; i < geometry.groups.length; i++) {
      expect(geometry.groups[i].start).toBe(build.buffers.groups[i].start);
      expect(geometry.groups[i].count).toBe(build.buffers.groups[i].count);
      expect(geometry.groups[i].materialIndex).toBe(i);
    }
  });

  it('uploads the destruction flag as a normalised byte attribute', () => {
    const geometry = toBufferGeometry(makeBuilding().buffers);
    const attribute = geometry.getAttribute('aDestroyed') as THREE.BufferAttribute;
    expect(attribute.itemSize).toBe(1);
    expect(attribute.normalized).toBe(true);
    expect(attribute.array).toBeInstanceOf(Uint8Array);
    expect(attribute.usage).toBe(THREE.DynamicDrawUsage);
  });

  it('uses 255 for the destroyed flag, not 1', () => {
    // A normalised Uint8 attribute reads back as byte/255 in GLSL. 1 would be
    // 0.0039 and the shader's `> 0.5` test would never fire.
    expect(DESTROYED_FLAG).toBe(255);
    expect(DESTROYED_FLAG / 255).toBeGreaterThan(0.5);
  });
});

describe('destruction', () => {
  it('flags exactly the chunk vertex range and nothing else', () => {
    const generator = makeGenerator('full');
    const chunk = generator.generate(0, 0);
    const block = chunk.blocks.find((b) => b.buildings.length > 0)!;
    const mesh = buildBlockMesh(block, () => new THREE.MeshBasicMaterial());

    const buildingId = Object.keys(block.fractures).sort()[0];
    const layout = block.fractures[buildingId];
    const target = layout.chunks[5];

    const before = mesh.destroyed.array as Uint8Array;
    expect(before.every((v) => v === 0)).toBe(true);

    const removed = destroyFractureChunk(mesh, buildingId, target.index);
    expect(removed).toBeDefined();
    expect(removed!.index).toBe(target.index);

    const after = mesh.destroyed.array as Uint8Array;
    let flagged = 0;
    for (let i = 0; i < after.length; i++) {
      if (after[i] === DESTROYED_FLAG) {
        flagged++;
        expect(i).toBeGreaterThanOrEqual(target.vertexStart);
        expect(i).toBeLessThan(target.vertexStart + target.vertexCount);
      }
    }
    expect(flagged).toBe(target.vertexCount);
    // `needsUpdate` is write-only on a BufferAttribute; the observable effect
    // is the version bump, which is what tells the renderer to re-upload.
    expect(mesh.destroyed.version).toBeGreaterThan(0);
  });

  it('repairs a block back to intact', () => {
    const generator = makeGenerator('full');
    const block = generator.generate(0, 0).blocks.find((b) => b.buildings.length > 0)!;
    const mesh = buildBlockMesh(block, () => new THREE.MeshBasicMaterial());
    const buildingId = Object.keys(block.fractures).sort()[0];
    destroyFractureChunk(mesh, buildingId, 0);
    destroyFractureChunk(mesh, buildingId, 1);
    repairBlock(mesh);
    expect((mesh.destroyed.array as Uint8Array).every((v) => v === 0)).toBe(true);
  });

  it('extracts a debris geometry whose indices are in range', () => {
    const generator = makeGenerator('full');
    const block = generator.generate(0, 0).blocks.find((b) => b.buildings.length > 0)!;
    const mesh = buildBlockMesh(block, () => new THREE.MeshBasicMaterial());
    const buildingId = Object.keys(block.fractures).sort()[0];
    const layout = block.fractures[buildingId];

    const piece = extractDebrisGeometry(mesh, buildingId, 4);
    expect(piece).toBeDefined();
    const chunk = layout.chunks[4];
    expect(piece!.mass).toBeCloseTo(chunk.mass, 5);
    expect(piece!.isGrounded).toBe(chunk.grounded);
    expect(piece!.detached).toBe(false);

    const geometry = piece!.geometry as unknown as THREE.BufferGeometry;
    const positions = geometry.getAttribute('position');
    expect(positions.count).toBe(chunk.vertexCount);
    const index = geometry.getIndex()!;
    for (let i = 0; i < index.count; i++) {
      expect(index.getX(i)).toBeGreaterThanOrEqual(0);
      expect(index.getX(i)).toBeLessThan(chunk.vertexCount);
    }
    // Local-space bounds must match the baked AABB.
    const box = geometry.boundingBox!;
    expect(box.min.y).toBeCloseTo(chunk.aabb[1], 3);
    expect(box.max.y).toBeCloseTo(chunk.aabb[4], 3);
  });

  it('returns undefined for an unknown building or chunk', () => {
    const generator = makeGenerator('full');
    const block = generator.generate(0, 0).blocks.find((b) => b.buildings.length > 0)!;
    const mesh = buildBlockMesh(block, () => new THREE.MeshBasicMaterial());
    expect(destroyFractureChunk(mesh, 'nope', 0)).toBeUndefined();
    const buildingId = Object.keys(block.fractures).sort()[0];
    expect(destroyFractureChunk(mesh, buildingId, 99999)).toBeUndefined();
  });
});

describe('block meshes', () => {
  it('binds one material per group, in slot order', () => {
    const generator = makeGenerator('full');
    const block = generator.generate(0, -4).blocks.find((b) => b.buildings.length > 0)!;
    const seen: string[] = [];
    const mesh = buildBlockMesh(block, (key) => {
      seen.push(key);
      return new THREE.MeshBasicMaterial();
    });
    expect(Array.isArray(mesh.mesh.material)).toBe(true);
    expect((mesh.mesh.material as THREE.Material[]).length).toBe(mesh.drawCalls);
    expect(mesh.drawCalls).toBeLessThanOrEqual(3);
    expect(seen[0]).toBe(block.materials.facade);
  });
});
