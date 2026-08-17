/**
 * ENTITY INTERFACE CONTRACT
 *
 * Owned by: player, NPC and monster workstreams.
 * Consumed by: combat, quests, world spawning, UI.
 *
 * TYPE-ONLY file. No runtime exports.
 */

import type * as THREE from 'three';
import type { IDisposable, IUpdatable, IEngineContext } from './engine';

/* -------------------------------------------------------------------------- */
/* Transform                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Position/orientation/scale of an entity.
 *
 * Implementations normally back this with a `THREE.Object3D`, so mutating the
 * vectors in place is expected and cheap. `rotation` is a quaternion to avoid
 * gimbal issues on aerial combat; use `yaw` for the common ground-facing case.
 */
export interface ITransform {
  readonly position: THREE.Vector3;
  readonly rotation: THREE.Quaternion;
  readonly scale: THREE.Vector3;
  /** Heading about the Y axis in radians. Derived from `rotation`. */
  yaw: number;
  /** Cached forward (-Z in local space) in world space. */
  readonly forward: THREE.Vector3;
  /** Underlying scene node, when one exists. */
  readonly object3D?: THREE.Object3D;
}

/* -------------------------------------------------------------------------- */
/* Base entity                                                                */
/* -------------------------------------------------------------------------- */

/** Stable, unique entity identifier. */
export type EntityId = string;

/** Anything that exists in the world and ticks. */
export interface IEntity extends IUpdatable, IDisposable {
  /** Globally unique, stable for the entity's lifetime. */
  readonly id: EntityId;
  /** Discriminator for cheap runtime filtering. */
  readonly type: EntityType;
  /** World transform. */
  readonly transform: ITransform;
  /** Scene node root. Added to / removed from the scene by the spawner. */
  readonly root: THREE.Object3D;
  /** When false, `update()` is skipped and the entity is hidden. */
  active: boolean;
  /** Chunk key the entity currently occupies; maintained by the spawner. */
  chunkKey?: string;
  /** Bounding radius in metres, for broad-phase queries. */
  readonly radius: number;
}

/** Coarse entity classification. */
export type EntityType = 'player' | 'npc' | 'monster' | 'hero' | 'prop' | 'vehicle' | 'projectile';

/* -------------------------------------------------------------------------- */
/* Factions                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Faction alignment. Determines targeting and hostility.
 * `civilian` are non-combatants; `hero` includes the player.
 */
export type Faction = 'hero' | 'civilian' | 'monster' | 'neutral';

/* -------------------------------------------------------------------------- */
/* Actor state machine                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Canonical actor states. Every animated actor drives its animation set from
 * this enum, so the names intentionally mirror `IAnimationSet` keys.
 */
export type ActorState =
  | 'idle'
  | 'walk'
  | 'run'
  | 'sprint'
  | 'jump'
  | 'fall'
  | 'land'
  | 'attack'
  | 'heavyAttack'
  | 'block'
  | 'dodge'
  | 'hit'
  | 'stagger'
  | 'death'
  | 'flee'
  | 'taunt';

/** Minimal state machine contract shared by player, NPCs and monsters. */
export interface IStateMachine<S extends string = ActorState> extends IUpdatable {
  /** Currently active state. */
  readonly current: S;
  /** State active before `current`. */
  readonly previous: S | undefined;
  /** Seconds spent in `current`. */
  readonly timeInState: number;
  /** Request a transition. Returns false when the transition is disallowed. */
  transition(next: S, force?: boolean): boolean;
  /** Whether a transition is currently legal. */
  canTransition(next: S): boolean;
  /** Register a callback fired on entering a state. */
  onEnter(state: S, cb: () => void): void;
  /** Register a callback fired on leaving a state. */
  onExit(state: S, cb: () => void): void;
}

/* -------------------------------------------------------------------------- */
/* Actor                                                                      */
/* -------------------------------------------------------------------------- */

/** An entity with health, a faction and a state machine. */
export interface IActor extends IEntity {
  /** Current hit points. Clamped to `[0, maxHealth]`. */
  health: number;
  /** Maximum hit points. */
  maxHealth: number;
  /** Alignment. */
  readonly faction: Faction;
  /** Behaviour/animation state machine. */
  readonly stateMachine: IStateMachine<ActorState>;
  /** Animation clip names for this actor. */
  readonly animations: IAnimationSet;
  /** Three.js mixer driving `animations`, when the actor is skinned. */
  readonly mixer?: THREE.AnimationMixer;
  /** True once health reaches 0 and the death state has been entered. */
  readonly isDead: boolean;
  /** Horizontal movement speed in m/s. */
  moveSpeed: number;
  /** Display name shown in the HUD / nameplate. */
  readonly displayName: string;

  /** Apply damage. Returns damage actually dealt after mitigation. */
  takeDamage(amount: number, source?: IActor, impulse?: THREE.Vector3): number;
  /** Restore health, clamped to `maxHealth`. */
  heal(amount: number): void;
  /** Force the death transition immediately. */
  kill(): void;
  /** Play a clip by animation-set key, optionally with a crossfade. */
  playAnimation(key: keyof IAnimationSet, fadeSeconds?: number): void;
}

/* -------------------------------------------------------------------------- */
/* Animation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Map from logical animation slot to the clip name inside the character's GLB.
 *
 * Rigging convention: characters are Mixamo-compatible humanoid rigs unless
 * `ICharacterAsset.skeleton` says otherwise. Optional slots fall back to
 * `idle` when absent.
 */
