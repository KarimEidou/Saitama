/**
 * HTTP ASSET PROVIDER
 *
 * The fetch/decode floor beneath `AssetRegistry`: it turns manifest ids into
 * URLs and URLs into bytes, and knows nothing about textures, meshes or GPUs.
 * Swapping it for a Capacitor Filesystem or OBB-expansion provider is a
 * constructor change, which is the entire reason `IAssetProvider` exists
 * separately from `IAssetRegistry`.
 *
 * Two behaviours are load-bearing:
 *
 *   TIER RESOLUTION IS PER ASSET. `resolveUrl('mat.x.albedo', 'high')` returns
 *   the mobile file when that asset has no high output. Of the 166 outputs in
 *   the shipped manifest only 13 exist at `high`; a provider that resolved the
 *   tier globally would 404 on the other 153.
 *
 *   A MISS IS DATA, NOT AN EXCEPTION. `fetchBytes` records the miss against
 *   `availability`, retries at the next lower tier the asset has, and only
 *   rejects when every tier is exhausted. The caller then substitutes a
 *   fallback. Nothing about a missing file reaches the player as a crash.
 */

import type { AnyAssetEntry, IAssetManifest, IAssetProvider, QualityTier } from '@/types';
import { createLogger } from '@/util';
import { DEFAULT_ASSET_ROOT, RUNTIME_MANIFEST_FILE, CHARACTER_INDEX_FILE } from './constants';
import {
  emptyRuntimeManifest,
  indexById,
  parseRuntimeManifest,
  type IRuntimeManifest,
} from './manifest';
import { CharacterIndex, parseCharacterIndex } from './characters';
import {
  detectTierSignals,
  selectQualityTier,
  TierAvailability,
  type ITierDecision,
  type ITierSignals,
} from './tier';

const log = createLogger('assets:provider');

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

export interface IHttpAssetProviderOptions {
  /**
   * Web root the generated tree is served from. Relative by default so it
   * resolves against `document.baseURI` — an absolute `/assets` breaks under
   * Capacitor on Android, where the app is not served from the origin root.
   */
  readonly baseUrl?: string;
  readonly manifestFile?: string;
  readonly characterIndexFile?: string;
  /** Skip tier detection. Still clamped to what the manifest says was built. */
  readonly tier?: QualityTier;
  /** Override the probed device signals. Used by tests and the harness. */
  readonly signals?: Partial<ITierSignals>;
  /** Injected for tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** `RequestInit.cache` for asset bodies. */
  readonly cacheMode?: RequestCache;
}

/** One completed transfer, for byte-accurate progress. */
export interface IFetchResult {
  readonly bytes: ArrayBuffer;
  readonly url: string;
  readonly tier: QualityTier;
}

/* -------------------------------------------------------------------------- */
/* Provider                                                                   */
/* -------------------------------------------------------------------------- */

export class HttpAssetProvider implements IAssetProvider {
  private readonly baseUrl: string;
  private readonly manifestFile: string;
  private readonly characterIndexFile: string;
  private readonly forcedTier: QualityTier | undefined;
  private readonly signalOverrides: Partial<ITierSignals>;
  private readonly doFetch: typeof fetch;
  private readonly cacheMode: RequestCache | undefined;

  private manifestValue: IRuntimeManifest | undefined;
  private entriesById: ReadonlyMap<string, AnyAssetEntry> = new Map();
  private characterIndexValue = new CharacterIndex([]);
  private availabilityValue = new TierAvailability(['mobile']);
  private decision: ITierDecision | undefined;
  private manifestPending: Promise<IAssetManifest> | undefined;
  private rawManifestValue: unknown;
  private resolvedSignals: ITierSignals | undefined;

