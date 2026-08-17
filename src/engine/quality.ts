/**
 * RENDER QUALITY TIERS
 *
 * `IQualitySettings` (engine.ts) is the CONTRACT other systems read — streaming
 * radius, character budgets, target fps. It deliberately says nothing about
 * cascade counts or bloom thresholds, because nothing outside the renderer
 * should care about those.
 *
 * `RenderTierProfile` below is the renderer's PRIVATE extension: it wraps the
 * contract object and adds the GPU-side knobs (cascades, post chain, IBL path,
 * context MSAA). Systems keep reading `IQualitySettings`; only `src/engine/**`
 * touches the profile.
 *
 * ── THE THREE QUALITY AXES ────────────────────────────────────────────────
 * This file deals with `IQualityTier` ('low'|'medium'|'high') — the RENDER
 * axis. `DeviceTier` (hardware) only *suggests* a starting point via
 * `renderTierForDevice()`; `QualityTier` (asset variant) is never touched here.
 */

import * as THREE from 'three';
import type { DeviceTier, IQualitySettings, IQualityTier } from '@/types';

/* -------------------------------------------------------------------------- */
/* Profile shapes                                                             */
/* -------------------------------------------------------------------------- */

/** Cascaded-shadow-map configuration for one render tier. */
export interface ShadowTierProfile {
  readonly enabled: boolean;
  /** Number of CSM cascades. Each cascade is one extra directional light. */
  readonly cascades: number;
  /** Edge size of every cascade's shadow map, in texels. */
  readonly mapSize: number;
  /** Distance in metres the cascade chain covers. Beyond this: blob decals. */
  readonly maxDistance: number;
  readonly type: THREE.ShadowMapType;
  /** Depth bias applied to every cascade. */
  readonly bias: number;
  /** Fade between cascades. Costs a little ALU, hides the cascade seam. */
  readonly fade: boolean;
  /** Max instanced blob-shadow decals drawn beyond `maxDistance`. */
  readonly blobShadowCapacity: number;
}

/** Post-processing chain shape for one render tier. */
export interface PostTierProfile {
  /**
   * 'off'  — NO EffectComposer at all. The scene renders straight to the
   *          default framebuffer, tone mapped in-material, with the context's
   *          own MSAA. Saves two full-screen copies per frame, which is the
   *          single biggest post-processing win on a low-end Android GPU.
   * 'mid'  — RenderPass -> quarter-res bloom -> LUT/output.
   * 'high' — adds half-res SSAO, AA, and the combined anime composite pass.
   */
  readonly mode: 'off' | 'mid' | 'high';
  readonly bloom: boolean;
  /** Render scale of the bloom chain. 0.25 = quarter res. */
  readonly bloomScale: number;
  readonly bloomThreshold: number;
  readonly bloomStrength: number;
  readonly bloomRadius: number;
  /** Apply the baked 32³ colour-grading LUT in the output pass. */
  readonly lut: boolean;
  readonly ssao: boolean;
  /** Render scale of the SSAO buffer. 0.5 = half res. */
  readonly ssaoScale: number;
  readonly ssaoSamples: number;
  readonly ssaoRadius: number;
  readonly ssaoIntensity: number;
  readonly antialias: 'none' | 'fxaa' | 'smaa';
  readonly motionBlur: boolean;
  readonly chromaticAberration: boolean;
  readonly speedLines: boolean;
  readonly vignette: boolean;
  /** MSAA samples on the composer's HDR target. 0 disables. */
  readonly msaaSamples: number;
}

/**
 * Everything the renderer needs to configure itself for a tier.
 * `settings` is the public contract; the rest is renderer-private.
 */
