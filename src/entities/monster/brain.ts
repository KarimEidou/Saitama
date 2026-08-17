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
 * ── WHO IT SWINGS AT, WHICH IS THE WHOLE GAME ─────────────────────────────
 * The protagonist cannot be hurt. Everything else can. So a monster that picks
 * its target by proximity picks the one character with no stake in the fight,
 * walks the encounter away from everybody who has one, and turns the game's
 * central premise into an anticlimax — which is exactly what a sixty-second
 * capture of a Harbinger showed: `lastTargetId: "player"`, unchanged, Genos
 * three hundred and fifty metres away and on full health.
 *
 * Selection therefore weights HARMABILITY alongside priority and distance
 * (`perceive`), notices people who can be hurt from any angle rather than only
 * through the vision cone, and puts a bounded clock on any engagement that
 * cannot accomplish anything (`tickFixation`). A monster may still charge
 * Saitama, and often does — he is attacked constantly in the source material.
 * It simply cannot spend the whole fight on him while a district burns.
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

/* -------------------------------------------------------------------------- */
/* WHO A MONSTER FIGHTS — the tuning behind the game's one stake              */
/* -------------------------------------------------------------------------- */

/**
 * Score multiplier for a target that cannot be harmed.
 *
 * The whole premise in one number. A monster that picks purely by distance
 * picks Saitama, walks its own fight three hundred metres away from the only
 * people in it who can lose, and spends the encounter swinging at someone who
 * is not even inconvenienced. Weighting harmability against proximity is what
 * makes an ally at thirty metres outrank the invulnerable man at ten.
 *
 * It is deliberately NOT zero. A monster with Saitama standing on top of it
 * still swings at him — he gets attacked constantly in the source material, it
 * simply never works — and with `Math.max(distance, 0.5)` in the denominator
 * this weight puts the crossover at roughly 0.12 × (ally distance / ally
 * priority) metres: point-blank he still wins, three metres out he does not.
 */
const UNHARMABLE_WEIGHT = 0.12;

/**
 * All-round awareness of a HARMABLE target, as a fraction of `aggroRadius`.
 *
 * The vision cone is what makes a monster approachable from behind, and that
 * has to survive — but applied to everyone it also means a monster locked onto
 * something in front of it can never notice the ally shooting it in the back,
 * which is precisely how the fight ends up in an empty district. So the cone
 * still governs the player (stealth is intact, because he is the unharmable
 * one) while people who scream, fire and bleed register from any angle.
 */
const HARMABLE_PERIPHERAL_FRACTION = 0.35;

/**
 * Score bonus for the target a monster is already fighting.
 *
 * Hysteresis, not loyalty: two allies a metre apart would otherwise swap the
 * lock every think and the monster would stand between them turning its head.
 * Granted ONLY when the current target is harmable — a fixation on someone
 * invulnerable is the bug, and rewarding it would re-create it.
 */
const TARGET_STICKINESS = 1.15;

/**
 * Seconds a monster stays committed to a target it cannot hurt.
 *
 * Long enough to be a beat rather than a flinch — it charges in, it commits,
 * it swings — and short enough that no encounter is spent on it.
 */
const FUTILE_LOCK_SECONDS = 5;

/**
 * Attacks that land on an unharmable target before the monster gives up.
 *
 * Two. The first tells it nothing (everything survives one hit), the second is
 * a pattern. A creature that keeps going after that is not menacing, it is
 * broken — and the failure this whole mechanism exists to delete was a
 * `lastTargetId` that never changed for sixty seconds.
 */
const FUTILE_ATTACK_LIMIT = 2;

/**
 * Seconds an abandoned target is skipped over entirely.
 *
 * Only one target can be suppressed at a time, and one slot is the right size:
 * there is exactly one thing in this world that cannot be hurt. When it
 * expires the monster is free to have another go — which is why Saitama still
 * gets attacked all game, in bursts, instead of once and never again.
 */
