/**
 * SOLAR / LUNAR POSITION TESTS
 *
 * The assertions are astronomical facts, not golden numbers copied out of the
 * implementation. If someone replaces the NOAA formulae with a better model,
 * these still pass; if someone replaces them with "rotate around X", they fail.
 */

import { describe, expect, it } from 'vitest';
import { moonIllumination, moonPosition, solarDeclination, sunPosition } from '../solar';

const RAD2DEG = 180 / Math.PI;

/** Scan the day for the crossing where elevation goes from below to above 0. */
function findSunrise(dayOfYear: number, latitudeDegrees: number): number {
  let previous = sunPosition(0, { dayOfYear, latitudeDegrees }).elevation;
  for (let i = 1; i <= 2880; i++) {
    const t = i / 2880;
    const elevation = sunPosition(t, { dayOfYear, latitudeDegrees }).elevation;
    if (previous < 0 && elevation >= 0) return t;
    previous = elevation;
  }
  return Number.NaN;
}

describe('solar declination', () => {
  it('peaks near the June solstice and troughs near December', () => {
    const june = solarDeclination(172).declination * RAD2DEG;
    const december = solarDeclination(355).declination * RAD2DEG;
    const march = solarDeclination(80).declination * RAD2DEG;

    expect(june).toBeGreaterThan(22.5);
    expect(june).toBeLessThan(23.9);
    expect(december).toBeLessThan(-22.5);
    expect(december).toBeGreaterThan(-23.9);
    // Equinox: the sun is over the equator.
    expect(Math.abs(march)).toBeLessThan(1.5);
  });

  it('keeps the equation of time inside its real +-17 minute envelope', () => {
    for (let day = 1; day <= 365; day++) {
      const { equationOfTimeMinutes } = solarDeclination(day);
      expect(Math.abs(equationOfTimeMinutes)).toBeLessThan(17.5);
    }
  });
});

describe('sun position', () => {
  it('reaches the correct maximum elevation for the latitude and season', () => {
    // Midsummer noon elevation = 90 - |latitude - declination|.
    const latitude = 35.6;
    let peak = -Infinity;
    for (let i = 0; i < 1440; i++) {
      peak = Math.max(peak, sunPosition(i / 1440, { dayOfYear: 172, latitudeDegrees: latitude }).elevation);
    }
    const expected = 90 - (latitude - 23.44);
    expect(peak * RAD2DEG).toBeGreaterThan(expected - 1);
    expect(peak * RAD2DEG).toBeLessThan(expected + 1);
  });

  it('does NOT pass through the zenith at a mid latitude', () => {
    // The failure mode of a naive "rotate the light around X" cycle.
    let peak = -Infinity;
    for (let i = 0; i < 1440; i++) {
      peak = Math.max(peak, sunPosition(i / 1440, { dayOfYear: 172 }).elevation);
    }
    expect(peak * RAD2DEG).toBeLessThan(88);
  });

  it('rises in the east and sets in the west', () => {
    const rise = findSunrise(172, 35.6);
    expect(Number.isNaN(rise)).toBe(false);
    const rising = sunPosition(rise + 0.01, { dayOfYear: 172 });
    // East is 90 degrees of azimuth; midsummer sunrise is north of due east.
    expect(rising.azimuth * RAD2DEG).toBeGreaterThan(45);
    expect(rising.azimuth * RAD2DEG).toBeLessThan(110);
    expect(rising.toBodyX).toBeGreaterThan(0); // +X is east

    // Late afternoon: still up, and now in the west.
    const setting = sunPosition(0.75, { dayOfYear: 172 });
    expect(setting.elevation).toBeGreaterThan(0);
    expect(setting.azimuth * RAD2DEG).toBeGreaterThan(250);
    expect(setting.toBodyX).toBeLessThan(0); // -X is west
  });

  it('gives longer days in summer than in winter', () => {
    const dayLength = (dayOfYear: number): number => {
      let up = 0;
      for (let i = 0; i < 1440; i++) {
        if (sunPosition(i / 1440, { dayOfYear }).elevation > 0) up++;
      }
      return up / 60;
    };
    expect(dayLength(172)).toBeGreaterThan(14);
    expect(dayLength(355)).toBeLessThan(10.5);
  });

  it('never leaves the unit sphere', () => {
    for (let i = 0; i < 360; i++) {
      const p = sunPosition(i / 360, { dayOfYear: 200 });
      const length = Math.hypot(p.toBodyX, p.toBodyY, p.toBodyZ);
      expect(length).toBeCloseTo(1, 6);
      expect(p.azimuth).toBeGreaterThanOrEqual(0);
      expect(p.azimuth).toBeLessThan(Math.PI * 2 + 1e-9);
    }
  });

  it('is continuous through solar noon', () => {
    // The acos-based azimuth formula snaps by ~180 degrees at the meridian,
    // which appears in game as every shadow flipping in one frame.
    let worstJump = 0;
    let previous = sunPosition(0.4, { dayOfYear: 172 }).azimuth;
    for (let i = 1; i <= 400; i++) {
      const azimuth = sunPosition(0.4 + i * 0.0005, { dayOfYear: 172 }).azimuth;
      worstJump = Math.max(worstJump, Math.abs(azimuth - previous));
      previous = azimuth;
    }
    expect(worstJump * RAD2DEG).toBeLessThan(2);
  });

  it('is deterministic', () => {
    const a = sunPosition(0.37, { dayOfYear: 172 });
    const b = sunPosition(0.37, { dayOfYear: 172 });
    expect(a).toEqual(b);
  });
});

describe('moon', () => {
  it('is full halfway through the synodic month and new at both ends', () => {
    expect(moonIllumination(0)).toBeCloseTo(0, 5);
    expect(moonIllumination(29.530588 / 2)).toBeCloseTo(1, 5);
    expect(moonIllumination(29.530588)).toBeCloseTo(0, 5);
    expect(moonIllumination(29.530588 / 4)).toBeCloseTo(0.5, 2);
  });

  it('puts a full moon high at midnight and a new moon high at noon', () => {
    const fullAtMidnight = moonPosition(0, 14.765, { dayOfYear: 172 }).elevation;
    const fullAtNoon = moonPosition(0.5, 14.765, { dayOfYear: 172 }).elevation;
    expect(fullAtMidnight).toBeGreaterThan(0);
    expect(fullAtMidnight).toBeGreaterThan(fullAtNoon);

    const newAtNoon = moonPosition(0.5, 0, { dayOfYear: 172 }).elevation;
    const newAtMidnight = moonPosition(0, 0, { dayOfYear: 172 }).elevation;
    expect(newAtNoon).toBeGreaterThan(newAtMidnight);
  });

  it('stays on the unit sphere', () => {
    for (let i = 0; i < 120; i++) {
      const p = moonPosition(i / 120, 14);
      expect(Math.hypot(p.toBodyX, p.toBodyY, p.toBodyZ)).toBeCloseTo(1, 6);
    }
  });
});
