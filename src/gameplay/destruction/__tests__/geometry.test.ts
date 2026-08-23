/**
 * THE OVERLAP PREDICATES — CONSERVATIVE MEANS CONSERVATIVE
 *
 * `geometry.ts` states the asymmetry it is built around: a false positive costs
 * one extra detached chunk and reads as spall, a false negative leaves a
 * floating slab the player can see. So the thing worth pinning is that the
 * cheap early rejects never throw away something the angular test would have
 * accepted.
 *
 * The half-angle is caller-supplied — `ShockwaveFiredEvent` only special-cases
 * `Math.PI` — and a cone WIDER than a hemisphere legitimately contains points
 * behind its own apex plane.
 *
 * ── WHY THERE IS NO DENSE-LATTICE BRUTE FORCE FOR THE CONE ─────────────────
 * The sibling predicate test (`src/gameplay/combat/__tests__/cone.test.ts`)
 * validates against a lattice, and that works there. It does NOT work here, and
 * the reason is worth writing down rather than discovering twice:
 * `aabbInCone` samples NINE points — the box's nearest point to the apex plus
 * its eight corners. A long thin box can straddle a narrow cone with all nine
 * outside it and its middle squarely inside, so "some lattice point is in the
 * cone" does not imply the function says true. Measured over 300k random
 * building-sized boxes that is ~1.4% of genuine intersections, and a lattice
 * assertion would fail on the seed rather than on a regression.
 *
 * What IS a theorem, and is what these tests assert, is that `aabbInCone`
 * equals that nine-point test exactly — no shortcut in front of it (the range
 * pre-reject, the apex-containment branch, the `halfAngle >= PI` branch, the
 * half-space reject inside `withinCone`) may change the answer. Bug
 * destruction-05 lived in precisely that gap.
 *
 * `aabbInSphere` has no such gap and IS brute-forced: the nearest point
 * minimises distance over the whole box, so "any point within the radius"
 * really does imply "the nearest point is within the radius".
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createRng } from '@/util';
import {
  aabbInCone,
  aabbInSphere,
  localAabbToWorld,
  localToWorld,
  normaliseInto,
  pointAabbDistanceSq,
} from '../geometry';
import { RegisteredStructure } from '../structure';
import { makeTower } from './fixtures';

type Box = [number, number, number, number, number, number];

/** A 2 m box centred on `(x, y, z)`. */
function box(x: number, y: number, z: number): Box {
  return [x - 1, y - 1, z - 1, x + 1, y + 1, z + 1];
}

/** `aabbInCone` for an apex at the origin pointing down +X. */
function hitFromOrigin(b: Box, range: number, halfAngle: number): boolean {
  return aabbInCone(b[0], b[1], b[2], b[3], b[4], b[5], 0, 0, 0, 1, 0, 0, range, halfAngle);
}

/**
 * The nine-point test with NO shortcuts in front of it: no range pre-reject, no
 * apex-containment branch, no `halfAngle >= PI` branch, no half-space reject.
 * Every acceptance `aabbInCone` makes must be one of these nine points, and
 * every one of these it must make.
 */
function coneReference(
  b: Box,
  ox: number,
  oy: number,
  oz: number,
  ax: number,
  ay: number,
  az: number,
  range: number,
  halfAngle: number
): boolean {
  const cosLimit = Math.cos(Math.min(halfAngle, Math.PI));
  const points: [number, number, number][] = [
    [
      ox < b[0] ? b[0] : ox > b[3] ? b[3] : ox,
      oy < b[1] ? b[1] : oy > b[4] ? b[4] : oy,
      oz < b[2] ? b[2] : oz > b[5] ? b[5] : oz,
    ],
  ];
  for (let corner = 0; corner < 8; corner++) {
    points.push([
      (corner & 1) === 0 ? b[0] : b[3],
      (corner & 2) === 0 ? b[1] : b[4],
      (corner & 4) === 0 ? b[2] : b[5],
    ]);
  }
  for (const [px, py, pz] of points) {
    const dx = px - ox;
    const dy = py - oy;
    const dz = pz - oz;
    const lengthSq = dx * dx + dy * dy + dz * dz;
    if (lengthSq > range * range) continue;
    if (lengthSq < 1e-8) return true;
    if (dx * ax + dy * ay + dz * az >= cosLimit * Math.sqrt(lengthSq)) return true;
  }
  return false;
}

