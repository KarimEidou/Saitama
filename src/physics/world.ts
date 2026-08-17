/**
 * PHYSICS WORLD
 *
 * `IPhysicsWorld` over Rapier. Owns the fixed-timestep accumulator, the body
 * registry, queries and contact reporting.
 *
 * ── FIXED TIMESTEP ─────────────────────────────────────────────────────────
 * The solver is NEVER stepped with a raw frame delta. Two reasons, and both
 * matter here:
 *
 *  1. DETERMINISM. The city generates from a seed and must replay identically.
 *     A variable dt makes every run diverge within a second, which would make
 *     the seeded world pointless the moment anything touches physics.
 *  2. STABILITY. Constraint solvers are tuned for a constant h. Feeding a
 *     34 ms frame after a hitch makes a settled debris pile explode.
 *
 * So `update(dt)` accumulates real time and drains it in whole 1/60 s steps,
 * capped at `MAX_SUB_STEPS` per frame, and leaves the remainder in `alpha` for
 * render interpolation.
 *
 * ── DETERMINISM RULES OBSERVED HERE ────────────────────────────────────────
 *  • no `Math.random()` — anything stochastic takes an `IRandom`;
 *  • no wall-clock time inside the simulation path;
 *  • query results are sorted by handle before being returned, so callers see
 *    a stable order regardless of broad-phase traversal.
 */

import * as THREE from 'three';
import type { Ball, Collider, EventQueue, Ray, World as RapierWorld } from '@dimforge/rapier3d-compat';
import type {
  BodyHandle,
  EntityId,
  IContactEvent,
  IEventBus,
  IPhysicsWorld,
  IRaycastHit,
  IRaycastOptions,
  IRigidBodyDesc,
  PhysicsLayer,
} from '@/types';
import { createLogger } from '@/util';
import { PhysicsBody } from './body';
import { CharacterController } from './character-controller';
import { createColliderDesc } from './colliders';
import { groupsFor, layerFromMask, queryGroups } from './layers';
import { FIXED_STEP, GRAVITY_Y, MAX_SUB_STEPS, SOLVER_ITERATIONS } from './constants';
import { getRapier, initPhysics, type Rapier } from './rapier-init';

const log = createLogger('physics');

/** Construction options. All optional; the defaults are the shipping values. */
export interface IPhysicsWorldOptions {
  /** Gravity vector. Defaults to `(0, GRAVITY_Y, 0)`. */
  readonly gravity?: THREE.Vector3;
  /** Fixed step length in seconds. */
  readonly fixedStep?: number;
  /** Maximum sub-steps consumed by one `update()`. */
  readonly maxSubSteps?: number;
  /** Bus used to publish physics-originated events. */
  readonly eventBus?: IEventBus;
  /** Collect contact events. Costs a little per step; on by default. */
  readonly contactEvents?: boolean;
  /**
   * Force magnitude (newtons) above which a contact is reported. Debris
   * grinding at rest generates a torrent of tiny contacts otherwise.
   */
  readonly contactForceThreshold?: number;
  /**
   * Report contacts for debris bodies too. Off by default: with 300 pieces
   * this is the single most expensive optional feature in the step.
   */
  readonly debrisContactEvents?: boolean;
  /** Constraint solver iterations. Lower is cheaper and bouncier. */
  readonly solverIterations?: number;
}

/** Registered contact subscriber. */
interface ContactSubscription {
  readonly minImpulse: number;
  readonly cb: (contact: IContactEvent) => void;
}

/** Mutable contact record, pooled to keep the step allocation-free. */
interface MutableContact {
  bodyA: BodyHandle;
  bodyB: BodyHandle;
  entityA: EntityId | undefined;
  entityB: EntityId | undefined;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  impulse: number;
  relativeSpeed: number;
}

const tmpVecA = new THREE.Vector3();
const tmpVecB = new THREE.Vector3();

export class PhysicsWorld implements IPhysicsWorld {
  readonly gravity: THREE.Vector3;
  readonly fixedStep: number;
  readonly maxSubSteps: number;

  /** Rapier module handle; passed to helpers rather than read from a global. */
  readonly rapier: Rapier;
  /** The underlying solver world. Physics-internal. */
  readonly raw: RapierWorld;

  private readonly bodies = new Map<BodyHandle, PhysicsBody>();
  /** Insertion-ordered body list; iteration order must not depend on the Map. */
  private readonly bodyList: PhysicsBody[] = [];
  private readonly byCollider = new Map<number, PhysicsBody>();
  private readonly byEntity = new Map<EntityId, PhysicsBody>();

