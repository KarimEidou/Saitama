/**
 * EVENT BUS CONTRACT
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE ARCHITECTURAL RULE OF THIS CODEBASE
 *
 *  Systems import ONLY from `src/types/` and `src/util/`.
 *  A system must NEVER import another system's implementation module.
 *  All cross-system communication goes through this event bus.
 *
 *  Concretely: the destruction system does not import the quest system to
 *  tell it a building fell; it emits `ChunkDetached` and the quest system
 *  subscribes. This is what allows dozens of systems to be built in parallel
 *  without colliding, and what keeps any one system removable.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * TYPE-ONLY file. No runtime exports — the concrete bus lives in
 * `src/util/event-bus.ts` and implements `IEventBus` from here.
 *
 * ── PAYLOAD DESIGN RULE ────────────────────────────────────────────────────
 * Payloads carry IDs and PLAIN DATA, never live entity references. This:
 *   • lets the bus be recorded and replayed for deterministic testing,
 *   • prevents handlers retaining despawned entities,
 *   • keeps events cheap to log.
 * Look the entity up via `IEntitySpawner` if you need the live object.
 *
 * Emitters may pass a `THREE.Vector3` wherever `Vec3` is expected (it is
 * structurally compatible). Bus implementations MUST copy vectors on emit —
 * callers reuse scratch vectors between frames.
 */

import type { EntityId, EntityType, Faction } from './entity';
import type { ThreatTier, LethalIntent, DamageType, PunchKind } from './combat';
import type { ChunkKey, IChunkCoord } from './world';
import type { QuestState } from './gameplay';
import type { HeroClass } from './gameplay';
import type { DayPhase } from './gameplay';

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Plain serialisable 3-vector. `THREE.Vector3` satisfies this structurally,
 * so emitters can pass one directly.
 */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Fields every event carries. Stamped by the bus on emit. */
export interface IEventBase {
  /** Scaled seconds since the clock started. */
  readonly time: number;
  /** Frame index the event was emitted on. */
  readonly frame: number;
}

/* -------------------------------------------------------------------------- */
/* Combat events                                                              */
/* -------------------------------------------------------------------------- */

/** A shockwave was released. Drives VFX, audio, camera shake and destruction. */
export interface ShockwaveFiredEvent extends IEventBase {
  readonly type: 'ShockwaveFired';
  readonly origin: Vec3;
  /** Unit propagation axis. */
  readonly direction: Vec3;
  /** Unbounded — a serious punch may exceed 1e6. Clamp before normalising. */
  readonly power: number;
  /** Cone length in metres. */
  readonly range: number;
  /** Cone half-angle in radians; `Math.PI` is omnidirectional. */
  readonly angle: number;
  readonly intent: LethalIntent;
  readonly punchKind: PunchKind;
  /** Who released it. */
  readonly sourceId?: EntityId;
}

/** An entity took damage but survived. */
export interface EntityDamagedEvent extends IEventBase {
  readonly type: 'EntityDamaged';
  readonly entityId: EntityId;
  readonly entityType: EntityType;
  readonly faction: Faction;
  /** Damage actually applied after resistances. */
  readonly amount: number;
  readonly damageType: DamageType;
  readonly intent: LethalIntent;
  /** Health remaining after the hit. */
  readonly healthRemaining: number;
  readonly maxHealth: number;
  readonly point: Vec3;
  readonly attackerId?: EntityId;
  readonly critical: boolean;
}

/** An entity was reduced to 0 health. Fires exactly once per entity. */
export interface EntityKilledEvent extends IEventBase {
  readonly type: 'EntityKilled';
  readonly entityId: EntityId;
  readonly entityType: EntityType;
  readonly faction: Faction;
  readonly position: Vec3;
  readonly killerId?: EntityId;
  /** Present when the victim was a monster. */
  readonly threatTier?: ThreatTier;
  /** Monster spec id, when applicable. */
  readonly specId?: string;
  readonly intent: LethalIntent;
  /** Hero points awarded for this kill. */
  readonly rewardPoints: number;
}

/** A physics impulse was applied. Consumed by physics and ragdolls. */
export interface ImpulseAppliedEvent extends IEventBase {
  readonly type: 'ImpulseApplied';
  /** Entity or debris body affected. */
  readonly targetId: EntityId;
  /** Impulse in newton-seconds. */
  readonly impulse: Vec3;
  /** World-space application point. */
  readonly point: Vec3;
  readonly sourceId?: EntityId;
}

/* -------------------------------------------------------------------------- */
/* Destruction events                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A fracture chunk detached from a structure and became a dynamic body.
 * Emitted once per piece — collapses are staggered, so expect bursts.
 */
