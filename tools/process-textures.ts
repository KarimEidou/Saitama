/**
 * PBR TEXTURE PROCESSING — 4K JPEG sources to GPU-native KTX2
 *
 * Poly Haven ships each material as three 4096² JPEGs: `diff` (albedo),
 * `nor_gl` (tangent-space normal, OpenGL convention) and `arm` (ambient
 * occlusion, roughness and metalness already packed into R, G and B). This
 * stage resamples them per tier and hands each one to the codec that suits its
 * data, then proves the result is what was asked for.
 *
 * ── WHY THREE DIFFERENT CODECS ─────────────────────────────────────────────
 *
 *   albedo   ETC1S (basis-lz)   Colour detail hides block artefacts, and ETC1S
 *                               is ~0.25 bpp after supercompression: a 4096²
 *                               albedo lands at ~3.3 MB. Nothing else is close.
 *
 *   normal   UASTC + zstd 18    ETC1S is a shared-palette *colour* codec. It
 *                               assumes channels correlate; in a tangent-space
 *                               normal map X and Y are independent, so the
 *                               palette tears the surface apart — visible as
 *                               blotchy, faceted lighting. UASTC is 4x the
 *                               bits and worth every one of them. Capped at 2K
 *                               because normals are the expensive slot.
 *
 *   arm      ETC1S              Low-frequency, low-contrast, and read three
 *                               times over: one texture serves aoMap,
 *                               roughnessMap and metalnessMap, so it is a 3x
 *                               VRAM saving before compression even starts.
 *                               2K is beyond what the data carries.
 *
 * ── TWO DELIBERATE DEVIATIONS, BOTH MEASURED ───────────────────────────────
 *
 *   1. `--clevel 2`, not 4. Benchmarked on this box at 4096²:
 *        clevel 1 → 17.2 s / 3,327,700 B
 *        clevel 2 → 27.7 s / 3,295,496 B
 *        clevel 4 → 78.2 s / 3,295,896 B
 *      Level 4 is 2.8x slower for a marginally LARGER file. Level 2 is the knee.
 *
 *   2. Normal maps are encoded as plain RGB UASTC, WITHOUT `--normal-mode`.
 *      `--normal-mode` repacks to two channels as (RGB=X, A=Y), and three's
 *      `KTX2Loader` transcodes every Basis payload to an RGBA format — never
 *      to RG11_EAC or RGTC2, the only formats `WebGLPrograms.isPackedRGFormat`
 *      recognises. So `USE_PACKED_NORMALMAP` never fires, three samples
 *      `normalMap.xyz`, and a packed map arrives as (X, X, X): lighting that
 *      is not subtly wrong but comprehensively wrong. RGB UASTC with
 *      normal-tuned RDO (`--uastc-rdo-l 0.5`, the range the encoder docs give
 *      for normals) is the encoding three can actually consume.
 *
 * ── ORIENTATION ────────────────────────────────────────────────────────────
 * Every output is written bottom-left origin (`--convert-texcoord-origin
 * bottom-left`, `KTXorientation: ru`). `KTX2Loader` produces a
 * `CompressedTexture`, which forces `flipY = false`, so the flip has to be in
 * the bytes; baking it in makes a KTX2 a drop-in replacement for the source
 * JPEG loaded through `TextureLoader` (whose default is `flipY = true`). It
 * also keeps the normal map's green channel pointing the way the albedo it
 * accompanies expects.
 *
 * ── PROCEDURAL MATERIALS ───────────────────────────────────────────────────
 * `mat.glass.window` and `mat.road.markings` have no source files — Poly Haven
 * publishes neither window glass nor road markings. They are synthesised here
 * with `sharp` from seeded, tileable value noise, then run through the exact
 * same encode/validate path, so they are indistinguishable from fetched
 * materials at runtime. Generation is deterministic, so their content hash is
 * stable and the skip cache works on them too.
 */

