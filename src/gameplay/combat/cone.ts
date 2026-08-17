/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  CONE / AABB GEOMETRY — THE PART THAT MUST NOT BE WRONG                  ║
 * ║                                                                          ║
 * ║  A FALSE NEGATIVE HERE IS A MONSTER SURVIVING A PUNCH THAT VISIBLY       ║
 * ║  ENGULFED IT. Every predicate below is therefore CONSERVATIVE: it may    ║
 * ║  over-accept, it may never under-accept.                                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── WHAT A "CONE" IS HERE ──────────────────────────────────────────────────
 * A SPHERICAL SECTOR, not a cone capped by a flat disc:
 *
 *     { P : |P - O| <= range  AND  angle(P - O, N) <= halfAngle }
 *
 * The far cap is a piece of a sphere. That matters: a target 179.9 m away at
 * the rim of a 180 m serious punch is inside, and a flat-cap formulation would
 * wrongly spare it.
 *
 * ── WHY THIS FILE DUPLICATES `sphereInCone` FROM `src/spatial` ─────────────
 * The architectural rule forbids this system from importing another system's
 * implementation, and the shockwave's broad phase is `DynamicEntityGrid`,
 * which lives in `src/spatial`. So the NARROW-PHASE PREDICATE IS MIRRORED HERE
 * BYTE FOR BYTE. If the two ever diverge, the grid's candidate set and this
 * module's acceptance test disagree and enemies start surviving punches.
 *
 * That risk is not left to discipline: `harness/combat.ts` imports BOTH
 * implementations at runtime and asserts they agree over tens of thousands of
 * random configurations. A drift is a failed harness run, not a silent bug.
 *
 * ── WHY THERE IS NO BROAD PHASE IN THIS FILE ───────────────────────────────
 * There is deliberately no grid, tree or hierarchy here. Broad phase is
 * `src/spatial`'s job and is injected (`ICombatBroadPhase`). `LinearScan`
 * in `targets.ts` is a REFERENCE, not an acceleration structure — its whole
 * purpose is to be obviously correct so the accelerated path can be checked
 * against it.
 */

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

/** Guard against division by a degenerate length. */
export const CONE_EPSILON = 1e-9;

