/**
 * FRUSTUM WITH PLANE-MASK COHERENCY
 *
 * `THREE.Frustum` only answers "is this box visible?". Hierarchical culling
 * needs a third answer — "is this box *entirely* inside?" — because that is
 * what turns a tree walk into a win:
 *
 *   OUTSIDE      discard the node and its whole subtree, untested.
 *   INSIDE       accept the node's whole subtree, untested.
 *   INTERSECTING descend, but only against the planes that are still ambiguous.
 *
 * The third refinement is the plane mask. If a parent box lies completely on
 * the inside of plane k, every descendant does too, so plane k is cleared from
 * the mask handed to the children and is never evaluated again in that subtree.
 * A node deep in a large visible region typically ends up testing one or two
 * planes instead of six.
 *
 * ── WHY THIS STAYS EXACT ───────────────────────────────────────────────────
 * A false negative here means geometry pops out of existence, so the skipping
 * has to be provably safe, not merely plausible:
 *
 *   Node bounds are the union of the item bounds beneath them, so every item
 *   box C satisfies C ⊆ P for its ancestor P. For a plane normal n,
 *   dot(n, pVertex(C)) >= dot(n, nVertex(C)) >= dot(n, nVertex(P)). Clearing
 *   plane k required dot(n_k, nVertex(P)) + d_k >= 0, therefore
 *   dot(n_k, pVertex(C)) + d_k >= 0 — the item passes plane k as well.
 *
 * The inequality survives floating point because every step is monotone in
 * IEEE-754 (products of a fixed-sign factor, and additions), PROVIDED both
 * sides evaluate the dot product in the same order. That is why
 * `dotPlane()` exists and why nothing in this file inlines it differently.
 *
 * ── THREE BOX REPRESENTATIONS, ON PURPOSE ──────────────────────────────────
 *   testBox / classifyBox              six scalars — the readable API
 *   testPacked / classifyPacked        six floats at an offset, corner choice
 *                                      resolved through precomputed indices
 *   classifyCentreExtent               centre + half-extent, one dot product
 *                                      per plane instead of two
 *
 * They are not redundant. `testPacked` is bit-identical to `testBox` and is
 * what BOTH the quadtree and its brute-force reference use per item, which is
 * what keeps their outputs provably equal. `classifyCentreExtent` rounds
 * differently and is therefore restricted to NODE bounds, where callers store
 * an inflated extent so every conclusion stays conservative.
 */

import type * as THREE from 'three';

/** Box lies entirely outside at least one plane. */
export const OUTSIDE = 0;
/** Box straddles at least one plane and is not rejected. */
export const INTERSECTING = 1;
/** Box lies entirely inside all six planes. */
export const INSIDE = 2;

/** All six planes still ambiguous — the mask to start a walk with. */
export const ALL_PLANES = 0b111111;

/** Plane slot order, matching `THREE.Frustum`. */
export const PLANE_RIGHT = 0;
export const PLANE_LEFT = 1;
export const PLANE_BOTTOM = 2;
export const PLANE_TOP = 3;
export const PLANE_FAR = 4;
export const PLANE_NEAR = 5;

/**
 * Signed distance from a plane to a point, evaluated in ONE fixed order.
 *
 * Do not inline or reassociate this. The exactness argument at the top of the
 * file depends on the accelerated path and the brute-force path producing
 * bit-identical values.
 */
function dotPlane(
  nx: number,
  ny: number,
  nz: number,
  d: number,
  x: number,
  y: number,
  z: number
): number {
  return nx * x + ny * y + nz * z + d;
}

/** Column-major 4x4 multiply, `out = a * b`. Avoids a runtime three import. */
function multiplyMatrices(a: ArrayLike<number>, b: ArrayLike<number>, out: Float64Array): void {
  for (let col = 0; col < 4; col++) {
    const b0 = b[col * 4]!;
    const b1 = b[col * 4 + 1]!;
    const b2 = b[col * 4 + 2]!;
    const b3 = b[col * 4 + 3]!;
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[row]! * b0 + a[4 + row]! * b1 + a[8 + row]! * b2 + a[12 + row]! * b3;
    }
  }
}