import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type {
  IAssetManifest,
  IMaterialAsset,
  ITextureAsset,
  QualityTier,
  TextureCodec,
  TextureRole,
} from '@/types';
import { Logger, formatBytes, sha256Of } from './lib/index.ts';
import {
  KHR_DF_MODEL_ETC1S,
  KHR_DF_MODEL_UASTC,
  KHR_DF_TRANSFER_LINEAR,
  KHR_DF_TRANSFER_SRGB,
  ProcessCache,
  TEX_DIR,
  VK_FORMAT_UNDEFINED,
  WORK_DIR,
  checkKtx2,
  inspectKtx2,
  ktx,
  ktxVersion,
  loadResolvedManifest,
  mapPool,
  matchesOnly,
  outputKey,
  outputRelPath,
  sourceFilePath,
  type IProducedOutput,
  type ProcessOptions,
  type ProcessResult,
} from './process-assets.ts';

/* -------------------------------------------------------------------------- */
/* Tier and codec policy                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Bump when a procedural generator changes. It feeds the skip-cache key for
 * synthesised materials, which have no source bytes to notice a change for them.
 */
const PROC_GEN_VERSION = 1;

/** Roles this stage knows how to build, and the codec each one gets. */
const CODEC_FOR_ROLE: Readonly<Partial<Record<TextureRole, TextureCodec>>> = {
  albedo: 'etc1s',
  normal: 'uastc',
  orm: 'etc1s',
};

interface IRoleTarget {
  /** Longest-edge clamp, px. Never upscales past the source. */
  readonly maxDimension: number;
  /**
   * ETC1S quality, 1..255. Higher is larger and better. Albedo carries the
   * detail the eye actually reads, so it gets the headroom; ARM is
   * low-frequency and does not repay it.
   */
  readonly qlevel?: number;
  /**
   * UASTC effort, 0..4. Measured on a 1024² asphalt normal map, 2 threads,
   * level-0 PSNR against the source:
   *
   *   0..1 →  7.8 s   36.09 dB
   *   2    →  8.1 s   36.24 dB   <- mobile
   *   3    → 12.3 s   36.52 dB   <- high / ultra: +0.28 dB for 1.5x the time
   *   4    → 224.0 s  36.59 dB   <- 27x the time of level 3 for +0.07 dB
   *
   * Level 4 is not a quality setting, it is a way to lose an afternoon.
   */
  readonly uastcQuality?: number;
  /**
   * UASTC RDO lambda. The encoder docs give [0.25, 0.75] for normal maps.
   *
   * Worth knowing before tuning it: on this data RDO barely moves the file.
   * Sweeping lambda 0.5 → 2.0 at 1K shrank the output from 1,271,997 B to
   * 1,208,270 B — 5% — because a tangent-space normal map is close to
   * incompressible noise and there is little rate for RDO to redistribute.
   * The lever that actually controls normal-map size is the dimension cap.
   */
  readonly uastcRdoLambda?: number;
}

/**
 * What each tier builds.
 *
 * `mobile` is what ships in the APK, and it ships 1K maps DERIVED from the 4K
 * sources — not 4K texels. A 4096² RGBA texture is 67 MB of VRAM before mips;
 * three of them per material is not a thing a phone can hold. Lanczos
 * downsampling from a 4K capture does keep more real detail than a native 1K
 * capture would, which is the actual reason the 4K sources are worth fetching.
 */
const TIER_TARGETS: Readonly<Record<QualityTier, Readonly<Record<string, IRoleTarget>>>> = {
  mobile: {
    albedo: { maxDimension: 1024, qlevel: 128 },
    normal: { maxDimension: 1024, uastcQuality: 2, uastcRdoLambda: 0.5 },
    orm: { maxDimension: 1024, qlevel: 112 },
  },
  high: {
    albedo: { maxDimension: 2048, qlevel: 160 },
    normal: { maxDimension: 2048, uastcQuality: 3, uastcRdoLambda: 0.5 },
    orm: { maxDimension: 1024, qlevel: 128 },
  },
  ultra: {
    albedo: { maxDimension: 4096, qlevel: 176 },
    normal: { maxDimension: 2048, uastcQuality: 3, uastcRdoLambda: 0.5 },
    orm: { maxDimension: 2048, qlevel: 144 },
  },
};

