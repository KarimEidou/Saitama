/**
 * WORKER PROTOCOL — WHAT CROSSES THE THREAD BOUNDARY
 *
 * Every message here is designed around one constraint: the main thread must do
 * nothing but hand buffers to the GPU. Anything that can be computed off-thread
 * is computed off-thread, and anything that crosses is a TRANSFERABLE
 * `ArrayBuffer` so the crossing itself is a pointer move rather than a copy.
 *
 * ── WHY NOT `ChunkPayload` FROM `@/types/world` ────────────────────────────
 * `ChunkPayload` is the CITY GENERATOR's contract and is the right shape for
 * describing a chunk's content: blocks, building specs, spawn points. It is not
 * usable verbatim as a worker message, because `ICityBlock` and `IBuildingSpec`
 * hold `THREE.Vector2`/`THREE.Vector3` instances, and structured clone
 * reconstructs those as plain objects — the class identity, and every method on
 * it, is lost in transit. Rebuilding the vectors on arrival would put exactly
 * the per-chunk allocation cost back on the main thread that this system exists
 * to remove.
 *
 * So the wire format is raw interleaved-free attribute buffers plus a small
 * plain-object descriptor, and `ChunkPayload`-shaped data is reconstructed on
 * the main thread only for the consumers that ask for it.
 *
 * ── GENERATOR SEAM ─────────────────────────────────────────────────────────
 * `IChunkJob.generator` names the generator by id rather than passing a
 * function (functions do not survive structured clone). The city-generation
 * workstream plugs in by registering its generator under a new id inside the
 * worker module; nothing on the main thread changes.
 */

import type { CrowdMode } from './constants';

/* -------------------------------------------------------------------------- */
/* Job                                                                        */
/* -------------------------------------------------------------------------- */

/** Request to build one chunk at one LOD ring. */
export interface IChunkJob {
  /** Monotonic id; results carry it back so stale results can be dropped. */
  readonly id: number;
  /** Generator id. See the generator seam note above. */
  readonly generator: string;
  /** Dense chunk index 0..255. */
  readonly chunk: number;
  /** Signed chunk coordinate. */
  readonly cx: number;
  readonly cz: number;
  /** Master world seed. */
  readonly seed: number;
  /** LOD ring 0..2. R3 is the impostor and is never a per-chunk job. */
  readonly ring: number;
  /**
   * Persistent damage bitmask for this chunk, or `undefined` when pristine.
   * Transferred, so the sender must pass a COPY (`ChunkDamageState.cloneMask`).
   */
  readonly damage?: Uint32Array;
}

/** Request to bake the single merged impostor mesh for the whole world. */
export interface IImpostorJob {
  readonly id: number;
  readonly generator: string;
  readonly seed: number;
  /** Marker discriminating this from `IChunkJob` on the worker side. */
  readonly kind: 'impostor';
}

/** Anything the pool can send to a worker. */
export type WorkerRequest =
  | ({ readonly kind: 'chunk' } & IChunkJob)
  | IImpostorJob
  | { readonly kind: 'ping'; readonly id: number };

/* -------------------------------------------------------------------------- */
/* Geometry buffers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * One draw batch's attribute buffers, all transferable.
 *
 * Positions and normals are `Float32Array`; colours are normalised `Uint8` (a
 * city is vertex-coloured concrete, and 8 bits per channel is more than the
 * palette needs while costing a quarter of the bandwidth). Indices are `Uint32`
 * unconditionally rather than adaptively `Uint16`, because a per-chunk branch
 * on index width would force the main thread to inspect the buffer before
 * uploading it, and inspection is exactly the work being avoided.
 */
export interface IGeometryBuffers {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly colors: Uint8Array;
  readonly indices: Uint32Array;
  /** Vertex count. `positions.length === vertexCount * 3`. */
  readonly vertexCount: number;
  /** Index count. `indices.length === indexCount`. */
  readonly indexCount: number;
  /** Precomputed bounding sphere so the main thread never walks the vertices. */
  readonly boundingSphere: readonly [number, number, number, number];
}

/** A box collider descriptor, in world space. Consumed by the physics sink. */
export interface IColliderBox {
  readonly centerX: number;
  readonly centerY: number;
  readonly centerZ: number;
  readonly halfX: number;
  readonly halfY: number;
  readonly halfZ: number;
  /** Building index within the chunk, or -1 for a merged block collider. */
  readonly buildingIndex: number;
}

/** A spawn slot the crowd system may populate. */
export interface ICrowdSlot {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rotationY: number;
}

/** Result of building one chunk at one ring. */
export interface IChunkBuildResult {
  readonly kind: 'chunk';
  readonly id: number;
  readonly chunk: number;
  readonly ring: number;
  readonly seed: number;
  readonly buffers: IGeometryBuffers;
  /** World AABB of the built content. */
  readonly bounds: readonly [number, number, number, number, number, number];
  /** Static colliders for this ring. Empty for R2/R3. */
  readonly colliders: readonly IColliderBox[];
  /** Crowd slots for this ring. Empty when `crowdMode === 'none'`. */
  readonly crowd: readonly ICrowdSlot[];
  readonly crowdMode: CrowdMode;
  /** Buildings still standing after the damage mask was applied. */
  readonly standingBuildings: number;
  /** Fracture pieces suppressed by the damage mask. */
  readonly destroyedPieces: number;
  /** Milliseconds the WORKER spent generating. Never on the main thread. */
  readonly generationTimeMs: number;
  /** Bytes the attribute buffers occupy. */
  readonly bytes: number;
  /**
   * Order-independent hash of the emitted geometry. Two runs with the same seed
   * must produce the same value — this is how determinism is asserted without
   * shipping golden buffers.
   */
  readonly contentHash: number;
}

/** Result of baking the world impostor ring. */
export interface IImpostorBuildResult {
  readonly kind: 'impostor';
  readonly id: number;
  readonly seed: number;
  readonly buffers: IGeometryBuffers;
  /**
   * Per-vertex source chunk index, used by the residency test in the vertex
   * shader. `0xffff` marks geometry that is never suppressed (the ground).
   */
  readonly chunkIds: Uint16Array;
  readonly buildingCount: number;
  readonly generationTimeMs: number;
  readonly bytes: number;
  readonly contentHash: number;
}

/** Anything a worker can send back. */
export type WorkerResponse =
  | IChunkBuildResult
  | IImpostorBuildResult
  | { readonly kind: 'pong'; readonly id: number }
  | { readonly kind: 'error'; readonly id: number; readonly message: string };

/* -------------------------------------------------------------------------- */
/* Transfer helpers                                                           */
/* -------------------------------------------------------------------------- */

/** The backing buffers of a geometry result, for the `postMessage` transfer list. */
export function geometryTransferables(buffers: IGeometryBuffers): ArrayBuffer[] {
  return [
    buffers.positions.buffer as ArrayBuffer,
    buffers.normals.buffer as ArrayBuffer,
    buffers.colors.buffer as ArrayBuffer,
    buffers.indices.buffer as ArrayBuffer,
  ];
}

/** Byte size of a geometry payload, for the streaming memory budget. */
export function geometryBytes(buffers: IGeometryBuffers): number {
  return (
    buffers.positions.byteLength +
    buffers.normals.byteLength +
    buffers.colors.byteLength +
    buffers.indices.byteLength
  );
}
