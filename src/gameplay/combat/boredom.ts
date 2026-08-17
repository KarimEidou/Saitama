/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THE BOREDOM METER — THE SYSTEMS ANSWER TO INVINCIBILITY                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Every other game answers "the player is too strong" with a bigger monster.
 * This one cannot: the premise is that no monster is big enough, and the
 * moment a fight becomes hard the story stops being this story. So the meter
 * that rises is not the enemy's health. It is his BOREDOM.
 *
 * ── THE RULES ──────────────────────────────────────────────────────────────
 *   KILLING INSTANTLY RAISES IT, scaled by how trivial the target was. A
 *   wolf-tier mob deleted in one tap is the full penalty; a god-tier kill
 *   still raises it, because it was still one punch, just far less.
 *
 *   IT DRAINS ONLY THROUGH HEROISM — arriving before a civilian dies,
 *   body-blocking a hit meant for Mumen Rider, catching debris over a crowd,
 *   finishing a fight without levelling the street. None of those help you
 *   win. Winning was never in question. They are the only things in the game
 *   that are actually *chosen*.
 *
 *   IDLENESS RAISES IT, slowly, forever. Standing in City Z doing nothing is
 *   the character's baseline condition.
 *
 *   AND IT DRIFTS BACK. Relief fades; the mood returns to `boredomBaseline`.
 *   That is `reason: 'decay'`, and it is what stops one good deed from buying
 *   permanent contentment.
 *
 * ── HOW IT REACHES THE PLAYER ──────────────────────────────────────────────
 * `BoredomChanged` only. The renderer already desaturates the whole frame off
 * it; the audio system already thins the arrangement to a single sustained
 * drone at 0.8. This module draws nothing and plays nothing — it emits one
 * number and the game changes colour.
 *
 * ── WHY IT SUBSCRIBES RATHER THAN BEING CALLED ─────────────────────────────
 * It listens to `EntityKilled` and `CivilianSaved` on the bus instead of being
 * poked by the resolver. A monster killed by a scripted set piece, by another
 * hero, or by a future system nobody has written yet moves the meter correctly
 * with no extra wiring — and the resolver stays a pure hit resolver.
 */

import type { EntityId, GameEventOf, IEventBus, ThreatTier } from '@/types';
import { clamp01 } from '@/util';
import { trivialityOf } from './resolver';
import type { ICombatTuning } from './tuning';
import type { HeroismKind } from './types';

/** Reasons the meter may report, narrowed from `BoredomChangedEvent`. */
export type BoredomReason = GameEventOf<'BoredomChanged'>['reason'];

/** One entry in the meter's audit log. Diagnostics and the harness. */
export interface IBoredomEntry {
  readonly time: number;
  readonly delta: number;
  readonly value: number;
  readonly reason: BoredomReason;
  readonly detail: string;
}

export interface IBoredomOptions {
  readonly bus: IEventBus;
  readonly tuning: ICombatTuning;
  /**
   * Whose kills count as the protagonist's trivial victories. Kills by anyone
   * else move nothing — a monster eating a civilian is a tragedy, not a
   * disappointment.
   */
  readonly playerId: EntityId;
  /** Starting value. Defaults to the baseline. */
  readonly initial?: number;
  /** Keep an audit log. On by default; it is a handful of small records. */
  readonly log?: boolean;
}

/** Which allowed `BoredomChanged.reason` each act of heroism reports as. */
const HEROISM_REASON: Readonly<Record<HeroismKind, BoredomReason>> = Object.freeze({
  arrivedInTime: 'civilianSaved',
  bodyBlock: 'challengingFight',
  debrisCaught: 'challengingFight',
  cleanVictory: 'restraintBonus',
  challenge: 'challengingFight',
});

export class BoredomMeter {
  private readonly bus: IEventBus;
  private readonly tuning: ICombatTuning;
  private readonly playerId: EntityId;
  private readonly keepLog: boolean;
  private readonly unsubscribes: (() => void)[] = [];
  private readonly entries: IBoredomEntry[] = [];

  private current: number;
  /** Last value put on the bus. The quantisation reference, not the truth. */
  private lastReported: number;
  private time = 0;
  /** Seconds since anything interesting happened. Drives the idle rise. */
  private sinceEvent = 0;
  /** True while heroism credit is still being unwound by the decay. */
  private belowBaseline = false;

  constructor(options: IBoredomOptions) {
    this.bus = options.bus;
    this.tuning = options.tuning;
    this.playerId = options.playerId;
    this.keepLog = options.log ?? true;
    this.current = clamp01(options.initial ?? options.tuning.boredomBaseline);
    this.lastReported = this.current;

    this.unsubscribes.push(
      this.bus.on('EntityKilled', (event) => this.onKilled(event)),
      this.bus.on('CivilianSaved', (event) => this.onCivilianSaved(event))
    );
  }

  get value(): number {
    return this.current;
  }

  get log(): readonly IBoredomEntry[] {
    return this.entries;
  }

  /* ---------------------------------------------------------------------- */
  /* Bus-driven                                                             */
  /* ---------------------------------------------------------------------- */

