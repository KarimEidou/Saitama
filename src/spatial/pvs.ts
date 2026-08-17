/**
 * PRECOMPUTED 2D POTENTIALLY VISIBLE SET
 *
 * The highest-value structure in this module. Frustum culling answers "is it in
 * front of the camera"; it cannot answer "is there a twelve-storey building in
 * the way". In a grid city at street level almost everything in the frustum is
 * behind a façade, so a frustum-only culler keeps 25-35 chunks where 6-10 are
 * actually reachable by light.
 *
 * ── THE STRUCTURE ──────────────────────────────────────────────────────────
 * For each of the 256 chunks, a 256-bit mask of the chunks potentially visible
 * from anywhere inside it. 256 x 8 uint32 = **8192 bytes for the whole city**,
 * computed once and cached. A runtime query is one shift and one AND.
 *
 * ── HOW IT IS COMPUTED ─────────────────────────────────────────────────────
 * Visibility is evaluated in 2D, in the horizontal plane, against building
 * footprints. That is the right dimensionality: a footprint that blocks the
 * sightline at street level blocks it at every height a player normally
 * occupies, and dropping Y turns a costly volumetric visibility problem into a
 * ray march that finishes in under a second for the whole city.
 *
 * From each of a few street-level sample points inside a chunk, `rayCount`
 * horizontal rays are cast at evenly spaced angles (seeded jitter breaks the
 * alignment between ray directions and the grid, which otherwise produces
 * repeating fans of false shadow). Each ray DDAs across the 96 m chunk grid,
 * marking every chunk it enters, and stops at the first footprint it hits.
 *
 * ── CONSERVATISM ───────────────────────────────────────────────────────────
 * A false positive costs a few draw calls. A false negative pops a building
 * out of existence. Everything here therefore errs towards keeping chunks:
 *
 *  - the whole chunk a ray dies inside is still marked visible, since the
 *    part of it in front of the occluder is genuinely visible;
 *  - the 3x3 ring around the viewer is forced visible, covering a camera
 *    sitting exactly on a chunk boundary;
 *  - the table is OR-symmetrised at the end. Real visibility is symmetric, so
 *    any asymmetry is a sampling artefact, and unioning A→B with B→A recovers
 *    sightlines that one side's sample points happened to miss.
 */

import { createRng, mixSeeds } from '@/util';
import {
  CHUNK_COUNT,
  CHUNK_GRID,
  CHUNK_SIZE,
  PVS_DEFAULT_RAY_COUNT,
  PVS_DEFAULT_SEED,
  PVS_MASK_WORDS,
  PVS_TOTAL_BYTES,
  WORLD_DIAGONAL,
  WORLD_MIN,
} from './constants';
import { rayRectEntry2D } from './aabb';
import type { IndexList } from './index-list';
import type { IChunkVisibility } from './quadtree';

/** A building footprint projected onto the XZ plane. */
export interface IFootprint {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

/** Builder knobs. Defaults are tuned for City Z. */
export interface IPvsBuildOptions {
  /** Horizontal rays per sampling origin. */
  readonly rayCount?: number;
  /** Street-level sample points per chunk: 1, 5 or 9. */
  readonly originSamples?: 1 | 5 | 9;
  /** Seed for the angular jitter. Determines the table exactly. */
  readonly seed?: number;
  /** Ray length cap in metres. */
  readonly maxDistance?: number;
  /** OR the table with its transpose. Leave on outside of experiments. */
  readonly symmetrise?: boolean;
  /** Chebyshev radius forced visible around every chunk. */
  readonly neighbourRing?: number;
  /** Called with (chunksDone, chunksTotal) roughly every 16 chunks. */
  readonly onProgress?: (done: number, total: number) => void;
}

/** Summary of a generated table. */
export interface IPvsStats {
  readonly chunks: number;
  readonly bytes: number;
  /** Mean chunks visible from a chunk. */
  readonly averageVisible: number;
  readonly minVisible: number;
  readonly maxVisible: number;
  /** Fraction of all (from, to) pairs the table rejects. */
  readonly occlusionRate: number;
  /** Milliseconds the build took, or 0 for a loaded table. */
  readonly buildMs: number;
}

/** Magic word `"PVS1"` for the serialised form. */
const PVS_MAGIC = 0x50565331;
const PVS_VERSION = 1;
const PVS_HEADER_BYTES = 16;

/* -------------------------------------------------------------------------- */
/* Runtime table                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The runtime side: 8 KB of bits plus the queries the renderer and the
 * streaming system make against it. Deliberately has no reference to the
 * builder or to any geometry, so a cached table loads without them.
 */
export class PvsTable implements IChunkVisibility {
  /** 256 chunks x 8 uint32 words. */
  readonly masks: Uint32Array;
  /** Milliseconds spent building, 0 when deserialised. */
  buildMs = 0;