/** Synthetic materials are cheap to generate but carry no 4K detail. */
const PROCEDURAL_MAX_DIMENSION = 2048;

/** BasisLZ effort. See the benchmark in this file's header — 2 is the knee. */
const CLEVEL = 2;
/** Zstandard level for the UASTC container. */
const ZSTD_LEVEL = 18;

/* -------------------------------------------------------------------------- */
/* Encode                                                                     */
/* -------------------------------------------------------------------------- */

/** Everything that decides the encoded bytes. Hashed into the skip key. */
interface IEncodeSpec {
  readonly role: TextureRole;
  readonly codec: TextureCodec;
  readonly colorSpace: 'srgb' | 'linear';
  readonly width: number;
  readonly height: number;
  readonly hasAlpha: boolean;
  readonly clevel?: number;
  readonly qlevel?: number;
  readonly uastcQuality?: number;
  readonly uastcRdoLambda?: number;
  readonly zstdLevel?: number;
  readonly mipmapFilter: string;
  readonly mipmapWrap: string;
  readonly texcoordOrigin: string;
  readonly normalMode: false;
}

/** Threads per encoder process, so N processes do not oversubscribe the box. */
function threadsPerEncode(concurrency: number): number {
  const cpus = os.cpus().length || 4;
  return Math.max(1, Math.floor(cpus / Math.max(1, concurrency)));
}

function ktxArgsFor(spec: IEncodeSpec, threads: number, input: string, output: string): string[] {
  const srgb = spec.colorSpace === 'srgb';
  const args = [
    'create',
    '--format',
    srgb ? 'R8G8B8A8_SRGB' : 'R8G8B8A8_UNORM',
    '--assign-tf',
    srgb ? 'srgb' : 'linear',
    // Bake the flip in: KTX2Loader forces flipY=false on compressed textures.
    '--convert-texcoord-origin',
    'bottom-left',
    '--generate-mipmap',
    '--mipmap-filter',
    spec.mipmapFilter,
    // Every material here tiles, so mips must sample across the seam, not
    // clamp at it — clamping darkens or lightens the edge of every tile.
    '--mipmap-wrap',
    spec.mipmapWrap,
    '--threads',
    String(threads),
  ];

  if (spec.codec === 'etc1s') {
    args.push('--encode', 'basis-lz', '--clevel', String(spec.clevel ?? CLEVEL));
    if (spec.qlevel !== undefined) args.push('--qlevel', String(spec.qlevel));
    // basis-lz IS the supercompression; --zstd is rejected alongside it.
  } else {
    args.push('--encode', 'uastc', '--uastc-quality', String(spec.uastcQuality ?? 2), '--uastc-rdo');
    if (spec.uastcRdoLambda !== undefined) {
      args.push('--uastc-rdo-l', String(spec.uastcRdoLambda));
    }
    args.push('--zstd', String(spec.zstdLevel ?? ZSTD_LEVEL));
  }

  args.push(input, output);
  return args;
}

/* -------------------------------------------------------------------------- */
/* Procedural sources                                                         */
/* -------------------------------------------------------------------------- */

/** Deterministic PRNG. Seeded per material so output is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromId(id: string): number {
  return parseInt(sha256Of(id).slice(0, 8), 16);
}

/**
 * Tileable fractal value noise.
 *
 * The lattice wraps at `period` and the period doubles with the frequency, so
 * every octave repeats over the same tile — which is what makes the result
 * seamless. A non-tiling noise here would put a visible seam on every road in
 * the city.
 */
