/**
 * POLYGON PRIMITIVES FOR CITY LAYOUT
 *
 * Everything the layout stage needs to reason about parcels, zones and lots on
 * the XZ plane, written against plain `[x, z]` tuples rather than
 * `THREE.Vector2`.
 *
 * The tuple choice is deliberate: block outlines, zone polygons and lot
 * rectangles all travel through the plan JSON and (eventually) across a worker
 * boundary. Plain arrays of numbers structured-clone for free and serialise
 * byte-identically; `THREE.Vector2` instances do neither. Conversion to Three
 * types happens once, at the very edge, in `runtime.ts`.
 *
 * WINDING: counter-clockwise is positive area in this file's convention, which
 * matches `ICityBlock.outline` in `src/types/world.ts`. Note that "CCW" here is
 * in the (x, z) plane read as a standard 2D plane — viewed from +Y looking
 * down at a right-handed Y-up world it appears clockwise. That is fine and
 * consistent; what matters is that every producer and consumer agrees.
 */

/** A point on the ground plane: `[x, z]` in world metres. */
export type Vec2 = readonly [number, number];

/** A closed polygon. The final vertex is NOT repeated. */
export type Polygon = readonly Vec2[];

/** Axis-aligned rectangle on the ground plane. */
export interface IRect2 {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

/* -------------------------------------------------------------------------- */
/* Basic measures                                                             */
/* -------------------------------------------------------------------------- */

/** Signed area via the shoelace formula. Positive when counter-clockwise. */
export function polygonArea(poly: Polygon): number {
  let sum = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum * 0.5;
}

/** Area-weighted centroid. Falls back to the vertex mean for degenerate rings. */
export function polygonCentroid(poly: Polygon): Vec2 {
  const area = polygonArea(poly);
  if (Math.abs(area) < 1e-9) {
    let sx = 0;
    let sz = 0;
    for (const p of poly) {
      sx += p[0];
      sz += p[1];
    }
    const n = Math.max(1, poly.length);
    return [sx / n, sz / n];
  }
  let cx = 0;
  let cz = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const cross = a[0] * b[1] - b[0] * a[1];
    cx += (a[0] + b[0]) * cross;
    cz += (a[1] + b[1]) * cross;
  }
  return [cx / (6 * area), cz / (6 * area)];
}

/** Axis-aligned bounds. Throws on an empty ring rather than returning NaN. */
export function polygonBounds(poly: Polygon): IRect2 {
  if (poly.length === 0) throw new Error('polygonBounds: empty polygon');
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of poly) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1];
    if (p[1] > maxZ) maxZ = p[1];
  }
  return { minX, minZ, maxX, maxZ };
}

/** Total edge length. */
export function polygonPerimeter(poly: Polygon): number {
  let total = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return total;
}

/** Ensure counter-clockwise winding, reversing a copy when necessary. */
export function ensureCCW(poly: Polygon): Polygon {
  return polygonArea(poly) < 0 ? poly.slice().reverse() : poly;
}

/* -------------------------------------------------------------------------- */
/* Containment                                                                */
/* -------------------------------------------------------------------------- */

/** Crossing-number point-in-polygon. Boundary results are unspecified. */
export function pointInPolygon(poly: Polygon, x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a[1] > z !== b[1] > z) {
      const t = (z - a[1]) / (b[1] - a[1]);
      if (x < a[0] + t * (b[0] - a[0])) inside = !inside;
    }
  }
  return inside;
}

/** True when the rectangle is entirely inside the polygon (corner test). */
export function rectInPolygon(poly: Polygon, rect: IRect2): boolean {
  return (
    pointInPolygon(poly, rect.minX, rect.minZ) &&
    pointInPolygon(poly, rect.maxX, rect.minZ) &&
    pointInPolygon(poly, rect.maxX, rect.maxZ) &&
    pointInPolygon(poly, rect.minX, rect.maxZ)
  );
}

