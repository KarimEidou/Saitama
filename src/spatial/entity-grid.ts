/**
 * DYNAMIC ENTITY GRID — 24 m CELLS, REBUILT EVERY FRAME
 *
 * Static geometry gets a quadtree because it is inserted once and queried
 * forever. Moving actors are the opposite: a few hundred of them, all of which
 * move every frame. Incrementally maintaining a tree for that means a remove
 * and a re-insert per entity per frame, plus pointer chasing, to accelerate a
 * set small enough that the constant factor dominates.
 *
 * A uniform grid rebuilt from scratch each frame wins outright at this scale:
 * `fill(0)` over 4096 counters, one counting-sort pass, and every query then
 * reads contiguous Int32 runs. No allocation, no tree maintenance, no stale
 * state to invalidate — and the rebuild is O(n) with a tiny constant.
 *
 * ── USAGE (once per frame, before any query) ────────────────────────────────
 *     grid.beginFrame();
 *     for (const e of entities) grid.add(e, x, y, z, e.radius, layerBit);
 *     grid.build();
 *     grid.queryRadius(px, py, pz, 12, out);
 *     grid.queryCone(px, py, pz, dx, dy, dz, 18, Math.PI / 4, out);
 *
 * ── WHAT IS AND IS NOT HERE ────────────────────────────────────────────────
 * The cone query exists because the shockwave needs cone-vs-entity broad phase.
 * It returns slots; deciding what a hit MEANS — damage, knockback, lethality —
 * belongs to combat, and nothing in this file knows those concepts. Layers are
 * an opaque uint32 bitmask the caller assigns; this module never interprets
 * them as factions.
 */

import { ENTITY_CELL_SIZE, ENTITY_GRID_DIM, WORLD_MIN } from './constants';
import type { IndexList } from './index-list';

/** Bitmask matching every layer. */
export const ALL_LAYERS = 0xffffffff;

/** Per-frame occupancy summary for the debug HUD. */
export interface IEntityGridStats {
  readonly entities: number;
  readonly cells: number;
  readonly occupiedCells: number;
  readonly maxPerCell: number;
  readonly capacity: number;
}

export class DynamicEntityGrid {
  readonly cellSize: number;
  readonly dim: number;
  readonly originX: number;
  readonly originZ: number;
  private readonly cellCount: number;

  /* ---- per-entity, indexed by slot ---- */
  private posX: Float32Array;
  private posY: Float32Array;
  private posZ: Float32Array;
  private radius: Float32Array;
  private layer: Uint32Array;
  private cell: Int32Array;
  private refs: (unknown | undefined)[];
  private capacity: number;
  private count = 0;

  /* ---- CSR buckets ---- */
  private readonly cellStart: Int32Array;
  private readonly cellCursor: Int32Array;
  private slotsByCell: Int32Array;

  /**
   * Largest radius added this frame. Query ranges are widened by it so that an
   * entity binned by its CENTRE is still found when only its volume reaches
   * into range — the alternative, inserting each entity into every cell it
   * overlaps, costs more than the widening ever saves at these radii.
   */
  private maxRadius = 0;
  private built = false;

  constructor(capacity = 512, cellSize = ENTITY_CELL_SIZE, dim = ENTITY_GRID_DIM, origin = WORLD_MIN) {
    this.cellSize = cellSize;
    this.dim = dim;
    this.originX = origin;
    this.originZ = origin;
    this.cellCount = dim * dim;

    this.capacity = Math.max(16, capacity);
    this.posX = new Float32Array(this.capacity);
    this.posY = new Float32Array(this.capacity);
    this.posZ = new Float32Array(this.capacity);
    this.radius = new Float32Array(this.capacity);
    this.layer = new Uint32Array(this.capacity);
    this.cell = new Int32Array(this.capacity);
    this.refs = new Array<unknown>(this.capacity);

    this.cellStart = new Int32Array(this.cellCount + 1);
    this.cellCursor = new Int32Array(this.cellCount);
    this.slotsByCell = new Int32Array(this.capacity);
  }

  /** Entities added this frame. */
  get size(): number {
    return this.count;
  }

  /** Discard the previous frame. Cheap: one counter fill. */
  beginFrame(): void {
    this.count = 0;
    this.maxRadius = 0;
    this.built = false;
    this.cellStart.fill(0);
  }