  constructor(masks?: Uint32Array) {
    if (masks !== undefined) {
      if (masks.length !== CHUNK_COUNT * PVS_MASK_WORDS) {
        throw new Error(
          `PvsTable: expected ${CHUNK_COUNT * PVS_MASK_WORDS} words, got ${masks.length}`
        );
      }
      this.masks = masks;
    } else {
      this.masks = new Uint32Array(CHUNK_COUNT * PVS_MASK_WORDS);
    }
  }

  /** A table where everything sees everything. The safe fallback. */
  static everythingVisible(): PvsTable {
    const table = new PvsTable();
    table.masks.fill(0xffffffff);
    return table;
  }

  /** True when chunk `to` may be visible from chunk `from`. */
  isVisible(from: number, to: number): boolean {
    if (from < 0 || from >= CHUNK_COUNT || to < 0 || to >= CHUNK_COUNT) return true;
    return (this.masks[from * PVS_MASK_WORDS + (to >>> 5)]! & (1 << (to & 31))) !== 0;
  }

  /** Set one bit. Builder / test use. */
  setVisible(from: number, to: number): void {
    const w = from * PVS_MASK_WORDS + (to >>> 5);
    this.masks[w] = this.masks[w]! | (1 << (to & 31));
  }

  /** A zero-copy view of one chunk's mask. Do not retain across rebuilds. */
  maskFor(from: number): Uint32Array {
    const base = from * PVS_MASK_WORDS;
    return this.masks.subarray(base, base + PVS_MASK_WORDS);
  }

  /** Chunks visible from `from`. */
  visibleCount(from: number): number {
    const base = from * PVS_MASK_WORDS;
    let n = 0;
    for (let w = 0; w < PVS_MASK_WORDS; w++) n += popcount32(this.masks[base + w]!);
    return n;
  }

  /** Append every visible chunk index to `out`. Allocation-free. */
  collectVisible(from: number, out: IndexList): number {
    out.clear();
    if (from < 0 || from >= CHUNK_COUNT) {
      for (let i = 0; i < CHUNK_COUNT; i++) out.push(i);
      return out.length;
    }
    const base = from * PVS_MASK_WORDS;
    for (let w = 0; w < PVS_MASK_WORDS; w++) {
      let bits = this.masks[base + w]!;
      while (bits !== 0) {
        const lsb = bits & -bits;
        out.push((w << 5) + trailingZeros32(lsb));
        bits ^= lsb;
      }
    }
    return out.length;
  }

  /** True when the table is exactly symmetric (A sees B iff B sees A). */
  isSymmetric(): boolean {
    for (let a = 0; a < CHUNK_COUNT; a++) {
      for (let b = a + 1; b < CHUNK_COUNT; b++) {
        if (this.isVisible(a, b) !== this.isVisible(b, a)) return false;
      }
    }
    return true;
  }

  stats(): IPvsStats {
    let total = 0;
    let min = CHUNK_COUNT;
    let max = 0;
    for (let c = 0; c < CHUNK_COUNT; c++) {
      const n = this.visibleCount(c);
      total += n;
      if (n < min) min = n;
      if (n > max) max = n;
    }
    const pairs = CHUNK_COUNT * CHUNK_COUNT;
    return {
      chunks: CHUNK_COUNT,
      bytes: this.masks.byteLength,
      averageVisible: total / CHUNK_COUNT,
      minVisible: min,
      maxVisible: max,
      occlusionRate: 1 - total / pairs,
      buildMs: this.buildMs,
    };
  }

