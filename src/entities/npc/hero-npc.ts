/**
 * HERO ALLIES — the three people who can lose
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY THESE THREE HAVE REAL HIT POINTS
 *
 *  The protagonist's health bar is decorative. Nothing in the game can move
 *  it, and a number that never changes is not a stake. So the danger is
 *  displaced onto people who CAN be hurt, and the allies are the sharpest
 *  version of that: named, competent, on your side, and losing.
 *
 *  Genos in particular exists to die in front of you. He engages a monster he
 *  cannot beat, his health actually falls, he calls out for Saitama, and if
 *  the player is elsewhere he is destroyed and `AllyDowned` fires. The
 *  player's invulnerability is what makes that land — you were never in
 *  danger, you were just too slow.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── THREE POLICIES, ONE CONTRACT ──────────────────────────────────────────
 * All three are the same `IActor` a monster is, differing only in faction and
 * ability set, and each carries a behaviour tree whose SHAPE is the
 * characterisation:
 *
 *   GENOS       kite, burn, call for help, keep burning.
 *   MUMEN RIDER charge, get knocked down, get up, charge. There is no retreat
 *               branch in his tree. Not disabled, not weighted to zero — the
 *               node does not exist, because the character does not have the
 *               behaviour. He is the thesis statement of the setting: losing
 *               on purpose, in public, because someone has to.
 *   TATSUMAKI   hold everything at arm's length, throw the scenery, be
 *               visibly annoyed that you turned up.
 *
 * ── THEY TALK TO COMBAT THROUGH THE BUS ───────────────────────────────────
 * An ally's attack emits `ShockwaveFired`. That is the sanctioned "an area
 * attack was released" event, and it is already what destruction, VFX, audio
 * and camera shake listen to. The alternative — calling into the combat
 * system — would make the crowd system depend on a workstream it must never
 * import.
 */

import * as THREE from 'three';
import type {
  ActorState,
  ClipName,
  EntityId,
  Faction,
  IActor,
  IAnimationSet,
  ICharacterInstance,
  IEventBus,
  IStateMachine,
  LethalIntent,
  PunchKind,
} from '@/types';
import { clamp01 } from '@/util';
import type { ProceduralAnimator } from '@/characters/anim';
import type { CharacterParts } from '@/characters/mesh';
import { ActorStateMachine, ActorTransform, PROCEDURAL_ANIMATIONS, angleTo, yawFromDirection } from './actor-support';
import {
  GENOS_CALLOUT_HEALTH,
  GENOS_HEALTH,
  MUMEN_DOWN_SECONDS,
  MUMEN_HEALTH,
  TATSUMAKI_HEALTH,
} from './constants';
import {
  BehaviourTree,
  action,
  cooldown,
  guard,
  selector,
  sequence,
  type BtNode,
} from './behaviour-tree';
import type { IHeroCallout, IHeroStatus, IThreatSource, HeroNpcId } from './types';

/* -------------------------------------------------------------------------- */
/* Specs                                                                      */
/* -------------------------------------------------------------------------- */

/** One ally's numbers. */
export interface IHeroSpec {
  readonly heroId: HeroNpcId;
  readonly displayName: string;
  readonly maxHealth: number;
  readonly moveSpeed: number;
  /** Metres this ally tries to keep between itself and its target. */
  readonly preferredRange: number;
  /** Metres at which its attack can reach. */
  readonly attackRange: number;
  /** Seconds between attacks. */
  readonly attackCooldown: number;
  /** Cone half-angle of the attack, radians. */
  readonly attackAngle: number;
  /** Shockwave power. Unbounded by contract; these are ordinary-hero numbers. */
  readonly attackPower: number;
  readonly punchKind: PunchKind;
  readonly intent: LethalIntent;
  /** A single hit above this fraction of max health knocks them down. */
  readonly knockdownFraction: number;
}

