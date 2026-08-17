/**
 * CROWD — INTERNAL VOCABULARY
 *
 * The cross-system contracts (`IActor`, `INPCBehaviour`, `GameEvent`) live in
 * `@/types`. This file is how the crowd system talks to itself.
 *
 * ── ONE RULE ABOUT DEPENDENCIES ───────────────────────────────────────────
 * The crowd never imports the monster system, the combat system, the city or
 * the roster. It learns about threats two ways and two ways only:
 *
 *   1. `IThreatSource` records pushed in by the bootstrap each frame — live
 *      monster positions, which nothing else can deliver without a hard
 *      dependency;
 *   2. events on the bus — `ShockwaveFired`, `ChunkDetached`, `PlayerLanded`,
 *      `EncounterStarted/Ended`, `EntityKilled`.
 *
 * That is what lets this system be built, tested and shipped while the monster
 * workstream is still empty.
 */

import type * as THREE from 'three';
import type { BodyArchetype, EntityId, Faction, ThreatTier } from '@/types';

/* -------------------------------------------------------------------------- */
/* Tiers and moods                                                            */
/* -------------------------------------------------------------------------- */

/** Which simulation tier an agent is in. */
export type CrowdTier = 'near' | 'mid' | 'far';

/**
 * What a civilian is doing.
 *
 * `gawk` is not a filler state. In this source material a monster the size of
 * an office block lands in the street and half the crowd takes their phone
 * out — the fact that the danger is obvious and they stay anyway IS the joke,
 * and it is also what makes the collateral damage land. Expect it to be the
 * most populated mood at moderate alarm.
 */
export type CivilianMood = 'commute' | 'gawk' | 'flee' | 'cower' | 'down';

/** Body archetypes the instanced crowd is built from, one draw call each. */
export interface ICrowdArchetype {
  readonly index: number;
  readonly seed: number;
  readonly archetype: BodyArchetype;
  /** Standing height in metres, used to place nameplates and scale steps. */
  readonly height: number;
}

/* -------------------------------------------------------------------------- */
/* Threats                                                                    */
/* -------------------------------------------------------------------------- */

/** Something the crowd is afraid of. */
export interface IThreatSource {
  readonly id: EntityId;
  /** Live world position. Read every frame; not copied. */
  readonly position: THREE.Vector3;
  /** 0..1 scare factor. Derived from `ThreatTier` for monsters. */
  readonly intensity: number;
  /** Present when the threat is a monster. */
  readonly tier?: ThreatTier;
}

/** A transient scare — an explosion, a shockwave, a building coming down. */
export interface IAlarmImpulse {
  x: number;
  z: number;
  /** Peak intensity at the centre. */
  intensity: number;
  /** Metres the seed reaches. */
  radius: number;
  /** Seconds of life remaining. */
  remaining: number;
}

/* -------------------------------------------------------------------------- */
/* Obstacles                                                                  */
/* -------------------------------------------------------------------------- */

/** An axis-aligned building footprint in world XZ. */
export interface IObstacleRect {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  /** Metres. Used only for the audio/visual read, never for navigation. */
  readonly height: number;
}

/* -------------------------------------------------------------------------- */
/* Save / lose accounting                                                     */
/* -------------------------------------------------------------------------- */

/** Why a civilian left the simulation. */
export type OutcomeKind = 'saved' | 'lost';

/**
 * One resolved civilian outcome, with the line-of-sight detail that
 * `CivilianSavedEvent` has no field for.
 *
 * The ranking system scores WITNESSED saves. The event contract cannot carry
 * that flag without a change to `src/types/`, which no single workstream may
 * make, so it travels two ways instead: folded into `reputationDelta` (which
 * ranking already reads) and kept verbatim here, queryable off the system.
 */
export interface ICivilianOutcome {
  readonly kind: OutcomeKind;
  readonly entityId: EntityId;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Seconds since the system started. */
  readonly time: number;
  /** The player rescued them / the player's collateral killed them. */
  readonly byPlayer: boolean;
  /** The player had unobstructed line of sight when it happened. */
  readonly witnessedByPlayer: boolean;
  /** How many other civilians had line of sight. */
  readonly bystanders: number;
  /** Reputation actually emitted, after witness scaling. */
  readonly reputationDelta: number;
  /** Peak alarm this civilian experienced. Zero means they were never in danger. */
  readonly peakAlarm: number;
}

/* -------------------------------------------------------------------------- */
/* Hero allies                                                                */
/* -------------------------------------------------------------------------- */

/** Which named ally. */
export type HeroNpcId = 'genos' | 'mumenRider' | 'tatsumaki';

/**
 * A line an ally says, surfaced for the subtitle/VO layer.
 *
 * Not an event: `GameEvent` is a closed union and dialogue is not a
 * cross-system concern. Anything that wants these subscribes directly.
 */
export interface IHeroCallout {
  readonly heroId: HeroNpcId;
  readonly displayName: string;
  /** Stable key for VO lookup. */
  readonly key: string;
  readonly line: string;
  readonly time: number;
}

/** Per-frame snapshot of an ally, for the HUD and for tests. */
export interface IHeroStatus {
  readonly id: EntityId;
  readonly heroId: HeroNpcId;
  readonly displayName: string;
  readonly health: number;
  readonly maxHealth: number;
  readonly faction: Faction;
  readonly state: string;
  readonly isDead: boolean;
  /** Times this ally has been knocked down and got back up. */
  readonly reEngagements: number;
}

/* -------------------------------------------------------------------------- */
/* Telemetry                                                                  */
/* -------------------------------------------------------------------------- */

/** Everything the debug HUD and the verification harness read. */
export interface ICrowdStats {
  readonly near: number;
  readonly mid: number;
  readonly far: number;
  readonly total: number;
  /** Mood histogram over simulated agents. */
  readonly moods: Readonly<Record<CivilianMood, number>>;
  /** 0..1 density feeding `ambience.crowd`. */
  readonly density: number;
  /** Peak alarm anywhere in the simulated band, 0..1. */
  readonly peakAlarm: number;
  /** Milliseconds of CPU the last `update` cost, excluding skinning. */
  readonly simMs: number;
  /** Milliseconds the last alarm tick cost. */
  readonly alarmMs: number;
  /** Milliseconds the last flow rebuild cost. */
  readonly flowMs: number;
  readonly saved: number;
  readonly lost: number;
  readonly witnessedSaves: number;
}
