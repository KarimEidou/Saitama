/**
 * ENTITY CONTRACT
 *
 * Transforms, actors, state machines, NPC brains and monsters.
 *
 * TYPE-ONLY file. No runtime exports.
 *
 * NOTE: `ThreatTier` comes from combat.ts and `ClipName` from character.ts —
 * they are imported, never redeclared here.
 */

import type * as THREE from 'three';
import type { IDisposable, IUpdatable, IEngineContext } from './engine';
import type { ThreatTier } from './combat';
import type { ClipName, ICharacterInstance } from './character';

/* -------------------------------------------------------------------------- */
/* Transform                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Position/orientation/scale of an entity.
 *
 * Normally backed by a `THREE.Object3D`, so mutating the vectors in place is
 * expected and cheap. `rotation` is a quaternion to avoid gimbal issues during
 * aerial combat; `yaw` covers the common ground-facing case.
 */
export interface ITransform {
  readonly position: THREE.Vector3;
  readonly rotation: THREE.Quaternion;
  readonly scale: THREE.Vector3;
  /** Heading about the Y axis in radians, derived from `rotation`. */
  yaw: number;
  /** Cached world-space forward (local -Z). */
  readonly forward: THREE.Vector3;
  /** Underlying scene node, when one exists. */
  readonly object3D?: THREE.Object3D;
}

/* -------------------------------------------------------------------------- */
/* Entities                                                                   */
/* -------------------------------------------------------------------------- */

/** Stable, unique entity identifier. */
export type EntityId = string;

/** Coarse entity classification. */
export type EntityType = 'player' | 'npc' | 'monster' | 'hero' | 'prop' | 'vehicle' | 'projectile';

/** Anything that exists in the world and ticks. */
export interface IEntity extends IUpdatable, IDisposable {
  /** Globally unique, stable for the entity's lifetime. */
  readonly id: EntityId;
  /** Discriminator for cheap runtime filtering. */
  readonly type: EntityType;
  readonly transform: ITransform;
  /** Scene node root; added/removed by the spawner. */
  readonly root: THREE.Object3D;
  /** When false, `update()` is skipped and the entity is hidden. */
  active: boolean;
  /** Chunk key currently occupied; maintained by the spawner. */
  chunkKey?: string;
  /** Bounding radius in metres, for broad-phase queries. */
  readonly radius: number;
}

/* -------------------------------------------------------------------------- */
/* Factions                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Faction alignment; determines targeting and hostility.
 * `civilian` are non-combatants; `hero` includes the player.
 */
export type Faction = 'hero' | 'civilian' | 'monster' | 'neutral';

/* -------------------------------------------------------------------------- */
/* State machine                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Canonical actor states. Names intentionally mirror `ClipName` slots so an
 * actor can drive its animator straight from its state.
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

/** Minimal state machine shared by player, NPCs and monsters. */
export interface IStateMachine<S extends string = ActorState> extends IUpdatable {
  readonly current: S;
  readonly previous: S | undefined;
  /** Seconds spent in `current`. */
  readonly timeInState: number;
  /** Request a transition. Returns false when disallowed. */
  transition(next: S, force?: boolean): boolean;
  canTransition(next: S): boolean;
  /** Returns an unsubscribe fn. */
  onEnter(state: S, cb: () => void): () => void;
  /** Returns an unsubscribe fn. */
  onExit(state: S, cb: () => void): () => void;
}

/* -------------------------------------------------------------------------- */
/* Animation set                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Maps each logical animation slot to the clip name inside the character's
 * GLB. Keys are kept in sync with `ClipName` in character.ts.
 *
 * Six slots are REQUIRED; every other slot falls back to `idle` when absent.
 */
export interface IAnimationSet {
  /** Neutral standing loop. */
  idle: string;
  /** Locomotion loop at walking speed. */
  walk: string;
  /** Locomotion loop at running speed. */
  run: string;
  /** Primary attack. */
  attack: string;
  /** Damage reaction. */
  hit: string;
  /** Death; should not loop. */
  death: string;

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
  /** Signature finisher. */
  special?: string;
}

/** Compile-time guarantee that IAnimationSet covers every ClipName slot. */
export type AnimationSetCoversAllClips = Record<ClipName, string | undefined> extends Record<
  keyof IAnimationSet,
  string | undefined
>
  ? true
  : never;

/* -------------------------------------------------------------------------- */
/* Actors                                                                     */
/* -------------------------------------------------------------------------- */

