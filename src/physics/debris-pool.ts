/**
 * DEBRIS POOL
 *
 * Budget-enforcing store for the rubble a fight leaves behind. Implements
 * `IDebrisPool`.
 *
 * ── FOUR DECISIONS THAT MAKE 300 PIECES AFFORDABLE ─────────────────────────
 *
 * 1. POOLED BODIES. Rigid bodies are allocated once at construction and
 *    recycled forever; only the collider is rebuilt per spawn (Rapier cannot
 *    resize a shape). A building collapse therefore allocates no bodies and no
 *    meshes at the exact moment the frame is already at its most expensive.
 *
 * 2. 8-VERTEX HULLS FROM THE CHUNK AABB. Not the chunk's real geometry. A true
 *    hull over a fractured concrete shard is dozens of planes; the box is 6,
 *    and on a piece tumbling past for two seconds nobody can tell.
 *
 * 3. BALLISTIC GRAVEL. Anything under `DEBRIS_MIN_PHYSICS_SIZE` skips the
 *    solver entirely and flies a parabola with a single bounce. Small debris
 *    is the majority of the piece count and contributes nothing to the
 *    simulation that a parabola does not.
 *
 * 4. HARD CAP + LRU. `capacity` is never exceeded. When full, the oldest
 *    SETTLED piece is recycled first (it is already visually inert); only if
 *    nothing has settled does the absolute oldest go. Pieces fade for
 *    `DEBRIS_FADE_SECONDS` before recycling so nothing vanishes mid-shot.
 */

import * as THREE from 'three';
import type { Collider, RigidBody as RapierRigidBody } from '@dimforge/rapier3d-compat';
import type { FractureChunk, IDebrisPiece, IDebrisPool } from '@/types';
import { clamp01, createRng, type IRandom } from '@/util';
import { PhysicsBody } from './body';
import { chunkHullPoints, chunkMaxExtent, convexHullDesc } from './colliders';
import { groupsFor } from './layers';
import type { PhysicsWorld } from './world';
import {
  BALLISTIC_GROUND_FRICTION,
  BALLISTIC_RESTITUTION,
  DEBRIS_FADE_SECONDS,
  DEBRIS_HARD_CAP,
  DEBRIS_MIN_PHYSICS_SIZE,
  DEBRIS_REST_SECONDS,
  DEFAULT_DEBRIS_DENSITY,
  GRAVITY_Y,
} from './constants';

/** Pool configuration. */
export interface IDebrisPoolOptions {
  /** Scene node the debris meshes are parented to. */
  readonly container?: THREE.Object3D;
  /** Live piece ceiling. Clamped to `DEBRIS_HARD_CAP`. */
  readonly capacity?: number;
  /** Material for pooled meshes. One shared instance by default. */
  readonly material?: THREE.Material;
  /** Ground plane height used by ballistic pieces. */
  readonly groundY?: number;
  /** Seeded generator for tumble. Never `Math.random()`. */
  readonly rng?: IRandom;
  /** AABB extent below which a piece skips the solver. */
  readonly minPhysicsSize?: number;
  /** Seconds at full opacity before the fade begins. */
  readonly restSeconds?: number;
  /** Fade duration before recycling. */
  readonly fadeSeconds?: number;
  /** Density fallback when a chunk carries no mass. */
  readonly density?: number;
}

/** A pooled piece. Extends the contract with pool bookkeeping. */
export interface IPooledDebris extends IDebrisPiece {
  readonly id: number;
  readonly mesh: THREE.Object3D;
  readonly bodyHandle: number;
  lifetime: number;
  settled: boolean;
  /** 1 while fully visible, ramping to 0 across the fade. */
  readonly fadeAlpha: number;
  /** True when the piece flies a parabola instead of being simulated. */
  readonly ballistic: boolean;
  /** Seconds since the piece was spawned. */
  readonly age: number;
}

/**
 * Internal slot state. One per pooled body.
 *
 * Structurally satisfies `IPooledDebris`, so a slot IS the public piece — no
 * second object, no copying, no cast.
 */
