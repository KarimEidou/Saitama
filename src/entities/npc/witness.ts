/**
 * SAVE / LOSE ACCOUNTING — the only score that matters
 *
 * The Hero Association ranks on what people SAW. That is not an implementation
 * convenience, it is the joke the whole series runs on: the protagonist wins
 * every fight and is ranked below people who lose theirs, because nobody was
 * watching him and everybody was watching them. So a rescue nobody saw has to
 * be worth measurably less than one that happened in front of forty phones,
 * and this file is where that gets decided.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  A CONTRACT GAP, HANDLED IN THE OPEN
 *
 *  `CivilianSavedEvent` carries `entityId`, `position`, `byPlayer` and
 *  `reputationDelta`. It has NO line-of-sight field, and `src/types/` is
 *  frozen against single-workstream edits for good reasons.
 *
 *  So witnessing travels two ways:
 *
 *    1. FOLDED INTO `reputationDelta`. Ranking already reads that number, and
 *       "the same rescue is worth more when it was seen" is exactly the
 *       behaviour it wants. The multipliers are named constants, not magic.
 *    2. KEPT VERBATIM in `CrowdLedger`, with the player's line-of-sight flag
 *       and the bystander count intact, for anything that needs the structure
 *       rather than the scalar.
 *
 *  This is written down rather than quietly worked around because the next
 *  person to touch the ranking system will otherwise wonder why two identical
 *  rescues scored differently.
 * ══════════════════════════════════════════════════════════════════════════
 */

import type { EntityId, IEventBus, Vec3 } from '@/types';
import {
  BYSTANDER_MULTIPLIER,
  REP_LOST,
  REP_LOST_BY_PLAYER,
  REP_SAVED_BY_PLAYER,
  REP_SAVED_SELF,
  SIGHT_RANGE,
  WITNESS_MULTIPLIER,
} from './constants';
import type { CrowdAgents } from './crowd-agents';
import type { ObstacleField } from './obstacles';
import type { ICivilianOutcome, OutcomeKind } from './types';

/** Who was watching when something happened. */
export interface IWitnessReport {
  /** The player had an unobstructed sightline within `SIGHT_RANGE`. */
  readonly byPlayer: boolean;
  /** Live civilians with an unobstructed sightline. */
  readonly bystanders: number;
  /** Metres from the player. Infinity when the player is not registered. */
  readonly playerDistance: number;
}

/**
 * Who could see a point.
 *
 * Bystanders are counted from the SIMULATED crowd only — the near and mid
 * tiers. Far-tier population is a density scalar with no positions, so
 * counting it would mean inventing witnesses, and a rescue in an empty street
 * scoring as if a hundred people saw it is worse than scoring zero.
 */
export function gatherWitnesses(
  agents: CrowdAgents,
  obstacles: ObstacleField,
  x: number,
  z: number,
  player: { x: number; z: number } | undefined,
  exclude: number
): IWitnessReport {
  let bystanders = 0;
  for (let i = 0; i < agents.extent; i++) {
    if (i === exclude || agents.active[i] === 0) continue;
    if (agents.health[i]! <= 0) continue;
    const dx = agents.posX[i]! - x;
    const dz = agents.posZ[i]! - z;
    if (dx * dx + dz * dz > SIGHT_RANGE * SIGHT_RANGE) continue;
    if (obstacles.segmentClear(agents.posX[i]!, agents.posZ[i]!, x, z, SIGHT_RANGE)) bystanders++;
  }

  if (player === undefined) {
    return { byPlayer: false, bystanders, playerDistance: Infinity };
  }
  const pdx = player.x - x;
  const pdz = player.z - z;
  const playerDistance = Math.sqrt(pdx * pdx + pdz * pdz);
  const byPlayer =
    playerDistance <= SIGHT_RANGE &&
    obstacles.segmentClear(player.x, player.z, x, z, SIGHT_RANGE);
  return { byPlayer, bystanders, playerDistance };
}

/**
 * Reputation for one outcome, after witness scaling.
 *
 * The player's own line of sight dominates a crowd of bystanders because the
 * player is the camera: something that happened off-screen did not happen, as
 * far as the ranking board is concerned.
 */
