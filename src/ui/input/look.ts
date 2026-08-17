/**
 * LOOK SMOOTHING
 *
 * Converts a per-frame pixel drag into the normalised look RATE carried by
 * `InputState.look`, and smooths it.
 *
 * ── Why `look` is a rate, not a delta ──────────────────────────────────────
 * `AxisState` is bounded to -1..1, so it cannot carry "37 degrees this frame".
 * Modelling it as a rate is both contract-compliant and the shape a gamepad
 * right-stick already has, which is exactly why keyboard/gamepad/touch can
 * produce identical structs. Consumers recover real rotation with:
 *
 *     degrees = look.x * tuning.lookFullRateDegPerSec * dt
 *
 * ── Why the smoothing is exponential and frame-rate independent ────────────
 * Touch digitisers report in coarse, irregular steps; feeding those straight
 * into a camera produces visible stair-stepping. A fixed `lerp(a, b, 0.2)`
 * would fix the stepping but tie camera feel to frame rate — the camera would
 * literally behave differently on a 120 Hz phone. `damp()` from `@/util` is
 * defined in terms of the fraction of error remaining after ONE SECOND, so
 * the response curve is identical at 30, 60 and 120 fps.
 */

import { clamp01, damp } from '@/util';
import type { IInputTuning } from './config';

/** Never divide by a zero or absurdly small dt. */
const MIN_DT = 1 / 240;

/** Normalised, smoothed look rate. */
export interface LookRate {
  /** -1..1, positive turns right. */
  readonly x: number;
  /** -1..1, positive looks UP. */
  readonly y: number;
  /** Unsmoothed degrees applied this frame — diagnostics only. */
  readonly rawDegX: number;
  readonly rawDegY: number;
}

/**
 * Stateful smoother. One instance per look-producing backend (touch drag,
 * mouse look), so a finger drag and a mouse sweep decay independently.
 */
export class LookSmoother {
  private vx = 0;
  private vy = 0;

  /**
   * @param dxPx Horizontal drag this frame, in CSS pixels (positive right).
   * @param dyPx Vertical drag this frame, in CSS pixels (positive DOWN,
   *             i.e. raw screen space — the flip to "positive up" happens here).
   */
  update(dxPx: number, dyPx: number, dt: number, tuning: IInputTuning): LookRate {
    const sensitivity = tuning.cameraDegPerPx * tuning.lookSensitivity;
    const rawDegX = dxPx * sensitivity;
    // Screen Y grows downward; `look.y` is positive UP. Dragging the thumb up
    // (negative dy) looks up.
    const rawDegY = -dyPx * sensitivity * (tuning.invertLookY ? -1 : 1);

    const step = Math.max(dt, MIN_DT);
    const targetX = rawDegX / step;
    const targetY = rawDegY / step;

    this.vx = damp(this.vx, targetX, tuning.lookSmoothing, step);
    this.vy = damp(this.vy, targetY, tuning.lookSmoothing, step);

    if (Math.abs(this.vx) < tuning.lookRestDegPerSec) this.vx = 0;
    if (Math.abs(this.vy) < tuning.lookRestDegPerSec) this.vy = 0;

    const scale = 1 / Math.max(tuning.lookFullRateDegPerSec, 1e-3);
    let nx = this.vx * scale;
    let ny = this.vy * scale;
    const magnitude = Math.hypot(nx, ny);
    if (magnitude > 1) {
      nx /= magnitude;
      ny /= magnitude;
    }
    return { x: nx, y: ny, rawDegX, rawDegY };
  }

  /** True while the smoother still has energy worth reporting. */
  get settled(): boolean {
    return this.vx === 0 && this.vy === 0;
  }

  reset(): void {
    this.vx = 0;
    this.vy = 0;
  }
}

/**
 * Shared charge-button timing, used identically by touch, keyboard and gamepad
 * so a charged punch feels the same on every device and — more importantly —
 * produces the same `InputState`.
 *
 * Contract produced by the owner of this tracker:
 *   `punch.pressed`            fires immediately on press (the light punch).
 *   `punch.holdTime`           drives the radial charge ring (0..chargeFullSec).
 *   `heavyPunch.pressed`       fires on RELEASE, once, when the hold passed
 *                              `chargeStartSec`, with `value` = charge ratio.
 *   nothing at all             if the swipe-up uppercut consumed the press.
 */
export class ChargeTracker {
  private heldTime = 0;
  private down = false;
  private cancelled = false;
  private full = false;

  /** Begin a press. */
  press(): void {
    this.down = true;
    this.heldTime = 0;
    this.cancelled = false;
    this.full = false;
  }

  /**
   * Advance the charge clock.
   * @returns true on the single tick where the charge reaches FULL (haptic cue).
   */
  tick(dt: number, tuning: IInputTuning): boolean {
    if (!this.down || this.cancelled) return false;
    this.heldTime += dt;
    if (!this.full && this.heldTime >= tuning.chargeFullSec) {
      this.full = true;
      return true;
    }
    return false;
  }

  /** Abandon the charge (uppercut swipe, pointer cancel, app backgrounded). */
  cancel(): void {
    this.cancelled = true;
    this.down = false;
    this.heldTime = 0;
    this.full = false;
  }

  /**
   * End the press.
   * @returns the charge ratio 0..1 to fire `heavyPunch` with, or `null` when
   *          the press was too short (or cancelled) to count as a charge.
   */
  release(tuning: IInputTuning): number | null {
    const wasDown = this.down;
    const cancelled = this.cancelled;
    const time = this.heldTime;
    this.down = false;
    this.cancelled = false;
    this.heldTime = 0;
    this.full = false;
    if (!wasDown || cancelled) return null;
    if (time < tuning.chargeStartSec) return null;
    return chargeRatio(time, tuning);
  }

  get isDown(): boolean {
    return this.down && !this.cancelled;
  }

  get holdTime(): number {
    return this.heldTime;
  }

  ratio(tuning: IInputTuning): number {
    return this.down && !this.cancelled ? chargeRatio(this.heldTime, tuning) : 0;
  }

  reset(): void {
    this.down = false;
    this.cancelled = false;
    this.heldTime = 0;
    this.full = false;
  }
}

/** 0 below `chargeStartSec`, ramping to 1 at `chargeFullSec`. */
export function chargeRatio(holdTime: number, tuning: IInputTuning): number {
  const span = Math.max(tuning.chargeFullSec - tuning.chargeStartSec, 1e-4);
  return clamp01((holdTime - tuning.chargeStartSec) / span);
}
