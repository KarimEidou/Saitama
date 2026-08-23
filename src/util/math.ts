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

/**
 * Constrain `value` to [min, max]. A NaN `value` clamps to `min`.
 *
 * ── DO NOT "SIMPLIFY" THIS ─────────────────────────────────────────────────
 * Neither `Math.min(max, Math.max(min, value))` nor the obvious
 * `value < min ? min : value > max ? max : value` is correct, because EVERY
 * comparison against NaN is false: both let NaN straight through, and a
 * function whose entire job is "give me a number in this range" then returns
 * something that is not a number. Every caller downstream assumes it cannot.
 *
 * The form below tests `value > min` FIRST, so NaN — which fails that test —
 * falls out at `min` rather than sailing on. `min` is the deliberate choice
 * over propagating: a shockwave attenuated to nothing, a camera pinned at its
 * pitch limit or a stick pushed to one extreme is a WRONG FRAME the next frame
 * corrects. A NaN in the same place is unrecoverable — it poisons every
 * accumulator it touches for the rest of the session, nothing throws, and the
 * symptom surfaces somewhere else entirely (usually as a character that has
 * silently vanished, because NaN quaternions cull the whole mesh).
 * `rank-ladder.ts` already takes exactly this stance for a NaN seat index.
 *
 * NaN BOUNDS are not laundered — there is no in-range answer when the range
 * itself is broken, so `clamp(x, NaN, 1)` returns NaN. That is the caller's
 * bug to fix, and it is better seen than papered over.
 *
 * Cost is unchanged: two comparisons, no calls, no allocation. This runs
 * per-entity per-frame.
 */
export function clamp(value: number, min: number, max: number): number {
  return value > min ? (value > max ? max : value) : min;
}

/**
 * Constrain `value` to [0, 1]. A NaN `value` clamps to 0.
 *
 * Same trap as `clamp` above, and this is the one that bites: `clamp01` is the
 * single most-called helper in the codebase (230-odd call sites), so ONE NaN
 * entering anywhere propagates silently through every consumer of the value.
 * `Math.min(1, Math.max(0, x))` and `x < 0 ? 0 : x > 1 ? 1 : x` both return NaN
 * for NaN. Testing `value > 0` first means NaN fails and falls out at 0.
 *
 * `> 0` rather than `>= 0` also normalises -0 to +0, so the output is always
 * the canonical zero. Consumers that divide by it or feed it to `Math.atan2`
 * get +Infinity / +PI rather than a sign that depends on how the argument was
 * computed. It costs nothing: the branch was there either way.
 */
export function clamp01(value: number): number {
  return value > 0 ? (value > 1 ? 1 : value) : 0;
}

/**
 * Linear interpolation. `t` is NOT clamped.
 *
 * Deliberately NOT NaN-guarded, unlike `clamp`/`clamp01`/`saturate`/`falloff`.
 * Those four promise a bounded output and enforce it with a comparison, which
 * is what makes a silent NaN a broken promise. `lerp` is raw arithmetic with no
 * range contract at all — extrapolation past both ends is a documented, used
 * feature — so there is no bound to fall back to, and a guard here would only
 * cost the hottest call in the file. Clamp `t` at the call site when it comes
 * from anywhere untrusted.
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Inverse lerp: where `value` sits between `a` and `b`, as 0..1.
 *
 * Returns 0 for a degenerate range. The tolerance is RELATIVE to the magnitude
 * of the endpoints, with no absolute floor, because the units here are
 * arbitrary. An absolute `EPSILON` collapses a legitimate `[0, 1e-7]` band —
 * fog density is quoted in `1/metres` and lives around `1e-6` — to `a` for
 * every input, silently and with nothing thrown. `<=` rather than `<` so a
 * genuinely zero range at the origin returns 0 instead of `0 / 0`.
 */
