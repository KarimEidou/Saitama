/**
 * THE ASSET REGISTRY
 *
 * `IAssetRegistry` is the only asset-layer type gameplay code is meant to
 * depend on: everything is addressed by its stable manifest id, never by path,
 * tier or file extension. This is the real implementation behind it.
 *
 * ── SHAPE ──────────────────────────────────────────────────────────────────
 *   getters are SYNCHRONOUS and return undefined when not resident — never
 *     block a frame on I/O;
 *   `load()` / `loadAll()` / `preloadCore()` are the async door, de-duplicated
 *     and priority-ordered through `LoadScheduler`;
 *   textures are reference-counted handles under an LRU budget (memory.ts);
 *   a missing asset yields a MARKED fallback plus a warning, and is recorded
 *     in `missing` so verification can assert zero instead of squinting at a
 *     screenshot.
 *
 * ── WHAT `load()` DOES BEYOND FETCHING ─────────────────────────────────────
 * Loading a material loads its textures first; loading a model brings its
 * embedded KTX2 with it; loading an HDRI picks PMREM or baked SH-9 by tier.
 * Callers say `load('mat.road.asphalt.worn')` and get a usable material, which
 * is the entire point of a registry over a loader.
 *
 * ── WHAT IT REFUSES TO DO ──────────────────────────────────────────────────
 * It never throws at the caller for a missing file. A 404 on one prop must not
 * take down a city block, and an exception thrown out of a streaming task
 * surfaces as an unhandled rejection three systems away from the cause.
 */

import * as THREE from 'three';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import type {
  AnyAssetEntry,
  AssetKind,
  IAssetLoadProgress,
  IAssetManifest,
  IAssetRegistry,
  IHDRIAsset,
  IMaterialAsset,
  IModelAsset,
  ITextureAsset,
  QualityTier,
  TextureHandle,
} from '@/types';
import { createLogger } from '@/util';
import {
  BASIS_TRANSCODER_DIR,
  PRIORITY,
  TEXTURE_ATTEMPT_LIMIT,
  TEXTURE_MEMORY_BUDGET_BYTES,
  type PriorityName,
} from './constants';
import { HttpAssetProvider } from './provider';
import {
  createKTX2Loader,
  describeTranscodeSupport,
  parseKTX2,
  prepareTexture,
  type ITranscodeSupport,
} from './ktx2';
import { estimateGpuBytes, TextureMemory, type IEvictionReport } from './memory';
import { ManagedTextureHandle, type IManagedTextureHandle } from './textures';
import { buildMaterial, requiredTextures, type IBuiltMaterial } from './materials';
import {
  createModelLoader,
  disposeSceneGraph,
  parseCharacter,
  parseModel,
  type ILoadedModel,
} from './models';
import { EnvironmentLoader, type ILoadedEnvironment } from './environment';
import { LoadScheduler, ProgressTracker } from './queue';
import { missingMaterial, missingModel, missingTexture } from './fallback';
import type { ICharacterRecord } from './characters';
import type { IRuntimeManifest } from './manifest';

const log = createLogger('assets:registry');

/* -------------------------------------------------------------------------- */
/* Options and diagnostics                                                    */
/* -------------------------------------------------------------------------- */

export interface IAssetRegistryOptions {
  readonly provider: HttpAssetProvider;
  readonly renderer: THREE.WebGLRenderer;
  /** Overrides the provider's tier decision. Mostly for the harness. */
  readonly tier?: QualityTier;
  /** Directory serving `basis_transcoder.js`. Defaults to `<root>/basis/`. */
  readonly transcoderPath?: string;
  /** Directory serving the Draco decoder, when a model needs one. */
  readonly dracoPath?: string;
  /** Texture-memory ceiling. Defaults to the per-tier budget. */
  readonly memoryBudgetBytes?: number;
  readonly concurrency?: number;
  /** Anisotropic filtering applied to every loaded texture. */
  readonly anisotropy?: number;
  /** Force the PMREM path on or off. Defaults to `tier !== 'mobile'`. */
  readonly pmrem?: boolean;
  /** Decode audio through this context. Without one, `getAudio` is empty. */
  readonly audioContext?: BaseAudioContext;
}

/** One asset that could not be loaded. */
export interface IAssetFailure {
  readonly key: string;
  readonly kind: string;
  readonly reason: string;
}

