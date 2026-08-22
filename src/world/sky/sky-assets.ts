/**
 * SKY ASSETS — everything reached by manifest id, never by path.
 *
 * Two pieces:
 *
 *   `HttpAssetProvider`  — an `IAssetProvider` over a static asset root. It
 *                          loads the manifest and resolves ids to URLs.
 *   `SkyEnvironmentRegistry` — an `IAssetRegistry` that serves HDRIs and
 *                          nothing else, because the sky is all this
 *                          workstream is entitled to load.
 *
 * ── WHY A NARROW REGISTRY IS THE RIGHT SHAPE ───────────────────────────────
 * The contract in `types/assets.ts` is deliberately broad, covering models,
 * characters, audio and fonts. A day/night cycle needs four equirect textures.
 * Implementing the whole surface with real loaders would duplicate work that
 * belongs to the asset workstream and would couple the sky to formats it has
 * no opinion about, so the non-HDRI getters return `undefined` and say so.
 * Anything asking this registry for a character has the wrong registry.
 *
 * ── THE TWO PIPELINE NOTES THAT ARE NOT OPTIONAL ───────────────────────────
 *  1. `KTX2Loader` hands back environment maps with `NearestFilter` on both
 *     min and mag. Left alone, the sky is a visibly blocky 1024x512 image and
 *     the PMREM convolution samples it point-wise, which aliases the sun disc
 *     into a flickering square. Fixed in `prepareEnvironment()`.
 *  2. The mapping must be `EquirectangularReflectionMapping`, or three treats
 *     the texture as a flat UV map and the sky wraps around the screen.
 */

import * as THREE from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import type {
  AnyAssetEntry,
  AssetKind,
  IAssetLoadProgress,
  IAssetManifest,
  IAssetProvider,
  IAssetRegistry,
  QualityTier,
  TextureHandle,
} from '@/types';
import { createLogger } from '@/util';

const log = createLogger('world.sky.assets');

/* -------------------------------------------------------------------------- */
/* Provider                                                                   */
/* -------------------------------------------------------------------------- */

export interface IHttpAssetProviderOptions {
  /** Root the manifest and generated files are served from, no trailing slash. */
  readonly baseUrl: string;
  /** Manifest filename under `baseUrl`. */
  readonly manifestFile?: string;
  /** Force a tier instead of probing the device. */
  readonly tier?: QualityTier;
}

/** Fetches the manifest and resolves asset ids to URLs. */
export class HttpAssetProvider implements IAssetProvider {
  private readonly baseUrl: string;
  private readonly manifestFile: string;
  private readonly forcedTier: QualityTier | undefined;
  private manifest: IAssetManifest | undefined;
  /** In-flight manifest fetch, so racing callers share one request. */
  private pending: Promise<IAssetManifest> | undefined;
  /** The raw parsed JSON, including pipeline extensions the type does not model. */
  private raw: unknown;

  constructor(options: IHttpAssetProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.manifestFile = options.manifestFile ?? 'assets.runtime.json';
    this.forcedTier = options.tier;
  }

  /**
   * The manifest exactly as parsed, including the `environments` and `pipeline`
   * blocks the texture workstream appends. `IAssetManifest` does not model
   * them, and the measured mean luminances live there — see
   * `parseEnvironmentMeasurements`.
   */
  get rawManifest(): unknown {
    return this.raw;
  }

