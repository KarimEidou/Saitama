/**
 * KINEMATIC CHARACTER CONTROLLER
 *
 * Saitama's locomotion. Built on Rapier's `KinematicCharacterController`
 * rather than a dynamic body, because a dynamic body is at the mercy of the
 * solver: it slides down slopes, gets shoved by debris, and reacts to input a
 * frame or two late. A kinematic capsule that is swept and slid manually gives
 * exact, repeatable motion — which is also what determinism requires.
 *
 * ── THE MOVEMENT CURVE ─────────────────────────────────────────────────────
 * Ground run 9 m/s, dash 22 m/s, jump apex ~28 m. Those are absurd, and that
 * is the point: the fantasy is that the strongest man alive crosses a city
 * block without trying. Making that feel good rather than floaty needs an
 * ASYMMETRIC gravity curve:
 *
 *      rise:  g = -22 m/s^2          (fast up, readable apex)
 *      fall:  g = -22 * 1.6 m/s^2    (heavier down, snappy landing)
 *
 * A symmetric parabola at this scale hangs in the air for well over a second
 * and reads as weightless. The 1.6x fall multiplier is the standard platformer
 * fix, and it also gets the player back into a fight faster.
 *
 * ── LANDINGS ───────────────────────────────────────────────────────────────
 * Impact speed and fall height are tracked across the airborne arc. A fall of
 * more than `GROUND_SLAM_FALL_HEIGHT` (15 m) marks the landing as a ground
 * slam: this module emits `PlayerLanded` with `createsCrater: true` and pushes
 * nearby debris outward. It does NOT implement destruction — the destruction
 * system subscribes to that event and detaches fracture chunks itself.
 */

import * as THREE from 'three';
import type {
  Collider,
  KinematicCharacterController as RapierCharacterController,
  RigidBody as RapierRigidBody,
} from '@dimforge/rapier3d-compat';
import type { EntityId, ICharacterController, LethalIntent, PhysicsLayer } from '@/types';
import { clamp, createRng, type IRandom } from '@/util';
import { PhysicsBody } from './body';
import { actorCapsuleDesc } from './colliders';
import { applyRadialImpulse } from './impulse';
import { groupsFor } from './layers';
import type { PhysicsWorld } from './world';
import {
  CHARACTER_SKIN,
  COYOTE_TIME,
  DASH_SPEED,
  FALL_GRAVITY_MULTIPLIER,
  GRAVITY_Y,
  GROUND_SLAM_BASE_RADIUS,
  GROUND_SLAM_FALL_HEIGHT,
  GROUND_SLAM_MAX_RADIUS,
  GROUND_SLAM_RADIUS_PER_METRE,
  GROUND_SNAP_DISTANCE,
  JUMP_APEX_HEIGHT,
  JUMP_SPEED,
  MAX_FALL_SPEED,
  MAX_SLOPE_ANGLE,
  MIN_SLOPE_SLIDE_ANGLE,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  RUN_SPEED,
  STEP_HEIGHT,
  STEP_MIN_WIDTH,
} from './constants';

/** Controller construction options. */
export interface ICharacterControllerOptions {
  readonly position: THREE.Vector3;
  /** Total capsule height including the caps. */
  readonly height?: number;
  readonly radius?: number;
  readonly layer?: PhysicsLayer;
  readonly collidesWith?: readonly PhysicsLayer[];
  readonly entityId?: EntityId;
  /** Force commitment reported on landing events. */
  readonly intent?: LethalIntent;
  /** Emit `PlayerLanded` on the world's bus. Only the player should. */
  readonly emitLandingEvents?: boolean;
  /** Push nearby dynamic bodies on a ground-slam landing. */
  readonly groundSlamShock?: boolean;
  /** Seeded stream for ground-slam tumble. Never `Math.random()`. */
  readonly rng?: IRandom;
}

/** A landing, reported by `onLanded` and mirrored onto the event bus. */
export interface ILandingReport {
  /** Downward speed at contact, m/s. */
  readonly impactSpeed: number;
  /** Metres fallen from the apex. */
  readonly fallHeight: number;
  /** True once the fall exceeds `GROUND_SLAM_FALL_HEIGHT`. */
  readonly createsCrater: boolean;
  readonly position: THREE.Vector3;
}

