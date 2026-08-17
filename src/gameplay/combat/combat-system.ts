/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  COMBAT SYSTEM — THE THREE VERBS                                         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 *   TAP        Normal Punch. Instant, single target, lethal, 1.2 m of reach,
 *              almost no collateral. Rapid taps chain into Consecutive Normal
 *              Punches, which escalate in power and therefore — because the
 *              audio system derives pitch from power — in pitch and shake.
 *
 *   HOLD       Serious Punch. Charges 0 to 1 over 1.2 s. Release fires a 22°
 *              cone that grows from 40 m to 180 m with charge and instantly
 *              kills everything inside it, detaches every fracture chunk it
 *              touches, and pushes a pressure wave through crowd, debris and
 *              vehicles.
 *
 *   LAND HARD  Ground slam. Physics already emits `PlayerLanded` with
 *              `createsCrater` above a 15 m fall; this converts it into the
 *              radial version of the same resolution — which means a leap
 *              across the district is itself a weapon, and a landing spot is
 *              a decision.
 *
 * ── THE DECISION THE PLAYER MAKES EVERY FIGHT ──────────────────────────────
 * The Serious Punch trivially solves any encounter and levels three blocks.
 * The Normal Punch costs nothing and requires you to physically reach the
 * monster before it reaches a civilian. That is the entire game loop, and
 * every number in `tuning.ts` exists to keep the two genuinely competitive.
 *
 * ── WHAT THIS FILE IS NOT ALLOWED TO DO ────────────────────────────────────
 * It reads `InputState` and emits `GameEvent`s. It does not draw the cone
 * (VFX does, off `ShockwaveFired`), it does not break the buildings
 * (destruction does, off the same event), it does not shake the camera or stop
 * the clock (the renderer does, off `EntityKilled`), and it does not play a
 * sound. It imports `@/types`, `@/util` and its own siblings — nothing else,
 * mechanically enforced by `__tests__/imports.test.ts`.
 */

import type {
  DistrictType,
  EntityId,
  GameEventOf,
  IEventBus,
  InputState,
  Vec3,
} from '@/types';
import { clamp01, createRng, lerp, type IRandom } from '@/util';
import { PunchChain, chainKind, chainPower } from './chain';
import { BoredomMeter } from './boredom';
import { EncounterTracker } from './encounter';
import { HitResolver } from './resolver';
import { forecastYen, StructureIndex, type ICombatStructureSpec } from './structures';
import { LinearScan, TargetRegistry, type ICombatTargetSpec } from './targets';
import {
  DEFAULT_COMBAT_TUNING,
  resolveCombatTuning,
  type ICombatTuning,
  type ICombatTuningPatch,
} from './tuning';
import type {
  HeroismKind,
  IAttackerSource,
  ICombatBroadPhase,
  IEncounterResult,
  IEncounterStartLike,
  IPunchOutcome,
  IPunchRequest,
} from './types';

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

export interface ICombatSystemOptions {
  readonly bus: IEventBus;
  /** Who is throwing the punches, and from where. */
  readonly attacker: IAttackerSource;
  readonly tuning?: ICombatTuningPatch;
  /**
   * Candidate supplier. In the shipped game this wraps `src/spatial`'s
   * `DynamicEntityGrid`, whose cone query is the measured broad phase.
   * Omitted, combat falls back to a linear scan over its own registry — which
   * is correct, and fine for a test, and would not be fine for a city.
   */
  readonly broadPhase?: ICombatBroadPhase;
  /** District under a point, for the property-damage invoice. */
  readonly districtAt?: (position: Vec3) => DistrictType;
  /** Line-of-sight, for `witnessed`. */
  readonly lineOfSight?: (from: Vec3, to: Vec3) => boolean;
  /** Deterministic seed. Same seed plus same input script = same events. */
  readonly seed?: number | string;
  /** Starting boredom. Defaults to the tuning baseline. */
  readonly boredom?: number;
}

