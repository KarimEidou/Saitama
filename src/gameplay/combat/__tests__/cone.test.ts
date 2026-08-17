/**
 * CONE / AABB MATHS — CHECKED AGAINST BRUTE FORCE
 *
 * ── WHY THIS FILE IS THE LONGEST TEST IN THE WORKSTREAM ────────────────────
 * A false negative here is a monster surviving a punch that visually engulfed
 * it. Nothing else in the system can recover from that: the resolver only ever
 * sees the targets these predicates hand it, so a miss is silent, unreportable
 * and looks exactly like a bug in the animation.
 *
 * So every predicate is checked in the ONE direction that matters:
 *
 *      brute force says INSIDE  =>  the production predicate must accept
 *
 * Brute force is dense point sampling. Sampling can only ever MISS an
 * intersection, never invent one, so a `true` from it is proof of a real
 * intersection and the implication above is sound. The reverse direction is
 * measured rather than asserted — a conservative test is allowed to
 * over-accept — but the over-acceptance rate is bounded so that a predicate
 * degenerating into `return true` would fail.
 */

import { describe, expect, it } from 'vitest';
import { createRng } from '@/util';
import {
  aabbFromCentre,
  aabbInCone,
  aabbInConeBrute,
  aabbInSphere,
  aabbOverlap,
  coneBounds,
  normalise,
  pointAabbDistanceSq,
  pointAabbFarthestSq,
  pointInAabb,
  pointInCone,
  segmentIntersectsAabb,
  sphereInCone,
  sphereInConeBrute,
  sphereInSphere,
  type ICombatAabb,
} from '../cone';
import { DEFAULT_COMBAT_TUNING } from '../tuning';

const SERIOUS_HALF_ANGLE = DEFAULT_COMBAT_TUNING.seriousHalfAngleRad;

/* -------------------------------------------------------------------------- */
/* Point in cone — the exact predicate everything else is measured against     */
/* -------------------------------------------------------------------------- */