  constructor(options: IHttpAssetProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_ASSET_ROOT).replace(/\/+$/, '');
    this.manifestFile = options.manifestFile ?? RUNTIME_MANIFEST_FILE;
    this.characterIndexFile = options.characterIndexFile ?? CHARACTER_INDEX_FILE;
    this.forcedTier = options.tier;
    this.signalOverrides = options.signals ?? {};
    this.doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.cacheMode = options.cacheMode;
  }

  /* -- accessors ---------------------------------------------------------- */

  /** Root every generated file hangs off, without a trailing slash. */
  get root(): string {
    return this.baseUrl;
  }

  /** The manifest with its pipeline extensions (`environments`, `pipeline`). */
  get runtimeManifest(): IRuntimeManifest {
    return this.manifestValue ?? emptyRuntimeManifest();
  }

  /** The manifest exactly as parsed, for consumers reading unmodelled blocks. */
  get rawManifest(): unknown {
    return this.rawManifestValue;
  }

  get characters(): CharacterIndex {
    return this.characterIndexValue;
  }

  /** Runtime record of which tiers actually exist on this device. */
  get availability(): TierAvailability {
    return this.availabilityValue;
  }

  /** Why the current tier was chosen. Surfaced in boot diagnostics. */
  get tierDecision(): ITierDecision {
    return (
      this.decision ?? {
        tier: this.forcedTier ?? 'mobile',
        requested: this.forcedTier ?? 'mobile',
        reason: 'manifest not loaded yet',
      }
    );
  }

  /* -- manifest ----------------------------------------------------------- */

  async loadManifest(): Promise<IAssetManifest> {
    if (this.manifestValue) return this.manifestValue;
    this.manifestPending ??= this.doLoadManifest();
    return this.manifestPending;
  }

  private async doLoadManifest(): Promise<IAssetManifest> {
    const url = `${this.baseUrl}/${this.manifestFile}`;
    try {
      const response = await this.doFetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.rawManifestValue = await response.json();
      this.manifestValue = parseRuntimeManifest(this.rawManifestValue);
    } catch (error) {
      // A missing index is survivable: everything resolves to a marked
      // fallback and the game boots into a visibly broken world rather than a
      // white screen with a stack trace.
      log.error(`asset manifest could not be loaded from ${url}: ${String(error)}`);
      this.manifestValue = emptyRuntimeManifest();
    }

    this.entriesById = indexById(this.manifestValue.entries);
    this.availabilityValue = new TierAvailability(this.manifestValue.tiersBuilt);
    this.resolvedSignals = { ...detectTierSignals(), ...this.signalOverrides };
    this.decision = selectQualityTier(this.resolvedSignals, {
      forced: this.forcedTier,
      builtTiers: this.manifestValue.tiersBuilt,
    });
    log.info(
      `asset tier '${this.decision.tier}' — ${this.decision.reason}; ` +
        `${this.manifestValue.entries.length} manifest entries`
    );

    await this.loadCharacterIndex();
    return this.manifestValue;
  }

  /**
   * The character bake writes its own index. Its absence is normal (a fresh
   * clone has not run the baker), so it is fetched separately and its failure
   * is logged at debug rather than error.
   */
  private async loadCharacterIndex(): Promise<void> {
    const url = `${this.baseUrl}/${this.characterIndexFile}`;
    try {
      const response = await this.doFetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.characterIndexValue = new CharacterIndex(parseCharacterIndex(await response.json()));
      log.info(`character index: ${this.characterIndexValue.size} characters`);
    } catch (error) {
      this.characterIndexValue = new CharacterIndex([]);
      log.debug(`no character index at ${url} (${String(error)})`);
    }
  }

  /* -- urls --------------------------------------------------------------- */

  /** Absolute-ish URL for a path relative to the generated root. */
  resolveFile(file: string): string {
    const root = this.manifestValue?.generatedRoot?.replace(/\/+$/, '');
    const prefix =
      root !== undefined && root.length > 0 && !this.baseUrl.endsWith(root)
        ? `${this.baseUrl}/${root}`
        : this.baseUrl;
    return `${prefix}/${file.replace(/^\/+/, '')}`;
  }

  getEntry(key: string): AnyAssetEntry | undefined {
    return this.entriesById.get(key);
  }

  /**
   * URL for an asset at the best tier at or below `tier`.
   *
   * Undefined means "not in the manifest" — a caller seeing undefined must
   * substitute a fallback, not retry.
   */
  resolveUrl(key: string, tier: QualityTier): string | undefined {
    const entry = this.entriesById.get(key);
    if (!entry) return undefined;
    const chosen = this.availabilityValue.bestTierFor(entry, tier);
    if (chosen === undefined) return undefined;
    const output = entry.outputs.find((candidate) => candidate.tier === chosen);
    return output ? this.resolveFile(output.file) : undefined;
  }

  /** Tier `resolveUrl` would actually serve for this asset. */
  effectiveTier(key: string, tier: QualityTier): QualityTier | undefined {
    const entry = this.entriesById.get(key);
    return entry ? this.availabilityValue.bestTierFor(entry, tier) : undefined;
  }

  /* -- bytes -------------------------------------------------------------- */

  async fetchBytes(key: string, tier: QualityTier, signal?: AbortSignal): Promise<ArrayBuffer> {
    return (await this.fetchAsset(key, tier, signal)).bytes;
  }

  /**
   * Fetch an asset, walking down the tier chain on a miss.
   *
   * Rejects only when the asset is unknown or every tier has been tried; the
   * registry treats that as "use the fallback".
   */
  async fetchAsset(key: string, tier: QualityTier, signal?: AbortSignal): Promise<IFetchResult> {
    const entry = this.entriesById.get(key);
    if (!entry) throw new Error(`asset "${key}" is not in the manifest`);

    let attempt: QualityTier | undefined = this.availabilityValue.bestTierFor(entry, tier);
    while (attempt !== undefined) {
      const output = entry.outputs.find((candidate) => candidate.tier === attempt);
      if (output === undefined) break;
      const url = this.resolveFile(output.file);
      try {
        const bytes = await this.fetchUrl(url, signal);
        return { bytes, url, tier: attempt };
      } catch (error) {
        if (signal?.aborted === true) throw error;
        attempt = this.availabilityValue.markMissing(key, attempt, entry, String(error));
      }
    }
    throw new Error(`asset "${key}" is unavailable at every built tier`);
  }

  /** Raw fetch of a path relative to the generated root. */
  async fetchFile(file: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    return this.fetchUrl(this.resolveFile(file), signal);
  }

  private async fetchUrl(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    const init: RequestInit = { signal };
    if (this.cacheMode !== undefined) init.cache = this.cacheMode;
    const response = await this.doFetch(url, init);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return response.arrayBuffer();
  }

  /* -- misc --------------------------------------------------------------- */

  /**
   * True when the asset is inside the installed package.
   *
   * Reported honestly: over the dev server nothing is guaranteed offline, and
   * a tier that has already been observed missing is not offline either.
   */
  isAvailableOffline(key: string): boolean {
    const entry = this.entriesById.get(key);
    if (!entry) return false;
    if (this.resolvedSignals?.isNative !== true) return false;
    return this.availabilityValue.bestTierFor(entry, this.selectTier()) !== undefined;
  }

  /** Device signals the tier decision was made from. Empty until load. */
  get signals(): ITierSignals | undefined {
    return this.resolvedSignals;
  }

  selectTier(): QualityTier {
    return this.tierDecision.tier;
  }
}
