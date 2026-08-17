/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  SAITAMA — PLAYER LOCOMOTION CONTROLLER                                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The FEEL layer on top of the kinematic character controller. It does not
 * solve collisions, integrate gravity or resolve slopes — `ICharacterController`
 * already does all of that, exactly, and reimplementing any of it here would
 * fork the movement curve. What lives here is everything between a thumb and
 * that contract:
 *
 *   • camera-relative intent from `InputState` (and NOTHING else — no DOM,
 *     no key codes, no device branches);
 *   • an acceleration model with separate accel / decel / turn-brake terms;
 *   • reduced-authority air control that preserves a leap's momentum;
 *   • coyote time and jump buffering;
 *   • a variable-height jump built out of the contract's `jump()`;
 *   • landing recovery, including the cratering hard landing;
 *   • the locomotion state machine that drives the animator.
 *
 * ── THE THREE NUMBERS THAT DO THE MOST WORK ────────────────────────────────
 *   turnBrakeMps2   38   a 180° flick pivots on the spot instead of arcing
 *   coyoteSeconds   0.12 the ledge-exit jump that "should have worked"
 *   airDecelMps2    1.6  a dash-jump still has its speed when it lands
 * Remove any one of them and the character reads as broken in a way players
 * describe as "laggy" without being able to say why. They live, with the rest,
 * in `tuning.ts`.
 *
 * ── FRAME ORDER (binding) ──────────────────────────────────────────────────
 *   input.poll(frame, time)
 *   player.update(state, dt)     // decides, then calls controller.move()
 *   physics.step(fixedStep, n)   // the kinematic move is applied HERE
 *   player.postStep()            // re-reads the solved transform
 *   camera.update(dt)            // frames a position that is one step fresh
 *
 * `postStep()` is idempotent and `update()` calls it lazily, so a caller that
 * forgets it still works — one physics step behind, which the harness measures
 * rather than assumes.
 *
 * ── WHY THERE IS NO `Math.random()` HERE ───────────────────────────────────
 * There is no randomness in this file at all. Every branch is a function of
 * `InputState` and the solved transform, so the same synthetic script produces
 * a bit-identical trajectory — which `harness/player.verify.ts` asserts by
 * running the whole scenario twice in two fresh worlds.
 */

import * as THREE from 'three';
import type {
  EntityId,
  GameEventOf,
  IAnimator,
  ICharacterController,
  ICharacterInstance,
  IEventBus,
  InputState,
} from '@/types';
import { clamp, clamp01, smoothstep, wrapAngle } from '@/util';
import {
  isRecoveryState,
  LocomotionStateMachine,
  resolveGroundState,
  toClipName,
  type PlayerLocoState,
} from './locomotion';
import {
  DEFAULT_PLAYER_TUNING,
  heldJumpSpeedCeiling,
  landingRecoverySeconds,
  turnRateRadPerSec,
  type IPlayerTuning,
} from './tuning';

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

export interface IPlayerControllerOptions {
  /** The kinematic controller this drives. Consumed through the contract only. */
  readonly controller: ICharacterController;
  /** Feel profile. Defaults to `DEFAULT_PLAYER_TUNING`. */
  readonly tuning?: IPlayerTuning;
  /**
   * Bus used to LISTEN for `PlayerLanded`, which the physics module emits with
   * the authoritative impact speed and crater flag.
   *
   * This controller deliberately emits NOTHING: the landing event already
   * exists and double-emitting it would make destruction crater twice.
   */
  readonly bus?: IEventBus;
  /**
   * Animator to drive on state changes. May be `null`/absent — the animation
   * workstream lands separately and a missing animator must never crash
   * traversal.
   */
  readonly animator?: IAnimator | null;
  /** Character instance whose root is moved. Optional. */
  readonly character?: ICharacterInstance | null;
  /** Scene node moved to the solved transform. Defaults to `character.root`. */
  readonly root?: THREE.Object3D | null;
  /** Identifier for diagnostics. */
  readonly entityId?: EntityId;
  /**
   * Metres from the capsule CENTRE down to the soles.
   *
   * The physics capsule is centred on the body origin, so a visual whose
   * origin is at the feet needs shifting down by half the capsule height.
   * Default 0.875 = PLAYER_HEIGHT (1.75 m) / 2 in `src/physics/constants.ts`.
   */
  readonly footOffsetM?: number;
  /** Crossfade seconds passed to the animator on a state change. */
  readonly clipFadeSeconds?: number;
  /** Starting facing, radians. */
  readonly yaw?: number;
}