/** Snapshot of the registry for the debug HUD and verification. */
export interface IRegistryDiagnostics {
  readonly tier: QualityTier;
  readonly tierReason: string;
  readonly transcode: ITranscodeSupport;
  readonly residentTextures: number;
  readonly textureBytes: number;
  readonly textureBudgetBytes: number;
  readonly modelBytes: number;
  readonly environmentBytes: number;
  readonly gpuBytes: number;
  readonly missing: readonly string[];
  readonly failures: readonly IAssetFailure[];
  readonly tierMisses: readonly { key: string; tier: QualityTier; reason: string }[];
  readonly unavailableTiers: readonly QualityTier[];
  readonly lastEviction: IEvictionReport | undefined;
  readonly evictedTotal: number;
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

export class AssetRegistry implements IAssetRegistry {
  readonly tier: QualityTier;

  private readonly provider: HttpAssetProvider;
  private readonly manifestValue: IRuntimeManifest;
  private readonly ktx2: KTX2Loader;
  private readonly gltf: GLTFLoader;
  private readonly environments: EnvironmentLoader;
  private readonly scheduler: LoadScheduler;
  private readonly memory: TextureMemory;
  private readonly transcode: ITranscodeSupport;
  private readonly anisotropy: number;
  private readonly audioContext: BaseAudioContext | undefined;

  private readonly textureHandles = new Map<string, IManagedTextureHandle>();
  private readonly builtMaterials = new Map<string, IBuiltMaterial>();
  private readonly loadedModels = new Map<string, ILoadedModel>();
  private readonly loadedCharacters = new Map<
    string,
    { scene: THREE.Object3D; clips: THREE.AnimationClip[] }
  >();
  private readonly loadedEnvironments = new Map<string, ILoadedEnvironment>();
  private readonly audioBuffers = new Map<string, AudioBuffer>();
  private readonly animationClips = new Map<string, THREE.AnimationClip>();

  private readonly missingKeys = new Set<string>();
  private readonly failureList: IAssetFailure[] = [];
  private readonly failedKeys = new Set<string>();
  /** Keys no retry can help: not in the manifest, no decoder, no loader. */
  private readonly permanentFailures = new Set<string>();
  /** Fetch attempts per texture key, against `TEXTURE_ATTEMPT_LIMIT`. */
  private readonly textureAttempts = new Map<string, number>();
  /** Aborts every outstanding fetch when the registry is disposed. */
  private readonly inflight = new AbortController();
  private lastEvictionReport: IEvictionReport | undefined;
  private evictedTotal = 0;
  private disposed = false;

  private constructor(
    options: IAssetRegistryOptions,
    manifest: IRuntimeManifest,
    tier: QualityTier
  ) {
    this.provider = options.provider;
    this.manifestValue = manifest;
    this.tier = tier;
    this.anisotropy = options.anisotropy ?? 1;
    this.audioContext = options.audioContext;

    const transcoderPath =
      options.transcoderPath ?? `${this.provider.root}/${BASIS_TRANSCODER_DIR}`;
    this.ktx2 = createKTX2Loader(options.renderer, transcoderPath);
    this.transcode = describeTranscodeSupport(options.renderer);
    this.gltf = createModelLoader({ ktx2: this.ktx2, dracoPath: options.dracoPath });
    this.environments = new EnvironmentLoader({
      renderer: options.renderer,
      ktx2: this.ktx2,
      tier,
      pmrem: options.pmrem,
    });
    this.scheduler = new LoadScheduler(options.concurrency);
    this.memory = new TextureMemory(options.memoryBudgetBytes ?? TEXTURE_MEMORY_BUDGET_BYTES[tier]);
  }

  /**
   * Load the manifest and build every loader.
   *
   * Resolves even when the manifest is unreachable: the registry then serves
   * marked fallbacks for everything, which boots into a visibly broken world
   * rather than a stack trace on a white screen.
   */
  static async open(options: IAssetRegistryOptions): Promise<AssetRegistry> {
    await options.provider.loadManifest();
    // The provider probes device signals while loading the manifest, before
    // any renderer exists to ask for `MAX_TEXTURE_SIZE`. Hand it the one this
    // call already carries so the tier decision is made on complete signals.
    options.provider.adoptRenderer(options.renderer);
    const manifest = options.provider.runtimeManifest;
    const tier = options.tier ?? options.provider.selectTier();
    const registry = new AssetRegistry(options, manifest, tier);
    log.info(
      `registry open at tier '${tier}' — ${manifest.entries.length} entries, ` +
        `${options.provider.characters.size} characters, ` +
        `${(registry.memory.budgetBytes / 1048576).toFixed(0)} MB texture budget, ` +
        `transcode target ${registry.transcode.predictedTarget}`
    );
    return registry;
  }