  /**
   * Pack to bytes for the asset cache: 16-byte header then 8192 mask bytes.
   * Little-endian, so the same file loads on every platform the game ships to.
   */
  serialize(): Uint8Array {
    const bytes = new Uint8Array(PVS_HEADER_BYTES + PVS_TOTAL_BYTES);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, PVS_MAGIC, true);
    view.setUint32(4, PVS_VERSION, true);
    view.setUint32(8, CHUNK_GRID, true);
    view.setUint32(12, checksum(this.masks), true);
    for (let i = 0; i < this.masks.length; i++) {
      view.setUint32(PVS_HEADER_BYTES + i * 4, this.masks[i]!, true);
    }
    return bytes;
  }

  /** Inverse of `serialize`. Throws on a corrupt or foreign-world table. */
  static deserialize(bytes: Uint8Array): PvsTable {
    if (bytes.length !== PVS_HEADER_BYTES + PVS_TOTAL_BYTES) {
      throw new Error(`PvsTable.deserialize: expected ${PVS_HEADER_BYTES + PVS_TOTAL_BYTES} bytes`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== PVS_MAGIC) throw new Error('PvsTable.deserialize: bad magic');
    if (view.getUint32(4, true) !== PVS_VERSION) {
      throw new Error('PvsTable.deserialize: version mismatch');
    }
    if (view.getUint32(8, true) !== CHUNK_GRID) {
      throw new Error('PvsTable.deserialize: chunk grid mismatch');
    }
    const masks = new Uint32Array(CHUNK_COUNT * PVS_MASK_WORDS);
    for (let i = 0; i < masks.length; i++) {
      masks[i] = view.getUint32(PVS_HEADER_BYTES + i * 4, true);
    }
    if (view.getUint32(12, true) !== checksum(masks)) {
      throw new Error('PvsTable.deserialize: checksum mismatch');
    }
    return new PvsTable(masks);
  }
}

function popcount32(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function trailingZeros32(v: number): number {
  return 31 - Math.clz32(v & -v);
}

function checksum(words: Uint32Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < words.length; i++) {
    h = (Math.imul(h ^ words[i]!, 0x01000193) >>> 0) ^ (i & 0xff);
  }
  return h >>> 0;
}

/* -------------------------------------------------------------------------- */
/* Occluder acceleration                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Footprints bucketed by the chunks they touch, in CSR form.
 *
 * The ray march visits chunks one at a time, so it only ever needs the
 * footprints in the chunk it is currently crossing. Bucketing turns "test every
 * building in the city per ray step" into "test the three in this chunk".
 */
class FootprintGrid {
  readonly bounds: Float64Array;
  readonly cellStart: Int32Array;
  readonly cellItems: Int32Array;

  constructor(footprints: readonly IFootprint[]) {
    const n = footprints.length;
    this.bounds = new Float64Array(n * 4);
    for (let i = 0; i < n; i++) {
      const f = footprints[i]!;
      this.bounds[i * 4] = f.minX;
      this.bounds[i * 4 + 1] = f.minZ;
      this.bounds[i * 4 + 2] = f.maxX;
      this.bounds[i * 4 + 3] = f.maxZ;
    }

    const counts = new Int32Array(CHUNK_COUNT);
    let totalRefs = 0;
    for (let i = 0; i < n; i++) {
      totalRefs += this.forEachCell(i, (cell) => {
        counts[cell] = counts[cell]! + 1;
      });
    }

    this.cellStart = new Int32Array(CHUNK_COUNT + 1);
    for (let c = 0; c < CHUNK_COUNT; c++) this.cellStart[c + 1] = this.cellStart[c]! + counts[c]!;

    this.cellItems = new Int32Array(totalRefs);
    const cursor = this.cellStart.slice(0, CHUNK_COUNT);
    for (let i = 0; i < n; i++) {
      this.forEachCell(i, (cell) => {
        const at = cursor[cell]!;
        this.cellItems[at] = i;
        cursor[cell] = at + 1;
      });
    }
  }

