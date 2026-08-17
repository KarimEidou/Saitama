/**
 * MULTI-TOUCH STATE MACHINE — deliberately DOM-free.
 *
 * This file knows nothing about `PointerEvent`, elements or CSS. It consumes
 * plain `{ id, x, y, phase, time }` records and produces an
 * `InputContribution`. `touch-source.ts` is the thin adapter that turns real
 * pointer events into those records.
 *
 * The split exists for one reason: multi-touch correctness is where touch
 * controls actually break, and it is untestable if it is welded to the DOM.
 * Here it is exhaustively unit-testable in Node, and the DOM adapter on top is
 * small enough to verify end-to-end in a browser harness.
 *
 * ── THE RULES THAT MAKE SIMULTANEOUS TOUCH WORK ────────────────────────────
 *  1. A pointer's ROLE is decided once, at `down`, and never changes. A thumb
 *     that starts on the stick stays the stick even if it slides across the
 *     screen centre; a finger that starts on the camera half never steals the
 *     stick. Re-deciding roles on move is the single most common source of
 *     "my character stops walking when I turn the camera".
 *  2. Everything is keyed by `pointerId`. There is no "the touch" anywhere.
 *  3. `cancel` is handled on exactly the same path as `up`, minus the gesture
 *     recognition. A cancelled pointer must never leave the stick deflected —
 *     that is the classic stuck-stick bug when the browser steals a gesture,
 *     a phone call arrives, or the app is backgrounded mid-drag.
 *  4. Whenever the set of camera pointers changes, the drag/pinch BASELINE is
 *     re-seeded from current positions without emitting a delta. Otherwise
 *     lifting one of two fingers teleports the camera by the distance between
 *     the old and new centroid.
 */

import type { InputAction, PointerSample } from '@/types';
import { clamp, clamp01 } from '@/util';
import { radialDeflection } from './axis';
import { InputContribution } from './backend';
import type { IInputTuning } from './config';
import { ChargeTracker, LookSmoother } from './look';

/* -------------------------------------------------------------------------- */
/* Input records                                                              */
/* -------------------------------------------------------------------------- */

export type PointerPhase = 'down' | 'move' | 'up' | 'cancel';

/** The four on-screen buttons. */
export type TouchButtonId = 'punch' | 'jump' | 'dash' | 'interact';

export const TOUCH_BUTTON_IDS: readonly TouchButtonId[] = Object.freeze([
  'punch',
  'jump',
  'dash',
  'interact',
] as const);

/** What a pointer landed on, resolved by the DOM layer at `down`. */
export type TouchHit = { readonly kind: 'button'; readonly button: TouchButtonId } | null;

/** One raw pointer event, in CSS pixels relative to the viewport. */
export interface PointerInput {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly phase: PointerPhase;
  /** Seconds. Must be monotonic. */
  readonly time: number;
  /** 0..1 where the device reports it, else 1. */
  readonly pressure?: number;
  /** Only meaningful on `down`. */
  readonly hit?: TouchHit;
}

/** How a pointer is being used. Assigned at `down`, immutable thereafter. */
export type PointerRole = 'stick' | 'camera' | 'button' | 'ignored';

/** Recognised gestures, surfaced for the harness and for HUD feedback. */
export type GestureName = 'doubleTapJump' | 'twoFingerTapLock' | 'swipeUpUppercut';

export interface GestureEvent {
  readonly gesture: GestureName;
  readonly time: number;
  /** Viewport pixels where it was recognised. */
  readonly x: number;
  readonly y: number;
}

/** Live per-pointer debug info, for the harness readout. */
export interface PointerDebug {
  readonly id: number;
  readonly role: PointerRole;
  readonly button: TouchButtonId | null;
  readonly x: number;
  readonly y: number;
  readonly downX: number;
  readonly downY: number;
  readonly travelPx: number;
  readonly ageSec: number;
}

/* -------------------------------------------------------------------------- */
/* Internal tracking                                                          */
/* -------------------------------------------------------------------------- */

