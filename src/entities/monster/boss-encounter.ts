/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THE BOSS ENCOUNTER — AND THE PHASE GATE                                 ║
 * ║                                                                          ║
 * ║  THIS FILE IS THE ONLY REASON BOSSES ARE NOT TRIVIAL, AND THE ONLY       ║
 * ║  REASON THEY ARE NOT TOUGH. Get it wrong in one direction and every      ║
 * ║  boss dies in the first second of its own introduction; get it wrong in  ║
 * ║  the other and the game grows a health bar, which is the one thing this  ║
 * ║  premise cannot survive.                                                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── THE GATE, EXACTLY ─────────────────────────────────────────────────────
 * Saitama's attacks carry `LethalIntent`, not damage. The combat resolver
 * branches on two fields and nothing else:
 *
 *     const gated = target.isBoss && !target.phaseResolved;
 *
 * `gated` → the hit is absorbed, health is floored at 1, `phaseGated` comes
 * back true. Not gated and lethal → instant kill, identical to a street pest.
 * There is no third branch and no partial credit.
 *
 * `phaseResolved` reaches the resolver ONE WAY: this module emits
 * `BossPhaseChanged` with `isFinalPhase: true`, and the combat system's
 * handler assigns `target.phaseResolved = event.isFinalPhase`. So the gate is
 * a NARRATIVE state travelling over the bus, exactly as intended — and the two
 * systems share no import, no reference and no memory.
 *
 * ── WHAT ADVANCES A PHASE ─────────────────────────────────────────────────
 *   engaged TIME   the player has to be present. A player who runs away does
 *                  not advance the fight by waiting it out.
 *   HITS           the boss has to be touched. A player who hides does not
 *                  advance it either.
 *   SUMMONS        when the phase says so, its minions have to be dead.
 *   THE ALLY BEAT  when the phase has one, it has to resolve — saved or lost.
 *
 * HEALTH IS NOT ON THAT LIST AND MUST NEVER BE. `bossPhaseChipDamage` in
 * combat's tuning ships at 0 for the same reason: a boss that could be worn
 * down is a boss with a health bar wearing a narrative hat.
 *
 * ── WHO EMITS `EncounterEnded` ────────────────────────────────────────────
 * NOT THIS MODULE. `src/gameplay/combat/encounter.ts` states plainly that it
 * owns that event, because `EncounterEnded` carries `civiliansLost` and
 * `collateralCost` and combat is the only system that knows either. This
 * encounter emits `EncounterStarted`, listens for `EncounterEnded`, and closes
 * its own books when it hears one. Emitting a second one here would give the
 * progression system two conflicting scorecards for the same fight.
 */

import type { EntityId, IEventBus, Vec3 } from '@/types';
import { clamp01, type IRandom } from '@/util';
import { intentForPower } from './brain';
import type { MonsterBrain } from './brain';
import type { IBossPhaseState, IBossScript, IMutableVec3 } from './types';

/* -------------------------------------------------------------------------- */
/* Stall guard                                                                */
/* -------------------------------------------------------------------------- */

/**
 * ENGAGED seconds after which a phase is force-advanced.
 *
 * The FSM has a watchdog for exactly this reason and encounters need the same
 * one: `requireSummonsCleared` is a hard AND, and a minion that fell through
 * the world, or a summon callback the host declined to service, would leave a
 * boss permanently unkillable — the single worst failure this system can
 * produce, because it looks like a design decision rather than a bug.
 *
 * Four minutes of the player standing inside the arena is not a scenario any
 * tuned phase reaches; `BossEncounter.stallTrips` counts it so it shows up in
 * the harness rather than as a fight that never ends.
 */
export const PHASE_STALL_SECONDS = 240;

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

/** The ally whose life the encounter may be about. */
export interface IEncounterAlly {
  readonly id: EntityId;
  readonly displayName: string;
  /** Live position, read every frame. Owned by the hero-NPC workstream. */
  readonly position: Vec3;
}

export interface IBossEncounterOptions {
  readonly bus: IEventBus;
  readonly script: IBossScript;
  /** The boss's brain. The encounter writes `phaseResolved` on it, only. */
  readonly boss: MonsterBrain;
  /** Deterministic stream, for pulse jitter. */
  readonly rng: IRandom;
  /**
   * The registered ally, when the script has a rescue beat.
   *
   * The hero-NPC workstream owns this actor completely — its behaviour, its
   * health, its getting back up. The two systems coordinate through ONE event:
   * `AllyDowned`. This encounter fires it when the script's clock runs out,
   * and consumes an externally fired one so the beat can never resolve twice.
   */
  readonly ally?: IEncounterAlly;
  /**
   * Place a phase's minions. The host owns spawning; the script only says how
   * many and of what. Returns the ids so the encounter can watch them die.
   */
  readonly onSummon?: (archetypeId: string, count: number, origin: Vec3) => readonly EntityId[];
}

