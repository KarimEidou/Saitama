/**
 * COLLIDER CONSTRUCTION
 *
 * Turns the solver-agnostic `ColliderShape` union from the contract into
 * Rapier descriptors, plus the three shape families the game actually leans on:
 *
 *   • HEIGHTFIELD / TRIMESH — static world. Heightfield for terrain (one float
 *     per grid sample, no index buffer, exact ray hits); trimesh only where the
 *     geometry genuinely is not a height map, because trimesh broad-phase is an
 *     order of magnitude more expensive.
 *   • CAPSULE — actors. Never a box: a box catches its corners on every kerb,
 *     which is exactly the "invisible wall" bug players report as jank.
 *   • CONVEX HULL — debris. Built from 8 AABB corners rather than the chunk's
 *     real vertices. A true hull over a fractured concrete shard runs to dozens
 *     of planes and costs proportionally in the narrow phase; nobody can tell
 *     the difference on a piece tumbling past for two seconds.
 */

import type * as THREE from 'three';
import type { ColliderDesc } from '@dimforge/rapier3d-compat';
import type { ColliderShape, FractureChunk } from '@/types';
import type { Rapier } from './rapier-init';

/** Scratch buffer for AABB hull corners; reused to avoid per-spawn garbage. */
const hullScratch = new Float32Array(24);

/**
 * The 8 corners of an axis-aligned box, as a flat xyz array.
 *
 * Writes into `out` when supplied. The default target is a module-level
 * scratch buffer — safe because Rapier copies the points into wasm memory
 * during `convexHull()`, before control returns.
 */
export function aabbHullPoints(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  out: Float32Array = hullScratch
): Float32Array {
  out[0] = minX;  out[1] = minY;  out[2] = minZ;
  out[3] = maxX;  out[4] = minY;  out[5] = minZ;
  out[6] = maxX;  out[7] = maxY;  out[8] = minZ;
  out[9] = minX;  out[10] = maxY; out[11] = minZ;
  out[12] = minX; out[13] = minY; out[14] = maxZ;
  out[15] = maxX; out[16] = minY; out[17] = maxZ;
  out[18] = maxX; out[19] = maxY; out[20] = maxZ;
  out[21] = minX; out[22] = maxY; out[23] = maxZ;
  return out;
}

/**
 * 8-corner hull for a fracture chunk, in the chunk's local space, recentred on
 * its centroid so the collider's origin matches the body's centre of mass.
 */
export function chunkHullPoints(chunk: FractureChunk, out?: Float32Array): Float32Array {
  const { min, max } = chunk.bounds;
  const c = chunk.centroid;
  return aabbHullPoints(min.x - c.x, min.y - c.y, min.z - c.z, max.x - c.x, max.y - c.y, max.z - c.z, out);
}

/** Largest AABB edge of a chunk, used for the "too small to simulate" test. */
export function chunkMaxExtent(chunk: FractureChunk): number {
  const { min, max } = chunk.bounds;
  return Math.max(max.x - min.x, max.y - min.y, max.z - min.z);
}

/**
 * Capsule descriptor for an actor of a given TOTAL height.
 *
 * Rapier capsules are specified by the half-height of the CYLINDRICAL section,
 * excluding the hemispherical caps, so the caps have to be subtracted first —
 * getting this wrong makes every character 2 x radius too tall.
 */
export function actorCapsuleDesc(rapier: Rapier, height: number, radius: number): ColliderDesc {
  const halfHeight = Math.max(0.01, height * 0.5 - radius);
  return rapier.ColliderDesc.capsule(halfHeight, radius);
}

/**
 * Static terrain from a column-major height grid.
 *
 * `rows`/`cols` are SUBDIVISION counts, so `heights.length` must be
 * `(rows + 1) * (cols + 1)`. The mismatch is checked here because Rapier's own
 * failure mode is an opaque wasm `unreachable` trap.
 */
export function heightfieldDesc(
  rapier: Rapier,
  rows: number,
  cols: number,
  heights: Float32Array,
  scale: THREE.Vector3
): ColliderDesc {
  const expected = (rows + 1) * (cols + 1);
  if (heights.length !== expected) {
    throw new Error(
      `heightfieldDesc: ${rows}x${cols} subdivisions needs ${expected} samples, got ${heights.length}`
    );
  }
  return rapier.ColliderDesc.heightfield(rows, cols, heights, scale);
}

/** Static world geometry that is not a height map. Expensive — use sparingly. */
export function trimeshDesc(
  rapier: Rapier,
  vertices: Float32Array,
  indices: Uint32Array
): ColliderDesc {
  if (indices.length % 3 !== 0) {
    throw new Error(`trimeshDesc: index count ${indices.length} is not a multiple of 3`);
  }
  return rapier.ColliderDesc.trimesh(vertices, indices);
}

/** Debris hull from 8 (or more) points. Throws when the points are degenerate. */
export function convexHullDesc(rapier: Rapier, points: Float32Array): ColliderDesc {
  const desc = rapier.ColliderDesc.convexHull(points);
  if (desc === null) {
    throw new Error(`convexHullDesc: degenerate hull from ${points.length / 3} points`);
  }
  return desc;
}

/**
 * Build a descriptor for any shape in the contract's `ColliderShape` union.
 *
 * A square heightfield grid is inferred for the `heightfield` variant, which
 * carries no row/column counts; call `heightfieldDesc` directly for a
 * non-square grid.
 */
export function createColliderDesc(rapier: Rapier, shape: ColliderShape): ColliderDesc {
  switch (shape.kind) {
    case 'box':
      return rapier.ColliderDesc.cuboid(
        shape.halfExtents.x,
        shape.halfExtents.y,
        shape.halfExtents.z
      );
    case 'sphere':
      return rapier.ColliderDesc.ball(shape.radius);
    case 'capsule':
      return rapier.ColliderDesc.capsule(shape.halfHeight, shape.radius);
    case 'cylinder':
      return rapier.ColliderDesc.cylinder(shape.halfHeight, shape.radius);
    case 'convexHull':
      return convexHullDesc(rapier, shape.points);
    case 'trimesh':
      return trimeshDesc(rapier, shape.vertices, shape.indices);
    case 'heightfield': {
      const side = Math.round(Math.sqrt(shape.heights.length));
      if (side * side !== shape.heights.length) {
        throw new Error(
          `createColliderDesc: heightfield with ${shape.heights.length} samples is not square; ` +
            `use heightfieldDesc(rapier, rows, cols, …) for a rectangular grid`
        );
      }
      return heightfieldDesc(rapier, side - 1, side - 1, shape.heights, shape.scale);
    }
  }
}