/** Dense lattice over the box; the nearest point minimises over all of it. */
function sphereBrute(b: Box, cx: number, cy: number, cz: number, radius: number): boolean {
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      for (let k = 0; k <= steps; k++) {
        const dx = b[0] + ((b[3] - b[0]) * i) / steps - cx;
        const dy = b[1] + ((b[4] - b[1]) * j) / steps - cy;
        const dz = b[2] + ((b[5] - b[2]) * k) / steps - cz;
        if (Math.hypot(dx, dy, dz) <= radius) return true;
      }
    }
  }
  return false;
}

describe('pointAabbDistanceSq', () => {
  it('is zero inside and the clamped distance outside', () => {
    const rng = createRng('point-aabb');
    for (let trial = 0; trial < 3000; trial++) {
      const b: Box = [rng.range(-40, 40), rng.range(-40, 40), rng.range(-40, 40), 0, 0, 0];
      b[3] = b[0] + rng.range(0.5, 16);
      b[4] = b[1] + rng.range(0.5, 16);
      b[5] = b[2] + rng.range(0.5, 16);
      const px = rng.range(-60, 60);
      const py = rng.range(-60, 60);
      const pz = rng.range(-60, 60);

      const actual = pointAabbDistanceSq(px, py, pz, b[0], b[1], b[2], b[3], b[4], b[5]);
      const inside =
        px >= b[0] && px <= b[3] && py >= b[1] && py <= b[4] && pz >= b[2] && pz <= b[5];
      if (inside) {
        expect(actual).toBe(0);
        continue;
      }

      // The componentwise clamp IS the nearest point of an AABB.
      const cx = Math.min(Math.max(px, b[0]), b[3]);
      const cy = Math.min(Math.max(py, b[1]), b[4]);
      const cz = Math.min(Math.max(pz, b[2]), b[5]);
      const expected = (px - cx) ** 2 + (py - cy) ** 2 + (pz - cz) ** 2;
      expect(actual).toBeCloseTo(expected, 9);
      expect(actual).toBeGreaterThan(0);
    }
  });

  it('is never greater than the distance to any point of the box', () => {
    const rng = createRng('point-aabb-min');
    for (let trial = 0; trial < 300; trial++) {
      const b: Box = [-3, -4, -5, 6, 7, 8];
      const px = rng.range(-30, 30);
      const py = rng.range(-30, 30);
      const pz = rng.range(-30, 30);
      const nearest = pointAabbDistanceSq(px, py, pz, b[0], b[1], b[2], b[3], b[4], b[5]);
      for (let i = 0; i <= 4; i++) {
        for (let j = 0; j <= 4; j++) {
          for (let k = 0; k <= 4; k++) {
            const dx = b[0] + ((b[3] - b[0]) * i) / 4 - px;
            const dy = b[1] + ((b[4] - b[1]) * j) / 4 - py;
            const dz = b[2] + ((b[5] - b[2]) * k) / 4 - pz;
            expect(nearest).toBeLessThanOrEqual(dx * dx + dy * dy + dz * dz + 1e-9);
          }
        }
      }
    }
  });
});

describe('aabbInSphere', () => {
  it('measures to the nearest point of the box, not its centre', () => {
    expect(pointAabbDistanceSq(0, 0, 0, 9, -1, -1, 11, 1, 1)).toBeCloseTo(81, 6);
    expect(aabbInSphere(...box(10, 0, 0), 0, 0, 0, 9.5)).toBe(true);
    expect(aabbInSphere(...box(10, 0, 0), 0, 0, 0, 8.5)).toBe(false);
  });

  it('takes every box with a point inside the radius', () => {
    const rng = createRng('sphere-brute');
    let hits = 0;
    for (let trial = 0; trial < 2000; trial++) {
      const b: Box = [0, 0, 0, 0, 0, 0];
      b[0] = rng.range(-30, 30);
      b[1] = rng.range(-30, 30);
      b[2] = rng.range(-30, 30);
      b[3] = b[0] + rng.range(0.5, 14);
      b[4] = b[1] + rng.range(0.5, 14);
      b[5] = b[2] + rng.range(0.5, 14);
      const cx = rng.range(-30, 30);
      const cy = rng.range(-30, 30);
      const cz = rng.range(-30, 30);
      const radius = rng.range(1, 25);
      if (sphereBrute(b, cx, cy, cz, radius)) {
        hits++;
        expect(aabbInSphere(b[0], b[1], b[2], b[3], b[4], b[5], cx, cy, cz, radius)).toBe(true);
      }
    }
    // The sweep is only worth anything if it actually found overlaps.
    expect(hits).toBeGreaterThan(200);
  });

  it('takes a centre inside the box and rejects a face just out of reach', () => {
    expect(aabbInSphere(-2, -2, -2, 2, 2, 2, 0, 0, 0, 0.001)).toBe(true);
    // Nearest face exactly `radius + 1e-6` away.
    expect(aabbInSphere(10, -1, -1, 12, 1, 1, 0, 0, 0, 10 - 1e-6)).toBe(false);
    expect(aabbInSphere(10, -1, -1, 12, 1, 1, 0, 0, 0, 10 + 1e-6)).toBe(true);
  });
});

