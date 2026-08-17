/**
 * ENVIRONMENT MAPS: PMREM ON DESKTOP, BAKED SH-9 ON MOBILE
 *
 * The four skies ship as zstd-supercompressed RGBA16F KTX2 equirects plus 27
 * spherical-harmonic floats each, already inside `assets.runtime.json`. Two
 * IBL paths come out of that, and which one is right is a device question:
 *
 *   PMREM (high/ultra) — `PMREMGenerator` convolves the equirect into a
 *     roughness-mipped cubemap. Correct specular response at every roughness,
 *     at the cost of a multi-megabyte render target and a build that stalls
 *     the frame it happens on.
 *
 *   SH-9 (mobile, the default) — nine RGB coefficients projected from the
 *     FULL-PRECISION source by the pipeline, so the day sky's sun energy is
 *     intact even where the stored half-float map clamps. Diffuse irradiance
 *     only, zero texture memory, zero build cost. On a phone that is the whole
 *     budget's worth of difference.
 *
 * ── meanLuminance IS NOT DECORATION ────────────────────────────────────────
 * The four HDRIs are NOT exposure-matched: peak luminance spans 4.0 to 137 000
 * — five orders of magnitude — while their MEANS sit within 1.5x of each
 * other. Anything comparing or cross-fading them must divide by
 * `meanLuminance` first, which is exactly why the pipeline exports it. It is
 * surfaced verbatim on `ILoadedEnvironment` (and `normalisationScale` is
 * provided) rather than folded into the texture, because the sky system needs
 * the number itself to blend two skies onto a common scale.
 */

