/**
 * The scalar guards nothing else asserts: the reputation clamp on the shared
 * `IProgressionSystem` contract, the property-damage floor, the day-count monotonicity gate,
 * and the three `RivalTracker` edges that keep the league honest.
 */

import { describe, expect, it } from 'vitest';
import {
  REPUTATION_MAX,
  REPUTATION_MIN,
  RIVAL_OFFSCREEN_POINTS_PER_DAY,
  START_REPUTATION,
} from '../constants';
import { RivalTracker } from '../rivals';
import { makeHarness } from './support';

describe('reputation is clamped to 0..100', () => {
  it('starts at START_REPUTATION and saturates at both ends', () => {
    const harness = makeHarness();
    const progression = harness.coordinator.progression;
    expect(progression.state.reputation).toBe(START_REPUTATION);

    progression.addReputation(1000);
    expect(progression.state.reputation).toBe(REPUTATION_MAX);
    progression.addReputation(1000);
    expect(progression.state.reputation).toBe(REPUTATION_MAX);

    progression.addReputation(-5000);
    expect(progression.state.reputation).toBe(REPUTATION_MIN);
    progression.addReputation(-5000);
    expect(progression.state.reputation).toBe(REPUTATION_MIN);
    harness.dispose();
  });
});

describe('property damage only ever accumulates', () => {
  it('floors a negative cost at zero rather than crediting it back', () => {
    const harness = makeHarness();
    const progression = harness.coordinator.progression;
    progression.addPropertyDamage(1200);
    progression.addPropertyDamage(-900);
    expect(progression.state.propertyDamage).toBe(1200);
    harness.dispose();
  });
});

describe('the off-screen day ledger', () => {
  it('pays each in-game day exactly once and never runs backwards', () => {
    const harness = makeHarness();
    const { progression, rivals } = harness.coordinator;
    const start = rivals.rank('genos').points;
    const perDay = RIVAL_OFFSCREEN_POINTS_PER_DAY.genos;

    progression.onDayElapsed(3);
    expect(rivals.rank('genos').points).toBeCloseTo(start + perDay * 3, 6);

    progression.onDayElapsed(3); // same day again
    progression.onDayElapsed(1); // and a clock that went backwards
    expect(rivals.rank('genos').points).toBeCloseTo(start + perDay * 3, 6);

    progression.onDayElapsed(5); // two more days
    expect(rivals.rank('genos').points).toBeCloseTo(start + perDay * 5, 6);
    harness.dispose();
  });
});

describe('RivalTracker edges', () => {
  it('penalises by magnitude and floors at the bottom of the ladder', () => {
    const tracker = new RivalTracker();
    const before = tracker.rank('tank').points;

    tracker.penalise('tank', 25);
    expect(tracker.rank('tank').points).toBeCloseTo(before - 25, 6);
    tracker.penalise('tank', -25); // magnitude only: still a loss
    expect(tracker.rank('tank').points).toBeCloseTo(before - 50, 6);

    tracker.penalise('tank', 1e12);
    expect(tracker.rank('tank').points).toBe(0);
    expect(tracker.rank('tank').heroClass).toBe('C');
    expect(tracker.rank('tank').rank).toBe(390);
  });

  it('does not bank, or count, an incident worth nothing', () => {
    const tracker = new RivalTracker();
    const before = tracker.rank('genos').points;
    expect(tracker.creditIncident('genos', 0, 10)).toBe(0);
    expect(tracker.creditIncident('genos', -50, 10)).toBe(0);
    expect(tracker.rank('genos').points).toBe(before);
    expect(tracker.serialise().genos!.joint).toBe(0);
  });

  it('announces a rival only when the seat actually moved', () => {
    const moved: string[] = [];
    const tracker = new RivalTracker({ onRivalRankChanged: (snapshot) => moved.push(snapshot.id) });
    tracker.creditIncident('genos', 0.0001, 0); // nowhere near an S-class step
    expect(moved).toHaveLength(0);
    tracker.creditIncident('genos', 10000, 0);
    expect(moved).toEqual(['genos']);
  });
});
