/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THE `IMonster` ADAPTER — WHERE BEHAVIOUR MEETS A SCENE NODE             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `MonsterBrain` is arithmetic: `Vec3`, floats, a state machine, no renderer.
 * `Monster` is the ten per cent that has to touch `three` — a transform, a
 * scene root, and an optional `ICharacterInstance` whose animator it drives.
 *
 * ── BEHAVIOUR, NOT GEOMETRY ───────────────────────────────────────────────
 * This class does not build a mesh, choose a material, pick a colour or load a
 * texture. The roster workstream owns every monster body in the game; the only
 * link between the two is `IMonsterArchetype.assetKey`, a string, resolved by
 * the host through `ICharacterFactory`. `attach()` takes the finished instance
 * and asks it for exactly one thing per frame: play this clip.
 *
 * That separation is why a monster's behaviour survives its mesh being rebuilt
 * underneath it, why the entire FSM and all four boss scripts unit-test with
 * no GPU present, and why the roster can be reskinned without a line changing
 * here.
 *
 * ── THE `IActor.stateMachine` PROJECTION ──────────────────────────────────
 * `IActor` promises an `IStateMachine<ActorState>`, and monsters run six
 * states of their own — `alerted`, `pursue` and `dead` are not `ActorState`
 * members. Rather than corrupt either vocabulary, `ActorStateView` projects
 * one onto the other, so an animator or HUD written against the shared
 * contract sees `run`/`attack`/`death` while the brain keeps saying `pursue`.
 */

import * as THREE from 'three';
import type {
  ActorState,
  ClipName,
  EntityId,
  Faction,
  IAnimationSet,
  ICharacterInstance,
  IEventBus,
  IMonster,
  IMonsterSpec,
  IStateMachine,
  ITransform,
  IActor,
} from '@/types';
import type { IRandom } from '@/util';
import { MonsterBrain, type IMonsterBrainOptions } from './brain';
import type { MonsterFsm } from './fsm';
import type { IMonsterArchetype, IMonsterSnapshot, IMonsterWorld, MonsterState } from './types';

/* -------------------------------------------------------------------------- */
/* Transform                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A transform backed by an `Object3D`.
 *
 * `yaw` is a real accessor rather than a cached float: writing it must rebuild
 * the quaternion, or the scene node and the brain disagree about facing the
 * first time something else reads `rotation`.
 */
class MonsterTransform implements ITransform {
  readonly position: THREE.Vector3;
  readonly rotation: THREE.Quaternion;
  readonly scale: THREE.Vector3;
  readonly forward = new THREE.Vector3(0, 0, 1);
  readonly object3D: THREE.Object3D;

  private yawValue = 0;

  constructor(object3D: THREE.Object3D) {
    this.object3D = object3D;
    this.position = object3D.position;
    this.rotation = object3D.quaternion;
    this.scale = object3D.scale;
  }

  get yaw(): number {
    return this.yawValue;
  }

  set yaw(value: number) {
    this.yawValue = value;
    this.rotation.setFromAxisAngle(UP, value);
    this.forward.set(Math.sin(value), 0, Math.cos(value));
  }
}

const UP = new THREE.Vector3(0, 1, 0);

/* -------------------------------------------------------------------------- */
/* State projection                                                           */
/* -------------------------------------------------------------------------- */

/** Monster state → the `ActorState` the shared contract expects. */
export const MONSTER_TO_ACTOR_STATE: Readonly<Record<MonsterState, ActorState>> = Object.freeze({
  idle: 'idle',
  alerted: 'idle',
  pursue: 'run',
  attack: 'attack',
  stagger: 'stagger',
  dead: 'death',
});

/**
 * `ActorState` → monster state, for `transition` and for subscriptions.
 *
 * Deliberately partial. A caller asking a monster to `block`, `dodge` or
 * `jump` is asking for something monsters do not have, and the honest answer
 * is `false` from `transition` and a no-op unsubscribe from `onEnter` — not a
 * silent mapping onto the nearest available state.
 */
export const ACTOR_TO_MONSTER_STATE: Readonly<Partial<Record<ActorState, MonsterState>>> =
  Object.freeze({
    idle: 'idle',
    walk: 'pursue',
    run: 'pursue',
    sprint: 'pursue',
    attack: 'attack',
    heavyAttack: 'attack',
    hit: 'stagger',
    stagger: 'stagger',
    death: 'dead',
  });

const NOOP = (): void => {};

/** Projects a `MonsterFsm` onto the `IStateMachine<ActorState>` contract. */
class ActorStateView implements IStateMachine<ActorState> {
  private readonly fsm: MonsterFsm;

  constructor(fsm: MonsterFsm) {
    this.fsm = fsm;
  }

  get current(): ActorState {
    return MONSTER_TO_ACTOR_STATE[this.fsm.current];
  }