/** Live state for the HUD and the harness. */
export interface ICombatDiagnostics {
  readonly charging: boolean;
  readonly charge: number;
  readonly chargeSeconds: number;
  /** Cone length the current charge would produce, in metres. */
  readonly chargeRangeMetres: number;
  /** Estimated yen the current charge would cost. THE price tag. */
  readonly chargeForecastYen: number;
  readonly chainLength: number;
  readonly chainWindowRemaining: number;
  readonly boredom: number;
  readonly punches: number;
  readonly encounterId: string | undefined;
  readonly sessionYen: number;
}

/* -------------------------------------------------------------------------- */
/* System                                                                     */
/* -------------------------------------------------------------------------- */

export class CombatSystem {
  readonly bus: IEventBus;
  readonly tuning: ICombatTuning;
  readonly targets: TargetRegistry;
  readonly structures: StructureIndex;
  readonly resolver: HitResolver;
  readonly boredomMeter: BoredomMeter;
  readonly encounters: EncounterTracker;
  readonly chain: PunchChain;

  private readonly attacker: IAttackerSource;
  private readonly rng: IRandom;
  private readonly unsubscribes: (() => void)[] = [];

  private readonly origin: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  private readonly facing: { x: number; y: number; z: number } = { x: 0, y: 0, z: -1 };

  /** Seconds the punch button has been held, carried across the release frame. */
  private holdSeconds = 0;
  private punchHeld = false;
  private time = 0;
  /** Outcome of the most recent punch, for the harness and the HUD. */
  private lastOutcome: IPunchOutcome | undefined;
  /**
   * When the current encounter's books close, or `undefined` while hostiles
   * remain. The gap between the last kill and this moment is what lets a
   * staggered collapse finish falling and be billed.
   */
  private settleAt: number | undefined;
  private lastEncounterResult: IEncounterResult | undefined;
  private disposed = false;

