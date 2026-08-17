/**
 * IMAGE-BASED LIGHTING
 *
 * Two paths behind one interface, chosen by render tier:
 *
 *   'pmrem' — `PMREMGenerator` builds a pre-filtered radiance cube-UV map and
 *             it becomes `scene.environment`. Correct diffuse AND specular IBL.
 *             Costs ~8-12 MB of VRAM and a burst of GPU work at load.
 *
 *   'sh9'   — 9 spherical-harmonic coefficients projected on the CPU become a
 *             `THREE.LightProbe`. Diffuse irradiance is within a couple of
 *             percent of PMREM; specular falls back to an analytic ambient
 *             tint. Zero environment VRAM, zero GPU work at load.
 *
 * ── WHY THE SPLIT IS NOT AN OPTIMISATION DETAIL ────────────────────────────
 * On a 3 GB Android device the PMREM's VRAM competes directly with streamed
 * city textures, and its load-time GPU burst lands while the loader is already
 * uploading everything else. Meanwhile the difference on a 5-inch screen, in
 * an outdoor scene lit mostly by one strong sun, is close to invisible. This is
 * the single biggest "looks the same, costs nothing" trade in the renderer.
 *
 * ── SOURCE-AGNOSTIC BY CONTRACT ────────────────────────────────────────────
 * `setEnvironment()` accepts any `THREE.Texture`. The asset workstream supplies
 * real HDRIs through `IAssetRegistry.getHDRI()`; the harness supplies a
 * procedural one. This module never touches a file path or an asset id.
 */

import * as THREE from 'three';
import type { IDisposable, ILightingState } from '@/types';
import { createLogger } from '@/util';
import { averageIrradiance, projectEquirectToSH9 } from './sh9';

const log = createLogger('engine.ibl');

/** Which IBL path is in use. Mirrors `RenderTierProfile.ibl`. */
export type IBLMode = 'pmrem' | 'sh9';

export interface IEnvironmentLightingOptions {
  readonly mode?: IBLMode;
  /** Render the environment as the scene background as well as lighting it. */
  readonly showBackground?: boolean;
  /** Blur applied to the background only, 0..1. Lighting is unaffected. */
  readonly backgroundBlur?: number;
  /** Multiplier on environment lighting. Usually driven by `ILightingState`. */
  readonly intensity?: number;
  /**
   * Release the `PMREMGenerator` as soon as the environment is built, freeing
   * its three shader programs. On by default; turn it off only when swapping
   * environments every few seconds (a fast day/night cycle), where rebuilding
   * the generator each time costs more than holding it.
   */
  readonly disposeGeneratorAfterBuild?: boolean;
}

/** What the current environment actually costs, for the debug HUD. */
export interface IEnvironmentStats {
  readonly mode: IBLMode;
  /** Approximate GPU bytes held by the environment map. 0 on the SH path. */
  readonly gpuBytes: number;
  /** Edge size of the PMREM cube-UV texture, 0 on the SH path. */
  readonly resolution: number;
  /** True when SH coefficients are live. */
  readonly hasSphericalHarmonics: boolean;
  /** Milliseconds the last `setEnvironment()` took. */
  readonly lastBuildMs: number;
}

export class EnvironmentLighting implements IDisposable {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;

  private pmrem: THREE.PMREMGenerator | undefined;
  private envRenderTarget: THREE.WebGLRenderTarget | undefined;
  private probe: THREE.LightProbe | undefined;
  private sourceTexture: THREE.Texture | undefined;
  /** Background copy, kept when the environment itself is SH-only. */
  private backgroundTexture: THREE.Texture | undefined;

  private modeValue: IBLMode;
  private intensityValue: number;
  private showBackgroundValue: boolean;
  private backgroundBlurValue: number;
  private readonly disposeGeneratorAfterBuild: boolean;
  private lastBuildMs = 0;
  private resolution = 0;
  private disposed = false;