interface TrackedPointer {
  id: number;
  role: PointerRole;
  button: TouchButtonId | null;
  downTime: number;
  downX: number;
  downY: number;
  x: number;
  y: number;
  pressure: number;
  travelPx: number;
  /** Set when a gesture (uppercut swipe) consumed this pointer. */
  consumed: boolean;
  /** True until the first `sample()` after the pointer went down. */
  freshDown: boolean;
  /** Normalised position at the previous `sample()`, for `PointerSample.dx/dy`. */
  prevNormX: number;
  prevNormY: number;
  /** Reported once with `up: true`, then dropped. */
  ended: boolean;
}

interface CompletedTap {
  x: number;
  y: number;
  downTime: number;
  upTime: number;
  consumed: boolean;
}

interface ButtonRuntime {
  /** Pointer currently holding this button, or -1. */
  pointerId: number;
  down: boolean;
}

/* -------------------------------------------------------------------------- */
/* Core                                                                       */
/* -------------------------------------------------------------------------- */

export interface ITouchCoreCallbacks {
  /** Fired the instant the punch charge fills. Wired to haptics. */
  onChargeComplete?: () => void;
  /** Fired for every recognised gesture. */
  onGesture?: (event: GestureEvent) => void;
  /** Fired whenever the dash toggle flips. */
  onDashToggle?: (on: boolean) => void;
}

/**
 * Owns all touch state. Feed it `handle()` for every pointer event and call
 * `sample()` once per frame.
 */
export class TouchCore {
  private tuning: IInputTuning;
  private readonly callbacks: ITouchCoreCallbacks;

  private viewportW = 1;
  private viewportH = 1;

  private readonly pointers = new Map<number, TrackedPointer>();
  /** Pointers that ended this frame, held so they can be reported once. */
  private readonly ending: TrackedPointer[] = [];

  /* stick */
  private stickPointerId = -1;
  private stickOriginX = 0;
  private stickOriginY = 0;

  /* camera drag + pinch */
  private readonly cameraIds: number[] = [];
  private haveCameraBaseline = false;
  private baseCentroidX = 0;
  private baseCentroidY = 0;
  private baseDistance = 0;
  private baseAngle = 0;
  private dragAccumX = 0;
  private dragAccumY = 0;
  private pinchAccum = 1;
  private twistAccum = 0;
  private readonly lookSmoother = new LookSmoother();

  /* buttons */
  private readonly buttons = new Map<TouchButtonId, ButtonRuntime>();
  private readonly charge = new ChargeTracker();
  private dashOn = false;
  private interactAvailable = false;

  /* gestures */
  private readonly recentTaps: CompletedTap[] = [];
  private readonly pendingPulses = new Map<InputAction, number>();
  private readonly pendingSilentClears = new Set<InputAction>();
  private lastGesture: GestureEvent | null = null;

  /** Latest clock seen, so `sample()` can advance timers without a fresh event. */
  private lastTime = 0;

  constructor(tuning: IInputTuning, callbacks: ITouchCoreCallbacks = {}) {
    this.tuning = tuning;
    this.callbacks = callbacks;
    for (const id of TOUCH_BUTTON_IDS) this.buttons.set(id, { pointerId: -1, down: false });
  }

  /* ---------------------------------------------------------------------- */
  /* Configuration                                                          */
  /* ---------------------------------------------------------------------- */

  setTuning(tuning: IInputTuning): void {
    this.tuning = tuning;
  }

  setViewport(width: number, height: number): void {
    this.viewportW = Math.max(1, width);
    this.viewportH = Math.max(1, height);
  }

  /** Context-sensitive interact button visibility. */
  setInteractAvailable(available: boolean): void {
    if (this.interactAvailable === available) return;
    this.interactAvailable = available;
    if (!available) this.forceReleaseButton('interact');
  }

  get isInteractAvailable(): boolean {
    return this.interactAvailable;
  }

