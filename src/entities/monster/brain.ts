/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THE MONSTER BRAIN — ONE PER MONSTER, ARCHETYPE-DRIVEN                   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Perception → state machine → attack scheduling → steering, with every number
 * coming out of `IMonsterArchetype`. There is no `if (spec.id === …)` anywhere
 * in this file and there must never be one: a monster that needs a branch here
 * is a monster the table cannot express, and the table is what should change.
 *
 * ── WHAT A MONSTER ATTACK ACTUALLY DOES ───────────────────────────────────
 * It emits `ShockwaveFired`. That is all.
 *
 * It does not deal damage, because damage is not this module's to deal: the
 * player cannot be hurt at all, civilians belong to the crowd system, allies
 * belong to the hero-NPC system, and buildings belong to destruction. Each of
 * those already subscribes to `ShockwaveFired` and each already knows what a
 * pressure cone means to the things it owns. A monster releases force; four
 * other systems decide what that costs, and none of them are imported here.
 *
 * The one exception is scripted: a boss encounter can defeat a named ally by
 * emitting `AllyDowned` directly, because that is a NARRATIVE beat rather than
 * a physical one. See `boss-encounter.ts`.
 *
 * ── COST ──────────────────────────────────────────────────────────────────
 * Hundreds of these tick on a phone. So:
 *   • full re-think runs on a distance-bucketed interval (0.1 s near, 0.6 s
 *     far), cheap steering runs every frame — the split the AI contract
 *     mandates and the single biggest lever on a populated city;
 *   • no allocation per frame anywhere in `update`, including the target
 *     scan, which reads a caller-owned array and writes into fixed scratch;
 *   • no closures created after construction.
 *
 * ── DETERMINISM ───────────────────────────────────────────────────────────
 * Every random draw comes from the stream this brain was constructed with,
 * derived per monster from the world seed. `Math.random()` appears nowhere.
 * Same seed plus same tick script produces byte-identical behaviour, which is
 * what makes a boss encounter reproducible in a test.
 */

import type { ClipName, EntityId, IEventBus, LethalIntent, PunchKind, Vec3 } from '@/types';
import { DEG2RAD, angleDelta, clamp, moveTowards, wrapAngle, type IRandom } from '@/util';
import { MonsterFsm } from './fsm';
import type {
  IMonsterArchetype,
  IMonsterAttack,
  IMonsterSnapshot,
  IMonsterWorld,
  IMutableVec3,
  MonsterState,
} from './types';

/* -------------------------------------------------------------------------- */
/* Tuning that is about the SIMULATION rather than about a monster            */
/* -------------------------------------------------------------------------- */

/**
 * Think intervals by distance from the nearest target, in metres → seconds.
 *
 * A monster 200 m away re-deciding ten times a second is pure heat: nothing it
 * could conclude would be visible. The bands are coarse on purpose — a smooth
 * function of distance would recompute a schedule every frame to save work
 * every frame.
 */
const THINK_NEAR_METRES = 40;
const THINK_MID_METRES = 120;
const THINK_INTERVAL_NEAR = 0.1;
const THINK_INTERVAL_MID = 0.25;
const THINK_INTERVAL_FAR = 0.6;

/**
 * Seconds a monster spends in `alerted` orienting before it commits.
 *
 * Not politeness — it is the player's window. A monster that transitions from
 * unaware to sprinting inside one frame gives no one time to react, and the
 * reaction is the only thing the player controls in a fight they cannot lose.
 */
const ALERT_ORIENT_SECONDS = 0.55;

/** Metres beyond the bounding radius at which a monster notices regardless of facing. */
const PROXIMITY_MARGIN_METRES = 2;

/** Seconds between idle wander re-aims. */
const WANDER_PERIOD_SECONDS = 3.5;

/** Fraction of walk speed used while idling. */
const WANDER_SPEED_RATIO = 0.28;

/**
 * `power` thresholds that decide the `LethalIntent` stamped on a monster's
 * shockwave.
 *
 * Intent is a statement about FORCE COMMITTED, and every consumer downstream
 * reads it that way: destruction only fractures structures above `normal`, the
 * crowd panics harder, the camera shakes more. A wolf-tier swipe at power 60
 * committing the same intent as Boros's Collapsing Star would level a
 * shopfront every time a street pest missed.
 */
