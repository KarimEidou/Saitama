/**
 * THE HUD MODEL
 *
 * One plain, mutable object holding everything any screen renders. No DOM, no
 * three, no event bus — which is why the whole thing is unit-testable in Node
 * and why the store that maintains it can be exercised without a browser.
 *
 * ── WHY A SINGLE MODEL AND NOT PER-SCREEN STATE ────────────────────────────
 * Three screens show the boredom value and four show the rank. Held separately
 * they drift, and the bug is always the same: the pause menu shows last
 * minute's rank because it subscribed and the HUD re-read. One object, written
 * in one place, read by everyone.
 *
 * ── WHY IT IS MUTABLE ──────────────────────────────────────────────────────
 * This is written up to sixty times a second on a phone. An immutable model
 * would allocate a new object graph per frame and hand the GC a steady stream
 * of garbage during exactly the moments the frame budget is tightest. The
 * screens diff against their own last-rendered values instead; that diff is
 * what `FrameWriter` deduplicates.
 */

import type { GamePhase, HeroClass, LethalIntent, DayPhase, ThreatTier, QuestState } from '@/types';
import { DEFAULT_HUD_SETTINGS, type IHudSettings } from './settings-model';

/* -------------------------------------------------------------------------- */
/* Rank                                                                       */
/* -------------------------------------------------------------------------- */

/** The player's standing. */
export interface IRankState {
  heroName: string;
  heroClass: HeroClass;
  rank: number;
  points: number;
  pointsToNextRank: number;
  /**
   * Boredom's throttle on positive point awards, 0.15 .. 1.
   *
   * Shown, not hidden. A player who cannot see the multiplier concludes the
   * ranking system is broken; a player who can see it concludes the CHARACTER
   * is, which is the intended reading.
   */
  rankGainMultiplier: number;
  reputation: number;
}

/** One line of the rank board's recent-movement feed. */
export interface IRankMovement {
  readonly id: number;
  /** Scaled seconds when it happened. */
  readonly time: number;
  /** Points added or removed AFTER the boredom throttle. */
  readonly delta: number;
  /** Why. Short enough to sit on one line at phone width. */
  readonly reason: string;
  readonly heroClass: HeroClass;
  readonly rank: number;
  /** Seats gained (positive) or lost (negative) on the ladder. */
  readonly seats: number;
}

/**
 * A rival's standing, as the rank board draws it.
 *
 * ── THE EVENT-SHAPE GAP ────────────────────────────────────────────────────
 * `RankChangedEvent` carries no hero id: it is unambiguously the PLAYER's rank
 * event, and progression deliberately did not forge a shared event other
 * systems would misread. So rivals arrive through
 * `RivalTracker.onRivalRankChanged` and are pushed into the model by the
 * bootstrap via `HudStore.setRivals`. The HUD subscribes to the bus for
 * everything the bus carries and takes an explicit push for the one thing it
 * does not.
 */
export interface IRivalRow {
  readonly id: string;
  readonly displayName: string;
  readonly heroClass: HeroClass;
  readonly rank: number;
  /** Ladder seats ABOVE the player. Negative means below. */
  readonly seatsAbovePlayer: number;
  /** Points banked at incidents the player was also at. */
  readonly sharedCredit: number;
  /** Points banked while the player was at the supermarket. */
  readonly offscreenCredit: number;
  readonly jointIncidents: number;
  /** Set for one board refresh after they moved, so the row can flash. */
  readonly moved?: 'up' | 'down';
}

/* -------------------------------------------------------------------------- */
/* Encounter                                                                  */
/* -------------------------------------------------------------------------- */

