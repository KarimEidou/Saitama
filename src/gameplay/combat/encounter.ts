/**
 * ENCOUNTER SCORING — THE ONLY SCOREBOARD THAT MEANS ANYTHING
 *
 * There is no damage dealt here, no accuracy, no combo grade. Those metrics
 * describe a contest, and there is no contest: every hit is fatal and every
 * fight is already won. What is left is the part the player actually
 * controlled.
 *
 *   timeToKill          how long the world was in danger while you closed the
 *                       distance. The ONLY cost of choosing the normal punch.
 *   civiliansSaved/Lost who was still alive at the end.
 *   alliesSaved         whether Mumen Rider got up.
 *   propertyDamageYen   destroyed fracture-chunk mass x zoning value. The
 *                       invoice for choosing the serious punch.
 *   witnessed           whether anyone SAW. The Hero Association's entire
 *                       comedy in one boolean.
 *
 * ── WHERE THE NUMBERS COME FROM ────────────────────────────────────────────
 * All of them arrive as events. `ChunkDetached` carries the mass of every
 * piece the destruction system releases and where it fell; the district under
 * that point selects the yen rate. Combat never asks the destruction system
 * anything and never imports it — it just adds up what falls.
 *
 * ── WHO EMITS `EncounterEnded` ─────────────────────────────────────────────
 * This module does, on the frame the last registered hostile dies. Combat is
 * the only system that knows both that the fight is over AND what it cost, and
 * `EncounterEndedEvent` carries `civiliansLost` and `collateralCost` — so any
 * other owner would have to ask combat for them anyway.
 */

import type {
  DistrictType,
  EntityId,
  GameEventOf,
  IEventBus,
  Vec3,
} from '@/types';
import { saturate } from '@/util';
import { PROPERTY_DAMAGE_HALF_YEN, ZONING_YEN_PER_KG, type ICombatTuning } from './tuning';
import type { IEncounterResult } from './types';

export interface IEncounterTrackerOptions {
  readonly bus: IEventBus;
  readonly tuning: ICombatTuning;
  /**
   * District under a world position. Injected: zoning lives in `src/world`,
   * which combat may not import. Absent, every square metre of City Z is
   * priced at `defaultZoningYenPerKg`.
   */
  readonly districtAt?: (position: Vec3) => DistrictType;
}

/** Parameters for starting a fight. */
export interface IEncounterStart {
  readonly encounterId: string;
  /** Ids that must all die for this to be a victory. */
  readonly hostileIds: readonly EntityId[];
  /** Ids whose survival is scored. */
  readonly allyIds?: readonly EntityId[];
  /** Seconds since boot. */
  readonly time: number;
  /** Boredom at the start, recorded so the tone shift is legible afterwards. */
  readonly boredom: number;
}

/** Live tallies while a fight is running. */
interface ITally {
  encounterId: string;
  startTime: number;
  endTime: number;
  hostiles: Set<EntityId>;
  hostilesRemaining: Set<EntityId>;
  allies: Set<EntityId>;
  alliesDowned: number;
  kills: number;
  civiliansLost: number;
  civiliansSaved: number;
  debrisMassKg: number;
  propertyDamageYen: number;
  collateralCost: number;
  witnessed: number;
  seriousPunches: number;
  normalPunches: number;
  longestChain: number;
  boredomBefore: number;
  lastKillTime: number;
}

/**
 * Scores one fight at a time.
 *
 * The subscriptions stay live even between encounters, so collateral caused
 * outside a fight is still visible to the HUD via `sessionYen` — you can
 * absolutely bankrupt City Z without a monster anywhere in sight, and the game
 * should say so.
 */
export class EncounterTracker {
  private readonly bus: IEventBus;
  private readonly tuning: ICombatTuning;
  private readonly districtAt: ((position: Vec3) => DistrictType) | undefined;
  private readonly unsubscribes: (() => void)[] = [];

  private tally: ITally | undefined;
  private lastResult: IEncounterResult | undefined;

  /**
   * Authoritative clock, pushed in by the combat system each frame.
   *
   * The bus stamps `time` from `setFrame()`, which a headless simulation or a
   * unit test may never call — and a `timeToKill` that silently reads 0 in
   * tests is worse than no metric at all. So the tracker takes the caller's
   * clock and never trusts the stamp.
   */
  private clock = 0;

  /** Yen and mass accumulated since construction, encounter or not. */
  private sessionYenTotal = 0;
  private sessionMassTotal = 0;

  constructor(options: IEncounterTrackerOptions) {
    this.bus = options.bus;
    this.tuning = options.tuning;
    this.districtAt = options.districtAt;

    this.unsubscribes.push(
      this.bus.on('ChunkDetached', (event) => this.onChunkDetached(event)),
      this.bus.on('CivilianLost', () => this.onCivilianLost()),
      this.bus.on('CivilianSaved', () => this.onCivilianSaved()),
      this.bus.on('AllyDowned', (event) => this.onAllyDowned(event)),
      this.bus.on('EntityKilled', (event) => this.onEntityKilled(event))
    );
  }

  get active(): boolean {
    return this.tally !== undefined;
  }

  get encounterId(): string | undefined {
    return this.tally?.encounterId;
  }

  get result(): IEncounterResult | undefined {
    return this.lastResult;
  }

  get sessionYen(): number {
    return this.sessionYenTotal;
  }

