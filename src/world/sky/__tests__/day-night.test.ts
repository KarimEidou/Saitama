/**
 * DAY / NIGHT SYSTEM TESTS
 *
 * The important ones are at the bottom: night must be MEASURABLY darker than
 * noon in the published lighting state, and the exposure curve must not quietly
 * cancel the luminance curve.
 */

import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '@/util';
import type { GameEventOf } from '@/types';
import { DayNightSystem } from '../day-night-system';
import { parseEnvironmentMeasurements } from '../environment-blend';
import { phaseForTime } from '../sky-lighting';
import { DAY_LENGTH_SECONDS, EXPOSURE_MAX, EXPOSURE_MIN } from '../constants';

const MANIFEST = {
  environments: {
    'hdri.sky.dawn': { meanLuminance: 1.0980531162976837, maxLuminance: 8.44295, sh9: tint(3.8, 1.0, 0.95, 0.85) },
    'hdri.sky.day': { meanLuminance: 0.73268945997054, maxLuminance: 136998.3, sh9: tint(2.52, 1.0, 1.0, 1.02) },
    'hdri.sky.dusk': { meanLuminance: 0.9044060619958861, maxLuminance: 4.04, sh9: tint(2.76, 1.0, 0.9, 0.8) },
    'hdri.sky.night': { meanLuminance: 0.712214196645703, maxLuminance: 554.8, sh9: tint(2.35, 0.9, 0.95, 1.1) },
  },
};

/** 27 plausible coefficients with a colour cast, dominated by the DC term. */
function tint(dc: number, r: number, g: number, b: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 9; i++) {
    const falloff = i === 0 ? 1 : 0.2 / i;
    out.push(dc * falloff * r, dc * falloff * g, dc * falloff * b);
  }
  return out;
}

function makeSystem(startTimeOfDay = 0.5, bus?: EventBus): DayNightSystem {
  return new DayNightSystem({
    bus,
    startTimeOfDay,
    measurements: parseEnvironmentMeasurements(MANIFEST),
  });
}

describe('phaseForTime', () => {
  it('names every phase and wraps midnight through zero', () => {
    expect(phaseForTime(0)).toBe('midnight');
    expect(phaseForTime(0.2)).toBe('dawn');
    expect(phaseForTime(0.35)).toBe('morning');
    expect(phaseForTime(0.5)).toBe('noon');
    expect(phaseForTime(0.65)).toBe('afternoon');
    expect(phaseForTime(0.76)).toBe('dusk');
    expect(phaseForTime(0.88)).toBe('night');
    expect(phaseForTime(0.99)).toBe('midnight');
    expect(phaseForTime(1.0)).toBe('midnight');
    expect(phaseForTime(-0.01)).toBe('midnight');
  });
});

describe('clock', () => {
  it('advances one full day in dayLengthSeconds', () => {
    const system = makeSystem(0);
    expect(system.dayLengthSeconds).toBe(DAY_LENGTH_SECONDS);
    for (let i = 0; i < 1440; i++) system.update(DAY_LENGTH_SECONDS / 1440);
    // 1440 * (X / 1440) is a hair under X in floating point, so the clock
    // lands just short of the wrap rather than exactly on it.
    const t = system.state.timeOfDay;
    expect(Math.min(t, 1 - t)).toBeLessThan(0.002);

    system.update(DAY_LENGTH_SECONDS / 1440);
    expect(system.dayCount).toBe(1);
    expect(system.state.timeOfDay).toBeLessThan(0.002);
  });

  it('honours timeScale, including a full freeze', () => {
    const system = makeSystem(0.5);
    system.timeScale = 0;
    system.update(600);
    expect(system.state.timeOfDay).toBeCloseTo(0.5, 9);

    system.timeScale = 4;
    system.update(DAY_LENGTH_SECONDS / 4);
    expect(system.state.timeOfDay).toBeCloseTo(0.5, 3);
  });

  it('ignores a non-finite time', () => {
    const system = makeSystem(0.5);
    system.setTimeOfDay(Number.NaN);
    expect(Number.isFinite(system.state.timeOfDay)).toBe(true);
  });

  it('wraps times outside 0..1', () => {
    const system = makeSystem(0.5);
    system.setTimeOfDay(2.25);
    expect(system.state.timeOfDay).toBeCloseTo(0.25, 9);
    system.setTimeOfDay(-0.25);
    expect(system.state.timeOfDay).toBeCloseTo(0.75, 9);
  });
});

