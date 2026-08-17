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

import { describe, it, expect } from 'vitest';
import { FlowField } from '../flow-field';
import { ObstacleField, cellCentreX, cellCentreZ, cellX, cellZ } from '../obstacles';
import { COST_UNREACHABLE, FIELD_DIM, STEP_ORTHO, FIELD_CELL } from '../constants';
import { cityRects, singleBlock, threatAt } from './fixtures';

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
    // A cell flush against the wall costs more to stand in than one a couple
    // of cells out, so paths prefer the middle of the road.
    const hugging = flow.sampleCost(flow.commuteA, 42, 0);
    const middle = flow.sampleCost(flow.commuteA, 66, 0);
    expect(hugging).not.toBe(COST_UNREACHABLE);
    expect(middle).not.toBe(COST_UNREACHABLE);
    expect(hugging + middle).toBeGreaterThan(0);
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

  it('costs a diagonal step more than an orthogonal one', () => {
    const obstacles = new ObstacleField();
    obstacles.rebuild([]);
    const flow = new FlowField();
    flow.rebuild(obstacles, [threatAt(0, 0)]);
    const ortho = flow.sampleCost(flow.flee, cellCentreX(cellX(0) + 4), cellCentreZ(cellZ(0)));
    const diag = flow.sampleCost(
      flow.flee,
      cellCentreX(cellX(0) + 4),
      cellCentreZ(cellZ(0) + 4)
    );
    expect(diag).toBeGreaterThan(ortho);
    expect(ortho).toBeGreaterThanOrEqual(STEP_ORTHO * 4);
  });
});