function makeTileableNoise(seed: number, basePeriod: number): (x: number, y: number) => number {
  const rand = mulberry32(seed);
  const TABLE = 512;
  const table = new Float32Array(TABLE);
  for (let i = 0; i < TABLE; i++) table[i] = rand();
  const perm = new Uint16Array(TABLE);
  for (let i = 0; i < TABLE; i++) perm[i] = i;
  for (let i = TABLE - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = perm[i]!;
    perm[i] = perm[j]!;
    perm[j] = t;
  }

  const lattice = (ix: number, iy: number, period: number): number => {
    const wx = ((ix % period) + period) % period;
    const wy = ((iy % period) + period) % period;
    return table[(perm[wx % TABLE]! + perm[wy % TABLE]! * 7) % TABLE]!;
  };

  const smooth = (t: number): number => t * t * (3 - 2 * t);

  const octave = (x: number, y: number, period: number): number => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = smooth(x - x0);
    const fy = smooth(y - y0);
    const v00 = lattice(x0, y0, period);
    const v10 = lattice(x0 + 1, y0, period);
    const v01 = lattice(x0, y0 + 1, period);
    const v11 = lattice(x0 + 1, y0 + 1, period);
    return (
      v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy
    );
  };

  // x, y arrive in [0, 1); one tile.
  return (x: number, y: number): number => {
    let sum = 0;
    let amp = 0.5;
    let total = 0;
    let period = basePeriod;
    for (let o = 0; o < 5; o++) {
      sum += amp * octave(x * period, y * period, period);
      total += amp;
      amp *= 0.5;
      period *= 2;
    }
    return sum / total;
  };
}

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

interface IProceduralMaps {
  /** RGB or RGBA, row-major, top row first (the encoder flips it). */
  readonly albedo: { data: Buffer; channels: 3 | 4 };
  readonly normal: { data: Buffer; channels: 3 };
  readonly orm: { data: Buffer; channels: 3 };
}

/**
 * Window glass: flat, cool, and nearly featureless by design.
 *
 * The visual interest in a glass facade comes from what it reflects, not from
 * its own maps, so the job here is to avoid introducing detail that would read
 * as dirt on every window in the city. What is present: a faint float-glass
 * ripple in the normal (real, and it makes reflections shimmer plausibly as
 * the camera moves) and mild smudging that raises roughness locally.
 */
function generateGlass(size: number, seed: number): IProceduralMaps {
  const smudge = makeTileableNoise(seed, 3);
  const ripple = makeTileableNoise(seed ^ 0x9e3779b9, 2);
  const grime = makeTileableNoise(seed ^ 0x517cc1b7, 8);

  const albedo = Buffer.alloc(size * size * 3);
  const normal = Buffer.alloc(size * size * 3);
  const orm = Buffer.alloc(size * size * 3);

  // spec.color 10466495 = 0x9FB4BF — cool grey-blue.
  const baseR = 0x9f;
  const baseG = 0xb4;
  const baseB = 0xbf;

  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x * inv;
      const v = y * inv;
      const i = (y * size + x) * 3;

      const s = smudge(u, v);
      const g = grime(u, v);
      // Smudges lighten very slightly (scattered light), grime darkens.
      const tint = 1 + (s - 0.5) * 0.06 - (g - 0.5) * 0.04;
      albedo[i] = clamp255(baseR * tint);
      albedo[i + 1] = clamp255(baseG * tint);
      albedo[i + 2] = clamp255(baseB * tint);

      // Float glass is not perfectly flat; the ripple is ~1 degree of slope.
      const e = 1 / 64;
      const dx = ripple(u + e, v) - ripple(u - e, v);
      const dy = ripple(u, v + e) - ripple(u, v - e);
      normal[i] = clamp255(128 + dx * 220);
      normal[i + 1] = clamp255(128 + dy * 220);
      normal[i + 2] = 255;

      // AO is flat (glass occludes nothing), roughness 0.08 base rising where
      // the surface is smudged, metalness zero.
      orm[i] = 255;
      orm[i + 1] = clamp255((0.08 + s * 0.14 + g * 0.05) * 255);
      orm[i + 2] = 0;
    }
  }

  return {
    albedo: { data: albedo, channels: 3 },
    normal: { data: normal, channels: 3 },
    orm: { data: orm, channels: 3 },
  };
}

