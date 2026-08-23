/**
 * THE TWO TIMELINES, PINNED
 *
 * `GameClock` is the only source of truth for game time, consumed by every
 * system each frame and by `ImpactFreeze`. Its header names the exact bug it
 * exists to prevent: "Mixing them up is how a '90ms' hit-stop becomes a
 * 2.25-second one at timeScale 0.04."
 *
 *   delta / elapsed             — SCALED. What simulation consumes.
 *   rawDelta / unscaledElapsed  — REAL. What UI animation, profiling and any
 *                                 wall-clock effect must consume.
 *
 * It takes an injectable clock explicitly "for tests" and had none. Sixty lines
 * of pure arithmetic with four distinct behaviours — first-tick nominal charge,
 * the `maxDelta` clamp, the scaled/unscaled split, and the fixed-step
 * accumulator — none of which any other test in the repo touches.
 */

import { describe, expect, it } from 'vitest';
import { GameClock } from '../game-clock';

/** A clock on a hand-cranked millisecond timeline. */
function harness(options: { maxDelta?: number; fixedStep?: number } = {}): {
  clock: GameClock;
  set: (ms: number) => void;
  advance: (ms: number) => void;
} {
  let t = 0;
  const clock = new GameClock({ ...options, now: () => t });
  return {
    clock,
    set: (ms: number): void => {
      t = ms;
    },
    advance: (ms: number): void => {
      t += ms;
    },
  };
}

describe('GameClock wall-clock handling', () => {
  it('charges one nominal frame on the first tick, not the load time', () => {
    const { clock, set } = harness();
    set(5000);

    clock.tick();

    // Five seconds of asset loading must not become five seconds of simulation.
    expect(clock.rawDelta).toBe(clock.fixedStep);
    expect(clock.unscaledElapsed).toBe(clock.fixedStep);
  });

  it('does the same after resync(), the returning-from-background path', () => {
    const { clock, advance } = harness();
    clock.tick();
    advance(16);
    clock.tick();

    clock.resync();
    advance(30_000);
    clock.tick();

    expect(clock.rawDelta).toBe(clock.fixedStep);
  });

  it('advances by the real gap once running', () => {
    const { clock, advance } = harness();
    clock.tick();
    advance(20);
    clock.tick();

    expect(clock.rawDelta).toBeCloseTo(0.02, 6);
    expect(clock.delta).toBe(clock.rawDelta);
    expect(clock.frameCount).toBe(2);
  });

  it('clamps a hitch to maxDelta so the simulation cannot teleport', () => {
    const { clock, advance } = harness();
    clock.tick();
    const before = clock.unscaledElapsed;

    advance(5000);
    clock.tick();

    expect(clock.rawDelta).toBe(1 / 15);
    expect(clock.unscaledElapsed - before).toBe(1 / 15);
  });

  it('never produces a negative delta from a backwards clock', () => {
    const { clock, set } = harness();
    set(1000);
    clock.tick();
    set(500);
    clock.tick();

    expect(clock.rawDelta).toBe(0);
    expect(clock.delta).toBe(0);
  });
});

describe('GameClock scaled vs unscaled time', () => {
  it('keeps the two timelines apart at hit-stop time scales', () => {
    const { clock, advance } = harness();
    clock.timeScale = 0.04;

    for (let i = 0; i < 10; i++) {
      if (i > 0) advance(1000 / 60);
      clock.tick();
    }

    // Ten frames of real time...
    expect(clock.unscaledElapsed).toBeCloseTo(10 / 60, 6);
    // ...are four hundredths of that in game time. Reading `elapsed` where
    // `unscaledElapsed` belongs is what turns a 90ms hit-stop into 2.25s.
    expect(clock.elapsed).toBeCloseTo(0.04 * (10 / 60), 6);
  });

  it('freezes game time at timeScale 0 while wall time keeps running', () => {
    const { clock, advance } = harness();
    clock.tick();
    const frozenAt = clock.elapsed;
    clock.timeScale = 0;

    for (let i = 0; i < 5; i++) {
      advance(16);
      clock.tick();
    }

    expect(clock.delta).toBe(0);
    expect(clock.fixedStepCount).toBe(0);
    expect(clock.elapsed).toBe(frozenAt);
    expect(clock.unscaledElapsed).toBeGreaterThan(frozenAt);
  });
});

