/**
 * THE DAY / NIGHT CLOCK
 *
 * Owns the normalised time of day, advances it, and publishes both states
 * every frame. Everything visual downstream — sky blend, exposure, cascades,
 * fog, street lamps — is a pure function of the value this class holds, which
 * is what makes "show me midnight" a one-line call rather than a wait.
 *
 * ── QUESTS CAN TAKE THE CLOCK ──────────────────────────────────────────────
 * `forceTimeOfDay(t)` pins the clock so a scripted beat happens at the hour it
 * was written for — the Deep Sea King arrives in the rain at dusk, not
 * whenever the player happens to walk in. `releaseTime()` hands it back and,
 * by default, EASES back to where the free-running clock would have been
 * rather than snapping, because a hard jump in sun angle re-renders every
 * shadow in one frame and reads as a glitch.
 *
 * ── EVENT DISCIPLINE ───────────────────────────────────────────────────────
 * `TimeOfDayChanged` fires on PHASE TRANSITIONS and on explicit jumps, never
 * per frame. A per-frame clock event would be 60 allocations a second on the
 * bus for a value any listener can read directly off `state`.
 */

import * as THREE from 'three';
import type { DayPhase, IDayNightState, IDayNightSystem, IEventBus } from '@/types';
import { createLogger } from '@/util';
import { DAY_LENGTH_SECONDS, INITIAL_LUNAR_AGE_DAYS, SYNODIC_MONTH_DAYS } from './constants';
import {
  blendSH9,
  sampleSkyBlend,
  wrap01,
  type EnvironmentMeasurements,
  type ISkyBlend,
} from './environment-blend';
import {
  MutableDayNightState,
  MutableSkyLightingState,
  deriveLighting,
  fillDayNightState,
  phaseForTime,
  type ISkyDerived,
} from './sky-lighting';
import type { ISolarOptions } from './solar';

const log = createLogger('world.sky');

export interface IDayNightOptions {
  /** Bus for `TimeOfDayChanged`. Omit in unit tests that do not need events. */
  readonly bus?: IEventBus;
  /** Real seconds per in-game day. */
  readonly dayLengthSeconds?: number;
  /** Starting normalised time. */
  readonly startTimeOfDay?: number;
  /** Measured sky data. Without it, colours fall back to neutral greys. */
  readonly measurements?: EnvironmentMeasurements;
  /** Overrides for latitude/longitude/day-of-year. */
  readonly solar?: ISolarOptions;
  /** Days since new moon at start. */
  readonly lunarAgeDays?: number;
  /** Advance the lunar age with the day count. Off keeps nights reproducible. */
  readonly advanceMoon?: boolean;
}

/** How a forced time is being held. */
export type TimeOverrideMode = 'none' | 'held' | 'releasing';

/** Fold any lunar age — including a negative one — into 0..SYNODIC_MONTH_DAYS. */
function wrapLunarAge(days: number): number {
  return ((days % SYNODIC_MONTH_DAYS) + SYNODIC_MONTH_DAYS) % SYNODIC_MONTH_DAYS;
}

export class DayNightSystem implements IDayNightSystem {
  /** Published lighting for the renderer, shadows and fog. */
  readonly lighting = new MutableSkyLightingState();
  /** Blended, exposure-normalised SH for the current instant. */
  readonly sphericalHarmonics = new THREE.SphericalHarmonics3();

  timeScale = 1;

  private readonly dayNight = new MutableDayNightState();
  private readonly bus: IEventBus | undefined;
  private readonly solar: ISolarOptions | undefined;
  private readonly advanceMoon: boolean;
  private readonly shScratch = new THREE.SphericalHarmonics3();

  private measurements: EnvironmentMeasurements | undefined;
  private hasSH = false;

  private time: number;
  private days = 0;
  private lunarAge: number;
  private phase: DayPhase;
  private blendValue: ISkyBlend;
  private derivedValue: ISkyDerived;

  private overrideMode: TimeOverrideMode = 'none';
  private overrideTarget = 0;
  /** Where the free-running clock would be; kept ticking under an override. */
  private shadowTime = 0;
  /**
   * Signed offset (visible clock minus real clock) frozen at the moment of
   * release, and how far through the blend back we are.
   *
   * Modelled as a decaying OFFSET rather than as an exponential chase towards
   * a moving target: the real clock keeps advancing during the blend, so a
   * chase settles at a non-zero equilibrium gap and never terminates.
   */
  private releaseOffset = 0;
  private releaseElapsed = 0;
  private releaseDuration = 1;

