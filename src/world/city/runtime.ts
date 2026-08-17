/**
 * MAIN-THREAD RUNTIME
 *
 * The only module in `src/world/city/` that touches Three.js. Everything
 * upstream of it produces typed arrays, which is what lets generation move to
 * a Web Worker without touching a line of the generator: the worker returns
 * buffers, this file wraps them in `BufferGeometry` and `Mesh`.
 *
 * ── HOW DESTRUCTION IS WIRED ───────────────────────────────────────────────
 * Every block mesh carries a per-vertex `aDestroyed` attribute (one byte a
 * vertex, uploaded normalised). `installDestructionHook` patches the material's
 * vertex shader to push any vertex with the flag set outside the far plane, so
 * its triangle is discarded before rasterisation.
 *
 * Destroying a fracture chunk is then:
 *
 *     destroyed.fill(1, vertexStart, vertexStart + vertexCount)
 *     attribute.addUpdateRange(vertexStart, vertexCount)
 *     attribute.needsUpdate = true
 *
 * — one memory fill and one partial buffer upload, on a range the generator
 * already computed. No geometry rebuild, no re-index, no allocation, and the
 * cost does not depend on how much of the building is already gone.
 */

import * as THREE from 'three';
import type {
  ChunkPayload,
  IAssetRegistry,
  ICityBlock,
  IChunkCoord,
  IPropPlacement,
  IRoadSegment,
  ISpawnPoint,
} from '@/types';
import type { IGeometryBuffers } from './mesh-builder';
import type { IBlockBuild } from './block';
import type { IGroundBuild } from './ground';
import type { ICityChunkBuild } from './chunk';
import type { IFractureLayout } from './fracture';
import { materialiseFractureChunk } from './fracture';
import { CHUNK_SIZE } from '@/spatial/constants';

/** Resolves a manifest material id to a live material. */
export type MaterialResolver = (key: string) => THREE.Material;

/**
 * Byte written into the `aDestroyed` attribute to remove a vertex.
 *
 * MUST be 255, not 1. The attribute is uploaded NORMALISED, so the shader sees
 * `byte / 255`; writing 1 gives 0.0039, the `> 0.5` test fails, and nothing
 * disappears — a bug that looks exactly like "destruction is not wired up" and
 * costs an afternoon to find.
 */
export const DESTROYED_FLAG = 255;

/**
 * Resolve through an `IAssetRegistry`, falling back when the asset is not yet
 * resident.
 *
 * The fallback is injected rather than built in: the city must never decide
 * what an unresolved material looks like, and it must never know a file path.
 */
export function createRegistryResolver(
  registry: IAssetRegistry,
  fallback: MaterialResolver
): MaterialResolver {
  const cache = new Map<string, THREE.Material>();
  return (key: string): THREE.Material => {
    const cached = cache.get(key);
    if (cached) return cached;
    const resolved = registry.getMaterial(key) ?? fallback(key);
    cache.set(key, resolved);
    return resolved;
  };
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* -------------------------------------------------------------------------- */

/** Wrap packed buffers in a `BufferGeometry`, groups and all. */
export function toBufferGeometry(buffers: IGeometryBuffers): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(buffers.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(buffers.normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(buffers.uvs, 2));
  geometry.setAttribute('color', new THREE.BufferAttribute(buffers.colors, 3));
  const destroyed = new THREE.BufferAttribute(buffers.destroyed, 1, true);
  destroyed.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('aDestroyed', destroyed);
  geometry.setIndex(new THREE.BufferAttribute(buffers.indices, 1));
  // Groups are emitted in slot order, so `materialIndex` is the slot index and
  // the material array can be built straight from the block's material set.
  for (let i = 0; i < buffers.groups.length; i++) {
    const g = buffers.groups[i];
    geometry.addGroup(g.start, g.count, i);
  }
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

/**
 * Patch a material so the `aDestroyed` attribute removes triangles.
 *
 * A vertex flagged destroyed is written outside the far plane, so the whole
 * triangle fails the clip test. Cheaper than an index rewrite, cheaper than
 * `discard` in the fragment shader, and it costs one attribute read per vertex
 * whether or not anything has been destroyed.
 */
export function installDestructionHook(material: THREE.Material): THREE.Material {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'attribute float aDestroyed;\nvoid main() {')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nif (aDestroyed > 0.5) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); }'
      );
  };
  material.customProgramCacheKey = () => 'city-destroy-v1';
  return material;
}

/* -------------------------------------------------------------------------- */
/* Meshes                                                                     */
/* -------------------------------------------------------------------------- */

