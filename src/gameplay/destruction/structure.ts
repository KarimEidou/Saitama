/**
 * A REGISTERED DESTRUCTIBLE STRUCTURE
 *
 * All the per-building state destruction owns, in flat typed arrays:
 *
 *   destroyed[]      one byte per fracture chunk. The authoritative record of
 *                    what has come off, and what a stream-out / stream-in
 *                    round trip is restored from.
 *   floorSupport[]   running sum of the surviving `supportShare` on each
 *                    storey. Maintained incrementally on detach, so the
 *                    "has this floor lost 60% of its supports" question is a
 *                    float compare rather than a loop over the building.
 *   collapsed[]      floors already handed to the collapse scheduler, so a
 *                    cascade is queued once and not re-queued by every chunk
 *                    that falls out of it.
 *
 * Nothing here allocates after construction. A detach touches three array
 * slots and one `Uint8Array.fill`.
 */

import * as THREE from 'three';
import { hashString } from '@/util';
import type { IStructureLayout, IStructureSpec } from './ports';
import { DEFAULT_COLLATERAL_PER_KG, DESTROYED_FLAG } from './constants';
import { localAabbToWorld, localToWorld } from './geometry';

/** Why a chunk came off. Drives the impulse profile and the audio class. */
export type DetachCause = 'blast' | 'collapse' | 'external' | 'restore';

export class RegisteredStructure {
  readonly id: string;
  readonly layout: IStructureLayout;
  readonly spec: IStructureSpec;
  readonly chunkCount: number;
  readonly floorCount: number;
  readonly collateralPerKg: number;

  /** Streaming chunk index, or -1 when this structure is not persisted. */
  readonly damageChunk: number;
  readonly damageBuilding: number;

  /**
   * Stable hash of the id, seeding this structure's detach jitter.
   *
   * Derived from the id rather than from a counter so the jitter does not
   * depend on how many buildings happened to be registered first — the same
   * building shatters the same way whichever direction the player approached
   * the block from.
   */
  readonly seedHash: number;

  /** One byte per fracture chunk: 0 intact, 1 destroyed. */
  readonly destroyed: Uint8Array;
  /** Surviving support share per storey, 0..1. */
  readonly floorSupport: Float64Array;
  /** 1 once the storey has been queued for collapse. */
  readonly collapsed: Uint8Array;

  /** World transform of the structure's local space. */
  readonly matrix = new THREE.Matrix4();
  readonly originX: number;
  readonly originY: number;
  readonly originZ: number;
  readonly cosY: number;
  readonly sinY: number;

  /** World AABB of the whole structure, for the broad-phase reject. */
  readonly worldBounds = new Float64Array(6);

  destroyedCount = 0;
  destroyedMassKg = 0;

  /**
   * Union of the vertex ranges blanked since the last upload flush.
   *
   * ── WHY COALESCE ───────────────────────────────────────────────────────
   * `THREE.BufferAttribute.addUpdateRange` pushes a `{start, count}` object
   * per call — three's own allocation, unavoidable from outside — and the
   * renderer issues one `bufferSubData` per recorded range. Calling it per
   * detached chunk therefore costs 48 objects and 48 GL calls to collapse one
   * building, for ranges that are adjacent anyway.
   *
   * Accumulating the union and emitting ONE range per structure per batch
   * costs one object and one contiguous upload. It is both less garbage and
   * fewer driver round trips, and it cannot be stale: `needsUpdate` is set the
   * instant a chunk is blanked, and the flush happens synchronously at the end
   * of the batch, never deferred to the next frame.
   */
  private dirtyMin = 0;
  private dirtyMax = -1;
  /** True while this structure is sitting in the system's flush list. */
  uploadPending = false;

  /** Stable predicate handed to `collapsingFloors`; allocated once, not per call. */
  readonly isChunkDestroyed: (chunkIndex: number) => boolean;

  constructor(spec: IStructureSpec) {
    this.spec = spec;
    this.id = spec.id;
    this.layout = spec.layout;
    this.chunkCount = spec.layout.chunks.length;
    this.floorCount = spec.layout.floors.length;
    this.collateralPerKg = spec.collateralPerKg ?? DEFAULT_COLLATERAL_PER_KG;
    this.damageChunk = spec.chunkIndex ?? -1;
    this.damageBuilding = spec.buildingIndex ?? 0;
    this.seedHash = hashString(spec.id);

    this.destroyed = new Uint8Array(this.chunkCount);
    this.floorSupport = new Float64Array(this.floorCount);
    this.collapsed = new Uint8Array(this.floorCount);
    for (let f = 0; f < this.floorCount; f++) {
      const floor = spec.layout.floors[f]!;
      let total = 0;
      for (const index of floor.chunks) {
        const chunk = spec.layout.chunks[index];
        if (chunk !== undefined) total += chunk.supportShare;
      }
      this.floorSupport[f] = total;
    }

    this.originX = spec.position.x;
    this.originY = spec.position.y;
    this.originZ = spec.position.z;
    const yaw = spec.rotationY ?? 0;
    this.cosY = Math.cos(yaw);
    this.sinY = Math.sin(yaw);
    this.matrix.makeRotationY(yaw);
    this.matrix.setPosition(this.originX, this.originY, this.originZ);

    this.isChunkDestroyed = (chunkIndex: number): boolean => this.destroyed[chunkIndex] === 1;

    this.computeWorldBounds();
  }