const INTENT_SERIOUS_POWER = 1e3;
const INTENT_FULL_POWER = 1e5;

/** Force commitment implied by an unbounded `power`. */
export function intentForPower(power: number): LethalIntent {
  if (power >= INTENT_FULL_POWER) return 'full';
  if (power >= INTENT_SERIOUS_POWER) return 'serious';
  return 'normal';
}

/** `PunchKind` a monster attack presents as, for the audio voice family. */
export function punchKindForAttack(attack: IMonsterAttack): PunchKind {
  switch (attack.kind) {
    case 'slam':
      return 'slam';
    case 'charge':
      return 'heavy';
    case 'ranged':
      // Not a punch at all. `environmental` is the honest slot for a beam:
      // it routes to the blast voice rather than to a fist.
      return 'environmental';
    case 'summon':
      return 'normal';
    case 'melee':
      return attack.clip === 'heavyAttack' ? 'heavy' : 'normal';
    default:
      return 'normal';
  }
}

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

export interface IMonsterBrainOptions {
  readonly id: EntityId;
  readonly archetype: IMonsterArchetype;
  readonly bus: IEventBus;
  /** Deterministic stream, derived per monster. Never `Math.random()`. */
  readonly rng: IRandom;
  readonly position: Vec3;
  readonly yaw?: number;
  /**
   * A summon attack went active. The host places the minions — the brain has
   * no spawner and must not acquire one.
   */
  readonly onSummon?: (archetypeId: string, count: number, origin: Vec3) => void;
  /** An attack went active. Lets an encounter script count pressure pulses. */
  readonly onAttack?: (attack: IMonsterAttack) => void;
}

/** Phase of the attack currently executing. */
export type AttackPhase = 'windup' | 'active' | 'recovery';

/* -------------------------------------------------------------------------- */
/* Brain                                                                      */
/* -------------------------------------------------------------------------- */

export class MonsterBrain {
  readonly id: EntityId;
  readonly archetype: IMonsterArchetype;
  readonly fsm: MonsterFsm;

  /** World position. Mutated in place; the host reads it every frame. */
  readonly position: IMutableVec3;
  /** Current velocity, m/s. */
  readonly velocity: IMutableVec3 = { x: 0, y: 0, z: 0 };
  /** Heading about Y in radians. */
  yaw: number;

  health: number;
  /** Seconds this brain has been alive. Drives bob and wander phases. */
  age = 0;

  /**
   * THE BOSS GATE, mirrored onto the monster.
   *
   * Meaningful only when `archetype.isBoss`. False means a `LethalIntent`
   * punch is absorbed by the plot; true means the identical punch kills. It is
   * written ONLY by the boss encounter script, from a scripted phase
   * transition, and never from health.
   */
  phaseResolved: boolean;

  private readonly bus: IEventBus;
  private readonly rng: IRandom;
  private readonly onSummon: IMonsterBrainOptions['onSummon'];
  private readonly onAttack: IMonsterBrainOptions['onAttack'];

  /* perception */
  private targetId: EntityId | undefined;
  private readonly lastKnown: IMutableVec3 = { x: 0, y: 0, z: 0 };
  private targetDistance = Number.POSITIVE_INFINITY;
  private hasLineOfSight = false;
  private secondsSinceSeen = Number.POSITIVE_INFINITY;

  /* scheduling */
  private thinkTimer = 0;
  private thinkInterval = THINK_INTERVAL_NEAR;

  /* attack */
  private attack: IMonsterAttack | undefined;
  private attackPhase: AttackPhase | undefined;
  private attackTimer = 0;
  private readonly cooldowns = new Map<string, number>();

  /* steering */
  private desiredYaw: number;
  private speed = 0;
  private erraticOffset = 0;
  private erraticTimer = 0;
  private wanderYaw: number;
  private wanderTimer = 0;
  private readonly bobPhase: number;

  /* presentation */
  private roarTimer: number;
  private taunting = false;

  /** Scratch for the summon callback, so a summon allocates nothing. */
  private readonly scratch: IMutableVec3 = { x: 0, y: 0, z: 0 };

