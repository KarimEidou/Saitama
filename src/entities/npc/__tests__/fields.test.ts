/**
 * OBSTACLES AND THE FLOW FIELD
 *
 * The two claims worth proving here are the ones a screenshot cannot show:
 *
 *   1. every trajectory the field defines TERMINATES, with no cycles — a
 *      two-cell limit cycle looks like a knot of civilians jittering on a
 *      corner while everybody else streams past, and it is invisible until it
 *      happens in front of a player;
 *   2. no direction ever points into a wall, which is the difference between
 *      "walks round the building" and "walks into the building and is then
 *      shoved back out by the containment pass every frame".
 */

import { describe, it, expect, vi } from 'vitest';
import { FlowField, type IDirectionField } from '../flow-field';
import { ObstacleField, cellCentreX, cellCentreZ, cellX, cellZ } from '../obstacles';
import {
  COST_UNREACHABLE,
  FIELD_DIM,
  STEP_DIAG,
  STEP_ORTHO,
  FIELD_CELL,
  WALL_HUG_PENALTY,
} from '../constants';
import { cityRects, singleBlock, threatAt } from './fixtures';

/**
 * The per-cell arrival penalty, read back out of a settled cost field.
 *
 * Dial's relaxation is `cost(cell) = min over neighbours (cost(n) + step +
 * penalty(cell))`, so `cost(cell) - cost(n) - step` is at most the penalty for
 * every neighbour and exactly the penalty for the one that settled it. Taking
 * the maximum recovers the penalty without reaching inside `FlowField`, and
 * without depending on where the commute goals happened to land.
 */
function arrivalPenalty(
  field: IDirectionField,
  obstacles: ObstacleField,
  x: number,
  z: number
): number {
  const gx = cellX(x);
  const gz = cellZ(z);
  const here = field.cost[gz * FIELD_DIM + gx]!;
  let best = -Infinity;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dz === 0) continue;
      const nx = gx + dx;
      const nz = gz + dz;
      if (nx < 0 || nz < 0 || nx >= FIELD_DIM || nz >= FIELD_DIM) continue;
      const n = nz * FIELD_DIM + nx;
      if (!obstacles.isWalkableCell(n)) continue;
      const cost = field.cost[n]!;
      if (cost === COST_UNREACHABLE) continue;
      const step = dx !== 0 && dz !== 0 ? STEP_DIAG : STEP_ORTHO;
      best = Math.max(best, here - cost - step);
    }
  }
  return best;
}

// These simulate hundreds of frames of a 250-agent crowd. Vitest's default
// five-second budget is comfortable on an idle machine and not comfortable at
// all when a dozen other workstreams are compiling on the same box, and a test
// that fails on CPU contention is worse than no test.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe('ObstacleField', () => {
  it('blocks the cells a building covers and leaves the street open', () => {
    const obstacles = new ObstacleField();
    obstacles.rebuild(singleBlock(0, 0, 30));
    expect(obstacles.isWalkable(0, 0)).toBe(false);
    expect(obstacles.isWalkable(60, 0)).toBe(true);
    expect(obstacles.isWalkableCell(cellZ(0) * FIELD_DIM + cellX(0))).toBe(false);
  });

  it('reports a clearance ramp away from geometry', () => {
    const obstacles = new ObstacleField();
    obstacles.rebuild(singleBlock(0, 0, 30));
    const at = (x: number, z: number): number =>
      obstacles.clearance[cellZ(z) * FIELD_DIM + cellX(x)]!;
    expect(at(0, 0)).toBe(0);
    expect(at(42, 0)).toBeLessThan(3);
    expect(at(200, 200)).toBe(3);
  });

  it('pushes a point out through the nearest face', () => {
    const obstacles = new ObstacleField();
    obstacles.rebuild(singleBlock(0, 0, 20));
    // Just inside the +X face.
    const point = { x: 18, z: 2 };
    const moved = obstacles.resolve(point, 0.3);
    expect(moved).toBeGreaterThan(0);
    // Just outside the inflated face — `resolve` adds a millimetre so the
    // point does not land exactly on a boundary the containment test counts
    // as inside.
    expect(point.x).toBeGreaterThan(20.3);
    expect(point.x).toBeLessThan(20.31);
    expect(point.z).toBe(2);
    expect(obstacles.isWalkable(point.x, point.z, 0.3)).toBe(true);
  });

  it('leaves a point that is already clear alone', () => {
    const obstacles = new ObstacleField();
    obstacles.rebuild(singleBlock(0, 0, 20));
    const point = { x: 40, z: 40 };
    expect(obstacles.resolve(point, 0.3)).toBe(0);
    expect(point).toEqual({ x: 40, z: 40 });
  });

  it('blocks line of sight through a building and allows it down the street', () => {
    const obstacles = new ObstacleField();
    obstacles.rebuild(singleBlock(0, 0, 30));
    // Straight through the middle.
    expect(obstacles.segmentClear(-60, 0, 60, 0, 200)).toBe(false);
    // Parallel to it, well clear.
    expect(obstacles.segmentClear(-60, 60, 60, 60, 200)).toBe(true);
    // Beyond sight range.
    expect(obstacles.segmentClear(-60, 60, 60, 60, 40)).toBe(false);
    // Degenerate: a point can see itself.
    expect(obstacles.segmentClear(10, 10, 10, 10)).toBe(true);
  });

  it('still contains a façade that ends just short of a cell boundary', () => {
    const obstacles = new ObstacleField();
    // Field cells are 12 m wide and start at `FIELD_ORIGIN`, so a boundary
    // sits at world x = 24. This rectangle stops 0.1 m short of it, which puts
    // its whole un-inflated AABB in the column to the LEFT of the boundary —
    // while a body standing at 24.05 is in the column to the right and is
    // 0.15 m inside its own 0.26 m margin.
    obstacles.rebuild([{ minX: 0, minZ: 0, maxX: 23.9, maxZ: 10, height: 20 }]);
    expect(cellX(23.9)).toBe(cellX(24.05) - 1);
    expect(obstacles.rectAt(24.05, 5, 0.26)).toBe(0);
    expect(obstacles.isWalkable(24.05, 5, 0.26)).toBe(false);
    // The margin is still a margin: a point genuinely clear of it is clear.
    expect(obstacles.isWalkable(24.05, 5)).toBe(true);
    expect(obstacles.isWalkable(24.5, 5, 0.26)).toBe(true);
  });

  it('bumps its revision so dependent fields know to rebuild', () => {
    const obstacles = new ObstacleField();
    const before = obstacles.revision;
    obstacles.rebuild(singleBlock(0, 0, 10));
    expect(obstacles.revision).toBeGreaterThan(before);
    expect(obstacles.rectCount).toBe(1);
    obstacles.clear();
    expect(obstacles.rectCount).toBe(0);
  });
});