  private onKilled(event: GameEventOf<'EntityKilled'>): void {
    // Only the protagonist's own kills, and only of things that fight back.
    if (event.killerId !== this.playerId) return;
    if (event.entityType !== 'monster' && event.faction !== 'monster') return;
    this.apply(
      this.trivialKillDelta(event.threatTier),
      'trivialVictory',
      `${event.specId ?? event.entityId} (${event.threatTier ?? 'untiered'})`
    );
  }

  private onCivilianSaved(event: GameEventOf<'CivilianSaved'>): void {
    if (!event.byPlayer) return;
    this.apply(-this.tuning.boredomPerCivilianSaved, 'civilianSaved', event.entityId);
  }

  /**
   * Boredom added by one instant kill.
   *
   * A god-tier kill still adds `boredomTopTierRetention` of the full amount —
   * winning is never interesting here, it is only ever less uninteresting.
   */
  trivialKillDelta(tier: ThreatTier | undefined): number {
    const triviality = trivialityOf(tier);
    const floor = this.tuning.boredomTopTierRetention;
    return this.tuning.boredomPerTrivialKill * (floor + (1 - floor) * triviality);
  }

  /* ---------------------------------------------------------------------- */
  /* Heroism                                                                */
  /* ---------------------------------------------------------------------- */

  /** Report an act of heroism. The only thing that lowers the meter. */
  reportHeroism(kind: HeroismKind, detail = ''): number {
    const magnitude =
      kind === 'arrivedInTime'
        ? this.tuning.boredomPerCivilianSaved
        : kind === 'bodyBlock'
          ? this.tuning.boredomPerBodyBlock
          : kind === 'debrisCaught'
            ? this.tuning.boredomPerDebrisCaught
            : kind === 'cleanVictory'
              ? this.tuning.boredomPerCleanVictory
              : this.tuning.boredomPerChallenge;
    return this.apply(-magnitude, HEROISM_REASON[kind], detail === '' ? kind : detail);
  }

  /* ---------------------------------------------------------------------- */
  /* Per-frame                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Advance idle rise and baseline decay.
   *
   * @param dt      seconds since the last frame
   * @param inCombat true while an encounter is live; suppresses the idle rise
   *                 so a long fight is never mistaken for standing around.
   */
  update(dt: number, inCombat: boolean): void {
    if (dt <= 0) return;
    this.time += dt;

    if (inCombat) {
      this.sinceEvent = 0;
    } else {
      this.sinceEvent += dt;
      if (this.sinceEvent >= this.tuning.boredomIdleAfterSeconds) {
        const rise = this.tuning.boredomIdleRatePerSecond * dt;
        if (rise > 0) this.apply(rise, 'idle', 'nothing is happening', false);
      }
    }

    // Heroism credit unwinds back toward the ambient mood. Only upward, and
    // only while below the baseline: this must never cancel out a kill.
    if (this.belowBaseline && this.current < this.tuning.boredomBaseline) {
      const step = Math.min(
        this.tuning.boredomDecayRatePerSecond * dt,
        this.tuning.boredomBaseline - this.current
      );
      if (step > 0) this.apply(step, 'decay', 'the relief wears off', false);
    } else if (this.current >= this.tuning.boredomBaseline) {
      this.belowBaseline = false;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Core                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Move the meter, and report it once the move is worth reporting.
   *
   * THE DELTA IS ALWAYS APPLIED. Only the emission is quantised, against
   * `lastReported` rather than against the previous frame — so a thousand
   * frames of sub-epsilon idle drift still add up to a real rise and still
   * produce exactly one event per `boredomEmitEpsilon` of movement.
   *
   * Reporting `previous: lastReported` keeps the (previous -> value) chain
   * continuous for a consumer that integrates it, which is what the audio
   * arrangement thinner does.
   */
  private apply(delta: number, reason: BoredomReason, detail: string, resetIdle = true): number {
    if (delta === 0) return 0;
    const previous = this.current;
    const next = clamp01(previous + delta);
    if (next === previous) return 0;

    this.current = next;
    if (resetIdle) this.sinceEvent = 0;
    if (delta < 0) this.belowBaseline = true;

    if (Math.abs(next - this.lastReported) < this.tuning.boredomEmitEpsilon) {
      // Banked, not lost.
      return next - previous;
    }

    const reported = this.lastReported;
    this.lastReported = next;
    this.bus.emit('BoredomChanged', { value: next, previous: reported, reason });
    if (this.keepLog) {
      this.entries.push({ time: this.time, delta: next - reported, value: next, reason, detail });
    }
    return next - previous;
  }

  /** Force a value, e.g. loading a save. Always reports. */
  set(value: number, reason: BoredomReason = 'decay'): void {
    const previous = this.current;
    const next = clamp01(value);
    if (next === previous) return;
    this.current = next;
    const reported = this.lastReported;
    this.lastReported = next;
    this.bus.emit('BoredomChanged', { value: next, previous: reported, reason });
  }

  dispose(): void {
    for (const off of this.unsubscribes) off();
    this.unsubscribes.length = 0;
  }
}