import * as THREE from 'three';
import type { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { createLogger } from '@/util';
import type { QualityTier } from '@/types';
import { parseKTX2, prepareEnvironmentTexture } from './ktx2';
import { estimateGpuBytes } from './memory';
import type { IEnvironmentRecord } from './manifest';
import { missingEnvironment } from './fallback';

const log = createLogger('assets:environment');

/** How the irradiance for this environment is provided. */
export type EnvironmentMode = 'pmrem' | 'sh' | 'raw';

/** A resident environment map and its measurements. */
export interface ILoadedEnvironment {
  readonly key: string;
  /** Equirectangular radiance map, filtered and mapped correctly. */
  readonly texture: THREE.Texture;
  /** Pre-filtered cubemap. Present on the PMREM path only. */
  readonly pmrem: THREE.Texture | undefined;
  /** Baked diffuse irradiance. Present whenever the manifest carried sh9. */
  readonly sh: THREE.SphericalHarmonics3 | undefined;
  /** Ready-to-add probe wrapping `sh`, for the mobile path. */
  readonly lightProbe: THREE.LightProbe | undefined;
  /** Area-weighted mean luminance of the SOURCE HDRI. Normalise by this. */
  readonly meanLuminance: number;
  /** Peak luminance of the source, before half-float conversion. */
  readonly maxLuminance: number;
  /** The raw 27 coefficients, for consumers that blend them themselves. */
  readonly sh9: readonly number[] | undefined;
  readonly mode: EnvironmentMode;
  readonly gpuBytes: number;
  /** True when this is the marked stand-in for a missing map. */
  readonly fallback: boolean;
  dispose(): void;
}

/**
 * Multiplier that puts an environment on a unit-mean scale.
 *
 * `normalised = source * normalisationScale(env)`. Guarded against a zero or
 * absent measurement, which would otherwise divide the world by nothing.
 */
export function normalisationScale(environment: {
  readonly meanLuminance: number;
}): number {
  return 1 / Math.max(1e-6, environment.meanLuminance);
}

/** Deserialise 27 interleaved floats into a `SphericalHarmonics3`. */
export function sphericalHarmonicsFromArray(
  values: readonly number[],
  scale = 1
): THREE.SphericalHarmonics3 | undefined {
  if (values.length !== 27) return undefined;
  const sh = new THREE.SphericalHarmonics3();
  for (let i = 0; i < 9; i++) {
    sh.coefficients[i]!.set(
      (values[i * 3] ?? 0) * scale,
      (values[i * 3 + 1] ?? 0) * scale,
      (values[i * 3 + 2] ?? 0) * scale
    );
  }
  return sh;
}

export interface IEnvironmentLoaderOptions {
  readonly renderer: THREE.WebGLRenderer;
  readonly ktx2: KTX2Loader;
  /**
   * Build a PMREM chain. Defaults to false on the mobile tier — the SH path is
   * the mobile default precisely because PMREM is what costs the memory.
   */
  readonly pmrem?: boolean;
  readonly tier: QualityTier;
}

/**
 * Loads environment maps and provides irradiance by whichever path the tier
 * calls for. Owns one `PMREMGenerator`, because compiling its shaders is the
 * expensive part and doing it per map would stall four times over.
 */
export class EnvironmentLoader {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly ktx2: KTX2Loader;
  private readonly usePmrem: boolean;
  private pmremGenerator: THREE.PMREMGenerator | undefined;

  constructor(options: IEnvironmentLoaderOptions) {
    this.renderer = options.renderer;
    this.ktx2 = options.ktx2;
    this.usePmrem = options.pmrem ?? options.tier !== 'mobile';
  }

  get pmremEnabled(): boolean {
    return this.usePmrem;
  }

  /**
   * Decode an environment from KTX2 bytes.
   *
   * Takes bytes, not a URL, so the provider's tier fallback stays in charge of
   * WHICH file is read — the Android package has only the mobile variants, and
   * a loader that fetched for itself would ask for the high one.
   */
  async parse(
    key: string,
    bytes: ArrayBuffer,
    record: IEnvironmentRecord | undefined
  ): Promise<ILoadedEnvironment> {
    const texture = await parseKTX2(this.ktx2, bytes);
    prepareEnvironmentTexture(texture);
    texture.name = key;
    return this.finish(key, texture, record, false);
  }

  /** A marked stand-in so a missing sky leaves the world lit, not black. */
  fallbackFor(key: string, record: IEnvironmentRecord | undefined): ILoadedEnvironment {
    log.warn(`environment "${key}" is unavailable; using the neutral stand-in`);
    return this.finish(key, missingEnvironment(key), record, true);
  }

  private finish(
    key: string,
    texture: THREE.Texture,
    record: IEnvironmentRecord | undefined,
    fallback: boolean
  ): ILoadedEnvironment {
    const sh9 = record?.sh9;
    const sh = sh9 !== undefined ? sphericalHarmonicsFromArray(sh9) : undefined;
    const lightProbe = sh !== undefined ? new THREE.LightProbe(sh) : undefined;

    let pmrem: THREE.Texture | undefined;
    let target: THREE.WebGLRenderTarget | undefined;
    if (this.usePmrem && !fallback) {
      try {
        this.pmremGenerator ??= new THREE.PMREMGenerator(this.renderer);
        this.pmremGenerator.compileEquirectangularShader();
        target = this.pmremGenerator.fromEquirectangular(texture);
        pmrem = target.texture;
      } catch (error) {
        // A PMREM failure must not lose the sky: the raw equirect still works
        // as `scene.environment`, just with a flatter specular response.
        log.warn(`PMREM build failed for "${key}" (${String(error)}); using the raw equirect`);
        pmrem = undefined;
      }
    }

    const mode: EnvironmentMode = pmrem !== undefined ? 'pmrem' : sh !== undefined ? 'sh' : 'raw';
    if (mode === 'sh') {
      log.info(
        `environment "${key}" on the SH-9 path: 27 baked coefficients, ` +
          `no PMREM chain built`
      );
    }

    const gpuBytes =
      estimateGpuBytes(texture) + (pmrem !== undefined ? estimateGpuBytes(pmrem) : 0);

    return {
      key,
      texture,
      pmrem,
      sh,
      lightProbe,
      // A missing measurement normalises by 1, i.e. reproduces the unmatched
      // look, rather than dividing the scene into darkness.
      meanLuminance: record?.meanLuminance ?? 1,
      maxLuminance: record?.maxLuminance ?? 0,
      sh9,
      mode,
      gpuBytes,
      fallback,
      dispose: () => {
        if (!fallback) texture.dispose();
        target?.dispose();
      },
    };
  }

  dispose(): void {
    this.pmremGenerator?.dispose();
    this.pmremGenerator = undefined;
  }
}