interface DebrisSlot extends IPooledDebris {
  readonly index: number;
  id: number;
  bodyHandle: number;
  active: boolean;
  ballistic: boolean;
  settled: boolean;
  age: number;
  lifetime: number;
  fadeAlpha: number;
  /** Monotonic spawn counter, for LRU ordering. */
  spawnOrder: number;
  readonly body: PhysicsBody;
  readonly raw: RapierRigidBody;
  collider: Collider | undefined;
  readonly mesh: THREE.Mesh;
  /** Chunk centroid, so the mesh can be offset off the body's centre of mass. */
  readonly centroid: THREE.Vector3;
  /** Ballistic integration state. */
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  readonly spin: THREE.Vector3;
  bounced: boolean;
  /** Half-height used to rest a ballistic piece on the ground. */
  halfHeight: number;
}

const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpVec = new THREE.Vector3();
const tmpEuler = new THREE.Euler();

/** Geometry every free slot points at, so a mesh always has one. */
const placeholderGeometry = new THREE.BoxGeometry(0.1, 0.1, 0.1);

export class DebrisPool implements IDebrisPool {
  readonly capacity: number;
  readonly container: THREE.Object3D;

  private readonly world: PhysicsWorld;
  private readonly slots: DebrisSlot[] = [];
  /** Active slots in spawn order — the LRU queue. */
  private readonly activeSlots: DebrisSlot[] = [];
  private readonly freeSlots: number[] = [];
  private readonly byId = new Map<number, DebrisSlot>();

  private readonly material: THREE.Material;
  private readonly ownsMaterial: boolean;
  private readonly groundY: number;
  private readonly rng: IRandom;
  private readonly minPhysicsSize: number;
  private readonly restSeconds: number;
  private readonly fadeSeconds: number;
  private readonly density: number;

  private nextId = 1;
  private spawnCounter = 0;
  private disposed = false;

  constructor(world: PhysicsWorld, options: IDebrisPoolOptions = {}) {
    this.world = world;
    this.capacity = Math.max(1, Math.min(options.capacity ?? DEBRIS_HARD_CAP, DEBRIS_HARD_CAP));
    this.container = options.container ?? new THREE.Group();
    this.groundY = options.groundY ?? 0;
    this.rng = options.rng ?? createRng('debris');
    this.minPhysicsSize = options.minPhysicsSize ?? DEBRIS_MIN_PHYSICS_SIZE;
    this.restSeconds = options.restSeconds ?? DEBRIS_REST_SECONDS;
    this.fadeSeconds = options.fadeSeconds ?? DEBRIS_FADE_SECONDS;
    this.density = options.density ?? DEFAULT_DEBRIS_DENSITY;

    this.ownsMaterial = options.material === undefined;
    this.material =
      options.material ??
      new THREE.MeshStandardMaterial({ color: 0x8a8580, roughness: 0.95, metalness: 0 });

    const R = world.rapier;
    for (let i = 0; i < this.capacity; i++) {
      // Bodies exist from the start and are simply disabled while free.
      const raw = world.raw.createRigidBody(
        R.RigidBodyDesc.dynamic()
          .setTranslation(0, -1000, 0)
          // Rubble is not a billiard ball: damping both settles the pile
          // within a couple of seconds and stops pieces sliding forever.
          .setLinearDamping(0.2)
          .setAngularDamping(0.6)
          .setCanSleep(true)
          .setEnabled(false)
      );
      const body = new PhysicsBody(raw, undefined, 'dynamic', 'debris', undefined, () => {
        /* debris never takes continuous forces */
      });
      world.register(body);
      const mesh = new THREE.Mesh(placeholderGeometry, this.material);
      mesh.visible = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.container.add(mesh);

      this.slots.push({
        index: i,
        id: 0,
        bodyHandle: raw.handle,
        active: false,
        ballistic: false,
        settled: false,
        age: 0,
        lifetime: 0,
        fadeAlpha: 1,
        spawnOrder: 0,
        body,
        raw,
        collider: undefined,
        mesh,
        centroid: new THREE.Vector3(),
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        spin: new THREE.Vector3(),
        bounced: false,
        halfHeight: 0.1,
      });
      this.freeSlots.push(i);
    }
    // Deterministic allocation order: slot 0 first.
    this.freeSlots.reverse();
  }

  /* ------------------------------------------------------------------ */
  /* Introspection                                                      */
  /* ------------------------------------------------------------------ */

  get count(): number {
    return this.activeSlots.length;
  }

