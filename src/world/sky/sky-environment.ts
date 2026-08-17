/**
 * THE BLENDED SKY — exposure-normalised cross-fading between four baked HDRIs.
 *
 * ── THE PIPELINE, IN ORDER ─────────────────────────────────────────────────
 *   1. Two source equirects are chosen by the clock (`sampleSkyBlend`).
 *   2. Each is divided by ITS OWN measured mean luminance in the blend shader,
 *      so both arrive on a common unit scale. This is the step that stops
 *      midnight looking like noon; see `constants.ts`.
 *   3. They are mixed into a half-float equirect render target.
 *   4. That target is the visible sky, and the source for the pre-filtered
 *      radiance map.
 *   5. The absolute brightness of the moment rides separately, as
 *      `scene.environmentIntensity` / `backgroundIntensity`.
 *
 * Splitting 3 from 5 is what makes the whole thing affordable: the blend and
 * the intensity change every frame, but the expensive PMREM convolution only
 * has to be redone when the MIX changes, and the mix is a slow signal.
 *
 * ── TWO PATHS, ONE CLASS ───────────────────────────────────────────────────
 *   'pmrem' — full radiance map off the blend target. Correct diffuse and
 *             specular IBL. ~2 MB at a 256 cube.
 *   'sh9'   — the two skies' BAKED SH sets are blended analytically on the
 *             CPU (27 floats each, no GPU work at all) into a `LightProbe`,
 *             plus a deliberately tiny specular-only probe so smooth metal has
 *             something to reflect. The baked coefficients are the right
 *             source here: they were projected from the FULL-PRECISION HDRIs,
 *             so the day sky's sun energy is intact even though the shipped
 *             half-float map clamps it at 65504.
 *
 * ── WHAT THIS MODULE MUST NOT DO ───────────────────────────────────────────
 * It never imports the renderer workstream. It takes a `THREE.WebGLRenderer`
 * and a `THREE.Scene` and touches only three's own API, so the engine and the
 * sky stay independently replaceable.
 */

import * as THREE from 'three';
import type { IAssetRegistry, IDisposable } from '@/types';
import { createLogger } from '@/util';
import {
  BLEND_TARGET_WIDTH_PMREM,
  BLEND_TARGET_WIDTH_SH9,
  ENVIRONMENT_REBUILD_THRESHOLD,
  MAX_BLEND_RADIANCE,
  SKY_ASSET_IDS,
  type SkyKey,
} from './constants';
import {
  normalisationScale,
  type EnvironmentMeasurements,
  type ISkyBlend,
} from './environment-blend';

const log = createLogger('world.sky.env');

/** Which image-based-lighting path is in use. */
export type SkyIBLMode = 'pmrem' | 'sh9';

export interface ISkyEnvironmentOptions {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly registry: IAssetRegistry;
  readonly measurements: EnvironmentMeasurements;
  readonly mode?: SkyIBLMode;
  /** Equirect width of the blend target. Defaults per mode. */
  readonly blendWidth?: number;
  /** Cube-face size of the specular-only probe on the SH path. 0 disables it. */
  readonly specularCubeSize?: number;
  /** Render the blended sky as the visible background. */
  readonly showBackground?: boolean;
  /**
   * Called when the environment map becomes specular-only, so the material
   * layer can cancel its diffuse term. Without it the SH probe and the probe
   * texture both light the surface and everything is a stop too bright.
   */
  readonly onSpecularOnlyChanged?: (specularOnly: boolean) => void;
}

export interface ISkyEnvironmentStats {
  readonly mode: SkyIBLMode;
  readonly loaded: readonly SkyKey[];
  readonly missing: readonly SkyKey[];
  readonly blendWidth: number;
  readonly radianceResolution: number;
  readonly radianceRebuilds: number;
  readonly lastRebuildMs: number;
  readonly gpuBytes: number;
  readonly specularOnly: boolean;
  /** Multiplier applied to each source to flatten it onto a unit mean. */
  readonly normalisation: Readonly<Record<SkyKey, number>>;
}

