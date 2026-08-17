/**
 * ASSET CONTRACT
 *
 * The manifest schema every asset-pipeline workstream writes, and the runtime
 * registry every consuming workstream reads.
 *
 * TYPE-ONLY file. No runtime exports.
 *
 * ── HOW THIS FITS TOGETHER ─────────────────────────────────────────────────
 *   1. Fetch agents download sources into `assets/source/` and append an
 *      `IAssetEntry` to the manifest — including licence and sha256.
 *   2. Process agents transcode into `assets/generated/`, filling in
 *      `outputs` per QualityTier.
 *   3. Runtime consumers only ever touch `IAssetRegistry` / `IAssetProvider`,
 *      addressing assets by their stable string `id`.
 *
 * ── LICENCE COMPLIANCE IS NOT OPTIONAL ─────────────────────────────────────
 * Every entry MUST carry a real `license`, `author` and `sourceUrl`. Entries
 * whose licence requires attribution MUST also carry `attributionUrl`. The
 * credits screen is generated mechanically from these fields — an asset with
 * a missing or invented licence is a shipping blocker, so leave it out rather
 * than guessing.
 */

import type * as THREE from 'three';
import type { IAnimationSet } from './entity';
import type { MaterialSpec } from './render';
import type { IFractureData } from './destruction';

/* -------------------------------------------------------------------------- */
/* Quality tiers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Asset variant tier. See the three-axes note in platform.ts — this is the
 * ASSET axis, distinct from `DeviceTier` (hardware) and `IQualityTier`
 * (render settings).
 *
 *   'mobile' — aggressive: ETC1S/ASTC, ≤1024px, heavy mesh decimation.
 *   'high'   — UASTC, ≤2048px, moderate decimation.
 *   'ultra'  — UASTC/uncompressed, ≤4096px, full-density meshes.
 */
export type QualityTier = 'mobile' | 'high' | 'ultra';

/* -------------------------------------------------------------------------- */
/* Kinds and formats                                                          */
/* -------------------------------------------------------------------------- */

/** What sort of asset an entry describes. Discriminates the entry union. */
export type AssetKind =
  | 'model'
  | 'character'
  | 'texture'
  | 'material'
  | 'audio'
  | 'hdri'
  | 'animation'
  | 'font';

/** Container/encoding an asset is delivered in at runtime. */
export type TargetFormat =
  | 'glb'
  | 'ktx2'
  | 'webp'
  | 'png'
  | 'jpg'
  | 'hdr'
  | 'exr'
  | 'mp3'
  | 'ogg'
  | 'webm'
  | 'woff2'
  | 'json';

/** GPU texture codec. `none` means an uncompressed/browser-decoded image. */
export type TextureCodec = 'etc1s' | 'uastc' | 'astc' | 'bc7' | 'none';

/**
 * How a texture's channels are interpreted. Getting this wrong is the single
 * most common source of visual bugs, so it is REQUIRED on every texture.
 *
 *   'srgb'   — colour data (albedo, emissive). Decoded to linear on sample.
 *   'linear' — non-colour data (normal, roughness, metalness, AO, height).
 */
export type ColorSpace = 'srgb' | 'linear';

/** Semantic role of a texture within a material. */
export type TextureRole =
  | 'albedo'
  | 'normal'
  | 'roughness'
  | 'metalness'
  /** Packed occlusion/roughness/metalness (R/G/B). */
  | 'orm'
  | 'occlusion'
  | 'emissive'
  | 'height'
  | 'alpha'
  | 'environment';

/* -------------------------------------------------------------------------- */
/* Licensing                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * SPDX licence identifier. The union lists the licences actually permitted in
 * this project; the `(string & {})` arm keeps autocomplete while allowing an
 * unusual-but-valid SPDX id.
 *
 * DO NOT add a copyleft licence (GPL/AGPL) — it is incompatible with shipping
 * a closed APK. `CC-BY-SA` is likewise excluded for bundled art.
 */