/** The fight currently happening. */
export interface IEncounterState {
  id: string;
  /** Display name; falls back to the tier when the monster is unnamed. */
  name: string;
  tier: ThreatTier;
  isBoss: boolean;
  /** Seconds since `EncounterStarted`. */
  elapsed: number;
  civiliansSaved: number;
  civiliansLost: number;
  /**
   * Live property damage in YEN.
   *
   * Pushed by combat, not derived: `ChunkDetached.collateralCost` is in the
   * destruction system's own unit and multiplying it by a yen rate here would
   * be a four-order-of-magnitude unit error that silently looks plausible.
   */
  collateralYen: number;
  /** `propertyDamageScore`, 0..1. THE FIELD THE METER READS. */
  collateralScore: number;
  /** Fracture chunks detached this encounter. Counted straight off the bus. */
  debrisPieces: number;
  /** Kilograms of it. */
  debrisMassKg: number;
  /** Civilians with line of sight. Credit needs an audience. */
  witnesses: number;
  /** Boss bar; absent for ordinary fights. */
  bossHealth?: number;
  bossPhase?: number;
}

/** The end-of-fight invoice. Mirrors `IEncounterResult` plus what rank did. */
export interface IEncounterInvoice {
  readonly encounterId: string;
  readonly name: string;
  readonly tier: ThreatTier;
  readonly victory: boolean;
  readonly timeToKill: number;
  readonly civiliansSaved: number;
  readonly civiliansLost: number;
  readonly alliesSaved: number;
  readonly alliesDowned: number;
  readonly propertyDamageYen: number;
  readonly propertyDamageScore: number;
  readonly witnessed: number;
  readonly kills: number;
  readonly seriousPunches: number;
  readonly normalPunches: number;
  readonly longestChain: number;
  readonly boredomBefore: number;
  readonly boredomAfter: number;
  /** Points the incident was worth before the boredom throttle. */
  readonly basePoints: number;
  /** Points actually banked. */
  readonly awardedPoints: number;
  /** Rival name -> points they banked for the same fight. */
  readonly rivalCredit: readonly { readonly name: string; readonly points: number }[];
  /** Ladder seats moved. Negative is a demotion. */
  readonly seats: number;
}

/* -------------------------------------------------------------------------- */
/* Quests                                                                     */
/* -------------------------------------------------------------------------- */

/** One objective line. */
export interface IQuestObjectiveRow {
  readonly id: string;
  readonly description: string;
  readonly current: number;
  readonly required: number;
  readonly complete: boolean;
  readonly hidden: boolean;
}

/** A quest as the log and the tracker draw it. */
export interface IQuestRow {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly state: QuestState;
  readonly tier: ThreatTier;
  readonly objectives: readonly IQuestObjectiveRow[];
  /** Seconds left, when the quest is timed. */
  readonly timeRemaining?: number;
  readonly timeLimitSeconds?: number;
  /** Ordinary life rather than hero work. The supermarket. */
  readonly errand: boolean;
  /** Quest ids this one ends if completed. Drawn as an explicit warning. */
  readonly conflictsWith?: readonly string[];
  /** Metres to the objective, when known. */
  readonly distance?: number;
  /** Camera-relative bearing in radians, for the tracker's arrow. */
  readonly bearing?: number;
  readonly rewardPoints: number;
}

/**
 * How loudly a timed quest should be shouting.
 *
 * The thresholds are deliberately generous: a 150-second tunnel evacuation
 * spends its last 45 seconds in `critical`, which is long enough to actually
 * change what the player does and short enough not to be background noise.
 */
export type QuestUrgency = 'none' | 'soon' | 'critical';

export function questUrgency(quest: IQuestRow): QuestUrgency {
  if (quest.state !== 'active' || quest.timeRemaining === undefined) return 'none';
  if (quest.timeRemaining <= 45) return 'critical';
  if (quest.timeRemaining <= 120) return 'soon';
  return 'none';
}

/**
 * Quest ordering for the log.
 *
 * Active before available before finished; inside active, the one with the
 * least time left first. An evacuation with 30 seconds on it outranks a
 * dragon-tier subjugation with no clock, always.
 */
