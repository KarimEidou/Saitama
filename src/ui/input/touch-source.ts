/**
 * TOUCH BACKEND — Pointer Events -> `TouchCore` -> `InputContribution`.
 *
 * Implemented directly against the Pointer Events API rather than a library.
 * `nipplejs` and friends are built around `touchstart`/`touchmove`, cannot
 * express "this finger owns the stick, that finger owns the camera, and this
 * third one owns a button", and are ~40 KB for a control that is 150 lines of
 * arithmetic. The whole value of this system is multi-touch correctness, and
 * that is precisely the part a generic joystick library does not give you.
 *
 * ── THE FOUR WAYS A TOUCH CONTROL GETS STUCK, AND WHAT WE DO ───────────────
 *  1. `pointercancel` — the browser decided the gesture was a scroll/zoom, or
 *     the OS interrupted (call, notification shade). Handled identically to
 *     `pointerup`, minus gesture recognition.
 *  2. `lostpointercapture` while still down — capture was yanked out from
 *     under us. We cancel that pointer.
 *  3. Window blur / tab hidden / `pagehide` — every event after this is a lie.
 *     We cancel EVERY pointer and reset the tracker.
 *  4. A `pointerdown` arriving for an id we already track — we missed an up.
 *     `TouchCore` cancels the stale one first.
 *
 * All four are exercised by `harness/input.verify.ts`.
 */

import type { SafeAreaInsets } from '@/types';
import { createLogger } from '@/util';
import type { IInputBackend, InputContribution } from './backend';
import type { IInputTuning } from './config';
import type { IHaptics } from './haptics';
import {
  TouchCore,
  TOUCH_BUTTON_IDS,
  type GestureEvent,
  type PointerDebug,
  type PointerInput,
  type TouchButtonId,
} from './touch-core';
import { createTouchOverlay, type ITouchOverlay } from './touch-overlay';

const log = createLogger('input.touch');

export interface ITouchSourceOptions {
  /** Element the overlay mounts into. Defaults to `document.body`. */
  readonly mount?: HTMLElement;
  /** Skip the DOM overlay entirely (headless smoke tests). */
  readonly headless?: boolean;
  /** Haptics sink for charge-complete. */
  readonly haptics?: IHaptics;
  /** Clock in SECONDS. Defaults to `performance.now() / 1000`. */
  readonly now?: () => number;
  /** Called for every recognised gesture — the harness logs these. */
  readonly onGesture?: (event: GestureEvent) => void;
}

/** Public surface of the touch backend beyond `IInputBackend`. */
export interface ITouchInputSource extends IInputBackend {
  readonly core: TouchCore;
  readonly overlay: ITouchOverlay | null;
  /** Show/hide the context-sensitive interact button. `null` hides it. */
  setInteractPrompt(label: string | null): void;
  setSafeArea(insets: SafeAreaInsets): void;
  setTuning(tuning: IInputTuning): void;
  /** Live pointer table for debug UI. */
  debugPointers(): PointerDebug[];
  /** 0..1 punch charge ring fill. */
  readonly chargeRatio: number;
  readonly lastGesture: GestureEvent | null;
  /** Force the dash toggle (e.g. gameplay cancels a dash). */
  setDashToggle(on: boolean): void;
  readonly dashOn: boolean;
}

/**
 * Create the touch backend. Returns a working (if invisible) backend even
 * without a DOM, so callers never have to branch on platform.
 */
