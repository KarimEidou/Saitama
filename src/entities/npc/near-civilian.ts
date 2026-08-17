/**
 * THE NEAR TIER — sixteen people who are actually people
 *
 * Inside forty metres a civilian stops being a texture of motion and becomes
 * something the player can pick out, aim around, fail to protect, or pull out
 * of the way. That transition is the whole reason the tier exists, and it buys
 * exactly three things:
 *
 *   A REAL SKELETON  a `SkinnedMesh` driven by the procedural animator, so
 *                    their feet stop sliding, they turn their heads, and they
 *                    react to being hit;
 *   A REAL BRAIN     a behaviour tree per individual, which can override the
 *                    shared flow field — for being staggered, for being dead,
 *                    and for following the player who just shouted at them;
 *   A REAL NAME      a stable `EntityId` on the bus, so `CivilianSaved` and
 *                    `CivilianLost` refer to a person rather than a statistic.
 *
 * ── WHAT IT DOES NOT BUY: SEPARATE LOCOMOTION ─────────────────────────────
 * Position, velocity and mood stay in the shared `CrowdAgents` arrays and are
 * integrated by the same steering pass as everybody else. A near civilian is
 * an agent with a BODY and a VETO, not a second movement implementation. Two
 * movement paths would drift apart at the tier boundary, and the symptom —
 * a civilian visibly jumping half a metre at exactly 40 m — is the classic
 * LOD-crossing artefact.
 *
 * ── AND WHY GAWK IS EVALUATED BY HAND ─────────────────────────────────────
 * `ProceduralAnimator` resolves clips out of the shared library, which has no
 * gawk in it (see `crowd-clips.ts` for why it cannot). So the near tier
 * evaluates the SAME clip function the VAT bake was made from, straight into
 * the bone pose. One evaluator, two consumers — which is exactly the rule the
 * animation workstream set for itself, applied to a clip it does not own.
 */

import * as THREE from 'three';
import type {
  ActorState,
  ClipName,
  EntityId,
  Faction,
  ICharacterInstance,
  IEngineContext,
  INPCBehaviour,
  IActor,
  IAnimationSet,
  IStateMachine,
  NPCBehaviourKind,
} from '@/types';
import { clamp01 } from '@/util';
import {
  ProceduralAnimator,
  applyPose,
  copyPose,
  createPose,
  type Pose,
} from '@/characters/anim';
import type { CharacterParts } from '@/characters/mesh';
import { ActorStateMachine, ActorTransform, PROCEDURAL_ANIMATIONS } from './actor-support';
import { COWER_CLIP, GAWK_CLIP, evaluateCrowdClip } from './crowd-clips';
import {
  CrowdAgents,
  MOOD_COWER,
  MOOD_DOWN,
  MOOD_FLEE,
  MOOD_GAWK,
} from './crowd-agents';
import { RESCUE_RADIUS } from './constants';
import {
  BehaviourTree,
  action,
  guard,
  selector,
  type BtNode,
  type BtStatus,
} from './behaviour-tree';

/** Seconds a civilian is off their feet after a solid hit. */
const STAGGER_SECONDS = 0.85;

/** Seconds a civilian keeps following the player after being shepherded. */
const SHEPHERD_SECONDS = 2.5;

/** What the near tier needs from the system that owns it. */
export interface ICivilianHost {
  readonly agents: CrowdAgents;
  /** Seconds since the crowd system started. */
  readonly time: number;
  /** Player position, when one is registered. */
  readonly player: { x: number; z: number } | undefined;
  /** Route damage and death through the system so one code path resolves both. */
  damageAgent(index: number, amount: number, causedByPlayer: boolean, attacker?: EntityId): number;
}

/** Context the behaviour tree sees. */
interface CivilianContext {
  readonly self: NearCivilian;
  readonly agents: CrowdAgents;
  readonly index: number;
  readonly host: ICivilianHost;
}