const BLEND_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const BLEND_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tFrom;
uniform sampler2D tTo;
uniform float uScaleFrom;
uniform float uScaleTo;
uniform float uAlpha;
uniform float uMaxRadiance;

void main() {
  // Each source carries its own exposure. Dividing by its measured mean
  // (uScaleFrom / uScaleTo) puts both on a unit scale BEFORE the mix, which is
  // the only way the mix has a defined brightness for every value of uAlpha.
  vec3 a = texture2D(tFrom, vUv).rgb * uScaleFrom;
  vec3 b = texture2D(tTo, vUv).rgb * uScaleTo;
  vec3 c = mix(a, b, uAlpha);

  // The day map's sun disc is already clamped at the half-float ceiling;
  // normalising pushes it past +Inf, and one Inf poisons an entire PMREM mip
  // chain with NaN. Clamp rather than overflow.
  gl_FragColor = vec4(min(c, vec3(uMaxRadiance)), 1.0);
}
`;

export class SkyEnvironment implements IDisposable {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly registry: IAssetRegistry;
  private readonly measurements: EnvironmentMeasurements;
  private readonly modeValue: SkyIBLMode;
  private readonly showBackground: boolean;
  private readonly specularCubeSize: number;
  private readonly onSpecularOnlyChanged: ((specularOnly: boolean) => void) | undefined;

  private readonly blendTarget: THREE.WebGLRenderTarget;
  private readonly specularTarget: THREE.WebGLRenderTarget | undefined;
  private readonly blendMaterial: THREE.ShaderMaterial;
  private readonly blendScene = new THREE.Scene();
  private readonly blendCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly blendQuad: THREE.Mesh;

  private pmrem: THREE.PMREMGenerator | undefined;
  private radianceTarget: THREE.WebGLRenderTarget | undefined;
  private probe: THREE.LightProbe | undefined;

  private loadedKeys: SkyKey[] = [];
  private lastBuiltSignature = Number.NaN;
  private rebuilds = 0;
  private lastRebuildMs = 0;
  private specularOnly = false;
  private disposed = false;

  constructor(options: ISkyEnvironmentOptions) {
    this.renderer = options.renderer;
    this.scene = options.scene;
    this.registry = options.registry;
    this.measurements = options.measurements;
    this.modeValue = options.mode ?? 'pmrem';
    this.showBackground = options.showBackground ?? true;
    this.specularCubeSize = Math.max(0, options.specularCubeSize ?? 32);
    this.onSpecularOnlyChanged = options.onSpecularOnlyChanged;

    const width =
      options.blendWidth ??
      (this.modeValue === 'pmrem' ? BLEND_TARGET_WIDTH_PMREM : BLEND_TARGET_WIDTH_SH9);
    this.blendTarget = makeEquirectTarget(width);
    this.blendTarget.texture.name = 'sky.blend';

    if (this.modeValue === 'sh9' && this.specularCubeSize > 0) {
      // PMREM sizes its cube from the SOURCE (`width / 4`) and offers no other
      // way to be asked for something small, so the small source is rendered
      // rather than the big one downsampled — a second fullscreen pass at
      // 128x64 is cheaper than any readback.
      this.specularTarget = makeEquirectTarget(this.specularCubeSize * 4);
      this.specularTarget.texture.name = 'sky.blend.specular';
    }

    this.blendMaterial = new THREE.ShaderMaterial({
      vertexShader: BLEND_VERTEX,
      fragmentShader: BLEND_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tFrom: { value: null },
        tTo: { value: null },
        uScaleFrom: { value: 1 },
        uScaleTo: { value: 1 },
        uAlpha: { value: 0 },
        uMaxRadiance: { value: MAX_BLEND_RADIANCE },
      },
    });
    this.blendQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blendMaterial);
    this.blendQuad.frustumCulled = false;
    this.blendScene.add(this.blendQuad);
  }

  get mode(): SkyIBLMode {
    return this.modeValue;
  }

  /** The blended, exposure-normalised equirect. Unit mean by construction. */
  get blendedTexture(): THREE.Texture {
    return this.blendTarget.texture;
  }

  get ready(): boolean {
    return this.loadedKeys.length === 4;
  }

  /**
   * Load all four skies through the registry.
   *
   * Partial success is allowed and reported: three skies still give a working
   * cycle, and a cycle with a gap is far better than a black world. Nothing
   * here knows a file path — ids only.
   */
  async load(onProgress?: (loaded: number, total: number) => void): Promise<readonly SkyKey[]> {
    const keys = Object.keys(SKY_ASSET_IDS) as SkyKey[];
    let done = 0;
    const results = await Promise.all(
      keys.map(async (key) => {
        try {
          await this.registry.load(SKY_ASSET_IDS[key]);
          return key;
        } catch (error) {
          log.warn(`sky "${key}" (${SKY_ASSET_IDS[key]}) failed to load: ${String(error)}`);
          return undefined;
        } finally {
          done++;
          onProgress?.(done, keys.length);
        }
      })
    );
    this.loadedKeys = results.filter((key): key is SkyKey => key !== undefined);
    return this.loadedKeys;
  }

  /**
   * Apply one frame's blend.
   *
   * @param blend     The two skies and their mix.
   * @param force     Rebuild the radiance map regardless of the hysteresis
   *                  threshold. Used when jumping the clock, where a stepped
   *                  environment would be plainly wrong.
   */
  update(blend: ISkyBlend, force = false): void {
    if (this.disposed) return;

    const from = this.textureFor(blend.from);
    const to = this.textureFor(blend.to) ?? from;
    if (!from) return;

    const uniforms = this.blendMaterial.uniforms;
    uniforms.tFrom!.value = from;
    uniforms.tTo!.value = to;
    uniforms.uScaleFrom!.value = normalisationScale(this.measurements[blend.from]);
    uniforms.uScaleTo!.value = normalisationScale(this.measurements[blend.to]);
    uniforms.uAlpha!.value = to === from ? 0 : blend.alpha;

    this.renderBlend(this.blendTarget);

    if (this.showBackground) {
      this.scene.background = this.blendTarget.texture;
      this.scene.backgroundIntensity = blend.luminance;
    }
    this.scene.environmentIntensity = blend.luminance;

    const signature = signatureOf(blend);
    if (force || !Number.isFinite(this.lastBuiltSignature) ||
        Math.abs(signature - this.lastBuiltSignature) >= ENVIRONMENT_REBUILD_THRESHOLD) {
      this.rebuildRadiance();
      this.lastBuiltSignature = signature;
    }

    if (this.probe) this.probe.intensity = blend.luminance;
  }

  /**
   * Install a blended SH set as the diffuse probe. Called by the day/night
   * system, which owns the blending — the coefficients arrive already
   * normalised to a unit mean, so `intensity` carries the time of day.
   */
  setSphericalHarmonics(sh: THREE.SphericalHarmonics3, intensity: number): void {
    if (this.modeValue !== 'sh9' || this.disposed) return;
    if (!this.probe) {
      this.probe = new THREE.LightProbe(sh.clone(), intensity);
      this.probe.name = 'sky.sh9';
      this.scene.add(this.probe);
    } else {
      this.probe.sh.copy(sh);
      this.probe.intensity = intensity;
    }
  }

  getStats(): ISkyEnvironmentStats {
    const all = Object.keys(SKY_ASSET_IDS) as SkyKey[];
    const normalisation = {} as Record<SkyKey, number>;
    for (const key of all) normalisation[key] = normalisationScale(this.measurements[key]);
    return {
      mode: this.modeValue,
      loaded: this.loadedKeys,
      missing: all.filter((key) => !this.loadedKeys.includes(key)),
      blendWidth: this.blendTarget.width,
      radianceResolution: this.radianceTarget?.width ?? 0,
      radianceRebuilds: this.rebuilds,
      lastRebuildMs: this.lastRebuildMs,
      gpuBytes: this.estimateGpuBytes(),
      specularOnly: this.specularOnly,
      normalisation,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.scene.background === this.blendTarget.texture) this.scene.background = null;
    if (this.radianceTarget && this.scene.environment === this.radianceTarget.texture) {
      this.scene.environment = null;
    }
    this.radianceTarget?.dispose();
    this.blendTarget.dispose();
    this.specularTarget?.dispose();
    this.blendMaterial.dispose();
    this.blendQuad.geometry.dispose();
    this.pmrem?.dispose();
    if (this.probe) {
      this.scene.remove(this.probe);
      this.probe.dispose();
      this.probe = undefined;
    }
  }

  /* ---------------------------------------------------------------------- */

  private textureFor(key: SkyKey): THREE.Texture | undefined {
    return this.registry.getHDRI(SKY_ASSET_IDS[key]);
  }

  private renderBlend(target: THREE.WebGLRenderTarget): void {
    const previousTarget = this.renderer.getRenderTarget();
    const previousXr = this.renderer.xr.enabled;
    this.renderer.xr.enabled = false;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.blendScene, this.blendCamera);
    this.renderer.setRenderTarget(previousTarget);
    this.renderer.xr.enabled = previousXr;
  }

  private rebuildRadiance(): void {
    const started = performance.now();

    let source: THREE.Texture;
    if (this.modeValue === 'sh9') {
      if (!this.specularTarget) {
        // Specular probe disabled: nothing to reflect, and smooth metal will
        // render black. Not a shipping configuration, but the harness measures
        // exactly this to prove the probe earns its bytes.
        this.setSpecularOnly(false);
        return;
      }
      this.renderBlend(this.specularTarget);
      source = this.specularTarget.texture;
    } else {
      source = this.blendTarget.texture;
    }
    source.mapping = THREE.EquirectangularReflectionMapping;

    this.pmrem ??= new THREE.PMREMGenerator(this.renderer);
    this.pmrem.compileEquirectangularShader();
    const next = this.pmrem.fromEquirectangular(source);

    // Swap, then release the old one: disposing first would leave
    // `scene.environment` pointing at freed GPU memory for the width of this
    // function, which some drivers do not survive.
    const previous = this.radianceTarget;
    this.radianceTarget = next;
    this.scene.environment = next.texture;
    previous?.dispose();

    this.setSpecularOnly(this.modeValue === 'sh9');
    this.rebuilds++;
    this.lastRebuildMs = performance.now() - started;
  }

  private setSpecularOnly(active: boolean): void {
    if (active === this.specularOnly) return;
    this.specularOnly = active;
    this.onSpecularOnlyChanged?.(active);
  }

  private estimateGpuBytes(): number {
    let bytes = this.blendTarget.width * this.blendTarget.height * 8;
    if (this.specularTarget) {
      bytes += this.specularTarget.width * this.specularTarget.height * 8;
    }
    if (this.radianceTarget) {
      bytes += this.radianceTarget.width * this.radianceTarget.height * 8;
    }
    return bytes;
  }
}

function makeEquirectTarget(width: number): THREE.WebGLRenderTarget {
  const w = Math.max(64, Math.round(width));
  const target = new THREE.WebGLRenderTarget(w, w >> 1, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.NoColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  target.texture.mapping = THREE.EquirectangularReflectionMapping;
  target.texture.wrapS = THREE.RepeatWrapping;
  target.texture.wrapT = THREE.ClampToEdgeWrapping;
  return target;
}

/**
 * A scalar that changes when the MIX changes and not otherwise.
 *
 * Keyed on the pair plus alpha rather than on the raw time, so a stretch of
 * cycle that sits on one sky costs no rebuilds at all, and a fast cross-fade
 * gets the rebuilds it needs.
 */
function signatureOf(blend: ISkyBlend): number {
  const order: Record<SkyKey, number> = { night: 0, dawn: 1, day: 2, dusk: 3 };
  return order[blend.from] + (blend.from === blend.to ? 0 : blend.alpha);
}
