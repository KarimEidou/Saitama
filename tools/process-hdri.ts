/**
 * HDRI ENVIRONMENT PROCESSING — Radiance .hdr to half-float KTX2 + SH9
 *
 * Poly Haven ships each sky as a 4096×2048 RGBE `.hdr`, ~17 MB of run-length
 * encoded bytes that no GPU can sample and no browser can decode without a
 * JavaScript parser running on the main thread. This stage turns each one into
 * two things the runtime can use immediately:
 *
 *   env/<id>.<tier>.ktx2   half-float equirectangular sky, zstd-supercompressed,
 *                          with a full mip chain — upload it and draw it.
 *   env/<id>.sh9.json      9 spherical-harmonic irradiance coefficients, RGB.
 *
 * ── WHY BOTH ───────────────────────────────────────────────────────────────
 * A sky does two unrelated jobs: it is the thing you SEE behind the buildings,
 * and it is the thing that LIGHTS them. Those want opposite treatment.
 *
 * Seeing it needs resolution — 2048×1024 for the visible sky, 1024×512 on
 * mobile where it is a backdrop behind a busy city.
 *
 * Lighting from it needs almost none. Diffuse irradiance from any environment
 * is a cosine-lobe convolution, which annihilates everything above SH band 2;
 * 9 RGB coefficients reproduce it to within a percent or so. The usual route
 * to that is PMREM: build a mip-chain cubemap on the GPU at load time and pay
 * ~12 MB of VRAM plus the prefilter cost, every launch. On mobile that is a
 * poor trade for lighting a scene whose diffuse response is 27 floats. Those
 * 27 floats are baked here, land in `assets.runtime.json`, and cost nothing.
 * The specular half still wants PMREM — but only on tiers that can afford it.
 *
 * ── ENERGY-CONSERVING DOWNSAMPLING ─────────────────────────────────────────
 * Every resample here is a box average in linear radiance, NOT Lanczos.
 * Lanczos rings, and an HDR sky is the one image where ringing is catastrophic:
 * the sun is four orders of magnitude brighter than the sky beside it, so a
 * filter with negative lobes carves a black halo around it and throws away
 * energy the lighting depends on. A box average is exact for the 2:1 and 4:1
 * ratios used here and conserves total radiance by construction.
 *
 * ── HALF FLOAT, AND ITS CEILING ────────────────────────────────────────────
 * `R16G16B16A16_SFLOAT` tops out at 65504. Solar disc radiance in these files
 * exceeds that, so those texels are clamped rather than allowed to become Inf —
 * an Inf would propagate through mip generation and poison an entire mip level,
 * and through the SH projection and poison the whole probe. The clamp costs
 * some sun energy, which is why the SH is projected from the FULL-PRECISION
 * float data before any conversion, not from the encoded texture.
 *
 * ── ORIENTATION ────────────────────────────────────────────────────────────
 * three's `equirectUv()` maps up (+Y) to v = 1, and `KTX2Loader` hands back a
 * `DataTexture` whose `flipY` is false, so v = 1 is the LAST row of the data.
 * A Radiance file's first scanline is the TOP of the image. The buffer is
 * therefore flipped once, up front, and both the KTX2 and the SH are derived
 * from that same flipped buffer — which is what guarantees the baked lighting
 * agrees with the sky the player is looking at.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { IAssetManifest, IHDRIAsset, QualityTier } from '@/types';
import { Logger, formatBytes } from './lib/index.ts';
import {
  ENV_DIR,
  KHR_DF_TRANSFER_LINEAR,
  ProcessCache,
  VK_FORMAT_R16G16B16A16_SFLOAT,
  WORK_DIR,
  cleanWorkDirs,
  checkKtx2,
  fullMipLevels,
  inspectKtx2,
  ktx,
  ktxVersion,
  loadResolvedManifest,
  mapPool,
  matchesOnly,
  outputKey,
  outputRelPath,
  sha256File,
  sourceFilePath,
  type IEnvironmentRuntime,
  type IProducedOutput,
  type ProcessOptions,
  type ProcessResult,
} from './process-assets.ts';

/* -------------------------------------------------------------------------- */
/* Tier policy                                                                */
/* -------------------------------------------------------------------------- */

interface IEnvTarget {
  readonly width: number;
  readonly height: number;
  readonly zstdLevel: number;
}