  constructor(options: ICombatSystemOptions) {
    this.bus = options.bus;
    this.tuning = resolveCombatTuning(options.tuning);
    this.attacker = options.attacker;
    this.rng = createRng(options.seed ?? 'combat');

    this.targets = new TargetRegistry();
    this.structures = new StructureIndex();
    this.chain = new PunchChain(this.tuning);

    this.resolver = new HitResolver({
      bus: this.bus,
      registry: this.targets,
      tuning: this.tuning,
      broadPhase: options.broadPhase ?? new LinearScan(this.targets),
      structures: this.structures,
      rng: this.rng.derive('resolver'),
      lineOfSight: options.lineOfSight,
    });

    this.boredomMeter = new BoredomMeter({
      bus: this.bus,
      tuning: this.tuning,
      playerId: options.attacker.id,
      initial: options.boredom,
    });

    this.encounters = new EncounterTracker({
      bus: this.bus,
      tuning: this.tuning,
      districtAt: options.districtAt,
    });

    this.unsubscribes.push(
      // The ground slam. Physics decides what a hard landing IS; combat only
      // decides what it MEANS.
      this.bus.on('PlayerLanded', (event) => this.onPlayerLanded(event)),
      // The boss gate: narrative, never HP.
      this.bus.on('BossPhaseChanged', (event) => this.onBossPhaseChanged(event)),
      // Scoring starts when the encounter system says a fight started.
      this.bus.on('EncounterStarted', (event) => this.onEncounterStarted(event))
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Registration                                                           */
  /* ---------------------------------------------------------------------- */

  /** Register something that can be hit. */
  addTarget(spec: ICombatTargetSpec): ReturnType<TargetRegistry['add']> {
    return this.targets.add(spec);
  }

  /** Register a breakable structure box, for the forecast and the sweep. */
  addStructure(spec: ICombatStructureSpec): ReturnType<StructureIndex['add']> {
    return this.structures.add(spec);
  }

  /* ---------------------------------------------------------------------- */
  /* Per-frame                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Read the input and throw whatever it asks for.
   *
   * @param input the frame's `InputState` — nothing else. No DOM, no events.
   * @param dt    scaled seconds since the last frame.
   * @param time  seconds since boot, used for the chain window and scoring.
   */
  update(input: InputState, dt: number, time: number): void {
    if (this.disposed) return;
    this.time = time;
    this.encounters.tick(time);
    this.chain.update(time);

    const punch = input.buttons.punch;
    const heavy = input.buttons.heavyPunch;

    /* ---- charge bookkeeping -------------------------------------------
       `holdTime` is 0 on the release frame, so the PEAK has to be carried
       across it or every charged punch would fire at charge 0.

       The tracker's `holdTime` is authoritative when it is moving; the `dt`
       accumulation is the floor beneath it, so a backend that reports a stale
       or absent hold still charges at real time rather than not at all. */
    if (punch.held) {
      this.punchHeld = true;
      this.holdSeconds = Math.max(punch.holdTime, this.holdSeconds + Math.max(0, dt));
    }

    /* ── TAP OR HOLD — DISCRIMINATED ON RELEASE ──────────────────────────
       Both verbs come out of the same button, so something has to tell them
       apart, and the press edge cannot: at the moment the thumb goes down
       there is no information about which one this is. Firing the jab there
       anyway means every charge begins by throwing a free kill the player did
       not choose to make — which is the central decision of the game, made
       wrongly, by a button they were still pressing.

       So: released at or before `tapMaxHoldSeconds` is a tap and the punch
       lands immediately; held past it is a charge, committed, and the jab is
       never thrown. ~140 ms of latency on the light attack, and the decision
       stays the player's. */
    if (this.tuning.normalPunchOnPress) {
      // Retained only so the rejected model can be re-measured against the
      // shipped one in a playtest. See `normalPunchOnPress` in tuning.ts.
      if (punch.pressed) this.normalPunch();
      if (heavy.pressed || punch.released) {
        if (heavy.pressed) this.seriousPunch(this.chargeFromHold(this.holdSeconds, heavy.value));
        this.clearHold();
      }
      this.boredomMeter.update(dt, this.encounters.active);
      this.settleEncounter(time);
      return;
    }

    // `heavyPunch.pressed` is what touch and keyboard produce on release, via
    // their own `ChargeTracker`. The synthetic driver has no charge tracker,
    // so a raw press/release of `punch` is honoured as the same gesture —
    // otherwise no scripted test could throw a serious punch at all. Both
    // doors land here, and `holdSeconds` is the shared source of truth.
    const releasing = heavy.pressed || punch.released;
    if (releasing && this.punchHeld) {
      if (this.holdSeconds <= this.tuning.tapMaxHoldSeconds && !heavy.pressed) {
        this.normalPunch();
      } else {
        this.seriousPunch(this.chargeFromHold(this.holdSeconds, heavy.value));
      }
      this.clearHold();
    } else if (releasing) {
      this.clearHold();
    }

    this.boredomMeter.update(dt, this.encounters.active);

    /* ---- close the books, once the dust has landed ---------------------- */
    if (this.encounters.active && this.encounters.cleared) {
      if (this.settleAt === undefined) {
        this.settleAt = time + this.tuning.encounterSettleSeconds;
      } else if (time >= this.settleAt) {
        this.finishEncounter();
      }
    } else {
      this.settleAt = undefined;
    }
  }

  private clearHold(): void {
    this.holdSeconds = 0;
    this.punchHeld = false;
  }

  /**
   * Charge 0..1 from the physical hold.
   *
   * The input system's own `heavyPunch.value` is computed against ITS charge
   * window (0.22 s to 1.0 s). Combat's window is 1.2 s and is a GAME tuning
   * value, not an input one, so the hold seconds are the source of truth and
   * the input ratio is only a fallback for a backend that reports no hold.
   */
  private chargeFromHold(seconds: number, fallbackRatio = 0): number {
    if (seconds <= 0) return clamp01(fallbackRatio);
    return clamp01(seconds / this.tuning.seriousChargeSeconds);
  }

  /* ---------------------------------------------------------------------- */
  /* Verb 1 — the tap                                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Throw a normal punch. Instant, lethal, one target, 1.2 m.
   *
   * Chained taps raise `power` geometrically and switch `punchKind` to
   * `consecutive`, which is what the audio system's chain voices key off.
   */
  normalPunch(): IPunchOutcome {
    const index = this.chain.punch(this.time);
    this.readAttacker();

    const request: IPunchRequest = {
      origin: { ...this.origin },
      direction: { ...this.facing },
      power: chainPower(index, this.tuning),
      radius: this.tuning.normalReachMetres,
      kind: chainKind(index, this.tuning),
      intent: this.tuning.normalPunchIntent,
      time: this.time,
      sourceId: this.attacker.id,
      halfAngle: this.tuning.normalHalfAngleRad,
      maxTargets: this.tuning.normalMaxTargets,
      chainIndex: index,
      knockbackMps: this.tuning.normalKnockbackMps,
    };
    return this.throwPunch(request, 'normal', index);
  }

  /* ---------------------------------------------------------------------- */
  /* Verb 2 — the hold                                                      */
  /* ---------------------------------------------------------------------- */

  /**
   * Release a Serious Punch at `charge` 0..1.
   *
   * Range scales 40 m to 180 m, power 1e5 to 2.5e6, and the intent escalates
   * from `serious` to `full` at half charge. Everything inside the 22° cone
   * dies at once — monsters, civilians, Mumen Rider, and whatever was standing
   * behind them for the next nine blocks.
   */
  seriousPunch(charge: number): IPunchOutcome {
    const c = clamp01(charge);
    this.readAttacker();

    const range = lerp(this.tuning.seriousRangeMinMetres, this.tuning.seriousRangeMaxMetres, c);
    const power = lerp(this.tuning.seriousPowerMin, this.tuning.seriousPowerMax, c);
    const intent = c >= this.tuning.seriousFullIntentCharge ? 'full' : 'serious';

    const request: IPunchRequest = {
      origin: { ...this.origin },
      direction: { ...this.facing },
      power,
      radius: range,
      kind: 'serious',
      intent,
      time: this.time,
      sourceId: this.attacker.id,
      halfAngle: this.tuning.seriousHalfAngleRad,
      charge: c,
      knockbackMps: this.tuning.seriousKnockbackMps,
      shockwave: {
        range,
        angle: this.tuning.seriousHalfAngleRad,
        force: power,
        destroysTerrain: true,
        travelTime: this.tuning.seriousTravelSeconds,
      },
    };
    // A serious punch breaks the chain: it is a different verb, not a louder
    // tap, and letting it inherit a chain multiplier would make the loudest
    // sound in the game a function of button mashing.
    this.chain.reset();
    return this.throwPunch(request, 'serious', 0);
  }

  /* ---------------------------------------------------------------------- */
  /* Verb 3 — the landing                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Convert a cratering landing into a radial resolution.
   *
   * The lethal radius is small and the pressure radius is 2.5x larger, so a
   * bad landing spot knocks a crowd flat far more often than it kills them —
   * but it does kill them, and that is the price of using traversal as a
   * weapon.
   */
  groundSlam(position: Vec3, impactSpeed: number, fallHeight: number): IPunchOutcome {
    const killRadius = Math.min(
      this.tuning.slamKillRadiusMaxMetres,
      this.tuning.slamKillRadiusBaseMetres + fallHeight * this.tuning.slamKillRadiusPerFallMetre
    );
    const pressureRadius = killRadius * this.tuning.slamPressureRadiusFactor;
    const power = Math.max(1, impactSpeed) * this.tuning.slamPowerPerImpactSpeed;

    const request: IPunchRequest = {
      origin: { x: position.x, y: position.y, z: position.z },
      // Straight up: the impulse blend adds the axis, so everything the crater
      // catches goes up and outward rather than sideways into a wall.
      direction: { x: 0, y: 1, z: 0 },
      power,
      radius: killRadius,
      kind: 'slam',
      intent: this.tuning.slamIntent,
      time: this.time,
      sourceId: this.attacker.id,
      halfAngle: Math.PI,
      knockbackMps: this.tuning.slamKnockbackMps,
      shockwave: {
        range: pressureRadius,
        angle: Math.PI,
        force: power,
        destroysTerrain: true,
        travelTime: 0,
      },
    };
    this.chain.reset();
    return this.throwPunch(request, 'slam', 0);
  }

  /* ---------------------------------------------------------------------- */
  /* Shared punch path                                                      */
  /* ---------------------------------------------------------------------- */

  private throwPunch(
    request: IPunchRequest,
    kind: 'normal' | 'serious' | 'slam',
    chainIndex: number
  ): IPunchOutcome {
    // Witnesses are counted BEFORE the punch resolves: a serious punch that
    // kills every witness in the cone would otherwise report an unwitnessed
    // kill, which is exactly backwards.
    const witnessed = this.resolver.isWitnessed(request.origin);
    const outcome = this.resolver.resolve(request);
    this.lastOutcome = outcome;
    this.encounters.recordPunch(kind, chainIndex, witnessed && outcome.kills > 0);
    return outcome;
  }

  private readAttacker(): void {
    this.attacker.getOrigin(this.origin);
    this.attacker.getFacing(this.facing);
  }

  /* ---------------------------------------------------------------------- */
  /* Encounters                                                             */
  /* ---------------------------------------------------------------------- */

  /** Start scoring a fight. Also driven automatically by `EncounterStarted`. */
  beginEncounter(start: IEncounterStartLike): void {
    this.encounters.begin({
      encounterId: start.encounterId,
      hostileIds: start.hostileIds,
      allyIds: start.allyIds,
      time: start.time ?? this.time,
      boredom: this.boredomMeter.value,
    });
  }

  /**
   * Close the fight, award the heroism it earned, and return the scorecard.
   *
   * Two acts of heroism are credited HERE rather than reported by gameplay,
   * because only the scorecard knows whether they happened: finishing with no
   * collateral and no civilian losses (`cleanVictory`), and a fight that took
   * longer than `challengeSeconds` to close (`challenge`) — which, for this
   * character, is the rarest event in the game.
   */
  endEncounter(
    outcome: 'victory' | 'defeat' | 'fled' | 'aborted' = 'victory'
  ): IEncounterResult | undefined {
    if (!this.encounters.active) return undefined;
    return this.finishEncounter(outcome);
  }

  private finishEncounter(
    outcome: 'victory' | 'defeat' | 'fled' | 'aborted' = 'victory'
  ): IEncounterResult | undefined {
    this.settleAt = undefined;
    // Peek at the tallies BEFORE closing, so the heroism they earn is inside
    // the same scorecard rather than landing after it.
    const preview = this.encounters.end(this.time, this.boredomMeter.value, outcome);
    if (preview === undefined) return undefined;

    if (preview.victory && preview.timeToKill >= this.tuning.challengeSeconds) {
      this.boredomMeter.reportHeroism('challenge', preview.encounterId);
    }
    if (preview.victory && preview.propertyDamageYen <= 0 && preview.civiliansLost === 0) {
      this.boredomMeter.reportHeroism('cleanVictory', preview.encounterId);
    }
    // The scorecard is re-stamped with the boredom the heroism just produced,
    // so `boredomAfter` reflects the whole fight including its own reward.
    const result: IEncounterResult = { ...preview, boredomAfter: this.boredomMeter.value };
    this.lastEncounterResult = result;
    return result;
  }

  /** The most recent scorecard, including the heroism awarded on closing. */
  get lastResult(): IEncounterResult | undefined {
    return this.lastEncounterResult;
  }

  /* ---------------------------------------------------------------------- */
  /* Heroism                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Report an act of heroism. Lowers boredom; nothing else in the game does.
   *
   * `arrivedInTime` additionally emits `CivilianSaved`, because reaching
   * someone before the thing that was going to kill them is a rescue and the
   * rest of the game should hear about it.
   */
  reportHeroism(kind: HeroismKind, subjectId?: EntityId, position?: Vec3): void {
    if (kind === 'arrivedInTime' && subjectId !== undefined) {
      const at = position ?? this.targets.get(subjectId)?.position ?? this.origin;
      // `CivilianSaved` already lowers boredom through the meter's own
      // subscription, so this path must not double-credit it.
      this.bus.emit('CivilianSaved', {
        entityId: subjectId,
        position: at,
        byPlayer: true,
        reputationDelta: 8,
      });
      return;
    }
    this.boredomMeter.reportHeroism(kind, subjectId ?? '');
  }

  /* ---------------------------------------------------------------------- */
  /* Bus handlers                                                           */
  /* ---------------------------------------------------------------------- */

  private onPlayerLanded(event: GameEventOf<'PlayerLanded'>): void {
    if (!event.createsCrater) return;
    this.groundSlam(event.position, event.impactSpeed, event.fallHeight);
  }

  private onBossPhaseChanged(event: GameEventOf<'BossPhaseChanged'>): void {
    const target = this.targets.get(event.entityId);
    if (target === undefined) return;
    // THE gate. A boss becomes killable when the script says so, and by no
    // other means — no HP threshold, no damage total, no combo.
    target.phaseResolved = event.isFinalPhase;
  }

  private onEncounterStarted(event: GameEventOf<'EncounterStarted'>): void {
    if (this.encounters.active) return;
    const hostiles: EntityId[] = [];
    const allies: EntityId[] = [];
    for (const id of event.participantIds) {
      const target = this.targets.get(id);
      if (target === undefined) continue;
      if (target.faction === 'monster') hostiles.push(id);
      else if (target.faction === 'hero' && target.type !== 'player') allies.push(id);
    }
    this.encounters.begin({
      encounterId: event.encounterId,
      hostileIds: hostiles,
      allyIds: allies,
      time: this.time,
      boredom: this.boredomMeter.value,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Diagnostics                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * The charge's live price tag.
   *
   * This is the single most important number on the HUD: it is what turns
   * "hold to win" into a decision, because it tells the player what winning
   * that way costs before they let go.
   */
  chargeForecast(charge: number): { rangeMetres: number; yen: number; structures: number } {
    const c = clamp01(charge);
    const range = lerp(this.tuning.seriousRangeMinMetres, this.tuning.seriousRangeMaxMetres, c);
    this.readAttacker();
    const swept = this.structures.sweepCone(
      this.origin,
      this.facing,
      range,
      this.tuning.seriousHalfAngleRad
    );
    return { rangeMetres: range, yen: forecastYen(swept), structures: swept.length };
  }

  get lastPunch(): IPunchOutcome | undefined {
    return this.lastOutcome;
  }

  get boredom(): number {
    return this.boredomMeter.value;
  }

  diagnostics(): ICombatDiagnostics {
    const charge = this.chargeFromHold(this.holdSeconds);
    const forecast = this.chargeForecast(charge);
    const chain = this.chain.state(this.time);
    return {
      charging: this.punchHeld && this.holdSeconds >= this.tuning.seriousMinChargeSeconds,
      charge,
      chargeSeconds: this.holdSeconds,
      chargeRangeMetres: forecast.rangeMetres,
      chargeForecastYen: forecast.yen,
      chainLength: chain.length,
      chainWindowRemaining: chain.windowRemaining,
      boredom: this.boredomMeter.value,
      punches: this.resolver.punchCount,
      encounterId: this.encounters.encounterId,
      sessionYen: this.encounters.sessionYen,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribes) off();
    this.unsubscribes.length = 0;
    this.boredomMeter.dispose();
    this.encounters.dispose();
  }
}

/** Convenience factory mirroring the rest of the codebase's style. */
export function createCombatSystem(options: ICombatSystemOptions): CombatSystem {
  return new CombatSystem(options);
}

export { DEFAULT_COMBAT_TUNING };