  /** Dash is a toggle; gameplay may need to force it off (e.g. on stagger). */
  setDashToggle(on: boolean): void {
    if (this.dashOn === on) return;
    this.dashOn = on;
    this.callbacks.onDashToggle?.(on);
  }

  get isDashOn(): boolean {
    return this.dashOn;
  }

  /* ---------------------------------------------------------------------- */
  /* Read-only views (overlay + harness)                                    */
  /* ---------------------------------------------------------------------- */

  /** Floating stick origin + current thumb position, or null when inactive. */
  get stick(): { originX: number; originY: number; x: number; y: number } | null {
    if (this.stickPointerId < 0) return null;
    const p = this.pointers.get(this.stickPointerId);
    if (!p) return null;
    return { originX: this.stickOriginX, originY: this.stickOriginY, x: p.x, y: p.y };
  }

  /** 0..1 charge ring fill. */
  get chargeRatio(): number {
    return this.charge.ratio(this.tuning);
  }

  /** Raw hold time of the punch button, in seconds. */
  get chargeHoldTime(): number {
    return this.charge.holdTime;
  }

  isButtonDown(id: TouchButtonId): boolean {
    return this.buttons.get(id)?.down ?? false;
  }

  get lastRecognisedGesture(): GestureEvent | null {
    return this.lastGesture;
  }

