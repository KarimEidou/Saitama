/**
 * GAMEPLAY INTERFACE CONTRACT
 *
 * Owned by: combat, destruction, progression and quest workstreams.
 * Consumed by: player, monsters, world destruction, HUD.
 *
 * TYPE-ONLY file. No runtime exports.
 */

import type * as THREE from 'three';
import type { IUpdatable, IDisposable } from './engine';
import type { IActor, IEntity, EntityId, ThreatTier, Faction } from './entity';

/* -------------------------------------------------------------------------- */
/* Combat — punches                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A single punch/impact event. Emitted by the player or any melee attacker and
 * consumed by the combat system, the destruction system and VFX.
 *
 * The signature move of the game: `power` is deliberately unbounded so a
 * "Serious Punch" can carry values orders of magnitude above a normal hit.
 */
export interface IPunchEvent {
  /** World-space origin of the impact (usually the fist position). */
  readonly origin: THREE.Vector3;
  /** Unit vector along the punch. Drives knockback and shockwave orientation. */
  readonly direction: THREE.Vector3;
  /**
   * Raw damage/force magnitude. Normal hits sit in the 10–1000 band;
   * serious punches can exceed 1e6. Consumers must not assume an upper bound.
   */
  readonly power: number;
  /** Effective radius of the impact in metres. */
  readonly radius: number;
  /** Who threw it. Undefined for environmental impacts. */
  readonly source?: IActor;
  /** Which punch variant, for VFX/audio/animation selection. */
  readonly kind: PunchKind;
  /** Seconds since boot when the punch landed. */
  readonly time: number;
  /** Whether a cone/shockwave extends beyond `radius` along `direction`. */
  readonly shockwave?: IShockwave;
  /** Whether this hit should ignore invulnerability frames. */
  readonly unblockable?: boolean;
}

/** Punch variants. Drives animation, VFX intensity and camera shake. */
export type PunchKind =
  | 'normal'
  | 'consecutive'
  | 'heavy'
  | 'uppercut'
  | 'slam'
  | 'serious'
  | 'seriousTableflip'
  | 'environmental';

/** Directional shockwave propagating from an impact. */
export interface IShockwave {
  /** Length of the cone in metres. */
  readonly range: number;
  /** Half-angle of the cone in radians. Use Math.PI for omnidirectional. */
  readonly angle: number;
  /** Force applied at the origin; falls off with distance. */
  readonly force: number;
  /** Whether the shockwave destroys terrain/buildings in its path. */
  readonly destroysTerrain: boolean;
}

/* -------------------------------------------------------------------------- */
/* Damage                                                                     */
/* -------------------------------------------------------------------------- */

/** Damage classification, used for resistances and VFX. */
export type DamageType = 'blunt' | 'slash' | 'pierce' | 'energy' | 'explosive' | 'environmental';

/** A resolved damage application. */
export interface IDamageInfo {
  readonly amount: number;
  readonly type: DamageType;
  readonly source?: IActor;
  /** Impact point in world space. */
  readonly point: THREE.Vector3;
  /** Knockback impulse in newton-seconds. */
  readonly impulse: THREE.Vector3;
  /** True when this hit came from a critical/finisher. */
  readonly critical: boolean;
}

/** Anything that can receive damage. */
export interface IDamageable {
  /** Current hit points. */
  readonly health: number;
  /** Maximum hit points. */
  readonly maxHealth: number;
  /** False once destroyed/dead. */
  readonly isAlive: boolean;
  /** Multiplier per damage type; 1.0 is neutral, 0 is immune. */
  readonly resistances?: Partial<Record<DamageType, number>>;
  /**
   * Apply damage. Returns the amount actually applied after resistances.
   * Implementations must clamp health at 0 and fire death exactly once.
   */
  applyDamage(info: IDamageInfo): number;
}

/* -------------------------------------------------------------------------- */
/* Destruction                                                                */
/* -------------------------------------------------------------------------- */

/** How a destructible breaks apart. */
export type DestructionMode = 'shatter' | 'topple' | 'collapse' | 'vaporise' | 'dent';

/** World geometry that can be broken by combat. */
export interface IDestructible extends IDamageable {
  /** Entity/building id this destructible belongs to. */
  readonly id: string;
  /** Structural integrity remaining; reaching 0 triggers destruction. */
  readonly integrity: number;
  /** Integrity at full health. */
  readonly maxIntegrity: number;
  /** Minimum punch `power` that can damage this at all. */
  readonly damageThreshold: number;
  /** How it comes apart. */
  readonly destructionMode: DestructionMode;
  /** True once fully destroyed. */
  readonly isDestroyed: boolean;
  /** Number of debris pieces to spawn on destruction. */
  readonly debrisCount: number;

