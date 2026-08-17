/**
 * INPUT MANAGER — the single `IInputSource` the game holds.
 *
 * Owns every backend, folds their contributions into one `InputState` per
 * frame, and arbitrates which device gets to claim `state.device`.
 *
 * ── MERGE RULES (deliberate, and load-bearing for parity) ──────────────────
 *  • BUTTONS merge with `max` across backends. Holding Shift on a keyboard
 *    while the on-screen dash toggle is on is one `sprint`, not a fight.
 *  • AXES take the contribution with the LARGEST magnitude, ties broken by the
 *    most recently active backend. Deterministic, and it means an idle
 *    gamepad resting at 0.02 never overrides a thumb at 0.9.
 *  • EDGES are computed exactly once, in the manager's single `ButtonTracker`.
 *    No backend can produce an edge on its own, which is why "keyboard and
 *    touch produce the identical InputState" is a structural property rather
 *    than something we hope stays true.
 *  • SYNTHETIC, when enabled, is exclusive: every other backend is skipped.
 */

import type {
  IInputSource,
  InputDevice,
  InputState,
  PointerSample,
  SafeAreaInsets,
} from '@/types';
import { createLogger } from '@/util';
import { axisFromVector, NEUTRAL_AXIS } from './axis';
import { InputContribution, type IInputBackend } from './backend';
import { ButtonTracker } from './buttons';
import { resolveTuning, type IInputTuning } from './config';
import { createGamepadSource, type IGamepadInputSource } from './gamepad-source';
import { createHaptics, createNullHaptics, type IHaptics } from './haptics';
import { createKeyboardSource, type IKeyboardInputSource } from './keyboard-source';
import { createSyntheticSource, type ISyntheticInput } from './synthetic-source';
import { deriveAnyActive, neutralInputState, type InputStatePatch } from './state';
import { installInputTestBridge } from './test-bridge';
import { createTouchSource, type ITouchInputSource } from './touch-source';
import type { GestureEvent } from './touch-core';

const log = createLogger('input');

/** Shared frozen empty pointer list; avoids an allocation on idle frames. */
const EMPTY_POINTERS: readonly PointerSample[] = Object.freeze([]);

/** Centred but being driven — a thumb resting inside the stick's dead zone. */
const ACTIVE_CENTRED_AXIS = Object.freeze({
  x: 0,
  y: 0,
  magnitude: 0,
  angle: 0,
  active: true,
});

export interface IInputManagerOptions {
  /** Element the touch overlay mounts into. Defaults to `document.body`. */
  readonly mount?: HTMLElement;
  readonly tuning?: Partial<IInputTuning>;
  /** Enable individual backends. All default to true where the host supports them. */
  readonly touch?: boolean;
  readonly keyboard?: boolean;
  readonly gamepad?: boolean;
  /** Skip the DOM entirely — for Node-side simulation and unit tests. */
  readonly headless?: boolean;
  /** Drive `look` from a locked mouse pointer. Desktop only. */
  readonly mouseLook?: boolean;
  /** Inject a haptics sink. Defaults to the real one (which no-ops on web). */
  readonly haptics?: IHaptics;
  /** Install `window.__INPUT__`. Default true — downstream E2E depends on it. */
  readonly exposeTestBridge?: boolean;
  /** Clock in SECONDS. Defaults to `performance.now()/1000`. */
  readonly now?: () => number;
  /** Injectable gamepad polling, for tests. */
  readonly getGamepads?: IGamepadSourceOptionsGetter;
  /** Notified for every recognised touch gesture. */
  readonly onGesture?: (event: GestureEvent) => void;
}

type IGamepadSourceOptionsGetter = NonNullable<
  Parameters<typeof createGamepadSource>[1]
>['getGamepads'];

/** The manager's public surface. Superset of `IInputSource`. */
export interface IInputManager extends IInputSource {
  /**
   * THE test/replay entry point from `IInputSource`, widened to the ergonomic
   * deeply-partial patch shape so callers can write
   * `setState({ move: { x: 1 }, buttons: { punch: true } })` without
   * hand-constructing a full `AxisState` and `ButtonState` for every field.
   *
   * `Partial<InputState>` is assignable to `InputStatePatch`, so this still
   * satisfies the contract — anything the interface accepts, this accepts.
   */
  setState(patch: InputStatePatch): void;

