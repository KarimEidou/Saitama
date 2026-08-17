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
import { createInstruments, type IInstrument, type InstrumentId } from './instruments';
import {
  degreeToMidi,
  LAYERS,
  MUSIC_STATES,
  partsFor,
  REST,
  secondsPerStep,
  STEPS_PER_BAR,
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
  private readonly instruments: Record<InstrumentId, IInstrument>;
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

  constructor(
    ctx: BaseAudioContext,
    destination: AudioNode,
    options: IMusicDirectorOptions = {}
  ) {
    this.ctx = ctx;
    this.instruments = createInstruments(ctx, destination);
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

  /** Current tempo, which follows the active state. */
  get bpm(): number {
    return LAYERS[this.currentState].bpm;
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
    // Realign the grid so the new state starts a fresh bar.
    this.stepCounter = 0;
    this.nextStepTime = Math.max(this.nextStepTime, time);
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
    for (const id of Object.keys(this.instruments) as InstrumentId[]) {
      this.instruments[id].allNotesOff(time, fadeSeconds);
    }
  }

  /**
   * Schedule every step up to `horizon`.
   *
   * @returns how many notes were scheduled by this call.
   */
  advanceTo(horizon: number): number {
    if (!this.running) return 0;
    let scheduled = 0;
    // Hard iteration cap: a bad horizon must never spin the frame.
    let guard = 100000;
    while (this.nextStepTime < horizon && guard-- > 0) {
      const stepInBar = this.stepCounter % STEPS_PER_BAR;
      if (stepInBar === 0) this.applyQueued(this.nextStepTime);
      scheduled += this.scheduleStep(stepInBar, this.nextStepTime);
      this.nextStepTime += secondsPerStep(LAYERS[this.currentState].bpm);
      this.stepCounter++;
    }
    return scheduled;
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
      if (!now.has(id)) this.instruments[id].allNotesOff(time);
    }
  }

  private scheduleStep(stepInBar: number, time: number): number {
    const layer = LAYERS[this.currentState];
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
      this.instruments[part.instrument].noteOn(time, midi, velocity, seconds);
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
    for (const id of Object.keys(this.instruments) as InstrumentId[]) {
      this.instruments[id].dispose();
    }
  }
}
