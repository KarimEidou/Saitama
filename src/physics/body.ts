/**
 * RIGID BODY WRAPPER
 *
 * Implements `IRigidBody` over a Rapier body + its primary collider, and owns
 * the render interpolation state.
 *
 * WHY INTERPOLATE: the solver advances in fixed 1/60 s steps while the display
 * refreshes at whatever rate it likes. Reading the solver transform directly
 * makes objects visibly stutter on a 120 Hz phone (some frames get a new
 * transform, some do not). Storing the previous and current step transforms and
 * blending by the world's `alpha` costs 14 floats per body and removes the
 * judder entirely.
 *
 * The two transforms are kept as raw numbers rather than THREE objects: 300
 * debris pieces would otherwise mean 600 Vector3s and 600 Quaternions of
 * permanently resident garbage, and every read would chase pointers.
 */

import type * as THREE from 'three';
import type {
  Collider,
  RigidBody as RapierBody,
  RigidBodyType as RapierBodyType,
} from '@dimforge/rapier3d-compat';
import type {
  BodyHandle,
  ColliderHandle,
  EntityId,
  IRigidBody,
  PhysicsLayer,
  RigidBodyType,
} from '@/types';

/** Callback the world installs so `applyForce` can be undone after the step. */
export type ForceNotifier = (body: PhysicsBody) => void;

/** Reusable plain vector, so wrapper calls never allocate. */
interface MutableVec {
  x: number;
  y: number;
  z: number;
}

/** Reusable quaternion shape, for reads that would otherwise allocate. */
interface MutableQuat {
  x: number;
  y: number;
  z: number;
  w: number;
}

const scratchVec: MutableVec = { x: 0, y: 0, z: 0 };

/**
 * Read targets handed to Rapier's accessors. Without a target every accessor
 * allocates a fresh object; with one it fills and returns this. Two distinct
 * objects because `snapshot()` holds a translation and a rotation at once, and
 * both are kept distinct from `scratchVec` so a read can never clobber a
 * pending write.
 */
const readVec: MutableVec = { x: 0, y: 0, z: 0 };
const readQuat: MutableQuat = { x: 0, y: 0, z: 0, w: 1 };

/** A live rigid body. Created by the world; never constructed directly. */
export class PhysicsBody implements IRigidBody {
  readonly handle: BodyHandle;
  readonly entityId: EntityId | undefined;
  readonly layer: PhysicsLayer;

  /** Mirror of the solver's body type; kept truthful by `setType`. */
  private bodyType: RigidBodyType;

  /** The underlying solver body. Physics-internal; do not leak to gameplay. */
  readonly raw: RapierBody;
  /**
   * The primary collider. MUTABLE, and undefined between shapes: pooled debris
   * keeps its body forever but rebuilds the collider on every spawn, because
   * Rapier shapes cannot be resized.
   */
  collider: Collider | undefined;

  /** True while the body participates in the simulation. */
  private enabled: boolean;
  /** Set when `applyForce`/`applyTorque` ran, so the world can clear it. */
  forcesPending = false;

  /* Interpolation: transform at the start (prev) and end (curr) of the last step. */
  private px = 0;
  private py = 0;
  private pz = 0;
  private pqx = 0;
  private pqy = 0;
  private pqz = 0;
  private pqw = 1;
  private cx = 0;
  private cy = 0;
  private cz = 0;
  private cqx = 0;
  private cqy = 0;
  private cqz = 0;
  private cqw = 1;

  private readonly onForce: ForceNotifier;

  constructor(
    raw: RapierBody,
    collider: Collider | undefined,
    type: RigidBodyType,
    layer: PhysicsLayer,
    entityId: EntityId | undefined,
    onForce: ForceNotifier
  ) {
    this.raw = raw;
    this.collider = collider;
    this.handle = raw.handle;
    this.bodyType = type;
    this.layer = layer;
    this.entityId = entityId;
    this.onForce = onForce;
    // Mirror the solver's own state: bodies may be created already disabled.
    this.enabled = raw.isEnabled();
    this.snapshot();
    // Seed both ends of the interpolation so frame 0 does not blend from origin.
    this.px = this.cx;
    this.py = this.cy;
    this.pz = this.cz;
    this.pqx = this.cqx;
    this.pqy = this.cqy;
    this.pqz = this.cqz;
    this.pqw = this.cqw;
  }

  /** Handle of the current collider, or -1 while the body has none. */
  get colliderHandle(): ColliderHandle {
    return this.collider?.handle ?? -1;
  }

  /** How the solver is currently simulating this body. */
  get type(): RigidBodyType {
    return this.bodyType;
  }

  /**
   * Change the body type, keeping `type` truthful.
   *
   * Callers that go straight to `raw.setBodyType` leave the wrapper reporting
   * the type the body had at construction, and both consumers of `type`
   * (`PhysicsWorld.activeBodyCount` and `applyRadialImpulse`) then act on a
   * lie — a frozen ragdoll limb is counted as awake forever and is handed
   * impulses the solver discards.
   *
   * The solver's own enum value is supplied by the caller: this file imports
   * Rapier TYPES only, and `world.rapier` is the one place the module lives.
   */
  setType(type: RigidBodyType, rawType: RapierBodyType, wakeUp = false): void {
    this.bodyType = type;
    this.raw.setBodyType(rawType, wakeUp);
  }

  get isSleeping(): boolean {
    return this.raw.isSleeping();
  }

