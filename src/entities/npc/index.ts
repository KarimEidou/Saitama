/**
 * NPC / CROWD SYSTEM
 *
 *   import { CrowdSystem, makeThreat } from '@/entities/npc';
 *
 * The city's civilians, the panic that moves them, and the three allies who
 * can actually lose.
 *
 * ── WHY THIS IS THE MOST IMPORTANT SYSTEM IN THE GAME ─────────────────────
 * The protagonist cannot be hurt. That is not a balance problem to be worked
 * around, it is the premise — and a premise like that leaves a game with no
 * stakes unless something else can be lost. Everything here exists to be that
 * something: people who panic, gawk, flee, get in the way, and die, and a
 * ledger that scores the player on how many of them were still standing
 * afterwards.
 *
 * ── WHAT IS GUARANTEED ────────────────────────────────────────────────────
 *   - 250 instanced civilians in six draw calls, one per body archetype, with
 *     per-instance wardrobe and gait phase.
 *   - Panic propagates OUTWARD from a threat at a bounded, measured speed
 *     rather than switching on inside a radius.
 *   - No two agents interpenetrate and no agent stands inside a building,
 *     enforced positionally after steering rather than hoped for.
 *   - The flow field converges: every walkable cell's trajectory terminates,
 *     with no cycles and no direction pointing into geometry.
 *   - `CivilianSaved` / `CivilianLost` carry witness-scaled reputation, with
 *     the raw line-of-sight flags queryable from `CrowdLedger`.
 *   - Mumen Rider gets back up. Every time. There is no branch that checks
 *     whether it is a good idea.
 *   - Same seed and same input sequence produce an identical crowd.
 *     `Math.random` appears nowhere.
 *
 * All of the above is asserted in `__tests__` and in `harness/crowd.ts`, not
 * merely intended.
 */

export { CrowdSystem, chunkIndexForCrowd, makeThreat, type ICrowdSystemOptions } from './crowd-system';

export { AlarmField } from './alarm-field';

export { FlowField, type IConvergenceReport, type IDirectionField } from './flow-field';

export {
  ObstacleField,
  cellCentreX,
  cellCentreZ,
  cellIndexAt,
  cellX,
  cellZ,
} from './obstacles';

export {
  CrowdAgents,
  MOOD_COMMUTE,
  MOOD_COWER,
  MOOD_DOWN,
  MOOD_FLEE,
  MOOD_GAWK,
  MOOD_NAMES,
  TIER_MID,
  TIER_NEAR,
  agentRng,
} from './crowd-agents';

export {
  CrowdSteering,
  LAYER_CIVILIAN,
  LAYER_HERO,
  LAYER_PLAYER,
  LAYER_THREAT,
  timeToCollision,
  type IAvoidBody,
  type ISteeringReport,
} from './steering';

export {
  CrowdRenderer,
  CROWD_CLIP_COWER,
  CROWD_CLIP_FLEE,
  CROWD_CLIP_GAWK,
  CROWD_CLIP_IDLE,
  CROWD_CLIP_RUN,
  CROWD_CLIP_WALK,
  clipForMood,
  type ICrowdRenderStats,
} from './crowd-renderer';

export {
  COWER_CLIP,
  COWER_KEY,
  GAWK_CLIP,
  GAWK_KEY,
  evaluateCrowdClip,
} from './crowd-clips';

export { NearCivilian, type ICivilianHost } from './near-civilian';

export { HeroNpc, HERO_SPECS, type IHeroSpec, type IHeroWorld } from './hero-npc';

export {
  CrowdLedger,
  gatherWitnesses,
  scoreOutcome,
  type IWitnessReport,
} from './witness';

export {
  BehaviourTree,
  action,
  always,
  condition,
  cooldown,
  effect,
  guard,
  invert,
  selector,
  sequence,
  type BtNode,
  type BtStatus,
} from './behaviour-tree';

export {
  ActorStateMachine,
  ActorTransform,
  PROCEDURAL_ANIMATIONS,
  angleTo,
  yawFromDirection,
} from './actor-support';

export * from './constants';

export type {
  CivilianMood,
  CrowdTier,
  HeroNpcId,
  IAlarmImpulse,
  ICivilianOutcome,
  ICrowdArchetype,
  ICrowdStats,
  IHeroCallout,
  IHeroStatus,
  IObstacleRect,
  IThreatSource,
  OutcomeKind,
} from './types';