/** Squared distance from a point to the closest polygon edge. */
export function distanceToPolygonEdgeSq(poly: Polygon, x: number, z: number): number {
  let best = Infinity;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const lenSq = dx * dx + dz * dz;
    let t = lenSq > 0 ? ((x - a[0]) * dx + (z - a[1]) * dz) / lenSq : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a[0] + dx * t - x;
    const pz = a[1] + dz * t - z;
    const d = px * px + pz * pz;
    if (d < best) best = d;
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/* Construction                                                               */
/* -------------------------------------------------------------------------- */

/** Rectangle as a CCW polygon. */
export function rectPolygon(rect: IRect2): Polygon {
  return [
    [rect.minX, rect.minZ],
    [rect.maxX, rect.minZ],
    [rect.maxX, rect.maxZ],
    [rect.minX, rect.maxZ],
  ];
}

/**
 * Inset a rectangle by a per-edge amount. Edge order is
 * `[west(-X), east(+X), north(-Z), south(+Z)]`, which is how the plan records
 * the road half-widths that bound a block.
 */
export function insetRect(
  rect: IRect2,
  west: number,
  east: number,
  north: number,
  south: number
): IRect2 {
  return {
    minX: rect.minX + west,
    maxX: rect.maxX - east,
    minZ: rect.minZ + north,
    maxZ: rect.maxZ - south,
  };
}

/**
 * Uniform inward offset by mitring each edge inwards along its normal and
 * re-intersecting adjacent edges.
 *
 * Correct for convex rings, which is all the layout produces (block outlines,
 * chamfered corners, lot rectangles). It is NOT a general straight-skeleton
 * offset — a concave ring offset past its own medial axis will self-intersect.
 * Callers offset by at most a couple of metres, well inside that limit.
 */
export function offsetPolygon(poly: Polygon, distance: number): Polygon {
  const n = poly.length;
  if (n < 3) return poly;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n];
    const cur = poly[i];
    const next = poly[(i + 1) % n];

    const n1 = edgeInwardNormal(prev, cur);
    const n2 = edgeInwardNormal(cur, next);

    // Mitre direction is the normalised sum of the two edge normals; the mitre
    // length divides by cos(half-angle) so the offset distance is exact.
    let mx = n1[0] + n2[0];
    let mz = n1[1] + n2[1];
    const len = Math.hypot(mx, mz);
    if (len < 1e-9) {
      out.push([cur[0] + n1[0] * distance, cur[1] + n1[1] * distance]);
      continue;
    }
    mx /= len;
    mz /= len;
    const cos = mx * n1[0] + mz * n1[1];
    const scale = distance / Math.max(0.2, cos);
    out.push([cur[0] + mx * scale, cur[1] + mz * scale]);
  }
  return out;
}

/** Inward unit normal of edge a->b for a CCW ring. */
function edgeInwardNormal(a: Vec2, b: Vec2): Vec2 {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len = Math.hypot(dx, dz);
  if (len < 1e-9) return [0, 0];
  // Left-hand normal of the travel direction points inwards for CCW winding.
  return [-dz / len, dx / len];
}

/** Outward unit normal of edge a->b for a CCW ring. */
export function edgeOutwardNormal(a: Vec2, b: Vec2): Vec2 {
  const n = edgeInwardNormal(a, b);
  return [-n[0], -n[1]];
}

/**
 * Replace each corner with a short chamfer of the given length. Used to give
 * downtown parcels the cut corners that real dense blocks have, which reads far
 * better than perfect right angles at street level.
 */
export function chamferPolygon(poly: Polygon, amount: number): Polygon {
  const n = poly.length;
  if (n < 3 || amount <= 0) return poly;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n];
    const cur = poly[i];
    const next = poly[(i + 1) % n];
    out.push(lerpTowards(cur, prev, amount));
    out.push(lerpTowards(cur, next, amount));
  }
  return out;
}

function lerpTowards(from: Vec2, to: Vec2, distance: number): Vec2 {
  const dx = to[0] - from[0];
  const dz = to[1] - from[1];
  const len = Math.hypot(dx, dz);
  if (len < 1e-9) return from;
  const t = Math.min(0.45, distance / len);
  return [from[0] + dx * t, from[1] + dz * t];
}

