/**
 * DETERMINISTIC NOISE FOR PROCEDURAL VFX TEXTURES
 *
 * Every texture this system uses is generated at boot from a seed. Nothing is
 * downloaded and nothing is committed: a dust puff is a formula, and the same
 * seed produces the same bytes on every device, which is what lets the
 * verification harness make claims about the pixels it captures.
 *
 * All arithmetic stays integer until the final divide (the same discipline as
 * `@/util` `rng.ts`), so there is no cross-platform floating-point drift in
 * the generated atlases.
 */

import { mixSeeds } from '@/util';

/** Hash a 2-D integer lattice point to a float in [0, 1). */
export function hash2(x: number, y: number, seed: number): number {
  return mixSeeds(mixSeeds(x >>> 0, y >>> 0), seed >>> 0) / 4294967296;
}

/** Hash a 1-D integer to a float in [0, 1). */
export function hash1(x: number, seed: number): number {
  return mixSeeds(x >>> 0, seed >>> 0) / 4294967296;
}

/**
 * Value noise on a `cells x cells` torus, smoothstep-interpolated.
 *
 * Toroidal on purpose: an atlas tile whose noise wraps can be rotated in the
 * shader without a visible seam appearing at the quad edge.
 */
export function valueNoise(x: number, y: number, cells: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const wrap = (n: number): number => ((n % cells) + cells) % cells;
  const x0 = wrap(xi);
  const y0 = wrap(yi);
  const x1 = wrap(xi + 1);
  const y1 = wrap(yi + 1);
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

/** Multi-octave tileable fBm in [0, 1] over a unit square. */
export function fbm(u: number, v: number, seed: number, octaves = 5, baseCells = 4): number {
  let value = 0;
  let amplitude = 0.5;
  let total = 0;
  let cells = baseCells;
  for (let o = 0; o < octaves; o++) {
    value += valueNoise(u * cells, v * cells, cells, seed + o * 7919) * amplitude;
    total += amplitude;
    amplitude *= 0.52;
    cells *= 2;
  }
  return value / total;
}

/**
 * Ridged fBm — `1 - |2n - 1|` per octave. Produces creases rather than blobs,
 * which is what makes smoke read as billowing instead of as fog.
 */
export function ridgedFbm(u: number, v: number, seed: number, octaves = 4, baseCells = 3): number {
  let value = 0;
  let amplitude = 0.5;
  let total = 0;
  let cells = baseCells;
  for (let o = 0; o < octaves; o++) {
    const n = valueNoise(u * cells, v * cells, cells, seed + o * 4517);
    value += (1 - Math.abs(n * 2 - 1)) * amplitude;
    total += amplitude;
    amplitude *= 0.5;
    cells *= 2;
  }
  return value / total;
}

/** Squared distance from point `p` to segment `ab`, all in 2-D. */
export function distanceToSegmentSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const lengthSq = abx * abx + aby * aby;
  let t = lengthSq > 1e-9 ? (apx * abx + apy * aby) / lengthSq : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = apx - abx * t;
  const dy = apy - aby * t;
  return dx * dx + dy * dy;
}

/** `smoothstep`, matching the GLSL definition. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0 || 1e-9)));
  return t * t * (3 - 2 * t);
}