export type AssetLicense =
  | 'CC0-1.0'
  | 'CC-BY-4.0'
  | 'CC-BY-3.0'
  | 'MIT'
  | 'Apache-2.0'
  | 'OFL-1.1'
  | 'Unlicense'
  | 'public-domain'
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  | (string & {});

/** Provenance and licence block. Required on every entry. */
export interface IAssetAttribution {
  /** SPDX id. */
  readonly license: AssetLicense;
  /** Author or studio, exactly as the source credits them. */
  readonly author: string;
  /** Canonical page the asset was obtained from. */
  readonly sourceUrl: string;
  /**
   * Link shown in the credits screen. REQUIRED when the licence demands
   * attribution (any CC-BY variant, OFL).
   */
  readonly attributionUrl?: string;
  /** Free-text note, e.g. "recoloured", "retopologised from original". */
  readonly modifications?: string;
  /** Year of publication, when known. */
  readonly year?: number;
}

/* -------------------------------------------------------------------------- */
/* Compression                                                                */
/* -------------------------------------------------------------------------- */

/** Texture transcoding parameters for one quality tier. */
export interface ICompressionProfile {
  readonly codec: TextureCodec;
  /** Encoder quality 0..100. ETC1S ~128 RDO levels map onto this. */
  readonly quality: number;
  /** Longest-edge clamp in px. Hardware ceiling here is 8192. */
  readonly maxDimension: number;
  readonly generateMipmaps: boolean;
  /** Channel interpretation. MUST match the texture's role. */
  readonly colorSpace: ColorSpace;
  /**
   * True for tangent-space normal maps: the encoder uses a two-channel
   * normal-optimised mode instead of RGB.
   */
  readonly isNormalMap: boolean;
  /** Apply Zstandard supercompression to the KTX2 container. */
  readonly zstd?: boolean;
  /** Zstandard level 1..22. */
  readonly zstdLevel?: number;
  /** Preserve the alpha channel. Dropping it saves substantial bandwidth. */
  readonly hasAlpha: boolean;
}

/** Mesh decimation parameters for one LOD. */
export interface IMeshCompressionProfile {
  /** Fraction of source triangles retained, 0..1. */
  readonly simplifyRatio: number;
  /** Draco geometry compression. */
  readonly draco: boolean;
  /** meshoptimizer vertex-cache/overdraw optimisation. */
  readonly meshopt: boolean;
  /** Quantisation bits for positions; 11–14 is typical. */
  readonly positionBits?: number;
  /** Quantisation bits for normals/UVs; 8–10 is typical. */
  readonly normalBits?: number;
}

/* -------------------------------------------------------------------------- */
/* LODs and outputs                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A decimated mesh variant produced by the asset pipeline.
 * (Distinct from `ILODLevel` in world.ts, which is a render DISTANCE band.)
 */
export interface IAssetLOD {
  /** 0 is highest detail. */
  readonly level: number;
  /** Path relative to the generated-assets root. */
  readonly file: string;
  /** Triangle count after decimation. */
  readonly triangles: number;
  /** File size in bytes. */
  readonly bytes: number;
  /** Distance in metres beyond which this LOD is used. */
  readonly screenDistance?: number;
}

/** A concrete built file for one quality tier. */
export interface IAssetOutput {
  readonly tier: QualityTier;
  /** Path relative to the generated-assets root. */
  readonly file: string;
  readonly format: TargetFormat;
  readonly bytes: number;
  /** sha256 of the BUILT file, for cache invalidation. */
  readonly sha256: string;
  /** Pixel dimensions, for textures. */
  readonly width?: number;
  readonly height?: number;
  readonly codec?: TextureCodec;
  /** Mesh LODs contained in or alongside this output. */
  readonly lods?: readonly IAssetLOD[];
}

/* -------------------------------------------------------------------------- */
/* Asset entries                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Base manifest entry. Every asset shares these fields.
 *
 * `id` is the stable runtime key: gameplay code says
 * `registry.getModel('building.office.a')`, never a file path. Ids are
 * dot-namespaced and MUST be globally unique.
 */
