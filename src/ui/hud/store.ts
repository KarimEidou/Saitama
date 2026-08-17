/**
 * THE HUD STORE
 *
 * Subscribes to the event bus, maintains one {@link IHudModel}, and touches no
 * DOM. Everything visual reads this; nothing writes back into gameplay through
 * it.
 *
 * ── WHAT COMES FROM THE BUS AND WHAT HAS TO BE PUSHED ──────────────────────
 * The architectural rule is that a system never imports another system's
 * implementation, so everything the bus carries is subscribed to here and
 * nothing else is imported. Three things the HUD needs are NOT on the bus, and
 * each is an explicit setter with a reason:
 *
 *   setRivals()       `RankChangedEvent` HAS NO HERO ID. It is the player's
 *                     rank event by construction, and progression declined to
 *                     forge a shared event that other systems would reasonably
 *                     read as the player's. Rival movement therefore arrives
 *                     through `RivalTracker.onRivalRankChanged` and the
 *                     bootstrap forwards it here. This is the known gap; the
 *                     rank board is fed correctly, but only because somebody
 *                     wires the callback.
 *
 *   setCollateral()   The live yen figure. `ChunkDetached.collateralCost` is in
 *                     the destruction system's unit, not yen, and
 *                     `EncounterEnded.collateralCost` carries that same unit
 *                     deliberately. Converting it here would need combat's
 *                     zoning table, which the HUD may not import. So the ticker
 *                     shows yen when combat pushes yen, and shows the debris
 *                     count — which IS on the bus — either way.
 *
 *   setCharge()       Charge ratio lives in the input layer's `ChargeTracker`
 *                     and never reaches the bus, because a value that changes
 *                     every frame has no business being an event.
 *
 * ── WHY POINT DELTAS ARE DERIVED HERE ──────────────────────────────────────
 * `RankChangedEvent` carries the new point TOTAL, not the movement. The feed
 * the rank board draws is movements, so the store keeps the previous total and
 * subtracts. That also means the very first event after a load produces a delta
 * against the loaded total rather than against zero, which is the behaviour a
 * player expects and the naive version gets wrong.
 */

import type {
  DayPhase,
  GameEventOf,
  GamePhase,
  HeroClass,
  IEventBus,
  LethalIntent,
  ThreatTier,
} from '@/types';
import { clamp01 } from '@/util';
import {
  ALERT_LIMIT,
  RANK_FEED_LIMIT,
  createHudModel,
  type IEncounterInvoice,
  type IHudAlert,
  type IHudModel,
  type IQuestRow,
  type IRivalRow,
  type IWorldMarker,
  type AlertKind,
} from './model';
import { TIER_ADVISORY, TIER_LABEL } from './tokens';
import { normaliseSettings, type IHudSettings } from './settings-model';

/** Points below which a rank movement is not worth a line in the feed. */
const FEED_EPSILON = 0.05;

/**
 * Boredom's throttle on positive point awards.
 *
 * Mirrors `BOREDOM_RANK_FLOOR` (0.15) and `BOREDOM_RANK_EXPONENT` (1.35) from
 * `src/gameplay/progression/constants.ts`. It is MIRRORED and not imported
 * because the HUD may not import another system, and it is only ever used to
 * DISPLAY a multiplier the player can already feel. If progression retunes the
 * curve the readout drifts by a few hundredths and nothing breaks — which is
 * the right failure mode for a number that exists to be looked at.
 */
export function displayRankGainMultiplier(boredom: number): number {
  const floor = 0.15;
  const exponent = 1.35;
  return floor + (1 - floor) * (1 - clamp01(boredom) ** exponent);
}

/** A quest row plus the ids it would cancel, as the bootstrap supplies it. */
export interface IHudStoreOptions {
  readonly bus?: IEventBus;
  /** Seeds `model.settings`. */
  readonly settings?: Partial<IHudSettings>;
  /** Called whenever a screen should re-read the model. Coalesced per frame. */
  readonly onDirty?: () => void;
}

export class HudStore {
  readonly model: IHudModel = createHudModel();