  /** Pieces currently driven by the solver. */
  get simulatedCount(): number {
    let n = 0;
    for (const slot of this.activeSlots) if (!slot.ballistic) n++;
    return n;
  }

  /** Pieces flying a parabola instead of being simulated. */
  get ballisticCount(): number {
    let n = 0;
    for (const slot of this.activeSlots) if (slot.ballistic) n++;
    return n;
  }

  /** Pieces the solver has put to sleep. */
  get settledCount(): number {
    let n = 0;
    for (const slot of this.activeSlots) if (slot.settled) n++;
    return n;
  }

  /** Live pieces, oldest first. */
  get pieces(): readonly IPooledDebris[] {
    return this.activeSlots;
  }

  /** Look up a live piece. */
  get(id: number): IPooledDebris | undefined {
    return this.byId.get(id);
  }

  /* ------------------------------------------------------------------ */
  /* Spawning                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Spawn debris for a detached fracture chunk.
   *
   * Returns undefined only when the pool has no slots at all — with a non-empty
   * pool an LRU eviction always frees one, because dropping the oldest piece is
   * strictly better than dropping the one the player is watching land.
   */
  spawn(
    chunk: FractureChunk,
    worldMatrix: THREE.Matrix4,
    impulse: THREE.Vector3
  ): IPooledDebris | undefined {
    if (this.disposed) return undefined;

    const slot = this.acquireSlot();
    if (slot === undefined) return undefined;

    // World transform of the chunk's centre of mass.
    worldMatrix.decompose(tmpPos, tmpQuat, tmpVec);
    const centroidWorld = tmpPos.clone().add(chunk.centroid.clone().applyQuaternion(tmpQuat));

    const extent = chunkMaxExtent(chunk);
    const mass = chunk.mass > 0 ? chunk.mass : Math.max(0.1, chunk.volume * this.density);

    slot.id = this.nextId++;
    slot.active = true;
    slot.settled = false;
    slot.age = 0;
    slot.fadeAlpha = 1;
    slot.lifetime = this.restSeconds + this.fadeSeconds;
    slot.spawnOrder = this.spawnCounter++;
    slot.centroid.copy(chunk.centroid);
    slot.bounced = false;
    slot.halfHeight = Math.max(0.02, (chunk.bounds.max.y - chunk.bounds.min.y) * 0.5);
    slot.ballistic = extent < this.minPhysicsSize;
    // A ballistic piece has no simulated body, and must not be findable as one.
    slot.bodyHandle = slot.ballistic ? -1 : slot.body.handle;

    slot.mesh.geometry = chunk.geometry;
    slot.mesh.visible = true;

    if (slot.ballistic) {
      // Parabola: impulse / mass gives the launch velocity directly.
      slot.position.copy(centroidWorld);
      slot.velocity.copy(impulse).divideScalar(Math.max(0.01, mass));
      // Deterministic tumble; a seeded stream, never Math.random().
      slot.spin.set(
        this.rng.range(-6, 6),
        this.rng.range(-6, 6),
        this.rng.range(-6, 6)
      );
      slot.mesh.quaternion.copy(tmpQuat);
      this.writeMeshTransform(slot, slot.position, tmpQuat);
    } else {
      this.attachCollider(slot, chunk, mass);
      // Through the wrapper, so `PhysicsBody.isEnabled` (and therefore
      // `world.activeBodyCount`) stays truthful.
      slot.body.setEnabled(true);
      slot.raw.setTranslation(
        { x: centroidWorld.x, y: centroidWorld.y, z: centroidWorld.z },
        true
      );
      slot.raw.setRotation({ x: tmpQuat.x, y: tmpQuat.y, z: tmpQuat.z, w: tmpQuat.w }, true);
      slot.raw.setLinvel({ x: 0, y: 0, z: 0 }, false);
      slot.raw.setAngvel({ x: 0, y: 0, z: 0 }, false);
      slot.body.snapshot();
      slot.body.advanceInterpolation();
      slot.raw.applyImpulse({ x: impulse.x, y: impulse.y, z: impulse.z }, true);
      // A little spin so pieces do not slide out flat like tiles.
      const spin = Math.min(impulse.length() * 0.05, mass * 4);
      slot.raw.applyTorqueImpulse(
        {
          x: this.rng.range(-spin, spin),
          y: this.rng.range(-spin, spin),
          z: this.rng.range(-spin, spin),
        },
        true
      );
      this.syncMeshFromBody(slot, 1);
    }

    this.activeSlots.push(slot);
    this.byId.set(slot.id, slot);
    return slot;
  }