/** Axis-aligned box in world space. Plain data; no `THREE.Box3` dependency. */
export interface ICombatAabb {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

/** Build a box from a centre and half-extents. */
export function aabbFromCentre(
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hy: number,
  hz: number
): ICombatAabb {
  return {
    minX: cx - hx,
    minY: cy - hy,
    minZ: cz - hz,
    maxX: cx + hx,
    maxY: cy + hy,
    maxZ: cz + hz,
  };
}

/** Squared distance from a point to a box; 0 when the point is inside. */
export function pointAabbDistanceSq(
  px: number,
  py: number,
  pz: number,
  box: ICombatAabb
): number {
  const dx = px < box.minX ? box.minX - px : px > box.maxX ? px - box.maxX : 0;
  const dy = py < box.minY ? box.minY - py : py > box.maxY ? py - box.maxY : 0;
  const dz = pz < box.minZ ? box.minZ - pz : pz > box.maxZ ? pz - box.maxZ : 0;
  return dx * dx + dy * dy + dz * dz;
}

/** Squared distance from a point to the FARTHEST corner of a box. */
export function pointAabbFarthestSq(
  px: number,
  py: number,
  pz: number,
  box: ICombatAabb
): number {
  const dx = Math.max(px - box.minX, box.maxX - px);
  const dy = Math.max(py - box.minY, box.maxY - py);
  const dz = Math.max(pz - box.minZ, box.maxZ - pz);
  return dx * dx + dy * dy + dz * dz;
}

/** True when the point lies inside (or on) the box. */
export function pointInAabb(px: number, py: number, pz: number, box: ICombatAabb): boolean {
  return (
    px >= box.minX &&
    px <= box.maxX &&
    py >= box.minY &&
    py <= box.maxY &&
    pz >= box.minZ &&
    pz <= box.maxZ
  );
}

/** True when two boxes overlap or touch. */
export function aabbOverlap(a: ICombatAabb, b: ICombatAabb): boolean {
  return (
    a.minX <= b.maxX &&
    a.maxX >= b.minX &&
    a.minY <= b.maxY &&
    a.maxY >= b.minY &&
    a.minZ <= b.maxZ &&
    a.maxZ >= b.minZ
  );
}

/* -------------------------------------------------------------------------- */
/* Point vs cone — the exact predicate everything else is measured against     */
/* -------------------------------------------------------------------------- */

/**
 * EXACT: is a point inside the spherical sector?
 *
 * `(nx, ny, nz)` must already be unit length. The apex itself is always
 * inside — a punch thrown from inside a target's volume connects.
 */
export function pointInCone(
  cx: number,
  cy: number,
  cz: number,
  nx: number,
  ny: number,
  nz: number,
  range: number,
  halfAngle: number
): boolean {
  const distSq = cx * cx + cy * cy + cz * cz;
  if (distSq > range * range) return false;
  if (distSq <= CONE_EPSILON) return true;
  const dist = Math.sqrt(distSq);
  // cos is monotonically decreasing in angle, so comparing cosines avoids an
  // acos and is exact to the same precision.
  return (cx * nx + cy * ny + cz * nz) / dist >= Math.cos(halfAngle);
}

/* -------------------------------------------------------------------------- */
/* Sphere vs cone                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Sphere-vs-cone intersection, apex at the origin. MIRROR OF
 * `src/spatial/entity-grid.ts#sphereInCone` — see the file header for why the
 * duplication is deliberate and how the mirror is enforced.
 *
 * `(cx, cy, cz)` is the sphere centre RELATIVE to the apex and `(nx, ny, nz)`
 * is the unit axis. Three cases, in the order that resolves them cheapest:
 *
 *  1. beyond `range + r` along any direction — reject on distance alone;
 *  2. apex inside the sphere — accept, the cone starts inside the target;
 *  3. otherwise compare the centre's angle off-axis against the half-angle
 *     widened by `asin(r / d)`, the angular radius the sphere subtends.
 *
 * Case 3 is the standard conservative sphere-cone test. It slightly
 * over-accepts spheres straddling the cone's rim near the apex, which is the
 * correct direction to err.
 */
export function sphereInCone(
  cx: number,
  cy: number,
  cz: number,
  r: number,
  nx: number,
  ny: number,
  nz: number,
  range: number,
  halfAngle: number
): boolean {
  const distSq = cx * cx + cy * cy + cz * cz;
  const limit = range + r;
  if (distSq > limit * limit) return false;
  if (distSq <= r * r) return true;

  const dist = Math.sqrt(distSq);
  const cosAxis = (cx * nx + cy * ny + cz * nz) / dist;
  const angle = Math.acos(cosAxis < -1 ? -1 : cosAxis > 1 ? 1 : cosAxis);
  const ratio = r / dist;
  const spread = ratio >= 1 ? Math.PI * 0.5 : Math.asin(ratio);
  return angle - spread <= halfAngle;
}

/**
 * BRUTE FORCE REFERENCE for `sphereInCone`.
 *
 * Samples the sphere's surface and interior on a lattice and asks whether ANY
 * sample is inside the sector. Sampling can only ever MISS an intersection, so
 * `sphereInConeBrute(...) === true` is proof of a real intersection — which is
 * exactly the direction the assertions need: anything brute force finds, the
 * production predicate must also accept.
 */
export function sphereInConeBrute(
  cx: number,
  cy: number,
  cz: number,
  r: number,
  nx: number,
  ny: number,
  nz: number,
  range: number,
  halfAngle: number,
  steps = 14
): boolean {
  if (pointInCone(cx, cy, cz, nx, ny, nz, range, halfAngle)) return true;
  if (r <= 0) return false;
  // Lattice over the sphere's bounding cube, keeping only points inside the
  // sphere. Includes the surface because the endpoints are inclusive.
  for (let i = 0; i <= steps; i++) {
    const u = (i / steps) * 2 - 1;
    for (let j = 0; j <= steps; j++) {
      const v = (j / steps) * 2 - 1;
      for (let k = 0; k <= steps; k++) {
        const w = (k / steps) * 2 - 1;
        const lenSq = u * u + v * v + w * w;
        if (lenSq > 1) continue;
        if (
          pointInCone(cx + u * r, cy + v * r, cz + w * r, nx, ny, nz, range, halfAngle)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Cone bounds                                                                */
/* -------------------------------------------------------------------------- */

/**
 * EXACT world-space AABB of a spherical sector.
 *
 * Per axis, the extreme of `dot(P, e)` over the sector is reached either at
 * radius `range` and the smallest achievable angle to `e` (`|phi - halfAngle|`
 * clamped to `[0, PI]`), or at the apex itself — which is why 0 is folded into
 * both ends. Using the sphere's own box instead would be correct but up to
 * nine times too large for a 22° serious punch, and the box is what prunes the
 * fracture-chunk sweep.
 */
export function coneBounds(
  ox: number,
  oy: number,
  oz: number,
  nx: number,
  ny: number,
  nz: number,
  range: number,
  halfAngle: number
): ICombatAabb {
  const axis = (n: number): { lo: number; hi: number } => {
    const clamped = n < -1 ? -1 : n > 1 ? 1 : n;
    const phi = Math.acos(clamped);
    const hiAngle = phi - halfAngle;
    const loAngle = phi + halfAngle;
    const hi = Math.max(0, range * Math.cos(hiAngle < 0 ? 0 : hiAngle));
    const lo = Math.min(0, range * Math.cos(loAngle > Math.PI ? Math.PI : loAngle));
    return { lo, hi };
  };
  const x = axis(nx);
  const y = axis(ny);
  const z = axis(nz);
  return {
    minX: ox + x.lo,
    minY: oy + y.lo,
    minZ: oz + z.lo,
    maxX: ox + x.hi,
    maxY: oy + y.hi,
    maxZ: oz + z.hi,
  };
}

/* -------------------------------------------------------------------------- */
/* Segment vs AABB                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Slab test: does the segment `O -> O + N * range` touch the box?
 *
 * Used as an EXACT ACCEPT shortcut in `aabbInCone`: the cone's axis is at
 * angle 0, so anything the axis passes through is unambiguously inside. This
 * is the common case — punching a building you are standing in front of — and
 * resolving it exactly keeps the conservative fallback from ever being reached
 * for it.
 */
export function segmentIntersectsAabb(
  ox: number,
  oy: number,
  oz: number,
  nx: number,
  ny: number,
  nz: number,
  range: number,
  box: ICombatAabb
): boolean {
  let tMin = 0;
  let tMax = range;

  const slab = (o: number, d: number, lo: number, hi: number): boolean => {
    if (Math.abs(d) < CONE_EPSILON) return o >= lo && o <= hi;
    const inv = 1 / d;
    let t0 = (lo - o) * inv;
    let t1 = (hi - o) * inv;
    if (t0 > t1) {
      const swap = t0;
      t0 = t1;
      t1 = swap;
    }
    if (t0 > tMin) tMin = t0;
    if (t1 < tMax) tMax = t1;
    return tMin <= tMax;
  };

  if (!slab(ox, nx, box.minX, box.maxX)) return false;
  if (!slab(oy, ny, box.minY, box.maxY)) return false;
  if (!slab(oz, nz, box.minZ, box.maxZ)) return false;
  return true;
}

/* -------------------------------------------------------------------------- */
/* AABB vs cone                                                               */
/* -------------------------------------------------------------------------- */

/**
 * CONSERVATIVE box-vs-spherical-sector test. Never a false negative.
 *
 * The structure is: cheap EXACT rejects, then cheap EXACT accepts, then two
 * independent conservative bounds that are ANDed together. Intersecting two
 * supersets of the true answer is still a superset, so the conjunction is
 * tighter than either bound alone and still cannot reject a real hit.
 *
 *  EXACT REJECTS
 *    1. the cone's own AABB misses the box;
 *    2. the box's nearest point is beyond `range`.
 *  EXACT ACCEPTS
 *    3. the apex is inside the box;
 *    4. the cone's axis segment passes through the box;
 *    5. the box's nearest point to the apex is inside the cone;
 *    6. any of the eight corners is inside the cone.
 *  CONSERVATIVE
 *    7. the box's bounding sphere intersects the cone (`sphereInCone`);
 *    8. `max(dot(P - O, N)) / min|P - O|` — an upper bound on the cosine of
 *       the smallest achievable off-axis angle — reaches `cos(halfAngle)`.
 *
 * Bound 8 is what makes long thin boxes (building fracture chunks, the whole
 * reason this exists) tight: the bounding sphere of a 40 m slab is useless,
 * but the dot/distance ratio is not.
 */
export function aabbInCone(
  box: ICombatAabb,
  ox: number,
  oy: number,
  oz: number,
  nx: number,
  ny: number,
  nz: number,
  range: number,
  halfAngle: number
): boolean {
  /* 1 — cone AABB vs box. */
  if (!aabbOverlap(coneBounds(ox, oy, oz, nx, ny, nz, range, halfAngle), box)) return false;

  /* 3 — apex inside the box. */
  if (pointInAabb(ox, oy, oz, box)) return true;

  /* 2 — nearest point beyond range. */
  const nearSq = pointAabbDistanceSq(ox, oy, oz, box);
  if (nearSq > range * range) return false;

  /* 4 — the axis passes through. */
  if (segmentIntersectsAabb(ox, oy, oz, nx, ny, nz, range, box)) return true;

  /* 5 — nearest point inside the cone. */
  const nearX = ox < box.minX ? box.minX : ox > box.maxX ? box.maxX : ox;
  const nearY = oy < box.minY ? box.minY : oy > box.maxY ? box.maxY : oy;
  const nearZ = oz < box.minZ ? box.minZ : oz > box.maxZ ? box.maxZ : oz;
  if (pointInCone(nearX - ox, nearY - oy, nearZ - oz, nx, ny, nz, range, halfAngle)) return true;

  /* 6 — any corner inside the cone. */
  for (let c = 0; c < 8; c++) {
    const px = (c & 1) === 0 ? box.minX : box.maxX;
    const py = (c & 2) === 0 ? box.minY : box.maxY;
    const pz = (c & 4) === 0 ? box.minZ : box.maxZ;
    if (pointInCone(px - ox, py - oy, pz - oz, nx, ny, nz, range, halfAngle)) return true;
  }

  /* 7 — bounding sphere of the box. */
  const cx = (box.minX + box.maxX) * 0.5 - ox;
  const cy = (box.minY + box.maxY) * 0.5 - oy;
  const cz = (box.minZ + box.maxZ) * 0.5 - oz;
  const hx = (box.maxX - box.minX) * 0.5;
  const hy = (box.maxY - box.minY) * 0.5;
  const hz = (box.maxZ - box.minZ) * 0.5;
  const boundingRadius = Math.sqrt(hx * hx + hy * hy + hz * hz);
  if (!sphereInCone(cx, cy, cz, boundingRadius, nx, ny, nz, range, halfAngle)) return false;

  /* 8 — dot / distance bound on the smallest off-axis angle. */
  // max of dot(P - O, N) over the box: pick the per-axis extreme by sign of N.
  const maxDot =
    (nx >= 0 ? box.maxX - ox : box.minX - ox) * nx +
    (ny >= 0 ? box.maxY - oy : box.minY - oy) * ny +
    (nz >= 0 ? box.maxZ - oz : box.minZ - oz) * nz;
  const nearDist = Math.sqrt(nearSq);
  const farDist = Math.sqrt(pointAabbFarthestSq(ox, oy, oz, box));
  // dot <= maxDot and |P - O| >= nearDist, so for a positive numerator the
  // ratio is bounded above by maxDot / nearDist. For a negative numerator the
  // least-negative bound divides by the LARGEST distance instead.
  let cosUpper: number;
  if (maxDot >= 0) {
    cosUpper = nearDist < CONE_EPSILON ? 1 : Math.min(1, maxDot / nearDist);
  } else {
    cosUpper = farDist < CONE_EPSILON ? -1 : maxDot / farDist;
  }
  return cosUpper >= Math.cos(halfAngle);
}

/**
 * BRUTE FORCE REFERENCE for `aabbInCone`.
 *
 * Dense lattice over the box, inclusive of faces, edges and corners, plus the
 * apex-inside-box case. As with `sphereInConeBrute`, sampling can only miss —
 * so a `true` here is proof, and `aabbInCone` must never disagree with it.
 */
export function aabbInConeBrute(
  box: ICombatAabb,
  ox: number,
  oy: number,
  oz: number,
  nx: number,
  ny: number,
  nz: number,
  range: number,
  halfAngle: number,
  steps = 12
): boolean {
  if (pointInAabb(ox, oy, oz, box)) return true;
  const sx = (box.maxX - box.minX) / steps;
  const sy = (box.maxY - box.minY) / steps;
  const sz = (box.maxZ - box.minZ) / steps;
  for (let i = 0; i <= steps; i++) {
    const px = box.minX + sx * i - ox;
    for (let j = 0; j <= steps; j++) {
      const py = box.minY + sy * j - oy;
      for (let k = 0; k <= steps; k++) {
        const pz = box.minZ + sz * k - oz;
        if (pointInCone(px, py, pz, nx, ny, nz, range, halfAngle)) return true;
      }
    }
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Radial (the ground slam)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * EXACT sphere-vs-sphere. The ground slam is the radial version of the same
 * resolution, so it shares the pipeline and differs only in this predicate.
 */
export function sphereInSphere(
  cx: number,
  cy: number,
  cz: number,
  r: number,
  radius: number
): boolean {
  const limit = radius + r;
  return cx * cx + cy * cy + cz * cz <= limit * limit;
}

/** EXACT box-vs-sphere: the box's nearest point is within the radius. */
export function aabbInSphere(
  box: ICombatAabb,
  ox: number,
  oy: number,
  oz: number,
  radius: number
): boolean {
  return pointAabbDistanceSq(ox, oy, oz, box) <= radius * radius;
}

/* -------------------------------------------------------------------------- */
/* Vector helpers                                                             */
/* -------------------------------------------------------------------------- */

/** A normalised direction plus the original length. */
export interface INormalised {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly length: number;
}

/**
 * Normalise a direction. A zero-length direction falls back to world -Z, which
 * is the engine's forward — a punch with no aim still has to go somewhere, and
 * silently producing NaN would poison every downstream event.
 */
export function normalise(x: number, y: number, z: number): INormalised {
  const length = Math.sqrt(x * x + y * y + z * z);
  if (length < CONE_EPSILON) return { x: 0, y: 0, z: -1, length: 0 };
  const inv = 1 / length;
  return { x: x * inv, y: y * inv, z: z * inv, length };
}
