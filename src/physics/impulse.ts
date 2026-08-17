/**
 * IMPULSE PROPAGATION
 *
 * Turns "a shockwave happened here" into forces on bodies.
 *
 * This module subscribes to `ShockwaveFired` and `ImpulseApplied` on the event
 * bus and NEVER imports the combat system — combat does not know physics
 * exists, physics does not know combat exists, and the bus is the whole of the
 * contract between them. That is what lets either be rewritten without
 * touching the other.
 *
 * ── IMPULSE SCALES WITH MASS ───────────────────────────────────────────────
 * A real pressure wave imparts an impulse proportional to exposed AREA, so a
 * pebble accelerates far harder than a girder. Faithfully modelled, a single
 * punch turns gravel into hypersonic projectiles while the interesting large
 * debris barely twitches. So the impulse here is `mass * deltaV`: every body in
 * the cone gets the same VELOCITY change. Physically wrong, dramatically right.
 *
 * ── DETERMINISM ────────────────────────────────────────────────────────────
 * Tumble uses a seeded stream derived per BODY HANDLE, not a single stream
 * drawn from in iteration order. Two runs of the same seed therefore produce
 * identical spins even if the broad phase hands the bodies over in a different
 * order.
 */

import * as THREE from 'three';
import type { BodyHandle, IEventBus, PhysicsLayer, Vec3 } from '@/types';
import { createRng, falloff, saturate, type IRandom } from '@/util';
import type { PhysicsBody } from './body';
import type { PhysicsWorld } from './world';
import {
  SHOCKWAVE_LIFT,
  SHOCKWAVE_MAX_DELTA_V,
  SHOCKWAVE_POWER_HALF,
  SHOCKWAVE_SPIN_FACTOR,
} from './constants';

/** Parameters for a radial or cone-shaped impulse. */
export interface IRadialImpulseOptions {
  /** Metres of effect. */
  readonly radius: number;
  /** Peak velocity change, at the origin and on axis. */
  readonly deltaV: number;
  /** Cone axis. Omit for a fully radial blast. */
  readonly direction?: THREE.Vector3 | Vec3;
  /** Cone half-angle in radians. `Math.PI` (default) is omnidirectional. */
  readonly angle?: number;
  /** Layers to affect. Defaults to debris + ragdoll + monster. */
  readonly layers?: readonly PhysicsLayer[];
  /** Upward bias, as a fraction of the push direction. */
  readonly lift?: number;
  /** Spin as a fraction of the linear delta-v. 0 disables tumble. */
  readonly spin?: number;
  /** Seeded stream for tumble. */
  readonly rng?: IRandom;
  /** Bodies to skip (the attacker, the player). */
  readonly exclude?: readonly BodyHandle[];
}

const DEFAULT_LAYERS: readonly PhysicsLayer[] = ['debris', 'ragdoll', 'monster'];

const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpDir = new THREE.Vector3();
const tmpAxis = new THREE.Vector3();
const tmpImpulse = new THREE.Vector3();
const tmpTorque = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Push every dynamic body in a sphere (or cone) away from `origin`.
 *
 * Returns the number of bodies affected.
 */
export function applyRadialImpulse(
  world: PhysicsWorld,
  origin: THREE.Vector3 | Vec3,
  options: IRadialImpulseOptions
): number {
  const radius = options.radius;
  if (radius <= 0 || options.deltaV === 0) return 0;

  tmpPos.set(origin.x, origin.y, origin.z);
  const bodies = world.overlapSphere(tmpPos, radius, options.layers ?? DEFAULT_LAYERS);
  if (bodies.length === 0) return 0;

  const angle = options.angle ?? Math.PI;
  const hasCone = options.direction !== undefined && angle < Math.PI - 1e-3;
  if (options.direction !== undefined) {
    tmpAxis.set(options.direction.x, options.direction.y, options.direction.z);
    if (tmpAxis.lengthSq() < 1e-8) tmpAxis.set(0, 0, -1);
    else tmpAxis.normalize();
  } else {
    tmpAxis.set(0, 0, 0);
  }
  const cosLimit = Math.cos(angle);
  const lift = options.lift ?? SHOCKWAVE_LIFT;
  const spinFactor = options.spin ?? SHOCKWAVE_SPIN_FACTOR;
  const rng = options.rng;
  const exclude = options.exclude;

  let affected = 0;
  for (const body of bodies) {
    if (body.type !== 'dynamic' || !body.isEnabled) continue;
    if (exclude !== undefined && exclude.includes(body.handle)) continue;

    body.getTransform(tmpDir, tmpQuat);
    tmpDir.sub(tmpPos);
    const distance = tmpDir.length();
    if (distance > radius) continue;

    // Radial direction; degenerate at the exact origin, so push straight up.
    if (distance < 1e-4) tmpDir.copy(UP);
    else tmpDir.multiplyScalar(1 / distance);

    let coneWeight = 1;
    if (hasCone) {
      const alignment = tmpDir.dot(tmpAxis);
      if (alignment < cosLimit) continue;
      // Soften the rim so the cone edge is not a hard cut.
      coneWeight = (alignment - cosLimit) / Math.max(1e-4, 1 - cosLimit);
      coneWeight = coneWeight * (2 - coneWeight);
    }

    const strength = options.deltaV * falloff(distance, radius) * coneWeight;
    if (strength <= 1e-4) continue;

    // Blend radial push with the blast axis, then bias upward.
    tmpImpulse.copy(tmpDir);
    if (hasCone) tmpImpulse.addScaledVector(tmpAxis, 0.6);
    tmpImpulse.addScaledVector(UP, lift);
    if (tmpImpulse.lengthSq() < 1e-8) tmpImpulse.copy(UP);
    tmpImpulse.normalize().multiplyScalar(strength * body.mass);

    body.wake();
    body.applyImpulse(tmpImpulse);

    if (spinFactor > 0) {
      // Per-handle stream: identical spin regardless of iteration order.
      const stream = rng !== undefined ? rng.derive(body.handle) : undefined;
      const magnitude = strength * spinFactor * body.mass * 0.1;
      if (stream !== undefined) {
        tmpTorque.set(
          stream.range(-magnitude, magnitude),
          stream.range(-magnitude, magnitude),
          stream.range(-magnitude, magnitude)
        );
      } else {
        // No stream supplied: derive a stable pseudo-spin from the handle so
        // the result is still reproducible.
        const h = body.handle;
        tmpTorque.set(
          (((h * 2654435761) % 1000) / 500 - 1) * magnitude,
          (((h * 40503) % 1000) / 500 - 1) * magnitude,
          (((h * 2246822519) % 1000) / 500 - 1) * magnitude
        );
      }
      body.applyTorqueImpulse(tmpTorque);
    }

    affected++;
  }
  return affected;
}

