/**
 * THE COMBAT HUD
 *
 * What is on screen while the game is being played, and — because the game is
 * played in landscape on a phone with a hand over each bottom corner — all of
 * it is in the top band. On the 844x390 profile that band is 121 px tall. That
 * number decided the whole composition.
 *
 * ── THREE PLATES AND A STRIP ───────────────────────────────────────────────
 * There used to be six panels up here, each with an identical hairline box, and
 * at 130 % HUD scale they did not fit — the right-hand column reached 6 px into
 * the hand. Panels that say two halves of one sentence are now ONE plate:
 *
 *   THE HERO FILE  Class, seat number, name, mood, gain multiplier and the
 *                  boredom meter. Two panels before, and they were the same
 *                  subject: who the Association thinks you are, and how much
 *                  you care. The RANK NUMBER is now the largest thing in the
 *                  corner by 2.4x with "RANK" demoted to an overline, because
 *                  the seat is the content and the word is the caption.
 *
 *                  BOREDOM is the game's actual progress bar, rendered as a
 *                  mood and never as a percentage: a word, a colour draining
 *                  towards grey, and a breath that slows from 2.4 s to 12 s as
 *                  he stops caring. The one number beside it is the throttle on
 *                  rank gain, labelled GAIN — it used to be labelled RANK, 20 px
 *                  under a chip that says "RANK 388", so one word meant a ladder
 *                  position and a multiplier at the same time.
 *
 *   THE INCIDENT   Tier word, name and fight clock on one baseline, with the
 *                  boss health as the plate's base rule instead of a second
 *                  panel underneath it. TIME-TO-KILL is the only performance
 *                  figure a game where every hit is fatal actually has.
 *
 *   THE COST       Saved, lost, watching and the live yen, as four cells of one
 *                  register with the damage meter as its base rule. Credit
 *                  needs an audience and blame does not, so the witness count
 *                  sits in the same row as the two it decides. The yen is in
 *                  BILLIONS with a fixed unit so the readout never changes width
 *                  mid-fight, and the METER reads `propertyDamageScore` — the
 *                  bounded 0..1 companion — because yen is unbounded and would
 *                  peg on the first serious punch of the game.
 *
 *   THE DUTY STRIP The pinned quest across the foot of the band: title, lead
 *                  objective, clock. One line on a landscape phone, two rows
 *                  everywhere else.
 *
 *   CHARGE ARC     Not a second copy of the input layer's ring. That ring, on
 *                  the punch button, answers "how long have I held this". This
 *                  arc answers "what am I about to do to the neighbourhood": it
 *                  marks where the hold crosses into SERIOUS and into NO
 *                  RESTRAINT, and prints the forecast bill under it. It lives
 *                  centre-bottom, in the corridor between the two thumbs.
 *
 * ── WHAT WENT, AND WHAT THAT COST ──────────────────────────────────────────
 * The tracker's OBJECTIVE LIST and its CONFLICT WARNING are gone from the
 * playing HUD. Both are in the quest log — the conflict line with more room
 * than it ever had here — and both were multi-line boxes on a band with no
 * lines to spare. The supermarket warning losing its live position is a real
 * loss and the quest log had better keep printing it loudly.
 *
 * The SEAT-PROGRESS sliver under the rank went too: an unlabelled 2 px dash
 * that cost the hero file a whole row. Its content is on the rank board, in
 * words and with a bar — "388.0 hero points · 12.4 to the next seat".
 *
 * The DEBRIS PIECE COUNT went. It is flavour, nobody acts on it mid-fight, and
 * the invoice prints it afterwards where there is time to be appalled by it.
 *
 * ── WHAT IS DELIBERATELY ABSENT ────────────────────────────────────────────
 * No health bar for the player. He does not have one, and drawing one would be
 * the single most off-model thing in the build. No minimap: it would have to go
 * in a corner, and both bottom corners are hands. No damage numbers: every hit
 * is fatal, so the number is always the same and it is always "all of it".
 *
 * ── THE 60 Hz PATH ─────────────────────────────────────────────────────────
 * `frame()` writes custom properties and NOTHING else — no `textContent`, no
 * `dataset`, no class changes, no layout reads. Every value that changes during
 * a fight is either a CSS counter (`CssNumber`) or generated content driven by
 * a string custom property. Anything that changes only when a human would
 * notice lives in `render()`, which is called on model changes and is free to
 * build DOM.
 */