  /* -- manifest view ------------------------------------------------------ */

  get manifest(): IAssetManifest {
    return this.manifestValue;
  }

  /** The manifest including the pipeline's unmodelled extension blocks. */
  get runtimeManifest(): IRuntimeManifest {
    return this.manifestValue;
  }

  getEntry(key: string): AnyAssetEntry | undefined {
    return this.provider.getEntry(key);
  }

  query(kind: AssetKind, tag?: string): readonly AnyAssetEntry[] {
    return this.manifestValue.entries.filter(
      (entry) => entry.kind === kind && (tag === undefined || entry.tags?.includes(tag) === true)
    );
  }

  /** Characters, which live in a separate index. See `characters.ts`. */
  get characterIndex(): readonly ICharacterRecord[] {
    return this.provider.characters.list();
  }

  /* -- synchronous getters ------------------------------------------------ */

  getModel(key: string): THREE.Object3D | undefined {
    return this.loadedModels.get(key)?.scene;
  }

  /** The full model record, including its LOD groups. */
  getModelAsset(key: string): ILoadedModel | undefined {
    return this.loadedModels.get(key);
  }

  getCharacter(key: string): { scene: THREE.Object3D; clips: THREE.AnimationClip[] } | undefined {
    return this.loadedCharacters.get(key);
  }

  getTexture(key: string): TextureHandle | undefined {
    const handle = this.textureHandles.get(key);
    if (handle) this.memory.touch(key);
    return handle;
  }

  /** The texture handle with its GPU-format details. */
  getTextureDetail(key: string): IManagedTextureHandle | undefined {
    return this.textureHandles.get(key);
  }

  getMaterial(key: string): THREE.Material | undefined {
    return this.builtMaterials.get(key)?.material;
  }

  /** The built material plus which of its textures were missing. */
  getMaterialDetail(key: string): IBuiltMaterial | undefined {
    return this.builtMaterials.get(key);
  }

  getAudio(key: string): AudioBuffer | undefined {
    return this.audioBuffers.get(key);
  }

  getHDRI(key: string): THREE.Texture | undefined {
    const environment = this.loadedEnvironments.get(key);
    if (environment === undefined) return undefined;
    // PMREM when it was built; the equirect otherwise. Both are valid values
    // for `scene.environment`.
    return environment.pmrem ?? environment.texture;
  }

  /** The environment record: SH coefficients, mean luminance, mode. */
  getEnvironment(key: string): ILoadedEnvironment | undefined {
    return this.loadedEnvironments.get(key);
  }

  getAnimation(key: string): THREE.AnimationClip | undefined {
    return this.animationClips.get(key);
  }

  isLoaded(key: string): boolean {
    return (
      this.textureHandles.has(key) ||
      this.builtMaterials.has(key) ||
      this.loadedModels.has(key) ||
      this.loadedCharacters.has(key) ||
      this.loadedEnvironments.has(key) ||
      this.audioBuffers.has(key) ||
      this.animationClips.has(key)
    );
  }

  /* -- loading ------------------------------------------------------------ */

  /**
   * True when a texture is resident only as the marked stand-in and still has
   * attempts left.
   *
   * A transient failure — one dropped request during a wifi/cellular handover
   * — installs the checker under the real key, which makes `isLoaded` true and
   * every later `load()` a no-op. Such a key is deliberately NOT treated as
   * loaded, so the next `load()` re-fetches it. `TEXTURE_ATTEMPT_LIMIT` stops
   * a genuinely absent file being re-fetched once per chunk stream-in.
   */
  private isRetryableFallback(key: string): boolean {
    const handle = this.textureHandles.get(key);
    if (handle?.fallback !== true) return false;
    return (this.textureAttempts.get(key) ?? 0) < TEXTURE_ATTEMPT_LIMIT;
  }

