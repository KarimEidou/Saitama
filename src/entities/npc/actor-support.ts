/**
 * ACTOR PLUMBING — the parts of `IActor` that are the same for everybody
 *
 * `IEntity` and `IActor` are broad contracts: a transform whose vectors are
 * mutated in place, a state machine with enter/exit hooks, an animation set
 * covering every `ClipName` slot. Implementing them once per NPC class would
 * be three near-identical copies, and the third copy is where the yaw
 * convention silently disagrees with the other two.
 *
 * So this file holds the shared halves, and `NearCivilian` and `HeroNpc`
 * differ only where they actually differ: faction, ability set and brain.
 */

import * as THREE from 'three';
import type { ActorState, IAnimationSet, IStateMachine, ITransform } from '@/types';

/**
 * An `ITransform` backed by an `Object3D`.
 *
 * `yaw` is the authority and the quaternion follows it, not the other way
 * round. Every ground actor in this game turns about Y and nothing else, and
 * deriving yaw back out of a quaternion each frame costs an `atan2` and
 * introduces a wrap discontinuity that the turn-rate limiter then has to
 * handle. The one place a quaternion is authoritative is a ragdoll, and a
 * ragdoll has stopped using this.
 */
export class ActorTransform implements ITransform {
  readonly position: THREE.Vector3;
  readonly rotation = new THREE.Quaternion();
  readonly scale = new THREE.Vector3(1, 1, 1);
  readonly forward = new THREE.Vector3(0, 0, -1);
  readonly object3D: THREE.Object3D;

  private yawValue = 0;

  constructor(object3D: THREE.Object3D) {
    this.object3D = object3D;
    this.position = object3D.position;
  }

  get yaw(): number {
    return this.yawValue;
  }

  set yaw(value: number) {
    this.yawValue = value;
    this.rotation.setFromAxisAngle(UP, value);
    this.object3D.quaternion.copy(this.rotation);
    // Characters face -Z, so heading (sin y, -cos y) is forward.
    this.forward.set(Math.sin(value), 0, -Math.cos(value));
  }

  /** Write position and yaw in one call, keeping the derived fields in step. */
  set(x: number, y: number, z: number, yaw: number): void {
    this.position.set(x, y, z);
    this.yaw = yaw;
  }
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * A small state machine over `ActorState`.
 *
 * Transitions out of `death` are refused unless forced, which is the one rule
 * worth enforcing structurally: a dead civilian who is still receiving alarm
 * updates will otherwise transition to `flee` on the next frame and stand up.
 */
export class ActorStateMachine implements IStateMachine<ActorState> {
  private state: ActorState;
  private prior: ActorState | undefined;
  private elapsed = 0;
  private readonly enterHooks = new Map<ActorState, Set<() => void>>();
  private readonly exitHooks = new Map<ActorState, Set<() => void>>();

  constructor(initial: ActorState = 'idle') {
    this.state = initial;
  }

  get current(): ActorState {
    return this.state;
  }

  get previous(): ActorState | undefined {
    return this.prior;
  }

  get timeInState(): number {
    return this.elapsed;
  }

  canTransition(next: ActorState): boolean {
    if (next === this.state) return false;
    if (this.state === 'death') return false;
    return true;
  }

  transition(next: ActorState, force = false): boolean {
    if (!force && !this.canTransition(next)) return false;
    if (next === this.state) return false;
    for (const hook of this.exitHooks.get(this.state) ?? EMPTY) hook();
    this.prior = this.state;
    this.state = next;
    this.elapsed = 0;
    for (const hook of this.enterHooks.get(next) ?? EMPTY) hook();
    return true;
  }

  onEnter(state: ActorState, cb: () => void): () => void {
    return subscribe(this.enterHooks, state, cb);
  }

  onExit(state: ActorState, cb: () => void): () => void {
    return subscribe(this.exitHooks, state, cb);
  }

  update(dt: number): void {
    this.elapsed += dt;
  }
}

const EMPTY: ReadonlySet<() => void> = new Set();

function subscribe(
  map: Map<ActorState, Set<() => void>>,
  state: ActorState,
  cb: () => void
): () => void {
  let set = map.get(state);
  if (set === undefined) {
    set = new Set();
    map.set(state, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
  };
}

/**
 * The animation set every procedurally-generated character uses.
 *
 * Slot names map to themselves because the clips are FUNCTIONS resolved by
 * slot, not clip names inside a GLB. `IAnimationSet` exists for the imported
 * case and is filled in honestly here rather than left half-populated, so
 * anything that reads `actor.animations.flee` gets a usable answer.
 */
export const PROCEDURAL_ANIMATIONS: IAnimationSet = {
  idle: 'idle',
  walk: 'walk',
  run: 'run',
  sprint: 'sprint',
  jump: 'jump',
  fall: 'fall',
  land: 'land',
  attack: 'attack',
  heavyAttack: 'heavyAttack',
  block: 'block',
  dodge: 'dodge',
  hit: 'hit',
  stagger: 'stagger',
  death: 'death',
  flee: 'flee',
  taunt: 'taunt',
  special: 'special',
};

/** Shortest signed angle from `from` to `to`, in (-PI, PI]. */
export function angleTo(from: number, to: number): number {
  let delta = to - from;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta <= -Math.PI) delta += Math.PI * 2;
  return delta;
}

/** Yaw that faces a world-space direction. Characters look down -Z. */
export function yawFromDirection(dx: number, dz: number): number {
  return Math.atan2(dx, -dz);
}