/**
 * Equirect dimensions per tier.
 *
 * 1024×512 is the irradiance-grade sky: on mobile the diffuse lighting comes
 * from the baked SH anyway, so this only has to survive being looked at
 * between buildings. 2048×1024 is the visible sky for anything that can hold
 * it. Nothing goes above that — a 4096×2048 half-float equirect is 64 MB of
 * VRAM for a backdrop, and the detail is atmospheric gradient that survives
 * the downsample intact.
 */
const TIER_TARGETS: Readonly<Record<QualityTier, IEnvTarget>> = {
  mobile: { width: 1024, height: 512, zstdLevel: 18 },
  high: { width: 2048, height: 1024, zstdLevel: 18 },
  ultra: { width: 2048, height: 1024, zstdLevel: 18 },
};

/**
 * Resolution the SH projection runs at.
 *
 * Band-2 SH cannot represent anything finer than a hemisphere-scale lobe, so
 * the only thing extra resolution buys is a better integral — and box
 * downsampling to 256×128 is itself an exact integral over each texel's solid
 * angle, so it costs nothing in accuracy while making the projection 1000x
 * cheaper than iterating 8.4 M texels.
 */
const SH_WIDTH = 256;
const SH_HEIGHT = 128;

/** Bump to invalidate baked SH when the projection changes. */
const SH_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* Radiance RGBE decoding                                                     */
/* -------------------------------------------------------------------------- */

interface IHdrImage {
  readonly width: number;
  readonly height: number;
  /** Linear RGB radiance, row-major, 3 floats per texel. */
  readonly data: Float32Array;
}

class HdrParseError extends Error {
  constructor(file: string, detail: string) {
    super(`${path.basename(file)}: ${detail}`);
    this.name = 'HdrParseError';
  }
}

/**
 * Decode a Radiance `.hdr`.
 *
 * Handles both the adaptive-RLE scanline format every modern writer emits and
 * the flat RGBE fallback, including the old `(1,1,1,count)` repeat marker. The
 * output is plain linear radiance: the shared exponent is applied here so
 * nothing downstream has to know RGBE exists.
 */
function decodeRadianceHdr(file: string, bytes: Buffer): IHdrImage {
  let pos = 0;

  const readLine = (): string => {
    const start = pos;
    while (pos < bytes.length && bytes[pos] !== 0x0a) pos++;
    const line = bytes.toString('latin1', start, pos);
    pos++; // consume the newline
    return line;
  };

  const magic = readLine();
  if (!magic.startsWith('#?')) throw new HdrParseError(file, `not a Radiance file (${magic})`);

  let format = '';
  for (;;) {
    if (pos >= bytes.length) throw new HdrParseError(file, 'header never ended');
    const line = readLine();
    if (line === '') break; // blank line terminates the header
    const match = /^FORMAT=(.*)$/.exec(line);
    if (match) format = match[1]!.trim();
  }
  if (format && format !== '32-bit_rle_rgbe') {
    throw new HdrParseError(file, `unsupported FORMAT=${format}`);
  }

  const dims = /^\s*-Y\s+(\d+)\s+\+X\s+(\d+)\s*$/.exec(readLine());
  if (!dims) throw new HdrParseError(file, 'expected a "-Y <h> +X <w>" resolution line');
  const height = Number(dims[1]);
  const width = Number(dims[2]);

  const data = new Float32Array(width * height * 3);
  const scanline = new Uint8Array(width * 4);

  // 2^(e-136) folds in the /256 mantissa scale: RGBE stores m/256 * 2^(e-128).
  const EXP = new Float32Array(256);
  for (let e = 1; e < 256; e++) EXP[e] = Math.pow(2, e - 136);

  const emit = (row: number): void => {
    let out = row * width * 3;
    for (let x = 0; x < width; x++) {
      const e = scanline[x + width * 3]!;
      const scale = EXP[e]!;
      data[out++] = scanline[x]! * scale;
      data[out++] = scanline[x + width]! * scale;
      data[out++] = scanline[x + width * 2]! * scale;
    }
  };

  for (let row = 0; row < height; row++) {
    if (pos + 4 > bytes.length) throw new HdrParseError(file, `truncated at row ${row}`);
    const r = bytes[pos]!;
    const g = bytes[pos + 1]!;
    const b = bytes[pos + 2]!;
    const e = bytes[pos + 3]!;
    const rle = r === 2 && g === 2 && ((b << 8) | e) === width && width >= 8 && width < 0x8000;

    if (!rle) {
      // Flat RGBE, possibly with (1,1,1,shift) run markers.
      let x = 0;
      let prev = [0, 0, 0, 0];
      while (x < width) {
        if (pos + 4 > bytes.length) throw new HdrParseError(file, `truncated at row ${row}`);
        const p0 = bytes[pos]!;
        const p1 = bytes[pos + 1]!;
        const p2 = bytes[pos + 2]!;
        const p3 = bytes[pos + 3]!;
        pos += 4;
        if (p0 === 1 && p1 === 1 && p2 === 1) {
          const count = p3;
          for (let i = 0; i < count && x < width; i++, x++) {
            scanline[x] = prev[0]!;
            scanline[x + width] = prev[1]!;
            scanline[x + width * 2] = prev[2]!;
            scanline[x + width * 3] = prev[3]!;
          }
          continue;
        }
        scanline[x] = p0;
        scanline[x + width] = p1;
        scanline[x + width * 2] = p2;
        scanline[x + width * 3] = p3;
        prev = [p0, p1, p2, p3];
        x++;
      }
      emit(row);
      continue;
    }

    pos += 4;
    // Adaptive RLE: each of the four channels is stored as its own run of
    // literals and repeats across the whole scanline.
    for (let channel = 0; channel < 4; channel++) {
      let x = 0;
      const base = channel * width;
      while (x < width) {
        if (pos >= bytes.length) throw new HdrParseError(file, `truncated at row ${row}`);
        const count = bytes[pos++]!;
        if (count > 128) {
          const run = count - 128;
          const value = bytes[pos++]!;
          if (x + run > width) throw new HdrParseError(file, `run overflow at row ${row}`);
          for (let i = 0; i < run; i++) scanline[base + x++] = value;
        } else {
          if (count === 0) throw new HdrParseError(file, `zero-length run at row ${row}`);
          if (x + count > width) throw new HdrParseError(file, `literal overflow at row ${row}`);
          for (let i = 0; i < count; i++) scanline[base + x++] = bytes[pos++]!;
        }
      }
    }
    emit(row);
  }

  return { width, height, data };
}

