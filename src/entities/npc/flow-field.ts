/**
 * FLOW FIELD — where two hundred and fifty people are trying to get to
 *
 * Three velocity fields over the same 12 m grid, rebuilt at 4 Hz:
 *
 *   COMMUTE A / COMMUTE B  ordinary pedestrian traffic
 *   FLEE                   straight uphill, away from every live threat
 *
 * A civilian's steering is `lerp(commute, flee, alarm)`, so the transition
 * from "walking to the shops" to "running for their life" is continuous and
 * costs one lerp per agent.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY A FIELD RATHER THAN 250 PATHS
 *
 *  A* per agent is the obvious answer and it is unaffordable at this count on
 *  a phone: 250 searches, each touching hundreds of nodes, every time the
 *  monster moves. A flow field inverts the problem — one search from the
 *  goals outward, and every agent then reads a direction out of an array.
 *  Cost stops scaling with population entirely, which is exactly the property
 *  a crowd needs.
 *
 *  It also gets the CROWD behaviour right for free. Two hundred agents each
 *  following their own optimal path all take the same optimal path and file
 *  through the same doorway; agents reading a shared field spread across the
 *  street because the field is defined everywhere, and the wall-hug penalty
 *  pushes the flow off the façades into the middle of the road where people
 *  actually walk.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── WHY TWO COMMUTE FIELDS ────────────────────────────────────────────────
 * One goal set produces a crowd that walks to a spot and stops, and a city
 * of statues is worse than a city of nobody. Two interleaved goal sets, half
 * a chunk apart, let each agent alternate A -> B -> A: they arrive, flip, and
 * head off again. Pedestrian traffic that never terminates, from two integer
 * searches that only rebuild when a building falls down.
 *
 * ── DIAL'S ALGORITHM, NOT DIJKSTRA WITH A HEAP ────────────────────────────
 * Edge weights here are 10 (orthogonal), 14 (diagonal) and a wall penalty:
 * small bounded integers. That is exactly the case a bucket queue was
 * invented for — O(V·C + E) with no comparisons, no heap sift, and no
 * allocation per node. For 16,384 cells the whole search is well under a
 * millisecond, which is what makes a 4 Hz rebuild free.
 */

import {
  COST_UNREACHABLE,
  FIELD_CELL,
  FIELD_CELLS_PER_CHUNK,
  FIELD_COUNT,
  FIELD_DIM,
  FLOW_DT,
  STEP_DIAG,
  STEP_ORTHO,
  WALL_HUG_PENALTY,
} from './constants';
import { cellCentreX, cellCentreZ, cellX, cellZ } from './obstacles';
import type { ObstacleField } from './obstacles';
import type { IThreatSource } from './types';

/** Neighbour offsets: 4 orthogonal then 4 diagonal. */
const NEIGHBOUR_DX = [1, -1, 0, 0, 1, 1, -1, -1] as const;
const NEIGHBOUR_DZ = [0, 0, 1, -1, 1, -1, 1, -1] as const;
const NEIGHBOUR_COST = [
  STEP_ORTHO,
  STEP_ORTHO,
  STEP_ORTHO,
  STEP_ORTHO,
  STEP_DIAG,
  STEP_DIAG,
  STEP_DIAG,
  STEP_DIAG,
] as const;
const INV_LEN = [1, 1, 1, 1, Math.SQRT1_2, Math.SQRT1_2, Math.SQRT1_2, Math.SQRT1_2] as const;

/** Buckets needed by Dial's algorithm: one more than the largest edge weight. */
const BUCKET_COUNT = STEP_DIAG + WALL_HUG_PENALTY + 1;

/** One direction field plus the integer cost field it was derived from. */
export interface IDirectionField {
  readonly cost: Int32Array;
  readonly dirX: Float32Array;
  readonly dirZ: Float32Array;
}

