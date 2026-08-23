/**
 * THE QUEST LOG
 *
 * Ten Hero Association requests and errands, sorted by what is actually about
 * to expire.
 *
 * ── THE SORT IS THE DESIGN ─────────────────────────────────────────────────
 * Active before available before finished, and inside active, LEAST TIME FIRST.
 * A 150-second tunnel evacuation therefore sits above a dragon-tier subjugation
 * with no clock, permanently, because that is the correct order to read them
 * in and because a quest log sorted by "the order they were accepted" is a
 * quest log nobody opens twice.
 *
 * ── THE SUPERMARKET ────────────────────────────────────────────────────────
 * `quest.errand.bargain` has an 11-minute window, no reward points, no
 * reputation, and a `conflictsWith` entry that ends it the moment the player
 * accepts the Mosquito Girl subjugation. Missing it costs 0.12 boredom; failing
 * the subjugation costs 0.04.
 *
 * That relationship is not a footnote in a tooltip. Errands get their own
 * grouping, their own colour, and — when they conflict with something else on
 * the list — an explicit line naming what taking the other job would cost.
 * Making the player FEEL that choice is most of the reason this screen exists,
 * and burying it in a description string would waste it.
 */

import { CssNumber } from '../css-number';
import { button, el } from '../dom';
import { formatCount } from '../format';
import type { FrameWriter } from '../frame-writer';
import { compareQuests, questUrgency, type IHudModel, type IQuestRow } from '../model';
import { HudScreen, type HudScreenName } from '../screen';
import { conflictTitles, objectiveRows } from './objective-row';
import { TIER_COLOR, TIER_LABEL } from '../tokens';

export interface IQuestLogOptions {
  readonly onClose: () => void;
  /** Pin a quest to the combat tracker. */
  readonly onTrack: (questId: string) => void;
}

export class QuestLogScreen extends HudScreen {
  readonly name: HudScreenName = 'quests';

  private readonly list: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly onClose: () => void;
  private readonly onTrack: (questId: string) => void;
  /** Live clock readouts, rebuilt whenever the list is rebuilt. */
  private clocks: {
    readonly minutes: CssNumber;
    readonly seconds: CssNumber;
    readonly quest: IQuestRow;
  }[] = [];