  private readonly unsubscribers: (() => void)[] = [];
  private readonly onDirty: (() => void) | undefined;
  private nextAlertId = 1;
  private nextMovementId = 1;
  private lastPoints = 0;
  private encounterStartedAt = 0;
  private clockSeconds = 0;
  private dirtyFlag = false;

  constructor(options: IHudStoreOptions = {}) {
    this.onDirty = options.onDirty;
    this.model.settings = normaliseSettings(options.settings);
    if (options.bus) this.attach(options.bus);
  }

  /* ---------------------------------------------------------------------- */
  /* Bus                                                                    */
  /* ---------------------------------------------------------------------- */

  /** Subscribe to every event the HUD reads. Idempotent per bus. */
  attach(bus: IEventBus): void {
    const on = <T extends Parameters<IEventBus['on']>[0]>(
      type: T,
      handler: (event: GameEventOf<T>) => void
    ): void => {
      this.unsubscribers.push(bus.on(type, handler));
    };

    on('BoredomChanged', (event) => {
      this.model.boredom = clamp01(event.value);
      this.model.boredomReason = event.reason;
      this.model.rank.rankGainMultiplier = displayRankGainMultiplier(this.model.boredom);
      this.markDirty();
    });

    on('RankChanged', (event) => {
      const rank = this.model.rank;
      const seats = seatDelta(event.previousClass, event.previousRank, event.heroClass, event.rank);
      const delta = event.points - this.lastPoints;
      this.lastPoints = event.points;
      rank.heroClass = event.heroClass;
      rank.rank = event.rank;
      rank.points = event.points;
      if (Math.abs(delta) >= FEED_EPSILON || seats !== 0) {
        this.pushMovement(delta, event.promoted ? 'promotion' : 'assessment', seats);
      }
      if (seats !== 0) {
        this.raiseAlert({
          kind: 'rank',
          title: event.promoted ? 'HERO ASSOCIATION — PROMOTED' : 'HERO ASSOCIATION — DEMOTED',
          body: `${event.previousClass}-${event.previousRank} → ${event.heroClass}-${event.rank}`,
          duration: 5,
        });
      }
      this.markDirty();
    });

    on('EncounterStarted', (event) => {
      this.encounterStartedAt = this.clockSeconds;
      this.model.encounter = {
        id: event.encounterId,
        name: prettyEncounterName(event.encounterId),
        tier: event.threatTier,
        isBoss: event.isBoss,
        elapsed: 0,
        civiliansSaved: 0,
        civiliansLost: 0,
        collateralYen: 0,
        collateralScore: 0,
        debrisPieces: 0,
        debrisMassKg: 0,
        witnesses: 0,
      };
      this.model.invoice = null;
      this.raiseAlert({
        kind: 'threat',
        tier: event.threatTier,
        title: `THREAT LEVEL ${TIER_LABEL[event.threatTier]}`,
        body: TIER_ADVISORY[event.threatTier],
        duration: event.isBoss ? 6 : 4,
      });
      this.markDirty();
    });

    on('EncounterEnded', (event) => {
      const active = this.model.encounter;
      if (active && active.id !== event.encounterId) return;
      this.model.encounter = null;
      this.markDirty();
      void event;
    });

    on('CivilianSaved', (event) => {
      if (this.model.encounter) this.model.encounter.civiliansSaved++;
      void event;
      this.markDirty();
    });

    on('CivilianLost', (event) => {
      if (this.model.encounter) this.model.encounter.civiliansLost++;
      if (event.causedByPlayer) {
        this.raiseAlert({ kind: 'danger', title: 'CIVILIAN LOST', duration: 3 });
      }
      this.markDirty();
    });

    on('ChunkDetached', (event) => {
      const active = this.model.encounter;
      if (!active) return;
      active.debrisPieces++;
      active.debrisMassKg += event.mass;
      this.markDirty();
    });

    on('BossPhaseChanged', (event) => {
      const active = this.model.encounter;
      if (!active) return;
      active.bossPhase = event.phase;
      active.bossHealth = clamp01(event.healthFraction);
      if (event.isFinalPhase) {
        this.raiseAlert({ kind: 'threat', title: 'FINAL PHASE', duration: 3, tier: active.tier });
      }
      this.markDirty();
    });

    on('QuestStateChanged', (event) => {
      const kind: AlertKind = event.state === 'failed' ? 'danger' : 'quest';
      const verb =
        event.state === 'active'
          ? 'ACCEPTED'
          : event.state === 'completed'
            ? 'COMPLETE'
            : event.state === 'failed'
              ? 'FAILED'
              : null;
      if (verb) this.raiseAlert({ kind, title: `${verb} — ${event.title}`, duration: 4 });
      this.markDirty();
    });

    on('TimeOfDayChanged', (event) => {
      this.model.time = {
        timeOfDay: event.timeOfDay,
        phase: event.phase as DayPhase,
        dayCount: event.dayCount,
      };
      this.markDirty();
    });
  }

