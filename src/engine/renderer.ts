/**
 * RENDERER — the `IRenderer` implementation.
 *
 * Owns the WebGL context, the colour pipeline, the resolution governor and the
 * per-frame statistics. Everything else in `src/engine/**` hangs off it but is
 * separately constructible, so a test or a tool can build a MaterialLib or a
 * ResolutionGovernor without a GL context.
 *
 * ── COLOUR PIPELINE ────────────────────────────────────────────────────────
 *   working space  linear-sRGB (three's default; do not change it)
 *   output         SRGBColorSpace
 *   tone mapping   ACES filmic, exposure from `ILightingState.exposure`
 *
 * On the LOW tier three compiles the tone map into every material and the frame
 * goes straight to the default framebuffer. On MID/HIGH the composer's output
 * pass does it instead — see `OutputLutPass`, which reimplements the identical
 * ACES fit so the two paths match rather than merely resemble each other.
 *
 * ── ANTIALIASING IS TIER-CONTROLLED ────────────────────────────────────────
 * The context is created with `antialias: false` by default. Default-framebuffer
 * MSAA can ONLY be requested at context creation, so it is fixed for the life of
 * the renderer and a runtime tier change cannot turn it on. Only the LOW tier
 * wants it (it has no composer to antialias in), so a renderer intended to run
 * low is constructed from `RENDER_TIER_PROFILES.low`, whose `contextAntialias`
 * is true. MID/HIGH antialias inside the chain (composer MSAA / FXAA / SMAA).
 *
 * ── WHAT THIS CLASS DELIBERATELY DOES NOT DO ───────────────────────────────
 * No scene graph, no camera rig, no game loop. `IRenderer.render(scene, camera)`
 * takes both as arguments precisely so the renderer stays agnostic; the loop and
 * the camera belong to systems that can be rewritten without touching this file.
 */

import * as THREE from 'three';
import type {
  ILightingState,
  IQualitySettings,
  IQualityTier,
  IRenderer,
  IRendererCapabilities,
  RenderStats,
} from '@/types';
import { createLogger } from '@/util';
import { renderProfileFor, type RenderTierProfile } from './quality';
import { ResolutionGovernor } from './resolution-governor';
import { MutableLightingState } from './lighting-state';
import { estimateSceneMemory, type ISceneMemoryReport } from './gpu-memory';
import type { PostProcessing } from './post/post-processing';

const log = createLogger('engine.renderer');

export interface IRendererOptions {
  readonly canvas: HTMLCanvasElement;
  /** Starting render tier. Ignored when `profile` is supplied. */
  readonly tier?: IQualityTier;
  /** Full renderer-private profile. Overrides `tier`. */
  readonly profile?: RenderTierProfile;
  /** Lighting source for exposure and fog. A neutral default is used otherwise. */
  readonly lighting?: ILightingState;
  /**
   * Default-framebuffer MSAA. Fixed at context creation. Defaults to the
   * profile's `contextAntialias`, which is true only for the LOW tier.
   */
  readonly antialias?: boolean;
  /**
   * Keep the drawing buffer readable after `render()`. Costs a full-frame copy
   * on some drivers — enable ONLY for screenshot tooling and verification.
   */
  readonly preserveDrawingBuffer?: boolean;
  readonly powerPreference?: WebGLPowerPreference;
  /** Physical DPR to clamp against. Defaults to `window.devicePixelRatio`. */
  readonly devicePixelRatio?: number;
  /** Turn the adaptive-resolution governor off. On by default. */
  readonly adaptiveResolution?: boolean;
  /** Initial logical size. Defaults to the canvas client size. */
  readonly width?: number;
  readonly height?: number;
}

/** Everything the debug HUD and the verification harness want in one object. */
export interface IRendererDiagnostics {
  readonly stats: RenderStats;
  readonly capabilities: IRendererCapabilities;
  readonly tier: IQualityTier;
  readonly resolutionScale: number;
  readonly medianFrameMs: number;
  readonly drawingBufferWidth: number;
  readonly drawingBufferHeight: number;
  readonly pixelRatio: number;
  readonly memory: ISceneMemoryReport | null;
}

export class Renderer implements IRenderer {
  readonly raw: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  /** Adaptive resolution. Public so the settings UI can disable it. */
  readonly governor: ResolutionGovernor;

  private profileValue: RenderTierProfile;
  private lightingState: ILightingState;
  private post: PostProcessing | undefined;

  private cssWidth: number;
  private cssHeight: number;
  private basePixelRatio: number;
  private capabilitiesCache: IRendererCapabilities | undefined;

  private lastFrameStartMs = 0;
  private frameTimeMs = 0;
  private smoothedFps = 0;
  private cpuTimeMs = 0;
  private frameIndex = 0;
  private contextLost = false;
  private disposed = false;

