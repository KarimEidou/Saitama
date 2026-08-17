/**
 * TIER SELECTION AND PER-ASSET TIER FALLBACK
 *
 * ── THE BUG THIS MODULE EXISTS TO FIX ──────────────────────────────────────
 * `public/assets/assets.runtime.json` declares `tiersBuilt: ['mobile','high',
 * 'ultra']`, but the Android APK bundles the MOBILE tier only. Twenty-six
 * files the manifest names (13 `high` + 13 `ultra` — four HDRIs and nine
 * textures at each tier) are simply not inside the package. A runtime that
 * believes the manifest and asks for `high` on Android 404s on the very first
 * environment map, i.e. at startup, before anything is on screen.
 *
 * Two independent defences, because either alone is fragile:
 *
 *   1. SELECTION — a native/Capacitor build selects `mobile`, full stop. That
 *      is not a heuristic about how fast the phone is; it is a statement about
 *      what is inside the APK. It means the failing case issues ZERO requests
 *      for a tier that is not there, so there is no 404 to recover from.
 *
 *   2. FALLBACK — `TierAvailability` tracks, per asset and per tier, what has
 *      actually been served. A miss demotes that asset to the next lower tier
 *      it has an output for, and repeated misses at a tier demote the whole
 *      tier for every later asset. Nothing throws; the load continues one
 *      notch down.
 *
 * Defence 2 also covers the ordinary case that has nothing to do with Android:
 * of the 166 outputs in the manifest, only 13 exist at `high` and 13 at
 * `ultra`. A desktop that selects `high` must still resolve the other 153
 * assets to `mobile`, per asset, without anyone writing that down.
 */

import type { AnyAssetEntry, IAssetOutput, PlatformKind, QualityTier } from '@/types';
import { createLogger } from '@/util';
import { TIER_ORDER, TIER_RANK } from './constants';

const log = createLogger('assets:tier');

/* -------------------------------------------------------------------------- */
/* Device signals                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Everything tier selection is allowed to look at.
 *
 * Injected rather than read from globals so the decision is testable and so a
 * harness can pretend to be an Android device without a device.
 */
export interface ITierSignals {
  /** Running inside a Capacitor/Cordova native shell. */
  readonly isNative: boolean;
  readonly platform: PlatformKind;
  /** `navigator.deviceMemory` in GB, when exposed. */
  readonly deviceMemoryGB?: number;
  readonly cpuCores: number;
  /** GL `MAX_TEXTURE_SIZE`, when a renderer was available to ask. */
  readonly maxTextureSize?: number;
  /** `navigator.connection.saveData`. */
  readonly saveData: boolean;
  readonly devicePixelRatio: number;
}

interface INavigatorLike {
  readonly deviceMemory?: number;
  readonly hardwareConcurrency?: number;
  readonly userAgent?: string;
  readonly connection?: { readonly saveData?: boolean };
}