  constructor(options: IDayNightOptions = {}) {
    this.bus = options.bus;
    this.solar = options.solar;
    this.advanceMoon = options.advanceMoon ?? false;
    this.measurements = options.measurements;
    this.lunarAge = options.lunarAgeDays ?? INITIAL_LUNAR_AGE_DAYS;
    // Through the SETTER, not the backing state: a 0 or negative day length
    // makes `step` infinite, which wraps the clock to 0 every frame and counts
    // a day elapsed at 60 Hz. One clamp, both paths.
    this.dayLengthSeconds = options.dayLengthSeconds ?? DAY_LENGTH_SECONDS;

    this.time = wrap01(options.startTimeOfDay ?? 0.5);
    this.shadowTime = this.time;
    this.phase = phaseForTime(this.time);
    this.blendValue = sampleSkyBlend(this.time);
    this.derivedValue = this.recompute();
  }

  get state(): IDayNightState {
    return this.dayNight;
  }

  /** Which two skies are mixing right now, and how. */
  get blend(): ISkyBlend {
    return this.blendValue;
  }

  /** Signals with no home in either shared contract. */
  get derived(): ISkyDerived {
    return this.derivedValue;
  }

  get lunarAgeDays(): number {
    return this.lunarAge;
  }

  get overrideState(): TimeOverrideMode {
    return this.overrideMode;
  }

  /** True once measured SH data is driving the colours. */
  get hasMeasuredEnvironment(): boolean {
    return this.hasSH;
  }

  /**
   * Install measured sky data. Safe to call after construction — the asset
   * load is async and the world must be lit before it finishes.
   */
  setMeasurements(measurements: EnvironmentMeasurements): void {
    this.measurements = measurements;
    this.derivedValue = this.recompute();
    log.info(
      `sky measurements installed; normalising against mean luminance ` +
        `(day ${measurements.day.meanLuminance.toFixed(3)}, night ${measurements.night.meanLuminance.toFixed(3)})`
    );
  }

  /** Real seconds per in-game day. */
  get dayLengthSeconds(): number {
    return this.dayNight.dayLengthSeconds;
  }

  set dayLengthSeconds(seconds: number) {
    this.dayNight.dayLengthSeconds = Math.max(1, seconds);
  }

  update(dt: number): void {
    if (dt > 0) {
      const step = (dt * this.timeScale) / this.dayNight.dayLengthSeconds;

      // The free-running clock keeps ticking even while a quest holds the
      // visible time, so releasing does not rewind the world.
      const previousShadow = this.shadowTime;
      this.shadowTime = wrap01(this.shadowTime + step);

      // The day count follows the FREE-RUNNING clock, so it is read here and
      // not inside the branches: a quest holding the clock across midnight
      // still elapses a day, exactly as `forceTimeOfDay` promises. Counting it
      // only in two of the three branches lost a whole in-game day, for good,
      // every time a scripted beat spanned a wrap.
      if (this.shadowTime < previousShadow) this.rollOverDay();

      if (this.overrideMode === 'none') {
        this.time = this.shadowTime;
      } else if (this.overrideMode === 'releasing') {
        this.releaseElapsed += dt;
        const u = Math.min(1, this.releaseElapsed / this.releaseDuration);
        if (u >= 1) {
          this.overrideMode = 'none';
          this.time = this.shadowTime;
        } else {
          // Smootherstep so the sun does not lurch into motion. The offset is
          // the SHORT way round the circle, so releasing at 23:50 towards
          // 00:10 does not run the sun backwards through the entire day.
          const eased = u * u * u * (u * (u * 6 - 15) + 10);
          this.time = wrap01(this.shadowTime + this.releaseOffset * (1 - eased));
        }
      } else {
        this.time = this.overrideTarget;
      }
    }

    this.derivedValue = this.recompute();
    this.publishPhase();
  }