export function createTouchSource(
  tuning: IInputTuning,
  options: ITouchSourceOptions = {}
): ITouchInputSource {
  const hasDom = typeof document !== 'undefined' && typeof window !== 'undefined';
  const now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000);
  const haptics = options.haptics;

  let activeTuning = tuning;
  let interactPrompt: string | null = null;

  const core = new TouchCore(activeTuning, {
    onChargeComplete: () => {
      haptics?.play('chargeComplete');
    },
    onGesture: (event) => {
      // A recognised gesture is a discrete, deliberate act; a short tick makes
      // it legible without competing with the charge/kill cues.
      if (event.gesture !== 'swipeUpUppercut') haptics?.play('gesture');
      options.onGesture?.(event);
    },
    onDashToggle: () => {
      haptics?.play('gesture');
    },
  });

  const mount = options.mount ?? (hasDom ? document.body : null);
  const overlay =
    !options.headless && mount ? createTouchOverlay(mount, activeTuning) : null;

  const listenerRoot: HTMLElement | null = overlay?.root ?? null;
  let disposed = false;
  let enabled = true;

  /* ---------------------------------------------------------------------- */
  /* Viewport                                                               */
  /* ---------------------------------------------------------------------- */

  let originX = 0;
  let originY = 0;

  function refreshViewport(): void {
    if (listenerRoot) {
      const rect = listenerRoot.getBoundingClientRect();
      originX = rect.left;
      originY = rect.top;
      core.setViewport(rect.width || 1, rect.height || 1);
    } else if (hasDom) {
      originX = 0;
      originY = 0;
      core.setViewport(window.innerWidth, window.innerHeight);
    } else {
      core.setViewport(1, 1);
    }
  }
  refreshViewport();

  /* ---------------------------------------------------------------------- */
  /* Pointer plumbing                                                       */
  /* ---------------------------------------------------------------------- */

  function toInput(event: PointerEvent, phase: PointerInput['phase']): PointerInput {
    return {
      id: event.pointerId,
      x: event.clientX - originX,
      y: event.clientY - originY,
      phase,
      time: now(),
      pressure: event.pressure > 0 ? event.pressure : 1,
      hit: phase === 'down' ? (overlay?.resolveHit(event.target) ?? null) : undefined,
    };
  }

  function onPointerDown(event: PointerEvent): void {
    if (!enabled) return;
    refreshViewport();
    core.handle(toInput(event, 'down'));
    // Explicit capture so a thumb that slides off the element — or off the
    // screen edge — keeps delivering moves to us. Touch pointers get implicit
    // capture already; mouse and pen do not.
    try {
      listenerRoot?.setPointerCapture(event.pointerId);
    } catch {
      /* capture is best-effort; the core copes without it */
    }
    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent): void {
    if (!enabled) return;
    // Coalesced events give sub-frame resolution on high-rate digitisers,
    // which is the difference between a smooth camera pan and a stepped one.
    const events: PointerEvent[] =
      typeof event.getCoalescedEvents === 'function'
        ? (event.getCoalescedEvents() as PointerEvent[])
        : [];
    if (events.length > 1) {
      for (const coalesced of events) core.handle(toInput(coalesced, 'move'));
    } else {
      core.handle(toInput(event, 'move'));
    }
    event.preventDefault();
  }

  function onPointerUp(event: PointerEvent): void {
    core.handle(toInput(event, 'up'));
    releaseCapture(event.pointerId);
    event.preventDefault();
  }

  function onPointerCancel(event: PointerEvent): void {
    core.handle(toInput(event, 'cancel'));
    releaseCapture(event.pointerId);
  }

  function releaseCapture(pointerId: number): void {
    try {
      if (listenerRoot?.hasPointerCapture(pointerId)) listenerRoot.releasePointerCapture(pointerId);
    } catch {
      /* already released */
    }
  }

  /**
   * Capture was taken away while the pointer is still down. `TouchCore.handle`
   * on `up`/`cancel` removes the pointer BEFORE we release capture, so the
   * `lostpointercapture` that follows a normal release finds nothing to do.
   * Anything left here is a genuine steal.
   */
  function onLostCapture(event: PointerEvent): void {
    core.cancelPointer(event.pointerId, now());
  }

  function onWindowBlur(): void {
    core.cancelAll(now());
    core.reset();
  }

  function onVisibility(): void {
    if (document.visibilityState === 'hidden') onWindowBlur();
  }

  function swallow(event: Event): void {
    event.preventDefault();
  }

  if (listenerRoot && hasDom) {
    listenerRoot.addEventListener('pointerdown', onPointerDown as EventListener);
    listenerRoot.addEventListener('pointermove', onPointerMove as EventListener);
    listenerRoot.addEventListener('pointerup', onPointerUp as EventListener);
    listenerRoot.addEventListener('pointercancel', onPointerCancel as EventListener);
    listenerRoot.addEventListener('lostpointercapture', onLostCapture as EventListener);
    // Long-press context menus and text selection both cancel the pointer
    // stream mid-drag on Android WebView.
    listenerRoot.addEventListener('contextmenu', swallow);
    listenerRoot.addEventListener('selectstart', swallow);
    listenerRoot.addEventListener('dragstart', swallow);
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('pagehide', onWindowBlur);
    window.addEventListener('resize', refreshViewport, { passive: true });
    window.addEventListener('orientationchange', refreshViewport, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    log.info('touch backend attached');
  } else if (!options.headless) {
    log.warn('no DOM available — touch backend running headless');
  }

  /* ---------------------------------------------------------------------- */
  /* Backend                                                                */
  /* ---------------------------------------------------------------------- */

  const buttonDown = {} as Record<TouchButtonId, boolean>;

  const source: ITouchInputSource = {
    device: 'touch',
    core,
    overlay,

    get enabled(): boolean {
      return enabled;
    },
    set enabled(value: boolean) {
      if (enabled === value) return;
      enabled = value;
      if (!value) {
        core.cancelAll(now());
        core.reset();
      }
    },

    sample(dt: number, time: number, out: InputContribution): void {
      if (!enabled) return;
      core.sample(dt, time, out);
      if (overlay) {
        for (const id of TOUCH_BUTTON_IDS) buttonDown[id] = core.isButtonDown(id);
        overlay.sync({
          stick: core.stick,
          chargeRatio: core.chargeRatio,
          charging: core.chargeHoldTime >= activeTuning.chargeStartSec,
          buttonDown,
          dashOn: core.isDashOn,
          interactAvailable: core.isInteractAvailable,
        });
      }
    },

    reset(): void {
      core.cancelAll(now());
      core.reset();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (listenerRoot && hasDom) {
        listenerRoot.removeEventListener('pointerdown', onPointerDown as EventListener);
        listenerRoot.removeEventListener('pointermove', onPointerMove as EventListener);
        listenerRoot.removeEventListener('pointerup', onPointerUp as EventListener);
        listenerRoot.removeEventListener('pointercancel', onPointerCancel as EventListener);
        listenerRoot.removeEventListener('lostpointercapture', onLostCapture as EventListener);
        listenerRoot.removeEventListener('contextmenu', swallow);
        listenerRoot.removeEventListener('selectstart', swallow);
        listenerRoot.removeEventListener('dragstart', swallow);
        window.removeEventListener('blur', onWindowBlur);
        window.removeEventListener('pagehide', onWindowBlur);
        window.removeEventListener('resize', refreshViewport);
        window.removeEventListener('orientationchange', refreshViewport);
        document.removeEventListener('visibilitychange', onVisibility);
      }
      overlay?.dispose();
      core.reset();
    },

    setInteractPrompt(label: string | null): void {
      interactPrompt = label;
      core.setInteractAvailable(label !== null);
      overlay?.setInteractPrompt(label);
    },

    setSafeArea(insets: SafeAreaInsets): void {
      overlay?.setSafeArea(insets);
    },

    setTuning(next: IInputTuning): void {
      activeTuning = next;
      core.setTuning(next);
      overlay?.setTuning(next);
    },

    debugPointers(): PointerDebug[] {
      return core.debugPointers(now());
    },

    get chargeRatio(): number {
      return core.chargeRatio;
    },

    get lastGesture(): GestureEvent | null {
      return core.lastRecognisedGesture;
    },

    setDashToggle(on: boolean): void {
      core.setDashToggle(on);
    },

    get dashOn(): boolean {
      return core.isDashOn;
    },
  };

  // Keep the accessor honest for anyone reading it back.
  void interactPrompt;

  return source;
}