  /**
   * Register one entity. Positions outside the world are clamped into the edge
   * cells rather than dropped: an actor knocked out of the map by a punch must
   * still be findable.
   *
   * @returns The slot, valid until the next `beginFrame`.
   */
  add(ref: unknown, x: number, y: number, z: number, radius = 0, layer = 1): number {
    if (this.count === this.capacity) this.grow();

    const slot = this.count++;
    this.posX[slot] = x;
    this.posY[slot] = y;
    this.posZ[slot] = z;
    this.radius[slot] = radius;
    this.layer[slot] = layer >>> 0;
    this.refs[slot] = ref;
    if (radius > this.maxRadius) this.maxRadius = radius;

    const cell = this.cellOf(x, z);
    this.cell[slot] = cell;
    // First pass of the counting sort: cellStart[c + 1] accumulates counts.
    this.cellStart[cell + 1] = this.cellStart[cell + 1]! + 1;
    return slot;
  }

  /** Finish the counting sort. Must run after the last `add`. */
  build(): void {
    const start = this.cellStart;
    for (let c = 0; c < this.cellCount; c++) start[c + 1] = start[c + 1]! + start[c]!;
    this.cellCursor.set(start.subarray(0, this.cellCount));

    if (this.slotsByCell.length < this.count) {
      this.slotsByCell = new Int32Array(Math.max(this.count, this.capacity));
    }
    for (let slot = 0; slot < this.count; slot++) {
      const c = this.cell[slot]!;
      const at = this.cellCursor[c]!;
      this.slotsByCell[at] = slot;
      this.cellCursor[c] = at + 1;
    }
    this.built = true;
  }

  private grow(): void {
    const next = this.capacity * 2;
    const copyF32 = (src: Float32Array): Float32Array => {
      const dst = new Float32Array(next);
      dst.set(src);
      return dst;
    };
    this.posX = copyF32(this.posX);
    this.posY = copyF32(this.posY);
    this.posZ = copyF32(this.posZ);
    this.radius = copyF32(this.radius);
    const layer = new Uint32Array(next);
    layer.set(this.layer);
    this.layer = layer;
    const cell = new Int32Array(next);
    cell.set(this.cell);
    this.cell = cell;
    this.refs.length = next;
    this.capacity = next;
  }

  private cellOf(x: number, z: number): number {
    let gx = Math.floor((x - this.originX) / this.cellSize);
    let gz = Math.floor((z - this.originZ) / this.cellSize);
    if (gx < 0) gx = 0;
    else if (gx >= this.dim) gx = this.dim - 1;
    if (gz < 0) gz = 0;
    else if (gz >= this.dim) gz = this.dim - 1;
    return gz * this.dim + gx;
  }

  /* ------------------------------------------------------------------ */
  /* Accessors                                                          */
  /* ------------------------------------------------------------------ */

  getRef(slot: number): unknown {
    return this.refs[slot];
  }

  getX(slot: number): number {
    return this.posX[slot]!;
  }

  getY(slot: number): number {
    return this.posY[slot]!;
  }

  getZ(slot: number): number {
    return this.posZ[slot]!;
  }

  getRadius(slot: number): number {
    return this.radius[slot]!;
  }

  getLayer(slot: number): number {
    return this.layer[slot]!;
  }

  /* ------------------------------------------------------------------ */
  /* Queries                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Entities whose bounding sphere intersects the query sphere.
   *
   * Predicate: `distance(centres) <= range + entityRadius`. `queryRadiusBrute`
   * applies the identical predicate to every entity, so the two return the same
   * set by construction and the test is really checking the cell pruning.
   */
  queryRadius(
    x: number,
    y: number,
    z: number,
    range: number,
    out: IndexList,
    layerMask = ALL_LAYERS
  ): number {
    out.clear();
    if (!this.built || this.count === 0) return 0;

    const reach = range + this.maxRadius;
    const gx0 = this.clampCell(Math.floor((x - reach - this.originX) / this.cellSize));
    const gx1 = this.clampCell(Math.floor((x + reach - this.originX) / this.cellSize));
    const gz0 = this.clampCell(Math.floor((z - reach - this.originZ) / this.cellSize));
    const gz1 = this.clampCell(Math.floor((z + reach - this.originZ) / this.cellSize));

    const start = this.cellStart;
    const slots = this.slotsByCell;

    for (let gz = gz0; gz <= gz1; gz++) {
      const row = gz * this.dim;
      for (let gx = gx0; gx <= gx1; gx++) {
        const c = row + gx;
        const from = start[c]!;
        const to = start[c + 1]!;
        for (let i = from; i < to; i++) {
          const slot = slots[i]!;
          if ((this.layer[slot]! & layerMask) === 0) continue;
          const dx = this.posX[slot]! - x;
          const dy = this.posY[slot]! - y;
          const dz = this.posZ[slot]! - z;
          const limit = range + this.radius[slot]!;
          if (dx * dx + dy * dy + dz * dz <= limit * limit) out.push(slot);
        }
      }
    }
    return out.length;
  }