/**
 * Road markings: white thermoplastic paint, worn.
 *
 * The whole tile is painted and the ALPHA channel is the wear mask, so the
 * mesh decides the shape of the marking (a lane line, an arrow, a crossing)
 * and the texture only decides how beaten-up the paint is. `spec.alphaTest` is
 * 0.4, so anywhere the mask drops below that the asphalt underneath shows
 * through — which is what worn paint actually looks like. Building the shape
 * into the texture instead would need one texture per marking type.
 */
function generateRoadMarkings(size: number, seed: number): IProceduralMaps {
  const wear = makeTileableNoise(seed, 4);
  const grain = makeTileableNoise(seed ^ 0x85ebca6b, 24);
  const scuff = makeTileableNoise(seed ^ 0xc2b2ae35, 10);

  const albedo = Buffer.alloc(size * size * 4);
  const normal = Buffer.alloc(size * size * 3);
  const orm = Buffer.alloc(size * size * 3);

  // spec.color 15921382 = 0xF2E6E6 — warm off-white, not pure white.
  const baseR = 0xf2;
  const baseG = 0xe6;
  const baseB = 0xe6;

  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x * inv;
      const v = y * inv;
      const i3 = (y * size + x) * 3;
      const i4 = (y * size + x) * 4;

      const w = wear(u, v);
      const gr = grain(u, v);
      const sc = scuff(u, v);

      // Paint coverage: mostly intact, eroded into holes where wear is high.
      // 0.4 is spec.alphaTest, so the mask is shaped to straddle it cleanly.
      const coverage = 1 - Math.max(0, (w - 0.58) / 0.42) * 1.6 - Math.max(0, sc - 0.8) * 1.2;
      albedo[i4 + 3] = clamp255(Math.max(0, Math.min(1, coverage)) * 255);

      // Grain dirties the paint; worn paint is greyer as the asphalt shows.
      const dirt = 1 - gr * 0.12 - Math.max(0, w - 0.5) * 0.18;
      albedo[i4] = clamp255(baseR * dirt);
      albedo[i4 + 1] = clamp255(baseG * dirt);
      albedo[i4 + 2] = clamp255(baseB * dirt);

      // Thermoplastic paint sits proud of the road; the grain gives it tooth.
      const e = 1 / 96;
      const dx = grain(u + e, v) - grain(u - e, v);
      const dy = grain(u, v + e) - grain(u, v - e);
      normal[i3] = clamp255(128 + dx * 300);
      normal[i3 + 1] = clamp255(128 + dy * 300);
      normal[i3 + 2] = 255;

      // Pits self-occlude slightly; worn paint is rougher than fresh paint.
      orm[i3] = clamp255(255 - Math.max(0, w - 0.55) * 120);
      orm[i3 + 1] = clamp255((0.85 + Math.max(0, w - 0.5) * 0.2 - gr * 0.06) * 255);
      orm[i3 + 2] = 0;
    }
  }

  return {
    albedo: { data: albedo, channels: 4 },
    normal: { data: normal, channels: 3 },
    orm: { data: orm, channels: 3 },
  };
}

const PROCEDURAL_GENERATORS: Readonly<Record<string, (size: number, seed: number) => IProceduralMaps>> =
  {
    'mat.glass.window': generateGlass,
    'mat.road.markings': generateRoadMarkings,
  };

/* -------------------------------------------------------------------------- */
/* Work planning                                                              */
/* -------------------------------------------------------------------------- */

interface ITextureJob {
  readonly materialId: string;
  readonly textureId: string;
  readonly role: TextureRole;
  readonly colorSpace: 'srgb' | 'linear';
  /** Absolute path of the source JPEG, or undefined for procedural. */
  readonly sourceFile?: string;
  /** Digest that stands in for the source bytes in the skip key. */
  readonly srcSha256: string;
  readonly outFile: string;
  readonly target: IRoleTarget;
  readonly procedural: boolean;
  /** Manifest row to attach the output to; synthesised for procedural. */
  readonly synthetic?: ITextureAsset;
}

/** `mat.foo.bar.albedo` -> `mat.foo.bar`. */
function materialIdOf(texture: ITextureAsset): string {
  const suffix = `.${texture.role}`;
  return texture.id.endsWith(suffix) ? texture.id.slice(0, -suffix.length) : texture.id;
}

