/**
 * FOOT PLANTING AND THE GAIT MODEL
 *
 * The headline assertion of this workstream, and the one that has to be a
 * measurement rather than a judgement: a planted foot's LOADED contact point
 * must not move.
 *
 * The threshold is 0.5 mm per stance — roughly one hundredth of a foot's
 * width. That is far below anything a viewer could see, which is the point:
 * the design pins feet in world space, so the residual is geometric rounding
 * rather than a tuned compromise, and a threshold that only just passes would
 * mean the mechanism had quietly stopped working.
 *
 * The control case (`measureNaiveFootSlide`) is measured the same way and
 * lands around 100 mm. The two numbers together are the actual claim.
 */

import { describe, expect, it } from 'vitest';
import {
  gaitProfile,
  measureFootSlide,
  measureLimbSanity,
  measureNaiveFootSlide,
} from '../analysis';
import { solveGait } from '../locomotion';
import { civilianFixture, heroFixture, scaledSpeed, showcaseFixtures } from './support';

/** Metres. A tenth of a millimetre is invisible; this is five times that. */
const SLIDE_LIMIT = 0.0005;

describe('planted feet', () => {
  const saitama = heroFixture('saitama');

  for (const speed of [0.8, 1.4, 2.2, 3.5, 6.0, 9.0]) {
    it(`does not slide at ${speed} m/s`, () => {
      const report = measureFootSlide(saitama.rig, { speed, seconds: 8 });
      expect(report.stances.length).toBeGreaterThan(6);
      expect(report.maxContactDrift).toBeLessThan(SLIDE_LIMIT);
      expect(report.maxFlatDrift).toBeLessThan(SLIDE_LIMIT);
      // The ankle DOES travel: the foot rolls from heel to ball. Asserting it
      // is non-zero keeps the test honest — a frozen foot would pass the
      // slide check trivially and look like a mannequin on a conveyor belt.
      expect(report.maxAnkleDrift).toBeGreaterThan(0.01);
    });
  }

  it('does not slide while accelerating through every gait', () => {
    // The case a clip-based system cannot win: stride length must change
    // mid-stance, and a foot animated backwards at "the current speed" skates
    // the instant that speed moves.
    const report = measureFootSlide(saitama.rig, {
      speedAt: (t) => 0.6 + (t / 12) * 6.4,
      seconds: 12,
      warmup: 1.5,
    });
    expect(report.stances.length).toBeGreaterThan(20);
    expect(report.maxContactDrift).toBeLessThan(SLIDE_LIMIT);
  });

  it('does not slide while turning', () => {
    const report = measureFootSlide(saitama.rig, { speed: 1.4, turnRate: 1.05, seconds: 8 });
    expect(report.maxContactDrift).toBeLessThan(SLIDE_LIMIT);
  });

  it('does not slide while decelerating to a stop', () => {
    const report = measureFootSlide(saitama.rig, {
      speedAt: (t) => Math.max(0, 4 - t * 0.5),
      seconds: 9,
      warmup: 1,
    });
    expect(report.maxContactDrift).toBeLessThan(SLIDE_LIMIT);
  });

  it('beats a naive sinusoidal walk by more than two orders of magnitude', () => {
    const solved = measureFootSlide(saitama.rig, { speed: 1.4, seconds: 8 });
    const naive = measureNaiveFootSlide(saitama.rig, 1.4, 8);
    expect(naive.maxContactDrift).toBeGreaterThan(0.03);
    expect(solved.maxContactDrift * 100).toBeLessThan(naive.maxContactDrift);
  });

  it('keeps feet planted for every body in the showcase', () => {
    for (const fixture of showcaseFixtures()) {
      const report = measureFootSlide(fixture.rig, {
        speed: scaledSpeed(fixture.rig, 0.47),
        seconds: 6,
      });
      expect(report.maxContactDrift, fixture.name).toBeLessThan(SLIDE_LIMIT);
    }
  });

  it('keeps feet planted for procedural civilians', () => {
    for (let seed = 0; seed < 6; seed++) {
      const fixture = civilianFixture(seed * 5471 + 3);
      const report = measureFootSlide(fixture.rig, {
        speed: scaledSpeed(fixture.rig, 0.47),
        seconds: 5,
      });
      expect(report.maxContactDrift, fixture.name).toBeLessThan(SLIDE_LIMIT);
    }
  });
});