/* -------------------------------------------------------------------------- */
/* Encounter                                                                  */
/* -------------------------------------------------------------------------- */

export class BossEncounter {
  readonly script: IBossScript;
  readonly bossId: EntityId;

  private readonly bus: IEventBus;
  private readonly boss: MonsterBrain;
  private readonly rng: IRandom;
  private readonly ally: IEncounterAlly | undefined;
  private readonly onSummon: IBossEncounterOptions['onSummon'];

  private phaseIndex = 0;
  /** ENGAGED seconds in the current phase. Only runs while the player is near. */
  private engagedSeconds = 0;
  /** Wall-clock seconds in the current phase, which nothing can pause. */
  private phaseSeconds = 0;
  private hitsThisPhase = 0;
  private pulseTimer = 0;
  private pulses = 0;

  private readonly summons = new Set<EntityId>();

  private begun = false;
  private closed = false;
  private startTime = 0;
  private elapsedTotal = 0;

  /** Times the stall guard had to rescue this encounter. Should stay 0. */
  stallTrips = 0;

  /** The ally beat: pending → consumed exactly once, by rescue or by defeat. */
  private allyBeatConsumed = false;
  private allySurvivedFlag = true;
  private allyDownEmittedHere = false;

  private readonly scratch: IMutableVec3 = { x: 0, y: 0, z: 0 };

  constructor(options: IBossEncounterOptions) {
    this.bus = options.bus;
    this.script = options.script;
    this.boss = options.boss;
    this.bossId = options.boss.id;
    this.rng = options.rng;
    this.ally = options.ally;
    this.onSummon = options.onSummon;
    // A boss is gated from construction, before any phase has been entered.
    // The default must be the SAFE one: an un-begun encounter that left the
    // boss killable would delete him during his own establishing shot.
    this.boss.phaseResolved = false;
  }

  /* ---------------------------------------------------------------------- */
  /* Queries                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * THE GATE, readable directly.
   *
   * The combat resolver reads its own mirror of this (`ICombatTarget
   * .phaseResolved`, set from the `BossPhaseChanged` event). This accessor is
   * for the HUD, the harness and anything that would rather poll than
   * subscribe — it is the same boolean, from the same source.
   */
  get phaseResolved(): boolean {
    return this.boss.phaseResolved;
  }

  get started(): boolean {
    return this.begun;
  }

  get finished(): boolean {
    return this.closed;
  }

  get currentPhaseIndex(): number {
    return this.phaseIndex;
  }

  get isFinalPhase(): boolean {
    return this.phaseIndex >= this.script.phases.length - 1;
  }

  /** Minions from the current phase still alive. */
  get summonsAlive(): number {
    return this.summons.size;
  }

  /** Did the registered ally survive? True when there is no ally at all. */
  get allySurvived(): boolean {
    return this.allySurvivedFlag;
  }

  /** Pressure pulses this encounter has released. Diagnostics and tests. */
  get pulseCount(): number {
    return this.pulses;
  }