  /** Visit every chunk the footprint overlaps. Returns the visit count. */
  private forEachCell(index: number, visit: (cell: number) => void): number {
    const o = index * 4;
    const gx0 = clampCell(Math.floor((this.bounds[o]! - WORLD_MIN) / CHUNK_SIZE));
    const gz0 = clampCell(Math.floor((this.bounds[o + 1]! - WORLD_MIN) / CHUNK_SIZE));
    const gx1 = clampCell(Math.floor((this.bounds[o + 2]! - WORLD_MIN) / CHUNK_SIZE));
    const gz1 = clampCell(Math.floor((this.bounds[o + 3]! - WORLD_MIN) / CHUNK_SIZE));
    let count = 0;
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        visit(gz * CHUNK_GRID + gx);
        count++;
      }
    }
    return count;
  }

  /** True when the point lies inside any footprint of the given cell. */
  containsPoint(cell: number, x: number, z: number): boolean {
    const start = this.cellStart[cell]!;
    const end = this.cellStart[cell + 1]!;
    for (let i = start; i < end; i++) {
      const o = this.cellItems[i]! * 4;
      if (
        x >= this.bounds[o]! &&
        x <= this.bounds[o + 2]! &&
        z >= this.bounds[o + 1]! &&
        z <= this.bounds[o + 3]!
      ) {
        return true;
      }
    }
    return false;
  }
}

function clampCell(v: number): number {
  return v < 0 ? 0 : v >= CHUNK_GRID ? CHUNK_GRID - 1 : v;
}

/* -------------------------------------------------------------------------- */
/* Builder                                                                    */
/* -------------------------------------------------------------------------- */

/** Sample-point offsets inside a chunk, as fractions of the chunk edge. */
const ORIGIN_PATTERNS: Readonly<Record<number, readonly number[]>> = {
  1: [0.5, 0.5],
  5: [0.5, 0.5, 0.25, 0.25, 0.75, 0.25, 0.25, 0.75, 0.75, 0.75],
  9: [
    1 / 6, 1 / 6, 0.5, 1 / 6, 5 / 6, 1 / 6, 1 / 6, 0.5, 0.5, 0.5, 5 / 6, 0.5, 1 / 6, 5 / 6, 0.5,
    5 / 6, 5 / 6, 5 / 6,
  ],
};

/**
 * Generate the visibility table for a set of building footprints.
 *
 * Deterministic: the same footprints and seed always produce a byte-identical
 * table, and the per-chunk RNG stream is derived from the chunk index rather
 * than threaded through the loop, so the result does not depend on iteration
 * order or on how the work is split across threads.
 */
export function buildPvs(
  footprints: readonly IFootprint[],
  options: IPvsBuildOptions = {}
): PvsTable {
  const rayCount = options.rayCount ?? PVS_DEFAULT_RAY_COUNT;
  const originSamples = options.originSamples ?? 5;
  const seed = options.seed ?? PVS_DEFAULT_SEED;
  const maxDistance = options.maxDistance ?? WORLD_DIAGONAL;
  const symmetrise = options.symmetrise ?? true;
  const ring = options.neighbourRing ?? 1;

  const started = now();
  const table = new PvsTable();
  const grid = new FootprintGrid(footprints);
  const pattern = ORIGIN_PATTERNS[originSamples] ?? ORIGIN_PATTERNS[5]!;
  const originCount = pattern.length >> 1;

  for (let chunk = 0; chunk < CHUNK_COUNT; chunk++) {
    const cx = chunk % CHUNK_GRID;
    const cz = (chunk / CHUNK_GRID) | 0;
    const baseX = WORLD_MIN + cx * CHUNK_SIZE;
    const baseZ = WORLD_MIN + cz * CHUNK_SIZE;

    // Per-chunk stream derived from the chunk index: order-independent, so the
    // table is identical whether chunks are built serially or in parallel.
    const rng = createRng(mixSeeds(seed, chunk));

    // A chunk always sees itself, plus its ring.
    table.setVisible(chunk, chunk);
    for (let dz = -ring; dz <= ring; dz++) {
      for (let dx = -ring; dx <= ring; dx++) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nx >= CHUNK_GRID || nz < 0 || nz >= CHUNK_GRID) continue;
        table.setVisible(chunk, nz * CHUNK_GRID + nx);
      }
    }

    // Street-level origins: sample points not buried inside a footprint. If a
    // chunk is completely built over, fall back to the centre and ignore the
    // footprint enclosing it rather than emitting an empty mask.
    let validOrigins = 0;
    for (let s = 0; s < originCount; s++) {
      const ox = baseX + pattern[s * 2]! * CHUNK_SIZE;
      const oz = baseZ + pattern[s * 2 + 1]! * CHUNK_SIZE;
      const jitter = rng.next();
      if (grid.containsPoint(chunk, ox, oz)) continue;
      validOrigins++;
      castFan(table, grid, chunk, ox, oz, rayCount, jitter, maxDistance, false);
    }

    if (validOrigins === 0) {
      castFan(
        table,
        grid,
        chunk,
        baseX + CHUNK_SIZE * 0.5,
        baseZ + CHUNK_SIZE * 0.5,
        rayCount,
        rng.next(),
        maxDistance,
        true
      );
    }

    if (options.onProgress !== undefined && (chunk & 15) === 15) {
      options.onProgress(chunk + 1, CHUNK_COUNT);
    }
  }

  if (symmetrise) symmetriseTable(table);

  table.buildMs = now() - started;
  return table;
}

