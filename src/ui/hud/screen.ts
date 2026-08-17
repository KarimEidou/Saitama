/**
 * SCREEN BASE
 *
 * ── ONE NAME WIDENED, AND WHY ──────────────────────────────────────────────
 * `ScreenName` in `@/types/ui.ts` is a shared contract owned by another
 * workstream and has no `'results'` member. The end-of-encounter invoice is a
 * screen in every sense that matters — full-bleed, modal, pushed, popped, back-
 * button-aware — so it is added to a LOCAL widening, {@link HudScreenName},
 * rather than by editing a contract eleven other systems import.
 *
 * Every canonical `ScreenName` remains assignable to `HudScreenName`, so a
 * consumer holding the shared type can always call in; only the reverse
 * direction needs the widened type, and only inside this module.
 *
 * ── THE TWO-TIER UPDATE CONTRACT ───────────────────────────────────────────
 * Screens have two entry points and they are not interchangeable:
 *
 *   render(model)      Arbitrary DOM. Called when something a human would
 *                      notice changed — a quest completed, a rank moved. Costs
 *                      whatever it costs; it happens a few times a minute.
 *
 *   frame(model, w)    THE 60 Hz PATH. May write ONLY through the FrameWriter,
 *                      which accepts only custom properties. May not read
 *                      layout, may not touch `textContent`, may not create a
 *                      node. This is the rule the harness asserts.
 *
 * Splitting them is what makes the assertion possible: there is exactly one
 * method per screen that runs every frame, and it takes the writer as its only
 * way to reach the DOM.
 */

import type { ScreenName } from '@/types';
import type { IHudModel } from './model';
import type { FrameWriter } from './frame-writer';

/** Canonical screens plus the encounter invoice. See the module comment. */
export type HudScreenName = ScreenName | 'results';

/** A mountable HUD view. */
export interface IHudScreen {
  readonly name: HudScreenName;
  readonly element: HTMLElement;
  readonly visible: boolean;
  /** True when the screen covers the play field and should pause the game. */
  readonly modal: boolean;
  show(): void;
  hide(): void;
  /** Event-driven refresh. Arbitrary DOM writes allowed. */
  render(model: IHudModel): void;
  /** Per-frame refresh. Custom-property writes only, via the writer. */
  frame(model: IHudModel, writer: FrameWriter): void;
  /** Android back / Escape. Return true to consume. */
  onBack?(): boolean;
  dispose(): void;
}

/** Shared plumbing: visibility, mount point, disposal. */
export abstract class HudScreen implements IHudScreen {
  abstract readonly name: HudScreenName;
  readonly element: HTMLElement;
  readonly modal: boolean;

  protected readonly doc: Document;
  private visibleFlag = false;
  private readonly teardown: (() => void)[] = [];

  constructor(doc: Document, className: string, modal: boolean) {
    this.doc = doc;
    this.modal = modal;
    this.element = doc.createElement('div');
    this.element.className = className;
    this.element.hidden = true;
  }

  get visible(): boolean {
    return this.visibleFlag;
  }

  show(): void {
    if (this.visibleFlag) return;
    this.visibleFlag = true;
    this.element.hidden = false;
  }

  hide(): void {
    if (!this.visibleFlag) return;
    this.visibleFlag = false;
    this.element.hidden = true;
  }

  render(_model: IHudModel): void {}

  frame(_model: IHudModel, _writer: FrameWriter): void {}

  /**
   * Android back / Escape. The base refuses it, so a screen that does not
   * override this falls through to the manager's stack pop — which is the right
   * default for every screen that is merely a view.
   */
  onBack(): boolean {
    return false;
  }

  /** Register a cleanup callback run on `dispose`. */
  protected onDispose(fn: () => void): void {
    this.teardown.push(fn);
  }

  dispose(): void {
    for (const fn of this.teardown) fn();
    this.teardown.length = 0;
    this.element.remove();
  }
}
