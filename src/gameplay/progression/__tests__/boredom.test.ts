import { describe, expect, it } from 'vitest';
import { EventBus } from '@/util';
import type { GameEventOf } from '@/types';
import { BoredomModel } from '../boredom';
import {
  BOREDOM_FUN_FIGHT_LOCK,
  BOREDOM_ON_MISSED_SALE,
  BOREDOM_RANK_FLOOR,
  HEROISM_BOREDOM_RELIEF,
} from '../constants';
import { QUEST_DEFS } from '../quest-defs';
import { makeHarness, ORIGIN, at } from './support';

describe('BoredomModel', () => {
  it('adopts combat as the authority on boredom rising', () => {
    const bus = new EventBus();
    const model = new BoredomModel({ bus });
    expect(model.boredom).toBe(0);

    bus.emit('BoredomChanged', { value: 0.62, previous: 0, reason: 'trivialVictory' });
    expect(model.boredom).toBeCloseTo(0.62, 9);
    model.dispose();
  });

  it('does not loop when it emits its own change', () => {
    const bus = new EventBus();
    const model = new BoredomModel({ bus, initial: 0.5 });
    let emissions = 0;
    bus.on('BoredomChanged', () => emissions++);

    model.recordHeroicDeed('bodyBlock');
    expect(emissions).toBe(1);
    expect(model.boredom).toBeCloseTo(0.5 + HEROISM_BOREDOM_RELIEF.bodyBlock, 9);
    model.dispose();
  });

  it('clamps to 0..1 and reports the change actually applied', () => {
    const model = new BoredomModel({ initial: 0.05 });
    const applied = model.apply(-0.5, 'restraintBonus');
    expect(model.boredom).toBe(0);
    expect(applied).toBeCloseTo(-0.05, 9);
    expect(model.apply(-1, 'restraintBonus')).toBe(0);

    model.restore(0.98);
    expect(model.apply(0.5, 'trivialVictory')).toBeCloseTo(0.02, 9);
    expect(model.boredom).toBe(1);
  });

  it('drains ONLY through heroism, and logs each act', () => {
    const model = new BoredomModel({ initial: 0.9 });
    for (const deed of Object.keys(HEROISM_BOREDOM_RELIEF) as (keyof typeof HEROISM_BOREDOM_RELIEF)[]) {
      expect(HEROISM_BOREDOM_RELIEF[deed]).toBeLessThan(0);
      model.recordHeroicDeed(deed, 'detail');
    }
    expect(model.boredom).toBeLessThan(0.9);
    expect(model.heroicHistory).toHaveLength(Object.keys(HEROISM_BOREDOM_RELIEF).length);
    expect(model.heroicHistory[0]!.detail).toBe('detail');
  });

  it('caps the heroism log', () => {
    const model = new BoredomModel({ initial: 1, historyLimit: 4 });
    for (let i = 0; i < 10; i++) model.recordHeroicDeed('caughtDebris', `${i}`);
    expect(model.heroicHistory).toHaveLength(4);
    expect(model.heroicHistory.at(-1)!.detail).toBe('9');
  });

  it('projects deeds onto the reasons the shared event permits', () => {
    const bus = new EventBus();
    const model = new BoredomModel({ bus, initial: 0.9 });
    const reasons: GameEventOf<'BoredomChanged'>['reason'][] = [];
    bus.on('BoredomChanged', (event) => reasons.push(event.reason));

    model.recordHeroicDeed('arrivedInTime');
    model.recordHeroicDeed('bodyBlock');
    model.recordHeroicDeed('zeroCollateral');
    expect(reasons).toEqual(['civilianSaved', 'restraintBonus', 'challengingFight']);
    model.dispose();
  });
});

describe('boredom throttles rank gain', () => {
  it('scales from 1.0 down to the floor', () => {
    const model = new BoredomModel();
    expect(model.rankGainMultiplier).toBeCloseTo(1, 9);
    model.restore(1);
    expect(model.rankGainMultiplier).toBeCloseTo(BOREDOM_RANK_FLOOR, 9);
    model.restore(0.5);
    const middle = model.rankGainMultiplier;
    expect(middle).toBeLessThan(1);
    expect(middle).toBeGreaterThan(BOREDOM_RANK_FLOOR);
  });

  it('is monotonic', () => {
    const model = new BoredomModel();
    let previous = Infinity;
    for (let i = 0; i <= 100; i++) {
      model.restore(i / 100);
      expect(model.rankGainMultiplier).toBeLessThanOrEqual(previous);
      previous = model.rankGainMultiplier;
    }
  });

  it('measurably slows a real run of witnessed rescues', () => {
    const fresh = makeHarness();
    const jaded = makeHarness();
    jaded.bus.emit('BoredomChanged', { value: 1, previous: 0, reason: 'trivialVictory' });

    for (const harness of [fresh, jaded]) {
      harness.crowd(ORIGIN, 12);
      for (let i = 0; i < 20; i++) harness.saveCivilian(ORIGIN);
      harness.tick(0.5);
    }

    const freshPoints = fresh.coordinator.progression.points;
    const jadedPoints = jaded.coordinator.progression.points;
    expect(jadedPoints).toBeLessThan(freshPoints);
    // The gains, not the totals — both start with the same 20 points.
    const freshGain = freshPoints - 20;
    const jadedGain = jadedPoints - 20;
    expect(jadedGain).toBeLessThan(freshGain * 0.35);
    expect(jadedGain).toBeGreaterThan(0);
    fresh.dispose();
    jaded.dispose();
  });

  it('does NOT throttle penalties — the throttle is never a shield', () => {
    const fresh = makeHarness();
    const jaded = makeHarness();
    jaded.bus.emit('BoredomChanged', { value: 1, previous: 0, reason: 'trivialVictory' });

    for (const harness of [fresh, jaded]) {
      harness.crowd(ORIGIN, 12);
      harness.loseCivilian(ORIGIN, true);
      harness.tick(0.2);
    }
    expect(jaded.coordinator.progression.points).toBe(fresh.coordinator.progression.points);
    fresh.dispose();
    jaded.dispose();
  });
});