  state(): IBossPhaseState {
    const phase = this.script.phases[this.phaseIndex]!;
    const allyDownIn =
      this.ally === undefined || this.allyBeatConsumed || phase.allyDownAtSeconds === undefined
        ? undefined
        : Math.max(0, phase.allyDownAtSeconds - this.phaseSeconds);
    return {
      encounterId: this.script.encounterId,
      bossId: this.bossId,
      phaseIndex: this.phaseIndex,
      phaseId: phase.id,
      kind: phase.kind,
      title: phase.title,
      elapsed: this.engagedSeconds,
      remaining: Math.max(0, phase.durationSeconds - this.engagedSeconds),
      hits: this.hitsThisPhase,
      hitsRequired: phase.hitsToAdvance,
      summonsAlive: this.summons.size,
      isFinalPhase: this.isFinalPhase,
      phaseResolved: this.boss.phaseResolved,
      finished: this.closed,
      allySurvived: this.allySurvivedFlag,
      allyDownIn,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Open the encounter.
   *
   * Emits `EncounterStarted`, which is what the audio system keys the
   * tier-sized roar and the boss music off, what the crowd keys its panic off,
   * and what combat's `EncounterTracker` keys the scorecard off. Then enters
   * phase 0 — which, unless the script is a single-phase one, closes the gate.
   */
  begin(time: number): void {
    if (this.begun) return;
    this.begun = true;
    this.startTime = time;

    const participants: EntityId[] = [this.bossId];
    if (this.ally !== undefined) participants.push(this.ally.id);

    this.bus.emit('EncounterStarted', {
      encounterId: this.script.encounterId,
      threatTier: this.boss.archetype.threatTier,
      position: this.boss.position,
      radius: this.script.arenaRadiusMetres,
      participantIds: participants,
      isBoss: true,
    });

    this.enterPhase(0);
  }

  /**
   * Advance the script.
   *
   * @param dt seconds
   * @param playerPosition the streaming focus. Engagement and the rescue check
   *   are both measured against it.
   */
  update(dt: number, playerPosition: Vec3): void {
    if (!this.begun || this.closed) return;
    this.elapsedTotal += dt;
    this.phaseSeconds += dt;

    const phase = this.script.phases[this.phaseIndex]!;

    /* ---- engagement ---------------------------------------------------- */
    const dx = playerPosition.x - this.boss.position.x;
    const dz = playerPosition.z - this.boss.position.z;
    const engaged = Math.hypot(dx, dz) <= phase.engageRadiusMetres;
    if (engaged) this.engagedSeconds += dt;

    /* ---- scripted pressure --------------------------------------------- */
    if (phase.pulsePeriodSeconds > 0) {
      this.pulseTimer -= dt;
      if (this.pulseTimer <= 0) {
        this.pulseTimer = phase.pulsePeriodSeconds;
        this.pulse(phase.pulseRangeMetres, phase.pulseHalfAngleRad, phase.pulsePower, playerPosition);
      }
    }

    /* ---- the ally beat -------------------------------------------------- */
    this.tickAllyBeat(phase.allyDownAtSeconds, phase.allyRescueRadiusMetres, playerPosition);

    /* ---- advance? ------------------------------------------------------- */
    if (this.isFinalPhase) return;
    if (!this.canAdvance(phase)) {
      if (this.engagedSeconds <= PHASE_STALL_SECONDS) return;
      this.stallTrips++;
      console.warn(
        `[monster.encounter] '${this.script.encounterId}' phase '${phase.id}' stalled for ` +
          `${this.engagedSeconds.toFixed(1)}s of engaged time; force-advancing`
      );
    }
    this.enterPhase(this.phaseIndex + 1);
  }

  /**
   * Everything the current phase is still waiting for.
   *
   * Written as one expression on purpose: every condition is visible at once,
   * and health is visibly not among them.
   */
  private canAdvance(phase: IBossScript['phases'][number]): boolean {
    if (this.engagedSeconds < phase.durationSeconds) return false;
    if (this.hitsThisPhase < phase.hitsToAdvance) return false;
    if (phase.requireSummonsCleared === true && this.summons.size > 0) return false;
    if (phase.allyDownAtSeconds !== undefined && !this.allyBeatConsumed) return false;
    return true;
  }

  /**
   * Enter a phase and — the important half — publish the gate.
   *
   * `isFinalPhase` is the ONLY thing that opens the boss to a killing blow.
   * Every script's last phase is a `finisher` with zero duration and zero
   * required hits, so entering it IS the resolution: the punch the player was
   * already throwing now lands.
   */
  private enterPhase(index: number): void {
    const previous = this.phaseIndex;
    this.phaseIndex = index;
    this.engagedSeconds = 0;
    this.phaseSeconds = 0;
    this.hitsThisPhase = 0;
    this.pulses = 0;

    const phase = this.script.phases[index]!;
    this.pulseTimer =
      phase.pulsePeriodSeconds > 0 ? this.rng.range(0.2, phase.pulsePeriodSeconds) : 0;

    /* minions */
    this.summons.clear();
    if (phase.summonArchetypeId !== undefined && (phase.summonCount ?? 0) > 0) {
      const ids =
        this.onSummon?.(phase.summonArchetypeId, phase.summonCount ?? 0, this.boss.position) ?? [];
      for (const id of ids) this.summons.add(id);
    }

    const isFinal = index >= this.script.phases.length - 1;

    /* ── THE GATE ──────────────────────────────────────────────────────
       Written locally so a poller sees it on the same frame, AND published
       so the combat resolver's own mirror is set from the event. Both, not
       either: the local flag is for the HUD, the event is the contract. */
    this.boss.phaseResolved = isFinal;

    this.bus.emit('BossPhaseChanged', {
      entityId: this.bossId,
      specId: this.boss.archetype.id,
      previousPhase: previous,
      phase: index,
      healthFraction: clamp01(this.boss.health / Math.max(1, this.boss.archetype.maxHealth)),
      isFinalPhase: isFinal,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* The ally beat                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * The Deep Sea King's entire design, in one method.
   *
   * A wall clock the player cannot negotiate with, and one radius. Arrive and
   * the ally lives; do not and he does not. The fight afterwards is IDENTICAL
   * either way — the boss is no harder and no easier, and the encounter still
   * ends with one punch. That is the point: this is the only thing in the game
   * the player can actually lose, so it must not also be a difficulty setting.
   *
   * The clock runs on WALL time, not engaged time. Every other phase condition
   * pauses when the player leaves, because those are about the fight. This one
   * is about somebody else's life, and it does not care where the player is.
   */
  private tickAllyBeat(
    downAtSeconds: number | undefined,
    rescueRadius: number | undefined,
    playerPosition: Vec3
  ): void {
    if (downAtSeconds === undefined || this.ally === undefined || this.allyBeatConsumed) return;

    /* rescued? */
    const radius = rescueRadius ?? 12;
    const dx = playerPosition.x - this.ally.position.x;
    const dz = playerPosition.z - this.ally.position.z;
    if (Math.hypot(dx, dz) <= radius) {
      this.allyBeatConsumed = true;
      this.allySurvivedFlag = true;
      return;
    }

    /* out of time */
    if (this.phaseSeconds < downAtSeconds) return;
    this.allyBeatConsumed = true;
    this.allySurvivedFlag = false;
    this.allyDownEmittedHere = true;
    this.bus.emit('AllyDowned', {
      entityId: this.ally.id,
      displayName: this.ally.displayName,
      position: this.ally.position,
      killerId: this.bossId,
    });
  }

  /**
   * An `AllyDowned` arrived from somewhere else.
   *
   * The hero-NPC workstream owns Mumen Rider's health and will fire this
   * itself if the fight goes badly before the script's clock runs out. When it
   * does, the beat is already resolved and this encounter must not fire a
   * second one — so the two systems agree on the outcome without ever
   * referencing each other.
   */
  onAllyDowned(entityId: EntityId): void {
    if (this.ally === undefined || entityId !== this.ally.id) return;
    if (this.allyDownEmittedHere) return; // our own event, echoed back
    this.allyBeatConsumed = true;
    this.allySurvivedFlag = false;
  }

  /* ---------------------------------------------------------------------- */
  /* Feedback from the world                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * The boss was hit.
   *
   * Counted, never subtracted. `EntityDamaged` for a gated boss reports
   * `amount: 0` (combat's `bossPhaseChipDamage` ships at 0) — which is exactly
   * right, and is why the phase counts HITS rather than damage. A hit that
   * dealt nothing still advanced the story.
   */
  onBossHit(): void {
    if (!this.begun || this.closed) return;
    this.hitsThisPhase++;
  }

  /** A minion died. When the phase required a clear board, it just got closer. */
  onMonsterKilled(entityId: EntityId): void {
    this.summons.delete(entityId);
  }

  /**
   * The boss died.
   *
   * Only reachable through the gate: the resolver refuses to kill a boss whose
   * phase has not resolved, so arriving here means the script finished. The
   * encounter closes its books and says nothing — `EncounterEnded` belongs to
   * combat, which is the only system that knows what the fight cost.
   */
  onBossKilled(): void {
    this.closed = true;
  }

  /** `EncounterEnded` arrived for this encounter. Close, whoever ended it. */
  onEncounterEnded(encounterId: string): void {
    if (encounterId !== this.script.encounterId) return;
    this.closed = true;
  }

  /** Total seconds since `begin`. */
  get duration(): number {
    return this.elapsedTotal;
  }

  /** Seconds since boot at which this encounter opened. */
  get openedAt(): number {
    return this.startTime;
  }

  /* ---------------------------------------------------------------------- */
  /* Pressure                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * One scripted pressure pulse — a meteoric burst, a beam volley, a wave.
   *
   * Aimed at the player and released from the boss. Like every monster attack
   * it is a `ShockwaveFired` and nothing else: the survival phase is survivable
   * because the protagonist cannot be hurt, and it is still a set piece because
   * everything AROUND him can.
   */
  private pulse(range: number, halfAngle: number, power: number, at: Vec3): void {
    const dx = at.x - this.boss.position.x;
    const dz = at.z - this.boss.position.z;
    const length = Math.hypot(dx, dz) || 1;

    this.scratch.x = this.boss.position.x;
    this.scratch.y = this.boss.position.y + this.boss.archetype.bodyHeightMetres * 0.6;
    this.scratch.z = this.boss.position.z;

    this.pulses++;
    this.bus.emit('ShockwaveFired', {
      origin: this.scratch,
      direction: { x: dx / length, y: 0, z: dz / length },
      power,
      range,
      angle: halfAngle,
      intent: intentForPower(power),
      punchKind: 'environmental',
      sourceId: this.bossId,
    });
  }
}