/** What a landing turned out to be. Mirrors the physics landing report. */
export interface IPlayerLandingInfo {
  /** Metres fallen from the apex. */
  readonly fallHeight: number;
  /** Downward speed at contact, m/s. */
  readonly impactSpeed: number;
  /** True once the fall exceeded `hardLandFallHeightM`. */
  readonly hard: boolean;
  /** Seconds of recovery this landing bought. */
  readonly recoverySeconds: number;
  /** True when the value came from the physics `PlayerLanded` event. */
  readonly fromBus: boolean;
}

/** Live read-out, for the debug HUD and the harness. */
export interface IPlayerDiagnostics {
  readonly state: PlayerLocoState;
  readonly timeInState: number;
  readonly grounded: boolean;
  readonly planarSpeed: number;
  readonly verticalSpeed: number;
  readonly targetSpeed: number;
  readonly yaw: number;
  readonly heightAboveGround: number;
  readonly coyoteRemaining: number;
  readonly jumpBufferRemaining: number;
  readonly controlScale: number;
  readonly recoveryRemaining: number;
  readonly dashing: boolean;
  readonly charging: boolean;
  readonly airborneSeconds: number;
  readonly apexHeight: number;
  readonly lastLanding: IPlayerLandingInfo | undefined;
}

/* -------------------------------------------------------------------------- */
/* Scratch                                                                    */
/* -------------------------------------------------------------------------- */

const tmpQuat = new THREE.Quaternion();
const tmpDisplacement = new THREE.Vector3();
const tmpDesired = new THREE.Vector3();

/** Stick magnitude under which the character is treated as hands-off. */
const STICK_EPSILON = 1e-3;

/* -------------------------------------------------------------------------- */
/* Controller                                                                 */
/* -------------------------------------------------------------------------- */

export class PlayerController {
  readonly stateMachine = new LocomotionStateMachine('idle');
  /** Solved world position of the capsule CENTRE. Read-only for callers. */
  readonly position = new THREE.Vector3();
  /** Planar velocity this controller commands, m/s. `y` is always 0. */
  readonly velocity = new THREE.Vector3();

  /** Character facing about Y, radians. Follows the movement direction. */
  yaw: number;
  /**
   * Yaw of the movement basis, radians — normally the camera's.
   *
   * The camera rig writes this every frame BEFORE `update()`. Left at 0 the
   * character moves in world axes, which is what the unit tests want.
   */
  cameraYaw = 0;

  private readonly controller: ICharacterController;
  private readonly tuning: IPlayerTuning;
  private readonly animator: IAnimator | null;
  private readonly root: THREE.Object3D | null;
  private readonly footOffset: number;
  private readonly clipFade: number;
  private readonly unsubscribe: (() => void) | null;

  /* --- per-frame carried state --- */
  private grounded = false;
  private wasGrounded = false;
  private pendingPostStep = false;
  private lastDt = 1 / 60;
  private dashing = false;
  private charging = false;
  /** Consecutive frames the sweep fell short of the commanded displacement. */
  private blockedFrames = 0;
  private moveMagnitude = 0;

  /* --- air / jump --- */
  private timeSinceGrounded = 0;
  private jumpBuffer = 0;
  private jumpConsumed = false;
  private jumpHolding = false;
  private jumpElapsed = 0;
  private airborneSeconds = 0;
  /** Airborne time measured at the most recent touchdown. */
  private airborneAtTouchdown = 0;
  /** Whether the flight that just ended was started by a jump. */
  private jumpConsumedThisFlight = false;
  private apexY = 0;
  private groundY = 0;
  private previousY = 0;
  private previousVerticalSpeed = 0;

  /* --- landing --- */
  private recoveryRemaining = 0;
  private recoveryTotal = 0;
  private recoveryHard = false;
  private landingFromBus: GameEventOf<'PlayerLanded'> | null = null;
  private lastLanding: IPlayerLandingInfo | undefined;
  private controlScale = 1;
  private targetSpeed = 0;