/** An entity with health, a faction and a state machine. */
export interface IActor extends IEntity {
  /** Current hit points, clamped to `[0, maxHealth]`. */
  health: number;
  maxHealth: number;
  readonly faction: Faction;
  readonly stateMachine: IStateMachine<ActorState>;
  /** Slot-to-clip mapping for this actor's rig. */
  readonly animations: IAnimationSet;
  /** Character instance when the actor is skinned. */
  readonly character?: ICharacterInstance;
  /** True once health hit 0 and the death state was entered. */
  readonly isDead: boolean;
  /** Horizontal movement speed in m/s. */
  moveSpeed: number;
  /** Name shown in the HUD / nameplate. */
  readonly displayName: string;

  /** Apply damage; returns damage actually dealt after mitigation. */
  takeDamage(amount: number, source?: IActor, impulse?: THREE.Vector3): number;
  /** Restore health, clamped to `maxHealth`. */
  heal(amount: number): void;
  /** Force the death transition immediately. */
  kill(): void;
  /** Play a clip slot, optionally with a crossfade. */
  playAnimation(clip: ClipName, fadeSeconds?: number): void;
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
 * Pluggable NPC brain, one per NPC. Implementations must be cheap — hundreds
 * run concurrently on a mid-tier phone.
 */
export interface INPCBehaviour extends IUpdatable {
  readonly kind: NPCBehaviourKind;
  readonly actor: IActor;
  /** Current navigation goal, if any. */
  target?: THREE.Vector3;
  /** Metres at which the NPC notices threats. */
  awarenessRadius: number;

  /** Called once when attached. */
  onAttach(ctx: IEngineContext): void;
  /** Notify of a nearby threat (monster, explosion, shockwave). */
  onThreat(source: THREE.Vector3, intensity: number): void;
  /** Reset to a clean state when recycled from the pool. */
  reset(): void;
}

/* -------------------------------------------------------------------------- */
/* Monsters                                                                   */
/* -------------------------------------------------------------------------- */

/** Data-driven monster definition, loaded from the monster table. */
export interface IMonsterSpec {
  /** Stable identifier, e.g. 'mosquito-girl'. */
  readonly id: string;
  readonly name: string;
  readonly threatTier: ThreatTier;
  /** Must match an `ICharacterAsset.id` in the asset manifest. */
  readonly assetKey: string;
  readonly maxHealth: number;
  readonly attackDamage: number;
  /** Metres per second. */
  readonly moveSpeed: number;
  /** Metres at which an attack can land. */
  readonly attackRange: number;
  /** Seconds between attacks. */
  readonly attackCooldown: number;
  /** Metres at which a target is acquired. */
  readonly aggroRadius: number;
  /** Uniform scale multiplier over the base asset. */
  readonly scale: number;
  readonly animations: IAnimationSet;
  /** Ability ids resolved by the combat system. */
  readonly abilities?: readonly string[];
  /** Hero points granted on defeat. */
  readonly rewardPoints: number;
  /** Named story boss rather than a random encounter. */
  readonly isBoss: boolean;
  /** Districts this monster may spawn in; empty means anywhere. */
  readonly spawnDistricts?: readonly string[];
}

/** A live monster instance. */
export interface IMonster extends IActor {
  readonly type: 'monster';
  readonly spec: IMonsterSpec;
  /** Current aggro target. */
  target?: IActor;
  /** Seconds until the next attack is permitted. */
  attackCooldownRemaining: number;
  /** Boss phase index; 0 for non-bosses. */
  readonly phase: number;
}

/* -------------------------------------------------------------------------- */
/* Spawning                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Entity lifecycle manager. Pools instances — never construct actors directly
 * in gameplay code, so budgets stay enforced.
 */
export interface IEntitySpawner extends IUpdatable, IDisposable {
  readonly entities: ReadonlyMap<EntityId, IEntity>;

  /** Create or recycle a monster from a spec id. */
  spawnMonster(specId: string, position: THREE.Vector3, rotationY?: number): Promise<IMonster>;
  /** Create or recycle an ambient NPC. */
  spawnNPC(
    behaviour: NPCBehaviourKind,
    position: THREE.Vector3,
    rotationY?: number
  ): Promise<IActor>;
  /** Return an entity to its pool. */
  despawn(id: EntityId): void;
  /** Despawn everything owned by a chunk. Called on chunk eviction. */
  despawnChunk(chunkKey: string): void;
  /** Entities within `radius` metres, optionally faction-filtered. */
  queryRadius(centre: THREE.Vector3, radius: number, faction?: Faction): IEntity[];
  /** Nearest entity matching a faction filter. */
  findNearest(centre: THREE.Vector3, faction?: Faction, maxDistance?: number): IEntity | undefined;
}