  constructor(options: IMonsterBrainOptions) {
    this.id = options.id;
    this.archetype = options.archetype;
    this.bus = options.bus;
    this.rng = options.rng;
    this.onSummon = options.onSummon;
    this.onAttack = options.onAttack;

    this.position = { x: options.position.x, y: options.position.y, z: options.position.z };
    this.yaw = options.yaw ?? 0;
    this.desiredYaw = this.yaw;
    this.wanderYaw = this.yaw;
    this.health = options.archetype.maxHealth;
    // A boss starts GATED; everything else is killable from the first frame.
    this.phaseResolved = !options.archetype.isBoss;
    this.bobPhase = this.rng.range(0, Math.PI * 2);
    this.roarTimer = this.rng.range(0, options.archetype.roarPeriodSeconds);
    this.fsm = new MonsterFsm('idle');
  }

  /* ---------------------------------------------------------------------- */
  /* Queries                                                                */
  /* ---------------------------------------------------------------------- */

  get state(): MonsterState {
    return this.fsm.current;
  }

  get isDead(): boolean {
    return this.fsm.current === 'dead';
  }

  get currentTargetId(): EntityId | undefined {
    return this.targetId;
  }

  get distanceToTarget(): number {
    return this.targetDistance;
  }

  /** Animation slot this monster wants played right now. */
  get clip(): ClipName {
    switch (this.fsm.current) {
      case 'dead':
        return 'death';
      case 'stagger':
        return 'stagger';
      case 'attack':
        return this.attack?.clip ?? 'attack';
      case 'pursue':
        return this.speed > this.archetype.movement.walkSpeed * 1.35 ? 'run' : 'walk';
      case 'alerted':
        return this.taunting ? 'taunt' : this.speed > 0.15 ? 'walk' : 'idle';
      case 'idle':
        return this.speed > 0.15 ? 'walk' : 'idle';
      default:
        return 'idle';
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Tick                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Advance one frame.
   *
   * Order matters and is a contract: cooldowns and the attack timeline run
   * BEFORE the think, so an attack that finished this frame is visible to the
   * decision that follows it; the FSM clock ticks LAST so `timeInState` is
   * consistent for everything that read it during the frame.
   */
  update(dt: number, world: IMonsterWorld): void {
    if (this.fsm.current === 'dead') {
      this.fsm.update(dt);
      return;
    }

    this.age += dt;
    this.tickCooldowns(dt);
    this.tickAttack(dt);

    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0) {
      this.perceive(world);
      this.decide(world);
      this.thinkTimer = this.thinkInterval;
    } else if (this.targetId !== undefined) {
      // Between thinks the target's distance is still refreshed — it is one
      // subtraction and steering would otherwise chase a stale point at
      // 0.6 s granularity, which reads as a monster lagging behind the player.
      this.refreshTargetDistance(world);
    }

    this.tickStagger();
    this.steer(dt, world);
    this.tickPresentation(dt);
    this.fsm.update(dt);
  }

  /* ---------------------------------------------------------------------- */
  /* Perception                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Choose a target.
   *
   * Score is `priority / distance`, so an ally worth protecting outranks a
   * closer civilian without any script saying so — which is exactly how Mumen
   * Rider ends up in front of the Deep Sea King.
   */
  private perceive(world: IMonsterWorld): void {
    const a = this.archetype;
    const keepRange = this.targetId === undefined ? a.aggroRadius : a.loseAggroMetres;
    const proximity = a.radiusMetres + PROXIMITY_MARGIN_METRES;

    let bestId: EntityId | undefined;
    let bestScore = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestVisible = false;
    let bestX = 0;
    let bestZ = 0;
    let bestY = 0;

    for (const target of world.targets) {
      if (!target.alive || target.faction === 'monster') continue;

      const dx = target.position.x - this.position.x;
      const dy = target.position.y - this.position.y;
      const dz = target.position.z - this.position.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance > keepRange) continue;

      // Inside the vision cone, or close enough that facing stops mattering.
      const forwardX = Math.sin(this.yaw);
      const forwardZ = Math.cos(this.yaw);
      const planar = Math.hypot(dx, dz) || 1;
      const cosine = (dx * forwardX + dz * forwardZ) / planar;
      const inCone = cosine >= Math.cos(a.visionHalfAngleRad);
      const noticed = inCone || distance <= proximity;
      if (!noticed && target.id !== this.targetId) continue;

      const clear = world.lineOfSight?.(this.position, target.position) ?? true;
      if (!clear && target.id !== this.targetId) continue;

      const score = target.priority / Math.max(distance, 0.5);
      if (score <= bestScore) continue;
      bestScore = score;
      bestId = target.id;
      bestDistance = distance;
      bestVisible = clear && noticed;
      bestX = target.position.x;
      bestY = target.position.y;
      bestZ = target.position.z;
    }

    if (bestId !== undefined) {
      this.targetId = bestId;
      this.targetDistance = bestDistance;
      this.hasLineOfSight = bestVisible;
      if (bestVisible) {
        this.secondsSinceSeen = 0;
        this.lastKnown.x = bestX;
        this.lastKnown.y = bestY;
        this.lastKnown.z = bestZ;
      } else {
        this.secondsSinceSeen += this.thinkInterval;
      }
    } else if (this.targetId !== undefined) {
      // Remembered, not seen. The monster keeps walking to where it last saw
      // the target, which is what makes losing one read as being hunted rather
      // than as a switch flipping off.
      this.secondsSinceSeen += this.thinkInterval;
      this.hasLineOfSight = false;
      if (this.secondsSinceSeen > this.archetype.memorySeconds) {
        this.targetId = undefined;
        this.targetDistance = Number.POSITIVE_INFINITY;
      }
    }

    this.thinkInterval =
      bestDistance <= THINK_NEAR_METRES
        ? THINK_INTERVAL_NEAR
        : bestDistance <= THINK_MID_METRES
          ? THINK_INTERVAL_MID
          : THINK_INTERVAL_FAR;
  }

