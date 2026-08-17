/**
 * ATLAS BAKER — geometry in, PBR maps out
 *
 * This is what turns "untextured geometry with vertex colours" into a
 * character. It rasterises the mesh IN UV SPACE and, for every texel a
 * triangle covers, resolves:
 *
 *     albedo   base colour x CC0 detail x weave x wear x occlusion tint
 *     ORM      baked AO (R), per-class roughness x detail (G), metalness (B)
 *     normal   CC0 tangent normal blended with a synthesised weave/plate relief
 *     emissive only where a class or a face actually glows
 *
 * ── WHY BAKE INSTEAD OF BINDING FIVE MATERIALS ────────────────────────────
 * The mesh ships five material slots, so the obvious move is five materials.
 * That costs five draw calls per character, five shader programs, and it still
 * cannot tell Saitama's yellow jumpsuit from his skin, because both are
 * painted onto the same slot. Baking solves both at once: ONE material, ONE
 * draw call, and metalness varies PER TEXEL — which is what lets Genos' bare
 * forearms be metal 1.0 while his shirt in the same draw call is metal 0.0.
 *
 * ── DETERMINISM ───────────────────────────────────────────────────────────
 * Every random decision comes from `createRng(seed)`; `Math.random` appears
 * nowhere. The same character and seed produce byte-identical maps, which is
 * what makes the build cacheable and the test meaningful.
 *
 * ── AO IS INJECTED, NOT IMPORTED ──────────────────────────────────────────
 * Ray-traced occlusion needs a BVH, and a BVH has no business in the browser
 * bundle for a job that only ever runs offline. So the baker takes an
 * `OcclusionSampler` callback; the offline tool supplies a real one and the
 * fallback here is an analytic cavity estimate that is good enough for a test.
 */

import type * as THREE from 'three';
import type { HumanoidBuild, UVRect, UVRegionName } from '@/characters/mesh';
import { UV_REGIONS } from '@/characters/mesh';
import { clamp01, createRng, lerp } from '@/util';
import type { ColorClassifier } from './classify';
import { classifyTriangles } from './classify';
import type {
  AtlasBakeOptions,
  AtlasMaps,
  DetailTile,
  FacePatch,
  MicroPattern,
  SurfaceClass,
  SurfaceStyleSet,
} from './types';
import { SURFACE_CLASSES, TINT_MASK_LEVEL } from './types';

/** Default atlas edge. 1024 gives the face ~305x131 texels; see `face.ts`. */
export const ATLAS_SIZE = 1024;

/** Texel bleed passes. Enough to survive three mip levels of bilinear taps. */
const DILATE_PASSES = 6;

