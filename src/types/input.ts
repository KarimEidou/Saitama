/**
 * INPUT CONTRACT
 *
 * TYPE-ONLY file. No runtime exports.
 *
 * ── TESTABILITY REQUIREMENT (binding) ──────────────────────────────────────
 * `InputState` is a PLAIN DATA STRUCT with no DOM types anywhere in it.
 * Tests and replays drive the game by constructing an `InputState` and handing
 * it to `IInputSource.setState()` — they must NEVER need to synthesise fake
 * `TouchEvent`/`PointerEvent` objects.
 *
 * Consequences for implementers:
 *   • Gameplay code reads ONLY from `InputState`. No system may attach its own
 *     DOM listeners or inspect raw events.
 *   • The touch/keyboard/gamepad backends are pure producers of `InputState`.
 *   • `InputState` must stay JSON-serialisable so input can be recorded and
 *     replayed frame by frame for deterministic regression tests.
 */

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Discrete, named player intents. Buttons and gestures map onto these, so
 * gameplay code never asks "was the jump button pressed" — it asks whether the
 * `jump` action is active.
 */
export type InputAction =
  | 'punch'
  | 'heavyPunch'
  | 'jump'
  | 'sprint'
  | 'dodge'
  | 'block'
  | 'interact'
  | 'lockOn'
  | 'special'
  | 'pause'
  | 'map'
  | 'cameraReset'
  | 'toggleIntent'
  | 'debugToggle';

/**
 * Per-action button state.
 *
 * `pressed`/`released` are EDGE flags true for exactly one frame; `held` is a
 * level flag. Gameplay should use edges for one-shot moves and `held` for
 * charge/continuous behaviour.
 */
export interface ButtonState {
  /** True on the frame the action went down. */
  readonly pressed: boolean;
  /** True for every frame the action is down, including the first. */
  readonly held: boolean;
  /** True on the frame the action went up. */
  readonly released: boolean;
  /** Seconds the action has been held; 0 when not held. */
  readonly holdTime: number;
  /** Analogue value 0..1. Digital buttons report 0 or 1. */
  readonly value: number;
}

/* -------------------------------------------------------------------------- */
/* Axes                                                                       */
/* -------------------------------------------------------------------------- */

/** A 2D analogue axis, e.g. a virtual thumbstick. */
export interface AxisState {
  /** -1..1, positive is right. */
  readonly x: number;
  /** -1..1, positive is UP (screen-space Y is inverted for the caller). */
  readonly y: number;
  /** Magnitude 0..1, already dead-zoned and clamped to the unit circle. */
  readonly magnitude: number;
  /** Direction in radians, 0 = +X, counter-clockwise. Undefined when centred. */
  readonly angle: number;
  /** True while the stick is being actively driven. */
  readonly active: boolean;
}

/* -------------------------------------------------------------------------- */
/* Input state                                                                */
/* -------------------------------------------------------------------------- */

/** Which backend produced the current state. Drives on-screen prompt glyphs. */
export type InputDevice = 'touch' | 'keyboard' | 'gamepad' | 'synthetic';

/**
 * Complete per-frame input snapshot.
 *
 * JSON-serialisable by construction — no DOM references, no class instances.
 * A test can write `{ move: {...}, buttons: {...} }` literally.
 */
export interface InputState {
  /** Frame this snapshot describes. */
  readonly frame: number;
  /** Seconds since the clock started. */
  readonly time: number;
  /** Which backend produced it. */
  readonly device: InputDevice;

  /** Movement stick, in camera-relative space. */
  readonly move: AxisState;
  /** Camera stick / drag delta. */
  readonly look: AxisState;
  /** Every action's button state. */
  readonly buttons: Readonly<Record<InputAction, ButtonState>>;

  /**
   * Raw pointer positions in NORMALISED viewport coordinates (0..1, origin
   * top-left). Exposed for world-space picking only; do not use for movement.
   */
  readonly pointers: readonly PointerSample[];
  /** Pinch scale delta since the previous frame; 1.0 means no change. */
  readonly pinchDelta: number;
  /** Two-finger twist delta in radians since the previous frame. */
  readonly twistDelta: number;
  /** True while any input at all is being provided. */
  readonly anyActive: boolean;
}

/** One active pointer/touch, in normalised viewport space. */
export interface PointerSample {
  readonly id: number;
  /** 0..1 from the left edge. */
  readonly x: number;
  /** 0..1 from the top edge. */
  readonly y: number;
  /** Movement since the previous frame, in normalised units. */
  readonly dx: number;
  readonly dy: number;
  /** 0..1 where supported, else 1. */
  readonly pressure: number;
  /** True on the frame the pointer went down. */
  readonly down: boolean;
  /** True on the frame the pointer lifted. */
  readonly up: boolean;
}

/* -------------------------------------------------------------------------- */
/* Source                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Produces one `InputState` per frame.
 *
 * Real backends read the DOM. The test/replay backend simply returns whatever
 * was handed to `setState()`, which is how automated verification drives the
 * game without touching the DOM at all.
 */
export interface IInputSource {
  /** The current frame's snapshot. Stable for the whole frame. */
  readonly state: InputState;
  /** Sample hardware and build the next snapshot. Called once per frame. */
  poll(frame: number, time: number): InputState;
  /**
   * Override the state directly. THE test/replay entry point.
   * Partial input is merged over a neutral baseline, so a test can specify
   * only what it cares about.
   */
  setState(state: Partial<InputState>): void;
  /** Clear all held state, e.g. when the app is backgrounded. */
  reset(): void;
  /** Stop producing input without tearing the source down. */
  enabled: boolean;
  dispose(): void;
}

/** Tunable input feel. */
export interface IInputConfig {
  /** Stick magnitude below this is treated as centred. */
  readonly deadZone: number;
  /** Look sensitivity multiplier. */
  readonly lookSensitivity: number;
  /** Invert the look Y axis. */
  readonly invertLookY: boolean;
  /** Seconds a press must last to count as a hold. */
  readonly holdThreshold: number;
  /** Seconds within which two presses count as a double-tap. */
  readonly doubleTapWindow: number;
  /** Virtual stick radius in CSS pixels. */
  readonly stickRadius: number;
  /** Let the virtual stick re-centre where the thumb first lands. */
  readonly floatingStick: boolean;
  /** Fire haptics on action presses. */
  readonly hapticsEnabled: boolean;
}
