/**
 * THE PROGRESSION SYSTEM'S OWN HOUSEKEEPING
 *
 * Restoring from a save that lost a field, incidents nobody ever closed, the
 * subscriptions a disposed system leaves behind, and who a rescue belongs to.
 * None of it is scoring — the scoring lives in `witness-and-rank.test.ts` —
 * but every one of these silently corrupts a session that keeps playing.
 */

import { describe, expect, it, vi } from 'vitest';
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

/**
 * ONE NaN MUST NOT END THE CAREER
 *
 * `pointsValue` is an ACCUMULATOR, and `Math.max(0, NaN)` is NaN, so a single
 * non-finite award is permanent: every later award, every rank lookup and
 * every save is NaN from that frame on, with nothing thrown.
 *
 * Both guards below exist because the comparisons around them are not guards.
 * `points === 0` is FALSE for NaN, so `addPoints`'s early-out let it through;
 * and `publishRank`'s `next.rank === previous.rank` is FALSE for NaN too, so a
 * broken standing always looked like a change and always published. The HUD
 * prints what it is given — `formatRank` renders a NaN rank as a plain `0` —
 * so the only visible symptom was a rank of zero and no explanation anywhere.
 */
describe('a non-finite standing is neither accumulated nor published', () => {
  it('rejects a non-finite award instead of freezing the ladder forever', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = new EventBus();
    const system = new ProgressionSystem({ bus });
    const changes: unknown[] = [];
    bus.on('RankChanged', (event) => changes.push(event));
    const before = system.points;

    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      system.addPoints(bad, 'broken-incident');
    }

    expect(system.points).toBe(before);
    expect(Number.isFinite(system.points)).toBe(true);
    expect(changes).toHaveLength(0);
    // Not swallowed: a developer has to be able to find where it came from,
    // which is why `reason` is in the message.
    expect(error).toHaveBeenCalledTimes(3);
    expect(String(error.mock.calls[0]?.[1])).toMatch(/non-finite point award/);

    // ...and the system is still usable afterwards. That is the whole point.
    system.addPoints(500, 'real');
    expect(system.points).toBeGreaterThan(before);
    expect(changes.length).toBeGreaterThan(0);
    system.dispose();
    error.mockRestore();
  });

  it('refuses to put a non-finite standing on the bus', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = new EventBus();
    const system = new ProgressionSystem({ bus });
    const changes: unknown[] = [];
    bus.on('RankChanged', (event) => changes.push(event));

    // Reach past `addPoints`'s own guard to poison the accumulator directly —
    // this is the last line of defence, and it has to hold on its own.
    (system as unknown as { pointsValue: number }).pointsValue = Number.NaN;
    system.addPoints(10, 'test');

    expect(changes).toHaveLength(0);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[1])).toMatch(/refusing to publish a non-finite standing/);
    system.dispose();
    error.mockRestore();
  });

  it('ignores a broken day count rather than freezing the rival ladder', () => {
    // `dayCount <= lastDayCount` is false for NaN, so the calendar took the
    // NaN, and after that no real day was ever "later" than the last one.
    const harness = makeHarness();
    const before = harness.coordinator.rivals.rank('genos').points;

    harness.coordinator.progression.onDayElapsed(Number.NaN);
    expect(harness.coordinator.rivals.rank('genos').points).toBe(before);

    harness.coordinator.progression.onDayElapsed(3);
    expect(harness.coordinator.rivals.rank('genos').points).toBeGreaterThan(before);
    expect(Number.isFinite(harness.coordinator.rivals.rank('genos').points)).toBe(true);
    harness.dispose();
  });

  it('keeps a rival off NaN when an incident scores non-finite', () => {
    // `basePoints <= 0` is false for NaN, so `rival.points += NaN` ran and
    // `compareRank` then sorted Genos arbitrarily against the player forever.
    const harness = makeHarness();
    const before = harness.coordinator.rivals.rank('genos').points;

    harness.coordinator.rivals.creditIncident('genos', Number.NaN, 10);
    expect(harness.coordinator.rivals.rank('genos').points).toBe(before);
    harness.coordinator.rivals.advanceOffscreen(Number.NaN);
    expect(harness.coordinator.rivals.rank('genos').points).toBe(before);
    harness.dispose();
  });
});