export interface RenderTierProfile {
  readonly tier: IQualityTier;
  readonly settings: IQualitySettings;
  /**
   * MSAA on the DEFAULT framebuffer. Can only be chosen when the WebGL context
   * is created, so it is fixed for the life of the renderer — a runtime tier
   * change cannot turn it on. Only the 'off' post mode benefits from it.
   */
  readonly contextAntialias: boolean;
  /**
   * 'pmrem' — full pre-filtered radiance environment map: correct specular
   *           IBL, ~8-12MB of VRAM and a noticeable one-off cost at load.
   * 'sh9'   — 9-coefficient spherical-harmonic irradiance only, projected on
   *           the CPU. Diffuse ambient is nearly identical, specular falls
   *           back to a cheap analytic term. Saves the VRAM and the load cost.
   */
  readonly ibl: 'pmrem' | 'sh9';
  /** PMREM source cube size. Ignored on the 'sh9' path. */
  readonly envMapResolution: number;
  readonly shadows: ShadowTierProfile;
  readonly post: PostTierProfile;
  /** Lower bound the resolution governor may scale the drawing buffer to. */
  readonly minResolutionScale: number;
}

/* -------------------------------------------------------------------------- */
/* Contract-side settings                                                     */
/* -------------------------------------------------------------------------- */

const LOW_SETTINGS: IQualitySettings = {
  tier: 'low',
  maxPixelRatio: 1,
  shadowMapSize: 1024,
  shadowsEnabled: true,
  drawDistance: 350,
  streamingRadius: 120,
  maxVisibleCharacters: 12,
  maxParticleSystems: 4,
  maxRigidBodies: 48,
  postProcessingEnabled: false,
  anisotropy: 2,
  targetFps: 30,
  textureCodec: 'etc1s',
};

const MEDIUM_SETTINGS: IQualitySettings = {
  tier: 'medium',
  maxPixelRatio: 1.5,
  shadowMapSize: 1024,
  shadowsEnabled: true,
  drawDistance: 600,
  streamingRadius: 200,
  maxVisibleCharacters: 24,
  maxParticleSystems: 8,
  maxRigidBodies: 96,
  postProcessingEnabled: true,
  anisotropy: 4,
  targetFps: 60,
  textureCodec: 'astc',
};

const HIGH_SETTINGS: IQualitySettings = {
  tier: 'high',
  maxPixelRatio: 2,
  shadowMapSize: 2048,
  shadowsEnabled: true,
  drawDistance: 1200,
  streamingRadius: 320,
  maxVisibleCharacters: 48,
  maxParticleSystems: 16,
  maxRigidBodies: 256,
  postProcessingEnabled: true,
  anisotropy: 16,
  targetFps: 60,
  textureCodec: 'bc7',
};

/* -------------------------------------------------------------------------- */
/* Profiles                                                                   */
/* -------------------------------------------------------------------------- */

const LOW_PROFILE: RenderTierProfile = {
  tier: 'low',
  settings: LOW_SETTINGS,
  // The ONLY tier that turns context MSAA on: it renders straight to the
  // default framebuffer, so hardware MSAA is the only AA available and it is
  // free-ish on the tiled mobile GPUs this tier targets.
  contextAntialias: true,
  ibl: 'sh9',
  envMapResolution: 64,
  shadows: {
    enabled: true,
    cascades: 1,
    mapSize: 1024,
    maxDistance: 45,
    type: THREE.PCFShadowMap,
    bias: -0.0006,
    fade: false,
    blobShadowCapacity: 96,
  },
  post: {
    mode: 'off',
    bloom: false,
    bloomScale: 0.25,
    bloomThreshold: 1.0,
    bloomStrength: 0.35,
    bloomRadius: 0.4,
    lut: false,
    ssao: false,
    ssaoScale: 0.5,
    ssaoSamples: 8,
    ssaoRadius: 0.6,
    ssaoIntensity: 0.8,
    antialias: 'none',
    motionBlur: false,
    chromaticAberration: false,
    speedLines: false,
    vignette: false,
    msaaSamples: 0,
  },
  minResolutionScale: 0.6,
};

