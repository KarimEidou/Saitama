/**
 * MUSIC DIRECTOR — the step sequencer and the intensity state machine.
 *
 * ── WHY A LOOKAHEAD SCHEDULER ──────────────────────────────────────────────
 * Notes are never fired "now". Every frame, the director schedules every step
 * that falls inside a short lookahead window onto the audio timeline, at exact
 * times. The audio thread then plays them with sample accuracy regardless of
 * what the render thread is doing. Firing notes from the frame loop instead
 * would tie the groove to the frame rate, and a dropped frame during a
 * collapse would audibly stumble the music.
 *
 * The same property is what makes the music renderable offline: an
 * `OfflineAudioContext` has no wall clock at all, so the tests simply call
 * `advanceTo(20)` once and the entire twenty seconds is scheduled up front.
 *
 * ── TRANSITIONS ────────────────────────────────────────────────────────────
 * A state change is never applied mid-bar. It is queued and takes effect on
 * the next bar line, which is why escalation sounds like an arrangement
 * decision rather than an interruption. Tempo changes ride along with it.
 *
 * ── BOREDOM ────────────────────────────────────────────────────────────────
 * Boredom removes parts (see `partsFor`). When a part is removed, its
 * instrument is explicitly silenced rather than left to ring, so the
 * arrangement really does get smaller instead of accumulating tails.
 */

import { createRng, lerp, type IRandom } from '@/util';
import { INSTRUMENT_FACTORIES, type IInstrument, type InstrumentId } from './instruments';
import {
  BOREDOM_COLLAPSE,
  degreeToMidi,
  LAYERS,
  MUSIC_STATES,
  partsFor,
  REST,
  secondsPerStep,
  STEPS_PER_BAR,
  type IMusicLayer,
  type IPart,
  type MusicState,
  type PartId,
} from './patterns';

/** Note event reported to observers (tests, the audition harness). */
export interface IScheduledNote {
  readonly part: PartId;
  readonly instrument: InstrumentId;
  readonly time: number;
  readonly midi: number;
  readonly velocity: number;
  readonly bar: number;
  readonly step: number;
}

export interface IMusicDirectorOptions {
  /** Deterministic seed for humanisation. */
  readonly seed?: number;
  /** Observer for every scheduled note. */
  readonly onNote?: (note: IScheduledNote) => void;
}

export class MusicDirector {
  private readonly ctx: BaseAudioContext;
  private readonly destination: AudioNode;
  /**
   * Instruments built so far, keyed by id.
   *
   * The palette is built ON DEMAND. `AudioSystem` constructs the director
   * eagerly — before `unlock()`, and whether or not music ever plays — and the
   * full palette is ~39 permanently-running sources. The `calm` layer plays two
   * of the ten instruments, so anything not in the current arrangement would be
   * pure cost. Every entry here is an instrument that has actually been asked
   * to sound at least once.
   */
  private readonly built = new Map<InstrumentId, IInstrument>();
  private readonly rng: IRandom;
  private readonly onNote: ((note: IScheduledNote) => void) | undefined;

  private currentState: MusicState = 'calm';
  private queuedState: MusicState | undefined;
  private boredomValue = 0;
  private queuedBoredom: number | undefined;
  private activeParts: readonly IPart[] = LAYERS.calm.parts;

  private running = false;
  private nextStepTime = 0;
  private stepCounter = 0;
  private notesScheduled = 0;

  constructor(ctx: BaseAudioContext, destination: AudioNode, options: IMusicDirectorOptions = {}) {
    this.ctx = ctx;
    this.destination = destination;
    this.rng = createRng(options.seed ?? 0x5a17a3);
    this.onNote = options.onNote;
    this.activeParts = partsFor(this.currentState, this.boredomValue);
  }

  /* ---------------------------------------------------------------------- */
  /* State                                                                  */
  /* ---------------------------------------------------------------------- */

  get state(): MusicState {
    return this.currentState;
  }

  /** The state queued for the next bar line, if any. */
  get pending(): MusicState | undefined {
    return this.queuedState;
  }