export interface IAssetEntry {
  /** Stable, globally unique, dot-namespaced key. */
  readonly id: string;
  readonly kind: AssetKind;
  /** Human-readable name for the credits screen and tooling. */
  readonly name: string;
  /** Provenance and licence. */
  readonly attribution: IAssetAttribution;
  /** Original download URL. Mirrors `attribution.sourceUrl` for convenience. */
  readonly sourceUrl: string;
  /** sha256 of the ORIGINAL downloaded file; verifies the fetch step. */
  readonly sha256: string;
  /** Path of the raw download, relative to `assets/source/`. */
  readonly sourceFile?: string;
  /** Delivery format at runtime. */
  readonly targetFormat: TargetFormat;
  /** Built outputs, one per quality tier that was produced. */
  readonly outputs: readonly IAssetOutput[];
  /** Free-form tags for querying, e.g. ['urban', 'z-city']. */
  readonly tags?: readonly string[];
  /** Load with the core bundle rather than on demand. */
  readonly preload?: boolean;
  /** Bytes of the original source file. */
  readonly sourceBytes?: number;
}

/** A static mesh: buildings, props, vehicles, debris. */
export interface IModelAsset extends IAssetEntry {
  readonly kind: 'model';
  readonly targetFormat: 'glb';
  /** Mesh decimation settings used. */
  readonly meshCompression?: IMeshCompressionProfile;
  /** Mesh LOD chain, highest detail first. */
  readonly lodLevels: readonly IAssetLOD[];
  /** Material ids this model references. */
  readonly materialKeys: readonly string[];
  /** Triangle count of the LOD0 mesh. */
  readonly triangles: number;
  /** Local-space bounding box as [minX,minY,minZ,maxX,maxY,maxZ] in metres. */
  readonly bounds?: readonly [number, number, number, number, number, number];
  /** Pre-computed fracture data when the model is destructible. */
  readonly fracture?: IFractureData;
  /** Hint that many instances exist — enables GPU instancing. */
  readonly instanced?: boolean;
}

/** A rigged, animatable character. */
export interface ICharacterAsset extends IAssetEntry {
  readonly kind: 'character';
  readonly targetFormat: 'glb';
  /**
   * Rig family. 'mixamo' guarantees the canonical `BoneName` set in
   * character.ts; anything else needs an explicit bone remap.
   */
  readonly skeleton: 'mixamo' | 'custom' | 'none';
  /** Bone remap from the source rig to canonical names, when non-Mixamo. */
  readonly boneMap?: Readonly<Record<string, string>>;
  /** Slot-to-clip mapping. */
  readonly animations: IAnimationSet;
  /** Clip names actually present in the GLB. */
  readonly clips: readonly string[];
  /** Standing height in metres, for scale normalisation. */
  readonly height: number;
  readonly materialKeys: readonly string[];
  readonly triangles: number;
  readonly lodLevels: readonly IAssetLOD[];
}

/** A single texture image. */
export interface ITextureAsset extends IAssetEntry {
  readonly kind: 'texture';
  readonly targetFormat: 'ktx2' | 'webp' | 'png' | 'jpg';
  /** Semantic role; determines the required colour space. */
  readonly role: TextureRole;
  /** Channel interpretation. */
  readonly colorSpace: ColorSpace;
  /** Compression settings per tier. */
  readonly compression: Readonly<Partial<Record<QualityTier, ICompressionProfile>>>;
  /** True when the texture tiles seamlessly. */
  readonly tileable: boolean;
  /** Source pixel dimensions. */
  readonly sourceWidth?: number;
  readonly sourceHeight?: number;
}

/** A PBR material: a named bundle of textures plus scalar parameters. */
export interface IMaterialAsset extends IAssetEntry {
  readonly kind: 'material';
  readonly targetFormat: 'json';
  /** Declarative material description consumed by the material factory. */
  readonly spec: MaterialSpec;
  /** Texture asset ids this material binds, by role. */
  readonly textureKeys: Readonly<Partial<Record<TextureRole, string>>>;
  /** Real-world size of one UV tile in metres, for correct tiling density. */
  readonly tileSizeMeters?: number;
}