import type { LethalIntent } from '@/types';
import { clamp01 } from '@/util';
import { CssNumber, escapeCssString } from '../css-number';
import { button, el, svg } from '../dom';
import type { FrameWriter } from '../frame-writer';
import { questUrgency, type IHudModel, type IQuestObjectiveRow, type IQuestRow } from '../model';
import { HudScreen, type HudScreenName } from '../screen';
import {
  BOREDOM_BANDS,
  CLASS_COLOR,
  INTENT_COLOR,
  INTENT_LABEL,
  INTENT_THRESHOLDS,
  TIER_COLOR,
  TIER_LABEL,
  boredomBand,
  intentForCharge,
} from '../tokens';

/* -------------------------------------------------------------------------- */
/* Charge arc geometry                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A 200-degree arc, opening downwards, drawn as a single stroked path.
 *
 * Not a circle: a full ring at this size would sit under the charge ring the
 * input layer already draws on the punch button and read as a duplicate. An arc
 * that opens towards the thumb reads as a gauge and leaves room for the label
 * and the forecast underneath.
 */
const ARC_RADIUS = 62;
const ARC_SWEEP_DEG = 200;
const ARC_CENTRE = { x: 74, y: 74 };

function arcPoint(fraction: number): { x: number; y: number } {
  // 0 at the lower-left end, 1 at the lower-right, sweeping over the top.
  const start = 180 + (180 - ARC_SWEEP_DEG) / 2;
  const angle = ((start + fraction * ARC_SWEEP_DEG) * Math.PI) / 180;
  return {
    x: ARC_CENTRE.x + Math.cos(angle) * ARC_RADIUS,
    y: ARC_CENTRE.y + Math.sin(angle) * ARC_RADIUS,
  };
}

/** Arc length in user units, for the dash-offset trick. */
export const ARC_LENGTH = (ARC_SWEEP_DEG / 360) * 2 * Math.PI * ARC_RADIUS;

function arcPath(): string {
  const a = arcPoint(0);
  const b = arcPoint(1);
  const large = ARC_SWEEP_DEG > 180 ? 1 : 0;
  return (
    `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} ` +
    `A ${ARC_RADIUS} ${ARC_RADIUS} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`
  );
}

function arcPointScaled(fraction: number, scale: number): { x: number; y: number } {
  const point = arcPoint(fraction);
  return {
    x: ARC_CENTRE.x + (point.x - ARC_CENTRE.x) * scale,
    y: ARC_CENTRE.y + (point.y - ARC_CENTRE.y) * scale,
  };
}

/**
 * Yen shown on the live ticker is always expressed in BILLIONS.
 *
 * A ticker that switches unit — ¥940M becoming ¥1.02B — changes width and
 * meaning in the same frame, mid-fight, which is exactly when the player has no
 * attention to spare for re-reading it. One fixed unit, two decimals, never
 * moves. The full grouped figure is printed on the invoice afterwards, where
 * there is time to be appalled by it.
 */
const YEN_PER_BILLION = 1e9;

/* -------------------------------------------------------------------------- */
/* Screen                                                                     */
/* -------------------------------------------------------------------------- */

export interface ICombatHudOptions {
  /** Invoked by the pause affordance. */
  readonly onPause: () => void;
  /** Invoked when the tracker card is tapped — opens the quest log. */
  readonly onOpenQuests?: () => void;
}

export class CombatHudScreen extends HudScreen {
  readonly name: HudScreenName = 'hud';

  /* the hero file */
  private readonly rankClass: HTMLElement;
  private readonly rankNumber: CssNumber;
  private readonly rankName: HTMLElement;
  private readonly boredom: HTMLElement;
  private readonly boredomMood: HTMLElement;
  private readonly boredomFill: HTMLElement;
  private readonly boredomBreath: HTMLElement;
  private readonly boredomMult: CssNumber;

  /* the incident */
  private readonly encounterCard: HTMLElement;
  private readonly encounterTier: HTMLElement;
  private readonly encounterName: HTMLElement;
  private readonly clockMinutes: CssNumber;
  private readonly clockSeconds: CssNumber;
  private readonly bossTrack: HTMLElement;
  private readonly bossFill: HTMLElement;