  /**
   * Analytic ambient standing in for specular reflection on the SH path.
   * Without it, metals sample a nonexistent environment and render black.
   */
  private readonly fallbackAmbient: THREE.HemisphereLight;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    options: IEnvironmentLightingOptions = {}
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.modeValue = options.mode ?? 'pmrem';
    this.intensityValue = options.intensity ?? 1;
    this.showBackgroundValue = options.showBackground ?? true;
    this.backgroundBlurValue = options.backgroundBlur ?? 0;
    this.disposeGeneratorAfterBuild = options.disposeGeneratorAfterBuild ?? true;

    this.fallbackAmbient = new THREE.HemisphereLight(0x9dbdf0, 0x3a3128, 0);
    this.fallbackAmbient.name = 'ibl.fallbackAmbient';
    this.scene.add(this.fallbackAmbient);
  }

  get mode(): IBLMode {
    return this.modeValue;
  }

  /** Live SH coefficients, or undefined on the PMREM path. */
  get sphericalHarmonics(): THREE.SphericalHarmonics3 | undefined {
    return this.probe?.sh;
  }

  /**
   * Install an equirectangular radiance map as the scene environment.
   *
   * Idempotent for the same texture and mode. The caller keeps ownership of
   * `texture`; everything derived from it is owned and disposed here.
   */
  setEnvironment(texture: THREE.Texture | null): void {
    if (this.disposed) return;
    const started = performance.now();

    this.releaseDerived();
    this.sourceTexture = texture ?? undefined;

    if (!texture) {
      this.scene.environment = null;
      if (this.showBackgroundValue) this.scene.background = null;
      this.fallbackAmbient.intensity = 0;
      this.lastBuildMs = 0;
      return;
    }

    texture.mapping = THREE.EquirectangularReflectionMapping;

    if (this.modeValue === 'pmrem') {
      this.buildPmrem(texture);
    } else {
      this.buildSphericalHarmonics(texture);
    }

    this.applyBackground(texture);
    this.applyIntensity();
    this.lastBuildMs = performance.now() - started;
    log.info(
      `environment ready via ${this.modeValue} in ${this.lastBuildMs.toFixed(1)}ms ` +
        `(${(this.estimateGpuBytes() / 1024 / 1024).toFixed(2)} MB)`
    );
  }

  /** Rebuild with a different path. Cheap when no environment is installed. */
  setMode(mode: IBLMode): void {
    if (mode === this.modeValue) return;
    this.modeValue = mode;
    const source = this.sourceTexture;
    if (source) this.setEnvironment(source);
  }

  /** Pull exposure-independent environment settings out of the lighting state. */
  applyLightingState(state: ILightingState): void {
    this.setIntensity(state.envMapIntensity);
    if (this.modeValue === 'sh9') {
      // The hemisphere fallback tracks sky/ground so a day/night cycle still
      // moves ambient colour on the cheap path.
      this.fallbackAmbient.color.copy(state.ambientColor);
      this.fallbackAmbient.groundColor.copy(state.groundColor);
    }
  }

  setIntensity(intensity: number): void {
    this.intensityValue = intensity;
    this.applyIntensity();
  }

  get intensity(): number {
    return this.intensityValue;
  }

  /** Show or hide the environment as the visible sky. */
  setBackgroundVisible(visible: boolean): void {
    this.showBackgroundValue = visible;
    if (!visible) {
      this.scene.background = null;
    } else if (this.sourceTexture) {
      this.applyBackground(this.sourceTexture);
    }
  }

  /** Blur the SKY only. Lighting is untouched. 0..1. */
  setBackgroundBlur(blur: number): void {
    this.backgroundBlurValue = Math.min(1, Math.max(0, blur));
    this.scene.backgroundBlurriness = this.backgroundBlurValue;
  }

  getStats(): IEnvironmentStats {
    return {
      mode: this.modeValue,
      gpuBytes: this.estimateGpuBytes(),
      resolution: this.resolution,
      hasSphericalHarmonics: this.probe !== undefined,
      lastBuildMs: this.lastBuildMs,
    };
  }

  /* ---------------------------------------------------------------------- */

  private buildPmrem(texture: THREE.Texture): void {
    this.pmrem ??= new THREE.PMREMGenerator(this.renderer);
    // Compiling the equirect shader up front keeps the compile out of the
    // first `fromEquirectangular()` call, which otherwise stalls mid-load.
    this.pmrem.compileEquirectangularShader();
    const target = this.pmrem.fromEquirectangular(texture);
    this.envRenderTarget = target;
    this.resolution = target.width;
    this.scene.environment = target.texture;
    this.fallbackAmbient.intensity = 0;

    if (this.disposeGeneratorAfterBuild) {
      // The generator holds three internal materials (equirect projection,
      // cubemap projection, spherical-gaussian blur) whose programs stay
      // resident for its lifetime. They are useless after the environment is
      // built, and against a 24-program whole-game budget three programs is
      // more than a tenth of it. The output render target survives the
      // generator; a later `setEnvironment()` rebuilds a fresh one.
      this.pmrem.dispose();
      this.pmrem = undefined;
    }
  }

  private buildSphericalHarmonics(texture: THREE.Texture): void {
    const sh = projectEquirectToSH9(texture);
    if (!sh) {
      // Unreadable source (compressed / DOM image). PMREM is the only way to
      // get ANY environment lighting out of it, so take the cost rather than
      // render an unlit scene.
      log.warn('SH projection unavailable; falling back to PMREM for this environment');
      this.buildPmrem(texture);
      return;
    }

    this.probe = new THREE.LightProbe(sh, 1);
    this.probe.name = 'ibl.sh9';
    this.scene.add(this.probe);
    // No radiance map exists on this path, so nothing can be reflected. A weak
    // hemisphere light tinted to the environment's average keeps metals and
    // smooth dielectrics from reading as black holes.
    const average = averageIrradiance(sh);
    this.fallbackAmbient.color.copy(average);
    this.fallbackAmbient.groundColor.copy(average).multiplyScalar(0.35);
    this.fallbackAmbient.intensity = 0.35;
    this.scene.environment = null;
    this.resolution = 0;
  }

  private applyBackground(texture: THREE.Texture): void {
    if (!this.showBackgroundValue) {
      this.scene.background = null;
      return;
    }
    // Prefer the PMREM output as the background: it is already resident, and
    // reusing it avoids a second full-resolution equirect texture on the GPU.
    const background = this.envRenderTarget?.texture ?? texture;
    this.backgroundTexture = background;
    this.scene.background = background;
    this.scene.backgroundBlurriness = this.backgroundBlurValue;
  }

  private applyIntensity(): void {
    this.scene.environmentIntensity = this.intensityValue;
    this.scene.backgroundIntensity = this.intensityValue;
    if (this.probe) this.probe.intensity = this.intensityValue;
  }

  /** Bytes the environment map occupies. Cube-UV RGBA16F, mips included. */
  private estimateGpuBytes(): number {
    if (!this.envRenderTarget) return 0;
    const { width, height } = this.envRenderTarget;
    // Half-float RGBA = 8 bytes/texel. The cube-UV layout already contains the
    // whole roughness mip chain in one texture, so no 4/3 mip factor.
    return width * height * 8;
  }

  private releaseDerived(): void {
    if (this.envRenderTarget) {
      if (this.scene.environment === this.envRenderTarget.texture) this.scene.environment = null;
      if (this.scene.background === this.envRenderTarget.texture) this.scene.background = null;
      this.envRenderTarget.dispose();
      this.envRenderTarget = undefined;
    }
    if (this.probe) {
      this.scene.remove(this.probe);
      this.probe.dispose();
      this.probe = undefined;
    }
    if (this.backgroundTexture && this.scene.background === this.backgroundTexture) {
      this.scene.background = null;
    }
    this.backgroundTexture = undefined;
    this.resolution = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseDerived();
    // PMREMGenerator holds several internal materials — leaving it alive keeps
    // its shader programs resident, which the program budget notices.
    this.pmrem?.dispose();
    this.pmrem = undefined;
    this.scene.remove(this.fallbackAmbient);
    this.fallbackAmbient.dispose();
    this.sourceTexture = undefined;
  }
}
