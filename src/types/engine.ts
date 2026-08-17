/**
 * ENGINE INTERFACE CONTRACT
 *
 * Owned by: Task 06 (renderer/engine core).
 * Consumed by: every rendering, world, entity and UI workstream.
 *
 * This file is TYPE-ONLY — it must never emit runtime code. Do not add
 * `const`, `enum`, or function implementations here; concrete values belong in
 * the implementing module. Keeping it type-only means all 17 workstreams can
 * import from it without creating a load-order or merge-conflict surface.
 */

import type * as THREE from 'three';

/* -------------------------------------------------------------------------- */
/* Core primitives                                                            */
/* -------------------------------------------------------------------------- */

/** Anything holding GPU/native resources that must be explicitly released. */
export interface IDisposable {
  /** Release GPU buffers, textures, listeners. Must be idempotent. */
  dispose(): void;
}

/** Anything ticked once per frame by the main loop. */
export interface IUpdatable {
  /**
   * Advance simulation.
   * @param dt Delta time in SECONDS since the previous frame (already clamped
   *           by the engine to guard against tab-switch spikes).
   */
  update(dt: number): void;
}

/** Optional companion to IUpdatable for systems needing post-physics work. */
export interface ILateUpdatable {
  /** Runs after all `update(dt)` calls, before render. */
  lateUpdate(dt: number): void;
}

/* -------------------------------------------------------------------------- */
/* Quality tiers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Device capability bucket. Selected at boot by the engine, may be overridden
 * by the player in settings. Systems must degrade gracefully across all three.
 */
export type IQualityTier = 'low' | 'medium' | 'high';

/**
 * Concrete render budget for a given tier. The engine publishes one of these on
 * `IEngineContext.qualitySettings`; world/entity systems read it instead of
 * branching on the tier string directly, so budgets can be tuned in one place.
 */
export interface IQualitySettings {
  readonly tier: IQualityTier;
  /** Upper bound on `renderer.setPixelRatio()`. Typically 1.0–2.0. */
  readonly maxPixelRatio: number;
  /** Shadow atlas edge size in px. 0 disables shadows entirely. */
  readonly shadowMapSize: number;
  /** Whether any dynamic shadow casting is permitted. */
  readonly shadowsEnabled: boolean;
  /** Camera far plane / world streaming radius in metres. */
  readonly drawDistance: number;
  /** Radius in metres within which chunks are kept resident. */
  readonly streamingRadius: number;
  /** Max simultaneously animated skinned characters. */
  readonly maxVisibleCharacters: number;
  /** Max live particle systems. */
  readonly maxParticleSystems: number;
  /** Enable the post-processing stack at all. */
  readonly postProcessingEnabled: boolean;
  /** Anisotropic filtering level, clamped to hardware max. */
  readonly anisotropy: number;
  /** Target frame rate used for adaptive resolution decisions. */
  readonly targetFps: number;
  /** Preferred GPU texture codec for this device. */
  readonly textureCodec: 'astc' | 'etc1s' | 'bc7' | 'uncompressed';
}

/* -------------------------------------------------------------------------- */
/* Renderer                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Thin abstraction over THREE.WebGLRenderer. Systems should prefer this over
 * touching the raw renderer so the engine can swap in adaptive resolution,
 * XR, or a post-processing composer without breaking callers.
 */
export interface IRenderer extends IDisposable {
  /** Escape hatch to the underlying Three.js renderer. */
  readonly raw: THREE.WebGLRenderer;
  /** The canvas being rendered into. */
  readonly canvas: HTMLCanvasElement;
  /** Current drawing-buffer width in physical pixels. */
  readonly width: number;
  /** Current drawing-buffer height in physical pixels. */
  readonly height: number;
  /** Effective device pixel ratio after clamping. */
  readonly pixelRatio: number;

  /** Draw one frame. Routes through post-processing when enabled. */
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  /** Resize the drawing buffer. Called on orientation change / resize. */
  setSize(width: number, height: number): void;
  /** Clamp and apply a device pixel ratio. */
  setPixelRatio(ratio: number): void;
  /** Per-frame GPU statistics, reset each frame by the engine. */
  getFrameStats(): IFrameStats;
  /** Runtime GPU/driver capability report. Also feeds `window.__GAME_DIAG__`. */
  getCapabilities(): IRendererCapabilities;
}

/** Per-frame render statistics. Surfaced to the debug HUD and to Task 17. */
export interface IFrameStats {
  /** Draw calls issued this frame. */
  drawCalls: number;
  /** Triangles submitted this frame. */
  triangles: number;
  /** Live geometry allocations. */
  geometries: number;
  /** Live texture allocations. */
  textures: number;
  /** Shader programs compiled. */
  programs: number;
  /** Wall-clock milliseconds for the previous frame. */
  frameTimeMs: number;
  /** Smoothed frames per second. */
  fps: number;
}