describe('aabbInCone', () => {
  it('takes a box straight down the axis and rejects one outside the angle', () => {
    expect(hitFromOrigin(box(10, 0, 0), 40, 0.35)).toBe(true);
    expect(hitFromOrigin(box(0, 0, 10), 40, 0.35)).toBe(false);
  });

  it('rejects anything past the range whatever the angle', () => {
    expect(hitFromOrigin(box(60, 0, 0), 40, Math.PI)).toBe(false);
    expect(hitFromOrigin(box(20, 0, 0), 40, Math.PI)).toBe(true);
  });

  it('always takes a box the apex is inside, whatever the axis', () => {
    const rng = createRng('apex-inside');
    for (let trial = 0; trial < 200; trial++) {
      const axis = new Float64Array(3);
      normaliseInto(axis, rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1));
      expect(aabbInCone(-2, -3, -4, 5, 6, 7, 1, 1, 1, axis[0]!, axis[1]!, axis[2]!, 40, 0.01)).toBe(
        true
      );
    }
  });

  it('reaches behind the apex plane once the half-angle passes 90 degrees', () => {
    // 114.6°: a box 10 m out at 100° off the axis is inside the cone —
    // `cos(100°) * 10 = -1.74` against a limit of `cos(114.6°) * 10 = -4.16`.
    const halfAngle = 2.0;
    const radians = (100 * Math.PI) / 180;
    const at100 = box(10 * Math.cos(radians), 0, 10 * Math.sin(radians));
    expect(hitFromOrigin(at100, 40, halfAngle)).toBe(true);

    // ...and the same box is still outside a 55° cone, so the reject that was
    // removed was not doing any work the angular test does not do.
    expect(hitFromOrigin(at100, 40, 0.96)).toBe(false);
  });

  it('rejects a box behind a narrow cone', () => {
    expect(hitFromOrigin([-30, -5, -5, -20, 5, 5], 40, 0.35)).toBe(false);
    expect(hitFromOrigin([-30, -5, -5, -20, 5, 5], 40, Math.PI)).toBe(true);
  });

  it('catches a slab whose nearest point is below the cone but whose top is inside', () => {
    // A cone from the ground tilted 30° up, 12° wide, so it covers 18°..42°.
    // The slab stands 10 m out and 6 m tall: its nearest point (10, 0, 0) is
    // 30° BELOW the axis and outside, while its top corner (10, 6, ±1) is 31°
    // up — 5° off the axis and squarely inside.
    const slab: Box = [10, 0, -1, 11, 6, 1];
    const tilt = Math.PI / 6;
    const ax = Math.cos(tilt);
    const ay = Math.sin(tilt);
    const halfAngle = 0.21;

    // The nearest point on its own would be rejected.
    const nearestOnly = aabbInCone(
      slab[0],
      slab[1],
      slab[2],
      slab[3],
      slab[1],
      slab[5],
      0,
      0,
      0,
      ax,
      ay,
      0,
      40,
      halfAngle
    );
    expect(nearestOnly).toBe(false);

    // The full box is taken, and only the corner sweep can have done it.
    expect(aabbInCone(...slab, 0, 0, 0, ax, ay, 0, 40, halfAngle)).toBe(true);
  });

  it('is exactly the nine-point test, with no shortcut changing the answer', () => {
    const rng = createRng('cone-reference');
    const axis = new Float64Array(3);
    let accepted = 0;
    let rejected = 0;
    for (let trial = 0; trial < 4000; trial++) {
      const b: Box = [0, 0, 0, 0, 0, 0];
      b[0] = rng.range(-40, 40);
      b[1] = rng.range(-40, 40);
      b[2] = rng.range(-40, 40);
      b[3] = b[0] + rng.range(0.5, 16);
      b[4] = b[1] + rng.range(0.5, 16);
      b[5] = b[2] + rng.range(0.5, 16);
      const ox = rng.range(-40, 40);
      const oy = rng.range(-40, 40);
      const oz = rng.range(-40, 40);
      // `normaliseInto` is exercised here rather than in isolation: the cone
      // test's contract says the axis is unit length, and this is what makes
      // one.
      normaliseInto(axis, rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1));
      const range = rng.range(10, 120);
      // The full legal span, `Math.PI` included. Below 90° the half-space
      // reject is a shortcut; above it, it must not fire at all.
      const halfAngle = rng.range(0.05, Math.PI);

      const actual = aabbInCone(
        b[0],
        b[1],
        b[2],
        b[3],
        b[4],
        b[5],
        ox,
        oy,
        oz,
        axis[0]!,
        axis[1]!,
        axis[2]!,
        range,
        halfAngle
      );
      expect(actual).toBe(
        coneReference(b, ox, oy, oz, axis[0]!, axis[1]!, axis[2]!, range, halfAngle)
      );
      if (actual) accepted++;
      else rejected++;
    }
    // Both branches were walked; an agreement test on an all-false sweep proves
    // nothing.
    expect(accepted).toBeGreaterThan(200);
    expect(rejected).toBeGreaterThan(200);
  });

  it('never accepts a box the range gate alone rules out', () => {
    const rng = createRng('cone-range-gate');
    const axis = new Float64Array(3);
    for (let trial = 0; trial < 2000; trial++) {
      const b: Box = [0, 0, 0, 0, 0, 0];
      b[0] = rng.range(-60, 60);
      b[1] = rng.range(-60, 60);
      b[2] = rng.range(-60, 60);
      b[3] = b[0] + rng.range(0.5, 10);
      b[4] = b[1] + rng.range(0.5, 10);
      b[5] = b[2] + rng.range(0.5, 10);
      normaliseInto(axis, rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1));
      const range = rng.range(5, 50);
      const halfAngle = rng.range(0.05, Math.PI);
      if (!aabbInCone(...b, 0, 0, 0, axis[0]!, axis[1]!, axis[2]!, range, halfAngle)) continue;
      expect(pointAabbDistanceSq(0, 0, 0, b[0], b[1], b[2], b[3], b[4], b[5])).toBeLessThanOrEqual(
        range * range
      );
    }
  });
});

