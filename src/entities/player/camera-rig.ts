/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THIRD-PERSON SPRING ARM                                                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A pivot above the character, an arm pointing back along yaw/pitch, and a
 * collision sweep that shortens the arm rather than letting the camera pass
 * through a wall. Everything else on top of that is game feel:
 *
 *   ARM LENGTH   4.5 m resting · 9 m winding up a serious punch · 14 m at the
 *                apex of a leap. The 14 m is a design statement, not a comfort
 *                number: at the top of a jump the whole district should be in
 *                frame, which also makes this camera the streaming and
 *                impostor-ring stress test.
 *   FOV          55° → 72° with planar speed, so a dash reads as speed rather
 *                than as the same shot moving faster.
 *   LOOK-AHEAD   the look-at point leads the character along its velocity, so
 *                you see where you are going, not where you have been.
 *   IMPACT LAG   on a serious punch the camera POSITION falls three frames
 *                behind and then catches up. Three frames is 50 ms — too short
 *                to read as a camera move, long enough that the punch lands
 *                before the frame it is in. It is the cheapest weight in the
 *                whole game.
 *
 * ── THE COLLISION RULE ─────────────────────────────────────────────────────
 * PULL IN INSTANTLY, PUSH OUT SLOWLY. Any smoothing on the way in is a frame
 * of camera inside a building, and one frame inside a building is worse than
 * a hundred frames of an arm that is slightly too short. On the way out the
 * rate cap is what stops a doorway from firing the camera backwards.
 *
 * ── COOPERATING WITH FOV DRIVEN ELSEWHERE ──────────────────────────────────
 * `src/engine/impact-freeze.ts` punches the FOV in by 8° on a kill, snapshots
 * whatever the FOV was when it started, and restores that exact value when it
 * finishes. If this rig also wrote FOV during the freeze, the two would fight
 * and the restore would put back a stale value. So the rig watches for the FOV
 * having moved under it and simply STOPS WRITING until it comes back — see
 * `updateFov()`. It never asks who moved it, which is the point.
 *
 * ── THE LIMITATION THIS RIG DOES NOT SOLVE ─────────────────────────────────
 * In a corridor narrower than about twice the resting arm, keeping the camera
 * OUT of the wall means putting it close enough to the character that he fills
 * the frame. The harness screenshots show this honestly at 2.4 m: no
 * penetration, and also no usable shot. Widening the FOV as the arm collapses
 * recovers some of it; the rest needs the character to fade out at short arm
 * lengths, which is a material decision this module publishes
 * `armCollapseRatio` for rather than making itself.
 *
 * ── WHAT THIS FILE MAY NOT DO ──────────────────────────────────────────────
 * No DOM, no input backends, no physics package. World geometry is reached
 * through `ICameraProbe`, which `createPhysicsCameraProbe()` builds from the
 * `IPhysicsWorld` CONTRACT, and combat reaches the rig through the event bus.
 */

import * as THREE from 'three';
import type {
  BodyHandle,
  IEventBus,
  InputState,
  IPhysicsWorld,
  LethalIntent,
  PhysicsLayer,
} from '@/types';
import { clamp, clamp01, damp, DEG2RAD, lerp, smoothstep, wrapAngle } from '@/util';
import { DEFAULT_PLAYER_TUNING, type IPlayerTuning } from './tuning';

/* -------------------------------------------------------------------------- */
/* World probe                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The rig's entire view of world geometry: one ray, one answer.
 *
 * Deliberately smaller than `IPhysicsWorld` so the rig can be unit-tested
 * against analytic geometry with no solver, and so a future BVH-backed probe
 * (`src/spatial` raycasts a merged mesh in 1.6 µs) can be swapped in without
 * touching this file.
 */
export interface ICameraProbe {
  /**
   * Distance to the first blocker along `direction`, or `Infinity` for a miss.
   * `direction` is unit length. Must not allocate.
   */
  probe(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number): number;
}

export interface IPhysicsCameraProbeOptions {
  /** Layers treated as opaque. Defaults to `['world']`. */
  readonly layers?: readonly PhysicsLayer[];
  /** Bodies to ignore — at minimum the player's own capsule. */
  readonly exclude?: readonly BodyHandle[];
}

/**
 * An `ICameraProbe` over the physics contract.
 *
 * Only `world` geometry occludes by default: debris, ragdolls and NPCs must
 * NOT shorten the arm, or a fight full of flying rubble turns the camera into
 * a strobe.
 */