  private disposed = false;

  constructor(options: IPlayerControllerOptions) {
    this.controller = options.controller;
    this.tuning = options.tuning ?? DEFAULT_PLAYER_TUNING;
    this.animator = options.animator ?? null;
    this.root = options.root ?? options.character?.root ?? null;
    this.footOffset = options.footOffsetM ?? 0.875;
    this.clipFade = options.clipFadeSeconds ?? 0.12;
    this.yaw = options.yaw ?? 0;

    this.controller.body.getTransform(this.position, tmpQuat);
    this.apexY = this.position.y;
    this.groundY = this.position.y;
    this.previousY = this.position.y;
    // Adopt the contact state the controller already has. Starting at `false`
    // costs the first frame of a standing start its ground acceleration, and
    // makes `coyoteRemaining` read full before anything has happened.
    this.grounded = this.controller.isGrounded;
    this.wasGrounded = this.grounded;

    // The ONLY cross-system wiring in this file, and it is inbound: physics
    // publishes the landing, this controller reacts to it.
    this.unsubscribe =
      options.bus?.on('PlayerLanded', (event) => {
        this.landingFromBus = event;
      }) ?? null;

    this.playClip(this.stateMachine.current, 0);
    this.syncRoot();
  }

  /* ------------------------------------------------------------------ */
  /* Read-out                                                           */
  /* ------------------------------------------------------------------ */

  get state(): PlayerLocoState {
    return this.stateMachine.current;
  }

  get isGrounded(): boolean {
    return this.grounded;
  }

  /** Planar speed in m/s. */
  get speed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  /** Vertical speed in m/s, owned by the physics controller. */
  get verticalSpeed(): number {
    return this.controller.velocity.y;
  }

  /** Metres above the last ground contact. Drives the camera's apex pull-back. */
  get heightAboveGround(): number {
    return Math.max(0, this.position.y - this.groundY);
  }

  /** Highest point reached in the current airborne arc, above the ground. */
  get apexHeight(): number {
    return Math.max(0, this.apexY - this.groundY);
  }

  /** True while a serious punch is being wound up. The camera pulls back on it. */
  get isCharging(): boolean {
    return this.charging;
  }

  get isDashing(): boolean {
    return this.dashing;
  }

  /** Most recent landing, or undefined before the first one. */
  get landing(): IPlayerLandingInfo | undefined {
    return this.lastLanding;
  }

  /** Seconds of coyote time still available. 0 once spent. */
  get coyoteRemaining(): number {
    if (this.grounded) return this.tuning.locomotion.coyoteSeconds;
    if (this.jumpConsumed) return 0;
    return Math.max(0, this.tuning.locomotion.coyoteSeconds - this.timeSinceGrounded);
  }

  /** Seconds a pressed jump is still remembered for. */
  get jumpBufferRemaining(): number {
    return Math.max(0, this.jumpBuffer);
  }