/**
 * Six view-frustum planes in world space, stored as `nx ny nz d` quadruples in
 * one Float32Array. Normals point INWARD: a point is inside when
 * `n · p + d >= 0`, matching `THREE.Plane.distanceToPoint`.
 */
export class Frustum {
  /** 6 planes x (nx, ny, nz, d). */
  readonly planes = new Float32Array(24);

  /**
   * Per plane, the three offsets into a packed `minX minY minZ maxX maxY maxZ`
   * box that select its positive vertex — the corner farthest along the inward
   * normal. `nIndex` selects the opposite corner.
   *
   * Which corner to take depends only on the SIGNS OF THE PLANE NORMAL, which
   * are fixed for the whole cull. Resolving them once here turns the inner
   * loop's `nx >= 0 ? maxX : minX` — three unpredictable branches per dot
   * product, thirty-six per node classification — into three indexed loads.
   * On the culling benchmark that is the difference between an 80 ns node test
   * and a 30 ns one, and the node test is what the whole hierarchy is paying
   * for.
   */
  private readonly pIndex = new Int32Array(18);
  private readonly nIndex = new Int32Array(18);

  /**
   * `|nx| |ny| |nz|` per plane, for the centre/extent classification.
   *
   * Public because `Quadtree.cullFrustum` hoists these into locals and inlines
   * the node classification: node testing is tree-only code with no
   * counterpart in the brute-force reference, so making it as fast as possible
   * is exactly the hierarchy's job.
   */
  readonly planesAbs = new Float32Array(18);

  /** Scratch for `setFromCamera`; a field so the call never allocates. */
  private readonly viewProjection = new Float64Array(16);

  /**
   * Gribb-Hartmann extraction from a column-major view-projection matrix.
   * Planes are normalised so `n · p + d` is a true signed distance in metres,
   * which the near-plane distance sort and the debug overlay both rely on.
   */
  setFromViewProjection(e: ArrayLike<number>): this {
    const m11 = e[0]!;
    const m21 = e[1]!;
    const m31 = e[2]!;
    const m41 = e[3]!;
    const m12 = e[4]!;
    const m22 = e[5]!;
    const m32 = e[6]!;
    const m42 = e[7]!;
    const m13 = e[8]!;
    const m23 = e[9]!;
    const m33 = e[10]!;
    const m43 = e[11]!;
    const m14 = e[12]!;
    const m24 = e[13]!;
    const m34 = e[14]!;
    const m44 = e[15]!;

    this.setPlane(PLANE_RIGHT, m41 - m11, m42 - m12, m43 - m13, m44 - m14);
    this.setPlane(PLANE_LEFT, m41 + m11, m42 + m12, m43 + m13, m44 + m14);
    this.setPlane(PLANE_BOTTOM, m41 + m21, m42 + m22, m43 + m23, m44 + m24);
    this.setPlane(PLANE_TOP, m41 - m21, m42 - m22, m43 - m23, m44 - m24);
    this.setPlane(PLANE_FAR, m41 - m31, m42 - m32, m43 - m33, m44 - m34);
    this.setPlane(PLANE_NEAR, m41 + m31, m42 + m32, m43 + m33, m44 + m34);
    return this;
  }

  /**
   * Extract from a camera. `camera.updateMatrixWorld()` and
   * `camera.updateProjectionMatrix()` must already have run this frame.
   */
  setFromCamera(camera: THREE.Camera): this {
    multiplyMatrices(
      camera.projectionMatrix.elements,
      camera.matrixWorldInverse.elements,
      this.viewProjection
    );
    return this.setFromViewProjection(this.viewProjection);
  }

