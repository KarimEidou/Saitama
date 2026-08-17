/**
 * KEYBOARD (+ MOUSE) BACKEND
 *
 * Produces contributions structurally identical to the touch backend's, which
 * is what lets the desktop build and every automated test drive the real game
 * loop. Two design choices carry that guarantee:
 *
 *  • WASD is a SQUARE source (W+D is the corner (1,1)). It goes through
 *    `squareToCircle()`, so a diagonal reaches magnitude 1.0 exactly like a
 *    120px diagonal drag on the virtual stick. Naively normalising the corner
 *    instead would make keyboard diagonals 29% slower than touch diagonals —
 *    subtle enough to survive review and obvious enough to ruin a speedrun.
 *
 *  • The punch key runs through the SAME `ChargeTracker` the punch button
 *    uses, with the same thresholds. Tap J and you get `punch.pressed`; hold
 *    it and you get `heavyPunch.pressed` on release with the same ratio.
 *
 * Every handler is also exposed as a plain method (`keyDown('KeyW')`), so the
 * unit tests can drive it in Node with no DOM and no synthetic KeyboardEvents.
 */

import type { InputAction } from '@/types';
import { createLogger } from '@/util';
import { squareToCircle } from './axis';
import type { IInputBackend, InputContribution } from './backend';
import type { IInputTuning } from './config';
import { ChargeTracker, LookSmoother } from './look';

const log = createLogger('input.keyboard');

/**
 * `KeyboardEvent.code` -> action. Codes, not `key`, so the layout is physical
 * and identical on AZERTY/QWERTZ.
 */
export const DEFAULT_KEY_MAP: Readonly<Record<string, InputAction>> = Object.freeze({
  Space: 'jump',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  KeyJ: 'punch',
  KeyL: 'special',
  KeyE: 'interact',
  KeyF: 'interact',
  KeyQ: 'lockOn',
  Tab: 'lockOn',
  ControlLeft: 'dodge',
  KeyC: 'dodge',
  KeyV: 'block',
  Escape: 'pause',
  KeyP: 'pause',
  KeyM: 'map',
  Home: 'cameraReset',
  KeyT: 'toggleIntent',
  Backquote: 'debugToggle',
  F3: 'debugToggle',
});

/** Movement keys, as unit vectors in the SQUARE domain (positive y is up). */
const MOVE_KEYS: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  KeyW: [0, 1],
  ArrowUp: [0, 1],
  KeyS: [0, -1],
  ArrowDown: [0, -1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
});

/** Arrow-free look keys, so a keyboard-only tester can still turn the camera. */
const LOOK_KEYS: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  KeyI: [0, 1],
  KeyK: [0, -1],
  Comma: [-1, 0],
  Period: [1, 0],
});

/** Degrees/second applied by a held look key. Matches a full stick deflection. */
const KEY_LOOK_RATE = 1;

export interface IKeyboardSourceOptions {
  /** Where to listen. Defaults to `window`. Pass `null` for a headless source. */
  readonly target?: EventTarget | null;
  /** Also drive `look` from mouse movement while the pointer is locked. */
  readonly mouseLook?: boolean;
  readonly keyMap?: Readonly<Record<string, InputAction>>;
  /** Fired the instant a held punch key completes its charge (haptic cue). */
  readonly onChargeComplete?: () => void;
}

export interface IKeyboardInputSource extends IInputBackend {
  /** Drive a key down without a DOM event. The tests use this. */
  keyDown(code: string): void;
  keyUp(code: string): void;
  /** Feed raw mouse-look pixels (already relative). */
  mouseMove(dxPx: number, dyPx: number): void;
  setTuning(tuning: IInputTuning): void;
  /** Codes currently held, for debug UI. */
  heldKeys(): string[];
}