export class NearCivilian implements IActor, INPCBehaviour {
  readonly type = 'npc' as const;
  readonly faction: Faction = 'civilian';
  readonly animations: IAnimationSet = PROCEDURAL_ANIMATIONS;
  readonly kind: NPCBehaviourKind = 'pedestrian';
  readonly root: THREE.Object3D;
  readonly transform: ActorTransform;
  readonly stateMachine: IStateMachine<ActorState>;
  readonly character: ICharacterInstance;

  /** Metres at which this civilian notices a threat without the alarm field. */
  awarenessRadius = 32;
  /** Steering goal, when the tree has one. */
  target?: THREE.Vector3;

  active = true;
  moveSpeed = 1.35;
  chunkKey?: string;

  private readonly parts: CharacterParts;
  private readonly animator: ProceduralAnimator;
  private readonly tree: BehaviourTree<CivilianContext>;
  private readonly context: CivilianContext;
  private readonly clipPose: Pose;
  private readonly host: ICivilianHost;
  /** Live index into the shared agent arrays. -1 once detached. */
  private agentIndex: number;
  private staggerTimer = 0;
  private shepherdTimer = 0;
  private deathPlayed = false;
  private clipTime = 0;
  private lastClip: ClipName | undefined;
  private disposed = false;

  constructor(
    id: EntityId,
    parts: CharacterParts,
    animator: ProceduralAnimator,
    host: ICivilianHost,
    index: number
  ) {
    this.id = id;
    this.parts = parts;
    this.animator = animator;
    this.host = host;
    this.agentIndex = index;
    this.root = parts.root;
    this.transform = new ActorTransform(parts.root);
    this.stateMachine = new ActorStateMachine('idle');
    this.character = { ...parts, animator } as ICharacterInstance;
    this.clipPose = createPose(animator.rig.boneCount);
    this.radius = host.agents.radius[index] ?? 0.26;
    this.maxHealth = host.agents.maxHealth[index] ?? 12;
    this.health = host.agents.health[index] ?? this.maxHealth;
    this.displayName = 'Civilian';

    this.context = { self: this, agents: host.agents, index, host };
    this.tree = new BehaviourTree(buildCivilianTree());
  }

  readonly id: EntityId;
  readonly radius: number;
  readonly displayName: string;
  health: number;
  maxHealth: number;

  get isDead(): boolean {
    return this.health <= 0;
  }

  /** Agent slot this body is attached to, or -1. */
  get index(): number {
    return this.agentIndex;
  }

  /** True while the tree has taken movement away from the flow field. */
  get overriding(): boolean {
    return this.staggerTimer > 0 || this.shepherdTimer > 0 || this.isDead;
  }

  /** Seconds of stagger remaining. */
  get stagger(): number {
    return this.staggerTimer;
  }

  /* ------------------------------------------------------------------ */
  /* INPCBehaviour                                                      */
  /* ------------------------------------------------------------------ */

  get actor(): IActor {
    return this;
  }

  onAttach(_context: IEngineContext): void {
    /* Nothing to bind: the crowd system owns the update order. */
  }

  /**
   * A threat this civilian could not have inferred from the alarm field —
   * something behind them, or a hit that has not yet reached the field.
   */
  onThreat(source: THREE.Vector3, intensity: number): void {
    if (this.isDead) return;
    const agents = this.host.agents;
    const i = this.agentIndex;
    if (i < 0) return;
    agents.peakAlarm[i] = Math.max(agents.peakAlarm[i]!, clamp01(intensity));
    if (intensity > 0.5) {
      // Look at it first. A civilian who runs without ever turning towards the
      // thing they are running from reads as scripted.
      const dx = source.x - agents.posX[i]!;
      const dz = source.z - agents.posZ[i]!;
      if (dx * dx + dz * dz > 1e-4) agents.setMood(i, MOOD_GAWK);
    }
  }

  reset(): void {
    this.staggerTimer = 0;
    this.shepherdTimer = 0;
    this.deathPlayed = false;
    this.clipTime = 0;
    this.lastClip = undefined;
    this.tree.reset(this.context);
    this.stateMachine.transition('idle', true);
  }