export const HERO_SPECS: Readonly<Record<HeroNpcId, IHeroSpec>> = {
  genos: {
    heroId: 'genos',
    displayName: 'Genos',
    maxHealth: GENOS_HEALTH,
    moveSpeed: 7.4,
    // Kites. An incineration cannon that walks into melee is a demolished
    // incineration cannon, and he knows it.
    preferredRange: 16,
    attackRange: 24,
    attackCooldown: 2.1,
    attackAngle: 0.3,
    attackPower: 2600,
    punchKind: 'heavy',
    intent: 'serious',
    knockdownFraction: 0.22,
  },
  mumenRider: {
    heroId: 'mumenRider',
    displayName: 'Mumen Rider',
    maxHealth: MUMEN_HEALTH,
    // On a bicycle. Faster than a civilian, slower than anything that matters.
    moveSpeed: 6.2,
    preferredRange: 1.9,
    attackRange: 2.6,
    attackCooldown: 1.05,
    attackAngle: 0.7,
    attackPower: 120,
    punchKind: 'normal',
    intent: 'normal',
    // Knocked down by almost anything. That is the point — the counter that
    // matters for him is not damage dealt, it is times stood back up.
    knockdownFraction: 0.08,
  },
  tatsumaki: {
    heroId: 'tatsumaki',
    displayName: 'Tatsumaki',
    maxHealth: TATSUMAKI_HEALTH,
    moveSpeed: 9.5,
    // Never within reach of anything. She does not dodge; she is simply never
    // where the fight is.
    preferredRange: 34,
    attackRange: 62,
    attackCooldown: 3.4,
    attackAngle: 0.55,
    attackPower: 9000,
    punchKind: 'environmental',
    intent: 'serious',
    knockdownFraction: 0.5,
  },
};

/* -------------------------------------------------------------------------- */
/* World seam                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Everything an ally needs from the world, injected rather than imported.
 *
 * `now()` and `playerPosition()` are calls rather than properties for the same
 * reason as `ICivilianHost`: an ally lives for the whole encounter and must
 * never read a value snapshotted when it was constructed.
 */
export interface IHeroWorld {
  readonly bus: IEventBus | undefined;
  now(): number;
  readonly threats: readonly IThreatSource[];
  playerPosition(): { x: number; z: number } | undefined;
  /** Debris the telekinetic can pick up, newest last. */
  readonly debris: readonly { x: number; y: number; z: number; mass: number }[];
  /** True when nothing blocks the line. */
  hasLineOfSight(ax: number, az: number, bx: number, bz: number): boolean;
  /** Scare the civilians. An ally's attack is not a quiet event. */
  seedAlarm(x: number, z: number, intensity: number, radius: number): void;
  /** Publish a line of dialogue. */
  say(callout: IHeroCallout): void;
}

/** Context the ally trees see. */
interface HeroContext {
  readonly self: HeroNpc;
  readonly world: IHeroWorld;
}

/* -------------------------------------------------------------------------- */
/* The ally                                                                   */
/* -------------------------------------------------------------------------- */

export class HeroNpc implements IActor {
  readonly type = 'hero' as const;
  readonly faction: Faction = 'hero';
  readonly animations: IAnimationSet = PROCEDURAL_ANIMATIONS;
  readonly spec: IHeroSpec;
  readonly heroId: HeroNpcId;
  readonly root: THREE.Object3D;
  readonly transform: ActorTransform;
  readonly stateMachine: IStateMachine<ActorState>;
  readonly character?: ICharacterInstance;
  readonly radius = 0.42;

  active = true;
  health: number;
  maxHealth: number;
  moveSpeed: number;
  chunkKey?: string;

  /** Metres per second, world space. Integrated by `update`. */
  readonly velocity = new THREE.Vector3();

  private readonly world: IHeroWorld;
  private readonly tree: BehaviourTree<HeroContext>;
  private readonly context: HeroContext;
  private readonly animator: ProceduralAnimator | undefined;
  private readonly parts: CharacterParts | undefined;
  private readonly entityId: EntityId;

  private cooldownRemaining = 0;
  private downTimer = 0;
  private reEngageCount = 0;
  private downedEmitted = false;
  private lastAttacker: EntityId | undefined;
  private disposed = false;
  private clipRequest: ClipName = 'idle';

