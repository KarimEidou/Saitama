/**
 * BAKED FRACTURE LAYOUT
 *
 * Fracture is decided at GENERATION time and never at runtime. There is no
 * Voronoi solve, no boolean geometry, no CSG — a building comes out of the
 * generator already split, and destroying part of it is a buffer edit.
 *
 * ── THE CHUNKING RULE ──────────────────────────────────────────────────────
 * One fracture chunk = one FLOOR x one FACADE QUADRANT, plus that quadrant's
 * share of the floor slab (and, on the top storey, of the roof deck, parapet
 * and rooftop plant). A 12-storey building is therefore 48 chunks — coarse
 * enough that a collapse stays inside the debris budget, fine enough that a
 * punch takes out a recognisable corner of a specific floor.
 *
 * Quadrants are chosen by FACE, not by diagonal wedge: a point belongs to the
 * east / south / west / north quadrant according to which axis of its offset
 * from the footprint centroid dominates. On the rectangular footprints that
 * make up most of a Japanese block, that means one chunk is exactly "one wall
 * of one floor", which is what a player expects to see fall away.
 *
 * ── WHAT DESTRUCTION DOES WITH THIS ────────────────────────────────────────
 *   1. `vertexStart..vertexStart+vertexCount` is filled with 1 in the
 *      per-vertex `destroyed` attribute; the vertex shader collapses those
 *      triangles to a point. One `Uint8Array.fill` and one partial buffer
 *      upload — no geometry rebuild, no reallocation, no frame spike.
 *   2. `parts[]` gives the contiguous index sub-range inside each material
 *      slot, so the same triangles can be copied straight into a pooled debris
 *      mesh without re-deriving anything.
 *   3. `supportShare` and `IFloorSupport` let the destruction system answer
 *      "has this floor lost more than 60% of its supports?" in constant time,
 *      and drop everything above it if so.
 */

import type { FractureChunk, StructureMaterial } from '@/types';
import type { AABB6 } from './mesh-builder';

/** Nominal densities in kg/m^3, used to turn chunk volume into mass. */
export const STRUCTURE_DENSITY: Readonly<Record<StructureMaterial, number>> = {
  concrete: 2400,
  brick: 1900,
  metal: 7850,
  glass: 2500,
  wood: 620,
  asphalt: 2300,
};

/**
 * Fraction of a floor's structural support that must SURVIVE for the floor to
 * stay standing. 0.4 means "collapse once more than 60% of the supports are
 * gone", which is the rule the destruction system applies.
 */
export const COLLAPSE_SUPPORT_RATIO = 0.4;

/** A contiguous index range inside one material slot. */
export interface IFractureSlotRange {
  readonly slot: number;
  /** First index into the geometry's index buffer, inclusive. */
  readonly start: number;
  readonly count: number;
}

/** One baked fracture chunk of a building. */
export interface IBuildingFractureChunk {
  /** Position in the parent's chunk array; equals `floor * 4 + quadrant`. */
  readonly index: number;
  readonly floor: number;
  /** 0 = +X (east), 1 = +Z (south), 2 = -X (west), 3 = -Z (north). */
  readonly quadrant: number;
  /**
   * Index range of this chunk inside the FACADE slot — the slot every chunk
   * has geometry in. `parts` carries the ranges for all three slots; these two
   * fields exist so the common case reads as the flat
   * `{start, count, centroid, mass, aabb}` record the destruction system wants.
   */
  readonly start: number;
  readonly count: number;
  readonly parts: readonly IFractureSlotRange[];
  /** Contiguous vertex range owned exclusively by this chunk. */
  readonly vertexStart: number;
  readonly vertexCount: number;
  /** Centre of mass in the building's LOCAL space. */
  readonly centroid: readonly [number, number, number];
  readonly volume: number;
  readonly mass: number;
  /** Local-space AABB, `[minX, minY, minZ, maxX, maxY, maxZ]`. */
  readonly aabb: AABB6;
  /** True when the chunk rests on the foundation. */
  readonly grounded: boolean;
  /** Chunks sharing a face: same floor either side, and directly above/below. */
  readonly neighbours: readonly number[];
  /** Share of this floor's total structural support, 0..1. */
  readonly supportShare: number;
}

/** Structural summary of one storey. */
export interface IFloorSupport {
  readonly floor: number;
  /** Local-space height band of the storey. */
  readonly y0: number;
  readonly y1: number;
  /** Chunk indices making up this storey. */
  readonly chunks: readonly number[];
  /** Sum of the storey's raw support weights, before normalisation. */
  readonly totalSupport: number;
}

