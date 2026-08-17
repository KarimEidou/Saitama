/**
 * AABB PRIMITIVES
 *
 * Bounds live in flat `Float32Array`s inside the quadtree (six floats per box,
 * `minX minY minZ maxX maxY maxZ`), never as objects. Two reasons:
 *
 *  1. 10,000 static instances as `THREE.Box3` objects is 10,000 allocations
 *     holding 20,000 `Vector3`s. As a Float32Array it is one 240 KB buffer that
 *     the frustum walk streams through linearly.
 *  2. Every predicate below is used by BOTH the accelerated query and the
 *     brute-force reference it is verified against. Sharing the exact
 *     expression — including the order of the additions — is what makes
 *     "returns exactly the same set" provable rather than approximate.
 */

import type * as THREE from 'three';

/** An axis-aligned box as plain numbers. Interop shape for callers. */
export interface IAabb {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/** Allocate an empty (inverted) AABB. */
export function createAabb(): IAabb {
  return {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
  };
}

/** Reset a box to the empty/inverted state. */
export function emptyAabb(box: IAabb): IAabb {
  box.minX = Infinity;
  box.minY = Infinity;
  box.minZ = Infinity;
  box.maxX = -Infinity;
  box.maxY = -Infinity;
  box.maxZ = -Infinity;
  return box;
}

/** True when the box has no volume because nothing was ever added. */
export function isAabbEmpty(box: IAabb): boolean {
  return box.maxX < box.minX || box.maxY < box.minY || box.maxZ < box.minZ;
}

/** Copy a `THREE.Box3` into flat form. */
export function aabbFromBox3(box3: THREE.Box3, target: IAabb): IAabb {
  target.minX = box3.min.x;
  target.minY = box3.min.y;
  target.minZ = box3.min.z;
  target.maxX = box3.max.x;
  target.maxY = box3.max.y;
  target.maxZ = box3.max.z;
  return target;
}

/** Write flat bounds into a `THREE.Box3`. */
export function aabbToBox3(box: IAabb, target: THREE.Box3): THREE.Box3 {
  target.min.set(box.minX, box.minY, box.minZ);
  target.max.set(box.maxX, box.maxY, box.maxZ);
  return target;
}

/** Read six floats out of a packed array at `offset`. */
export function readAabb(src: ArrayLike<number>, offset: number, target: IAabb): IAabb {
  target.minX = src[offset]!;
  target.minY = src[offset + 1]!;
  target.minZ = src[offset + 2]!;
  target.maxX = src[offset + 3]!;
  target.maxY = src[offset + 4]!;
  target.maxZ = src[offset + 5]!;
  return target;
}

/** Write six floats into a packed array at `offset`. */
export function writeAabb(dst: Float32Array, offset: number, box: IAabb): void {
  dst[offset] = box.minX;
  dst[offset + 1] = box.minY;
  dst[offset + 2] = box.minZ;
  dst[offset + 3] = box.maxX;
  dst[offset + 4] = box.maxY;
  dst[offset + 5] = box.maxZ;
}

/* -------------------------------------------------------------------------- */
/* Packed-array predicates                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Box-vs-box overlap, packed form vs six scalars.
 * Touching faces count as overlapping (closed intervals).
 */
export function packedIntersectsBox(
  src: ArrayLike<number>,
  offset: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number
): boolean {
  return (
    src[offset]! <= maxX &&
    src[offset + 3]! >= minX &&
    src[offset + 1]! <= maxY &&
    src[offset + 4]! >= minY &&
    src[offset + 2]! <= maxZ &&
    src[offset + 5]! >= minZ
  );
}

/** True when the packed box at `offset` is fully inside the given box. */
export function packedInsideBox(
  src: ArrayLike<number>,
  offset: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number
): boolean {
  return (
    src[offset]! >= minX &&
    src[offset + 3]! <= maxX &&
    src[offset + 1]! >= minY &&
    src[offset + 4]! <= maxY &&
    src[offset + 2]! >= minZ &&
    src[offset + 5]! <= maxZ
  );
}

/**
 * Squared distance from a point to the packed box (0 when inside).
 * Used for radius queries in the XZ plane and for BVH-free proximity tests.
 */
export function packedDistanceSq(
  src: ArrayLike<number>,
  offset: number,
  x: number,
  y: number,
  z: number
): number {
  const dx = x < src[offset]! ? src[offset]! - x : x > src[offset + 3]! ? x - src[offset + 3]! : 0;
  const dy =
    y < src[offset + 1]! ? src[offset + 1]! - y : y > src[offset + 4]! ? y - src[offset + 4]! : 0;
  const dz =
    z < src[offset + 2]! ? src[offset + 2]! - z : z > src[offset + 5]! ? z - src[offset + 5]! : 0;
  return dx * dx + dy * dy + dz * dz;
}

/** Squared XZ distance from a point to the packed box (0 when inside). */
export function packedDistanceSq2D(
  src: ArrayLike<number>,
  offset: number,
  x: number,
  z: number
): number {
  const dx = x < src[offset]! ? src[offset]! - x : x > src[offset + 3]! ? x - src[offset + 3]! : 0;
  const dz =
    z < src[offset + 2]! ? src[offset + 2]! - z : z > src[offset + 5]! ? z - src[offset + 5]! : 0;
  return dx * dx + dz * dz;
}

/* -------------------------------------------------------------------------- */
/* Ray casting                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Entry distance of a ray into an AABB, or `Infinity` when it misses.
 *
 * A ray whose origin is already inside returns 0. Axis-aligned directions are
 * handled with an explicit branch rather than by relying on `1/0 == Infinity`:
 * the infinity trick produces `0 * Infinity == NaN` when the origin lies
 * exactly on a slab plane, which silently drops hits on the world's grid-
 * aligned buildings — the one case guaranteed to happen constantly here.
 *
 * The SAME function backs the accelerated raycast and its brute-force
 * reference, so their results agree bit for bit.
 */
export function rayBoxEntry(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDistance: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number
): number {
  let tmin = 0;
  let tmax = maxDistance;

  if (dx !== 0) {
    const inv = 1 / dx;
    let t1 = (minX - ox) * inv;
    let t2 = (maxX - ox) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  } else if (ox < minX || ox > maxX) {
    return Infinity;
  }

  if (dy !== 0) {
    const inv = 1 / dy;
    let t1 = (minY - oy) * inv;
    let t2 = (maxY - oy) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  } else if (oy < minY || oy > maxY) {
    return Infinity;
  }

  if (dz !== 0) {
    const inv = 1 / dz;
    let t1 = (minZ - oz) * inv;
    let t2 = (maxZ - oz) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  } else if (oz < minZ || oz > maxZ) {
    return Infinity;
  }

  return tmin;
}

/** `rayBoxEntry` against a packed six-float box. */
export function packedRayEntry(
  src: ArrayLike<number>,
  offset: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDistance: number
): number {
  return rayBoxEntry(
    ox,
    oy,
    oz,
    dx,
    dy,
    dz,
    maxDistance,
    src[offset]!,
    src[offset + 1]!,
    src[offset + 2]!,
    src[offset + 3]!,
    src[offset + 4]!,
    src[offset + 5]!
  );
}

/**
 * 2D (XZ) ray-vs-rectangle entry distance, or `Infinity` on a miss.
 * The PVS builder's inner loop: rays are horizontal and occluders are
 * footprints, so the Y axis never enters into it.
 */
export function rayRectEntry2D(
  ox: number,
  oz: number,
  dx: number,
  dz: number,
  maxDistance: number,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number
): number {
  let tmin = 0;
  let tmax = maxDistance;

  if (dx !== 0) {
    const inv = 1 / dx;
    let t1 = (minX - ox) * inv;
    let t2 = (maxX - ox) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  } else if (ox < minX || ox > maxX) {
    return Infinity;
  }

  if (dz !== 0) {
    const inv = 1 / dz;
    let t1 = (minZ - oz) * inv;
    let t2 = (maxZ - oz) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return Infinity;
  } else if (oz < minZ || oz > maxZ) {
    return Infinity;
  }

  return tmin;
}
