/**
 * RENDER CONTRACT
 *
 * Canonical home for the renderer abstraction, GPU statistics, material
 * descriptions and the lighting state.
 *
 * TYPE-ONLY file. No runtime exports.
 *
 * NOTE: `IRenderer`, `RenderStats` and `IRendererCapabilities` live HERE, not
 * in engine.ts. engine.ts imports them. Do not redeclare them elsewhere.
 */

import type * as THREE from 'three';

/* -------------------------------------------------------------------------- */
/* Renderer                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Thin abstraction over THREE.WebGLRenderer. Systems should prefer this to the
 * raw renderer so adaptive resolution, post-processing and XR can be swapped
 * in without touching callers.
 */
export interface IRenderer {
  /** Escape hatch to the underlying Three.js renderer. */
  readonly raw: THREE.WebGLRenderer;
  /** The canvas being rendered into. */
  readonly canvas: HTMLCanvasElement;
  /** Drawing-buffer width in physical pixels. */
  readonly width: number;
  /** Drawing-buffer height in physical pixels. */
  readonly height: number;
  /** Effective device pixel ratio after clamping. */
  readonly pixelRatio: number;

  /** Draw one frame. Routes through post-processing when enabled. */
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  /** Resize the drawing buffer. Called on resize / orientation change. */
  setSize(width: number, height: number): void;
  /** Clamp and apply a device pixel ratio. */
  setPixelRatio(ratio: number): void;
  /** Statistics for the frame just rendered. */
  getStats(): RenderStats;
  /** Static GPU capability report. Also feeds `window.__GAME_DIAG__`. */
  getCapabilities(): IRendererCapabilities;
  /** Release all GPU resources. */
  dispose(): void;
}

/** Per-frame render statistics. Surfaced to the debug HUD and verification. */
export interface RenderStats {
  /** Draw calls issued this frame. */
  drawCalls: number;
  /** Triangles submitted this frame. */
  triangles: number;
  /** Points submitted this frame. */
  points: number;
  /** Lines submitted this frame. */
  lines: number;
  /** Live geometry allocations. */
  geometries: number;
  /** Live texture allocations. */
  textures: number;
  /** Shader programs compiled. */
  programs: number;
  /** Wall-clock milliseconds for the previous frame. */
  frameTimeMs: number;
  /** Milliseconds spent in CPU-side scene traversal, when instrumented. */
  cpuTimeMs?: number;
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
  /** Compressed-texture codecs available, derived from GL extensions. */
  readonly compressedFormats: readonly string[];
  /** Whether float / half-float render targets are available. */
  readonly floatTextures: boolean;
  /** Full list of enabled GL extensions. */
  readonly extensions: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Materials                                                                  */
/* -------------------------------------------------------------------------- */

/** Which Three.js material class to instantiate. */
export type MaterialKind = 'standard' | 'physical' | 'basic' | 'lambert' | 'toon' | 'shader';

/**
 * Declarative PBR material description. The material factory resolves texture
 * keys through `IAssetRegistry` and caches by `id`, so two specs with the same
 * `id` MUST describe the same material.
 *
 * Anime/cel look: set `kind: 'toon'` and supply `outlineWidth` for the
 * ink-outline pass used on characters.
 */
export interface MaterialSpec {
  /** Stable id; doubles as the material cache key. */
  readonly id: string;
  readonly kind: MaterialKind;
  /** Base colour as a hex integer, e.g. 0xffffff. */
  readonly color?: number;
  /** 0..1. Ignored for 'toon' and 'basic'. */
  readonly roughness?: number;
  /** 0..1. */
  readonly metalness?: number;
  /** Emissive colour as a hex integer. */
  readonly emissive?: number;
  /** Emissive multiplier. */
  readonly emissiveIntensity?: number;
  /** 0..1; requires `transparent`. */
  readonly opacity?: number;
  readonly transparent?: boolean;
  /** Alpha cutoff for foliage/fences. Cheaper than blending on mobile. */
  readonly alphaTest?: number;
  readonly side?: 'front' | 'back' | 'double';

  /** Texture keys resolved via IAssetRegistry. All optional. */
  readonly mapKey?: string;
  readonly normalMapKey?: string;
  /** Packed ORM: occlusion in R, roughness in G, metalness in B. */
  readonly ormMapKey?: string;
  readonly emissiveMapKey?: string;
  readonly alphaMapKey?: string;

  /** UV repeat, applied to every bound texture. */
  readonly uvRepeat?: readonly [number, number];
  /** Normal map strength. */
  readonly normalScale?: number;
  /** Ink outline width in world units; 'toon' only, 0 disables. */
  readonly outlineWidth?: number;
  /** Whether meshes using this material cast shadows. */
  readonly castShadow?: boolean;
  /** Whether meshes using this material receive shadows. */
  readonly receiveShadow?: boolean;
  /** Hint that this material is used by many instances — enables batching. */
  readonly instanced?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Lighting                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Current scene lighting. Published by the day/night system and consumed by
 * the renderer, skybox and post-processing.
 */
export interface ILightingState {
  /** Direction the sunlight TRAVELS (from sun towards the world), normalised. */
  readonly sunDirection: THREE.Vector3;
  /** Direct sun colour. */
  readonly sunColor: THREE.Color;
  /** Direct sun intensity; 0 at night. */
  readonly sunIntensity: number;
  /** Hemisphere/ambient sky colour. */
  readonly ambientColor: THREE.Color;
  /** Ambient intensity. */
  readonly ambientIntensity: number;
  /** Ground bounce colour for the hemisphere light. */
  readonly groundColor: THREE.Color;
  /** Fog colour, normally matched to the horizon. */
  readonly fogColor: THREE.Color;
  /** Exponential-squared fog density in 1/metres. */
  readonly fogDensity: number;
  /** Environment map intensity for IBL. */
  readonly envMapIntensity: number;
  /** ACES tone-mapping exposure. */
  readonly exposure: number;
  /** True while street lights and window emissives should be lit. */
  readonly streetLightsOn: boolean;
  /** Shadow-camera half-extent in metres, tightened at night. */
  readonly shadowRadius: number;
}

/* -------------------------------------------------------------------------- */
/* Camera                                                                     */
/* -------------------------------------------------------------------------- */

/** Camera behaviour mode. */
export type CameraMode = 'thirdPerson' | 'combatLock' | 'aerial' | 'cutscene' | 'free' | 'photo';

/** Third-person camera rig contract. */
export interface ICameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode;
  /** Point the camera orbits, normally the player's chest. */
  readonly target: THREE.Vector3;
  /** Orbit distance in metres. */
  distance: number;
  /** Yaw in radians. */
  yaw: number;
  /** Pitch in radians, clamped to avoid gimbal flip. */
  pitch: number;
  /** Vertical field of view in degrees. */
  fov: number;

  /** Add trauma in 0..1; decays automatically. Used by punch impacts. */
  addShake(trauma: number): void;
  /** Frame a combat target, or clear the lock with `undefined`. */
  setLockTarget(target: THREE.Object3D | undefined): void;
  /** Snap instantly, skipping smoothing. Use after teleports. */
  snapToTarget(): void;
}
