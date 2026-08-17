/**
 * PLATFORM CONTRACT
 *
 * Device capability detection and native-shell integration.
 *
 * TYPE-ONLY file. No runtime exports.
 *
 * ── THE THREE QUALITY AXES (read this before adding a fourth) ──────────────
 * The codebase deliberately keeps three separate, non-interchangeable tiers:
 *
 *   DeviceTier   (platform.ts) — what the HARDWARE is.    'low'|'mid'|'high'|'desktop'
 *   IQualityTier (engine.ts)   — how we RENDER.           'low'|'medium'|'high'
 *   QualityTier  (assets.ts)   — which ASSET VARIANT.     'mobile'|'high'|'ultra'
 *
 * DeviceTier is detected once at boot. It *suggests* an initial IQualityTier,
 * but the player may override render quality in settings without changing the
 * asset variant already downloaded. Never assume a 1:1 mapping.
 */

/** Detected hardware capability class. */
export type DeviceTier = 'low' | 'mid' | 'high' | 'desktop';

/** Host operating system / shell. */
export type PlatformKind = 'android' | 'ios' | 'web' | 'unknown';

/** Screen orientation. */
export type OrientationKind = 'portrait' | 'landscape';

/** Device safe-area insets in CSS pixels (notch / home indicator). */
export interface SafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Static device description, probed once at boot. */
export interface IPlatformInfo {
  readonly kind: PlatformKind;
  readonly tier: DeviceTier;
  /** True when running inside a Capacitor native shell. */
  readonly isNative: boolean;
  /** True when a touch screen is present. */
  readonly isTouch: boolean;
  /** `navigator.hardwareConcurrency`, or a conservative fallback. */
  readonly cpuCores: number;
  /** `navigator.deviceMemory` in GB when exposed, else undefined. */
  readonly memoryGB?: number;
  /** Physical device pixel ratio, BEFORE the renderer clamps it. */
  readonly devicePixelRatio: number;
  /** Logical screen size in CSS pixels. */
  readonly screen: { width: number; height: number };
  /** True when the OS requests reduced motion. */
  readonly prefersReducedMotion: boolean;
  /** Raw user-agent, for telemetry only — never branch on this. */
  readonly userAgent: string;
}

/** Battery / thermal signals used by the adaptive-quality governor. */
export interface IPowerState {
  /** 0..1, or undefined when the Battery API is unavailable. */
  readonly level?: number;
  readonly charging?: boolean;
  /** True when the OS or governor has requested reduced power draw. */
  readonly lowPowerMode: boolean;
  /**
   * Thermal pressure, if observable. Sustained 'serious' or worse should
   * trigger a quality downgrade.
   */
  readonly thermalState?: 'nominal' | 'fair' | 'serious' | 'critical';
}

/**
 * Native-shell facade. Web builds supply a no-op implementation so gameplay
 * code never branches on platform.
 */
export interface IPlatformAdapter {
  readonly info: IPlatformInfo;
  readonly safeArea: SafeAreaInsets;
  readonly orientation: OrientationKind;
  readonly power: IPowerState;

  /** Lock to an orientation. Resolves immediately on web. */
  lockOrientation(orientation: OrientationKind): Promise<void>;
  /** Hide or show the OS status bar. */
  setStatusBarVisible(visible: boolean): Promise<void>;
  /** Fire a haptic pulse. No-op where unsupported. */
  vibrate(pattern: HapticPattern): void;
  /** Keep the screen awake during play. */
  setKeepAwake(enabled: boolean): Promise<void>;
  /** Persist a small key/value blob (save games, settings). */
  storageSet(key: string, value: string): Promise<void>;
  /** Read a persisted blob. */
  storageGet(key: string): Promise<string | null>;
  /** Remove a persisted blob. */
  storageRemove(key: string): Promise<void>;
  /** App lifecycle: fired when backgrounded/foregrounded. */
  onAppStateChange(cb: (active: boolean) => void): () => void;
  /** Android hardware back button. Return true to consume the event. */
  onBackButton(cb: () => boolean): () => void;
  /** Re-read safe-area insets and orientation after a layout change. */
  refresh(): void;
}

/** Haptic feedback strength. Maps onto @capacitor/haptics impact styles. */
export type HapticPattern = 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error';
