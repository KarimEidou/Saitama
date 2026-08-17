/**
 * THE HERO ASSOCIATION RANK BOARD
 *
 * ── WHAT THIS SCREEN IS FOR ────────────────────────────────────────────────
 * It is the reward. Not the number going up — the number NOT going up, in
 * public, next to somebody else's.
 *
 * The player wins every fight instantly. There is no build, no gear, no skill
 * tree, and any progression system that pretended otherwise would be lying
 * about the character. What is left is an institution that scores heroism by
 * paperwork: credit needs a witness, blame does not, and a disciple who filed a
 * clear statement with sensor recordings banks 2.4× what the man who actually
 * ended the fight did.
 *
 * So this board has three parts and they are in this order deliberately:
 *
 *   1. YOUR STANDING       C-388, and what it would take to move.
 *   2. THE LADDER          Genos, Mumen Rider, Tanktop Master — and how many
 *                          seats above you each one sits, with the split
 *                          between credit they earned AT YOUR FIGHTS and credit
 *                          they earned while you were at the supermarket.
 *   3. RECENT MOVEMENTS    Every point award, signed, with its reason. This is
 *                          where `+0.0` after two hundred unwitnessed kills
 *                          lands, and that line is the single most articulate
 *                          thing the game says about the Hero Association.
 *
 * ── THE KNOWN GAP ──────────────────────────────────────────────────────────
 * `RankChangedEvent` carries no hero id, so a HUD that listened only to the bus
 * would render a rival table that never moves. Rivals arrive through
 * `HudStore.setRivals`, fed from `RivalTracker.onRivalRankChanged`. If nobody
 * wires that callback this screen still renders — it just shows an empty ladder
 * and says so, rather than silently implying the player is unopposed.
 */

import { clamp01 } from '@/util';
import { button, el } from '../dom';
import { formatPoints, formatRank, formatSeatDelta } from '../format';
import type { FrameWriter } from '../frame-writer';
import type { IHudModel, IRankMovement, IRivalRow } from '../model';
import { HudScreen, type HudScreenName } from '../screen';
import { CLASS_COLOR } from '../tokens';

export interface IRankBoardOptions {
  readonly onClose: () => void;
}

export class RankBoardScreen extends HudScreen {
  readonly name: HudScreenName = 'rank';

  private readonly standingRank: HTMLElement;
  private readonly standingName: HTMLElement;
  private readonly standingMeta: HTMLElement;
  private readonly standingBar: HTMLElement;
  private readonly rivalList: HTMLElement;
  private readonly feedList: HTMLElement;
  private readonly boredomNote: HTMLElement;
  private readonly onClose: () => void;

  constructor(doc: Document, options: IRankBoardOptions) {
    super(doc, 'hud-layer hud-layer--screen hud-screen hud-screen--centre', true);
    this.onClose = options.onClose;

    this.standingRank = el(doc, 'div', { className: 'hud-standing__rank', text: 'C-388' });
    this.standingName = el(doc, 'div', { className: 'hud-row__title', text: '' });
    this.standingMeta = el(doc, 'div', { className: 'hud-row__meta', text: '' });
    this.standingBar = el(doc, 'div', { className: 'hud-standing__bar' });
    this.rivalList = el(doc, 'div', {});
    this.feedList = el(doc, 'div', {});
    this.boredomNote = el(doc, 'div', { className: 'hud-note', text: '' });

    const body = el(doc, 'div', {
      className: 'hud-sheet__body',
      children: [
        el(doc, 'div', {
          className: 'hud-standing',
          attrs: { 'data-hud': 'standing' },
          children: [
            this.standingRank,
            el(doc, 'div', {
              className: 'hud-standing__meta',
              children: [this.standingName, this.standingMeta, this.standingBar],
            }),
          ],
        }),
        this.boredomNote,
        el(doc, 'div', {
          className: 'hud-section',
          children: [
            el(doc, 'div', { className: 'hud-section__title', text: 'The ladder' }),
            this.rivalList,
          ],
        }),
        el(doc, 'div', {
          className: 'hud-section',
          children: [
            el(doc, 'div', { className: 'hud-section__title', text: 'Recent assessments' }),
            this.feedList,
          ],
        }),
      ],
    });

    this.element.appendChild(
      el(doc, 'div', {
        className: 'hud-sheet hud-sheet--wide',
        attrs: { 'data-screen': 'rank' },
        children: [
          el(doc, 'div', {
            className: 'hud-sheet__head',
            children: [
              el(doc, 'div', { className: 'hud-sheet__title', text: 'Hero Association' }),
              el(doc, 'div', { className: 'hud-sheet__sub', text: 'Register of active heroes' }),
            ],
          }),
          body,
          el(doc, 'div', {
            className: 'hud-sheet__foot',
            children: [
              button(doc, 'Close', () => this.onClose(), {
                className: 'hud-btn--primary',
                attrs: { 'data-hud': 'rank-close' },
              }),
            ],
          }),
        ],
      })
    );
  }