  private readonly eventBus: IEventBus | undefined;
  private readonly wantsContacts: boolean;
  private readonly contactForceThreshold: number;
  private readonly debrisContactEvents: boolean;

  private readonly eventQueue: EventQueue | undefined;
  private readonly contacts: MutableContact[] = [];
  private contactCount_ = 0;
  private readonly contactSubs: ContactSubscription[] = [];

  private readonly pendingForceBodies: PhysicsBody[] = [];

  private accumulator = 0;
  private alphaValue = 0;
  private steppedCount = 0;
  /** Set when a collider was added or removed since the last step. */
  private queriesDirty = false;
  /** Query refreshes performed. Diagnostics — a high count means churn. */
  private queryRefreshes = 0;
  /** Simulated seconds since construction. Advances only in whole steps. */
  private simTime = 0;

  /** Cached query primitives; Rapier copies them into wasm on use. */
  private readonly queryRay: Ray;
  private readonly queryBall: Ball;

  private disposed = false;

  /* ------------------------------------------------------------------ */
  /* Construction                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Build a world, initialising Rapier first if needed.
   * The normal entry point — `new PhysicsWorld()` requires `initPhysics()`
   * to have already resolved.
   */
  static async create(options: IPhysicsWorldOptions = {}): Promise<PhysicsWorld> {
    await initPhysics();
    return new PhysicsWorld(options);
  }

  constructor(options: IPhysicsWorldOptions = {}) {
    this.rapier = getRapier();
    this.gravity = options.gravity?.clone() ?? new THREE.Vector3(0, GRAVITY_Y, 0);
    this.fixedStep = options.fixedStep ?? FIXED_STEP;
    this.maxSubSteps = options.maxSubSteps ?? MAX_SUB_STEPS;
    this.eventBus = options.eventBus;
    this.wantsContacts = options.contactEvents ?? true;
    this.contactForceThreshold = options.contactForceThreshold ?? 500;
    this.debrisContactEvents = options.debrisContactEvents ?? false;

    this.raw = new this.rapier.World({
      x: this.gravity.x,
      y: this.gravity.y,
      z: this.gravity.z,
    });
    this.raw.integrationParameters.dt = this.fixedStep;
    this.raw.integrationParameters.numSolverIterations =
      options.solverIterations ?? SOLVER_ITERATIONS;

    this.eventQueue = this.wantsContacts ? new this.rapier.EventQueue(true) : undefined;
    this.queryRay = new this.rapier.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    this.queryBall = new this.rapier.Ball(1);
  }

  /* ------------------------------------------------------------------ */
  /* Introspection                                                      */
  /* ------------------------------------------------------------------ */

  get bodyCount(): number {
    return this.bodyList.length;
  }

  /**
   * Dynamic bodies the solver is actually integrating.
   *
   * Fixed and kinematic bodies are excluded: Rapier reports them as not
   * sleeping (they are never in an island at all), so counting them would
   * report a fully settled debris pile as "5 bodies awake" forever.
   */
  get activeBodyCount(): number {
    let n = 0;
    for (const body of this.bodyList) {
      if (body.type === 'dynamic' && body.isEnabled && !body.isSleeping) n++;
    }
    return n;
  }

  /** Interpolation factor for the current frame, 0..1. */
  get alpha(): number {
    return this.alphaValue;
  }

  /** Fixed steps executed by the most recent `update()`. */
  get lastStepCount(): number {
    return this.steppedCount;
  }

  /** Simulated seconds elapsed. Advances only in whole fixed steps. */
  get time(): number {
    return this.simTime;
  }

  /** Every live body, in creation order. Read-only view for iteration. */
  get allBodies(): readonly PhysicsBody[] {
    return this.bodyList;
  }

  /* ------------------------------------------------------------------ */
  /* Bodies                                                             */
  /* ------------------------------------------------------------------ */

