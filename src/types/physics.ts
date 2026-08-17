/**
 * PHYSICS CONTRACT
 *
 * Abstraction over the Rapier solver (@dimforge/rapier3d-compat).
 *
 * TYPE-ONLY file. No runtime exports, and deliberately NO import of the Rapier
 * package — keeping the solver out of the contract means gameplay code never
 * depends on it directly and the backend stays swappable.
 *
 * UNITS: metres, kilograms, seconds. Gravity is about -9.81 m/s^2 on Y.
 */

import type * as THREE from 'three';
import type { IUpdatable, IDisposable } from './engine';
import type { EntityId } from './entity';

/* -------------------------------------------------------------------------- */
/* Handles                                                                    */
/* -------------------------------------------------------------------------- */

/** Opaque handle to a rigid body inside the solver. */
export type BodyHandle = number;
/** Opaque handle to a collider inside the solver. */
export type ColliderHandle = number;

/** How a body is simulated. */
export type RigidBodyType =
  /** Fully simulated: debris, ragdolls, thrown objects. */
  | 'dynamic'
  /** Never moves: terrain, intact buildings. */
  | 'fixed'
  /** Moved by code, pushes dynamics but is not pushed: player, platforms. */
  | 'kinematic';

/** Collision filtering groups. Combine as a bitmask. */
export type PhysicsLayer =
  | 'world'
  | 'player'
  | 'monster'
  | 'npc'
  | 'debris'
  | 'projectile'
  | 'trigger'
  | 'ragdoll';

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

/** Collider geometry. Prefer primitives — trimesh is far more expensive. */
export type ColliderShape =
  | { readonly kind: 'box'; readonly halfExtents: THREE.Vector3 }
  | { readonly kind: 'sphere'; readonly radius: number }
  | { readonly kind: 'capsule'; readonly halfHeight: number; readonly radius: number }
  | { readonly kind: 'cylinder'; readonly halfHeight: number; readonly radius: number }
  | { readonly kind: 'convexHull'; readonly points: Float32Array }
  | { readonly kind: 'trimesh'; readonly vertices: Float32Array; readonly indices: Uint32Array }
  | { readonly kind: 'heightfield'; readonly heights: Float32Array; readonly scale: THREE.Vector3 };

/** Parameters for creating a body plus its collider. */
export interface IRigidBodyDesc {
  readonly type: RigidBodyType;
  readonly shape: ColliderShape;
  readonly position: THREE.Vector3;
  readonly rotation?: THREE.Quaternion;
  /** Kilograms. Omit to derive from shape volume and `density`. */
  readonly mass?: number;
  /** kg/m^3. Concrete ~2400, wood ~700. */
  readonly density?: number;
  /** 0..1. */
  readonly friction?: number;
  /** 0..1; 0 is fully inelastic. */
  readonly restitution?: number;
  /** Which layer this body belongs to. */
  readonly layer: PhysicsLayer;
  /** Layers this body collides with. */
  readonly collidesWith: readonly PhysicsLayer[];
  /** Reports overlaps without generating contact forces. */
  readonly isSensor?: boolean;
  /** Owning entity, for mapping contacts back to gameplay. */
  readonly entityId?: EntityId;
  /** Linear damping, for air resistance on debris. */
  readonly linearDamping?: number;
  readonly angularDamping?: number;
  /** Permit the solver to sleep this body when at rest. Strongly recommended. */
  readonly canSleep?: boolean;
  /** Continuous collision detection. Needed for fast projectiles. */
  readonly ccd?: boolean;
}

/** A live rigid body. */
export interface IRigidBody {
  readonly handle: BodyHandle;
  readonly type: RigidBodyType;
  readonly entityId?: EntityId;
  /** True once the solver has put the body to sleep. */
  readonly isSleeping: boolean;
  readonly mass: number;

