/**
 * THE CENTRAL ASSERTION OF THE WHOLE WORKSTREAM
 *
 * Rank moves on WITNESSED saves and REPORTED collateral, and NOT on kills.
 * Everything else in progression is negotiable; these tests are not.
 */

import { describe, expect, it } from 'vitest';
import { WITNESS_CREDIBILITY, WITNESS_RADIUS, WITNESS_SATURATION } from '../constants';
import { WitnessField, mergeReports, NO_WITNESSES } from '../witness';
import { indexForRank, rankGap } from '../rank-ladder';
import { at, makeHarness, ORIGIN } from './support';

describe('WitnessField', () => {
  it('only counts witnesses inside the radius', () => {
    const field = new WitnessField();
    field.register('a', 'civilian', at(0, 0, 0));
    field.register('b', 'civilian', at(WITNESS_RADIUS - 1, 0, 0));
    field.register('c', 'civilian', at(WITNESS_RADIUS + 5, 0, 0));

    const report = field.report(ORIGIN);
    expect(report.count).toBe(2);
    expect(report.credibility).toBe(2 * WITNESS_CREDIBILITY.civilian);
  });

  it('weighs a hero, the press and a camera above a bystander', () => {
    const field = new WitnessField();
    field.register('civ', 'civilian', ORIGIN);
    expect(field.report(ORIGIN).credibility).toBe(1);
    field.clear();

    field.register('hero', 'hero', ORIGIN);
    expect(field.report(ORIGIN).credibility).toBe(WITNESS_CREDIBILITY.hero);
    field.clear();

    field.register('press', 'press', ORIGIN);
    expect(field.report(ORIGIN).credibility).toBe(WITNESS_CREDIBILITY.press);
  });

  it('gives the player his own account exactly zero weight', () => {
    const field = new WitnessField();
    field.register('player', 'self', ORIGIN);
    const report = field.report(ORIGIN);
    expect(report.count).toBe(1);
    expect(report.credibility).toBe(0);
    expect(report.corroboration).toBe(0);
  });

  it('saturates corroboration at 1', () => {
    const field = new WitnessField();
    for (let i = 0; i < 40; i++) field.register(`c${i}`, 'civilian', at(i * 0.1, 0, 0));
    expect(field.report(ORIGIN).corroboration).toBe(1);
    expect(field.report(ORIGIN).credibility).toBeGreaterThan(WITNESS_SATURATION);
  });

  it('reports collateral even with nobody watching — the asymmetry', () => {
    const empty = new WitnessField().report(ORIGIN);
    expect(empty.count).toBe(0);
    // Credit is zero...
    expect(empty.corroboration).toBe(0);
    // ...but blame is not.
    expect(empty.collateralReportRate).toBeGreaterThan(0.5);
    expect(NO_WITNESSES.collateralReportRate).toBe(empty.collateralReportRate);
  });

  it('reports MORE collateral with a crowd than without one', () => {
    const field = new WitnessField();
    const alone = field.report(ORIGIN).collateralReportRate;
    for (let i = 0; i < 12; i++) field.register(`c${i}`, 'civilian', at(i, 0, 0));
    expect(field.report(ORIGIN).collateralReportRate).toBeGreaterThan(alone);
    expect(field.report(ORIGIN).collateralReportRate).toBeLessThanOrEqual(1);
  });

  it('drops witnesses who cannot testify', () => {
    const field = new WitnessField();
    field.register('a', 'civilian', ORIGIN);
    field.setActive('a', false);
    expect(field.report(ORIGIN).count).toBe(0);
    field.setActive('a', true);
    expect(field.report(ORIGIN).count).toBe(1);
  });

  it('is idempotent by id and supports moving', () => {
    const field = new WitnessField();
    field.register('a', 'civilian', ORIGIN);
    field.register('a', 'civilian', ORIGIN);
    expect(field.size).toBe(1);
    field.move('a', at(500, 0, 0));
    expect(field.report(ORIGIN).count).toBe(0);
  });

  it('names the heroes present, for rival credit', () => {
    const field = new WitnessField();
    field.register('ally.genos', 'hero', ORIGIN);
    field.register('civ', 'civilian', ORIGIN);
    expect(field.report(ORIGIN).heroIds).toEqual(['ally.genos']);
  });

  it('merges reports by keeping the strongest evidence for each claim', () => {
    const a = { count: 3, credibility: 3, corroboration: 0.4, collateralReportRate: 0.6, heroIds: ['h1'] };
    const b = { count: 1, credibility: 7, corroboration: 1, collateralReportRate: 0.9, heroIds: ['h2'] };
    const merged = mergeReports(a, b);
    expect(merged.count).toBe(3);
    expect(merged.corroboration).toBe(1);
    expect(merged.collateralReportRate).toBe(0.9);
    expect(merged.heroIds.sort()).toEqual(['h1', 'h2']);
  });
});

