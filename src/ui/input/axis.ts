/**
 * AXIS MATH — pure, allocation-light, zero DOM.
 *
 * ── WHY THERE ARE TWO DIFFERENT MAPPINGS IN HERE ───────────────────────────
 * Sticks arrive from hardware in two fundamentally different shapes and they
 * need different treatment to end up with the SAME feel:
 *
 *   RADIAL sources (a virtual thumbstick). The raw signal is an unbounded
 *   pixel offset from the touch origin. The right normalisation is radial:
 *   divide the DISTANCE by the full-deflection radius. Travel to reach
 *   magnitude 1.0 is then identical in every direction, so a diagonal drag is
 *   never clamped short. `radialDeflection()` does this.
 *
 *   SQUARE sources (WASD, D-pads, and physical analogue sticks, whose gates
 *   are square). Their natural range is the unit SQUARE: pressing W+D gives
 *   (1, 1), magnitude 1.414. Clamping that to the unit circle costs the
 *   diagonal 29% of its reach compared to a cardinal — the classic
 *   "diagonals are slower" bug. `squareToCircle()` maps the square onto the
 *   disc instead of clipping it, so the corner lands exactly ON the circle.
 *
 * Both paths end in `axisFromVector()`, which is the single place an
 * `AxisState` is constructed — so touch, keyboard and gamepad are guaranteed
 * to produce byte-identical structs for equivalent input.
 */

import type { AxisState } from '@/types';
import { clamp, clamp01, EPSILON } from '@/util';

/** The centred axis. Frozen and shared — never mutate it. */
export const NEUTRAL_AXIS: AxisState = Object.freeze({
  x: 0,
  y: 0,
  magnitude: 0,
  angle: 0,
  active: false,
});

/**
 * Build an `AxisState` from a raw vector, clamping to the unit circle.
 *
 * This is the ONLY constructor for `AxisState` in the codebase. `angle` is
 * `atan2(y, x)` (0 = +X, counter-clockwise) and is 0 when centred, matching
 * the "undefined when centred" note on the contract.
 *
 * @param x  -1..1, positive right (values outside are clamped radially).
 * @param y  -1..1, positive UP.
 * @param active Whether the source is being driven. Defaults to "magnitude > 0".
 */
export function axisFromVector(x: number, y: number, active?: boolean): AxisState {
  let mx = x;
  let my = y;
  let magnitude = Math.hypot(mx, my);
  if (magnitude > 1) {
    // Radial clamp: preserve direction, cap the length.
    const inv = 1 / magnitude;
    mx *= inv;
    my *= inv;
    magnitude = 1;
  }
  if (magnitude < EPSILON) {
    return active === true ? { x: 0, y: 0, magnitude: 0, angle: 0, active: true } : NEUTRAL_AXIS;
  }
  return {
    x: mx,
    y: my,
    magnitude,
    angle: Math.atan2(my, mx),
    active: active ?? true,
  };
}

/**
 * Map the unit SQUARE onto the unit DISC (elliptical grid mapping).
 *
 *   u = x * sqrt(1 - y^2 / 2)
 *   v = y * sqrt(1 - x^2 / 2)
 *
 * Corners land exactly on the circle: (1,1) -> (0.7071, 0.7071), magnitude 1.
 * Cardinals are untouched: (1,0) -> (1,0). Every intermediate direction is
 * smoothly interpolated, and the mapping is area-preserving enough that a
 * physical stick's feel is unchanged.
 *
 * Inputs are clamped to the square first, so this is safe on raw hardware
 * values that occasionally overshoot 1.0.
 */
export function squareToCircle(x: number, y: number): { x: number; y: number } {
  const sx = clamp(x, -1, 1);
  const sy = clamp(y, -1, 1);
  return {
    x: sx * Math.sqrt(1 - (sy * sy) / 2),
    y: sy * Math.sqrt(1 - (sx * sx) / 2),
  };
}

/** Result of turning a pixel offset into a normalised stick deflection. */
export interface RadialDeflection {
  /** -1..1, positive right. */
  readonly x: number;
  /** -1..1, positive UP. */
  readonly y: number;
  /** 0..1, dead-zoned and clamped. */
  readonly magnitude: number;
  /** Raw distance from the origin, in pixels, before dead zone/clamp. */
  readonly rawDistancePx: number;
}

/**
 * Normalise a pixel offset from a stick origin into a circular deflection.
 *
 * `dy` is expected in SCREEN space (positive down); the returned `y` is
 * flipped to match the `AxisState` contract (positive UP).
 *
 * Distance is measured radially, so `fullDeflectionPx` of travel yields
 * magnitude 1.0 in EVERY direction — a 120px drag to the north-east is
 * exactly as strong as a 120px drag due north.
 *
 * The remaining travel between the dead zone and full deflection is rescaled
 * to 0..1, so the very first pixel past the dead zone is a barely-perceptible
 * nudge rather than an instant 47% lurch.
 */
export function radialDeflection(
  dx: number,
  dy: number,
  deadZonePx: number,
  fullDeflectionPx: number
): RadialDeflection {
  const up = -dy;
  const distance = Math.hypot(dx, up);
  if (distance < EPSILON) return { x: 0, y: 0, magnitude: 0, rawDistancePx: 0 };

  const span = Math.max(fullDeflectionPx - deadZonePx, EPSILON);
  const magnitude = clamp01((distance - deadZonePx) / span);
  if (magnitude === 0) return { x: 0, y: 0, magnitude: 0, rawDistancePx: distance };

  const inv = 1 / distance;
  return {
    x: dx * inv * magnitude,
    y: up * inv * magnitude,
    magnitude,
    rawDistancePx: distance,
  };
}

/**
 * Apply a radial dead zone to an already-normalised vector and rescale the
 * remainder to 0..1. Used for gamepad sticks, whose dead zone is expressed as
 * a fraction rather than pixels.
 */
export function radialDeadZone(x: number, y: number, deadZone: number): { x: number; y: number } {
  const magnitude = Math.hypot(x, y);
  if (magnitude < EPSILON) return { x: 0, y: 0 };
  if (magnitude <= deadZone) return { x: 0, y: 0 };
  const scaled = clamp01((magnitude - deadZone) / Math.max(1 - deadZone, EPSILON));
  const inv = scaled / magnitude;
  return { x: x * inv, y: y * inv };
}

/** Structural comparison for axes, with a tolerance. Used by parity tests. */
export function axesEqual(a: AxisState, b: AxisState, epsilon = 1e-4): boolean {
  return (
    Math.abs(a.x - b.x) <= epsilon &&
    Math.abs(a.y - b.y) <= epsilon &&
    Math.abs(a.magnitude - b.magnitude) <= epsilon &&
    a.active === b.active &&
    // Angle is meaningless when centred; only compare it when there is a direction.
    (a.magnitude <= epsilon || Math.abs(shortestAngle(a.angle, b.angle)) <= epsilon)
  );
}

/** Signed shortest difference between two angles, in radians. */
function shortestAngle(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