function outFileFor(materialId: string, role: TextureRole, tier: QualityTier): string {
  return path.join(TEX_DIR, materialId, `${role}.${tier}.ktx2`);
}

/** A manifest row for a texture this pipeline invented rather than downloaded. */
function syntheticTextureEntry(
  material: IMaterialAsset,
  role: TextureRole,
  colorSpace: 'srgb' | 'linear'
): ITextureAsset {
  return {
    id: `${material.id}.${role}`,
    kind: 'texture',
    name: `${material.name} — ${role}`,
    attribution: material.attribution,
    sourceUrl: material.sourceUrl,
    sha256: sha256Of(`${material.sha256}|procedural-v${PROC_GEN_VERSION}|${role}`),
    targetFormat: 'ktx2',
    outputs: [],
    tags: material.tags,
    preload: material.preload,
    role,
    colorSpace,
    compression: {},
    tileable: true,
    sourceWidth: PROCEDURAL_MAX_DIMENSION,
    sourceHeight: PROCEDURAL_MAX_DIMENSION,
  };
}

function planJobs(
  manifest: IAssetManifest,
  tier: QualityTier,
  only: readonly string[] | undefined
): { jobs: ITextureJob[]; synthetic: (ITextureAsset | IMaterialAsset)[] } {
  const jobs: ITextureJob[] = [];
  const synthetic: (ITextureAsset | IMaterialAsset)[] = [];
  const targets = TIER_TARGETS[tier];

  for (const entry of manifest.entries) {
    if (entry.kind === 'texture') {
      if (!matchesOnly(entry.id, only)) continue;
      const role = entry.role;
      if (!CODEC_FOR_ROLE[role]) continue;
      const target = targets[role];
      if (!target || !entry.sourceFile) continue;
      const materialId = materialIdOf(entry);
      jobs.push({
        materialId,
        textureId: entry.id,
        role,
        colorSpace: entry.colorSpace,
        sourceFile: sourceFilePath(entry.sourceFile),
        srcSha256: entry.sha256,
        outFile: outFileFor(materialId, role, tier),
        target,
        procedural: false,
      });
      continue;
    }

    if (entry.kind !== 'material') continue;
    const generator = PROCEDURAL_GENERATORS[entry.id];
    if (!generator) continue;
    if (!matchesOnly(entry.id, only)) continue;

    const textureKeys: Partial<Record<TextureRole, string>> = {};
    for (const role of ['albedo', 'normal', 'orm'] as const) {
      const target = targets[role];
      if (!target) continue;
      const colorSpace = role === 'albedo' ? 'srgb' : 'linear';
      const textureEntry = syntheticTextureEntry(entry, role, colorSpace);
      synthetic.push(textureEntry);
      textureKeys[role] = textureEntry.id;
      jobs.push({
        materialId: entry.id,
        textureId: textureEntry.id,
        role,
        colorSpace,
        srcSha256: textureEntry.sha256,
        outFile: outFileFor(entry.id, role, tier),
        target: { ...target, maxDimension: Math.min(target.maxDimension, PROCEDURAL_MAX_DIMENSION) },
        procedural: true,
        synthetic: textureEntry,
      });
    }
    // Republish the material with the texture ids it now actually has.
    synthetic.push({ ...entry, textureKeys } as IMaterialAsset);
  }

  return { jobs, synthetic };
}

/* -------------------------------------------------------------------------- */
/* Encode one texture                                                         */
/* -------------------------------------------------------------------------- */

interface IEncodeOutcome {
  readonly output: IProducedOutput;
  readonly cached: boolean;
}