describe('TimeOfDayChanged', () => {
  it('fires on phase transitions and NOT every frame', () => {
    const bus = new EventBus();
    const events: GameEventOf<'TimeOfDayChanged'>[] = [];
    bus.on('TimeOfDayChanged', (event) => events.push(event));

    const system = makeSystem(0, bus);
    // One whole day, sampled 600 times: 7 phases, so 7 transitions.
    for (let i = 0; i < 600; i++) system.update(DAY_LENGTH_SECONDS / 600);

    expect(events.length).toBe(7);
    expect(new Set(events.map((e) => e.phase)).size).toBe(7);
    for (const event of events) expect(event.phase).not.toBe(event.previousPhase);
  });

  it('fires on an explicit jump that crosses a phase', () => {
    const bus = new EventBus();
    const events: GameEventOf<'TimeOfDayChanged'>[] = [];
    bus.on('TimeOfDayChanged', (event) => events.push(event));

    const system = makeSystem(0.5, bus);
    system.setTimeOfDay(0.0);
    expect(events).toHaveLength(1);
    expect(events[0]!.previousPhase).toBe('noon');
    expect(events[0]!.phase).toBe('midnight');

    // A jump inside the same phase is silent.
    system.setTimeOfDay(0.02);
    expect(events).toHaveLength(1);
  });

  it('carries the day count', () => {
    const bus = new EventBus();
    const events: GameEventOf<'TimeOfDayChanged'>[] = [];
    bus.on('TimeOfDayChanged', (event) => events.push(event));
    const system = makeSystem(0.9, bus);
    for (let i = 0; i < 2000; i++) system.update(DAY_LENGTH_SECONDS / 1000);
    expect(system.dayCount).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.dayCount >= 1)).toBe(true);
  });
});

describe('quest time override', () => {
  it('pins the visible clock while the real one keeps running', () => {
    const system = makeSystem(0.5);
    system.forceTimeOfDay(0.79);
    expect(system.state.timeOfDay).toBeCloseTo(0.79, 9);
    expect(system.overrideState).toBe('held');

    for (let i = 0; i < 100; i++) system.update(1);
    expect(system.state.timeOfDay).toBeCloseTo(0.79, 9);

    // Releasing with no easing lands on where the free clock actually is.
    system.releaseTime(0);
    expect(system.overrideState).toBe('none');
    expect(system.state.timeOfDay).toBeGreaterThan(0.5);
    expect(system.state.timeOfDay).toBeLessThan(0.62);
  });

  it('eases back rather than snapping', () => {
    const system = makeSystem(0.5);
    system.forceTimeOfDay(0.2);
    for (let i = 0; i < 60; i++) system.update(1 / 60);
    system.releaseTime(4);
    expect(system.overrideState).toBe('releasing');

    const first = system.state.timeOfDay;
    system.update(1 / 60);
    const second = system.state.timeOfDay;
    // Moving, but not the whole way in one frame.
    expect(second).not.toBeCloseTo(first, 6);
    expect(Math.abs(second - first)).toBeLessThan(0.1);

    for (let i = 0; i < 600; i++) system.update(1 / 60);
    expect(system.overrideState).toBe('none');
  });

  it('takes the short way round the circle when releasing across midnight', () => {
    const system = makeSystem(0.999);
    system.forceTimeOfDay(0.99);
    system.update(1); // free clock ticks past midnight
    system.releaseTime(2);
    const path: number[] = [];
    for (let i = 0; i < 300; i++) {
      system.update(1 / 60);
      path.push(system.state.timeOfDay);
    }
    // A wrap-unaware ease runs the sun backwards through the entire day, which
    // shows up as the time passing through noon.
    expect(path.some((t) => t > 0.3 && t < 0.7)).toBe(false);
  });

  it('setTimeOfDay clears an active override', () => {
    const system = makeSystem(0.5);
    system.forceTimeOfDay(0.1);
    system.setTimeOfDay(0.6);
    expect(system.overrideState).toBe('none');
    expect(system.state.timeOfDay).toBeCloseTo(0.6, 9);
  });
});