  constructor(doc: Document, options: IQuestLogOptions) {
    super(doc, 'hud-layer hud-layer--screen hud-screen hud-screen--centre', true);
    this.onClose = options.onClose;
    this.onTrack = options.onTrack;

    this.list = el(doc, 'div', {});
    this.summary = el(doc, 'div', { className: 'hud-sheet__sub', text: '' });

    this.element.appendChild(
      el(doc, 'div', {
        className: 'hud-sheet hud-sheet--wide',
        attrs: { 'data-screen': 'quests' },
        children: [
          el(doc, 'div', {
            className: 'hud-sheet__head',
            children: [
              el(doc, 'div', { className: 'hud-sheet__title', text: 'Requests' }),
              this.summary,
            ],
          }),
          el(doc, 'div', { className: 'hud-sheet__body', children: [this.list] }),
          el(doc, 'div', {
            className: 'hud-sheet__foot',
            children: [
              button(doc, 'Close', () => this.onClose(), {
                className: 'hud-btn--primary',
                attrs: { 'data-hud': 'quests-close' },
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
    const sorted = [...model.quests].sort(compareQuests);
    const active = sorted.filter((q) => q.state === 'active');
    this.summary.textContent =
      `${formatCount(active.length, 'active request')} · ` +
      `${formatCount(sorted.filter((q) => q.state === 'completed').length, 'resolved')}`;

    this.clocks = [];
    const nodes: HTMLElement[] = [];
    if (sorted.length === 0) {
      nodes.push(
        el(this.doc, 'div', {
          className: 'hud-note',
          text: 'No requests on file. The Association will be in touch.',
        })
      );
    }
    for (const quest of sorted) nodes.push(this.questRow(quest, model));
    this.list.replaceChildren(...nodes);
  }

  private questRow(quest: IQuestRow, model: IHudModel): HTMLElement {
    const urgency = questUrgency(quest);
    const tracked = quest.id === model.trackedQuestId;

    const objectives = objectiveRows(this.doc, quest.objectives);

    /* The clock. Its digits are CSS COUNTERS, exactly like the combat
       tracker's, so `frame` can keep it running through the FrameWriter and
       never touch a text node — see the note on `frame` below. */
    const clock = el(this.doc, 'div', { className: 'hud-row__value', dataset: { urgency } });
    if (quest.timeRemaining !== undefined) {
      const minutes = new CssNumber(this.doc, { id: `${quest.id}-m` });
      const seconds = new CssNumber(this.doc, { pad2: true, id: `${quest.id}-s` });
      clock.append(minutes.element, el(this.doc, 'span', { text: ':' }), seconds.element);
      this.clocks.push({ minutes, seconds, quest });
    }

    const conflicts = conflictTitles(model.quests, quest.conflictsWith);

    return el(this.doc, 'div', {
      className: 'hud-row hud-row--button',
      dataset: {
        selected: tracked ? 'true' : 'false',
        quest: quest.id,
        state: quest.state,
        errand: quest.errand ? 'true' : 'false',
        urgency,
      },
      attrs: { role: 'button', tabindex: '0' },
      children: [
        el(this.doc, 'span', {
          className: 'hud-chip',
          vars: { '--hud-chip-color': quest.errand ? '#7ef0ff' : TIER_COLOR[quest.tier] },
          text: quest.errand ? 'ERRAND' : TIER_LABEL[quest.tier],
        }),
        el(this.doc, 'div', {
          className: 'hud-row__main',
          children: [
            el(this.doc, 'div', { className: 'hud-row__title', text: quest.title }),
            el(this.doc, 'div', {
              className: 'hud-row__meta',
              text:
                quest.state === 'active'
                  ? quest.description
                  : `${quest.state.toUpperCase()} · ${quest.description}`,
            }),
            ...objectives,
            conflicts
              ? el(this.doc, 'div', {
                  className: 'hud-tracker__conflict',
                  text: quest.errand
                    ? `The sale ends if you accept: ${conflicts}`
                    : `Accepting this ends: ${conflicts}`,
                })
              : null,
          ],
        }),
        el(this.doc, 'div', {
          children: [
            clock,
            el(this.doc, 'div', {
              className: 'hud-row__meta',
              text: quest.rewardPoints > 0 ? `${quest.rewardPoints} pts` : 'no points',
            }),
          ],
        }),
      ],
    });
  }

  /**
   * The log's clocks, on the 60 Hz path like every other clock in the HUD.
   *
   * This screen is modal and could plausibly afford a text write — but the
   * contract in `screen.ts` is stated over EVERY screen and the harness asserts
   * it over the one screen it happens to measure, so a screen that quietly
   * exempts itself makes the claim untrue rather than qualified. Counters cost
   * one custom-property write per changed digit and no text node, and the row
   * reference is captured in `render` so nothing is searched per frame either.
   */
  override frame(_model: IHudModel, writer: FrameWriter): void {
    // Indexed, not `for…of`: an iterator per frame is still an allocation, and
    // "step 3 never allocates" is the other half of the same contract.
    for (let i = 0; i < this.clocks.length; i++) {
      const entry = this.clocks[i]!;
      const left = Math.max(0, entry.quest.timeRemaining ?? 0);
      entry.minutes.write(writer, Math.floor(left / 60));
      entry.seconds.write(writer, Math.floor(left % 60));
    }
  }

  /** Track the quest under a tap. Wired by the manager, which owns routing. */
  handleTap(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    const row = target.closest<HTMLElement>('[data-quest]');
    const id = row?.dataset.quest;
    if (!id) return false;
    this.onTrack(id);
    return true;
  }
}
