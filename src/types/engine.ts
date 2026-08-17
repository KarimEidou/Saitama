/**
 * ENGINE CONTRACT
 *
 * Core primitives, quality tiers, the engine context threaded through every
 * system, and the diagnostics surface used by automated verification.
 *
 * TYPE-ONLY file. No runtime exports.
 *
 * ── ARCHITECTURAL RULE (binding for all workstreams) ───────────────────────
 * Systems import ONLY from `src/types/` and `src/util/`. A system must never
 * import another system's implementation module. All cross-system
 * communication goes through the event bus (`src/types/events.ts`).
 *
 * NOTE: `IRenderer` / `RenderStats` / `IRendererCapabilities` are defined in
 * render.ts and re-used here — they are NOT redeclared in this file.
 */

import type * as THREE from 'three';
import type { IRenderer } from './render';
import type { SafeAreaInsets } from './platform';

/* -------------------------------------------------------------------------- */
/* Core primitives                                                            */
/* -------------------------------------------------------------------------- */

/** Anything holding GPU/native resources that must be explicitly released. */
export interface IDisposable {
  /** Release GPU buffers, textures, listeners. Must be idempotent. */
  dispose(): void;
}

/** Anything advanced once per frame. */
export interface IUpdatable {
  /**
   * Advance simulation.
   * @param dt Delta time in SECONDS, already scaled and clamped by the clock.
   */
  update(dt: number): void;
}

/** Optional companion for systems needing post-physics work. */
export interface ILateUpdatable {
  /** Runs after every `update(dt)`, before render. */
  lateUpdate(dt: number): void;
}

/* -------------------------------------------------------------------------- */
/* Quality                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Render quality bucket. See the three-axes note in platform.ts — this is the
 * RENDER axis, distinct from `DeviceTier` (hardware) and `QualityTier` (assets).
 */
export type IQualityTier = 'low' | 'medium' | 'high';

/**
 * Concrete render budget for a tier. Systems read this instead of branching on
 * the tier string, so budgets stay tunable in one place.
 */
export interface IQualitySettings {
  readonly tier: IQualityTier;
  /** Upper bound on `setPixelRatio()`. Typically 1.0–2.0. */
  readonly maxPixelRatio: number;
  /** Shadow atlas edge size in px. 0 disables shadows. */
  readonly shadowMapSize: number;
  readonly shadowsEnabled: boolean;
  /** Camera far plane in metres. */
  readonly drawDistance: number;
  /** Radius in metres within which chunks stay resident. */
  readonly streamingRadius: number;
  readonly maxVisibleCharacters: number;
  readonly maxParticleSystems: number;
  /** Max simultaneous rigid bodies (debris budget). */
  readonly maxRigidBodies: number;
  readonly postProcessingEnabled: boolean;
  /** Anisotropic filtering level, clamped to hardware max. */
  readonly anisotropy: number;
  /** Frame rate the adaptive-resolution governor aims for. */
  readonly targetFps: number;
  /** Preferred GPU texture codec on this device. */
  readonly textureCodec: 'astc' | 'etc1s' | 'bc7' | 'uncompressed';
}

/* -------------------------------------------------------------------------- */
/* Post-processing                                                            */
/* -------------------------------------------------------------------------- */

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

/**
 * Post-processing stack. Must no-op cleanly when
 * `IQualitySettings.postProcessingEnabled` is false.
 */
export interface IPostProcessing extends IDisposable, IUpdatable {
  enabled: boolean;
  /** Render the composed frame, replacing a direct `renderer.render()`. */
  render(dt: number): void;
  setSize(width: number, height: number): void;
  setEffectEnabled(effect: PostEffectName, enabled: boolean): void;
  /** Scalar intensity in 0..1. */
  setEffectIntensity(effect: PostEffectName, intensity: number): void;
  applyQuality(settings: IQualitySettings): void;
}

/* -------------------------------------------------------------------------- */
/* Engine context                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The root object threaded through every system. Constructed exactly once at
 * boot and passed by reference — never cloned.
 */
export interface IEngineContext {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: IRenderer;
  readonly clock: THREE.Clock;
  /** Mutable: the settings UI may change this at runtime. */
  quality: IQualityTier;
  /** Budgets matching `quality`; replaced wholesale when the tier changes. */
  qualitySettings: IQualitySettings;
  /** Undefined on low tier. */
  postProcessing?: IPostProcessing;
  /** Seconds since boot. */
  readonly elapsed: number;
  /** Delta of the frame being processed, in seconds. */
  readonly delta: number;
  /** Logical viewport size in CSS pixels. */
  readonly viewport: { width: number; height: number };
  /** Device safe-area insets in CSS pixels. */
  readonly safeArea: SafeAreaInsets;
}

/* -------------------------------------------------------------------------- */
/* Systems                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A subsystem owned by the engine loop, updated in ascending `priority`.
 * See IGameLoop in game.ts for the canonical priority bands.
 */
export interface IEngineSystem extends IUpdatable, IDisposable {
  /** Stable unique identifier, e.g. 'world.streaming'. */
  readonly id: string;
  /** Lower runs earlier. */
  readonly priority: number;
  /** Skipped by the loop when false. */
  enabled: boolean;
  /** Optional async setup, awaited during boot before the first frame. */
  init?(ctx: IEngineContext): Promise<void> | void;
}

/* -------------------------------------------------------------------------- */
/* Diagnostics — consumed by automated verification                           */
/* -------------------------------------------------------------------------- */

/**
 * Shape of `window.__GAME_DIAG__`. The verification harness reads this from
 * the page; fields must stay ADDITIVE so older checks keep passing.
 */
export interface IGameDiagnostics {
  /** GL renderer string. */
  renderer: string;
  /** GL vendor string. */
  vendor: string;
  isWebGL2: boolean;
  maxTextureSize: number;
  maxAnisotropy: number;
  /** Compressed texture codecs available on this device. */
  compressedFormats: string[];
  drawCalls: number;
  triangles: number;
  fps: number;
  /** Frames rendered since boot. */
  frameCount: number;
  quality: IQualityTier;
  /** Milliseconds from navigation start to first presented frame. */
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
    /** Live diagnostics. See IGameDiagnostics. */
    __GAME_DIAG__?: IGameDiagnostics;
  }
}
