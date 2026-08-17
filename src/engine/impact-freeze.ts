/**
 * IMPACT FREEZE — the hit-stop that sells a one-punch kill.
 *
 * On a lethal hit the game clock drops to 4% speed for 90 REAL milliseconds
 * while the camera's field of view punches in 8 degrees, then both ease back
 * over 200ms. It is three lines of maths and it is the difference between a
 * monster dying and a monster being DELETED.
 *
 * ── WHY IT LIVES IN THE RENDERER ───────────────────────────────────────────
 * It is a clock and camera effect, not a combat rule. Combat decides that
 * something died; how that reads on screen is a presentation decision, and
 * putting it here means combat can be rewritten without touching game feel and
 * vice versa. Communication is one-way through the event bus — this file does
 * not import the combat system, and could not, per the architectural rule.
 *
 * ── THE TWO-TIMELINE TRAP ──────────────────────────────────────────────────
 * The freeze is measured in REAL time, but it works by slowing GAME time. Feed
 * it scaled `delta` and 90ms of hit-stop becomes 90 / 0.04 = 2250ms of
 * wall-clock hang: the game appears to lock up. `update()` therefore takes
 * `IGameClock.rawDelta`, never `delta`.
 *
 * ── WHY FOV AND NOT A DOLLY ────────────────────────────────────────────────
 * Moving the camera in would clip through the monster and re-frame the shot.
 * Narrowing the FOV magnifies the subject while leaving the camera where the
 * player put it, and the perspective distortion change is itself the visual
 * cue — the same trick as a vertigo shot, used at 8 degrees over 90ms.
 */

import type * as THREE from 'three';
import type { GameEventOf, IDisposable, IEventBus, IGameClock, LethalIntent } from '@/types';
import { createLogger } from '@/util';

const log = createLogger('engine.impact');

export interface IImpactFreezeOptions {
  /** Time scale held during the freeze. */
  readonly frozenTimeScale?: number;
  /** Seconds of REAL time the freeze holds. */
  readonly holdSeconds?: number;
  /** Seconds of REAL time spent easing back to normal. */
  readonly recoverSeconds?: number;
  /** Degrees the field of view narrows by at full intensity. */
  readonly fovPunchDegrees?: number;
  /**
   * Intents that qualify as "lethal enough". Defaults to all three: the freeze
   * reacts to something dying to a punch, not to how long the button was held.
   * Intent still scales the result, so a jab reads shorter and shallower than a
   * serious punch rather than being silent.
   */
  readonly qualifyingIntents?: readonly LethalIntent[];
  /**
   * Also fire on a critical, non-fatal hit at `full` intent. Cheap way to make
   * heavy blows land even when the target survives.
   */
  readonly includeCriticalHits?: boolean;
  /** Called when a freeze starts, with intensity 0..1. Drives VFX/post/audio. */
  readonly onImpact?: (intensity: number) => void;
}

/** Live state, for the debug HUD. */
export interface IImpactFreezeState {
  readonly active: boolean;
  readonly phase: 'idle' | 'hold' | 'recover';
  readonly elapsed: number;
  readonly intensity: number;
  readonly timeScale: number;
  readonly fovOffset: number;
}

/**
 * The freeze keys on LETHALITY, not on how long a button was held.
 *
 * `normal` is included deliberately. Saitama's whole premise is that he ends
 * fights with one unremarkable punch — a casual jab deleting a demon-tier
 * monster IS the signature moment, and it cannot pass silently while only the
 * charged attack gets a hit-stop. The combat system reports `intent` honestly
 * (audio picks its punch voice from it, VFX scales the shockwave from it), so
 * the weighting below is what separates a jab from a serious punch, not a lie
 * about intent.
 */
const DEFAULT_INTENTS: readonly LethalIntent[] = ['normal', 'serious', 'full'];

/**
 * How much of `holdSeconds` a freeze actually holds, by intensity. A tap is
 * frequent, so it gets a crisp stop rather than a cinematic pause — a full 90ms
 * on every jab reads as sludge, especially mid-chain.
 */
const MIN_HOLD_FRACTION = 0.5;

export class ImpactFreeze implements IDisposable {
  private readonly clock: IGameClock;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly frozenTimeScale: number;
  private readonly holdSeconds: number;
  private readonly recoverSeconds: number;
  private readonly fovPunchDegrees: number;
  private readonly qualifyingIntents: ReadonlySet<LethalIntent>;
  private readonly includeCriticalHits: boolean;
  private readonly onImpact: ((intensity: number) => void) | undefined;

  private readonly unsubscribes: (() => void)[] = [];

  private active = false;
  private elapsed = 0;
  private intensity = 0;
  /** Time scale the game was running at before the freeze started. */
  private restoreTimeScale = 1;
  /** FOV the camera was at before the freeze started. */
  private restoreFov = 60;
  private disposed = false;

  constructor(
    clock: IGameClock,
    camera: THREE.PerspectiveCamera,
    bus: IEventBus,
    options: IImpactFreezeOptions = {}
  ) {
    this.clock = clock;
    this.camera = camera;
    this.frozenTimeScale = options.frozenTimeScale ?? 0.04;
    this.holdSeconds = options.holdSeconds ?? 0.09;
    this.recoverSeconds = options.recoverSeconds ?? 0.2;
    this.fovPunchDegrees = options.fovPunchDegrees ?? 8;
    this.qualifyingIntents = new Set(options.qualifyingIntents ?? DEFAULT_INTENTS);
    this.includeCriticalHits = options.includeCriticalHits ?? true;
    this.onImpact = options.onImpact;

    this.unsubscribes.push(
      bus.on('EntityKilled', (event) => this.onEntityKilled(event)),
      bus.on('EntityDamaged', (event) => this.onEntityDamaged(event))
    );
  }