/** A sound effect, ambience bed or music track. */
export interface IAudioAsset extends IAssetEntry {
  readonly kind: 'audio';
  readonly targetFormat: 'mp3' | 'ogg' | 'webm';
  /** Mixer bus this sound belongs to. */
  readonly category: 'sfx' | 'music' | 'ambience' | 'voice' | 'ui';
  /** Duration in seconds. */
  readonly duration: number;
  /** Seamlessly loopable. */
  readonly loop: boolean;
  /** Positional 3D audio rather than a 2D bed. */
  readonly spatial: boolean;
  /** Decode fully at load rather than streaming. Use for short SFX. */
  readonly preloadDecoded?: boolean;
  readonly sampleRate?: number;
  readonly channels?: 1 | 2;
  /** Per-asset gain trim in dB, applied on top of the bus volume. */
  readonly gainDb?: number;
}

/** An environment map / sky. */
export interface IHDRIAsset extends IAssetEntry {
  readonly kind: 'hdri';
  readonly targetFormat: 'hdr' | 'exr' | 'ktx2';
  /** Equirectangular width in px. */
  readonly resolution: number;
  /** Which day phase this sky represents. */
  readonly timeOfDay?: 'dawn' | 'day' | 'dusk' | 'night';
  /** Pre-filtered irradiance is available for cheap IBL. */
  readonly hasIrradiance?: boolean;
}

/** A standalone animation clip retargetable onto a compatible rig. */
export interface IAnimationAsset extends IAssetEntry {
  readonly kind: 'animation';
  readonly targetFormat: 'glb';
  /** Logical slot this clip fills. */
  readonly clipName: string;
  readonly duration: number;
  readonly loop: boolean;
  /** Rig family this clip targets. */
  readonly skeleton: 'mixamo' | 'custom';
  /** Root motion is baked into the clip. */
  readonly rootMotion?: boolean;
}

/** A webfont. */
export interface IFontAsset extends IAssetEntry {
  readonly kind: 'font';
  readonly targetFormat: 'woff2';
  readonly family: string;
  readonly weight: number;
  readonly style: 'normal' | 'italic';
  /** Unicode ranges included after subsetting. */
  readonly subsets?: readonly string[];
}

/**
 * Discriminated union of every entry type. Narrow on `kind`:
 *
 *   if (entry.kind === 'texture') { entry.colorSpace }  // narrowed
 */
export type AnyAssetEntry =
  | IModelAsset
  | ICharacterAsset
  | ITextureAsset
  | IMaterialAsset
  | IAudioAsset
  | IHDRIAsset
  | IAnimationAsset
  | IFontAsset;

/* -------------------------------------------------------------------------- */
/* Manifest                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The asset manifest. Serialised to JSON and committed; the binary files it
 * references are NOT committed (see .gitignore and the binary guard).
 */
export interface IAssetManifest {
  /** Schema version. Bump on any breaking shape change. */
  readonly version: number;
  /** ISO-8601 build timestamp. */
  readonly generatedAt: string;
  /** Tool that produced this manifest. */
  readonly generator: string;
  /** Every asset, keyed by `id` within the array. */
  readonly entries: readonly AnyAssetEntry[];
  /** Total built bytes per tier, for budget tracking. */
  readonly totalBytes?: Readonly<Partial<Record<QualityTier, number>>>;
  /** Root for generated files, relative to the web root. */
  readonly generatedRoot?: string;
}

/* -------------------------------------------------------------------------- */
/* Runtime handles                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A reference-counted GPU texture handle.
 *
 * Textures are shared aggressively across materials, so consumers must call
 * `release()` rather than disposing the underlying `THREE.Texture` directly —
 * the last release actually frees the GPU memory.
 */