/* -------------------------------------------------------------------------- */
/* Resampling                                                                 */
/* -------------------------------------------------------------------------- */

/** Flip vertically in place-equivalent (returns a new buffer). See the header. */
function flipVertical(image: IHdrImage): IHdrImage {
  const { width, height, data } = image;
  const out = new Float32Array(data.length);
  const stride = width * 3;
  for (let y = 0; y < height; y++) {
    out.set(data.subarray(y * stride, y * stride + stride), (height - 1 - y) * stride);
  }
  return { width, height, data: out };
}

/**
 * Box-average down to exactly `outW × outH`.
 *
 * Requires integer ratios, which every step in this pipeline has (4096→2048→
 * 1024→…). Averaging in linear radiance is what makes it energy-conserving:
 * the mean of the children IS the correct value for the parent texel, with no
 * filter weights to get wrong and no negative lobes to ring with.
 */
function boxDownsample(image: IHdrImage, outW: number, outH: number): IHdrImage {
  const { width, height, data } = image;
  if (outW === width && outH === height) return image;
  const fx = width / outW;
  const fy = height / outH;
  if (!Number.isInteger(fx) || !Number.isInteger(fy)) {
    throw new Error(
      `box downsample needs integer ratios, got ${width}/${outW} × ${height}/${outH}`
    );
  }
  const out = new Float32Array(outW * outH * 3);
  const inv = 1 / (fx * fy);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < fy; sy++) {
        let src = ((y * fy + sy) * width + x * fx) * 3;
        for (let sx = 0; sx < fx; sx++) {
          r += data[src]!;
          g += data[src + 1]!;
          b += data[src + 2]!;
          src += 3;
        }
      }
      const o = (y * outW + x) * 3;
      out[o] = r * inv;
      out[o + 1] = g * inv;
      out[o + 2] = b * inv;
    }
  }
  return { width: outW, height: outH, data: out };
}

