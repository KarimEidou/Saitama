/**
 * CROWD VOICE LOGIC, WITHOUT AN AUDIO CONTEXT.
 *
 * Both functions here decide something audible before a single node is touched,
 * so both are testable as pure functions — which is the point of extracting
 * them. `director.test.ts` covers the crowd BED's blip rate against a moving
 * clock; this file covers the two decisions that need no clock at all: which
 * unit a burst overflows onto, and what a civilian count means.
 */

import { describe, expect, it } from 'vitest';
import { CrowdBedVoice, pickBlipUnit } from '../voices/crowd';

/** Stand-in for a `BlipUnit`: the picker only ever reads `freeAt`. */
interface IUnit {
  readonly name: string;
  readonly freeAt: number;
}

function units(...freeAt: readonly number[]): IUnit[] {
  return freeAt.map((at, i) => ({ name: `u${i}`, freeAt: at }));
}

describe('blip unit selection', () => {
  it('takes the first free unit in declaration order', () => {
    // Declaration order matters: the units are built once and reused, so a
    // picker that scanned from the end would always start from the same place
    // and never spread across the pool.
    const pool = units(5, -1, -1);
    expect(pickBlipUnit(pool, 1)?.name).toBe('u1');
    expect(pickBlipUnit(pool, 10)?.name).toBe('u0');
  });

  it('takes the unit that frees soonest when every unit is busy', () => {
    // This is the overflow path. `crowd.panic` at full intensity schedules 22
    // onsets across a 1.4 s spread against 10 units, so a clustered draw finds
    // them all sounding. Falling back to unit 0 put every overflow in a cluster
    // onto the SAME blip: three interrupted envelopes on one voice, with the
    // pan and formants jumping mid-note, instead of three separate voices.
    const pool = units(9, 4, 7);
    expect(pickBlipUnit(pool, 1)?.name).toBe('u1');
  });

  it('breaks a tie towards the earlier index', () => {
    const pool = units(9, 4, 4);
    expect(pickBlipUnit(pool, 1)?.name).toBe('u1');
  });

  it('returns undefined for an empty pool', () => {
    expect(pickBlipUnit([], 0)).toBeUndefined();
  });

  it('treats a unit that frees exactly now as free', () => {
    const pool = units(2, 5);
    expect(pickBlipUnit(pool, 2)?.name).toBe('u0');
  });
});

describe('crowd density mapping', () => {
  const density = (count: number): number => CrowdBedVoice.densityForCount(count);

  it('spans the full knob across the designed range', () => {
    expect(density(0)).toBe(0);
    // 80 people is the top of the range: log10(81) / log10(81).
    expect(density(80)).toBeCloseTo(1, 12);
  });

  it('never decreases as the crowd grows', () => {
    const counts = [0, 1, 5, 20, 80, 500];
    const values = counts.map(density);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!, `${counts[i]} vs ${counts[i - 1]}`).toBeGreaterThanOrEqual(values[i - 1]!);
    }
  });

  it('clamps both ends rather than running off the knob', () => {
    expect(density(500)).toBe(1);
    expect(density(-5)).toBe(0);
  });

  it('is logarithmic, so small crowds are where the difference is', () => {
    expect(density(5) - density(0)).toBeGreaterThan(density(65) - density(60));
  });

  it('returns a usable number for a broken civilian count', () => {
    // INFINITY is the case the guard still carries on its own: `log10(Infinity)`
    // is `Infinity` and `clamp01` pins that at 1, so an overflowed counter would
    // open the crowd bed to full rather than close it. NaN is belt and braces —
    // `clamp01` floors that at 0 — but it is asserted here too, because the
    // alternative was `linearRampToValueAtTime(NaN, …)` throwing a `TypeError`
    // out of the per-frame audio update.
    expect(density(Number.NaN)).toBe(0);
    expect(density(Number.POSITIVE_INFINITY)).toBe(0);
    expect(density(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});