  /** Resolve a punch against this object. Returns integrity removed. */
  applyPunch(punch: IPunchEvent): number;
  /** Force immediate destruction, skipping integrity. */
  destroy(punch?: IPunchEvent): void;
  /** Restore to pristine state. Used on chunk reload. */
  repair(): void;
}

/* -------------------------------------------------------------------------- */
/* Combat system                                                              */
/* -------------------------------------------------------------------------- */

/** Central combat resolver. One instance. */
export interface ICombatSystem extends IUpdatable, IDisposable {
  /**
   * Resolve a punch: query overlapping actors and destructibles, apply damage,
   * spawn VFX and camera shake. Returns everything the punch affected.
   */
  resolvePunch(punch: IPunchEvent): IPunchResult;
  /** Register a destructible so punches can find it. */
  registerDestructible(target: IDestructible, bounds: THREE.Box3): void;
  /** Deregister on chunk unload. */
  unregisterDestructible(id: string): void;
  /** Direct single-target damage, bypassing spatial queries. */
  applyDirectDamage(target: IDamageable, info: IDamageInfo): number;
  /** Subscribe to resolved punches (VFX, audio, screen shake, quest hooks). */
  onPunch(cb: (result: IPunchResult) => void): () => void;
  /** Subscribe to actor deaths (progression, quests, spawner cleanup). */
  onKill(cb: (victim: IActor, killer?: IActor) => void): () => void;
}

/** What a punch actually hit. */
export interface IPunchResult {
  readonly punch: IPunchEvent;
  /** Actors damaged, with the amount each took. */
  readonly actorsHit: readonly { actor: IActor; damage: number; killed: boolean }[];
  /** Destructibles damaged. */
  readonly destructiblesHit: readonly { target: IDestructible; damage: number }[];
  /** True when nothing was in range. */
  readonly whiffed: boolean;
  /** Suggested camera shake amplitude in 0..1, derived from power. */
  readonly cameraShake: number;
}

/* -------------------------------------------------------------------------- */
/* Progression — Hero Association rank                                        */
/* -------------------------------------------------------------------------- */

/**
 * Hero Association class. Ascending: C < B < A < S.
 * (Saitama famously begins at C-class, rank 388.)
 */
export type HeroClass = 'C' | 'B' | 'A' | 'S';

/**
 * A hero's standing. `rank` is 1-based and LOWER IS BETTER within a class —
 * S-class rank 1 is the strongest hero alive.
 */