describe('gait model', () => {
  const saitama = heroFixture('saitama');

  it('reproduces adult walking cadence and stride from the formula', () => {
    // 1.4 m/s is the textbook comfortable walking speed. Real adults land near
    // 110-125 steps/min with a 1.3-1.5 m stride. Nothing here is a lookup —
    // these come out of `2.2 * u^0.49` and `0.42 * u^-0.51`.
    const [row] = gaitProfile(saitama.rig, [1.4]);
    expect(row!.stepsPerMinute).toBeGreaterThan(105);
    expect(row!.stepsPerMinute).toBeLessThan(135);
    expect(row!.strideLength).toBeGreaterThan(1.2);
    expect(row!.strideLength).toBeLessThan(1.55);
    expect(row!.duty).toBeGreaterThan(0.55);
    expect(row!.duty).toBeLessThan(0.68);
  });

  it('produces a flight phase only when running', () => {
    const walk = solveGait(1.4, saitama.rig.metrics.legLength);
    const run = solveGait(6, saitama.rig.metrics.legLength);
    expect(walk.duty).toBeGreaterThan(0.5); // double support, no flight
    expect(run.duty).toBeLessThan(0.5); // both feet off the ground
  });

  it('keeps speed equal to stride times cadence at every speed', () => {
    // Foot planting depends on this identity: if the stride and the cadence
    // disagree with the ground speed, the feet cannot be both correctly spaced
    // and correctly timed.
    for (const speed of [0.4, 1.4, 3, 7, 14, 30]) {
      const g = solveGait(speed, saitama.rig.metrics.legLength);
      expect(g.strideLength * g.cycleFrequency).toBeCloseTo(speed, 6);
    }
  });

  it('scales cadence with body size rather than holding it fixed', () => {
    // The Froude scaling in one assertion. At the SAME normalised speed, a
    // short leg must take quicker steps; scaling a human cycle by height
    // instead would give both bodies the same cadence.
    const bodies = showcaseFixtures();
    const child = bodies.find((b) => b.name === 'Child')!;
    const monster = bodies.find((b) => b.name === 'Monster humanoid')!;
    const childGait = solveGait(scaledSpeed(child.rig, 0.47), child.rig.metrics.legLength);
    const monsterGait = solveGait(scaledSpeed(monster.rig, 0.47), monster.rig.metrics.legLength);
    expect(childGait.cycleFrequency).toBeGreaterThan(monsterGait.cycleFrequency * 1.3);
    // ...and their strides must differ by roughly the leg-length ratio.
    // At matched Froude number the strides differ by exactly the leg ratio.
    const ratio = monster.rig.metrics.legLength / child.rig.metrics.legLength;
    expect(monsterGait.strideLength / childGait.strideLength).toBeCloseTo(ratio, 2);
  });

  it('never takes a step at zero speed', () => {
    const g = solveGait(0, saitama.rig.metrics.legLength);
    expect(g.strideLength).toBe(0);
    expect(g.excursion).toBe(0);
    expect(g.activity).toBe(0);
  });
});

describe('limb integrity', () => {
  it('never stretches a bone, inverts a knee or sinks a foot', () => {
    for (const fixture of showcaseFixtures()) {
      const L = fixture.rig.metrics.legLength;
      const speeds = [0, 0.15, 0.47, 1.15, 2.1, 3.4].map((u) => u * Math.sqrt(9.81 * L));
      const report = measureLimbSanity(fixture.rig, speeds, 3);
      // Rotation-only animation: any length change is float32 noise.
      expect(report.maxLengthError, `${fixture.name} bone length`).toBeLessThan(1e-5);
      // A knee past 180 degrees is inverted; past ~150 is anatomically absurd.
      expect(report.maxKneeFlexion, `${fixture.name} knee`).toBeLessThan(Math.PI * 0.85);
      // Not exactly zero: the IK leaves a few tens of microns of residual when
      // it lands on a target, and that residual can point downward. A tenth of
      // a millimetre is four orders of magnitude below anything visible.
      expect(report.maxGroundPenetration, `${fixture.name} ground`).toBeLessThan(1e-4);
      expect(report.frames).toBeGreaterThan(1000);
    }
  });

  it('crouches rather than over-extending when the stride outgrows the leg', () => {
    // The reach limiter's whole job. A 2.45 m monster running at hero speed
    // demands a stride its leg cannot span from a standing pelvis height.
    const monster = showcaseFixtures().find((b) => b.name === 'Monster humanoid')!;
    const fast = measureFootSlide(monster.rig, {
      speed: scaledSpeed(monster.rig, 2.6),
      seconds: 6,
    });
    expect(fast.maxReachDrop).toBeGreaterThan(0.01);
    expect(fast.maxContactDrift).toBeLessThan(SLIDE_LIMIT);
    // ...and the crouch stays within a fraction of the leg, not a collapse.
    expect(fast.maxReachDrop).toBeLessThan(monster.rig.metrics.legLength * 0.35);
  });
});