  /** Overwrite one plane, normalising the normal and refreshing its vertex
   * selectors. */
  setPlane(slot: number, nx: number, ny: number, nz: number, d: number): void {
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    const inv = len > 0 ? 1 / len : 0;
    const o = slot * 4;
    this.planes[o] = nx * inv;
    this.planes[o + 1] = ny * inv;
    this.planes[o + 2] = nz * inv;
    this.planes[o + 3] = d * inv;

    // Read the STORED float32 components back: the selectors must agree with
    // the values the dot products will actually use, including any sign change
    // a denormal flush could theoretically introduce.
    const sx = this.planes[o]!;
    const sy = this.planes[o + 1]!;
    const sz = this.planes[o + 2]!;
    const i = slot * 3;
    this.planesAbs[i] = sx < 0 ? -sx : sx;
    this.planesAbs[i + 1] = sy < 0 ? -sy : sy;
    this.planesAbs[i + 2] = sz < 0 ? -sz : sz;
    this.pIndex[i] = sx >= 0 ? 3 : 0;
    this.pIndex[i + 1] = sy >= 0 ? 4 : 1;
    this.pIndex[i + 2] = sz >= 0 ? 5 : 2;
    this.nIndex[i] = sx >= 0 ? 0 : 3;
    this.nIndex[i + 1] = sy >= 0 ? 1 : 4;
    this.nIndex[i + 2] = sz >= 0 ? 2 : 5;
  }

  /** Copy planes from another frustum. */
  copy(other: Frustum): this {
    this.planes.set(other.planes);
    return this;
  }

  /** True when the point is on the inside of all six planes. */
  containsPoint(x: number, y: number, z: number): boolean {
    const p = this.planes;
    for (let i = 0; i < 6; i++) {
      const o = i * 4;
      if (dotPlane(p[o]!, p[o + 1]!, p[o + 2]!, p[o + 3]!, x, y, z) < 0) return false;
    }
    return true;
  }

