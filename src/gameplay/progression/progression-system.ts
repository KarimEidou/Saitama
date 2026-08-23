/**
 * HERO ASSOCIATION PROGRESSION
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  RANK DOES NOT MOVE ON KILLS.
 *
 *  `EntityKilled` increments `killsByTier` and nothing else. Not one hero
 *  point. `EntityKilledEvent.rewardPoints` is deliberately ignored for rank —
 *  it is combat's estimate of a fight's significance, and this system uses it
 *  only to weigh how newsworthy an incident was, never as an award.
 *
 *  Points come from an INCIDENT REPORT, filed when an encounter ends, and the
 *  report is scored on:
 *
 *    RESOLVED INCIDENTS  x1.00 with a crowd, x0.06 with nobody there, and a
 *                        x0.75 floor when the Association dispatched you
 *    WITNESSED SAVES     12 pts x corroboration; 0.4 pts with nobody there
 *    REPORTED COLLATERAL x0.55 floor with nobody there, rising to x1.00
 *
 *  Credit needs an audience. Blame does not. A hero who flattens a block in an
 *  empty district at 3am still answers for the block; a hero who saves nine
 *  people in the same district gets a shrug. That asymmetry is the system, and
 *  every constant in `constants.ts` exists to serve it.
 *
 *  Genos, standing in the same fight, is credited at 2.4x because he gives a
 *  statement with sensor recordings while the player leaves. He will pass the
 *  player on the ladder. He is meant to.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Imports nothing but `@/types`, `@/util` and its own module. Every input
 * arrives on the event bus.
 */

import type {
  IEventBus,
  IHeroRank,
  IProgressionState,
  IProgressionSystem,
  ThreatTier,
  Vec3,
} from '@/types';
import { clamp, createLogger } from '@/util';
import {
  BOREDOM_ON_ERRAND_COMPLETE,
  BOREDOM_ON_MISSED_SALE,
  BOREDOM_ON_QUEST_FAILED,
  INCIDENT_ATTRIBUTION_RADIUS,
  INCIDENT_DISPATCHED_MULTIPLIER,
  INCIDENT_POINTS_BY_TIER,
  INCIDENT_UNWITNESSED_MULTIPLIER,
  INCIDENT_WITNESSED_MULTIPLIER,
  PLAYER_FAULT_MULTIPLIER,
  POINTS_PER_CIVILIAN_LOST,
  POINTS_PER_COLLATERAL_UNIT,
  POINTS_PER_KILL,
  POINTS_PER_UNWITNESSED_SAVE,
  POINTS_PER_WITNESSED_SAVE,
  REPUTATION_MAX,
  REPUTATION_MIN,
  REPUTATION_PER_COLLATERAL_UNIT,
  REPUTATION_PER_WITNESSED_SAVE,
  START_HERO_NAME,
  START_REPUTATION,
  type HeroicDeed,
  type RivalId,
} from './constants';
import { BoredomModel } from './boredom';
import { RivalTracker, type IRivalSnapshot } from './rivals';
import { START_POINTS, formatRank, rankFromPoints } from './rank-ladder';
import { WitnessField, mergeReports, type IWitnessReport } from './witness';

const log = createLogger('gameplay.progression');

/**
 * Seconds an incident may stay open without an `EncounterEnded`.
 *
 * The producers do not guarantee a 1:1 pairing — combat tracks one encounter at
 * a time and ignores the rest, while the monster system announces one per
 * spawned wave — so without an upper bound the map grows for the whole session
 * and every kill within 200 m of a long-dead encounter is credited to a report
 * that will never be filed. Generous enough that no real fight is evicted mid-way.
 */
const INCIDENT_MAX_AGE_SECONDS = 600;

/** Cap on the session incident log, so a long session cannot grow unbounded. */
const REPORT_LOG_LIMIT = 128;

/** `value` when it is a usable number, otherwise `fallback` (loudly). */
function finiteOr(value: number, fallback: number, field: string): number {
  if (Number.isFinite(value)) return value;
  log.warn(`save field ${field} was ${String(value)}; using ${fallback}`);
  return fallback;
}