/** A block's mesh plus the handles destruction needs. */
export interface IBlockMesh {
  readonly mesh: THREE.Mesh;
  readonly blockId: string;
  /** Live per-vertex destruction flags. */
  readonly destroyed: THREE.BufferAttribute;
  /** Per-building fracture layouts, already rebased into this geometry. */
  readonly fractures: Readonly<Record<string, IFractureLayout>>;
  /** Draw calls this mesh costs: one per material group. */
  readonly drawCalls: number;
}

/** Build the merged mesh for one block: three materials, three draw calls. */
export function buildBlockMesh(block: IBlockBuild, resolve: MaterialResolver): IBlockMesh {
  const geometry = toBufferGeometry(block.geometry.buffers);
  const slotToMaterial = [block.materials.facade, block.materials.glass, block.materials.roof];
  const materials = block.geometry.buffers.groups.map((g) => resolve(slotToMaterial[g.slot]));
  const mesh = new THREE.Mesh(geometry, materials);
  mesh.name = `block:${block.id}`;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return {
    mesh,
    blockId: block.id,
    destroyed: geometry.getAttribute('aDestroyed') as THREE.BufferAttribute,
    fractures: block.fractures,
    drawCalls: block.geometry.buffers.groups.length,
  };
}

/** Build the mesh for one chunk's ground: four materials. */
export function buildGroundMesh(ground: IGroundBuild, resolve: MaterialResolver): THREE.Mesh {
  const geometry = toBufferGeometry(ground.buffers);
  const slotToMaterial = [
    ground.materials.road,
    ground.materials.paving,
    ground.materials.lot,
    ground.materials.markings,
  ];
  const materials = ground.buffers.groups.map((g) => resolve(slotToMaterial[g.slot]));
  const mesh = new THREE.Mesh(geometry, materials);
  mesh.name = 'ground';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

/** The scene nodes for one chunk, plus the handles the game needs later. */
export interface IChunkNodes {
  readonly group: THREE.Group;
  readonly blocks: readonly IBlockMesh[];
  readonly ground?: THREE.Mesh;
  readonly instanced: readonly THREE.InstancedMesh[];
  readonly drawCalls: number;
}

/** Assemble a chunk's scene graph. Props are instanced, one draw call each. */
export function buildChunkNodes(
  build: ICityChunkBuild,
  resolve: MaterialResolver,
  resolveModel: (assetKey: string) => { geometry: THREE.BufferGeometry; material: THREE.Material } | undefined
): IChunkNodes {
  const group = new THREE.Group();
  group.name = `chunk:${build.key}`;
  const blocks: IBlockMesh[] = [];
  for (const block of build.blocks) {
    const mesh = buildBlockMesh(block, resolve);
    blocks.push(mesh);
    group.add(mesh.mesh);
  }
  let ground: THREE.Mesh | undefined;
  if (build.ground) {
    ground = buildGroundMesh(build.ground, resolve);
    group.add(ground);
  }

  const instanced: THREE.InstancedMesh[] = [];
  const matrix = new THREE.Matrix4();
  for (const batch of build.instances) {
    const model = resolveModel(batch.assetKey);
    if (!model) continue;
    const mesh = new THREE.InstancedMesh(model.geometry, model.material, batch.count);
    mesh.name = `props:${batch.assetKey}`;
    for (let i = 0; i < batch.count; i++) {
      matrix.fromArray(batch.matrices, i * 16);
      mesh.setMatrixAt(i, matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    instanced.push(mesh);
    group.add(mesh);
  }

  let drawCalls = blocks.reduce((n, b) => n + b.drawCalls, 0) + instanced.length;
  if (ground) drawCalls += build.ground?.drawCalls ?? 0;
  return { group, blocks, ground, instanced, drawCalls };
}

/* -------------------------------------------------------------------------- */
/* Destruction                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Remove one fracture chunk from a block mesh.
 *
 * O(vertices in the chunk), no allocation, and the upload is limited to the
 * touched range. Returns the chunk record so the caller can hand its mass and
 * centroid to physics.
 */
export function destroyFractureChunk(
  blockMesh: IBlockMesh,
  buildingId: string,
  chunkIndex: number
): IFractureLayout['chunks'][number] | undefined {
  const layout = blockMesh.fractures[buildingId];
  if (!layout) return undefined;
  const chunk = layout.chunks[chunkIndex];
  if (!chunk) return undefined;
  const array = blockMesh.destroyed.array as Uint8Array;
  array.fill(DESTROYED_FLAG, chunk.vertexStart, chunk.vertexStart + chunk.vertexCount);
  blockMesh.destroyed.addUpdateRange(chunk.vertexStart, chunk.vertexCount);
  blockMesh.destroyed.needsUpdate = true;
  return chunk;
}

/** Restore a block to intact, e.g. on chunk reload. */
export function repairBlock(blockMesh: IBlockMesh): void {
  (blockMesh.destroyed.array as Uint8Array).fill(0);
  blockMesh.destroyed.needsUpdate = true;
}

/**
 * Extract a detached chunk as a standalone geometry for the debris pool,
 * conforming to `FractureChunk` in `src/types/destruction.ts`.
 */
export function extractDebrisGeometry(
  blockMesh: IBlockMesh,
  buildingId: string,
  chunkIndex: number
) {
  const layout = blockMesh.fractures[buildingId];
  if (!layout) return undefined;
  const geometry = blockMesh.mesh.geometry;
  return materialiseFractureChunk(THREE as never, layout, chunkIndex, {
    positions: geometry.getAttribute('position').array as Float32Array,
    normals: geometry.getAttribute('normal').array as Float32Array,
    uvs: geometry.getAttribute('uv').array as Float32Array,
    colors: geometry.getAttribute('color').array as Float32Array,
    indices: geometry.getIndex()!.array as Uint32Array,
  });
}

/* -------------------------------------------------------------------------- */
/* Contract conversion                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Convert a generated chunk into the `ChunkPayload` shape from
 * `src/types/world.ts`, which streaming consumes.
 *
 * Runs on the MAIN THREAD, not in the worker: `ICityBlock` is specified in
 * terms of `THREE.Vector2`/`THREE.Vector3`, and class instances do not survive
 * `structuredClone` with their prototypes. The worker returns
 * `ICityChunkBuild` (typed arrays, transferable, zero copy) and this is the
 * one place those become Three objects.
 */
export function toChunkPayload(build: ICityChunkBuild, roads: readonly IRoadSegment[] = []): ChunkPayload {
  const coord: IChunkCoord = { x: build.coord.x, z: build.coord.z };
  const spawnPoints: ISpawnPoint[] = build.spawns.map((s) => ({
    position: new THREE.Vector3(s.x, s.y, s.z),
    rotationY: s.rotationY,
    kind: s.kind,
    tag: s.tag,
  }));

  const blocks: ICityBlock[] = build.blocks.map((block) => ({
    id: block.id,
    chunk: coord,
    outline: block.outline.map((p) => new THREE.Vector2(p[0], p[1])),
    bounds: {
      min: new THREE.Vector3(block.bounds[0], block.bounds[1], block.bounds[2]),
      max: new THREE.Vector3(block.bounds[3], block.bounds[4], block.bounds[5]),
    },
    buildings: block.buildings.map((b) => ({
      id: b.id,
      footprint: b.footprint.map((p) => new THREE.Vector2(p[0], p[1])),
      floors: b.floors,
      floorHeight: b.height / Math.max(1, b.floors),
      style: b.style,
      materialKey: block.materials.facade,
      roofMaterialKey: block.materials.roof,
      position: new THREE.Vector3(b.position[0], b.position[1], b.position[2]),
      rotationY: b.rotationY,
      seed: block.seed,
      destructible: true,
      integrity: b.integrity,
    })),
    roads,
    props: block.props.map(
      (p): IPropPlacement => ({
        assetKey: p.assetKey,
        position: new THREE.Vector3(p.x, p.y, p.z),
        rotationY: p.rotationY,
        scale: p.scale,
        destructible: p.destructible,
      })
    ),
    district: block.district,
    seed: block.seed,
    spawnPoints: block.spawns.map((s) => ({
      position: new THREE.Vector3(s.x, s.y, s.z),
      rotationY: s.rotationY,
      kind: s.kind,
      tag: s.tag,
    })),
  }));

  return {
    coord,
    key: build.key,
    seed: build.seed,
    blocks,
    instances: build.instances,
    spawnPoints,
    generationTimeMs: build.generationTimeMs,
    estimatedBytes: build.estimatedBytes,
  };
}

/** World-space AABB of a chunk coordinate, matching the payload bounds. */
export function chunkBounds(coord: IChunkCoord, maxHeight = 90): THREE.Box3 {
  return new THREE.Box3(
    new THREE.Vector3(coord.x * CHUNK_SIZE, -20, coord.z * CHUNK_SIZE),
    new THREE.Vector3((coord.x + 1) * CHUNK_SIZE, maxHeight, (coord.z + 1) * CHUNK_SIZE)
  );
}