  /**
   * THE per-item visibility test — p-vertex only, over the planes still set in
   * `mask`. This is the predicate the brute-force reference uses (with
   * `mask = ALL_PLANES`) and the predicate the tree walk uses on the items it
   * reaches, which is what makes the two produce identical sets.
   */
  testBox(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    mask: number = ALL_PLANES
  ): boolean {
    const p = this.planes;
    for (let i = 0; i < 6; i++) {
      if ((mask & (1 << i)) === 0) continue;
      const o = i * 4;
      const nx = p[o]!;
      const ny = p[o + 1]!;
      const nz = p[o + 2]!;
      if (
        dotPlane(
          nx,
          ny,
          nz,
          p[o + 3]!,
          nx >= 0 ? maxX : minX,
          ny >= 0 ? maxY : minY,
          nz >= 0 ? maxZ : minZ
        ) < 0
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * Three-way classification plus the refined plane mask for the children.
   *
   * Returns a packed int: `(childMask << 2) | code`, where code is
   * OUTSIDE / INTERSECTING / INSIDE. Packing avoids returning an object or
   * writing to a shared mutable field, both of which cost more than the shift
   * in a loop that runs thousands of times a frame.
   */
  classifyBox(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    mask: number = ALL_PLANES
  ): number {
    const p = this.planes;
    let remaining = mask;

    for (let i = 0; i < 6; i++) {
      const bit = 1 << i;
      if ((remaining & bit) === 0) continue;

      const o = i * 4;
      const nx = p[o]!;
      const ny = p[o + 1]!;
      const nz = p[o + 2]!;
      const d = p[o + 3]!;

      // Positive vertex: the corner farthest along the inward normal. If even
      // that corner is behind the plane the whole box is outside.
      if (
        dotPlane(nx, ny, nz, d, nx >= 0 ? maxX : minX, ny >= 0 ? maxY : minY, nz >= 0 ? maxZ : minZ) <
        0
      ) {
        return OUTSIDE;
      }

      // Negative vertex: the corner nearest the plane. Inside means the whole
      // box clears this plane, so descendants never need to test it again.
      if (
        dotPlane(nx, ny, nz, d, nx >= 0 ? minX : maxX, ny >= 0 ? minY : maxY, nz >= 0 ? minZ : maxZ) >=
        0
      ) {
        remaining &= ~bit;
      }
    }

    return remaining === 0 ? INSIDE : (remaining << 2) | INTERSECTING;
  }

  /**
   * `testBox` against a box stored as six consecutive floats at `offset`.
   *
   * Identical arithmetic to `testBox` — the same corner, the same operand
   * order — with the vertex choice resolved through `pIndex` instead of a
   * branch. Both the tree walk and the brute-force reference call THIS, so the
   * two remain provably set-identical while both run at full speed.
   */
  testPacked(bounds: ArrayLike<number>, offset: number, mask: number = ALL_PLANES): boolean {
    const p = this.planes;
    const pi = this.pIndex;
    for (let i = 0; i < 6; i++) {
      if ((mask & (1 << i)) === 0) continue;
      const o = i * 4;
      const k = i * 3;
      if (
        p[o]! * bounds[offset + pi[k]!]! +
          p[o + 1]! * bounds[offset + pi[k + 1]!]! +
          p[o + 2]! * bounds[offset + pi[k + 2]!]! +
          p[o + 3]! <
        0
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * `classifyBox` against a packed box, using the precomputed vertex
   * selectors. The node test used by the quadtree walk.
   */
  classifyPacked(bounds: ArrayLike<number>, offset: number, mask: number = ALL_PLANES): number {
    const p = this.planes;
    const pi = this.pIndex;
    const ni = this.nIndex;
    let remaining = mask;

    for (let i = 0; i < 6; i++) {
      const bit = 1 << i;
      if ((remaining & bit) === 0) continue;
      const o = i * 4;
      const k = i * 3;
      const nx = p[o]!;
      const ny = p[o + 1]!;
      const nz = p[o + 2]!;
      const d = p[o + 3]!;

      if (
        nx * bounds[offset + pi[k]!]! +
          ny * bounds[offset + pi[k + 1]!]! +
          nz * bounds[offset + pi[k + 2]!]! +
          d <
        0
      ) {
        return OUTSIDE;
      }

      if (
        nx * bounds[offset + ni[k]!]! +
          ny * bounds[offset + ni[k + 1]!]! +
          nz * bounds[offset + ni[k + 2]!]! +
          d >=
        0
      ) {
        remaining &= ~bit;
      }
    }

    return remaining === 0 ? INSIDE : (remaining << 2) | INTERSECTING;
  }

  /**
   * Three-way classification of a box given as CENTRE and HALF-EXTENT, same
   * packed encoding as `classifyBox`. This is the node test the quadtree walk
   * uses, and the representation change is the point.
   *
   * With min/max corners a node costs two dot products per plane — one for the
   * positive vertex, one for the negative — plus three unpredictable branches
   * each to pick the corners: twelve dot products and thirty-six branches per
   * node. With centre and half-extent the SAME two answers fall out of one dot
   * product and one projected radius:
   *
   *     dc = n · centre + d          signed distance of the centre
   *     r  = |n| · extent            the box's radius along the normal
   *     outside this plane   <=>  dc + r <  0
   *     inside this plane    <=>  dc - r >= 0
   *
   * Six mults and five adds per plane, no branches, no corner selection. That
   * turns the node test from roughly five times the cost of an item test into
   * roughly the same cost — which is precisely the ratio that decides whether
   * a hierarchy beats a linear scan by 6x or by 25x.
   *
   * ── SAFETY ─────────────────────────────────────────────────────────────
   * `dc ± r` is mathematically identical to the corner dot products but rounds
   * differently, so this is NOT bit-identical to `classifyPacked`. It is only
   * ever applied to NODE bounds, and callers store those with an inflated
   * extent (see `Quadtree.updateNodeExtents`) so the classified box strictly
   * encloses every item beneath it by a margin orders of magnitude above the
   * rounding. Both conclusions therefore remain conservative, and the per-item
   * predicate — which is what the brute-force reference also runs — is
   * untouched.
   */
  classifyCentreExtent(ce: ArrayLike<number>, offset: number, mask: number = ALL_PLANES): number {
    const p = this.planes;
    const pa = this.planesAbs;
    const cx = ce[offset]!;
    const cy = ce[offset + 1]!;
    const cz = ce[offset + 2]!;
    const ex = ce[offset + 3]!;
    const ey = ce[offset + 4]!;
    const ez = ce[offset + 5]!;
    let remaining = mask;

    for (let i = 0; i < 6; i++) {
      const bit = 1 << i;
      if ((remaining & bit) === 0) continue;
      const o = i * 4;
      const k = i * 3;
      const dc = p[o]! * cx + p[o + 1]! * cy + p[o + 2]! * cz + p[o + 3]!;
      const r = pa[k]! * ex + pa[k + 1]! * ey + pa[k + 2]! * ez;
      if (dc + r < 0) return OUTSIDE;
      if (dc - r >= 0) remaining &= ~bit;
    }

    return remaining === 0 ? INSIDE : (remaining << 2) | INTERSECTING;
  }

  /** Signed distance from the near plane; negative is behind the camera. */
  distanceToNearPlane(x: number, y: number, z: number): number {
    const o = PLANE_NEAR * 4;
    const p = this.planes;
    return dotPlane(p[o]!, p[o + 1]!, p[o + 2]!, p[o + 3]!, x, y, z);
  }
}

/** Unpack the classification code from `classifyBox`. */
export function classifyCode(packed: number): number {
  return packed & 3;
}

/** Unpack the refined child plane mask from `classifyBox`. */
export function classifyMask(packed: number): number {
  return packed >>> 2;
}

const VIEW_SCRATCH = new Float64Array(16);
const PROJ_SCRATCH = new Float64Array(16);

/**
 * Build a perspective view-projection matrix without constructing a
 * `THREE.Camera`. Used by tests, the PVS cull-rate measurement and the harness
 * so they can sweep thousands of camera poses cheaply.
 *
 * @param out 16 floats, column-major, ready for `setFromViewProjection`.
 */
export function composeViewProjection(
  out: Float64Array,
  eyeX: number,
  eyeY: number,
  eyeZ: number,
  yaw: number,
  pitch: number,
  fovYRadians: number,
  aspect: number,
  near: number,
  far: number
): Float64Array {
  // Forward from yaw/pitch. yaw 0 looks down -Z, matching three's default.
  const cp = Math.cos(pitch);
  const fx = -Math.sin(yaw) * cp;
  const fy = Math.sin(pitch);
  const fz = -Math.cos(yaw) * cp;

  // Right = normalize(cross(forward, worldUp)), worldUp = +Y.
  let rx = -fz;
  let ry = 0;
  let rz = fx;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl;
  ry /= rl;
  rz /= rl;

  // Up = cross(right, forward).
  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;

  // View matrix (world -> camera), column-major.
  const v = VIEW_SCRATCH;
  v[0] = rx;
  v[1] = ux;
  v[2] = -fx;
  v[3] = 0;
  v[4] = ry;
  v[5] = uy;
  v[6] = -fy;
  v[7] = 0;
  v[8] = rz;
  v[9] = uz;
  v[10] = -fz;
  v[11] = 0;
  v[12] = -(rx * eyeX + ry * eyeY + rz * eyeZ);
  v[13] = -(ux * eyeX + uy * eyeY + uz * eyeZ);
  v[14] = fx * eyeX + fy * eyeY + fz * eyeZ;
  v[15] = 1;

  // Perspective projection, WebGL depth range [-1, 1], column-major.
  const f = 1 / Math.tan(fovYRadians * 0.5);
  const p = PROJ_SCRATCH;
  p.fill(0);
  p[0] = f / aspect;
  p[5] = f;
  p[10] = (far + near) / (near - far);
  p[11] = -1;
  p[14] = (2 * far * near) / (near - far);

  multiplyMatrices(p, v, out);
  return out;
}