  /**
   * Spawn from an explicit AABB, for callers without a `FractureChunk`
   * (procedural rubble, the physics harness).
   */
  spawnBox(
    halfExtents: THREE.Vector3,
    position: THREE.Vector3,
    rotation: THREE.Quaternion,
    impulse: THREE.Vector3,
    geometry: THREE.BufferGeometry,
    density = this.density
  ): IPooledDebris | undefined {
    const volume = 8 * halfExtents.x * halfExtents.y * halfExtents.z;
    const chunk: FractureChunk = {
      index: 0,
      geometry,
      centroid: ZERO,
      volume,
      mass: volume * density,
      bounds: new THREE.Box3(
        new THREE.Vector3(-halfExtents.x, -halfExtents.y, -halfExtents.z),
        new THREE.Vector3(halfExtents.x, halfExtents.y, halfExtents.z)
      ),
      neighbours: EMPTY_NEIGHBOURS,
      isGrounded: false,
      detached: true,
    };
    tmpMatrix.compose(position, rotation, ONE);
    return this.spawn(chunk, tmpMatrix, impulse);
  }

  /**
   * Take a slot, evicting under the LRU policy when full.
   *
   * Settled pieces go first: they are asleep, motionless and almost certainly
   * behind the action, whereas the oldest awake piece may still be in flight.
   */
  private acquireSlot(): DebrisSlot | undefined {
    const free = this.freeSlots.pop();
    if (free !== undefined) return this.slots[free];
    if (this.activeSlots.length === 0) return undefined;

    let victim: DebrisSlot | undefined;
    for (const slot of this.activeSlots) {
      if (slot.settled) {
        victim = slot;
        break;
      }
    }
    victim ??= this.activeSlots[0];
    if (victim === undefined) return undefined;
    this.recycle(victim);
    const reclaimed = this.freeSlots.pop();
    return reclaimed === undefined ? undefined : this.slots[reclaimed];
  }

  private attachCollider(slot: DebrisSlot, chunk: FractureChunk, mass: number): void {
    if (slot.collider !== undefined) {
      this.world.raw.removeCollider(slot.collider, false);
      slot.collider = undefined;
    }
    const points = chunkHullPoints(chunk);
    const desc = convexHullDesc(this.world.rapier, points)
      .setMass(mass)
      .setFriction(0.85)
      .setRestitution(0.05)
      .setCollisionGroups(groupsFor('debris', ['world', 'debris', 'player', 'monster', 'ragdoll']));
    slot.collider = this.world.raw.createCollider(desc, slot.raw);
    // Mass properties are otherwise only refreshed on the next step, which
    // would leave the piece with the previous occupant's mass for one frame.
    slot.raw.recomputeMassPropertiesFromColliders();
    this.world.registerCollider(slot.collider.handle, slot.body);
  }

  /* ------------------------------------------------------------------ */
  /* Update                                                             */
  /* ------------------------------------------------------------------ */

  update(dt: number): void {
    if (this.disposed || dt <= 0) return;
    const alpha = this.world.alpha;

    for (let i = this.activeSlots.length - 1; i >= 0; i--) {
      const slot = this.activeSlots[i]!;
      slot.age += dt;
      slot.lifetime -= dt;
      slot.fadeAlpha = clamp01(slot.lifetime / this.fadeSeconds);

      if (slot.lifetime <= 0) {
        this.recycle(slot);
        continue;
      }

      if (slot.ballistic) {
        this.integrateBallistic(slot, dt);
      } else {
        slot.settled = slot.raw.isSleeping();
        this.syncMeshFromBody(slot, alpha);
      }
    }
  }