export interface IAnimationSet {
  /** Required: neutral standing loop. */
  idle: string;
  /** Required: locomotion loop at walking speed. */
  walk: string;
  /** Required: locomotion loop at running speed. */
  run: string;
  /** Required: primary attack. */
  attack: string;
  /** Required: damage reaction. */
  hit: string;
  /** Required: death. Should not loop. */
  death: string;

  /** Optional extended slots. */
  sprint?: string;
  jump?: string;
  fall?: string;
  land?: string;
  heavyAttack?: string;
  block?: string;
  dodge?: string;
  stagger?: string;
  flee?: string;
  taunt?: string;
  /** Signature finisher, e.g. Saitama's Serious Punch. */
  special?: string;
}

/* -------------------------------------------------------------------------- */
/* NPC behaviour                                                              */
/* -------------------------------------------------------------------------- */

/** Behaviour archetypes for ambient city population. */
export type NPCBehaviourKind =
  | 'pedestrian'
  | 'vendor'
  | 'bystander'
  | 'fleeing'
  | 'heroPatrol'
  | 'idleCrowd';

/**
 * Pluggable NPC brain. One instance per NPC; the NPC system ticks it.
 * Implementations must be cheap — hundreds run concurrently.
 */
export interface INPCBehaviour extends IUpdatable {
  /** Archetype discriminator. */
  readonly kind: NPCBehaviourKind;
  /** The actor this brain drives. */
  readonly actor: IActor;
  /** Current navigation goal, if any. */
  target?: THREE.Vector3;
  /** Metres at which the NPC notices threats. */
  awarenessRadius: number;

  /** Called once when the behaviour is attached. */
  onAttach(ctx: IEngineContext): void;
  /** Notify of a nearby threat (monster, explosion, punch shockwave). */
  onThreat(source: THREE.Vector3, intensity: number): void;
  /** Reset to a clean state when the NPC is recycled from the pool. */
  reset(): void;
}

/* -------------------------------------------------------------------------- */
/* Monsters                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Hero Association threat classification, ascending in danger.
 * `wolf` < `tiger` < `demon` < `dragon` < `god`.
 */
export type ThreatTier = 'wolf' | 'tiger' | 'demon' | 'dragon' | 'god';

/** Data-driven monster definition. Loaded from the monster table. */
export interface IMonsterSpec {
  /** Stable identifier, e.g. 'mosquito-girl'. */
  readonly id: string;
  /** Display name. */
  readonly name: string;
  /** Threat classification. */
  readonly threatTier: ThreatTier;
  /** Key into `IAssetRegistry` — must match an `ICharacterAsset.id`. */
  readonly assetKey: string;
  /** Base hit points. */
  readonly maxHealth: number;
  /** Damage dealt per basic attack. */
  readonly attackDamage: number;
  /** Metres per second. */
  readonly moveSpeed: number;
  /** Metres at which the monster can land an attack. */
  readonly attackRange: number;
  /** Seconds between attacks. */
  readonly attackCooldown: number;
  /** Metres at which the monster acquires a target. */
  readonly aggroRadius: number;
  /** Uniform scale multiplier applied to the base asset. */
  readonly scale: number;
  /** Animation slot mapping for this monster's rig. */
  readonly animations: IAnimationSet;
  /** Special abilities by id, resolved by the combat system. */
  readonly abilities?: readonly string[];
  /** Experience/reward granted on defeat. */
  readonly rewardXp: number;
  /** Whether this is a named story boss rather than a random encounter. */
  readonly isBoss: boolean;
  /** Districts this monster may spawn in; empty means anywhere. */
  readonly spawnDistricts?: readonly string[];
}

/** A live monster instance. */
export interface IMonster extends IActor {
  readonly type: 'monster';
  /** The spec this instance was created from. */
  readonly spec: IMonsterSpec;
  /** Current aggro target. */
  target?: IActor;
  /** Seconds until the next attack is permitted. */
  attackCooldownRemaining: number;
}

/* -------------------------------------------------------------------------- */
/* Spawning                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Entity lifecycle manager. Pools instances — never construct actors directly
 * in gameplay code, always go through the spawner so budgets are respected.
 */
export interface IEntitySpawner extends IUpdatable, IDisposable {
  /** All live entities by id. */
  readonly entities: ReadonlyMap<EntityId, IEntity>;

  /** Create (or recycle) a monster from a spec id at a position. */
  spawnMonster(specId: string, position: THREE.Vector3, rotationY?: number): Promise<IMonster>;
  /** Create (or recycle) an ambient NPC. */
  spawnNPC(
    behaviour: NPCBehaviourKind,
    position: THREE.Vector3,
    rotationY?: number
  ): Promise<IActor>;
  /** Return an entity to its pool. */
  despawn(id: EntityId): void;
  /** Despawn everything owned by a chunk. Called on chunk eviction. */
  despawnChunk(chunkKey: string): void;
  /** Entities within `radius` metres of a point, optionally faction-filtered. */
  queryRadius(centre: THREE.Vector3, radius: number, faction?: Faction): IEntity[];
  /** Nearest entity matching a faction filter. */
  findNearest(centre: THREE.Vector3, faction?: Faction, maxDistance?: number): IEntity | undefined;
}