/** An incident being accumulated between `EncounterStarted` and `Ended`. */
export interface IIncidentRecord {
  readonly encounterId: string;
  readonly threatTier: ThreatTier;
  readonly position: Vec3;
  readonly isBoss: boolean;
  /** Rivals who were listed as participants when it began. */
  readonly rivals: RivalId[];
  /** True when the player accepted an Association request for this incident. */
  dispatched: boolean;
  kills: number;
  /**
   * Sum of `EntityKilled.rewardPoints`. REPORT-ONLY: it says how newsworthy the
   * fight looked and is deliberately absent from the award, because a sum of
   * per-kill rewards is a kill counter by another name.
   */
  significance: number;
  collateral: number;
  civiliansSaved: number;
  civiliansLost: number;
  civiliansLostByPlayer: number;
  allyDowned: boolean;
  witnesses: IWitnessReport;
  startedAt: number;
}

/** The filed report, as the Association would print it. */
export interface IIncidentReport {
  readonly encounterId: string;
  readonly threatTier: ThreatTier;
  readonly outcome: 'victory' | 'defeat' | 'fled' | 'aborted';
  readonly witnessCount: number;
  readonly corroboration: number;
  /** Points before the boredom throttle. */
  readonly basePoints: number;
  /** Points actually awarded to the player. */
  readonly awardedPoints: number;
  readonly collateralGross: number;
  readonly collateralReported: number;
  readonly collateralPenalty: number;
  readonly kills: number;
  readonly rivalCredit: Readonly<Partial<Record<RivalId, number>>>;
}

export interface IProgressionOptions {
  readonly bus: IEventBus;
  readonly heroName?: string;
  /** Share a boredom model with the rest of the game. One is created if absent. */
  readonly boredom?: BoredomModel;
  readonly rivals?: RivalTracker;
  readonly witnesses?: WitnessField;
  /** Called once per filed report. The quest system's incident counter uses it. */
  readonly onIncidentReported?: (report: IIncidentReport) => void;
  /** Called on any rank change, in addition to the `RankChanged` event. */
  readonly onRankChanged?: (rank: IHeroRank, previous: IHeroRank) => void;
}

/** Mutable mirror of the read-only `IProgressionState`. */
class MutableProgressionState implements IProgressionState {
  rank: IHeroRank;
  readonly killsByTier: Record<ThreatTier, number> = {
    wolf: 0,
    tiger: 0,
    demon: 0,
    dragon: 0,
    god: 0,
  };
  civiliansSaved = 0;
  civiliansLost = 0;
  propertyDamage = 0;
  reputation = START_REPUTATION;
  boredom = 0;
  completedQuests: string[] = [];
  playTimeSeconds = 0;

  constructor(heroName: string) {
    this.rank = rankFromPoints(START_POINTS, heroName);
  }
}

export class ProgressionSystem implements IProgressionSystem {
  /** Who saw what. Fed by the crowd system through the bootstrap. */
  readonly witnesses: WitnessField;
  /** Boredom, consumed from combat and drained by heroism. */
  readonly boredomModel: BoredomModel;
  /** The rival ladder. Genos lives here. */
  readonly rivals: RivalTracker;

  private readonly bus: IEventBus;
  private readonly stateValue: MutableProgressionState;
  private readonly heroName: string;
  private readonly unsubscribers: (() => void)[] = [];
  private readonly options: IProgressionOptions;
  private readonly incidents = new Map<string, IIncidentRecord>();
  private readonly reports: IIncidentReport[] = [];
  /** Encounter ids of currently accepted requests, so an incident can be marked dispatched. */
  private readonly dispatchedEncounters = new Set<string>();
  /** Authored failure boredom, registered by the coordinator just before the event. */
  private readonly questFailureBoredom = new Map<string, number>();
  /** True when this system created its own boredom model and must dispose it. */
  private readonly ownsBoredom: boolean;

  private pointsValue = START_POINTS;
  private elapsed = 0;
  private lastDayCount = 0;

