import { describe, expect, it } from 'vitest';
import {
  LADDER_SIZE,
  START_POINTS,
  classForIndex,
  compareRank,
  formatRank,
  indexForPoints,
  indexForRank,
  pointsForIndex,
  rankForIndex,
  rankFromPoints,
  rankGap,
} from '../rank-ladder';
import { CLASS_SIZES, START_HERO_RANK } from '../constants';

describe('ladder geometry', () => {
  it('has one seat per canonical hero, 546 in total', () => {
    expect(LADDER_SIZE).toBe(390 + 100 + 39 + 17);
    expect(CLASS_SIZES.C).toBe(390);
    expect(CLASS_SIZES.S).toBe(17);
  });

  it('puts C-390 at the bottom and S-1 at the top', () => {
    expect(classForIndex(0)).toBe('C');
    expect(rankForIndex(0)).toBe(390);
    expect(classForIndex(LADDER_SIZE - 1)).toBe('S');
    expect(rankForIndex(LADDER_SIZE - 1)).toBe(1);
  });

  it('round-trips every seat through index and back', () => {
    for (let index = 0; index < LADDER_SIZE; index++) {
      const heroClass = classForIndex(index);
      const rank = rankForIndex(index);
      expect(indexForRank(heroClass, rank)).toBe(index);
    }
  });

  it('crosses class boundaries in the right direction', () => {
    const topOfC = indexForRank('C', 1);
    expect(classForIndex(topOfC + 1)).toBe('B');
    expect(rankForIndex(topOfC + 1)).toBe(100);

    const topOfB = indexForRank('B', 1);
    expect(classForIndex(topOfB + 1)).toBe('A');
    expect(rankForIndex(topOfB + 1)).toBe(39);
  });

  it('clamps out-of-range input rather than throwing', () => {
    expect(classForIndex(-5)).toBe('C');
    expect(classForIndex(99999)).toBe('S');
    expect(indexForRank('C', 0)).toBe(indexForRank('C', 1));
    expect(indexForRank('C', 5000)).toBe(indexForRank('C', 390));
  });
});

describe('points', () => {
  it('is strictly increasing up the ladder', () => {
    let previous = -1;
    for (let index = 0; index < LADDER_SIZE; index++) {
      const points = pointsForIndex(index);
      expect(points).toBeGreaterThan(previous);
      previous = points;
    }
  });

  it('makes each class step cost more than the one below it', () => {
    const stepAt = (index: number): number => pointsForIndex(index + 1) - pointsForIndex(index);
    const cStep = stepAt(indexForRank('C', 200));
    const bStep = stepAt(indexForRank('B', 50));
    const aStep = stepAt(indexForRank('A', 20));
    const sStep = stepAt(indexForRank('S', 10));
    expect(bStep).toBeGreaterThan(cStep);
    expect(aStep).toBeGreaterThan(bStep);
    expect(sStep).toBeGreaterThan(aStep);
  });

  it('charges a promotion premium at each class boundary', () => {
    const plainCStep = pointsForIndex(50) - pointsForIndex(49);
    const cToB = pointsForIndex(indexForRank('C', 1) + 1) - pointsForIndex(indexForRank('C', 1));
    expect(cToB).toBeGreaterThan(plainCStep * 10);
  });

  it('inverts exactly: indexForPoints undoes pointsForIndex', () => {
    for (let index = 0; index < LADDER_SIZE; index++) {
      expect(indexForPoints(pointsForIndex(index))).toBe(index);
      // One point short of the threshold is still the seat below.
      if (index > 0) expect(indexForPoints(pointsForIndex(index) - 0.001)).toBe(index - 1);
    }
  });

  it('handles degenerate point totals', () => {
    expect(indexForPoints(-100)).toBe(0);
    expect(indexForPoints(0)).toBe(0);
    expect(indexForPoints(Number.NaN)).toBe(0);
    expect(indexForPoints(Number.POSITIVE_INFINITY)).toBe(LADDER_SIZE - 1);
  });
});

describe('rankFromPoints', () => {
  it('starts the player at C-Class Rank 388, exactly as canon', () => {
    const rank = rankFromPoints(START_POINTS);
    expect(rank.heroClass).toBe('C');
    expect(rank.rank).toBe(START_HERO_RANK);
    expect(formatRank(rank)).toBe('C-Class Rank 388');
  });

  it('reports the points remaining to the next rank', () => {
    const rank = rankFromPoints(START_POINTS);
    expect(rank.pointsToNextRank).toBeGreaterThan(0);
    const promoted = rankFromPoints(START_POINTS + rank.pointsToNextRank);
    expect(promoted.rank).toBe(START_HERO_RANK - 1);
  });

  it('reports 0 to next at the very top', () => {
    const top = rankFromPoints(pointsForIndex(LADDER_SIZE - 1) + 1e9);
    expect(top.heroClass).toBe('S');
    expect(top.rank).toBe(1);
    expect(top.pointsToNextRank).toBe(0);
  });

  it('demotes back through a class boundary when points are lost', () => {
    const justIntoB = pointsForIndex(indexForRank('B', 100));
    expect(rankFromPoints(justIntoB).heroClass).toBe('B');
    expect(rankFromPoints(justIntoB - 1).heroClass).toBe('C');
    expect(rankFromPoints(justIntoB - 1).rank).toBe(1);
  });

  it('never reports negative points', () => {
    expect(rankFromPoints(-5000).points).toBe(0);
    expect(rankFromPoints(-5000).rank).toBe(390);
  });
});

describe('comparison', () => {
  it('orders across classes, not by the rank number', () => {
    const cOne = rankFromPoints(pointsForIndex(indexForRank('C', 1)));
    const sOne = rankFromPoints(pointsForIndex(indexForRank('S', 1)));
    // The trap: both are "rank 1".
    expect(cOne.rank).toBe(1);
    expect(sOne.rank).toBe(1);
    expect(compareRank(sOne, cOne)).toBeGreaterThan(0);
    expect(rankGap(sOne, cOne)).toBe(LADDER_SIZE - 1 - indexForRank('C', 1));
  });

  it('orders within a class with lower numbers on top', () => {
    const a = rankFromPoints(pointsForIndex(indexForRank('C', 10)));
    const b = rankFromPoints(pointsForIndex(indexForRank('C', 300)));
    expect(compareRank(a, b)).toBeGreaterThan(0);
    expect(rankGap(a, b)).toBe(290);
  });
});
