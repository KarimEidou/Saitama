/**
 * FORMATTER TESTS
 *
 * Every one of these is a real value from a real system, not a made-up number:
 * ¥1.5e10 is a fully-charged serious punch downtown, `+0.0` is what two hundred
 * unwitnessed kills are worth, and 660 s is the supermarket sale window.
 */

import { describe, expect, it } from 'vitest';
import { seatDelta } from '../store';
import {
  CLASS_MOVE_SEATS,
  clockParts,
  formatClock,
  formatCount,
  formatDistance,
  formatDuration,
  formatMultiplier,
  formatPercent,
  formatPoints,
  formatRank,
  formatSeatDelta,
  formatSeatMove,
  formatTier,
  formatYenCompact,
  formatYenFull,
  formatYenOku,
  groupDigits,
} from '../format';

describe('yen', () => {
  it('keeps a restrained fight at a clean zero', () => {
    expect(formatYenCompact(0)).toBe('¥0');
    expect(formatYenFull(0)).toBe('¥0');
  });

  it('compacts the four documented magnitudes', () => {
    // The figures in the MAGNITUDE WARNING on IEncounterResult.
    expect(formatYenCompact(1.0e9)).toBe('¥1.00B'); // one shopfront
    expect(formatYenCompact(4.3e9)).toBe('¥4.30B'); // one downtown block
    expect(formatYenCompact(1.5e10)).toBe('¥15.0B'); // a serious punch
  });

  it('prints every digit on the invoice', () => {
    expect(formatYenFull(1.5e10)).toBe('¥15,000,000,000');
    expect(formatYenFull(4.3e9)).toBe('¥4,300,000,000');
  });

  it('renders the Japanese unit an invoice of this size would use', () => {
    expect(formatYenOku(1.5e10)).toBe('150.0億円');
    expect(formatYenOku(1.0e9)).toBe('10.0億円');
    expect(formatYenOku(4.3e8)).toBe('4.30億円');
    expect(formatYenOku(2.4e12)).toBe('2.40兆円');
  });

  it('never returns a negative bill', () => {
    expect(formatYenCompact(-5e9)).toBe('¥0');
    expect(formatYenFull(-5e9)).toBe('¥0');
  });

  it('does not print four ungrouped digits at the K boundary', () => {
    // The ticker is sized for three characters and one fixed unit. Rounding
    // BEFORE the magnitude test let the band [999.5, 1000) escape compaction.
    expect(formatYenCompact(999.4)).toBe('¥999');
    expect(formatYenCompact(999.6)).toBe('¥1.00K');
    expect(formatYenCompact(1000)).toBe('¥1.00K');
  });

  it('groups digits without Intl', () => {
    expect(groupDigits(0)).toBe('0');
    expect(groupDigits(999)).toBe('999');
    expect(groupDigits(1000)).toBe('1,000');
    expect(groupDigits(1234567)).toBe('1,234,567');
    expect(groupDigits(-1234)).toBe('-1,234');
  });
});

describe('time', () => {
  it('splits into integer parts a CSS counter can take', () => {
    expect(clockParts(0)).toEqual({ minutes: 0, seconds: 0, tenths: 0 });
    expect(clockParts(67.4)).toEqual({ minutes: 1, seconds: 7, tenths: 4 });
    // The supermarket window.
    expect(clockParts(660)).toEqual({ minutes: 11, seconds: 0, tenths: 0 });
  });

  it('always rounds a countdown DOWN', () => {
    // 0:01 showing while the quest has already failed is a lie.
    expect(formatClock(1.99)).toBe('0:01');
    expect(formatClock(59.99)).toBe('0:59');
    expect(formatClock(60)).toBe('1:00');
  });

  it('clamps a negative remainder to zero rather than counting up', () => {
    expect(formatClock(-4)).toBe('0:00');
    expect(clockParts(-4).seconds).toBe(0);
  });

  it('gives short fights the tenth that distinguishes them', () => {
    expect(formatDuration(1.4)).toBe('1.4s');
    expect(formatDuration(9.04)).toBe('9.0s');
    expect(formatDuration(23.6)).toBe('24s');
    expect(formatDuration(150)).toBe('2:30');
  });
});