/** Static GPU capability description, probed once at boot. */
export interface IRendererCapabilities {
  /** UNMASKED_RENDERER_WEBGL string, e.g. "ANGLE (…SwiftShader…)". */
  readonly renderer: string;
  /** UNMASKED_VENDOR_WEBGL string. */
  readonly vendor: string;
  /** True when a WebGL2 context was obtained. */
  readonly isWebGL2: boolean;
  /** GL MAX_TEXTURE_SIZE. */
  readonly maxTextureSize: number;
  /** GL MAX_TEXTURE_IMAGE_UNITS. */
  readonly maxTextureUnits: number;
  /** Hardware anisotropy ceiling (1 when unsupported). */
  readonly maxAnisotropy: number;
  /** Supported compressed-texture codecs, derived from GL extensions. */
  readonly compressedFormats: readonly string[];
  /** Whether float/half-float render targets are available. */
  readonly floatTextures: boolean;
  /** Full list of enabled GL extensions. */
  readonly extensions: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Post-processing                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Post-processing stack. Implementations must no-op cleanly when
 * `IQualitySettings.postProcessingEnabled` is false.
 */
export interface IPostProcessing extends IDisposable, IUpdatable {
  /** Whether the stack is currently active. */
  enabled: boolean;
  /** Render the composed frame. Replaces a direct `renderer.render()`. */
  render(dt: number): void;
  /** Resize all internal render targets. */
  setSize(width: number, height: number): void;
  /** Enable/disable a named effect, e.g. 'bloom', 'ssao', 'motionBlur'. */
  setEffectEnabled(effect: PostEffectName, enabled: boolean): void;
  /** Scalar intensity in 0..1 for a named effect. */
  setEffectIntensity(effect: PostEffectName, intensity: number): void;
  /** Reconfigure the whole stack for a new quality tier. */
  applyQuality(settings: IQualitySettings): void;
}

/** Named post effects. Extend here rather than using bare strings. */
export type PostEffectName =
  | 'bloom'
  | 'ssao'
  | 'motionBlur'
  | 'vignette'
  | 'chromaticAberration'
  | 'filmGrain'
  | 'colorGrading'
  | 'fxaa'
  | 'smaa'
  | 'depthOfField'
  | 'speedLines';

/* -------------------------------------------------------------------------- */
/* Engine context                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The root object threaded through every system. Construct exactly once at
 * boot (Task 06) and pass by reference — never clone it.
 */
export interface IEngineContext {
  /** Root scene graph. */
  readonly scene: THREE.Scene;
  /** Active gameplay camera. */
  readonly camera: THREE.PerspectiveCamera;
  /** Renderer abstraction. */
  readonly renderer: IRenderer;
  /** Master clock; `getDelta()` is consumed by the engine loop only. */
  readonly clock: THREE.Clock;
  /** Current tier. Mutable — settings UI may change it at runtime. */
  quality: IQualityTier;
  /** Budgets matching `quality`. Replaced wholesale when the tier changes. */
  qualitySettings: IQualitySettings;
  /** Optional post stack; undefined on low tier. */
  postProcessing?: IPostProcessing;
  /** Seconds since boot, monotonically increasing. */
  readonly elapsed: number;
  /** Delta of the frame currently being processed, in seconds. */
  readonly delta: number;
  /** Logical viewport size in CSS pixels. */
  readonly viewport: { width: number; height: number };
  /** Safe-area insets in CSS pixels (notch / home indicator). */
  readonly safeArea: ISafeAreaInsets;
}

/** Device safe-area insets, mirrored from the CSS env() values. */
export interface ISafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/* -------------------------------------------------------------------------- */
/* System registration                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A subsystem owned by the engine loop. Systems are updated in ascending
 * `priority` order; keep input low and rendering-adjacent work high.
 */
export interface IEngineSystem extends IUpdatable, IDisposable {
  /** Stable unique identifier, e.g. 'world.streaming'. */
  readonly id: string;
  /** Lower runs earlier. Suggested bands: input 0-99, sim 100-499,
   *  world/streaming 500-699, animation 700-799, camera 800-899, ui 900+. */
  readonly priority: number;
  /** Skipped by the loop when false. */
  enabled: boolean;
  /** Optional async setup, awaited during boot before the first frame. */
  init?(ctx: IEngineContext): Promise<void> | void;
}

/* -------------------------------------------------------------------------- */
/* Diagnostics — consumed by Task 17 automated verification                    */
/* -------------------------------------------------------------------------- */

/**
 * Shape of `window.__GAME_DIAG__`. The verification harness reads this from
 * the page; fields must stay additive so older checks keep passing.
 */
export interface IGameDiagnostics {
  /** GL renderer string. */
  renderer: string;
  /** GL vendor string. */
  vendor: string;
  /** True when a WebGL2 context is active. */
  isWebGL2: boolean;
  /** GL MAX_TEXTURE_SIZE. */
  maxTextureSize: number;
  /** Hardware anisotropy ceiling. */
  maxAnisotropy: number;
  /** Compressed texture codecs available on this device. */
  compressedFormats: string[];
  /** Draw calls in the most recent frame. */
  drawCalls: number;
  /** Triangles in the most recent frame. */
  triangles: number;
  /** Smoothed FPS. */
  fps: number;
  /** Frames rendered since boot. */
  frameCount: number;
  /** Selected quality tier. */
  quality: IQualityTier;
  /** Milliseconds from navigation start to first rendered frame. */
  bootTimeMs: number;
  /** Build identifier / git sha when available. */
  build?: string;
  /** Non-fatal errors collected during boot. */
  errors?: string[];
}

declare global {
  interface Window {
    /** Flipped to true once the first frame has presented. */
    __GAME_READY__?: boolean;
    /** Live diagnostics object. See IGameDiagnostics. */
    __GAME_DIAG__?: IGameDiagnostics;
  }
}