  /** True once every chunk has come off. */
  get isLevelled(): boolean {
    return this.destroyedCount >= this.chunkCount;
  }

  /* ------------------------------------------------------------------ */
  /* Queries                                                            */
  /* ------------------------------------------------------------------ */

  /** World-space AABB of one fracture chunk, written into `out` (6 numbers). */
  chunkWorldBounds(chunkIndex: number, out: Float64Array): boolean {
    const chunk = this.layout.chunks[chunkIndex];
    if (chunk === undefined) return false;
    localAabbToWorld(
      out,
      chunk.aabb,
      this.originX,
      this.originY,
      this.originZ,
      this.cosY,
      this.sinY
    );
    return true;
  }

  /** World-space centroid of one fracture chunk, written into `out` (3 numbers). */
  chunkWorldCentroid(chunkIndex: number, out: Float64Array): boolean {
    const chunk = this.layout.chunks[chunkIndex];
    if (chunk === undefined) return false;
    localToWorld(
      out,
      chunk.centroid[0],
      chunk.centroid[1],
      chunk.centroid[2],
      this.originX,
      this.originY,
      this.originZ,
      this.cosY,
      this.sinY
    );
    return true;
  }

  /** Surviving support on a storey, 0..1, maintained incrementally. */
  supportOn(floor: number): number {
    return this.floorSupport[floor] ?? 1;
  }

  /* ------------------------------------------------------------------ */
  /* Mutation                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Mark one chunk destroyed and blank its vertices.
   *
   * Returns false when the chunk was already gone, which makes every detach
   * path idempotent — that is what lets the system safely consume the same
   * `ChunkDetached` event it emitted without a re-entrancy dance.
   *
   * `DESTROYED_FLAG` is 255 and not 1. See `constants.ts`.
   */
  markDestroyed(chunkIndex: number): boolean {
    const chunk = this.layout.chunks[chunkIndex];
    if (chunk === undefined) return false;
    if (this.destroyed[chunkIndex] === 1) return false;
    this.destroyed[chunkIndex] = 1;
    this.destroyedCount++;
    this.destroyedMassKg += chunk.mass;

    const support = this.floorSupport[chunk.floor];
    if (support !== undefined) {
      const remaining = support - chunk.supportShare;
      this.floorSupport[chunk.floor] = remaining < 0 ? 0 : remaining;
    }

    const attribute = this.spec.target.destroyed;
    attribute.array.fill(DESTROYED_FLAG, chunk.vertexStart, chunk.vertexStart + chunk.vertexCount);
    // Upload is requested NOW; only the range bookkeeping is coalesced.
    attribute.needsUpdate = true;
    const end = chunk.vertexStart + chunk.vertexCount;
    if (this.dirtyMax < 0) {
      this.dirtyMin = chunk.vertexStart;
      this.dirtyMax = end;
    } else {
      if (chunk.vertexStart < this.dirtyMin) this.dirtyMin = chunk.vertexStart;
      if (end > this.dirtyMax) this.dirtyMax = end;
    }
    return true;
  }

  /** True when this structure has vertices blanked but no range recorded yet. */
  get hasPendingUpload(): boolean {
    return this.dirtyMax >= 0;
  }

  /**
   * Record the coalesced range on the attribute. Called at the end of every
   * detach batch, synchronously, so nothing is ever a frame late.
   */
  flushUpload(): void {
    if (this.dirtyMax < 0) return;
    const attribute = this.spec.target.destroyed;
    attribute.addUpdateRange(this.dirtyMin, this.dirtyMax - this.dirtyMin);
    attribute.needsUpdate = true;
    this.dirtyMin = 0;
    this.dirtyMax = -1;
    this.uploadPending = false;
  }

  /** Replay a saved destroyed set onto a freshly built mesh. */
  restoreFrom(flags: Uint8Array): number {
    let restored = 0;
    const limit = Math.min(flags.length, this.chunkCount);
    for (let i = 0; i < limit; i++) {
      if (flags[i] === 1 && this.markDestroyed(i)) restored++;
    }
    return restored;
  }

  /** Copy the destroyed set into `out`, for the ledger. */
  snapshotInto(out: Uint8Array): void {
    out.set(this.destroyed.subarray(0, Math.min(out.length, this.chunkCount)));
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                          */
  /* ------------------------------------------------------------------ */

  private computeWorldBounds(): void {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    const scratch = new Float64Array(6);
    for (let i = 0; i < this.chunkCount; i++) {
      if (!this.chunkWorldBounds(i, scratch)) continue;
      if (scratch[0]! < minX) minX = scratch[0]!;
      if (scratch[1]! < minY) minY = scratch[1]!;
      if (scratch[2]! < minZ) minZ = scratch[2]!;
      if (scratch[3]! > maxX) maxX = scratch[3]!;
      if (scratch[4]! > maxY) maxY = scratch[4]!;
      if (scratch[5]! > maxZ) maxZ = scratch[5]!;
    }
    if (minX === Infinity) {
      this.worldBounds.fill(0);
      return;
    }
    this.worldBounds[0] = minX;
    this.worldBounds[1] = minY;
    this.worldBounds[2] = minZ;
    this.worldBounds[3] = maxX;
    this.worldBounds[4] = maxY;
    this.worldBounds[5] = maxZ;
  }
}