/** Regular n-gon, CCW, used for park and crater zone rings. */
export function circlePolygon(cx: number, cz: number, radius: number, segments: number): Polygon {
  const out: Vec2[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    out.push([cx + Math.cos(a) * radius, cz + Math.sin(a) * radius]);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Triangulation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Ear-clipping triangulation of a simple polygon. Returns index triples into
 * the input ring, wound CCW to match the input.
 *
 * Ear clipping rather than a library: the rings here are small (4–24 vertices),
 * the whole thing must run inside a worker with no dependencies, and the output
 * has to be bit-stable across devices — a deterministic O(n^2) clip is the right
 * trade at this size.
 */
export function triangulate(poly: Polygon): number[] {
  const n = poly.length;
  const out: number[] = [];
  if (n < 3) return out;
  if (n === 3) return [0, 1, 2];

  const ccw = polygonArea(poly) > 0;
  const remaining: number[] = [];
  for (let i = 0; i < n; i++) remaining.push(ccw ? i : n - 1 - i);

  let guard = 0;
  while (remaining.length > 3 && guard++ < n * n + 16) {
    let clipped = false;
    for (let i = 0; i < remaining.length; i++) {
      const i0 = remaining[(i - 1 + remaining.length) % remaining.length];
      const i1 = remaining[i];
      const i2 = remaining[(i + 1) % remaining.length];
      if (isEar(poly, remaining, i0, i1, i2)) {
        out.push(i0, i1, i2);
        remaining.splice(i, 1);
        clipped = true;
        break;
      }
    }
    // No ear found: the ring is self-intersecting or numerically degenerate.
    // Fan from the first vertex so the caller still gets covering geometry.
    if (!clipped) break;
  }
  if (remaining.length === 3) {
    out.push(remaining[0], remaining[1], remaining[2]);
  } else if (remaining.length > 3) {
    for (let i = 1; i < remaining.length - 1; i++) {
      out.push(remaining[0], remaining[i], remaining[i + 1]);
    }
  }
  return out;
}

function isEar(poly: Polygon, remaining: readonly number[], i0: number, i1: number, i2: number) {
  const a = poly[i0];
  const b = poly[i1];
  const c = poly[i2];
  const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (cross <= 1e-9) return false; // reflex or collinear
  for (const idx of remaining) {
    if (idx === i0 || idx === i1 || idx === i2) continue;
    const p = poly[idx];
    if (pointInTriangle(p, a, b, c)) return false;
  }
  return true;
}

function pointInTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const d1 = sign(p, a, b);
  const d2 = sign(p, b, c);
  const d3 = sign(p, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function sign(p: Vec2, a: Vec2, b: Vec2): number {
  return (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
}

/* -------------------------------------------------------------------------- */
/* Splines                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Resample a control polyline as a centripetal Catmull-Rom spline.
 *
 * Centripetal (alpha = 0.5) rather than uniform: uniform Catmull-Rom overshoots
 * and self-intersects when control points are unevenly spaced, which is exactly
 * what a hand-authored road graph produces.
 */
export function resampleSpline(points: Polygon, spacing: number): Vec2[] {
  if (points.length < 2) return points.slice();
  if (points.length === 2) return resampleLine(points[0], points[1], spacing);

  const out: Vec2[] = [];
  const n = points.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(n - 1, i + 2)];
    const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const steps = Math.max(1, Math.round(segLen / spacing));
    for (let s = 0; s < steps; s++) {
      out.push(catmullRom(p0, p1, p2, p3, s / steps));
    }
  }
  out.push(points[n - 1]);
  return out;
}

function resampleLine(a: Vec2, b: Vec2, spacing: number): Vec2[] {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const steps = Math.max(1, Math.round(len / spacing));
  const out: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

function catmullRom(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const t2 = t * t;
  const t3 = t2 * t;
  const f = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])];
}
