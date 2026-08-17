/**
 * HAPTICS — `@capacitor/haptics`, defused.
 *
 * ── WHY THIS WRAPPER EXISTS ────────────────────────────────────────────────
 * `@capacitor/haptics`' web implementation calls `navigator.vibrate` and
 * THROWS `unavailable(...)` when the browser has no vibration API. Because the
 * plugin methods are `async`, that throw becomes a rejected promise, and an
 * unhandled rejection in a game loop is a console full of noise at best and a
 * crashed frame at worst. Desktop Chrome, Safari, and every headless browser
 * used for CI are all in that bucket.
 *
 * So: the plugin is imported LAZILY (never at module scope, so a Node/vitest
 * import graph stays clean), capability is probed BEFORE calling, and every
 * promise is caught. `play()` is fire-and-forget and can never throw.
 *
 * The three cues the design calls for are `chargeComplete`, `kill` and
 * `landing`. Input owns `chargeComplete` because it owns the charge timer;
 * combat and the player controller fire the other two through this same
 * object, reachable as `inputManager.haptics`.
 */

import type { HapticPattern } from '@/types';
import { createLogger } from '@/util';

const log = createLogger('input.haptics');

/** Named game cues. Kept semantic so the mapping can be re-tuned in one place. */
export type HapticCue =
  'chargeComplete' | 'kill' | 'landing' | 'hit' | 'gesture' | 'uiTap' | 'error';

/** Minimum gap between two identical cues; stops a rumble from machine-gunning. */
const CUE_COOLDOWN_MS: Readonly<Record<HapticCue, number>> = {
  chargeComplete: 250,
  kill: 120,
  landing: 90,
  hit: 40,
  gesture: 60,
  uiTap: 30,
  error: 300,
};

/** Cue -> the platform pattern in `@/types`. */
const CUE_PATTERN: Readonly<Record<HapticCue, HapticPattern>> = {
  chargeComplete: 'success',
  kill: 'heavy',
  landing: 'medium',
  hit: 'light',
  gesture: 'light',
  uiTap: 'light',
  error: 'error',
};

export interface IHaptics {
  enabled: boolean;
  /** Fire a cue. Never throws, never rejects, no-ops when unsupported. */
  play(cue: HapticCue): void;
  /** True when something will actually be felt. */
  readonly supported: boolean;
  /** Cue counts since construction — the harness asserts on these. */
  readonly counts: Readonly<Record<string, number>>;
  dispose(): void;
}

/** Minimal shape we need from the plugin; avoids a hard type dependency. */
interface HapticsPluginLike {
  impact(options: { style: string }): Promise<void>;
  notification(options: { type: string }): Promise<void>;
}

/** Capacitor's `ImpactStyle`/`NotificationType` string values, inlined. */
const IMPACT_STYLE: Record<string, string> = { light: 'LIGHT', medium: 'MEDIUM', heavy: 'HEAVY' };
const NOTIFICATION_TYPE: Record<string, string> = {
  success: 'SUCCESS',
  warning: 'WARNING',
  error: 'ERROR',
};

export interface IHapticsOptions {
  readonly enabled?: boolean;
  /** Inject a stub. Used by tests and by the harness to count cues. */
  readonly impl?: HapticsPluginLike | null;
  /** Override capability detection (the harness forces it on to count cues). */
  readonly forceSupported?: boolean;
}

/**
 * Create the haptics sink.
 *
 * Never awaits the plugin import on the hot path: the first `play()` kicks off
 * the dynamic import and returns immediately, so the first cue may be dropped
 * on a cold start. That is the correct trade — a 2 ms buzz is not worth a
 * frame hitch, and a charge takes a full second to fill anyway.
 */
export function createHaptics(options: IHapticsOptions = {}): IHaptics {
  let enabled = options.enabled ?? true;
  let plugin: HapticsPluginLike | null = options.impl ?? null;
  let loading = false;
  let loadFailed = false;
  const lastFired = new Map<HapticCue, number>();
  const counts: Record<string, number> = {};

  const hasVibrate =
    typeof navigator !== 'undefined' &&
    typeof (navigator as Navigator & { vibrate?: unknown }).vibrate === 'function';
  const isNative =
    typeof globalThis !== 'undefined' &&
    (
      globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }
    ).Capacitor?.isNativePlatform?.() === true;

  const supported = options.forceSupported ?? (options.impl != null || hasVibrate || isNative);

  function ensurePlugin(): void {
    if (plugin || loading || loadFailed) return;
    loading = true;
    // Dynamic: keeps `@capacitor/haptics` out of the Node/vitest import graph
    // and out of the initial bundle.
    import('@capacitor/haptics')
      .then((module) => {
        plugin = module.Haptics as unknown as HapticsPluginLike;
      })
      .catch((error: unknown) => {
        loadFailed = true;
        log.warn('haptics plugin unavailable', error);
      })
      .finally(() => {
        loading = false;
      });
  }

  function fire(pattern: HapticPattern): void {
    const target = plugin;
    if (!target) return;
    try {
      const impact = IMPACT_STYLE[pattern];
      const promise = impact
        ? target.impact({ style: impact })
        : target.notification({ type: NOTIFICATION_TYPE[pattern] ?? 'SUCCESS' });
      // Both the web fallback and a missing native bridge reject; swallow.
      void promise?.catch?.(() => undefined);
    } catch {
      /* never let a buzz break a frame */
    }
  }

  return {
    get enabled(): boolean {
      return enabled;
    },
    set enabled(value: boolean) {
      enabled = value;
    },

    get supported(): boolean {
      return supported;
    },

    get counts(): Readonly<Record<string, number>> {
      return counts;
    },

    play(cue: HapticCue): void {
      counts[cue] = (counts[cue] ?? 0) + 1;
      if (!enabled || !supported) return;
      const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const last = lastFired.get(cue) ?? -Infinity;
      if (nowMs - last < CUE_COOLDOWN_MS[cue]) return;
      lastFired.set(cue, nowMs);
      ensurePlugin();
      fire(CUE_PATTERN[cue]);
    },

    dispose(): void {
      enabled = false;
      plugin = null;
      lastFired.clear();
    },
  };
}

/** A haptics sink that only counts. Default in tests and on unsupported hosts. */
export function createNullHaptics(): IHaptics {
  const counts: Record<string, number> = {};
  return {
    enabled: false,
    supported: false,
    counts,
    play(cue: HapticCue): void {
      counts[cue] = (counts[cue] ?? 0) + 1;
    },
    dispose(): void {},
  };
}