export interface IHeroRank {
  /** Class bracket. */
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

/** Player progression state. */
export interface IProgressionState {
  readonly rank: IHeroRank;
  /** Total monsters defeated, bucketed by threat tier. */
  readonly killsByTier: Record<ThreatTier, number>;
  /** Civilians rescued. */
  readonly civiliansSaved: number;
  /** Cumulative property damage in currency units — lowers reputation. */
  readonly propertyDamage: number;
  /** Public reputation 0..100; affects NPC reactions and rank gain. */
  readonly reputation: number;
  /** Completed quest ids. */
  readonly completedQuests: readonly string[];
  /** Total play time in seconds. */
  readonly playTimeSeconds: number;
}

/* -------------------------------------------------------------------------- */
/* Quests                                                                     */
/* -------------------------------------------------------------------------- */

/** Quest lifecycle. */
export type QuestState = 'locked' | 'available' | 'active' | 'completed' | 'failed';

/** Objective kinds understood by the quest tracker. */
export type QuestObjectiveKind =
  | 'defeat'
  | 'defeatTier'
  | 'reach'
  | 'rescue'
  | 'survive'
  | 'protect'
  | 'destroy'
  | 'talk';

/** A single trackable objective within a quest. */
export interface IQuestObjective {
  readonly id: string;
  readonly kind: QuestObjectiveKind;
  /** Player-facing text, e.g. "Defeat the Mosquito Girl". */
  readonly description: string;
  /** Target count (kills, rescues, seconds survived). */
  readonly required: number;
  /** Progress so far. */
  current: number;
  /** Whether `current >= required`. */
  readonly complete: boolean;
  /** Context-dependent target: monster spec id, actor id, or quest marker id. */
  readonly targetId?: string;
  /** World position for the HUD waypoint marker. */
  readonly location?: THREE.Vector3;
  /** Metres from `location` that counts as arrival, for 'reach'. */
  readonly radius?: number;
  /** Hidden from the objective list until unlocked. */
  readonly hidden?: boolean;
}

/** A quest / hero-association mission. */
export interface IQuest {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Current lifecycle state. */
  state: QuestState;
  /** Ordered objectives. */
  readonly objectives: readonly IQuestObjective[];
  /** Threat level of the incident; gates by hero class. */
  readonly threatTier: ThreatTier;
  /** Minimum hero class required to accept. */
  readonly requiredClass?: HeroClass;
  /** Quest ids that must be completed first. */
  readonly prerequisites?: readonly string[];
  /** Hero points granted on completion. */
  readonly rewardPoints: number;
  /** Reputation delta on completion. */
  readonly rewardReputation: number;
  /** Optional time limit in seconds; failure when it elapses. */
  readonly timeLimitSeconds?: number;
  /** Where the quest begins. */
  readonly location?: THREE.Vector3;
  /** True when every non-hidden objective is complete. */
  readonly isComplete: boolean;
}

/** Quest tracking system. */
export interface IQuestSystem extends IUpdatable {
  readonly quests: ReadonlyMap<string, IQuest>;
  readonly activeQuests: readonly IQuest[];
  /** Move a quest to 'active'. Returns false if prerequisites are unmet. */
  accept(questId: string): boolean;
  /** Abandon an active quest. */
  abandon(questId: string): void;
  /** Report progress towards an objective. */
  reportProgress(kind: QuestObjectiveKind, targetId: string | undefined, amount: number): void;
  /** Subscribe to quest state changes. */
  onStateChange(cb: (quest: IQuest, previous: QuestState) => void): () => void;
}

/* -------------------------------------------------------------------------- */
/* Day / night cycle                                                          */
/* -------------------------------------------------------------------------- */

/** Named phases derived from `timeOfDay`, for spawn tables and audio. */
export type DayPhase = 'dawn' | 'morning' | 'noon' | 'afternoon' | 'dusk' | 'night' | 'midnight';

/**
 * Current time-of-day state. Published by the day/night system and consumed by
 * lighting, skybox, NPC schedules and monster spawn rates.
 */
export interface IDayNightState {
  /** Normalised time of day in [0,1). 0 = midnight, 0.5 = noon. */
  readonly timeOfDay: number;
  /** Named phase derived from `timeOfDay`. */
  readonly phase: DayPhase;
  /** Whole in-game days elapsed since the campaign began. */
  readonly dayCount: number;
  /** Real seconds per in-game day. */
  readonly dayLengthSeconds: number;
  /** Unit vector pointing FROM the sun TOWARDS the world. */
  readonly sunDirection: THREE.Vector3;
  /** Sun elevation in radians; negative means below the horizon. */
  readonly sunElevation: number;
  /** Sun intensity in 0..1, 0 at night. */
  readonly sunIntensity: number;
  /** Moon intensity in 0..1, 0 during the day. */
  readonly moonIntensity: number;
  /** Ambient/sky colour for the current phase. */
  readonly ambientColor: THREE.Color;
  /** Direct light colour for the current phase. */
  readonly sunColor: THREE.Color;
  /** True while street lights and building windows should be lit. */
  readonly streetLightsOn: boolean;
}

/** Day/night driver. */
export interface IDayNightSystem extends IUpdatable {
  readonly state: IDayNightState;
  /** Jump to a normalised time of day in [0,1). */
  setTimeOfDay(t: number): void;
  /** Multiplier on the passage of time; 1 is normal, 0 pauses. */
  timeScale: number;
}

/* -------------------------------------------------------------------------- */
/* Save data                                                                  */
/* -------------------------------------------------------------------------- */

/** Serialisable save payload. Versioned so migrations stay possible. */
export interface ISaveGame {
  readonly version: number;
  readonly savedAt: string;
  readonly worldSeed: number;
  readonly progression: IProgressionState;
  readonly playerPosition: { x: number; y: number; z: number };
  readonly playerYaw: number;
  readonly timeOfDay: number;
  readonly dayCount: number;
  readonly questStates: Record<string, QuestState>;
  readonly questProgress: Record<string, Record<string, number>>;
}

/* -------------------------------------------------------------------------- */
/* Targeting helpers                                                          */
/* -------------------------------------------------------------------------- */

/** Spatial query used by combat and AI. */
export interface ITargetQuery {
  readonly origin: THREE.Vector3;
  readonly radius: number;
  readonly faction?: Faction;
  /** Exclude these entity ids from results. */
  readonly exclude?: readonly EntityId[];
  /** Cone half-angle in radians; omit for a sphere query. */
  readonly coneAngle?: number;
  /** Cone axis; required when `coneAngle` is set. */
  readonly direction?: THREE.Vector3;
  /** Require unobstructed line of sight. */
  readonly requireLineOfSight?: boolean;
  /** Cap on returned results, nearest first. */
  readonly limit?: number;
}

/** Result row from a target query. */
export interface ITargetHit {
  readonly entity: IEntity;
  readonly distance: number;
  readonly point: THREE.Vector3;
}
