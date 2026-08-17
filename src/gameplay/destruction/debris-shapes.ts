/**
 * POOLED DEBRIS SHAPES
 *
 * The debris pool wants a `FractureChunk`: a geometry, a centroid, a mass and
 * a local AABB. Producing one honestly means extracting the chunk's triangles
 * out of the block mesh into a standalone `BufferGeometry` — which allocates a
 * geometry, five typed arrays and a GPU buffer, at the exact moment a
 * collapse is already spending the frame.
 *
 * So it is not done that way. Three observations collapse the cost to zero:
 *
 *  1. The debris COLLIDER is already an 8-vertex hull derived from the chunk's
 *     AABB, not from its triangles. Physics never looks at the geometry.
 *  2. The visible piece is a fragment tumbling past for two seconds. A box the
 *     exact size of the chunk is, frankly, what the collider says it is
 *     anyway, and nobody can tell the difference on a falling shard.
 *  3. A box is 24 vertices whose NORMALS and INDICES never change — only the
 *     eight corner positions do. Resizing one is 72 float writes into a buffer
 *     that already exists.
 *
 * The pool therefore holds `capacity` boxes, one per possible live debris
 * piece, and hands them out with their corners rewritten. Steady-state
 * allocation for a 300-piece collapse: zero bytes.
 *
 * ── SLOT LIFETIME ──────────────────────────────────────────────────────────
 * A box may not be resized while the piece using it is still on screen, so
 * slots are reclaimed by asking the debris pool whether the piece it was lent
 * to still exists. A ring buffer would be cheaper and is NOT safe: the debris
 * pool's LRU can keep one old piece alive across an entire capacity's worth of
 * spawns, and that piece would have its box resized under it.
 */

import * as THREE from 'three';
import type { FractureChunk } from '@/types';
import type { IDebrisSink, IStructureChunk } from './ports';

/** Vertex count of a box with hard (per-face) normals. */
const BOX_VERTICES = 24;

/**
 * Corner selector per vertex: bit 0 = use maxX, bit 1 = use maxY,
 * bit 2 = use maxZ. Six faces x four corners, wound counter-clockwise as seen
 * from outside so back-face culling keeps the outside visible.
 */
const CORNER_SELECT = new Uint8Array([
  /* +X */ 0b101, 0b001, 0b011, 0b111,
  /* -X */ 0b000, 0b100, 0b110, 0b010,
  /* +Y */ 0b110, 0b111, 0b011, 0b010,
  /* -Y */ 0b000, 0b001, 0b101, 0b100,
  /* +Z */ 0b100, 0b101, 0b111, 0b110,
  /* -Z */ 0b001, 0b000, 0b010, 0b011,
]);

const FACE_NORMALS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;

function buildBoxNormals(): Float32Array {
  const normals = new Float32Array(BOX_VERTICES * 3);
  for (let face = 0; face < 6; face++) {
    const n = FACE_NORMALS[face]!;
    for (let corner = 0; corner < 4; corner++) {
      const v = (face * 4 + corner) * 3;
      normals[v] = n[0];
      normals[v + 1] = n[1];
      normals[v + 2] = n[2];
    }
  }
  return normals;
}

function buildBoxIndices(): Uint16Array {
  const indices = new Uint16Array(36);
  for (let face = 0; face < 6; face++) {
    const base = face * 4;
    const i = face * 6;
    indices[i] = base;
    indices[i + 1] = base + 1;
    indices[i + 2] = base + 2;
    indices[i + 3] = base;
    indices[i + 4] = base + 2;
    indices[i + 5] = base + 3;
  }
  return indices;
}

/** A mutable `FractureChunk`, so the record itself is pooled too. */
interface IMutableChunk {
  index: number;
  geometry: THREE.BufferGeometry;
  centroid: THREE.Vector3;
  volume: number;
  mass: number;
  bounds: THREE.Box3;
  neighbours: readonly number[];
  isGrounded: boolean;
  detached: boolean;
}

const NO_NEIGHBOURS: readonly number[] = [];

/** One pooled box plus the record handed to the debris pool. */
interface IShapeSlot {
  readonly index: number;
  readonly geometry: THREE.BufferGeometry;
  readonly positions: Float32Array;
  readonly positionAttribute: THREE.BufferAttribute;
  readonly chunk: IMutableChunk;
  /** Debris piece id currently borrowing this slot; 0 when free. */
  debrisId: number;
}

/**
 * `capacity` reusable boxes. Sized to the debris pool so a slot is available
 * whenever the pool has room for a piece.
 */
export class DebrisShapePool {
  readonly capacity: number;

