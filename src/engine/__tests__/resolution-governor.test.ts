/**
 * THE GOVERNOR'S REPORTED MEDIAN MUST BE THE MEDIAN IT ACTUALLY HAS
 *
 * `medianFrameMs` is not decoration: it is the number the debug HUD shows and
 * the number the verification harness reads to decide whether the frame budget
 * is being met. It used to be computed only on the far side of the hysteresis
 * check, so for the whole dwell window — and for the first second after every
 * resize, including the orientation change a mobile session starts with — it
 * read `0`, i.e. "infinite headroom", which is the most misleading value it
 * could possibly have reported.
 *
 * The decision is still gated on the dwell timer. Only the MEASUREMENT moved.
 */

import { describe, expect, it, vi } from 'vitest';
import { ResolutionGovernor, type IResolutionGovernorOptions } from '../resolution-governor';

/**
 * A governor on a hand-cranked clock.
 *
 * `snap()` returns float-drifted values (`19 * 0.05 === 0.9500000000000001`), so
 * EVERY scale assertion below uses `toBeCloseTo(x, 10)` and never `toBe`.
 */
function harness(options: IResolutionGovernorOptions = {}): {
  governor: ResolutionGovernor;
  advance: (ms: number) => void;
} {
  let t = 0;
  const governor = new ResolutionGovernor({ now: () => t, ...options });
  return {
    governor,
    advance: (ms: number): void => {
      t += ms;
    },
  };
}

/** Feed `count` identical frames. */
function fill(governor: ResolutionGovernor, frameMs: number, count: number): boolean {
  let changed = false;
  for (let i = 0; i < count; i++) changed = governor.sample(frameMs) || changed;
  return changed;
}

/** A governor on a hand-cranked clock, with a short window for readability. */
function makeGovernor(): { governor: ResolutionGovernor; setClock: (ms: number) => void } {
  let clock = 0;
  const governor = new ResolutionGovernor({
    targetFps: 60,
    sampleCount: 4,
    hysteresisMs: 500,
    minScale: 0.6,
    maxScale: 1,
    now: () => clock,
  });
  return {
    governor,
    setClock: (ms: number): void => {
      clock = ms;
    },
  };
}

describe('ResolutionGovernor median reporting', () => {
  it('reports the median as soon as the window fills, before the dwell timer expires', () => {
    const { governor } = makeGovernor();

    for (const ms of [10, 12, 14, 16]) governor.sample(ms);

    // The dwell timer has not expired, so nothing may change the scale...
    expect(governor.scale).toBe(1);
    // ...but the reading the HUD and the harness consume must be real.
    expect(governor.medianFrameMs).toBe(13);
    expect(governor.getState().medianFrameMs).toBe(13);
  });

  it('keeps the median current through the dwell window after a scale change', () => {
    const { governor, setClock } = makeGovernor();

    setClock(600);
    for (const ms of [40, 40, 40, 40]) governor.sample(ms);
    expect(governor.scale).toBeCloseTo(0.95);
    expect(governor.medianFrameMs).toBe(40);

    // The scale change cleared the window. Refill it while still dwelling: the
    // scale must hold, and the median must track the frames just measured.
    for (const ms of [30, 30, 30, 30]) governor.sample(ms);
    expect(governor.scale).toBeCloseTo(0.95);
    expect(governor.medianFrameMs).toBe(30);
  });

  it('still reports nothing before the window is full', () => {
    const { governor } = makeGovernor();
    governor.sample(12);
    governor.sample(12);
    expect(governor.medianFrameMs).toBe(0);
  });
});

/*
 * ── THE DECISION LOOP ──────────────────────────────────────────────────────
 *
 * Every documented behaviour of this class is a SILENT-failure mode: a governor
 * that has stopped scaling looks exactly like a game that is merely slow. None
 * of it was covered, despite the injectable clock existing "for deterministic
 * tests".
 */