  get previous(): ActorState | undefined {
    const prior = this.fsm.previous;
    return prior === undefined ? undefined : MONSTER_TO_ACTOR_STATE[prior];
  }

  get timeInState(): number {
    return this.fsm.timeInState;
  }

  transition(next: ActorState, force?: boolean): boolean {
    const mapped = ACTOR_TO_MONSTER_STATE[next];
    if (mapped === undefined) return false;
    return this.fsm.transition(mapped, force);
  }

  canTransition(next: ActorState): boolean {
    const mapped = ACTOR_TO_MONSTER_STATE[next];
    return mapped === undefined ? false : this.fsm.canTransition(mapped);
  }

  onEnter(state: ActorState, cb: () => void): () => void {
    const mapped = ACTOR_TO_MONSTER_STATE[state];
    return mapped === undefined ? NOOP : this.fsm.onEnter(mapped, cb);
  }

  onExit(state: ActorState, cb: () => void): () => void {
    const mapped = ACTOR_TO_MONSTER_STATE[state];
    return mapped === undefined ? NOOP : this.fsm.onExit(mapped, cb);
  }

  /** Driven by the brain's own tick; ticking it again would double the clock. */
  update(_dt: number): void {}
}

/* -------------------------------------------------------------------------- */
/* Monster                                                                    */
/* -------------------------------------------------------------------------- */

export interface IMonsterOptions extends Omit<IMonsterBrainOptions, 'archetype'> {
  readonly archetype: IMonsterArchetype;
  /** Parent for the scene root. The spawner normally supplies the chunk node. */
  readonly parent?: THREE.Object3D;
}

/**
 * A live monster: an `IMonsterSpec`, a brain, a scene node and (optionally) a
 * body.
 *
 * Implements `IMonster` from `@/types` so the spawner, the HUD, the animation
 * system and combat's target adapter all see it through the shared contract
 * rather than through this module.
 */
export class Monster implements IMonster {
  readonly type = 'monster' as const;
  readonly faction: Faction = 'monster';
  readonly brain: MonsterBrain;
  readonly root: THREE.Object3D;
  readonly transform: MonsterTransform;
  readonly stateMachine: IStateMachine<ActorState>;

  active = true;
  chunkKey: string | undefined;
  /** Seconds since this monster was placed. The director reads it for culling. */
  age = 0;
  /** True for boss minions and scripted actors the spawn director must ignore. */
  scripted = false;

  private characterInstance: ICharacterInstance | undefined;
  private lastClip: ClipName | undefined;
  private disposed = false;

  constructor(options: IMonsterOptions) {
    this.root = new THREE.Object3D();
    this.root.name = `monster:${options.id}`;
    this.transform = new MonsterTransform(this.root);
    this.brain = new MonsterBrain(options);
    this.stateMachine = new ActorStateView(this.brain.fsm);

    this.transform.position.set(options.position.x, options.position.y, options.position.z);
    this.transform.yaw = options.yaw ?? 0;
    options.parent?.add(this.root);
  }

  /* ---------------------------------------------------------------------- */
  /* IEntity / IActor                                                       */
  /* ---------------------------------------------------------------------- */

  get id(): EntityId {
    return this.brain.id;
  }

  get radius(): number {
    return this.archetype.radiusMetres;
  }

  get archetype(): IMonsterArchetype {
    return this.brain.archetype;
  }

  get spec(): IMonsterSpec {
    return this.brain.archetype;
  }

  get health(): number {
    return this.brain.health;
  }

  set health(value: number) {
    this.brain.health = value;
  }

  get maxHealth(): number {
    return this.archetype.maxHealth;
  }

  set maxHealth(_value: number) {
    // Max health is archetype data. A caller wanting a tougher monster wants a
    // different row in the table, not a mutated instance.
  }

  get animations(): IAnimationSet {
    return this.archetype.animations;
  }

  get character(): ICharacterInstance | undefined {
    return this.characterInstance;
  }

  get isDead(): boolean {
    return this.brain.isDead;
  }

  get moveSpeed(): number {
    return this.archetype.movement.runSpeed;
  }

  set moveSpeed(_value: number) {
    // Same reasoning as `maxHealth`: speed is a property of the archetype.
  }

  get displayName(): string {
    return this.archetype.name;
  }

  /** Current aggro target id. `IMonster.target` wants an `IActor`; the brain
   *  holds ids only, so the host resolves it. Undefined unless one was set. */
  target: IActor | undefined;

  get attackCooldownRemaining(): number {
    const snapshot = this.brain.snapshot();
    return snapshot.attackPhase === undefined ? 0 : this.archetype.attackCooldown;
  }

  set attackCooldownRemaining(_value: number) {
    // Cooldowns are per-attack and owned by the brain; a single writable
    // scalar cannot express the set, so the contract's setter is inert.
  }

