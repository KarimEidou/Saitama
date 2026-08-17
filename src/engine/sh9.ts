/**
 * 9-COEFFICIENT SPHERICAL-HARMONIC IRRADIANCE — the mobile IBL path.
 *
 * ── WHAT THIS BUYS ─────────────────────────────────────────────────────────
 * A PMREM (pre-filtered radiance environment map) is the correct way to do
 * image-based lighting, and it is expensive twice over: ~8-12 MB of VRAM for
 * the mip chain at a usable resolution, and a burst of GPU work at load while
 * every roughness level is convolved. On a 3 GB Android device that VRAM
 * competes directly with streamed city textures, and the load cost lands on
 * the loading screen where the player is already waiting.
 *
 * Nine RGB coefficients — 27 floats — reproduce DIFFUSE irradiance from an
 * environment to within a couple of percent (Ramamoorthi & Hanrahan 2001). The
 * error is concentrated in high-frequency detail that diffuse response
 * integrates away anyway. What SH cannot do is SPECULAR reflection, so the
 * mobile tier accepts an analytic specular fallback and keeps every byte of
 * the saved VRAM.
 *
 * ── WHY ON THE CPU ─────────────────────────────────────────────────────────
 * Projecting a 256x128 equirect map is ~32k samples: a few milliseconds of
 * plain arithmetic, off the GPU entirely, with no render targets, no readback
 * stall, and no dependency on float-render-target support. `LightProbeGenerator`
 * requires rendering the map into a cube target and reading it back — more
 * code paths, more failure modes, and it needs the GPU during loading, which
 * is exactly when the GPU is busy uploading textures.
 *
 * ── CONVENTION ─────────────────────────────────────────────────────────────
 * Coefficients are ∫ L(ω)·Y(ω) dω normalised so the weights sum to 4π, which is
 * what `THREE.LightProbe` / `SphericalHarmonics3.getIrradianceAt()` expects and
 * what `LightProbeGenerator.fromCubeTexture` produces. Do not "fix" the
 * normalisation without checking against that function.
 */

import * as THREE from 'three';
import { createLogger } from '@/util';
import { createEquirectReader } from './equirect';

const log = createLogger('engine.sh9');

/**
 * Project an equirectangular radiance texture onto 9 SH coefficients.
 *
 * The texture's `image.data` must be readable — that is true for `DataTexture`,
 * for `RGBELoader`/`EXRLoader` output, and for `UltraHDRLoader` output, but not
 * for a texture created from an `<img>` or a compressed KTX2. Returns null in
 * that case so the caller can fall back to PMREM rather than render black.
 *
 * @param texture   Equirectangular radiance map.
 * @param intensity Multiplier applied to every coefficient.
 */
export function projectEquirectToSH9(
  texture: THREE.Texture,
  intensity = 1
): THREE.SphericalHarmonics3 | null {
  const reader = createEquirectReader(texture);
  if (!reader) {
    log.warn(
      `environment texture "${texture.name || 'unnamed'}" has no readable pixel ` +
        `data; SH projection is unavailable (compressed or DOM-image source).`
    );
    return null;
  }
  const { width, height, channels, read } = reader;

  const sh = new THREE.SphericalHarmonics3();
  const coefficients = sh.coefficients;
  const basis = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const direction = new THREE.Vector3();

  // Solid angle of one texel row: dElevation * dPhi * cos(elevation).
  const dElevation = Math.PI / height;
  const dPhi = (Math.PI * 2) / width;
  let totalWeight = 0;

  for (let y = 0; y < height; y++) {
    // `DataTexture.flipY` is false, so row 0 is v = 0, i.e. straight down.
    const v = (y + 0.5) / height;
    const elevation = (v - 0.5) * Math.PI;
    const dirY = Math.sin(elevation);
    const radius = Math.cos(elevation);
    const weight = Math.max(0, radius) * dElevation * dPhi;
    if (weight <= 0) continue;

    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const phi = (u - 0.5) * Math.PI * 2;
      direction.set(Math.cos(phi) * radius, dirY, Math.sin(phi) * radius).normalize();

      const index = (y * width + x) * channels;
      const r = read(index);
      const g = channels > 1 ? read(index + 1) : r;
      const b = channels > 2 ? read(index + 2) : r;

      THREE.SphericalHarmonics3.getBasisAt(direction, basis);
      totalWeight += weight;
      for (let j = 0; j < 9; j++) {
        const bw = basis[j]! * weight;
        coefficients[j]!.x += bw * r;
        coefficients[j]!.y += bw * g;
        coefficients[j]!.z += bw * b;
      }
    }
  }

  if (totalWeight <= 0) return null;

  const norm = ((4 * Math.PI) / totalWeight) * intensity;
  for (let j = 0; j < 9; j++) coefficients[j]!.multiplyScalar(norm);

  return sh;
}

/**
 * Mean irradiance the coefficients represent, as a linear colour.
 *
 * Useful as the analytic specular/ambient fallback on the SH path: with no
 * PMREM there is no reflection to sample, so a constant environment tint that
 * matches the SH's average brightness keeps metals from going black.
 */
export function averageIrradiance(sh: THREE.SphericalHarmonics3): THREE.Color {
  const target = new THREE.Vector3();
  const accumulator = new THREE.Vector3();
  const directions: readonly THREE.Vector3[] = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(0, 0, -1),
  ];
  for (const direction of directions) {
    sh.getIrradianceAt(direction, target);
    accumulator.add(target);
  }
  accumulator.multiplyScalar(1 / directions.length);
  return new THREE.Color(accumulator.x, accumulator.y, accumulator.z);
}

/** Serialise to 27 floats, for caching a projection across sessions. */
export function serializeSH9(sh: THREE.SphericalHarmonics3): number[] {
  const out: number[] = [];
  for (const coefficient of sh.coefficients) out.push(coefficient.x, coefficient.y, coefficient.z);
  return out;
}

/** Inverse of `serializeSH9`. Returns null when the array is malformed. */
export function deserializeSH9(values: readonly number[]): THREE.SphericalHarmonics3 | null {
  if (values.length !== 27) return null;
  const sh = new THREE.SphericalHarmonics3();
  for (let j = 0; j < 9; j++) {
    sh.coefficients[j]!.set(values[j * 3]!, values[j * 3 + 1]!, values[j * 3 + 2]!);
  }
  return sh;
}