/* -------------------------------------------------------------------------- */
/* Small deterministic noise                                                  */
/* -------------------------------------------------------------------------- */

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x85ebca6b) ^ Math.imul(seed, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Value noise in [0, 1). */
function noise2(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = smooth(x - xi);
  const yf = smooth(y - yi);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return lerp(lerp(a, b, xf), lerp(c, d, xf), yf);
}

function fbm(x: number, y: number, seed: number, octaves = 3): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(x * freq, y * freq, seed + i * 37) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

/* -------------------------------------------------------------------------- */
/* Micro patterns                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Height of a synthetic surface pattern at a tiled coordinate, in [-1, 1].
 *
 * These are what make cloth read as cloth. A photograph of plaster gives
 * irregular grain but no THREAD DIRECTION, and thread direction is most of
 * what the eye uses to identify a woven surface at arm's length.
 */
function patternHeight(kind: MicroPattern, x: number, y: number, seed: number): number {
  switch (kind) {
    case 'none':
      return 0;
    case 'weave': {
      const threads = 8;
      const gx = x * threads;
      const gy = y * threads;
      const cx = Math.floor(gx);
      const cy = Math.floor(gy);
      const fx = gx - cx;
      const fy = gy - cy;
      const over = (cx + cy) % 2 === 0;
      const ridge = over ? Math.cos((fy - 0.5) * Math.PI) : Math.cos((fx - 0.5) * Math.PI);
      const slub = (fbm(x * 3.1, y * 3.7, seed, 2) - 0.5) * 0.5;
      return ridge * 0.8 + slub;
    }
    case 'twill': {
      const threads = 10;
      const rib = Math.cos((x + y) * threads * Math.PI * 2);
      const slub = (fbm(x * 4.3, y * 4.1, seed + 11, 2) - 0.5) * 0.6;
      return rib * 0.7 + slub;
    }
    case 'canvas': {
      const threads = 5;
      const gx = x * threads;
      const gy = y * threads;
      const cx = Math.floor(gx);
      const cy = Math.floor(gy);
      const over = (cx + cy) % 2 === 0;
      const ridge = over
        ? Math.cos((gy - cy - 0.5) * Math.PI)
        : Math.cos((gx - cx - 0.5) * Math.PI);
      const slub = (fbm(x * 2.2, y * 2.6, seed + 5, 3) - 0.5) * 1.1;
      return clampSigned(ridge * 0.62 + slub);
    }
    case 'leather': {
      // Cells with creased borders: two noise fields, one for the grain and a
      // ridged one for the cracks between grains.
      const cell = fbm(x * 6.1, y * 6.3, seed + 3, 2);
      const crack = Math.abs(fbm(x * 3.3, y * 3.1, seed + 9, 3) - 0.5) * 2;
      return clampSigned((cell - 0.5) * 1.4 - Math.pow(1 - crack, 6) * 1.2);
    }
    case 'pores': {
      const fine = fbm(x * 22, y * 22, seed + 17, 2) - 0.5;
      const pore = hash2(Math.floor(x * 60), Math.floor(y * 60), seed + 23);
      return clampSigned(fine * 0.5 - (pore > 0.985 ? 0.9 : 0));
    }
    case 'strand': {
      const strands = 26;
      const wobble = (fbm(x * 2.0, y * 5.0, seed + 31, 2) - 0.5) * 0.35;
      const s = Math.cos((x + wobble) * strands * Math.PI * 2);
      const flow = fbm(x * 1.4, y * 0.8, seed + 41, 2) - 0.5;
      return clampSigned(s * 0.7 + flow * 0.7);
    }
    case 'brushed': {
      const streak = fbm(x * 60, y * 1.6, seed + 53, 2) - 0.5;
      return clampSigned(streak * 1.6);
    }
    case 'hexcell': {
      // Axial hex lattice distance field.
      const q = x * 8;
      const r = y * 8;
      const row = Math.floor(r);
      const offset = (row % 2) * 0.5;
      const cx = Math.floor(q + offset) - offset;
      const fx = q - cx - 0.5;
      const fy = r - row - 0.5;
      const d = Math.max(Math.abs(fx), Math.abs(fx) * 0.5 + Math.abs(fy) * 0.866);
      return clampSigned(0.6 - d * 1.6);
    }
    case 'scale': {
      const cols = 9;
      const rows = 13;
      const gy = y * rows;
      const row = Math.floor(gy);
      const fy = gy - row;
      const gx = x * cols + (row % 2) * 0.5;
      const col = Math.floor(gx);
      const fx = gx - col - 0.5;
      // A scale is a dome that fades out at its lower edge.
      const d = Math.sqrt(fx * fx * 1.6 + (fy - 0.15) * (fy - 0.15) * 0.9);
      const dome = Math.max(0, 1 - d * 1.9);
      return clampSigned(dome * 1.3 - 0.35);
    }
    case 'pebble': {
      const bump = fbm(x * 9, y * 9, seed + 61, 3) - 0.5;
      return clampSigned(bump * 2);
    }
  }
}

function clampSigned(value: number): number {
  return value < -1 ? -1 : value > 1 ? 1 : value;
}

/**
 * Cycles each pattern packs into ONE tile.
 *
 * Needed to keep patterns above the Nyquist limit of the atlas. The unwrap's
 * texel density varies by a factor of three across a character — the leg
 * rectangle covers 3.4 m of surface per UV unit against the body's 1.4 — so a
 * single "tiles per metre" number that looks like fine cotton on the torso is
 * pure moire on the shins. Clamping frequency per region is what turns that
 * shimmer into fabric.
 */
const PATTERN_CYCLES: Readonly<Record<MicroPattern, number>> = {
  none: 1,
  weave: 8,
  twill: 10,
  canvas: 5,
  leather: 6,
  pores: 22,
  strand: 26,
  brushed: 60,
  hexcell: 8,
  scale: 13,
  pebble: 9,
};

/** Texels a pattern cycle must span before it is allowed to exist. */
const MIN_TEXELS_PER_CYCLE = 5;

/* -------------------------------------------------------------------------- */
/* Colour space                                                               */
/* -------------------------------------------------------------------------- */

function linearToSrgb(value: number): number {
  const v = clamp01(value);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function srgbToLinear(value: number): number {
  const v = clamp01(value);
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/* -------------------------------------------------------------------------- */
/* Region density                                                             */
/* -------------------------------------------------------------------------- */

const REGION_NAMES = Object.keys(UV_REGIONS) as UVRegionName[];

function rectOf(u: number, v: number): UVRegionName {
  for (const name of REGION_NAMES) {
    const r = UV_REGIONS[name];
    if (u >= r.u0 - 1e-4 && u <= r.u1 + 1e-4 && v >= r.v0 - 1e-4 && v <= r.v1 + 1e-4) return name;
  }
  return 'body';
}

/** Metres of surface per unit of UV, per named rectangle. */
function regionDensities(
  geometry: THREE.BufferGeometry,
  triRect: Uint8Array
): Record<UVRegionName, number> {
  const index = geometry.getIndex();
  const position = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  if (index === null) throw new Error('roster: geometry must be indexed');

  const world: Record<string, number> = {};
  const space: Record<string, number> = {};

  const triangles = index.count / 3;
  for (let t = 0; t < triangles; t++) {
    const a = index.getX(t * 3);
    const b = index.getX(t * 3 + 1);
    const c = index.getX(t * 3 + 2);

    const ax = position.getX(a);
    const ay = position.getY(a);
    const az = position.getZ(a);
    const e1x = position.getX(b) - ax;
    const e1y = position.getY(b) - ay;
    const e1z = position.getZ(b) - az;
    const e2x = position.getX(c) - ax;
    const e2y = position.getY(c) - ay;
    const e2z = position.getZ(c) - az;
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    const area3 = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);

    const au = uv.getX(a);
    const av = uv.getY(a);
    const areaUv =
      0.5 *
      Math.abs((uv.getX(b) - au) * (uv.getY(c) - av) - (uv.getX(c) - au) * (uv.getY(b) - av));

    const name = REGION_NAMES[triRect[t]!]!;
    world[name] = (world[name] ?? 0) + area3;
    space[name] = (space[name] ?? 0) + areaUv;
  }

  const out = {} as Record<UVRegionName, number>;
  for (const name of REGION_NAMES) {
    const w = world[name] ?? 0;
    const s = space[name] ?? 0;
    out[name] = s > 1e-9 ? Math.sqrt(w / s) : 1;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Detail sampling                                                            */
/* -------------------------------------------------------------------------- */

function wrapIndex(value: number, size: number): number {
  const i = Math.floor(value) % size;
  return i < 0 ? i + size : i;
}

/**
 * A box-filtered pyramid over one detail tile.
 *
 * The CC0 sources are 4k photographs downsampled to a 512 tile, and the bake
 * then MINIFIES them again — by 8x on a limb. Point or bilinear sampling of an
 * 8x minified photograph is not detail, it is noise, and it is what made the
 * first metal close-up sparkle like static. A three-level pyramid plus a
 * footprint-driven level choice costs a few milliseconds and removes it.
 */
interface TilePyramid {
  readonly levels: readonly { size: number; albedo: Uint8Array; normal: Uint8Array; arm: Uint8Array }[];
}

function halve(data: Uint8Array, size: number): Uint8Array {
  const half = size >> 1;
  const out = new Uint8Array(half * half * 3);
  for (let y = 0; y < half; y++) {
    for (let x = 0; x < half; x++) {
      const o = (y * half + x) * 3;
      for (let c = 0; c < 3; c++) {
        const a = data[((y * 2) * size + x * 2) * 3 + c]!;
        const b = data[((y * 2) * size + x * 2 + 1) * 3 + c]!;
        const d = data[((y * 2 + 1) * size + x * 2) * 3 + c]!;
        const e = data[((y * 2 + 1) * size + x * 2 + 1) * 3 + c]!;
        out[o + c] = (a + b + d + e + 2) >> 2;
      }
    }
  }
  return out;
}

function buildPyramid(tile: DetailTile, levels = 3): TilePyramid {
  const out: { size: number; albedo: Uint8Array; normal: Uint8Array; arm: Uint8Array }[] = [
    { size: tile.size, albedo: tile.albedo, normal: tile.normal, arm: tile.arm },
  ];
  for (let i = 1; i < levels; i++) {
    const previous = out[i - 1]!;
    if (previous.size <= 16) break;
    out.push({
      size: previous.size >> 1,
      albedo: halve(previous.albedo, previous.size),
      normal: halve(previous.normal, previous.size),
      arm: halve(previous.arm, previous.size),
    });
  }
  return { levels: out };
}

/**
 * Bilinear, wrapping tile fetch.
 *
 * Bilinear rather than nearest because a 4k CC0 source downsampled to a 512
 * tile and then MINIFIED again onto a limb island aliases badly under point
 * sampling — and aliased grain reads as noise, which is exactly the "cheap
 * texture" look the whole bake exists to avoid.
 */
function sampleTile(data: Uint8Array, size: number, x: number, y: number, out: Float32Array): void {
  const fx = x * size - 0.5;
  const fy = y * size - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const xa = wrapIndex(x0, size);
  const xb = wrapIndex(x0 + 1, size);
  const ya = wrapIndex(y0, size);
  const yb = wrapIndex(y0 + 1, size);
  const oaa = (ya * size + xa) * 3;
  const oba = (ya * size + xb) * 3;
  const oab = (yb * size + xa) * 3;
  const obb = (yb * size + xb) * 3;
  for (let c = 0; c < 3; c++) {
    const top = data[oaa + c]! + (data[oba + c]! - data[oaa + c]!) * tx;
    const bottom = data[oab + c]! + (data[obb + c]! - data[oab + c]!) * tx;
    out[c] = (top + (bottom - top) * ty) / 255;
  }
}

/* -------------------------------------------------------------------------- */
/* Bake                                                                       */
/* -------------------------------------------------------------------------- */

interface Raster {
  readonly covered: Uint8Array;
  readonly classId: Uint8Array;
  readonly color: Float32Array;
  readonly local: Float32Array;
  readonly rect: Uint8Array;
  readonly position: Float32Array;
  readonly normal: Float32Array;
}

function rasterise(
  build: HumanoidBuild,
  triClass: readonly SurfaceClass[],
  triRect: Uint8Array,
  size: number
): Raster {
  const geometry = build.geometry;
  const index = geometry.getIndex()!;
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const uv = geometry.getAttribute('uv');
  const color = geometry.getAttribute('color');

  const texels = size * size;
  const raster: Raster = {
    covered: new Uint8Array(texels),
    classId: new Uint8Array(texels),
    color: new Float32Array(texels * 3),
    local: new Float32Array(texels * 2),
    rect: new Uint8Array(texels),
    position: new Float32Array(texels * 3),
    normal: new Float32Array(texels * 3),
  };

  const triangles = index.count / 3;
  for (let t = 0; t < triangles; t++) {
    const ia = index.getX(t * 3);
    const ib = index.getX(t * 3 + 1);
    const ic = index.getX(t * 3 + 2);

    // Pixel-space triangle. The half-texel offset puts sample points at texel
    // centres, which is where a GPU samples them.
    const ax = uv.getX(ia) * size - 0.5;
    const ay = uv.getY(ia) * size - 0.5;
    const bx = uv.getX(ib) * size - 0.5;
    const by = uv.getY(ib) * size - 0.5;
    const cx = uv.getX(ic) * size - 0.5;
    const cy = uv.getY(ic) * size - 0.5;

    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(area) < 1e-9) continue;
    const invArea = 1 / area;

    // Expand the box by one texel so thin slivers still light their texels.
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)) - 1);
    const maxX = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx)) + 1);
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)) - 1);
    const maxY = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy)) + 1);

    const classId = SURFACE_CLASSES.indexOf(triClass[t]!);
    const rect = triRect[t]!;

    // Half a texel, expressed in barycentric units for THIS triangle. Snapping
    // marginally-outside samples onto the edge rather than dropping them is
    // what stops a sliver triangle from leaving an unwritten line down a seam.
    const slack = 0.5 / Math.max(1, maxX - minX, maxY - minY);

    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        let w0 = ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) * invArea;
        let w1 = ((px - ax) * (cy - ay) - (cx - ax) * (py - ay)) * invArea;
        if (w0 < -slack || w1 < -slack || w0 + w1 > 1 + slack) continue;
        w0 = clamp01(w0);
        w1 = clamp01(w1);
        const total = w0 + w1;
        if (total > 1) {
          w0 /= total;
          w1 /= total;
        }
        const w2 = 1 - w0 - w1;
        // Barycentric convention: w2 belongs to a, w1 to b, w0 to c.
        const la = w2;
        const lb = w1;
        const lc = w0;

        const texel = py * size + px;
        raster.covered[texel] = 1;
        raster.classId[texel] = classId;
        raster.rect[texel] = rect;

        const o3 = texel * 3;
        raster.color[o3] = color.getX(ia) * la + color.getX(ib) * lb + color.getX(ic) * lc;
        raster.color[o3 + 1] = color.getY(ia) * la + color.getY(ib) * lb + color.getY(ic) * lc;
        raster.color[o3 + 2] = color.getZ(ia) * la + color.getZ(ib) * lb + color.getZ(ic) * lc;

        raster.position[o3] =
          position.getX(ia) * la + position.getX(ib) * lb + position.getX(ic) * lc;
        raster.position[o3 + 1] =
          position.getY(ia) * la + position.getY(ib) * lb + position.getY(ic) * lc;
        raster.position[o3 + 2] =
          position.getZ(ia) * la + position.getZ(ib) * lb + position.getZ(ic) * lc;

        const nx = normal.getX(ia) * la + normal.getX(ib) * lb + normal.getX(ic) * lc;
        const ny = normal.getY(ia) * la + normal.getY(ib) * lb + normal.getY(ic) * lc;
        const nz = normal.getZ(ia) * la + normal.getZ(ib) * lb + normal.getZ(ic) * lc;
        const nl = Math.hypot(nx, ny, nz) || 1;
        raster.normal[o3] = nx / nl;
        raster.normal[o3 + 1] = ny / nl;
        raster.normal[o3 + 2] = nz / nl;

        const rectangle = UV_REGIONS[REGION_NAMES[rect]!];
        const o2 = texel * 2;
        raster.local[o2] = clamp01(
          ((px + 0.5) / size - rectangle.u0) / Math.max(rectangle.u1 - rectangle.u0, 1e-6)
        );
        raster.local[o2 + 1] = clamp01(
          ((py + 0.5) / size - rectangle.v0) / Math.max(rectangle.v1 - rectangle.v0, 1e-6)
        );
      }
    }
  }

  return raster;
}

