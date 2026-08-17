/**
 * MONSTER — INTERNAL VOCABULARY
 *
 * The cross-system contracts (`IMonsterSpec`, `IMonster`, `IStateMachine`,
 * `GameEvent`) live in `@/types`. This file is how the monster system talks to
 * itself, and it is deliberately PLAIN DATA: `Vec3`, `EntityId`, numbers. No
 * `three`, no scene nodes, no live entity handles.
 *
 * ── WHY PLAIN DATA, WHEN THIS IS AN ENTITY SYSTEM ─────────────────────────
 * Behaviour and geometry are two different workstreams here. The roster owns
 * every monster's mesh, material and face; this module owns what the monster
 * DOES. Keeping the brain in `Vec3` means the whole FSM, the spawn director
 * and all four boss scripts can be unit-tested with no renderer, no GPU and no
 * character factory present — and it means a monster's behaviour survives its
 * mesh being rebuilt underneath it.
 *
 * The one place a scene node appears is `monster.ts`, which adapts a brain to
 * the `IMonster`/`IActor` contract and optionally attaches an
 * `ICharacterInstance`. Everything below that line is arithmetic.
 *
 * ── THE ONE RULE THAT MATTERS MOST IN THIS FILE ───────────────────────────
 * `IBossPhase` is the boss kill gate. Saitama's punch carries `LethalIntent`,
 * not damage, and any lethal hit on a non-boss is an instant kill. A boss dies
 * to the identical punch — but only once its scripted phase resolves, which is
 * a TIMER/NARRATIVE gate and never an HP gate. `phaseResolved` below is that
 * gate's public face, and `BossPhaseChanged { isFinalPhase: true }` is how it
 * reaches the combat resolver. Nothing here may ever advance a phase because a
 * boss ran out of health.
 */

import type {
  ClipName,
  DistrictType,
  EntityId,
  Faction,
  IAnimationSet,
  IMonsterSpec,
  ThreatTier,
  Vec3,
} from '@/types';

/* -------------------------------------------------------------------------- */
/* States                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The shared monster state machine.
 *
 *   idle → alerted → pursue → attack → stagger → dead
 *
 * Six states, one machine, every monster in the game — the archetype supplies
 * the numbers, never a new state. `hit` is deliberately NOT a state: a flinch
 * that does not interrupt is an animation event, and a flinch that does
 * interrupt is `stagger`. Two states for one idea is how a machine acquires an
 * unreachable corner.
 */
export type MonsterState = 'idle' | 'alerted' | 'pursue' | 'attack' | 'stagger' | 'dead';

/** Every state, in canonical order. Iteration order is stable. */
export const MONSTER_STATES: readonly MonsterState[] = Object.freeze([
  'idle',
  'alerted',
  'pursue',
  'attack',
  'stagger',
  'dead',
]);

/**
 * How a monster gets around, which decides how it approaches and whether it
 * can be reached by a ground-level jab at all.
 *
 * `flying` exists because of Mosquito Girl: a target that never touches the
 * ground is the one thing a 1.2 m melee reach genuinely cannot answer, so the
 * player has to either jump or spend a serious punch. That is a real test, and
 * it is worth one enum member.
 */
export type MonsterMotion = 'ground' | 'flying' | 'burrowing' | 'aquatic';

/* -------------------------------------------------------------------------- */
/* Attacks                                                                    */
/* -------------------------------------------------------------------------- */

/** What an attack does when it becomes active. */
export type MonsterAttackKind =
  /** Contact swing. Reach is short; the monster must close. */
  | 'melee'
  /** A projected beam or bolt. Reaches across the arena; wrecks cover. */
  | 'ranged'
  /** A radial burst centred on the monster. */
  | 'slam'
  /** A committed rush that closes distance and hits on arrival. */
  | 'charge'
  /** Spawns minions rather than dealing a blow. */
  | 'summon';

/**
 * One attack in an archetype's set.
 *
 * ── TELEGRAPH IS A FIRST-CLASS FIELD ──────────────────────────────────────
 * `windupSeconds` is not animation padding. The player cannot be hurt, so a
 * monster attack's only job is to be READABLE — a wind-up the player can see
 * and choose to interrupt is the difference between a monster and a hazard.
 * Every attack here has a non-zero wind-up for that reason.
 */
