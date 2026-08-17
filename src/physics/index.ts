/**
 * PHYSICS SYSTEM — PUBLIC SURFACE
 *
 *   import { initPhysics, PhysicsWorld, DebrisPool } from '@/physics';
 *
 * A wrapper around Rapier (`@dimforge/rapier3d-compat`) implementing the
 * contracts in `src/types/physics.ts`. Nothing outside this directory should
 * import the Rapier package, and nothing in here imports another system —
 * cross-system traffic goes over the event bus.
 *
 * ── BOOT ORDER ─────────────────────────────────────────────────────────────
 *   await initPhysics();                       // one wasm instantiation
 *   const world = new PhysicsWorld({ eventBus });
 *   const debris = new DebrisPool(world, { container: scene });
 *   const ragdolls = new RagdollManager(world);
 *   const shock = new ImpulsePropagator(world); shock.attach(eventBus);
 *
 * ── PER FRAME ──────────────────────────────────────────────────────────────
 *   world.update(dt);        // fixed steps + interpolation alpha
 *   debris.update(dt);
 *   ragdolls.update(dt);
 *
 * `initPhysics()` is the ONLY thing that pulls in the 2.8 MB Rapier chunk, and
 * it does so with a dynamic import so the first frame is never blocked on it.
 */

/* Loader */
export {
  initPhysics,
  getRapier,
  isPhysicsReady,
  physicsInitDurationMs,
  __resetPhysicsLoaderForTests,
  type Rapier,
} from './rapier-init';

/* Tuning */
export * from './constants';

/* Layers */
export {
  PHYSICS_LAYERS,
  LAYER_BIT,
  ALL_LAYERS,
  DEFAULT_COLLISION_MATRIX,
  layerMask,
  interactionGroups,
  groupsFor,
  queryGroups,
  layerFromMask,
  layersInteract,
} from './layers';

/* Collider helpers */
export {
  aabbHullPoints,
  chunkHullPoints,
  chunkMaxExtent,
  actorCapsuleDesc,
  heightfieldDesc,
  trimeshDesc,
  convexHullDesc,
  createColliderDesc,
} from './colliders';

/* Core */
export { PhysicsBody, type ForceNotifier } from './body';
export { PhysicsWorld, type IPhysicsWorldOptions } from './world';

/* Character */
export {
  CharacterController,
  apexHeightForSpeed,
  TUNED_JUMP_APEX,
  type ICharacterControllerOptions,
  type ILandingReport,
} from './character-controller';

/* Ragdolls */
export {
  Ragdoll,
  RagdollManager,
  createRagdoll,
  estimateRigHeight,
  RAGDOLL_SEGMENTS,
  type AxisLimit,
  type IRagdollOptions,
  type IRagdollSegment,
  type IRagdollSegmentSpec,
  type RagdollSegmentName,
} from './ragdoll';

export {
  createReferenceRig,
  poseRigIdle,
  REFERENCE_SKELETON,
  REFERENCE_HEIGHT,
  type IRagdollRigSource,
  type IReferenceRig,
} from './reference-rig';

/* Debris */
export { DebrisPool, type IDebrisPoolOptions, type IPooledDebris } from './debris-pool';

/* Impulses */
export {
  ImpulsePropagator,
  applyRadialImpulse,
  type IImpulsePropagatorOptions,
  type IRadialImpulseOptions,
} from './impulse';