  createBody(desc: IRigidBodyDesc): PhysicsBody {
    const R = this.rapier;

    let bodyDesc;
    switch (desc.type) {
      case 'dynamic':
        bodyDesc = R.RigidBodyDesc.dynamic();
        break;
      case 'fixed':
        bodyDesc = R.RigidBodyDesc.fixed();
        break;
      case 'kinematic':
        bodyDesc = R.RigidBodyDesc.kinematicPositionBased();
        break;
    }

    bodyDesc.setTranslation(desc.position.x, desc.position.y, desc.position.z);
    if (desc.rotation !== undefined) {
      bodyDesc.setRotation({
        x: desc.rotation.x,
        y: desc.rotation.y,
        z: desc.rotation.z,
        w: desc.rotation.w,
      });
    }
    if (desc.linearDamping !== undefined) bodyDesc.setLinearDamping(desc.linearDamping);
    if (desc.angularDamping !== undefined) bodyDesc.setAngularDamping(desc.angularDamping);
    bodyDesc.setCanSleep(desc.canSleep ?? true);
    if (desc.ccd === true) bodyDesc.setCcdEnabled(true);

    const rawBody = this.raw.createRigidBody(bodyDesc);

    const colliderDesc = createColliderDesc(R, desc.shape);
    // Explicit mass wins over density; otherwise the shape's volume decides.
    if (desc.mass !== undefined) {
      colliderDesc.setMass(desc.mass);
    } else if (desc.density !== undefined) {
      colliderDesc.setDensity(desc.density);
    }
    colliderDesc.setFriction(desc.friction ?? 0.7);
    colliderDesc.setRestitution(desc.restitution ?? 0.05);
    colliderDesc.setCollisionGroups(groupsFor(desc.layer, desc.collidesWith));
    if (desc.isSensor === true) colliderDesc.setSensor(true);

    const reportContacts =
      this.wantsContacts && (desc.layer !== 'debris' || this.debrisContactEvents);
    if (reportContacts) {
      colliderDesc.setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS);
      colliderDesc.setContactForceEventThreshold(this.contactForceThreshold);
    }

    const collider = this.raw.createCollider(colliderDesc, rawBody);

