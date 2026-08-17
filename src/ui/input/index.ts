/**
 * ══════════════════════════════════════════════════════════════════════════
 *  INPUT SYSTEM — public surface
 *
 *    import { createInputManager } from '@/ui/input';
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Produces one `InputState` (see `@/types/input.ts`) per frame from four
 * interchangeable backends: touch, keyboard(+mouse), gamepad, and a synthetic
 * driver. Nothing downstream ever touches the DOM, listens for an event, or
 * asks which device is in use.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  1. WIRING IT UP
 * ──────────────────────────────────────────────────────────────────────────
 *
 *   const input = createInputManager({ mount: document.body });
 *
 *   function frame(frameIndex: number, timeSeconds: number) {
 *     const state = input.poll(frameIndex, timeSeconds);   // once per frame
 *     player.update(state, dt);
 *   }
 *
 * `poll()` must be called EXACTLY once per frame: edge flags
 * (`pressed`/`released`) advance on each call, so polling twice eats an edge
 * and polling zero times makes one last two frames. Read `input.state` if you
 * need the current snapshot again later in the frame; it is stable between
 * polls.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  2. DRIVING THE GAME FROM A TEST  ← every other workstream needs this
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Do not synthesise touch events. Write `InputState` instead. Three equivalent
 * doors into the same driver:
 *
 *   // (a) the IInputSource contract, from anywhere holding the manager
 *   input.setState({ move: { x: 1, y: 0 }, buttons: { punch: true } });
 *
 *   // (b) the typed synthetic object, for scripted sequences
 *   input.synthetic.setMove(0, 1);
 *   input.synthetic.tap('jump');
 *   input.synthetic.queue([
 *     { frames: 30, patch: { move: { x: 0, y: 1 } }, label: 'run north' },
 *     { frames: 1, taps: ['punch'], label: 'punch' },
 *   ]);
 *
 *   // (c) from Playwright, over the wire
 *   await page.evaluate(() => window.__INPUT__.setMove(0, 1));
 *   await page.evaluate(() => window.__INPUT__.tap('punch'));
 *   const snapshot = await page.evaluate(() => window.__INPUT__.snapshot());
 *
 * Semantics (all three doors share them):
 *   • LATCHED — what you set persists until changed or cleared.
 *   • REAL EDGES — injected holds run through the same `ButtonTracker` as a
 *     thumb, so `pressed`/`released`/`holdTime` are physically plausible.
 *   • EXCLUSIVE — while armed, real devices are ignored, so a stray touch on
 *     the test device cannot corrupt a run. `state.device === 'synthetic'`.
 *   • `tap(action)` is held for exactly one poll.
 *   • `disable()` / `syntheticEnabled = false` hands control back cleanly.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  3. WHAT EACH FIELD MEANS FOR A CONSUMER
 * ──────────────────────────────────────────────────────────────────────────
 *
 *   move   Camera-relative movement, unit disc. `magnitude` is already
 *          dead-zoned and rescaled; use it directly as a speed scalar.
 *   look   A RATE, not a delta — `look.x === 1` means
 *          `tuning.lookFullRateDegPerSec` degrees per second. Recover real
 *          rotation with `deg = look.x * tuning.lookFullRateDegPerSec * dt`.
 *   pinchDelta  Per-frame ratio for the camera arm length; 1 = unchanged.
 *               `armLength /= pinchDelta` is the usual application.
 *   buttons.punch        `pressed` = throw the light punch NOW.
 *                        `holdTime` drives the charge ring (see `chargeRatio`).
 *   buttons.heavyPunch   `pressed` = the charged blow lands, and `value` is
 *                        the charge ratio 0..1. Fires on RELEASE of a held
 *                        punch. Never fires if the uppercut swipe consumed it.
 *   buttons.special      `pressed` = uppercut launch (swipe up on punch, RB).
 *   buttons.sprint       `held` = dash. Touch drives it as a toggle; keyboard
 *                        Shift and gamepad L3 drive it as a hold. Identical
 *                        `InputState` either way.
 *   buttons.lockOn       `pressed` = two-finger tap / Q / R3.
 *   buttons.jump         `pressed` = jump. Also fired by a double tap.
 *   buttons.interact     Only reachable on touch while a prompt is set —
 *                        call `input.setInteractPrompt('OPEN')` when a target
 *                        is in range, and `setInteractPrompt(null)` when not.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  4. HAPTICS
 * ──────────────────────────────────────────────────────────────────────────
 *
 *   input.haptics.play('kill');      // combat
 *   input.haptics.play('landing');   // player controller
 *
 * `chargeComplete` is fired by the input system itself. Every cue no-ops
 * safely on web, in headless Chromium, and when the plugin is missing.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  5. WHAT THIS MODULE MAY NOT DO
 * ──────────────────────────────────────────────────────────────────────────
 *
 * It produces `InputState`. It does not move a character, drive a camera, or
 * know what a punch is. The player controller and camera own that; they read
 * `InputState` and nothing else.
 */