describe('rank does NOT move on kills', () => {
  it('is unmoved by a hundred kills with nobody watching', () => {
    const harness = makeHarness();
    const before = harness.coordinator.progression.points;
    const beforeRank = harness.coordinator.progression.state.rank;

    for (let i = 0; i < 100; i++) {
      harness.killMonster({ threatTier: 'tiger', rewardPoints: 60, position: at(i * 3, 0, 0) });
    }
    harness.tick(2);

    expect(harness.coordinator.progression.points).toBe(before);
    expect(harness.coordinator.progression.state.rank.rank).toBe(beforeRank.rank);
    // The kills are still RECORDED — the counter works, it just does not pay.
    expect(harness.coordinator.progression.state.killsByTier.tiger).toBe(100);
    harness.dispose();
  });

  it('barely moves across many unwitnessed resolved encounters', () => {
    const harness = makeHarness();
    const start = harness.coordinator.progression.points;

    for (let i = 0; i < 25; i++) {
      const id = `encounter.alley.${i}`;
      harness.startEncounter(id, { threatTier: 'demon', position: at(i * 400, 0, 0) });
      for (let k = 0; k < 8; k++) harness.killMonster({ threatTier: 'demon', position: at(i * 400, 0, 0) });
      harness.endEncounter(id);
      harness.tick(0.5);
    }

    const gained = harness.coordinator.progression.points - start;
    // 25 demon-tier victories at full credit would be well over 2000 points.
    expect(gained).toBeGreaterThan(0);
    expect(gained).toBeLessThan(200);
    expect(harness.coordinator.progression.state.rank.heroClass).toBe('C');
    harness.dispose();
  });

  it('moves a great deal for ONE witnessed encounter', () => {
    const alley = makeHarness();
    const street = makeHarness();

    for (const [harness, witnessed] of [
      [alley, false],
      [street, true],
    ] as const) {
      if (witnessed) harness.crowd(ORIGIN, 12);
      harness.startEncounter('encounter.x', { threatTier: 'demon' });
      harness.killMonster({ threatTier: 'demon' });
      harness.endEncounter('encounter.x');
      harness.tick(0.5);
    }

    const alone = alley.coordinator.progression.points;
    const seen = street.coordinator.progression.points;
    expect(seen).toBeGreaterThan(alone * 1.5);
    alley.dispose();
    street.dispose();
  });
});

describe('rank moves on witnessed saves', () => {
  it('pays far more for a save someone saw', () => {
    const alone = makeHarness();
    const seen = makeHarness();
    seen.crowd(ORIGIN, 10);

    alone.saveCivilian(ORIGIN);
    seen.saveCivilian(ORIGIN);
    alone.tick(0.2);
    seen.tick(0.2);

    const aloneGain = alone.coordinator.progression.points;
    const seenGain = seen.coordinator.progression.points;
    expect(seenGain).toBeGreaterThan(aloneGain + 5);
    alone.dispose();
    seen.dispose();
  });

  it('promotes through several ranks on a string of witnessed rescues', () => {
    const harness = makeHarness();
    harness.crowd(ORIGIN, 14);
    const before = harness.coordinator.progression.state.rank.rank;

    for (let i = 0; i < 30; i++) harness.saveCivilian(ORIGIN);
    harness.tick(1);

    const after = harness.coordinator.progression.state.rank;
    expect(after.rank).toBeLessThan(before);
    expect(harness.coordinator.progression.state.civiliansSaved).toBe(30);
    harness.dispose();
  });
});

describe('rank moves DOWN on reported collateral', () => {
  it('penalises a hero who wrecked the block even with nobody watching', () => {
    const harness = makeHarness();
    harness.crowd(ORIGIN, 10);
    for (let i = 0; i < 20; i++) harness.saveCivilian(ORIGIN);
    harness.tick(0.5);
    const afterSaves = harness.coordinator.progression.points;

    harness.coordinator.witnesses.clear();
    harness.startEncounter('encounter.demolition', { threatTier: 'wolf' });
    harness.wreck(ORIGIN, 400000);
    harness.endEncounter('encounter.demolition', { collateralCost: 400000 });
    harness.tick(0.5);

    expect(harness.coordinator.progression.points).toBeLessThan(afterSaves);
    expect(harness.coordinator.progression.state.propertyDamage).toBe(400000);
    harness.dispose();
  });

  it('reports MORE of the same damage when there was a crowd', () => {
    const quiet = makeHarness();
    const busy = makeHarness();
    busy.crowd(ORIGIN, 14);

    for (const harness of [quiet, busy]) {
      harness.startEncounter('e', { threatTier: 'wolf' });
      harness.wreck(ORIGIN, 250000);
      harness.endEncounter('e', { collateralCost: 250000 });
      harness.tick(0.3);
    }

    const quietReport = quiet.coordinator.progression.incidentReports[0]!;
    const busyReport = busy.coordinator.progression.incidentReports[0]!;
    expect(busyReport.collateralReported).toBeGreaterThan(quietReport.collateralReported);
    // ...but the quiet one still reported over half of it.
    expect(quietReport.collateralReported / quietReport.collateralGross).toBeGreaterThan(0.5);
    quiet.dispose();
    busy.dispose();
  });
});