interface ICapacitorLike {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

/** True when a Capacitor native shell is hosting the page. */
export function isCapacitorNative(): boolean {
  const cap = (globalThis as { Capacitor?: ICapacitorLike }).Capacitor;
  return cap?.isNativePlatform?.() === true;
}

/** Best-effort host platform. Never branch on the raw user agent elsewhere. */
export function detectPlatform(): PlatformKind {
  const cap = (globalThis as { Capacitor?: ICapacitorLike }).Capacitor;
  const named = cap?.getPlatform?.();
  if (named === 'android' || named === 'ios' || named === 'web') return named;

  const ua = (globalThis as { navigator?: INavigatorLike }).navigator?.userAgent ?? '';
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  if (ua.length > 0) return 'web';
  return 'unknown';
}

/**
 * Probe the host for tier signals.
 *
 * `maxTextureSize` needs a live GL context, so pass the renderer when one
 * exists; without it the ceiling is treated as unknown rather than assumed.
 */
export function detectTierSignals(
  renderer?: { capabilities?: { maxTextureSize?: number } }
): ITierSignals {
  const nav = (globalThis as { navigator?: INavigatorLike }).navigator;
  return {
    isNative: isCapacitorNative(),
    platform: detectPlatform(),
    deviceMemoryGB: typeof nav?.deviceMemory === 'number' ? nav.deviceMemory : undefined,
    cpuCores: typeof nav?.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : 4,
    maxTextureSize: renderer?.capabilities?.maxTextureSize,
    saveData: nav?.connection?.saveData === true,
    devicePixelRatio: (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1,
  };
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                  */
/* -------------------------------------------------------------------------- */

/** A tier choice plus the reason, so a wrong choice can be diagnosed. */
export interface ITierDecision {
  readonly tier: QualityTier;
  /** Human-readable justification, surfaced in the boot diagnostics. */
  readonly reason: string;
  /** Tier chosen before clamping to what is actually built. */
  readonly requested: QualityTier;
}

export interface ITierSelectionOptions {
  /** Skip the heuristics entirely. Still clamped to `builtTiers`. */
  readonly forced?: QualityTier;
  /**
   * Tiers the manifest claims exist. The choice is clamped down to the best
   * of these; an empty or missing list is treated as "mobile only", which is
   * the safe direction to be wrong in.
   */
  readonly builtTiers?: readonly QualityTier[];
}

/** Clamp a tier down to the best entry present in `available`. */
export function clampTier(
  tier: QualityTier,
  available: readonly QualityTier[]
): QualityTier | undefined {
  const usable = TIER_ORDER.filter((candidate) => available.includes(candidate));
  if (usable.length === 0) return undefined;
  for (let i = TIER_RANK[tier]; i >= 0; i--) {
    const candidate = TIER_ORDER[i]!;
    if (usable.includes(candidate)) return candidate;
  }
  // Nothing at or below the request: take the cheapest thing that does exist.
  return usable[0];
}

/**
 * Pick the asset tier for this device.
 *
 * The native check comes FIRST and is not a performance judgement — see the
 * module header. A flagship Android phone still gets `mobile`, because that is
 * what shipped inside the package it is running from.
 */
export function selectQualityTier(
  signals: ITierSignals,
  options: ITierSelectionOptions = {}
): ITierDecision {
  const built = options.builtTiers?.length ? options.builtTiers : (['mobile'] as const);

  const decide = (): { tier: QualityTier; reason: string } => {
    if (options.forced) return { tier: options.forced, reason: `forced to '${options.forced}'` };

    if (signals.isNative) {
      return {
        tier: 'mobile',
        reason: 'native shell: only the mobile tier is packaged in the app bundle',
      };
    }
    if (signals.platform === 'android' || signals.platform === 'ios') {
      return { tier: 'mobile', reason: `${signals.platform} browser: mobile asset set` };
    }
    if (signals.saveData) {
      return { tier: 'mobile', reason: 'navigator.connection.saveData is set' };
    }

    const memory = signals.deviceMemoryGB;
    if (typeof memory === 'number' && memory <= 4) {
      return { tier: 'mobile', reason: `deviceMemory ${memory} GB` };
    }
    if (signals.cpuCores <= 2) {
      return { tier: 'mobile', reason: `${signals.cpuCores} logical cores` };
    }
    if (typeof signals.maxTextureSize === 'number' && signals.maxTextureSize < 4096) {
      return { tier: 'mobile', reason: `MAX_TEXTURE_SIZE ${signals.maxTextureSize}` };
    }

    const roomy = (memory ?? 0) >= 12 && signals.cpuCores >= 12;
    const bigTextures = (signals.maxTextureSize ?? 0) >= 8192;
    if (roomy && bigTextures) {
      return {
        tier: 'ultra',
        reason: `${memory} GB / ${signals.cpuCores} cores / ${signals.maxTextureSize}px textures`,
      };
    }
    return { tier: 'high', reason: 'desktop-class defaults' };
  };

  const { tier: requested, reason } = decide();
  const clamped = clampTier(requested, built);
  if (clamped === undefined) {
    log.warn(`manifest declares no built tiers; falling back to 'mobile'`);
    return { tier: 'mobile', requested, reason: `${reason} (no tiers declared built)` };
  }
  if (clamped !== requested) {
    return {
      tier: clamped,
      requested,
      reason: `${reason}; clamped to '${clamped}' (built: ${built.join(', ')})`,
    };
  }
  return { tier: clamped, requested, reason };
}

/* -------------------------------------------------------------------------- */
/* Availability                                                               */
/* -------------------------------------------------------------------------- */

/** One recorded miss, for diagnostics and for the harness to assert on. */
export interface ITierMiss {
  readonly key: string;
  readonly tier: QualityTier;
  readonly reason: string;
}

/**
 * What the manifest PROMISED, corrected by what the server actually served.
 *
 * The manifest is a build-time artefact and can outlive the package it
 * describes — that is exactly the Android case. This class is the runtime's
 * memory of the difference.
 */
export class TierAvailability {
  private readonly missed = new Set<string>();
  private readonly deadTiers = new Set<QualityTier>();
  private readonly misses: ITierMiss[] = [];

  constructor(
    /** Tiers the manifest claims were built. */
    private readonly builtTiers: readonly QualityTier[],
    /**
     * Consecutive misses at one tier before the whole tier is written off.
     * One miss is a gap in the build; three is a tier that was not shipped.
     */
    private readonly tierWriteOffThreshold = 3
  ) {}

  /** Every miss recorded so far, oldest first. */
  get recordedMisses(): readonly ITierMiss[] {
    return this.misses;
  }

  /** Tiers written off wholesale after repeated misses. */
  get unavailableTiers(): readonly QualityTier[] {
    return [...this.deadTiers];
  }

  /** True when this tier has not been written off. */
  isTierUsable(tier: QualityTier): boolean {
    return !this.deadTiers.has(tier);
  }

  /** True when this exact asset+tier is known to be absent. */
  isMissing(key: string, tier: QualityTier): boolean {
    return this.missed.has(`${key}@${tier}`);
  }

  /**
   * Record that `key` was not served at `tier`.
   *
   * Returns the next tier to try, or undefined when the asset has no cheaper
   * variant left. Callers must treat undefined as "use the fallback", never as
   * an error to throw.
   */
  markMissing(key: string, tier: QualityTier, entry: AnyAssetEntry, reason: string): QualityTier | undefined {
    const id = `${key}@${tier}`;
    if (!this.missed.has(id)) {
      this.missed.add(id);
      this.misses.push({ key, tier, reason });

      const atThisTier = this.misses.filter((miss) => miss.tier === tier).length;
      if (atThisTier >= this.tierWriteOffThreshold && !this.deadTiers.has(tier)) {
        this.deadTiers.add(tier);
        log.warn(
          `tier '${tier}' written off after ${atThisTier} misses — the manifest ` +
            `declares it built but the package does not contain it. Later assets ` +
            `skip '${tier}' entirely rather than 404 one at a time.`
        );
      } else {
        log.warn(`asset "${key}" is absent at tier '${tier}' (${reason}); trying a lower tier`);
      }
    }
    const chain = this.chainFor(entry, tier);
    return chain.find((candidate) => TIER_RANK[candidate] < TIER_RANK[tier]);
  }

  /**
   * Tiers worth trying for one asset, best first.
   *
   * Only tiers the asset genuinely has an output for, that the manifest says
   * were built, that have not been written off, and that are not already known
   * missing for this asset. Downgrade only: an asset with just a `mobile`
   * output must not be silently served at `ultra` quality it does not have,
   * and a device that asked for `mobile` must not be handed a 4K texture.
   */
  chainFor(entry: AnyAssetEntry, preferred: QualityTier): readonly QualityTier[] {
    const outputs = new Set(entry.outputs.map((output: IAssetOutput) => output.tier));
    const chain: QualityTier[] = [];
    for (let rank = TIER_RANK[preferred]; rank >= 0; rank--) {
      const tier = TIER_ORDER[rank]!;
      if (!outputs.has(tier)) continue;
      if (!this.builtTiers.includes(tier)) continue;
      if (this.deadTiers.has(tier)) continue;
      if (this.missed.has(`${entry.id}@${tier}`)) continue;
      chain.push(tier);
    }
    if (chain.length === 0) {
      // Nothing at or below the request. An asset built ONLY at a higher tier
      // is still better than no asset, so look upwards as a last resort.
      for (let rank = TIER_RANK[preferred] + 1; rank < TIER_ORDER.length; rank++) {
        const tier = TIER_ORDER[rank]!;
        if (!outputs.has(tier)) continue;
        if (this.deadTiers.has(tier)) continue;
        if (this.missed.has(`${entry.id}@${tier}`)) continue;
        chain.push(tier);
      }
    }
    return chain;
  }

  /** The tier this asset should be fetched at right now, if any. */
  bestTierFor(entry: AnyAssetEntry, preferred: QualityTier): QualityTier | undefined {
    return this.chainFor(entry, preferred)[0];
  }
}