/**
 * Occlusion for every covered texel.
 *
 * With a sampler, this is real ray-traced AO on a coarse grid, bilinearly
 * upsampled — cheap because occlusion is a low-frequency signal. Without one,
 * it falls back to a cavity estimate from the local normal divergence, which
 * finds armpits and finger gaps but not the shadow a cape casts on a back.
 */
function bakeOcclusion(raster: Raster, size: number, options: AtlasBakeOptions): Float32Array {
  const ao = new Float32Array(size * size);
  ao.fill(1);

  const sampler = options.occlusion;
  if (sampler === undefined) {
    // Analytic fallback: how much the neighbourhood's normals disagree.
    for (let y = 1; y < size - 1; y++) {
      for (let x = 1; x < size - 1; x++) {
        const texel = y * size + x;
        if (raster.covered[texel] === 0) continue;
        const o = texel * 3;
        let dot = 0;
        let count = 0;
        for (const [dx, dy] of [
          [-2, 0],
          [2, 0],
          [0, -2],
          [0, 2],
        ] as const) {
          const other = (y + dy) * size + (x + dx);
          if (raster.covered[other] === 0) continue;
          const p = other * 3;
          dot +=
            raster.normal[o]! * raster.normal[p]! +
            raster.normal[o + 1]! * raster.normal[p + 1]! +
            raster.normal[o + 2]! * raster.normal[p + 2]!;
          count++;
        }
        const agreement = count > 0 ? dot / count : 1;
        ao[texel] = clamp01(0.55 + agreement * 0.45);
      }
    }
    return ao;
  }

  const grid = Math.max(32, Math.min(options.occlusionSize ?? 256, size));
  const stride = size / grid;
  const positions = new Float32Array(grid * grid * 3);
  const normals = new Float32Array(grid * grid * 3);
  const valid = new Uint8Array(grid * grid);

  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const x = Math.min(size - 1, Math.floor((gx + 0.5) * stride));
      const y = Math.min(size - 1, Math.floor((gy + 0.5) * stride));
      const texel = y * size + x;
      const g = gy * grid + gx;
      if (raster.covered[texel] === 0) continue;
      valid[g] = 1;
      const o = texel * 3;
      positions[g * 3] = raster.position[o]!;
      positions[g * 3 + 1] = raster.position[o + 1]!;
      positions[g * 3 + 2] = raster.position[o + 2]!;
      normals[g * 3] = raster.normal[o]!;
      normals[g * 3 + 1] = raster.normal[o + 1]!;
      normals[g * 3 + 2] = raster.normal[o + 2]!;
    }
  }

  const coarse = sampler(positions, normals, grid * grid);

  // Fill invalid cells from valid neighbours so the upsample does not pull
  // black out of the gutter.
  const filled = new Float32Array(grid * grid);
  for (let i = 0; i < grid * grid; i++) filled[i] = valid[i] === 1 ? coarse[i]! : -1;
  for (let pass = 0; pass < 4; pass++) {
    for (let gy = 0; gy < grid; gy++) {
      for (let gx = 0; gx < grid; gx++) {
        const g = gy * grid + gx;
        if (filled[g]! >= 0) continue;
        let sum = 0;
        let count = 0;
        for (const [dx, dy] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ] as const) {
          const nx = gx + dx;
          const ny = gy + dy;
          if (nx < 0 || ny < 0 || nx >= grid || ny >= grid) continue;
          const value = filled[ny * grid + nx]!;
          if (value >= 0) {
            sum += value;
            count++;
          }
        }
        if (count > 0) filled[g] = sum / count;
      }
    }
  }
  for (let i = 0; i < grid * grid; i++) if (filled[i]! < 0) filled[i] = 1;

  for (let y = 0; y < size; y++) {
    const fy = Math.min(grid - 1.001, Math.max(0, y / stride - 0.5));
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    for (let x = 0; x < size; x++) {
      const fx = Math.min(grid - 1.001, Math.max(0, x / stride - 0.5));
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const a = filled[y0 * grid + x0]!;
      const b = filled[y0 * grid + Math.min(grid - 1, x0 + 1)]!;
      const c = filled[Math.min(grid - 1, y0 + 1) * grid + x0]!;
      const d = filled[Math.min(grid - 1, y0 + 1) * grid + Math.min(grid - 1, x0 + 1)]!;
      ao[y * size + x] = lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
    }
  }
  return ao;
}