describe('normaliseInto', () => {
  it('returns the original length and writes a unit vector', () => {
    const rng = createRng('normalise');
    const out = new Float64Array(3);
    for (let trial = 0; trial < 2000; trial++) {
      const x = rng.range(-100, 100);
      const y = rng.range(-100, 100);
      const z = rng.range(-100, 100);
      const length = Math.hypot(x, y, z);
      if (length < 1e-3) continue;
      expect(normaliseInto(out, x, y, z)).toBeCloseTo(length, 9);
      expect(Math.hypot(out[0]!, out[1]!, out[2]!)).toBeCloseTo(1, 12);
      // Direction preserved, not just magnitude.
      expect(out[0]! * length).toBeCloseTo(x, 9);
      expect(out[1]! * length).toBeCloseTo(y, 9);
      expect(out[2]! * length).toBeCloseTo(z, 9);
    }
  });

  it('turns a degenerate input into +X and reports zero length', () => {
    const out = new Float64Array(3);
    for (const [x, y, z] of [
      [0, 0, 0],
      [1e-9, 0, 0],
      [0, -1e-9, 5e-10],
    ]) {
      out.fill(NaN);
      expect(normaliseInto(out, x!, y!, z!)).toBe(0);
      expect([...out]).toEqual([1, 0, 0]);
    }
  });
});

describe('localToWorld', () => {
  it('agrees with a three yaw matrix', () => {
    const rng = createRng('local-to-world');
    const out = new Float64Array(3);
    const scratch = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    for (let trial = 0; trial < 1000; trial++) {
      const yaw = rng.range(-Math.PI * 2, Math.PI * 2);
      const lx = rng.range(-50, 50);
      const ly = rng.range(-50, 50);
      const lz = rng.range(-50, 50);
      const px = rng.range(-200, 200);
      const py = rng.range(-200, 200);
      const pz = rng.range(-200, 200);

      localToWorld(out, lx, ly, lz, px, py, pz, Math.cos(yaw), Math.sin(yaw));
      matrix.makeRotationY(yaw).setPosition(px, py, pz);
      scratch.set(lx, ly, lz).applyMatrix4(matrix);

      expect(out[0]!).toBeCloseTo(scratch.x, 9);
      expect(out[1]!).toBeCloseTo(scratch.y, 9);
      expect(out[2]!).toBeCloseTo(scratch.z, 9);
    }
  });
});

