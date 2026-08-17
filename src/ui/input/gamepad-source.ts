/**
 * GAMEPAD BACKEND — Gamepad API, polled.
 *
 * The Gamepad API has no events for button state; it is a poll-only API, which
 * suits a game loop perfectly and is why this backend has no listeners beyond
 * connect/disconnect logging.
 *
 * Parity with touch and keyboard is preserved the same way as everywhere else:
 * axes go through `radialDeadZone` + `squareToCircle` (a physical stick's gate
 * is square, so its corner must be mapped rather than clipped), the punch
 * button shares `ChargeTracker`, and edges are derived downstream by the one
 * shared `ButtonTracker`.
 *
 * `getGamepads` is injectable so the unit tests can hand it a literal
 * `{ axes, buttons }` and assert the resulting `InputState` matches the
 * keyboard's byte for byte.
 */

import type { InputAction } from '@/types';
import { createLogger } from '@/util';
import { radialDeadZone, squareToCircle } from './axis';
import type { IInputBackend, InputContribution } from './backend';
import type { IInputTuning } from './config';
import { ChargeTracker } from './look';

const log = createLogger('input.gamepad');

/** The bits of `Gamepad` we use. Structural, so tests can fake it trivially. */
export interface GamepadLike {
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[];
  readonly mapping?: string;
  readonly connected?: boolean;
  readonly id?: string;
  readonly index?: number;
}

/**
 * Standard-mapping button indices -> actions.
 *
 * Chosen so the four TOUCH buttons land under the four thumb-reachable face
 * buttons and the dash/sprint toggle lands on L3, matching the on-screen
 * layout's ergonomics rather than a spreadsheet.
 */
export const DEFAULT_GAMEPAD_MAP: Readonly<Record<number, InputAction>> = Object.freeze({
  0: 'jump', // A / Cross
  1: 'dodge', // B / Circle
  2: 'punch', // X / Square
  3: 'interact', // Y / Triangle
  4: 'block', // LB
  5: 'special', // RB
  6: 'toggleIntent', // LT (analogue)
  7: 'heavyPunch', // RT (analogue)
  8: 'map', // Back / Select
  9: 'pause', // Start
  10: 'sprint', // L3
  11: 'lockOn', // R3
  16: 'debugToggle', // Guide
});

/** D-pad indices, as square-domain unit vectors (positive y is up). */
const DPAD: Readonly<Record<number, readonly [number, number]>> = Object.freeze({
  12: [0, 1],
  13: [0, -1],
  14: [-1, 0],
  15: [1, 0],
});

/** Indices whose analogue value should be used verbatim. */
const ANALOGUE_BUTTONS = new Set([6, 7]);

export interface IGamepadSourceOptions {
  /** Injectable for tests. Defaults to `navigator.getGamepads()`. */
  readonly getGamepads?: () => readonly (GamepadLike | null)[];
  readonly buttonMap?: Readonly<Record<number, InputAction>>;
  /** Which pad index to read. `null` = first connected. */
  readonly padIndex?: number | null;
  readonly onChargeComplete?: () => void;
}

export interface IGamepadInputSource extends IInputBackend {
  setTuning(tuning: IInputTuning): void;
  /** Id of the pad currently being read, or null. */
  readonly connectedId: string | null;
}

