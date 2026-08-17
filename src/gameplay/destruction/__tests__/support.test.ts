/**
 * SUPPORT MODEL — PINNED TO THE GENERATOR'S OWN RULE
 *
 * `collapsingFloors` is injected, and the bootstrap injects the city
 * generator's implementation. This directory carries a fallback so it can run
 * standalone, and a fallback that quietly disagrees with the authority is
 * worse than no fallback at all — the collapse would behave one way in a unit
 * test and another way in the game.
 *
 * So the two are run side by side over thousands of randomised destruction
 * patterns on REAL generated buildings and required to agree exactly.
 *
 * The comparison also proves the port: the generator's `IFractureLayout` is
 * passed straight into a parameter typed `IStructureLayout` with no cast, so
 * any structural drift between the two is a compile error here.
 */

import { describe, expect, it } from 'vitest';
import { collapsingFloors as cityCollapsingFloors, remainingSupport as cityRemainingSupport } from '@/world/city';
import { createRng } from '@/util';
import { collapsingFloors, remainingSupport } from '../support';
import { COLLAPSE_SUPPORT_RATIO } from '../constants';
import { makeTower, realLayouts } from './fixtures';

describe('collapse threshold', () => {
  it('matches the ratio the generator bakes against', () => {
    const { layout } = makeTower();
    expect(layout.collapseSupportRatio).toBe(COLLAPSE_SUPPORT_RATIO);
  });

  it('a floor survives losing half its supports and fails at three quarters', () => {
    const { layout } = makeTower({ floors: 5 });
    const gone = new Set<number>();
    const isDestroyed = (i: number): boolean => gone.has(i);

    // Two of four quadrants: 50% remaining, above the 0.4 floor.
    gone.add(0);
    gone.add(1);
    expect(remainingSupport(layout, 0, isDestroyed)).toBeCloseTo(0.5, 6);
    expect(collapsingFloors(layout, isDestroyed)).toEqual([]);

    // Three of four: 25% remaining, below it. Floor 0 and everything above go.
    gone.add(2);
    expect(remainingSupport(layout, 0, isDestroyed)).toBeCloseTo(0.25, 6);
    expect(collapsingFloors(layout, isDestroyed)).toEqual([0, 1, 2, 3, 4]);
  });

  it('fails at the LOWEST failing storey, not the punched one', () => {
    const { layout } = makeTower({ floors: 8 });
    const gone = new Set<number>();
    // Gut floor 5 completely and floor 2 to 25%.
    for (let q = 0; q < 4; q++) gone.add(5 * 4 + q);
    gone.add(2 * 4 + 0);
    gone.add(2 * 4 + 1);
    gone.add(2 * 4 + 2);
    const floors = collapsingFloors(layout, (i) => gone.has(i));
    expect(floors[0]).toBe(2);
    expect(floors).toEqual([2, 3, 4, 5, 6, 7]);
  });
});

describe('agreement with the city generator', () => {
  it('produces identical output on real buildings under random damage', () => {
    const layouts = realLayouts(1, -4);
    expect(layouts.length).toBeGreaterThan(3);

    const rng = createRng('support-equivalence');
    let comparisons = 0;
    let sawCollapse = 0;

    for (const { layout } of layouts) {
      for (let trial = 0; trial < 60; trial++) {
        const gone = new Set<number>();
        const density = rng.range(0.05, 0.95);
        for (let i = 0; i < layout.chunks.length; i++) {
          if (rng.next() < density) gone.add(i);
        }
        const isDestroyed = (i: number): boolean => gone.has(i);

        // No cast on either call: both signatures accept this layout.
        const mine = collapsingFloors(layout, isDestroyed);
        const theirs = cityCollapsingFloors(layout, isDestroyed);
        expect(mine).toEqual(theirs);
        if (mine.length > 0) sawCollapse++;

        for (let f = 0; f < layout.floors.length; f++) {
          expect(remainingSupport(layout, f, isDestroyed)).toBeCloseTo(
            cityRemainingSupport(layout, f, isDestroyed),
            10
          );
        }
        comparisons++;
      }
    }

    expect(comparisons).toBeGreaterThan(200);
    // A test where nothing ever collapsed would agree vacuously.
    expect(sawCollapse).toBeGreaterThan(20);
  }, 60_000);
});