  diagnostics(): IPlayerDiagnostics {
    return {
      state: this.stateMachine.current,
      timeInState: this.stateMachine.timeInState,
      grounded: this.grounded,
      planarSpeed: this.speed,
      verticalSpeed: this.controller.velocity.y,
      targetSpeed: this.targetSpeed,
      yaw: this.yaw,
      heightAboveGround: this.heightAboveGround,
      coyoteRemaining: this.coyoteRemaining,
      jumpBufferRemaining: this.jumpBufferRemaining,
      controlScale: this.controlScale,
      recoveryRemaining: Math.max(0, this.recoveryRemaining),
      dashing: this.dashing,
      charging: this.charging,
      airborneSeconds: this.airborneSeconds,
      apexHeight: this.apexHeight,
      lastLanding: this.lastLanding,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Frame                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Read intent and command one step of motion.
   *
   * Calls `ICharacterController.move()` exactly once. The caller must step the
   * physics world afterwards, then call `postStep()`.
   */
  update(input: InputState, dt: number): void {
    if (this.disposed || dt <= 0) return;
    // Cheap safety net for a caller that skipped postStep(): the state below
    // would otherwise be a whole frame stale in a way that is very hard to see.
    if (this.pendingPostStep) this.postStep();
    this.lastDt = dt;

    const loco = this.tuning.locomotion;
    const cam = this.tuning.camera;

    /* ---- 1. intent -------------------------------------------------- */
    const jump = input.buttons.jump;
    const sprint = input.buttons.sprint;
    const punch = input.buttons.punch;

    this.moveMagnitude = clamp01(input.move.magnitude);
    this.charging = punch.held && punch.holdTime >= cam.chargeStartSeconds;

    // `move` arrives in CAMERA space: +y is "away from the camera".
    const basis = this.cameraYaw;
    const sinB = Math.sin(basis);
    const cosB = Math.cos(basis);
    const forwardX = -sinB;
    const forwardZ = -cosB;
    const rightX = cosB;
    const rightZ = -sinB;
    tmpDesired.set(
      input.move.x * rightX + input.move.y * forwardX,
      0,
      input.move.x * rightZ + input.move.y * forwardZ
    );
    const desiredLen = Math.hypot(tmpDesired.x, tmpDesired.z);
    const hasIntent = this.moveMagnitude > STICK_EPSILON && desiredLen > STICK_EPSILON;
    if (hasIntent) {
      tmpDesired.x /= desiredLen;
      tmpDesired.z /= desiredLen;
    } else {
      tmpDesired.set(0, 0, 0);
    }
    this.dashing = sprint.held && hasIntent;

    /* ---- 2. jump buffering ------------------------------------------ */
    // Buffered BEFORE the eligibility test, so a press on the exact frame of
    // touchdown is honoured rather than racing it.
    if (jump.pressed) this.jumpBuffer = loco.jumpBufferSeconds;
    else this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);

    /* ---- 3. target velocity ----------------------------------------- */
    this.controlScale = this.computeControlScale();
    const maxSpeed = this.dashing ? loco.dashSpeed : loco.runSpeed;
    const stickScale = clamp01(this.moveMagnitude / Math.max(1e-4, loco.stickFullSpeedAt));
    this.targetSpeed = hasIntent ? maxSpeed * stickScale * this.controlScale : 0;

    this.integrateVelocity(tmpDesired, hasIntent, dt);

    /* ---- 4. facing --------------------------------------------------- */
    if (hasIntent) {
      // three.js convention: an object's forward is its local -Z, so the yaw
      // that FACES `d` is atan2(-d.x, -d.z), not atan2(d.x, d.z). Getting this
      // backwards is the classic "character moonwalks" bug.
      const target = Math.atan2(-tmpDesired.x, -tmpDesired.z);
      const rate = turnRateRadPerSec(loco, this.speed, this.grounded);
      this.yaw = wrapAngle(this.yaw + clamp(wrapAngle(target - this.yaw), -rate * dt, rate * dt));
    }

    /* ---- 5. jump ----------------------------------------------------- */
    this.updateJump(jump.held, dt);

    /* ---- 6. hand the step to physics --------------------------------- */
    this.previousY = this.position.y;
    this.previousVerticalSpeed = this.controller.velocity.y;
    tmpDisplacement.set(this.velocity.x * dt, 0, this.velocity.z * dt);
    this.controller.move(tmpDisplacement, dt);

    this.stateMachine.update(dt);
    this.pendingPostStep = true;
  }

  /**
   * Re-read the solved transform and resolve everything that depends on it.
   *
   * Call after `IPhysicsWorld.step()`. Idempotent: calling it twice in a frame
   * is a no-op, and never calling it costs one step of freshness.
   */
  postStep(): void {
    if (this.disposed || !this.pendingPostStep) return;
    this.pendingPostStep = false;

    const dt = this.lastDt;

    this.controller.body.getTransform(this.position, tmpQuat);
    this.grounded = this.controller.isGrounded;

    /* ---- recovery (before the landing that may restart it) ----------- */
    if (this.recoveryRemaining > 0) this.recoveryRemaining -= dt;

    /* ---- air bookkeeping -------------------------------------------- */
    if (this.grounded) {
      this.airborneAtTouchdown = this.airborneSeconds;
      this.jumpConsumedThisFlight = this.jumpConsumed;
      this.timeSinceGrounded = 0;
      this.airborneSeconds = 0;
      this.jumpConsumed = false;
      this.jumpHolding = false;
    } else {
      this.timeSinceGrounded += dt;
      this.airborneSeconds += dt;
      if (this.position.y > this.apexY) this.apexY = this.position.y;
    }

    /* ---- landing ----------------------------------------------------- */
    // Ordered so `onLanded()` still sees the pre-landing apex; `groundY` and
    // `apexY` are re-anchored to the contact point immediately afterwards.
    if (this.grounded && !this.wasGrounded && !this.wasMicroAirborne()) this.onLanded();
    this.landingFromBus = null;
    this.wasGrounded = this.grounded;
    if (this.grounded) {
      this.groundY = this.position.y;
      this.apexY = this.position.y;
    }

    /* ---- reconcile the commanded velocity with what happened ---------- */
    this.reconcileVelocity();

    /* ---- state ------------------------------------------------------- */
    this.resolveState();

    /* ---- visuals ----------------------------------------------------- */
    this.syncRoot();
  }

  /* ------------------------------------------------------------------ */
  /* Movement model                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * One step of the acceleration model.
   *
   * A single vectorial `moveTowards`, with the RATE chosen from three terms:
   *
   *   accel      when the target is faster than the current speed
   *   decel      when it is slower (including "no input at all")
   *   turnBrake  scaled by how far the wanted direction is from the current
   *              one — 0 when aligned, full when reversed
   *
   * Doing turning as extra DECELERATION rather than as a steering rate is what
   * gives the character its weight: a reversal spends real time killing the old
   * velocity, but spends it in a straight line instead of an arc.
   */
  private integrateVelocity(direction: THREE.Vector3, hasIntent: boolean, dt: number): void {
    const loco = this.tuning.locomotion;
    const speed = this.speed;
    const targetX = direction.x * this.targetSpeed;
    const targetZ = direction.z * this.targetSpeed;

    let rate: number;
    if (this.grounded) {
      rate =
        this.targetSpeed > speed
          ? this.dashing
            ? loco.dashAccelMps2
            : loco.groundAccelMps2
          : loco.groundDecelMps2;
    } else {
      rate = this.targetSpeed > speed ? loco.airAccelMps2 : loco.airDecelMps2;
    }

    if (hasIntent && speed > loco.idleSpeedThreshold) {
      const align = (this.velocity.x * direction.x + this.velocity.z * direction.z) / speed;
      const brake = loco.turnBrakeMps2 * (this.grounded ? 1 : loco.airTurnBrakeRatio);
      rate += brake * clamp01((1 - align) * 0.5);
    }

    // Landing recovery throttles how hard the character may push, not just how
    // fast it may end up going: without this, a hard landing still accelerates
    // like a standing start and the crater reads as weightless.
    if (this.grounded) rate *= 0.25 + 0.75 * this.controlScale;

    const maxDelta = rate * dt;
    const dx = targetX - this.velocity.x;
    const dz = targetZ - this.velocity.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= maxDelta || dist < 1e-9) {
      this.velocity.set(targetX, 0, targetZ);
    } else {
      const scale = maxDelta / dist;
      this.velocity.set(this.velocity.x + dx * scale, 0, this.velocity.z + dz * scale);
    }
  }