  /** Boss phase index; 0 for non-bosses, per the contract. */
  get phase(): number {
    return this.bossPhaseIndex;
  }

  /** Written by the boss encounter, which is the only thing that may. */
  bossPhaseIndex = 0;

  /* ---------------------------------------------------------------------- */
  /* Body                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Attach a body built by the roster + character factory.
   *
   * The instance is parented, not owned: `dispose()` detaches it and leaves it
   * for the factory to release back into its pool, because the geometry and
   * skeleton are shared across every instance of that asset key.
   */
  attach(instance: ICharacterInstance): void {
    if (this.characterInstance === instance) return;
    this.detach();
    this.characterInstance = instance;
    this.root.add(instance.root);
    const scale = this.archetype.scale;
    instance.root.scale.setScalar(scale);
    this.lastClip = undefined;
  }

  /** Detach the body without disposing it. */
  detach(): ICharacterInstance | undefined {
    const instance = this.characterInstance;
    if (instance === undefined) return undefined;
    this.root.remove(instance.root);
    this.characterInstance = undefined;
    return instance;
  }

  playAnimation(clip: ClipName, fadeSeconds = 0.15): void {
    const animator = this.characterInstance?.animator;
    if (animator === undefined) return;
    if (!animator.has(clip)) return;
    animator.play(clip, { fade: fadeSeconds });
    this.lastClip = clip;
  }

  /* ---------------------------------------------------------------------- */
  /* Tick                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * `IUpdatable.update` takes only `dt`, but a brain needs the world. The
   * monster system calls `tick(dt, world)`; this overload exists so a
   * `Monster` can sit in a generic `IUpdatable` list and still advance its
   * animation, which is the part a world-less caller can meaningfully do.
   */
  update(dt: number): void {
    this.syncFromBrain(dt);
  }

  /** The real tick. Called by `MonsterSystem`, which owns the world view. */
  tick(dt: number, world: IMonsterWorld): void {
    if (!this.active || this.disposed) return;
    this.age += dt;
    this.brain.update(dt, world);
    this.syncFromBrain(dt);
  }

  private syncFromBrain(_dt: number): void {
    const brain = this.brain;
    this.transform.position.set(brain.position.x, brain.position.y, brain.position.z);
    this.transform.yaw = brain.yaw;

    const clip = brain.clip;
    if (clip !== this.lastClip) {
      // Death gets a slower crossfade: a monster snapping into a death pose in
      // 150 ms reads as a bug, and physics blends the ragdoll over 120 ms from
      // whatever pose is showing when the impulse lands.
      this.playAnimation(clip, clip === 'death' ? 0.22 : 0.12);
      this.lastClip = clip;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Damage                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * `IActor.takeDamage`.
   *
   * NOT the path Saitama's punches take. The combat resolver is authoritative
   * on damage and reports through `EntityDamaged`/`EntityKilled`, which the
   * monster system forwards into the brain. This entry point exists for the
   * other things that can hurt a monster — an ally's attack, a collapsing
   * building — and it routes to the same reaction so both look identical.
   */
  takeDamage(amount: number, _source?: IActor, _impulse?: THREE.Vector3): number {
    if (this.isDead || amount <= 0) return 0;
    const dealt = Math.min(this.brain.health, amount);
    this.brain.onDamaged(this.brain.health - dealt, dealt);
    if (this.brain.health <= 0) this.brain.onKilled();
    return dealt;
  }

  heal(amount: number): void {
    if (this.isDead || amount <= 0) return;
    this.brain.health = Math.min(this.maxHealth, this.brain.health + amount);
  }

  kill(): void {
    this.brain.onKilled();
  }

  /* ---------------------------------------------------------------------- */
  /* Diagnostics and lifecycle                                              */
  /* ---------------------------------------------------------------------- */

  snapshot(): IMonsterSnapshot {
    return this.brain.snapshot();
  }

  /** Recycle for the pool. The body is detached and handed back to the caller. */
  recycle(position: THREE.Vector3 | { x: number; y: number; z: number }, yaw: number): void {
    this.brain.reset(position, yaw);
    this.transform.position.set(position.x, position.y, position.z);
    this.transform.yaw = yaw;
    this.age = 0;
    this.active = true;
    this.target = undefined;
    this.bossPhaseIndex = 0;
    this.lastClip = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    this.detach();
    this.root.removeFromParent();
  }
}

/** Convenience factory, mostly so callers do not repeat the option bag. */
export function createMonster(
  id: EntityId,
  archetype: IMonsterArchetype,
  bus: IEventBus,
  rng: IRandom,
  position: { x: number; y: number; z: number },
  yaw = 0
): Monster {
  return new Monster({ id, archetype, bus, rng, position, yaw });
}