  override onBack(): boolean {
    this.onClose();
    return true;
  }

  override render(model: IHudModel): void {
    const rank = model.rank;
    this.standingRank.textContent = formatRank(rank.heroClass, rank.rank);
    this.standingRank.style.setProperty('--hud-class', CLASS_COLOR[rank.heroClass]);
    this.standingName.textContent = rank.heroName;
    this.standingMeta.textContent =
      `${rank.points.toFixed(1)} hero points · ` +
      `${rank.pointsToNextRank.toFixed(1)} to the next seat · ` +
      `reputation ${Math.round(rank.reputation)}`;

    /* The throttle, stated plainly. It is the reason the numbers look wrong. */
    this.boredomNote.textContent =
      rank.rankGainMultiplier < 0.95
        ? `Assessment note: point awards are running at ×${rank.rankGainMultiplier.toFixed(2)}. ` +
          `The committee records enthusiasm, and yours is not on file.`
        : 'Assessment note: awards at full rate.';

    this.rivalList.replaceChildren(
      ...(model.rivals.length === 0
        ? [
            el(this.doc, 'div', {
              className: 'hud-note',
              attrs: { 'data-hud': 'rivals-empty' },
              text:
                'No rival standings reported. The Association publishes the ' +
                'register weekly; nothing has been filed since your registration.',
            }),
          ]
        : model.rivals.map((rival) => this.rivalRow(rival)))
    );

    this.feedList.replaceChildren(
      ...(model.rankFeed.length === 0
        ? [el(this.doc, 'div', { className: 'hud-note', text: 'No assessments on file.' })]
        : model.rankFeed.map((movement) => this.feedRow(movement)))
    );
  }

  private rivalRow(rival: IRivalRow): HTMLElement {
    const above = rival.seatsAbovePlayer > 0;
    /* The split is the story: shared credit is what they banked AT YOUR FIGHT. */
    const meta =
      `${rival.sharedCredit.toFixed(0)} pts from ${rival.jointIncidents} joint ` +
      `incident${rival.jointIncidents === 1 ? '' : 's'} · ` +
      `${rival.offscreenCredit.toFixed(0)} pts off-screen`;
    return el(this.doc, 'div', {
      className: 'hud-row hud-rival',
      dataset: { above: above ? 'true' : 'false', rival: rival.id },
      children: [
        el(this.doc, 'span', {
          className: 'hud-chip',
          vars: { '--hud-chip-color': CLASS_COLOR[rival.heroClass] },
          text: formatRank(rival.heroClass, rival.rank),
        }),
        el(this.doc, 'div', {
          className: 'hud-row__main',
          children: [
            el(this.doc, 'div', { className: 'hud-row__title', text: rival.displayName }),
            el(this.doc, 'div', { className: 'hud-row__meta', text: meta }),
          ],
        }),
        el(this.doc, 'div', {
          className: 'hud-row__value hud-rival__gap',
          text: above
            ? `${rival.seatsAbovePlayer > 900 ? 'CLASSES' : `${rival.seatsAbovePlayer}`} ahead`
            : 'behind',
        }),
      ],
    });
  }

  private feedRow(movement: IRankMovement): HTMLElement {
    const sign = movement.delta > 0.05 ? 'up' : movement.delta < -0.05 ? 'down' : 'flat';
    return el(this.doc, 'div', {
      className: 'hud-row',
      dataset: { movement: String(movement.id) },
      children: [
        el(this.doc, 'div', {
          className: 'hud-row__main',
          children: [
            el(this.doc, 'div', { className: 'hud-row__title', text: movement.reason }),
            el(this.doc, 'div', {
              className: 'hud-row__meta',
              text: `${formatRank(movement.heroClass, movement.rank)} · ${formatSeatDelta(
                movement.seats > 900 ? 1 : movement.seats
              )}`,
            }),
          ],
        }),
        el(this.doc, 'div', {
          className: 'hud-row__value hud-feed__delta',
          dataset: { sign },
          text: formatPoints(movement.delta),
        }),
      ],
    });
  }

  override frame(model: IHudModel, writer: FrameWriter): void {
    writer.setNumber(this.standingBar, '--fill', clamp01(model.rank.rankProgress), 3);
  }
}
