/**
 * ASSET RUNTIME BARREL
 *
 *   import { HttpAssetProvider, AssetRegistry } from '@/assets';
 *
 * The shared loader every other system reaches assets through. Wiring, in the
 * order the bootstrap does it:
 *
 *   1. `new HttpAssetProvider({ baseUrl })` — knows about URLs and bytes.
 *   2. `AssetRegistry.open({ provider, renderer })` — loads the manifest,
 *      picks the tier, builds the KTX2/GLTF/PMREM loaders.
 *   3. `registry.preloadCore(onProgress)` — the boot screen.
 *   4. Everything else calls `registry.load(id)` and the synchronous getters.
 *
 * Consumers should type against `IAssetRegistry` from `@/types`, not against
 * `AssetRegistry`, so the registry can be swapped for a test double.
 *
 * ── THE FOUR THINGS THIS MODULE EXISTS TO GET RIGHT ────────────────────────
 *  - Tier selection that survives a manifest promising files the package does
 *    not contain (tier.ts). The Android APK is exactly that case.
 *  - The pipeline's channel and orientation conventions, applied once
 *    (ktx2.ts, materials.ts): ORM into three slots with `aoMap.channel = 0`,
 *    plain-RGB normals, no re-flip, environment maps re-filtered.
 *  - Reference-counted textures under an LRU budget (memory.ts, textures.ts).
 *  - Missing assets that degrade to a MARKED fallback and a recorded warning
 *    (fallback.ts), never to a crash and never to something that looks shipped.
 */

export {
  TIER_ORDER,
  TIER_RANK,
  DEFAULT_ASSET_ROOT,
  RUNTIME_MANIFEST_FILE,
  CHARACTER_INDEX_FILE,
  BASIS_TRANSCODER_DIR,
  TEXTURE_MEMORY_BUDGET_BYTES,
  EVICTION_TARGET_FRACTION,
  DEFAULT_CONCURRENCY,
  PRIORITY,
  FALLBACK_TEXTURE_SIZE,
  FALLBACK_CHECKER_CELL,
  type PriorityName,
} from './constants';

export {
  parseRuntimeManifest,
  emptyRuntimeManifest,
  indexById,
  outputBytes,
  materialTextureKeys,
  type IRuntimeManifest,
  type IEnvironmentRecord,
  type IPipelineRecord,
} from './manifest';

export {
  detectPlatform,
  detectTierSignals,
  isCapacitorNative,
  selectQualityTier,
  clampTier,
  TierAvailability,
  type ITierSignals,
  type ITierDecision,
  type ITierSelectionOptions,
  type ITierMiss,
} from './tier';

export {
  CharacterIndex,
  parseCharacterIndex,
  indexCharacterFiles,
  parseTierToken,
  parseRoleToken,
  type ICharacterRecord,
  type ICharacterFile,
  type CharacterTextureRole,
} from './characters';

export {
  createKTX2Loader,
  describeTranscodeSupport,
  parseKTX2,
  gpuFormatName,
  isCompressedTexture,
  codecOf,
  prepareTexture,
  prepareEnvironmentTexture,
  type ITranscodeSupport,
} from './ktx2';

export {
  estimateGpuBytes,
  TextureMemory,
  type IEvictable,
  type IEvictionReport,
} from './memory';

export {
  ManagedTextureHandle,
  bindPackedOrm,
  withRepeat,
  type IManagedTextureHandle,
  type ITextureHandleInit,
} from './textures';

export {
  buildMaterial,
  requiredTextures,
  type IBuiltMaterial,
  type TextureResolver,
} from './materials';

export {
  createModelLoader,
  extractLodGroups,
  parseModel,
  parseCharacter,
  disposeSceneGraph,
  type ILoadedModel,
  type IModelLodGroup,
  type IModelLodLevel,
  type IModelLoaderOptions,
} from './models';

export {
  EnvironmentLoader,
  normalisationScale,
  sphericalHarmonicsFromArray,
  type ILoadedEnvironment,
  type IEnvironmentLoaderOptions,
  type EnvironmentMode,
} from './environment';

export { LoadScheduler, ProgressTracker, priorityValue } from './queue';

export {
  missingTexture,
  missingMaterial,
  missingModel,
  missingEnvironment,
  isMissingAsset,
  disposeFallbacks,
  MISSING_ASSET_FLAG,
} from './fallback';

export {
  HttpAssetProvider,
  type IHttpAssetProviderOptions,
  type IFetchResult,
} from './provider';

export {
  AssetRegistry,
  type IAssetRegistryOptions,
  type IAssetFailure,
  type IRegistryDiagnostics,
} from './registry';