const tmpMove = new THREE.Vector3();
const tmpVec = new THREE.Vector3();

export class CharacterController implements ICharacterController {
  readonly body: PhysicsBody;
  readonly groundNormal = new THREE.Vector3(0, 1, 0);
  readonly velocity = new THREE.Vector3();

  maxSlopeAngle = MAX_SLOPE_ANGLE;
  stepHeight = STEP_HEIGHT;

  /** Horizontal ground speed used by `moveInDirection`. */
  runSpeed = RUN_SPEED;
  /** Horizontal speed while dashing. */
  dashSpeed = DASH_SPEED;
  /** True while the caller wants dash speed. */
  dashing = false;
  /** Reported on landing events. */
  intent: LethalIntent;

  private readonly world: PhysicsWorld;
  private readonly controller: RapierCharacterController;
  private readonly collider: Collider;
  private readonly raw: RapierRigidBody;
  private readonly position = new THREE.Vector3();
  private readonly emitLandings: boolean;
  private readonly groundSlamShock: boolean;
  private readonly slamRng: IRandom;
  /** Bodies moved by the most recent ground slam. Diagnostics only. */
  private lastSlamAffected = 0;

  private grounded = false;
  private wasGrounded = false;
  private airTime = 0;
  private timeSinceGrounded = Number.POSITIVE_INFINITY;
  private apexY = 0;
  private lastImpactSpeed = 0;
  private lastFallHeight = 0;
  private landedCallbacks: ((report: ILandingReport) => void)[] = [];
  private disposed = false;

  constructor(world: PhysicsWorld, options: ICharacterControllerOptions) {
    this.world = world;
    const R = world.rapier;
    const height = options.height ?? PLAYER_HEIGHT;
    const radius = options.radius ?? PLAYER_RADIUS;
    const layer = options.layer ?? 'player';
    const collidesWith = options.collidesWith ?? ['world', 'monster', 'npc', 'debris', 'trigger'];
    this.intent = options.intent ?? 'normal';
    this.emitLandings = options.emitLandingEvents ?? true;
    this.groundSlamShock = options.groundSlamShock ?? true;
    this.slamRng = options.rng ?? createRng('ground-slam');

    this.raw = world.raw.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased().setTranslation(
        options.position.x,
        options.position.y,
        options.position.z
      )
    );
    const colliderDesc = actorCapsuleDesc(R, height, radius);
    colliderDesc.setCollisionGroups(groupsFor(layer, collidesWith));
    colliderDesc.setFriction(0);
    this.collider = world.raw.createCollider(colliderDesc, this.raw);

    this.body = new PhysicsBody(this.raw, this.collider, 'kinematic', layer, options.entityId, () => {
      /* kinematic bodies ignore forces */
    });
    world.register(this.body);

    this.controller = world.raw.createCharacterController(CHARACTER_SKIN);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
    this.controller.setMaxSlopeClimbAngle(this.maxSlopeAngle);
    this.controller.setMinSlopeSlideAngle(MIN_SLOPE_SLIDE_ANGLE);
    this.controller.enableAutostep(this.stepHeight, STEP_MIN_WIDTH, true);
    this.controller.enableSnapToGround(GROUND_SNAP_DISTANCE);
    this.controller.setSlideEnabled(true);
    // Let the capsule shove debris out of the way instead of standing on it.
    this.controller.setApplyImpulsesToDynamicBodies(true);
    this.controller.setCharacterMass(70);