describe('the Genos problem', () => {
  it('credits a rival at the same incident more than the player', () => {
    const harness = makeHarness();
    harness.crowd(ORIGIN, 12);

    harness.startEncounter('encounter.joint', {
      threatTier: 'demon',
      participantIds: ['ally.genos'],
    });
    harness.killMonster({ threatTier: 'demon' });
    harness.endEncounter('encounter.joint');
    harness.tick(0.3);

    const report = harness.coordinator.progression.incidentReports[0]!;
    expect(report.rivalCredit.genos).toBeGreaterThan(report.awardedPoints);
    expect(report.rivalCredit.genos! / report.basePoints).toBeCloseTo(2.4, 5);
    harness.dispose();
  });

  it('lets Genos climb past the player over a shared campaign', () => {
    const harness = makeHarness();
    harness.crowd(ORIGIN, 12);

    const startGap = rankGap(
      harness.coordinator.rivals.rank('genos'),
      harness.coordinator.progression.state.rank
    );

    for (let i = 0; i < 12; i++) {
      const id = `encounter.joint.${i}`;
      harness.startEncounter(id, { threatTier: 'demon', participantIds: ['ally.genos'] });
      harness.killMonster({ threatTier: 'demon' });
      harness.endEncounter(id);
      harness.tick(0.2);
    }

    const endGap = rankGap(
      harness.coordinator.rivals.rank('genos'),
      harness.coordinator.progression.state.rank
    );
    // The player climbed. Genos climbed faster, from further up.
    expect(harness.coordinator.progression.state.rank.rank).toBeLessThan(388);
    expect(endGap).toBeGreaterThan(0);
    expect(harness.coordinator.rivals.rank('genos').heroClass).toBe('S');
    expect(startGap).toBeGreaterThan(0);
    harness.dispose();
  });

  it('keeps rivals working while the player does nothing', () => {
    const harness = makeHarness();
    const before = harness.coordinator.rivals.rank('genos').points;
    harness.coordinator.rivals.advanceOffscreen(7);
    expect(harness.coordinator.rivals.rank('genos').points).toBeGreaterThan(before);
    harness.dispose();
  });

  it('serialises and restores the rival table exactly', () => {
    const harness = makeHarness();
    harness.coordinator.rivals.advanceOffscreen(3);
    const saved = harness.coordinator.rivals.serialise();

    harness.coordinator.rivals.reset();
    expect(harness.coordinator.rivals.rank('genos').points).not.toBe(saved.genos!.points);

    harness.coordinator.rivals.restore(saved);
    expect(harness.coordinator.rivals.rank('genos').points).toBe(saved.genos!.points);
    harness.dispose();
  });
});

describe('RankChanged', () => {
  it('fires only when the seat actually changes', () => {
    const harness = makeHarness();
    const events: { promoted: boolean; rank: number }[] = [];
    harness.bus.on('RankChanged', (event) => events.push({ promoted: event.promoted, rank: event.rank }));

    // An UNWITNESSED save is worth 0.4 points: real, recorded, and nowhere
    // near a rank at the C-class step cost of 10.
    for (let i = 0; i < 5; i++) harness.saveCivilian(ORIGIN);
    expect(events).toHaveLength(0);
    expect(harness.coordinator.progression.state.civiliansSaved).toBe(5);

    // With a crowd, the same act moves the ladder immediately.
    harness.crowd(ORIGIN, 12);
    for (let i = 0; i < 10; i++) harness.saveCivilian(ORIGIN);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.promoted)).toBe(true);
    harness.dispose();
  });

  it('fires a demotion when points are lost', () => {
    const harness = makeHarness();
    harness.crowd(ORIGIN, 12);
    for (let i = 0; i < 20; i++) harness.saveCivilian(ORIGIN);

    const events: boolean[] = [];
    harness.bus.on('RankChanged', (event) => events.push(event.promoted));
    for (let i = 0; i < 6; i++) harness.loseCivilian(ORIGIN, true);

    expect(events.length).toBeGreaterThan(0);
    expect(events.some((promoted) => !promoted)).toBe(true);
    harness.dispose();
  });

  it('never lets the player fall below the bottom of the ladder', () => {
    const harness = makeHarness();
    for (let i = 0; i < 200; i++) harness.loseCivilian(ORIGIN, true);
    const rank = harness.coordinator.progression.state.rank;
    expect(rank.heroClass).toBe('C');
    expect(rank.rank).toBe(390);
    expect(rank.points).toBe(0);
    expect(indexForRank(rank.heroClass, rank.rank)).toBe(0);
    harness.dispose();
  });
});
