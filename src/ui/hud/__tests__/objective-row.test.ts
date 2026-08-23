/**
 * ONE OBJECTIVE ROW, TWO SCREENS
 *
 * The combat tracker and the quest log draw the same objective one tap apart.
 * They were the same twenty lines twice, and nothing made them stay identical —
 * a reviewer editing one of the two blocks could not see that the other copy
 * existed. These assertions pin the shared builder's three decisions: hidden
 * rows never render, the count is CLAMPED to the requirement, and `complete` is
 * a string on the dataset rather than a boolean.
 *
 * No DOM in the node test environment, so the document is the hand-rolled stub
 * pattern `frame-writer.test.ts` established.
 */

import { describe, expect, it } from 'vitest';
import { conflictTitles, objectiveRows } from '../screens/objective-row';
import type { IQuestObjectiveRow, IQuestRow } from '../model';

/** The minimum node surface `el()` touches, with children recorded. */
interface IStubNode {
  className: string;
  textContent: string;
  readonly dataset: Record<string, string>;
  readonly children: IStubNode[];
  readonly style: { setProperty(name: string, value: string): void };
  setAttribute(name: string, value: string): void;
  appendChild(child: IStubNode): void;
}

function stubNode(): IStubNode {
  const children: IStubNode[] = [];
  return {
    className: '',
    textContent: '',
    dataset: {},
    children,
    style: { setProperty(): void {} },
    setAttribute(): void {},
    appendChild(child: IStubNode): void {
      children.push(child);
    },
  };
}

function fakeDocument(): Document {
  return { createElement: (): IStubNode => stubNode() } as unknown as Document;
}

function objective(patch: Partial<IQuestObjectiveRow> = {}): IQuestObjectiveRow {
  return {
    id: 'o',
    description: 'Clear the tunnel',
    current: 0,
    required: 1,
    complete: false,
    hidden: false,
    ...patch,
  };
}

function quest(patch: Partial<IQuestRow> & Pick<IQuestRow, 'id' | 'title'>): IQuestRow {
  return {
    description: '',
    state: 'active',
    tier: 'wolf',
    objectives: [],
    errand: false,
    rewardPoints: 0,
    ...patch,
  };
}

/** The `.hud-tracker__count` text of a built row. */
function countOf(row: unknown): string {
  return (row as unknown as IStubNode).children[0]!.textContent;
}

/* -------------------------------------------------------------------------- */

describe('objectiveRows', () => {
  it('never renders a hidden objective', () => {
    // `hidden` exists so the quest system can reveal a step later; one that
    // leaks into either list is the same bug on both screens.
    const rows = objectiveRows(fakeDocument(), [
      objective({ id: 'a' }),
      objective({ id: 'b', hidden: true }),
    ]);
    expect(rows).toHaveLength(1);
  });

  it('clamps the count to the requirement', () => {
    const rows = objectiveRows(fakeDocument(), [objective({ current: 7, required: 5 })]);
    expect(countOf(rows[0]!)).toBe('5/5');
    const partial = objectiveRows(fakeDocument(), [objective({ current: 2, required: 5 })]);
    expect(countOf(partial[0]!)).toBe('2/5');
  });

  it('renders a single-step objective as a tick or a bullet, never as 1/1', () => {
    const done = objectiveRows(fakeDocument(), [objective({ required: 1, complete: true })]);
    expect(countOf(done[0]!)).toBe('✓');
    const todo = objectiveRows(fakeDocument(), [objective({ required: 1, complete: false })]);
    expect(countOf(todo[0]!)).toBe('•');
  });

  it('writes complete as a STRING, because a dataset value is one', () => {
    const [row] = objectiveRows(fakeDocument(), [objective({ complete: true })]);
    const node = row as unknown as IStubNode;
    expect(node.dataset.complete).toBe('true');
    expect(node.className).toBe('hud-tracker__obj');
    const [pending] = objectiveRows(fakeDocument(), [objective({ complete: false })]);
    expect((pending as unknown as IStubNode).dataset.complete).toBe('false');
  });

  it('carries the description through as the second span', () => {
    const [row] = objectiveRows(fakeDocument(), [
      objective({ description: 'Evacuate 5 civilians' }),
    ]);
    expect((row as unknown as IStubNode).children[1]!.textContent).toBe('Evacuate 5 civilians');
  });
});

describe('conflictTitles', () => {
  const quests = [
    quest({ id: 'q.known', title: 'Known title' }),
    quest({ id: 'q.other', title: 'Other title' }),
  ];

  it('falls back to the raw id rather than dropping a conflict silently', () => {
    // The supermarket warning is the point of the screen; a conflict that
    // vanishes because its quest is not on the list is the worst outcome.
    expect(conflictTitles(quests, ['q.known', 'q.unknown'])).toBe('Known title, q.unknown');
  });

  it('is the empty string for no conflicts, which the callers test for falsiness', () => {
    expect(conflictTitles(quests, undefined)).toBe('');
    expect(conflictTitles(quests, [])).toBe('');
  });

  it('comma-joins in the order given', () => {
    expect(conflictTitles(quests, ['q.other', 'q.known'])).toBe('Other title, Known title');
  });
});