describe('ResolutionGovernor decision loop', () => {
  it('decides nothing until the window is full', () => {
    const { governor } = harness({ sampleCount: 4, hysteresisMs: 0 });

    for (let i = 1; i <= 3; i++) {
      expect(governor.sample(100)).toBe(false);
      expect(governor.scale).toBeCloseTo(1, 10);
      expect(governor.getState().samples).toBe(i);
    }

    // Budget 16.667ms, downTrigger 1.15 -> anything over 19.2ms scales down.
    expect(governor.sample(100)).toBe(true);
    expect(governor.scale).toBeCloseTo(0.95, 10);
  });

  it('clears the window on a change, so the old scale cannot drive the next one', () => {
    const { governor } = harness({ sampleCount: 4, hysteresisMs: 0 });
    fill(governor, 100, 4);
    expect(governor.scale).toBeCloseTo(0.95, 10);
    expect(governor.getState().samples).toBe(0);
  });

  it('takes the MEDIAN, so one spike cannot move the scale', () => {
    const { governor } = harness({ sampleCount: 5, hysteresisMs: 0 });
    governor.setScale(0.8);

    // Median 8ms (headroom, scale up); MEAN 86.4ms (would scale down). The
    // direction is the whole "why median, not mean" claim in the header.
    for (const ms of [8, 8, 8, 8, 400]) governor.sample(ms);

    expect(governor.medianFrameMs).toBe(8);
    expect(governor.scale).toBeGreaterThan(0.8);
    expect(governor.scale).toBeCloseTo(0.85, 10);
  });

  it('blocks a second change inside the dwell window', () => {
    const { governor, advance } = harness({ sampleCount: 4, hysteresisMs: 500 });

    // The dwell timer starts at construction, so the first decision needs it to
    // expire too.
    advance(600);
    expect(fill(governor, 100, 4)).toBe(true);
    expect(governor.scale).toBeCloseTo(0.95, 10);

    // Still dwelling: the window fills, but nothing may change.
    expect(fill(governor, 100, 4)).toBe(false);
    expect(governor.getState().samples).toBe(4);
    expect(governor.scale).toBeCloseTo(0.95, 10);

    advance(600);
    expect(fill(governor, 100, 4)).toBe(true);
    expect(governor.scale).toBeCloseTo(0.9, 10);
  });

  it('records but never scales while disabled, and still reports the median', () => {
    const { governor } = harness({ sampleCount: 4, hysteresisMs: 0 });
    governor.enabled = false;

    expect(fill(governor, 100, 4)).toBe(false);
    expect(governor.scale).toBeCloseTo(1, 10);
    // Written before the enabled check on purpose: the debug HUD depends on it.
    expect(governor.medianFrameMs).toBe(100);
  });

  it('rejects the pathological deltas a backgrounded tab produces', () => {
    const { governor } = harness({ sampleCount: 4, hysteresisMs: 0 });

    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 2001]) {
      expect(governor.sample(bad)).toBe(false);
      expect(governor.getState().samples).toBe(0);
    }

    expect(governor.sample(2000)).toBe(false);
    expect(governor.getState().samples).toBe(1);
  });

  it('walks to the floor in the documented number of steps and stops there', () => {
    const { governor, advance } = harness({ hysteresisMs: 500 });

    // Defaults: min 0.6, max 1.0, step 0.05 -> eight changes to the floor.
    for (let i = 0; i < 8; i++) {
      advance(600);
      expect(fill(governor, 100, 30)).toBe(true);
    }

    expect(governor.scale).toBeCloseTo(0.6, 10);
    expect(governor.getState().changes).toBe(8);

    advance(600);
    expect(fill(governor, 100, 30)).toBe(false);
    expect(governor.scale).toBeCloseTo(0.6, 10);
    expect(governor.getState().changes).toBe(8);
  });

  it('reset() clears the window, the median and the dwell timer', () => {
    const { governor, advance } = harness({ sampleCount: 4, hysteresisMs: 500 });
    advance(600);
    fill(governor, 100, 4);

    governor.reset(0.8);

    const state = governor.getState();
    expect(state.samples).toBe(0);
    expect(state.medianFrameMs).toBe(0);
    expect(state.msSinceChange).toBe(0);
    expect(governor.scale).toBeCloseTo(0.8, 10);
  });

  it('setScaleRange re-clamps immediately and notifies exactly once', () => {
    const onScaleChanged = vi.fn();
    const { governor } = harness({ onScaleChanged });
    governor.setScale(0.6);
    onScaleChanged.mockClear();

    governor.setScaleRange(0.8, 1);

    expect(governor.scale).toBeCloseTo(0.8, 10);
    expect(onScaleChanged).toHaveBeenCalledTimes(1);
    expect(onScaleChanged.mock.calls[0]?.[0]).toBeCloseTo(0.8, 10);
  });

  it('setScaleRange sorts its arguments', () => {
    const { governor } = harness();
    governor.setScale(0.6);
    governor.setScaleRange(1, 0.8);
    expect(governor.scale).toBeCloseTo(0.8, 10);
  });

  it('setScale snaps to the step grid and is a no-op when nothing moves', () => {
    const onScaleChanged = vi.fn();
    const { governor } = harness({ onScaleChanged });

    governor.setScale(0.83);
    expect(governor.scale).toBeCloseTo(0.85, 10);
    expect(onScaleChanged).toHaveBeenCalledTimes(1);
    const changes = governor.getState().changes;

    governor.setScale(0.85);
    expect(onScaleChanged).toHaveBeenCalledTimes(1);
    expect(governor.getState().changes).toBe(changes);
  });

  it('setTargetFps moves the budget, and with it the decision', () => {
    const at60 = harness({ sampleCount: 4, hysteresisMs: 0 });
    expect(at60.governor.budget).toBeCloseTo(16.667, 3);
    at60.governor.setScale(0.8);
    fill(at60.governor, 25, 4);
    // 25ms > 16.667 * 1.15: over budget at 60fps.
    expect(at60.governor.scale).toBeLessThan(0.8);

    const at30 = harness({ sampleCount: 4, hysteresisMs: 0 });
    at30.governor.setTargetFps(30);
    expect(at30.governor.budget).toBeCloseTo(33.333, 3);
    at30.governor.setScale(0.8);
    fill(at30.governor, 25, 4);
    // 25ms < 33.333 * 1.15: the same frames are now comfortably inside budget.
    expect(at30.governor.scale).toBeGreaterThanOrEqual(0.8);
  });

  it('averages the two middle samples on an even window', () => {
    const { governor } = harness({ sampleCount: 4, hysteresisMs: 0 });
    governor.enabled = false;
    for (const ms of [10, 20, 30, 40]) governor.sample(ms);
    expect(governor.medianFrameMs).toBe(25);
  });
});