  /**
   * Load the manifest once, however many callers ask.
   *
   * The `this.manifest` guard alone only helps AFTER the first fetch has
   * resolved: the documented wiring has the bootstrap load the manifest and
   * `SkyEnvironmentRegistry.open()` load it again, and overlapping those sends
   * two `no-store` requests for the same file whose parsed objects then race
   * to be stored. Holding the pending promise is what makes it once. A failure
   * clears the pending slot, so a retry is still possible.
   */
  async loadManifest(): Promise<IAssetManifest> {
    if (this.manifest) return this.manifest;
    this.pending ??= this.fetchManifest().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async fetchManifest(): Promise<IAssetManifest> {
    const response = await fetch(`${this.baseUrl}/${this.manifestFile}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`asset manifest ${response.status} at ${this.baseUrl}`);
    const raw: unknown = await response.json();
    // Parsed, not blind-cast. A manifest whose shape drifted otherwise fails
    // deep inside `resolveUrl` as `Cannot read properties of undefined`,
    // several frames away from the thing that is actually wrong.
    if (!looksLikeManifest(raw)) {
      throw new Error(`asset manifest at ${this.baseUrl} has no "entries" array`);
    }
    this.raw = raw;
    this.manifest = raw;
    return raw;
  }

  resolveUrl(key: string, tier: QualityTier): string | undefined {
    const entry = this.manifest?.entries.find((e) => e.id === key);
    if (!entry) return undefined;
    // Exact tier, then DOWNWARD, and only upward when there is nothing at or
    // below the request. A device asking for 'ultra' on a set built only to
    // 'high' should get the sky rather than a black screen — but a device the
    // tier logic put BELOW 'ultra' must never be handed the 4K equirect
    // because its own tier happens not to have been built. That is several
    // times the download and several times the VRAM on hardware already judged
    // unable to afford it. Same rule as `TierAvailability.chainFor`.
    const order: QualityTier[] =
      tier === 'mobile'
        ? ['mobile', 'high', 'ultra']
        : tier === 'high'
          ? ['high', 'mobile', 'ultra']
          : ['ultra', 'high', 'mobile'];
    for (const candidate of order) {
      const output = entry.outputs.find((o) => o.tier === candidate);
      if (output) {
        const root = this.manifest?.generatedRoot?.replace(/\/+$/, '');
        const prefix =
          root && !this.baseUrl.endsWith(root) ? `${this.baseUrl}/${root}` : this.baseUrl;
        return `${prefix}/${output.file}`;
      }
    }
    return undefined;
  }

  async fetchBytes(key: string, tier: QualityTier, signal?: AbortSignal): Promise<ArrayBuffer> {
    const url = this.resolveUrl(key, tier);
    if (!url) throw new Error(`asset "${key}" has no output for tier "${tier}"`);
    const response = await fetch(url, { signal, cache: 'force-cache' });
    if (!response.ok) throw new Error(`asset "${key}" fetch failed: ${response.status}`);
    return response.arrayBuffer();
  }

  isAvailableOffline(key: string): boolean {
    // Everything ships inside the APK under Capacitor; over the dev server
    // nothing is guaranteed. Reported honestly rather than optimistically.
    return this.manifest?.entries.some((e) => e.id === key) === true && isCapacitorNative();
  }

  /**
   * Best tier for this device.
   *
   * `navigator.deviceMemory` is Chromium-only: WebKit and Gecko do not
   * implement it, so a probe that consults nothing else classifies EVERY iOS
   * device — the first-class target of this project, under Capacitor — as
   * `high`, an iPhone SE exactly like an iPhone 17 Pro. So the other signals
   * the canonical `src/assets/tier.ts` uses are consulted too, in its order:
   * a native shell only ever packages the mobile set, a data-saving connection
   * asks for the small files, and a low core count is a phone whatever the
   * user agent claims.
   */
  selectTier(): QualityTier {
    if (this.forcedTier) return this.forcedTier;
    const nav = globalThis.navigator as INavigatorSignals | undefined;

    if (isCapacitorNative()) return 'mobile';
    if (nav?.connection?.saveData === true) return 'mobile';

    const memory = nav?.deviceMemory;
    if (typeof memory === 'number') return memory <= 4 ? 'mobile' : 'high';

    // No `deviceMemory`. Fall back to what every engine does report.
    if (isHandheldUserAgent(nav?.userAgent)) return 'mobile';
    const cores = typeof nav?.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : 4;
    if (cores <= 2) return 'mobile';
    return 'high';
  }
}

/** The handful of `navigator` fields the tier probe reads. */
interface INavigatorSignals {
  readonly deviceMemory?: number;
  readonly hardwareConcurrency?: number;
  readonly userAgent?: string;
  readonly connection?: { readonly saveData?: boolean };
}

function isCapacitorNative(): boolean {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return cap?.isNativePlatform?.() === true;
}

/** Mobile Safari and mobile Gecko, the two engines with no `deviceMemory`. */
function isHandheldUserAgent(userAgent: string | undefined): boolean {
  if (!userAgent) return false;
  return /android|iphone|ipad|ipod|mobile safari/i.test(userAgent);
}

/**
 * Structural check that the parsed JSON is a manifest at all.
 *
 * Deliberately shallow: the sky reads `entries` and `generatedRoot`, and a
 * missing `entries` is the difference between "this asset is not built" and a
 * `TypeError` from inside `resolveUrl`.
 */
function looksLikeManifest(raw: unknown): raw is IAssetManifest {
  return (
    typeof raw === 'object' && raw !== null && Array.isArray((raw as { entries?: unknown }).entries)
  );
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

export interface ISkyRegistryOptions {
  readonly provider: IAssetProvider;
  readonly renderer: THREE.WebGLRenderer;
  /** URL the Basis transcoder is served from. */
  readonly transcoderPath?: string;
  readonly tier?: QualityTier;
}

/**
 * HDRI-only `IAssetRegistry`.
 *
 * `getHDRI()` is the whole point; every other getter answers `undefined`
 * because this registry deliberately does not own those kinds.
 */
export class SkyEnvironmentRegistry implements IAssetRegistry {
  readonly tier: QualityTier;

  private readonly provider: IAssetProvider;
  private readonly ktx2: KTX2Loader;
  private readonly textures = new Map<string, THREE.Texture>();
  private readonly inFlight = new Map<string, Promise<void>>();
  /** Reject handles for `inFlight`, so `dispose()` can settle them. */
  private readonly abort = new Map<string, (reason: Error) => void>();
  private manifestValue: IAssetManifest;
  private disposed = false;

  private constructor(
    provider: IAssetProvider,
    manifest: IAssetManifest,
    tier: QualityTier,
    ktx2: KTX2Loader
  ) {
    this.provider = provider;
    this.manifestValue = manifest;
    this.tier = tier;
    this.ktx2 = ktx2;
  }

  /** Load the manifest and build the loaders. */
  static async open(options: ISkyRegistryOptions): Promise<SkyEnvironmentRegistry> {
    const manifest = await options.provider.loadManifest();
    const tier = options.tier ?? options.provider.selectTier();
    const ktx2 = new KTX2Loader()
      .setTranscoderPath(options.transcoderPath ?? '/basis/')
      .detectSupport(options.renderer);
    return new SkyEnvironmentRegistry(options.provider, manifest, tier, ktx2);
  }

  get manifest(): IAssetManifest {
    return this.manifestValue;
  }

  getEntry(key: string): AnyAssetEntry | undefined {
    return this.manifestValue.entries.find((entry) => entry.id === key);
  }

  query(kind: AssetKind, tag?: string): readonly AnyAssetEntry[] {
    return this.manifestValue.entries.filter(
      (entry) => entry.kind === kind && (tag === undefined || entry.tags?.includes(tag) === true)
    );
  }

  getHDRI(key: string): THREE.Texture | undefined {
    return this.textures.get(key);
  }

  isLoaded(key: string): boolean {
    return this.textures.has(key);
  }

  async load(key: string): Promise<void> {
    if (this.textures.has(key)) return;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    if (this.disposed) throw new Error(`sky registry is disposed; "${key}" cannot be loaded`);

    const url = this.provider.resolveUrl(key, this.tier);
    if (!url) throw new Error(`sky asset "${key}" is not in the manifest`);

    const transcode = this.ktx2.loadAsync(url).then((texture) => {
      // The transcode can land AFTER dispose(): `WorkerPool.postMessage`
      // silently spins up a brand-new worker when the pool has been emptied.
      // Inserting here would put a live GPU texture into a disposed registry
      // that nobody will dispose again.
      if (this.disposed) {
        texture.dispose();
        throw new Error(`sky asset "${key}" completed after the registry was disposed`);
      }
      prepareEnvironment(texture);
      texture.name = key;
      this.textures.set(key, texture);
      log.info(`loaded environment "${key}" (${texture.image?.width}x${texture.image?.height})`);
    });

    // `KTX2Loader.dispose()` terminates the worker pool WITHOUT settling the
    // transcodes sitting in it — three's `WorkerPool.dispose()` drops its
    // pending resolvers on the floor and neither resolves nor rejects them. So
    // the promise handed to callers is one this registry can settle itself; a
    // registry torn down mid-load must not leave `await load()` hanging for
    // the lifetime of the page.
    const task = new Promise<void>((resolve, reject) => {
      this.abort.set(key, reject);
      transcode.then(resolve, reject);
    }).finally(() => {
      this.inFlight.delete(key);
      this.abort.delete(key);
    });

    this.inFlight.set(key, task);
    return task;
  }

  async loadAll(
    keys: readonly string[],
    onProgress?: (progress: IAssetLoadProgress) => void
  ): Promise<void> {
    let loaded = 0;
    await Promise.all(
      keys.map(async (key) => {
        await this.load(key);
        loaded++;
        onProgress?.({
          loaded,
          total: keys.length,
          fraction: loaded / Math.max(1, keys.length),
          current: key,
          bytesLoaded: 0,
          bytesTotal: 0,
        });
      })
    );
  }

  async preloadCore(onProgress?: (progress: IAssetLoadProgress) => void): Promise<void> {
    const keys = this.manifestValue.entries
      .filter((entry) => entry.kind === 'hdri' && entry.preload)
      .map((entry) => entry.id);
    await this.loadAll(keys, onProgress);
  }

  unload(key: string): void {
    const texture = this.textures.get(key);
    if (!texture) return;
    texture.dispose();
    this.textures.delete(key);
  }

  get gpuBytes(): number {
    let bytes = 0;
    for (const texture of this.textures.values()) {
      const image = texture.image as { width?: number; height?: number } | undefined;
      // RGBA16F, plus a third again for the mip chain.
      bytes += (image?.width ?? 0) * (image?.height ?? 0) * 8 * 1.34;
    }
    return Math.round(bytes);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Settle every in-flight load BEFORE the worker pool goes away, or the
    // callers awaiting them wait forever.
    for (const [key, reject] of [...this.abort]) {
      reject(new Error(`sky asset "${key}" aborted: the registry was disposed`));
    }
    this.abort.clear();
    this.inFlight.clear();
    for (const key of [...this.textures.keys()]) this.unload(key);
    this.ktx2.dispose();
  }

  /* Kinds this registry does not own. --------------------------------------- */
  getModel(): THREE.Object3D | undefined {
    return undefined;
  }
  getCharacter(): { scene: THREE.Object3D; clips: THREE.AnimationClip[] } | undefined {
    return undefined;
  }
  getTexture(): TextureHandle | undefined {
    return undefined;
  }
  getMaterial(): THREE.Material | undefined {
    return undefined;
  }
  getAudio(): AudioBuffer | undefined {
    return undefined;
  }
  getAnimation(): THREE.AnimationClip | undefined {
    return undefined;
  }
}

/**
 * Apply the two settings `KTX2Loader` gets wrong for environment maps.
 *
 * Exported because it is a correctness fix, not an internal detail: any other
 * consumer loading these same maps needs it too.
 */
export function prepareEnvironment(texture: THREE.Texture): THREE.Texture {
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.magFilter = THREE.LinearFilter;
  // Mip levels are present in the KTX2 (11 for 1024x512), so trilinear is
  // available and worth having: PMREM's lower roughness levels sample the
  // source at reduced footprints.
  texture.minFilter =
    texture.mipmaps && texture.mipmaps.length > 1
      ? THREE.LinearMipmapLinearFilter
      : THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}
