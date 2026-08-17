/**
 * MATH HELPERS
 *
 * Small, allocation-free numeric utilities. Anything here may be called
 * thousands of times per frame, so nothing in this file allocates unless the
 * name says it returns a new object.
 */

/** Radians per degree. */
export const DEG2RAD = Math.PI / 180;
/** Degrees per radian. */
export const RAD2DEG = 180 / Math.PI;
/** Full turn in radians. */
export const TAU = Math.PI * 2;
/** Comparison tolerance for floats. */
export const EPSILON = 1e-6;

/** Constrain `value` to [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Constrain `value` to [0, 1]. */
export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Linear interpolation. `t` is NOT clamped. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Inverse lerp: where `value` sits between `a` and `b`, as 0..1. */
export function inverseLerp(a: number, b: number, value: number): number {
  return Math.abs(b - a) < EPSILON ? 0 : (value - a) / (b - a);
}

/** Remap from one range to another, without clamping. */
export function remap(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number
): number {
  return lerp(outMin, outMax, inverseLerp(inMin, inMax, value));
}

/** Remap and clamp to the output range. */
export function remapClamped(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number
): number {
  return lerp(outMin, outMax, clamp01(inverseLerp(inMin, inMax, value)));
}

/**
 * Frame-rate-INDEPENDENT exponential smoothing.
 *
 * Prefer this over `lerp(current, target, 0.1)` in update loops: a raw lerp
 * factor makes the smoothing speed depend on frame rate, so the camera behaves
 * differently at 30fps and 60fps. `smoothing` is the fraction REMAINING after
 * one second (e.g. 0.01 = 99% of the way there each second).
 */
export function damp(current: number, target: number, smoothing: number, dt: number): number {
  return lerp(target, current, Math.pow(clamp01(smoothing), dt));
}

/** Hermite smoothstep over [edge0, edge1]. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01(inverseLerp(edge0, edge1, x));
  return t * t * (3 - 2 * t);
}

/** Quintic smootherstep; zero 1st and 2nd derivatives at both ends. */
export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01(inverseLerp(edge0, edge1, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Move `current` towards `target` by at most `maxDelta`. */
export function moveTowards(current: number, target: number, maxDelta: number): number {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

/** Euclidean modulo — the result always has the sign of `n`. */
export function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(radians: number): number {
  return mod(radians + Math.PI, TAU) - Math.PI;
}

/** Shortest signed angular difference from `a` to `b`, in radians. */
export function angleDelta(a: number, b: number): number {
  return wrapAngle(b - a);
}

/** Interpolate angles along the shortest arc. */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + angleDelta(a, b) * t;
}

/** Frame-rate-independent angular smoothing along the shortest arc. */
export function dampAngle(current: number, target: number, smoothing: number, dt: number): number {
  return current + angleDelta(current, target) * (1 - Math.pow(clamp01(smoothing), dt));
}

/** Float equality within a tolerance. */
export function approximately(a: number, b: number, epsilon = EPSILON): boolean {
  return Math.abs(a - b) < epsilon;
}

/** Squared 2D distance. Prefer over `distance2` when only comparing. */
export function distanceSq2(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

/** Squared 3D distance. Prefer over `distance3` when only comparing. */
export function distanceSq3(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  return dx * dx + dy * dy + dz * dz;
}

/** True when `value` is a power of two. */
export function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}

/** Smallest power of two >= `value`. */
export function nextPowerOfTwo(value: number): number {
  if (value <= 1) return 1;
  return 1 << (32 - Math.clz32(value - 1));
}

/**
 * Round to a multiple of `step`. Used to snap procedural geometry onto a grid
 * so adjacent chunks line up exactly.
 */
export function snap(value: number, step: number): number {
  return step === 0 ? value : Math.round(value / step) * step;
}

/**
 * Apply a radial dead zone and rescale the remainder to 0..1.
 * Returns the adjusted magnitude for a stick of magnitude `magnitude`.
 */
export function applyDeadZone(magnitude: number, deadZone: number): number {
  if (magnitude <= deadZone) return 0;
  return clamp01((magnitude - deadZone) / (1 - deadZone));
}

/**
 * Attenuation from 0 at `maxDistance` to 1 at the origin, falling off with the
 * inverse square and smoothed at the edge. Used for shockwave falloff, camera
 * shake attenuation and audio-adjacent effects.
 */
export function falloff(distance: number, maxDistance: number): number {
  if (distance >= maxDistance) return 0;
  if (distance <= 0) return 1;
  const t = 1 - distance / maxDistance;
  return t * t;
}

/**
 * Compress an unbounded magnitude into 0..1.
 *
 * Punch `power` has no upper bound (a serious punch can exceed 1e6), so any
 * consumer wanting a normalised intensity — camera shake, VFX scale, audio
 * gain — must run it through a saturating curve rather than dividing by an
 * assumed maximum. `half` is the value that maps to 0.5.
 */
export function saturate(value: number, half: number): number {
  if (value <= 0) return 0;
  return value / (value + half);
}
