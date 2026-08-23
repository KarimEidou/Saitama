/**
 * THE TWO LOOKUPS EVERY SCREEN READS
 *
 * `boredomBand` and `intentForCharge` are each a linear scan that seeds with the
 * table's first entry, so each is TOTAL only while that first entry starts at 0.
 * Both tables and both scans are asserted here, together, because the failure
 * mode when they drift is a HUD that silently shows the wrong word.
 *
 * The scans also have a DIRECTION when the input is broken. A seeded scan gives
 * a non-finite value the seed — the calmest entry in both tables — because every
 * comparison against NaN is false, and both functions now refuse that: they fail
 * to the top of the ramp instead. Asserted below for both, because the whole
 * point of the choice is that the wrong direction is indistinguishable from an
 * ordinary reading.
 */

import { describe, expect, it } from 'vitest';
import {
  BOREDOM_BANDS,
  INTENT_LABEL,
  INTENT_THRESHOLDS,
  boredomBand,
  intentForCharge,
} from '../tokens';

describe('the boredom band table', () => {
  it('starts at zero and ascends, which is what makes the scan total', () => {
    expect(BOREDOM_BANDS[0]!.from).toBe(0);
    for (let i = 1; i < BOREDOM_BANDS.length; i++) {
      expect(BOREDOM_BANDS[i]!.from).toBeGreaterThan(BOREDOM_BANDS[i - 1]!.from);
    }
  });

  it('slows the breath monotonically as he stops caring', () => {
    for (let i = 1; i < BOREDOM_BANDS.length; i++) {
      expect(BOREDOM_BANDS[i]!.breathSeconds).toBeGreaterThan(BOREDOM_BANDS[i - 1]!.breathSeconds);
    }
  });
});

describe('boredomBand', () => {
  it('selects on the documented boundaries', () => {
    expect(boredomBand(0).label).toBe('ENGAGED');
    expect(boredomBand(0.249).label).toBe('ENGAGED');
    expect(boredomBand(0.25).label).toBe('RESTLESS');
    expect(boredomBand(0.5).label).toBe('GOING THROUGH THE MOTIONS');
    // 0.72 is BOREDOM_FUN_FIGHT_LOCK, mirrored from progression on purpose.
    expect(boredomBand(0.719).label).toBe('GOING THROUGH THE MOTIONS');
    expect(boredomBand(0.72).label).toBe('NOTHING FEELS LIKE ANYTHING');
    expect(boredomBand(0.92).label).toBe('NUMB');
    expect(boredomBand(1).label).toBe('NUMB');
  });

  it('never returns undefined, whatever it is handed', () => {
    // A NEGATIVE value is a real reading below the bottom of the ramp, so it
    // stays ENGAGED. Only non-finite input takes the fail-loud escape below.
    expect(boredomBand(-5).label).toBe('ENGAGED');
    expect(boredomBand(99).label).toBe('NUMB');
  });

  it('fails toward the alarming band, not the calm one', () => {
    // The seeded scan used to answer ENGAGED here, because `NaN >= 0` is false
    // and nothing ever moved the initialiser. A meter that reports "he is having
    // a good time" when its input stopped meaning anything is worse than no
    // meter: ENGAGED is also an ordinary answer, so nobody would ever notice.
    const worst = BOREDOM_BANDS[BOREDOM_BANDS.length - 1]!;
    expect(boredomBand(Number.NaN)).toBe(worst);
    expect(boredomBand(Number.POSITIVE_INFINITY)).toBe(worst);
    expect(boredomBand(Number.NEGATIVE_INFINITY)).toBe(worst);
  });

  it('never moves backwards as boredom rises', () => {
    let last = -1;
    for (let v = 0; v <= 1.0001; v += 0.005) {
      const index = BOREDOM_BANDS.indexOf(boredomBand(v));
      expect(index).toBeGreaterThanOrEqual(last);
      last = index;
    }
  });
});

describe('intentForCharge', () => {
  it('crosses at the thresholds that place the arc ticks', () => {
    expect(intentForCharge(0)).toBe('normal');
    expect(intentForCharge(0.449)).toBe('normal');
    expect(intentForCharge(0.45)).toBe('serious');
    expect(intentForCharge(0.849)).toBe('serious');
    expect(intentForCharge(0.85)).toBe('full');
    expect(intentForCharge(1)).toBe('full');
  });

  it('starts at zero, so the scan is total for any ratio', () => {
    expect(INTENT_THRESHOLDS[0]!.at).toBe(0);
    for (let i = 1; i < INTENT_THRESHOLDS.length; i++) {
      expect(INTENT_THRESHOLDS[i]!.at).toBeGreaterThan(INTENT_THRESHOLDS[i - 1]!.at);
    }
    expect(intentForCharge(-1)).toBe('normal');
  });

  it('fails toward the heaviest intent, not the lightest', () => {
    // Same asymmetry as `boredomBand`, for a different reason. The player reads
    // the arc to decide when to LET GO: told "full" on a light charge they
    // release early and waste a punch, told "normal" on a heavy one they commit
    // and take the block down with the monster. Only one of those is undoable.
    const heaviest = INTENT_THRESHOLDS[INTENT_THRESHOLDS.length - 1]!.intent;
    expect(intentForCharge(Number.NaN)).toBe(heaviest);
    expect(intentForCharge(Number.POSITIVE_INFINITY)).toBe(heaviest);
    expect(intentForCharge(Number.NEGATIVE_INFINITY)).toBe(heaviest);
  });

  it('only ever returns an intent the table names, and never goes backwards', () => {
    // Asserted as table/function AGREEMENT rather than as a frozen list, so a
    // future `restrained` rung still passes and a drift between the two fails.
    const named = INTENT_THRESHOLDS.map((step) => step.intent);
    let last = -1;
    for (let r = 0; r <= 1.0001; r += 0.005) {
      const intent = intentForCharge(r);
      expect(named).toContain(intent);
      expect(INTENT_LABEL[intent]).toBeTruthy();
      const index = named.lastIndexOf(intent);
      expect(index).toBeGreaterThanOrEqual(last);
      last = index;
    }
  });
});