  /**
   * Jump to a normalised time. Instant and unheld — the free-running clock is
   * moved, not overridden.
   */
  setTimeOfDay(t: number): void {
    const next = wrap01(t);
    this.time = next;
    this.shadowTime = next;
    this.overrideMode = 'none';
    this.derivedValue = this.recompute();
    this.publishPhase();
  }

  /**
   * Pin the clock for a scripted beat. The free-running clock continues
   * underneath, so gameplay that depends on elapsed days is unaffected.
   */
  forceTimeOfDay(t: number): void {
    this.overrideTarget = wrap01(t);
    this.overrideMode = 'held';
    this.time = this.overrideTarget;
    this.derivedValue = this.recompute();
    this.publishPhase();
  }

  /**
   * Hand the clock back.
   *
   * @param easeSeconds Seconds to blend back to the real time. 0 snaps.
   */
  releaseTime(easeSeconds = 6): void {
    if (this.overrideMode === 'none') return;
    if (easeSeconds <= 0) {
      this.overrideMode = 'none';
      this.time = this.shadowTime;
      this.derivedValue = this.recompute();
      this.publishPhase();
      return;
    }
    this.overrideMode = 'releasing';
    this.releaseOffset = shortestDelta(this.shadowTime, this.time);
    this.releaseElapsed = 0;
    this.releaseDuration = easeSeconds;
  }

  /** Days elapsed. Advances on the free-running clock, not the visible one. */
  get dayCount(): number {
    return this.days;
  }

  /**
   * Restore the elapsed-day count, and optionally the lunar age, from a save.
   *
   * `ISaveGame` persists `dayCount`, but without this the field is write-only:
   * the load path can put the time back and nothing else, so a player who
   * saved on day 5 reloads onto day 0 and the off-screen rival progression
   * re-runs its accounting from zero. Call it next to `setTimeOfDay(...)`.
   */
  setDayCount(days: number, lunarAgeDays?: number): void {
    this.days = Number.isFinite(days) ? Math.max(0, Math.floor(days)) : 0;
    if (lunarAgeDays !== undefined && Number.isFinite(lunarAgeDays)) {
      this.lunarAge = wrapLunarAge(lunarAgeDays);
    }
    this.derivedValue = this.recompute();
  }

  /**
   * Restore the moon phase on its own.
   *
   * A save can carry a lunar age without a usable day count — the extras block
   * is optional and older payloads have one but not the other — so the two are
   * restorable independently rather than only as a pair.
   */
  setLunarAgeDays(days: number): void {
    if (!Number.isFinite(days)) return;
    this.lunarAge = wrapLunarAge(days);
    this.derivedValue = this.recompute();
  }

  /* ---------------------------------------------------------------------- */

  private rollOverDay(): void {
    this.days++;
    if (this.advanceMoon) this.lunarAge = (this.lunarAge + 1) % SYNODIC_MONTH_DAYS;
  }

  private recompute(): ISkyDerived {
    this.blendValue = sampleSkyBlend(this.time);
    this.hasSH = this.measurements
      ? blendSH9(this.measurements, this.blendValue, this.sphericalHarmonics, this.shScratch)
      : false;

    const derived = deriveLighting(
      {
        timeOfDay: this.time,
        lunarAgeDays: this.lunarAge,
        blend: this.blendValue,
        sh: this.hasSH ? this.sphericalHarmonics : undefined,
        solar: this.solar,
      },
      this.lighting
    );

    fillDayNightState(
      this.dayNight,
      {
        timeOfDay: this.time,
        dayCount: this.days,
        dayLengthSeconds: this.dayNight.dayLengthSeconds,
        lunarAgeDays: this.lunarAge,
      },
      this.lighting,
      derived
    );
    return derived;
  }

  private publishPhase(): void {
    const next = phaseForTime(this.time);
    if (next === this.phase) return;
    const previous = this.phase;
    this.phase = next;
    this.bus?.emit('TimeOfDayChanged', {
      timeOfDay: this.time,
      phase: next,
      previousPhase: previous,
      dayCount: this.days,
    });
  }
}

/** Signed distance from `a` to `b` around a unit circle, in (-0.5, 0.5]. */
function shortestDelta(a: number, b: number): number {
  let d = b - a;
  while (d > 0.5) d -= 1;
  while (d <= -0.5) d += 1;
  return d;
}