  readonly tuning: IInputTuning;
  readonly haptics: IHaptics;
  /** THE scripting entry point. See `synthetic-source.ts`. */
  readonly synthetic: ISyntheticInput;
  /** While true, the synthetic driver is the ONLY input the game sees. */
  syntheticEnabled: boolean;
  readonly touch: ITouchInputSource | null;
  readonly keyboard: IKeyboardInputSource | null;
  readonly gamepad: IGamepadInputSource | null;
  /** Which backend last produced input. */
  readonly activeDevice: InputDevice;
  /** Show/hide the context-sensitive interact button. `null` hides it. */
  setInteractPrompt(label: string | null): void;
  setSafeArea(insets: SafeAreaInsets): void;
  setTuning(patch: Partial<IInputTuning>): void;
  /** Latest recognised touch gesture, for HUD feedback. */
  readonly lastGesture: GestureEvent | null;
}

export function createInputManager(options: IInputManagerOptions = {}): IInputManager {
  let tuning = resolveTuning(options.tuning);
  const hasDom = typeof document !== 'undefined' && typeof window !== 'undefined';
  const headless = options.headless ?? !hasDom;
  const now =
    options.now ??
    (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000);

  const haptics =
    options.haptics ?? (headless ? createNullHaptics() : createHaptics({ enabled: tuning.hapticsEnabled }));

  let lastGesture: GestureEvent | null = null;

  const touch: ITouchInputSource | null =
    options.touch === false
      ? null
      : createTouchSource(tuning, {
          mount: options.mount,
          headless,
          haptics,
          now,
          onGesture: (event) => {
            lastGesture = event;
            options.onGesture?.(event);
          },
        });

  const keyboard: IKeyboardInputSource | null =
    options.keyboard === false
      ? null
      : createKeyboardSource(tuning, {
          target: headless ? null : undefined,
          mouseLook: options.mouseLook ?? false,
          onChargeComplete: () => haptics.play('chargeComplete'),
        });

  const gamepad: IGamepadInputSource | null =
    options.gamepad === false
      ? null
      : createGamepadSource(tuning, {
          getGamepads: options.getGamepads,
          onChargeComplete: () => haptics.play('chargeComplete'),
        });

  const synthetic = createSyntheticSource();

  const backends: IInputBackend[] = [];
  if (touch) backends.push(touch);
  if (keyboard) backends.push(keyboard);
  if (gamepad) backends.push(gamepad);

  const scratch = new InputContribution();
  const tracker = new ButtonTracker();
  const lastActive = new Map<InputDevice, number>();

  let state: InputState = neutralInputState(0, 0, 'touch');
  let lastTime = Number.NaN;
  let activeDevice: InputDevice = hasDom ? 'touch' : 'synthetic';
  let enabled = true;
  let disposed = false;

  /** Applied to whichever backend is winning the axis race this frame. */
  interface AxisPick {
    x: number;
    y: number;
    magnitude: number;
    device: InputDevice;
  }

  function poll(frame: number, time: number): InputState {
    const dt = Number.isNaN(lastTime) ? 0 : Math.max(0, time - lastTime);
    lastTime = time;

    if (!enabled) {
      tracker.reset();
      state = neutralInputState(frame, time, activeDevice);
      return state;
    }

    let movePick: AxisPick | null = null;
    let lookPick: AxisPick | null = null;
    // A thumb resting on the stick inside the dead zone is CENTRED but ACTIVE.
    // Gameplay uses that distinction (e.g. "holding still" vs "hands off"), so
    // a zero-magnitude contribution must not be mistaken for no contribution.
    let moveTouched = false;
    let lookTouched = false;
    let pinchDelta = 1;
    let twistDelta = 0;
    // Rebuilt from scratch every frame: carrying the previous frame's pointers
    // forward would leave phantom touches after the last finger lifts.
    let pointers: readonly PointerSample[] = EMPTY_POINTERS;
    let frameDevice: InputDevice | null = null;

    const active: IInputBackend[] = synthetic.enabled ? [synthetic] : backends;

    for (const backend of active) {
      if (!backend.enabled) continue;
      scratch.reset();
      backend.sample(dt, time, scratch);

      if (scratch.active) lastActive.set(backend.device, time);

      if (scratch.hasMove) {
        moveTouched = true;
        const magnitude = Math.hypot(scratch.moveX, scratch.moveY);
        if (
          magnitude > 0 &&
          (movePick === null ||
            magnitude > movePick.magnitude + 1e-6 ||
            (Math.abs(magnitude - movePick.magnitude) <= 1e-6 &&
              (lastActive.get(backend.device) ?? -1) > (lastActive.get(movePick.device) ?? -1)))
        ) {
          movePick = { x: scratch.moveX, y: scratch.moveY, magnitude, device: backend.device };
        }
      }

      if (scratch.hasLook) {
        lookTouched = true;
        const magnitude = Math.hypot(scratch.lookX, scratch.lookY);
        if (magnitude > 0 && (lookPick === null || magnitude > lookPick.magnitude)) {
          lookPick = { x: scratch.lookX, y: scratch.lookY, magnitude, device: backend.device };
        }
      }

      for (const [action, value] of scratch.held) tracker.contribute(action, value);
      for (const [action, value] of scratch.pulses) tracker.pulse(action, value);
      for (const action of scratch.silentClears) tracker.clearSilently(action);

      if (scratch.pointers.length > 0) pointers = scratch.pointers;
      if (scratch.pinchDelta !== 1) pinchDelta = scratch.pinchDelta;
      if (scratch.twistDelta !== 0) twistDelta = scratch.twistDelta;

      if (scratch.active) frameDevice = backend.device;
    }

    if (frameDevice) activeDevice = frameDevice;

    const buttons = tracker.commit(dt);
    const move = movePick
      ? axisFromVector(movePick.x, movePick.y, true)
      : moveTouched
        ? ACTIVE_CENTRED_AXIS
        : NEUTRAL_AXIS;
    const look = lookPick
      ? axisFromVector(lookPick.x, lookPick.y, true)
      : lookTouched
        ? ACTIVE_CENTRED_AXIS
        : NEUTRAL_AXIS;

    state = Object.freeze({
      frame,
      time,
      device: activeDevice,
      move,
      look,
      buttons,
      pointers,
      pinchDelta,
      twistDelta,
      anyActive: deriveAnyActive({ move, look, buttons, pointers, pinchDelta, twistDelta }),
    });
    return state;
  }

  const manager: IInputManager = {
    get state(): InputState {
      return state;
    },

    poll,

    /**
     * `IInputSource.setState` — forwards to the synthetic driver and ENABLES
     * it, so the documented one-liner
     *   `input.setState({ move: { x: 1, y: 0 } })`
     * just works from a test without a separate arming step.
     */
    setState(patch: InputStatePatch): void {
      synthetic.setState(patch);
      if (!synthetic.enabled) {
        synthetic.enabled = true;
        log.info('synthetic input engaged — real devices are now ignored');
      }
    },

    reset(): void {
      tracker.reset();
      for (const backend of backends) backend.reset();
      synthetic.reset();
      state = neutralInputState(state.frame, state.time, activeDevice);
    },

    get enabled(): boolean {
      return enabled;
    },
    set enabled(value: boolean) {
      if (enabled === value) return;
      enabled = value;
      if (!value) {
        tracker.reset();
        for (const backend of backends) backend.reset();
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const backend of backends) backend.dispose();
      synthetic.dispose();
      haptics.dispose();
    },

    get tuning(): IInputTuning {
      return tuning;
    },

    haptics,
    synthetic,

    get syntheticEnabled(): boolean {
      return synthetic.enabled;
    },
    set syntheticEnabled(value: boolean) {
      if (synthetic.enabled === value) return;
      synthetic.enabled = value;
      // Handing control either way must not leave a latched key down, and the
      // sidelined backends must not accumulate a frame's worth of unread drag.
      tracker.reset();
      for (const backend of backends) backend.reset();
      if (!value) synthetic.clear();
    },

    touch,
    keyboard,
    gamepad,

    get activeDevice(): InputDevice {
      return activeDevice;
    },

    setInteractPrompt(label: string | null): void {
      touch?.setInteractPrompt(label);
    },

    setSafeArea(insets: SafeAreaInsets): void {
      touch?.setSafeArea(insets);
    },

    setTuning(patch: Partial<IInputTuning>): void {
      tuning = resolveTuning({ ...tuning, ...patch });
      touch?.setTuning(tuning);
      keyboard?.setTuning(tuning);
      gamepad?.setTuning(tuning);
      haptics.enabled = tuning.hapticsEnabled;
    },

    get lastGesture(): GestureEvent | null {
      return lastGesture;
    },
  };

  // The synthetic driving surface ships in every build, including production.
  // Downstream E2E and the final integration playthrough depend on it being
  // there unconditionally; a build flavour that differs from the tested one is
  // worth less than the ~1 KB it saves.
  if (options.exposeTestBridge !== false) installInputTestBridge(manager);

  log.info(
    `input manager ready — backends: ${backends.map((b) => b.device).join(', ') || 'none'}` +
      `${headless ? ' (headless)' : ''}`
  );
  return manager;
}