/** Options for the bus-driven propagator. */
export interface IImpulsePropagatorOptions {
  /** Seeded stream used for tumble. */
  readonly rng?: IRandom;
  /** Peak velocity change for an infinitely powerful shockwave. */
  readonly maxDeltaV?: number;
  /** Punch `power` mapping to half of `maxDeltaV`. */
  readonly powerHalf?: number;
  /** Layers a shockwave may move. */
  readonly layers?: readonly PhysicsLayer[];
  /** Bodies never moved by a shockwave (typically the player). */
  readonly exclude?: readonly BodyHandle[];
}

/**
 * Bus-driven impulse propagation.
 *
 * `attach(bus)` wires `ShockwaveFired` and `ImpulseApplied`; the returned
 * function unsubscribes. Nothing else in the codebase needs to know this class
 * exists.
 */
export class ImpulsePropagator {
  private readonly world: PhysicsWorld;
  private readonly rng: IRandom;
  private readonly maxDeltaV: number;
  private readonly powerHalf: number;
  private readonly layers: readonly PhysicsLayer[];
  private readonly exclude: readonly BodyHandle[] | undefined;
  private unsubscribers: (() => void)[] = [];

  /** Shockwaves handled since construction. Diagnostics only. */
  shockwaveCount = 0;
  /** Bodies moved by the most recent shockwave. */
  lastAffectedCount = 0;

  constructor(world: PhysicsWorld, options: IImpulsePropagatorOptions = {}) {
    this.world = world;
    this.rng = options.rng ?? createRng('shockwave');
    this.maxDeltaV = options.maxDeltaV ?? SHOCKWAVE_MAX_DELTA_V;
    this.powerHalf = options.powerHalf ?? SHOCKWAVE_POWER_HALF;
    this.layers = options.layers ?? DEFAULT_LAYERS;
    this.exclude = options.exclude;
  }

  /** Subscribe to the bus. Returns an unsubscribe function. */
  attach(bus: IEventBus): () => void {
    this.detach();
    this.unsubscribers.push(
      bus.on('ShockwaveFired', (event) => {
        this.shockwaveCount++;
        this.lastAffectedCount = this.applyShockwave(
          event.origin,
          event.direction,
          event.power,
          event.range,
          event.angle
        );
      })
    );
    this.unsubscribers.push(
      bus.on('ImpulseApplied', (event) => {
        this.applyToEntity(event.targetId, event.impulse, event.point);
      })
    );
    return () => this.detach();
  }

  detach(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
  }

  /**
   * Apply a shockwave.
   *
   * `power` is unbounded — a serious punch can exceed 1e6 — so it is squashed
   * through a saturating curve rather than divided by an assumed maximum.
   */
  applyShockwave(
    origin: THREE.Vector3 | Vec3,
    direction: THREE.Vector3 | Vec3,
    power: number,
    range: number,
    angle: number
  ): number {
    const deltaV = this.maxDeltaV * saturate(power, this.powerHalf);
    return applyRadialImpulse(this.world, origin, {
      radius: range,
      deltaV,
      direction,
      angle,
      layers: this.layers,
      rng: this.rng,
      exclude: this.exclude,
    });
  }

  /** Apply a direct impulse to the body owning an entity. */
  applyToEntity(entityId: string, impulse: Vec3, point?: Vec3): boolean {
    const body: PhysicsBody | undefined = this.world.getBodyByEntity(entityId);
    if (body === undefined || body.type !== 'dynamic') return false;
    tmpImpulse.set(impulse.x, impulse.y, impulse.z);
    body.wake();
    if (point === undefined) {
      body.applyImpulse(tmpImpulse);
    } else {
      body.applyImpulse(tmpImpulse, tmpDir.set(point.x, point.y, point.z));
    }
    return true;
  }
}