export function createKeyboardSource(
  tuning: IInputTuning,
  options: IKeyboardSourceOptions = {}
): IKeyboardInputSource {
  let activeTuning = tuning;
  const keyMap = options.keyMap ?? DEFAULT_KEY_MAP;
  const held = new Set<string>();
  const charge = new ChargeTracker();
  const look = new LookSmoother();
  const pendingPulses = new Map<InputAction, number>();
  const pendingSilent = new Set<InputAction>();
  let mouseDx = 0;
  let mouseDy = 0;
  let enabled = true;
  let disposed = false;

  const target =
    options.target === undefined ? (typeof window !== 'undefined' ? window : null) : options.target;

  function pulse(action: InputAction, value = 1): void {
    const prev = pendingPulses.get(action) ?? 0;
    if (value > prev) pendingPulses.set(action, value);
  }

  function keyDown(code: string): void {
    if (!enabled) return;
    if (held.has(code)) return; // ignore auto-repeat
    held.add(code);
    if (keyMap[code] === 'punch') charge.press();
  }

  function keyUp(code: string): void {
    if (!held.delete(code)) return;
    if (keyMap[code] === 'punch') {
      const ratio = charge.release(activeTuning);
      if (ratio !== null) pulse('heavyPunch', Math.max(ratio, 1e-3));
    }
  }

  /* ---------------------------------------------------------------------- */
  /* DOM wiring                                                             */
  /* ---------------------------------------------------------------------- */

  function onKeyDown(event: Event): void {
    const e = event as KeyboardEvent;
    if (e.repeat) return;
    const code = e.code;
    if (!code) return;
    if (isBound(code)) {
      // Tab would move focus out of the canvas; F3/backquote open dev panels.
      if (code === 'Tab' || code === 'F3') e.preventDefault();
      keyDown(code);
    }
  }

  function onKeyUp(event: Event): void {
    const code = (event as KeyboardEvent).code;
    if (code) keyUp(code);
  }

  function onBlur(): void {
    reset();
  }

  function onMouseMove(event: Event): void {
    if (!options.mouseLook) return;
    if (typeof document !== 'undefined' && document.pointerLockElement === null) return;
    const e = event as MouseEvent;
    mouseDx += e.movementX ?? 0;
    mouseDy += e.movementY ?? 0;
  }

  function isBound(code: string): boolean {
    return code in keyMap || code in MOVE_KEYS || code in LOOK_KEYS;
  }

  if (target) {
    target.addEventListener('keydown', onKeyDown);
    target.addEventListener('keyup', onKeyUp);
    target.addEventListener('blur', onBlur);
    if (options.mouseLook) target.addEventListener('mousemove', onMouseMove);
    log.info('keyboard backend attached');
  }

  function reset(): void {
    held.clear();
    charge.reset();
    look.reset();
    pendingPulses.clear();
    pendingSilent.clear();
    mouseDx = 0;
    mouseDy = 0;
  }

  return {
    device: 'keyboard',

    get enabled(): boolean {
      return enabled;
    },
    set enabled(value: boolean) {
      if (enabled === value) return;
      enabled = value;
      if (!value) reset();
    },

    sample(dt: number, time: number, out: InputContribution): void {
      if (!enabled) return;

      /* ---- movement: square domain -> circle ---- */
      let sx = 0;
      let sy = 0;
      for (const code of held) {
        const vector = MOVE_KEYS[code];
        if (vector) {
          sx += vector[0];
          sy += vector[1];
        }
      }
      if (sx !== 0 || sy !== 0) {
        const mapped = squareToCircle(Math.max(-1, Math.min(1, sx)), Math.max(-1, Math.min(1, sy)));
        out.setMove(mapped.x, mapped.y);
        out.active = true;
      }

      /* ---- look: keys are a rate, mouse is a delta ---- */
      let lookKeyX = 0;
      let lookKeyY = 0;
      for (const code of held) {
        const vector = LOOK_KEYS[code];
        if (vector) {
          lookKeyX += vector[0];
          lookKeyY += vector[1];
        }
      }
      const rate = look.update(mouseDx, mouseDy, dt, activeTuning);
      mouseDx = 0;
      mouseDy = 0;

      if (lookKeyX !== 0 || lookKeyY !== 0) {
        const mapped = squareToCircle(
          Math.max(-1, Math.min(1, lookKeyX)) * KEY_LOOK_RATE,
          Math.max(-1, Math.min(1, lookKeyY)) * KEY_LOOK_RATE
        );
        out.setLook(mapped.x, mapped.y);
        out.active = true;
      } else if (!look.settled) {
        out.setLook(rate.x, rate.y);
        out.active = true;
      }

      /* ---- buttons ---- */
      let punchHeld = false;
      for (const code of held) {
        const action = keyMap[code];
        if (!action) continue;
        out.hold(action, 1);
        if (action === 'punch') punchHeld = true;
      }
      // Same `ChargeTracker`, same thresholds as the on-screen punch button —
      // that identity is the whole point of the keyboard path.
      if (punchHeld && charge.tick(dt, activeTuning)) options.onChargeComplete?.();

      for (const [action, value] of pendingPulses) out.pulse(action, value);
      pendingPulses.clear();
      for (const action of pendingSilent) out.clearSilently(action);
      pendingSilent.clear();

      if (held.size > 0) out.active = true;
    },

    reset,

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (target) {
        target.removeEventListener('keydown', onKeyDown);
        target.removeEventListener('keyup', onKeyUp);
        target.removeEventListener('blur', onBlur);
        if (options.mouseLook) target.removeEventListener('mousemove', onMouseMove);
      }
      reset();
    },

    keyDown,
    keyUp,

    mouseMove(dxPx: number, dyPx: number): void {
      mouseDx += dxPx;
      mouseDy += dyPx;
    },

    setTuning(next: IInputTuning): void {
      activeTuning = next;
    },

    heldKeys(): string[] {
      return [...held].sort();
    },
  };
}