describe('localAabbToWorld', () => {
  it('fast-paths an unrotated box to a pure translate', () => {
    const rng = createRng('aabb-fast-path');
    const fast = new Float64Array(6);
    const general = new Float64Array(6);
    for (let trial = 0; trial < 500; trial++) {
      const aabb: Box = [
        rng.range(-20, 0),
        rng.range(-20, 0),
        rng.range(-20, 0),
        rng.range(0, 20),
        rng.range(0, 20),
        rng.range(0, 20),
      ];
      const px = rng.range(-100, 100);
      const py = rng.range(-100, 100);
      const pz = rng.range(-100, 100);

      localAabbToWorld(fast, aabb, px, py, pz, 1, 0);
      // A yaw of 2π is the same rotation without hitting `sinY === 0 && cosY === 1`
      // exactly, so it takes the general branch.
      localAabbToWorld(general, aabb, px, py, pz, Math.cos(2 * Math.PI), Math.sin(2 * Math.PI));
      for (let i = 0; i < 6; i++) expect(fast[i]!).toBeCloseTo(general[i]!, 9);
      expect([...fast]).toEqual([
        aabb[0] + px,
        aabb[1] + py,
        aabb[2] + pz,
        aabb[3] + px,
        aabb[4] + py,
        aabb[5] + pz,
      ]);
    }
  });

  it('bounds every one of the eight rotated corners, and no more', () => {
    const rng = createRng('aabb-rotated');
    const out = new Float64Array(6);
    const corner = new Float64Array(3);
    for (let trial = 0; trial < 1000; trial++) {
      const aabb: Box = [
        rng.range(-20, -1),
        rng.range(-20, -1),
        rng.range(-20, -1),
        rng.range(1, 20),
        rng.range(1, 20),
        rng.range(1, 20),
      ];
      const yaw = rng.range(-Math.PI, Math.PI);
      const cosY = Math.cos(yaw);
      const sinY = Math.sin(yaw);
      const px = rng.range(-80, 80);
      const py = rng.range(-80, 80);
      const pz = rng.range(-80, 80);
      localAabbToWorld(out, aabb, px, py, pz, cosY, sinY);

      let minX = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxZ = -Infinity;
      for (let c = 0; c < 8; c++) {
        const lx = (c & 1) === 0 ? aabb[0] : aabb[3];
        const ly = (c & 2) === 0 ? aabb[1] : aabb[4];
        const lz = (c & 4) === 0 ? aabb[2] : aabb[5];
        localToWorld(corner, lx, ly, lz, px, py, pz, cosY, sinY);
        // Every transformed corner is inside the reported AABB.
        expect(corner[0]!).toBeGreaterThanOrEqual(out[0]! - 1e-9);
        expect(corner[1]!).toBeGreaterThanOrEqual(out[1]! - 1e-9);
        expect(corner[2]!).toBeGreaterThanOrEqual(out[2]! - 1e-9);
        expect(corner[0]!).toBeLessThanOrEqual(out[3]! + 1e-9);
        expect(corner[1]!).toBeLessThanOrEqual(out[4]! + 1e-9);
        expect(corner[2]!).toBeLessThanOrEqual(out[5]! + 1e-9);
        if (corner[0]! < minX) minX = corner[0]!;
        if (corner[0]! > maxX) maxX = corner[0]!;
        if (corner[2]! < minZ) minZ = corner[2]!;
        if (corner[2]! > maxZ) maxZ = corner[2]!;
      }

      // ...and it is the TIGHT bound: exactly the corner extremes in X/Z, with
      // Y simply translated, because a yaw does not touch Y.
      expect(out[0]!).toBeCloseTo(minX, 9);
      expect(out[3]!).toBeCloseTo(maxX, 9);
      expect(out[2]!).toBeCloseTo(minZ, 9);
      expect(out[5]!).toBeCloseTo(maxZ, 9);
      expect(out[1]!).toBeCloseTo(aabb[1] + py, 12);
      expect(out[4]!).toBeCloseTo(aabb[4] + py, 12);
    }
  });
});