/* -- composition ---------------------------------------------------------- */
export {
  createInputManager,
  type IInputManager,
  type IInputManagerOptions,
} from './input-manager';

/* -- tuning --------------------------------------------------------------- */
export { DEFAULT_INPUT_TUNING, resolveTuning, type IInputTuning } from './config';

/* -- synthetic driver (THE test entry point) ------------------------------ */
export { createSyntheticSource, type ISyntheticInput, type IInputScriptStep } from './synthetic-source';
export {
  createInputTestBridge,
  installInputTestBridge,
  INPUT_BRIDGE_VERSION,
  type IInputTestBridge,
} from './test-bridge';

/* -- state helpers (assertions, replays) ---------------------------------- */
export {
  applyInputPatch,
  cloneInputState,
  describeInputState,
  deriveAnyActive,
  diffInputStates,
  inputStatesEqual,
  neutralInputState,
  normaliseAxisPatch,
  normaliseButtonPatch,
  buttonPatchValue,
  type ButtonPatch,
  type InputStatePatch,
  type IStateCompareOptions,
} from './state';

/* -- math ----------------------------------------------------------------- */
export {
  axesEqual,
  axisFromVector,
  NEUTRAL_AXIS,
  radialDeadZone,
  radialDeflection,
  squareToCircle,
  type RadialDeflection,
} from './axis';

/* -- buttons -------------------------------------------------------------- */
export {
  ButtonTracker,
  buttonsEqual,
  INPUT_ACTIONS,
  NEUTRAL_BUTTON,
  NEUTRAL_BUTTONS,
  neutralButtons,
} from './buttons';

/* -- look / charge -------------------------------------------------------- */
export { ChargeTracker, chargeRatio, LookSmoother, type LookRate } from './look';

/* -- backends ------------------------------------------------------------- */
export { InputContribution, type IInputBackend } from './backend';
export {
  TouchCore,
  TOUCH_BUTTON_IDS,
  type GestureEvent,
  type GestureName,
  type PointerDebug,
  type PointerInput,
  type PointerPhase,
  type PointerRole,
  type TouchButtonId,
  type TouchHit,
} from './touch-core';
export { createTouchSource, type ITouchInputSource, type ITouchSourceOptions } from './touch-source';
export {
  createTouchOverlay,
  THUMB_ARC,
  THUMB_PIVOT_PX,
  thumbArcOffset,
  type IThumbArcSlot,
  type ITouchOverlay,
  type ITouchOverlayView,
} from './touch-overlay';
export {
  createKeyboardSource,
  DEFAULT_KEY_MAP,
  type IKeyboardInputSource,
  type IKeyboardSourceOptions,
} from './keyboard-source';
export {
  createGamepadSource,
  DEFAULT_GAMEPAD_MAP,
  type GamepadLike,
  type IGamepadInputSource,
  type IGamepadSourceOptions,
} from './gamepad-source';

/* -- haptics -------------------------------------------------------------- */
export {
  createHaptics,
  createNullHaptics,
  type HapticCue,
  type IHaptics,
  type IHapticsOptions,
} from './haptics';