  private refreshTargetDistance(world: IMonsterWorld): void {
    for (const target of world.targets) {
      if (target.id !== this.targetId) continue;
      if (!target.alive) return;
      const dx = target.position.x - this.position.x;
      const dy = target.position.y - this.position.y;
      const dz = target.position.z - this.position.z;
      this.targetDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (this.hasLineOfSight) {
        this.lastKnown.x = target.position.x;
        this.lastKnown.y = target.position.y;
        this.lastKnown.z = target.position.z;
      }
      return;
    }
  }

  /**
   * Inject a stimulus the monster could not have seen — a shockwave three
   * blocks away, a building coming down, a scream.
   *
   * This is how a serious punch wakes a district: the resolver emits
   * `ShockwaveFired`, the monster system forwards it here, and every monster
   * inside `hearingMetres` turns toward it. No monster subscribes to the bus
   * itself; one subscription serves all of them.
   */
  notice(x: number, y: number, z: number, intensity: number): void {
    if (this.fsm.current === 'dead') return;
    const dx = x - this.position.x;
    const dz = z - this.position.z;
    const distance = Math.hypot(dx, dz);
    if (distance > this.archetype.hearingMetres * clamp(intensity, 0.1, 1.5)) return;

    this.lastKnown.x = x;
    this.lastKnown.y = y;
    this.lastKnown.z = z;
    this.secondsSinceSeen = 0;
    if (this.fsm.current === 'idle') {
      this.fsm.transition('alerted');
      this.desiredYaw = Math.atan2(dx, dz);
    }
    // Re-think on the next frame rather than at the next scheduled tick: a
    // monster that ignores an explosion for half a second looks deaf.
    this.thinkTimer = 0;
  }

  /* ---------------------------------------------------------------------- */
  /* Decision                                                               */
  /* ---------------------------------------------------------------------- */

  private decide(_world: IMonsterWorld): void {
    switch (this.fsm.current) {
      case 'idle': {
        if (this.targetId !== undefined) {
          this.fsm.transition('alerted');
          this.taunting = this.roarTimer <= 0;
          if (this.taunting) this.roarTimer = this.archetype.roarPeriodSeconds;
        }
        return;
      }

      case 'alerted': {
        if (this.targetId === undefined) {
          if (this.fsm.timeInState >= this.archetype.memorySeconds) this.fsm.transition('idle');
          return;
        }
        if (this.fsm.timeInState < ALERT_ORIENT_SECONDS) return;
        this.taunting = false;
        const ready = this.selectAttack();
        if (ready !== undefined) this.beginAttack(ready);
        else this.fsm.transition('pursue');
        return;
      }

      case 'pursue': {
        if (this.targetId === undefined) {
          this.fsm.transition('alerted');
          return;
        }
        const ready = this.selectAttack();
        if (ready !== undefined) this.beginAttack(ready);
        return;
      }

      case 'attack': {
        if (this.attackPhase !== undefined) return;
        if (this.targetId === undefined) {
          this.fsm.transition('alerted');
          return;
        }
        const ready = this.selectAttack();
        if (ready !== undefined) this.beginAttack(ready);
        else this.fsm.transition('pursue');
        return;
      }

      case 'stagger':
      case 'dead':
        return;

      default:
        return;
    }
  }

