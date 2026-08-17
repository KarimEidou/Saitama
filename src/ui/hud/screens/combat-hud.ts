/**
 * THE COMBAT HUD
 *
 * What is on screen while the game is being played, and — because the game is
 * played in landscape on a phone with a hand over each bottom corner — almost
 * all of it is in the top band.
 *
 * ── WHAT IS HERE, AND WHY EACH ONE EARNS ITS PIXELS ────────────────────────
 *
 *   BOREDOM        The game's actual progress bar. Rendered as a mood, never a
 *                  percentage: a word, a colour draining towards grey, and a
 *                  breath that slows from 2.4 s to 12 s as he stops caring. The
 *                  only number beside it is the ×0.15 throttle on rank gain,
 *                  shown because a player who cannot see it concludes the
 *                  RANKING SYSTEM is broken instead of the character.
 *
 *   CHARGE ARC     Not a second copy of the input layer's ring. That ring, on
 *                  the punch button, answers "how long have I held this". This
 *                  arc answers "what am I about to do to the neighbourhood": it
 *                  marks where the hold crosses into SERIOUS and into NO
 *                  RESTRAINT, and prints the forecast bill under it. It lives
 *                  centre-bottom, in the corridor between the two thumbs.
 *
 *   TIMER          Seconds since the encounter started. In a game where every
 *                  fight ends in one hit, time-to-kill is the only performance
 *                  figure that exists.
 *
 *   LEDGER         Saved and lost, plus the witness count — because credit
 *                  needs an audience and blame does not, and the player should
 *                  be able to see whether anyone is watching.
 *
 *   COLLATERAL     Live yen, in BILLIONS with a fixed unit so the readout never
 *                  changes width, and a bounded meter driven by
 *                  `propertyDamageScore` rather than by the yen — the yen is
 *                  unbounded and would peg any meter on the first serious punch
 *                  of the game.
 *
 *   TRACKER        The pinned quest, its objectives, and — loudly — its clock.
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
import { CssNumber } from '../css-number';
import { button, el, svg } from '../dom';
import type { FrameWriter } from '../frame-writer';
import { questUrgency, type IHudModel, type IQuestRow } from '../model';
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

  /* rank chip */
  private readonly rankClass: HTMLElement;
  private readonly rankNumber: CssNumber;
  private readonly rankName: HTMLElement;
  private readonly rankProgress: HTMLElement;

  /* boredom */
  private readonly boredom: HTMLElement;
  private readonly boredomMood: HTMLElement;
  private readonly boredomFill: HTMLElement;
  private readonly boredomBreath: HTMLElement;
  private readonly boredomMult: CssNumber;

  /* encounter */
  private readonly encounterCard: HTMLElement;
  private readonly encounterTier: HTMLElement;
  private readonly encounterName: HTMLElement;
  private readonly clockMinutes: CssNumber;
  private readonly clockSeconds: CssNumber;
  private readonly bossCard: HTMLElement;
  private readonly bossFill: HTMLElement;
  private readonly bossPhase: HTMLElement;

  /* ledger */
  private readonly ledger: HTMLElement;
  private readonly savedCount: CssNumber;
  private readonly lostCell: HTMLElement;
  private readonly lostCount: CssNumber;
  private readonly witnessCount: CssNumber;

  /* collateral */
  private readonly collateral: HTMLElement;
  private readonly collateralYen: CssNumber;
  private readonly collateralFill: HTMLElement;
  private readonly debrisCount: CssNumber;

  /* tracker */
  private readonly tracker: HTMLElement;
  private readonly trackerTitle: HTMLElement;
  private readonly trackerObjectives: HTMLElement;
  private readonly trackerClock: HTMLElement;
  private readonly trackerMinutes: CssNumber;
  private readonly trackerSeconds: CssNumber;
  private readonly trackerConflict: HTMLElement;

  /* charge */
  private readonly charge: HTMLElement;
  private readonly chargeForecast: CssNumber;

  /* diffed state — `render` only rebuilds when one of these actually moved */
  private lastMood = '';
  private lastIntent: LethalIntent | null = null;
  private lastEncounterId: string | null = null;
  private lastTrackerSignature = '';
  private lastLostCount = 0;
  private collateralVisible = false;

  constructor(doc: Document, options: ICombatHudOptions) {
    super(doc, 'hud-layer hud-layer--hud hud-combat', false);

    /* ---- rank chip ---- */
    this.rankClass = el(doc, 'span', { className: 'hud-rankchip__class', text: 'C' });
    this.rankNumber = new CssNumber(doc, { id: 'rank' });
    this.rankName = el(doc, 'div', { className: 'hud-label hud-rankchip__name', text: '' });
    this.rankProgress = el(doc, 'span', { className: 'hud-rankchip__pts' });
    const rankChip = el(doc, 'div', {
      className: 'hud-panel hud-rankchip',
      attrs: { 'data-hud': 'rank-chip' },
      children: [
        this.rankClass,
        el(doc, 'div', {
          children: [
            el(doc, 'div', {
              className: 'hud-rankchip__rank',
              children: [doc.createTextNode('RANK '), this.rankNumber.element],
            }),
            this.rankName,
            this.rankProgress,
          ],
        }),
      ],
    });

    /* ---- boredom ---- */
    this.boredomMood = el(doc, 'span', { className: 'hud-boredom__mood', text: 'ENGAGED' });
    this.boredomMult = new CssNumber(doc, { decimals: 2, prefix: '×', id: 'gain' });
    this.boredomFill = el(doc, 'span', { className: 'hud-boredom__fill' });
    this.boredomBreath = el(doc, 'span', { className: 'hud-boredom__breath' });
    this.boredom = el(doc, 'div', {
      className: 'hud-panel hud-boredom',
      attrs: { 'data-hud': 'boredom' },
      dataset: { throttled: 'false' },
      children: [
        el(doc, 'div', {
          className: 'hud-boredom__head',
          children: [
            this.boredomMood,
            el(doc, 'span', {
              className: 'hud-boredom__mult',
              attrs: { title: 'Rank gain multiplier' },
              children: [doc.createTextNode('RANK '), this.boredomMult.element],
            }),
          ],
        }),
        el(doc, 'div', {
          className: 'hud-boredom__track',
          children: [this.boredomFill, this.boredomBreath],
        }),
      ],
    });

    /* ---- encounter ---- */
    this.encounterTier = el(doc, 'span', { className: 'hud-encounter__tier', text: '' });
    this.encounterName = el(doc, 'span', { className: 'hud-encounter__name', text: '' });
    this.clockMinutes = new CssNumber(doc, { id: 'enc-m' });
    this.clockSeconds = new CssNumber(doc, { pad2: true, id: 'enc-s' });
    this.encounterCard = el(doc, 'div', {
      className: 'hud-panel hud-encounter',
      attrs: { 'data-hud': 'encounter' },
      children: [
        el(doc, 'div', {
          children: [this.encounterTier, el(doc, 'div', { children: [this.encounterName] })],
        }),
        el(doc, 'span', {
          className: 'hud-encounter__clock',
          children: [
            this.clockMinutes.element,
            el(doc, 'span', { className: 'hud-encounter__sep', text: ':' }),
            this.clockSeconds.element,
          ],
        }),
      ],
    });
    this.encounterCard.hidden = true;

    this.bossFill = el(doc, 'span', { className: 'hud-boss__fill' });
    this.bossPhase = el(doc, 'span', { className: 'hud-label', text: 'PHASE 1' });
    this.bossCard = el(doc, 'div', {
      className: 'hud-panel hud-boss',
      attrs: { 'data-hud': 'boss' },
      children: [
        this.bossPhase,
        el(doc, 'div', { className: 'hud-boss__track', children: [this.bossFill] }),
      ],
    });
    this.bossCard.hidden = true;

    /* ---- ledger ---- */
    this.savedCount = new CssNumber(doc, { id: 'saved' });
    this.lostCount = new CssNumber(doc, { id: 'lost' });
    this.witnessCount = new CssNumber(doc, { id: 'witness' });
    this.lostCell = el(doc, 'div', {
      className: 'hud-ledger__cell hud-ledger__cell--lost',
      children: [
        el(doc, 'span', { className: 'hud-ledger__value', children: [this.lostCount.element] }),
        el(doc, 'span', { className: 'hud-label', text: 'LOST' }),
      ],
    });
    this.ledger = el(doc, 'div', {
      className: 'hud-panel hud-ledger',
      attrs: { 'data-hud': 'ledger' },
      children: [
        el(doc, 'div', {
          className: 'hud-ledger__cell hud-ledger__cell--saved',
          children: [
            el(doc, 'span', { className: 'hud-ledger__value', children: [this.savedCount.element] }),
            el(doc, 'span', { className: 'hud-label', text: 'SAVED' }),
          ],
        }),
        this.lostCell,
        el(doc, 'div', {
          className: 'hud-ledger__cell',
          children: [
            el(doc, 'span', {
              className: 'hud-ledger__value hud-ledger__witness',
              children: [this.witnessCount.element],
            }),
            el(doc, 'span', { className: 'hud-label', text: 'WATCHING' }),
          ],
        }),
      ],
    });
    this.ledger.hidden = true;

    /* ---- collateral ---- */
    this.collateralYen = new CssNumber(doc, {
      className: 'hud-collateral__value',
      decimals: 2,
      prefix: '¥',
      suffix: 'B',
      id: 'yen',
    });
    this.collateralFill = el(doc, 'span', { className: 'hud-collateral__fill' });
    this.debrisCount = new CssNumber(doc, { suffix: ' PIECES', id: 'debris' });
    this.collateral = el(doc, 'div', {
      className: 'hud-panel hud-collateral',
      attrs: { 'data-hud': 'collateral' },
      children: [
        el(doc, 'div', {
          className: 'hud-collateral__row',
          children: [
            el(doc, 'span', { className: 'hud-label', text: 'COLLATERAL' }),
            this.collateralYen.element,
          ],
        }),
        el(doc, 'div', { className: 'hud-collateral__track', children: [this.collateralFill] }),
        el(doc, 'span', {
          className: 'hud-label hud-collateral__debris',
          children: [this.debrisCount.element],
        }),
      ],
    });
    this.collateral.hidden = true;

    /* ---- tracker ---- */
    this.trackerTitle = el(doc, 'div', { className: 'hud-tracker__title', text: '' });
    this.trackerObjectives = el(doc, 'div', {});
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
    this.trackerConflict = el(doc, 'div', { className: 'hud-tracker__conflict', text: '' });
    this.tracker = el(doc, 'div', {
      className: 'hud-panel hud-tracker',
      attrs: { 'data-hud': 'tracker', role: 'button', tabindex: '0' },
      dataset: { urgency: 'none', errand: 'false' },
      children: [
        el(doc, 'div', { className: 'hud-label', text: 'TRACKING' }),
        this.trackerTitle,
        this.trackerObjectives,
        this.trackerClock,
        this.trackerConflict,
      ],
    });
    this.tracker.hidden = true;
    if (options.onOpenQuests) {
      const open = options.onOpenQuests;
      this.tracker.style.pointerEvents = 'auto';
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
      className: 'hud-btn--ghost hud-pausebtn',
      text: '❚❚',
      attrs: { 'data-hud': 'pause-button' },
    });

    // The pause affordance sits outside the right column so the ledger does not
    // shuffle sideways when it appears; the column reserves its width instead.
    const rightColumn = el(doc, 'div', {
      className: 'hud-top__right',
      vars: { 'padding-right': '46px' },
      children: [this.ledger, this.collateral],
    });

    this.element.append(
      el(doc, 'div', {
        className: 'hud-top',
        children: [
          el(doc, 'div', {
            className: 'hud-top__left',
            children: [rankChip, this.boredom, this.tracker],
          }),
          el(doc, 'div', {
            className: 'hud-top__centre',
            children: [this.encounterCard, this.bossCard],
          }),
          rightColumn,
        ],
      }),
      pauseButton,
      this.charge
    );
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
      this.boredomBreath.style.setProperty('--hud-breath', `${band.breathSeconds}s`);
    }
    this.boredom.dataset.throttled = model.rank.rankGainMultiplier < 0.55 ? 'true' : 'false';

    /* encounter */
    const encounter = model.encounter;
    const hasEncounter = encounter !== null;
    this.encounterCard.hidden = !hasEncounter;
    this.ledger.hidden = !hasEncounter;
    this.collateralVisible = hasEncounter && model.settings.showCollateralTicker;
    this.collateral.hidden = !this.collateralVisible;
    this.bossCard.hidden = !(encounter?.isBoss ?? false);

    if (encounter && encounter.id !== this.lastEncounterId) {
      this.lastEncounterId = encounter.id;
      this.encounterName.textContent = encounter.name;
      this.encounterTier.textContent = `THREAT ${TIER_LABEL[encounter.tier]}`;
      const tint = TIER_COLOR[encounter.tier];
      this.encounterCard.style.setProperty('--hud-tier', tint);
      this.bossCard.style.setProperty('--hud-tier', tint);
      this.lastLostCount = 0;
    } else if (!encounter) {
      this.lastEncounterId = null;
    }
    if (encounter?.bossPhase !== undefined) {
      const text = `PHASE ${encounter.bossPhase}`;
      if (this.bossPhase.textContent !== text) this.bossPhase.textContent = text;
    }

    /* the lost counter is the only one that gets to move */
    const lost = encounter?.civiliansLost ?? 0;
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
    const signature = [
      quest.id,
      urgency,
      quest.objectives.map((o) => `${o.id}:${o.current}/${o.required}`).join(','),
      quest.conflictsWith?.join(',') ?? '',
    ].join('|');
    if (signature === this.lastTrackerSignature) return;
    this.lastTrackerSignature = signature;

    this.tracker.dataset.urgency = urgency;
    this.tracker.dataset.errand = quest.errand ? 'true' : 'false';
    this.trackerTitle.textContent = quest.title;
    this.trackerClock.hidden = quest.timeRemaining === undefined;

    this.trackerObjectives.replaceChildren(
      ...quest.objectives
        .filter((o) => !o.hidden)
        .map((objective) =>
          el(this.doc, 'div', {
            className: 'hud-tracker__obj',
            dataset: { complete: objective.complete ? 'true' : 'false' },
            children: [
              el(this.doc, 'span', {
                className: 'hud-tracker__count',
                text:
                  objective.required > 1
                    ? `${Math.min(objective.current, objective.required)}/${objective.required}`
                    : objective.complete
                      ? '✓'
                      : '•',
              }),
              el(this.doc, 'span', { text: objective.description }),
            ],
          })
        )
    );

    /* The conflict warning. This is the supermarket, and it is the point. */
    const conflicts = quest.conflictsWith ?? [];
    if (conflicts.length === 0) {
      this.trackerConflict.hidden = true;
    } else {
      this.trackerConflict.hidden = false;
      const names = conflicts
        .map((id) => model.quests.find((q) => q.id === id)?.title ?? id)
        .join(', ');
      this.trackerConflict.textContent = quest.errand
        ? `Ends if you take: ${names}`
        : `Taking this ends: ${names}`;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* The 60 Hz path — custom properties, and nothing else                   */
  /* ---------------------------------------------------------------------- */

  override frame(model: IHudModel, writer: FrameWriter): void {
    /* rank */
    this.rankNumber.write(writer, model.rank.rank);
    writer.setNumber(this.rankProgress, '--fill', clamp01(model.rank.rankProgress), 3);

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
      if (this.collateralVisible) {
        this.debrisCount.write(writer, encounter.debrisPieces);
        this.collateralYen.write(writer, encounter.collateralYen / YEN_PER_BILLION);
        writer.setNumber(this.collateralFill, '--collateral', encounter.collateralScore, 3);
      }
      if (encounter.bossHealth !== undefined) {
        writer.setNumber(this.bossFill, '--fill', clamp01(encounter.bossHealth), 3);
      }
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
      writer.set(this.charge, '--hud-intent-label', `'${INTENT_LABEL[intent]}'`);
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
 */
export function pickTrackedQuest(model: IHudModel): IQuestRow | undefined {
  const active = model.quests.filter((q) => q.state === 'active');
  if (active.length === 0) return undefined;
  const pinned = active.find((q) => q.id === model.trackedQuestId);
  if (pinned) return pinned;
  return active.reduce((best, quest) =>
    (quest.timeRemaining ?? Infinity) < (best.timeRemaining ?? Infinity) ? quest : best
  );
}

/** Re-exported so the harness can walk the band table for screenshots. */
export { BOREDOM_BANDS };