  /**
   * Take the SOLVED horizontal velocity back from physics when the character
   * was actually blocked.
   *
   * `ICharacterController.velocity` reports what the sweep ACHIEVED, so running
   * into a wall reports ~0, and adopting that gives a wall slide for free.
   *
   * ── WHY IT TAKES TWO FRAMES ────────────────────────────────────────────
   * Measured, not assumed: Rapier's sweep returns a shortened or redirected
   * movement for a single step every dozen frames or so, on flat ground, with
   * nothing anywhere near the capsule — ratios of 0.71 and 0.45 against the
   * commanded displacement. Reacting to one frame of that turns a standing
   * start from 0.18 s into 0.33 s and reads as the controls sticking.
   *
   * A wall lasts; a solver hiccup does not. Requiring the shortfall on two
   * consecutive frames rejects every hiccup and costs a real collision 16 ms
   * of speed nobody can see.
   */
  private reconcileVelocity(): void {
    const commanded = this.speed;
    if (commanded < 1e-6) {
      this.blockedFrames = 0;
      return;
    }
    const solvedX = this.controller.velocity.x;
    const solvedZ = this.controller.velocity.z;
    const solved = Math.hypot(solvedX, solvedZ);
    if (solved >= commanded * 0.85) {
      this.blockedFrames = 0;
      return;
    }
    this.blockedFrames++;
    if (this.blockedFrames >= 2) this.velocity.set(solvedX, 0, solvedZ);
  }

