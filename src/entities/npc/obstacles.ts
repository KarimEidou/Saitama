/**
 * OBSTACLE FIELD — what a pedestrian cannot walk through, and cannot see through
 *
 * Three questions, one data structure:
 *
 *   1. NAVIGATION  which field cells are blocked, so the flow field routes
 *                  round buildings instead of through them;
 *   2. CONTAINMENT after integration, is this agent inside a wall, and where
 *                  is the nearest way out;
 *   3. VISIBILITY  is there a clear line between these two points, which is
 *                  what makes a save WITNESSED and a threat SEEN.
 *
 * ── WHY A RASTER AND A RECT LIST, NOT ONE OR THE OTHER ────────────────────
 * The raster answers "is this cell walkable" in one array read, which is what
 * a 16,384-cell BFS at 4 Hz needs. But a raster cannot push an agent out of a
 * wall accurately — the best it can do is snap to a 12 m cell centre, which
 * teleports a pedestrian across the pavement. So the exact rectangles are kept
 * alongside, bucketed by cell, and containment/push-out uses those. Each
 * structure does the job it is good at.
 *
 * ── LINE OF SIGHT IS A DDA, NOT A RECT SWEEP ──────────────────────────────
 * Visibility runs over the raster with a grid DDA: at 12 m cells a 55 m sight
 * line touches five cells, so the test is five array reads. Sweeping the rect
 * list instead would be exact but would cost a segment-vs-AABB test per
 * building in the neighbourhood, dozens of them, for a query that runs once
 * per civilian per save. The raster is conservative in the useful direction —
 * it can only call a marginal sightline blocked, never a blocked one clear.
 */

import { clamp } from '@/util';
import {
  FIELD_CELL,
  FIELD_COUNT,
  FIELD_DIM,
  FIELD_ORIGIN,
  SIGHT_RANGE,
} from './constants';
import type { IObstacleRect } from './types';

/** World X of a field cell's centre. */
export function cellCentreX(gx: number): number {
  return FIELD_ORIGIN + (gx + 0.5) * FIELD_CELL;
}

/** World Z of a field cell's centre. */
export function cellCentreZ(gz: number): number {
  return FIELD_ORIGIN + (gz + 0.5) * FIELD_CELL;
}

/** Field column for a world X, clamped into the grid. */
export function cellX(x: number): number {
  return clamp(Math.floor((x - FIELD_ORIGIN) / FIELD_CELL), 0, FIELD_DIM - 1);
}

/** Field row for a world Z, clamped into the grid. */
export function cellZ(z: number): number {
  return clamp(Math.floor((z - FIELD_ORIGIN) / FIELD_CELL), 0, FIELD_DIM - 1);
}

/** Flat cell index for a world position. */
export function cellIndexAt(x: number, z: number): number {
  return cellZ(z) * FIELD_DIM + cellX(x);
}

/**
 * Blocked geometry over the field grid.
 *
 * Rebuilt when the resident chunk set changes, which is rare — a chunk stream
 * or a building collapse, not every frame.
 */
export class ObstacleField {
  /** 1 where a building covers enough of the cell to be impassable. */
  readonly blocked = new Uint8Array(FIELD_COUNT);
  /** Chebyshev cells to the nearest blocked cell, saturating at 3. */
  readonly clearance = new Uint8Array(FIELD_COUNT);

  private readonly rects: IObstacleRect[] = [];
  /** CSR buckets: rect indices per cell. Built once per rebuild. */
  private cellStart = new Int32Array(FIELD_COUNT + 1);
  private cellRects = new Int32Array(0);
  /** Bumped on every rebuild so dependent fields know to invalidate. */
  private version = 0;

  /** Monotonic rebuild counter. */
  get revision(): number {
    return this.version;
  }

  /** Rectangles currently registered. */
  get rectCount(): number {
    return this.rects.length;
  }

  /** Drop everything. */
  clear(): void {
    this.rects.length = 0;
    this.blocked.fill(0);
    this.clearance.fill(3);
    this.cellStart.fill(0);
    this.cellRects = new Int32Array(0);
    this.version++;
  }

  /**
   * Replace the obstacle set.
   *
   * @param rects Building footprints in world XZ. Copied; the caller may reuse.
   */
  rebuild(rects: readonly IObstacleRect[]): void {
    this.rects.length = 0;
    for (const rect of rects) this.rects.push(rect);
    this.rasterise();
    this.bucket();
    this.computeClearance();
    this.version++;
  }