    this.position.copy(options.position);
    this.apexY = options.position.y;
  }

  /* ------------------------------------------------------------------ */
  /* State                                                              */
  /* ------------------------------------------------------------------ */

  get isGrounded(): boolean {
    return this.grounded;
  }

  /** Seconds airborne; 0 while grounded. */
  get airborneTime(): number {
    return this.airTime;
  }

  /** True within the coyote-time window after leaving the ground. */
  get canJump(): boolean {
    return this.grounded || this.timeSinceGrounded <= COYOTE_TIME;
  }

  /** Downward speed of the most recent landing, m/s. */
  get lastLandingImpactSpeed(): number {
    return this.lastImpactSpeed;
  }

  /** Metres fallen in the most recent landing. */
  get lastLandingFallHeight(): number {
    return this.lastFallHeight;
  }

  /** Metres above the current position at the last apex. */
  get currentFallHeight(): number {
    return Math.max(0, this.apexY - this.position.y);
  }

  /** Bodies pushed by the most recent ground slam. */
  get lastGroundSlamAffected(): number {
    return this.lastSlamAffected;
  }

  /** Live world position. Do not mutate — call `setPosition`. */
  get translation(): THREE.Vector3 {
    return this.position;
  }

  /** Subscribe to landings. Returns an unsubscribe function. */
  onLanded(cb: (report: ILandingReport) => void): () => void {
    this.landedCallbacks.push(cb);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const i = this.landedCallbacks.indexOf(cb);
      if (i !== -1) this.landedCallbacks.splice(i, 1);
    };
  }

  /* ------------------------------------------------------------------ */
  /* Movement                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Move by a desired displacement for this step.
   *
   * `displacement.x/z` is horizontal translation ALREADY scaled by `dt`;
   * vertical motion is owned by the controller (gravity + jump), and any
   * `displacement.y` is added on top for scripted lifts.
   */
  move(displacement: THREE.Vector3, dt: number): void {
    if (this.disposed || dt <= 0) return;

    this.integrateGravity(dt);

    tmpMove.set(displacement.x, this.velocity.y * dt + displacement.y, displacement.z);

    this.controller.computeColliderMovement(this.collider, tmpMove);
    const applied = this.controller.computedMovement();
    this.grounded = this.controller.computedGrounded();

    this.position.x += applied.x;
    this.position.y += applied.y;
    this.position.z += applied.z;
    this.raw.setNextKinematicTranslation({
      x: this.position.x,
      y: this.position.y,
      z: this.position.z,
    });

    // Horizontal velocity is reported from what actually happened, so running
    // into a wall reads as zero speed rather than full speed.
    this.velocity.x = dt > 0 ? applied.x / dt : 0;
    this.velocity.z = dt > 0 ? applied.z / dt : 0;

    this.readGroundNormal();
    this.updateAirState(applied.y, dt);
  }

  /**
   * Convenience over `move`: a normalised horizontal direction plus the
   * current run/dash speed.
   */
  moveInDirection(direction: THREE.Vector3, dt: number): void {
    const speed = this.dashing ? this.dashSpeed : this.runSpeed;
    const lenSq = direction.x * direction.x + direction.z * direction.z;
    if (lenSq > 1e-8) {
      const inv = (1 / Math.sqrt(lenSq)) * speed * dt;
      tmpVec.set(direction.x * inv, 0, direction.z * inv);
    } else {
      tmpVec.set(0, 0, 0);
    }
    this.move(tmpVec, dt);
  }

  /**
   * Apply an upward impulse.
   *
   * Defaults to the speed that reaches `JUMP_APEX_HEIGHT`. Never reduces an
   * existing upward velocity, so a jump during an ascent is not a penalty.
   */
  jump(speed: number = JUMP_SPEED): void {
    if (this.disposed) return;
    this.velocity.y = Math.max(this.velocity.y, speed);
    this.grounded = false;
    this.timeSinceGrounded = Number.POSITIVE_INFINITY;
    this.apexY = this.position.y;
  }

  /** Take-off speed reaching `height` metres under the rise gravity. */
  jumpSpeedForHeight(height: number): number {
    return Math.sqrt(2 * Math.abs(GRAVITY_Y) * Math.max(0, height));
  }

  setPosition(position: THREE.Vector3): void {
    this.position.copy(position);
    this.raw.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
    this.raw.setNextKinematicTranslation({ x: position.x, y: position.y, z: position.z });
    this.body.setTransform(position);
    this.velocity.set(0, 0, 0);
    this.apexY = position.y;
    this.airTime = 0;
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                          */
  /* ------------------------------------------------------------------ */

  private integrateGravity(dt: number): void {
    if (this.grounded && this.velocity.y <= 0) {
      // A small downward bias keeps the capsule pinned to the ground so the
      // snap has something to work with on ramps and stairs.
      this.velocity.y = -2;
      return;
    }
    const g = this.velocity.y < 0 ? GRAVITY_Y * FALL_GRAVITY_MULTIPLIER : GRAVITY_Y;
    this.velocity.y = Math.max(this.velocity.y + g * dt, -MAX_FALL_SPEED);
  }

  private readGroundNormal(): void {
    if (!this.grounded) {
      this.groundNormal.set(0, 1, 0);
      return;
    }
    const count = this.controller.numComputedCollisions();
    let bestY = -1;
    this.groundNormal.set(0, 1, 0);
    for (let i = 0; i < count; i++) {
      const collision = this.controller.computedCollision(i);
      if (collision === null) continue;
      const n = collision.normal1;
      // Rapier reports the obstacle's outward normal; the floor points up.
      const upness = n.y;
      if (upness > bestY) {
        bestY = upness;
        this.groundNormal.set(n.x, n.y, n.z);
      }
    }
    if (bestY <= 0) this.groundNormal.set(0, 1, 0);
  }

  private updateAirState(appliedY: number, dt: number): void {
    if (this.grounded) {
      if (!this.wasGrounded) this.reportLanding();
      this.airTime = 0;
      this.timeSinceGrounded = 0;
      this.apexY = this.position.y;
      if (this.velocity.y < 0) this.velocity.y = 0;
    } else {
      this.airTime += dt;
      this.timeSinceGrounded += dt;
      if (this.position.y > this.apexY) this.apexY = this.position.y;
      // A ceiling hit kills upward velocity; otherwise it keeps accumulating
      // and the character "sticks" to the underside of the geometry.
      if (this.velocity.y > 0 && appliedY < this.velocity.y * dt * 0.5) this.velocity.y = 0;
    }
    this.wasGrounded = this.grounded;
  }

  private reportLanding(): void {
    const impactSpeed = Math.abs(this.velocity.y);
    const fallHeight = Math.max(0, this.apexY - this.position.y);
    this.lastImpactSpeed = impactSpeed;
    this.lastFallHeight = fallHeight;
    const createsCrater = fallHeight >= GROUND_SLAM_FALL_HEIGHT;

    const report: ILandingReport = {
      impactSpeed,
      fallHeight,
      createsCrater,
      position: this.position.clone(),
    };
    for (const cb of this.landedCallbacks) cb(report);

    if (this.emitLandings) {
      this.world.bus?.emit('PlayerLanded', {
        position: this.position,
        impactSpeed,
        fallHeight,
        createsCrater,
        intent: this.intent,
      });
    }

    if (createsCrater && this.groundSlamShock) this.applyGroundSlam(fallHeight);
  }

  /**
   * Shove loose bodies away from the impact point.
   *
   * This is the PHYSICS half of a ground slam only. Detaching fracture chunks
   * from buildings is the destruction system's job, driven by the
   * `PlayerLanded` event above.
   */
  private applyGroundSlam(fallHeight: number): void {
    const radius = clamp(
      GROUND_SLAM_BASE_RADIUS +
        (fallHeight - GROUND_SLAM_FALL_HEIGHT) * GROUND_SLAM_RADIUS_PER_METRE,
      GROUND_SLAM_BASE_RADIUS,
      GROUND_SLAM_MAX_RADIUS
    );
    this.lastSlamAffected = applyRadialImpulse(this.world, this.position, {
      radius,
      // Scales with the fall, capped so a skyline drop is not a nuke.
      deltaV: Math.min(30, 10 + fallHeight * 0.35),
      layers: ['debris', 'ragdoll', 'monster'],
      lift: 0.8,
      rng: this.slamRng,
      exclude: [this.body.handle],
    });
  }

  /** Release the controller and its body. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.landedCallbacks = [];
    if (this.world.isDisposed) return;
    this.world.removeBody(this.body.handle);
    this.world.raw.removeCharacterController(this.controller);
  }
}

/** Apex height reached by a jump at `speed`, under the rise gravity. */
export function apexHeightForSpeed(speed: number): number {
  return (speed * speed) / (2 * Math.abs(GRAVITY_Y));
}

/** The tuned jump apex, exported so gameplay can display or test it. */
export const TUNED_JUMP_APEX = JUMP_APEX_HEIGHT;
