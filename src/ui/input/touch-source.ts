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
 * COVERAGE, accurately: path 1 end-to-end in `harness/input.verify.ts` (§6/§7,
 * via CDP `touchCancel`); path 4 in `touch-core.test.ts` ("recovers from a
 * duplicate pointerdown for a live id"); path 2's ACCIDENTAL trigger — a
 * descendant's capture loss bubbling up here — in
 * `__tests__/overlay-browser.test.ts`, which is where the bug below was found.
 * Path 3 still has NO automated coverage (CDP cannot background the page), so
 * re-verify that listener wiring by hand whenever it changes.
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
  /** Current context prompt label, or null when no target is in range. */
  readonly interactPrompt: string | null;
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
  const now =
    options.now ??
    (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000);
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
  const overlay = !options.headless && mount ? createTouchOverlay(mount, activeTuning) : null;

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

  /**
   * Hand the core the insets the OVERLAY's CSS actually resolved.
   *
   * `setSafeArea` only ever reached the overlay, which was fine while the core
   * had no geometry of its own. It does now: the anchored stick's origin is
   * measured from the safe-area corner, and the CSS paints the ring from that
   * same corner. Two sources for one number is how the ring ends up 44px from
   * the origin on exactly the notched phones the safe-area apparatus exists for.
   *
   * Read from the overlay rather than from the argument to `setSafeArea`,
   * because the two are not the same thing: the CSS uses
   * `max(env(...), override)` and the game never calls `setSafeArea` at all on
   * a platform where `env()` already works.
   *
   * Deliberately NOT called from `refreshViewport`: that runs on every
   * `pointerdown`, and this forces style resolution.
   */
  function refreshCoreSafeArea(): void {
    if (overlay) core.setSafeArea(overlay.resolvedSafeArea());
  }
  refreshCoreSafeArea();

  function onViewportChange(): void {
    refreshViewport();
    refreshCoreSafeArea();
  }

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
    // Explicit capture so a cursor that slides off the element — or off the
    // screen edge — keeps delivering moves to us. TOUCH POINTERS ARE EXCLUDED,
    // and that exclusion is a bug fix, not an optimisation.
    //
    // A touch already has IMPLICIT capture, granted to whatever element it
    // landed on. Land on `.opm-btn` and the button holds it; transferring it to
    // the root fires `lostpointercapture` AT THE BUTTON, which BUBBLES to the
    // root, where `onLostCapture` cancelled the press — a finger still
    // physically on the punch button, released by our own capture call. Every
    // event a touch generates already bubbles up to this root regardless of
    // which descendant holds the capture, so there was never anything to gain.
    //
    // Mouse and pen get no implicit capture and still need this.
    if (event.pointerType !== 'touch') {
      try {
        listenerRoot?.setPointerCapture(event.pointerId);
      } catch {
        /* capture is best-effort; the core copes without it */
      }
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
   *
   * ...as long as it is OUR capture. This event bubbles, so a descendant losing
   * its own implicit touch capture — which is a routine part of every press on
   * a button — arrives here looking identical to a steal, and cancelling on it
   * releases a button the player is still holding. Only a loss reported against
   * the listener root is ours to act on. (A real browser gesture-steal fires
   * `pointercancel` as well, which we handle on its own path, so nothing is
   * missed by being strict here.)
   */
  function onLostCapture(event: PointerEvent): void {
    if (event.target !== listenerRoot) return;
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
    window.addEventListener('resize', onViewportChange, { passive: true });
    window.addEventListener('orientationchange', onViewportChange, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    log.info('touch backend attached');
  } else if (!options.headless) {
    log.warn('no DOM available — touch backend running headless');
  }

  /* ---------------------------------------------------------------------- */
  /* Backend                                                                */
  /* ---------------------------------------------------------------------- */

  const buttonDown = {} as Record<TouchButtonId, boolean>;

  /**
   * Push the core's current state to the overlay. Called from `sample()` and
   * from every path that clears the core WITHOUT a following sample — the
   * overlay holds no state of its own, so a reset that skips this leaves a
   * deflected knob and pressed buttons painted on screen until input is
   * re-enabled and polled again.
   */
  function syncOverlay(): void {
    if (!overlay) return;
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
        syncOverlay();
      }
    },

    sample(dt: number, time: number, out: InputContribution): void {
      if (!enabled) return;
      core.sample(dt, time, out);
      syncOverlay();
    },

    reset(): void {
      core.cancelAll(now());
      core.reset();
      syncOverlay();
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
        window.removeEventListener('resize', onViewportChange);
        window.removeEventListener('orientationchange', onViewportChange);
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
      refreshCoreSafeArea();
      // No overlay (headless) means no CSS to resolve, so the argument is the
      // only truth there is.
      if (!overlay) core.setSafeArea(insets);
    },

    setTuning(next: IInputTuning): void {
      activeTuning = next;
      core.setTuning(next);
      overlay?.setTuning(next);
      // The stylesheet the insets resolve against was just regenerated, and the
      // anchor inset itself may have moved with it.
      refreshCoreSafeArea();
    },

    debugPointers(): PointerDebug[] {
      return core.debugPointers(now());
    },

    get chargeRatio(): number {
      return core.chargeRatio;
    },

    get interactPrompt(): string | null {
      return interactPrompt;
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

  return source;
}