  /**
   * Parabola with exactly one bounce.
   *
   * The second ground contact stops the piece dead rather than bouncing again:
   * gravel that keeps micro-bouncing reads as jitter, and stopping is free.
   */
  private integrateBallistic(slot: DebrisSlot, dt: number): void {
    if (slot.settled) {
      this.writeMeshTransform(slot, slot.position, slot.mesh.quaternion);
      return;
    }
    slot.velocity.y += GRAVITY_Y * dt;
    slot.position.addScaledVector(slot.velocity, dt);

    tmpEuler.set(slot.spin.x * dt, slot.spin.y * dt, slot.spin.z * dt);
    tmpQuat.setFromEuler(tmpEuler);
    slot.mesh.quaternion.multiply(tmpQuat).normalize();

    const restY = this.groundY + slot.halfHeight;
    if (slot.position.y <= restY) {
      slot.position.y = restY;
      if (slot.bounced) {
        slot.velocity.set(0, 0, 0);
        slot.spin.set(0, 0, 0);
        slot.settled = true;
      } else {
        slot.bounced = true;
        slot.velocity.y = Math.abs(slot.velocity.y) * BALLISTIC_RESTITUTION;
        slot.velocity.x *= BALLISTIC_GROUND_FRICTION;
        slot.velocity.z *= BALLISTIC_GROUND_FRICTION;
        slot.spin.multiplyScalar(BALLISTIC_GROUND_FRICTION);
      }
    }
    this.writeMeshTransform(slot, slot.position, slot.mesh.quaternion);
  }

  private syncMeshFromBody(slot: DebrisSlot, alpha: number): void {
    slot.body.getRenderTransform(tmpPos, tmpQuat, alpha);
    this.writeMeshTransform(slot, tmpPos, tmpQuat);
  }

  /**
   * Position the mesh from a body transform.
   *
   * Two offsets are folded in here: the chunk centroid (the body sits at the
   * centre of mass, the geometry is authored around the parent's origin) and
   * the fade sink, which drops the piece through the floor as it fades so a
   * shared material never needs a per-piece opacity.
   */
  private writeMeshTransform(
    slot: DebrisSlot,
    position: THREE.Vector3,
    rotation: THREE.Quaternion
  ): void {
    tmpVec.copy(slot.centroid).applyQuaternion(rotation);
    const sink = (1 - slot.fadeAlpha) * slot.halfHeight * 2.2;
    slot.mesh.position.set(
      position.x - tmpVec.x,
      position.y - tmpVec.y - sink,
      position.z - tmpVec.z
    );
    slot.mesh.quaternion.copy(rotation);
    slot.mesh.updateMatrix();
  }

  /* ------------------------------------------------------------------ */
  /* Recycling                                                          */
  /* ------------------------------------------------------------------ */

  release(id: number): void {
    const slot = this.byId.get(id);
    if (slot !== undefined) this.recycle(slot);
  }

  private recycle(slot: DebrisSlot): void {
    if (!slot.active) return;
    slot.active = false;
    this.byId.delete(slot.id);
    const i = this.activeSlots.indexOf(slot);
    if (i !== -1) this.activeSlots.splice(i, 1);

    if (slot.collider !== undefined && !this.world.isDisposed) {
      this.world.unregisterCollider(slot.collider.handle);
      this.world.raw.removeCollider(slot.collider, false);
      // Drop the stale mass immediately; Rapier would otherwise keep it until
      // the next step and the next occupant would inherit it.
      slot.raw.recomputeMassPropertiesFromColliders();
    }
    slot.collider = undefined;
    if (!this.world.isDisposed) {
      slot.body.setEnabled(false);
      slot.raw.setLinvel({ x: 0, y: 0, z: 0 }, false);
      slot.raw.setAngvel({ x: 0, y: 0, z: 0 }, false);
      slot.raw.setTranslation({ x: 0, y: -1000, z: 0 }, false);
    }

    slot.mesh.visible = false;
    slot.mesh.geometry = placeholderGeometry;
    slot.settled = false;
    slot.ballistic = false;
    slot.fadeAlpha = 1;
    slot.lifetime = 0;
    this.freeSlots.push(slot.index);
  }

  clear(): void {
    for (let i = this.activeSlots.length - 1; i >= 0; i--) {
      this.recycle(this.activeSlots[i]!);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    for (const slot of this.slots) {
      this.world.removeBody(slot.body.handle);
      this.container.remove(slot.mesh);
    }
    this.slots.length = 0;
    this.freeSlots.length = 0;
    if (this.ownsMaterial) this.material.dispose();
  }
}

const ZERO = new THREE.Vector3(0, 0, 0);
const ONE = new THREE.Vector3(1, 1, 1);
const EMPTY_NEIGHBOURS: readonly number[] = [];
const tmpMatrix = new THREE.Matrix4();