export interface ChunkDetachedEvent extends IEventBase {
  readonly type: 'ChunkDetached';
  /** Destructible the piece came from. */
  readonly structureId: string;
  /** Index into the structure's fracture chunk array. */
  readonly chunkIndex: number;
  readonly position: Vec3;
  /** Mass in kilograms. */
  readonly mass: number;
  /** Impulse imparted at detach time. */
  readonly impulse: Vec3;
  /** Material class, for debris audio and particle selection. */
  readonly material: string;
  /** Estimated collateral cost contributed by this piece. */
  readonly collateralCost: number;
}

/* -------------------------------------------------------------------------- */
/* Civilian / ally events                                                     */
/* -------------------------------------------------------------------------- */

/** A civilian was rescued or escaped a threat. Raises reputation. */
export interface CivilianSavedEvent extends IEventBase {
  readonly type: 'CivilianSaved';
  readonly entityId: EntityId;
  readonly position: Vec3;
  /** Rescued directly by the player vs. escaped on their own. */
  readonly byPlayer: boolean;
  readonly reputationDelta: number;
}

/**
 * A civilian died. Lowers reputation — heavily so when the player caused it,
 * which is the main pressure against fighting at full intent in populated
 * districts.
 */
export interface CivilianLostEvent extends IEventBase {
  readonly type: 'CivilianLost';
  readonly entityId: EntityId;
  readonly position: Vec3;
  /** True when the player or their collateral damage was responsible. */
  readonly causedByPlayer: boolean;
  readonly reputationDelta: number;
}

/** A friendly hero NPC was defeated. */
export interface AllyDownedEvent extends IEventBase {
  readonly type: 'AllyDowned';
  readonly entityId: EntityId;
  readonly displayName: string;
  readonly position: Vec3;
  readonly killerId?: EntityId;
}

/* -------------------------------------------------------------------------- */
/* Encounter / boss events                                                    */
/* -------------------------------------------------------------------------- */

/** A scripted or dynamic encounter began. */
export interface EncounterStartedEvent extends IEventBase {
  readonly type: 'EncounterStarted';
  readonly encounterId: string;
  readonly threatTier: ThreatTier;
  readonly position: Vec3;
  /** Encounter radius in metres. */
  readonly radius: number;
  /** Entity ids participating at start. */
  readonly participantIds: readonly EntityId[];
  readonly isBoss: boolean;
}

/** An encounter concluded. */
export interface EncounterEndedEvent extends IEventBase {
  readonly type: 'EncounterEnded';
  readonly encounterId: string;
  readonly outcome: 'victory' | 'defeat' | 'fled' | 'aborted';
  /** Seconds the encounter lasted. */
  readonly duration: number;
  readonly civiliansLost: number;
  readonly collateralCost: number;
}

/** A boss crossed a phase threshold. */
export interface BossPhaseChangedEvent extends IEventBase {
  readonly type: 'BossPhaseChanged';
  readonly entityId: EntityId;
  readonly specId: string;
  readonly previousPhase: number;
  readonly phase: number;
  /** Health fraction 0..1 at the transition. */
  readonly healthFraction: number;
  /** True for the final phase. */
  readonly isFinalPhase: boolean;
}

/* -------------------------------------------------------------------------- */
/* Progression events                                                         */
/* -------------------------------------------------------------------------- */

/** A quest changed lifecycle state. */
export interface QuestStateChangedEvent extends IEventBase {
  readonly type: 'QuestStateChanged';
  readonly questId: string;
  readonly previous: QuestState;
  readonly state: QuestState;
  readonly title: string;
}

/** The player's Hero Association standing changed. */
export interface RankChangedEvent extends IEventBase {
  readonly type: 'RankChanged';
  readonly previousClass: HeroClass;
  readonly heroClass: HeroClass;
  readonly previousRank: number;
  /** Lower is better; S-class rank 1 is the strongest hero alive. */
  readonly rank: number;
  readonly points: number;
  /** True when this was a promotion rather than a demotion. */
  readonly promoted: boolean;
}

/**
 * The protagonist's boredom meter moved.
 *
 * Being unbeatable is the character's central problem, and boredom is the
 * systemic expression of it: winning trivially raises it, genuine challenge
 * and restraint-based play lower it. It gates tone, music and some content.
 */
export interface BoredomChangedEvent extends IEventBase {
  readonly type: 'BoredomChanged';
  /** 0..1, where 1 is utterly bored. */
  readonly value: number;
  readonly previous: number;
  /** What moved it. */
  readonly reason:
    | 'trivialVictory'
    | 'challengingFight'
    | 'restraintBonus'
    | 'idle'
    | 'questComplete'
    | 'civilianSaved'
    | 'decay';
}

/* -------------------------------------------------------------------------- */
/* World events                                                               */
/* -------------------------------------------------------------------------- */

/** A chunk finished loading and was added to the scene. */
export interface ChunkStreamedInEvent extends IEventBase {
  readonly type: 'ChunkStreamedIn';
  readonly key: ChunkKey;
  readonly coord: IChunkCoord;
  /** Milliseconds spent generating/loading. */
  readonly loadTimeMs: number;
  readonly memoryBytes: number;
}

