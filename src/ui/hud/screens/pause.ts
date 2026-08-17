/**
 * PAUSE
 *
 * Four destinations and a resume, at 44 px minimum, in the middle of the
 * screen where either thumb can reach them.
 *
 * ── WHY THE PAUSE MENU SHOWS THE BOREDOM LINE ──────────────────────────────
 * A pause screen is where a player stops and asks "what am I doing". This game
 * has an answer, and it is not a quest objective — it is the mood readout and
 * the rank that will not move. Printing them here, quietly, under the buttons,
 * costs one line and is the difference between a menu and the game continuing
 * to talk while it is paused.
 */

import { button, el } from '../dom';
import { formatMultiplier, formatRank } from '../format';
import type { IHudModel } from '../model';
import { HudScreen, type HudScreenName } from '../screen';
import { boredomBand, CLASS_COLOR } from '../tokens';

export interface IPauseOptions {
  readonly onResume: () => void;
  readonly onQuests: () => void;
  readonly onRank: () => void;
  readonly onSettings: () => void;
}

export class PauseScreen extends HudScreen {
  readonly name: HudScreenName = 'pause';

  private readonly standing: HTMLElement;
  private readonly mood: HTMLElement;
  private readonly onResume: () => void;

  constructor(doc: Document, options: IPauseOptions) {
    super(doc, 'hud-layer hud-layer--screen hud-screen hud-screen--centre', true);
    this.onResume = options.onResume;

    this.standing = el(doc, 'div', { className: 'hud-sheet__sub', text: '' });
    this.mood = el(doc, 'div', { className: 'hud-note', text: '' });

    this.element.appendChild(
      el(doc, 'div', {
        className: 'hud-sheet',
        attrs: { 'data-screen': 'pause' },
        vars: { 'max-width': '420px' },
        children: [
          el(doc, 'div', {
            className: 'hud-sheet__head',
            children: [
              el(doc, 'div', { className: 'hud-sheet__title', text: 'Paused' }),
              this.standing,
            ],
          }),
          el(doc, 'div', {
            className: 'hud-sheet__body',
            children: [
              el(doc, 'div', {
                vars: { display: 'grid', gap: '8px' },
                children: [
                  button(doc, 'Resume', options.onResume, {
                    className: 'hud-btn--primary',
                    attrs: { 'data-hud': 'pause-resume' },
                  }),
                  button(doc, 'Requests', options.onQuests, {
                    attrs: { 'data-hud': 'pause-quests' },
                  }),
                  button(doc, 'Hero Association', options.onRank, {
                    attrs: { 'data-hud': 'pause-rank' },
                  }),
                  button(doc, 'Settings', options.onSettings, {
                    attrs: { 'data-hud': 'pause-settings' },
                  }),
                ],
              }),
              this.mood,
            ],
          }),
        ],
      })
    );
  }

  override onBack(): boolean {
    this.onResume();
    return true;
  }

  override render(model: IHudModel): void {
    const rank = model.rank;
    this.standing.textContent = `${rank.heroName} · ${formatRank(rank.heroClass, rank.rank)}`;
    this.standing.style.setProperty('color', CLASS_COLOR[rank.heroClass]);
    const band = boredomBand(model.boredom);
    this.mood.textContent =
      `${band.label.toLowerCase()} · rank gain ${formatMultiplier(rank.rankGainMultiplier)}` +
      (model.encounter ? ` · ${model.encounter.name} is still standing` : '');
  }
}
