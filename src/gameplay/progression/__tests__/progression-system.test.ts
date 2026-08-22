/**
 * THE PROGRESSION SYSTEM'S OWN HOUSEKEEPING
 *
 * Restoring from a save that lost a field, incidents nobody ever closed, the
 * subscriptions a disposed system leaves behind, and who a rescue belongs to.
 * None of it is scoring — the scoring lives in `witness-and-rank.test.ts` —
 * but every one of these silently corrupts a session that keeps playing.
 */

import { describe, expect, it } from 'vitest';
import { EventBus } from '@/util';
import type { IProgressionState } from '@/types';
import { ProgressionSystem } from '../progression-system';
import { validateSave } from '../save-game';
import { START_POINTS, rankFromPoints } from '../rank-ladder';
import { makeHarness, ORIGIN, at } from './support';

function cleanState(): IProgressionState {
  return {
    rank: rankFromPoints(640, 'Caped Baldy'),
    killsByTier: { wolf: 3, tiger: 1, demon: 0, dragon: 0, god: 0 },
    civiliansSaved: 7,
    civiliansLost: 1,
    propertyDamage: 1200,
    reputation: 58,
    boredom: 0.4,
    completedQuests: ['quest.duty.quota'],
    playTimeSeconds: 420,
  };
}

describe('restoring a damaged save', () => {
  it('replaces a missing point total instead of poisoning the session with NaN', () => {
    const bus = new EventBus();
    const system = new ProgressionSystem({ bus });
    const broken = cleanState();
    // A truncated write, a hand-edit, or a schema change without a migration.
    (broken.rank as { points?: number }).points = undefined;

    system.restore(broken);
    expect(Number.isFinite(system.points)).toBe(true);
    expect(system.points).toBe(START_POINTS);
    expect(system.state.rank.points).toBe(system.points);

    // The award path stays finite, so the ladder is not frozen for the session.
    system.addPoints(120, 'test');
    expect(Number.isFinite(system.points)).toBe(true);
    system.dispose();
  });

  it('keeps the next save writable when every number came back broken', () => {
    const bus = new EventBus();
    const system = new ProgressionSystem({ bus });
    const broken = {
      ...cleanState(),
      civiliansSaved: Number.NaN,
      propertyDamage: Number.POSITIVE_INFINITY,
      reputation: Number.NaN,
      boredom: Number.NaN,
      playTimeSeconds: Number.NaN,
      killsByTier: { wolf: Number.NaN, tiger: 1, demon: 0, dragon: 0, god: 0 },
    } as IProgressionState;

    system.restore(broken);
    // Without sanitising, `validateSave` throws on every future autosave and
    // the player can never save again.
    expect(validateSave(system.snapshot())).toHaveLength(0);
    system.dispose();
  });
});

describe('incidents nobody closed', () => {
  it('drops an encounter that never ended, rather than scoring it later', () => {
    const harness = makeHarness();
    harness.startEncounter('e.zombie', { threatTier: 'demon' });
    // Combat tracks one encounter at a time and ignores the rest, so an
    // `EncounterEnded` for this one is never coming.
    harness.tick(700, 70);
    harness.endEncounter('e.zombie');
    harness.tick(0.1);

    expect(harness.coordinator.progression.incidentReports).toHaveLength(0);
    harness.dispose();
  });

  it('still files an encounter resolved within the window', () => {
    const harness = makeHarness();
    harness.startEncounter('e.real', { threatTier: 'demon' });
    harness.tick(60, 60);
    harness.endEncounter('e.real');
    harness.tick(0.1);

    expect(harness.coordinator.progression.incidentReports).toHaveLength(1);
    harness.dispose();
  });
});

describe('lifecycle', () => {
  it('disposes the boredom model it created itself', () => {
    const bus = new EventBus();
    const system = new ProgressionSystem({ bus });
    system.dispose();

    bus.emit('BoredomChanged', { value: 0.8, previous: 0, reason: 'trivialVictory' });
    expect(system.boredomModel.boredom).toBe(0);
  });

  it('leaves a model handed in by the caller alone', () => {
    const harness = makeHarness();
    harness.coordinator.progression.dispose();

    // The coordinator owns this one and disposes it itself.
    harness.bus.emit('BoredomChanged', { value: 0.8, previous: 0, reason: 'trivialVictory' });
    expect(harness.coordinator.boredom.boredom).toBeCloseTo(0.8, 9);
    harness.dispose();
  });

  it('adopts the calendar from a save without paying rivals for it twice', () => {
    const harness = makeHarness();
    const before = harness.coordinator.rivals.rank('genos').points;

    harness.coordinator.progression.syncDayCount(10);
    harness.coordinator.progression.onDayElapsed(10);
    expect(harness.coordinator.rivals.rank('genos').points).toBe(before);

    harness.coordinator.progression.onDayElapsed(11);
    expect(harness.coordinator.rivals.rank('genos').points).toBeGreaterThan(before);
    harness.dispose();
  });
});

describe('who a rescue belongs to', () => {
  it('credits the player only for rescues the game attributed to him', () => {
    const harness = makeHarness();
    harness.startEncounter('e.rescue', { threatTier: 'tiger' });

    harness.saveCivilian(ORIGIN, true);
    harness.saveCivilian(ORIGIN, false);
    harness.saveCivilian(at(4, 0, 4), false);
    harness.endEncounter('e.rescue');
    harness.tick(0.2);

    // The player's own stat line, which is written straight into the save.
    expect(harness.coordinator.progression.state.civiliansSaved).toBe(1);
    harness.dispose();
  });
});