/** OR the table with its transpose, in place. */
function symmetriseTable(table: PvsTable): void {
  for (let a = 0; a < CHUNK_COUNT; a++) {
    for (let b = a + 1; b < CHUNK_COUNT; b++) {
      if (table.isVisible(a, b)) table.setVisible(b, a);
      else if (table.isVisible(b, a)) table.setVisible(a, b);
    }
  }
}

/**
 * Cast `rayCount` evenly spaced horizontal rays from one origin and mark every
 * chunk they reach.
 *
 * `jitter` in [0, 1) rotates the whole fan by up to one ray spacing. Without it
 * every origin fires along the same absolute angles, and because those angles
 * repeat against a regular street grid the result is a fan of identical false
 * shadows in every chunk — visible in the harness as radial stripes.
 */
function castFan(
  table: PvsTable,
  grid: FootprintGrid,
  fromChunk: number,
  ox: number,
  oz: number,
  rayCount: number,
  jitter: number,
  maxDistance: number,
  ignoreEnclosing: boolean
): void {
  const step = (Math.PI * 2) / rayCount;
  const phase = jitter * step;
  for (let i = 0; i < rayCount; i++) {
    const angle = phase + i * step;
    marchRay(table, grid, fromChunk, ox, oz, Math.cos(angle), Math.sin(angle), maxDistance, ignoreEnclosing);
  }
}

/**
 * March one horizontal ray across the chunk grid, marking chunks visible until
 * a footprint stops it.
 *
 * Standard 2D DDA. The chunk a ray dies inside is marked BEFORE the occluder
 * test, because the strip of that chunk in front of the building really is
 * visible — refusing to mark it is exactly the false negative that pops a
 * façade out of existence as the camera turns.
 */
function marchRay(
  table: PvsTable,
  grid: FootprintGrid,
  fromChunk: number,
  ox: number,
  oz: number,
  dx: number,
  dz: number,
  maxDistance: number,
  ignoreEnclosing: boolean
): void {
  let gx = Math.floor((ox - WORLD_MIN) / CHUNK_SIZE);
  let gz = Math.floor((oz - WORLD_MIN) / CHUNK_SIZE);
  if (gx < 0 || gx >= CHUNK_GRID || gz < 0 || gz >= CHUNK_GRID) return;

  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  const invAbsX = dx !== 0 ? 1 / Math.abs(dx) : Infinity;
  const invAbsZ = dz !== 0 ? 1 / Math.abs(dz) : Infinity;
  const tDeltaX = dx !== 0 ? CHUNK_SIZE * invAbsX : Infinity;
  const tDeltaZ = dz !== 0 ? CHUNK_SIZE * invAbsZ : Infinity;

  const cellMinX = WORLD_MIN + gx * CHUNK_SIZE;
  const cellMinZ = WORLD_MIN + gz * CHUNK_SIZE;
  let tMaxX =
    dx > 0
      ? (cellMinX + CHUNK_SIZE - ox) * invAbsX
      : dx < 0
        ? (ox - cellMinX) * invAbsX
        : Infinity;
  let tMaxZ =
    dz > 0
      ? (cellMinZ + CHUNK_SIZE - oz) * invAbsZ
      : dz < 0
        ? (oz - cellMinZ) * invAbsZ
        : Infinity;

  let tEnter = 0;
  for (;;) {
    const cell = gz * CHUNK_GRID + gx;
    table.setVisible(fromChunk, cell);

    const tExit = tMaxX < tMaxZ ? tMaxX : tMaxZ;
    const segmentEnd = tExit < maxDistance ? tExit : maxDistance;

    if (blocked(grid, cell, ox, oz, dx, dz, tEnter, segmentEnd, ignoreEnclosing)) return;
    if (segmentEnd >= maxDistance) return;

    tEnter = tExit;
    if (tMaxX < tMaxZ) {
      gx += stepX;
      tMaxX += tDeltaX;
    } else {
      gz += stepZ;
      tMaxZ += tDeltaZ;
    }
    if (gx < 0 || gx >= CHUNK_GRID || gz < 0 || gz >= CHUNK_GRID) return;
  }
}

