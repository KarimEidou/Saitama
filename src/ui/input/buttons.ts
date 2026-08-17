/**
 * BUTTON EDGE TRACKING
 *
 * There is exactly ONE `ButtonTracker` per `InputManager`, and every backend
 * (touch, keyboard, gamepad, synthetic) funnels through it. That is what makes
 * the parity guarantee real rather than aspirational: `pressed`/`released`
 * edges are not re-derived per backend, so they cannot drift apart.
 *
 * Semantics, restated from `@/types`:
 *   pressed  — true for exactly ONE commit, the one where the action went down.
 *   held     — true for every commit the action is down, including the first.
 *   released — true for exactly ONE commit, the one where the action went up.
 *   holdTime — 0 on the press commit, then accumulates dt while held, 0 when up.
 *   value    — 0..1; digital sources report 1 while held.
 */

import type { ButtonState, InputAction } from '@/types';

/** Every action in the contract, in a stable order. */
export const INPUT_ACTIONS: readonly InputAction[] = Object.freeze([
  'punch',
  'heavyPunch',
  'jump',
  'sprint',
  'dodge',
  'block',
  'interact',
  'lockOn',
  'special',
  'pause',
  'map',
  'cameraReset',
  'toggleIntent',
  'debugToggle',
] as const);

/** The up, never-touched button. Frozen and shared. */
export const NEUTRAL_BUTTON: ButtonState = Object.freeze({
  pressed: false,
  held: false,
  released: false,
  holdTime: 0,
  value: 0,
});

/** A fresh, fully-populated neutral button record. */
export function neutralButtons(): Record<InputAction, ButtonState> {
  const out = {} as Record<InputAction, ButtonState>;
  for (const action of INPUT_ACTIONS) out[action] = NEUTRAL_BUTTON;
  return out;
}

/** Shared frozen neutral record — safe because every ButtonState is frozen. */
export const NEUTRAL_BUTTONS: Readonly<Record<InputAction, ButtonState>> = Object.freeze(
  neutralButtons()
);

interface Slot {
  /** Value accumulated by backends since the last commit. */
  raw: number;
  /** One-commit-only press requested via `pulse()`. */
  pulse: number;
  /** Suppress the `released` edge on the next commit (see `clearSilently`). */
  silence: boolean;
  prevHeld: boolean;
  holdTime: number;
  state: ButtonState;
}

/**
 * Accumulates raw held/value contributions during a frame, then converts them
 * into edge-accurate `ButtonState`s on `commit(dt)`.
 */
export class ButtonTracker {
  private readonly slots = new Map<InputAction, Slot>();

  constructor() {
    for (const action of INPUT_ACTIONS) {
      this.slots.set(action, {
        raw: 0,
        pulse: 0,
        silence: false,
        prevHeld: false,
        holdTime: 0,
        state: NEUTRAL_BUTTON,
      });
    }
  }

  /**
   * Contribute a held value for this frame. Contributions from multiple
   * backends are combined with `max`, so holding a key AND the on-screen
   * button reads as one press rather than fighting each other.
   *
   * @param value 0..1. Any value > 0 counts as held.
   */
  contribute(action: InputAction, value: number): void {
    const slot = this.slots.get(action);
    if (!slot) return;
    if (value > slot.raw) slot.raw = value;
  }

  /** Convenience for digital sources. */
  set(action: InputAction, held: boolean): void {
    if (held) this.contribute(action, 1);
  }

  /**
   * Request a press lasting exactly one commit. Used by gestures (double-tap
   * jump, two-finger lock-on) which have no natural "held" phase.
   */
  pulse(action: InputAction, value = 1): void {
    const slot = this.slots.get(action);
    if (!slot) return;
    if (value > slot.pulse) slot.pulse = value;
  }

  /**
   * Drop an action to "up" WITHOUT emitting a `released` edge.
   *
   * Needed exactly once: when a swipe-up converts a punch charge into an
   * uppercut, the charge must vanish without downstream reading it as "the
   * charged punch was fired". Everything else should use normal edges.
   */
  clearSilently(action: InputAction): void {
    const slot = this.slots.get(action);
    if (!slot) return;
    slot.raw = 0;
    slot.pulse = 0;
    slot.silence = true;
  }

  /** True if the action was held as of the last `commit()`. */
  isHeld(action: InputAction): boolean {
    return this.slots.get(action)?.prevHeld ?? false;
  }

  /** Hold duration as of the last `commit()`. */
  holdTime(action: InputAction): number {
    return this.slots.get(action)?.holdTime ?? 0;
  }

  /**
   * Turn this frame's accumulated contributions into edge-accurate states and
   * clear the accumulator. Returns a NEW frozen record each call, so callers
   * may retain snapshots (replay buffers do exactly that).
   */
  commit(dt: number): Readonly<Record<InputAction, ButtonState>> {
    const out = {} as Record<InputAction, ButtonState>;
    for (const action of INPUT_ACTIONS) {
      const slot = this.slots.get(action)!;
      const value = Math.max(slot.raw, slot.pulse);
      const held = value > 0;
      const pressed = held && !slot.prevHeld;
      const released = !held && slot.prevHeld && !slot.silence;

      if (pressed) slot.holdTime = 0;
      else if (held) slot.holdTime += dt;
      else slot.holdTime = 0;

      const state: ButtonState =
        !held && !released
          ? NEUTRAL_BUTTON
          : Object.freeze({
              pressed,
              held,
              released,
              holdTime: slot.holdTime,
              value: held ? value : 0,
            });

      slot.state = state;
      out[action] = state;

      slot.prevHeld = held;
      slot.raw = 0;
      slot.pulse = 0;
      slot.silence = false;
    }
    return Object.freeze(out);
  }

  /** Latest committed record, without advancing. */
  snapshot(): Readonly<Record<InputAction, ButtonState>> {
    const out = {} as Record<InputAction, ButtonState>;
    for (const action of INPUT_ACTIONS) out[action] = this.slots.get(action)!.state;
    return Object.freeze(out);
  }

  /**
   * Hard reset: everything up, no edges emitted on the next commit. Called on
   * app background, window blur, and pointer-capture loss — the three ways a
   * button gets stuck down forever if you do not handle them.
   */
  reset(): void {
    for (const action of INPUT_ACTIONS) {
      const slot = this.slots.get(action)!;
      slot.raw = 0;
      slot.pulse = 0;
      slot.silence = false;
      slot.prevHeld = false;
      slot.holdTime = 0;
      slot.state = NEUTRAL_BUTTON;
    }
  }
}

/** Structural comparison for a button, with a tolerance on the float fields. */
export function buttonsEqual(a: ButtonState, b: ButtonState, epsilon = 1e-4): boolean {
  return (
    a.pressed === b.pressed &&
    a.held === b.held &&
    a.released === b.released &&
    Math.abs(a.value - b.value) <= epsilon &&
    Math.abs(a.holdTime - b.holdTime) <= epsilon
  );
}