  get isActive(): boolean {
    return this.active;
  }

  /* ---------------------------------------------------------------------- */
  /* Triggers                                                               */
  /* ---------------------------------------------------------------------- */

  private onEntityKilled(event: GameEventOf<'EntityKilled'>): void {
    if (!this.qualifyingIntents.has(event.intent)) return;
    // Threat tier scales the hit: deleting a wolf-tier mob is routine, dropping
    // a dragon is not. Absent tier (a civilian, a prop) reads as low stakes.
    const tierWeight: Record<string, number> = {
      wolf: 0.45,
      tiger: 0.6,
      demon: 0.8,
      dragon: 1,
      god: 1,
    };
    const weight = event.threatTier ? (tierWeight[event.threatTier] ?? 0.5) : 0.4;
    // normal < serious < full. A jab that kills still stops the world, just
    // briefly and without the vertigo punch.
    const intentWeight = event.intent === 'full' ? 1 : event.intent === 'serious' ? 0.75 : 0.45;
    this.trigger(weight * intentWeight);
  }

  private onEntityDamaged(event: GameEventOf<'EntityDamaged'>): void {
    if (!this.includeCriticalHits) return;
    if (!event.critical || event.intent !== 'full') return;
    // A survived hit gets a shorter, weaker stop so it does not compete with
    // the kill it may be about to become.
    this.trigger(0.45);
  }

  /**
   * Start (or reinforce) a freeze.
   *
   * @param intensity 0..1. Scales both the FOV punch and how deep the time
   *                  scale drops. Re-triggering mid-freeze takes the STRONGER
   *                  of the two and restarts the timer, so a combo reads as one
   *                  sustained beat rather than a stutter.
   */
  trigger(intensity = 1): void {
    if (this.disposed) return;
    const clamped = Math.min(1, Math.max(0, intensity));
    if (clamped <= 0.01) return;

    if (!this.active) {
      // Snapshot BEFORE touching anything: whatever the game was running at
      // (a cutscene at 0.5x, a pause menu at 0) is what we return it to.
      this.restoreTimeScale = this.clock.timeScale;
      this.restoreFov = this.camera.fov;
      this.active = true;
    }

    this.intensity = Math.max(this.intensity, clamped);
    this.elapsed = 0;
    this.apply();
    this.onImpact?.(this.intensity);
  }

  /** Abandon the freeze immediately and restore the clock and camera. */
  cancel(): void {
    if (!this.active) return;
    this.active = false;
    this.elapsed = 0;
    this.intensity = 0;
    this.clock.timeScale = this.restoreTimeScale;
    this.camera.fov = this.restoreFov;
    this.camera.updateProjectionMatrix();
  }

  /* ---------------------------------------------------------------------- */
  /* Per-frame                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Advance the freeze.
   *
   * @param unscaledDt REAL seconds since the last frame — `IGameClock.rawDelta`.
   *                   Passing the scaled delta here stretches a 90ms hit-stop
   *                   into more than two seconds.
   */
  /**
   * Hold duration for the CURRENT intensity. A weak hit (a lethal jab) gets a
   * crisp stop; a full-power kill gets the whole cinematic beat.
   */
  private get effectiveHold(): number {
    return this.holdSeconds * (MIN_HOLD_FRACTION + (1 - MIN_HOLD_FRACTION) * this.intensity);
  }

  update(unscaledDt: number): void {
    if (!this.active || this.disposed) return;
    this.elapsed += unscaledDt;

    const total = this.effectiveHold + this.recoverSeconds;
    if (this.elapsed >= total) {
      this.active = false;
      this.intensity = 0;
      this.clock.timeScale = this.restoreTimeScale;
      this.camera.fov = this.restoreFov;
      this.camera.updateProjectionMatrix();
      return;
    }
    this.apply();
  }

  private apply(): void {
    const hold = this.effectiveHold;
    const punch = this.fovPunchDegrees * this.intensity;
    // At low intensity the clock should not stop dead; blend the frozen scale
    // towards normal so a weak hit is a nudge and a full-power kill is a stop.
    const frozenScale =
      this.restoreTimeScale * (1 - this.intensity) + this.frozenTimeScale * this.intensity;

    let timeScale: number;
    let fovOffset: number;

    if (this.elapsed < hold) {
      timeScale = frozenScale;
      fovOffset = punch;
    } else {
      const t = Math.min(1, (this.elapsed - hold) / Math.max(1e-4, this.recoverSeconds));
      // Cubic ease-out: most of the recovery happens early, so control returns
      // to the player fast while the tail keeps the beat from feeling clipped.
      const eased = 1 - Math.pow(1 - t, 3);
      timeScale = frozenScale + (this.restoreTimeScale - frozenScale) * eased;
      fovOffset = punch * (1 - eased);
    }

    this.clock.timeScale = timeScale;
    const fov = this.restoreFov - fovOffset;
    if (Math.abs(this.camera.fov - fov) > 1e-4) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  getState(): IImpactFreezeState {
    return {
      active: this.active,
      phase: !this.active ? 'idle' : this.elapsed < this.effectiveHold ? 'hold' : 'recover',
      elapsed: this.elapsed,
      intensity: this.intensity,
      timeScale: this.clock.timeScale,
      fovOffset: this.restoreFov - this.camera.fov,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.active) {
      this.clock.timeScale = this.restoreTimeScale;
      this.camera.fov = this.restoreFov;
      this.camera.updateProjectionMatrix();
      this.active = false;
    }
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
    log.debug('impact freeze disposed');
  }
}