/**
 * ── THE YAW PATH, END TO END ───────────────────────────────────────────────
 * `city-streamer.ts` registers without a `rotationY`, so `RegisteredStructure`'s
 * `cosY`/`sinY`/`matrix` path has never executed in the game. The first landmark
 * wired with a yaw either works or silently mis-places every chunk AABB, and the
 * symptom — a punch that misses a building it visibly engulfed — is exactly the
 * false negative `geometry.ts` says must not happen.
 */
describe('a structure registered with a yaw', () => {
  const cases: [string, number][] = [
    ['rotated 45 degrees', Math.PI / 4],
    ['axis aligned', 0],
    ['rotated a third of a turn', (2 * Math.PI) / 3],
    ['rotated backwards', -1.1],
  ];

  for (const [label, rotationY] of cases) {
    it(`places every chunk through its own matrix when ${label}`, () => {
      const { layout, attribute } = makeTower({ floors: 4 });
      const structure = new RegisteredStructure({
        id: 'rot',
        layout,
        target: { destroyed: attribute },
        position: { x: 12, y: 3, z: -7 },
        rotationY,
      });

      const centroid = new Float64Array(3);
      const bounds = new Float64Array(6);
      const point = new THREE.Vector3();

      for (let i = 0; i < structure.chunkCount; i++) {
        const chunk = layout.chunks[i]!;
        expect(structure.chunkWorldCentroid(i, centroid)).toBe(true);
        expect(structure.chunkWorldBounds(i, bounds)).toBe(true);

        // The centroid is the local centroid through `structure.matrix` — the
        // same transform the renderer puts the block mesh at.
        point
          .set(chunk.centroid[0], chunk.centroid[1], chunk.centroid[2])
          .applyMatrix4(structure.matrix);
        expect(centroid[0]!).toBeCloseTo(point.x, 9);
        expect(centroid[1]!).toBeCloseTo(point.y, 9);
        expect(centroid[2]!).toBeCloseTo(point.z, 9);

        // The chunk AABB contains that centroid and all eight local corners.
        const contains = (p: THREE.Vector3): void => {
          expect(p.x).toBeGreaterThanOrEqual(bounds[0]! - 1e-9);
          expect(p.y).toBeGreaterThanOrEqual(bounds[1]! - 1e-9);
          expect(p.z).toBeGreaterThanOrEqual(bounds[2]! - 1e-9);
          expect(p.x).toBeLessThanOrEqual(bounds[3]! + 1e-9);
          expect(p.y).toBeLessThanOrEqual(bounds[4]! + 1e-9);
          expect(p.z).toBeLessThanOrEqual(bounds[5]! + 1e-9);
        };
        contains(point);
        for (let c = 0; c < 8; c++) {
          point
            .set(
              (c & 1) === 0 ? chunk.aabb[0] : chunk.aabb[3],
              (c & 2) === 0 ? chunk.aabb[1] : chunk.aabb[4],
              (c & 4) === 0 ? chunk.aabb[2] : chunk.aabb[5]
            )
            .applyMatrix4(structure.matrix);
          contains(point);
        }

        // ...and the broad-phase AABB the sweep rejects against contains the
        // chunk AABB. A structure whose bounds miss one of its own chunks is a
        // punch that misses a wall it went through.
        for (let k = 0; k < 3; k++) {
          expect(bounds[k]!).toBeGreaterThanOrEqual(structure.worldBounds[k]! - 1e-9);
          expect(bounds[k + 3]!).toBeLessThanOrEqual(structure.worldBounds[k + 3]! + 1e-9);
        }
      }
    });
  }

  it('keeps a yawed tower reachable by a punch aimed at where it looks', () => {
    // The same tower at 45°, hit from due west. If the rotated branch of
    // `localAabbToWorld` were wrong the cone would sweep empty air.
    const { layout, attribute } = makeTower({ floors: 4, footprint: 12 });
    const structure = new RegisteredStructure({
      id: 'rot-hit',
      layout,
      target: { destroyed: attribute },
      position: { x: 0, y: 0, z: 0 },
      rotationY: Math.PI / 4,
    });

    const b = structure.worldBounds;
    // A 12 m square turned 45° spans 12*sqrt(2) ≈ 16.97 m corner to corner.
    expect(b[3]! - b[0]!).toBeCloseTo(12 * Math.SQRT2, 6);
    expect(b[5]! - b[2]!).toBeCloseTo(12 * Math.SQRT2, 6);
    expect(aabbInCone(b[0]!, b[1]!, b[2]!, b[3]!, b[4]!, b[5]!, -40, 2, 0, 1, 0, 0, 120, 0.2)).toBe(
      true
    );
  });
});
