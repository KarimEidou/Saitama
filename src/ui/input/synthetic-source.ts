/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  SYNTHETIC INPUT — THE HEADLESS DRIVER                                   ║
 * ║                                                                          ║
 * ║  This is the entry point every other workstream uses to script gameplay. ║
 * ║  Do NOT fake `TouchEvent`s or `PointerEvent`s in a test; write an        ║
 * ║  `InputState` here and the game cannot tell the difference, because the  ║
 * ║  game only ever reads `InputState`.                                      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── SEMANTICS THAT MATTER ──────────────────────────────────────────────────
 *
 * LATCHED. Everything you set persists across frames until you change it or
 * call `clear()`. `setMove(1, 0)` then twenty `poll()`s = twenty frames of
 * walking east. This is what makes scripted playthroughs readable.
 *
 * REAL EDGES. Held state you inject flows through the SAME `ButtonTracker`
 * real input uses, so `pressed`/`released`/`holdTime` behave exactly as they
 * would under a thumb. `press('punch')` gives you `pressed` on the next poll
 * and `held` on every poll after — you cannot accidentally produce a
 * physically impossible snapshot such as "pressed for five frames running".
 *
 * ONE-FRAME TAPS. `tap('jump')` is held for exactly one poll and released on
 * the next, which is the shape gameplay code expects from a real tap.
 *
 * AUTHORITATIVE. While enabled, the synthetic backend is the ONLY backend the
 * manager reads, so a stray touch on a device running a scripted test cannot
 * corrupt the run. `InputState.device` reports `'synthetic'`, so gameplay can
 * assert it is being driven.
 */

import type { InputAction, PointerSample } from '@/types';
import type { IInputBackend, InputContribution } from './backend';
import { INPUT_ACTIONS } from './buttons';
import { buttonPatchValue, normaliseAxisPatch, type InputStatePatch } from './state';

/** One step of a scripted sequence. */
export interface IInputScriptStep {
  /** How many polls this step lasts. Minimum 1. */
  readonly frames: number;
  /** Applied on the step's first poll, merged over what is already latched. */
  readonly patch?: InputStatePatch;
  /** Fired as one-frame pulses on the step's first poll. */
  readonly taps?: readonly InputAction[];
  /** Optional label, surfaced by `currentStep` for debugging. */
  readonly label?: string;
}

export interface ISyntheticInput extends IInputBackend {
  /**
   * Merge a patch into the latched state. Deeply partial:
   * `{ move: { x: 1 }, buttons: { punch: true } }` is legal and the derived
   * fields (`magnitude`, `angle`, `active`) are computed for you.
   */
  setState(patch: InputStatePatch): void;
  /** Latch an action down until `release()`. `value` is the analogue level. */
  press(action: InputAction, value?: number): void;
  release(action: InputAction): void;
  /** Held for exactly one poll, released on the next. */
  tap(action: InputAction, value?: number): void;
  /** Movement stick, -1..1. Clamped to the unit circle. */
  setMove(x: number, y: number): void;
  /** Look RATE, -1..1 (1 == `tuning.lookFullRateDegPerSec`). */
  setLook(x: number, y: number): void;
  /** Pinch ratio for the NEXT poll only; 1 means unchanged. */
  setPinch(delta: number): void;
  /** Twist for the NEXT poll only, radians. */
  setTwist(radians: number): void;
  /** Raw pointer samples, normalised 0..1. Latched. */
  setPointers(pointers: readonly PointerSample[]): void;
  /** Release everything and un-latch. Does NOT disable the backend. */
  clear(): void;
  /** Queue a timed sequence; consumed one step per poll. Replaces any queue. */
  queue(steps: readonly IInputScriptStep[]): void;
  /** True while a queued script still has steps left. */
  readonly scriptRunning: boolean;
  /** Label of the step currently executing, or null. */
  readonly currentStep: string | null;
  /** The latched patch, for debug UI. */
  readonly latched: Readonly<InputStatePatch>;
}

