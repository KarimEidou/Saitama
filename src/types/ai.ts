/**
 * AI CONTRACT
 *
 * Navigation, perception, steering and decision-making.
 *
 * TYPE-ONLY file. No runtime exports.
 *
 * PERFORMANCE RULE: hundreds of agents tick concurrently on a phone. AI work
 * is BUDGETED — `IAIScheduler` gives each agent a full think only every N
 * frames, while cheap steering runs every frame. Never do a pathfind inside
 * a per-frame update without going through the scheduler.
 *
 * `INPCBehaviour` (the per-NPC brain) lives in entity.ts; this file covers the
 * lower-level services those brains call.
 */

import type * as THREE from 'three';
import type { IUpdatable, IDisposable } from './engine';
import type { EntityId, IActor, Faction } from './entity';
import type { ThreatTier } from './combat';

/* -------------------------------------------------------------------------- */
/* Navigation                                                                 */
/* -------------------------------------------------------------------------- */

/** A path returned by the navigation system. */
export interface INavPath {
  /** Waypoints in world space, start to goal. */
  readonly waypoints: readonly THREE.Vector3[];
  /** Total length in metres. */
  readonly length: number;
  /** True when the goal was reached; false means a partial/best-effort path. */
  readonly complete: boolean;
  /** Index of the waypoint currently being steered towards. */
  cursor: number;
}

/** A pathfinding request. */
export interface IPathRequest {
  readonly start: THREE.Vector3;
  readonly goal: THREE.Vector3;
  /** Metres from the goal that counts as arrival. */
  readonly tolerance?: number;
  /** Higher is served first when the budget is tight. */
  readonly priority?: number;
  /** Agent radius in metres, for clearance. */
  readonly agentRadius?: number;
  /** Cap on search cost; partial paths are returned when exceeded. */
  readonly maxNodes?: number;
}

/**
 * Navigation surface.
 *
 * The city is streamed and destructible, so the navmesh is CHUNK-LOCAL and
 * rebuilt when a chunk loads or a building collapses. Paths crossing chunk
 * boundaries are stitched through portal edges.
 */
export interface INavMesh extends IDisposable {
  /** Chunk keys with navigation data resident. */
  readonly loadedChunks: readonly string[];

  /** Async path request; resolves on a later frame via the scheduler. */
  findPath(request: IPathRequest): Promise<INavPath | undefined>;
  /** Synchronous straight-line check. Cheap — safe to call per frame. */
  isDirectPathClear(from: THREE.Vector3, to: THREE.Vector3, agentRadius?: number): boolean;
  /** Nearest point on the navmesh, for spawn snapping. Undefined if far off. */
  projectToNavMesh(position: THREE.Vector3, maxDistance?: number): THREE.Vector3 | undefined;
  /** True when a position stands on walkable surface. */
  isWalkable(position: THREE.Vector3): boolean;
  /** A random reachable point within a radius, for wandering. */
  randomPointNear(centre: THREE.Vector3, radius: number): THREE.Vector3 | undefined;
  /** Build navigation data for a chunk. */
  buildChunk(chunkKey: string, geometry: THREE.BufferGeometry): void;
  /** Drop a chunk's navigation data. */
  unloadChunk(chunkKey: string): void;
  /** Invalidate a region after destruction, forcing a local rebuild. */
  invalidateRegion(centre: THREE.Vector3, radius: number): void;
}

/* -------------------------------------------------------------------------- */
/* Perception                                                                 */
/* -------------------------------------------------------------------------- */

/** Something an agent has noticed. */
export interface IPerceivedTarget {
  readonly entityId: EntityId;
  readonly faction: Faction;
  /** Last known position; may be stale once the target is out of sight. */
  readonly position: THREE.Vector3;
  readonly distance: number;
  /** Currently within the vision cone and unobstructed. */
  readonly visible: boolean;
  /** Seconds since the target was last actually seen. */
  readonly timeSinceSeen: number;
  /** How dangerous the agent judges this target, 0..1. */
  readonly threat: number;
  /** Present when the target is a monster. */
  readonly threatTier?: ThreatTier;
}

/**
 * An agent's sensory view of the world.
 *
 * Deliberately imperfect: agents act on `lastKnownPosition` rather than
 * ground truth, which is what makes fleeing civilians and searching monsters
 * read as believable rather than omniscient.
 */
export interface IPerception extends IUpdatable {
  readonly owner: IActor;
  /** Everything currently tracked, nearest first. */
  readonly targets: readonly IPerceivedTarget[];
  /** Highest-threat visible hostile, if any. */
  readonly primaryThreat?: IPerceivedTarget;