  dispose(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
  }

  /* ---------------------------------------------------------------------- */
  /* Frame                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Advance time-based model state.
   *
   * The encounter timer is derived from a clock the store owns rather than
   * accumulated per frame, so a dropped frame or a paused tab cannot make a
   * fight look shorter than it was.
   */
  update(dt: number): void {
    this.clockSeconds += dt;
    const encounter = this.model.encounter;
    if (encounter) encounter.elapsed = this.clockSeconds - this.encounterStartedAt;

    if (this.model.alerts.length > 0) {
      let expired = false;
      for (const alert of this.model.alerts) {
        alert.age += dt;
        if (alert.age >= alert.duration) expired = true;
      }
      if (expired) {
        this.model.alerts = this.model.alerts.filter((a) => a.age < a.duration);
        this.markDirty();
      }
    }
  }

  /** True once since the last call, if anything a screen renders changed. */
  consumeDirty(): boolean {
    const was = this.dirtyFlag;
    this.dirtyFlag = false;
    return was;
  }

  private markDirty(): void {
    this.dirtyFlag = true;
    this.onDirty?.();
  }

  /* ---------------------------------------------------------------------- */
  /* Explicit pushes — the things the bus cannot carry                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Rival standings.
   *
   * Wire this to `RivalTracker.onRivalRankChanged`, or call it with
   * `progression.rivalTable()` after any incident. See the class comment for
   * why it is not an event.
   */
  setRivals(rows: readonly IRivalRow[]): void {
    this.model.rivals = [...rows].sort((a, b) => b.seatsAbovePlayer - a.seatsAbovePlayer);
    this.markDirty();
  }

  /** Live collateral. `score` is the bounded 0..1 figure the meter reads. */
  setCollateral(yen: number, score: number): void {
    const encounter = this.model.encounter;
    if (!encounter) return;
    encounter.collateralYen = Math.max(0, yen);
    encounter.collateralScore = clamp01(score);
    this.markDirty();
  }

  /** Live witness count from the crowd system's witness field. */
  setWitnesses(count: number): void {
    if (this.model.encounter) this.model.encounter.witnesses = Math.max(0, Math.round(count));
    this.markDirty();
  }

  /** Punch charge. Called every frame; deliberately does NOT mark dirty. */
  setCharge(ratio: number, charging: boolean, intent: LethalIntent, forecastYen = 0): void {
    const charge = this.model.charge;
    charge.ratio = clamp01(ratio);
    charge.charging = charging;
    charge.intent = intent;
    charge.forecastYen = Math.max(0, forecastYen);
  }

  /** Boss health, for the boss bar. */
  setBoss(health: number, phase: number): void {
    const encounter = this.model.encounter;
    if (!encounter) return;
    encounter.bossHealth = clamp01(health);
    encounter.bossPhase = phase;
    this.markDirty();
  }

  /** Replace the quest list. Cheap enough to call whenever a quest changes. */
  setQuests(rows: readonly IQuestRow[], trackedId?: string): void {
    this.model.quests = [...rows];
    this.model.trackedQuestId = trackedId ?? this.model.trackedQuestId;
    if (
      this.model.trackedQuestId &&
      !this.model.quests.some((q) => q.id === this.model.trackedQuestId)
    ) {
      this.model.trackedQuestId = undefined;
    }
    this.markDirty();
  }