  /** True when there is nothing more `load()` can usefully do for `key`. */
  private isSettled(key: string): boolean {
    if (this.permanentFailures.has(key)) return true;
    return this.isLoaded(key) && !this.isRetryableFallback(key);
  }

  /** Load one asset. Idempotent, de-duplicated, never rejects on a miss. */
  async load(key: string, priority: PriorityName | number = PRIORITY.normal): Promise<void> {
    if (this.disposed || this.isSettled(key)) return;
    await this.scheduler.schedule(key, priority, () => this.loadUncached(key));
  }

  async loadAll(
    keys: readonly string[],
    onProgress?: (progress: IAssetLoadProgress) => void,
    priority: PriorityName | number = PRIORITY.normal
  ): Promise<void> {
    const unique = [...new Set(keys)];
    const tracker = new ProgressTracker(unique.length, this.estimateBytes(unique), onProgress);
    // Credited through the same ledger the estimate was built from, so
    // `bytesLoaded` lands exactly on `bytesTotal` rather than at half of it.
    const charged = new Set<string>();
    tracker.begin(unique[0] ?? '');
    await Promise.all(
      unique.map(async (key) => {
        await this.load(key, priority);
        tracker.complete(key, this.chargeBytes(key, charged));
      })
    );
  }

  /** Load everything flagged `preload` in the manifest. The boot screen path. */
  async preloadCore(onProgress?: (progress: IAssetLoadProgress) => void): Promise<void> {
    const keys = this.manifestValue.entries
      .filter((entry) => entry.preload === true)
      .map((entry) => entry.id);
    log.info(`preloading ${keys.length} core assets`);
    await this.loadAll(keys, onProgress, PRIORITY.critical);
  }

  /** Queue without waiting. For speculative streaming ahead of the player. */
  prefetch(keys: readonly string[], priority: PriorityName | number = PRIORITY.low): void {
    for (const key of keys) void this.load(key, priority);
  }

  /** Resolves when the scheduler has nothing queued or running. */
  async idle(): Promise<void> {
    await this.scheduler.idle();
  }

  private async loadUncached(key: string): Promise<void> {
    if (this.disposed || this.isSettled(key)) return;

    const characterRecord = this.provider.characters.get(key);
    if (characterRecord !== undefined) {
      await this.loadCharacter(characterRecord);
      return;
    }

    const entry = this.provider.getEntry(key);
    if (entry === undefined) {
      // Nothing about a later attempt can make a manifest entry appear, so the
      // key is written off here. Re-running this per chunk stream-in is how
      // `failureList` grew without bound and `load()` stopped being idempotent.
      this.permanentFailures.add(key);
      this.recordFailure(key, 'unknown', 'not present in the manifest');
      return;
    }

    try {
      switch (entry.kind) {
        case 'texture':
          await this.loadTexture(entry);
          break;
        case 'material':
          await this.loadMaterial(entry);
          break;
        case 'model':
          await this.loadModel(entry);
          break;
        case 'hdri':
          await this.loadEnvironment(entry);
          break;
        case 'audio':
          await this.loadAudio(entry);
          break;
        case 'animation':
          await this.loadAnimation(entry);
          break;
        case 'character':
          await this.loadManifestCharacter(entry);
          break;
        default:
          this.permanentFailures.add(key);
          this.recordFailure(key, entry.kind, `no loader for kind '${entry.kind}'`);
          break;
      }
    } catch (error) {
      // A load that lost its race with `dispose()` must not repopulate the
      // maps the teardown just cleared, and its abort is not a broken file.
      if (this.disposed) return;
      // Last line of defence. Anything that escapes a per-kind loader lands
      // here as a marked fallback rather than an unhandled rejection.
      this.recordFailure(key, entry.kind, String(error));
      this.installFallback(entry);
    }
  }

  /* -- per-kind loaders --------------------------------------------------- */