export interface TextureHandle {
  /** Asset id this handle refers to. */
  readonly key: string;
  /** The live GPU texture. */
  readonly texture: THREE.Texture;
  /** Channel interpretation, mirrored from the manifest. */
  readonly colorSpace: ColorSpace;
  readonly width: number;
  readonly height: number;
  /** Codec actually transcoded to on this device. */
  readonly codec: TextureCodec;
  /** Approximate GPU bytes, including mips. */
  readonly gpuBytes: number;
  /** Current reference count. */
  readonly refCount: number;
  /** Increment the reference count; returns this handle. */
  retain(): TextureHandle;
  /** Decrement; frees GPU memory when it reaches 0. */
  release(): void;
}

/** Progress report during bulk loading. */
export interface IAssetLoadProgress {
  readonly loaded: number;
  readonly total: number;
  /** 0..1. */
  readonly fraction: number;
  /** Asset id currently being loaded. */
  readonly current?: string;
  readonly bytesLoaded: number;
  readonly bytesTotal: number;
}

/* -------------------------------------------------------------------------- */
/* Registry and provider                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Runtime asset lookup. THE consumer-facing interface — gameplay code should
 * depend on this and nothing else from the asset layer.
 *
 * Every getter is SYNCHRONOUS and returns undefined when the asset is not yet
 * resident. Call `load()`/`preload()` first, or use the async `require*`
 * helpers. Never block a frame waiting on an asset.
 */
export interface IAssetRegistry {
  /** The manifest backing this registry. */
  readonly manifest: IAssetManifest;
  /** Tier this registry is serving. */
  readonly tier: QualityTier;

  /** Manifest metadata for an id, regardless of load state. */
  getEntry(key: string): AnyAssetEntry | undefined;
  /** All entries of a kind, optionally tag-filtered. */
  query(kind: AssetKind, tag?: string): readonly AnyAssetEntry[];

  /** Resident scene graph for a model. Clone before adding to the scene. */
  getModel(key: string): THREE.Object3D | undefined;
  /** Resident character template, including its animation clips. */
  getCharacter(key: string): { scene: THREE.Object3D; clips: THREE.AnimationClip[] } | undefined;
  /** Resident texture handle. Caller must `retain()` to hold it. */
  getTexture(key: string): TextureHandle | undefined;
  /** Resident material instance. Shared — do not mutate in place. */
  getMaterial(key: string): THREE.Material | undefined;
  /** Decoded audio buffer. */
  getAudio(key: string): AudioBuffer | undefined;
  /** Resident environment map. */
  getHDRI(key: string): THREE.Texture | undefined;
  /** Standalone animation clip. */
  getAnimation(key: string): THREE.AnimationClip | undefined;

  /** True when the asset is resident and a getter will succeed. */
  isLoaded(key: string): boolean;
  /** Load one asset. Resolves once resident. Idempotent and de-duplicated. */
  load(key: string): Promise<void>;
  /** Load many, reporting progress. */
  loadAll(keys: readonly string[], onProgress?: (p: IAssetLoadProgress) => void): Promise<void>;
  /** Load everything flagged `preload`. Called during the boot screen. */
  preloadCore(onProgress?: (p: IAssetLoadProgress) => void): Promise<void>;
  /** Drop an asset and free its GPU memory if unreferenced. */
  unload(key: string): void;
  /** Approximate resident GPU bytes. */
  readonly gpuBytes: number;
}

/**
 * Lower-level fetch/decode layer beneath `IAssetRegistry`.
 *
 * Exists so the registry can be tested against an in-memory provider, and so
 * delivery can change (bundled files, CDN, Capacitor Filesystem, OBB expansion)
 * without touching consumers.
 */
export interface IAssetProvider {
  /** Resolve an asset id + tier to a fetchable URL. */
  resolveUrl(key: string, tier: QualityTier): string | undefined;
  /** Fetch raw bytes. Implementations should support `signal` for aborts. */
  fetchBytes(key: string, tier: QualityTier, signal?: AbortSignal): Promise<ArrayBuffer>;
  /** True when the asset is available offline without a network round-trip. */
  isAvailableOffline(key: string): boolean;
  /** Load and parse the manifest. */
  loadManifest(): Promise<IAssetManifest>;
  /** Best tier this device/connection should use. */
  selectTier(): QualityTier;
}