describe('boredom locks the fun fights', () => {
  it('hides them above the threshold and restores them below it', () => {
    const harness = makeHarness();
    const funQuestIds = QUEST_DEFS.filter((d) => d.rules?.funFight).map((d) => d.id);
    expect(funQuestIds.length).toBeGreaterThan(0);

    // Fresh: they are merely gated by their prerequisites, not by boredom.
    harness.bus.emit('BoredomChanged', {
      value: BOREDOM_FUN_FIGHT_LOCK + 0.05,
      previous: 0,
      reason: 'trivialVictory',
    });
    harness.tick(0.1);
    for (const id of funQuestIds) {
      expect(harness.coordinator.quests.quests.get(id)!.state).toBe('locked');
    }

    // Heroism brings them back.
    for (let i = 0; i < 4; i++) harness.coordinator.progression.recordHeroicDeed('bodyBlock');
    harness.tick(0.1);
    expect(harness.coordinator.boredom.funFightsAvailable).toBe(true);
    harness.dispose();
  });
});

describe('boredom and the shopping', () => {
  it('costs MORE to miss the bargain sale than to fail a subjugation', () => {
    const missed = makeHarness();
    missed.bus.emit('QuestStateChanged', {
      questId: 'quest.errand.bargain',
      previous: 'active',
      state: 'failed',
      title: 'Bargain Sale',
    });
    const subjugation = makeHarness();
    subjugation.bus.emit('QuestStateChanged', {
      questId: 'quest.subjugation.mosquito',
      previous: 'active',
      state: 'failed',
      title: 'Mosquito Girl',
    });

    expect(missed.coordinator.boredom.boredom).toBeCloseTo(BOREDOM_ON_MISSED_SALE, 9);
    expect(missed.coordinator.boredom.boredom).toBeGreaterThan(subjugation.coordinator.boredom.boredom);
    missed.dispose();
    subjugation.dispose();
  });
});

describe('heroism derived from the bus', () => {
  it('credits an unwitnessed rescue as heroism, not as rank', () => {
    const harness = makeHarness();
    harness.bus.emit('BoredomChanged', { value: 0.8, previous: 0, reason: 'trivialVictory' });
    const before = harness.coordinator.boredom.boredom;

    harness.saveCivilian(at(900, 0, 900));
    expect(harness.coordinator.boredom.boredom).toBeLessThan(before);
    expect(harness.coordinator.boredom.heroicHistory.at(-1)!.deed).toBe('unwitnessedRescue');
    harness.dispose();
  });

  it('credits a zero-collateral finish', () => {
    const harness = makeHarness();
    harness.bus.emit('BoredomChanged', { value: 0.8, previous: 0, reason: 'trivialVictory' });

    harness.startEncounter('e.clean', { threatTier: 'tiger' });
    harness.killMonster({ threatTier: 'tiger' });
    harness.endEncounter('e.clean', { collateralCost: 0, civiliansLost: 0 });

    const deeds = harness.coordinator.boredom.heroicHistory.map((r) => r.deed);
    expect(deeds).toContain('zeroCollateral');
    harness.dispose();
  });

  it('does NOT credit a finish that wrecked the street', () => {
    const harness = makeHarness();
    harness.bus.emit('BoredomChanged', { value: 0.8, previous: 0, reason: 'trivialVictory' });

    harness.startEncounter('e.messy', { threatTier: 'tiger' });
    harness.wreck(ORIGIN, 90000);
    harness.endEncounter('e.messy', { collateralCost: 90000 });

    const deeds = harness.coordinator.boredom.heroicHistory.map((r) => r.deed);
    expect(deeds).not.toContain('zeroCollateral');
    harness.dispose();
  });

  it('credits allies still standing, and not when one went down', () => {
    const standing = makeHarness();
    const fallen = makeHarness();
    for (const harness of [standing, fallen]) {
      harness.bus.emit('BoredomChanged', { value: 0.8, previous: 0, reason: 'trivialVictory' });
      harness.startEncounter('e.joint', { threatTier: 'demon', participantIds: ['ally.mumen'] });
    }
    fallen.bus.emit('AllyDowned', {
      entityId: 'ally.mumen',
      displayName: 'Mumen Rider',
      position: ORIGIN,
    });
    for (const harness of [standing, fallen]) harness.endEncounter('e.joint');

    expect(standing.coordinator.boredom.heroicHistory.map((r) => r.deed)).toContain('alliesStanding');
    expect(fallen.coordinator.boredom.heroicHistory.map((r) => r.deed)).not.toContain('alliesStanding');
    standing.dispose();
    fallen.dispose();
  });
});