  private readonly slots: IShapeSlot[] = [];
  private readonly freeSlots: number[] = [];
  /** Slots currently lent out, in lend order. Scanned to reclaim. */
  private readonly lent: number[] = [];

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity | 0);
    const normals = buildBoxNormals();
    const indices = buildBoxIndices();

    for (let i = 0; i < this.capacity; i++) {
      const positions = new Float32Array(BOX_VERTICES * 3);
      const positionAttribute = new THREE.BufferAttribute(positions, 3);
      positionAttribute.setUsage(THREE.DynamicDrawUsage);

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', positionAttribute);
      // Normals and indices are identical for every box, so every slot shares
      // one copy of each. Only the corners are per-slot.
      geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      geometry.setIndex(new THREE.BufferAttribute(indices, 1));
      geometry.boundingSphere = new THREE.Sphere();
      geometry.boundingBox = new THREE.Box3();

      this.slots.push({
        index: i,
        geometry,
        positions,
        positionAttribute,
        chunk: {
          index: 0,
          geometry,
          centroid: new THREE.Vector3(),
          volume: 0,
          mass: 0,
          bounds: new THREE.Box3(),
          neighbours: NO_NEIGHBOURS,
          isGrounded: false,
          detached: true,
        },
        debrisId: 0,
      });
      this.freeSlots.push(i);
    }
    // Deterministic allocation order: slot 0 first, always.
    this.freeSlots.reverse();
  }

  get freeCount(): number {
    return this.freeSlots.length;
  }

  get lentCount(): number {
    return this.lent.length;
  }

  /**
   * Configure a free slot for a fracture chunk and return the record to hand
   * to the debris pool. `undefined` when every box is still in use, which the
   * caller must treat as "detach visually, spawn no body".
   */
  acquire(source: IStructureChunk): FractureChunk | undefined {
    const index = this.freeSlots.pop();
    if (index === undefined) return undefined;
    const slot = this.slots[index]!;

    const a = source.aabb;
    this.writeBox(slot, a[0], a[1], a[2], a[3], a[4], a[5]);

    const chunk = slot.chunk;
    chunk.index = source.index;
    chunk.centroid.set(source.centroid[0], source.centroid[1], source.centroid[2]);
    chunk.volume = source.volume;
    chunk.mass = source.mass;
    chunk.bounds.min.set(a[0], a[1], a[2]);
    chunk.bounds.max.set(a[3], a[4], a[5]);
    chunk.neighbours = source.neighbours;
    chunk.isGrounded = source.grounded;
    chunk.detached = true;

    slot.debrisId = 0;
    this.lent.push(index);
    return chunk as unknown as FractureChunk;
  }

  /**
   * Record which debris piece took the slot most recently handed out. A slot
   * whose spawn was refused is returned immediately.
   */
  bind(debrisId: number | undefined): void {
    const index = this.lent[this.lent.length - 1];
    if (index === undefined) return;
    if (debrisId === undefined) {
      this.lent.pop();
      this.freeSlots.push(index);
      return;
    }
    this.slots[index]!.debrisId = debrisId;
  }

  /**
   * Reclaim slots whose debris piece the pool has recycled. Called once a
   * frame; O(live pieces) map lookups, no allocation.
   */
  reclaim(debris: IDebrisSink): void {
    const get = debris.get;
    if (get === undefined) return;
    let write = 0;
    for (let read = 0; read < this.lent.length; read++) {
      const index = this.lent[read]!;
      const slot = this.slots[index]!;
      if (slot.debrisId !== 0 && get.call(debris, slot.debrisId) !== undefined) {
        this.lent[write++] = index;
      } else {
        slot.debrisId = 0;
        this.freeSlots.push(index);
      }
    }
    this.lent.length = write;
  }

  /** Return every slot. Used on `clear()` / `dispose()`. */
  releaseAll(): void {
    for (const index of this.lent) {
      this.slots[index]!.debrisId = 0;
      this.freeSlots.push(index);
    }
    this.lent.length = 0;
  }

  dispose(): void {
    for (const slot of this.slots) slot.geometry.dispose();
    this.slots.length = 0;
    this.freeSlots.length = 0;
    this.lent.length = 0;
  }

  /** Rewrite one box's 24 corners in place. 72 float writes, no allocation. */
  private writeBox(
    slot: IShapeSlot,
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number
  ): void {
    const p = slot.positions;
    for (let v = 0; v < BOX_VERTICES; v++) {
      const select = CORNER_SELECT[v]!;
      const o = v * 3;
      p[o] = (select & 1) === 0 ? minX : maxX;
      p[o + 1] = (select & 2) === 0 ? minY : maxY;
      p[o + 2] = (select & 4) === 0 ? minZ : maxZ;
    }
    slot.positionAttribute.needsUpdate = true;

    // Bounds are mutated in place; `new THREE.Sphere()` here would allocate
    // once per detached chunk, which is exactly what this file exists to avoid.
    const box = slot.geometry.boundingBox!;
    box.min.set(minX, minY, minZ);
    box.max.set(maxX, maxY, maxZ);
    const sphere = slot.geometry.boundingSphere!;
    sphere.center.set((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5);
    const dx = maxX - minX;
    const dy = maxY - minY;
    const dz = maxZ - minZ;
    sphere.radius = 0.5 * Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
}