/** Composite one rasterised face layer over a target buffer. */
function compositeFace(
  patch: FacePatch,
  rect: { u0: number; v0: number; u1: number; v1: number },
  size: number,
  apply: (texel: number, r: number, g: number, b: number, alpha: number) => void
): void {
  // ATLAS ORIENTATION, stated once for the whole workstream: row 0 is v = 0.
  // Every roster image is authored this way and every roster texture sets
  // `flipY = false`, which is also what glTF assumes and what `KTX2Loader`
  // forces — so the same bytes serve the runtime texture, the embedded GLB
  // texture and any future KTX2 transcode with no flip anywhere in the chain.
  // The patch arrives already in this orientation (the baker's caller flips
  // the rasterised SVG once), so this is a straight row-for-row copy.
  const x0 = Math.round(rect.u0 * size);
  const x1 = Math.round(rect.u1 * size);
  const y0 = Math.round(rect.v0 * size);
  const y1 = Math.round(rect.v1 * size);
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);

  for (let y = 0; y < height; y++) {
    const sy = Math.min(patch.height - 1, Math.floor(((y + 0.5) / height) * patch.height));
    const ty = y0 + y;
    if (ty < 0 || ty >= size) continue;
    for (let x = 0; x < width; x++) {
      const sx = Math.min(patch.width - 1, Math.floor(((x + 0.5) / width) * patch.width));
      const tx = x0 + x;
      if (tx < 0 || tx >= size) continue;
      const o = (sy * patch.width + sx) * 4;
      const alpha = patch.rgba[o + 3]! / 255;
      if (alpha <= 0.002) continue;
      apply(ty * size + tx, patch.rgba[o]! / 255, patch.rgba[o + 1]! / 255, patch.rgba[o + 2]! / 255, alpha);
    }
  }
}