  /* ------------------------------------------------------------------ */
  /* Jump                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Coyote time, buffering, and the variable-height ascent.
   *
   * ── HOW A VARIABLE JUMP IS BUILT OUT OF `jump(speed)` ──────────────────
   * The contract's `jump()` only ever RAISES vertical speed (`max`), so a jump
   * cannot be cut short after the fact. Instead the launch is the SHORT one —
   * `hopSpeed` — and while the button stays held the controller re-issues
   * `jump()` with a ceiling that ramps to `jumpSpeed` across
   * `jumpRampSeconds` and then decays at exactly the rise gravity.
   *
   * Because the ceiling decays at the rise gravity, letting go at any moment
   * leaves the vertical speed continuous: there is no step, no kink, and no
   * frame where the character appears to be yanked upward. And once the ramp
   * completes, the ceiling has converged onto the free-flight curve, so the
   * re-issues quietly stop doing anything.
   *
   * MEASURED against Rapier (`harness/player.verify.ts`): a tap reaches
   * 11.73 m and a hold reaches 26.87 m, straddling the 15 m crater threshold —
   * a hop is traversal, a held leap is a weapon. The held apex is 1.1 m short
   * of the 28 m a single-shot launch would reach, which is the price of the
   * ramp: every millisecond spent below full speed is height not bought.
   */
  private updateJump(held: boolean, dt: number): void {
    const loco = this.tuning.locomotion;

    const eligible =
      this.jumpBuffer > 0 &&
      !this.jumpConsumed &&
      (this.grounded || this.timeSinceGrounded <= loco.coyoteSeconds) &&
      // A cratering landing is a beat the player sits through. `land` is not.
      this.stateMachine.current !== 'hardLand';

    if (eligible) {
      this.controller.jump(loco.hopSpeed);
      this.jumpBuffer = 0;
      this.jumpConsumed = true;
      this.jumpHolding = true;
      this.jumpElapsed = 0;
      // Spend the coyote window: without this the same press could be honoured
      // twice inside 120 ms.
      this.timeSinceGrounded = Number.POSITIVE_INFINITY;
      this.grounded = false;
      this.apexY = this.position.y;
      this.recoveryRemaining = 0;
      this.request('jumpLaunch');
      return;
    }

    if (!this.jumpHolding) return;

    this.jumpElapsed += dt;
    const rising = this.controller.velocity.y > 0;
    // A ceiling strike (or any interruption of the ascent) ends the hold, so
    // the boost cannot grind the character against the underside of geometry.
    const progressed = this.position.y - this.previousY > this.previousVerticalSpeed * dt * 0.3;
    if (!held || !rising || this.jumpElapsed > loco.jumpHoldSeconds || !progressed) {
      this.jumpHolding = false;
      return;
    }
    this.controller.jump(heldJumpSpeedCeiling(loco, this.jumpElapsed));
  }

  /* ------------------------------------------------------------------ */
  /* Landing                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * True when the airborne interval just ended was too short and too shallow
   * to have been real — a solver hiccup rather than a jump or a ledge.
   */
  private wasMicroAirborne(): boolean {
    const loco = this.tuning.locomotion;
    if (this.jumpConsumedThisFlight) return false;
    if (this.airborneAtTouchdown > loco.groundGraceSeconds) return false;
    return Math.max(0, this.apexY - this.position.y) < 0.5;
  }

