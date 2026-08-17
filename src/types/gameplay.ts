/**
 * GAMEPLAY CONTRACT
 *
 * Progression, Hero Association rank, quests, the day/night cycle and saves.
 *
 * TYPE-ONLY file. No runtime exports.
 *
 * NOTE: combat primitives (punches, damage, hits) live in combat.ts and
 * breakable geometry in destruction.ts — this file deliberately does not
 * redeclare them.
 */

import type * as THREE from 'three';
import type { IUpdatable } from './engine';
import type { ThreatTier } from './combat';

/* -------------------------------------------------------------------------- */
/* Hero Association rank                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Hero Association class, ascending: C < B < A < S.
 * (The protagonist famously begins at C-class, rank 388.)
 */
export type HeroClass = 'C' | 'B' | 'A' | 'S';

/**
 * A hero's standing.
 *
 * `rank` is 1-based and LOWER IS BETTER within a class — S-class rank 1 is the
 * strongest hero alive. Do not sort ascending by `rank` across classes without
 * also comparing `heroClass`.
 */
export interface IHeroRank {
  readonly heroClass: HeroClass;
  /** Position within the class; 1 is the top. */
  readonly rank: number;
  /** Accumulated hero points driving promotion. */
  readonly points: number;
  /** Points required to reach the next rank up. */
  readonly pointsToNextRank: number;
  /** Registered hero alias. */
  readonly heroName: string;
}

/* -------------------------------------------------------------------------- */
/* Progression                                                                */
/* -------------------------------------------------------------------------- */

/** Player progression state. */
export interface IProgressionState {
  readonly rank: IHeroRank;
  /** Monsters defeated, bucketed by threat tier. */
  readonly killsByTier: Readonly<Record<ThreatTier, number>>;
  readonly civiliansSaved: number;
  readonly civiliansLost: number;
  /** Cumulative property damage in currency units; lowers reputation. */
  readonly propertyDamage: number;
  /** Public reputation 0..100; affects NPC reactions and rank gain. */
  readonly reputation: number;
  /**
   * Boredom 0..1. Rises with trivial victories, falls with genuine challenge
   * and restraint-based play. The systemic expression of being unbeatable.
   */
  readonly boredom: number;
  readonly completedQuests: readonly string[];
  readonly playTimeSeconds: number;
}

/** Progression driver. Listens to kill/rescue events and updates rank. */
export interface IProgressionSystem extends IUpdatable {
  readonly state: IProgressionState;
  /** Award hero points, possibly triggering a promotion. */
  addPoints(points: number, reason: string): void;
  /** Adjust reputation, clamped to 0..100. */
  addReputation(delta: number): void;
  /** Adjust boredom, clamped to 0..1. */
  addBoredom(delta: number, reason: string): void;
  /** Record collateral damage cost. */
  addPropertyDamage(cost: number): void;
}

/* -------------------------------------------------------------------------- */
/* Quests                                                                     */
/* -------------------------------------------------------------------------- */

/** Quest lifecycle. */
export type QuestState = 'locked' | 'available' | 'active' | 'completed' | 'failed';

/** Objective kinds understood by the quest tracker. */
export type QuestObjectiveKind =
  'defeat' | 'defeatTier' | 'reach' | 'rescue' | 'survive' | 'protect' | 'destroy' | 'talk';

/** A single trackable objective. */
export interface IQuestObjective {
  readonly id: string;
  readonly kind: QuestObjectiveKind;
  /** Player-facing text, e.g. "Defeat the Mosquito Girl". */
  readonly description: string;
  /** Target count: kills, rescues, or seconds survived. */
  readonly required: number;
  /** Progress so far. */
  current: number;
  /** Whether `current >= required`. */
  readonly complete: boolean;
  /** Monster spec id, actor id, or marker id, depending on `kind`. */
  readonly targetId?: string;
  /** World position for the HUD waypoint. */
  readonly location?: THREE.Vector3;
  /** Metres from `location` counting as arrival, for 'reach'. */
  readonly radius?: number;
  /** Hidden from the objective list until unlocked. */
  readonly hidden?: boolean;
}