  /* ------------------------------------------------------------------ */
  /* IActor                                                             */
  /* ------------------------------------------------------------------ */

  takeDamage(amount: number, source?: IActor, _impulse?: THREE.Vector3): number {
    if (this.agentIndex < 0) return 0;
    const causedByPlayer = source?.faction === 'hero' && source.type === 'player';
    const dealt = this.host.damageAgent(this.agentIndex, amount, causedByPlayer, source?.id);
    this.health = this.host.agents.health[this.agentIndex]!;
    if (dealt > 0 && !this.isDead) this.staggerTimer = STAGGER_SECONDS;
    return dealt;
  }

  heal(amount: number): void {
    if (this.agentIndex < 0 || this.isDead) return;
    this.health = Math.min(this.maxHealth, this.health + Math.max(0, amount));
    this.host.agents.health[this.agentIndex] = this.health;
  }

  kill(): void {
    if (this.isDead) return;
    this.takeDamage(this.maxHealth * 2);
  }

  playAnimation(clip: ClipName, fadeSeconds = 0.18): void {
    this.animator.play(clip, { fade: fadeSeconds });
    this.lastClip = clip;
  }

  /** The player has grabbed this civilian and is moving them out of the way. */
  shepherd(): void {
    if (this.isDead) return;
    this.shepherdTimer = SHEPHERD_SECONDS;
  }

  /* ------------------------------------------------------------------ */
  /* Frame                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Think, then present.
   *
   * The tree runs BEFORE the shared steering pass so its veto lands on this
   * frame's movement rather than last frame's. Presentation — bones, root
   * transform, clip selection — runs after, in `present`, once the steering
   * pass has settled the position.
   */
  think(dt: number): void {
    if (this.disposed || this.agentIndex < 0) return;
    this.staggerTimer = Math.max(0, this.staggerTimer - dt);
    this.shepherdTimer = Math.max(0, this.shepherdTimer - dt);
    this.health = this.host.agents.health[this.agentIndex]!;
    this.stateMachine.update(dt);
    this.tree.tick(this.context, dt);
  }

  /** Copy the simulated agent onto the scene node and drive the animator. */
  present(dt: number): void {
    if (this.disposed || this.agentIndex < 0) return;
    const agents = this.host.agents;
    const i = this.agentIndex;
    this.transform.set(agents.posX[i]!, 0, agents.posZ[i]!, agents.yaw[i]!);

    const vx = agents.velX[i]!;
    const vz = agents.velZ[i]!;
    const speed = Math.sqrt(vx * vx + vz * vz);
    const mood = agents.mood[i]!;

    this.animator.setLocomotion({ speed, grounded: true });
    this.animator.setRoot(this.transform.position, agents.yaw[i]!);
    this.selectClip(mood, speed);
    this.animator.update(dt);

    // Gawk and cower are evaluated straight into the bones AFTER the animator
    // has written its own pose, because the library cannot resolve them. The
    // animator still runs: it owns the mixer, the event markers and the
    // locomotion solver's world-space foot locks, none of which stop being
    // needed just because this frame's pose came from somewhere else.
    if (mood === MOOD_GAWK || (mood === MOOD_COWER && !this.isDead)) {
      this.clipTime += dt;
      const entry = mood === MOOD_GAWK ? GAWK_CLIP : COWER_CLIP;
      copyPose(this.clipPose, this.animator.rig.rest);
      evaluateCrowdClip(
        entry,
        this.animator.rig,
        this.animator.params,
        this.clipTime / entry.def.duration,
        this.clipPose
      );
      applyPose(this.clipPose, this.animator.rig);
    } else {
      this.clipTime = 0;
    }
  }

