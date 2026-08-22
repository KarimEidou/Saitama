/**
 * THE CONE TEST — CONSERVATIVE MEANS CONSERVATIVE
 *
 * `geometry.ts` states the asymmetry it is built around: a false positive costs
 * one extra detached chunk and reads as spall, a false negative leaves a
 * floating slab the player can see. So the only thing worth pinning here is
 * that the cheap early rejects never throw away something the angular test
 * would have accepted.
 *
 * The half-angle is caller-supplied — `ShockwaveFiredEvent` only special-cases
 * `Math.PI` — and a cone WIDER than a hemisphere legitimately contains points
 * behind its own apex plane.
 */

import { describe, expect, it } from 'vitest';
import { aabbInCone, aabbInSphere, pointAabbDistanceSq } from '../geometry';

/** A 2 m box centred on `(x, y, z)`. */
function box(x: number, y: number, z: number): [number, number, number, number, number, number] {
  return [x - 1, y - 1, z - 1, x + 1, y + 1, z + 1];
}

/** `aabbInCone` for an apex at the origin pointing down +X. */
function hitFromOrigin(
  b: [number, number, number, number, number, number],
  range: number,
  halfAngle: number
): boolean {
  return aabbInCone(b[0], b[1], b[2], b[3], b[4], b[5], 0, 0, 0, 1, 0, 0, range, halfAngle);
}

describe('aabbInCone', () => {
  it('takes a box straight down the axis and rejects one outside the angle', () => {
    expect(hitFromOrigin(box(10, 0, 0), 40, 0.35)).toBe(true);
    expect(hitFromOrigin(box(0, 0, 10), 40, 0.35)).toBe(false);
  });

  it('rejects anything past the range whatever the angle', () => {
    expect(hitFromOrigin(box(60, 0, 0), 40, Math.PI)).toBe(false);
  });

  it('always takes a box the apex is inside', () => {
    expect(hitFromOrigin(box(0, 0, 0), 40, 0.01)).toBe(true);
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
    expect(hitFromOrigin(box(-10, 0, 0), 40, 0.35)).toBe(false);
    expect(hitFromOrigin(box(-10, 0, 0), 40, Math.PI)).toBe(true);
  });
});

describe('aabbInSphere', () => {
  it('measures to the nearest point of the box, not its centre', () => {
    expect(pointAabbDistanceSq(0, 0, 0, 9, -1, -1, 11, 1, 1)).toBeCloseTo(81, 6);
    expect(aabbInSphere(...box(10, 0, 0), 0, 0, 0, 9.5)).toBe(true);
    expect(aabbInSphere(...box(10, 0, 0), 0, 0, 0, 8.5)).toBe(false);
  });
});