  get boredom(): number {
    return this.boredomValue;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Bars elapsed since `start`. */
  get bar(): number {
    return Math.floor(this.stepCounter / STEPS_PER_BAR);
  }

  /** Steps elapsed since `start`. */
  get step(): number {
    return this.stepCounter;
  }

  /** Notes scheduled since `start`. */
  get noteCount(): number {
    return this.notesScheduled;
  }

  /** The parts currently playing, in arrangement order. */
  get parts(): readonly PartId[] {
    return this.activeParts.map((p) => p.id);
  }

  /** Current tempo, which follows whatever layer is actually sounding. */
  get bpm(): number {
    return this.layer.bpm;
  }

  /**
   * The layer that is actually sounding.
   *
   * `partsFor` swaps in the BORED layer's parts at the collapse threshold, but
   * the parts are only half of a layer: root, scale and tempo travel with it.
   * Resolving them from `currentState` instead played the drone at the combat
   * root (55 Hz, an octave below the 110 Hz it was voiced for, and close to
   * inaudible on a phone) with a 1.8 s bar instead of a 4 s one, so it was
   * re-struck before its 2.5 s attack ever arrived.
   */
  private get layer(): IMusicLayer {
    return this.boredomValue >= BOREDOM_COLLAPSE ? LAYERS.bored : LAYERS[this.currentState];
  }

  /**
   * Queue an intensity change. It takes effect on the next bar line, so the
   * transition lands musically. Setting the state that is already active, or
   * re-queuing, is a no-op.
   */
  setState(state: MusicState): void {
    if (state === this.currentState) {
      this.queuedState = undefined;
      return;
    }
    this.queuedState = state;
  }

  /** Change state at once, ignoring the bar grid. For hard cuts only. */
  setStateImmediate(state: MusicState, time = this.ctx.currentTime): void {
    this.queuedState = undefined;
    this.applyState(state, time);
    // Silence every instrument that EXISTS, not just the ones that dropped out.
    // Most escalations share their whole palette — combat to boss drops nothing
    // — so `refreshParts` alone leaves the old layer's already-scheduled notes
    // sounding, at the old root, over the new one: a bitonal smear on a cut the
    // caller asked to be instantaneous. An instrument that was never built has
    // nothing scheduled on it, so building one here to silence it would be
    // exactly backwards.
    for (const made of this.built.values()) made.allNotesOff(time, 0.02);
    // Realign the grid so the new state starts a fresh bar AT THE CUT, rather
    // than wherever the old lookahead window happened to reach.
    this.stepCounter = 0;
    this.nextStepTime = Math.max(time, this.ctx.currentTime);
  }

  /**
   * Set the boredom meter. Like state, it is applied on a bar line: the
   * arrangement must not lose a part halfway through one.
   */
  setBoredom(value: number): void {
    const clamped = Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;
    if (clamped === this.boredomValue) {
      this.queuedBoredom = undefined;
      return;
    }
    this.queuedBoredom = clamped;
  }

  /* ---------------------------------------------------------------------- */
  /* Transport                                                              */
  /* ---------------------------------------------------------------------- */

  start(time = this.ctx.currentTime): void {
    if (this.running) return;
    this.running = true;
    this.nextStepTime = time;
    this.stepCounter = 0;
    this.notesScheduled = 0;
    this.activeParts = partsFor(this.currentState, this.boredomValue);
  }

  stop(time = this.ctx.currentTime, fadeSeconds = 0.5): void {
    if (!this.running) return;
    this.running = false;
    for (const made of this.built.values()) made.allNotesOff(time, fadeSeconds);
  }

  /**
   * Schedule every step up to `horizon`.
   *
   * @returns how many notes were scheduled by this call.
   */
  advanceTo(horizon: number): number {
    if (!this.running) return 0;
    this.resync();
    let scheduled = 0;
    // Hard iteration cap: a bad horizon must never spin the frame.
    let guard = 100000;
    while (this.nextStepTime < horizon && guard-- > 0) {
      const stepInBar = this.stepCounter % STEPS_PER_BAR;
      if (stepInBar === 0) this.applyQueued(this.nextStepTime);
      scheduled += this.scheduleStep(stepInBar, this.nextStepTime);
      this.nextStepTime += secondsPerStep(this.layer.bpm);
      this.stepCounter++;
    }
    return scheduled;
  }

  /**
   * Skip a backlog rather than playing it.
   *
   * The frame loop stops calling `update()` whenever the game is modally paused
   * or the tab is backgrounded, while `ctx.currentTime` keeps running. Without
   * a floor, the next call schedules every missed step — ten seconds of a
   * 132 bpm groove is ~160 notes, ALL at times already in the past, which Web
   * Audio collapses onto the current render quantum: one full-scale cluster into
   * the limiter, and for a long pause tens of thousands of automation writes in
   * a single frame. The transport is snapped forward on the step grid instead,
   * so the groove resumes in phase and nothing is emitted for time that has
   * already gone by.
   */
  private resync(): void {
    const now = this.ctx.currentTime;
    const stepSeconds = secondsPerStep(this.layer.bpm);
    if (!(stepSeconds > 0) || this.nextStepTime >= now - stepSeconds) return;
    const skipped = Math.ceil((now - this.nextStepTime) / stepSeconds);
    this.nextStepTime += skipped * stepSeconds;
    this.stepCounter += skipped;
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  private applyQueued(time: number): void {
    if (this.queuedBoredom !== undefined) {
      this.boredomValue = this.queuedBoredom;
      this.queuedBoredom = undefined;
      this.refreshParts(time);
    }
    if (this.queuedState !== undefined) {
      const next = this.queuedState;
      this.queuedState = undefined;
      this.applyState(next, time);
    }
  }

  private applyState(state: MusicState, time: number): void {
    if (!MUSIC_STATES.includes(state)) return;
    this.currentState = state;
    this.refreshParts(time);
  }

  /**
   * Recompute the active part set and silence anything that just dropped out.
   * Leaving a removed part ringing would defeat the whole point: the
   * arrangement has to get structurally smaller, not just stop being fed.
   */
  private refreshParts(time: number): void {
    const previous = new Set(this.activeParts.map((p) => p.instrument));
    this.activeParts = partsFor(this.currentState, this.boredomValue);
    const now = new Set(this.activeParts.map((p) => p.instrument));
    for (const id of previous) {
      // `built.get`, never `instrument()`: silencing a part that never sounded
      // must not construct the graph it is silencing.
      if (!now.has(id)) this.built.get(id)?.allNotesOff(time);
    }
  }

  /** The instrument for `id`, built on first use. */
  private instrument(id: InstrumentId): IInstrument {
    let made = this.built.get(id);
    if (!made) {
      made = INSTRUMENT_FACTORIES[id](this.ctx, this.destination);
      this.built.set(id, made);
    }
    return made;
  }

  private scheduleStep(stepInBar: number, time: number): number {
    const layer = this.layer;
    const stepSeconds = secondsPerStep(layer.bpm);
    // Every fourth bar takes the fill pattern where a part defines one.
    const isFillBar = this.bar % 4 === 3;
    let count = 0;

    for (const part of this.activeParts) {
      const steps = isFillBar && part.fill ? part.fill : part.steps;
      const degree = steps[stepInBar] ?? REST;
      if (degree === REST) continue;

      const midi = degreeToMidi(layer.root, layer.scale, degree, part.octave);
      // Humanised velocity. Small, deterministic, and enough to stop a
      // sixteenth-note hat from sounding like a click track.
      const velocity = Math.min(1, part.velocity * lerp(0.88, 1.08, this.rng.next()));
      const seconds = part.gate * stepSeconds;
      this.instrument(part.instrument).noteOn(time, midi, velocity, seconds);
      count++;
      this.notesScheduled++;
      this.onNote?.({
        part: part.id,
        instrument: part.instrument,
        time,
        midi,
        velocity,
        bar: this.bar,
        step: stepInBar,
      });
    }
    return count;
  }

  dispose(): void {
    // Stop first, and set the flag directly rather than calling `stop()`: a
    // disposed director must not report `isRunning`, and `advanceTo` must not be
    // able to write automation onto nodes that are about to be torn down.
    // `stop()` would schedule multi-second fades on instruments this very loop
    // disconnects on the next line, which is pure waste.
    this.running = false;
    this.queuedState = undefined;
    this.queuedBoredom = undefined;
    for (const made of this.built.values()) made.dispose();
  }
}