/** One 2x reduction, clamping at 1px so non-square chains reach 1×1. */
function halveForMip(image: IHdrImage): IHdrImage {
  const outW = Math.max(1, image.width >> 1);
  const outH = Math.max(1, image.height >> 1);
  const { width, height, data } = image;
  const out = new Float32Array(outW * outH * 3);
  const sx = width > 1 ? 2 : 1;
  const sy = height > 1 ? 2 : 1;
  const inv = 1 / (sx * sy);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < sy; j++) {
        for (let i = 0; i < sx; i++) {
          const s = ((y * sy + j) * width + (x * sx + i)) * 3;
          r += data[s]!;
          g += data[s + 1]!;
          b += data[s + 2]!;
        }
      }
      const o = (y * outW + x) * 3;
      out[o] = r * inv;
      out[o + 1] = g * inv;
      out[o + 2] = b * inv;
    }
  }
  return { width: outW, height: outH, data: out };
}

/* -------------------------------------------------------------------------- */
/* Half float                                                                 */
/* -------------------------------------------------------------------------- */

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);
/** Largest finite half. Anything above saturates here rather than to Inf. */
const HALF_MAX = 65504;

/**
 * IEEE 754 binary32 to binary16, round-to-nearest-even, saturating.
 *
 * Saturating rather than overflowing to Inf is the whole point: one Inf texel
 * in the solar disc would spread through every mip level that averages it and
 * turn a quarter of the sky into NaN the first time something multiplies it
 * by zero.
 */
export function toHalfFloat(value: number): number {
  if (!Number.isFinite(value)) return value > 0 ? 0x7bff : value < 0 ? 0xfbff : 0;
  const clamped = value > HALF_MAX ? HALF_MAX : value < -HALF_MAX ? -HALF_MAX : value;
  F32[0] = clamped;
  const bits = U32[0]!;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  let mantissa = bits & 0x007fffff;

  if (exponent === 0) return sign; // zero or float32 subnormal: underflows to 0

  let e = exponent - 127 + 15;
  if (e >= 31) return sign | 0x7bff;
  if (e <= 0) {
    if (e < -10) return sign;
    mantissa |= 0x00800000;
    const shift = 14 - e;
    let half = mantissa >>> shift;
    // Round to nearest, ties to even.
    const remainder = mantissa & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    if (remainder > halfway || (remainder === halfway && (half & 1) === 1)) half += 1;
    return sign | half;
  }

  const remainder = mantissa & 0x1fff;
  let half = mantissa >>> 13;
  if (remainder > 0x1000 || (remainder === 0x1000 && (half & 1) === 1)) {
    half += 1;
    if (half === 0x400) {
      half = 0;
      e += 1;
      if (e >= 31) return sign | 0x7bff;
    }
  }
  return sign | (e << 10) | half;
}

