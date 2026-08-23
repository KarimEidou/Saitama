/**
 * THE QUEST LOG IS FED BY THE COMPOSITION ROOT OR NOT AT ALL
 *
 * `HudStore.setQuests` is one of the four pushes the bus cannot carry:
 * `QuestStateChangedEvent` carries an id and two states, and a log row needs a
 * title, a tier, objectives, a reward and a clock. Nothing in `src/game` ever
 * called it, so the screen drew "No requests on file" for a whole session with
 * the authored catalogue sitting behind it — a blank sheet in the integration
 * screenshot and no error anywhere.
 *
 * Two things are pinned here, because they are the two ways it comes back:
 *
 *   THE MAPPING     a row that type-checks but drops `hidden` shows a step the
 *                   quest system meant to reveal later; one that drops `errand`
 *                   loses the supermarket's own colour and chip; one that drops
 *                   `conflictsWith` — or that filters the locked quests out of
 *                   the list the ids resolve against — degrades the one warning
 *                   the log exists to show into a raw quest id.
 *
 *   THE SUBSCRIPTION  a push that happens once at boot and never again is a log
 *                   that is stale from the first accept onwards, which looks
 *                   exactly like a working screen until someone reads it.
 *
 * `Game` needs a GL context, a wasm physics world and a document, so the two
 * private methods are invoked against a prototype-backed stub carrying only the
 * fields they read — with a REAL `QuestSystem`, a REAL bus and a REAL `HudStore`
 * on either side, since a hand-written fake quest would beg the question the
 * mapping test is asking.
 */

import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '@/util';
import { QuestSystem, type IQuestDef } from '@/gameplay/progression';
import { HudStore } from '@/ui/hud';
import { Game } from '../game';

/**
 * Two quests, one of each kind that matters here: a timed errand that conflicts
 * with a subjugation, and a subjugation gated behind a class the player has not
 * reached — so it stays LOCKED and proves the locked rows are pushed too.
 */
const DEFS: readonly IQuestDef[] = [
  {
    id: 'test.errand.bargain',
    title: 'Bargain Sale',
    description: 'Half-price beef. The queue is already round the block.',
    threatTier: 'wolf',
    rewardPoints: 0,
    rewardReputation: 0,
    timeLimitSeconds: 660,
    objectives: [
      {
        id: 'bargain.buy',
        kind: 'talk',
        description: 'Buy the beef',
        required: 3,
        targetId: 'grocer',
      },
      {
        id: 'bargain.sprint',
        kind: 'defeat',
        description: 'Outrun the crowd',
        required: 1,
        targetId: 'shopper',
        hidden: true,
      },
    ],
    rules: { errand: true, conflictsWith: ['test.subjugation.mosquito'] },
  },
  {
    id: 'test.subjugation.mosquito',
    title: 'Subjugation Request: Mosquito Girl',
    description: 'A swarm over C-City. Threat level: Demon.',
    threatTier: 'demon',
    requiredClass: 'S',
    rewardPoints: 300,
    rewardReputation: 12,
    objectives: [{ id: 'mosquito.kill', kind: 'defeat', description: 'Defeat her', required: 1 }],
  },
];

/** The two private members under test, plus everything they read off `this`. */
interface IGameInternals {
  subscribe(): void;
  pushQuests(): void;
  questClocksRunning: boolean;
  bus: EventBus;
  disposers: (() => void)[];
  progression: unknown;
  hud: unknown;
}

function harness(): {
  bus: EventBus;
  quests: QuestSystem;
  store: HudStore;
  game: IGameInternals;
} {
  const bus = new EventBus();
  const quests = new QuestSystem({ bus, defs: DEFS, heroClass: () => 'C' });
  const store = new HudStore({ bus });

  const game = Object.create(Game.prototype) as IGameInternals;
  game.bus = bus;
  game.disposers = [];
  game.progression = {
    quests,
    // `subscribe` ends with a rival push as well. The ladder has its own tests;
    // an empty one keeps this test about the quests.
    progression: { state: { rank: 3151 } },
    rivals: { snapshot: () => [] },
  };
  game.hud = { store };

  return { bus, quests, store, game };
}

