/**
 * STORE TESTS
 *
 * The HUD's data path, exercised entirely through the event bus with no DOM in
 * sight — which is the point of keeping the store DOM-free.
 *
 * Several of these encode decisions that would otherwise be invisible: that a
 * kill is worth nothing, that the alert queue drops the OLDEST, that the
 * tracker prefers the quest with the least time left, and that the rival table
 * cannot be fed by the bus at all.
 */

import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '@/util';
import { HudStore, displayRankGainMultiplier, prettyEncounterName, seatDelta } from '../store';
import {
  ALERT_LIMIT,
  RANK_FEED_LIMIT,
  compareQuests,
  createHudModel,
  questUrgency,
  type IQuestRow,
} from '../model';
import { pickTrackedQuest } from '../screens/combat-hud';

function makeStore(): { bus: EventBus; store: HudStore } {
  const bus = new EventBus();
  const store = new HudStore({ bus });
  return { bus, store };
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

/* -------------------------------------------------------------------------- */

describe('boredom', () => {
  it('adopts the value and derives the throttle', () => {
    const { bus, store } = makeStore();
    bus.emit('BoredomChanged', { value: 0.72, previous: 0, reason: 'trivialVictory' });
    expect(store.model.boredom).toBeCloseTo(0.72, 6);
    expect(store.model.boredomReason).toBe('trivialVictory');
    expect(store.model.rank.rankGainMultiplier).toBeLessThan(0.5);
    store.dispose();
  });

  it('bottoms the multiplier out at the documented floor', () => {
    expect(displayRankGainMultiplier(1)).toBeCloseTo(0.15, 6);
    expect(displayRankGainMultiplier(0)).toBeCloseTo(1, 6);
    // Monotonic: more boredom is never worth more points.
    for (let b = 0; b < 1; b += 0.1) {
      expect(displayRankGainMultiplier(b + 0.1)).toBeLessThan(displayRankGainMultiplier(b));
    }
  });
});

describe('rank', () => {
  it('derives a signed movement from the point TOTAL the event carries', () => {
    const { bus, store } = makeStore();
    store.setRank({ points: 100 });
    bus.emit('RankChanged', {
      previousClass: 'C',
      heroClass: 'C',
      previousRank: 388,
      rank: 384,
      points: 112.4,
      promoted: true,
    });
    expect(store.model.rankFeed).toHaveLength(1);
    expect(store.model.rankFeed[0]!.delta).toBeCloseTo(12.4, 6);
    expect(store.model.rankFeed[0]!.seats).toBe(4);
    expect(store.model.rank.rank).toBe(384);
    store.dispose();
  });

  it('files nothing for two hundred unwitnessed kills', () => {
    const { bus, store } = makeStore();
    for (let i = 0; i < 200; i++) {
      bus.emit('EntityKilled', {
        entityId: `m${i}`,
        entityType: 'monster',
        faction: 'monster',
        position: { x: 0, y: 0, z: 0 },
        intent: 'normal',
        rewardPoints: 0,
      });
    }
    // No RankChanged means no movement, which is the entire design.
    expect(store.model.rankFeed).toEqual([]);
    expect(store.model.rank.rank).toBe(388);
    store.dispose();
  });

  it('caps the feed', () => {
    const { bus, store } = makeStore();
    for (let i = 0; i < RANK_FEED_LIMIT + 6; i++) {
      bus.emit('RankChanged', {
        previousClass: 'C',
        heroClass: 'C',
        previousRank: 388 - i,
        rank: 387 - i,
        points: (i + 1) * 10,
        promoted: true,
      });
    }
    expect(store.model.rankFeed).toHaveLength(RANK_FEED_LIMIT);
    // Newest first.
    expect(store.model.rankFeed[0]!.rank).toBe(387 - (RANK_FEED_LIMIT + 5));
    store.dispose();
  });

  it('never lets an absent save field wipe a live standing', () => {
    const { store } = makeStore();
    store.setRank({ heroClass: 'B', rank: 42, points: 900, heroName: 'Caped Baldy' });
    // A save written by an older build: keys present, values undefined.
    store.setRank({ heroName: undefined, rank: undefined, points: undefined });
    expect(store.model.rank.heroName).toBe('Caped Baldy');
    expect(store.model.rank.rank).toBe(42);
    expect(store.model.rank.points).toBe(900);
    expect(store.model.rank.heroClass).toBe('B');
    store.dispose();
  });

  it('scores a class change as a class change, never as a seat count', () => {
    // The HUD does not know the class sizes and must not invent them.
    expect(seatDelta('C', 1, 'B', 300)).toBeGreaterThan(900);
    expect(seatDelta('B', 1, 'C', 300)).toBeLessThan(-900);
    expect(seatDelta('C', 388, 'C', 384)).toBe(4);
  });
});

describe('rivals', () => {
  it('cannot be fed by the bus — RankChanged carries no hero id', () => {
    const { bus, store } = makeStore();
    bus.emit('RankChanged', {
      previousClass: 'S',
      heroClass: 'S',
      previousRank: 17,
      rank: 16,
      points: 9000,
      promoted: true,
    });
    // That event was read as the PLAYER's, because that is what it is.
    expect(store.model.rivals).toEqual([]);
    expect(store.model.rank.heroClass).toBe('S');
    store.dispose();
  });

  it('sorts the pushed table by distance above the player', () => {
    const { store } = makeStore();
    store.setRivals([
      {
        id: 'mumen',
        displayName: 'Mumen Rider',
        heroClass: 'C',
        rank: 1,
        seatsAbovePlayer: 387,
        sharedCredit: 12,
        offscreenCredit: 3,
        jointIncidents: 1,
      },
      {
        id: 'genos',
        displayName: 'Demon Cyborg',
        heroClass: 'S',
        rank: 17,
        seatsAbovePlayer: 1400,
        sharedCredit: 240,
        offscreenCredit: 60,
        jointIncidents: 2,
      },
    ]);
    expect(store.model.rivals.map((r) => r.id)).toEqual(['genos', 'mumen']);
    store.dispose();
  });
});

describe('encounters', () => {
  it('opens a fight, counts civilians and debris, then closes it', () => {
    const { bus, store } = makeStore();
    bus.emit('EncounterStarted', {
      encounterId: 'encounter.deepSeaKing',
      threatTier: 'dragon',
      position: { x: 0, y: 0, z: 0 },
      radius: 40,
      participantIds: [],
      isBoss: true,
    });
    expect(store.model.encounter?.name).toBe('Deep Sea King');
    expect(store.model.encounter?.isBoss).toBe(true);

    bus.emit('CivilianSaved', {
      entityId: 'c1',
      position: { x: 0, y: 0, z: 0 },
      byPlayer: true,
      reputationDelta: 1,
    });
    bus.emit('CivilianLost', {
      entityId: 'c2',
      position: { x: 0, y: 0, z: 0 },
      causedByPlayer: true,
      reputationDelta: -1,
    });
    bus.emit('ChunkDetached', {
      structureId: 's',
      chunkIndex: 0,
      position: { x: 0, y: 0, z: 0 },
      mass: 900,
      impulse: { x: 0, y: 0, z: 0 },
      material: 'concrete',
      collateralCost: 12,
    });
    expect(store.model.encounter?.civiliansSaved).toBe(1);
    expect(store.model.encounter?.civiliansLost).toBe(1);
    expect(store.model.encounter?.debrisPieces).toBe(1);
    expect(store.model.encounter?.debrisMassKg).toBe(900);

    bus.emit('EncounterEnded', {
      encounterId: 'encounter.deepSeaKing',
      outcome: 'victory',
      duration: 12,
      civiliansLost: 1,
      collateralCost: 12,
    });
    expect(store.model.encounter).toBeNull();
    store.dispose();
  });

  it('ignores an end event for a fight that is not the live one', () => {
    const { bus, store } = makeStore();
    bus.emit('EncounterStarted', {
      encounterId: 'a',
      threatTier: 'wolf',
      position: { x: 0, y: 0, z: 0 },
      radius: 10,
      participantIds: [],
      isBoss: false,
    });
    bus.emit('EncounterEnded', {
      encounterId: 'b',
      outcome: 'victory',
      duration: 1,
      civiliansLost: 0,
      collateralCost: 0,
    });
    expect(store.model.encounter?.id).toBe('a');
    store.dispose();
  });

  it('runs the timer off its own clock, not off accumulated frames', () => {
    const { bus, store } = makeStore();
    store.update(10); // ten seconds of "before"
    bus.emit('EncounterStarted', {
      encounterId: 'a',
      threatTier: 'wolf',
      position: { x: 0, y: 0, z: 0 },
      radius: 10,
      participantIds: [],
      isBoss: false,
    });
    store.update(1 / 60);
    store.update(2); // a stalled frame
    expect(store.model.encounter!.elapsed).toBeCloseTo(2 + 1 / 60, 5);
    store.dispose();
  });

  it('refuses to invent a yen figure from destruction units', () => {
    const { bus, store } = makeStore();
    bus.emit('EncounterStarted', {
      encounterId: 'a',
      threatTier: 'wolf',
      position: { x: 0, y: 0, z: 0 },
      radius: 10,
      participantIds: [],
      isBoss: false,
    });
    bus.emit('ChunkDetached', {
      structureId: 's',
      chunkIndex: 0,
      position: { x: 0, y: 0, z: 0 },
      mass: 4000,
      impulse: { x: 0, y: 0, z: 0 },
      material: 'concrete',
      collateralCost: 5000,
    });
    // collateralCost is in destruction's unit. Yen stays zero until pushed.
    expect(store.model.encounter!.collateralYen).toBe(0);
    store.setCollateral(1.5e10, 0.86);
    expect(store.model.encounter!.collateralYen).toBe(1.5e10);
    expect(store.model.encounter!.collateralScore).toBeCloseTo(0.86, 6);
    store.dispose();
  });
});

describe('alerts', () => {
  it('raises a threat banner carrying the tier and the advisory', () => {
    const { bus, store } = makeStore();
    bus.emit('EncounterStarted', {
      encounterId: 'a',
      threatTier: 'dragon',
      position: { x: 0, y: 0, z: 0 },
      radius: 10,
      participantIds: [],
      isBoss: false,
    });
    const alert = store.model.alerts.at(-1)!;
    expect(alert.kind).toBe('threat');
    expect(alert.tier).toBe('dragon');
    expect(alert.title).toContain('DRAGON');
    expect(alert.body).toContain('multiple cities');
    store.dispose();
  });

  it('drops the OLDEST when the stack overflows', () => {
    const { store } = makeStore();
    const ids: number[] = [];
    for (let i = 0; i < ALERT_LIMIT + 2; i++) {
      ids.push(store.raiseAlert({ kind: 'info', title: `n${i}`, duration: 5 }));
    }
    expect(store.model.alerts).toHaveLength(ALERT_LIMIT);
    // The newest survived; the first two did not.
    expect(store.model.alerts.at(-1)!.id).toBe(ids.at(-1));
    expect(store.model.alerts.some((a) => a.id === ids[0])).toBe(false);
    store.dispose();
  });

  it('expires them on its own clock', () => {
    const { store } = makeStore();
    store.raiseAlert({ kind: 'info', title: 'x', duration: 2 });
    store.update(1);
    expect(store.model.alerts).toHaveLength(1);
    store.update(1.1);
    expect(store.model.alerts).toHaveLength(0);
    store.dispose();
  });
});

describe('quests', () => {
  it('sorts the least time remaining to the top of the active group', () => {
    const rows = [
      quest({ id: 'dragon', title: 'Subterranean King', tier: 'dragon' }),
      quest({ id: 'tunnel', title: 'Tunnel collapse', timeRemaining: 30 }),
      quest({ id: 'done', title: 'Done', state: 'completed' }),
      quest({ id: 'bargain', title: 'Bargain sale', timeRemaining: 300, errand: true }),
    ];
    expect([...rows].sort(compareQuests).map((q) => q.id)).toEqual([
      'tunnel',
      'bargain',
      'dragon',
      'done',
    ]);
  });

  it('escalates urgency only for an ACTIVE timed quest', () => {
    expect(questUrgency(quest({ id: 'a', title: 'a' }))).toBe('none');
    expect(questUrgency(quest({ id: 'a', title: 'a', timeRemaining: 300 }))).toBe('none');
    expect(questUrgency(quest({ id: 'a', title: 'a', timeRemaining: 90 }))).toBe('soon');
    expect(questUrgency(quest({ id: 'a', title: 'a', timeRemaining: 20 }))).toBe('critical');
    expect(questUrgency(quest({ id: 'a', title: 'a', timeRemaining: 20, state: 'failed' }))).toBe(
      'none'
    );
  });

  it('tracks the pinned quest, else the one with the least time left', () => {
    const model = createHudModel();
    model.quests = [
      quest({ id: 'dragon', title: 'Subterranean King', tier: 'dragon' }),
      quest({ id: 'bargain', title: 'Bargain sale', timeRemaining: 300, errand: true }),
      quest({ id: 'tunnel', title: 'Tunnel collapse', timeRemaining: 30 }),
      quest({ id: 'old', title: 'Resolved', timeRemaining: 1, state: 'completed' }),
    ];
    // Least time remaining wins, and a resolved quest is not a candidate.
    expect(pickTrackedQuest(model)?.id).toBe('tunnel');
    model.trackedQuestId = 'bargain';
    expect(pickTrackedQuest(model)?.id).toBe('bargain');
    // A pin on something that is not active falls back to the urgent one.
    model.trackedQuestId = 'old';
    expect(pickTrackedQuest(model)?.id).toBe('tunnel');
    model.quests = [];
    expect(pickTrackedQuest(model)).toBeUndefined();
  });

  it('keeps the earlier of two equally urgent quests, and allocates nothing', () => {
    // `frame()` calls this every frame for the tracker clock, so it is an
    // indexed loop rather than filter+find+reduce. A tie that flipped would
    // make the tracker swap between two jobs sixty times a second.
    const model = createHudModel();
    model.quests = [
      quest({ id: 'first', title: 'First', timeRemaining: 40 }),
      quest({ id: 'second', title: 'Second', timeRemaining: 40 }),
    ];
    expect(pickTrackedQuest(model)?.id).toBe('first');
    // The winner is LIST ORDER, not the id: reversed, the other one wins.
    model.quests = [...model.quests].reverse();
    expect(pickTrackedQuest(model)?.id).toBe('second');
    // No clock at all still beats nothing, and the first one wins.
    model.quests = [quest({ id: 'a', title: 'A' }), quest({ id: 'b', title: 'B' })];
    expect(pickTrackedQuest(model)?.id).toBe('a');
  });

  it('shows nothing when no quest is active, and ignores a pin nothing matches', () => {
    const model = createHudModel();
    expect(pickTrackedQuest(model)).toBeUndefined();
    model.quests = [
      quest({ id: 'a', title: 'A', state: 'available' }),
      quest({ id: 'b', title: 'B', state: 'completed' }),
      quest({ id: 'c', title: 'C', state: 'failed' }),
      quest({ id: 'd', title: 'D', state: 'locked' }),
    ];
    expect(pickTrackedQuest(model)).toBeUndefined();
    // A pin naming a quest that is not on the list at all is ignored, not obeyed.
    model.quests = [quest({ id: 'tunnel', title: 'Tunnel collapse', timeRemaining: 30 })];
    model.trackedQuestId = 'gone';
    expect(pickTrackedQuest(model)?.id).toBe('tunnel');
  });

  it('drops a tracked id that is no longer in the list', () => {
    const { store } = makeStore();
    store.setQuests([quest({ id: 'a', title: 'A' })], 'a');
    expect(store.model.trackedQuestId).toBe('a');
    store.setQuests([quest({ id: 'b', title: 'B' })]);
    expect(store.model.trackedQuestId).toBeUndefined();
    store.dispose();
  });

  it('raises a banner naming the quest on every lifecycle change', () => {
    const { bus, store } = makeStore();
    bus.emit('QuestStateChanged', {
      questId: 'quest.errand.bargain',
      previous: 'active',
      state: 'failed',
      title: 'Bargain Sale — Shopping District J',
    });
    const alert = store.model.alerts.at(-1)!;
    expect(alert.kind).toBe('danger');
    expect(alert.title).toContain('FAILED');
    expect(alert.title).toContain('Bargain Sale');
    store.dispose();
  });
});

describe('housekeeping', () => {
  it('unsubscribes everything on dispose', () => {
    const bus = new EventBus();
    const store = new HudStore({ bus });
    expect(bus.listenerCount()).toBeGreaterThan(5);
    store.dispose();
    expect(bus.listenerCount()).toBe(0);
  });

  it('is idempotent per bus, as the docstring promises', () => {
    // A second subscription set does not leak, it DOUBLE-COUNTS: two rescues
    // per civilian, two threat banners per encounter — and with ALERT_LIMIT of
    // three the duplicate evicts a real alert.
    const bus = new EventBus();
    const store = new HudStore({ bus });
    const subscribed = bus.listenerCount();
    store.attach(bus);
    store.attach(bus);
    expect(bus.listenerCount()).toBe(subscribed);

    bus.emit('EncounterStarted', {
      encounterId: 'a',
      threatTier: 'wolf',
      position: { x: 0, y: 0, z: 0 },
      radius: 10,
      participantIds: [],
      isBoss: false,
    });
    bus.emit('CivilianSaved', {
      entityId: 'c1',
      position: { x: 0, y: 0, z: 0 },
      byPlayer: true,
      reputationDelta: 1,
    });
    expect(store.model.encounter?.civiliansSaved).toBe(1);
    expect(store.model.alerts).toHaveLength(1);
    store.dispose();
  });

  it('re-attaches after a dispose, because dispose really did unsubscribe', () => {
    const bus = new EventBus();
    const store = new HudStore({ bus });
    store.dispose();
    expect(bus.listenerCount()).toBe(0);
    store.attach(bus);
    expect(bus.listenerCount()).toBeGreaterThan(5);
    store.dispose();
  });

  it('notifies once per change and clears the dirty flag when consumed', () => {
    const onDirty = vi.fn();
    const bus = new EventBus();
    const store = new HudStore({ bus, onDirty });
    bus.emit('BoredomChanged', { value: 0.3, previous: 0, reason: 'idle' });
    expect(onDirty).toHaveBeenCalledTimes(1);
    expect(store.consumeDirty()).toBe(true);
    expect(store.consumeDirty()).toBe(false);
    store.dispose();
  });

  it('does not mark dirty for a per-frame charge push', () => {
    // Charge changes every frame; if it dirtied the model, `render` would run
    // 60 times a second and the whole two-tier split would be pointless.
    const onDirty = vi.fn();
    const store = new HudStore({ onDirty });
    store.setCharge(0.5, true, 'serious', 1e9);
    expect(onDirty).not.toHaveBeenCalled();
    expect(store.consumeDirty()).toBe(false);
    store.dispose();
  });

  it('does not mark dirty for an unchanged per-frame witness push', () => {
    // `game.ts` `updateHud` pushes this EVERY frame. Dirtying unconditionally
    // would take `render()` — the "a few times a minute" tier — to 60 Hz.
    const onDirty = vi.fn();
    const bus = new EventBus();
    const store = new HudStore({ bus, onDirty });
    bus.emit('EncounterStarted', {
      encounterId: 'a',
      threatTier: 'wolf',
      position: { x: 0, y: 0, z: 0 },
      radius: 10,
      participantIds: [],
      isBoss: false,
    });
    store.consumeDirty();
    onDirty.mockClear();

    store.setWitnesses(3); // moved
    expect(store.model.encounter!.witnesses).toBe(3);
    expect(store.consumeDirty()).toBe(true);

    store.setWitnesses(3); // did not move
    store.setWitnesses(3.4); // rounds to the same integer
    expect(store.consumeDirty()).toBe(false);

    bus.emit('EncounterEnded', {
      encounterId: 'a',
      outcome: 'victory',
      duration: 1,
      civiliansLost: 0,
      collateralCost: 0,
    });
    store.consumeDirty();
    store.setWitnesses(9); // no encounter: nothing to show
    expect(store.consumeDirty()).toBe(false);
    store.dispose();
  });

  it('humanises an encounter id without pretending it is a display name', () => {
    expect(prettyEncounterName('encounter.deepSeaKing')).toBe('Deep Sea King');
    expect(prettyEncounterName('encounter.mosquito')).toBe('Mosquito');
    expect(prettyEncounterName('bare')).toBe('Bare');
  });
});