export function createGamepadSource(
  tuning: IInputTuning,
  options: IGamepadSourceOptions = {}
): IGamepadInputSource {
  let activeTuning = tuning;
  const buttonMap = options.buttonMap ?? DEFAULT_GAMEPAD_MAP;
  const charge = new ChargeTracker();
  const pendingPulses = new Map<InputAction, number>();
  let enabled = true;
  let disposed = false;
  let connectedId: string | null = null;
  let punchWasDown = false;

  const getGamepads =
    options.getGamepads ??
    (() => {
      if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
        return [];
      }
      return navigator.getGamepads() as readonly (GamepadLike | null)[];
    });

  function onConnect(event: Event): void {
    const pad = (event as GamepadEvent).gamepad;
    log.info(`gamepad connected: ${pad?.id ?? 'unknown'}`);
  }
  function onDisconnect(): void {
    reset();
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('gamepadconnected', onConnect);
    window.addEventListener('gamepaddisconnected', onDisconnect);
  }

  function pickPad(): GamepadLike | null {
    const pads = getGamepads();
    if (options.padIndex != null) return pads[options.padIndex] ?? null;
    for (const pad of pads) {
      if (pad && pad.connected !== false) return pad;
    }
    return null;
  }

  function reset(): void {
    charge.reset();
    pendingPulses.clear();
    punchWasDown = false;
    connectedId = null;
  }

  return {
    device: 'gamepad',

    get enabled(): boolean {
      return enabled;
    },
    set enabled(value: boolean) {
      if (enabled === value) return;
      enabled = value;
      if (!value) reset();
    },

    get connectedId(): string | null {
      return connectedId;
    },

    sample(dt: number, time: number, out: InputContribution): void {
      if (!enabled) return;
      const pad = pickPad();
      if (!pad) {
        if (punchWasDown) {
          // Pad yanked mid-charge: abandon it rather than firing a phantom blow.
          charge.cancel();
          punchWasDown = false;
        }
        connectedId = null;
        return;
      }
      connectedId = pad.id ?? 'gamepad';

      /* ---- sticks ---- */
      const lx = pad.axes[0] ?? 0;
      // Gamepad Y is positive DOWN; `AxisState.y` is positive UP.
      const ly = -(pad.axes[1] ?? 0);
      let mx = lx;
      let my = ly;
      // D-pad merges into the left stick, in the same square domain.
      for (const [indexText, vector] of Object.entries(DPAD)) {
        const index = Number(indexText);
        if (pad.buttons[index]?.pressed) {
          mx += vector[0];
          my += vector[1];
        }
      }
      // ORDER MATTERS: square -> circle FIRST, dead zone SECOND.
      // The stick's physical gate is a square, so (1,1) is its true corner and
      // must land ON the unit circle. Dead-zoning first would already have
      // normalised the corner to magnitude 1, and the subsequent mapping would
      // then shrink it to 0.866 — a diagonal 13% slower than a cardinal, on
      // gamepad only. That is exactly the parity bug this ordering prevents.
      const mappedMove = squareToCircle(mx, my);
      const deadZoned = radialDeadZone(mappedMove.x, mappedMove.y, activeTuning.gamepadDeadZone);
      if (deadZoned.x !== 0 || deadZoned.y !== 0) {
        out.setMove(deadZoned.x, deadZoned.y);
        out.active = true;
      }

      const rx = pad.axes[2] ?? 0;
      const ry = -(pad.axes[3] ?? 0);
      const mappedLook = squareToCircle(rx, ry);
      const lookDead = radialDeadZone(mappedLook.x, mappedLook.y, activeTuning.gamepadDeadZone);
      if (lookDead.x !== 0 || lookDead.y !== 0) {
        out.setLook(lookDead.x, activeTuning.invertLookY ? -lookDead.y : lookDead.y);
        out.active = true;
      }

      /* ---- buttons ---- */
      let punchDown = false;
      for (let index = 0; index < pad.buttons.length; index++) {
        const button = pad.buttons[index];
        if (!button) continue;
        const action = buttonMap[index];
        if (!action) continue;
        const analogue = ANALOGUE_BUTTONS.has(index);
        const value = analogue ? button.value : button.pressed ? 1 : 0;
        const isDown = analogue ? value >= activeTuning.triggerThreshold : button.pressed;
        if (!isDown) continue;
        // The RT trigger is a direct heavy attack; the charged punch still
        // comes from holding X, exactly as it comes from holding the on-screen
        // punch button.
        out.hold(action, analogue ? value : 1);
        if (action === 'punch') punchDown = true;
      }

      if (punchDown && !punchWasDown) charge.press();
      if (!punchDown && punchWasDown) {
        const ratio = charge.release(activeTuning);
        if (ratio !== null) {
          const prev = pendingPulses.get('heavyPunch') ?? 0;
          const value = Math.max(ratio, 1e-3);
          if (value > prev) pendingPulses.set('heavyPunch', value);
        }
      }
      punchWasDown = punchDown;
      if (punchDown && charge.tick(dt, activeTuning)) options.onChargeComplete?.();

      for (const [action, value] of pendingPulses) out.pulse(action, value);
      pendingPulses.clear();
    },

    reset,

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (typeof window !== 'undefined') {
        window.removeEventListener('gamepadconnected', onConnect);
        window.removeEventListener('gamepaddisconnected', onDisconnect);
      }
      reset();
    },

    setTuning(next: IInputTuning): void {
      activeTuning = next;
    },
  };
}