  /** Reference implementation of `queryRadius`. */
  queryRadiusBrute(
    x: number,
    y: number,
    z: number,
    range: number,
    out: IndexList,
    layerMask = ALL_LAYERS
  ): number {
    out.clear();
    for (let slot = 0; slot < this.count; slot++) {
      if ((this.layer[slot]! & layerMask) === 0) continue;
      const dx = this.posX[slot]! - x;
      const dy = this.posY[slot]! - y;
      const dz = this.posZ[slot]! - z;
      const limit = range + this.radius[slot]!;
      if (dx * dx + dy * dy + dz * dz <= limit * limit) out.push(slot);
    }
    return out.length;
  }

  /**
   * Entities whose bounding sphere intersects a cone — the broad phase behind
   * the shockwave and behind any directional AI awareness check.
   *
   * `direction` need not be normalised. `halfAngle` is measured from the axis,
   * so a 90-degree fan is `halfAngle = PI / 4`.
   *
   * Cells are pruned by their nearest corner only. An angular cell rejection is
   * possible but not worth it: at combat ranges (10-30 m) the cone's XZ box
   * spans two or three cells, so the exact per-entity test below already runs
   * on a handful of candidates.
   */
  queryCone(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    range: number,
    halfAngle: number,
    out: IndexList,
    layerMask = ALL_LAYERS
  ): number {
    out.clear();
    if (!this.built || this.count === 0) return 0;

    const dLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dLen === 0) return 0;
    const nx = dx / dLen;
    const ny = dy / dLen;
    const nz = dz / dLen;

    const reach = range + this.maxRadius;
    const gx0 = this.clampCell(Math.floor((ox - reach - this.originX) / this.cellSize));
    const gx1 = this.clampCell(Math.floor((ox + reach - this.originX) / this.cellSize));
    const gz0 = this.clampCell(Math.floor((oz - reach - this.originZ) / this.cellSize));
    const gz1 = this.clampCell(Math.floor((oz + reach - this.originZ) / this.cellSize));

    const start = this.cellStart;
    const slots = this.slotsByCell;
    const reachSq = reach * reach;