/** A quest / Hero Association mission. */
export interface IQuest {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  state: QuestState;
  readonly objectives: readonly IQuestObjective[];
  /** Threat level of the incident. */
  readonly threatTier: ThreatTier;
  /** Minimum hero class required to accept. */
  readonly requiredClass?: HeroClass;
  /** Quest ids that must be completed first. */
  readonly prerequisites?: readonly string[];
  readonly rewardPoints: number;
  readonly rewardReputation: number;
  /** Optional time limit in seconds; failure when it elapses. */
  readonly timeLimitSeconds?: number;
  readonly location?: THREE.Vector3;
  /** True when every non-hidden objective is complete. */
  readonly isComplete: boolean;
}

/** Quest tracking system. */
export interface IQuestSystem extends IUpdatable {
  readonly quests: ReadonlyMap<string, IQuest>;
  readonly activeQuests: readonly IQuest[];
  /** Quest shown in the HUD tracker. */
  trackedQuestId?: string;

  /** Move a quest to 'active'. Returns false if prerequisites are unmet. */
  accept(questId: string): boolean;
  /** Abandon an active quest. */
  abandon(questId: string): void;
  /** Report progress towards matching objectives. */
  reportProgress(kind: QuestObjectiveKind, targetId: string | undefined, amount: number): void;
  /** Subscribe to state changes. Returns an unsubscribe fn. */
  onStateChange(cb: (quest: IQuest, previous: QuestState) => void): () => void;
}

/* -------------------------------------------------------------------------- */
/* Day / night                                                                */
/* -------------------------------------------------------------------------- */

/** Named phases derived from `timeOfDay`, for spawn tables and audio. */
export type DayPhase = 'dawn' | 'morning' | 'noon' | 'afternoon' | 'dusk' | 'night' | 'midnight';

/**
 * Time-of-day state. Consumed by lighting, skybox, NPC schedules and monster
 * spawn rates. The derived lighting values live in `ILightingState`
 * (render.ts); this is the authoritative clock.
 */
export interface IDayNightState {
  /** Normalised 0..1; 0 is midnight, 0.5 noon. */
  readonly timeOfDay: number;
  readonly phase: DayPhase;
  /** Whole in-game days elapsed. */
  readonly dayCount: number;
  /** Real seconds per in-game day. */
  readonly dayLengthSeconds: number;
  /** Unit vector pointing FROM the sun TOWARDS the world. */
  readonly sunDirection: THREE.Vector3;
  /** Sun elevation in radians; negative is below the horizon. */
  readonly sunElevation: number;
  /** 0..1, 0 at night. */
  readonly sunIntensity: number;
  /** 0..1, 0 during the day. */
  readonly moonIntensity: number;
  readonly ambientColor: THREE.Color;
  readonly sunColor: THREE.Color;
  /** True while street lights and window emissives should be lit. */
  readonly streetLightsOn: boolean;
}

/** Day/night driver. */
export interface IDayNightSystem extends IUpdatable {
  readonly state: IDayNightState;
  /** Jump to a normalised time of day in 0..1. */
  setTimeOfDay(t: number): void;
  /** Multiplier on the passage of time; 1 is normal, 0 freezes it. */
  timeScale: number;
}

/* -------------------------------------------------------------------------- */
/* Saves                                                                      */
/* -------------------------------------------------------------------------- */

/** Serialisable save payload. Versioned so migrations remain possible. */
export interface ISaveGame {
  readonly version: number;
  /** ISO-8601 timestamp. */
  readonly savedAt: string;
  /** Regenerates an identical world. */
  readonly worldSeed: number;
  readonly progression: IProgressionState;
  readonly playerPosition: { readonly x: number; readonly y: number; readonly z: number };
  readonly playerYaw: number;
  readonly timeOfDay: number;
  readonly dayCount: number;
  readonly questStates: Readonly<Record<string, QuestState>>;
  /** questId -> objectiveId -> progress. */
  readonly questProgress: Readonly<Record<string, Record<string, number>>>;
}