export interface IMonsterAttack {
  /** Stable id, unique within the archetype. */
  readonly id: string;
  readonly kind: MonsterAttackKind;
  /** Maximum distance at which this attack can be started, in metres. */
  readonly rangeMetres: number;
  /** Minimum distance; below it the monster backs off instead. 0 for most. */
  readonly minRangeMetres: number;
  /** Cone half-angle the target must be inside to start, in radians. */
  readonly halfAngleRad: number;
  /** Seconds of readable wind-up before the attack becomes active. */
  readonly windupSeconds: number;
  /** Seconds the attack is live. */
  readonly activeSeconds: number;
  /** Seconds of recovery after the active window, during which it is open. */
  readonly recoverySeconds: number;
  /** Seconds before this attack may be used again. */
  readonly cooldownSeconds: number;
  /** Selection weight when several attacks are legal. Higher wins more often. */
  readonly weight: number;
  /** Animation slot to play. Drives `IAnimationSet`. */
  readonly clip: ClipName;
  /**
   * Pressure released when the attack goes active, as a `ShockwaveFired`
   * cone: length in metres, half-angle in radians, unbounded `power`.
   *
   * Monsters do not deal damage through this module. They release PRESSURE,
   * and the systems that own the victims (crowd, physics, destruction, VFX)
   * decide what that means — which is the only arrangement that lets those
   * four workstreams and this one be built at the same time.
   */
  readonly waveRangeMetres: number;
  readonly waveHalfAngleRad: number;
  readonly wavePower: number;
  /** Minions released, for `kind: 'summon'`. */
  readonly summonArchetypeId?: string;
  readonly summonCount?: number;
}

/* -------------------------------------------------------------------------- */
/* Movement                                                                   */
/* -------------------------------------------------------------------------- */

/** How an archetype moves once it has decided where to go. */
export interface IMovementProfile {
  /** Metres per second while alerted but not committed. */
  readonly walkSpeed: number;
  /** Metres per second in pursuit. */
  readonly runSpeed: number;
  /** Metres per second squared. */
  readonly acceleration: number;
  /** Radians per second of turn authority. */
  readonly turnRateRad: number;
  /**
   * Sideways drift as a fraction of forward speed, resampled every
   * `erraticPeriodSeconds`. 0 is a freight train; 0.9 is a mosquito.
   */
  readonly erratic: number;
  /** Seconds between erratic-drift resamples. */
  readonly erraticPeriodSeconds: number;
  /** Cruising altitude above ground in metres. 0 for ground motion. */
  readonly hoverHeightMetres: number;
  /** Metres of vertical bob for flyers. */
  readonly bobAmplitudeMetres: number;
  /** Metres the monster tries to keep from its target while circling. */
  readonly standoffMetres: number;
}

/* -------------------------------------------------------------------------- */
/* Archetypes                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A monster, as data.
 *
 * Extends the shared `IMonsterSpec` contract rather than replacing it, so
 * everything the rest of the game already knows how to read — tier, asset key,
 * reward points, spawn districts — keeps its canonical field name, and the
 * behaviour-only fields are additive. New monsters are rows in
 * `archetypes.ts`; none of them require a line of code.
 */
export interface IMonsterArchetype extends IMonsterSpec {
  readonly motion: MonsterMotion;
  readonly movement: IMovementProfile;
  /** Ordered attack set. Selection is by range, cooldown and weight. */
  readonly attacks: readonly IMonsterAttack[];
  /** Standing height in metres. Drives audio formants and nameplate offset. */
  readonly bodyHeightMetres: number;
  /** Mass in kilograms. Turns knockback delta-v into newton-seconds. */
  readonly massKg: number;
  /** Bounding radius in metres, for broad-phase queries. */
  readonly radiusMetres: number;
  /** Metres at which a lost target is finally given up on. */
  readonly loseAggroMetres: number;
  /** Vision cone half-angle in radians. Hearing is omnidirectional. */
  readonly visionHalfAngleRad: number;
  /** Metres at which a loud event is noticed regardless of facing. */
  readonly hearingMetres: number;
  /** Seconds a lost target is remembered before the monster de-escalates. */
  readonly memorySeconds: number;
  /** Seconds spent staggered after an interrupting hit. */
  readonly staggerSeconds: number;
  /**
   * Damage fraction of `maxHealth` that interrupts into `stagger`.
   *
   * Saitama's hits never reach this branch — they kill outright — so this is
   * how a monster reacts to Genos, Mumen Rider and falling masonry.
   */
  readonly staggerFraction: number;
  /** Seconds between idle roars. `monster.roar` is formant-sized by body. */
  readonly roarPeriodSeconds: number;
  /** True when this archetype is only ever placed by a boss script. */
  readonly summonOnly: boolean;
}