  /**
   * Highest-weighted legal attack, or undefined.
   *
   * Legal means: off cooldown, target inside `[minRange, range]`, and inside
   * the attack's own half-angle. Ties are broken by a weighted draw from this
   * monster's own stream, so two identical monsters standing side by side do
   * not swing in lockstep — and so the same seed still replays exactly.
   */
  private selectAttack(): IMonsterAttack | undefined {
    if (this.targetDistance === Number.POSITIVE_INFINITY) return undefined;
    // Measured against the heading to the target, NOT against `desiredYaw`:
    // `desiredYaw` is written by `steer`, which runs after `decide`, so using
    // it here would test this frame's decision against last frame's aim.
    const facing = Math.abs(angleDelta(this.yaw, this.headingToLastKnown()));

    let candidates: IMonsterAttack[] | undefined;
    let weights: number[] | undefined;
    for (const attack of this.archetype.attacks) {
      if ((this.cooldowns.get(attack.id) ?? 0) > 0) continue;
      if (this.targetDistance > attack.rangeMetres) continue;
      if (this.targetDistance < attack.minRangeMetres) continue;
      if (facing > attack.halfAngleRad) continue;
      candidates ??= [];
      weights ??= [];
      candidates.push(attack);
      weights.push(attack.weight);
    }
    if (candidates === undefined || weights === undefined || candidates.length === 0) {
      return undefined;
    }
    if (candidates.length === 1) return candidates[0];
    return this.rng.weighted(candidates, weights);
  }

  private beginAttack(attack: IMonsterAttack): void {
    // Self-transition is legal for `attack` and only for `attack`: a second
    // swing genuinely restarts the wind-up, the clip and the state clock, so
    // this one call is correct whether or not the monster is already swinging.
    this.fsm.transition('attack');
    this.attack = attack;
    this.attackPhase = 'windup';
    this.attackTimer = attack.windupSeconds;
    this.cooldowns.set(attack.id, attack.cooldownSeconds);
  }

  private tickCooldowns(dt: number): void {
    for (const [id, remaining] of this.cooldowns) {
      const next = remaining - dt;
      if (next <= 0) this.cooldowns.delete(id);
      else this.cooldowns.set(id, next);
    }
  }

  private tickAttack(dt: number): void {
    const attack = this.attack;
    if (attack === undefined || this.attackPhase === undefined) return;

    this.attackTimer -= dt;
    if (this.attackTimer > 0) return;

    switch (this.attackPhase) {
      case 'windup': {
        this.attackPhase = 'active';
        this.attackTimer = attack.activeSeconds;
        this.release(attack);
        return;
      }
      case 'active': {
        this.attackPhase = 'recovery';
        this.attackTimer = attack.recoverySeconds;
        return;
      }
      case 'recovery': {
        this.attackPhase = undefined;
        this.attack = undefined;
        this.attackTimer = 0;
        // Re-decide immediately: a monster that stands in its own recovery for
        // up to 0.6 s waiting for the next scheduled think reads as broken.
        this.thinkTimer = 0;
        return;
      }
      default:
        return;
    }
  }

  /**
   * The attack goes active: release the pressure.
   *
   * `ShockwaveFired` is the ONLY thing that leaves this module on a monster's
   * behalf. Physics propagates it, the crowd panics from it, destruction
   * fractures from it, VFX draws it and audio voices it — and not one of them
   * is referenced here.
   */
  private release(attack: IMonsterAttack): void {
    const forwardX = Math.sin(this.yaw);
    const forwardZ = Math.cos(this.yaw);
    const originY = this.position.y + this.archetype.bodyHeightMetres * 0.55;

    this.scratch.x = this.position.x + forwardX * this.archetype.radiusMetres;
    this.scratch.y = originY;
    this.scratch.z = this.position.z + forwardZ * this.archetype.radiusMetres;

    this.bus.emit('ShockwaveFired', {
      origin: this.scratch,
      direction: { x: forwardX, y: 0, z: forwardZ },
      power: attack.wavePower,
      range: attack.waveRangeMetres,
      angle: attack.waveHalfAngleRad,
      intent: intentForPower(attack.wavePower),
      punchKind: punchKindForAttack(attack),
      sourceId: this.id,
    });

    if (attack.kind === 'summon' && attack.summonArchetypeId !== undefined) {
      this.onSummon?.(attack.summonArchetypeId, attack.summonCount ?? 1, this.scratch);
    }
    this.onAttack?.(attack);
  }