describe('Game.pushQuests', () => {
  it('maps a runtime quest onto the row the log draws', () => {
    const { quests, store, game } = harness();

    expect(quests.accept('test.errand.bargain')).toBe(true);
    quests.reportProgress('talk', 'grocer', 2);
    game.pushQuests();

    const row = store.model.quests.find((q) => q.id === 'test.errand.bargain');
    expect(row).toEqual({
      id: 'test.errand.bargain',
      title: 'Bargain Sale',
      description: 'Half-price beef. The queue is already round the block.',
      state: 'active',
      tier: 'wolf',
      objectives: [
        {
          id: 'bargain.buy',
          description: 'Buy the beef',
          current: 2,
          required: 3,
          complete: false,
          hidden: false,
        },
        {
          id: 'bargain.sprint',
          description: 'Outrun the crowd',
          current: 0,
          required: 1,
          complete: false,
          // `objectiveRows` filters on this. Defaulting it to false would put a
          // step the quest system is deliberately hiding on screen.
          hidden: true,
        },
      ],
      timeRemaining: 660,
      timeLimitSeconds: 660,
      errand: true,
      conflictsWith: ['test.subjugation.mosquito'],
      rewardPoints: 0,
    });
    // `accept` pins the first quest it takes; the tracker reads the pin.
    expect(store.model.trackedQuestId).toBe('test.errand.bargain');
  });

  it('pushes the locked quests too, so a conflict resolves to a title', () => {
    const { store, game } = harness();
    game.pushQuests();

    const locked = store.model.quests.find((q) => q.id === 'test.subjugation.mosquito');
    expect(locked?.state).toBe('locked');
    expect(locked?.errand).toBe(false);
    expect(locked?.tier).toBe('demon');
    expect(locked?.rewardPoints).toBe(300);

    // This is the lookup `conflictTitles` does against `model.quests`: filtering
    // the list down to what is offerable right now leaves the errand's warning
    // reading "Accepting this ends: test.subjugation.mosquito".
    const errand = store.model.quests.find((q) => q.id === 'test.errand.bargain');
    const conflictId = errand?.conflictsWith?.[0];
    expect(store.model.quests.find((q) => q.id === conflictId)?.title).toBe(
      'Subjugation Request: Mosquito Girl'
    );
  });

  it('re-pushes on every QuestStateChanged, not only at boot', () => {
    const { quests, store, game } = harness();

    game.subscribe();
    expect(store.model.quests.find((q) => q.id === 'test.errand.bargain')?.state).toBe('available');

    const setQuests = vi.spyOn(store, 'setQuests');
    expect(quests.accept('test.errand.bargain')).toBe(true);

    expect(setQuests).toHaveBeenCalledTimes(1);
    const row = store.model.quests.find((q) => q.id === 'test.errand.bargain');
    expect(row?.state).toBe('active');
    // The clock arrives with the state change, not a frame later: `accept` sets
    // it before it publishes, precisely so a listener can read it.
    expect(row?.timeRemaining).toBe(660);

    for (const dispose of game.disposers) dispose();
    store.dispose();
  });

  it('runs the one-second re-push only while a clock is actually ticking', () => {
    const { quests, store, game } = harness();

    game.pushQuests();
    // Nothing accepted: the rows are frozen data and the cadence stays off.
    expect(game.questClocksRunning).toBe(false);

    quests.accept('test.errand.bargain');
    game.pushQuests();
    expect(game.questClocksRunning).toBe(true);

    // Resolving the quest clears its `timeRemaining`, which is what turns the
    // cadence back off — otherwise the HUD re-renders once a second forever.
    quests.reportProgress('talk', 'grocer', 3);
    quests.reportProgress('defeat', 'shopper', 1);
    game.pushQuests();
    expect(store.model.quests.find((q) => q.id === 'test.errand.bargain')?.state).toBe('completed');
    expect(store.model.quests.find((q) => q.id === 'test.errand.bargain')?.timeRemaining).toBe(
      undefined
    );
    expect(game.questClocksRunning).toBe(false);
  });
});