export function compareQuests(a: IQuestRow, b: IQuestRow): number {
  const stateRank = (q: IQuestRow): number =>
    q.state === 'active' ? 0 : q.state === 'available' ? 1 : q.state === 'failed' ? 3 : 2;
  const byState = stateRank(a) - stateRank(b);
  if (byState !== 0) return byState;
  const aTime = a.timeRemaining ?? Infinity;
  const bTime = b.timeRemaining ?? Infinity;
  if (aTime !== bTime) return aTime - bTime;
  return a.title.localeCompare(b.title);
}

/* -------------------------------------------------------------------------- */
/* Alerts and markers                                                         */
/* -------------------------------------------------------------------------- */

export type AlertKind = 'threat' | 'rank' | 'quest' | 'info' | 'danger';

/** A transient banner. */
export interface IHudAlert {
  readonly id: number;
  readonly kind: AlertKind;
  readonly title: string;
  readonly body?: string;
  readonly tier?: ThreatTier;
  /** Seconds to remain on screen. */
  readonly duration: number;
  /** Seconds since it was raised. Advanced by the store. */
  age: number;
}

/** Kinds of world-space marker, in draw priority order. */
export type MarkerKind = 'threat' | 'objective' | 'civilian' | 'ally' | 'errand';

/** A diegetic marker pinned to a world position. */
export interface IWorldMarker {
  readonly id: string;
  readonly kind: MarkerKind;
  readonly label: string;
  /** World position. Plain numbers: the model never holds a THREE object. */
  x: number;
  y: number;
  z: number;
  tier?: ThreatTier;
  /** Metres from the camera. Filled in by the marker layer each frame. */
  distance?: number;
  /** 0..1 for markers that carry progress, e.g. an evacuation. */
  progress?: number;
}

/* -------------------------------------------------------------------------- */
/* The model                                                                  */
/* -------------------------------------------------------------------------- */

/** Everything the HUD renders. */
export interface IHudModel {
  phase: GamePhase;
  loading: { progress: number; label: string };

  /** 0..1. The game's real progress bar. */
  boredom: number;
  boredomReason: string;

  /** Punch charge, pushed by the combat/input integration. */
  charge: { ratio: number; charging: boolean; intent: LethalIntent; forecastYen: number };

  rank: IRankState;
  rankFeed: IRankMovement[];
  rivals: IRivalRow[];

  encounter: IEncounterState | null;
  invoice: IEncounterInvoice | null;

  quests: IQuestRow[];
  trackedQuestId: string | undefined;

  alerts: IHudAlert[];
  markers: Map<string, IWorldMarker>;

  time: { timeOfDay: number; phase: DayPhase; dayCount: number };

  settings: IHudSettings;
}

/** A model in its start-of-game state: C-class rank 388, bored by nothing yet. */
export function createHudModel(): IHudModel {
  return {
    phase: 'loading',
    loading: { progress: 0, label: 'Initialising' },
    boredom: 0,
    boredomReason: 'idle',
    charge: { ratio: 0, charging: false, intent: 'normal', forecastYen: 0 },
    rank: {
      heroName: 'Caped Baldy',
      heroClass: 'C',
      rank: 388,
      points: 0,
      pointsToNextRank: 0,
      rankGainMultiplier: 1,
      reputation: 50,
    },
    rankFeed: [],
    rivals: [],
    encounter: null,
    invoice: null,
    quests: [],
    trackedQuestId: undefined,
    alerts: [],
    markers: new Map(),
    time: { timeOfDay: 0.5, phase: 'noon', dayCount: 0 },
    settings: DEFAULT_HUD_SETTINGS,
  };
}

/** How many movements the rank feed remembers. Two screens' worth on a phone. */
export const RANK_FEED_LIMIT = 12;

/** How many alerts may stack. Beyond three nobody reads any of them. */
export const ALERT_LIMIT = 3;