describe('GameClock fixed-step accumulator', () => {
  it('runs one step per fixed-step of scaled time', () => {
    const { clock, advance } = harness();

    // The priming tick charges exactly one fixedStep.
    clock.tick();
    expect(clock.fixedStepCount).toBe(1);
    expect(clock.fixedAlpha).toBeCloseTo(0, 5);

    advance(1000 / 30);
    clock.tick();
    expect(clock.fixedStepCount).toBe(2);

    const second = harness();
    second.clock.tick();
    second.advance(1000 / 15);
    second.clock.tick();
    expect(second.clock.fixedStepCount).toBe(4);
  });

  it('carries the remainder between frames instead of discarding it', () => {
    const { clock, advance } = harness();
    clock.tick();

    // 10ms frames against a 16.667ms step. A clock that threw the remainder
    // away at the end of each frame would run ZERO steps here, forever.
    const observed: Array<[number, number]> = [];
    for (let i = 0; i < 4; i++) {
      advance(10);
      clock.tick();
      observed.push([clock.fixedStepCount, clock.fixedAlpha]);
    }

    expect(observed.map(([steps]) => steps)).toEqual([0, 1, 0, 1]);
    for (const [, alpha] of observed) {
      expect(alpha).toBeGreaterThanOrEqual(0);
      expect(alpha).toBeLessThan(1);
    }
    expect(observed[0]![1]).toBeCloseTo(0.6, 6);
    expect(observed[1]![1]).toBeCloseTo(0.2, 6);
    expect(observed[2]![1]).toBeCloseTo(0.8, 6);
    expect(observed[3]![1]).toBeCloseTo(0.4, 6);
  });

  it('accumulates SCALED time, so slow motion also slows physics', () => {
    const { clock, advance } = harness();
    clock.tick();
    clock.timeScale = 0.5;

    advance(1000 / 30);
    clock.tick();

    // A 1/30s frame is two fixed steps at full speed and one at half.
    expect(clock.fixedStepCount).toBe(1);
  });

  it('caps sub-steps and drops the remainder, so a hitch cannot spiral', () => {
    const { clock, advance } = harness({ fixedStep: 1 / 1000, maxDelta: 1 / 15 });
    clock.tick();

    advance(5000);
    clock.tick();

    // 1/15s at a 1ms step is 66 steps; the guard stops at 8 and zeroes the
    // accumulator rather than carrying 58 steps of debt into the next frame.
    expect(clock.fixedStepCount).toBe(8);
    expect(clock.fixedAlpha).toBe(0);
  });
});

describe('GameClock reset', () => {
  it('zeroes every counter but keeps timeScale', () => {
    const { clock, advance } = harness();
    clock.timeScale = 0.25;
    for (let i = 0; i < 4; i++) {
      advance(16);
      clock.tick();
    }

    clock.reset();

    expect(clock.elapsed).toBe(0);
    expect(clock.unscaledElapsed).toBe(0);
    expect(clock.frameCount).toBe(0);
    expect(clock.fixedStepCount).toBe(0);
    expect(clock.fixedAlpha).toBe(0);
    expect(clock.rawDelta).toBe(0);
    expect(clock.delta).toBe(0);
    expect(clock.timeScale).toBe(0.25);

    // And the clock is unstarted again, so the next tick charges one frame.
    advance(9000);
    clock.tick();
    expect(clock.rawDelta).toBe(clock.fixedStep);
  });
});