/** A chunk was removed from the scene. */
export interface ChunkStreamedOutEvent extends IEventBase {
  readonly type: 'ChunkStreamedOut';
  readonly key: ChunkKey;
  readonly coord: IChunkCoord;
  /** True when evicted for budget rather than distance. */
  readonly evictedForMemory: boolean;
}

/** The time of day crossed into a new phase. */
export interface TimeOfDayChangedEvent extends IEventBase {
  readonly type: 'TimeOfDayChanged';
  /** Normalised 0..1; 0 is midnight, 0.5 noon. */
  readonly timeOfDay: number;
  readonly phase: DayPhase;
  readonly previousPhase: DayPhase;
  readonly dayCount: number;
}

/* -------------------------------------------------------------------------- */
/* Player events                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The player touched down after a fall or leap. Large `impactSpeed` values
 * produce craters, so destruction listens to this too.
 */
export interface PlayerLandedEvent extends IEventBase {
  readonly type: 'PlayerLanded';
  readonly position: Vec3;
  /** Downward speed at contact, m/s. */
  readonly impactSpeed: number;
  /** Metres fallen. */
  readonly fallHeight: number;
  /** True when the landing was forceful enough to crater the ground. */
  readonly createsCrater: boolean;
  readonly intent: LethalIntent;
}

/* -------------------------------------------------------------------------- */
/* The union                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every event on the bus. Discriminated by `type`.
 *
 * ADDING AN EVENT: append an interface above with a unique `type` literal,
 * then add it to this union. Never change or reuse an existing `type` string.
 */
export type GameEvent =
  | ShockwaveFiredEvent
  | EntityDamagedEvent
  | EntityKilledEvent
  | ImpulseAppliedEvent
  | ChunkDetachedEvent
  | CivilianSavedEvent
  | CivilianLostEvent
  | AllyDownedEvent
  | EncounterStartedEvent
  | EncounterEndedEvent
  | BossPhaseChangedEvent
  | QuestStateChangedEvent
  | RankChangedEvent
  | BoredomChangedEvent
  | ChunkStreamedInEvent
  | ChunkStreamedOutEvent
  | TimeOfDayChangedEvent
  | PlayerLandedEvent;

/** Every valid `type` string. */
export type GameEventType = GameEvent['type'];

/** Narrow the union to the member matching a `type` literal. */
export type GameEventOf<T extends GameEventType> = Extract<GameEvent, { type: T }>;

/**
 * Payload accepted by `emit()`: the event minus the fields the bus stamps
 * itself (`time`, `frame`).
 */
export type GameEventPayload<T extends GameEventType> = Omit<GameEventOf<T>, 'time' | 'frame'>;

/** Handler for a specific event type, receiving the narrowed member. */
export type EventHandler<T extends GameEventType> = (event: GameEventOf<T>) => void;

/* -------------------------------------------------------------------------- */
/* The bus                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Typed publish/subscribe bus.
 *
 * `bus.on('EntityKilled', e => e.threatTier)` — `e` narrows to
 * `EntityKilledEvent` automatically; no casts anywhere.
 *
 * DISPATCH SEMANTICS (implementations must honour all of these):
 *  • `emit` is SYNCHRONOUS — handlers run before it returns.
 *  • Handler exceptions are caught and logged; one bad handler must never
 *    break the others or the frame.
 *  • Subscribing or unsubscribing DURING dispatch is safe and takes effect on
 *    the next emit, not the current one.
 *  • Handlers for one type run in subscription order.
 */
export interface IEventBus {
  /** Subscribe. Returns an unsubscribe function. */
  on<T extends GameEventType>(type: T, handler: EventHandler<T>): () => void;
  /** Subscribe for a single dispatch. Returns an unsubscribe function. */
  once<T extends GameEventType>(type: T, handler: EventHandler<T>): () => void;
  /** Unsubscribe a handler previously passed to `on`/`once`. */
  off<T extends GameEventType>(type: T, handler: EventHandler<T>): void;
  /**
   * Publish. The bus stamps `time` and `frame`, so callers omit them.
   * Vectors in the payload are copied — reusing a scratch vector is safe.
   */
  emit<T extends GameEventType>(type: T, payload: GameEventPayload<T>): void;
  /** Subscribe to EVERY event. For logging, replay capture and debug tools. */
  onAny(handler: (event: GameEvent) => void): () => void;
  /** Remove all handlers for a type, or all handlers entirely. */
  clear(type?: GameEventType): void;
  /** Live handler count, for leak detection in tests. */
  listenerCount(type?: GameEventType): number;
  /** Advance the frame stamp. Called once per frame by the game loop. */
  setFrame(frame: number, time: number): void;
}