/** True when a footprint in `cell` intercepts the ray inside `[tEnter, tExit]`. */
function blocked(
  grid: FootprintGrid,
  cell: number,
  ox: number,
  oz: number,
  dx: number,
  dz: number,
  tEnter: number,
  tExit: number,
  ignoreEnclosing: boolean
): boolean {
  const start = grid.cellStart[cell]!;
  const end = grid.cellStart[cell + 1]!;
  for (let i = start; i < end; i++) {
    const o = grid.cellItems[i]! * 4;
    const minX = grid.bounds[o]!;
    const minZ = grid.bounds[o + 1]!;
    const maxX = grid.bounds[o + 2]!;
    const maxZ = grid.bounds[o + 3]!;
    if (ignoreEnclosing && ox >= minX && ox <= maxX && oz >= minZ && oz <= maxZ) continue;
    const t = rayRectEntry2D(ox, oz, dx, dz, tExit, minX, minZ, maxX, maxZ);
    if (t !== Infinity && t >= tEnter) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Ground truth (verification only)                                           */
/* -------------------------------------------------------------------------- */

/**
 * Exhaustive point-to-point visibility between two chunks, for tests.
 *
 * Samples an `n x n` lattice of street-level points in each chunk and reports
 * whether ANY pair has a clear segment between them. This is the definition the
 * ray-sampled table approximates, so it is what a false-negative audit has to
 * measure against. Cost is O(n^4) segment tests per pair — fine for a few
 * hundred pairs in a test, hopeless for all 65,536.
 */
export function groundTruthVisible(
  footprints: readonly IFootprint[],
  fromChunk: number,
  toChunk: number,
  samplesPerAxis = 6
): boolean {
  if (fromChunk === toChunk) return true;

  const fx = (fromChunk % CHUNK_GRID) * CHUNK_SIZE + WORLD_MIN;
  const fz = ((fromChunk / CHUNK_GRID) | 0) * CHUNK_SIZE + WORLD_MIN;
  const tx = (toChunk % CHUNK_GRID) * CHUNK_SIZE + WORLD_MIN;
  const tz = ((toChunk / CHUNK_GRID) | 0) * CHUNK_SIZE + WORLD_MIN;

  const inside = (x: number, z: number): boolean => {
    for (let i = 0; i < footprints.length; i++) {
      const f = footprints[i]!;
      if (x >= f.minX && x <= f.maxX && z >= f.minZ && z <= f.maxZ) return true;
    }
    return false;
  };

  const stepFraction = 1 / (samplesPerAxis + 1);
  for (let az = 1; az <= samplesPerAxis; az++) {
    for (let ax = 1; ax <= samplesPerAxis; ax++) {
      const px = fx + ax * stepFraction * CHUNK_SIZE;
      const pz = fz + az * stepFraction * CHUNK_SIZE;
      if (inside(px, pz)) continue;

      for (let bz = 1; bz <= samplesPerAxis; bz++) {
        for (let bx = 1; bx <= samplesPerAxis; bx++) {
          const qx = tx + bx * stepFraction * CHUNK_SIZE;
          const qz = tz + bz * stepFraction * CHUNK_SIZE;
          if (inside(qx, qz)) continue;
          if (segmentClear(footprints, px, pz, qx, qz)) return true;
        }
      }
    }
  }
  return false;
}

/** True when no footprint intersects the open segment p→q. */
function segmentClear(
  footprints: readonly IFootprint[],
  px: number,
  pz: number,
  qx: number,
  qz: number
): boolean {
  const dx = qx - px;
  const dz = qz - pz;
  const length = Math.hypot(dx, dz);
  if (length === 0) return true;
  const nx = dx / length;
  const nz = dz / length;
  for (let i = 0; i < footprints.length; i++) {
    const f = footprints[i]!;
    const t = rayRectEntry2D(px, pz, nx, nz, length, f.minX, f.minZ, f.maxX, f.maxZ);
    if (t !== Infinity) return false;
  }
  return true;
}

/** Monotonic clock that works in the browser, in Node and under vitest. */
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