  private onLanded(): void {
    const loco = this.tuning.locomotion;

    // Prefer the physics event: it measured the impact inside the same step
    // that resolved the contact, so its fall height has no interpolation error.
    const bus = this.landingFromBus;
    const fallHeight = bus?.fallHeight ?? Math.max(0, this.apexY - this.position.y);
    const impactSpeed = bus?.impactSpeed ?? Math.abs(this.previousVerticalSpeed);
    const hard = bus?.createsCrater ?? fallHeight >= loco.hardLandFallHeightM;
    const recovery = landingRecoverySeconds(loco, fallHeight);

    this.recoveryRemaining = recovery;
    this.recoveryTotal = recovery;
    this.recoveryHard = hard;
    this.lastLanding = {
      fallHeight,
      impactSpeed,
      hard,
      recoverySeconds: recovery,
      fromBus: bus !== null,
    };

    const retention = hard ? loco.hardLandSpeedRetention : loco.landSpeedRetention;
    this.velocity.multiplyScalar(retention);
    this.jumpHolding = false;
    this.request(hard ? 'hardLand' : 'land');
  }

  /**
   * Movement authority 0..1 during a landing recovery.
   *
   * Starts at the floor for the flavour of landing and eases back to full over
   * the recovery window. Smoothstep rather than linear so control returns
   * gently at first and then all at once — a linear ramp reads as sticky.
   */
  private computeControlScale(): number {
    if (this.recoveryRemaining <= 0 || this.recoveryTotal <= 0) return 1;
    const loco = this.tuning.locomotion;
    const floor = this.recoveryHard ? loco.hardLandControlFloor : loco.landControlFloor;
    const t = clamp01(1 - this.recoveryRemaining / this.recoveryTotal);
    return floor + (1 - floor) * smoothstep(0, 1, t);
  }

  /* ------------------------------------------------------------------ */
  /* State resolution                                                   */
  /* ------------------------------------------------------------------ */

  private resolveState(): void {
    const loco = this.tuning.locomotion;
    const machine = this.stateMachine;
    const current = machine.current;

    if (!this.grounded) {
      // A single frame of lost contact is solver noise, not a fall. Hold the
      // ground state until the grace window expires, unless a jump started it.
      if (
        !this.jumpConsumed &&
        this.airborneSeconds <= loco.groundGraceSeconds &&
        current !== 'jumpLaunch' &&
        current !== 'fall'
      ) {
        return;
      }
      // The launch pose holds briefly, then the arc reads as a fall. Using
      // vertical speed alone makes the flip happen at the exact apex frame,
      // which is a single-frame pop at the top of a 3 s leap.
      const wantsLaunch =
        current === 'jumpLaunch' &&
        machine.timeInState < loco.jumpLaunchSeconds &&
        this.controller.velocity.y > 0;
      this.request(wantsLaunch ? 'jumpLaunch' : 'fall');
      return;
    }

    if (isRecoveryState(current) && this.recoveryRemaining > 0) return;

    this.request(resolveGroundState(loco, this.speed, this.dashing));
  }

  private request(next: PlayerLocoState): void {
    if (next === this.stateMachine.current) return;
    if (this.stateMachine.transition(next)) this.playClip(next, this.clipFade);
  }

  /* ------------------------------------------------------------------ */
  /* Presentation                                                       */
  /* ------------------------------------------------------------------ */

  private playClip(state: PlayerLocoState, fade: number): void {
    // A null animator is expected while the animation workstream is in flight.
    if (this.animator === null) return;
    this.animator.play(toClipName(state), { fade });
  }

  private syncRoot(): void {
    if (this.root === null) return;
    this.root.position.set(
      this.position.x,
      this.position.y - this.footOffset,
      this.position.z
    );
    this.root.rotation.set(0, this.yaw, 0);
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  /** Teleport, clearing every timer so no stale coyote or buffer survives. */
  setPosition(position: THREE.Vector3): void {
    this.controller.setPosition(position);
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.apexY = position.y;
    this.groundY = position.y;
    this.previousY = position.y;
    this.previousVerticalSpeed = 0;
    // A teleport is not a ledge exit: no coyote time comes with it.
    this.timeSinceGrounded = Number.POSITIVE_INFINITY;
    this.airborneSeconds = 0;
    this.jumpBuffer = 0;
    this.jumpConsumed = false;
    this.jumpHolding = false;
    this.recoveryRemaining = 0;
    this.recoveryTotal = 0;
    this.pendingPostStep = false;
    this.grounded = false;
    this.wasGrounded = false;
    if (this.stateMachine.transition('fall', true)) this.playClip('fall', 0);
    this.syncRoot();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.stateMachine.clearHooks();
  }
}
