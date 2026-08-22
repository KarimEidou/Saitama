/**
 * MUSIC TRANSPORT
 *
 * `MusicDirector` is a lookahead scheduler, and everything interesting about a
 * lookahead scheduler is a function of the CLOCK: how it behaves when the frame
 * loop stops calling it, what it writes at a bar line that is still in the
 * future, where the grid restarts after a hard cut. The offline probes cannot
 * see any of that — an `OfflineAudioContext` pins `currentTime` at 0 for the
 * whole scheduling pass, and every probe calls `advanceTo(seconds)` exactly
 * once for the entire render.
 *
 * These tests drive the director the way the frame loop does, over a fake
 * context whose `currentTime` the test moves by hand.
 */

import { describe, expect, it } from 'vitest';
import { MusicDirector, type IScheduledNote } from '../music/director';
import { CrowdBedVoice } from '../voices/crowd';
import { Mixer } from '../mixer';
import { BOREDOM_COLLAPSE, LAYERS, secondsPerStep } from '../music/patterns';
import { fakeContext, fakeDestination } from './fake-context';

/** The audio system's own lookahead, mirrored here. */
const LOOKAHEAD = 0.25;

interface Rig {
  ctx: BaseAudioContext & { currentTime: number };
  director: MusicDirector;
  notes: IScheduledNote[];
  /** Advance the clock by `dt` and fill the lookahead, as `update()` does. */
  frame: (dt: number) => void;
}

function rig(): Rig {
  const ctx = fakeContext();
  const notes: IScheduledNote[] = [];
  const director = new MusicDirector(ctx, fakeDestination(), {
    seed: 1234,
    onNote: (note) => notes.push(note),
  });
  const frame = (dt: number): void => {
    ctx.currentTime += dt;
    director.advanceTo(ctx.currentTime + LOOKAHEAD);
  };
  return { ctx, director, notes, frame };
}

describe('music transport', () => {
  it('schedules only inside its lookahead window, one frame at a time', () => {
    const r = rig();
    r.director.setStateImmediate('combat');
    r.director.start(r.ctx.currentTime);
    for (let i = 0; i < 60; i++) r.frame(1 / 60);
    expect(r.notes.length).toBeGreaterThan(0);
    for (const note of r.notes) {
      expect(note.time).toBeGreaterThanOrEqual(0);
      expect(note.time).toBeLessThanOrEqual(r.ctx.currentTime + LOOKAHEAD + 1e-9);
    }
  });

  it('skips a backlog instead of dumping every missed note on resume', () => {
    // Regression guard. The frame loop stops calling `update()` while the game
    // is modally paused — `AudioSystem.setSuspended` has no caller — but the
    // live `AudioContext` clock keeps running. Without a floor in `advanceTo`,
    // the first frame after the pause scheduled every step of the gap, all at
    // times already past, which Web Audio collapses onto one instant: a
    // full-scale cluster into the limiter plus a multi-frame stall.
    const r = rig();
    r.director.setStateImmediate('combat');
    r.director.start(r.ctx.currentTime);
    for (let i = 0; i < 10; i++) r.frame(1 / 60);
    const before = r.notes.length;

    // Ten seconds of pause: the clock moved, the scheduler was not called.
    r.ctx.currentTime += 10;
    const scheduled = r.director.advanceTo(r.ctx.currentTime + LOOKAHEAD);

    const step = secondsPerStep(LAYERS.combat.bpm);
    // One lookahead window's worth of steps, not ten seconds' worth (~88 steps,
    // ~160 notes at this arrangement).
    expect(scheduled).toBeLessThan(20);
    // And nothing may be written into the past.
    for (const note of r.notes.slice(before)) {
      expect(note.time).toBeGreaterThanOrEqual(r.ctx.currentTime - step);
    }
    // The groove stays on its own grid rather than restarting from scratch.
    expect(r.director.step).toBeGreaterThan(80);
  });

  it('keeps the transport running normally when no gap accumulated', () => {
    const r = rig();
    r.director.setStateImmediate('calm');
    r.director.start(r.ctx.currentTime);
    for (let i = 0; i < 120; i++) r.frame(1 / 60);
    const expected = Math.floor((r.ctx.currentTime + LOOKAHEAD) / secondsPerStep(LAYERS.calm.bpm));
    // No resync should have fired, so the step counter tracks the clock exactly.
    expect(r.director.step).toBe(expected + 1);
  });

  it('plays the boredom collapse in the BORED layer, not the current one', () => {
    // The arrangement swapped to the drone while root, scale and tempo stayed on
    // the combat layer: the "single sustained tone" sounded an octave below the
    // 110 Hz it was voiced for, on a 1.8 s bar instead of a 4 s one, so it was
    // re-struck long before its 2.5 s attack arrived.
    const r = rig();
    r.director.setStateImmediate('combat');
    r.director.start(r.ctx.currentTime);
    for (let i = 0; i < 30; i++) r.frame(1 / 60);
    r.director.setBoredom(0.95);
    expect(0.95).toBeGreaterThanOrEqual(BOREDOM_COLLAPSE);
    // Well past the next bar line at either tempo.
    for (let i = 0; i < 600; i++) r.frame(1 / 60);

    expect(r.director.parts).toEqual(['drone']);
    expect(r.director.bpm).toBe(LAYERS.bored.bpm);
    const drone = r.notes.filter((n) => n.instrument === 'drone');
    expect(drone.length).toBeGreaterThan(0);
    for (const note of drone) expect(note.midi).toBe(LAYERS.bored.root);
  });

  it('restores the full arrangement when boredom falls back', () => {
    // The collapse has to be reversible: it is driven by a meter that goes down
    // again, and there is no event that puts the score back on its own.
    const r = rig();
    r.director.setStateImmediate('combat');
    r.director.start(r.ctx.currentTime);
    r.director.setBoredom(0.95);
    for (let i = 0; i < 400; i++) r.frame(1 / 60);
    expect(r.director.parts).toEqual(['drone']);

    r.director.setBoredom(0.1);
    for (let i = 0; i < 400; i++) r.frame(1 / 60);
    expect(r.director.parts).toEqual(LAYERS.combat.parts.map((p) => p.id));
    expect(r.director.bpm).toBe(LAYERS.combat.bpm);
  });

  it('restarts the grid AT the cut for setStateImmediate', () => {
    const r = rig();
    r.director.setStateImmediate('combat');
    r.director.start(r.ctx.currentTime);
    for (let i = 0; i < 30; i++) r.frame(1 / 60);
    const cutAt = r.ctx.currentTime;
    const before = r.notes.length;

    r.director.setStateImmediate('boss', cutAt);
    r.director.advanceTo(cutAt + LOOKAHEAD);
    const after = r.notes.slice(before);

    expect(after.length).toBeGreaterThan(0);
    // The old lookahead had already reached ~250 ms ahead. A hard cut must
    // begin where the cut happened, not where that window ended.
    expect(after[0]!.time).toBeCloseTo(cutAt, 6);
    expect(after[0]!.step).toBe(0);
  });
});

