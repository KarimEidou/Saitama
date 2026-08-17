/**
 * ENGINE / RENDERER BARREL
 *
 *   import { Renderer, MaterialLib, ShadowSystem } from '@/engine';
 *
 * Everything below is the RENDERER workstream. Other systems consume it through
 * the `IRenderer` / `IPostProcessing` contracts in `src/types/`, not through
 * these classes directly — the concrete exports exist for the bootstrap that
 * wires the engine together, and for the verification harness.
 *
 * ── WHAT THE RENDERER IS RESPONSIBLE FOR ───────────────────────────────────
 *   renderer.ts             the WebGL context, colour pipeline, stats
 *   resolution-governor.ts  adaptive drawing-buffer scaling (the mobile win)
 *   material-lib.ts         shared materials, shader injection, program budget
 *   shader-warmup.ts        compile everything during loading, never in a fight
 *   ibl.ts / sh9.ts         image-based lighting, PMREM and the cheap SH path
 *   shadows.ts              cascaded shadow maps + instanced blob decals
 *   post/                   the tier-gated post-processing chains
 *   impact-freeze.ts        hit-stop and FOV punch, driven by the event bus
 *
 * ── WHAT IT IS NOT ─────────────────────────────────────────────────────────
 * No scene graph, no camera rig, no game loop, no asset loading. Those belong
 * to other workstreams and reach the renderer through contracts and the bus.
 */

/* Core ------------------------------------------------------------------- */
export { Renderer, type IRendererOptions, type IRendererDiagnostics } from './renderer';

export {
  ResolutionGovernor,
  type IResolutionGovernorOptions,
  type IResolutionGovernorState,
} from './resolution-governor';

export { GameClock, type IGameClockOptions } from './game-clock';

/* Quality ---------------------------------------------------------------- */
export {
  RENDER_TIER_PROFILES,
  qualitySettingsFor,
  renderProfileFor,
  renderTierForDevice,
  isCheaperTier,
  type RenderTierProfile,
  type ShadowTierProfile,
  type PostTierProfile,
} from './quality';

/* Lighting --------------------------------------------------------------- */
export {
  MutableLightingState,
  createDefaultLightingState,
  createDuskLightingState,
} from './lighting-state';

export {
  EnvironmentLighting,
  type IBLMode,
  type IEnvironmentLightingOptions,
  type IEnvironmentStats,
} from './ibl';

export { projectEquirectToSH9, averageIrradiance, serializeSH9, deserializeSH9 } from './sh9';

export { createProceduralSkyTexture, type IProceduralSkyOptions } from './procedural-sky';

export { createEquirectReader, downsampleEquirect, type IEquirectReader } from './equirect';

/* Materials -------------------------------------------------------------- */
export {
  MaterialLib,
  applyInstanceVariation,
  applySpecularOnlyEnvironment,
  hasSpecularOnlyEnvironment,
  type IMaterialLibOptions,
  type IMaterialRequest,
} from './material-lib';

export {
  NO_FEATURES,
  INSTANCE_TINT_ATTRIBUTE,
  INSTANCE_WEAR_ATTRIBUTE,
  featureKey,
  hasAnyFeature,
  type IMaterialFeatures,
} from './shader-chunks';

export {
  addShaderHook,
  adoptAssignedHook,
  removeShaderHooks,
  shaderHookKeys,
  hasShaderHooks,
  type ShaderHook,
} from './shader-hooks';

export {
  createMissingTexture,
  createNoiseAlbedo,
  createNoiseNormal,
  createOrmTexture,
  createBlobShadowTexture,
  createBlackPixelTexture,
  type INoiseAlbedoOptions,
  type IOrmOptions,
} from './procedural-textures';

/* Warmup ----------------------------------------------------------------- */
export {
  ShaderWarmup,
  type IShaderWarmupOptions,
  type IWarmupEntry,
  type IWarmupReport,
  type WarmupGeometryKind,
} from './shader-warmup';

/* Shadows ---------------------------------------------------------------- */
export {
  ShadowSystem,
  submitCrowdBlobShadows,
  type IShadowSystemOptions,
  type IShadowStats,
} from './shadows';

export { BlobShadowField, type IBlobShadowOptions } from './blob-shadows';

/* Post-processing -------------------------------------------------------- */
export {
  PostProcessing,
  type IPostProcessingOptions,
  type IPostProcessingStats,
} from './post/post-processing';

export { OutputLutPass, type IOutputLutPassOptions } from './post/output-lut-pass';
export { HalfResSSAOPass, type IHalfResSSAOOptions } from './post/ssao-pass';
export { DualFilterBloomPass, type IDualFilterBloomOptions } from './post/dual-filter-bloom-pass';
export { AnimeCompositePass, type IAnimeCompositeOptions } from './post/anime-composite-pass';
export {
  bakeLutStrip,
  ANIME_GRADE,
  NEUTRAL_GRADE,
  LUT_SIZE,
  LUT_STRIP_WIDTH,
  LUT_STRIP_HEIGHT,
  LUT_STRIP_GLSL,
  type IGradeOptions,
} from './post/lut';

/* Feel ------------------------------------------------------------------- */
export { ImpactFreeze, type IImpactFreezeOptions, type IImpactFreezeState } from './impact-freeze';

/* Diagnostics ------------------------------------------------------------ */
export {
  estimateSceneMemory,
  estimateTextureBytes,
  formatBytes,
  type ISceneMemoryReport,
} from './gpu-memory';