/** RGB float image to an interleaved RGBA half-float buffer, alpha = 1. */
function toHalfRgba(image: IHdrImage): Buffer {
  const count = image.width * image.height;
  const out = new Uint16Array(count * 4);
  const ONE = toHalfFloat(1);
  for (let i = 0; i < count; i++) {
    out[i * 4] = toHalfFloat(image.data[i * 3]!);
    out[i * 4 + 1] = toHalfFloat(image.data[i * 3 + 1]!);
    out[i * 4 + 2] = toHalfFloat(image.data[i * 3 + 2]!);
    out[i * 4 + 3] = ONE;
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

/* -------------------------------------------------------------------------- */
/* Spherical-harmonic irradiance                                              */
/* -------------------------------------------------------------------------- */

export interface IShResult {
  /** 27 numbers: 9 coefficients x RGB, in `SphericalHarmonics3.fromArray` order. */
  readonly flat: number[];
  /** Solid-angle-weighted mean luminance. Box downsampling preserves it exactly. */
  readonly meanLuminance: number;
}

/**
 * Brightest texel in the image.
 *
 * Must be measured on the FULL-RESOLUTION data: the solar disc covers about
 * half a degree, so a 4096-wide equirect spends ~6 texels on it and a 256-wide
 * one averages it into the sky entirely. Reading the peak off a downsampled
 * copy understates it by three orders of magnitude, which would make the
 * number useless for the exposure decisions it exists to inform.
 */
export function peakLuminance(image: IHdrImage): number {
  let max = 0;
  const { data } = image;
  for (let i = 0; i < data.length; i += 3) {
    const luminance = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
    if (luminance > max) max = luminance;
  }
  return max;
}

/**
 * Project an equirect onto the first 9 real spherical harmonics.
 *
 * The basis and the `4π / totalWeight` renormalisation are lifted verbatim
 * from three's `LightProbeGenerator`, so the result drops straight into
 * `new SphericalHarmonics3().fromArray(flat)` and `LightProbe`, and
 * `getIrradianceAt()` applies the cosine-lobe convolution on top exactly as it
 * does for a probe generated at runtime. Matching that convention is the whole
 * value of the bake — coefficients under any other normalisation would need a
 * magic scale factor at every call site.
 *
 * `image` MUST already be flipped into texture order, i.e. row 0 is v = 0, so
 * the directions here agree with `equirectUv()` and therefore with the sky.
 */
export function projectSH9(image: IHdrImage): IShResult {
  const { width, height, data } = image;
  const coefficients = new Float64Array(27);
  let totalWeight = 0;
  let luminanceSum = 0;

  // Solid angle of one texel: dω = (2π/W)(π/H) sinθ, with θ from the pole.
  const dPhi = (2 * Math.PI) / width;
  const dTheta = Math.PI / height;

  for (let row = 0; row < height; row++) {
    const v = (row + 0.5) / height;
    // three: v = asin(y)/π + 0.5  =>  y = sin(π (v − 0.5)).
    const y = Math.sin(Math.PI * (v - 0.5));
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const weight = dPhi * dTheta * radius; // sinθ = radius

    for (let col = 0; col < width; col++) {
      const u = (col + 0.5) / width;
      // three: u = atan2(z, x)/2π + 0.5  =>  φ = 2π (u − 0.5).
      const phi = 2 * Math.PI * (u - 0.5);
      const x = radius * Math.cos(phi);
      const z = radius * Math.sin(phi);

      const o = (row * width + col) * 3;
      const r = data[o]!;
      const g = data[o + 1]!;
      const b = data[o + 2]!;

      luminanceSum += (0.2126 * r + 0.7152 * g + 0.0722 * b) * weight;

      // SphericalHarmonics3.getBasisAt, inlined.
      const basis = [
        0.282095,
        0.488603 * y,
        0.488603 * z,
        0.488603 * x,
        1.092548 * x * y,
        1.092548 * y * z,
        0.315392 * (3 * z * z - 1),
        1.092548 * x * z,
        0.546274 * (x * x - y * y),
      ];

      for (let j = 0; j < 9; j++) {
        const bw = basis[j]! * weight;
        coefficients[j * 3] += bw * r;
        coefficients[j * 3 + 1] += bw * g;
        coefficients[j * 3 + 2] += bw * b;
      }
      totalWeight += weight;
    }
  }

  const norm = (4 * Math.PI) / totalWeight;
  return {
    flat: Array.from(coefficients, (c) => c * norm),
    meanLuminance: luminanceSum / totalWeight,
  };
}

/* -------------------------------------------------------------------------- */
/* Encode                                                                     */
/* -------------------------------------------------------------------------- */

/** Write the mip chain as raw half-float files and hand them all to ktx. */
async function encodeEnvKtx2(
  base: IHdrImage,
  target: IEnvTarget,
  outFile: string,
  workDir: string,
  id: string
): Promise<void> {
  const levels = fullMipLevels(target.width, target.height);
  const inputs: string[] = [];
  let level: IHdrImage = base;

  try {
    for (let i = 0; i < levels; i++) {
      const file = path.join(workDir, `${id}.L${String(i).padStart(2, '0')}.bin`);
      await writeFile(file, toHalfRgba(level));
      inputs.push(file);
      if (i + 1 < levels) level = halveForMip(level);
    }

    await ktx([
      'create',
      '--raw',
      '--format',
      'R16G16B16A16_SFLOAT',
      '--width',
      String(target.width),
      '--height',
      String(target.height),
      '--levels',
      String(levels),
      '--assign-tf',
      'linear',
      // The buffer was flipped before it got here; this records that fact.
      '--assign-texcoord-origin',
      'bottom-left',
      '--zstd',
      String(target.zstdLevel),
      ...inputs,
      outFile,
    ]);
  } finally {
    await Promise.all(inputs.map((file) => rm(file, { force: true })));
  }
}

/* -------------------------------------------------------------------------- */
/* Stage entry point                                                          */
/* -------------------------------------------------------------------------- */

interface IEnvOutcome {
  readonly output: IProducedOutput;
  readonly cached: boolean;
  readonly environment: IEnvironmentRuntime;
  readonly entry: IHDRIAsset;
  readonly shBytes: number;
}

async function processOne(
  entry: IHDRIAsset,
  opts: ProcessOptions,
  cache: ProcessCache,
  encoderVersion: string,
  workDir: string
): Promise<IEnvOutcome> {
  const target = TIER_TARGETS[opts.tier];
  const outFile = path.join(ENV_DIR, `${entry.id}.${opts.tier}.ktx2`);
  const shFile = path.join(ENV_DIR, `${entry.id}.sh9.json`);
  const planOptions = {
    width: target.width,
    height: target.height,
    zstdLevel: target.zstdLevel,
    format: 'R16G16B16A16_SFLOAT',
    texcoordOrigin: 'bottom-left',
    filter: 'box',
    shVersion: SH_VERSION,
    shWidth: SH_WIDTH,
    shHeight: SH_HEIGHT,
  };
  const key = outputKey({
    srcSha256: entry.sha256,
    outFile,
    options: planOptions,
    encoderVersion,
  });

  await mkdir(ENV_DIR, { recursive: true });

  // The runtime entry always advertises what the pipeline actually delivers.
  const runtimeEntry: IHDRIAsset = { ...entry, targetFormat: 'ktx2' };

  if (!opts.force) {
    const hit = await cache.lookup(key);
    if (hit) {
      try {
        const sh = JSON.parse(await readFile(shFile, 'utf8')) as {
          coefficientsFlat: number[];
          stats: { meanLuminance: number; maxLuminance: number };
        };
        return {
          cached: true,
          shBytes: 0,
          entry: runtimeEntry,
          output: {
            assetId: entry.id,
            tier: opts.tier,
            file: outputRelPath(outFile),
            format: 'ktx2',
            bytes: hit.bytes,
            sha256: hit.sha256,
            width: hit.width,
            height: hit.height,
          },
          environment: {
            sh9: sh.coefficientsFlat,
            shFile: outputRelPath(shFile),
            meanLuminance: sh.stats.meanLuminance,
            maxLuminance: sh.stats.maxLuminance,
          },
        };
      } catch {
        // SH sidecar missing or unreadable: fall through and rebuild both.
      }
    }
  }

  if (!entry.sourceFile) throw new Error(`${entry.id}: no source .hdr in the manifest`);
  const sourcePath = sourceFilePath(entry.sourceFile);
  const decoded = decodeRadianceHdr(sourcePath, await readFile(sourcePath));

  // Flip ONCE, then derive everything from the flipped buffer. This is what
  // keeps the baked lighting and the visible sky in agreement.
  const oriented = flipVertical(decoded);
  const base = boxDownsample(oriented, target.width, target.height);

  await encodeEnvKtx2(base, target, outFile, workDir, entry.id);

  const facts = await inspectKtx2(outFile);
  const problems = checkKtx2(facts, {
    vkFormat: VK_FORMAT_R16G16B16A16_SFLOAT,
    transferFunction: KHR_DF_TRANSFER_LINEAR,
    width: target.width,
    height: target.height,
    fullMipChain: true,
    supercompressionScheme: 2, // Zstandard
  });
  if (problems.length > 0) throw new Error(problems.join('; '));

  // Project from full-precision floats, before the half-float clamp: the sun
  // is exactly the part half float cannot hold and exactly the part that
  // dominates the irradiance.
  const sh = projectSH9(boxDownsample(oriented, SH_WIDTH, SH_HEIGHT));
  const maxLuminance = peakLuminance(oriented);
  const coefficients: number[][] = [];
  for (let i = 0; i < 9; i++) coefficients.push(sh.flat.slice(i * 3, i * 3 + 3));

  const shJson =
    JSON.stringify(
      {
        id: entry.id,
        name: entry.name,
        format: 'three/SphericalHarmonics3',
        bands: 3,
        note:
          'Coefficients match THREE.SphericalHarmonics3 conventions. Use: ' +
          'new THREE.LightProbe(new THREE.SphericalHarmonics3().fromArray(coefficientsFlat)). ' +
          'getIrradianceAt() applies the cosine-lobe convolution — do not pre-convolve.',
        source: { file: entry.sourceFile, sha256: entry.sha256 },
        projectedAt: { width: SH_WIDTH, height: SH_HEIGHT },
        coefficients,
        coefficientsFlat: sh.flat,
        stats: { meanLuminance: sh.meanLuminance, maxLuminance },
      },
      null,
      2
    ) + '\n';
  await writeFile(shFile, shJson);

  await cache.record(key, outFile, {
    width: facts.width,
    height: facts.height,
    levels: facts.levelCount,
    sha256: facts.sha256,
  });

  return {
    cached: false,
    shBytes: Buffer.byteLength(shJson),
    entry: runtimeEntry,
    output: {
      assetId: entry.id,
      tier: opts.tier,
      file: outputRelPath(outFile),
      format: 'ktx2',
      bytes: facts.bytes,
      sha256: facts.sha256,
      width: facts.width,
      height: facts.height,
    },
    environment: {
      sh9: sh.flat,
      shFile: outputRelPath(shFile),
      meanLuminance: sh.meanLuminance,
      maxLuminance,
    },
  };
}

/** Build every environment map for one quality tier. */
export async function processHdri(opts: ProcessOptions): Promise<ProcessResult> {
  const log = new Logger();
  const manifest: IAssetManifest = await loadResolvedManifest();
  const encoderVersion = await ktxVersion();
  const cache = await ProcessCache.open();

  const entries = manifest.entries.filter(
    (entry): entry is IHDRIAsset => entry.kind === 'hdri' && matchesOnly(entry.id, opts.only)
  );
  if (entries.length === 0) {
    return { written: 0, skipped: 0, bytes: 0, errors: [], outputs: [], environments: {} };
  }

  const workDir = path.join(WORK_DIR, `env-${opts.tier}`);
  await mkdir(workDir, { recursive: true });

  // Decoding a 4096×2048 HDR needs ~100 MB of Float32 plus the mip chain, so
  // this stage stays narrower than the texture stage regardless of --concurrency.
  const width = Math.min(opts.concurrency, 2);
  let done = 0;
  const results = await mapPool(entries, width, async (entry) => {
    const outcome = await processOne(entry, opts, cache, encoderVersion, workDir);
    done += 1;
    log.status(
      `env ${opts.tier}  ${done}/${entries.length}  ` +
        `${outcome.cached ? 'cached' : 'built '} ${formatBytes(outcome.output.bytes)}  <- ${entry.id}`
    );
    return outcome;
  });
  log.endStatus();

  await cache.save();

  const outputs: IProducedOutput[] = [];
  const environments: Record<string, IEnvironmentRuntime> = {};
  const syntheticEntries: IHDRIAsset[] = [];
  const errors: string[] = [];
  let written = 0;
  let skipped = 0;
  let bytes = 0;

  for (const [index, result] of results.entries()) {
    const entry = entries[index]!;
    if (!result.ok) {
      errors.push(`${entry.id} @ ${opts.tier}: ${result.error.message}`);
      continue;
    }
    outputs.push(result.value.output);
    environments[entry.id] = result.value.environment;
    syntheticEntries.push(result.value.entry);
    bytes += result.value.output.bytes + result.value.shBytes;
    if (result.value.cached) skipped += 1;
    else written += 1;
  }

  return { written, skipped, bytes, errors, outputs, environments, syntheticEntries };
}

/** Standalone: `npx tsx tools/process-hdri.ts --tier mobile`. */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const tier = (flag('--tier') ?? 'mobile') as QualityTier;
  const result = await processHdri({
    tier,
    only: flag('--only')?.split(','),
    concurrency: Number(flag('--concurrency') ?? 2),
    force: argv.includes('--force'),
  });
  console.log(
    `hdri ${tier}: ${result.written} written, ${result.skipped} cached, ` +
      `${formatBytes(result.bytes)}, ${result.errors.length} error(s)`
  );
  for (const [id, env] of Object.entries(result.environments ?? {})) {
    console.log(
      `  ${id}  L0=[${env.sh9
        .slice(0, 3)
        .map((v) => v.toFixed(4))
        .join(
          ', '
        )}]  meanLum=${env.meanLuminance.toFixed(4)}  maxLum=${env.maxLuminance.toFixed(1)}`
    );
  }
  for (const error of result.errors) console.error(`  ✗ ${error}`);
  await cleanWorkDirs();
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

/** Exported for verification: `sha256File` is re-exported for scripted checks. */
export { sha256File };