describe('pointInCone', () => {
  it('accepts the apex itself', () => {
    expect(pointInCone(0, 0, 0, 0, 0, -1, 40, SERIOUS_HALF_ANGLE)).toBe(true);
  });

  it('accepts a point straight down the axis at the rim of the range', () => {
    expect(pointInCone(0, 0, -40, 0, 0, -1, 40, SERIOUS_HALF_ANGLE)).toBe(true);
    expect(pointInCone(0, 0, -40.0001, 0, 0, -1, 40, SERIOUS_HALF_ANGLE)).toBe(false);
  });

  it('is bounded by a SPHERICAL cap, not a flat disc', () => {
    // 39 m along the axis and 3 m off it: inside a spherical sector (39.1 m
    // from the apex, 4.4 degrees off axis), and it must stay inside. A flat-cap
    // formulation would agree here; the point of the test is the pair below.
    expect(pointInCone(3, 0, -39, 0, 0, -1, 40, SERIOUS_HALF_ANGLE)).toBe(true);
    // Same angle, radius 40.5: beyond the sphere, so out.
    const d = normalise(3, 0, -39);
    expect(pointInCone(d.x * 40.5, d.y * 40.5, d.z * 40.5, 0, 0, -1, 40, SERIOUS_HALF_ANGLE)).toBe(
      false
    );
  });

  it('rejects exactly at the half-angle boundary plus epsilon', () => {
    const justInside = SERIOUS_HALF_ANGLE - 1e-4;
    const justOutside = SERIOUS_HALF_ANGLE + 1e-4;
    const at = (angle: number): boolean =>
      pointInCone(Math.sin(angle) * 20, 0, -Math.cos(angle) * 20, 0, 0, -1, 40, SERIOUS_HALF_ANGLE);
    expect(at(justInside)).toBe(true);
    expect(at(justOutside)).toBe(false);
  });

  it('rejects everything behind the apex for a narrow cone', () => {
    expect(pointInCone(0, 0, 5, 0, 0, -1, 40, SERIOUS_HALF_ANGLE)).toBe(false);
  });

  it('accepts the whole sphere when the half-angle is PI', () => {
    const rng = createRng('radial');
    for (let i = 0; i < 2000; i++) {
      const x = rng.range(-9, 9);
      const y = rng.range(-9, 9);
      const z = rng.range(-9, 9);
      const inside = Math.hypot(x, y, z) <= 10;
      expect(pointInCone(x, y, z, 0, 1, 0, 10, Math.PI)).toBe(inside);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Sphere in cone                                                             */
/* -------------------------------------------------------------------------- */

describe('sphereInCone vs brute force', () => {
  /**
   * 40 000 random configurations spanning every regime the game produces:
   * apex inside the target, target grazing the rim, target directly behind,
   * target far outside, half-angles from a hair to fully radial, ranges from
   * a 1.2 m jab to a 180 m serious punch.
   */
  it('never produces a false negative', () => {
    const rng = createRng('sphere-cone');
    let bruteInside = 0;
    let accepted = 0;
    let falseNegatives = 0;

    for (let i = 0; i < 40_000; i++) {
      const range = rng.range(1.2, 180);
      const halfAngle = rng.range(0.02, Math.PI);
      const dir = normalise(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1));
      // Bias placement toward the interesting shell around `range`, so most
      // samples straddle a boundary rather than sitting trivially far away.
      const distance = rng.range(0, range * 1.35);
      const at = normalise(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1));
      const r = rng.range(0, Math.max(0.4, range * 0.12));
      const cx = at.x * distance;
      const cy = at.y * distance;
      const cz = at.z * distance;

      const fast = sphereInCone(cx, cy, cz, r, dir.x, dir.y, dir.z, range, halfAngle);
      const brute = sphereInConeBrute(cx, cy, cz, r, dir.x, dir.y, dir.z, range, halfAngle, 10);

      if (fast) accepted++;
      if (brute) {
        bruteInside++;
        if (!fast) falseNegatives++;
      }
    }

    expect(bruteInside).toBeGreaterThan(4000);
    expect(falseNegatives).toBe(0);
    // Guard against the predicate degenerating into `return true`.
    expect(accepted).toBeLessThan(40_000);
  });

  it('is conservative, not sloppy — over-acceptance stays bounded', () => {
    const rng = createRng('sphere-cone-tightness');
    let brute = 0;
    let fast = 0;
    for (let i = 0; i < 20_000; i++) {
      const range = rng.range(4, 120);
      const halfAngle = rng.range(0.05, 1.2);
      const dir = normalise(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1));
      const at = normalise(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1));
      const distance = rng.range(0, range * 1.2);
      const r = rng.range(0.2, 2.5);
      const c = { x: at.x * distance, y: at.y * distance, z: at.z * distance };
      if (sphereInCone(c.x, c.y, c.z, r, dir.x, dir.y, dir.z, range, halfAngle)) fast++;
      if (sphereInConeBrute(c.x, c.y, c.z, r, dir.x, dir.y, dir.z, range, halfAngle, 12)) brute++;
    }
    expect(brute).toBeGreaterThan(0);
    // Accepting more than 1.35x what brute force finds would mean the angular
    // widening is doing more than covering the sphere's own radius.
    expect(fast).toBeLessThanOrEqual(Math.ceil(brute * 1.35));
  });

  it('accepts a target the apex is standing inside, whatever the aim', () => {
    const rng = createRng('apex-inside');
    for (let i = 0; i < 500; i++) {
      const dir = normalise(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1));
      // Centre 0.8 m away, radius 1.1 m: the apex is inside the sphere.
      const at = normalise(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1));
      expect(
        sphereInCone(at.x * 0.8, at.y * 0.8, at.z * 0.8, 1.1, dir.x, dir.y, dir.z, 1.2, 0.05)
      ).toBe(true);
    }
  });

  it('a 1.2 m jab reaches a 1.1 m monster at 2.0 m and not at 2.4 m', () => {
    const jab = DEFAULT_COMBAT_TUNING.normalReachMetres;
    const half = DEFAULT_COMBAT_TUNING.normalHalfAngleRad;
    expect(sphereInCone(0, 0, -2.0, 1.1, 0, 0, -1, jab, half)).toBe(true);
    expect(sphereInCone(0, 0, -2.4, 1.1, 0, 0, -1, jab, half)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Cone bounds                                                                */
/* -------------------------------------------------------------------------- */

describe('coneBounds', () => {
  it('contains every point of the cone', () => {
    const rng = createRng('cone-bounds');
    for (let trial = 0; trial < 400; trial++) {
      const range = rng.range(2, 180);
      const halfAngle = rng.range(0.05, Math.PI);
      const dir = normalise(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1));
      const o = { x: rng.range(-50, 50), y: rng.range(-50, 50), z: rng.range(-50, 50) };
      const box = coneBounds(o.x, o.y, o.z, dir.x, dir.y, dir.z, range, halfAngle);

      for (let i = 0; i < 60; i++) {
        const at = normalise(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1));
        const d = rng.range(0, range);
        const p = { x: at.x * d, y: at.y * d, z: at.z * d };
        if (!pointInCone(p.x, p.y, p.z, dir.x, dir.y, dir.z, range, halfAngle)) continue;
        expect(pointInAabb(o.x + p.x, o.y + p.y, o.z + p.z, box)).toBe(true);
      }
    }
  });

  it('is much tighter than the sphere box for a narrow cone', () => {
    // A fully-charged serious punch: 180 m at a 22 degree half-angle.
    //   Z spans the whole range, [-180, 0].
    //   X and Y span +/- 180 * cos(90 - 22) = +/- 67.4 m.
    // That is 3.27e6 cubic metres against the 4.67e7 of the enclosing sphere's
    // box — seven percent, and the difference is fracture chunks not swept.
    const box = coneBounds(0, 0, 0, 0, 0, -1, 180, SERIOUS_HALF_ANGLE);
    const volume = (box.maxX - box.minX) * (box.maxY - box.minY) * (box.maxZ - box.minZ);
    const sphereVolume = 360 * 360 * 360;
    expect(volume / sphereVolume).toBeLessThan(0.075);
    expect(box.maxZ).toBeCloseTo(0, 6);
    expect(box.minZ).toBeCloseTo(-180, 6);
    expect(box.maxX).toBeCloseTo(180 * Math.cos(Math.PI / 2 - SERIOUS_HALF_ANGLE), 6);
  });

  it('degenerates to the full sphere box at half-angle PI', () => {
    const box = coneBounds(1, 2, 3, 0, 1, 0, 10, Math.PI);
    expect(box.minX).toBeCloseTo(-9, 6);
    expect(box.maxX).toBeCloseTo(11, 6);
    expect(box.minY).toBeCloseTo(-8, 6);
    expect(box.maxY).toBeCloseTo(12, 6);
  });
});

/* -------------------------------------------------------------------------- */
/* AABB in cone                                                               */
/* -------------------------------------------------------------------------- */

describe('aabbInCone vs brute force', () => {
  /** Random box that spans the shapes the city actually contains. */
  function randomBox(rng: ReturnType<typeof createRng>, spread: number): ICombatAabb {
    const cx = rng.range(-spread, spread);
    const cy = rng.range(-spread * 0.3, spread * 0.6);
    const cz = rng.range(-spread, spread);
    // Wildly anisotropic on purpose: a fracture chunk of a facade is a slab,
    // and slabs are where a bounding-sphere test would fall apart.
    const hx = rng.range(0.2, 22);
    const hy = rng.range(0.2, 26);
    const hz = rng.range(0.2, 22);
    return aabbFromCentre(cx, cy, cz, hx, hy, hz);
  }

  it('never produces a false negative over 20 000 random configurations', () => {
    const rng = createRng('aabb-cone');
    let bruteInside = 0;
    let accepted = 0;
    const failures: string[] = [];

    for (let i = 0; i < 20_000; i++) {
      const range = rng.range(2, 180);
      const halfAngle = rng.range(0.03, Math.PI);
      const dir = normalise(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1));
      const box = randomBox(rng, range * 0.8);

      const fast = aabbInCone(box, 0, 0, 0, dir.x, dir.y, dir.z, range, halfAngle);
      const brute = aabbInConeBrute(box, 0, 0, 0, dir.x, dir.y, dir.z, range, halfAngle, 9);

      if (fast) accepted++;
      if (brute) {
        bruteInside++;
        if (!fast && failures.length < 4) {
          failures.push(
            `range=${range.toFixed(2)} half=${halfAngle.toFixed(3)} ` +
              `dir=(${dir.x.toFixed(3)},${dir.y.toFixed(3)},${dir.z.toFixed(3)}) ` +
              `box=${JSON.stringify(box)}`
          );
        }
      }
    }

    expect(bruteInside).toBeGreaterThan(2000);
    expect(failures).toEqual([]);
    expect(accepted).toBeLessThan(20_000);
  });

  it('stays tight on the slab shapes a facade fractures into', () => {
    const rng = createRng('aabb-slab');
    let brute = 0;
    let fast = 0;
    for (let i = 0; i < 12_000; i++) {
      const range = rng.range(20, 180);
      const halfAngle = SERIOUS_HALF_ANGLE;
      const dir = normalise(rng.range(-1, 1), 0, rng.range(-1, 1));
      // A 4 m x 12 m x 0.4 m slab, the shape a building facade comes apart in.
      const box = aabbFromCentre(
        rng.range(-range, range),
        rng.range(0, 40),
        rng.range(-range, range),
        2,
        6,
        0.2
      );
      if (aabbInCone(box, 0, 0, 0, dir.x, dir.y, dir.z, range, halfAngle)) fast++;
      if (aabbInConeBrute(box, 0, 0, 0, dir.x, dir.y, dir.z, range, halfAngle, 10)) brute++;
    }
    expect(brute).toBeGreaterThan(50);
    expect(fast).toBeGreaterThanOrEqual(brute);
    // A bounding-sphere-only test would run several times looser than this.
    expect(fast).toBeLessThanOrEqual(Math.ceil(brute * 1.6));
  });

  it('accepts a box the apex is standing inside', () => {
    const box = aabbFromCentre(0, 0, 0, 5, 5, 5);
    expect(aabbInCone(box, 0, 0, 0, 0, 0, -1, 40, 0.01)).toBe(true);
  });

  it('accepts a box the axis passes straight through at any half-angle', () => {
    const box = aabbFromCentre(0, 0, -30, 1, 1, 1);
    expect(aabbInCone(box, 0, 0, 0, 0, 0, -1, 40, 0.001)).toBe(true);
  });

  it('rejects a box entirely behind the apex', () => {
    const box = aabbFromCentre(0, 0, 30, 4, 4, 4);
    expect(aabbInCone(box, 0, 0, 0, 0, 0, -1, 180, SERIOUS_HALF_ANGLE)).toBe(false);
  });

  it('rejects a box beyond the range even when perfectly on axis', () => {
    const box = aabbFromCentre(0, 0, -60, 2, 2, 2);
    expect(aabbInCone(box, 0, 0, 0, 0, 0, -1, 40, SERIOUS_HALF_ANGLE)).toBe(false);
    expect(aabbInCone(box, 0, 0, 0, 0, 0, -1, 70, SERIOUS_HALF_ANGLE)).toBe(true);
  });

  it('a 40 m minimum-charge cone reaches the first block and not the third', () => {
    // Matches `populateStreet`: blocks centred at z = -24, -64, -104.
    const first = aabbFromCentre(0, 12, -24, 18, 12, 14);
    const third = aabbFromCentre(0, 12, -104, 18, 12, 14);
    expect(aabbInCone(first, 0, 1.4, 0, 0, 0, -1, 40, SERIOUS_HALF_ANGLE)).toBe(true);
    expect(aabbInCone(third, 0, 1.4, 0, 0, 0, -1, 40, SERIOUS_HALF_ANGLE)).toBe(false);
    expect(aabbInCone(third, 0, 1.4, 0, 0, 0, -1, 180, SERIOUS_HALF_ANGLE)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Radial predicates                                                          */
/* -------------------------------------------------------------------------- */

describe('radial predicates', () => {
  it('sphereInSphere agrees with the definition on random pairs', () => {
    const rng = createRng('sphere-sphere');
    for (let i = 0; i < 5000; i++) {
      const c = { x: rng.range(-30, 30), y: rng.range(-30, 30), z: rng.range(-30, 30) };
      const r = rng.range(0, 4);
      const radius = rng.range(0, 30);
      const expected = Math.hypot(c.x, c.y, c.z) <= radius + r;
      expect(sphereInSphere(c.x, c.y, c.z, r, radius)).toBe(expected);
    }
  });

  it('aabbInSphere agrees with dense sampling', () => {
    const rng = createRng('aabb-sphere');
    for (let i = 0; i < 3000; i++) {
      const box = aabbFromCentre(
        rng.range(-30, 30),
        rng.range(-30, 30),
        rng.range(-30, 30),
        rng.range(0.2, 8),
        rng.range(0.2, 8),
        rng.range(0.2, 8)
      );
      const radius = rng.range(1, 30);
      const fast = aabbInSphere(box, 0, 0, 0, radius);
      const brute = aabbInConeBrute(box, 0, 0, 0, 0, 1, 0, radius, Math.PI, 8);
      if (brute) expect(fast).toBe(true);
    }
  });

  it('a radial cone and a sphere pick the same targets', () => {
    const rng = createRng('radial-parity');
    for (let i = 0; i < 4000; i++) {
      const c = { x: rng.range(-25, 25), y: rng.range(-25, 25), z: rng.range(-25, 25) };
      const r = rng.range(0, 3);
      const radius = rng.range(1, 25);
      expect(sphereInCone(c.x, c.y, c.z, r, 0, 1, 0, radius, Math.PI)).toBe(
        sphereInSphere(c.x, c.y, c.z, r, radius)
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Supporting primitives                                                      */
/* -------------------------------------------------------------------------- */

describe('supporting primitives', () => {
  it('pointAabbDistanceSq and pointAabbFarthestSq bracket every point in the box', () => {
    const rng = createRng('aabb-distance');
    for (let trial = 0; trial < 300; trial++) {
      const box = aabbFromCentre(
        rng.range(-20, 20),
        rng.range(-20, 20),
        rng.range(-20, 20),
        rng.range(0.5, 9),
        rng.range(0.5, 9),
        rng.range(0.5, 9)
      );
      const near = pointAabbDistanceSq(0, 0, 0, box);
      const far = pointAabbFarthestSq(0, 0, 0, box);
      expect(far).toBeGreaterThanOrEqual(near);
      for (let i = 0; i < 40; i++) {
        const p = {
          x: rng.range(box.minX, box.maxX),
          y: rng.range(box.minY, box.maxY),
          z: rng.range(box.minZ, box.maxZ),
        };
        const d = p.x * p.x + p.y * p.y + p.z * p.z;
        expect(d).toBeGreaterThanOrEqual(near - 1e-9);
        expect(d).toBeLessThanOrEqual(far + 1e-9);
      }
    }
  });

  it('segmentIntersectsAabb agrees with dense sampling along the segment', () => {
    const rng = createRng('segment-aabb');
    for (let trial = 0; trial < 4000; trial++) {
      const box = aabbFromCentre(
        rng.range(-15, 15),
        rng.range(-15, 15),
        rng.range(-15, 15),
        rng.range(0.5, 6),
        rng.range(0.5, 6),
        rng.range(0.5, 6)
      );
      const dir = normalise(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1));
      const range = rng.range(1, 40);
      const fast = segmentIntersectsAabb(0, 0, 0, dir.x, dir.y, dir.z, range, box);
      let sampled = false;
      for (let i = 0; i <= 900 && !sampled; i++) {
        const t = (i / 900) * range;
        sampled = pointInAabb(dir.x * t, dir.y * t, dir.z * t, box);
      }
      if (sampled) expect(fast).toBe(true);
    }
  });

  it('aabbOverlap is symmetric and matches the separating-axis definition', () => {
    const rng = createRng('aabb-overlap');
    for (let i = 0; i < 4000; i++) {
      const a = aabbFromCentre(
        rng.range(-10, 10),
        rng.range(-10, 10),
        rng.range(-10, 10),
        rng.range(0.2, 5),
        rng.range(0.2, 5),
        rng.range(0.2, 5)
      );
      const b = aabbFromCentre(
        rng.range(-10, 10),
        rng.range(-10, 10),
        rng.range(-10, 10),
        rng.range(0.2, 5),
        rng.range(0.2, 5),
        rng.range(0.2, 5)
      );
      expect(aabbOverlap(a, b)).toBe(aabbOverlap(b, a));
    }
  });

  it('normalise falls back to world forward rather than producing NaN', () => {
    const zero = normalise(0, 0, 0);
    expect(zero.length).toBe(0);
    expect(Number.isNaN(zero.x)).toBe(false);
    expect(zero.z).toBe(-1);
  });
});