const FUTILE_SUPPRESSION_SECONDS = 14;

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
  /** Whether hitting the current target would accomplish anything. */
  private targetHarmable = true;

  /* fixation — the clock that stops a monster wasting a fight on Saitama */
  private futileSeconds = 0;
  private futileAttacks = 0;
  private suppressedId: EntityId | undefined;
  private suppressedFor = 0;
  /** Targets abandoned as futile. Diagnostics, and what the tests assert on. */
  retargets = 0;

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

  /** True when the current target can actually be hurt. No target reads false. */
  get isTargetHarmable(): boolean {
    return this.targetId !== undefined && this.targetHarmable;
  }

  /** The target being deliberately ignored, and for how much longer. */
  get suppressedTargetId(): EntityId | undefined {
    return this.suppressedFor > 0 ? this.suppressedId : undefined;
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
    // Before the think, so a target abandoned this frame is already gone when
    // the scan that replaces it runs.
    this.tickFixation(dt);

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
   * ── WHAT THE SCORE IS, AND WHY IT IS NOT JUST DISTANCE ──────────────────
   *
   *     score = priority × harmability × stickiness / distance
   *
   * Distance alone picks whoever is nearest, and in this game whoever is
   * nearest is very often the one person in the world who cannot be hurt.
   * Priority alone was tried and is not enough — a 1.6× ally at thirty metres
   * still loses to a 1.0× protagonist at five. Harmability is the term that
   * makes the difference categorical rather than a tuning race: an ally worth
   * protecting outranks a closer civilian, and BOTH of them outrank Saitama
   * unless he is close enough to be stepped on.
   *
   * That is how Mumen Rider ends up in front of the Deep Sea King without a
   * line of script saying so, and how the fight stays where the people are.
   */
  private perceive(world: IMonsterWorld): void {
    const a = this.archetype;
    const keepRange = this.targetId === undefined ? a.aggroRadius : a.loseAggroMetres;
    const proximity = a.radiusMetres + PROXIMITY_MARGIN_METRES;
    // Someone who can be hurt is noticed from any angle inside this radius.
    // Someone who cannot — the protagonist — still has to be seen.
    const peripheral = Math.max(proximity, a.aggroRadius * HARMABLE_PERIPHERAL_FRACTION);
    const suppressed = this.suppressedFor > 0 ? this.suppressedId : undefined;

    let bestId: EntityId | undefined;
    let bestScore = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestVisible = false;
    let bestHarmable = true;
    let bestX = 0;
    let bestZ = 0;
    let bestY = 0;

    for (const target of world.targets) {
      if (!target.alive || target.faction === 'monster') continue;
      // Given up on for futility. Ignored outright rather than merely
      // out-scored: the point of abandoning a target is to LOOK ELSEWHERE,
      // and a discount still wins when it is the only thing in range.
      if (target.id === suppressed) continue;

      const dx = target.position.x - this.position.x;
      const dy = target.position.y - this.position.y;
      const dz = target.position.z - this.position.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance > keepRange) continue;

      const harmable = target.harmable ?? true;

      // Inside the vision cone, close enough that facing stops mattering, or —
      // for someone who can be hurt — anywhere inside the peripheral radius.
      const forwardX = Math.sin(this.yaw);
      const forwardZ = Math.cos(this.yaw);
      const planar = Math.hypot(dx, dz) || 1;
      const cosine = (dx * forwardX + dz * forwardZ) / planar;
      const inCone = cosine >= Math.cos(a.visionHalfAngleRad);
      const noticed = inCone || distance <= proximity || (harmable && distance <= peripheral);
      if (!noticed && target.id !== this.targetId) continue;

      const clear = world.lineOfSight?.(this.position, target.position) ?? true;
      if (!clear && target.id !== this.targetId) continue;

      const weight = harmable ? 1 : UNHARMABLE_WEIGHT;
      // Stickiness for a fight already in progress, never for a futile one.
      const sticky = target.id === this.targetId && harmable ? TARGET_STICKINESS : 1;
      const score = (target.priority * weight * sticky) / Math.max(distance, 0.5);
      if (score <= bestScore) continue;
      bestScore = score;
      bestId = target.id;
      bestDistance = distance;
      bestVisible = clear && noticed;
      bestHarmable = harmable;
      bestX = target.position.x;
      bestY = target.position.y;
      bestZ = target.position.z;
    }

    if (bestId !== undefined) {
      // Switching targets restarts the futility clock: the count is about ONE
      // target's worth of wasted effort, not about the monster's whole life.
      if (bestId !== this.targetId) {
        this.futileSeconds = 0;
        this.futileAttacks = 0;
      }
      this.targetId = bestId;
      this.targetDistance = bestDistance;
      this.hasLineOfSight = bestVisible;
      this.targetHarmable = bestHarmable;
      // Proof of progress, for the FSM watchdog. A chase across three
      // districts is a legitimate three-minute stay in `pursue`, and the
      // watchdog must not end it — but a `pursue` that has perceived nothing
      // at all for 75 s really is stuck and should be rescued.
      if (this.fsm.current === 'pursue') this.fsm.heartbeat();
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
      if (this.secondsSinceSeen > this.archetype.memorySeconds) this.forgetTarget();
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

  /* ---------------------------------------------------------------------- */
  /* Fixation — the clock that ends a fight nobody can lose                 */
  /* ---------------------------------------------------------------------- */

  /**
   * ══════════════════════════════════════════════════════════════════════
   *  THE RE-TARGET, AND WHY IT IS A CLOCK RATHER THAN A SCORE
   * ══════════════════════════════════════════════════════════════════════
   * Weighting harmability decides who a monster picks when it has a choice.
   * This decides what happens when it does not — the case that actually shipped
   * broken: a Harbinger locked onto the protagonist, `lastTargetId: "player"`
   * unchanged for sixty seconds, three hundred metres of city between the fight
   * and everybody in it who could still be hurt.
   *
   * No score fixes that, because the discount is irrelevant when the discounted
   * target is the only one in range. What fixes it is the monster noticing it
   * is wasting its time: seconds committed, and attacks that landed and changed
   * nothing. Either limit ends the engagement, the target is skipped for a
   * while, and the monster goes looking for something it can actually break.
   *
   * A monster may still engage Saitama, repeatedly, all game. It just cannot
   * spend a whole encounter on him.
   */
  private tickFixation(dt: number): void {
    if (this.suppressedFor > 0) {
      this.suppressedFor -= dt;
      if (this.suppressedFor <= 0) {
        this.suppressedFor = 0;
        this.suppressedId = undefined;
      }
    }

    if (this.targetId === undefined || this.targetHarmable) {
      this.futileSeconds = 0;
      return;
    }
    // Only time spent ENGAGED counts. Walking towards him across a district is
    // not futile yet — he might be standing next to somebody who matters.
    const state = this.fsm.current;
    if (state !== 'pursue' && state !== 'attack' && state !== 'alerted') return;

    this.futileSeconds += dt;
    if (this.futileSeconds < FUTILE_LOCK_SECONDS && this.futileAttacks < FUTILE_ATTACK_LIMIT) {
      return;
    }
    this.abandonTarget();
  }

  /**
   * Give up on the current target and refuse to see it for a while.
   *
   * Straight to `idle` rather than to `alerted`: `alerted` means "I have
   * something", and this monster explicitly does not any more. `idle` is legal
   * from every live state, wanders instead of standing still, re-acquires on
   * the very next think, and — unlike `alerted`, whose watchdog is shorter than
   * several archetypes' memory — cannot sit there long enough to trip anything.
   * The visible result is a creature that breaks off mid-swing and turns away,
   * which is exactly what it has decided to do.
   */
  private abandonTarget(): void {
    if (this.targetId === undefined) return;
    this.suppressedId = this.targetId;
    this.suppressedFor = FUTILE_SUPPRESSION_SECONDS;
    this.retargets++;
    this.forgetTarget();
    this.cancelAttack();
    if (this.fsm.current !== 'idle') this.fsm.transition('idle');
    this.thinkTimer = 0;
  }

  /** Drop the current target and everything derived from it. */
  private forgetTarget(): void {
    this.targetId = undefined;
    this.targetDistance = Number.POSITIVE_INFINITY;
    this.targetHarmable = true;
    this.futileSeconds = 0;
    this.futileAttacks = 0;
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

    // Force spent on someone it cannot hurt. Counted here rather than at the
    // decision, because a wind-up that got interrupted cost the monster
    // nothing and taught it nothing — only a released attack is evidence.
    if (this.targetId !== undefined && !this.targetHarmable) this.futileAttacks++;

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
      targetHarmable: this.isTargetHarmable,
      retargets: this.retargets,
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
    // A recycled monster has no grudges and no history: the suppression and
    // the futility counters are about ONE engagement, and this is a new one.
    this.targetHarmable = true;
    this.futileSeconds = 0;
    this.futileAttacks = 0;
    this.suppressedId = undefined;
    this.suppressedFor = 0;
    this.retargets = 0;
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