  private async loadTexture(entry: ITextureAsset): Promise<void> {
    if (this.textureHandles.has(entry.id) && !this.isRetryableFallback(entry.id)) return;
    this.textureAttempts.set(entry.id, (this.textureAttempts.get(entry.id) ?? 0) + 1);
    try {
      const result = await this.provider.fetchAsset(entry.id, this.tier, this.inflight.signal);
      const texture = await parseKTX2(this.ktx2, result.bytes);
      prepareTexture(texture, entry.colorSpace, this.anisotropy, entry.tileable);
      texture.name = entry.id;
      const output = entry.outputs.find((candidate) => candidate.tier === result.tier);
      this.installTexture(
        new ManagedTextureHandle({
          key: entry.id,
          texture,
          colorSpace: entry.colorSpace,
          tier: result.tier,
          sourceCodec: output?.codec,
          onUnreferenced: (id) => this.memory.notifyUnreferenced(id),
          onTouch: (id) => this.memory.touch(id),
        })
      );
      this.textureAttempts.delete(entry.id);
      // A retry that succeeded is no longer a stand-in, so it must not keep
      // showing up in `missing` — verification asserts that list is empty.
      this.missingKeys.delete(entry.id);
    } catch (error) {
      if (this.disposed) return;
      this.recordFailure(entry.id, 'texture', String(error));
      this.installTexture(
        new ManagedTextureHandle({
          key: entry.id,
          texture: missingTexture(),
          colorSpace: entry.colorSpace,
          tier: 'fallback',
          fallback: true,
          onUnreferenced: (id) => this.memory.notifyUnreferenced(id),
          onTouch: (id) => this.memory.touch(id),
        })
      );
    }
  }

  private installTexture(handle: IManagedTextureHandle): void {
    // A fetch that resolves after teardown would otherwise re-populate the
    // maps `dispose()` just cleared, with nothing left to free it.
    if (this.disposed) {
      handle.dispose();
      return;
    }
    this.textureHandles.set(handle.key, handle);
    const report = this.memory.insert({
      key: handle.key,
      gpuBytes: handle.gpuBytes,
      get refCount() {
        return handle.refCount;
      },
      dispose: () => {
        this.textureHandles.delete(handle.key);
        handle.dispose();
      },
    });
    this.recordEviction(report);
  }

  /**
   * Remember the outcome of one eviction pass.
   *
   * Every pass, not only the ones that freed something: a pass that evicted
   * nothing because every candidate was referenced is precisely the state an
   * operator needs to see, and keeping the previous report would report
   * someone else's success as the outcome of this pass.
   */
  private recordEviction(report: IEvictionReport): void {
    this.lastEvictionReport = report;
    this.evictedTotal += report.evicted.length;
  }

  private async loadMaterial(entry: IMaterialAsset): Promise<void> {
    if (this.builtMaterials.has(entry.id)) return;
    const textureKeys = requiredTextures(entry);
    // Textures load at `high`: a material whose maps queue behind unrelated
    // streaming work renders as the missing-texture checker until they arrive.
    // That is NOT better than its parent on the boot path, where the parent is
    // `critical` — which is why the wait below gives the slot back rather than
    // relying on the children outranking anything.
    //
    // Each one is retained THE MOMENT it lands, before its siblings finish.
    // Without that pin there is a window in which an unreferenced, just-loaded
    // albedo is the LRU's best eviction candidate while its own normal map is
    // still downloading — the material then binds a stand-in for a texture
    // that loaded successfully seconds earlier.
    const pins: TextureHandle[] = [];
    let built: IBuiltMaterial;
    try {
      // The wait happens OUTSIDE this task's scheduler slot. Holding it would
      // make the material's own textures queue behind the material — a
      // permanent deadlock at `concurrency: 1`, and on the `preloadCore` path
      // as soon as every slot holds a waiting material. See
      // `LoadScheduler.withSlotReleased`.
      await this.scheduler.withSlotReleased(async () => {
        await Promise.all(
          textureKeys.map(async (textureKey) => {
            await this.load(textureKey, PRIORITY.high);
            const handle = this.getTexture(textureKey);
            if (handle !== undefined) pins.push(handle.retain());
          })
        );
      });
      built = buildMaterial(entry, (key) => this.getTexture(key), this.anisotropy);
    } finally {
      // `finally`, because a sibling texture rejecting skips the release loop
      // and strands the pins that already landed at refCount >= 1 — unevictable
      // for the rest of the session, with no owner to release them.
      for (const pin of pins) pin.release();
    }
    if (this.disposed) {
      for (const handle of built.handles) handle.release();
      for (const texture of built.ownedTextures) texture.dispose();
      built.material.dispose();
      return;
    }
    if (built.missingTextures.length > 0) {
      this.missingKeys.add(entry.id);
      log.warn(
        `material "${entry.id}" built with ${built.missingTextures.length} ` +
          `missing texture(s): ${built.missingTextures.join(', ')}`
      );
    }
    this.builtMaterials.set(entry.id, built);
  }

