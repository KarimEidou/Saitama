/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  window.__INPUT__ — THE E2E DRIVING SURFACE                              ║
 * ║                                                                          ║
 * ║  Installed automatically by `createInputManager()`. Playwright drives    ║
 * ║  the game through this and nothing else:                                 ║
 * ║                                                                          ║
 * ║    await page.evaluate(() => window.__INPUT__.setMove(0, 1));            ║
 * ║    await page.evaluate(() => window.__INPUT__.tap('punch'));             ║
 * ║    const s = await page.evaluate(() => window.__INPUT__.snapshot());     ║
 * ║                                                                          ║
 * ║  Everything it returns is JSON-serialisable, so it survives the          ║
 * ║  Playwright/CDP boundary unchanged.                                      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Shipping this in production builds is deliberate. It is the same surface the
 * final integration playthrough uses, it costs ~1 KB, and a build flavour that
 * differs from the tested one is worth less than the bytes it saves.
 */

import type { InputAction, InputState } from '@/types';
import type { IInputTuning } from './config';
import type { IInputManager } from './input-manager';
import type { IInputScriptStep } from './synthetic-source';
import { cloneInputState, describeInputState, type InputStatePatch } from './state';

/** Bridge version. Bump on any breaking change; downstream may assert on it. */
export const INPUT_BRIDGE_VERSION = 1;

export interface IInputTestBridge {
  readonly version: number;

  /* ---- arming ---- */
  /** Take control. Real touch/keyboard/gamepad are ignored while armed. */
  enable(): void;
  /** Hand control back to real devices and clear everything latched. */
  disable(): void;
  readonly enabled: boolean;

  /* ---- writing state (all latched; all auto-arm) ---- */
  setState(patch: InputStatePatch): void;
  setMove(x: number, y: number): void;
  setLook(x: number, y: number): void;
  press(action: InputAction, value?: number): void;
  release(action: InputAction): void;
  /** Held for exactly one poll. */
  tap(action: InputAction, value?: number): void;
  setPinch(delta: number): void;
  setTwist(radians: number): void;
  /** Release everything, keep control. */
  clear(): void;
  /** Release everything AND hand control back. */
  reset(): void;
  /** Queue a timed script, one step consumed per poll. */
  queue(steps: readonly IInputScriptStep[]): void;
  readonly scriptRunning: boolean;

  /* ---- reading ---- */
  /** Deep copy of the current frame's snapshot. JSON-safe. */
  snapshot(): InputState;
  /** One-line summary, for failure messages. */
  describe(): string;
  /**
   * Advance the input clock manually — ONLY for pages with no render loop
   * (like the input harness's step mode). A running game already polls.
   */
  step(frame?: number, time?: number): InputState;

  /* ---- configuration ---- */
  config(): IInputTuning;
  setConfig(patch: Partial<IInputTuning>): void;
  /** Show/hide the context-sensitive interact button. */
  setInteractPrompt(label: string | null): void;
  /** Force safe-area insets, for verifying notch-aware layout headlessly. */
  setSafeArea(insets: { top: number; right: number; bottom: number; left: number }): void;
  /** Cue counts, so a test can assert haptics fired without a vibrating CI box. */
  hapticCounts(): Readonly<Record<string, number>>;
  /** Which backend last produced input. */
  device(): string;
}

declare global {
  interface Window {
    /** Installed by `createInputManager()`. See `src/ui/input/test-bridge.ts`. */
    __INPUT__?: IInputTestBridge;
  }
}

/**
 * Build the bridge object. Exported separately from installation so a harness
 * can hold one without touching globals.
 */
export function createInputTestBridge(manager: IInputManager): IInputTestBridge {
  let stepFrame = 0;

  function arm(): void {
    if (!manager.syntheticEnabled) manager.syntheticEnabled = true;
  }

  return {
    version: INPUT_BRIDGE_VERSION,

    enable: arm,
    disable(): void {
      manager.syntheticEnabled = false;
    },
    get enabled(): boolean {
      return manager.syntheticEnabled;
    },

    setState(patch: InputStatePatch): void {
      arm();
      manager.synthetic.setState(patch);
    },
    setMove(x: number, y: number): void {
      arm();
      manager.synthetic.setMove(x, y);
    },
    setLook(x: number, y: number): void {
      arm();
      manager.synthetic.setLook(x, y);
    },
    press(action: InputAction, value?: number): void {
      arm();
      manager.synthetic.press(action, value);
    },
    release(action: InputAction): void {
      arm();
      manager.synthetic.release(action);
    },
    tap(action: InputAction, value?: number): void {
      arm();
      manager.synthetic.tap(action, value);
    },
    setPinch(delta: number): void {
      arm();
      manager.synthetic.setPinch(delta);
    },
    setTwist(radians: number): void {
      arm();
      manager.synthetic.setTwist(radians);
    },
    clear(): void {
      manager.synthetic.clear();
    },
    reset(): void {
      manager.synthetic.clear();
      manager.syntheticEnabled = false;
      manager.reset();
    },
    queue(steps: readonly IInputScriptStep[]): void {
      arm();
      manager.synthetic.queue(steps);
    },
    get scriptRunning(): boolean {
      return manager.synthetic.scriptRunning;
    },

    snapshot(): InputState {
      return cloneInputState(manager.state);
    },
    describe(): string {
      return describeInputState(manager.state);
    },
    step(frame?: number, time?: number): InputState {
      stepFrame = frame ?? stepFrame + 1;
      const t =
        time ??
        (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
      return cloneInputState(manager.poll(stepFrame, t));
    },

    config(): IInputTuning {
      return manager.tuning;
    },
    setConfig(patch: Partial<IInputTuning>): void {
      manager.setTuning(patch);
    },
    setInteractPrompt(label: string | null): void {
      manager.setInteractPrompt(label);
    },
    setSafeArea(insets: { top: number; right: number; bottom: number; left: number }): void {
      manager.setSafeArea(insets);
    },
    hapticCounts(): Readonly<Record<string, number>> {
      return { ...manager.haptics.counts };
    },
    device(): string {
      return manager.activeDevice;
    },
  };
}

/**
 * Install the bridge on `window`. Returns an uninstall function.
 * No-ops (returning a no-op) when there is no `window`.
 */
export function installInputTestBridge(manager: IInputManager): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const bridge = createInputTestBridge(manager);
  window.__INPUT__ = bridge;
  return () => {
    if (window.__INPUT__ === bridge) delete window.__INPUT__;
  };
}