  constructor(options: IProgressionOptions) {
    this.options = options;
    this.bus = options.bus;
    this.heroName = options.heroName ?? START_HERO_NAME;
    this.stateValue = new MutableProgressionState(this.heroName);
    this.witnesses = options.witnesses ?? new WitnessField();
    this.ownsBoredom = options.boredom === undefined;
    this.boredomModel = options.boredom ?? new BoredomModel({ bus: options.bus });
    this.rivals = options.rivals ?? new RivalTracker();
    this.subscribe();
  }

  get state(): IProgressionState {
    this.stateValue.boredom = this.boredomModel.boredom;
    return this.stateValue;
  }

  /** Raw point total. `state.rank.points` mirrors it. */
  get points(): number {
    return this.pointsValue;
  }

  /** Reports filed this session, newest last. */
  get incidentReports(): readonly IIncidentReport[] {
    return this.reports;
  }

  /** Rival standings plus their distance from the player. */
  rivalTable(): readonly IRivalSnapshot[] {
    return this.rivals.snapshot(this.stateValue.rank);
  }

  /* ---------------------------------------------------------------------- */
  /* IProgressionSystem                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * Award (or deduct) hero points.
   *
   * POSITIVE awards are throttled by boredom. NEGATIVE ones are not — being
   * jaded does not protect a hero from the consequences of a flattened block,
   * and the asymmetry is deliberate: the throttle must never become a shield.
   */
  addPoints(points: number, reason: string): void {
    if (points === 0) return;
    const scaled = points > 0 ? points * this.boredomModel.rankGainMultiplier : points;
    const previous = this.stateValue.rank;
    this.pointsValue = Math.max(0, this.pointsValue + scaled);
    this.stateValue.rank = rankFromPoints(this.pointsValue, this.heroName);
    this.publishRank(previous, reason, scaled);
  }

  addReputation(delta: number): void {
    this.stateValue.reputation = clamp(
      this.stateValue.reputation + delta,
      REPUTATION_MIN,
      REPUTATION_MAX
    );
  }

  addBoredom(delta: number, reason: string): void {
    this.boredomModel.apply(delta, delta < 0 ? 'restraintBonus' : 'trivialVictory');
    this.stateValue.boredom = this.boredomModel.boredom;
    void reason;
  }

  addPropertyDamage(cost: number): void {
    this.stateValue.propertyDamage += Math.max(0, cost);
  }

  update(dt: number): void {
    this.elapsed += dt;
    this.stateValue.playTimeSeconds += dt;
    this.boredomModel.update(dt);
    this.stateValue.boredom = this.boredomModel.boredom;
    this.evictStaleIncidents();
  }

  /**
   * Drop incidents whose `EncounterEnded` never arrived.
   *
   * They are not scored — an encounter nobody closed produced no outcome — but
   * leaving them open silently swallows the credit and the blame of everything
   * that happens within 200 m of them for the rest of the session.
   */
  private evictStaleIncidents(): void {
    if (this.incidents.size === 0) return;
    for (const [id, incident] of this.incidents) {
      if (this.elapsed - incident.startedAt <= INCIDENT_MAX_AGE_SECONDS) continue;
      this.incidents.delete(id);
      log.debug(`incident ${id} expired without an EncounterEnded; dropping it`);
    }
  }

  /**
   * Advance rivals' off-screen careers.
   *
   * Called by the bootstrap when the day count rolls over, because the rival
   * ladder must not freeze while the player is at the supermarket.
   */
  onDayElapsed(dayCount: number): void {
    if (dayCount <= this.lastDayCount) return;
    this.rivals.advanceOffscreen(dayCount - this.lastDayCount);
    this.lastDayCount = dayCount;
  }

  /**
   * Mark an encounter as an accepted Association request.
   *
   * A dispatched incident scores even without witnesses, because the
   * Association sent the hero and the monster demonstrably stopped. Walking
   * into an unreported fight and winning it alone is worth almost nothing.
   */
  markDispatched(encounterId: string): void {
    this.dispatchedEncounters.add(encounterId);
    const incident = this.incidents.get(encounterId);
    if (incident) incident.dispatched = true;
  }