/* -------------------------------------------------------------------------- */
/* Perception                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Something a monster can notice and chase.
 *
 * Pushed in by the host each frame, exactly as the crowd system takes
 * `IThreatSource`. A monster never queries the player controller, the hero NPC
 * system or the spawner — it is handed a list of positions and factions, which
 * is all a brain needs and all this module is allowed to know.
 */
export interface IMonsterTarget {
  readonly id: EntityId;
  readonly faction: Faction;
  /** Live world position. Read every frame; never copied or retained. */
  readonly position: Vec3;
  /** False once downed. A dead target is dropped on the next think. */
  readonly alive: boolean;
  /**
   * Priority multiplier over distance-based selection. The player reads 1;
   * an ally worth protecting reads higher so monsters converge on them, which
   * is what puts Mumen Rider in danger without scripting it.
   */
  readonly priority: number;
}

/**
 * The host's view, injected. Everything the brain cannot compute itself.
 *
 * Every member is optional except `targets` and `time`, and each absent one
 * degrades to a defensible default: no line of sight test means open ground,
 * no ring lookup means everything is streamed in, no district lookup means
 * residential. A brain must run in a unit test with nothing wired up.
 */
export interface IMonsterWorld {
  /** Seconds since boot. Monotonic. */
  readonly time: number;
  /** Everything a monster may notice, refreshed by the host each frame. */
  readonly targets: readonly IMonsterTarget[];
  /** Unobstructed line of sight between two points. Absent = open ground. */
  readonly lineOfSight?: (from: Vec3, to: Vec3) => boolean;
  /** Ground height under a point, for flyers and for spawn snapping. */
  readonly groundHeight?: (x: number, z: number) => number;
  /** Streaming ring at a position: 0 = R0, 1 = R1, 2 = R2, 3 = impostors. */
  readonly ringAt?: (position: Vec3) => number;
  /** District under a position, for spawn zoning. */
  readonly districtAt?: (position: Vec3) => DistrictType;
}

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                */
/* -------------------------------------------------------------------------- */

/** Per-frame snapshot of one monster, for the HUD, the harness and tests. */
export interface IMonsterSnapshot {
  readonly id: EntityId;
  readonly archetypeId: string;
  readonly displayName: string;
  readonly tier: ThreatTier;
  readonly motion: MonsterMotion;
  readonly state: MonsterState;
  readonly previousState: MonsterState | undefined;
  readonly timeInState: number;
  readonly position: Vec3;
  readonly yaw: number;
  readonly health: number;
  readonly maxHealth: number;
  readonly targetId: EntityId | undefined;
  readonly targetDistance: number;
  /** Attack currently being executed, if any. */
  readonly attackId: string | undefined;
  /** Phase of that attack. */
  readonly attackPhase: 'windup' | 'active' | 'recovery' | undefined;
  readonly isBoss: boolean;
  /** True only for a boss whose scripted encounter has resolved. */
  readonly phaseResolved: boolean;
  readonly clip: ClipName;
}

/* -------------------------------------------------------------------------- */
/* Boss encounters                                                            */
/* -------------------------------------------------------------------------- */

/** What a scripted phase is testing the player on. */
export type BossPhaseKind =
  /** Opening beat: the boss is introduced and the arena is established. */
  | 'arena'
  /** The boss releases minions; the phase is about the swarm, not the boss. */
  | 'swarm'
  /** Sustained ranged fire. The phase is about cover and about closing. */
  | 'bombardment'
  /** A timed beat with an ally's life on it. */
  | 'rescue'
  /** Incoming damage the player must simply endure for a fixed duration. */
  | 'survival'
  /** The gate is open. One punch ends it. */
  | 'finisher';