/** Everything the destruction system needs about one building. */
export interface IFractureLayout {
  readonly chunks: readonly IBuildingFractureChunk[];
  readonly floors: readonly IFloorSupport[];
  readonly structureMaterial: StructureMaterial;
  readonly totalMass: number;
  /** Fraction of support that must survive; see `COLLAPSE_SUPPORT_RATIO`. */
  readonly collapseSupportRatio: number;
  /**
   * Index offset of each material slot inside the geometry these ranges point
   * at. Kept so a layout can be rebased when the building is merged into a
   * block — the slot-local order survives the merge untouched, only the base
   * moves, so `start - slotBase[slot] + mergedBase[slot]` is exact.
   */
  readonly slotBase: readonly number[];
}

/** Rebase a layout onto a merged geometry. Pure; the input is not mutated. */
export function rebaseLayout(
  layout: IFractureLayout,
  vertexOffset: number,
  mergedSlotBase: readonly number[]
): IFractureLayout {
  const chunks = layout.chunks.map((chunk) => {
    const parts = chunk.parts.map((p) => ({
      slot: p.slot,
      start: p.start - layout.slotBase[p.slot] + mergedSlotBase[p.slot],
      count: p.count,
    }));
    const facade = parts.find((p) => p.slot === 0) ?? parts[0];
    return {
      ...chunk,
      parts,
      start: facade ? facade.start : 0,
      count: facade ? facade.count : 0,
      vertexStart: chunk.vertexStart + vertexOffset,
    };
  });
  return { ...layout, chunks, slotBase: mergedSlotBase };
}

/** Quadrants per floor. Fixed at four — see the chunking rule above. */
export const QUADRANTS = 4;

/** Which face-quadrant a local-space offset from the centroid belongs to. */
export function quadrantOf(dx: number, dz: number): number {
  if (Math.abs(dx) >= Math.abs(dz)) return dx >= 0 ? 0 : 2;
  return dz >= 0 ? 1 : 3;
}

/** Neighbour chunk indices for `(floor, quadrant)` in a building of `floors`. */
export function neighboursOf(floor: number, quadrant: number, floors: number): number[] {
  const out: number[] = [];
  out.push(floor * QUADRANTS + ((quadrant + 1) % QUADRANTS));
  out.push(floor * QUADRANTS + ((quadrant + QUADRANTS - 1) % QUADRANTS));
  if (floor > 0) out.push((floor - 1) * QUADRANTS + quadrant);
  if (floor < floors - 1) out.push((floor + 1) * QUADRANTS + quadrant);
  return out;
}

/**
 * Support remaining on a floor after some chunks have been destroyed, 0..1.
 * The destruction system compares this against `collapseSupportRatio`.
 */
export function remainingSupport(
  layout: IFractureLayout,
  floor: number,
  isDestroyed: (chunkIndex: number) => boolean
): number {
  const info = layout.floors[floor];
  if (!info) return 1;
  let remaining = 0;
  for (const index of info.chunks) {
    if (!isDestroyed(index)) remaining += layout.chunks[index].supportShare;
  }
  return remaining;
}

/**
 * Floors that must come down given the currently destroyed chunks: the lowest
 * floor whose support has fallen below the threshold, and everything above it.
 */
export function collapsingFloors(
  layout: IFractureLayout,
  isDestroyed: (chunkIndex: number) => boolean
): number[] {
  for (let f = 0; f < layout.floors.length; f++) {
    if (remainingSupport(layout, f, isDestroyed) < layout.collapseSupportRatio) {
      const out: number[] = [];
      for (let g = f; g < layout.floors.length; g++) out.push(g);
      return out;
    }
  }
  return [];
}

/* -------------------------------------------------------------------------- */
/* Conformance to the destruction contract                                    */
/* -------------------------------------------------------------------------- */

/** Minimal Three.js surface needed to materialise a chunk, injected by callers. */
export interface IThreeLike {
  BufferGeometry: new () => {
    setAttribute(name: string, attribute: object): unknown;
    setIndex(index: object): unknown;
    computeBoundingBox(): void;
  };
  BufferAttribute: new (array: ArrayLike<number>, itemSize: number) => object;
  Vector3: new (x: number, y: number, z: number) => object;
  Box3: new (min: object, max: object) => object;
}

/**
 * Build the `FractureChunk` record from `src/types/destruction.ts` for one
 * chunk, extracting its triangles into a standalone geometry.
 *
 * Deliberately LAZY. A `FractureChunk` owns a live `THREE.BufferGeometry`, and
 * materialising 48 of them per building at generation time would allocate
 * thousands of geometries for a city that has not been punched yet — and would
 * make the chunk payload un-transferable, since a BufferGeometry cannot be
 * structured-cloned. The baked layout is the source of truth; this runs on the
 * main thread at the moment a chunk actually detaches and needs a debris body.
 */