describe('rank', () => {
  it('formats the starting standing', () => {
    expect(formatRank('C', 388)).toBe('C-388');
    expect(formatRank('S', 17)).toBe('S-17');
  });

  it('shows the sign on zero, because zero is the verdict', () => {
    // 200 unwitnessed kills = exactly 0 points, by design.
    expect(formatPoints(0)).toBe('+0.0');
    expect(formatPoints(0.02)).toBe('+0.0');
    expect(formatPoints(12.4)).toBe('+12.4');
    expect(formatPoints(-35)).toBe('−35.0');
  });

  it('phrases seat movement the way the Association would', () => {
    expect(formatSeatDelta(0)).toBe('held');
    expect(formatSeatDelta(3)).toBe('up 3');
    expect(formatSeatDelta(-12)).toBe('down 12');
  });

  it('decodes a class change SYMMETRICALLY, and never as a seat count', () => {
    // `seatDelta` encodes a class change as a ±1000 sentinel because the HUD
    // does not know the class sizes. A demotion is the direction the old
    // one-sided `seats > 900 ? 1 : seats` guard missed, and it printed the
    // fabricated "down 1000" on the rank board and on the invoice.
    expect(formatSeatMove(seatDelta('C', 1, 'B', 300))).toBe('up a class');
    expect(formatSeatMove(seatDelta('B', 1, 'C', 300))).toBe('down a class');
    // Two classes at once is still a class change, not "up 2000".
    expect(formatSeatMove(seatDelta('C', 1, 'A', 30))).toBe('up a class');
    expect(formatSeatMove(seatDelta('S', 17, 'C', 30))).toBe('down a class');
    expect(formatSeatMove(-1000)).toBe('down a class');
    expect(formatSeatMove(1000)).toBe('up a class');
  });

  it('leaves a real within-class movement to formatSeatDelta', () => {
    expect(formatSeatMove(seatDelta('C', 388, 'C', 384))).toBe('up 4');
    expect(formatSeatMove(-12)).toBe('down 12');
    expect(formatSeatMove(0)).toBe('held');
    // The sentinel threshold is the only magic number, and it sits well above
    // any real within-class movement.
    expect(formatSeatMove(CLASS_MOVE_SEATS - 1)).toBe(`up ${CLASS_MOVE_SEATS - 1}`);
  });
});

describe('world', () => {
  it('switches to kilometres above a thousand metres', () => {
    expect(formatDistance(0)).toBe('0 m');
    expect(formatDistance(120.4)).toBe('120 m');
    expect(formatDistance(1500)).toBe('1.5 km');
    expect(formatDistance(24000)).toBe('24 km');
  });

  it('formats tiers and counts', () => {
    expect(formatTier('dragon')).toBe('Dragon');
    expect(formatCount(1, 'civilian')).toBe('1 civilian');
    expect(formatCount(0, 'civilian')).toBe('0 civilians');
    expect(formatCount(3, 'entry', 'entries')).toBe('3 entries');
  });
});

describe('ratios', () => {
  it('renders the boredom throttle at its floor', () => {
    expect(formatMultiplier(0.15)).toBe('×0.15');
    expect(formatMultiplier(1)).toBe('×1.00');
  });

  it('clamps percentages', () => {
    expect(formatPercent(-1)).toBe('0%');
    expect(formatPercent(0.634)).toBe('63%');
    expect(formatPercent(3)).toBe('100%');
  });
});

describe('non-finite input never reaches the screen', () => {
  it('coerces NaN and Infinity to the zero of each formatter', () => {
    // Belt and braces: `clamp01` floors NaN at 0 now, but yen and seconds do
    // not pass through a clamp on the way to a glyph, and `¥NaN` on the glass
    // reads as a rendering fault rather than as the bad input it is.
    expect(formatYenCompact(Number.NaN)).toBe('¥0');
    expect(formatYenFull(Number.NaN)).toBe('¥0');
    expect(formatYenOku(Number.NaN)).toBe('0円');
    expect(groupDigits(Number.NaN)).toBe('0');
    expect(formatClock(Number.NaN)).toBe('0:00');
    expect(formatDuration(Number.NaN)).toBe('0.0s');
    expect(formatRank('C', Number.NaN)).toBe('C-1');
    expect(formatPoints(Number.NaN)).toBe('+0.0');
    expect(formatSeatDelta(Number.NaN)).toBe('held');
    expect(formatSeatMove(Number.NaN)).toBe('held');
    expect(formatDistance(Number.NaN)).toBe('0 m');
    expect(formatCount(Number.NaN, 'civilian')).toBe('0 civilians');
    expect(formatMultiplier(Number.NaN)).toBe('×0.00');
    expect(formatPercent(Number.NaN)).toBe('0%');
    expect(formatYenCompact(Number.POSITIVE_INFINITY)).toBe('¥0');
    expect(clockParts(Number.NaN)).toEqual({ minutes: 0, seconds: 0, tenths: 0 });
  });
});