    const body = new PhysicsBody(
      rawBody,
      collider,
      desc.type,
      desc.layer,
      desc.entityId,
      this.trackForces
    );
    this.register(body);
    return body;
  }

  /** Register an externally created body (character controller, ragdoll limb). */
  register(body: PhysicsBody): void {
    this.bodies.set(body.handle, body);
    this.bodyList.push(body);
    if (body.collider !== undefined) this.byCollider.set(body.collider.handle, body);
    if (body.entityId !== undefined) this.byEntity.set(body.entityId, body);
    this.queriesDirty = true;
  }

  /**
   * Mark scene queries stale.
   *
   * Rapier inserts new colliders into the query BVH during `step()`, so a
   * raycast or overlap issued between spawning a body and the next step would
   * simply not see it. That is not a hypothetical: a shockwave fired on the
   * same frame a building sheds its chunks is the single most common ordering
   * in this game. `refreshQueries()` closes the gap.
   */
  markQueriesDirty(): void {
    this.queriesDirty = true;
  }

  /**
   * Bring the query BVH up to date without advancing time.
   *
   * A zero-length step rebuilds the acceleration structure while integrating
   * nothing: positions, velocities and sleep timers all come out unchanged
   * (verified — `dt = 0` makes every integration term zero). No event queue is
   * passed, so no spurious contacts are reported either.
   */
  refreshQueries(): void {
    if (!this.queriesDirty || this.disposed) return;
    this.queriesDirty = false;
    this.queryRefreshes++;
    const dt = this.raw.integrationParameters.dt;
    this.raw.integrationParameters.dt = 0;
    this.raw.step();
    this.raw.integrationParameters.dt = dt;
  }

  /** Query refreshes performed since construction. */
  get queryRefreshCount(): number {
    return this.queryRefreshes;
  }

  /**
   * Map a newly created collider back to its body.
   *
   * Needed by the debris pool, which swaps a pooled body's collider on every
   * spawn — without this, contacts and queries on the new shape would find no
   * owner and be silently dropped.
   */
  registerCollider(colliderHandle: number, body: PhysicsBody): void {
    this.byCollider.set(colliderHandle, body);
    this.queriesDirty = true;
  }

  /** Drop a collider mapping ahead of removing the collider. */
  unregisterCollider(colliderHandle: number): void {
    this.byCollider.delete(colliderHandle);
    this.queriesDirty = true;
  }

  removeBody(handle: BodyHandle): void {
    // After dispose the solver world is freed; touching a body would trap the
    // wasm module. Pools and managers legitimately dispose in either order.
    if (this.disposed) return;
    const body = this.bodies.get(handle);
    if (body === undefined) return;
    this.bodies.delete(handle);
    if (body.collider !== undefined) this.byCollider.delete(body.collider.handle);
    if (body.entityId !== undefined && this.byEntity.get(body.entityId) === body) {
      this.byEntity.delete(body.entityId);
    }
    const i = this.bodyList.indexOf(body);
    if (i !== -1) this.bodyList.splice(i, 1);
    const pending = this.pendingForceBodies.indexOf(body);
    if (pending !== -1) this.pendingForceBodies.splice(pending, 1);
    // Removing the body removes its colliders with it.
    this.raw.removeRigidBody(body.raw);
    this.queriesDirty = true;
  }

  getBody(handle: BodyHandle): PhysicsBody | undefined {
    return this.bodies.get(handle);
  }

  /** Body owned by an entity, when one was registered with an `entityId`. */
  getBodyByEntity(entityId: EntityId): PhysicsBody | undefined {
    return this.byEntity.get(entityId);
  }

  /** Body owning a collider. Used to map query and contact results back. */
  getBodyByCollider(colliderHandle: number): PhysicsBody | undefined {
    return this.byCollider.get(colliderHandle);
  }

  /**
   * Create a kinematic character controller.
   *
   * `character-controller.ts` imports this module TYPE-ONLY, so this runtime
   * import direction is the only one and there is no module cycle.
   */
  createCharacterController(
    position: THREE.Vector3,
    height: number,
    radius: number
  ): CharacterController {
    return new CharacterController(this, { position, height, radius });
  }

  /* ------------------------------------------------------------------ */
  /* Stepping                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Advance by a frame delta.
   *
   * Drains the accumulator in whole fixed steps. When more than `maxSubSteps`
   * are owed, the surplus is DISCARDED rather than run: catching up after a
   * long stall costs more than the stall itself and reliably causes a second.
   */
  update(dt: number): void {
    if (this.disposed) return;
    // Guard against a negative or absurd delta from a suspended tab.
    const clamped = dt > 0 ? Math.min(dt, 0.25) : 0;
    this.accumulator += clamped;

    let steps = 0;
    while (this.accumulator >= this.fixedStep && steps < this.maxSubSteps) {
      this.stepOnce();
      this.accumulator -= this.fixedStep;
      steps++;
    }
    if (steps === this.maxSubSteps && this.accumulator > this.fixedStep) {
      this.accumulator = this.fixedStep * 0.5;
    }
    this.steppedCount = steps;
    this.alphaValue = this.accumulator / this.fixedStep;
  }

  /**
   * Run `count` fixed sub-steps immediately, bypassing the accumulator.
   * Used by the game loop's fixed-update band and by tests.
   */
  step(fixedStep: number, count: number): void {
    if (this.disposed) return;
    if (Math.abs(fixedStep - this.fixedStep) > 1e-9) {
      this.raw.integrationParameters.dt = fixedStep;
    }
    for (let i = 0; i < count; i++) this.stepOnce(fixedStep);
    this.raw.integrationParameters.dt = this.fixedStep;
    this.steppedCount = count;
    // `step()` means "advance exactly this far, now": there is no leftover
    // time, so the newest state is the one to display. (`update()` keeps the
    // standard convention of blending from the previous step by the leftover
    // fraction, which never extrapolates past what has been simulated.)
    this.alphaValue = 1;
  }

  private stepOnce(stepLength = this.fixedStep): void {
    for (const body of this.bodyList) body.advanceInterpolation();

    this.queriesDirty = false;
    this.raw.step(this.eventQueue);
    this.simTime += stepLength;

    // Forces are one-shot per the contract; Rapier keeps them until cleared.
    if (this.pendingForceBodies.length > 0) {
      for (const body of this.pendingForceBodies) {
        body.raw.resetForces(false);
        body.raw.resetTorques(false);
        body.forcesPending = false;
      }
      this.pendingForceBodies.length = 0;
    }

    // Sleeping bodies do not move, so only refresh the ones that can have.
    for (const body of this.bodyList) {
      if (!body.isSleeping) body.snapshot();
    }

    if (this.eventQueue !== undefined) this.collectContacts();
  }

  /* ------------------------------------------------------------------ */
  /* Contacts                                                           */
  /* ------------------------------------------------------------------ */

  private collectContacts(): void {
    this.contactCount_ = 0;
    const queue = this.eventQueue;
    if (queue === undefined) return;

    // Only CONTACT_FORCE_EVENTS are enabled on colliders, so the collision
    // (started/stopped) buffer stays empty and needs no drain.
    queue.drainContactForceEvents((event) => {
      const a = this.byCollider.get(event.collider1());
      const b = this.byCollider.get(event.collider2());
      if (a === undefined || b === undefined) return;

      const record = this.ensureContact(this.contactCount_++);
      record.bodyA = a.handle;
      record.bodyB = b.handle;
      record.entityA = a.entityId;
      record.entityB = b.entityId;

      // Impulse = force * dt, the quantity gameplay compares against.
      record.impulse = event.totalForceMagnitude() * this.fixedStep;
      const dir = event.maxForceDirection();
      record.normal.set(dir.x, dir.y, dir.z);

      // Approach speed along the contact normal, for audio/VFX intensity.
      a.getLinearVelocity(tmpVecA);
      b.getLinearVelocity(tmpVecB);
      record.relativeSpeed = Math.abs(tmpVecA.sub(tmpVecB).dot(record.normal));

      if (a.collider !== undefined && b.collider !== undefined) {
        this.readContactPoint(a.collider, b.collider, record.point);
      }
    });

    if (this.contactCount_ > 0 && this.contactSubs.length > 0) {
      for (let i = 0; i < this.contactCount_; i++) {
        const contact = this.contacts[i]!;
        for (const sub of this.contactSubs) {
          if (contact.impulse >= sub.minImpulse) {
            try {
              sub.cb(contact);
            } catch (error) {
              log.error('contact handler threw', error);
            }
          }
        }
      }
    }
  }

  /** World-space contact point for a pair; falls back to the midpoint. */
  private readContactPoint(a: Collider, b: Collider, out: THREE.Vector3): void {
    let found = false;
    this.raw.contactPair(a, b, (manifold) => {
      if (found || manifold.numSolverContacts() === 0) return;
      const p = manifold.solverContactPoint(0);
      if (p !== null) {
        out.set(p.x, p.y, p.z);
        found = true;
      }
    });
    if (!found) {
      const pa = a.translation();
      const pb = b.translation();
      out.set((pa.x + pb.x) * 0.5, (pa.y + pb.y) * 0.5, (pa.z + pb.z) * 0.5);
    }
  }

  /** Contacts from the last step without copying; pair with `contactAt`. */
  get contactCount(): number {
    return this.contactCount_;
  }

  /**
   * Read one contact from the last step, without the array copy `getContacts()`
   * makes. Index must be below `contactCount`.
   */
  contactAt(index: number): IContactEvent | undefined {
    return index >= 0 && index < this.contactCount_ ? this.contacts[index] : undefined;
  }

  private ensureContact(index: number): MutableContact {
    let record = this.contacts[index];
    if (record === undefined) {
      record = {
        bodyA: 0,
        bodyB: 0,
        entityA: undefined,
        entityB: undefined,
        point: new THREE.Vector3(),
        normal: new THREE.Vector3(),
        impulse: 0,
        relativeSpeed: 0,
      };
      this.contacts[index] = record;
    }
    return record;
  }

  getContacts(): readonly IContactEvent[] {
    return this.contacts.slice(0, this.contactCount_);
  }

  onContact(minImpulse: number, cb: (contact: IContactEvent) => void): () => void {
    const sub: ContactSubscription = { minImpulse, cb };
    this.contactSubs.push(sub);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const i = this.contactSubs.indexOf(sub);
      if (i !== -1) this.contactSubs.splice(i, 1);
    };
  }

  /* ------------------------------------------------------------------ */
  /* Queries                                                            */
  /* ------------------------------------------------------------------ */

  raycast(options: IRaycastOptions): IRaycastHit | undefined {
    this.refreshQueries();
    const ray = this.queryRay;
    ray.origin = { x: options.origin.x, y: options.origin.y, z: options.origin.z };
    ray.dir = { x: options.direction.x, y: options.direction.y, z: options.direction.z };

    const R = this.rapier;
    let flags = R.QueryFilterFlags.EXCLUDE_SENSORS;
    if (options.includeSensors === true) flags = 0 as typeof flags;

    const predicate = this.excludePredicate(options.exclude);
    const hit = this.raw.castRayAndGetNormal(
      ray,
      options.maxDistance,
      true,
      flags,
      queryGroups(options.layers),
      undefined,
      undefined,
      predicate
    );
    if (hit === null) return undefined;

    const body = this.byCollider.get(hit.collider.handle);
    if (body === undefined) return undefined;
    return {
      body,
      collider: hit.collider.handle,
      distance: hit.timeOfImpact,
      point: new THREE.Vector3(
        options.origin.x + options.direction.x * hit.timeOfImpact,
        options.origin.y + options.direction.y * hit.timeOfImpact,
        options.origin.z + options.direction.z * hit.timeOfImpact
      ),
      normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
      entityId: body.entityId,
      layer: body.layer,
    };
  }

  raycastAll(options: IRaycastOptions): IRaycastHit[] {
    this.refreshQueries();
    const ray = this.queryRay;
    ray.origin = { x: options.origin.x, y: options.origin.y, z: options.origin.z };
    ray.dir = { x: options.direction.x, y: options.direction.y, z: options.direction.z };

    const R = this.rapier;
    let flags = R.QueryFilterFlags.EXCLUDE_SENSORS;
    if (options.includeSensors === true) flags = 0 as typeof flags;

    const predicate = this.excludePredicate(options.exclude);
    const hits: IRaycastHit[] = [];
    this.raw.intersectionsWithRay(
      ray,
      options.maxDistance,
      true,
      (intersection) => {
        const body = this.byCollider.get(intersection.collider.handle);
        if (body !== undefined) {
          hits.push({
            body,
            collider: intersection.collider.handle,
            distance: intersection.timeOfImpact,
            point: new THREE.Vector3(
              options.origin.x + options.direction.x * intersection.timeOfImpact,
              options.origin.y + options.direction.y * intersection.timeOfImpact,
              options.origin.z + options.direction.z * intersection.timeOfImpact
            ),
            normal: new THREE.Vector3(
              intersection.normal.x,
              intersection.normal.y,
              intersection.normal.z
            ),
            entityId: body.entityId,
            layer: body.layer,
          });
        }
        return true;
      },
      flags,
      queryGroups(options.layers),
      undefined,
      undefined,
      predicate
    );
    // Stable ordering: distance first, then handle so ties never reorder.
    hits.sort((a, b) => a.distance - b.distance || a.body.handle - b.body.handle);
    return hits;
  }

  /**
   * Bodies overlapping a sphere, sorted by handle.
   *
   * The sort is not cosmetic: broad-phase traversal order depends on internal
   * tree layout, and anything that applies impulses in traversal order would
   * diverge between two runs of the same seed.
   */
  overlapSphere(
    centre: THREE.Vector3,
    radius: number,
    layers?: readonly PhysicsLayer[]
  ): PhysicsBody[] {
    this.refreshQueries();
    this.queryBall.radius = radius;
    const found: PhysicsBody[] = [];
    const seen = new Set<BodyHandle>();
    this.raw.intersectionsWithShape(
      { x: centre.x, y: centre.y, z: centre.z },
      { x: 0, y: 0, z: 0, w: 1 },
      this.queryBall,
      (collider) => {
        const body = this.byCollider.get(collider.handle);
        if (body !== undefined && !seen.has(body.handle)) {
          seen.add(body.handle);
          found.push(body);
        }
        return true;
      },
      this.rapier.QueryFilterFlags.EXCLUDE_SENSORS,
      queryGroups(layers)
    );
    found.sort((a, b) => a.handle - b.handle);
    return found;
  }

  private excludePredicate(
    exclude: readonly BodyHandle[] | undefined
  ): ((collider: Collider) => boolean) | undefined {
    if (exclude === undefined || exclude.length === 0) return undefined;
    return (collider: Collider): boolean => {
      const body = this.byCollider.get(collider.handle);
      return body === undefined || !exclude.includes(body.handle);
    };
  }

  /** Layer a collider belongs to, derived from its membership mask. */
  layerOfCollider(collider: Collider): PhysicsLayer | undefined {
    return layerFromMask(collider.collisionGroups() >>> 16);
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  /** The bus this world publishes on, if any. */
  get bus(): IEventBus | undefined {
    return this.eventBus;
  }

  /** True once `dispose()` has run. The solver world is gone after that. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  private readonly trackForces = (body: PhysicsBody): void => {
    this.pendingForceBodies.push(body);
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.contactSubs.length = 0;
    this.contacts.length = 0;
    this.contactCount_ = 0;
    this.bodies.clear();
    this.byCollider.clear();
    this.byEntity.clear();
    this.bodyList.length = 0;
    this.pendingForceBodies.length = 0;
    this.eventQueue?.free();
    this.raw.free();
  }
}
