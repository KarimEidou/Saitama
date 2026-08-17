/**
 * PROCEDURAL PLACEHOLDER TEXTURES
 *
 * Generated on the CPU, no files, no network. Two jobs:
 *
 *   1. MISSING-ASSET FALLBACK. When a `MaterialSpec` names a texture the
 *      registry has not loaded, binding an obvious magenta checker is far more
 *      useful than binding nothing — "nothing" renders as flat white and looks
 *      deliberate, so broken material wiring ships.
 *   2. HARNESS CONTENT. The renderer harness must exercise albedo, normal and
 *      ORM sampling before the asset pipeline exists. These stand in until an
 *      `IAssetProvider` supplies the real thing; nothing here is ever a
 *      hardcoded path to a shipping asset.
 *
 * All output is tileable, power-of-two and mip-mapped.
 */

import * as THREE from 'three';

function makeDataTexture(
  size: number,
  data: Uint8Array,
  colorSpace: THREE.ColorSpace,
  name: string
): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.name = name;
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** Deterministic value noise so a given seed always yields the same texture. */
function hash2(x: number, y: number, seed: number): number {
  let h = x * 374761393 + y * 668265263 + seed * 1442695040;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function smoothNoise(x: number, y: number, size: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const wrap = (n: number): number => ((n % size) + size) % size;
  const a = hash2(wrap(xi), wrap(yi), seed);
  const b = hash2(wrap(xi + 1), wrap(yi), seed);
  const c = hash2(wrap(xi), wrap(yi + 1), seed);
  const d = hash2(wrap(xi + 1), wrap(yi + 1), seed);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

/** Multi-octave tileable fBm in 0..1. */
function fbm(x: number, y: number, size: number, seed: number, octaves = 4): number {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const cells = Math.max(2, Math.round(size / (16 / frequency)));
    value += smoothNoise((x / size) * cells, (y / size) * cells, cells, seed + o * 977) * amplitude;
    total += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return value / total;
}

/**
 * The universal "this texture failed to resolve" marker: a magenta/black
 * checker. Deliberately hideous — a placeholder you can miss is worse than none.
 */
export function createMissingTexture(size = 64): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const cell = size / 8;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const on = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
      const i = (y * size + x) * 4;
      data[i] = on ? 255 : 24;
      data[i + 1] = 0;
      data[i + 2] = on ? 220 : 24;
      data[i + 3] = 255;
    }
  }
  return makeDataTexture(size, data, THREE.SRGBColorSpace, 'texture.missing');
}

export interface INoiseAlbedoOptions {
  readonly size?: number;
  /** Base colour, hex. */
  readonly color?: number;
  /** Secondary colour mixed in by the noise, hex. */
  readonly accent?: number;
  /** 0..1 amount of grid lines drawn over the noise. 0 disables. */
  readonly grid?: number;
  readonly seed?: number;
}

/** A tileable noisy surface with optional panel lines — concrete, asphalt, wall. */
export function createNoiseAlbedo(options: INoiseAlbedoOptions = {}): THREE.DataTexture {
  const size = options.size ?? 256;
  const base = new THREE.Color(options.color ?? 0x8d8b86);
  const accent = new THREE.Color(options.accent ?? 0x5d5b57);
  const grid = options.grid ?? 0;
  const seed = options.seed ?? 1;
  const data = new Uint8Array(size * size * 4);
  const tmp = new THREE.Color();

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x, y, size, seed, 4);
      tmp.copy(base).lerp(accent, n);
      if (grid > 0) {
        const gx = Math.min(x % (size / 4), (size / 4) - (x % (size / 4)));
        const gy = Math.min(y % (size / 4), (size / 4) - (y % (size / 4)));
        const line = Math.min(gx, gy) < 1.5 ? grid : 0;
        tmp.lerp(accent, line);
      }
      const i = (y * size + x) * 4;
      // Values are authored in sRGB space; the texture is tagged SRGB so
      // three linearises on sample.
      data[i] = Math.round(tmp.r * 255);
      data[i + 1] = Math.round(tmp.g * 255);
      data[i + 2] = Math.round(tmp.b * 255);
      data[i + 3] = 255;
    }
  }
  return makeDataTexture(size, data, THREE.SRGBColorSpace, 'texture.noise.albedo');
}

/** Tangent-space normal map derived from the same fBm height field. */
export function createNoiseNormal(size = 256, strength = 2.0, seed = 1): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) height[y * size + x] = fbm(x, y, size, seed, 4);
  }
  const at = (x: number, y: number): number =>
    height[(((y % size) + size) % size) * size + (((x % size) + size) % size)]!;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      // Sobel-lite gradient -> normal, then pack to 0..1.
      const nx = -dx;
      const ny = -dy;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const i = (y * size + x) * 4;
      data[i] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round(((nz / len) * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  // Normal maps are DATA, never colour: tagging them sRGB is the single most
  // common cause of "why is my lighting wrong".
  return makeDataTexture(size, data, THREE.NoColorSpace, 'texture.noise.normal');
}

export interface IOrmOptions {
  readonly size?: number;
  /** Mean roughness in 0..1; noise modulates around it. */
  readonly roughness?: number;
  /** 0 or 1 in practice — metal/dielectric masks should be binary. */
  readonly metalness?: number;
  readonly variance?: number;
  readonly seed?: number;
}

/** Packed ORM: occlusion in R, roughness in G, metalness in B. */
export function createOrmTexture(options: IOrmOptions = {}): THREE.DataTexture {
  const size = options.size ?? 256;
  const roughness = options.roughness ?? 0.75;
  const metalness = options.metalness ?? 0;
  const variance = options.variance ?? 0.25;
  const seed = options.seed ?? 7;
  const data = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x, y, size, seed, 3);
      const ao = 0.75 + n * 0.25;
      const r = Math.min(1, Math.max(0, roughness + (n - 0.5) * 2 * variance));
      const i = (y * size + x) * 4;
      data[i] = Math.round(ao * 255);
      data[i + 1] = Math.round(r * 255);
      data[i + 2] = Math.round(metalness * 255);
      data[i + 3] = 255;
    }
  }
  return makeDataTexture(size, data, THREE.NoColorSpace, 'texture.orm');
}

/**
 * A radial falloff used as the blob-shadow decal sprite. Alpha only in the R
 * channel so it can double as a mask.
 */
export function createBlobShadowTexture(size = 64, softness = 1.6): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - half) / half;
      const dy = (y + 0.5 - half) / half;
      const d = Math.min(1, Math.hypot(dx, dy));
      const a = Math.pow(1 - d, softness);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
    }
  }
  const texture = makeDataTexture(size, data, THREE.NoColorSpace, 'texture.blobShadow');
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

/** 1x1 black texture — the neutral default for the global damage/dust mask. */
export function createBlackPixelTexture(): THREE.DataTexture {
  const texture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
  texture.name = 'texture.black1x1';
  texture.colorSpace = THREE.NoColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