describe('published lighting', () => {
  it('is measurably darker at night than at noon — the whole point', () => {
    const system = makeSystem(0.5);
    const sample = (t: number) => {
      system.setTimeOfDay(t);
      return {
        luminance: system.blend.luminance,
        exposure: system.lighting.exposure,
        // What actually reaches the tone mapper.
        net: system.blend.luminance * system.lighting.exposure,
      };
    };

    const noon = sample(0.5);
    const midnight = sample(0.0);

    expect(midnight.luminance).toBeLessThan(noon.luminance / 50);
    // Exposure lifts night, but nowhere near enough to cancel it.
    expect(midnight.exposure).toBeGreaterThan(noon.exposure);
    expect(midnight.net).toBeLessThan(noon.net * 0.06);
  });

  it('keeps exposure inside its authored band all cycle', () => {
    const system = makeSystem(0);
    for (let i = 0; i <= 2000; i++) {
      system.setTimeOfDay(i / 2000);
      expect(system.lighting.exposure).toBeGreaterThanOrEqual(EXPOSURE_MIN - 1e-9);
      expect(system.lighting.exposure).toBeLessThanOrEqual(EXPOSURE_MAX + 1e-9);
      expect(Number.isFinite(system.lighting.envMapIntensity)).toBe(true);
    }
  });

  it('turns street lights on at night and off in daylight', () => {
    const system = makeSystem(0.5);
    system.setTimeOfDay(0.5);
    expect(system.lighting.streetLightsOn).toBe(false);
    expect(system.derived.nightFactor).toBeLessThan(0.05);

    system.setTimeOfDay(0.0);
    expect(system.lighting.streetLightsOn).toBe(true);
    expect(system.derived.nightFactor).toBeGreaterThan(0.95);
    expect(system.derived.windowLitFraction).toBeGreaterThan(0.1);
  });

  it('lights more windows in the evening than in the small hours', () => {
    const system = makeSystem(0.5);
    system.setTimeOfDay(0.86); // ~20:40
    const evening = system.derived.windowLitFraction;
    system.setTimeOfDay(0.13); // ~03:00
    const smallHours = system.derived.windowLitFraction;
    expect(evening).toBeGreaterThan(smallHours * 1.5);
  });

  it('hands the key light to the moon at night and the sun by day', () => {
    const system = new DayNightSystem({
      startTimeOfDay: 0,
      lunarAgeDays: 14.765,
      measurements: parseEnvironmentMeasurements(MANIFEST),
    });
    expect(system.derived.moonIsKeyLight).toBe(true);
    // Key light comes from above at midnight with a full moon on the meridian.
    expect(system.lighting.sunDirection.y).toBeLessThan(0);
    expect(system.state.sunIntensity).toBe(0);
    expect(system.state.moonIntensity).toBeGreaterThan(0.5);

    system.setTimeOfDay(0.5);
    expect(system.derived.moonIsKeyLight).toBe(false);
    expect(system.state.sunIntensity).toBeGreaterThan(0.8);
    expect(system.state.moonIntensity).toBeLessThan(0.05);
  });

  it('tightens the shadow cascades at night', () => {
    const system = makeSystem(0.5);
    const day = system.lighting.shadowRadius;
    system.setTimeOfDay(0);
    expect(system.lighting.shadowRadius).toBeLessThan(day * 0.5);
  });

  it('thickens the fog at night', () => {
    const system = makeSystem(0.5);
    const day = system.lighting.fogDensity;
    system.setTimeOfDay(0);
    expect(system.lighting.fogDensity).toBeGreaterThan(day);
  });

  it('derives ambient colour from the sky rather than a constant', () => {
    const system = makeSystem(0.5);
    system.setTimeOfDay(0.5);
    const noon = system.lighting.ambientColor.getHex();
    system.setTimeOfDay(0.0);
    const midnight = system.lighting.ambientColor.getHex();
    expect(noon).not.toBe(midnight);
    // Night ambient is bluer than noon ambient.
    system.setTimeOfDay(0.0);
    const c = system.lighting.ambientColor;
    expect(c.b).toBeGreaterThan(c.r);
  });

  it('keeps the sun direction unit-length and pointing down while the sun is up', () => {
    const system = makeSystem(0.5);
    for (let i = 0; i <= 400; i++) {
      system.setTimeOfDay(i / 400);
      expect(system.lighting.sunDirection.length()).toBeCloseTo(1, 6);
      expect(system.state.sunDirection.length()).toBeCloseTo(1, 6);
    }
    system.setTimeOfDay(0.5);
    expect(system.lighting.sunDirection.y).toBeLessThan(-0.9);
  });

  it('lights the world even with no measurements at all', () => {
    const system = new DayNightSystem({ startTimeOfDay: 0.5 });
    expect(system.hasMeasuredEnvironment).toBe(false);
    expect(system.lighting.ambientIntensity).toBeGreaterThan(0);
    expect(system.lighting.sunIntensity).toBeGreaterThan(0);
    // ...and picks up measurements later without a restart.
    system.setMeasurements(parseEnvironmentMeasurements(MANIFEST));
    expect(system.hasMeasuredEnvironment).toBe(true);
  });

  it('produces no NaN anywhere in the cycle', () => {
    const system = makeSystem(0);
    for (let i = 0; i <= 1000; i++) {
      system.setTimeOfDay(i / 1000);
      const l = system.lighting;
      for (const value of [l.sunIntensity, l.ambientIntensity, l.exposure, l.envMapIntensity, l.fogDensity, l.shadowRadius]) {
        expect(Number.isFinite(value)).toBe(true);
      }
      for (const color of [l.sunColor, l.ambientColor, l.groundColor, l.fogColor]) {
        expect(Number.isFinite(color.r + color.g + color.b)).toBe(true);
        expect(color.r).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('is deterministic — same time, same state, every time', () => {
    const a = makeSystem(0.5);
    const b = makeSystem(0.5);
    for (const t of [0, 0.137, 0.42, 0.63, 0.81, 0.99]) {
      a.setTimeOfDay(t);
      b.setTimeOfDay(t);
      expect(a.lighting.exposure).toBe(b.lighting.exposure);
      expect(a.lighting.sunDirection.toArray()).toEqual(b.lighting.sunDirection.toArray());
      expect(a.lighting.ambientColor.getHex()).toBe(b.lighting.ambientColor.getHex());
    }
  });

  it('does not allocate new colour or vector objects per frame', () => {
    const system = makeSystem(0.5);
    const direction = system.lighting.sunDirection;
    const ambient = system.lighting.ambientColor;
    const spy = vi.spyOn(system.lighting.sunColor, 'copy');
    for (let i = 0; i < 200; i++) system.update(1 / 60);
    expect(system.lighting.sunDirection).toBe(direction);
    expect(system.lighting.ambientColor).toBe(ambient);
    expect(spy).toHaveBeenCalled();
  });
});