  /**
   * The request is no longer accepted: a future encounter with this id is a
   * fight the Association never sent anyone to.
   *
   * Only FUTURE encounters are affected. An incident already open keeps the
   * flag it was opened with, because the dispatch was real when it started.
   */
  clearDispatched(encounterId: string): void {
    this.dispatchedEncounters.delete(encounterId);
  }

  /**
   * Register the boredom a specific quest's failure costs, overriding the
   * default. Consumed by the very next `QuestStateChanged: failed` for that id.
   *
   * The catalogue authors `rules.boredomOnFailure`, but this system never
   * imports the catalogue — the coordinator reads it off the quest and hands it
   * here from `onResolved`, which runs before the state change is published.
   */
  setQuestFailureBoredom(questId: string, boredom: number): void {
    this.questFailureBoredom.set(questId, boredom);
  }

  /**
   * Adopt the calendar from a save.
   *
   * Without it `lastDayCount` stays 0 after a load and the next `onDayElapsed`
   * pays every rival for days they already banked in the save file.
   */
  syncDayCount(dayCount: number): void {
    if (!Number.isFinite(dayCount)) return;
    this.lastDayCount = Math.max(0, dayCount);
  }

  /**
   * Record an act of heroism. THE only thing that lowers boredom.
   *
   * Public because two of the deeds — catching debris and body-blocking for an
   * ally — have no representation on the shared event bus. They are the
   * combat and destruction systems' knowledge, and reach this system through
   * the bootstrap rather than through a forged event.
   */
  recordHeroicDeed(deed: HeroicDeed, detail?: string): number {
    const applied = this.boredomModel.recordHeroicDeed(deed, detail);
    this.stateValue.boredom = this.boredomModel.boredom;
    return applied;
  }

  /**
   * Restore from a save. Does not emit `RankChanged`.
   *
   * EVERY number is sanitised on the way in. A save that lost a field — a
   * truncated write, a hand-edit, a schema change without a migration — would
   * otherwise fold `undefined` into `NaN`, freeze the ladder at the bottom for
   * the rest of the session, and then make every future save throw on the
   * validator's non-finite check. A replaced field is loud; a poisoned one is
   * silent and permanent.
   */
  restore(state: IProgressionState): void {
    this.pointsValue = Math.max(0, finiteOr(state.rank?.points, START_POINTS, 'rank.points'));
    this.stateValue.rank = rankFromPoints(this.pointsValue, state.rank?.heroName || this.heroName);
    for (const tier of Object.keys(this.stateValue.killsByTier) as ThreatTier[]) {
      const kills = state.killsByTier?.[tier] ?? 0;
      this.stateValue.killsByTier[tier] = Math.max(0, finiteOr(kills, 0, `killsByTier.${tier}`));
    }
    this.stateValue.civiliansSaved = Math.max(
      0,
      finiteOr(state.civiliansSaved, 0, 'civiliansSaved')
    );
    this.stateValue.civiliansLost = Math.max(0, finiteOr(state.civiliansLost, 0, 'civiliansLost'));
    this.stateValue.propertyDamage = Math.max(
      0,
      finiteOr(state.propertyDamage, 0, 'propertyDamage')
    );
    this.stateValue.reputation = clamp(
      finiteOr(state.reputation, START_REPUTATION, 'reputation'),
      REPUTATION_MIN,
      REPUTATION_MAX
    );
    this.stateValue.completedQuests = [...(state.completedQuests ?? [])];
    this.stateValue.playTimeSeconds = Math.max(
      0,
      finiteOr(state.playTimeSeconds, 0, 'playTimeSeconds')
    );
    this.boredomModel.restore(finiteOr(state.boredom, 0, 'boredom'));
    this.stateValue.boredom = this.boredomModel.boredom;

    // A restored session is a different session: nothing that was open before
    // the load is open now, and last session's log is not this session's.
    this.incidents.clear();
    this.reports.length = 0;
    this.dispatchedEncounters.clear();
    this.questFailureBoredom.clear();
  }