/*
 * ── snap() MUST HONOUR THE RANGE IT ADVERTISES ─────────────────────────────
 *
 * Rounding to the step grid AFTER clamping can move the value back outside the
 * range whenever the bounds are not multiples of `step`. `snap()` is the only
 * writer of `currentScale`, so the class's advertised invariant — "Current
 * drawing-buffer multiplier in [minScale, maxScale]" — was not enforced.
 *
 * Every shipping profile uses min 0.6 / max 1.0 / step 0.05, all exact
 * multiples, so this was latent; the second clamp is bit-identical there.
 */
describe('ResolutionGovernor scale bounds', () => {
  const ODD = { minScale: 0.62, maxScale: 0.97, step: 0.1 } as const;

  it('never returns a scale below minScale when the floor is off-grid', () => {
    const { governor } = harness(ODD);
    governor.setScale(0.62);
    expect(governor.scale).toBeGreaterThanOrEqual(0.62);
  });

  it('never returns a scale above maxScale when the ceiling is off-grid', () => {
    const { governor } = harness(ODD);
    governor.setScale(1.5);
    expect(governor.scale).toBeLessThanOrEqual(0.97);
  });

  it('clamps reset() to the off-grid floor', () => {
    const { governor } = harness(ODD);
    governor.reset(0.5);
    expect(governor.scale).toBeGreaterThanOrEqual(0.62);
  });

  it('stops at the off-grid floor when driven down by real load', () => {
    const { governor, advance } = harness({ ...ODD, sampleCount: 4, hysteresisMs: 500 });

    for (let i = 0; i < 10; i++) {
      advance(600);
      fill(governor, 100, 4);
      expect(governor.scale).toBeGreaterThanOrEqual(0.62);
    }

    expect(governor.scale).toBeCloseTo(0.62, 10);
  });

  it('leaves the shipping configuration bit-identical', () => {
    const { governor } = harness();
    governor.setScale(0.83);
    expect(governor.scale).toBeCloseTo(0.85, 10);
    governor.setScale(0.1);
    expect(governor.scale).toBeCloseTo(0.6, 10);
    governor.setScale(9);
    expect(governor.scale).toBeCloseTo(1.0, 10);
  });
});
