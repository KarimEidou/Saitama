/**
 * PROCEDURAL SKY HDRI
 *
 * Generates an equirectangular, floating-point radiance map on the CPU. It is
 * a stand-in, not a shipping asset: the asset workstream supplies real Poly
 * Haven HDRIs through `IAssetProvider`, and `EnvironmentLighting` accepts any
 * `THREE.Texture` regardless of where it came from. Nothing downstream knows
 * or cares which one it got.
 *
 * Having a real HDR environment available with zero I/O matters for three
 * reasons: the renderer can boot and light a scene before the asset pipeline
 * exists, the verification harness has deterministic content, and PMREM/SH
 * paths can be compared against a known-good source.
 *
 * ── EQUIRECTANGULAR CONVENTION ─────────────────────────────────────────────
 * Matches three's `equirectUv()` exactly:
 *   u = atan2( d.z, d.x ) / 2π + 0.5
 *   v = asin( d.y ) / π + 0.5
 * `DataTexture.flipY` is false, so data row 0 is v=0, i.e. straight DOWN.
 * `sh9.ts` uses the same inverse mapping — if you change one, change both.
 */

import * as THREE from 'three';

export interface IProceduralSkyOptions {
  /** Equirect width in pixels. Height is always width / 2. */
  readonly width?: number;
  /** Direction the sunlight TRAVELS, matching `ILightingState.sunDirection`. */
  readonly sunDirection?: THREE.Vector3;
  /** Linear-space sun colour. */
  readonly sunColor?: THREE.Color;
  /** Peak radiance of the sun disc. Real skies are 1e4+; this is tone mapped. */
  readonly sunIntensity?: number;
  /** Zenith sky colour, linear. */
  readonly zenithColor?: THREE.Color;
  /** Horizon sky colour, linear. */
  readonly horizonColor?: THREE.Color;
  /** Ground hemisphere colour, linear. */
  readonly groundColor?: THREE.Color;
  /** 0..1 cloud coverage. 0 gives a clean gradient. */
  readonly cloudiness?: number;
  /** Overall multiplier. */
  readonly exposure?: number;
}

function hash3(x: number, y: number, z: number): number {
  let h = x * 374761393 + y * 668265263 + z * 1274126177;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Tileable-in-phi value noise on the sphere, sampled in direction space. */
function skyNoise(x: number, y: number, z: number, scale: number): number {
  const sx = x * scale;
  const sy = y * scale;
  const sz = z * scale;
  const xi = Math.floor(sx);
  const yi = Math.floor(sy);
  const zi = Math.floor(sz);
  const xf = sx - xi;
  const yf = sy - yi;
  const zf = sz - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);

  let result = 0;
  for (let dz = 0; dz <= 1; dz++) {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const weight = (dx === 1 ? u : 1 - u) * (dy === 1 ? v : 1 - v) * (dz === 1 ? w : 1 - w);
        result += hash3(xi + dx, yi + dy, zi + dz) * weight;
      }
    }
  }
  return result;
}

function cloudField(x: number, y: number, z: number): number {
  return (
    skyNoise(x, y, z, 3) * 0.5 +
    skyNoise(x, y, z, 7) * 0.28 +
    skyNoise(x, y, z, 15) * 0.14 +
    skyNoise(x, y, z, 31) * 0.08
  );
}

/**
 * Build the environment map.
 *
 * @returns A float RGBA `DataTexture` tagged `EquirectangularReflectionMapping`,
 *          ready for `PMREMGenerator.fromEquirectangular()` or for CPU SH
 *          projection. The caller owns it and must dispose it.
 */
export function createProceduralSkyTexture(options: IProceduralSkyOptions = {}): THREE.DataTexture {
  const width = options.width ?? 256;
  const height = width >> 1;

  // `sunDirection` travels FROM the sun, so the direction TO the sun is its
  // negation. Getting this backwards puts the sun under the floor.
  const toSun = (options.sunDirection ?? new THREE.Vector3(-0.45, -0.78, -0.43))
    .clone()
    .normalize()
    .negate();

  const sunColor = options.sunColor ?? new THREE.Color(0xfff2dc);
  const sunIntensity = options.sunIntensity ?? 260;
  const zenith = options.zenithColor ?? new THREE.Color(0x2a5fae);
  const horizon = options.horizonColor ?? new THREE.Color(0xbdd2e8);
  const ground = options.groundColor ?? new THREE.Color(0x2c2620);
  const cloudiness = options.cloudiness ?? 0.45;
  const exposure = options.exposure ?? 1;

  const data = new Float32Array(width * height * 4);
  const dir = new THREE.Vector3();
  const color = new THREE.Color();
  const scratch = new THREE.Color();

  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    const elevation = (v - 0.5) * Math.PI;
    const dy = Math.sin(elevation);
    const radius = Math.cos(elevation);

    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const phi = (u - 0.5) * Math.PI * 2;
      dir.set(Math.cos(phi) * radius, dy, Math.sin(phi) * radius);

      // --- base gradient ---
      const up = Math.max(0, dy);
      color.copy(horizon).lerp(zenith, Math.pow(up, 0.42));

      // --- ground hemisphere ---
      if (dy < 0) {
        const t = Math.min(1, Math.pow(-dy, 0.35));
        color.lerp(ground, t);
      }

      // --- clouds: a band above the horizon, thinning towards the zenith ---
      if (cloudiness > 0 && dy > -0.02) {
        const band = Math.min(1, Math.max(0, (dy + 0.02) / 0.55));
        const n = cloudField(dir.x, dir.y * 2.4, dir.z);
        const density = Math.min(1, Math.max(0, (n - (1 - cloudiness) * 0.72) * 3.4)) * band;
        if (density > 0) {
          // Clouds are bright and near-white but pick up the sun's colour on
          // the side facing it.
          const facing = Math.max(0, dir.dot(toSun));
          scratch.copy(sunColor).multiplyScalar(0.55 + facing * 0.9);
          scratch.lerp(new THREE.Color(0.72, 0.76, 0.82), 0.35);
          color.lerp(scratch, density * 0.85);
        }
      }

      // --- sun disc and glow ---
      const cosGamma = dir.dot(toSun);
      if (cosGamma > 0) {
        // Two lobes: a tight forward-scatter glow and a broad haze.
        const glow = Math.pow(cosGamma, 380);
        const haze = Math.pow(cosGamma, 8) * 0.16 + Math.pow(cosGamma, 2) * 0.04;
        const add = haze + (glow > 1e-4 ? glow * sunIntensity : 0);
        color.r += sunColor.r * add;
        color.g += sunColor.g * add;
        color.b += sunColor.b * add;
      }

      color.multiplyScalar(exposure);

      const i = (y * width + x) * 4;
      data[i] = color.r;
      data[i + 1] = color.g;
      data[i + 2] = color.b;
      data[i + 3] = 1;
    }
  }

  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.name = 'hdri.procedural.sky';
  texture.mapping = THREE.EquirectangularReflectionMapping;
  // Radiance is already linear. Tagging it sRGB would double-decode it.
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}
