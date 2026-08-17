/**
 * BOREDOM — the systems answer to an invincible protagonist.
 *
 * ── THE PROBLEM ────────────────────────────────────────────────────────────
 * A character who cannot lose has no stakes, and a game with no stakes has no
 * pressure to shape play. Every other solution to this is a lie the player can
 * see: secretly weaken him, invent an enemy who is somehow an exception, or
 * gate him behind a stamina bar. All three contradict the premise.
 *
 * Boredom takes the premise seriously instead. He really can win any fight
 * instantly — and doing so costs him the only thing he has left to lose.
 *
 * ── OWNERSHIP ──────────────────────────────────────────────────────────────
 * COMBAT is the authority on boredom RISING: it knows what a trivial victory
 * is, because it knows how long the fight lasted and how hard it was. This
 * module CONSUMES `BoredomChanged` and treats combat's number as truth.
 *
 * What it adds is the other half: boredom DRAINS ONLY THROUGH HEROISM. Not
 * through waiting, not through levelling, not through a shop. Arriving before
 * a civilian dies. Body-blocking for Mumen Rider. Catching debris that was
 * about to land on someone. Finishing without wrecking the street. Every
 * entry in `HEROISM_BOREDOM_RELIEF` is negative and there is no other way
 * down, because "wait it out" is exactly the character's problem.
 *
 * ── WHAT IT GATES ──────────────────────────────────────────────────────────
 *   THROTTLES RANK GAIN — down to 15% at maximum. A throttle, not a wall: the
 *   player can see the numbers moving badly and act on it.
 *   LOCKS FUN FIGHTS    — above 0.72 the encounters that would actually have
 *   been interesting stop appearing. Nothing feels fun when you are numb, and
 *   this is the one place the design lets the fiction have a mechanical veto.
 */

import type { BoredomChangedEvent, IEventBus } from '@/types';
import { clamp01, createLogger } from '@/util';
import {
  BOREDOM_FUN_FIGHT_LOCK,
  BOREDOM_RANK_EXPONENT,
  BOREDOM_RANK_FLOOR,
  HEROISM_BOREDOM_RELIEF,
  type HeroicDeed,
} from './constants';

const log = createLogger('gameplay.boredom');

/** Reason strings the shared `BoredomChanged` event permits. */
type BoredomReason = BoredomChangedEvent['reason'];

/** A recorded act of heroism, for the HUD and for the harness readout. */
export interface IHeroicRecord {
  readonly deed: HeroicDeed;
  readonly delta: number;
  /** Scaled seconds when it happened. */
  readonly time: number;
  readonly detail?: string;
}

export interface IBoredomOptions {
  readonly bus?: IEventBus;
  readonly initial?: number;
  /** Cap on the heroism log. Older entries are dropped. */
  readonly historyLimit?: number;
}

/**
 * Owns the boredom value, consumes combat's changes, and applies heroism.
 *
 * ── RE-ENTRANCY ────────────────────────────────────────────────────────────
 * This class both LISTENS to `BoredomChanged` and EMITS it. Without a guard
 * that is an infinite loop on the first heroic deed. The `applying` flag makes
 * the handler ignore exactly the events this instance emitted, and nothing
 * else — dropping all self-emitted events by identity instead would break the
 * moment a second consumer legitimately echoes one.
 */
export class BoredomModel {
  private readonly bus: IEventBus | undefined;
  private readonly historyLimit: number;
  private readonly history: IHeroicRecord[] = [];
  private readonly unsubscribe: (() => void) | undefined;

  private value: number;
  private applying = false;
  private elapsed = 0;

  constructor(options: IBoredomOptions = {}) {
    this.bus = options.bus;
    this.value = clamp01(options.initial ?? 0);
    this.historyLimit = options.historyLimit ?? 64;

    this.unsubscribe = this.bus?.on('BoredomChanged', (event) => {
      // Combat is the authority on boredom rising; adopt its value verbatim.
      // Ignore the echo of our own emissions.
      if (this.applying) return;
      this.value = clamp01(event.value);
    });
  }

  /** 0..1, where 1 is utterly bored. */
  get boredom(): number {
    return this.value;
  }

  /** Every heroic act recorded this session, newest last. */
  get heroicHistory(): readonly IHeroicRecord[] {
    return this.history;
  }

  /**
   * Multiplier applied to every hero-point award.
   *
   * At 0 boredom it is 1.0; at 1 it is `BOREDOM_RANK_FLOOR`. The exponent
   * keeps mild boredom nearly harmless so the player is punished for actually
   * checking out, not for a slow afternoon.
   */
  get rankGainMultiplier(): number {
    const t = Math.pow(clamp01(this.value), BOREDOM_RANK_EXPONENT);
    return 1 - (1 - BOREDOM_RANK_FLOOR) * t;
  }

  /** False once boredom has locked the encounters that would have been fun. */
  get funFightsAvailable(): boolean {
    return this.value < BOREDOM_FUN_FIGHT_LOCK;
  }

  /** Advance the internal clock used to timestamp heroic records. */
  update(dt: number): void {
    this.elapsed += dt;
  }

  /** Overwrite without emitting. For save loading only. */
  restore(value: number): void {
    this.value = clamp01(value);
  }

  /**
   * Apply a delta and publish it.
   *
   * @returns the change actually applied after clamping, which is 0 when
   *          boredom is already pinned at an end of the range.
   */
  apply(delta: number, reason: BoredomReason): number {
    const previous = this.value;
    const next = clamp01(previous + delta);
    if (next === previous) return 0;
    this.value = next;

    this.applying = true;
    try {
      this.bus?.emit('BoredomChanged', { value: next, previous, reason });
    } finally {
      this.applying = false;
    }
    return next - previous;
  }

  /**
   * Record an act of heroism and drain boredom by its authored amount.
   *
   * THE ONLY WAY DOWN. If a second one is ever added, it belongs in
   * `HEROISM_BOREDOM_RELIEF` beside these, not as a special case here.
   */
  recordHeroicDeed(deed: HeroicDeed, detail?: string): number {
    const delta = HEROISM_BOREDOM_RELIEF[deed];
    const applied = this.apply(delta, reasonFor(deed));
    this.history.push({ deed, delta: applied, time: this.elapsed, detail });
    if (this.history.length > this.historyLimit) this.history.shift();
    if (applied !== 0) {
      log.debug(`heroism "${deed}"${detail ? ` (${detail})` : ''} -> boredom ${this.value.toFixed(3)}`);
    }
    return applied;
  }

  dispose(): void {
    this.unsubscribe?.();
  }
}

/**
 * Map a heroic deed onto one of the reasons the shared event permits.
 *
 * `BoredomChangedEvent.reason` is a closed union in `types/events.ts`, which
 * this workstream does not own. Rather than smuggle a new string past the
 * type, the deed is projected onto the nearest sanctioned reason and the full
 * detail stays in `heroicHistory`.
 */
function reasonFor(deed: HeroicDeed): BoredomReason {
  switch (deed) {
    case 'arrivedInTime':
    case 'unwitnessedRescue':
      return 'civilianSaved';
    case 'bodyBlock':
    case 'caughtDebris':
      return 'restraintBonus';
    case 'zeroCollateral':
    case 'alliesStanding':
      return 'challengingFight';
    default:
      return 'restraintBonus';
  }
}