export function materialiseFractureChunk(
  three: IThreeLike,
  layout: IFractureLayout,
  chunkIndex: number,
  source: {
    readonly positions: Float32Array;
    readonly normals: Float32Array;
    readonly uvs: Float32Array;
    readonly colors: Float32Array;
    readonly indices: Uint32Array;
  }
): FractureChunk {
  const chunk = layout.chunks[chunkIndex];
  const vStart = chunk.vertexStart;
  const vCount = chunk.vertexCount;

  let indexCount = 0;
  for (const part of chunk.parts) indexCount += part.count;
  const indices = new Uint32Array(indexCount);
  let cursor = 0;
  for (const part of chunk.parts) {
    for (let i = 0; i < part.count; i++) {
      // Rebase onto the extracted vertex slice.
      indices[cursor++] = source.indices[part.start + i] - vStart;
    }
  }

  const geometry = new three.BufferGeometry();
  geometry.setAttribute(
    'position',
    new three.BufferAttribute(source.positions.subarray(vStart * 3, (vStart + vCount) * 3), 3)
  );
  geometry.setAttribute(
    'normal',
    new three.BufferAttribute(source.normals.subarray(vStart * 3, (vStart + vCount) * 3), 3)
  );
  geometry.setAttribute(
    'uv',
    new three.BufferAttribute(source.uvs.subarray(vStart * 2, (vStart + vCount) * 2), 2)
  );
  geometry.setAttribute(
    'color',
    new three.BufferAttribute(source.colors.subarray(vStart * 3, (vStart + vCount) * 3), 3)
  );
  geometry.setIndex(new three.BufferAttribute(indices, 1));
  geometry.computeBoundingBox();

  const a = chunk.aabb;
  return {
    index: chunk.index,
    geometry: geometry as unknown as FractureChunk['geometry'],
    centroid: new three.Vector3(
      chunk.centroid[0],
      chunk.centroid[1],
      chunk.centroid[2]
    ) as unknown as FractureChunk['centroid'],
    volume: chunk.volume,
    mass: chunk.mass,
    bounds: new three.Box3(
      new three.Vector3(a[0], a[1], a[2]),
      new three.Vector3(a[3], a[4], a[5])
    ) as unknown as FractureChunk['bounds'],
    neighbours: chunk.neighbours,
    isGrounded: chunk.grounded,
    detached: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Verification helpers                                                       */
/* -------------------------------------------------------------------------- */

/** Result of checking that chunks partition a geometry exactly. */
export interface IPartitionReport {
  readonly ok: boolean;
  /** Triangles claimed by more than one chunk. */
  readonly duplicated: number;
  /** Triangles claimed by no chunk. */
  readonly orphaned: number;
  /** Vertices claimed by more than one chunk. */
  readonly duplicatedVertices: number;
  /** Vertices claimed by no chunk. */
  readonly orphanedVertices: number;
  readonly totalTriangles: number;
  readonly totalVertices: number;
}

/**
 * Verify the two partition invariants the whole scheme rests on:
 * every triangle belongs to exactly one chunk, and every vertex belongs to
 * exactly one chunk. If either fails, destruction either leaves floating
 * triangles behind or deletes triangles belonging to an intact chunk.
 */
export function verifyPartition(
  layout: IFractureLayout,
  indexCount: number,
  vertexCount: number
): IPartitionReport {
  const triangleOwner = new Int32Array(indexCount / 3).fill(-1);
  const vertexOwner = new Int32Array(vertexCount).fill(-1);
  let duplicated = 0;
  let duplicatedVertices = 0;

  for (const chunk of layout.chunks) {
    for (const part of chunk.parts) {
      for (let i = part.start; i < part.start + part.count; i += 3) {
        const tri = i / 3;
        if (triangleOwner[tri] !== -1) duplicated++;
        triangleOwner[tri] = chunk.index;
      }
    }
    for (let v = chunk.vertexStart; v < chunk.vertexStart + chunk.vertexCount; v++) {
      if (vertexOwner[v] !== -1) duplicatedVertices++;
      vertexOwner[v] = chunk.index;
    }
  }

  let orphaned = 0;
  for (let i = 0; i < triangleOwner.length; i++) if (triangleOwner[i] === -1) orphaned++;
  let orphanedVertices = 0;
  for (let i = 0; i < vertexOwner.length; i++) if (vertexOwner[i] === -1) orphanedVertices++;

  return {
    ok: duplicated === 0 && orphaned === 0 && duplicatedVertices === 0 && orphanedVertices === 0,
    duplicated,
    orphaned,
    duplicatedVertices,
    orphanedVertices,
    totalTriangles: triangleOwner.length,
    totalVertices: vertexCount,
  };
}
