/**
 * TEST DOUBLES FOR THE PLAYER WORKSTREAM
 *
 * Two stubs and an `InputState` builder, all written against the CONTRACTS in
 * `src/types/` and nothing else.
 *
 * ── WHY A STUB CHARACTER CONTROLLER AND NOT RAPIER ─────────────────────────
 * These tests are about the layer this workstream owns: the acceleration
 * model, coyote time, buffering, the state machine and the camera. Running
 * them through the real solver would test Rapier's sweep (which `src/physics`
 * already verifies exhaustively) at the cost of a wasm boot per file, and it
 * would let a physics change silently move a feel assertion.
 *
 * So the stub reproduces exactly the parts of `ICharacterController` the feel
 * layer can observe, INCLUDING the two quirks that matter:
 *   • gravity is asymmetric (−22 rising, −22 × 1.6 falling);
 *   • `jump()` only ever RAISES vertical speed;
 *   • `velocity.x/z` report what the move ACHIEVED, not what was asked for.
 * The real integration — Rapier, slopes, autostep, the crater event — is
 * measured in `harness/player.*`, in a browser, against the actual module.
 */

import * as THREE from 'three';
import type {
  ButtonState,
  ICharacterController,
  IRigidBody,
  InputAction,
  InputState,
} from '@/types';

/* -------------------------------------------------------------------------- */
/* Physics constants mirrored from src/physics/constants.ts                   */
/* -------------------------------------------------------------------------- */

export const STUB_GRAVITY = -22;
export const STUB_FALL_MULTIPLIER = 1.6;
/** The downward bias the real controller applies while grounded. */
export const STUB_GROUND_BIAS = -2;

/* -------------------------------------------------------------------------- */
/* Character controller stub                                                  */
/* -------------------------------------------------------------------------- */

export interface IStubControllerOptions {
  readonly position?: THREE.Vector3;
  /** Ground height. The capsule centre rests at `groundY + standHeight`. */
  readonly groundY?: number;
  /** Capsule centre height above the surface it stands on. */
  readonly standHeight?: number;
  /**
   * Optional planar blocker: a wall at `x >= wallX`. Used to prove the
   * controller adopts the SOLVED velocity when it is actually blocked.
   */
  readonly wallX?: number;
  /** When set, ground only exists for `z <= ledgeZ` — a cliff edge. */
  readonly ledgeZ?: number;
}

/** A flat-world `ICharacterController`, faithful to the real one's semantics. */
export class StubCharacterController implements ICharacterController {
  readonly groundNormal = new THREE.Vector3(0, 1, 0);
  readonly velocity = new THREE.Vector3();
  readonly position = new THREE.Vector3();

  maxSlopeAngle = 50 * (Math.PI / 180);
  stepHeight = 0.5;

  /** Landing reports, for tests that want the raw sequence. */
  readonly landings: { fallHeight: number; impactSpeed: number }[] = [];

  readonly body: IRigidBody;

  private readonly groundY: number;
  private readonly standHeight: number;
  private readonly wallX: number;
  private readonly ledgeZ: number;
  private grounded = true;
  private apexY: number;
  /** Frames of forged contact loss; see `simulateContactLoss`. */
  private contactLossFrames = 0;

  constructor(options: IStubControllerOptions = {}) {
    this.groundY = options.groundY ?? 0;
    this.standHeight = options.standHeight ?? 0.875;
    this.wallX = options.wallX ?? Number.POSITIVE_INFINITY;
    this.ledgeZ = options.ledgeZ ?? Number.POSITIVE_INFINITY;
    this.position.copy(options.position ?? new THREE.Vector3(0, this.restY, 0));
    this.apexY = this.position.y;

    // Arrow functions rather than a `self` alias: they close over `this`
    // lexically, so the facade needs no captured reference at all.
    this.body = {
      handle: 1,
      type: 'kinematic',
      isSleeping: false,
      mass: 70,
      getTransform: (position: THREE.Vector3): void => {
        position.copy(this.position);
      },
      setTransform: (position: THREE.Vector3): void => {
        this.position.copy(position);
      },
      getLinearVelocity: (out: THREE.Vector3): THREE.Vector3 => out.copy(this.velocity),
      setLinearVelocity: (v: THREE.Vector3): void => {
        this.velocity.copy(v);
      },
      getAngularVelocity: (out: THREE.Vector3): THREE.Vector3 => out.set(0, 0, 0),
      setAngularVelocity: (): void => {},
      applyImpulse: (): void => {},
      applyForce: (): void => {},
      applyTorqueImpulse: (): void => {},
      wake: (): void => {},
      setEnabled: (): void => {},
    };
  }

  private get restY(): number {
    return this.groundY + this.standHeight;
  }

  get isGrounded(): boolean {
    return this.grounded;
  }

  /**
   * Forge `frames` steps in which the sweep reports no ground contact while
   * the character is plainly standing on the floor.
   *
   * This is not a hypothetical: Rapier does exactly this on flat ground every
   * dozen frames or so at speed, and the feel layer has to be immune to it.
   */
  simulateContactLoss(frames: number): void {
    this.contactLossFrames = frames;
  }

  /** True where solid ground exists under `z`. */
  private hasGroundAt(z: number): boolean {
    return z <= this.ledgeZ;
  }

