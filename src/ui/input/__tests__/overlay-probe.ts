/**
 * PAGE-SIDE PROBE for the overlay's browser tests.
 *
 * Bundled by `browser-harness.ts` and injected into a headless Chromium page.
 * It mounts a REAL touch source — the same `createTouchSource` the game calls —
 * and exposes measurements of what the layout engine actually produced.
 *
 * Nothing here asserts. Everything it returns is a number or a rect, and the
 * judgement lives in `overlay-browser.test.ts` on the Node side, so a failure
 * reports through vitest with a real diff instead of through a thrown string.
 */

import { resolveTuning, type IInputTuning } from '../config';
import { InputContribution } from '../backend';
import { fixedStickAnchor } from '../stick-geometry';
import { TOUCH_BUTTON_IDS, type TouchButtonId } from '../touch-core';
import { createTouchSource, type ITouchInputSource } from '../touch-source';

/** A rect reduced to what the assertions care about. */
export interface IProbeRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly centreX: number;
  readonly centreY: number;
}

/** One measurement of the whole overlay. */
export interface IProbeMeasurement {
  readonly stick: IProbeRect | null;
  readonly knob: IProbeRect | null;
  readonly buttons: Record<string, IProbeRect | null>;
  readonly labelFontPx: Record<string, number>;
  readonly stickOpacity: number;
  readonly stickActive: string;
  readonly layout: string;
  readonly hand: string;
  readonly anchor: { x: number; y: number };
  readonly resolvedInsets: { top: number; right: number; bottom: number; left: number };
  readonly viewport: { width: number; height: number };
}

declare global {
  interface Window {
    /** Installed by this module's own side effect when the bundle evaluates. */
    __OVERLAY_PROBE__: IOverlayProbe;
  }
}

export interface IOverlayProbe {
  mount(patch?: Partial<IInputTuning>): void;
  setSafeArea(insets: { top: number; right: number; bottom: number; left: number }): void;
  frame(): void;
  measure(): IProbeMeasurement;
  press(id: number, x: number, y: number): void;
  moveTo(id: number, x: number, y: number): void;
  release(id: number, x: number, y: number): void;
  /** Dispatch `lostpointercapture` AT a button, exactly as the browser does. */
  loseCaptureAtButton(id: number, button: TouchButtonId): void;
  isButtonDown(button: TouchButtonId): boolean;
  dispose(): void;
}

function rectOf(element: Element | null): IProbeRect | null {
  if (!element) return null;
  const r = element.getBoundingClientRect();
  return {
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
    centreX: r.x + r.width / 2,
    centreY: r.y + r.height / 2,
  };
}

function pointerEvent(type: string, id: number, x: number, y: number): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: id,
    pointerType: 'touch',
    isPrimary: true,
    clientX: x,
    clientY: y,
    pressure: 0.5,
    buttons: type === 'pointerup' ? 0 : 1,
  });
}

/**
 * Deliver an event the way the browser would.
 *
 * `pointerdown` goes to whatever is under the point. EVERYTHING AFTER IT goes
 * to that same element, because a touch pointer holds implicit capture on the
 * element it landed on for its whole lifetime — which is exactly the mechanism
 * the `lostpointercapture` bug below turns on, and it is also why a thumb that
 * drags off the top of the screen keeps reaching the input root.
 */
const captured = new Map<number, Element>();

function dispatchAt(type: string, id: number, x: number, y: number): void {
  let target = captured.get(id);
  if (type === 'pointerdown' || !target) {
    target =
      document.elementFromPoint(x, y) ?? document.querySelector('.opm-input-root') ?? document.body;
    captured.set(id, target);
  }
  target.dispatchEvent(pointerEvent(type, id, x, y));
  if (type === 'pointerup' || type === 'pointercancel') captured.delete(id);
}

export function installOverlayProbe(): IOverlayProbe {
  let source: ITouchInputSource | null = null;
  let tuning: IInputTuning = resolveTuning();
  const out = new InputContribution();
  let time = 0;

  const probe: IOverlayProbe = {
    mount(patch): void {
      source?.dispose();
      captured.clear();
      // A previous overlay's stylesheet survives `dispose()` by design (it is
      // shared by id); `createTouchOverlay` regenerates it, which is exactly
      // the path a live re-tune takes.
      tuning = resolveTuning(patch);
      source = createTouchSource(tuning, { mount: document.body });
      probe.frame();
    },

    setSafeArea(insets): void {
      source?.setSafeArea(insets);
      probe.frame();
    },

    frame(): void {
      time += 1 / 60;
      out.reset();
      source?.sample(1 / 60, time, out);
    },

    measure(): IProbeMeasurement {
      const stickEl = document.querySelector('.opm-stick');
      const buttons: Record<string, IProbeRect | null> = {};
      const labelFontPx: Record<string, number> = {};
      for (const id of TOUCH_BUTTON_IDS) {
        const el = document.querySelector(`.opm-btn[data-id="${id}"]`);
        buttons[id] = rectOf(el);
        const label = el?.querySelector('.opm-btn-label');
        labelFontPx[id] = label ? Number.parseFloat(getComputedStyle(label).fontSize) : Number.NaN;
      }
      const root = document.querySelector<HTMLElement>('.opm-input-root');
      const insets = source?.overlay?.resolvedSafeArea() ?? {
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
      };
      return {
        stick: rectOf(stickEl),
        knob: rectOf(document.querySelector('.opm-stick-knob')),
        buttons,
        labelFontPx,
        stickOpacity: stickEl ? Number.parseFloat(getComputedStyle(stickEl).opacity) : Number.NaN,
        stickActive: (stickEl as HTMLElement | null)?.dataset.active ?? '',
        layout: root?.dataset.stick ?? '',
        hand: root?.dataset.hand ?? '',
        anchor: fixedStickAnchor(tuning, window.innerWidth, window.innerHeight, insets),
        resolvedInsets: insets,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    },

    press(id, x, y): void {
      dispatchAt('pointerdown', id, x, y);
      probe.frame();
    },

    moveTo(id, x, y): void {
      dispatchAt('pointermove', id, x, y);
      probe.frame();
    },

    release(id, x, y): void {
      dispatchAt('pointerup', id, x, y);
      probe.frame();
    },

    loseCaptureAtButton(id, button): void {
      const el = document.querySelector(`.opm-btn[data-id="${button}"]`);
      el?.dispatchEvent(pointerEvent('lostpointercapture', id, 0, 0));
      probe.frame();
    },

    isButtonDown(button): boolean {
      return source?.core.isButtonDown(button) ?? false;
    },

    dispose(): void {
      source?.dispose();
      source = null;
    },
  };

  (globalThis as unknown as { __OVERLAY_PROBE__: IOverlayProbe }).__OVERLAY_PROBE__ = probe;
  return probe;
}

installOverlayProbe();