  /**
   * Mark cells a rectangle covers.
   *
   * A cell counts as blocked when the rectangle covers its CENTRE, not when it
   * merely touches the cell. Blocking on touch would close every 6 m alley in
   * the city — at 12 m cells a building edge clips the neighbouring cell
   * almost everywhere — and a crowd that cannot use the alleys funnels into
   * the avenues and jams. Under-blocking is corrected by the exact rectangle
   * containment test, which runs on the agent's real position.
   */
  private rasterise(): void {
    this.blocked.fill(0);
    for (const rect of this.rects) {
      const gx0 = cellX(rect.minX);
      const gx1 = cellX(rect.maxX);
      const gz0 = cellZ(rect.minZ);
      const gz1 = cellZ(rect.maxZ);
      for (let gz = gz0; gz <= gz1; gz++) {
        const cz = cellCentreZ(gz);
        if (cz < rect.minZ || cz > rect.maxZ) continue;
        const row = gz * FIELD_DIM;
        for (let gx = gx0; gx <= gx1; gx++) {
          const cx = cellCentreX(gx);
          if (cx < rect.minX || cx > rect.maxX) continue;
          this.blocked[row + gx] = 1;
        }
      }
    }
  }

  /** Counting sort of rect indices into the cells each rect overlaps. */
  private bucket(): void {
    this.cellStart.fill(0);
    let total = 0;
    for (const rect of this.rects) {
      const gx0 = cellX(rect.minX);
      const gx1 = cellX(rect.maxX);
      const gz0 = cellZ(rect.minZ);
      const gz1 = cellZ(rect.maxZ);
      for (let gz = gz0; gz <= gz1; gz++) {
        const row = gz * FIELD_DIM;
        for (let gx = gx0; gx <= gx1; gx++) {
          this.cellStart[row + gx + 1]!++;
          total++;
        }
      }
    }
    for (let c = 0; c < FIELD_COUNT; c++) {
      this.cellStart[c + 1] = this.cellStart[c + 1]! + this.cellStart[c]!;
    }
    this.cellRects = new Int32Array(total);
    const cursor = new Int32Array(FIELD_COUNT);
    cursor.set(this.cellStart.subarray(0, FIELD_COUNT));
    for (let i = 0; i < this.rects.length; i++) {
      const rect = this.rects[i]!;
      const gx0 = cellX(rect.minX);
      const gx1 = cellX(rect.maxX);
      const gz0 = cellZ(rect.minZ);
      const gz1 = cellZ(rect.maxZ);
      for (let gz = gz0; gz <= gz1; gz++) {
        const row = gz * FIELD_DIM;
        for (let gx = gx0; gx <= gx1; gx++) {
          const c = row + gx;
          this.cellRects[cursor[c]!] = i;
          cursor[c] = cursor[c]! + 1;
        }
      }
    }
  }

  /**
   * Chebyshev distance to the nearest blocked cell, saturated at 3.
   *
   * Two chamfer sweeps rather than a BFS: the values are tiny and saturating,
   * and a forward-then-backward pass over a 128x128 grid is 32,768 min
   * operations with perfect locality.
   */
  private computeClearance(): void {
    const c = this.clearance;
    const b = this.blocked;
    const MAX = 3;
    for (let i = 0; i < FIELD_COUNT; i++) c[i] = b[i] === 1 ? 0 : MAX;

    for (let gz = 0; gz < FIELD_DIM; gz++) {
      const row = gz * FIELD_DIM;
      for (let gx = 0; gx < FIELD_DIM; gx++) {
        const i = row + gx;
        if (c[i] === 0) continue;
        let best = c[i]!;
        if (gx > 0) best = Math.min(best, c[i - 1]! + 1);
        if (gz > 0) best = Math.min(best, c[i - FIELD_DIM]! + 1);
        if (gx > 0 && gz > 0) best = Math.min(best, c[i - FIELD_DIM - 1]! + 1);
        if (gx < FIELD_DIM - 1 && gz > 0) best = Math.min(best, c[i - FIELD_DIM + 1]! + 1);
        c[i] = Math.min(best, MAX);
      }
    }
    for (let gz = FIELD_DIM - 1; gz >= 0; gz--) {
      const row = gz * FIELD_DIM;
      for (let gx = FIELD_DIM - 1; gx >= 0; gx--) {
        const i = row + gx;
        if (c[i] === 0) continue;
        let best = c[i]!;
        if (gx < FIELD_DIM - 1) best = Math.min(best, c[i + 1]! + 1);
        if (gz < FIELD_DIM - 1) best = Math.min(best, c[i + FIELD_DIM]! + 1);
        if (gx < FIELD_DIM - 1 && gz < FIELD_DIM - 1) {
          best = Math.min(best, c[i + FIELD_DIM + 1]! + 1);
        }
        if (gx > 0 && gz < FIELD_DIM - 1) best = Math.min(best, c[i + FIELD_DIM - 1]! + 1);
        c[i] = Math.min(best, MAX);
      }
    }
  }

