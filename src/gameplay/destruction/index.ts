/**
 * DESTRUCTION BARREL
 *
 *   import { DestructionSystem } from '@/gameplay/destruction';
 *
 * The system that turns a punch into a hole in City Z. Wire it once:
 *
 *   const destruction = new DestructionSystem({
 *     bus,
 *     debris: debrisPool,        // src/physics    — DebrisPool
 *     damage: streaming.damageState, // src/world/streaming — ChunkDamageState
 *     ragdolls: ragdollAdapter,  // resolves rigs, calls RagdollManager.spawn
 *     collapsingFloors,          // src/world/city — the authoritative rule
 *     seed: worldSeed,
 *   });
 *
 * then register every block mesh as its buildings stream in:
 *
 *   for (const [buildingId, layout] of Object.entries(blockMesh.fractures)) {
 *     destruction.register({
 *       id: buildingId,
 *       layout,
 *       target: blockMesh,
 *       position: summary.position,
 *       chunkIndex, buildingIndex,
 *     });
 *   }
 *
 * and call `update(dt)` once a frame. Everything else arrives on the bus:
 * `ShockwaveFired` carves, `EntityKilled` throws bodies, `PlayerLanded`
 * craters, and `ChunkDetached` goes back out — one per piece — for combat's
 * scorecard, VFX and audio.
 *
 * NOTE ON IMPORTS: nothing in this directory imports another system. Physics,
 * streaming and the city generator all arrive through the structural ports in
 * `ports.ts`, which those modules satisfy verbatim.
 */

export {
  DestructionSystem,
  type IDestructionSystemOptions,
  type IDestructionStats,
} from './destruction-system';

export { RegisteredStructure, type DetachCause } from './structure';

export { CollapseScheduler, type CollapseDrainFn, type ICollapseEntry } from './collapse-scheduler';

export { DebrisShapePool } from './debris-shapes';

export { collapsingFloors, remainingSupport } from './support';

export {
  bandForFloor,
  chunkMatchesPiece,
  damageSlot,
  pieceForChunk,
  quadrantForPlanQuarter,
} from './damage-address';

export {
  aabbInCone,
  aabbInSphere,
  localAabbToWorld,
  localToWorld,
  normaliseInto,
  pointAabbDistanceSq,
} from './geometry';

export * from './constants';

export type {
  CollapsingFloorsFn,
  IDamageSink,
  IDebrisSink,
  IDestroyedAttribute,
  IDestructionTarget,
  IRagdollSink,
  IStructureChunk,
  IStructureFloor,
  IStructureLayout,
  IStructureSlotRange,
  IStructureSpec,
} from './ports';