export function createPhysicsCameraProbe(
  world: IPhysicsWorld,
  options: IPhysicsCameraProbeOptions = {}
): ICameraProbe {
  const layers = options.layers ?? (['world'] as const);
  const exclude = options.exclude;
  return {
    probe(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number): number {
      const hit = world.raycast({ origin, direction, maxDistance, layers, exclude });
      return hit === undefined ? Number.POSITIVE_INFINITY : hit.distance;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Target                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What the rig needs from whatever it is following.
 *
 * `PlayerController` satisfies this structurally; so does a two-line stub in a
 * unit test, which is the reason it exists as its own type.
 */
export interface ICameraTarget {
  /** Capsule centre in world space. */
  readonly position: THREE.Vector3;
  /** Planar velocity, m/s. */
  readonly velocity: THREE.Vector3;
  /** Facing about Y (three.js convention: forward is local -Z). */
  readonly yaw: number;
  /** Metres above the last ground contact. Drives the apex pull-back. */
  readonly heightAboveGround: number;
  /** True while a serious punch is being wound up. */
  readonly isCharging: boolean;
}

/* -------------------------------------------------------------------------- */
/* Options and diagnostics                                                    */
/* -------------------------------------------------------------------------- */

export interface IThirdPersonCameraOptions {
  readonly camera: THREE.PerspectiveCamera;
  readonly target: ICameraTarget;
  readonly tuning?: IPlayerTuning;
  /** World geometry probe. Without one the arm never shortens. */
  readonly probe?: ICameraProbe | null;
  /**
   * Bus used to LISTEN for `ShockwaveFired`. A serious or full-intent
   * shockwave is what triggers the three-frame impact lag, which is how combat
   * reaches this rig without either module importing the other.
   */
  readonly bus?: IEventBus;
  /** Starting azimuth, radians. */
  readonly yaw?: number;
  /** Starting elevation, degrees. Defaults to `tuning.camera.defaultPitchDeg`. */
  readonly pitchDeg?: number;
  /** Write `camera.fov`. Set false to hand FOV entirely to another system. */
  readonly driveFov?: boolean;
}

/** Live read-out, for the debug HUD and the harness. */
export interface ICameraDiagnostics {
  readonly yaw: number;
  readonly pitchDeg: number;
  /** Length the state machine asked for, before collision. */
  readonly armTarget: number;
  /** Length after smoothing, before collision. */
  readonly armSmoothed: number;
  /** Length actually used this frame. */
  readonly armActual: number;
  /** True while geometry is holding the arm shorter than it wants to be. */
  readonly occluded: boolean;
  /**
   * 0 when the arm is at full length, 1 when collision has crushed it to the
   * minimum. Published for a character fade/dither: below ~0.5 the character
   * starts filling the frame and something has to give.
   */
  readonly armCollapseRatio: number;
  /** Distance to the nearest blocker found by the sweep, or Infinity. */
  readonly nearestBlocker: number;
  readonly fov: number;
  /** True while another system owns the FOV and this rig is standing down. */
  readonly fovSuspended: boolean;
  /** 0..1 blend toward the three-frame-stale position. */
  readonly impactLag: number;
  /** Metres the output position currently trails the desired one by. */
  readonly impactLagOffsetM: number;
  readonly apexFactor: number;
  readonly charging: boolean;
  readonly lookAhead: number;
}

/* -------------------------------------------------------------------------- */
/* Scratch                                                                    */
/* -------------------------------------------------------------------------- */

const tmpArmDir = new THREE.Vector3();
const tmpPerpA = new THREE.Vector3();
const tmpPerpB = new THREE.Vector3();
const tmpOrigin = new THREE.Vector3();
const tmpLook = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const FALLBACK_PERP = new THREE.Vector3(1, 0, 0);

/** Intents that count as "a serious punch" for the impact lag. */
const SERIOUS_INTENTS: ReadonlySet<LethalIntent> = new Set<LethalIntent>(['serious', 'full']);

/* -------------------------------------------------------------------------- */
/* The rig                                                                    */
/* -------------------------------------------------------------------------- */

export class ThirdPersonCameraRig {
  /** Azimuth in radians. Camera sits at +armDir from the pivot. */
  yaw: number;
  /** Player-authored elevation in radians. The apex bias is added on top. */
  pitch: number;

  private readonly camera: THREE.PerspectiveCamera;
  private readonly target: ICameraTarget;
  private readonly tuning: IPlayerTuning;
  private readonly probeSource: ICameraProbe | null;
  private readonly driveFov: boolean;
  private readonly unsubscribe: (() => void) | null;

  /** Smoothed look pivot. Chases the character rather than being welded to it. */
  private readonly pivot = new THREE.Vector3();
  /** Smoothed look-ahead offset, world space. */
  private readonly lookAhead = new THREE.Vector3();
  /** Where the camera would be with no impact lag. */
  private readonly desiredPosition = new THREE.Vector3();
  /** Ring of recent desired positions, for the impact lag. */
  private readonly history: THREE.Vector3[];
  private historyHead = 0;
  private historyCount = 0;

  private armTarget: number;
  private armSmoothed: number;
  private armActual: number;
  private occluded = false;
  private nearestBlocker = Number.POSITIVE_INFINITY;
  /** Player pinch bias on the resting arm length, 0.6..2.0. */
  private armBias = 1;

  private autoPitchOffset = 0;
  private apexFactor = 0;
  private fov: number;
  private ownedFov: number;
  private fovSuspended = false;

  private impactLagTimer = 0;
  private impactLagStrength = 0;

  private initialised = false;
  private disposed = false;

  constructor(options: IThirdPersonCameraOptions) {
    this.camera = options.camera;
    this.target = options.target;
    this.tuning = options.tuning ?? DEFAULT_PLAYER_TUNING;
    this.probeSource = options.probe ?? null;
    this.driveFov = options.driveFov ?? true;

    const cam = this.tuning.camera;
    this.yaw = options.yaw ?? this.target.yaw;
    this.pitch = (options.pitchDeg ?? cam.defaultPitchDeg) * DEG2RAD;
    this.armTarget = cam.armLengthM;
    this.armSmoothed = cam.armLengthM;
    this.armActual = cam.armLengthM;
    this.fov = cam.fovBaseDeg;
    this.ownedFov = cam.fovBaseDeg;

    this.history = [];
    for (let i = 0; i < cam.impactLagFrames + 2; i++) this.history.push(new THREE.Vector3());

    this.unsubscribe =
      options.bus?.on('ShockwaveFired', (event) => {
        if (SERIOUS_INTENTS.has(event.intent)) this.triggerImpactLag();
      }) ?? null;
  }

  /* ------------------------------------------------------------------ */
  /* Read-out                                                           */
  /* ------------------------------------------------------------------ */

  /** Arm length actually used this frame, after collision. */
  get armLength(): number {
    return this.armActual;
  }

  /** Arm length the state machine wanted, before collision. */
  get desiredArmLength(): number {
    return this.armSmoothed;
  }

  get isOccluded(): boolean {
    return this.occluded;
  }

  /** Smoothed pivot the camera orbits. Read-only. */
  get pivotPosition(): THREE.Vector3 {
    return this.pivot;
  }

  diagnostics(): ICameraDiagnostics {
    return {
      yaw: this.yaw,
      pitchDeg: (this.pitch + this.autoPitchOffset) / DEG2RAD,
      armTarget: this.armTarget,
      armSmoothed: this.armSmoothed,
      armActual: this.armActual,
      occluded: this.occluded,
      armCollapseRatio: this.armCollapseRatio(),
      nearestBlocker: this.nearestBlocker,
      fov: this.camera.fov,
      fovSuspended: this.fovSuspended,
      impactLag: this.impactLagStrength,
      impactLagOffsetM: this.camera.position.distanceTo(this.desiredPosition),
      apexFactor: this.apexFactor,
      charging: this.target.isCharging,
      lookAhead: this.lookAhead.length(),
    };
  }

  /**
   * Fall three frames behind for a moment.
   *
   * Called automatically from `ShockwaveFired` and from a released charged
   * punch; exposed so a cutscene or a scripted beat can borrow the effect.
   */
  triggerImpactLag(): void {
    const cam = this.tuning.camera;
    this.impactLagTimer = cam.impactLagHoldSeconds + cam.impactLagReleaseSeconds;
    this.impactLagStrength = 1;
  }

  /** Snap the camera behind the character immediately. */
  recentre(): void {
    this.yaw = this.target.yaw;
  }

  /* ------------------------------------------------------------------ */
  /* Frame                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Advance one frame. Call AFTER the player's `postStep()`, so the pivot is
   * chasing a transform the solver has already resolved.
   */
  update(input: InputState, dt: number): void {
    if (this.disposed || dt <= 0) return;

    this.readLook(input, dt);
    this.updatePivot(dt);
    this.updateArmTarget(dt);
    this.composeDesiredPosition();
    this.applyCollision();
    this.applyImpactLag(input, dt);
    this.updateFov(dt);

    this.camera.lookAt(tmpLook.copy(this.pivot).add(this.lookAhead));
    this.initialised = true;
  }

  /* ------------------------------------------------------------------ */
  /* Orientation                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Turn `look` into rotation.
   *
   * `look` is a RATE, not a delta — `look.x === 1` means
   * `lookFullRateDegPerSec` degrees per second (see `src/ui/input/config.ts`).
   * Treating it as a delta is the single easiest way to get a camera that
   * behaves differently at 30 and 60 fps, so the multiplication by `dt` here
   * is load-bearing.
   */
  private readLook(input: InputState, dt: number): void {
    const cam = this.tuning.camera;
    const rate = cam.lookFullRateDegPerSec * DEG2RAD * dt;

    // Screen-right turns the view right. The camera sits opposite its own
    // forward (which is local -Z), so turning right DECREASES yaw.
    this.yaw = wrapAngle(this.yaw - input.look.x * rate);
    // Pushing up looks up, which lowers the camera's elevation over the pivot.
    this.pitch -= input.look.y * rate;

    if (input.buttons.cameraReset.pressed) this.recentre();

    // Pinch is a per-frame RATIO on the arm; 1 means unchanged.
    if (input.pinchDelta !== 1 && input.pinchDelta > 0) {
      this.armBias = clamp(this.armBias / input.pinchDelta, 0.6, 2);
    }

    // The apex bias is ADDITIVE so it never fights a pitch the player chose.
    const apexBias = (cam.apexPitchDeg - cam.defaultPitchDeg) * DEG2RAD * this.apexFactor;
    this.autoPitchOffset = damp(this.autoPitchOffset, apexBias, cam.autoPitchSmoothing, dt);

    const minPitch = cam.minPitchDeg * DEG2RAD;
    const maxPitch = cam.maxPitchDeg * DEG2RAD;
    this.pitch = clamp(this.pitch, minPitch - this.autoPitchOffset, maxPitch - this.autoPitchOffset);
  }

  /* ------------------------------------------------------------------ */
  /* Pivot and look-ahead                                               */
  /* ------------------------------------------------------------------ */

  private updatePivot(dt: number): void {
    const cam = this.tuning.camera;
    const t = this.target;

    // Over-the-shoulder offset, in the CAMERA's right direction so it stays
    // put while the character spins on the spot.
    //
    // The offset is itself collision-limited. A pivot shoved into a wall is
    // the one failure the arm sweep cannot recover from: every probe would
    // then start inside solid geometry and report zero, and no arm length is
    // safe. One extra ray here removes the whole failure mode.
    const rightX = Math.cos(this.yaw);
    const rightZ = -Math.sin(this.yaw);
    const chestY = t.position.y + cam.pivotHeightM;
    let side = cam.pivotSideM;
    if (this.probeSource !== null && side > 0) {
      tmpOrigin.set(t.position.x, chestY, t.position.z);
      tmpPerpA.set(rightX, 0, rightZ);
      const gap = cam.probeClearanceM;
      const d = this.probeSource.probe(tmpOrigin, tmpPerpA, side + gap);
      if (Number.isFinite(d)) side = Math.max(0, d - gap);
    }
    const wantX = t.position.x + rightX * side;
    const wantY = chestY;
    const wantZ = t.position.z + rightZ * side;

    if (!this.initialised) {
      this.pivot.set(wantX, wantY, wantZ);
    } else {
      this.pivot.set(
        damp(this.pivot.x, wantX, cam.pivotSmoothing, dt),
        damp(this.pivot.y, wantY, cam.pivotSmoothing, dt),
        damp(this.pivot.z, wantZ, cam.pivotSmoothing, dt)
      );
    }

    // Look-ahead: lead the character along its own velocity so the shot shows
    // where it is going. Clamped, or a dash puts the character off frame.
    const speed = Math.hypot(t.velocity.x, t.velocity.z);
    let aheadX = 0;
    let aheadZ = 0;
    if (speed > 1e-4) {
      const lead = Math.min(cam.lookAheadMaxM, speed * cam.lookAheadSeconds);
      aheadX = (t.velocity.x / speed) * lead;
      aheadZ = (t.velocity.z / speed) * lead;
    }
    if (!this.initialised) {
      this.lookAhead.set(aheadX, 0, aheadZ);
    } else {
      this.lookAhead.set(
        damp(this.lookAhead.x, aheadX, cam.lookAheadSmoothing, dt),
        0,
        damp(this.lookAhead.z, aheadZ, cam.lookAheadSmoothing, dt)
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /* Arm length                                                         */
  /* ------------------------------------------------------------------ */

  private updateArmTarget(dt: number): void {
    const cam = this.tuning.camera;
    const t = this.target;

    this.apexFactor = smoothstep(
      cam.apexArmStartHeightM,
      cam.apexArmFullHeightM,
      t.heightAboveGround
    );

    const resting = cam.armLengthM * this.armBias;
    const apex = lerp(resting, cam.armLengthApexM, this.apexFactor);
    const charging = t.isCharging ? cam.armLengthChargingM : 0;
    // The three requirements are a MAXIMUM, not a chain: charging a punch at
    // the top of a leap should not give a 9 m arm just because the punch state
    // was evaluated last.
    this.armTarget = Math.max(resting, apex, charging);

    this.armSmoothed = this.initialised
      ? damp(this.armSmoothed, this.armTarget, cam.armExtendSmoothing, dt)
      : this.armTarget;

    // Rate-limit only the RECOVERY from an occlusion; a design-driven change
    // of length is shaped by the smoothing above and must not be throttled too.
    if (!this.initialised) {
      this.armActual = this.armSmoothed;
    } else if (this.occluded) {
      this.armActual = Math.min(this.armSmoothed, this.armActual + cam.armRecoverSpeedMps * dt);
    } else {
      this.armActual = this.armSmoothed;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Placement and collision                                            */
  /* ------------------------------------------------------------------ */

  /** How far collision has crushed the arm, 0..1. */
  private armCollapseRatio(): number {
    const cam = this.tuning.camera;
    const span = this.armSmoothed - cam.armLengthMinM;
    if (span <= 1e-4) return 0;
    return clamp01((this.armSmoothed - this.armActual) / span);
  }

  private composeDesiredPosition(): void {
    const pitch = this.pitch + this.autoPitchOffset;
    const cosP = Math.cos(pitch);
    tmpArmDir.set(Math.sin(this.yaw) * cosP, Math.sin(pitch), Math.cos(this.yaw) * cosP);
    // Guard against a degenerate arm direction at ±90° pitch.
    if (tmpArmDir.lengthSq() < 1e-8) tmpArmDir.set(0, 1, 0);
    else tmpArmDir.normalize();
    this.desiredPosition
      .copy(this.pivot)
      .addScaledVector(tmpArmDir, this.armActual);
  }

  /**
   * Shorten the arm until nothing is between the pivot and the camera.
   *
   * Five parallel rays — the axis plus four at `probeRadiusM` — approximate a
   * CYLINDER swept along the arm. A cylinder rather than a sphere because that
   * is the shape the arm actually occupies, and the extra conservatism at the
   * ends is free insurance against the near plane clipping a corner.
   *
   * The contract exposes rays, not shape casts, which is why this is five
   * calls rather than one. At ~1.6 µs each against the BVH that is not a cost
   * worth optimising away.
   */
  private applyCollision(): void {
    const cam = this.tuning.camera;
    this.nearestBlocker = Number.POSITIVE_INFINITY;
    if (this.probeSource === null) {
      this.occluded = false;
      return;
    }

    const maxDistance = this.armActual + cam.probeClearanceM;
    if (maxDistance <= 1e-4) return;

    // Perpendicular basis for the cross pattern.
    tmpPerpA.copy(tmpArmDir).cross(WORLD_UP);
    if (tmpPerpA.lengthSq() < 1e-8) tmpPerpA.copy(FALLBACK_PERP);
    tmpPerpA.normalize();
    tmpPerpB.copy(tmpArmDir).cross(tmpPerpA).normalize();

    const r = cam.probeRadiusM;
    let nearest = this.probeSource.probe(this.pivot, tmpArmDir, maxDistance);
    for (let i = 0; i < 4; i++) {
      const sign = i < 2 ? 1 : -1;
      const axis = i % 2 === 0 ? tmpPerpA : tmpPerpB;
      tmpOrigin.copy(this.pivot).addScaledVector(axis, sign * r);
      const d = this.probeSource.probe(tmpOrigin, tmpArmDir, maxDistance);
      if (d < nearest) nearest = d;
    }
    this.nearestBlocker = nearest;

    if (!Number.isFinite(nearest)) {
      this.occluded = false;
      return;
    }

    // `armLengthMinM` is a FLOOR, not a guarantee: in a corridor narrower
    // than twice the floor the camera would have to be inside a wall to honour
    // it, and staying out of the wall wins.
    const allowed = clamp(nearest - cam.probeClearanceM, cam.armLengthMinM, this.armSmoothed);
    if (allowed < this.armActual - 1e-4) {
      // PULL IN INSTANTLY. Smoothing here is a frame of camera inside a wall.
      this.armActual = allowed;
      this.occluded = true;
      this.composeDesiredPosition();
    } else if (allowed < this.armSmoothed - 1e-4) {
      this.occluded = true;
    } else {
      this.occluded = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Impact lag                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Blend the camera toward where it was three frames ago.
   *
   * The history stores the DESIRED position, never the lagged one — feeding
   * the output back in would make the lag compound into a slow drift instead
   * of a snap and a catch-up.
   */
  private applyImpactLag(input: InputState, dt: number): void {
    const cam = this.tuning.camera;

    const heavy = input.buttons.heavyPunch;
    if (heavy.pressed && heavy.value >= cam.seriousChargeRatio) this.triggerImpactLag();

    // Record first, so frame N's history contains frame N.
    this.history[this.historyHead]!.copy(this.desiredPosition);
    this.historyHead = (this.historyHead + 1) % this.history.length;
    if (this.historyCount < this.history.length) this.historyCount++;

    if (this.impactLagTimer > 0) {
      this.impactLagTimer -= dt;
      const release = Math.max(1e-4, cam.impactLagReleaseSeconds);
      this.impactLagStrength = clamp01(this.impactLagTimer / release);
    } else {
      this.impactLagStrength = 0;
    }

    if (this.impactLagStrength <= 1e-4 || this.historyCount <= cam.impactLagFrames) {
      this.camera.position.copy(this.desiredPosition);
      return;
    }

    const back = cam.impactLagFrames;
    const index = (this.historyHead - 1 - back + this.history.length * 2) % this.history.length;
    const stale = this.history[index]!;
    this.camera.position.lerpVectors(this.desiredPosition, stale, this.impactLagStrength);
  }

  /* ------------------------------------------------------------------ */
  /* Field of view                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Speed-driven FOV, with an automatic stand-down.
   *
   * If `camera.fov` is not where this rig left it, another system owns it
   * right now (the impact freeze punches it in by 8° and restores the exact
   * value it snapshotted). Writing during that window would corrupt the
   * restore, so the rig stops writing AND stops advancing its own smoothed
   * value — which is what makes the hand-back seamless rather than a pop.
   */
  private updateFov(dt: number): void {
    if (!this.driveFov) return;
    const cam = this.tuning.camera;

    if (this.initialised && Math.abs(this.camera.fov - this.ownedFov) > 1e-3) {
      this.fovSuspended = true;
      return;
    }
    this.fovSuspended = false;

    const speed = Math.hypot(this.target.velocity.x, this.target.velocity.z);
    const t = clamp01(speed / Math.max(1e-4, cam.fovMaxAtSpeed));
    // Widen as the arm collapses: a wall that steals four metres of distance
    // has stolen most of the shot, and the lens is the only thing left to give.
    const wanted = clamp(
      lerp(cam.fovBaseDeg, cam.fovMaxDeg, t) + cam.armCollapseFovBoostDeg * this.armCollapseRatio(),
      20,
      95
    );
    this.fov = this.initialised ? damp(this.fov, wanted, cam.fovSmoothing, dt) : wanted;

    if (Math.abs(this.camera.fov - this.fov) > 1e-4) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
    this.ownedFov = this.camera.fov;
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
  }
}