export function scoreOutcome(
  kind: OutcomeKind,
  causedByPlayer: boolean,
  witness: IWitnessReport
): number {
  const base =
    kind === 'saved'
      ? causedByPlayer
        ? REP_SAVED_BY_PLAYER
        : REP_SAVED_SELF
      : causedByPlayer
        ? REP_LOST_BY_PLAYER
        : REP_LOST;

  let multiplier = 1;
  if (witness.byPlayer) multiplier = WITNESS_MULTIPLIER;
  else if (witness.bystanders > 0) multiplier = BYSTANDER_MULTIPLIER;
  // Reputation LOSSES are not discounted for being unwitnessed. A civilian the
  // player killed in an alley with nobody watching still died, and letting the
  // player farm a lower penalty by fighting where the cameras are not is a
  // straightforward exploit.
  if (kind === 'lost' && multiplier < 1) multiplier = 1;
  return Math.round(base * multiplier * 100) / 100;
}

/**
 * Every save and loss, in order, with the detail the event union cannot carry.
 *
 * Bounded: a long session in a dense district can produce thousands of
 * outcomes, and an unbounded array of them is a slow leak that only shows up
 * after an hour of play. The counters are exact regardless of the cap.
 */
export class CrowdLedger {
  private readonly entries: ICivilianOutcome[] = [];
  private readonly limit: number;

  private savedCount = 0;
  private lostCount = 0;
  private witnessedSaves = 0;
  private witnessedLosses = 0;
  private playerCaused = 0;
  private reputation = 0;

  constructor(limit = 512) {
    this.limit = limit;
  }

  get saved(): number {
    return this.savedCount;
  }

  get lost(): number {
    return this.lostCount;
  }

  /** Saves the player personally had line of sight to. The rankable number. */
  get witnessed(): number {
    return this.witnessedSaves;
  }

  /** Deaths the player watched happen. */
  get witnessedLost(): number {
    return this.witnessedLosses;
  }

  /** Civilian deaths the player's own collateral caused. */
  get killedByPlayer(): number {
    return this.playerCaused;
  }

  /** Net reputation from civilian outcomes. */
  get netReputation(): number {
    return Math.round(this.reputation * 100) / 100;
  }

  /** The most recent outcomes, oldest first. */
  get recent(): readonly ICivilianOutcome[] {
    return this.entries;
  }

  clear(): void {
    this.entries.length = 0;
    this.savedCount = 0;
    this.lostCount = 0;
    this.witnessedSaves = 0;
    this.witnessedLosses = 0;
    this.playerCaused = 0;
    this.reputation = 0;
  }

  /**
   * Record an outcome and publish the matching event.
   *
   * Recording and emitting are one operation on purpose. Two call sites — one
   * that emits and one that tallies — is how a save ends up counted twice, or
   * once, or announced without being scored, depending on the order the
   * refactor happened in.
   */
  record(
    bus: IEventBus | undefined,
    kind: OutcomeKind,
    entityId: EntityId,
    position: Vec3,
    causedByPlayer: boolean,
    witness: IWitnessReport,
    peakAlarm: number,
    time: number
  ): ICivilianOutcome {
    const reputationDelta = scoreOutcome(kind, causedByPlayer, witness);
    const outcome: ICivilianOutcome = {
      kind,
      entityId,
      x: position.x,
      y: position.y,
      z: position.z,
      time,
      byPlayer: causedByPlayer,
      witnessedByPlayer: witness.byPlayer,
      bystanders: witness.bystanders,
      reputationDelta,
      peakAlarm,
    };

    this.entries.push(outcome);
    if (this.entries.length > this.limit) this.entries.shift();
    this.reputation += reputationDelta;

    if (kind === 'saved') {
      this.savedCount++;
      if (witness.byPlayer) this.witnessedSaves++;
      bus?.emit('CivilianSaved', {
        entityId,
        position,
        byPlayer: causedByPlayer,
        reputationDelta,
      });
    } else {
      this.lostCount++;
      if (witness.byPlayer) this.witnessedLosses++;
      if (causedByPlayer) this.playerCaused++;
      bus?.emit('CivilianLost', {
        entityId,
        position,
        causedByPlayer,
        reputationDelta,
      });
    }
    return outcome;
  }
}