  private async loadModel(entry: IModelAsset): Promise<void> {
    if (this.loadedModels.has(entry.id)) return;
    const result = await this.provider.fetchAsset(entry.id, this.tier, this.inflight.signal);
    const model = await parseModel(this.gltf, entry.id, result.bytes, entry, this.anisotropy);
    if (this.disposed) {
      model.dispose();
      return;
    }
    this.loadedModels.set(entry.id, model);
  }

  private async loadEnvironment(entry: IHDRIAsset): Promise<void> {
    if (this.loadedEnvironments.has(entry.id)) return;
    const record = this.manifestValue.environments[entry.id];
    try {
      const result = await this.provider.fetchAsset(entry.id, this.tier, this.inflight.signal);
      const environment = await this.environments.parse(entry.id, result.bytes, record);
      if (this.disposed) {
        environment.dispose();
        return;
      }
      this.loadedEnvironments.set(entry.id, environment);
    } catch (error) {
      if (this.disposed) return;
      this.recordFailure(entry.id, 'hdri', String(error));
      this.loadedEnvironments.set(entry.id, this.environments.fallbackFor(entry.id, record));
    }
  }

  private async loadAudio(entry: AnyAssetEntry): Promise<void> {
    if (this.audioContext === undefined) {
      // No context will appear later in this registry's life.
      this.permanentFailures.add(entry.id);
      this.recordFailure(entry.id, 'audio', 'no AudioContext was supplied to the registry');
      return;
    }
    const result = await this.provider.fetchAsset(entry.id, this.tier, this.inflight.signal);
    const buffer = await this.audioContext.decodeAudioData(result.bytes);
    if (this.disposed) return;
    this.audioBuffers.set(entry.id, buffer);
  }

  private async loadAnimation(entry: AnyAssetEntry): Promise<void> {
    if (this.animationClips.has(entry.id)) return;
    const result = await this.provider.fetchAsset(entry.id, this.tier, this.inflight.signal);
    const parsed = await parseCharacter(this.gltf, entry.id, result.bytes, this.anisotropy);
    // Only the clips are kept. An animation GLB commonly ships the skinned mesh
    // it was authored against, and dropping the last reference to that graph
    // leaks its geometries and embedded textures with no `unload` route back.
    disposeSceneGraph(parsed.scene, { textures: true });
    const clip = parsed.clips[0];
    if (clip === undefined) {
      this.recordFailure(entry.id, 'animation', 'GLB contained no animation clips');
      return;
    }
    if (this.disposed) return;
    this.animationClips.set(entry.id, clip);
    for (const extra of parsed.clips) this.animationClips.set(`${entry.id}:${extra.name}`, extra);
  }

  /** A `character` entry that IS in the manifest, unlike the baked roster. */
  private async loadManifestCharacter(entry: AnyAssetEntry): Promise<void> {
    if (this.loadedCharacters.has(entry.id)) return;
    const result = await this.provider.fetchAsset(entry.id, this.tier, this.inflight.signal);
    const parsed = await parseCharacter(this.gltf, entry.id, result.bytes, this.anisotropy);
    if (this.disposed) {
      disposeSceneGraph(parsed.scene, { textures: true });
      return;
    }
    this.loadedCharacters.set(entry.id, parsed);
  }

  /**
   * Load a character from the separate bake index.
   *
   * Its mesh is one GLB regardless of tier; only the atlases are tiered, and
   * they are PNG rather than KTX2 because the baker leaves them
   * browser-decodable.
   */
  private async loadCharacter(record: ICharacterRecord): Promise<void> {
    if (this.loadedCharacters.has(record.id)) return;
    try {
      const bytes = await this.provider.fetchFile(record.modelFile, this.inflight.signal);
      const parsed = await parseCharacter(this.gltf, record.id, bytes, this.anisotropy);
      if (this.disposed) {
        disposeSceneGraph(parsed.scene, { textures: true });
        return;
      }
      this.loadedCharacters.set(record.id, parsed);
    } catch (error) {
      if (this.disposed) return;
      this.recordFailure(record.id, 'character', String(error));
      this.loadedCharacters.set(record.id, {
        scene: missingModel(record.id),
        clips: [],
      });
      this.missingKeys.add(record.id);
    }
  }