async function writeSourcePng(job: ITextureJob, workDir: string): Promise<{
  file: string;
  width: number;
  height: number;
  hasAlpha: boolean;
}> {
  const png = path.join(workDir, `${job.textureId}.${job.role}.png`);

  if (job.procedural) {
    const size = job.target.maxDimension;
    const generator = PROCEDURAL_GENERATORS[job.materialId]!;
    const maps = generator(size, seedFromId(job.materialId));
    const map = maps[job.role as 'albedo' | 'normal' | 'orm'];
    await sharp(map.data, { raw: { width: size, height: size, channels: map.channels } })
      .png({ compressionLevel: 1 })
      .toFile(png);
    return { file: png, width: size, height: size, hasAlpha: map.channels === 4 };
  }

  const image = sharp(job.sourceFile!, { unlimited: true });
  const meta = await image.metadata();
  const source = Math.max(meta.width ?? 0, meta.height ?? 0);
  if (source === 0) throw new Error(`${job.sourceFile}: unreadable image`);
  // Never upscale: a 1K source asked for at 2K stays 1K.
  const longest = Math.min(job.target.maxDimension, source);
  const width = Math.max(1, Math.round(((meta.width ?? source) * longest) / source));
  const height = Math.max(1, Math.round(((meta.height ?? source) * longest) / source));

  await image
    .resize(width, height, { kernel: 'lanczos3', fit: 'fill' })
    .png({ compressionLevel: 1 })
    .toFile(png);

  return { file: png, width, height, hasAlpha: false };
}