describe('FlowField', () => {
  const seed = 4242;

  function build(): { flow: FlowField; obstacles: ObstacleField } {
    const obstacles = new ObstacleField();
    obstacles.rebuild(cityRects(seed, 2));
    const flow = new FlowField();
    flow.rebuild(obstacles, [threatAt(0, 0)]);
    return { flow, obstacles };
  }

  it('reaches most of the walkable city from its commute goals', () => {
    const { flow, obstacles } = build();
    let walkable = 0;
    let reached = 0;
    for (let i = 0; i < FIELD_DIM * FIELD_DIM; i++) {
      if (!obstacles.isWalkableCell(i)) continue;
      walkable++;
      if (flow.commuteA.cost[i] !== COST_UNREACHABLE) reached++;
    }
    expect(walkable).toBeGreaterThan(1000);
    expect(reached / walkable).toBeGreaterThan(0.99);
  });

  it('converges: every trajectory terminates with no cycles', () => {
    const { flow, obstacles } = build();
    for (const [field, ascend] of [
      [flow.commuteA, false],
      [flow.commuteB, false],
      [flow.flee, true],
    ] as const) {
      const report = flow.checkConvergence(field, obstacles, ascend);
      expect(report.tested).toBeGreaterThan(1000);
      expect(report.cycles).toBe(0);
      expect(report.stalled).toBe(0);
      expect(report.converged).toBe(report.tested);
    }
  });

  it('never points a walkable cell into a wall', () => {
    const { flow, obstacles } = build();
    expect(flow.countDirectionsIntoWalls(flow.commuteA, obstacles)).toBe(0);
    expect(flow.countDirectionsIntoWalls(flow.commuteB, obstacles)).toBe(0);
    expect(flow.countDirectionsIntoWalls(flow.flee, obstacles)).toBe(0);
  });

  it('routes round a building instead of through it', () => {
    const obstacles = new ObstacleField();
    obstacles.rebuild(singleBlock(0, 0, 36));
    const flow = new FlowField();
    // Threat on one side of the block; the flee cost on the far side must be
    // the way AROUND, not the straight line through.
    flow.rebuild(obstacles, [threatAt(-60, 0)]);
    const straight = 120;
    const throughCost = flow.threatDistance(60, 0);
    expect(throughCost).toBeGreaterThan(straight * 1.05);
    expect(throughCost).toBeLessThan(straight * 2.5);
  });

  it('makes the flee field increase away from the threat', () => {
    const obstacles = new ObstacleField();
    obstacles.rebuild([]);
    const flow = new FlowField();
    flow.rebuild(obstacles, [threatAt(0, 0)]);
    expect(flow.hasThreats).toBe(true);
    const near = flow.threatDistance(24, 0);
    const far = flow.threatDistance(96, 0);
    expect(far).toBeGreaterThan(near);
    // Integer cost field over 12 m cells: the answer is quantised, not exact.
    expect(Math.abs(near - 24)).toBeLessThan(FIELD_CELL);
    expect(Math.abs(far - 96)).toBeLessThan(FIELD_CELL);
  });

  it('points the flee direction away from the threat', () => {
    const obstacles = new ObstacleField();
    obstacles.rebuild([]);
    const flow = new FlowField();
    flow.rebuild(obstacles, [threatAt(0, 0)]);
    const out: [number, number] = [0, 0];
    flow.sampleDirection(flow.flee, 60, 0, out);
    // Away means +X here.
    expect(out[0]).toBeGreaterThan(0.7);
    flow.sampleDirection(flow.flee, 0, -60, out);
    expect(out[1]).toBeLessThan(-0.7);
  });

  it('keeps the commute flow off the façades', () => {
    const obstacles = new ObstacleField();
    obstacles.rebuild(singleBlock(0, 0, 36));
    const flow = new FlowField();
    flow.rebuild(obstacles, []);

    // Cell centres at 42, 54 and 66 sit one, two and three cells clear of a
    // façade that ends at x = 36. `clearance` counts a BLOCKED cell as zero,
    // so those are clearances 1, 2 and 3 — the three rungs of the documented
    // ramp, which the cost field must charge for on arrival.
    const hugging = flow.sampleCost(flow.commuteA, 42, 0);
    const oneOut = flow.sampleCost(flow.commuteA, 54, 0);
    const middle = flow.sampleCost(flow.commuteA, 66, 0);
    for (const cost of [hugging, oneOut, middle]) {
      expect(cost).not.toBe(COST_UNREACHABLE);
      // A goal cell costs nothing to arrive at and has no penalty to read.
      expect(cost).toBeGreaterThan(0);
    }

    expect(arrivalPenalty(flow.commuteA, obstacles, 42, 0)).toBe(WALL_HUG_PENALTY);
    expect(arrivalPenalty(flow.commuteA, obstacles, 54, 0)).toBe(WALL_HUG_PENALTY >> 1);
    expect(arrivalPenalty(flow.commuteA, obstacles, 66, 0)).toBe(0);
  });

  it('is a pure function of its inputs — rebuilding twice changes nothing', () => {
    const { flow, obstacles } = build();
    const before = Array.from(flow.flee.cost);
    flow.rebuild(obstacles, [threatAt(0, 0)]);
    const after = Array.from(flow.flee.cost);
    expect(after).toEqual(before);
  });

  it('handles having no threats at all', () => {
    const obstacles = new ObstacleField();
    obstacles.rebuild(singleBlock(0, 0, 24));
    const flow = new FlowField();
    flow.rebuild(obstacles, []);
    expect(flow.hasThreats).toBe(false);
    expect(flow.threatDistance(50, 50)).toBe(Infinity);
    const out: [number, number] = [1, 1];
    flow.sampleDirection(flow.flee, 50, 50, out);
    expect(out).toEqual([0, 0]);
  });

  it('rebuilds the flee field at FLOW_HZ instead of drifting slow', () => {
    // Zeroing the accumulator instead of subtracting the period throws away the
    // remainder, so fifteen frames of 1/60 sum to just under FLOW_DT, the
    // rebuild lands on the sixteenth, and the cadence is 60/16 = 3.75 Hz — 6 %
    // slow, and slow by a DIFFERENT amount at every other frame rate, which
    // makes the flee field lag the threat by a variable margin.
    const obstacles = new ObstacleField();
    obstacles.rebuild([]);
    const flow = new FlowField();
    // The first call is the obstacle-revision rebuild; start counting after it.
    flow.update(1 / 60, obstacles, []);
    const before = flow.rebuildCount;
    for (let f = 0; f < 600; f++) flow.update(1 / 60, obstacles, []);
    const rebuilds = flow.rebuildCount - before;
    // Ten seconds at FLOW_HZ, give or take the frame the clock started on.
    expect(rebuilds).toBeGreaterThanOrEqual(39);
    expect(rebuilds).toBeLessThanOrEqual(41);
  });

  it('does not bank a burst of catch-up rebuilds after a hitch', () => {
    const obstacles = new ObstacleField();
    obstacles.rebuild([]);
    const flow = new FlowField();
    flow.update(1 / 60, obstacles, []);
    const before = flow.rebuildCount;
    // A two-second stall is one rebuild's worth of work, not eight.
    flow.update(2, obstacles, []);
    expect(flow.rebuildCount - before).toBe(1);
    // And the carried remainder is capped at one period, so the debt buys a
    // single catch-up rather than a burst: one second of ordinary frames
    // afterwards is the hitch, one catch-up, and the four FLOW_HZ ticks.
    for (let f = 0; f < 60; f++) flow.update(1 / 60, obstacles, []);
    expect(flow.rebuildCount - before).toBeLessThanOrEqual(6);
    expect(flow.rebuildCount - before).toBeGreaterThanOrEqual(5);
  });

  it('costs a diagonal step more than an orthogonal one', () => {
    const obstacles = new ObstacleField();
    obstacles.rebuild([]);
    const flow = new FlowField();
    flow.rebuild(obstacles, [threatAt(0, 0)]);
    const ortho = flow.sampleCost(flow.flee, cellCentreX(cellX(0) + 4), cellCentreZ(cellZ(0)));
    const diag = flow.sampleCost(flow.flee, cellCentreX(cellX(0) + 4), cellCentreZ(cellZ(0) + 4));
    expect(diag).toBeGreaterThan(ortho);
    expect(ortho).toBeGreaterThanOrEqual(STEP_ORTHO * 4);
  });
});