  move(displacement: THREE.Vector3, dt: number): void {
    if (dt <= 0) return;

    // Gravity, with the same asymmetric curve and grounded bias as the real one.
    if (this.grounded && this.velocity.y <= 0) {
      this.velocity.y = STUB_GROUND_BIAS;
    } else {
      const g = this.velocity.y < 0 ? STUB_GRAVITY * STUB_FALL_MULTIPLIER : STUB_GRAVITY;
      this.velocity.y += g * dt;
    }

    const wantX = this.position.x + displacement.x;
    const wantZ = this.position.z + displacement.z;
    const appliedX = Math.min(wantX, this.wallX) - this.position.x;
    const appliedZ = wantZ - this.position.z;

    this.position.x += appliedX;
    this.position.z += appliedZ;
    this.position.y += this.velocity.y * dt + displacement.y;

    const wasGrounded = this.grounded;
    if (this.contactLossFrames > 0) {
      this.contactLossFrames--;
      this.grounded = false;
      this.position.y = Math.max(this.position.y, this.restY);
      this.velocity.x = appliedX / dt;
      this.velocity.z = appliedZ / dt;
      return;
    }
    if (this.hasGroundAt(this.position.z) && this.position.y <= this.restY) {
      this.position.y = this.restY;
      this.grounded = true;
      if (!wasGrounded) {
        this.landings.push({
          fallHeight: Math.max(0, this.apexY - this.position.y),
          impactSpeed: Math.abs(this.velocity.y),
        });
      }
      if (this.velocity.y < 0) this.velocity.y = 0;
      this.apexY = this.position.y;
    } else {
      this.grounded = false;
      if (this.position.y > this.apexY) this.apexY = this.position.y;
    }

    // Report what the move ACHIEVED, exactly like the real controller.
    this.velocity.x = appliedX / dt;
    this.velocity.z = appliedZ / dt;
  }

  jump(speed: number): void {
    this.velocity.y = Math.max(this.velocity.y, speed);
    this.grounded = false;
    this.apexY = this.position.y;
  }

  setPosition(position: THREE.Vector3): void {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.apexY = position.y;
    this.grounded = false;
  }
}

/* -------------------------------------------------------------------------- */
/* Camera probe stub                                                          */
/* -------------------------------------------------------------------------- */

/** An axis-aligned slab occupying `x >= planeX`, used as a wall. */
export function wallProbe(planeX: number): {
  probe(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number): number;
} {
  return {
    probe(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number): number {
      if (direction.x <= 1e-6) return Number.POSITIVE_INFINITY;
      const d = (planeX - origin.x) / direction.x;
      if (d < 0 || d > maxDistance) return Number.POSITIVE_INFINITY;
      return d;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* InputState builder                                                         */
/* -------------------------------------------------------------------------- */

const ACTIONS: readonly InputAction[] = [
  'punch',
  'heavyPunch',
  'jump',
  'sprint',
  'dodge',
  'block',
  'interact',
  'lockOn',
  'special',
  'pause',
  'map',
  'cameraReset',
  'toggleIntent',
  'debugToggle',
];

/**
 * A minimal `InputState` factory with REAL edge semantics.
 *
 * Mirrors what `src/ui/input` produces — `pressed` on the first frame of a
 * hold, `held` thereafter, `released` on the frame it goes up — because
 * gameplay code that only ever sees `pressed: true` on ten frames running is
 * being tested against input that cannot physically happen.
 */
export class InputScript {
  private frame = 0;
  private time = 0;
  private readonly held = new Map<InputAction, number>();
  private readonly holdTimes = new Map<InputAction, number>();
  private previous = new Set<InputAction>();
  private moveX = 0;
  private moveY = 0;
  private lookX = 0;
  private lookY = 0;
  private pinch = 1;

  setMove(x: number, y: number): this {
    this.moveX = x;
    this.moveY = y;
    return this;
  }

  setLook(x: number, y: number): this {
    this.lookX = x;
    this.lookY = y;
    return this;
  }

  setPinch(delta: number): this {
    this.pinch = delta;
    return this;
  }

  press(action: InputAction, value = 1): this {
    this.held.set(action, value);
    return this;
  }

  release(action: InputAction): this {
    this.held.delete(action);
    return this;
  }

  /** Advance one frame and return the snapshot for it. */
  poll(dt: number): InputState {
    const buttons = {} as Record<InputAction, ButtonState>;
    const nowDown = new Set<InputAction>(this.held.keys());
    for (const action of ACTIONS) {
      const down = nowDown.has(action);
      const wasDown = this.previous.has(action);
      if (down) {
        this.holdTimes.set(action, (wasDown ? (this.holdTimes.get(action) ?? 0) : 0) + dt);
      }
      buttons[action] = down
        ? {
            pressed: !wasDown,
            held: true,
            released: false,
            holdTime: this.holdTimes.get(action) ?? dt,
            value: this.held.get(action) ?? 1,
          }
        : {
            pressed: false,
            held: false,
            released: wasDown,
            holdTime: 0,
            value: 0,
          };
      if (!down) this.holdTimes.delete(action);
    }
    this.previous = nowDown;

    const moveMag = Math.min(1, Math.hypot(this.moveX, this.moveY));
    const lookMag = Math.min(1, Math.hypot(this.lookX, this.lookY));
    const state: InputState = {
      frame: this.frame++,
      time: (this.time += dt),
      device: 'synthetic',
      move: {
        x: this.moveX,
        y: this.moveY,
        magnitude: moveMag,
        angle: Math.atan2(this.moveY, this.moveX),
        active: moveMag > 0,
      },
      look: {
        x: this.lookX,
        y: this.lookY,
        magnitude: lookMag,
        angle: Math.atan2(this.lookY, this.lookX),
        active: lookMag > 0,
      },
      buttons,
      pointers: [],
      pinchDelta: this.pinch,
      twistDelta: 0,
      anyActive: moveMag > 0 || lookMag > 0 || nowDown.size > 0,
    };
    this.pinch = 1;
    return state;
  }
}
