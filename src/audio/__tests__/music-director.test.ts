/**
 * MUSIC DIRECTOR — the bar grid, the queued-transition state machine, and the
 * lazily-built instrument palette.
 *
 * `director.test.ts` drives the same object the way the FRAME LOOP does, over a
 * moving clock, and asserts what a lookahead scheduler does with a clock:
 * catch-up after a pause, the lookahead window, a hard cut. This file asserts
 * the other half — the arrangement itself. How many notes a bar contains, where
 * the fill lands, when a queued change is allowed to take effect, and what gets
 * CONSTRUCTED — driven with a stationary clock and whole-horizon `advanceTo`
 * calls, which is exactly how the offline probes drive it.
 *
 * Nothing about the DSP is asserted here, so this is not "a mock testing a
 * mock": the fake context exists only so the instrument graph can be built at
 * all in Node. Every number below comes from the director's own `onNote`
 * observer and its public getters.
 */

import { describe, expect, it } from 'vitest';
import { MusicDirector, type IScheduledNote } from '../music/director';
import { LAYERS, secondsPerStep, STEPS_PER_BAR } from '../music/patterns';
import { fakeContext, fakeDestination } from './fake-context';

/** Seconds per step of the `calm` layer, which every case starts in. */
const STEP = secondsPerStep(LAYERS.calm.bpm);

/**
 * A horizon `bars` bars after `start`, landing in the MIDDLE of a step.
 *
 * `nextStepTime` is accumulated by repeated `+=`, so a horizon sitting exactly
 * on a step boundary is a float coin-flip over whether that step is scheduled.
 * Every horizon in this file is half a step short of one.
 */
function horizon(bars: number): number {
  return bars * STEPS_PER_BAR * STEP - STEP / 2;
}

/** Sources the director's palette actually costs, counted as they are built. */
interface INodeCounts {
  oscillator: number;
  bufferSource: number;
}

interface Rig {
  d: MusicDirector;
  notes: IScheduledNote[];
  created: INodeCounts;
}

function rig(seed = 1234): Rig {
  const ctx = fakeContext();
  const created: INodeCounts = { oscillator: 0, bufferSource: 0 };
  const makeOscillator = ctx.createOscillator.bind(ctx);
  const makeBufferSource = ctx.createBufferSource.bind(ctx);
  ctx.createOscillator = (): OscillatorNode => {
    created.oscillator++;
    return makeOscillator();
  };
  ctx.createBufferSource = (): AudioBufferSourceNode => {
    created.bufferSource++;
    return makeBufferSource();
  };
  const notes: IScheduledNote[] = [];
  const d = new MusicDirector(ctx, fakeDestination(), {
    seed,
    onNote: (note) => notes.push(note),
  });
  return { d, notes, created };
}

/** The `calm` bar: pad on steps 0 and 8, pluck on 2, 7, 11 and 14. */
const CALM_NOTES_PER_BAR = 6;
/** The pluck's fill has five hits where its normal pattern has four. */
const CALM_NOTES_PER_FILL_BAR = 7;