const MEDIUM_PROFILE: RenderTierProfile = {
  tier: 'medium',
  settings: MEDIUM_SETTINGS,
  contextAntialias: false,
  ibl: 'pmrem',
  envMapResolution: 128,
  shadows: {
    enabled: true,
    cascades: 2,
    mapSize: 1024,
    maxDistance: 90,
    type: THREE.PCFShadowMap,
    bias: -0.0005,
    fade: true,
    blobShadowCapacity: 192,
  },
  post: {
    mode: 'mid',
    bloom: true,
    bloomScale: 0.25,
    bloomThreshold: 1.0,
    bloomStrength: 0.35,
    bloomRadius: 0.45,
    lut: true,
    ssao: false,
    ssaoScale: 0.5,
    ssaoSamples: 8,
    ssaoRadius: 0.6,
    ssaoIntensity: 0.8,
    antialias: 'none',
    motionBlur: false,
    chromaticAberration: false,
    speedLines: false,
    vignette: true,
    msaaSamples: 0,
  },
  minResolutionScale: 0.6,
};

const HIGH_PROFILE: RenderTierProfile = {
  tier: 'high',
  settings: HIGH_SETTINGS,
  contextAntialias: false,
  ibl: 'pmrem',
  envMapResolution: 256,
  shadows: {
    enabled: true,
    cascades: 3,
    mapSize: 2048,
    maxDistance: 200,
    // NOT PCFSoftShadowMap. It is deprecated in three r185: `WebGLShadowMap`
    // warns and silently rewrites it to PCFShadowMap on the FIRST shadow
    // render — after materials have already compiled against type 2. Every one
    // of them then recompiles against type 1, doubling the material program
    // count and burning the warmup's whole purpose. Measured: 38 live programs
    // with PCFSoft against 31 with PCF, for identical output.
    type: THREE.PCFShadowMap,
    bias: -0.0004,
    fade: true,
    blobShadowCapacity: 256,
  },
  post: {
    mode: 'high',
    bloom: true,
    bloomScale: 0.25,
    bloomThreshold: 1.0,
    bloomStrength: 0.35,
    bloomRadius: 0.5,
    lut: true,
    ssao: true,
    ssaoScale: 0.5,
    ssaoSamples: 8,
    ssaoRadius: 0.8,
    ssaoIntensity: 0.9,
    // FXAA, not SMAA, by default: SMAA is three separate full-screen programs
    // (edges / weights / blend) against FXAA's one, and the shader-program
    // budget is the scarce resource here. `setAntialias('smaa')` opts in.
    antialias: 'fxaa',
    motionBlur: true,
    chromaticAberration: true,
    speedLines: true,
    vignette: true,
    msaaSamples: 0,
  },
  minResolutionScale: 0.6,
};

/** Every render tier profile, keyed by `IQualityTier`. */
export const RENDER_TIER_PROFILES: Readonly<Record<IQualityTier, RenderTierProfile>> = {
  low: LOW_PROFILE,
  medium: MEDIUM_PROFILE,
  high: HIGH_PROFILE,
};

/** The `IQualitySettings` contract object for a tier. */
export function qualitySettingsFor(tier: IQualityTier): IQualitySettings {
  return RENDER_TIER_PROFILES[tier].settings;
}

/** The renderer-private profile for a tier. */
export function renderProfileFor(tier: IQualityTier): RenderTierProfile {
  return RENDER_TIER_PROFILES[tier];
}

/**
 * Suggest a starting render tier from detected hardware.
 *
 * This is a SUGGESTION only — the settings UI may override render quality
 * without changing the asset variant already on disk. Never assume a 1:1 map
 * between `DeviceTier` and `IQualityTier`.
 */
export function renderTierForDevice(device: DeviceTier): IQualityTier {
  switch (device) {
    case 'desktop':
    case 'high':
      return 'high';
    case 'mid':
      return 'medium';
    case 'low':
      return 'low';
  }
}

/** Is `a` a strictly cheaper tier than `b`? Used by the adaptive governor. */
export function isCheaperTier(a: IQualityTier, b: IQualityTier): boolean {
  const order: Record<IQualityTier, number> = { low: 0, medium: 1, high: 2 };
  return order[a] < order[b];
}