export function createSyntheticSource(): ISyntheticInput {
  let enabled = false;
  const latchedButtons = new Map<InputAction, number>();
  const pulses = new Map<InputAction, number>();
  let move: { x: number; y: number } | null = null;
  let look: { x: number; y: number } | null = null;
  let pointers: readonly PointerSample[] = [];
  let pinchOnce = 1;
  let twistOnce = 0;

  let script: readonly IInputScriptStep[] = [];
  let scriptIndex = 0;
  let scriptFramesLeft = 0;
  let scriptStarted = false;

  function advanceScript(): void {
    if (scriptIndex >= script.length) {
      script = [];
      scriptIndex = 0;
      scriptFramesLeft = 0;
      scriptStarted = false;
      return;
    }
    const step = script[scriptIndex]!;
    if (!scriptStarted) {
      scriptStarted = true;
      scriptFramesLeft = Math.max(1, Math.floor(step.frames));
      if (step.patch) applyPatch(step.patch);
      if (step.taps) for (const action of step.taps) pulses.set(action, 1);
    }
    scriptFramesLeft--;
    if (scriptFramesLeft <= 0) {
      scriptIndex++;
      scriptStarted = false;
    }
  }

  function applyPatch(patch: InputStatePatch): void {
    if (patch.move !== undefined) {
      const axis = normaliseAxisPatch(patch.move);
      move = axis.active || axis.magnitude > 0 ? { x: axis.x, y: axis.y } : null;
    }
    if (patch.look !== undefined) {
      const axis = normaliseAxisPatch(patch.look);
      look = axis.active || axis.magnitude > 0 ? { x: axis.x, y: axis.y } : null;
    }
    if (patch.buttons) {
      for (const action of INPUT_ACTIONS) {
        if (!Object.prototype.hasOwnProperty.call(patch.buttons, action)) continue;
        const value = buttonPatchValue(patch.buttons[action]);
        if (value > 0) latchedButtons.set(action, value);
        else latchedButtons.delete(action);
      }
    }
    if (patch.pointers !== undefined) pointers = patch.pointers;
    if (patch.pinchDelta !== undefined) pinchOnce = patch.pinchDelta;
    if (patch.twistDelta !== undefined) twistOnce = patch.twistDelta;
  }

  return {
    device: 'synthetic',

    get enabled(): boolean {
      return enabled;
    },
    set enabled(value: boolean) {
      enabled = value;
    },

    sample(_dt: number, _time: number, out: InputContribution): void {
      if (!enabled) return;
      if (script.length > 0) advanceScript();

      if (move) {
        out.setMove(move.x, move.y);
        out.active = true;
      }
      if (look) {
        out.setLook(look.x, look.y);
        out.active = true;
      }
      for (const [action, value] of latchedButtons) out.hold(action, value);
      for (const [action, value] of pulses) out.pulse(action, value);
      pulses.clear();

      if (pointers.length > 0) {
        out.pointers = pointers.map((p) => ({ ...p }));
        out.active = true;
      }
      if (pinchOnce !== 1) {
        out.pinchDelta = pinchOnce;
        out.active = true;
        pinchOnce = 1;
      }
      if (twistOnce !== 0) {
        out.twistDelta = twistOnce;
        out.active = true;
        twistOnce = 0;
      }
      // A synthetic driver that is enabled is, by definition, driving — even a
      // deliberately neutral frame is an assertion about the input.
      out.active = true;
    },

    reset(): void {
      latchedButtons.clear();
      pulses.clear();
      move = null;
      look = null;
      pointers = [];
      pinchOnce = 1;
      twistOnce = 0;
      script = [];
      scriptIndex = 0;
      scriptFramesLeft = 0;
      scriptStarted = false;
    },

    dispose(): void {
      enabled = false;
      latchedButtons.clear();
      pulses.clear();
    },

    setState(patch: InputStatePatch): void {
      applyPatch(patch);
    },

    press(action: InputAction, value = 1): void {
      latchedButtons.set(action, Math.max(value, 1e-3));
    },

    release(action: InputAction): void {
      latchedButtons.delete(action);
    },

    tap(action: InputAction, value = 1): void {
      const prev = pulses.get(action) ?? 0;
      if (value > prev) pulses.set(action, Math.max(value, 1e-3));
    },

    setMove(x: number, y: number): void {
      move = x === 0 && y === 0 ? null : { x, y };
    },

    setLook(x: number, y: number): void {
      look = x === 0 && y === 0 ? null : { x, y };
    },

    setPinch(delta: number): void {
      pinchOnce = delta;
    },

    setTwist(radians: number): void {
      twistOnce = radians;
    },

    setPointers(next: readonly PointerSample[]): void {
      pointers = next;
    },

    clear(): void {
      latchedButtons.clear();
      pulses.clear();
      move = null;
      look = null;
      pointers = [];
      pinchOnce = 1;
      twistOnce = 0;
      script = [];
      scriptIndex = 0;
      scriptFramesLeft = 0;
      scriptStarted = false;
    },

    queue(steps: readonly IInputScriptStep[]): void {
      script = steps;
      scriptIndex = 0;
      scriptFramesLeft = 0;
      scriptStarted = false;
    },

    get scriptRunning(): boolean {
      return script.length > 0 && scriptIndex < script.length;
    },

    get currentStep(): string | null {
      if (!this.scriptRunning) return null;
      return script[scriptIndex]?.label ?? `step ${scriptIndex}`;
    },

    get latched(): Readonly<InputStatePatch> {
      const buttons: Partial<Record<InputAction, number>> = {};
      for (const [action, value] of latchedButtons) buttons[action] = value;
      return {
        move: move ? { x: move.x, y: move.y } : null,
        look: look ? { x: look.x, y: look.y } : null,
        buttons,
        pointers,
        pinchDelta: pinchOnce,
        twistDelta: twistOnce,
      };
    },
  };
}