  /* the cost */
  private readonly ledger: HTMLElement;
  private readonly savedCount: CssNumber;
  private readonly lostCell: HTMLElement;
  private readonly lostCount: CssNumber;
  private readonly witnessCount: CssNumber;
  private readonly costCell: HTMLElement;
  private readonly costYen: CssNumber;
  private readonly costTrack: HTMLElement;
  private readonly costFill: HTMLElement;

  /* the duty strip */
  private readonly tracker: HTMLElement;
  private readonly trackerTitle: HTMLElement;
  private readonly trackerObj: HTMLElement;
  private readonly trackerCount: HTMLElement;
  private readonly trackerWhat: HTMLElement;
  private readonly trackerClock: HTMLElement;
  private readonly trackerMinutes: CssNumber;
  private readonly trackerSeconds: CssNumber;

  /* charge */
  private readonly charge: HTMLElement;
  private readonly chargeForecast: CssNumber;

  /* diffed state — `render` only rebuilds when one of these actually moved */
  private lastMood = '';
  private lastIntent: LethalIntent | null = null;
  private lastEncounterId: string | null = null;
  private lastTrackerSignature = '';
  private lastLostCount = 0;
  private costVisible = false;

  constructor(doc: Document, options: ICombatHudOptions) {
    super(doc, 'hud-layer hud-layer--hud hud-combat', false);

    /* ---- the hero file ---- */
    this.rankClass = el(doc, 'span', { className: 'hud-rankchip__class', text: 'C' });
    this.rankNumber = new CssNumber(doc, { id: 'rank' });
    this.rankName = el(doc, 'div', { className: 'hud-rankchip__name', text: '' });
    this.boredomMood = el(doc, 'span', { className: 'hud-boredom__mood', text: 'ENGAGED' });
    // GAIN, not RANK. See the note in `styles.ts` on `.hud-boredom__mult`: the
    // overline two lines above this says RANK and means a seat on a ladder.
    this.boredomMult = new CssNumber(doc, { decimals: 2, prefix: '×', id: 'gain' });
    this.boredomFill = el(doc, 'span', { className: 'hud-boredom__fill' });
    // The breath lives INSIDE the fill, so a bar reading zero has nothing to
    // shimmer. Over the track it was an indeterminate spinner on an empty bar.
    this.boredomBreath = el(doc, 'span', { className: 'hud-boredom__breath' });
    this.boredomFill.appendChild(this.boredomBreath);
    this.boredom = el(doc, 'div', {
      className: 'hud-boredom',
      dataset: { throttled: 'false' },
      children: [
        this.boredomMood,
        el(doc, 'span', {
          className: 'hud-boredom__mult',
          children: [doc.createTextNode('GAIN '), this.boredomMult.element],
        }),
      ],
    });
    const rankChip = el(doc, 'div', {
      className: 'hud-panel hud-rankchip',
      attrs: { 'data-hud': 'rank-chip' },
      children: [
        this.rankClass,
        el(doc, 'div', {
          className: 'hud-rankchip__file',
          children: [
            el(doc, 'div', {
              className: 'hud-rankchip__head',
              children: [
                el(doc, 'span', { className: 'hud-rankchip__overline', text: 'RANK' }),
                this.rankName,
              ],
            }),
            el(doc, 'div', {
              className: 'hud-rankchip__seat',
              children: [
                el(doc, 'span', {
                  className: 'hud-rankchip__rank',
                  children: [this.rankNumber.element],
                }),
                this.boredom,
              ],
            }),
            el(doc, 'div', {
              className: 'hud-boredom__track',
              attrs: { 'data-hud': 'boredom' },
              children: [this.boredomFill],
            }),
          ],
        }),
      ],
    });

    /* ---- the incident ---- */
    this.encounterTier = el(doc, 'span', { className: 'hud-encounter__tier', text: '' });
    this.encounterName = el(doc, 'span', { className: 'hud-encounter__name', text: '' });
    this.clockMinutes = new CssNumber(doc, { id: 'enc-m' });
    this.clockSeconds = new CssNumber(doc, { pad2: true, id: 'enc-s' });
    this.bossFill = el(doc, 'span', { className: 'hud-boss__fill' });
    this.bossTrack = el(doc, 'div', {
      className: 'hud-boss',
      attrs: { 'data-hud': 'boss' },
      children: [this.bossFill],
    });
    this.bossTrack.hidden = true;
    this.encounterCard = el(doc, 'div', {
      className: 'hud-panel hud-encounter',
      attrs: { 'data-hud': 'encounter' },
      children: [
        el(doc, 'div', {
          className: 'hud-encounter__head',
          children: [
            this.encounterTier,
            this.encounterName,
            el(doc, 'span', {
              className: 'hud-encounter__clock',
              children: [
                this.clockMinutes.element,
                el(doc, 'span', { className: 'hud-encounter__sep', text: ':' }),
                this.clockSeconds.element,
              ],
            }),
          ],
        }),
        this.bossTrack,
      ],
    });
    this.encounterCard.hidden = true;

    /* ---- the cost ---- */
    this.savedCount = new CssNumber(doc, { id: 'saved' });
    this.lostCount = new CssNumber(doc, { id: 'lost' });
    this.witnessCount = new CssNumber(doc, { id: 'witness' });
    this.costYen = new CssNumber(doc, {
      className: 'hud-ledger__value',
      decimals: 2,
      prefix: '¥',
      suffix: 'B',
      id: 'yen',
    });
    this.lostCell = this.cell('LOST', this.lostCount.element, 'hud-ledger__cell--lost');
    this.costCell = el(doc, 'div', {
      className: 'hud-ledger__cell hud-ledger__cell--cost',
      children: [el(doc, 'span', { className: 'hud-label', text: 'COST' }), this.costYen.element],
    });
    this.costFill = el(doc, 'span', { className: 'hud-ledger__fill' });
    this.costTrack = el(doc, 'div', {
      className: 'hud-ledger__track',
      children: [this.costFill],
    });
    this.ledger = el(doc, 'div', {
      className: 'hud-panel hud-ledger',
      attrs: { 'data-hud': 'ledger' },
      dataset: { lost: 'false' },
      children: [
        this.cell('SAVED', this.savedCount.element, 'hud-ledger__cell--saved'),
        this.lostCell,
        this.cell('WATCHING', this.witnessCount.element, 'hud-ledger__witness'),
        this.costCell,
        this.costTrack,
      ],
    });
    this.ledger.hidden = true;

    /* ---- the duty strip ---- */
    this.trackerTitle = el(doc, 'div', { className: 'hud-tracker__title', text: '' });
    this.trackerCount = el(doc, 'span', { className: 'hud-tracker__count', text: '' });
    this.trackerWhat = el(doc, 'span', { className: 'hud-tracker__what', text: '' });
    this.trackerObj = el(doc, 'div', {
      className: 'hud-tracker__obj',
      dataset: { complete: 'false' },
      children: [this.trackerCount, this.trackerWhat],
    });
    this.trackerMinutes = new CssNumber(doc, { id: 'q-m' });
    this.trackerSeconds = new CssNumber(doc, { pad2: true, id: 'q-s' });
    this.trackerClock = el(doc, 'div', {
      className: 'hud-tracker__clock',
      children: [
        el(doc, 'span', { className: 'hud-label', text: 'TIME' }),
        this.trackerMinutes.element,
        el(doc, 'span', { text: ':' }),
        this.trackerSeconds.element,
      ],
    });
    this.tracker = el(doc, 'div', {
      className: 'hud-panel hud-tracker',
      attrs: { 'data-hud': 'tracker', role: 'button', tabindex: '0' },
      dataset: { urgency: 'none', errand: 'false' },
      children: [
        el(doc, 'div', {
          className: 'hud-tracker__main',
          children: [this.trackerTitle, this.trackerObj],
        }),
        this.trackerClock,
      ],
    });
    this.tracker.hidden = true;
    if (options.onOpenQuests) {
      const open = options.onOpenQuests;
      // NOT `style.pointerEvents = 'auto'`. The stylesheet owns whether this is
      // a control, because the answer depends on the viewport: on a landscape
      // phone the strip sits inside the rectangle `src/ui/input` treats as
      // stick input, so a tap there is a movement input whatever the HUD
      // believes — the harness's hit-ownership grid measured it stealing three
      // probes. An inline style would have overridden that media query.
      this.tracker.addEventListener('pointerup', open);
      this.onDispose(() => this.tracker.removeEventListener('pointerup', open));
    }

    /* ---- charge arc ---- */
    this.chargeForecast = new CssNumber(doc, {
      decimals: 2,
      prefix: 'FORECAST ¥',
      suffix: 'B',
      id: 'forecast',
    });
    const arc = svg(doc, 'svg', { viewBox: '0 0 148 100', 'aria-hidden': 'true' }, [
      svg(doc, 'path', { class: 'hud-charge__track', d: arcPath() }),
      svg(doc, 'path', { class: 'hud-charge__fill', d: arcPath() }),
      // Threshold ticks. The whole reason the arc exists: the player can see
      // where the hold stops being a punch and starts being a decision.
      ...INTENT_THRESHOLDS.filter((step) => step.at > 0).map((step) => {
        const inner = arcPointScaled(step.at, 0.86);
        const outer = arcPointScaled(step.at, 1.14);
        return svg(doc, 'line', {
          class: 'hud-charge__tick',
          x1: inner.x.toFixed(2),
          y1: inner.y.toFixed(2),
          x2: outer.x.toFixed(2),
          y2: outer.y.toFixed(2),
        });
      }),
    ]);
    this.charge = el(doc, 'div', {
      className: 'hud-charge',
      attrs: { 'data-hud': 'charge' },
      vars: { '--hud-arc-len': ARC_LENGTH.toFixed(2) },
      children: [
        arc,
        el(doc, 'div', { className: 'hud-charge__label' }),
        el(doc, 'div', {
          className: 'hud-charge__cost',
          children: [this.chargeForecast.element],
        }),
      ],
    });

    /* ---- assembly ---- */
    const pauseButton = button(doc, 'Pause', options.onPause, {
      className: 'hud-pausebtn',
      text: '❚❚',
      attrs: { 'data-hud': 'pause-button' },
    });

    // The pause affordance sits outside the right column so the ledger does not
    // shuffle sideways when it appears; the column reserves its width instead —
    // in `styles.ts`, from `--hud-pause-size`, so the reserve and the button it
    // reserves for cannot drift apart.
    const rightColumn = el(doc, 'div', {
      className: 'hud-top__right',
      children: [this.ledger],
    });

    this.element.append(
      el(doc, 'div', {
        className: 'hud-top',
        children: [
          el(doc, 'div', { className: 'hud-top__left', children: [rankChip] }),
          el(doc, 'div', { className: 'hud-top__centre', children: [this.encounterCard] }),
          rightColumn,
          // Placed by the stylesheet, not by its position in this list: row two
          // of the band, spanning it, in every orientation. See `.hud-tracker`.
          this.tracker,
        ],
      }),
      pauseButton,
      this.charge
    );
  }