  constructor(
    id: EntityId,
    heroId: HeroNpcId,
    world: IHeroWorld,
    body?: { parts: CharacterParts; animator: ProceduralAnimator }
  ) {
    this.entityId = id;
    this.heroId = heroId;
    this.spec = HERO_SPECS[heroId];
    this.world = world;
    this.health = this.spec.maxHealth;
    this.maxHealth = this.spec.maxHealth;
    this.moveSpeed = this.spec.moveSpeed;

    this.parts = body?.parts;
    this.animator = body?.animator;
    this.root = body?.parts.root ?? new THREE.Group();
    this.root.name = `hero-${heroId}`;
    this.transform = new ActorTransform(this.root);
    this.stateMachine = new ActorStateMachine('idle');
    if (body !== undefined) this.character = { ...body.parts, animator: body.animator };

    this.context = { self: this, world };
    this.tree = new BehaviourTree(buildHeroTree(heroId));
  }

  get id(): EntityId {
    return this.entityId;
  }

  get displayName(): string {
    return this.spec.displayName;
  }

  get isDead(): boolean {
    return this.health <= 0;
  }

  /** True while knocked off their feet. */
  get isDown(): boolean {
    return this.downTimer > 0;
  }

  /**
   * Times this ally has been knocked down and got back up.
   *
   * The number that makes Mumen Rider legible as a character rather than as a
   * weak NPC, and the one the harness asserts on.
   */
  get reEngagements(): number {
    return this.reEngageCount;
  }

  /** Seconds until the next attack is permitted. */
  get attackCooldownRemaining(): number {
    return this.cooldownRemaining;
  }

