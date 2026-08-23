/**
 * OBJECTIVE ROWS, ONE COPY
 *
 * The combat tracker and the quest log draw the same objective one tap apart, so
 * they draw it from the same function. Hidden objectives are filtered here rather
 * than at each call site: a `hidden` objective that leaks into either list is the
 * same bug in both, and `IQuestObjectiveRow.hidden` exists specifically so the
 * quest system can reveal a step later.
 */

import { el } from '../dom';
import type { IQuestObjectiveRow, IQuestRow } from '../model';

/** The visible objectives of a quest, as `.hud-tracker__obj` rows. */
export function objectiveRows(
  doc: Document,
  objectives: readonly IQuestObjectiveRow[]
): HTMLElement[] {
  return objectives
    .filter((objective) => !objective.hidden)
    .map((objective) =>
      el(doc, 'div', {
        className: 'hud-tracker__obj',
        dataset: { complete: objective.complete ? 'true' : 'false' },
        children: [
          el(doc, 'span', {
            className: 'hud-tracker__count',
            text:
              objective.required > 1
                ? `${Math.min(objective.current, objective.required)}/${objective.required}`
                : objective.complete
                  ? '✓'
                  : '•',
          }),
          el(doc, 'span', { text: objective.description }),
        ],
      })
    );
}

/**
 * The titles of the quests an id list refers to, comma-joined.
 *
 * Falls back to the raw id for a quest that is not on the list, so a conflict is
 * never silently dropped — the supermarket warning is the point of the screen.
 */
export function conflictTitles(
  quests: readonly IQuestRow[],
  ids: readonly string[] | undefined
): string {
  return (ids ?? []).map((id) => quests.find((q) => q.id === id)?.title ?? id).join(', ');
}