  /* -- unloading ---------------------------------------------------------- */

  /** Drop an asset and free its GPU memory when nothing references it. */
  unload(key: string): void {
    const material = this.builtMaterials.get(key);
    if (material) {
      for (const handle of material.handles) handle.release();
      // The per-material UV-repeat clones belong to this material and nothing
      // else: the handles above own the originals, and three frees a GL texture
      // only on an explicit `dispose()`.
      for (const texture of material.ownedTextures) texture.dispose();
      material.material.dispose();
      this.builtMaterials.delete(key);
    }

    const model = this.loadedModels.get(key);
    if (model) {
      model.dispose();
      this.loadedModels.delete(key);
    }

    const character = this.loadedCharacters.get(key);
    if (character) {
      // A character graph owns the textures inside its own GLB, so they go too.
      disposeSceneGraph(character.scene, { textures: true });
      this.loadedCharacters.delete(key);
    }

    const environment = this.loadedEnvironments.get(key);
    if (environment) {
      environment.dispose();
      this.loadedEnvironments.delete(key);
    }

    this.audioBuffers.delete(key);
    this.animationClips.delete(key);

    // Textures last: a material released above may have just dropped the final
    // reference, which makes the texture evictable in the same call.
    if (this.textureHandles.has(key)) this.memory.remove(key);
  }

  /** Force an eviction pass. Returns what it managed to free. */
  trimMemory(): IEvictionReport {
    const report = this.memory.trim();
    this.recordEviction(report);
    return report;
  }

  /** Change the texture budget at runtime, e.g. on a thermal downgrade. */
  setTextureBudget(bytes: number): void {
    this.memory.setBudget(bytes);
    this.trimMemory();
  }

  /** Free a texture the instant its last reference goes, per the type doc. */
  setEagerRelease(enabled: boolean): void {
    this.memory.setEagerRelease(enabled);
  }

  /* -- accounting --------------------------------------------------------- */

  get gpuBytes(): number {
    let bytes = this.memory.bytes;
    for (const environment of this.loadedEnvironments.values()) bytes += environment.gpuBytes;
    bytes += this.modelBytes;
    return bytes;
  }

  /** Resident texture bytes only, i.e. what the LRU budget governs. */
  get textureBytes(): number {
    return this.memory.bytes;
  }

