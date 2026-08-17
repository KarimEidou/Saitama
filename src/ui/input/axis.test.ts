import { describe, expect, it } from 'vitest';
import {
  axesEqual,
  axisFromVector,
  NEUTRAL_AXIS,
  radialDeadZone,
  radialDeflection,
  squareToCircle,
} from './axis';
import { DEFAULT_INPUT_TUNING } from './config';

const DEAD = DEFAULT_INPUT_TUNING.stickDeadZonePx; // 56
const FULL = DEFAULT_INPUT_TUNING.stickFullDeflectionPx; // 120

describe('radialDeflection — dead zone', () => {
  it('reads centred inside the dead zone', () => {
    for (const [dx, dy] of [
      [0, 0],
      [30, 0],
      [0, 55],
      [-39, 39], // 55.2px diagonal, still inside
    ] as const) {
      const d = radialDeflection(dx, dy, DEAD, FULL);
      expect(d.magnitude, `(${dx},${dy})`).toBe(0);
      expect(d.x).toBe(0);
      expect(d.y).toBe(0);
    }
  });

  it('is a barely-perceptible nudge just past the dead zone, not a lurch', () => {
    const d = radialDeflection(DEAD + 1, 0, DEAD, FULL);
    expect(d.magnitude).toBeGreaterThan(0);
    expect(d.magnitude).toBeLessThan(0.02);
  });

  it('the dead-zone edge is circular, not square', () => {
    // 56px along a 45-degree ray: still exactly at the boundary.
    const at = (56 * Math.SQRT1_2) as number;
    expect(radialDeflection(at, -at, DEAD, FULL).magnitude).toBeCloseTo(0, 5);
    // A hair beyond it in the same direction reads non-zero.
    const past = 57 * Math.SQRT1_2;
    expect(radialDeflection(past, -past, DEAD, FULL).magnitude).toBeGreaterThan(0);
  });
});

describe('radialDeflection — full deflection and clamping', () => {
  it('reaches exactly 1.0 at the full-deflection radius', () => {
    expect(radialDeflection(FULL, 0, DEAD, FULL).magnitude).toBeCloseTo(1, 6);
    expect(radialDeflection(0, -FULL, DEAD, FULL).magnitude).toBeCloseTo(1, 6);
  });

  it('clamps beyond full deflection instead of overshooting', () => {
    for (const distance of [FULL + 1, 200, 1000, 1e6]) {
      const d = radialDeflection(distance, 0, DEAD, FULL);
      expect(d.magnitude, `${distance}px`).toBe(1);
      expect(d.x).toBeCloseTo(1, 6);
    }
  });

  it('DIAGONALS ARE NOT CLAMPED SHORT — same travel, same magnitude', () => {
    // The whole point: 120px of thumb travel is magnitude 1.0 in every
    // direction, not just the cardinals.
    for (let deg = 0; deg < 360; deg += 15) {
      const rad = (deg * Math.PI) / 180;
      const dx = Math.cos(rad) * FULL;
      const dy = -Math.sin(rad) * FULL; // screen y is down
      const d = radialDeflection(dx, dy, DEAD, FULL);
      expect(d.magnitude, `${deg} degrees`).toBeCloseTo(1, 5);
      expect(Math.atan2(d.y, d.x), `${deg} degrees`).toBeCloseTo(
        Math.atan2(Math.sin(rad), Math.cos(rad)),
        5
      );
    }
  });

  it('flips screen-space Y so positive is UP', () => {
    // Dragging the thumb UP the screen is a negative dy.
    const up = radialDeflection(0, -FULL, DEAD, FULL);
    expect(up.y).toBeCloseTo(1, 6);
    const down = radialDeflection(0, FULL, DEAD, FULL);
    expect(down.y).toBeCloseTo(-1, 6);
  });

  it('rescales the band between dead zone and full deflection linearly', () => {
    const mid = DEAD + (FULL - DEAD) / 2;
    expect(radialDeflection(mid, 0, DEAD, FULL).magnitude).toBeCloseTo(0.5, 6);
  });
});

describe('squareToCircle', () => {
  it('leaves cardinals untouched', () => {
    expect(squareToCircle(1, 0)).toEqual({ x: 1, y: 0 });
    expect(squareToCircle(0, -1)).toEqual({ x: 0, y: -1 });
  });

  it('maps every corner of the square exactly onto the unit circle', () => {
    for (const [x, y] of [
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ] as const) {
      const m = squareToCircle(x, y);
      expect(Math.hypot(m.x, m.y), `(${x},${y})`).toBeCloseTo(1, 6);
    }
  });

  it('preserves the direction of a corner', () => {
    const m = squareToCircle(1, 1);
    expect(m.x).toBeCloseTo(Math.SQRT1_2, 6);
    expect(m.y).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('never leaves the unit disc, for any point in the square', () => {
    for (let x = -1; x <= 1.0001; x += 0.1) {
      for (let y = -1; y <= 1.0001; y += 0.1) {
        const m = squareToCircle(x, y);
        expect(Math.hypot(m.x, m.y)).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it('clamps hardware overshoot rather than producing NaN', () => {
    const m = squareToCircle(1.4, -1.4);
    expect(Number.isFinite(m.x)).toBe(true);
    expect(Math.hypot(m.x, m.y)).toBeCloseTo(1, 6);
  });
});

describe('radialDeadZone', () => {
  it('zeroes inside the dead zone', () => {
    expect(radialDeadZone(0.1, 0.05, 0.15)).toEqual({ x: 0, y: 0 });
  });

  it('rescales the remainder to reach 1.0 at full deflection', () => {
    const r = radialDeadZone(1, 0, 0.15);
    expect(r.x).toBeCloseTo(1, 6);
  });

  it('is circular, so it cannot make diagonals shorter than cardinals', () => {
    const cardinal = radialDeadZone(1, 0, 0.15);
    const diagonal = radialDeadZone(Math.SQRT1_2, Math.SQRT1_2, 0.15);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(Math.hypot(cardinal.x, cardinal.y), 6);
  });
});

describe('axisFromVector', () => {
  it('returns the shared neutral axis when centred', () => {
    expect(axisFromVector(0, 0)).toBe(NEUTRAL_AXIS);
  });

  it('clamps radially, preserving direction', () => {
    const a = axisFromVector(3, 4); // magnitude 5
    expect(a.magnitude).toBeCloseTo(1, 6);
    expect(a.x).toBeCloseTo(0.6, 6);
    expect(a.y).toBeCloseTo(0.8, 6);
  });

  it('computes angle counter-clockwise from +X', () => {
    expect(axisFromVector(1, 0).angle).toBeCloseTo(0, 6);
    expect(axisFromVector(0, 1).angle).toBeCloseTo(Math.PI / 2, 6);
    expect(axisFromVector(-1, 0).angle).toBeCloseTo(Math.PI, 6);
  });

  it('can be active while centred (thumb down, not yet moved)', () => {
    const a = axisFromVector(0, 0, true);
    expect(a.active).toBe(true);
    expect(a.magnitude).toBe(0);
  });
});

describe('axesEqual', () => {
  it('ignores the meaningless angle of a centred axis', () => {
    const a = { x: 0, y: 0, magnitude: 0, angle: 0, active: false };
    const b = { x: 0, y: 0, magnitude: 0, angle: 3.1, active: false };
    expect(axesEqual(a, b)).toBe(true);
  });

  it('compares angles across the +/-PI wrap', () => {
    const a = axisFromVector(-1, 1e-9);
    const b = axisFromVector(-1, -1e-9);
    expect(axesEqual(a, b, 1e-3)).toBe(true);
  });
});
