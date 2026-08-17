/**
 * SCALAR OVERLAP TESTS
 *
 * Which fracture chunks did that shockwave engulf. Pure arithmetic on six
 * numbers — no `THREE.Vector3`, no allocation, no object per candidate — which
 * matters because a full-charge serious punch sweeps a 180 m cone across
 * several hundred chunks in one frame and every temporary allocated in that
 * loop lands in the same GC pause the collapse does.
 *
 * The tests are CONSERVATIVE by design: a chunk that grazes the cone counts as
 * hit. A false positive costs one detached chunk and reads as spall, which is
 * correct; a false negative leaves a floating slab, which is a bug the player
 * can see.
 */

/** Squared distance from a point to an AABB. Zero when the point is inside. */
export function pointAabbDistanceSq(
  px: number,
  py: number,
  pz: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number
): number {
  const dx = px < minX ? minX - px : px > maxX ? px - maxX : 0;
  const dy = py < minY ? minY - py : py > maxY ? py - maxY : 0;
  const dz = pz < minZ ? minZ - pz : pz > maxZ ? pz - maxZ : 0;
  return dx * dx + dy * dy + dz * dz;
}

/** AABB vs sphere. Used by ground slams and landing craters. */
export function aabbInSphere(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  cx: number,
  cy: number,
  cz: number,
  radius: number
): boolean {
  return pointAabbDistanceSq(cx, cy, cz, minX, minY, minZ, maxX, maxY, maxZ) <= radius * radius;
}

/**
 * AABB vs cone, where the cone is `(origin, unit axis, range, half-angle)`.
 *
 * Two cheap tests, then a corner sweep:
 *
 *  1. RANGE. The nearest point of the box must be inside `range`, or nothing
 *     else matters.
 *  2. CONTAINMENT. An origin inside the box is always a hit — a punch thrown
 *     from inside a building destroys it.
 *  3. ANGLE. The box is hit when the nearest point OR any of the eight corners
 *     lies within the half-angle. Corners are what catch the common case of a
 *     tall slab whose nearest point sits below the cone but whose top is
 *     squarely inside it.
 *
 * `halfAngle >= PI` is omnidirectional and skips the angular test entirely,
 * matching `ShockwaveFiredEvent`'s contract.
 */
export function aabbInCone(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  ox: number,
  oy: number,
  oz: number,
  ax: number,
  ay: number,
  az: number,
  range: number,
  halfAngle: number
): boolean {
  if (pointAabbDistanceSq(ox, oy, oz, minX, minY, minZ, maxX, maxY, maxZ) > range * range) {
    return false;
  }
  if (ox >= minX && ox <= maxX && oy >= minY && oy <= maxY && oz >= minZ && oz <= maxZ) {
    return true;
  }
  if (halfAngle >= Math.PI) return true;

  const cosLimit = Math.cos(Math.min(halfAngle, Math.PI));

  // Nearest point on the box to the cone apex.
  const nx = ox < minX ? minX : ox > maxX ? maxX : ox;
  const ny = oy < minY ? minY : oy > maxY ? maxY : oy;
  const nz = oz < minZ ? minZ : oz > maxZ ? maxZ : oz;
  if (withinCone(nx - ox, ny - oy, nz - oz, ax, ay, az, range, cosLimit)) return true;

  for (let corner = 0; corner < 8; corner++) {
    const cx = (corner & 1) === 0 ? minX : maxX;
    const cy = (corner & 2) === 0 ? minY : maxY;
    const cz = (corner & 4) === 0 ? minZ : maxZ;
    if (withinCone(cx - ox, cy - oy, cz - oz, ax, ay, az, range, cosLimit)) return true;
  }
  return false;
}

/** One offset vector against the cone. `a*` must be unit length. */
function withinCone(
  dx: number,
  dy: number,
  dz: number,
  ax: number,
  ay: number,
  az: number,
  range: number,
  cosLimit: number
): boolean {
  const lengthSq = dx * dx + dy * dy + dz * dz;
  if (lengthSq > range * range) return false;
  if (lengthSq < 1e-8) return true;
  const along = dx * ax + dy * ay + dz * az;
  if (along <= 0) return false;
  return along >= cosLimit * Math.sqrt(lengthSq);
}

/**
 * Normalise into the three-slot scratch array, returning the original length.
 * Degenerate input becomes +X, which is arbitrary but never NaN — a NaN axis
 * silently destroys the whole city.
 */
export function normaliseInto(out: Float64Array, x: number, y: number, z: number): number {
  const length = Math.sqrt(x * x + y * y + z * z);
  if (length < 1e-6) {
    out[0] = 1;
    out[1] = 0;
    out[2] = 0;
    return 0;
  }
  out[0] = x / length;
  out[1] = y / length;
  out[2] = z / length;
  return length;
}

/**
 * Rotate a local-space offset by a yaw about +Y and translate, writing into
 * `out`. The city's procedural buildings are axis-aligned (`rotationY === 0`),
 * for which this is a pure add — but landmarks are not, and a destruction
 * system that only works on axis-aligned buildings is a destruction system
 * that fails on the interesting ones.
 */
export function localToWorld(
  out: Float64Array,
  lx: number,
  ly: number,
  lz: number,
  px: number,
  py: number,
  pz: number,
  cosY: number,
  sinY: number
): void {
  out[0] = px + lx * cosY + lz * sinY;
  out[1] = py + ly;
  out[2] = pz - lx * sinY + lz * cosY;
}

/**
 * World-space AABB of a yaw-rotated local AABB, written into `out` as six
 * numbers. Rotating the eight corners and re-bounding is exact for a yaw and
 * costs four multiplies.
 */
export function localAabbToWorld(
  out: Float64Array,
  aabb: readonly [number, number, number, number, number, number],
  px: number,
  py: number,
  pz: number,
  cosY: number,
  sinY: number
): void {
  if (sinY === 0 && cosY === 1) {
    out[0] = aabb[0] + px;
    out[1] = aabb[1] + py;
    out[2] = aabb[2] + pz;
    out[3] = aabb[3] + px;
    out[4] = aabb[4] + py;
    out[5] = aabb[5] + pz;
    return;
  }
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let corner = 0; corner < 4; corner++) {
    const lx = (corner & 1) === 0 ? aabb[0] : aabb[3];
    const lz = (corner & 2) === 0 ? aabb[2] : aabb[5];
    const wx = px + lx * cosY + lz * sinY;
    const wz = pz - lx * sinY + lz * cosY;
    if (wx < minX) minX = wx;
    if (wx > maxX) maxX = wx;
    if (wz < minZ) minZ = wz;
    if (wz > maxZ) maxZ = wz;
  }
  out[0] = minX;
  out[1] = aabb[1] + py;
  out[2] = minZ;
  out[3] = maxX;
  out[4] = aabb[4] + py;
  out[5] = maxZ;
}