  status(): IHeroStatus {
    return {
      id: this.entityId,
      heroId: this.heroId,
      displayName: this.spec.displayName,
      health: this.health,
      maxHealth: this.maxHealth,
      faction: this.faction,
      state: this.isDead ? 'down' : this.isDown ? 'knocked-down' : this.stateMachine.current,
      isDead: this.isDead,
      reEngagements: this.reEngageCount,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Damage                                                             */
  /* ------------------------------------------------------------------ */

  takeDamage(amount: number, source?: IActor, _impulse?: THREE.Vector3): number {
    if (this.isDead || amount <= 0) return 0;
    const dealt = Math.min(this.health, amount);
    this.health -= dealt;
    this.lastAttacker = source?.id;

    this.world.bus?.emit('EntityDamaged', {
      entityId: this.entityId,
      entityType: 'hero',
      faction: this.faction,
      amount: dealt,
      damageType: 'blunt',
      intent: 'normal',
      healthRemaining: this.health,
      maxHealth: this.maxHealth,
      point: this.transform.position,
      attackerId: source?.id,
      critical: false,
    });

    if (this.health <= 0) {
      this.die();
      return dealt;
    }
    if (dealt >= this.maxHealth * this.spec.knockdownFraction) this.knockdown();
    return dealt;
  }

  heal(amount: number): void {
    if (this.isDead) return;
    this.health = Math.min(this.maxHealth, this.health + Math.max(0, amount));
  }

  kill(): void {
    if (this.isDead) return;
    this.health = 0;
    this.die();
  }

  /**
   * Put this ally on the ground for a moment.
   *
   * Public because combat and the harness both need to cause it, and because
   * making it explicit is what lets the Mumen Rider assertion be written
   * without reaching inside him.
   */
  knockdown(seconds = MUMEN_DOWN_SECONDS): void {
    if (this.isDead) return;
    this.downTimer = Math.max(this.downTimer, seconds);
    this.stateMachine.transition('stagger', true);
    this.clipRequest = 'stagger';
  }

  private die(): void {
    this.health = 0;
    this.downTimer = 0;
    this.stateMachine.transition('death', true);
    this.clipRequest = 'death';
    if (this.downedEmitted) return;
    this.downedEmitted = true;
    this.world.bus?.emit('AllyDowned', {
      entityId: this.entityId,
      displayName: this.spec.displayName,
      position: this.transform.position,
      killerId: this.lastAttacker,
    });
    this.world.bus?.emit('EntityKilled', {
      entityId: this.entityId,
      entityType: 'hero',
      faction: this.faction,
      position: this.transform.position,
      killerId: this.lastAttacker,
      intent: 'normal',
      rewardPoints: 0,
    });
    this.say(DEATH_LINES[this.heroId]!, DEATH_KEYS[this.heroId]!);
  }

  /* ------------------------------------------------------------------ */
  /* Actions used by the trees                                          */
  /* ------------------------------------------------------------------ */

  /** Nearest live threat, or undefined. */
  nearestThreat(): IThreatSource | undefined {
    let best: IThreatSource | undefined;
    let bestSq = Infinity;
    for (const threat of this.world.threats) {
      const dx = threat.position.x - this.transform.position.x;
      const dz = threat.position.z - this.transform.position.z;
      const d = dx * dx + dz * dz;
      if (d < bestSq) {
        bestSq = d;
        best = threat;
      }
    }
    return best;
  }

  /** Metres to a threat, on the ground plane. */
  distanceTo(threat: IThreatSource): number {
    const dx = threat.position.x - this.transform.position.x;
    const dz = threat.position.z - this.transform.position.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  /** Command a ground velocity towards or away from a point. */
  moveToward(x: number, z: number, speed: number, dt: number): void {
    const dx = x - this.transform.position.x;
    const dz = z - this.transform.position.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < 1e-4) return;
    this.velocity.set((dx / d) * speed, 0, (dz / d) * speed);
    this.faceDirection(dx, dz, dt);
  }

  /** Stop, without snapping — momentum reads as weight. */
  brake(dt: number): void {
    const damp = Math.max(0, 1 - dt * 8);
    this.velocity.multiplyScalar(damp);
  }

  /** Turn towards a direction at a bounded rate. */
  faceDirection(dx: number, dz: number, dt: number): void {
    if (dx * dx + dz * dz < 1e-6) return;
    const want = yawFromDirection(dx, dz);
    const delta = angleTo(this.transform.yaw, want);
    const maxTurn = 9 * dt;
    this.transform.yaw = this.transform.yaw + Math.max(-maxTurn, Math.min(maxTurn, delta));
  }

  /**
   * Release this ally's attack as a `ShockwaveFired`.
   *
   * The one place the crowd system talks TO combat, and it does it by
   * publishing rather than by calling. Whatever resolves the cone — damage,
   * knockback, structural integrity — is somebody else's module and stays
   * that way.
   */
  fireAttack(target: IThreatSource, powerScale = 1, kindOverride?: PunchKind): void {
    const origin = this.transform.position;
    const dx = target.position.x - origin.x;
    const dz = target.position.z - origin.z;
    const length = Math.max(1e-4, Math.sqrt(dx * dx + dz * dz));
    this.cooldownRemaining = this.spec.attackCooldown;
    this.clipRequest = this.heroId === 'tatsumaki' ? 'special' : 'attack';
    this.stateMachine.transition('attack', true);

    this.world.bus?.emit('ShockwaveFired', {
      origin,
      direction: { x: dx / length, y: 0, z: dz / length },
      power: this.spec.attackPower * powerScale,
      range: this.spec.attackRange,
      angle: this.spec.attackAngle,
      intent: powerScale > 2 ? 'full' : this.spec.intent,
      punchKind: kindOverride ?? this.spec.punchKind,
      sourceId: this.entityId,
    });
    // Allies are loud. A civilian two streets away does not know who fired,
    // only that something went off, and reacts accordingly.
    this.world.seedAlarm(origin.x, origin.z, clamp01(0.28 * powerScale), 30 * powerScale);
  }

  /** Publish a line, once. */
  say(line: string, key: string): void {
    this.world.say({
      heroId: this.heroId,
      displayName: this.spec.displayName,
      key,
      line,
      time: this.world.now(),
    });
  }

  /* ------------------------------------------------------------------ */
  /* Frame                                                              */
  /* ------------------------------------------------------------------ */

  update(dt: number): void {
    if (this.disposed) return;
    this.stateMachine.update(dt);
    this.cooldownRemaining = Math.max(0, this.cooldownRemaining - dt);

    if (this.isDead) {
      this.brake(dt);
      this.integrate(dt);
      this.present(dt);
      return;
    }

    if (this.downTimer > 0) {
      this.downTimer -= dt;
      this.brake(dt);
      if (this.downTimer <= 0) {
        this.downTimer = 0;
        // THE line of code that is Mumen Rider. There is no branch here that
        // checks whether getting up is a good idea.
        this.reEngageCount++;
        this.stateMachine.transition('idle', true);
        this.clipRequest = 'idle';
        if (this.heroId === 'mumenRider') {
          this.say(RISE_LINES[this.reEngageCount % RISE_LINES.length]!, 'mumen.rise');
        }
      }
      this.integrate(dt);
      this.present(dt);
      return;
    }

    this.tree.tick(this.context, dt);
    this.integrate(dt);
    this.present(dt);
  }

  private integrate(dt: number): void {
    const p = this.transform.position;
    this.transform.set(p.x + this.velocity.x * dt, p.y, p.z + this.velocity.z * dt, this.transform.yaw);
  }

  private present(dt: number): void {
    if (this.animator === undefined) return;
    const speed = Math.sqrt(
      this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z
    );
    this.animator.setLocomotion({ speed, grounded: true });
    this.animator.setRoot(this.transform.position, this.transform.yaw);
    if (this.clipRequest === 'death') {
      this.animator.play('death', { fade: 0.12, loop: 'once', clampWhenFinished: true });
    } else if (this.clipRequest === 'attack' || this.clipRequest === 'special') {
      this.animator.playAdditive(this.clipRequest, { fade: 0.08 });
      this.clipRequest = 'idle';
    } else if (this.clipRequest === 'stagger') {
      this.animator.play('stagger', { fade: 0.1 });
    } else if (speed > 0.4) {
      this.animator.play(speed > 4 ? 'run' : 'walk', { fade: 0.18 });
    } else {
      this.animator.play('idle', { fade: 0.2 });
    }
    this.animator.update(dt);
  }

  playAnimation(clip: ClipName, fadeSeconds = 0.18): void {
    this.animator?.play(clip, { fade: fadeSeconds });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.animator?.dispose();
    this.parts?.dispose();
    this.root.removeFromParent();
  }
}

/* -------------------------------------------------------------------------- */
/* Trees                                                                      */
/* -------------------------------------------------------------------------- */

function buildHeroTree(heroId: HeroNpcId): BtNode<HeroContext> {
  switch (heroId) {
    case 'genos':
      return genosTree();
    case 'mumenRider':
      return mumenTree();
    default:
      return tatsumakiTree();
  }
}

/** Shared: is there anything to fight? */
const hasTarget = (c: HeroContext): boolean => c.self.nearestThreat() !== undefined;

/**
 * GENOS — kite, burn, call for Saitama.
 *
 * The callout branch sits ABOVE the attack branch and below nothing, which is
 * deliberate: it fires while he is still fighting, not instead of fighting.
 * He is not asking to be rescued. He is reporting.
 */
function genosTree(): BtNode<HeroContext> {
  return selector<HeroContext>('genos', [
    guard<HeroContext>(
      'engaged',
      hasTarget,
      selector<HeroContext>('engaged-branches', [
        // Wounded: say so, on a long cooldown so it does not become chatter.
        cooldown<HeroContext>(
          'callout',
          9,
          guard<HeroContext>(
            'hurt',
            (c) => c.self.health < c.self.maxHealth * GENOS_CALLOUT_HEALTH,
            action<HeroContext>('call-sensei', (c) => {
              c.self.say(
                c.self.health < c.self.maxHealth * 0.2
                  ? 'Sensei — I cannot hold it. Where are you?'
                  : 'Sensei! It is stronger than the report said!',
                'genos.callout'
              );
              return 'success';
            })
          )
        ),
        // In range and loaded: fire.
        sequence<HeroContext>('incinerate', [
          action<HeroContext>('check-range', (c) => {
            const threat = c.self.nearestThreat();
            if (threat === undefined) return 'failure';
            if (c.self.attackCooldownRemaining > 0) return 'failure';
            return c.self.distanceTo(threat) <= c.self.spec.attackRange ? 'success' : 'failure';
          }),
          action<HeroContext>('check-sight', (c) => {
            const threat = c.self.nearestThreat();
            if (threat === undefined) return 'failure';
            const p = c.self.transform.position;
            return c.world.hasLineOfSight(p.x, p.z, threat.position.x, threat.position.z)
              ? 'success'
              : 'failure';
          }),
          action<HeroContext>('fire', (c, dt) => {
            const threat = c.self.nearestThreat();
            if (threat === undefined) return 'failure';
            c.self.brake(dt);
            c.self.faceDirection(
              threat.position.x - c.self.transform.position.x,
              threat.position.z - c.self.transform.position.z,
              dt
            );
            c.self.fireAttack(threat);
            return 'success';
          }),
        ]),
        // Otherwise hold the preferred range: close when far, back off when near.
        action<HeroContext>('kite', (c, dt) => {
          const threat = c.self.nearestThreat();
          if (threat === undefined) return 'failure';
          const distance = c.self.distanceTo(threat);
          const want = c.self.spec.preferredRange;
          const p = c.self.transform.position;
          if (distance > want + 3) {
            c.self.moveToward(threat.position.x, threat.position.z, c.self.moveSpeed, dt);
          } else if (distance < want - 3) {
            c.self.moveToward(
              p.x * 2 - threat.position.x,
              p.z * 2 - threat.position.z,
              c.self.moveSpeed,
              dt
            );
          } else {
            c.self.brake(dt);
            c.self.faceDirection(threat.position.x - p.x, threat.position.z - p.z, dt);
          }
          return 'running';
        }),
      ])
    ),
    action<HeroContext>('stand-by', (c, dt) => {
      c.self.brake(dt);
      return 'success';
    }),
  ]);
}

/**
 * MUMEN RIDER — charge, swing, get up, charge.
 *
 * Read the whole tree. There is no retreat node, no health check, no
 * "disengage when outmatched", and no branch that considers the odds. The
 * absence is the characterisation: this is a man whose entire heroic method is
 * to be standing in the way, and a behaviour tree can state that structurally
 * in a way a utility score cannot.
 *
 * Getting back up is not in the tree at all — it is unconditional, in
 * `update`, because it is not a decision he makes.
 */
function mumenTree(): BtNode<HeroContext> {
  return selector<HeroContext>('mumen-rider', [
    guard<HeroContext>(
      'engaged',
      hasTarget,
      selector<HeroContext>('engaged-branches', [
        sequence<HeroContext>('justice-crash', [
          action<HeroContext>('in-reach', (c) => {
            const threat = c.self.nearestThreat();
            if (threat === undefined) return 'failure';
            if (c.self.attackCooldownRemaining > 0) return 'failure';
            return c.self.distanceTo(threat) <= c.self.spec.attackRange ? 'success' : 'failure';
          }),
          action<HeroContext>('swing', (c, dt) => {
            const threat = c.self.nearestThreat();
            if (threat === undefined) return 'failure';
            c.self.brake(dt);
            c.self.faceDirection(
              threat.position.x - c.self.transform.position.x,
              threat.position.z - c.self.transform.position.z,
              dt
            );
            c.self.fireAttack(threat);
            return 'success';
          }),
        ]),
        cooldown<HeroContext>(
          'declare',
          14,
          action<HeroContext>('declaration', (c) => {
            c.self.say(
              'I am Mumen Rider, C-Class Rank 1! And I am not running!',
              'mumen.declare'
            );
            return 'success';
          })
        ),
        action<HeroContext>('charge', (c, dt) => {
          const threat = c.self.nearestThreat();
          if (threat === undefined) return 'failure';
          c.self.moveToward(threat.position.x, threat.position.z, c.self.moveSpeed, dt);
          return 'running';
        }),
      ])
    ),
    action<HeroContext>('patrol', (c, dt) => {
      c.self.brake(dt);
      return 'success';
    }),
  ]);
}

/**
 * TATSUMAKI — throw the scenery, from a long way away, while insulting you.
 *
 * Her contempt branch runs ABOVE combat and does not interrupt it: she is
 * quite capable of being rude to you and hurling a car in the same second.
 */
function tatsumakiTree(): BtNode<HeroContext> {
  return selector<HeroContext>('tatsumaki', [
    // Never let go of the disdain, even mid-fight.
    cooldown<HeroContext>(
      'contempt',
      17,
      guard<HeroContext>(
        'player-nearby',
        (c) => {
          const player = c.world.playerPosition();
          if (player === undefined) return false;
          const p = c.self.transform.position;
          const dx = player.x - p.x;
          const dz = player.z - p.z;
          return dx * dx + dz * dz < 30 * 30;
        },
        action<HeroContext>('insult', (c) => {
          c.self.say(TATSUMAKI_LINES[c.self.reEngagements % TATSUMAKI_LINES.length]!, 'tatsumaki.contempt');
          return 'failure';
        })
      )
    ),
    guard<HeroContext>(
      'engaged',
      hasTarget,
      selector<HeroContext>('engaged-branches', [
        // Occasionally she picks up something far too large. `ChunkDetached`
        // feeds the debris list, so "throw a building at it" is literally
        // throwing a piece of a building that is already in the world.
        cooldown<HeroContext>(
          'hurl-building',
          21,
          sequence<HeroContext>('big-throw', [
            action<HeroContext>('have-mass', (c) => {
              const heavy = c.world.debris.find((d) => d.mass > 4000);
              return heavy !== undefined ? 'success' : 'failure';
            }),
            action<HeroContext>('throw', (c) => {
              const threat = c.self.nearestThreat();
              if (threat === undefined) return 'failure';
              c.self.fireAttack(threat, 3.2, 'environmental');
              c.self.say('Fine. Stand still.', 'tatsumaki.hurl');
              return 'success';
            }),
          ])
        ),
        sequence<HeroContext>('hurl-debris', [
          action<HeroContext>('ready', (c) => {
            const threat = c.self.nearestThreat();
            if (threat === undefined) return 'failure';
            if (c.self.attackCooldownRemaining > 0) return 'failure';
            return c.self.distanceTo(threat) <= c.self.spec.attackRange ? 'success' : 'failure';
          }),
          action<HeroContext>('lift-and-throw', (c, dt) => {
            const threat = c.self.nearestThreat();
            if (threat === undefined) return 'failure';
            c.self.brake(dt);
            c.self.faceDirection(
              threat.position.x - c.self.transform.position.x,
              threat.position.z - c.self.transform.position.z,
              dt
            );
            // More debris in reach means a heavier volley.
            const scale = 1 + Math.min(c.world.debris.length, 12) * 0.06;
            c.self.fireAttack(threat, scale);
            return 'success';
          }),
        ]),
        action<HeroContext>('hover', (c, dt) => {
          const threat = c.self.nearestThreat();
          if (threat === undefined) return 'failure';
          const distance = c.self.distanceTo(threat);
          const p = c.self.transform.position;
          if (distance < c.self.spec.preferredRange - 4) {
            c.self.moveToward(
              p.x * 2 - threat.position.x,
              p.z * 2 - threat.position.z,
              c.self.moveSpeed,
              dt
            );
          } else if (distance > c.self.spec.attackRange) {
            c.self.moveToward(threat.position.x, threat.position.z, c.self.moveSpeed, dt);
          } else {
            c.self.brake(dt);
            c.self.faceDirection(threat.position.x - p.x, threat.position.z - p.z, dt);
          }
          return 'running';
        }),
      ])
    ),
    action<HeroContext>('drift', (c, dt) => {
      c.self.brake(dt);
      return 'success';
    }),
  ]);
}

/* -------------------------------------------------------------------------- */
/* Dialogue                                                                   */
/* -------------------------------------------------------------------------- */

const RISE_LINES: readonly string[] = [
  'Not yet.',
  'Still standing.',
  'You will have to do better than that.',
  'Someone has to be here.',
];

const TATSUMAKI_LINES: readonly string[] = [
  'Move, baldy. You are in the shot.',
  'Did anyone ask you to be here?',
  'I had this. Obviously.',
];

const DEATH_LINES: Readonly<Record<HeroNpcId, string>> = {
  genos: 'Sensei... I was not... strong enough...',
  mumenRider: 'Get them out... I can still...',
  tatsumaki: 'Tch. Fine. Your turn.',
};

const DEATH_KEYS: Readonly<Record<HeroNpcId, string>> = {
  genos: 'genos.down',
  mumenRider: 'mumen.down',
  tatsumaki: 'tatsumaki.down',
};