  /* ---------------------------------------------------------------------- */
  /* Damage and death — driven by the bus, never self-inflicted             */
  /* ---------------------------------------------------------------------- */

  /**
   * React to damage the COMBAT system already applied.
   *
   * This module is not authoritative on health: `EntityDamaged` and
   * `EntityKilled` are, and the monster system forwards them here. A brain
   * that decremented its own health would be a second source of truth, and the
   * two would drift the first time a punch and a falling girder landed on the
   * same frame.
   */
  onDamaged(healthRemaining: number, amount: number): void {
    if (this.fsm.current === 'dead') return;
    this.health = healthRemaining;
    const interrupts = amount >= this.archetype.maxHealth * this.archetype.staggerFraction;
    if (!interrupts) return;
    this.cancelAttack();
    this.fsm.transition('stagger');
    // Being hit is being found: a monster punched from behind now knows where
    // to look, which stops flanking from being a permanent free pass.
    this.thinkTimer = 0;
  }

  /** The monster died. Forced, because death arrives in any state at any time. */
  onKilled(): void {
    if (this.fsm.current === 'dead') return;
    this.cancelAttack();
    this.health = 0;
    this.speed = 0;
    this.velocity.x = 0;
    this.velocity.y = 0;
    this.velocity.z = 0;
    this.fsm.transition('dead', true);
  }

  private cancelAttack(): void {
    this.attack = undefined;
    this.attackPhase = undefined;
    this.attackTimer = 0;
  }

  private tickStagger(): void {
    if (this.fsm.current !== 'stagger') return;
    if (this.fsm.timeInState < this.archetype.staggerSeconds) return;
    this.fsm.transition(this.targetId === undefined ? 'idle' : 'pursue');
  }

  /* ---------------------------------------------------------------------- */
  /* Steering                                                               */
  /* ---------------------------------------------------------------------- */

  private steer(dt: number, world: IMonsterWorld): void {
    const move = this.archetype.movement;

    /* ---- erratic drift ------------------------------------------------- */
    if (move.erratic > 0) {
      this.erraticTimer -= dt;
      if (this.erraticTimer <= 0) {
        this.erraticOffset = this.rng.range(-move.erratic, move.erratic);
        this.erraticTimer = move.erraticPeriodSeconds;
      }
    }

    /* ---- desired heading and speed ------------------------------------- */
    // Deliberately uninitialised: every arm of the switch, including the
    // default, assigns it, so a stray `0` here would be dead code that quietly
    // hides a missing case if a state is ever added.
    let targetSpeed: number;
    switch (this.fsm.current) {
      case 'idle': {
        this.wanderTimer -= dt;
        if (this.wanderTimer <= 0) {
          this.wanderYaw = wrapAngle(this.wanderYaw + this.rng.range(-1.6, 1.6));
          this.wanderTimer = WANDER_PERIOD_SECONDS;
        }
        this.desiredYaw = this.wanderYaw;
        targetSpeed = move.walkSpeed * WANDER_SPEED_RATIO;
        break;
      }
      case 'alerted': {
        this.desiredYaw = this.headingToLastKnown();
        targetSpeed = this.fsm.timeInState < ALERT_ORIENT_SECONDS ? 0 : move.walkSpeed;
        break;
      }
      case 'pursue': {
        this.desiredYaw = this.headingToLastKnown() + this.erraticOffset;
        // Stand off rather than shoving into the target: a gunner that closes
        // to melee is not a gunner, and a flyer that lands is not a flyer.
        const gap = this.targetDistance - move.standoffMetres;
        targetSpeed = gap > 1 ? move.runSpeed : gap < -1 ? -move.walkSpeed * 0.6 : 0;
        break;
      }
      case 'attack': {
        this.desiredYaw = this.headingToLastKnown();
        // A charge is the one attack that MOVES during its active window.
        targetSpeed =
          this.attack?.kind === 'charge' && this.attackPhase === 'active' ? move.runSpeed * 1.6 : 0;
        break;
      }
      case 'stagger':
      case 'dead':
        targetSpeed = 0;
        break;
      default:
        targetSpeed = 0;
        break;
    }

    /* ---- turn, accelerate, integrate ----------------------------------- */
    const turn = move.turnRateRad * dt;
    const delta = angleDelta(this.yaw, this.desiredYaw);
    this.yaw = wrapAngle(this.yaw + clamp(delta, -turn, turn));

    this.speed = moveTowards(this.speed, targetSpeed, move.acceleration * dt);
    const forwardX = Math.sin(this.yaw);
    const forwardZ = Math.cos(this.yaw);
    this.velocity.x = forwardX * this.speed;
    this.velocity.z = forwardZ * this.speed;
    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;

    /* ---- vertical ------------------------------------------------------ */
    const ground = world.groundHeight?.(this.position.x, this.position.z) ?? 0;
    if (move.hoverHeightMetres > 0) {
      const bob = Math.sin(this.age * 2.1 + this.bobPhase) * move.bobAmplitudeMetres;
      const desiredY = ground + move.hoverHeightMetres + bob;
      const previousY = this.position.y;
      // Approach altitude at a rate proportional to run speed, so a diving
      // flyer is not teleported to its cruising height on the next frame.
      this.position.y = moveTowards(this.position.y, desiredY, move.runSpeed * dt);
      this.velocity.y = dt > 0 ? (this.position.y - previousY) / dt : 0;
    } else {
      this.position.y = ground;
      this.velocity.y = 0;
    }
  }