  /**
   * One register cell: the label on top, the number under it.
   *
   * LABEL ON TOP and both flush left, which is a correctness fix and not a
   * preference. The cells used to be `align-items:flex-end` with the number
   * above a TRACKED label, and CSS adds letter-spacing after the FINAL glyph
   * too — so every counter sat over the last letter and a half of its own label
   * and overhung its right edge by ~1 px. Left-aligned columns cannot do that,
   * and a printed register reads label-first anyway.
   */
  private cell(label: string, value: Node, modifier: string): HTMLElement {
    return el(this.doc, 'div', {
      className: `hud-ledger__cell ${modifier}`,
      children: [
        el(this.doc, 'span', { className: 'hud-label', text: label }),
        el(this.doc, 'span', { className: 'hud-ledger__value', children: [value] }),
      ],
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Event-driven render — arbitrary DOM, a few times a minute               */
  /* ---------------------------------------------------------------------- */

  override render(model: IHudModel): void {
    /* rank */
    if (this.rankClass.textContent !== model.rank.heroClass) {
      this.rankClass.textContent = model.rank.heroClass;
      this.rankClass.style.setProperty('--hud-class', CLASS_COLOR[model.rank.heroClass]);
    }
    if (this.rankName.textContent !== model.rank.heroName) {
      this.rankName.textContent = model.rank.heroName;
    }

    /* boredom band — word, colour and breath change on band crossings only */
    const band = boredomBand(model.boredom);
    if (band.label !== this.lastMood) {
      this.lastMood = band.label;
      this.boredomMood.textContent = band.label;
      this.boredom.style.setProperty('--hud-mood', band.color);
      this.boredomFill.style.setProperty('--hud-mood', band.color);
      this.boredomBreath.style.setProperty('--hud-breath', `${band.breathSeconds}s`);
    }
    this.boredom.dataset.throttled = model.rank.rankGainMultiplier < 0.55 ? 'true' : 'false';

    /* encounter */
    const encounter = model.encounter;
    const hasEncounter = encounter !== null;
    this.encounterCard.hidden = !hasEncounter;
    this.ledger.hidden = !hasEncounter;
    this.costVisible = hasEncounter && model.settings.showCollateralTicker;
    this.costCell.hidden = !this.costVisible;
    this.costTrack.hidden = !this.costVisible;
    this.bossTrack.hidden = !(encounter?.isBoss ?? false);

    if (encounter && encounter.id !== this.lastEncounterId) {
      this.lastEncounterId = encounter.id;
      this.encounterName.textContent = encounter.name;
      // The tier word ALWAYS prints beside the tier colour. No five-hue ramp
      // survives dichromacy as colour alone.
      this.encounterTier.textContent = `THREAT ${TIER_LABEL[encounter.tier]}`;
      this.encounterCard.style.setProperty('--hud-tier', TIER_COLOR[encounter.tier]);
      this.lastLostCount = 0;
    } else if (!encounter) {
      this.lastEncounterId = null;
    }

    /* The ledger's edge rule is the ledger's headline: green while everyone is
       accounted for, red the moment somebody is not. */
    const lost = encounter?.civiliansLost ?? 0;
    this.ledger.dataset.lost = lost > 0 ? 'true' : 'false';

    /* the lost counter is the only one that gets to move */
    if (lost > this.lastLostCount) {
      this.lastLostCount = lost;
      const cell = this.lostCell;
      cell.dataset.bump = 'false';
      // Restart the keyframes without the usual `void el.offsetWidth` reflow
      // hack — which is precisely the forced synchronous layout this HUD is
      // built to never perform. A frame boundary does the same job for free.
      this.doc.defaultView?.requestAnimationFrame(() => {
        cell.dataset.bump = 'true';
      });
    }

    this.renderTracker(model);
  }

  private renderTracker(model: IHudModel): void {
    const quest = pickTrackedQuest(model);
    if (!quest) {
      this.tracker.hidden = true;
      this.lastTrackerSignature = '';
      return;
    }
    this.tracker.hidden = false;

    const urgency = questUrgency(quest);
    const lead = leadObjective(quest.objectives);
    /* Every field the gated block below writes has to be in here. `hidden` and
       `complete` are first-class on `IQuestObjectiveRow` precisely so they can
       change WITHOUT the counter moving — an objective revealed by progress
       goes hidden:false at 0/N, and a `required <= 1` objective completes at
       0/1 — and a signature blind to them left both changes off the HUD. */
    const signature = [
      quest.id,
      quest.title,
      quest.errand ? 'e' : '',
      urgency,
      quest.objectives
        .map(
          (o) => `${o.id}:${o.current}/${o.required}:${o.hidden ? 'h' : ''}${o.complete ? 'c' : ''}`
        )
        .join(','),
    ].join('|');
    if (signature === this.lastTrackerSignature) return;
    this.lastTrackerSignature = signature;

    this.tracker.dataset.urgency = urgency;
    this.tracker.dataset.errand = quest.errand ? 'true' : 'false';
    this.trackerTitle.textContent = quest.title;
    this.trackerClock.hidden = quest.timeRemaining === undefined;

    this.trackerObj.hidden = lead === undefined;
    if (lead !== undefined) {
      this.trackerObj.dataset.complete = lead.complete ? 'true' : 'false';
      this.trackerCount.textContent =
        lead.required > 1
          ? `${Math.min(lead.current, lead.required)}/${lead.required}`
          : lead.complete
            ? '✓'
            : '•';
      this.trackerWhat.textContent = lead.description;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* The 60 Hz path — custom properties, and nothing else                   */
  /* ---------------------------------------------------------------------- */

  override frame(model: IHudModel, writer: FrameWriter): void {
    /* rank */
    this.rankNumber.write(writer, model.rank.rank);

    /* boredom */
    writer.setNumber(this.boredomFill, '--boredom', clamp01(model.boredom), 3);
    this.boredomMult.write(writer, model.rank.rankGainMultiplier);

    /* encounter */
    const encounter = model.encounter;
    if (encounter) {
      const elapsed = Math.max(0, encounter.elapsed);
      this.clockMinutes.write(writer, Math.floor(elapsed / 60));
      this.clockSeconds.write(writer, Math.floor(elapsed % 60));
      this.savedCount.write(writer, encounter.civiliansSaved);
      this.lostCount.write(writer, encounter.civiliansLost);
      this.witnessCount.write(writer, encounter.witnesses);
      if (this.costVisible) {
        this.costYen.write(writer, encounter.collateralYen / YEN_PER_BILLION);
        writer.setNumber(this.costFill, '--collateral', encounter.collateralScore, 3);
      }
      // Full until told otherwise, and written every frame rather than only
      // when known: a boss card that opened on the PREVIOUS fight's health
      // because nothing reset the property is the same bug as one that opens
      // empty. `--fill` is registered, so `var(--fill,1)` in CSS cannot do it.
      writer.setNumber(this.bossFill, '--fill', clamp01(encounter.bossHealth ?? 1), 3);
    }

    /* tracker clock */
    const quest = pickTrackedQuest(model);
    if (quest?.timeRemaining !== undefined) {
      const left = Math.max(0, quest.timeRemaining);
      this.trackerMinutes.write(writer, Math.floor(left / 60));
      this.trackerSeconds.write(writer, Math.floor(left % 60));
    }

    /* charge arc */
    const charge = model.charge;
    writer.setNumber(this.charge, '--charge', clamp01(charge.ratio), 3);
    writer.set(this.charge, '--hud-on', charge.charging ? '1' : '0');
    const intent = charge.charging ? intentForCharge(charge.ratio) : charge.intent;
    if (intent !== this.lastIntent) {
      this.lastIntent = intent;
      writer.set(this.charge, '--hud-intent', INTENT_COLOR[intent]);
      writer.set(this.charge, '--hud-intent-label', `'${escapeCssString(INTENT_LABEL[intent])}'`);
    }
    this.chargeForecast.write(writer, charge.forecastYen / YEN_PER_BILLION);
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Which quest the tracker shows.
 *
 * The explicitly pinned one, else the most urgent active one. "Most urgent"
 * means least time remaining, so a 30-second evacuation displaces a dragon-tier
 * subjugation with no clock — the correct priority, and the one a naive "first
 * active quest" implementation gets wrong every time.
 *
 * ONE INDEXED PASS, no intermediate array and no closures: `frame()` calls this
 * every frame for the tracker clock, and `step 3 never allocates` is the
 * performance contract the whole two-tier split exists to keep. A `filter` +
 * `find` + `reduce` here is a fresh array and three closure activations sixty
 * times a second, for the session, on a phone.
 */
export function pickTrackedQuest(model: IHudModel): IQuestRow | undefined {
  const quests = model.quests;
  const pinnedId = model.trackedQuestId;
  let best: IQuestRow | undefined;
  let bestTime = Infinity;
  for (let i = 0; i < quests.length; i++) {
    const quest = quests[i]!;
    if (quest.state !== 'active') continue;
    if (pinnedId !== undefined && quest.id === pinnedId) return quest;
    const time = quest.timeRemaining ?? Infinity;
    // Strictly less: ties keep the earlier quest, as the reduce this replaces
    // did, so the tracker does not swap between two equally urgent jobs.
    if (best === undefined || time < bestTime) {
      best = quest;
      bestTime = time;
    }
  }
  return best;
}

/**
 * The one objective the duty strip has room to print.
 *
 * The first VISIBLE objective that is not yet done, because that is the thing
 * the player is currently supposed to be doing; the last visible one when they
 * are all done, so a finished quest reads as finished rather than as blank.
 * Hidden objectives never appear — `IQuestObjectiveRow.hidden` exists so the
 * quest system can reveal a step later, and a leaked one spoils it.
 *
 * The full list is in the quest log. On a 121 px band this HUD gets one line.
 */
function leadObjective(objectives: readonly IQuestObjectiveRow[]): IQuestObjectiveRow | undefined {
  let last: IQuestObjectiveRow | undefined;
  for (let i = 0; i < objectives.length; i++) {
    const objective = objectives[i]!;
    if (objective.hidden) continue;
    if (!objective.complete) return objective;
    last = objective;
  }
  return last;
}

/** Re-exported so the harness can walk the band table for screenshots. */
export { BOREDOM_BANDS };