  get mass(): number {
    return this.raw.mass();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /* ------------------------------------------------------------------ */
  /* Interpolation                                                      */
  /* ------------------------------------------------------------------ */

  /** Promote the current transform to previous. Called before a solver step. */
  advanceInterpolation(): void {
    this.px = this.cx;
    this.py = this.cy;
    this.pz = this.cz;
    this.pqx = this.cqx;
    this.pqy = this.cqy;
    this.pqz = this.cqz;
    this.pqw = this.cqw;
  }

  /** Read the solver transform into the `curr` slot. Called after a step. */
  snapshot(): void {
    const t = this.raw.translation(readVec);
    const r = this.raw.rotation(readQuat);
    this.cx = t.x;
    this.cy = t.y;
    this.cz = t.z;
    this.cqx = r.x;
    this.cqy = r.y;
    this.cqz = r.z;
    this.cqw = r.w;
  }

  /**
   * Transform for RENDERING: the fixed-step transforms blended by `alpha`.
   *
   * Rotation uses nlerp rather than slerp — over a single 16 ms step the
   * angular difference is small enough that the error is invisible, and nlerp
   * is several times cheaper across hundreds of bodies.
   */
  getRenderTransform(position: THREE.Vector3, rotation: THREE.Quaternion, alpha: number): void {
    const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    position.set(
      this.px + (this.cx - this.px) * a,
      this.py + (this.cy - this.py) * a,
      this.pz + (this.cz - this.pz) * a
    );

    // Take the shorter arc; quaternions q and -q are the same orientation.
    const dot =
      this.pqx * this.cqx + this.pqy * this.cqy + this.pqz * this.cqz + this.pqw * this.cqw;
    const sign = dot < 0 ? -1 : 1;
    let x = this.pqx + (this.cqx * sign - this.pqx) * a;
    let y = this.pqy + (this.cqy * sign - this.pqy) * a;
    let z = this.pqz + (this.cqz * sign - this.pqz) * a;
    let w = this.pqw + (this.cqw * sign - this.pqw) * a;
    const len = Math.hypot(x, y, z, w);
    if (len > 1e-8) {
      const inv = 1 / len;
      x *= inv;
      y *= inv;
      z *= inv;
      w *= inv;
    } else {
      x = 0;
      y = 0;
      z = 0;
      w = 1;
    }
    rotation.set(x, y, z, w);
  }

  /* ------------------------------------------------------------------ */
  /* IRigidBody                                                         */
  /* ------------------------------------------------------------------ */

  getTransform(position: THREE.Vector3, rotation: THREE.Quaternion): void {
    const t = this.raw.translation(readVec);
    const r = this.raw.rotation(readQuat);
    position.set(t.x, t.y, t.z);
    rotation.set(r.x, r.y, r.z, r.w);
  }

  setTransform(position: THREE.Vector3, rotation?: THREE.Quaternion): void {
    scratchVec.x = position.x;
    scratchVec.y = position.y;
    scratchVec.z = position.z;
    this.raw.setTranslation(scratchVec, true);
    if (rotation !== undefined) {
      this.raw.setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w }, true);
    }
    // A teleport has no continuity to interpolate; collapse both ends onto it.
    this.snapshot();
    this.advanceInterpolation();
  }

  getLinearVelocity(out: THREE.Vector3): THREE.Vector3 {
    const v = this.raw.linvel(readVec);
    return out.set(v.x, v.y, v.z);
  }

  setLinearVelocity(v: THREE.Vector3): void {
    scratchVec.x = v.x;
    scratchVec.y = v.y;
    scratchVec.z = v.z;
    this.raw.setLinvel(scratchVec, true);
  }

  getAngularVelocity(out: THREE.Vector3): THREE.Vector3 {
    const v = this.raw.angvel(readVec);
    return out.set(v.x, v.y, v.z);
  }

  setAngularVelocity(v: THREE.Vector3): void {
    scratchVec.x = v.x;
    scratchVec.y = v.y;
    scratchVec.z = v.z;
    this.raw.setAngvel(scratchVec, true);
  }

  applyImpulse(impulse: THREE.Vector3, point?: THREE.Vector3): void {
    scratchVec.x = impulse.x;
    scratchVec.y = impulse.y;
    scratchVec.z = impulse.z;
    if (point === undefined) {
      this.raw.applyImpulse(scratchVec, true);
    } else {
      this.raw.applyImpulseAtPoint(scratchVec, { x: point.x, y: point.y, z: point.z }, true);
    }
  }

  applyForce(force: THREE.Vector3, point?: THREE.Vector3): void {
    scratchVec.x = force.x;
    scratchVec.y = force.y;
    scratchVec.z = force.z;
    if (point === undefined) {
      this.raw.addForce(scratchVec, true);
    } else {
      this.raw.addForceAtPoint(scratchVec, { x: point.x, y: point.y, z: point.z }, true);
    }
    // Rapier accumulates forces until explicitly reset; the contract says a
    // force lasts one step, so the world clears it after the next step.
    if (!this.forcesPending) {
      this.forcesPending = true;
      this.onForce(this);
    }
  }

  applyTorqueImpulse(torque: THREE.Vector3): void {
    scratchVec.x = torque.x;
    scratchVec.y = torque.y;
    scratchVec.z = torque.z;
    this.raw.applyTorqueImpulse(scratchVec, true);
  }

  wake(): void {
    this.raw.wakeUp();
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.raw.setEnabled(enabled);
  }
}