  /** Vision cone half-angle in radians. */
  visionAngle: number;
  /** Sight range in metres. */
  visionRange: number;
  /** Radius within which the agent notices things regardless of facing. */
  hearingRange: number;
  /** Seconds a target is remembered after being lost. */
  memoryDuration: number;

  /** True when a specific entity is currently visible. */
  canSee(entityId: EntityId): boolean;
  /** Inject a stimulus the agent could not have seen, e.g. a loud impact. */
  notice(position: THREE.Vector3, intensity: number, sourceId?: EntityId): void;
  /** Forget everything, e.g. when recycled from the pool. */
  reset(): void;
}

/* -------------------------------------------------------------------------- */
/* Steering                                                                   */
/* -------------------------------------------------------------------------- */

/** Local movement behaviours, blended into a single desired velocity. */
export type SteeringBehaviour =
  | 'seek'
  | 'flee'
  | 'arrive'
  | 'wander'
  | 'pursue'
  | 'evade'
  | 'separation'
  | 'alignment'
  | 'cohesion'
  | 'obstacleAvoidance'
  | 'followPath';

/** Weighted steering configuration for one agent. */
export interface ISteeringConfig {
  readonly weights: Readonly<Partial<Record<SteeringBehaviour, number>>>;
  /** Metres per second. */
  readonly maxSpeed: number;
  /** Metres per second squared. */
  readonly maxAcceleration: number;
  /** Radians per second. */
  readonly maxTurnRate: number;
  /** Metres at which `arrive` begins decelerating. */
  readonly arrivalRadius: number;
  /** Neighbour radius for flocking behaviours. */
  readonly neighbourRadius: number;
}

/** Per-frame local steering. Cheap enough to run on every agent every frame. */
export interface ISteering extends IUpdatable {
  readonly owner: IActor;
  config: ISteeringConfig;
  /** Steering goal. */
  target?: THREE.Vector3;
  /** Path being followed, when `followPath` is weighted. */
  path?: INavPath;
  /** Resulting desired velocity for this frame. */
  readonly desiredVelocity: THREE.Vector3;
  /** True once within `arrivalRadius` of the target. */
  readonly hasArrived: boolean;
  /** Enable or disable a behaviour at runtime. */
  setWeight(behaviour: SteeringBehaviour, weight: number): void;
}

/* -------------------------------------------------------------------------- */
/* Decision making                                                            */
/* -------------------------------------------------------------------------- */

/** One considered course of action. */
export interface IAIAction {
  readonly id: string;
  /** Utility score 0..1; the highest scorer is selected. */
  readonly score: number;
  /** Run the action. Returns false when it can no longer proceed. */
  execute(dt: number): boolean;
  /** Called when this action is displaced by a higher-scoring one. */
  onInterrupt?(): void;
}

/**
 * Utility-based decision maker. Each action scores itself against the current
 * world state and the best one runs. Preferred over behaviour trees here
 * because reactions must interleave cleanly with streaming and destruction.
 */
export interface IAIBrain extends IUpdatable {
  readonly owner: IActor;
  readonly perception: IPerception;
  readonly steering: ISteering;
  /** Action currently executing. */
  readonly currentAction?: IAIAction;

  /** Add a candidate action. */
  addAction(action: IAIAction): void;
  /** Re-score every action and switch if a better one is available. */
  reconsider(): void;
  /** Force a specific action, bypassing scoring. */
  forceAction(id: string): boolean;
  /** Reset to a clean state when recycled from the pool. */
  reset(): void;
}

/* -------------------------------------------------------------------------- */
/* Scheduling                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Spreads AI work across frames.
 *
 * Agents are bucketed by distance: nearby agents think often, distant ones
 * rarely. This is the single most important lever for keeping a densely
 * populated city inside frame budget.
 */
export interface IAIScheduler extends IUpdatable, IDisposable {
  /** Registered agents. */
  readonly agentCount: number;
  /** Milliseconds of AI work permitted per frame. */
  budgetMs: number;

  /** Register a brain. Returns an unregister function. */
  register(brain: IAIBrain): () => void;
  /** Queue a pathfinding request; resolved within budget over later frames. */
  requestPath(request: IPathRequest): Promise<INavPath | undefined>;
  /** Point used for distance bucketing — normally the player. */
  focus: THREE.Vector3;
  /** Milliseconds actually spent last frame, for the debug overlay. */
  readonly lastFrameMs: number;
}