  /** A plain, JSON-safe copy for the save file. */
  snapshot(): IProgressionState {
    return {
      rank: { ...this.stateValue.rank },
      killsByTier: { ...this.stateValue.killsByTier },
      civiliansSaved: this.stateValue.civiliansSaved,
      civiliansLost: this.stateValue.civiliansLost,
      propertyDamage: this.stateValue.propertyDamage,
      reputation: this.stateValue.reputation,
      boredom: this.boredomModel.boredom,
      completedQuests: [...this.stateValue.completedQuests],
      playTimeSeconds: this.stateValue.playTimeSeconds,
    };
  }

  dispose(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    // A model handed in belongs to the caller, who disposes it. One created
    // here holds a `BoredomChanged` subscription nobody else can drop.
    if (this.ownsBoredom) this.boredomModel.dispose();
    this.incidents.clear();
    this.reports.length = 0;
    this.dispatchedEncounters.clear();
    this.questFailureBoredom.clear();
  }

  /* ---------------------------------------------------------------------- */
  /* Bus                                                                    */
  /* ---------------------------------------------------------------------- */

  private subscribe(): void {
    this.unsubscribers.push(
      this.bus.on('EncounterStarted', (event) => {
        const rivals = event.participantIds
          .map((id) => String(id).replace(/^ally\./, ''))
          .filter((id): id is RivalId => this.rivals.ids.includes(id as RivalId));

        this.incidents.set(event.encounterId, {
          encounterId: event.encounterId,
          threatTier: event.threatTier,
          position: { x: event.position.x, y: event.position.y, z: event.position.z },
          isBoss: event.isBoss,
          rivals,
          dispatched: this.dispatchedEncounters.has(event.encounterId),
          kills: 0,
          significance: 0,
          collateral: 0,
          civiliansSaved: 0,
          civiliansLost: 0,
          civiliansLostByPlayer: 0,
          allyDowned: false,
          // Snapshot the crowd at the START too: bystanders scatter, and an
          // incident nobody stayed for was still seen by everyone who ran.
          witnesses: this.witnesses.report(event.position),
          startedAt: this.elapsed,
        });
      }),

      this.bus.on('EncounterEnded', (event) => {
        const incident = this.incidents.get(event.encounterId);
        this.incidents.delete(event.encounterId);
        if (incident)
          this.fileReport(incident, event.outcome, event.collateralCost, event.civiliansLost);
      }),

      this.bus.on('EntityKilled', (event) => {
        if (event.threatTier) this.stateValue.killsByTier[event.threatTier]++;
        // POINTS_PER_KILL is 0. This line exists so that the fact is visible
        // in the code path rather than only in a constant nobody reads.
        if (POINTS_PER_KILL !== 0) this.addPoints(POINTS_PER_KILL, 'kill');
        const incident = this.nearestIncident(event.position);
        if (incident) {
          incident.kills++;
          incident.significance += event.rewardPoints;
        }
      }),

      this.bus.on('CivilianSaved', (event) => {
        // The incident's tally is about the INCIDENT, so it counts everyone who
        // got out. The player's own counter is about the PLAYER, and a rescue
        // the game itself attributed to Genos is not his.
        const incident = this.nearestIncident(event.position);
        if (incident) incident.civiliansSaved++;
        if (!event.byPlayer) return;
        this.stateValue.civiliansSaved++;

        const report = this.witnesses.report(event.position);
        const witnessed = report.corroboration > 0;
        const points = witnessed
          ? POINTS_PER_WITNESSED_SAVE * report.corroboration
          : POINTS_PER_UNWITNESSED_SAVE;
        this.addPoints(points, witnessed ? 'witnessedSave' : 'unwitnessedSave');
        this.addReputation(
          witnessed
            ? REPUTATION_PER_WITNESSED_SAVE * report.corroboration
            : event.reputationDelta * 0.1
        );

        // A rescue nobody saw was done for its own sake, which is the only
        // kind of heroism that reaches him.
        this.recordHeroicDeed(
          witnessed ? 'arrivedInTime' : 'unwitnessedRescue',
          event.entityId as string
        );
      }),

      this.bus.on('CivilianLost', (event) => {
        this.stateValue.civiliansLost++;
        const incident = this.nearestIncident(event.position);
        if (incident) {
          incident.civiliansLost++;
          if (event.causedByPlayer) incident.civiliansLostByPlayer++;
        }
        const penalty =
          POINTS_PER_CIVILIAN_LOST * (event.causedByPlayer ? PLAYER_FAULT_MULTIPLIER : 1);
        this.addPoints(penalty, 'civilianLost');
        this.addReputation(event.reputationDelta);
      }),

      this.bus.on('AllyDowned', (event) => {
        for (const incident of this.incidents.values()) incident.allyDowned = true;
        log.info(`ally down: ${event.displayName}`);
      }),

      this.bus.on('ChunkDetached', (event) => {
        this.addPropertyDamage(event.collateralCost);
        const incident = this.nearestIncident(event.position);
        if (incident) incident.collateral += event.collateralCost;
      }),

      this.bus.on('QuestStateChanged', (event) => {
        if (event.state === 'completed') this.onQuestCompleted(event.questId);
        else if (event.state === 'failed') this.onQuestFailed(event.questId);
      })
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Reports                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * The nearest open incident, or undefined.
   *
   * Events carry positions rather than encounter ids, so attribution is
   * spatial. Deliberately generous (`INCIDENT_ATTRIBUTION_RADIUS`): a serious
   * punch throws debris further than a tidy radius, and under-attributing
   * collateral would let a player dodge the report by fighting at the edge of
   * the encounter.
   */
  private nearestIncident(position: Vec3): IIncidentRecord | undefined {
    let best: IIncidentRecord | undefined;
    let bestDistance = INCIDENT_ATTRIBUTION_RADIUS * INCIDENT_ATTRIBUTION_RADIUS;
    for (const incident of this.incidents.values()) {
      const dx = incident.position.x - position.x;
      const dy = incident.position.y - position.y;
      const dz = incident.position.z - position.z;
      const distance = dx * dx + dy * dy + dz * dz;
      if (distance < bestDistance) {
        best = incident;
        bestDistance = distance;
      }
    }
    return best;
  }

  /**
   * Score and file an incident. This is where rank actually moves.
   */
  private fileReport(
    incident: IIncidentRecord,
    outcome: 'victory' | 'defeat' | 'fled' | 'aborted',
    reportedCollateral: number,
    reportedCiviliansLost: number
  ): void {
    // Take the better-corroborated of the two crowd snapshots.
    const witnesses = mergeReports(incident.witnesses, this.witnesses.report(incident.position));
    const collateralGross = Math.max(incident.collateral, reportedCollateral);
    const civiliansLost = Math.max(incident.civiliansLost, reportedCiviliansLost);

    // CREDIT: needs an audience, or an official dispatch.
    let creditMultiplier = INCIDENT_UNWITNESSED_MULTIPLIER;
    if (witnesses.corroboration > 0) {
      creditMultiplier =
        INCIDENT_UNWITNESSED_MULTIPLIER +
        (INCIDENT_WITNESSED_MULTIPLIER - INCIDENT_UNWITNESSED_MULTIPLIER) * witnesses.corroboration;
    }
    if (incident.dispatched)
      creditMultiplier = Math.max(creditMultiplier, INCIDENT_DISPATCHED_MULTIPLIER);

    const tierPoints = outcome === 'victory' ? INCIDENT_POINTS_BY_TIER[incident.threatTier] : 0;
    // `incident.significance` — the sum of combat's per-kill `rewardPoints` —
    // is NOT in this expression, and must never be: it rises with the number of
    // things killed inside the encounter radius, so paying it out would make
    // rank move on kills through the back door. It stays on the record as a
    // report-only measure of how newsworthy the fight looked.
    const basePoints = tierPoints * creditMultiplier;

    // BLAME: reported at 0.55 even with nobody watching.
    const collateralReported = collateralGross * witnesses.collateralReportRate;
    const collateralPenalty = collateralReported * POINTS_PER_COLLATERAL_UNIT;

    const before = this.pointsValue;
    if (basePoints !== 0) this.addPoints(basePoints, `incident:${incident.encounterId}`);
    if (collateralPenalty !== 0) this.addPoints(collateralPenalty, 'reportedCollateral');
    this.addReputation(collateralReported * REPUTATION_PER_COLLATERAL_UNIT);
    const awardedPoints = this.pointsValue - before;

    // Rivals bank their share off the SAME base, at their own multiplier, and
    // are NOT throttled by the player's boredom. Genos is not bored.
    const rivalCredit: Partial<Record<RivalId, number>> = {};
    for (const rival of incident.rivals) {
      rivalCredit[rival] = this.rivals.creditIncident(rival, basePoints, awardedPoints);
    }

    // Heroism: only on a clean win.
    if (outcome === 'victory') {
      if (collateralGross === 0 && civiliansLost === 0) {
        this.recordHeroicDeed('zeroCollateral', incident.encounterId);
      }
      if (incident.rivals.length > 0 && !incident.allyDowned) {
        this.recordHeroicDeed('alliesStanding', incident.encounterId);
      }
    }

    const report: IIncidentReport = {
      encounterId: incident.encounterId,
      threatTier: incident.threatTier,
      outcome,
      witnessCount: witnesses.count,
      corroboration: witnesses.corroboration,
      basePoints,
      awardedPoints,
      collateralGross,
      collateralReported,
      collateralPenalty,
      kills: incident.kills,
      rivalCredit,
    };
    this.reports.push(report);
    if (this.reports.length > REPORT_LOG_LIMIT) this.reports.shift();
    this.options.onIncidentReported?.(report);

    log.info(
      `incident ${incident.encounterId}: ${incident.kills} kills, ` +
        `${witnesses.count} witnesses (corroboration ${witnesses.corroboration.toFixed(2)}), ` +
        `awarded ${awardedPoints.toFixed(1)} pts` +
        (Object.keys(rivalCredit).length > 0
          ? `; rivals ${Object.entries(rivalCredit)
              .map(([id, v]) => `${id} +${(v ?? 0).toFixed(1)}`)
              .join(', ')}`
          : '')
    );
  }

  private onQuestCompleted(questId: string): void {
    if (!this.stateValue.completedQuests.includes(questId)) {
      this.stateValue.completedQuests.push(questId);
    }
    // Rewards are looked up by the caller through `awardQuest`, which the
    // bootstrap wires; the base implementation records completion only, so
    // this system never has to import the quest catalogue.
  }

  private onQuestFailed(questId: string): void {
    // The catalogue's authored `boredomOnFailure` wins when the coordinator
    // registered it. The id sniff is the standalone fallback: this system does
    // not import the catalogue and cannot read the rule itself.
    const authored = this.questFailureBoredom.get(questId);
    this.questFailureBoredom.delete(questId);
    const boredom =
      authored ?? (questId.includes('errand') ? BOREDOM_ON_MISSED_SALE : BOREDOM_ON_QUEST_FAILED);
    this.addBoredom(boredom, `questFailed:${questId}`);
  }

  /**
   * Pay out a completed quest.
   *
   * Separate from `onQuestCompleted` so this system never imports the quest
   * catalogue — the bootstrap reads the reward off the quest and hands it here.
   */
  awardQuest(questId: string, points: number, reputation: number, isErrand = false): void {
    this.addPoints(points, `quest:${questId}`);
    this.addReputation(reputation);
    if (isErrand) this.addBoredom(BOREDOM_ON_ERRAND_COMPLETE, `errand:${questId}`);
  }

  private publishRank(previous: IHeroRank, reason: string, delta: number): void {
    const next = this.stateValue.rank;
    if (next.heroClass === previous.heroClass && next.rank === previous.rank) return;
    const promoted = delta > 0;
    this.bus.emit('RankChanged', {
      previousClass: previous.heroClass,
      heroClass: next.heroClass,
      previousRank: previous.rank,
      rank: next.rank,
      points: next.points,
      promoted,
    });
    this.options.onRankChanged?.(next, previous);
    log.info(
      `${promoted ? 'promoted' : 'demoted'}: ${formatRank(previous)} -> ${formatRank(next)} (${reason})`
    );
  }
}