/**
 * One scripted phase of a boss encounter.
 *
 * ── HOW A PHASE ADVANCES, AND HOW IT MUST NOT ─────────────────────────────
 * A phase ends when BOTH of its conditions are satisfied:
 *
 *   • `durationSeconds` of ENGAGED time has elapsed, where engaged means the
 *     player is inside `engageRadiusMetres` — so a player who runs away does
 *     not advance the fight by waiting, and a player who never shows up does
 *     not skip to the finisher;
 *   • `hitsToAdvance` hits have landed on the boss, and — when
 *     `requireSummonsCleared` is set — every minion this phase released is
 *     dead.
 *
 * Health is not among those conditions and never will be. A boss that died at
 * 0 HP would be merely tough, and "merely tough" is the one thing this game
 * cannot have: the joke only works if the punch that ends the fight is the
 * same punch that would have ended it in the first second.
 */
export interface IBossPhase {
  readonly id: string;
  readonly kind: BossPhaseKind;
  /** Human-readable beat name, for the HUD and the harness. */
  readonly title: string;
  /** Seconds of engaged time before the phase may end. */
  readonly durationSeconds: number;
  /** Hits the boss must absorb before the phase may end. */
  readonly hitsToAdvance: number;
  /** Metres within which the player counts as engaged. */
  readonly engageRadiusMetres: number;
  /** Minions released on entry. */
  readonly summonArchetypeId?: string;
  readonly summonCount?: number;
  /** When true, every minion released by this phase must die first. */
  readonly requireSummonsCleared?: boolean;
  /**
   * Seconds between scripted pressure pulses during the phase, e.g. Boros's
   * meteoric burst or Vaccine Man's beam cadence. 0 disables them.
   */
  readonly pulsePeriodSeconds: number;
  /** Cone of one pulse. */
  readonly pulseRangeMetres: number;
  readonly pulseHalfAngleRad: number;
  readonly pulsePower: number;
  /**
   * Seconds after phase entry at which a registered ally is defeated, unless
   * the player has reached them. `undefined` disables the beat entirely.
   *
   * This is the Deep Sea King's whole design, expressed as one number.
   */
  readonly allyDownAtSeconds?: number;
  /** Metres the player must come within to save the ally. */
  readonly allyRescueRadiusMetres?: number;
}

/** A named boss encounter, as data. */
export interface IBossScript {
  /** Stable encounter id, e.g. 'boss.deepSeaKing'. */
  readonly encounterId: string;
  /** Archetype the boss itself is built from. */
  readonly archetypeId: string;
  readonly title: string;
  /** Encounter radius in metres, for `EncounterStarted`. */
  readonly arenaRadiusMetres: number;
  /** Phases in order. The last one is the finisher and opens the gate. */
  readonly phases: readonly IBossPhase[];
  /** One-line statement of what this encounter is testing. Design intent. */
  readonly tests: string;
}

/** Live state of a boss encounter. Read by the HUD, the harness and tests. */
export interface IBossPhaseState {
  readonly encounterId: string;
  readonly bossId: EntityId;
  readonly phaseIndex: number;
  readonly phaseId: string;
  readonly kind: BossPhaseKind;
  readonly title: string;
  /** Seconds of ENGAGED time accumulated in this phase. */
  readonly elapsed: number;
  /** Seconds of engaged time still required, 0 once satisfied. */
  readonly remaining: number;
  readonly hits: number;
  readonly hitsRequired: number;
  readonly summonsAlive: number;
  readonly isFinalPhase: boolean;
  /**
   * THE GATE. False means a `LethalIntent` punch is absorbed; true means the
   * same punch kills. Mirrors `ICombatTarget.phaseResolved`, which the combat
   * resolver reads, and which is set from the `BossPhaseChanged` event this
   * encounter emits when it flips.
   */
  readonly phaseResolved: boolean;
  /** True once the boss is dead and the encounter has closed. */
  readonly finished: boolean;
  /** Whether the registered ally is still standing. */
  readonly allySurvived: boolean;
  /** Seconds until the ally is defeated, when a beat is pending. */
  readonly allyDownIn: number | undefined;
}