  get sessionDebrisMassKg(): number {
    return this.sessionMassTotal;
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                              */
  /* ---------------------------------------------------------------------- */

  begin(start: IEncounterStart): void {
    this.clock = start.time;
    this.tally = {
      encounterId: start.encounterId,
      startTime: start.time,
      endTime: start.time,
      hostiles: new Set(start.hostileIds),
      hostilesRemaining: new Set(start.hostileIds),
      allies: new Set(start.allyIds ?? []),
      alliesDowned: 0,
      kills: 0,
      civiliansLost: 0,
      civiliansSaved: 0,
      debrisMassKg: 0,
      propertyDamageYen: 0,
      collateralCost: 0,
      witnessed: 0,
      seriousPunches: 0,
      normalPunches: 0,
      longestChain: 0,
      boredomBefore: start.boredom,
      lastKillTime: start.time,
    };
  }

  /**
   * Close the fight and emit `EncounterEnded`.
   *
   * @param boredom boredom AFTER the fight, so the scorecard shows the swing.
   */
  end(time: number, boredom: number, outcome: 'victory' | 'defeat' | 'fled' | 'aborted' = 'victory'):
    | IEncounterResult
    | undefined {
    const tally = this.tally;
    if (tally === undefined) return undefined;
    tally.endTime = time;
    this.clock = time;

    const result: IEncounterResult = {
      encounterId: tally.encounterId,
      // Time to kill is measured to the LAST kill, not to the moment the
      // player wandered off afterwards.
      timeToKill: Math.max(0, tally.lastKillTime - tally.startTime),
      civiliansSaved: tally.civiliansSaved,
      civiliansLost: tally.civiliansLost,
      alliesSaved: Math.max(0, tally.allies.size - tally.alliesDowned),
      alliesDowned: tally.alliesDowned,
      debrisMassKg: tally.debrisMassKg,
      propertyDamageYen: tally.propertyDamageYen,
      propertyDamageScore: saturate(tally.propertyDamageYen, PROPERTY_DAMAGE_HALF_YEN),
      collateralCost: tally.collateralCost,
      witnessed: tally.witnessed,
      kills: tally.kills,
      victory: tally.hostilesRemaining.size === 0,
      seriousPunches: tally.seriousPunches,
      normalPunches: tally.normalPunches,
      longestChain: tally.longestChain,
      boredomBefore: tally.boredomBefore,
      boredomAfter: boredom,
    };

    this.lastResult = result;
    this.tally = undefined;

    this.bus.emit('EncounterEnded', {
      encounterId: result.encounterId,
      outcome,
      duration: Math.max(0, tally.endTime - tally.startTime),
      civiliansLost: result.civiliansLost,
      // ── UNIT MATTERS HERE, AND IT IS NOT YEN ─────────────────────────────
      // `collateralCost` on this event has to be in the SAME unit as
      // `ChunkDetached.collateralCost`, because a consumer that accumulates
      // the per-chunk figure and then reconciles it against the total will
      // otherwise be comparing two quantities four orders of magnitude apart
      // and the yen figure wins every time. The player-facing invoice is
      // `IEncounterResult.propertyDamageYen`; this is the accounting figure.
      collateralCost: result.collateralCost,
    });
    return result;
  }

  /** True once every registered hostile is dead. */
  get cleared(): boolean {
    return this.tally !== undefined && this.tally.hostilesRemaining.size === 0;
  }

  /* ---------------------------------------------------------------------- */
  /* Punch bookkeeping — pushed in by the combat system                     */
  /* ---------------------------------------------------------------------- */

  recordPunch(kind: 'normal' | 'serious' | 'slam', chainIndex: number, witnessed: boolean): void {
    const tally = this.tally;
    if (tally === undefined) return;
    if (kind === 'normal') tally.normalPunches++;
    else tally.seriousPunches++;
    if (chainIndex > tally.longestChain) tally.longestChain = chainIndex;
    if (witnessed) tally.witnessed++;
  }

  /* ---------------------------------------------------------------------- */
  /* Bus-driven                                                             */
  /* ---------------------------------------------------------------------- */

  private onChunkDetached(event: GameEventOf<'ChunkDetached'>): void {
    const rate =
      this.districtAt === undefined
        ? this.tuning.defaultZoningYenPerKg
        : ZONING_YEN_PER_KG[this.districtAt(event.position)];
    const yen = event.mass * rate;
    this.sessionMassTotal += event.mass;
    this.sessionYenTotal += yen;

    const tally = this.tally;
    if (tally === undefined) return;
    tally.debrisMassKg += event.mass;
    tally.propertyDamageYen += yen;
    tally.collateralCost += event.collateralCost;
  }

  private onCivilianLost(): void {
    if (this.tally !== undefined) this.tally.civiliansLost++;
  }

  private onCivilianSaved(): void {
    if (this.tally !== undefined) this.tally.civiliansSaved++;
  }

  private onAllyDowned(event: GameEventOf<'AllyDowned'>): void {
    const tally = this.tally;
    if (tally === undefined) return;
    if (tally.allies.has(event.entityId)) tally.alliesDowned++;
  }

  private onEntityKilled(event: GameEventOf<'EntityKilled'>): void {
    const tally = this.tally;
    if (tally === undefined) return;
    if (!tally.hostiles.has(event.entityId)) return;
    tally.hostilesRemaining.delete(event.entityId);
    tally.kills++;
    tally.lastKillTime = this.clock;
  }

  /** Advance the authoritative clock. Called once per frame. */
  tick(time: number): void {
    this.clock = time;
  }

  dispose(): void {
    for (const off of this.unsubscribes) off();
    this.unsubscribes.length = 0;
  }
}