export function inverseLerp(a: number, b: number, value: number): number {
  const range = b - a;
  const tolerance = EPSILON * Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(range) <= tolerance ? 0 : (value - a) / range;
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

/**
 * Wrap an angle to [-PI, PI).
 *
 * Half-open at the TOP: `mod` returns [0, TAU), so the exact antipode comes
 * back as `-PI`, never `+PI`. Both are the same direction, but code that tests
 * the sign of `angleDelta` to pick a turn direction turns clockwise at exactly
 * 180 degrees away.
 */
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

/**
 * True when `value` is a positive integral power of two.
 *
 * The bit test alone is not enough: `&` coerces through `ToInt32`, which
 * truncates fractions and wraps past 2^32, so `1024.7` and `2^32 + 1` would
 * both report true — and the natural caller is a texture-dimension guard whose
 * whole job is to catch exactly those.
 */
export function isPowerOfTwo(value: number): boolean {
  if (!Number.isInteger(value) || value <= 0) return false;
  if (value <= 2 ** 31) return (value & (value - 1)) === 0;
  return 2 ** Math.round(Math.log2(value)) === value;
}

/**
 * Smallest power of two >= `value`.
 *
 * Not the `1 << (32 - clz32(v - 1))` bit trick: that truncates fractional
 * inputs (returning a power of two BELOW the argument, e.g. 1 for 1.5) and
 * shifts modulo 32 above 2^30, returning a negative number.
 */
export function nextPowerOfTwo(value: number): number {
  if (!Number.isFinite(value) || value <= 1) return 1;
  let p = 2 ** Math.ceil(Math.log2(value));
  // `Math.log2` is not required to be exactly rounded, so nudge the boundary
  // rather than trusting it for exact powers of two.
  if (p < value) p *= 2;
  else if (p / 2 >= value) p /= 2;
  return p;
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
 * Attenuation from 1 at the origin to 0 at `maxDistance`: a quadratic ease-out
 * with FINITE support, `(1 - d/r)^2`. Used for shockwave falloff, camera shake
 * attenuation and audio-adjacent effects.
 *
 * NOT inverse-square (`1/d^2`): this curve is bounded at the origin, is 0.25 at
 * half range, and reaches exactly 0 at the edge, which is what a gameplay
 * radius wants. Do not reach for it when a physical distance model is needed —
 * for 3D audio gain, configure the Web Audio panner instead.
 */
export function falloff(distance: number, maxDistance: number): number {
  // Origin first: with `maxDistance <= 0` the range test alone would attenuate
  // the epicentre of a zero-radius shockwave to nothing.
  if (distance <= 0) return 1;
  // `!(distance < maxDistance)`, NOT `distance >= maxDistance`. Identical for
  // every real number, but NaN fails both `<=` above and `>=` here, so the `>=`
  // form fell through to `1 - NaN / maxDistance` and multiplied a NaN impulse
  // into every rigid body in range. Written as a negation so NaN — in EITHER
  // argument — lands on "out of range", which is the safe end: an effect that
  // did not happen, rather than one applied at unknown strength.
  if (!(distance < maxDistance)) return 0;
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
 *
 * The two guards below are the same NaN trap as `clamp01`, in the one helper
 * whose whole purpose is to bound an input nobody bounds upstream.
 */
export function saturate(value: number, half: number): number {
  // `!(value > 0)`, NOT `value <= 0`: NaN fails `<=`, so a non-finite punch
  // power reached `NaN / NaN` and handed a NaN intensity to camera shake, VFX
  // scale and audio gain — where `linearRampToValueAtTime(NaN, …)` throws out
  // of the per-frame audio update.
  if (!(value > 0)) return 0;
  // `Infinity / Infinity` is also NaN, so the curve's own limit has to be
  // spelled out rather than left to the arithmetic. An unbounded magnitude
  // saturates completely, which is exactly what this curve means.
  if (value === Number.POSITIVE_INFINITY) return 1;
  return value / (value + half);
}