  /** Read the current transform into the supplied objects. */
  getTransform(position: THREE.Vector3, rotation: THREE.Quaternion): void;
  /** Teleport. Use sparingly on dynamic bodies — it breaks continuity. */
  setTransform(position: THREE.Vector3, rotation?: THREE.Quaternion): void;
  /** Read the current linear velocity. */
  getLinearVelocity(out: THREE.Vector3): THREE.Vector3;
  setLinearVelocity(v: THREE.Vector3): void;
  getAngularVelocity(out: THREE.Vector3): THREE.Vector3;
  setAngularVelocity(v: THREE.Vector3): void;
  /** Instantaneous impulse in newton-seconds. */
  applyImpulse(impulse: THREE.Vector3, point?: THREE.Vector3): void;
  /** Continuous force in newtons; applies for one step. */
  applyForce(force: THREE.Vector3, point?: THREE.Vector3): void;
  applyTorqueImpulse(torque: THREE.Vector3): void;
  /** Wake a sleeping body. */
  wake(): void;
  setEnabled(enabled: boolean): void;
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

/** A raycast/shapecast result. */
export interface IRaycastHit {
  readonly body: IRigidBody;
  readonly collider: ColliderHandle;
  /** Metres along the ray. */
  readonly distance: number;
  readonly point: THREE.Vector3;
  readonly normal: THREE.Vector3;
  readonly entityId?: EntityId;
  readonly layer: PhysicsLayer;
}

/** Raycast parameters. */
export interface IRaycastOptions {
  readonly origin: THREE.Vector3;
  /** Must be normalised. */
  readonly direction: THREE.Vector3;
  readonly maxDistance: number;
  /** Layers to test against. Omit to test all. */
  readonly layers?: readonly PhysicsLayer[];
  /** Bodies to ignore, e.g. the caster itself. */
  readonly exclude?: readonly BodyHandle[];
  /** Treat sensors as hits. */
  readonly includeSensors?: boolean;
}

/** A contact between two bodies, reported for the current step. */
export interface IContactEvent {
  readonly bodyA: BodyHandle;
  readonly bodyB: BodyHandle;
  readonly entityA?: EntityId;
  readonly entityB?: EntityId;
  readonly point: THREE.Vector3;
  readonly normal: THREE.Vector3;
  /** Total normal impulse; use as an impact-strength proxy for audio/VFX. */
  readonly impulse: number;
  /** Relative approach speed at contact, m/s. */
  readonly relativeSpeed: number;
}

/* -------------------------------------------------------------------------- */
/* Character controller                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Kinematic character controller. Used for the player and walking NPCs —
 * dynamic bodies make responsive movement very hard to tune.
 */
export interface ICharacterController {
  readonly body: IRigidBody;
  /** True when standing on walkable ground this step. */
  readonly isGrounded: boolean;
  /** Ground surface normal; +Y when airborne. */
  readonly groundNormal: THREE.Vector3;
  /** Current velocity, including gravity accumulation. */
  readonly velocity: THREE.Vector3;
  /** Steepest walkable slope in radians. */
  maxSlopeAngle: number;
  /** Maximum step height that can be climbed without jumping, in metres. */
  stepHeight: number;

  /** Move by a desired displacement, resolving collisions and slopes. */
  move(displacement: THREE.Vector3, dt: number): void;
  /** Apply an upward impulse. */
  jump(speed: number): void;
  /** Teleport. */
  setPosition(position: THREE.Vector3): void;
}

/* -------------------------------------------------------------------------- */
/* Ragdoll                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A physics ragdoll bound to a character skeleton. Created on death or heavy
 * knockback; the animator is disabled while the ragdoll drives the bones.
 */
export interface IRagdoll extends IDisposable {
  readonly bodies: readonly IRigidBody[];
  /** True while physics is driving the skeleton. */
  readonly active: boolean;
  /** Hand control to physics, seeding velocities from the current pose. */
  activate(initialImpulse?: THREE.Vector3, impulsePoint?: THREE.Vector3): void;
  /** Return control to the animator. */
  deactivate(): void;
  /** Copy body transforms onto the skeleton bones. Called each frame. */
  syncToSkeleton(): void;
}

/* -------------------------------------------------------------------------- */
/* World                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The physics world.
 *
 * STEPPING: the solver runs at a FIXED timestep (`IGameClock.fixedStep`),
 * sub-stepped `fixedStepCount` times per frame. Never step it with a raw
 * variable delta — determinism and stability both depend on this.
 */
export interface IPhysicsWorld extends IUpdatable, IDisposable {
  readonly gravity: THREE.Vector3;
  /** Live body count, for budget enforcement. */
  readonly bodyCount: number;
  /** Bodies currently awake. Sleeping bodies are nearly free. */
  readonly activeBodyCount: number;

  /** Create a body. */
  createBody(desc: IRigidBodyDesc): IRigidBody;
  /** Destroy a body and its colliders. */
  removeBody(handle: BodyHandle): void;
  getBody(handle: BodyHandle): IRigidBody | undefined;
  /** Create a kinematic character controller. */
  createCharacterController(
    position: THREE.Vector3,
    height: number,
    radius: number
  ): ICharacterController;

  /** Nearest hit along a ray. */
  raycast(options: IRaycastOptions): IRaycastHit | undefined;
  /** All hits along a ray, sorted by distance. */
  raycastAll(options: IRaycastOptions): IRaycastHit[];
  /** Bodies overlapping a sphere. */
  overlapSphere(centre: THREE.Vector3, radius: number, layers?: readonly PhysicsLayer[]): IRigidBody[];

  /** Contacts generated during the last step. */
  getContacts(): readonly IContactEvent[];
  /** Subscribe to contacts above an impulse threshold. */
  onContact(minImpulse: number, cb: (contact: IContactEvent) => void): () => void;

  /** Run `count` fixed sub-steps. Called by the loop, never ad hoc. */
  step(fixedStep: number, count: number): void;
  /** Interpolation factor 0..1 for smooth rendering between steps. */
  readonly alpha: number;
}
