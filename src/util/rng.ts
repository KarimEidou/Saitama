/**
 * DETERMINISTIC SEEDED RNG
 *
 * The entire city generates from seeds and MUST be byte-identical across runs,
 * devices and platforms. That constraint drives every choice in this file:
 *
 *  • `Math.random()` is BANNED in world generation — it is unseeded and
 *    implementation-defined. Use these generators instead.
 *  • The core is mulberry32: all arithmetic stays in the uint32 domain via
 *    `Math.imul` and `>>> 0`, so there is no floating-point accumulation and
 *    therefore no cross-platform drift. A float is produced only at the very
 *    last step, by dividing a uint32 by 2^32.
 *  • Generation is HIERARCHICAL: never thread one shared generator through the
 *    world builder, because then generating chunk B depends on whether chunk A
 *    was generated first. Derive an independent child stream per unit of work
 *    (`derive`, `forCoord`), so any chunk can be generated at any time, in any
 *    order, on any thread, and produce identical output.
 */

/** A deterministic pseudo-random stream. */
export interface IRandom {
  /** The seed this stream was created from. */
  readonly seed: number;
  /** Next float in [0, 1). */
  next(): number;
  /** Next raw uint32 in [0, 2^32). */
  nextUint32(): number;
  /** Float in [min, max). */
  range(min: number, max: number): number;
  /** Integer in [min, max] — INCLUSIVE of both ends. */
  int(min: number, max: number): number;
  /** True with probability `p` (default 0.5). */
  bool(p?: number): boolean;
  /** Uniformly pick one element. Throws on an empty array. */
  pick<T>(items: readonly T[]): T;
  /**
   * Pick by relative weight. `weights[i]` corresponds to `items[i]`;
   * weights need not sum to 1. Throws when lengths differ or total is 0.
   */
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
  /** Fisher-Yates shuffle returning a NEW array; the input is untouched. */
  shuffle<T>(items: readonly T[]): T[];
  /** Normally-distributed value via Box-Muller. */
  gaussian(mean?: number, stdDev?: number): number;
  /** Unit vector on the XZ plane, as [x, z]. */
  unitVector2(): [number, number];
  /** Point uniformly distributed inside a circle, as [x, z]. */
  insideCircle(radius: number): [number, number];
  /**
   * An INDEPENDENT child stream. The same `(parent seed, label)` pair always
   * yields the same child, regardless of how much the parent has been drawn
   * from — this is what makes generation order-independent.
   */
  derive(label: string | number): IRandom;
  /** Reset to the initial seed. */
  reset(): void;
  /** Snapshot the internal state, for save/replay. */
  getState(): number;
  /** Restore a snapshot. */
  setState(state: number): void;
}

/**
 * xmur3 string hash. Produces a well-distributed uint32 seed from text, so
 * `hashString('downtown')` is a stable, readable seed source.
 */
export function hashString(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Mix two uint32 values into one. Used to fold a coordinate into a seed
 * without the collisions a plain `x * 31 + z` would produce.
 */
export function mixSeeds(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= Math.imul(b ^ 0x165667b1, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Stable seed for a chunk/tile coordinate.
 *
 * Negative coordinates are handled correctly: the values are folded into the
 * uint32 domain before mixing, so (-1, 2) and (1, -2) do not collide.
 */
export function hashCoord(x: number, z: number, seed = 0): number {
  return mixSeeds(mixSeeds(x >>> 0, z >>> 0), seed >>> 0);
}

/** Internal mulberry32 step. Kept private so state handling stays consistent. */
function mulberry32Step(state: number): { value: number; state: number } {
  let t = (state + 0x6d2b79f5) >>> 0;
  const next = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, state: next };
}

class Mulberry32 implements IRandom {
  readonly seed: number;
  private state: number;
  /** Cached second Box-Muller sample; the transform produces two at a time. */
  private spare: number | undefined;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.state = this.seed;
  }

  next(): number {
    const r = mulberry32Step(this.state);
    this.state = r.state;
    return r.value;
  }

  nextUint32(): number {
    return (this.next() * 4294967296) >>> 0;
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  int(min: number, max: number): number {
    if (max < min) [min, max] = [max, min];
    return Math.floor(this.range(Math.ceil(min), Math.floor(max) + 1));
  }

  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('rng.pick: empty array');
    return items[this.int(0, items.length - 1)]!;
  }

  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    if (items.length === 0) throw new Error('rng.weighted: empty array');
    if (items.length !== weights.length) {
      throw new Error(`rng.weighted: ${items.length} items vs ${weights.length} weights`);
    }
    let total = 0;
    for (const w of weights) {
      if (w < 0) throw new Error('rng.weighted: negative weight');
      total += w;
    }
    if (total <= 0) throw new Error('rng.weighted: weights sum to 0');

    let roll = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      roll -= weights[i]!;
      if (roll < 0) return items[i]!;
    }
    // Unreachable except for float rounding at the very top of the range.
    return items[items.length - 1]!;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  gaussian(mean = 0, stdDev = 1): number {
    if (this.spare !== undefined) {
      const s = this.spare;
      this.spare = undefined;
      return mean + s * stdDev;
    }
    // Reject u === 0 so Math.log never sees zero.
    let u = this.next();
    while (u === 0) u = this.next();
    const v = this.next();
    const mag = Math.sqrt(-2 * Math.log(u));
    this.spare = mag * Math.sin(2 * Math.PI * v);
    return mean + mag * Math.cos(2 * Math.PI * v) * stdDev;
  }

  unitVector2(): [number, number] {
    const a = this.next() * Math.PI * 2;
    return [Math.cos(a), Math.sin(a)];
  }

  insideCircle(radius: number): [number, number] {
    // sqrt keeps the distribution uniform by AREA rather than by radius.
    const r = radius * Math.sqrt(this.next());
    const a = this.next() * Math.PI * 2;
    return [Math.cos(a) * r, Math.sin(a) * r];
  }

  derive(label: string | number): IRandom {
    const labelSeed = typeof label === 'number' ? label >>> 0 : hashString(label);
    return new Mulberry32(mixSeeds(this.seed, labelSeed));
  }

  reset(): void {
    this.state = this.seed;
    this.spare = undefined;
  }

  getState(): number {
    return this.state;
  }

  setState(state: number): void {
    this.state = state >>> 0;
    this.spare = undefined;
  }
}

/**
 * Create a deterministic stream.
 * @param seed A number, or a string that will be hashed.
 */
export function createRng(seed: number | string): IRandom {
  return new Mulberry32(typeof seed === 'number' ? seed >>> 0 : hashString(seed));
}

/**
 * Create the stream for a specific chunk. THE entry point for world
 * generation — always derive from this rather than a shared generator, so
 * chunks can be generated in any order and still match.
 */
export function createChunkRng(worldSeed: number, chunkX: number, chunkZ: number): IRandom {
  return new Mulberry32(hashCoord(chunkX, chunkZ, worldSeed));
}