/**
 * Bucket-queue shortest path over the field grid.
 *
 * Deliberately allocation-free after construction: `run` is called up to three
 * times per rebuild, twelve times a second, forever.
 */
class DialSolver {
  private readonly buckets: Int32Array[] = [];
  private readonly bucketLength = new Int32Array(BUCKET_COUNT);

  constructor() {
    for (let i = 0; i < BUCKET_COUNT; i++) this.buckets.push(new Int32Array(1024));
  }

  private push(bucket: number, cell: number): void {
    const b = bucket % BUCKET_COUNT;
    let array = this.buckets[b]!;
    const length = this.bucketLength[b]!;
    if (length === array.length) {
      const bigger = new Int32Array(array.length * 2);
      bigger.set(array);
      this.buckets[b] = bigger;
      array = bigger;
    }
    array[length] = cell;
    this.bucketLength[b] = length + 1;
  }

  /**
   * Multi-source shortest path. `cost` must be pre-filled with
   * `COST_UNREACHABLE` except at the sources, which hold 0.
   *
   * @param extra Per-cell additive penalty applied on ARRIVAL at a cell.
   */
  run(cost: Int32Array, sources: readonly number[], blocked: Uint8Array, extra: Uint8Array): void {
    this.bucketLength.fill(0);
    if (sources.length === 0) return;

    // Entries currently sitting in buckets, stale ones included. Counting
    // pushes against pops (rather than settled cells against the total) is
    // what lets the scan stop the instant the queue drains instead of walking
    // every integer up to the theoretical maximum path cost.
    let queued = 0;
    for (const source of sources) {
      if (blocked[source] === 1) continue;
      cost[source] = 0;
      this.push(0, source);
      queued++;
    }
    if (queued === 0) return;

    const maxCost = FIELD_COUNT * (STEP_DIAG + WALL_HUG_PENALTY);
    for (let d = 0; d <= maxCost; d++) {
      const b = d % BUCKET_COUNT;
      const length = this.bucketLength[b]!;
      if (length === 0) {
        if (queued === 0) break;
        continue;
      }
      const bucket = this.buckets[b]!;
      this.bucketLength[b] = 0;
      queued -= length;
      for (let i = 0; i < length; i++) {
        const cell = bucket[i]!;
        // Stale entry: this cell was re-inserted at a lower cost later.
        if (cost[cell] !== d) continue;
        const gx = cell % FIELD_DIM;
        const gz = (cell - gx) / FIELD_DIM;
        for (let n = 0; n < 8; n++) {
          const nx = gx + NEIGHBOUR_DX[n]!;
          const nz = gz + NEIGHBOUR_DZ[n]!;
          if (nx < 0 || nz < 0 || nx >= FIELD_DIM || nz >= FIELD_DIM) continue;
          const next = nz * FIELD_DIM + nx;
          if (blocked[next] === 1) continue;
          // Diagonals may not cut a building corner: both orthogonal cells
          // sharing the corner must be open, or a pedestrian slips through a
          // zero-width gap between two buildings that touch at a point.
          if (n >= 4) {
            if (blocked[gz * FIELD_DIM + nx] === 1) continue;
            if (blocked[nz * FIELD_DIM + gx] === 1) continue;
          }
          const candidate = d + NEIGHBOUR_COST[n]! + extra[next]!;
          if (candidate < cost[next]!) {
            cost[next] = candidate;
            this.push(candidate, next);
            queued++;
          }
        }
      }
    }
  }
}

export class FlowField {
  /** Commute goal set A, and the field that reaches it. */
  readonly commuteA: IDirectionField = makeField();
  /** Commute goal set B, half a chunk offset from A. */
  readonly commuteB: IDirectionField = makeField();
  /** Distance from the nearest threat; the flee field climbs it. */
  readonly flee: IDirectionField = makeField();

  /** Additive per-cell cost that keeps the flow off the façades. */
  private readonly penalty = new Uint8Array(FIELD_COUNT);
  private readonly solver = new DialSolver();
  private readonly goalsA: number[] = [];
  private readonly goalsB: number[] = [];
  private readonly threatCells: number[] = [];