describe('music director grid', () => {
  it('schedules nothing before start', () => {
    const r = rig();
    expect(r.d.advanceTo(10)).toBe(0);
    expect(r.notes).toHaveLength(0);
    expect(r.d.isRunning).toBe(false);
    expect(r.d.step).toBe(0);
  });

  it('schedules exactly one bar of the calm arrangement', () => {
    const r = rig();
    r.d.start(0);
    expect(r.d.advanceTo(horizon(1))).toBe(CALM_NOTES_PER_BAR);
    expect(r.d.step).toBe(STEPS_PER_BAR);
    expect(r.d.bar).toBe(1);
    expect(r.d.noteCount).toBe(CALM_NOTES_PER_BAR);

    for (const note of r.notes) {
      // `IScheduledNote.step` is the step WITHIN its bar (0..15), not the
      // absolute counter `MusicDirector.step` reports.
      expect(note.time).toBeCloseTo((note.bar * STEPS_PER_BAR + note.step) * STEP, 9);
      expect(note.velocity).toBeGreaterThan(0);
      expect(note.velocity).toBeLessThanOrEqual(1);
    }
    expect(r.notes.filter((n) => n.part === 'pad').map((n) => n.step)).toEqual([0, 8]);
    expect(r.notes.filter((n) => n.part === 'pluck').map((n) => n.step)).toEqual([2, 7, 11, 14]);
  });

  it('is idempotent for a horizon it has already covered', () => {
    const r = rig();
    r.d.start(0);
    r.d.advanceTo(horizon(1));
    expect(r.d.advanceTo(horizon(1))).toBe(0);
    expect(r.notes).toHaveLength(CALM_NOTES_PER_BAR);
  });

  it('takes the fill pattern on the last bar of a four-bar phrase', () => {
    const r = rig();
    r.d.start(0);
    r.d.advanceTo(horizon(4));
    const perBar = [0, 1, 2, 3].map((bar) => r.notes.filter((n) => n.bar === bar).length);
    expect(perBar).toEqual([
      CALM_NOTES_PER_BAR,
      CALM_NOTES_PER_BAR,
      CALM_NOTES_PER_BAR,
      CALM_NOTES_PER_FILL_BAR,
    ]);
    // The extra note is the pluck's, and it is a different pattern rather than
    // the same one with a hit added.
    expect(r.notes.filter((n) => n.bar === 3 && n.part === 'pluck').map((n) => n.step)).toEqual([
      2, 6, 9, 12, 14,
    ]);
  });
});

describe('music director transitions', () => {
  it('applies a queued state change on the bar line, not mid-bar', () => {
    const r = rig();
    r.d.start(0);
    r.d.advanceTo(horizon(0.5));
    r.d.setState('combat');
    expect(r.d.state).toBe('calm');
    expect(r.d.pending).toBe('combat');

    // Schedule the REST of the bar with the change already queued. This is the
    // half that matters: a director that applied the queue on every step would
    // escalate here, four steps early.
    r.d.advanceTo(horizon(0.75));
    expect(r.d.state).toBe('calm');
    expect(r.d.pending).toBe('combat');
    expect(r.d.bpm).toBe(LAYERS.calm.bpm);
    expect(r.d.bar).toBe(0);
    expect(new Set(r.notes.map((n) => n.part))).toEqual(new Set(['pad', 'pluck']));

    // Just past the bar line: the change lands on step 16 and nowhere else.
    r.d.advanceTo(STEPS_PER_BAR * STEP + STEP / 2);
    expect(r.d.state).toBe('combat');
    expect(r.d.pending).toBeUndefined();
    expect(r.d.bpm).toBe(LAYERS.combat.bpm);
    // Nothing from the new layer sounded in the old bar...
    expect(r.notes.filter((n) => n.bar === 0).map((n) => n.instrument)).not.toContain('kick');
    // ...and the new layer is playing in the new one.
    const bar1 = r.notes.filter((n) => n.bar === 1);
    expect(bar1.length).toBeGreaterThan(0);
    expect(bar1.map((n) => n.instrument)).toContain('kick');
  });

  it('cancels a pending change when the current state is re-requested', () => {
    const r = rig();
    r.d.start(0);
    r.d.setState('combat');
    expect(r.d.pending).toBe('combat');
    r.d.setState('calm');
    expect(r.d.pending).toBeUndefined();
    expect(r.d.state).toBe('calm');
  });

  it('thins the arrangement for boredom on a bar line', () => {
    const r = rig();
    r.d.start(0);
    r.d.advanceTo(horizon(0.5));
    r.d.setBoredom(0.6);
    // Scheduling the rest of the bar must not lose a part halfway through it.
    r.d.advanceTo(horizon(0.75));
    expect(r.d.parts).toEqual(['pad', 'pluck']);
    expect(r.d.boredom).toBe(0);
    r.d.advanceTo(horizon(2));
    expect(r.d.parts).toEqual(['pad']);
    expect(r.d.boredom).toBe(0.6);
  });

  it('collapses the arrangement to the drone at the top of the meter', () => {
    // Parts only: the collapse also swaps root, scale and tempo to the BORED
    // layer, and those numbers are asserted in `director.test.ts`.
    const r = rig();
    r.d.start(0);
    r.d.advanceTo(horizon(0.5));
    r.d.setBoredom(0.9);
    r.d.advanceTo(horizon(0.75));
    expect(r.d.parts).toEqual(['pad', 'pluck']);
    r.d.advanceTo(horizon(2));
    expect(r.d.parts).toEqual(['drone']);
  });
});