/* -------------------------------------------------------------------------- */
/* Spawning                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The spawn director's pacing state.
 *
 * A city that is always fighting is exhausting and a city that never fights is
 * a walking simulator, so the director cycles rather than sampling a constant
 * rate. `lull` is not dead air — it is where the crowd, the traffic and the
 * skyline get to be the content.
 */
export type SpawnPacingState = 'lull' | 'build' | 'peak' | 'cooldown';

/** One monster the director wants placed. Plain data; the host builds it. */
export interface ISpawnOrder {
  /** Monotonic, unique per director. Also seeds the monster's own stream. */
  readonly serial: number;
  readonly archetypeId: string;
  readonly tier: ThreatTier;
  readonly position: Vec3;
  readonly yaw: number;
  readonly district: DistrictType;
  /** Streaming ring the position falls in. Never 2 or 3. */
  readonly ring: number;
  /** Wave this order belongs to, for grouping into one encounter. */
  readonly waveId: number;
  /** Metres from the streaming focus at the moment of the order. */
  readonly distanceFromFocus: number;
}

/** Everything the director reads. Tunable, all in one place. */
export interface ISpawnPolicy {
  /** Hard cap on live director-spawned monsters. Boss minions do not count. */
  readonly maxActive: number;
  /** Cap per threat tier, so the world cannot fill with dragons. */
  readonly maxPerTier: Readonly<Record<ThreatTier, number>>;
  /** Monsters in one wave, by pacing state. */
  readonly waveSizeByState: Readonly<Record<SpawnPacingState, number>>;
  /** Seconds each pacing state lasts. */
  readonly stateSecondsByState: Readonly<Record<SpawnPacingState, number>>;
  /** Seconds between waves within a state. */
  readonly waveIntervalSeconds: number;
  /**
   * Nearest a monster may appear to the streaming focus, in metres.
   *
   * The player must never turn around into a monster that was not there a
   * moment ago: it reads as a bug even when it is a spawn, and it is the one
   * failure mode that makes an open world feel cheap.
   */
  readonly minSpawnDistanceMetres: number;
  /** Furthest a monster may appear. Beyond this it would never be found. */
  readonly maxSpawnDistanceMetres: number;
  /** Metres two spawned monsters must keep apart. */
  readonly spawnSeparationMetres: number;
  /**
   * Highest streaming ring a spawn may land in.
   *
   * 1 (R1) — R2 carries no NPCs and no colliders, so a monster there would
   * pathfind through a merged block mesh with nothing to collide against and
   * nobody to threaten. It would also be invisible: R2 is a single merged
   * LOD2 mesh with the skinned crowd already stripped.
   */
  readonly maxSpawnRing: number;
  /** Metres from the world origin past which nothing spawns. */
  readonly worldRadiusMetres: number;
  /** Attempts per order before the director gives up on this wave. */
  readonly placementAttempts: number;
  /** Seconds a monster may go unseen and un-engaged before being recycled. */
  readonly staleSeconds: number;
  /** Metres past which an idle monster is recycled regardless of age. */
  readonly recycleDistanceMetres: number;
}

/** Per-district tier weighting. Rows need not sum to 1. */
export type DistrictTierWeights = Readonly<Record<DistrictType, Readonly<Record<ThreatTier, number>>>>;

/** Live director state, for the HUD and the harness. */
export interface ISpawnDirectorStats {
  readonly pacing: SpawnPacingState;
  readonly secondsInState: number;
  readonly active: number;
  readonly activeByTier: Readonly<Record<ThreatTier, number>>;
  readonly waves: number;
  readonly ordersIssued: number;
  readonly ordersRejected: number;
  /** Why the last rejection happened. Diagnostics only. */
  readonly lastRejection: string | undefined;
  readonly nextWaveIn: number;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** A writable vector, for fill-in-place accessors that must not allocate. */
export interface IMutableVec3 {
  x: number;
  y: number;
  z: number;
}

/** Re-exported so callers do not reach past this module for the vocabulary. */
export type {
  ClipName,
  DistrictType,
  EntityId,
  Faction,
  IAnimationSet,
  IMonsterSpec,
  ThreatTier,
  Vec3,
};