  private obstacleRevision = -1;
  private accumulator = 0;
  private rebuilds = 0;
  private lastMs = 0;
  private threatsPresent = false;

  /** Flow rebuilds since construction. */
  get rebuildCount(): number {
    return this.rebuilds;
  }

  /** Milliseconds the last rebuild cost. */
  get lastRebuildMs(): number {
    return this.lastMs;
  }

  /** True when the flee field has at least one source. */
  get hasThreats(): boolean {
    return this.threatsPresent;
  }

  /**
   * Advance the rebuild clock. Call every frame; it rebuilds at `FLOW_HZ`.
   *
   * The commute fields only rebuild when the obstacle set changes — a chunk
   * streaming in or a building collapsing. Their goals do not move, so
   * recomputing them four times a second would be four times a second of
   * identical work.
   */
  update(dt: number, obstacles: ObstacleField, threats: readonly IThreatSource[]): void {
    let dirty = false;
    if (obstacles.revision !== this.obstacleRevision) {
      this.obstacleRevision = obstacles.revision;
      this.buildPenalty(obstacles);
      this.buildCommuteGoals(obstacles);
      const start = performance.now();
      this.solve(this.commuteA, this.goalsA, obstacles, false);
      this.solve(this.commuteB, this.goalsB, obstacles, false);
      this.lastMs = performance.now() - start;
      dirty = true;
    }

    this.accumulator += dt;
    if (this.accumulator >= FLOW_DT || dirty) {
      this.accumulator = 0;
      const start = performance.now();
      this.rebuildFlee(obstacles, threats);
      this.lastMs = performance.now() - start;
      this.rebuilds++;
    }
  }

  /** Force a full rebuild now. Tests and the harness drive this directly. */
  rebuild(obstacles: ObstacleField, threats: readonly IThreatSource[]): void {
    this.obstacleRevision = obstacles.revision;
    this.buildPenalty(obstacles);
    this.buildCommuteGoals(obstacles);
    const start = performance.now();
    this.solve(this.commuteA, this.goalsA, obstacles, false);
    this.solve(this.commuteB, this.goalsB, obstacles, false);
    this.rebuildFlee(obstacles, threats);
    this.lastMs = performance.now() - start;
    this.rebuilds++;
    this.accumulator = 0;
  }

  /* ------------------------------------------------------------------ */
  /* Goals                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * One commute goal per streaming chunk, per set.
   *
   * Placed at the chunk's quarter and three-quarter points rather than its
   * centre, because a chunk centre is inside the city block and therefore
   * always unwalkable — every goal would fall back to the same handful of
   * reachable cells and the whole city would commute to four street corners.
   * The quarter points sit on the street grid the layout generator produces.
   */
  private buildCommuteGoals(obstacles: ObstacleField): void {
    this.goalsA.length = 0;
    this.goalsB.length = 0;
    const per = FIELD_CELLS_PER_CHUNK;
    const quarter = Math.max(1, Math.round(per * 0.25));
    const threeQuarter = Math.max(1, Math.round(per * 0.75));
    for (let cz = 0; cz < FIELD_DIM; cz += per) {
      for (let cx = 0; cx < FIELD_DIM; cx += per) {
        const a = nearestWalkable(obstacles, cx + quarter, cz + quarter);
        if (a >= 0) this.goalsA.push(a);
        const b = nearestWalkable(obstacles, cx + threeQuarter, cz + threeQuarter);
        if (b >= 0) this.goalsB.push(b);
      }
    }
  }