  /** True when a field cell is passable. */
  isWalkableCell(index: number): boolean {
    return this.blocked[index] === 0;
  }

  /** True when a world position is not inside any building. */
  isWalkable(x: number, z: number, margin = 0): boolean {
    return this.rectAt(x, z, margin) < 0;
  }

  /** Index of the first rectangle containing a point (inflated by `margin`). */
  rectAt(x: number, z: number, margin = 0): number {
    const c = cellIndexAt(x, z);
    const from = this.cellStart[c]!;
    const to = this.cellStart[c + 1]!;
    for (let i = from; i < to; i++) {
      const r = this.rects[this.cellRects[i]!]!;
      if (
        x >= r.minX - margin &&
        x <= r.maxX + margin &&
        z >= r.minZ - margin &&
        z <= r.maxZ + margin
      ) {
        return this.cellRects[i]!;
      }
    }
    return -1;
  }

  /** Rectangle by index. */
  rect(index: number): IObstacleRect | undefined {
    return this.rects[index];
  }

  /**
   * Push a point out of any building it has ended up inside.
   *
   * Exits through the NEAREST face. Exiting through the face the agent came in
   * by would need a swept test and a previous position; the nearest face is
   * both cheaper and better behaved at corners, where the swept answer flips
   * between two faces on floating-point noise.
   *
   * @returns Metres the point moved. Zero when it was already clear.
   */
  resolve(out: { x: number; z: number }, margin = 0): number {
    let moved = 0;
    // Two passes: leaving one building can land inside its neighbour across a
    // 2 m alley. More than two is wasted — the third pass has never fired in
    // the layouts this ships with.
    for (let pass = 0; pass < 2; pass++) {
      const hit = this.rectAt(out.x, out.z, margin);
      if (hit < 0) break;
      const r = this.rects[hit]!;
      const dxMin = out.x - (r.minX - margin);
      const dxMax = r.maxX + margin - out.x;
      const dzMin = out.z - (r.minZ - margin);
      const dzMax = r.maxZ + margin - out.z;
      const best = Math.min(dxMin, dxMax, dzMin, dzMax);
      if (best === dxMin) out.x = r.minX - margin;
      else if (best === dxMax) out.x = r.maxX + margin;
      else if (best === dzMin) out.z = r.minZ - margin;
      else out.z = r.maxZ + margin;
      moved += best;
    }
    return moved;
  }

  /**
   * True when nothing blocks the segment between two world points.
   *
   * Amanatides-Woo DDA over the raster. Both endpoints' own cells are ignored:
   * an agent standing in a cell the raster calls blocked (it happens on the
   * pavement beside a large building) must still be able to see out, and the
   * alternative is a witness test that silently reports nobody ever sees
   * anything.
   */
  segmentClear(ax: number, az: number, bx: number, bz: number, maxDistance = SIGHT_RANGE): boolean {
    const dx = bx - ax;
    const dz = bz - az;
    const distSq = dx * dx + dz * dz;
    if (distSq > maxDistance * maxDistance) return false;
    if (distSq < 1e-8) return true;

    let gx = cellX(ax);
    let gz = cellZ(az);
    const endX = cellX(bx);
    const endZ = cellZ(bz);
    if (gx === endX && gz === endZ) return true;

    const stepX = dx > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const invDx = dx === 0 ? Infinity : 1 / dx;
    const invDz = dz === 0 ? Infinity : 1 / dz;

    const nextBoundaryX = FIELD_ORIGIN + (gx + (dx > 0 ? 1 : 0)) * FIELD_CELL;
    const nextBoundaryZ = FIELD_ORIGIN + (gz + (dz > 0 ? 1 : 0)) * FIELD_CELL;
    let tMaxX = dx === 0 ? Infinity : (nextBoundaryX - ax) * invDx;
    let tMaxZ = dz === 0 ? Infinity : (nextBoundaryZ - az) * invDz;
    const tDeltaX = dx === 0 ? Infinity : FIELD_CELL * Math.abs(invDx);
    const tDeltaZ = dz === 0 ? Infinity : FIELD_CELL * Math.abs(invDz);

    // Bounded so a degenerate ray can never spin: the grid is 128 cells across,
    // so no segment crosses more than 256 of them.
    for (let guard = 0; guard < FIELD_DIM * 2; guard++) {
      if (tMaxX < tMaxZ) {
        gx += stepX;
        tMaxX += tDeltaX;
      } else {
        gz += stepZ;
        tMaxZ += tDeltaZ;
      }
      if (gx < 0 || gz < 0 || gx >= FIELD_DIM || gz >= FIELD_DIM) return false;
      if (gx === endX && gz === endZ) return true;
      if (this.blocked[gz * FIELD_DIM + gx] === 1) return false;
    }
    return false;
  }
}