describe('crowd blip scheduler', () => {
  /** Drive the bed for `seconds` at `fps`, exactly as `update()` does. */
  function run(bed: CrowdBedVoice, ctx: { currentTime: number }, seconds: number, fps: number) {
    const dt = 1 / fps;
    let blips = 0;
    for (let t = 0; t < seconds; t += dt) {
      ctx.currentTime += dt;
      blips += bed.scheduleBlips(ctx.currentTime + LOOKAHEAD);
    }
    return blips;
  }

  function bed(): { ctx: BaseAudioContext & { currentTime: number }; voice: CrowdBedVoice } {
    const ctx = fakeContext();
    const voice = new CrowdBedVoice(ctx, fakeDestination());
    return { ctx, voice };
  }

  it('holds the designed rate regardless of frame rate', () => {
    // The `Math.max(1, Math.round(expected * 2))` candidate floor forced ONE
    // onset every frame whatever the density, so the bed ran at ~34 blips/s at
    // 60 fps against a designed 0.4–7 — and halved when the frame rate did.
    const seconds = 40;
    for (const fps of [30, 60, 120]) {
      const b = bed();
      b.voice.start(0, 1, 0.01);
      const blips = run(b.voice, b.ctx, seconds, fps);
      const rate = blips / seconds;
      expect(rate, `${fps} fps`).toBeGreaterThan(4);
      expect(rate, `${fps} fps`).toBeLessThan(8);
    }
  });

  it('tracks density, which is the whole point of the bed', () => {
    const seconds = 40;
    const rates = [0, 0.5, 1].map((density) => {
      const b = bed();
      b.voice.start(0, density, 0.01);
      return run(b.voice, b.ctx, seconds, 60) / seconds;
    });
    expect(rates[0]!).toBeLessThan(1);
    expect(rates[1]!).toBeGreaterThan(rates[0]!);
    expect(rates[2]!).toBeGreaterThan(rates[1]! * 2);
  });

  it('bounds the catch-up after a paused frame loop', () => {
    // `scheduledTo` is never clamped against the clock, so a ten-minute pause
    // used to schedule thousands of blip envelopes — ~21 000 `AudioParam` writes
    // in one frame, every one of them at a time already gone.
    const b = bed();
    b.voice.start(0, 1, 0.01);
    run(b.voice, b.ctx, 1, 60);
    b.ctx.currentTime += 600;
    const blips = b.voice.scheduleBlips(b.ctx.currentTime + LOOKAHEAD);
    expect(blips).toBeLessThanOrEqual(6);
  });
});

describe('mixer ducking state', () => {
  it('reports ducking only while a duck is actually in flight', () => {
    // `duckReleaseAt` started at `+Infinity` and `unduck` put it back there, so
    // `isDucking` was `now < Infinity` — true on a freshly built mixer that had
    // never ducked, and still true after the bus was provably back at unity.
    const ctx = fakeContext();
    const mixer = new Mixer(ctx, { bypassMaster: true });
    expect(mixer.isDucking('music', 0)).toBe(false);

    mixer.duckFor('music', 0.25, 0.02, 0.35, 0.7, 1);
    expect(mixer.isDucking('music', 1.1)).toBe(true);
    // 0.02 + 0.35 + 0.7 after the request.
    expect(mixer.isDucking('music', 1 + 1.07 + 1e-6)).toBe(false);

    mixer.duckFor('music', 0.25, 0.02, 0.35, 0.7, 5);
    mixer.unduck('music', 0.3, 5.1);
    expect(mixer.isDucking('music', 5.2)).toBe(false);

    // The indefinite form has no release, and must still say so.
    mixer.duck('music', 0.5, 0.1, 6);
    expect(mixer.isDucking('music', 600)).toBe(true);
  });
});
