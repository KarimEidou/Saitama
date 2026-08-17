/**
 * BACKEND CONTRACT
 *
 * Backends do NOT each build an `InputState`. They write CONTRIBUTIONS into a
 * shared per-frame accumulator, and the manager folds those into one snapshot
 * through a single `ButtonTracker`.
 *
 * That indirection is the entire reason keyboard/gamepad/touch parity holds:
 * edges, hold timers and `anyActive` are computed in exactly one place, so
 * "the same input via a different device" cannot produce a differently-shaped
 * struct. It also makes simultaneous devices work for free — hold Shift on a
 * keyboard while tapping the on-screen dash and the two contributions merge
 * with `max` instead of fighting.
 */

import type { InputAction, InputDevice, PointerSample } from '@/types';

/** Scratch buffer a backend writes into during `sample()`. */
export class InputContribution {
  /** Movement vector in -1..1, already dead-zoned. `null` = this backend has no opinion. */
  moveX = 0;
  moveY = 0;
  hasMove = false;

  /** Look RATE in -1..1 (1 == `lookFullRateDegPerSec`). `hasLook` gates it. */
  lookX = 0;
  lookY = 0;
  hasLook = false;

  /** action -> held value 0..1. */
  readonly held = new Map<InputAction, number>();
  /** action -> one-frame press value. */
  readonly pulses = new Map<InputAction, number>();
  /** Actions to drop without emitting a `released` edge. */
  readonly silentClears = new Set<InputAction>();

  /** Raw pointers, normalised viewport coords. Only the touch backend fills this. */
  pointers: PointerSample[] = [];

  /** Per-frame pinch ratio; 1 = unchanged. */
  pinchDelta = 1;
  /** Per-frame twist in radians. */
  twistDelta = 0;

  /** True when this backend saw ANY input this frame (drives device arbitration). */
  active = false;

  reset(): void {
    this.moveX = 0;
    this.moveY = 0;
    this.hasMove = false;
    this.lookX = 0;
    this.lookY = 0;
    this.hasLook = false;
    this.held.clear();
    this.pulses.clear();
    this.silentClears.clear();
    this.pointers = [];
    this.pinchDelta = 1;
    this.twistDelta = 0;
    this.active = false;
  }

  setMove(x: number, y: number): void {
    this.moveX = x;
    this.moveY = y;
    this.hasMove = true;
  }

  setLook(x: number, y: number): void {
    this.lookX = x;
    this.lookY = y;
    this.hasLook = true;
  }

  hold(action: InputAction, value = 1): void {
    if (value <= 0) return;
    const prev = this.held.get(action) ?? 0;
    if (value > prev) this.held.set(action, value);
    this.active = true;
  }

  pulse(action: InputAction, value = 1): void {
    if (value <= 0) return;
    const prev = this.pulses.get(action) ?? 0;
    if (value > prev) this.pulses.set(action, value);
    this.active = true;
  }

  clearSilently(action: InputAction): void {
    this.silentClears.add(action);
    this.held.delete(action);
    this.pulses.delete(action);
  }
}

/** A source of raw input. Implemented by touch, keyboard, gamepad and synthetic. */
export interface IInputBackend {
  /** Reported on `InputState.device` when this backend last drove the frame. */
  readonly device: InputDevice;
  /** Skipped entirely when false. */
  enabled: boolean;
  /**
   * Write this frame's contribution.
   * @param dt   Seconds since the previous sample (0 on the first).
   * @param time Absolute clock, in seconds.
   * @param out  Scratch buffer, already `reset()`.
   */
  sample(dt: number, time: number, out: InputContribution): void;
  /** Drop all held state without emitting edges (blur, background, capture loss). */
  reset(): void;
  /** Detach listeners / DOM. Must be idempotent. */
  dispose(): void;
}