  private readonly stats: RenderStats = {
    drawCalls: 0,
    triangles: 0,
    points: 0,
    lines: 0,
    geometries: 0,
    textures: 0,
    programs: 0,
    frameTimeMs: 0,
    cpuTimeMs: 0,
    fps: 0,
  };

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
    log.error('WebGL context lost — rendering suspended until restore');
  };

  private readonly onContextRestored = (): void => {
    this.contextLost = false;
    log.warn('WebGL context restored; GPU resources are being re-uploaded');
    this.applyPipelineSettings();
    this.applyResolution();
  };

  constructor(options: IRendererOptions) {
    this.canvas = options.canvas;
    this.profileValue = options.profile ?? renderProfileFor(options.tier ?? 'medium');
    this.lightingState = options.lighting ?? new MutableLightingState();

    const antialias = options.antialias ?? this.profileValue.contextAntialias;

    this.raw = new THREE.WebGLRenderer({
      canvas: this.canvas,
      // AA is TIER-CONTROLLED. See the class header: this flag cannot be
      // changed after the context exists, and only the composer-less LOW tier
      // has any use for it.
      antialias,
      alpha: false,
      // Stencil costs bandwidth in the depth attachment and nothing here uses
      // it; depth is required for everything.
      stencil: false,
      depth: true,
      powerPreference: options.powerPreference ?? 'high-performance',
      preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
      failIfMajorPerformanceCaveat: false,
    });

    this.basePixelRatio = options.devicePixelRatio ?? globalThis.devicePixelRatio ?? 1;
    this.cssWidth = Math.max(1, options.width ?? (this.canvas.clientWidth || 1));
    this.cssHeight = Math.max(1, options.height ?? (this.canvas.clientHeight || 1));

    this.governor = new ResolutionGovernor({
      targetFps: this.profileValue.settings.targetFps,
      minScale: this.profileValue.minResolutionScale,
      maxScale: 1,
      onScaleChanged: (scale, medianMs) => {
        log.debug(
          `resolution scale -> ${scale.toFixed(2)} (median ${medianMs.toFixed(1)}ms, ` +
            `budget ${this.governor.budget.toFixed(1)}ms)`
        );
        this.applyResolution();
      },
    });
    this.governor.enabled = options.adaptiveResolution ?? true;

    this.applyPipelineSettings();
    this.applyResolution();

    this.canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);

    const capabilities = this.getCapabilities();
    log.info(
      `${capabilities.renderer} | WebGL2 ${capabilities.isWebGL2} | ` +
        `maxTexture ${capabilities.maxTextureSize} | aniso ${capabilities.maxAnisotropy} | ` +
        `codecs ${capabilities.compressedFormats.join(',') || 'none'}`
    );
    log.info(
      `tier ${this.profileValue.tier} | contextAA ${antialias} | ` +
        `post ${this.profileValue.post.mode} | ibl ${this.profileValue.ibl}`
    );
  }

  /* ---------------------------------------------------------------------- */
  /* IRenderer                                                              */
  /* ---------------------------------------------------------------------- */

  /** Drawing-buffer width in PHYSICAL pixels, after DPR clamp and scaling. */
  get width(): number {
    return this.raw.domElement.width;
  }

  /** Drawing-buffer height in PHYSICAL pixels. */
  get height(): number {
    return this.raw.domElement.height;
  }

  /** Effective device pixel ratio, including the adaptive resolution scale. */
  get pixelRatio(): number {
    return this.raw.getPixelRatio();
  }

  /**
   * Draw one frame.
   *
   * Frame time is measured start-to-start rather than around the draw call,
   * because WebGL is asynchronous: the time spent inside `renderer.render()` is
   * mostly command submission, and the GPU work it triggers lands after the
   * call returns. Start-to-start is the interval that actually reflects whether
   * the frame budget is being met, which is what the governor needs.
   */
  render(scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.disposed) return;

    const now = performance.now();
    if (this.lastFrameStartMs > 0) {
      this.frameTimeMs = now - this.lastFrameStartMs;
      this.governor.sample(this.frameTimeMs);
      // Exponential smoothing: an instantaneous 1/dt reading is unreadable.
      const instant = 1000 / Math.max(0.001, this.frameTimeMs);
      this.smoothedFps = this.smoothedFps === 0 ? instant : this.smoothedFps * 0.9 + instant * 0.1;
    }
    this.lastFrameStartMs = now;

    if (this.contextLost) return;

    this.raw.toneMappingExposure = this.lightingState.exposure;

    const cpuStart = performance.now();
    this.raw.info.reset();

    if (this.post && this.post.enabled) {
      if (camera instanceof THREE.PerspectiveCamera) {
        this.post.setSceneAndCamera(scene, camera);
      }
      this.post.setExposure(this.lightingState.exposure);
      this.post.render(this.frameTimeMs / 1000);
    } else {
      this.raw.setRenderTarget(null);
      this.raw.render(scene, camera);
    }

    this.cpuTimeMs = performance.now() - cpuStart;
    this.frameIndex++;
    this.collectStats();
  }

  /**
   * Resize the drawing buffer.
   *
   * @param width  LOGICAL width in CSS pixels.
   * @param height LOGICAL height in CSS pixels.
   */
  setSize(width: number, height: number): void {
    this.cssWidth = Math.max(1, Math.round(width));
    this.cssHeight = Math.max(1, Math.round(height));
    // A resize invalidates the frame-time window: the first frames at the new
    // size are dominated by reallocation, and letting the governor see them
    // makes it scale down for a cost that was never going to repeat.
    this.governor.reset(this.governor.scale);
    this.applyResolution();
  }

  /**
   * Clamp and apply a device pixel ratio.
   *
   * The clamp is not politeness — a modern phone reports DPR 3 or 4, and
   * rendering a fragment-bound scene at 3x native resolution is the fastest
   * possible way to halve the frame rate for detail nobody can resolve.
   */
  setPixelRatio(ratio: number): void {
    this.basePixelRatio = Math.max(0.5, ratio);
    this.applyResolution();
  }

  /** Statistics for the frame just rendered. */
  getStats(): RenderStats {
    return this.stats;
  }

  /** Static GPU capability report. Probed once, then cached. */
  getCapabilities(): IRendererCapabilities {
    if (this.capabilitiesCache) return this.capabilitiesCache;

    const gl = this.raw.getContext();
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const extensions = gl.getSupportedExtensions() ?? [];

    const compressedProbes: readonly [string, string][] = [
      ['WEBGL_compressed_texture_astc', 'astc'],
      ['WEBGL_compressed_texture_etc', 'etc2'],
      ['WEBGL_compressed_texture_etc1', 'etc1'],
      ['WEBGL_compressed_texture_s3tc', 's3tc'],
      ['WEBGL_compressed_texture_s3tc_srgb', 's3tc_srgb'],
      ['WEBGL_compressed_texture_pvrtc', 'pvrtc'],
      ['EXT_texture_compression_bptc', 'bc7'],
      ['EXT_texture_compression_rgtc', 'rgtc'],
    ];
    const compressedFormats: string[] = [];
    for (const [extension, codec] of compressedProbes) {
      if (gl.getExtension(extension)) compressedFormats.push(codec);
    }

    this.capabilitiesCache = {
      renderer: debugInfo
        ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))
        : 'unknown',
      vendor: debugInfo ? String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)) : 'unknown',
      isWebGL2:
        this.raw.capabilities.isWebGL2 ??
        (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext),
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      maxTextureUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number,
      maxAnisotropy: this.raw.capabilities.getMaxAnisotropy(),
      compressedFormats,
      floatTextures:
        gl.getExtension('EXT_color_buffer_float') !== null ||
        gl.getExtension('EXT_color_buffer_half_float') !== null,
      extensions,
    };
    return this.capabilitiesCache;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.post?.dispose();
    this.post = undefined;
    this.raw.dispose();
    // Actively drop the GL context: on Android a page holding several dead
    // contexts hits the browser's limit and the next one silently fails.
    this.raw.forceContextLoss();
  }

  /* ---------------------------------------------------------------------- */
  /* Renderer-private surface                                               */
  /* ---------------------------------------------------------------------- */

  get profile(): RenderTierProfile {
    return this.profileValue;
  }

  get tier(): IQualityTier {
    return this.profileValue.tier;
  }

  /** The public `IQualitySettings` contract for the current tier. */
  get qualitySettings(): IQualitySettings {
    return this.profileValue.settings;
  }

  /** Frames rendered since construction. */
  get frameCount(): number {
    return this.frameIndex;
  }

  /**
   * Switch render tier at runtime.
   *
   * Everything except context MSAA can change live. The post chain rebuilds,
   * the pixel-ratio ceiling moves and the governor re-targets. Callers own
   * re-configuring the shadow system and IBL from the new profile — the
   * renderer does not hold references to them by design.
   */
  setQualityTier(tier: IQualityTier): RenderTierProfile {
    if (tier === this.profileValue.tier) return this.profileValue;
    this.profileValue = renderProfileFor(tier);
    this.applyPipelineSettings();
    this.governor.setTargetFps(this.profileValue.settings.targetFps);
    this.governor.setScaleRange(this.profileValue.minResolutionScale, 1);
    this.governor.reset(1);
    this.applyResolution();
    this.post?.applyProfile(this.profileValue.post);
    this.post?.setSize(this.width, this.height);
    log.info(`quality tier -> ${tier}`);
    return this.profileValue;
  }

  /** Attach the post chain. Pass undefined to render direct-to-framebuffer. */
  setPostProcessing(post: PostProcessing | undefined): void {
    this.post = post;
    this.post?.setSize(this.width, this.height);
    this.post?.setExposure(this.lightingState.exposure);
  }

  get postProcessing(): PostProcessing | undefined {
    return this.post;
  }

  /**
   * Point the renderer at a lighting state. The day/night system publishes one;
   * until it exists a neutral default is used. Read every frame, never copied.
   */
  setLightingState(state: ILightingState): void {
    this.lightingState = state;
    this.raw.toneMappingExposure = state.exposure;
    this.post?.setExposure(state.exposure);
  }

  get lighting(): ILightingState {
    return this.lightingState;
  }

  /** Aggregate diagnostics. Used by the debug HUD and the harness. */
  getDiagnostics(scene?: THREE.Scene): IRendererDiagnostics {
    return {
      stats: this.getStats(),
      capabilities: this.getCapabilities(),
      tier: this.profileValue.tier,
      resolutionScale: this.governor.scale,
      medianFrameMs: this.governor.medianFrameMs,
      drawingBufferWidth: this.width,
      drawingBufferHeight: this.height,
      pixelRatio: this.pixelRatio,
      memory: scene ? estimateSceneMemory(scene) : null,
    };
  }

  /**
   * Distinct shader programs currently alive in the GL context.
   *
   * THE number to watch. `renderer.info.programs` is the live program cache;
   * a program is released only when every material using it is disposed.
   */
  get programCount(): number {
    return this.raw.info.programs?.length ?? 0;
  }

  /** Cache keys of the live programs. Invaluable when the budget is blown. */
  getProgramCacheKeys(): string[] {
    const programs = this.raw.info.programs ?? [];
    return programs.map((program) => program.cacheKey);
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  private applyPipelineSettings(): void {
    const profile = this.profileValue;
    this.raw.outputColorSpace = THREE.SRGBColorSpace;
    this.raw.toneMapping = THREE.ACESFilmicToneMapping;
    this.raw.toneMappingExposure = this.lightingState.exposure;
    this.raw.shadowMap.enabled = profile.shadows.enabled;
    // Guard against a profile asking for the deprecated soft type. three r185
    // rewrites it to PCFShadowMap inside the first shadow render, which happens
    // AFTER materials have compiled against the requested type — so every
    // material compiles twice and the shader warmup is wasted. Coercing here
    // makes the change happen before anything is compiled.
    if (profile.shadows.type === THREE.PCFSoftShadowMap) {
      log.warn(
        'PCFSoftShadowMap is deprecated in three r185 and would silently ' +
          'downgrade mid-frame, doubling the shader program count. Using ' +
          'PCFShadowMap instead.'
      );
      this.raw.shadowMap.type = THREE.PCFShadowMap;
    } else {
      this.raw.shadowMap.type = profile.shadows.type;
    }
    // Shadow maps re-render every frame by default. Systems that know their
    // shadow casters are static flip `autoUpdate` off and drive
    // `needsUpdate` themselves; the renderer keeps the safe default.
    this.raw.shadowMap.autoUpdate = profile.shadows.enabled;
    this.raw.autoClear = true;
    this.raw.setClearColor(0x000000, 1);
    // `renderer.render()` resets `info` on every call, and a composed frame
    // calls it many times (RenderPass, the SSAO prepass, one per full-screen
    // quad). Left on, `getStats()` would report only the LAST full-screen
    // triangle — two draw calls and two triangles, forever. Manual reset in
    // `render()` makes the numbers whole-frame totals instead.
    this.raw.info.autoReset = false;
  }

  /**
   * Push the current CSS size, DPR clamp and governor scale into the context.
   *
   * `setSize(..., false)` keeps the CSS size alone: the canvas is laid out by
   * the page and only the DRAWING BUFFER changes, which is what makes
   * resolution scaling invisible to layout.
   */
  private applyResolution(): void {
    const maxRatio = this.profileValue.settings.maxPixelRatio;
    const effective = Math.min(this.basePixelRatio, maxRatio) * this.governor.scale;
    this.raw.setPixelRatio(effective);
    this.raw.setSize(this.cssWidth, this.cssHeight, false);
    this.post?.setSize(this.width, this.height);
  }

  private collectStats(): void {
    const info = this.raw.info;
    const stats = this.stats as {
      -readonly [K in keyof RenderStats]: RenderStats[K];
    };
    stats.drawCalls = info.render.calls;
    stats.triangles = info.render.triangles;
    stats.points = info.render.points;
    stats.lines = info.render.lines;
    stats.geometries = info.memory.geometries;
    stats.textures = info.memory.textures;
    stats.programs = info.programs?.length ?? 0;
    stats.frameTimeMs = this.frameTimeMs;
    stats.cpuTimeMs = this.cpuTimeMs;
    stats.fps = Math.round(this.smoothedFps);
  }
}