  /** Snapshot of every live pointer, for the harness table. */
  debugPointers(now = this.lastTime): PointerDebug[] {
    const out: PointerDebug[] = [];
    for (const p of this.pointers.values()) {
      out.push({
        id: p.id,
        role: p.role,
        button: p.button,
        x: p.x,
        y: p.y,
        downX: p.downX,
        downY: p.downY,
        travelPx: p.travelPx,
        ageSec: Math.max(0, now - p.downTime),
      });
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  get activePointerCount(): number {
    return this.pointers.size;
  }

  /* ---------------------------------------------------------------------- */
  /* Event ingestion                                                        */
  /* ---------------------------------------------------------------------- */

  handle(event: PointerInput): void {
    this.lastTime = event.time;
    switch (event.phase) {
      case 'down':
        this.onDown(event);
        break;
      case 'move':
        this.onMove(event);
        break;
      case 'up':
        this.onEnd(event, false);
        break;
      case 'cancel':
        this.onEnd(event, true);
        break;
    }
  }

  private onDown(event: PointerInput): void {
    // Defensive: a duplicate `down` for a live id means we missed an `up`.
    if (this.pointers.has(event.id)) this.onEnd({ ...event, phase: 'cancel' }, true);

    const hit = event.hit ?? null;
    let role: PointerRole;
    let button: TouchButtonId | null = null;

    if (hit && hit.kind === 'button') {
      if (hit.button === 'interact' && !this.interactAvailable) {
        role = 'ignored';
      } else {
        role = 'button';
        button = hit.button;
      }
    } else if (
      event.x < this.viewportW * this.tuning.stickZoneFraction &&
      this.stickPointerId < 0
    ) {
      role = 'stick';
    } else {
      role = 'camera';
    }

    const tracked: TrackedPointer = {
      id: event.id,
      role,
      button,
      downTime: event.time,
      downX: event.x,
      downY: event.y,
      x: event.x,
      y: event.y,
      pressure: event.pressure ?? 1,
      travelPx: 0,
      consumed: false,
      freshDown: true,
      prevNormX: event.x / this.viewportW,
      prevNormY: event.y / this.viewportH,
      ended: false,
    };
    this.pointers.set(event.id, tracked);

    if (role === 'stick') {
      this.stickPointerId = event.id;
      // Floating origin: the stick materialises exactly where the thumb landed.
      // Never a fixed position — a fixed stick forces the player to look at
      // their thumb instead of the game.
      this.stickOriginX = event.x;
      this.stickOriginY = event.y;
    } else if (role === 'camera') {
      this.cameraIds.push(event.id);
      this.reseedCameraBaseline();
    } else if (role === 'button' && button) {
      this.pressButton(button, event.id, event.time);
    }
  }

  private onMove(event: PointerInput): void {
    const p = this.pointers.get(event.id);
    if (!p) return;

    p.x = event.x;
    p.y = event.y;
    if (event.pressure !== undefined) p.pressure = event.pressure;
    p.travelPx = Math.max(p.travelPx, Math.hypot(event.x - p.downX, event.y - p.downY));

    switch (p.role) {
      case 'stick':
        this.updateStickOrigin(p);
        break;
      case 'camera':
        this.updateCameraFromPointers();
        break;
      case 'button':
        if (p.button === 'punch' && !p.consumed) this.checkUppercutSwipe(p, event.time);
        break;
      case 'ignored':
        break;
    }
  }

  private onEnd(event: PointerInput, cancelled: boolean): void {
    const p = this.pointers.get(event.id);
    if (!p) return;

    p.x = event.x;
    p.y = event.y;
    p.ended = true;
    this.pointers.delete(event.id);
    this.ending.push(p);

    switch (p.role) {
      case 'stick':
        if (this.stickPointerId === event.id) this.stickPointerId = -1;
        break;
      case 'camera': {
        const index = this.cameraIds.indexOf(event.id);
        if (index !== -1) this.cameraIds.splice(index, 1);
        // Re-seed WITHOUT emitting a delta, so lifting one of two fingers does
        // not snap the camera by the centroid shift.
        this.reseedCameraBaseline();
        break;
      }
      case 'button':
        if (p.button) this.releaseButton(p.button, event.id, event.time, cancelled || p.consumed);
        break;
      case 'ignored':
        break;
    }

    // Gesture recognition never runs on a cancelled pointer: the browser took
    // the gesture away from us, so anything we infer from it is a guess.
    if (!cancelled && !p.consumed && (p.role === 'stick' || p.role === 'camera')) {
      this.recordTapCandidate(p, event.time);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Stick                                                                  */
  /* ---------------------------------------------------------------------- */

  private updateStickOrigin(p: TrackedPointer): void {
    if (!this.tuning.stickOriginFollows) return;
    const dx = p.x - this.stickOriginX;
    const dy = p.y - this.stickOriginY;
    const distance = Math.hypot(dx, dy);
    const limit = this.tuning.stickFullDeflectionPx;
    if (distance > limit && distance > 1e-6) {
      // Drag the origin along so it trails exactly `limit` behind the thumb.
      // Deflection stays saturated, but pulling back eases off immediately
      // instead of retracing the whole overshoot.
      const excess = (distance - limit) / distance;
      this.stickOriginX += dx * excess;
      this.stickOriginY += dy * excess;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Camera drag + pinch                                                    */
  /* ---------------------------------------------------------------------- */

  private cameraCentroid(): { x: number; y: number } | null {
    if (this.cameraIds.length === 0) return null;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const id of this.cameraIds) {
      const p = this.pointers.get(id);
      if (!p) continue;
      sx += p.x;
      sy += p.y;
      n++;
    }
    if (n === 0) return null;
    return { x: sx / n, y: sy / n };
  }

  private cameraSpan(): { distance: number; angle: number } | null {
    if (this.cameraIds.length < 2) return null;
    const a = this.pointers.get(this.cameraIds[0]!);
    const b = this.pointers.get(this.cameraIds[1]!);
    if (!a || !b) return null;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return { distance: Math.hypot(dx, dy), angle: Math.atan2(dy, dx) };
  }

  /** Re-anchor drag/pinch to the current finger positions, emitting nothing. */
  private reseedCameraBaseline(): void {
    const centroid = this.cameraCentroid();
    if (!centroid) {
      this.haveCameraBaseline = false;
      this.baseDistance = 0;
      return;
    }
    this.baseCentroidX = centroid.x;
    this.baseCentroidY = centroid.y;
    const span = this.cameraSpan();
    this.baseDistance = span?.distance ?? 0;
    this.baseAngle = span?.angle ?? 0;
    this.haveCameraBaseline = true;
  }

  private updateCameraFromPointers(): void {
    const centroid = this.cameraCentroid();
    if (!centroid) return;
    if (!this.haveCameraBaseline) {
      this.reseedCameraBaseline();
      return;
    }

    this.dragAccumX += centroid.x - this.baseCentroidX;
    this.dragAccumY += centroid.y - this.baseCentroidY;
    this.baseCentroidX = centroid.x;
    this.baseCentroidY = centroid.y;

    const span = this.cameraSpan();
    if (span && this.baseDistance > 0) {
      const change = span.distance - this.baseDistance;
      if (Math.abs(change) >= this.tuning.pinchMinDeltaPx) {
        const ratio = clamp(
          span.distance / this.baseDistance,
          1 / this.tuning.pinchMaxRatioPerFrame,
          this.tuning.pinchMaxRatioPerFrame
        );
        this.pinchAccum *= ratio;
        this.baseDistance = span.distance;
      }
      let twist = span.angle - this.baseAngle;
      while (twist > Math.PI) twist -= Math.PI * 2;
      while (twist < -Math.PI) twist += Math.PI * 2;
      this.twistAccum += twist;
      this.baseAngle = span.angle;
    } else if (span) {
      this.baseDistance = span.distance;
      this.baseAngle = span.angle;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Buttons                                                                */
  /* ---------------------------------------------------------------------- */

  private pressButton(id: TouchButtonId, pointerId: number, _time: number): void {
    const runtime = this.buttons.get(id);
    if (!runtime) return;
    runtime.pointerId = pointerId;
    runtime.down = true;

    if (id === 'punch') {
      this.charge.press();
    } else if (id === 'dash') {
      // Toggle on PRESS, not on release: a dash toggle that waits for your
      // thumb to lift feels broken.
      this.setDashToggle(!this.dashOn);
    }
  }

  private releaseButton(
    id: TouchButtonId,
    pointerId: number,
    _time: number,
    suppressed: boolean
  ): void {
    const runtime = this.buttons.get(id);
    if (!runtime || runtime.pointerId !== pointerId) return;
    runtime.pointerId = -1;
    runtime.down = false;

    if (id === 'punch') {
      if (suppressed) {
        this.charge.cancel();
        this.pendingSilentClears.add('punch');
      } else {
        const ratio = this.charge.release(this.tuning);
        if (ratio !== null) this.queuePulse('heavyPunch', Math.max(ratio, 1e-3));
      }
    }
  }

  /** Drop a button as if the pointer vanished. Used when `interact` disappears. */
  private forceReleaseButton(id: TouchButtonId): void {
    const runtime = this.buttons.get(id);
    if (!runtime || !runtime.down) return;
    const pointerId = runtime.pointerId;
    runtime.down = false;
    runtime.pointerId = -1;
    const p = this.pointers.get(pointerId);
    if (p) p.role = 'ignored';
    if (id === 'punch') this.charge.cancel();
  }

  /* ---------------------------------------------------------------------- */
  /* Gestures                                                               */
  /* ---------------------------------------------------------------------- */

  private queuePulse(action: InputAction, value = 1): void {
    const prev = this.pendingPulses.get(action) ?? 0;
    if (value > prev) this.pendingPulses.set(action, value);
  }

  private emitGesture(gesture: GestureName, x: number, y: number, time: number): void {
    const event: GestureEvent = { gesture, time, x, y };
    this.lastGesture = event;
    this.callbacks.onGesture?.(event);
  }

  /** Swipe UP on the punch button = uppercut launch. Fires mid-drag, not on release. */
  private checkUppercutSwipe(p: TrackedPointer, time: number): void {
    if (time - p.downTime > this.tuning.swipeUpMaxSec) return;
    const dx = p.x - p.downX;
    const dy = p.y - p.downY;
    if (-dy < this.tuning.swipeUpMinPx) return;
    if (Math.abs(dx) > Math.abs(dy) * this.tuning.swipeUpMaxSkewRatio) return;

    p.consumed = true;
    this.queuePulse('special');
    // The press already produced `punch.pressed`; drop it silently so nothing
    // downstream reads the uppercut as a cancelled charge.
    this.charge.cancel();
    this.pendingSilentClears.add('punch');
    const runtime = this.buttons.get('punch');
    if (runtime) {
      runtime.down = false;
      runtime.pointerId = -1;
    }
    this.emitGesture('swipeUpUppercut', p.x, p.y, time);
  }

  private recordTapCandidate(p: TrackedPointer, time: number): void {
    const duration = time - p.downTime;
    if (duration > this.tuning.tapMaxDurationSec) return;
    if (p.travelPx > this.tuning.tapMaxMovePx) return;

    const tap: CompletedTap = {
      x: p.x,
      y: p.y,
      downTime: p.downTime,
      upTime: time,
      consumed: false,
    };

    // Two-finger tap wins over double tap: it is the more deliberate gesture,
    // and its two taps would otherwise also read as a (very fast) double tap.
    for (let i = this.recentTaps.length - 1; i >= 0; i--) {
      const other = this.recentTaps[i]!;
      if (other.consumed) continue;
      const overlapped = other.downTime <= tap.upTime && tap.downTime <= other.upTime;
      const together =
        Math.abs(other.downTime - tap.downTime) <= this.tuning.twoFingerTapWindowSec;
      if (overlapped && together) {
        other.consumed = true;
        tap.consumed = true;
        this.queuePulse('lockOn');
        this.emitGesture('twoFingerTapLock', (tap.x + other.x) / 2, (tap.y + other.y) / 2, time);
        break;
      }
    }

    if (!tap.consumed) {
      for (let i = this.recentTaps.length - 1; i >= 0; i--) {
        const other = this.recentTaps[i]!;
        if (other.consumed) continue;
        const gap = tap.upTime - other.upTime;
        if (gap < 0 || gap > this.tuning.doubleTapWindow) continue;
        const overlapped = other.downTime <= tap.upTime && tap.downTime <= other.upTime;
        if (overlapped) continue; // simultaneous: not a double tap
        if (Math.hypot(tap.x - other.x, tap.y - other.y) > this.tuning.doubleTapMaxDistPx) continue;
        other.consumed = true;
        tap.consumed = true;
        this.queuePulse('jump');
        this.emitGesture('doubleTapJump', tap.x, tap.y, time);
        break;
      }
    }

    this.recentTaps.push(tap);
    // Retain a short window; anything older can never form a gesture.
    const cutoff = time - Math.max(this.tuning.doubleTapWindow, this.tuning.tapMaxDurationSec) * 2;
    while (this.recentTaps.length > 0 && this.recentTaps[0]!.upTime < cutoff) {
      this.recentTaps.shift();
    }
    if (this.recentTaps.length > 8) this.recentTaps.splice(0, this.recentTaps.length - 8);
  }

  /* ---------------------------------------------------------------------- */
  /* Frame sampling                                                         */
  /* ---------------------------------------------------------------------- */

  sample(dt: number, time: number, out: InputContribution): void {
    this.lastTime = time;

    /* ---- stick ---- */
    const stick = this.stick;
    if (stick) {
      const deflection = radialDeflection(
        stick.x - stick.originX,
        stick.y - stick.originY,
        this.tuning.stickDeadZonePx,
        this.tuning.stickFullDeflectionPx
      );
      out.setMove(deflection.x, deflection.y);
      out.active = true;
    }

    /* ---- camera drag ---- */
    const dragging = this.cameraIds.length > 0;
    const rate = this.lookSmoother.update(this.dragAccumX, this.dragAccumY, dt, this.tuning);
    if (dragging || !this.lookSmoother.settled) {
      out.setLook(rate.x, rate.y);
    }
    if (dragging) out.active = true;
    this.dragAccumX = 0;
    this.dragAccumY = 0;

    /* ---- pinch / twist ---- */
    if (this.pinchAccum !== 1) {
      out.pinchDelta = this.pinchAccum;
      out.active = true;
    }
    if (this.twistAccum !== 0) {
      out.twistDelta = this.twistAccum;
      out.active = true;
    }
    this.pinchAccum = 1;
    this.twistAccum = 0;

    /* ---- buttons ---- */
    if (this.buttons.get('punch')!.down) {
      out.hold('punch', 1);
      if (this.charge.tick(dt, this.tuning)) this.callbacks.onChargeComplete?.();
    }
    if (this.buttons.get('jump')!.down) out.hold('jump', 1);
    if (this.buttons.get('interact')!.down && this.interactAvailable) out.hold('interact', 1);
    if (this.dashOn) out.hold('sprint', 1);

    /* ---- gesture pulses queued between frames ---- */
    for (const [action, value] of this.pendingPulses) out.pulse(action, value);
    this.pendingPulses.clear();
    for (const action of this.pendingSilentClears) out.clearSilently(action);
    this.pendingSilentClears.clear();

    /* ---- pointer samples ---- */
    out.pointers = this.collectPointerSamples();
    if (out.pointers.length > 0) out.active = true;
  }

  private collectPointerSamples(): PointerSample[] {
    const samples: PointerSample[] = [];
    const invW = 1 / this.viewportW;
    const invH = 1 / this.viewportH;

    for (const p of this.pointers.values()) {
      const nx = clamp01(p.x * invW);
      const ny = clamp01(p.y * invH);
      samples.push({
        id: p.id,
        x: nx,
        y: ny,
        dx: p.freshDown ? 0 : nx - p.prevNormX,
        dy: p.freshDown ? 0 : ny - p.prevNormY,
        pressure: p.pressure,
        down: p.freshDown,
        up: false,
      });
      p.prevNormX = nx;
      p.prevNormY = ny;
      p.freshDown = false;
    }

    // Pointers that ended during this frame are reported exactly once, so a
    // tap that starts and finishes between two polls is never invisible.
    for (const p of this.ending) {
      const nx = clamp01(p.x * invW);
      const ny = clamp01(p.y * invH);
      samples.push({
        id: p.id,
        x: nx,
        y: ny,
        dx: p.freshDown ? 0 : nx - p.prevNormX,
        dy: p.freshDown ? 0 : ny - p.prevNormY,
        pressure: p.pressure,
        down: p.freshDown,
        up: true,
      });
    }
    this.ending.length = 0;

    samples.sort((a, b) => a.id - b.id);
    return samples;
  }

  /* ---------------------------------------------------------------------- */
  /* Reset                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Drop EVERYTHING. Called on window blur, app background, visibility loss
   * and pointer-capture loss. After this the stick is centred, no button is
   * held, and no edges will be emitted — which is precisely the guarantee that
   * stops a backgrounded app from returning with the character sprinting into
   * a wall.
   */
  reset(): void {
    this.pointers.clear();
    this.ending.length = 0;
    this.stickPointerId = -1;
    this.cameraIds.length = 0;
    this.haveCameraBaseline = false;
    this.dragAccumX = 0;
    this.dragAccumY = 0;
    this.pinchAccum = 1;
    this.twistAccum = 0;
    this.lookSmoother.reset();
    for (const id of TOUCH_BUTTON_IDS) {
      const runtime = this.buttons.get(id)!;
      runtime.down = false;
      runtime.pointerId = -1;
    }
    this.charge.reset();
    this.recentTaps.length = 0;
    this.pendingPulses.clear();
    this.pendingSilentClears.clear();
  }

  /** Cancel one pointer by id — the DOM layer's `lostpointercapture` path. */
  cancelPointer(id: number, time: number): void {
    const p = this.pointers.get(id);
    if (!p) return;
    this.onEnd({ id, x: p.x, y: p.y, phase: 'cancel', time }, true);
  }

  /** Cancel every live pointer. */
  cancelAll(time: number): void {
    for (const id of [...this.pointers.keys()]) this.cancelPointer(id, time);
  }
}