/** Grow covered texels outward so filtering never samples the gutter. */
function dilate(data: Uint8Array, covered: Uint8Array, size: number, channels: number): void {
  const mask = Uint8Array.from(covered);
  const next = Uint8Array.from(mask);
  const accum = new Float32Array(channels);

  for (let pass = 0; pass < DILATE_PASSES; pass++) {
    let grew = false;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const texel = y * size + x;
        if (mask[texel] === 1) continue;
        accum.fill(0);
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= size) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= size) continue;
            const other = ny * size + nx;
            if (mask[other] === 0) continue;
            for (let c = 0; c < channels; c++) accum[c]! += data[other * channels + c]!;
            count++;
          }
        }
        if (count === 0) continue;
        for (let c = 0; c < channels; c++) data[texel * channels + c] = Math.round(accum[c]! / count);
        next[texel] = 1;
        grew = true;
      }
    }
    mask.set(next);
    if (!grew) break;
  }
}

/**
 * Bake one character's atlas.
 *
 * @param build      geometry whose UVs have already been through
 *                   `prepareRosterGeometry`
 * @param styles     resolved per-class surface table
 * @param classifier costume colour -> class lookup
 */
export function bakeCharacterAtlas(
  build: HumanoidBuild,
  styles: SurfaceStyleSet,
  classifier: ColorClassifier,
  options: AtlasBakeOptions = {}
): AtlasMaps {
  const size = options.size ?? ATLAS_SIZE;
  const seed = options.seed ?? 1;
  const rng = createRng(seed).derive('atlas');
  const wearSeed = rng.nextUint32() >>> 8;
  const geometry = build.geometry;
  const index = geometry.getIndex();
  if (index === null) throw new Error('roster: geometry must be indexed');

  const triClass = classifyTriangles(geometry, classifier);
  const triangles = index.count / 3;

  // Which named rectangle each triangle lives in, by UV centroid.
  const uv = geometry.getAttribute('uv');
  const triRect = new Uint8Array(triangles);
  for (let t = 0; t < triangles; t++) {
    const a = index.getX(t * 3);
    const b = index.getX(t * 3 + 1);
    const c = index.getX(t * 3 + 2);
    const cu = (uv.getX(a) + uv.getX(b) + uv.getX(c)) / 3;
    const cv = (uv.getY(a) + uv.getY(b) + uv.getY(c)) / 3;
    triRect[t] = REGION_NAMES.indexOf(rectOf(cu, cv));
  }

  const density = regionDensities(geometry, triRect);
  const raster = rasterise(build, triClass, triRect, size);
  const ao = bakeOcclusion(raster, size, options);

  const texels = size * size;
  const albedo = new Uint8Array(texels * 3);
  const mask = new Uint8Array(texels);
  const orm = new Uint8Array(texels * 3);
  const normalMap = new Uint8Array(texels * 3);
  const height = new Float32Array(texels);
  const detailNormal = new Float32Array(texels * 3);
  const roughness = new Float32Array(texels);
  const metalness = new Float32Array(texels);
  const baseLinear = new Float32Array(texels * 3);
  const classTexels: Partial<Record<SurfaceClass, number>> = {};

  let emissive: Uint8Array | undefined;
  const emissiveLinear = new Float32Array(texels * 3);
  let glowing = false;

  const tiles = options.tiles;
  const pyramids = new Map<string, TilePyramid>();
  const detailSample = new Float32Array(3);
  const armSample = new Float32Array(3);
  const normalSample = new Float32Array(3);

  let covered = 0;

  for (let texel = 0; texel < texels; texel++) {
    if (raster.covered[texel] === 0) continue;
    covered++;

    const surface = SURFACE_CLASSES[raster.classId[texel]!] ?? 'skin';
    classTexels[surface] = (classTexels[surface] ?? 0) + 1;
    const style = styles[surface];
    const detail = style.detail;

    const rectName = REGION_NAMES[raster.rect[texel]!]!;
    const rect: UVRect = UV_REGIONS[rectName];
    const spanU = rect.u1 - rect.u0;
    const spanV = rect.v1 - rect.v0;
    const metresPerUv = density[rectName];

    // Detail coordinates in TILES-PER-METRE, so a pattern keeps its physical
    // size whether it lands on the body rectangle or the much denser
    // extremity one.
    // Frequency is capped per region so no pattern cycle lands under five
    // texels. `tiles` is authored as an intent ("about this many repeats per
    // metre"); the atlas decides what it can actually carry.
    const texelsPerMetre = size / Math.max(metresPerUv, 1e-4);
    const cycles = PATTERN_CYCLES[detail.pattern];
    const tilesPerMetre = Math.min(
      detail.tiles,
      texelsPerMetre / (MIN_TEXELS_PER_CYCLE * Math.max(cycles, 1))
    );
    const du = raster.local[texel * 2]! * spanU * metresPerUv * tilesPerMetre;
    const dv = raster.local[texel * 2 + 1]! * spanV * metresPerUv * tilesPerMetre;
    // The photographic detail keeps its own (uncapped) rate but picks a mip.
    const photoTiles = detail.tiles;
    const pu = raster.local[texel * 2]! * spanU * metresPerUv * photoTiles;
    const pv = raster.local[texel * 2 + 1]! * spanV * metresPerUv * photoTiles;

    const o3 = texel * 3;
    let r = raster.color[o3]!;
    let g = raster.color[o3 + 1]!;
    let b = raster.color[o3 + 2]!;

    if (options.neutralize === true && style.tint !== 'none') {
      // Keep a hint of the original luminance ordering so trousers stay darker
      // than a shirt even before the instance tint arrives.
      const luma = clamp01(0.2126 * r + 0.7152 * g + 0.0722 * b);
      const level = lerp(0.62, 0.9, Math.pow(luma, 0.35));
      r = level;
      g = level;
      b = level;
    }

    const tone = style.tone ?? 1;
    r *= tone;
    g *= tone;
    b *= tone;

    // --- CC0 detail -------------------------------------------------------
    const tile = detail.material === undefined ? undefined : tiles?.get(detail.material);
    let rough = style.roughness;
    let metal = style.metalness;
    let occlusion = ao[texel]!;

    if (tile !== undefined) {
      let pyramid = pyramids.get(tile.id);
      if (pyramid === undefined) {
        pyramid = buildPyramid(tile);
        pyramids.set(tile.id, pyramid);
      }
      // Source texels per destination texel, then the matching pyramid level.
      const footprint = (tile.size * photoTiles) / Math.max(texelsPerMetre, 1);
      const level = Math.min(
        pyramid.levels.length - 1,
        Math.max(0, Math.round(Math.log2(Math.max(footprint, 1))))
      );
      const mip = pyramid.levels[level]!;
      sampleTile(mip.albedo, mip.size, pu, pv, detailSample);
      const luma =
        0.2126 * srgbToLinear(detailSample[0]!) +
        0.7152 * srgbToLinear(detailSample[1]!) +
        0.0722 * srgbToLinear(detailSample[2]!);
      const modulation = lerp(1, luma / Math.max(tile.meanLuma, 1e-3), detail.albedoStrength);
      r *= modulation;
      g *= modulation;
      b *= modulation;

      sampleTile(mip.arm, mip.size, pu, pv, armSample);
      occlusion *= lerp(1, armSample[0]!, 0.7);
      rough = clamp01(
        lerp(rough, rough * (armSample[1]! / Math.max(tile.meanRough, 1e-3)), detail.roughnessStrength)
      );
      // Photographed metalness is unreliable on a CC0 scan; the class knows
      // better. It only ever multiplies down, never up.
      metal = clamp01(metal * lerp(1, 0.5 + armSample[2]! * 0.5, 0.35));

      if (detail.normalStrength > 0) {
        sampleTile(mip.normal, mip.size, pu, pv, normalSample);
        detailNormal[o3] = (normalSample[0]! * 2 - 1) * detail.normalStrength;
        detailNormal[o3 + 1] = (normalSample[1]! * 2 - 1) * detail.normalStrength;
        detailNormal[o3 + 2] = normalSample[2]! * 2 - 1;
      }
    }

    // --- Synthetic pattern ------------------------------------------------
    if (detail.pattern !== 'none' && detail.patternStrength > 0) {
      const h = patternHeight(detail.pattern, du, dv, seed);
      height[texel] = h * detail.patternStrength;
      // Threads catch light on their crowns and hold dirt in their valleys.
      const shade = 1 + h * 0.09 * detail.patternStrength;
      r *= shade;
      g *= shade;
      b *= shade;
      rough = clamp01(rough - h * 0.05 * detail.patternStrength);
    }

    // --- Wear -------------------------------------------------------------
    const wear = fbm(
      raster.local[texel * 2]! * 4.2,
      raster.local[texel * 2 + 1]! * 4.2,
      wearSeed + raster.rect[texel]! * 7,
      3
    );
    const wearAmount = surface === 'skin' ? 0.05 : 0.12;
    const wearShade = 1 - (wear - 0.5) * wearAmount;
    r *= wearShade;
    g *= wearShade;
    b *= wearShade;
    rough = clamp01(rough + (wear - 0.5) * 0.1);

    // --- Occlusion tint ---------------------------------------------------
    const aoAmount = lerp(1, occlusion, style.ao);
    const shadeTint = lerp(1, aoAmount, 0.45);
    baseLinear[o3] = clamp01(r * shadeTint);
    baseLinear[o3 + 1] = clamp01(g * shadeTint);
    baseLinear[o3 + 2] = clamp01(b * shadeTint);

    roughness[texel] = rough;
    metalness[texel] = metal;
    ao[texel] = aoAmount;

    if (style.emissive !== undefined) {
      glowing = true;
      const strength = style.emissiveStrength ?? 1;
      emissiveLinear[o3] = srgbToLinear(((style.emissive >> 16) & 255) / 255) * strength;
      emissiveLinear[o3 + 1] = srgbToLinear(((style.emissive >> 8) & 255) / 255) * strength;
      emissiveLinear[o3 + 2] = srgbToLinear((style.emissive & 255) / 255) * strength;
    }
  }

  // --- Face composite -------------------------------------------------------
  const faceRect = options.faceRect;
  if (options.face !== undefined && faceRect !== undefined) {
    compositeFace(options.face, faceRect, size, (texel, fr, fg, fb, alpha) => {
      const o = texel * 3;
      baseLinear[o] = lerp(baseLinear[o]!, srgbToLinear(fr), alpha);
      baseLinear[o + 1] = lerp(baseLinear[o + 1]!, srgbToLinear(fg), alpha);
      baseLinear[o + 2] = lerp(baseLinear[o + 2]!, srgbToLinear(fb), alpha);
    });
  }
  if (options.faceOrm !== undefined && faceRect !== undefined) {
    compositeFace(options.faceOrm, faceRect, size, (texel, fr, fg, fb, alpha) => {
      ao[texel] = lerp(ao[texel]!, fr, alpha);
      roughness[texel] = lerp(roughness[texel]!, fg, alpha);
      metalness[texel] = lerp(metalness[texel]!, fb, alpha);
      // A wet eye has no weave.
      height[texel] = lerp(height[texel]!, 0, alpha);
    });
  }
  if (options.faceEmissive !== undefined && faceRect !== undefined) {
    compositeFace(options.faceEmissive, faceRect, size, (texel, fr, fg, fb, alpha) => {
      if (alpha <= 0.01) return;
      glowing = true;
      const o = texel * 3;
      emissiveLinear[o] = lerp(emissiveLinear[o]!, srgbToLinear(fr), alpha);
      emissiveLinear[o + 1] = lerp(emissiveLinear[o + 1]!, srgbToLinear(fg), alpha);
      emissiveLinear[o + 2] = lerp(emissiveLinear[o + 2]!, srgbToLinear(fb), alpha);
    });
  }

  // --- Encode ---------------------------------------------------------------
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const texel = y * size + x;
      const o3 = texel * 3;
      if (raster.covered[texel] === 0) {
        normalMap[o3] = 128;
        normalMap[o3 + 1] = 128;
        normalMap[o3 + 2] = 255;
        continue;
      }

      albedo[o3] = Math.round(linearToSrgb(baseLinear[o3]!) * 255);
      albedo[o3 + 1] = Math.round(linearToSrgb(baseLinear[o3 + 1]!) * 255);
      albedo[o3 + 2] = Math.round(linearToSrgb(baseLinear[o3 + 2]!) * 255);

      const surface = SURFACE_CLASSES[raster.classId[texel]!] ?? 'skin';
      mask[texel] = Math.round(TINT_MASK_LEVEL[styles[surface].tint] * 255);

      orm[o3] = Math.round(clamp01(ao[texel]!) * 255);
      orm[o3 + 1] = Math.round(clamp01(roughness[texel]!) * 255);
      orm[o3 + 2] = Math.round(clamp01(metalness[texel]!) * 255);

      // Macro relief from the synthesised height field, blended with whatever
      // the CC0 normal contributed. Sobel over the height buffer: the scale
      // factor is what turns an amplitude into a slope.
      const hl = height[texel - (x > 0 ? 1 : 0)]!;
      const hr = height[texel + (x < size - 1 ? 1 : 0)]!;
      const hd = height[texel - (y > 0 ? size : 0)]!;
      const hu = height[texel + (y < size - 1 ? size : 0)]!;
      // Sobel gain. Tuned by eye against the close-ups: at 2.2 a jumpsuit read
      // as a knitted string vest and a machined forearm as corrugated iron.
      // Cloth relief is a suggestion at arm's length, not a relief map.
      let nx = (hl - hr) * 1.0 + detailNormal[o3]!;
      let ny = (hd - hu) * 1.0 + detailNormal[o3 + 1]!;
      let nz = 1;
      const length = Math.hypot(nx, ny, nz) || 1;
      nx /= length;
      ny /= length;
      nz /= length;
      normalMap[o3] = Math.round((nx * 0.5 + 0.5) * 255);
      normalMap[o3 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normalMap[o3 + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    }
  }

  if (glowing) {
    emissive = new Uint8Array(texels * 3);
    for (let texel = 0; texel < texels; texel++) {
      const o3 = texel * 3;
      emissive[o3] = Math.round(linearToSrgb(emissiveLinear[o3]!) * 255);
      emissive[o3 + 1] = Math.round(linearToSrgb(emissiveLinear[o3 + 1]!) * 255);
      emissive[o3 + 2] = Math.round(linearToSrgb(emissiveLinear[o3 + 2]!) * 255);
    }
  }

  dilate(albedo, raster.covered, size, 3);
  dilate(mask, raster.covered, size, 1);
  dilate(orm, raster.covered, size, 3);
  dilate(normalMap, raster.covered, size, 3);
  if (emissive !== undefined) dilate(emissive, raster.covered, size, 3);

  return {
    size,
    albedo,
    mask,
    orm,
    normal: normalMap,
    emissive,
    coverage: covered / texels,
    triangles,
    classTexels,
  };
}
