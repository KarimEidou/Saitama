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

import { describe, expect, it } from 'vitest';
import { ResolutionGovernor } from '../resolution-governor';

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