describe('music director transport', () => {
  it('does not restart the transport when start is called twice', () => {
    const r = rig();
    r.d.start(0);
    r.d.advanceTo(horizon(1));
    r.d.start(0);
    expect(r.d.step).toBe(STEPS_PER_BAR);
    expect(r.d.noteCount).toBe(CALM_NOTES_PER_BAR);
    expect(r.d.advanceTo(horizon(1))).toBe(0);
  });

  it('halts scheduling on stop', () => {
    const r = rig();
    r.d.start(0);
    r.d.advanceTo(horizon(1));
    r.d.stop(0, 0.01);
    expect(r.d.isRunning).toBe(false);
    expect(r.d.advanceTo(horizon(8))).toBe(0);
    expect(r.notes).toHaveLength(CALM_NOTES_PER_BAR);
  });

  it('stops the transport when disposed', () => {
    // A disposed director used to keep reporting `isRunning`, and its
    // `advanceTo` kept walking the loop and writing automation onto nodes that
    // had already been stopped and disconnected. `MusicDirector` is public API
    // and the audition harness reads `audio.music.isRunning` directly, so the
    // lie was observable.
    const r = rig();
    r.d.start(0);
    r.d.advanceTo(horizon(1));
    r.d.dispose();
    expect(r.d.isRunning).toBe(false);
    expect(r.d.advanceTo(60)).toBe(0);
    expect(r.notes).toHaveLength(CALM_NOTES_PER_BAR);
  });

  it('is deterministic for a seed, and humanises differently for another', () => {
    const grid = (n: IScheduledNote): readonly number[] => [n.time, n.midi];
    const runs = [rig(99), rig(99), rig(1234)];
    for (const r of runs) {
      r.d.start(0);
      r.d.advanceTo(horizon(4));
    }
    const [a, b, c] = runs as [Rig, Rig, Rig];
    expect(a.notes.length).toBeGreaterThan(20);
    expect(b.notes).toEqual(a.notes);
    // A different seed moves the humanised velocities and NOTHING else: the
    // grid and the pitches are fixed by the score.
    expect(c.notes.map(grid)).toEqual(a.notes.map(grid));
    expect(c.notes.map((n) => n.velocity)).not.toEqual(a.notes.map((n) => n.velocity));
  });
});

describe('music director instrument palette', () => {
  it('builds no instrument until a note needs one', () => {
    const r = rig();
    // Constructing the director must cost nothing: `AudioSystem` builds it
    // before `unlock()`, whether or not music ever plays.
    expect(r.created.oscillator).toBe(0);
    expect(r.created.bufferSource).toBe(0);

    r.d.start(0);
    r.d.advanceTo(horizon(1));
    // The calm layer is a pad and a pluck — oscillators only, and no drum, hat
    // or snare, so not one noise reader is allocated.
    expect(r.created.oscillator).toBeGreaterThan(0);
    expect(r.created.bufferSource).toBe(0);
  });

  it('builds the drums only once a layer that plays them arrives', () => {
    const r = rig();
    r.d.start(0);
    r.d.advanceTo(horizon(1));
    const calmOscillators = r.created.oscillator;

    r.d.setState('combat');
    r.d.advanceTo(STEPS_PER_BAR * STEP + STEP / 2);
    expect(r.created.oscillator).toBeGreaterThan(calmOscillators);
    expect(r.created.bufferSource).toBeGreaterThan(0);
  });

  it('does not build an instrument in order to silence it', () => {
    const r = rig();
    // A hard cut silences the whole palette, and `refreshParts` silences
    // whatever dropped out of the arrangement. Neither may construct the graph
    // it is silencing — that would build the entire palette on the first
    // escalation, which is the cost this is here to avoid.
    r.d.setStateImmediate('boss');
    expect(r.d.state).toBe('boss');
    expect(r.created.oscillator).toBe(0);
    expect(r.created.bufferSource).toBe(0);
  });
});