async function encodeTexture(
  job: ITextureJob,
  tier: QualityTier,
  opts: ProcessOptions,
  cache: ProcessCache,
  encoderVersion: string,
  workDir: string
): Promise<IEncodeOutcome> {
  const codec = CODEC_FOR_ROLE[job.role]!;

  // The key must be computable WITHOUT doing the work, so the resolved
  // dimensions come from the clamp rule rather than from opening the source.
  const planSpec = {
    role: job.role,
    codec,
    colorSpace: job.colorSpace,
    maxDimension: job.target.maxDimension,
    clevel: codec === 'etc1s' ? CLEVEL : undefined,
    qlevel: job.target.qlevel,
    uastcQuality: job.target.uastcQuality,
    uastcRdoLambda: job.target.uastcRdoLambda,
    zstdLevel: codec === 'uastc' ? ZSTD_LEVEL : undefined,
    mipmapFilter: 'lanczos4',
    mipmapWrap: 'wrap',
    texcoordOrigin: 'bottom-left',
    normalMode: false,
    procGenVersion: job.procedural ? PROC_GEN_VERSION : undefined,
  };
  const key = outputKey({
    srcSha256: job.srcSha256,
    outFile: job.outFile,
    options: planSpec,
    encoderVersion,
  });

  const file = outputRelPath(job.outFile);

  if (!opts.force) {
    const hit = await cache.lookup(key);
    if (hit) {
      return {
        cached: true,
        output: {
          assetId: job.textureId,
          tier,
          file,
          format: 'ktx2',
          bytes: hit.bytes,
          sha256: hit.sha256,
          width: hit.width,
          height: hit.height,
          codec: hit.codec ?? codec,
        },
      };
    }
  }

  await mkdir(path.dirname(job.outFile), { recursive: true });
  const png = await writeSourcePng(job, workDir);

  const spec: IEncodeSpec = {
    role: job.role,
    codec,
    colorSpace: job.colorSpace,
    width: png.width,
    height: png.height,
    hasAlpha: png.hasAlpha,
    clevel: codec === 'etc1s' ? CLEVEL : undefined,
    qlevel: job.target.qlevel,
    uastcQuality: job.target.uastcQuality,
    uastcRdoLambda: job.target.uastcRdoLambda,
    zstdLevel: codec === 'uastc' ? ZSTD_LEVEL : undefined,
    mipmapFilter: 'lanczos4',
    mipmapWrap: 'wrap',
    texcoordOrigin: 'bottom-left',
    normalMode: false,
  };

  try {
    await ktx(ktxArgsFor(spec, threadsPerEncode(opts.concurrency), png.file, job.outFile));
  } finally {
    // A 4096² intermediate PNG is ~40 MB. Keeping 117 of them around would
    // cost more disk than the entire build it is producing.
    await rm(png.file, { force: true });
  }

  const facts = await inspectKtx2(job.outFile);
  const problems = checkKtx2(facts, {
    // A Basis payload carries its codec in the DFD, not in vkFormat.
    vkFormat: VK_FORMAT_UNDEFINED,
    colorModel: codec === 'etc1s' ? KHR_DF_MODEL_ETC1S : KHR_DF_MODEL_UASTC,
    transferFunction: job.colorSpace === 'srgb' ? KHR_DF_TRANSFER_SRGB : KHR_DF_TRANSFER_LINEAR,
    width: png.width,
    height: png.height,
    fullMipChain: true,
  });
  if (problems.length > 0) throw new Error(problems.join('; '));

  await cache.record(key, job.outFile, {
    width: facts.width,
    height: facts.height,
    codec,
    levels: facts.levelCount,
    sha256: facts.sha256,
  });

  return {
    cached: false,
    output: {
      assetId: job.textureId,
      tier,
      file,
      format: 'ktx2',
      bytes: facts.bytes,
      sha256: facts.sha256,
      width: facts.width,
      height: facts.height,
      codec,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Stage entry point                                                          */
/* -------------------------------------------------------------------------- */

/** Build every PBR texture for one quality tier. */
export async function processTextures(opts: ProcessOptions): Promise<ProcessResult> {
  const log = new Logger();
  const manifest = await loadResolvedManifest();
  const encoderVersion = await ktxVersion();
  const cache = await ProcessCache.open();

  const { jobs, synthetic } = planJobs(manifest, opts.tier, opts.only);
  if (jobs.length === 0) {
    return { written: 0, skipped: 0, bytes: 0, errors: [], outputs: [], syntheticEntries: [] };
  }

  const workDir = path.join(WORK_DIR, `tex-${opts.tier}`);
  await mkdir(workDir, { recursive: true });

  const started = Date.now();
  let done = 0;
  const results = await mapPool(jobs, opts.concurrency, async (job) => {
    const outcome = await encodeTexture(job, opts.tier, opts, cache, encoderVersion, workDir);
    done += 1;
    const elapsed = Date.now() - started;
    const eta = done > 0 ? (elapsed / done) * (jobs.length - done) : 0;
    log.status(
      `tex ${opts.tier}  ${done}/${jobs.length}  ` +
        `${outcome.cached ? 'cached' : 'built '} ${formatBytes(outcome.output.bytes)}  ` +
        `eta ${Math.round(eta / 1000)}s  <- ${job.materialId}/${job.role}`
    );
    return outcome;
  });
  log.endStatus();

  await cache.save();

  const outputs: IProducedOutput[] = [];
  const errors: string[] = [];
  let written = 0;
  let skipped = 0;
  let bytes = 0;

  for (const [index, result] of results.entries()) {
    const job = jobs[index]!;
    if (!result.ok) {
      errors.push(`${job.textureId} @ ${opts.tier}: ${result.error.message}`);
      continue;
    }
    outputs.push(result.value.output);
    bytes += result.value.output.bytes;
    if (result.value.cached) skipped += 1;
    else written += 1;
  }

  return { written, skipped, bytes, errors, outputs, syntheticEntries: synthetic };
}

/**
 * Standalone entry point, so a texture-only rebuild does not have to go
 * through the orchestrator: `npx tsx tools/process-textures.ts --tier mobile`.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const tier = (flag('--tier') ?? 'mobile') as QualityTier;
  const result = await processTextures({
    tier,
    only: flag('--only')?.split(','),
    concurrency: Number(flag('--concurrency') ?? 2),
    force: argv.includes('--force'),
  });
  console.log(
    `textures ${tier}: ${result.written} written, ${result.skipped} cached, ` +
      `${formatBytes(result.bytes)}, ${result.errors.length} error(s)`
  );
  for (const error of result.errors) console.error(`  ✗ ${error}`);
  await rm(WORK_DIR, { recursive: true, force: true });
  if (result.errors.length > 0) process.exit(1);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error((error as Error).stack ?? String(error));
    process.exit(1);
  });
}
