/**
 * THE LOADING SCREEN
 *
 * ── REAL PROGRESS, OR NONE ─────────────────────────────────────────────────
 * The bar reads `model.loading.progress`, which the bootstrap advances from
 * actual completed work: assets fetched, chunks generated, physics colliders
 * built. It is never animated on a timer and it never eases to 90% and waits.
 * A fake bar is worse than no bar — a player who has seen one bar lie stops
 * believing all of them, including the honest one that says a 40-second install
 * is 12 seconds from done.
 *
 * The step LABEL is what makes the bar tolerable. "Baking radiance" is a
 * different experience from a bar that sits at 34% for nine seconds, even when
 * the nine seconds are identical.
 *
 * ── WHY IT IS NOT `index.html`'s BOOT SCREEN ───────────────────────────────
 * `index.html` owns a boot screen that shows before any JavaScript has parsed;
 * it must, or the first paint is a black rectangle. This one takes over once
 * the HUD exists and outlives it — it comes back for every subsequent load
 * (fast travel, a save restore), which the inline one cannot do because it is
 * removed from the document.
 *
 * ── IT IS A CARD, NOT A SPLASH ─────────────────────────────────────────────
 * Everything on this screen used to be centred, and centring is what was wrong
 * with it. Measured off a real device: the title sat 2.00 CSS px left of centre
 * and the subtitle 1.83 px, because CSS adds letter-spacing after the FINAL
 * glyph too and heavy tracking therefore pushes centred text half a tracking
 * unit left — the two untracked flavour lines measured 0.17 and 0.33 px, i.e.
 * dead centre, which is the control that proves it. On top of that the whole
 * column was centred inside an ASYMMETRIC padding box, so the vertical centre
 * was 213.5 px on a 440 px viewport instead of 220.
 *
 * It is a filed card now: one plate, one measure, everything flush left against
 * it, and the ONE PUNCH MAN / CITY Z pair tight together above the bar because
 * they are one unit — "CITY Z" used to sit 15 px from the progress bar and
 * 18.3 px from the title it is the subtitle of, so it optically belonged to the
 * bar. The order of the four blocks is the order they are read in and the gaps
 * say which of them belong together.
 */

import { clamp01 } from '@/util';
import { CssNumber } from '../css-number';
import { el } from '../dom';
import type { FrameWriter } from '../frame-writer';
import type { IHudModel } from '../model';
import { HudScreen, type HudScreenName } from '../screen';

/**
 * Loading-screen copy.
 *
 * Rules of the world rather than tips, because there is nothing to be good at.
 * Each one is a real mechanic the player can verify in the systems.
 */
export const LOADING_LINES: readonly string[] = [
  'The Hero Association scores what is reported. Two hundred kills in an empty alley is worth exactly zero points.',
  'Credit needs a witness. Blame does not.',
  'A serious punch ends the fight and bills the district. Both are true at once.',
  'Boredom throttles rank gain to ×0.15. It is not a penalty, it is a diagnosis.',
  'The supermarket sale ends at six whether you are there or not.',
  'Genos files a full statement with sensor recordings. You say you punched it.',
];

export interface ILoadingOptions {
  /** Chooses the line shown. Defaults to a stable pick, for reproducible shots. */
  readonly lineIndex?: number;
}

export class LoadingScreen extends HudScreen {
  readonly name: HudScreenName = 'boot';

  private readonly fill: HTMLElement;
  private readonly label: HTMLElement;
  private readonly percent: CssNumber;
  private readonly tip: HTMLElement;
  private lastLabel = '';

  constructor(doc: Document, options: ILoadingOptions = {}) {
    super(doc, 'hud-layer hud-layer--screen hud-loading', true);

    this.fill = el(doc, 'div', { className: 'hud-loading__fill' });
    this.label = el(doc, 'div', { className: 'hud-loading__label', text: 'Initialising' });
    this.percent = new CssNumber(doc, { suffix: '%', id: 'load' });
    this.tip = el(doc, 'div', {
      className: 'hud-loading__tip',
      text: LOADING_LINES[(options.lineIndex ?? 0) % LOADING_LINES.length]!,
    });

    this.element.append(
      el(doc, 'div', {
        className: 'hud-loading__card',
        children: [
          el(doc, 'div', { className: 'hud-loading__title', text: 'One Punch Man' }),
          el(doc, 'div', { className: 'hud-loading__sub', text: 'City Z' }),
          el(doc, 'div', {
            className: 'hud-loading__track',
            attrs: { 'data-hud': 'loading-track' },
            children: [this.fill],
          }),
          // The percentage LEADS the row, at the same x as the fill's origin.
          // It used to trail a flex:1 label in a row exactly as wide as the
          // bar, which stranded it 238 px from the fill head across a 167 px
          // void — and made the row's own justify-content:center dead code.
          el(doc, 'div', {
            className: 'hud-loading__row',
            children: [
              el(doc, 'span', {
                className: 'hud-loading__pct',
                children: [this.percent.element],
              }),
              this.label,
            ],
          }),
          this.tip,
        ],
      })
    );
    this.element.setAttribute('data-screen', 'boot');
  }

  override render(model: IHudModel): void {
    if (model.loading.label !== this.lastLabel) {
      this.lastLabel = model.loading.label;
      this.label.textContent = model.loading.label;
    }
  }

  override frame(model: IHudModel, writer: FrameWriter): void {
    const progress = clamp01(model.loading.progress);
    writer.setNumber(this.fill, '--fill', progress, 4);
    this.percent.write(writer, Math.floor(progress * 100));
  }
}
