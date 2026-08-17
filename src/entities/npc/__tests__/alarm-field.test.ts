/**
 * ALARM FIELD
 *
 * The claim under test is not "panic exists" but "panic ARRIVES": it starts at
 * the threat, moves outward at a bounded speed, has a finite range, and drains
 * once the threat is gone. Each of those is a separate failure mode with a
 * separate visible symptom, so each gets its own assertion.
 */

import { describe, it, expect } from 'vitest';
import { AlarmField } from '../alarm-field';
import {
  ALARM_GATE,
  ALARM_RISE,
  FIELD_CELL,
  FIELD_DIM,
  ALARM_HZ,
} from '../constants';
import { cellX, cellZ } from '../obstacles';
import { threatAt } from './fixtures';

/** Alarm sampled at a distance along +X from the origin. */
function alongX(field: AlarmField, metres: number): number {
  return field.sample(metres, 0);
}

describe('AlarmField', () => {
  it('starts empty and stays empty with no threats', () => {
    const field = new AlarmField();
    for (let i = 0; i < 20; i++) field.tick([]);
    expect(field.peakAlarm).toBe(0);
    expect(field.countAbove(0.001)).toBe(0);
  });

  it('seeds alarm at a threat position', () => {
    const field = new AlarmField();
    field.tick([threatAt(0, 0)]);
    expect(field.sample(0, 0)).toBeGreaterThan(0.5);
    expect(field.sample(400, 400)).toBe(0);
  });

  it('propagates outward rather than switching on inside a radius', () => {
    const field = new AlarmField();
    const threat = [threatAt(0, 0)];
    const near = 24;
    const far = 120;

    // Ten ticks (1 s): the near sample should be alarmed and the far one not
    // yet. A radius-based implementation would light both on the first tick.
    for (let i = 0; i < 10; i++) field.tick(threat);
    const nearEarly = alongX(field, near);
    const farEarly = alongX(field, far);
    expect(nearEarly).toBeGreaterThan(0.05);
    expect(farEarly).toBeLessThan(0.01);

    for (let i = 0; i < 40; i++) field.tick(threat);
    expect(alongX(field, far)).toBeGreaterThan(farEarly + 0.05);
  });

  it('advances its front at the speed the rate limit predicts', () => {
    const field = new AlarmField();
    const threat = [threatAt(0, 0)];
    const samples: number[] = [];
    // Sample the front every half second across the linear part of the
    // expansion, before it saturates against the transfer range.
    for (let step = 0; step < 8; step++) {
      for (let i = 0; i < ALARM_HZ / 2; i++) field.tick(threat);
      samples.push(field.frontRadius(0, 0, 0.15));
    }

    // Strictly outward.
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]!);
    }

    // A cell needs `gate / rise` seconds to become able to alarm the next one,
    // so the front covers one cell in that time. Measured over the middle of
    // the expansion, where neither the seed radius nor saturation dominates.
    const predicted = FIELD_CELL / (ALARM_GATE / ALARM_RISE);
    const measured = (samples[5]! - samples[1]!) / 2;
    expect(measured).toBeGreaterThan(predicted * 0.7);
    expect(measured).toBeLessThan(predicted * 1.5);
  });

  it('expands isotropically rather than as a rotated square', () => {
    const field = new AlarmField();
    const threat = [threatAt(0, 0)];
    for (let i = 0; i < 25; i++) field.tick(threat);

    // 60 m along an axis versus 60 m along the diagonal. A shared rate limit
    // for orthogonal and diagonal neighbours makes the diagonal run 41 % ahead.
    const axis = field.sample(60, 0);
    const diagonal = field.sample(42.4, 42.4);
    expect(axis).toBeGreaterThan(0.05);
    expect(Math.abs(axis - diagonal)).toBeLessThan(axis * 0.25);
  });

  it('has a finite range set by the transfer factor', () => {
    const field = new AlarmField();
    const threat = [threatAt(0, 0)];
    for (let i = 0; i < 200; i++) field.tick(threat);
    const saturated = field.frontRadius(0, 0, 0.15);
    expect(saturated).toBeGreaterThan(100);
    expect(saturated).toBeLessThan(300);
    // Far corner of the world never hears about it.
    expect(field.sample(700, 700)).toBeLessThan(0.01);
  });

  it('drains once the threat is gone', () => {
    const field = new AlarmField();
    const threat = [threatAt(0, 0)];
    for (let i = 0; i < 40; i++) field.tick(threat);
    const peak = field.peakAlarm;
    expect(peak).toBeGreaterThan(0.5);
    for (let i = 0; i < 60; i++) field.tick([]);
    expect(field.peakAlarm).toBeLessThan(peak * 0.05);
  });

  it('sustains an impulse across several ticks rather than one', () => {
    const field = new AlarmField();
    field.addImpulse(0, 0, 1, 40);
    expect(field.impulseCount).toBe(1);
    field.tick([]);
    const first = field.sample(0, 0);
    field.tick([]);
    expect(field.sample(30, 0)).toBeGreaterThan(0);
    expect(first).toBeGreaterThan(0.5);
    // Expires on its own.
    for (let i = 0; i < 30; i++) field.tick([]);
    expect(field.impulseCount).toBe(0);
  });

  it('is deterministic and frame-rate independent in its internal ticks', () => {
    const a = new AlarmField();
    const b = new AlarmField();
    const threat = [threatAt(24, -36)];
    // One drives with 60 Hz frames, the other with irregular ones. The field
    // ticks internally at a fixed rate, so both must land on the same state
    // after the same elapsed time.
    // The target is deliberately 2.05 s, not 2.0: at exactly a tick boundary
    // the two accumulators differ in the last bit and one fires a tick the
    // other does not. That is a property of any fixed-step accumulator and not
    // worth engineering away — what matters is that the same elapsed time
    // produces the same simulation, which it does everywhere except on the
    // knife edge.
    const target = 2.05;
    let ea = 0;
    while (ea < target) {
      a.update(1 / 60, threat);
      ea += 1 / 60;
    }
    let elapsed = 0;
    const steps = [1 / 30, 1 / 90, 1 / 45, 1 / 120];
    let k = 0;
    while (elapsed < target) {
      const dt = steps[k++ % steps.length]!;
      b.update(dt, threat);
      elapsed += dt;
    }
    expect(a.tickCount).toBe(b.tickCount);
    expect(a.hash()).toBe(b.hash());
  });

  it('produces the same field from the same seed twice', () => {
    const build = (): number => {
      const field = new AlarmField();
      field.addImpulse(12, 8, 0.8, 50);
      for (let i = 0; i < 30; i++) field.tick([threatAt(-40, 20)]);
      return field.hash();
    };
    expect(build()).toBe(build());
  });

  it('clamps its grid lookups at the world edge', () => {
    const field = new AlarmField();
    expect(cellX(-99999)).toBe(0);
    expect(cellX(99999)).toBe(FIELD_DIM - 1);
    expect(cellZ(-99999)).toBe(0);
    expect(() => field.sample(1e9, -1e9)).not.toThrow();
  });
});
