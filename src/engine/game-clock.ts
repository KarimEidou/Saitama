/**
 * GAME CLOCK — the only source of truth for game time.
 *
 * Implements `IGameClock` (game.ts). Lives in the engine because time scaling
 * is a renderer/camera concern as much as a simulation one: the impact-freeze
 * effect drives `timeScale` while the camera FOV punches in, and both have to
 * agree about what "90 milliseconds of REAL time" means while the game clock
 * itself is running at 4% speed.
 *
 * ── THE TWO TIMELINES ──────────────────────────────────────────────────────
 *   delta / elapsed                 — SCALED. What simulation consumes.
 *   rawDelta / unscaledElapsed      — REAL. What UI animation, profiling and
 *                                     any effect measured in wall-clock time
 *                                     (impact freeze, resolution governor)
 *                                     must consume.
 * Mixing them up is how a "90ms" hit-stop becomes a 2.25-second one at
 * timeScale 0.04.
 */

import type { IGameClock } from '@/types';

export interface IGameClockOptions {
  /** Upper bound on `rawDelta`, in seconds. Defaults to 1/15. */
  readonly maxDelta?: number;
  /** Fixed physics timestep, in seconds. Defaults to 1/60. */
  readonly fixedStep?: number;
  /** Injectable clock for tests. Defaults to `performance.now`. */
  readonly now?: () => number;
}

export class GameClock implements IGameClock {
  rawDelta = 0;
  delta = 0;
  elapsed = 0;
  unscaledElapsed = 0;
  frameCount = 0;
  timeScale = 1;
  readonly maxDelta: number;
  readonly fixedStep: number;
  fixedStepCount = 0;
  fixedAlpha = 0;

  private readonly now: () => number;
  private lastNowMs: number;
  private accumulator = 0;
  private started = false;

  constructor(options: IGameClockOptions = {}) {
    this.maxDelta = options.maxDelta ?? 1 / 15;
    this.fixedStep = options.fixedStep ?? 1 / 60;
    this.now = options.now ?? (() => performance.now());
    this.lastNowMs = this.now();
  }

  /**
   * Advance one frame.
   *
   * @param nowMs Optional timestamp (the value rAF hands you). Defaults to
   *              the injected clock.
   * @returns the scaled delta in seconds, for convenience.
   */
  tick(nowMs: number = this.now()): number {
    if (!this.started) {
      // First tick after construction or resume: the elapsed wall time is
      // meaningless (it includes asset loading), so charge one nominal frame.
      this.started = true;
      this.lastNowMs = nowMs;
      this.rawDelta = this.fixedStep;
    } else {
      const raw = (nowMs - this.lastNowMs) / 1000;
      this.lastNowMs = nowMs;
      this.rawDelta = raw > this.maxDelta ? this.maxDelta : raw < 0 ? 0 : raw;
    }

    this.delta = this.rawDelta * this.timeScale;
    this.elapsed += this.delta;
    this.unscaledElapsed += this.rawDelta;
    this.frameCount++;

    // Fixed-step accumulation runs on SCALED time so slow motion also slows
    // physics; capped so a hitch cannot spiral into a hundred sub-steps.
    this.accumulator += this.delta;
    let steps = 0;
    while (this.accumulator >= this.fixedStep && steps < 8) {
      this.accumulator -= this.fixedStep;
      steps++;
    }
    if (steps === 8) this.accumulator = 0;
    this.fixedStepCount = steps;
    this.fixedAlpha = this.fixedStep > 0 ? this.accumulator / this.fixedStep : 0;

    return this.delta;
  }

  /**
   * Discard the wall-clock gap since the last tick without advancing game
   * time. Call after returning from the background or a long load, otherwise
   * the next tick charges the whole gap (clamped to maxDelta, but still a
   * visible jump).
   */
  resync(): void {
    this.started = false;
    this.lastNowMs = this.now();
  }

  /** Zero everything except `timeScale`. */
  reset(): void {
    this.rawDelta = 0;
    this.delta = 0;
    this.elapsed = 0;
    this.unscaledElapsed = 0;
    this.frameCount = 0;
    this.fixedStepCount = 0;
    this.fixedAlpha = 0;
    this.accumulator = 0;
    this.resync();
  }
}