  /** Pin a quest to the tracker. Passing undefined unpins. */
  trackQuest(id: string | undefined): void {
    this.model.trackedQuestId = id;
    this.markDirty();
  }

  /** Publish the end-of-encounter invoice. Shows the results screen. */
  setInvoice(invoice: IEncounterInvoice | null): void {
    this.model.invoice = invoice;
    this.markDirty();
  }

  /** Loading progress, 0..1. */
  setLoading(progress: number, label: string): void {
    this.model.loading = { progress: clamp01(progress), label };
    this.markDirty();
  }

  setPhase(phase: GamePhase): void {
    this.model.phase = phase;
    this.markDirty();
  }

  /** Whole-state rank push, for a save-game load. */
  setRank(rank: Partial<IHudModel['rank']>): void {
    Object.assign(this.model.rank, rank);
    if (typeof rank.points === 'number') this.lastPoints = rank.points;
    this.markDirty();
  }

  setSettings(settings: IHudSettings): void {
    this.model.settings = settings;
    this.markDirty();
  }

  /* ---------------------------------------------------------------------- */
  /* Alerts and markers                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * Raise a banner.
   *
   * Beyond {@link ALERT_LIMIT} the OLDEST is dropped, not the newest: a
   * dragon-level warning arriving while three quest toasts are on screen has to
   * win, and the alternative — refusing the new one — is how players miss the
   * only message that mattered.
   */
  raiseAlert(alert: Omit<IHudAlert, 'id' | 'age'>): number {
    const id = this.nextAlertId++;
    const next = [...this.model.alerts, { ...alert, id, age: 0 }];
    this.model.alerts = next.slice(Math.max(0, next.length - ALERT_LIMIT));
    this.markDirty();
    return id;
  }

  dismissAlert(id: number): void {
    this.model.alerts = this.model.alerts.filter((a) => a.id !== id);
    this.markDirty();
  }

  /** Add or move a world marker. */
  setMarker(marker: IWorldMarker): void {
    this.model.markers.set(marker.id, marker);
    this.markDirty();
  }

  removeMarker(id: string): void {
    if (this.model.markers.delete(id)) this.markDirty();
  }

  clearMarkers(): void {
    if (this.model.markers.size === 0) return;
    this.model.markers.clear();
    this.markDirty();
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  private pushMovement(delta: number, reason: string, seats: number): void {
    this.model.rankFeed.unshift({
      id: this.nextMovementId++,
      time: this.clockSeconds,
      delta,
      reason,
      heroClass: this.model.rank.heroClass,
      rank: this.model.rank.rank,
      seats,
    });
    if (this.model.rankFeed.length > RANK_FEED_LIMIT) {
      this.model.rankFeed.length = RANK_FEED_LIMIT;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const CLASS_INDEX: Readonly<Record<HeroClass, number>> = { C: 0, B: 1, A: 2, S: 3 };

/**
 * Seats gained between two standings, positive for a climb.
 *
 * Uses only the CLASS ORDER and the within-class rank, never a global seat
 * number — the HUD does not know the class sizes and must not guess them. So a
 * class change reports as a class change (a full class is worth more than any
 * within-class movement) rather than as a fabricated seat count.
 */
export function seatDelta(
  previousClass: HeroClass,
  previousRank: number,
  heroClass: HeroClass,
  rank: number
): number {
  const classStep = CLASS_INDEX[heroClass] - CLASS_INDEX[previousClass];
  if (classStep !== 0) return classStep * 1000;
  return previousRank - rank;
}

/**
 * `encounter.deepSeaKing` -> `Deep Sea King`.
 *
 * A fallback, not a localisation strategy: whoever owns the monster gets to
 * push a real display name. This exists so an unnamed encounter shows something
 * a human can read instead of an id.
 */
export function prettyEncounterName(encounterId: string): string {
  const tail = encounterId.split('.').pop() ?? encounterId;
  const spaced = tail.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A tier's position in the severity order, for sorting alerts. */
export function tierSeverity(tier: ThreatTier): number {
  return ['wolf', 'tiger', 'demon', 'dragon', 'god'].indexOf(tier);
}