    for (let gz = gz0; gz <= gz1; gz++) {
      const cellMinZ = this.originZ + gz * this.cellSize;
      const cellMaxZ = cellMinZ + this.cellSize;
      const ddz = oz < cellMinZ ? cellMinZ - oz : oz > cellMaxZ ? oz - cellMaxZ : 0;
      const row = gz * this.dim;

      for (let gx = gx0; gx <= gx1; gx++) {
        const cellMinX = this.originX + gx * this.cellSize;
        const cellMaxX = cellMinX + this.cellSize;
        const ddx = ox < cellMinX ? cellMinX - ox : ox > cellMaxX ? ox - cellMaxX : 0;
        if (ddx * ddx + ddz * ddz > reachSq) continue;

        const c = row + gx;
        const from = start[c]!;
        const to = start[c + 1]!;
        for (let i = from; i < to; i++) {
          const slot = slots[i]!;
          if ((this.layer[slot]! & layerMask) === 0) continue;
          if (
            sphereInCone(
              this.posX[slot]! - ox,
              this.posY[slot]! - oy,
              this.posZ[slot]! - oz,
              this.radius[slot]!,
              nx,
              ny,
              nz,
              range,
              halfAngle
            )
          ) {
            out.push(slot);
          }
        }
      }
    }
    return out.length;
  }

  /** Reference implementation of `queryCone`. */
  queryConeBrute(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    range: number,
    halfAngle: number,
    out: IndexList,
    layerMask = ALL_LAYERS
  ): number {
    out.clear();
    const dLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dLen === 0) return 0;
    const nx = dx / dLen;
    const ny = dy / dLen;
    const nz = dz / dLen;

    for (let slot = 0; slot < this.count; slot++) {
      if ((this.layer[slot]! & layerMask) === 0) continue;
      if (
        sphereInCone(
          this.posX[slot]! - ox,
          this.posY[slot]! - oy,
          this.posZ[slot]! - oz,
          this.radius[slot]!,
          nx,
          ny,
          nz,
          range,
          halfAngle
        )
      ) {
        out.push(slot);
      }
    }
    return out.length;
  }

  /**
   * Nearest entity to a point within `range`, or -1.
   * Searches outward one ring of cells at a time and stops as soon as the next
   * ring cannot contain anything closer.
   */
  queryNearest(x: number, y: number, z: number, range: number, layerMask = ALL_LAYERS): number {
    if (!this.built || this.count === 0) return -1;

    const centreGx = this.clampCell(Math.floor((x - this.originX) / this.cellSize));
    const centreGz = this.clampCell(Math.floor((z - this.originZ) / this.cellSize));
    const maxRing = Math.ceil((range + this.maxRadius) / this.cellSize);

    let best = -1;
    let bestDistSq = (range + this.maxRadius) * (range + this.maxRadius);
    const start = this.cellStart;
    const slots = this.slotsByCell;

    for (let ring = 0; ring <= maxRing; ring++) {
      // Anything in a farther ring is at least this far away.
      const ringFloor = (ring - 1) * this.cellSize;
      if (best >= 0 && ringFloor > 0 && ringFloor * ringFloor > bestDistSq) break;

      for (let gz = centreGz - ring; gz <= centreGz + ring; gz++) {
        if (gz < 0 || gz >= this.dim) continue;
        const onZEdge = gz === centreGz - ring || gz === centreGz + ring;
        for (let gx = centreGx - ring; gx <= centreGx + ring; gx++) {
          if (gx < 0 || gx >= this.dim) continue;
          // Only the perimeter of the ring is new.
          if (!onZEdge && gx !== centreGx - ring && gx !== centreGx + ring) continue;

          const c = gz * this.dim + gx;
          const from = start[c]!;
          const to = start[c + 1]!;
          for (let i = from; i < to; i++) {
            const slot = slots[i]!;
            if ((this.layer[slot]! & layerMask) === 0) continue;
            const dx = this.posX[slot]! - x;
            const dy = this.posY[slot]! - y;
            const dz = this.posZ[slot]! - z;
            const d2 = dx * dx + dy * dy + dz * dz;
            const limit = range + this.radius[slot]!;
            if (d2 <= limit * limit && d2 < bestDistSq) {
              bestDistSq = d2;
              best = slot;
            }
          }
        }
      }
    }
    return best;
  }

  private clampCell(v: number): number {
    return v < 0 ? 0 : v >= this.dim ? this.dim - 1 : v;
  }

  stats(): IEntityGridStats {
    let occupied = 0;
    let max = 0;
    if (this.built) {
      for (let c = 0; c < this.cellCount; c++) {
        const n = this.cellStart[c + 1]! - this.cellStart[c]!;
        if (n > 0) occupied++;
        if (n > max) max = n;
      }
    }
    return {
      entities: this.count,
      cells: this.cellCount,
      occupiedCells: occupied,
      maxPerCell: max,
      capacity: this.capacity,
    };
  }
}

/**
 * Sphere-vs-cone intersection, apex at the origin.
 *
 * `(cx, cy, cz)` is the sphere centre RELATIVE to the apex and `(nx, ny, nz)`
 * is the unit axis. Three cases, in the order that resolves them cheapest:
 *
 *  1. beyond `range + r` along any direction — reject on distance alone;
 *  2. apex inside the sphere — accept, the cone starts inside the target;
 *  3. otherwise compare the centre's angle off-axis against the half-angle
 *     widened by `asin(r / d)`, the angular radius the sphere subtends.
 *
 * Case 3 is the standard conservative sphere-cone test. It slightly over-
 * accepts spheres straddling the cone's rim near the apex, which is the correct
 * direction to err for a broad phase.
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