  /** Choose the base clip for a mood, without restarting a looping one. */
  private selectClip(mood: number, speed: number): void {
    let want: ClipName;
    if (this.isDead) want = 'death';
    else if (this.staggerTimer > 0) want = 'stagger';
    else if (mood === MOOD_FLEE) want = 'flee';
    else if (mood === MOOD_COWER || mood === MOOD_GAWK) want = 'idle';
    else want = speed > 0.35 ? 'walk' : 'idle';

    if (want === this.lastClip) return;
    this.lastClip = want;
    if (want === 'death') {
      if (this.deathPlayed) return;
      this.deathPlayed = true;
      this.animator.play('death', { fade: 0.1, loop: 'once', clampWhenFinished: true });
      this.stateMachine.transition('death', true);
      return;
    }
    this.animator.play(want, { fade: 0.18 });
    this.stateMachine.transition(want as ActorState);
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  /** Rebind this body to a different agent slot when recycled from the pool. */
  rebind(id: EntityId, index: number): void {
    (this as { id: EntityId }).id = id;
    this.agentIndex = index;
    (this.context as { index: number }).index = index;
    this.health = this.host.agents.health[index]!;
    this.maxHealth = this.host.agents.maxHealth[index]!;
    this.reset();
  }

  /** Detach from the agent arrays without destroying the body. */
  detach(): void {
    this.agentIndex = -1;
    this.root.visible = false;
  }

  update(dt: number): void {
    this.think(dt);
    this.present(dt);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.animator.dispose();
    this.parts.dispose();
    this.root.removeFromParent();
  }
}

/* -------------------------------------------------------------------------- */
/* The tree                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A civilian's individual behaviour, in priority order.
 *
 * Everything here is a VETO over the shared flow field. The default branch
 * does nothing at all, and that is correct: the field already knows where a
 * frightened person wants to go, and re-deciding it per agent would be the
 * expensive mistake this architecture exists to avoid.
 */
function buildCivilianTree(): BtNode<CivilianContext> {
  return selector<CivilianContext>('civilian', [
    // 1. Dead. Nothing else applies, and it is worth being structural about
    //    it: a corpse that still samples the alarm field will stand up.
    guard<CivilianContext>(
      'down',
      (c) => c.agents.health[c.index]! <= 0,
      action('lie-still', (c) => {
        c.agents.setMood(c.index, MOOD_DOWN);
        c.agents.velX[c.index] = 0;
        c.agents.velZ[c.index] = 0;
        return 'running' as BtStatus;
      })
    ),

    // 2. Knocked off their feet. Shed velocity fast; the shared steering pass
    //    will accelerate them again once the timer expires.
    guard<CivilianContext>(
      'staggered',
      (c) => c.self.stagger > 0,
      action('reel', (c, dt) => {
        const damp = Math.max(0, 1 - dt * 6);
        c.agents.velX[c.index] = c.agents.velX[c.index]! * damp;
        c.agents.velZ[c.index] = c.agents.velZ[c.index]! * damp;
        return 'running' as BtStatus;
      })
    ),

    // 3. The player is right here and this civilian is in danger. Follow them.
    //    This is the branch that makes a rescue an ACTION rather than a
    //    coincidence of geometry — the player can physically shepherd people
    //    out of a blast radius, and the ledger credits it to them.
    guard<CivilianContext>(
      'shepherded',
      (c) => {
        const player = c.host.player;
        if (player === undefined) return false;
        const dx = player.x - c.agents.posX[c.index]!;
        const dz = player.z - c.agents.posZ[c.index]!;
        return dx * dx + dz * dz < RESCUE_RADIUS * RESCUE_RADIUS && c.agents.alarm[c.index]! > 0.2;
      },
      action('follow-player', (c) => {
        const player = c.host.player;
        if (player === undefined) return 'failure' as BtStatus;
        const dx = player.x - c.agents.posX[c.index]!;
        const dz = player.z - c.agents.posZ[c.index]!;
        const d = Math.sqrt(dx * dx + dz * dz);
        // Stand behind them, not on them.
        if (d < 1.6) return 'running' as BtStatus;
        const speed = 3.2;
        c.agents.velX[c.index] = (dx / d) * speed;
        c.agents.velZ[c.index] = (dz / d) * speed;
        return 'running' as BtStatus;
      })
    ),

    // 4. Do what the field says. Deliberately empty.
    action('follow-field', () => 'success' as BtStatus),
  ]);
}