  private headingToLastKnown(): number {
    const dx = this.lastKnown.x - this.position.x;
    const dz = this.lastKnown.z - this.position.z;
    if (dx === 0 && dz === 0) return this.yaw;
    return Math.atan2(dx, dz);
  }

  private tickPresentation(dt: number): void {
    if (this.roarTimer > 0) this.roarTimer -= dt;
    if (this.taunting && this.fsm.timeInState >= ALERT_ORIENT_SECONDS) this.taunting = false;
  }

  /* ---------------------------------------------------------------------- */
  /* Diagnostics                                                            */
  /* ---------------------------------------------------------------------- */

  snapshot(): IMonsterSnapshot {
    return {
      id: this.id,
      archetypeId: this.archetype.id,
      displayName: this.archetype.name,
      tier: this.archetype.threatTier,
      motion: this.archetype.motion,
      state: this.fsm.current,
      previousState: this.fsm.previous,
      timeInState: this.fsm.timeInState,
      position: { x: this.position.x, y: this.position.y, z: this.position.z },
      yaw: this.yaw,
      health: this.health,
      maxHealth: this.archetype.maxHealth,
      targetId: this.targetId,
      targetDistance: this.targetDistance,
      attackId: this.attack?.id,
      attackPhase: this.attackPhase,
      isBoss: this.archetype.isBoss,
      phaseResolved: this.phaseResolved,
      clip: this.clip,
    };
  }

  /** Reset for the pool. Position and yaw are supplied by the new placement. */
  reset(position: Vec3, yaw: number): void {
    this.position.x = position.x;
    this.position.y = position.y;
    this.position.z = position.z;
    this.velocity.x = 0;
    this.velocity.y = 0;
    this.velocity.z = 0;
    this.yaw = yaw;
    this.desiredYaw = yaw;
    this.wanderYaw = yaw;
    this.speed = 0;
    this.age = 0;
    this.health = this.archetype.maxHealth;
    this.phaseResolved = !this.archetype.isBoss;
    this.targetId = undefined;
    this.targetDistance = Number.POSITIVE_INFINITY;
    this.secondsSinceSeen = Number.POSITIVE_INFINITY;
    this.hasLineOfSight = false;
    this.thinkTimer = 0;
    this.thinkInterval = THINK_INTERVAL_NEAR;
    this.cooldowns.clear();
    this.cancelAttack();
    this.taunting = false;
    this.roarTimer = this.archetype.roarPeriodSeconds;
    this.fsm.reset('idle');
  }
}

/** Re-exported so the harness can render a vision cone without re-deriving it. */
export const MONSTER_VISION_DEFAULT_HALF_ANGLE_RAD = 65 * DEG2RAD;