  /**
   * Cost bonus for walking near a building.
   *
   * `clearance` saturates at 3 cells, so this is a three-step ramp: flush
   * against a façade is expensive, one cell off is half that, two cells or
   * more is free.
   */
  private buildPenalty(obstacles: ObstacleField): void {
    for (let i = 0; i < FIELD_COUNT; i++) {
      const clear = obstacles.clearance[i]!;
      this.penalty[i] = clear >= 2 ? 0 : clear === 1 ? (WALL_HUG_PENALTY >> 1) : WALL_HUG_PENALTY;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Solving                                                            */
  /* ------------------------------------------------------------------ */

  private rebuildFlee(obstacles: ObstacleField, threats: readonly IThreatSource[]): void {
    this.threatCells.length = 0;
    for (const threat of threats) {
      const cell = cellZ(threat.position.z) * FIELD_DIM + cellX(threat.position.x);
      const open = obstacles.isWalkableCell(cell) ? cell : nearestWalkableIndex(obstacles, cell);
      if (open >= 0) this.threatCells.push(open);
    }
    this.threatsPresent = this.threatCells.length > 0;
    this.solve(this.flee, this.threatCells, obstacles, true);
  }

  /**
   * Run one search and derive its direction field.
   *
   * @param ascend When true the direction climbs the cost field (run AWAY from
   *   the sources) instead of descending it (walk TOWARDS them).
   */
  private solve(
    field: IDirectionField,
    sources: readonly number[],
    obstacles: ObstacleField,
    ascend: boolean
  ): void {
    field.cost.fill(COST_UNREACHABLE);
    // The wall-hug penalty is a comfort tax on ordinary walking. Somebody
    // running from a monster does not care about the pavement etiquette, and
    // applying it to the flee field pushes panicking crowds into the middle of
    // junctions where they mill instead of leaving.
    this.solver.run(field.cost, sources, obstacles.blocked, ascend ? ZERO_PENALTY : this.penalty);
    this.deriveDirections(field, obstacles, ascend);
  }

  /**
   * Central-difference gradient over the eight-neighbourhood.
   *
   * Not "step to the cheapest neighbour": that quantises every direction to
   * one of eight, so a crowd crossing an open plaza forms visible diagonal
   * lanes. Weighting all eight neighbours by their cost difference produces a
   * continuous direction and the lanes disappear.
   */
  private deriveDirections(field: IDirectionField, obstacles: ObstacleField, ascend: boolean): void {
    const { cost, dirX, dirZ } = field;
    const sign = ascend ? -1 : 1;
    for (let gz = 0; gz < FIELD_DIM; gz++) {
      const row = gz * FIELD_DIM;
      for (let gx = 0; gx < FIELD_DIM; gx++) {
        const i = row + gx;
        if (obstacles.blocked[i] === 1 || cost[i] === COST_UNREACHABLE) {
          dirX[i] = 0;
          dirZ[i] = 0;
          continue;
        }
        const here = cost[i]!;
        let ax = 0;
        let az = 0;
        for (let n = 0; n < 8; n++) {
          const nx = gx + NEIGHBOUR_DX[n]!;
          const nz = gz + NEIGHBOUR_DZ[n]!;
          if (nx < 0 || nz < 0 || nx >= FIELD_DIM || nz >= FIELD_DIM) continue;
          const next = nz * FIELD_DIM + nx;
          if (obstacles.blocked[next] === 1) continue;
          const other = cost[next]!;
          if (other === COST_UNREACHABLE) continue;
          // Downhill is positive when descending, uphill when ascending.
          const drop = sign * (here - other);
          if (drop <= 0) continue;
          const scale = drop * INV_LEN[n]!;
          ax += NEIGHBOUR_DX[n]! * scale;
          az += NEIGHBOUR_DZ[n]! * scale;
        }
        const len = Math.sqrt(ax * ax + az * az);
        if (len < 1e-6) {
          dirX[i] = 0;
          dirZ[i] = 0;
          continue;
        }
        let ux = ax / len;
        let uz = az / len;

        // A weighted average of open neighbours can still aim at a BLOCKED
        // diagonal: if +X and +Z are both open and +X+Z is a building corner,
        // the mean of the two points straight at the corner. Left alone, the
        // crowd shaves every corner in the city and the containment pass shoves
        // them back out again, every frame, for ever. Drop the smaller
        // component so the flow follows the open face instead.
        const tx = cellX(cellCentreX(gx) + ux * FIELD_CELL);
        const tz = cellZ(cellCentreZ(gz) + uz * FIELD_CELL);
        if (obstacles.blocked[tz * FIELD_DIM + tx] === 1) {
          if (Math.abs(ux) >= Math.abs(uz)) {
            uz = 0;
            ux = Math.sign(ux);
          } else {
            ux = 0;
            uz = Math.sign(uz);
          }
          const rx = cellX(cellCentreX(gx) + ux * FIELD_CELL);
          const rz = cellZ(cellCentreZ(gz) + uz * FIELD_CELL);
          if (obstacles.blocked[rz * FIELD_DIM + rx] === 1) {
            ux = 0;
            uz = 0;
          }
        }
        dirX[i] = ux;
        dirZ[i] = uz;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Sampling                                                           */
  /* ------------------------------------------------------------------ */

  /** Bilinear-free nearest-cell sample of a direction field. */
  sampleDirection(field: IDirectionField, x: number, z: number, out: [number, number]): void {
    const i = cellZ(z) * FIELD_DIM + cellX(x);
    out[0] = field.dirX[i]!;
    out[1] = field.dirZ[i]!;
  }

  /** Cost at a world position, or `COST_UNREACHABLE`. */
  sampleCost(field: IDirectionField, x: number, z: number): number {
    return field.cost[cellZ(z) * FIELD_DIM + cellX(x)]!;
  }

  /** Metres from the nearest threat, following walkable ground. */
  threatDistance(x: number, z: number): number {
    const c = this.flee.cost[cellZ(z) * FIELD_DIM + cellX(x)]!;
    if (c === COST_UNREACHABLE) return Infinity;
    return (c / STEP_ORTHO) * FIELD_CELL;
  }

  /* ------------------------------------------------------------------ */
  /* Verification                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Walk the discrete field from every reachable cell and check that it
   * terminates at a source (or, for the flee field, at a local maximum)
   * without ever revisiting a cell.
   *
   * This is what "the flow field converges" MEANS operationally, and it is
   * worth asserting rather than assuming: a gradient built from a cost field
   * with a plateau in it can produce a two-cell limit cycle, and the visible
   * symptom is a knot of civilians jittering back and forth on one street
   * corner while the rest of the crowd streams past.
   */
  checkConvergence(
    field: IDirectionField,
    obstacles: ObstacleField,
    ascend: boolean
  ): IConvergenceReport {
    const visited = new Int32Array(FIELD_COUNT).fill(-1);
    let tested = 0;
    let converged = 0;
    let cycles = 0;
    let stalled = 0;
    let longest = 0;

    for (let start = 0; start < FIELD_COUNT; start++) {
      if (obstacles.blocked[start] === 1) continue;
      if (field.cost[start] === COST_UNREACHABLE) continue;
      tested++;

      let cell = start;
      let steps = 0;
      let ok = false;
      for (; steps < FIELD_DIM * 4; steps++) {
        if (visited[cell] === start) {
          cycles++;
          break;
        }
        visited[cell] = start;
        const next = this.stepCell(field, obstacles, cell, ascend);
        if (next < 0) {
          // No downhill neighbour: this is a goal (descending) or the far side
          // of the map (ascending). Either way the walk terminated.
          ok = true;
          break;
        }
        cell = next;
      }
      if (steps > longest) longest = steps;
      if (ok) converged++;
      else if (steps >= FIELD_DIM * 4) stalled++;
    }

    return { tested, converged, cycles, stalled, longestWalk: longest };
  }

  /** The cell the discrete flow moves to, or -1 at a terminus. */
  private stepCell(
    field: IDirectionField,
    obstacles: ObstacleField,
    cell: number,
    ascend: boolean
  ): number {
    const gx = cell % FIELD_DIM;
    const gz = (cell - gx) / FIELD_DIM;
    const here = field.cost[cell]!;
    let best = -1;
    let bestCost = here;
    for (let n = 0; n < 8; n++) {
      const nx = gx + NEIGHBOUR_DX[n]!;
      const nz = gz + NEIGHBOUR_DZ[n]!;
      if (nx < 0 || nz < 0 || nx >= FIELD_DIM || nz >= FIELD_DIM) continue;
      const next = nz * FIELD_DIM + nx;
      if (obstacles.blocked[next] === 1) continue;
      const other = field.cost[next]!;
      if (other === COST_UNREACHABLE) continue;
      if (ascend ? other > bestCost : other < bestCost) {
        bestCost = other;
        best = next;
      }
    }
    return best;
  }

  /** Cells whose direction points into a blocked neighbour. Must always be 0. */
  countDirectionsIntoWalls(field: IDirectionField, obstacles: ObstacleField): number {
    let bad = 0;
    for (let gz = 0; gz < FIELD_DIM; gz++) {
      const row = gz * FIELD_DIM;
      for (let gx = 0; gx < FIELD_DIM; gx++) {
        const i = row + gx;
        if (obstacles.blocked[i] === 1) continue;
        const dx = field.dirX[i]!;
        const dz = field.dirZ[i]!;
        if (dx === 0 && dz === 0) continue;
        const tx = cellX(cellCentreX(gx) + dx * FIELD_CELL);
        const tz = cellZ(cellCentreZ(gz) + dz * FIELD_CELL);
        if (obstacles.blocked[tz * FIELD_DIM + tx] === 1) bad++;
      }
    }
    return bad;
  }
}

/** Result of a convergence walk. */
export interface IConvergenceReport {
  /** Reachable walkable cells the walk started from. */
  readonly tested: number;
  /** Walks that terminated at a goal or a maximum. */
  readonly converged: number;
  /** Walks that revisited a cell. Must be zero. */
  readonly cycles: number;
  /** Walks that hit the step limit. Must be zero. */
  readonly stalled: number;
  /** Longest walk in cells. */
  readonly longestWalk: number;
}

const ZERO_PENALTY = new Uint8Array(FIELD_COUNT);

function makeField(): IDirectionField {
  return {
    cost: new Int32Array(FIELD_COUNT).fill(COST_UNREACHABLE),
    dirX: new Float32Array(FIELD_COUNT),
    dirZ: new Float32Array(FIELD_COUNT),
  };
}

/** Nearest walkable cell to a grid coordinate, searching outward. Returns -1. */
function nearestWalkable(obstacles: ObstacleField, gx: number, gz: number): number {
  const x = Math.min(FIELD_DIM - 1, Math.max(0, gx));
  const z = Math.min(FIELD_DIM - 1, Math.max(0, gz));
  return nearestWalkableIndex(obstacles, z * FIELD_DIM + x);
}

/** Ring search outward from a cell for the first walkable one. */
function nearestWalkableIndex(obstacles: ObstacleField, cell: number): number {
  if (obstacles.blocked[cell] === 0) return cell;
  const gx = cell % FIELD_DIM;
  const gz = (cell - gx) / FIELD_DIM;
  for (let r = 1; r <= 6; r++) {
    for (let dz = -r; dz <= r; dz++) {
      const nz = gz + dz;
      if (nz < 0 || nz >= FIELD_DIM) continue;
      const edge = Math.abs(dz) === r;
      for (let dx = -r; dx <= r; dx += edge ? 1 : 2 * r) {
        const nx = gx + dx;
        if (nx < 0 || nx >= FIELD_DIM) continue;
        const i = nz * FIELD_DIM + nx;
        if (obstacles.blocked[i] === 0) return i;
      }
    }
  }
  return -1;
}