  private get modelBytes(): number {
    let bytes = 0;
    const counted = new Set<number>();
    const add = (root: THREE.Object3D): void => {
      root.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        const geometry = mesh.geometry;
        if (counted.has(geometry.id)) return;
        counted.add(geometry.id);
        for (const attribute of Object.values(geometry.attributes)) {
          bytes += attribute.array.byteLength;
        }
        bytes += geometry.getIndex()?.array.byteLength ?? 0;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          const pbr = material as THREE.MeshStandardMaterial;
          for (const texture of [pbr.map, pbr.normalMap, pbr.roughnessMap, pbr.emissiveMap]) {
            if (texture && !counted.has(texture.id)) {
              counted.add(texture.id);
              bytes += estimateGpuBytes(texture);
            }
          }
        }
      });
    };
    for (const model of this.loadedModels.values()) add(model.scene);
    for (const character of this.loadedCharacters.values()) add(character.scene);
    return bytes;
  }

  /** Assets that fell back to a stand-in. Verification asserts this is empty. */
  get missing(): readonly string[] {
    return [...this.missingKeys];
  }

  get failures(): readonly IAssetFailure[] {
    return this.failureList;
  }

  /** Everything the debug HUD and the harness need in one object. */
  diagnostics(): IRegistryDiagnostics {
    return {
      tier: this.tier,
      tierReason: this.provider.tierDecision.reason,
      transcode: this.transcode,
      residentTextures: this.textureHandles.size,
      textureBytes: this.memory.bytes,
      textureBudgetBytes: this.memory.budgetBytes,
      modelBytes: this.modelBytes,
      environmentBytes: [...this.loadedEnvironments.values()].reduce(
        (sum, environment) => sum + environment.gpuBytes,
        0
      ),
      gpuBytes: this.gpuBytes,
      missing: this.missing,
      failures: this.failureList,
      tierMisses: this.provider.availability.recordedMisses.map((miss) => ({ ...miss })),
      unavailableTiers: this.provider.availability.unavailableTiers,
      lastEviction: this.lastEvictionReport,
      evictedTotal: this.evictedTotal,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Stop the queue and abort what is already in the air FIRST: a fetch that
    // resolved after this point used to re-populate the maps cleared below,
    // with nothing left alive to free it.
    this.scheduler.cancelAll();
    this.inflight.abort();
    for (const built of this.builtMaterials.values()) {
      for (const handle of built.handles) handle.release();
      for (const texture of built.ownedTextures) texture.dispose();
      built.material.dispose();
    }
    this.builtMaterials.clear();
    for (const model of this.loadedModels.values()) model.dispose();
    this.loadedModels.clear();
    for (const character of this.loadedCharacters.values()) {
      disposeSceneGraph(character.scene, { textures: true });
    }
    this.loadedCharacters.clear();
    for (const environment of this.loadedEnvironments.values()) environment.dispose();
    this.loadedEnvironments.clear();
    this.memory.clear();
    this.textureHandles.clear();
    this.environments.dispose();
    this.ktx2.dispose();
  }

  /* -- internals ---------------------------------------------------------- */

  /**
   * Record one failed asset, ONCE per key.
   *
   * A key that fails repeatedly — a city material asked for at every chunk
   * transition — would otherwise push a row per attempt into an array
   * `diagnostics()` hands to the debug HUD every frame, and log a warning per
   * attempt with it.
   */
  private recordFailure(key: string, kind: string, reason: string): void {
    this.missingKeys.add(key);
    if (this.failedKeys.has(key)) return;
    this.failedKeys.add(key);
    this.failureList.push({ key, kind, reason });
    log.warnOnce(
      `asset-unavailable:${key}`,
      `asset "${key}" (${kind}) unavailable: ${reason} — using a marked fallback`
    );
  }

  private installFallback(entry: AnyAssetEntry): void {
    switch (entry.kind) {
      case 'material':
        this.builtMaterials.set(entry.id, {
          material: missingMaterial(entry.id),
          handles: [],
          ownedTextures: [],
          missingTextures: [],
          ormBound: false,
        });
        break;
      case 'model':
        this.loadedModels.set(entry.id, fallbackModel(entry.id));
        break;
      case 'character':
        this.loadedCharacters.set(entry.id, { scene: missingModel(entry.id), clips: [] });
        break;
      default:
        break;
    }
  }

  private bytesOf(key: string): number {
    const entry = this.provider.getEntry(key);
    if (entry === undefined) return 0;
    const tier = this.provider.effectiveTier(key, this.tier);
    return entry.outputs.find((output) => output.tier === tier)?.bytes ?? 0;
  }

  /** Files loading `key` actually downloads: itself, plus a material's maps. */
  private billableFiles(key: string): readonly string[] {
    const entry = this.provider.getEntry(key);
    if (entry?.kind !== 'material') return [key];
    return [key, ...requiredTextures(entry)];
  }

  /**
   * Bytes of `key`'s files that `charged` has not been counted for yet, adding
   * them to it.
   *
   * Estimate and credit run through the same function so they cannot disagree.
   * They did: the pipeline copies a material's `preload` flag onto its texture
   * rows, so `preloadCore()`'s key set holds the material AND its textures,
   * the estimate counted those textures twice, the credit counted them once,
   * and the boot bar stopped at roughly half.
   */
  private chargeBytes(key: string, charged: Set<string>): number {
    let total = 0;
    for (const file of this.billableFiles(key)) {
      if (charged.has(file)) continue;
      charged.add(file);
      total += this.bytesOf(file);
    }
    return total;
  }

  private estimateBytes(keys: readonly string[]): number {
    const charged = new Set<string>();
    let total = 0;
    for (const key of keys) total += this.chargeBytes(key, charged);
    return total;
  }
}

/** A stand-in model that still satisfies `ILoadedModel`. */
function fallbackModel(key: string): ILoadedModel {
  const scene = missingModel(key);
  return {
    key,
    scene,
    lodGroups: [],
    triangles: 12,
    lodCount: 1,
    activeLevel: 0,
    setLodLevel: () => undefined,
    toThreeLOD: () => {
      const lod = new THREE.LOD();
      lod.addLevel(scene, 0);
      return lod;
    },
    dispose: () => disposeSceneGraph(scene),
  };
}
