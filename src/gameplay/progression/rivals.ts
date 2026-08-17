/**
 * RIVALS — and specifically, Genos climbing past you.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The most faithful thing this game can do is let the player win a fight
 * decisively, alongside a disciple who contributed almost nothing to the
 * outcome, and then watch that disciple get promoted for it while they do not.
 * That is not a bug in the Hero Association, it is the Hero Association. It is
 * also the only reliable source of dramatic tension in a game about someone
 * who cannot lose.
 *
 * So rivals are not decoration. They stand on the SAME LADDER, banking points
 * from the SAME incidents, at a HIGHER multiplier, and they keep working
 * off-screen while the player is at the supermarket.
 *
 * Genos's 2.4x is not favouritism written into the fiction — it is what
 * actually happens when one participant gives a clear statement with sensor
 * recordings and the other says "I dunno, I just punched it" and leaves.
 *
 * ── THE EVENT SHAPE PROBLEM ────────────────────────────────────────────────
 * `RankChangedEvent` in `types/events.ts` has no hero id: it is the PLAYER's
 * rank event. This workstream does not own that contract, so rival movements
 * are published through `onRivalRankChanged` instead of forging a shared
 * event that other systems would reasonably read as the player's.
 */

import type { IHeroRank } from '@/types';
import { createLogger } from '@/util';
import {
  RIVAL_CREDIT_MULTIPLIER,
  RIVAL_OFFSCREEN_POINTS_PER_DAY,
  type RivalId,
} from './constants';
import { indexForRank, pointsForIndex, rankFromPoints, rankGap } from './rank-ladder';

const log = createLogger('gameplay.rivals');

/** A rival hero's standing and how they got there. */
export interface IRivalState {
  readonly id: RivalId;
  readonly displayName: string;
  points: number;
  /** Points banked from incidents the player was also at. */
  sharedCredit: number;
  /** Points banked from work the player never saw. */
  offscreenCredit: number;
  /** Incidents attended alongside the player. */
  jointIncidents: number;
}

export interface IRivalSnapshot {
  readonly id: RivalId;
  readonly displayName: string;
  readonly rank: IHeroRank;
  readonly sharedCredit: number;
  readonly offscreenCredit: number;
  readonly jointIncidents: number;
  /** Ladder seats the rival is ABOVE the player. Negative means below. */
  readonly seatsAbovePlayer: number;
}

/** Starting standings, canonical to the early arc. */
const ROSTER: readonly {
  id: RivalId;
  displayName: string;
  heroClass: IHeroRank['heroClass'];
  rank: number;
}[] = [
  // Genos enters at S-17 on raw power and a flawless written exam, which is
  // exactly the thing the player got wrong.
  { id: 'genos', displayName: 'Demon Cyborg', heroClass: 'S', rank: 17 },
  { id: 'mumen', displayName: 'Mumen Rider', heroClass: 'C', rank: 1 },
  { id: 'tank', displayName: 'Tanktop Master', heroClass: 'B', rank: 1 },
];

export interface IRivalTrackerOptions {
  /** Called whenever a rival's class or rank actually changes. */
  readonly onRivalRankChanged?: (snapshot: IRivalSnapshot, previous: IHeroRank) => void;
  /** Turn off off-screen drift. Used by tests that want a still world. */
  readonly offscreenProgress?: boolean;
}

export class RivalTracker {
  private readonly rivals = new Map<RivalId, IRivalState>();
  private readonly onChanged: IRivalTrackerOptions['onRivalRankChanged'];
  private readonly offscreenProgress: boolean;

  constructor(options: IRivalTrackerOptions = {}) {
    this.onChanged = options.onRivalRankChanged;
    this.offscreenProgress = options.offscreenProgress ?? true;
    this.reset();
  }

  reset(): void {
    this.rivals.clear();
    for (const entry of ROSTER) {
      this.rivals.set(entry.id, {
        id: entry.id,
        displayName: entry.displayName,
        points: startingPointsFor(entry.heroClass, entry.rank),
        sharedCredit: 0,
        offscreenCredit: 0,
        jointIncidents: 0,
      });
    }
  }

  get ids(): readonly RivalId[] {
    return [...this.rivals.keys()];
  }

  rank(id: RivalId): IHeroRank {
    const rival = this.rivals.get(id);
    return rankFromPoints(rival?.points ?? 0, rival?.displayName ?? id);
  }

  /**
   * Award a rival their share of an incident.
   *
   * `basePoints` is the SAME figure the player is being scored on, before the
   * player's own boredom throttle. The rival's multiplier is applied on top —
   * which is how Genos ends up ahead having done less.
   *
   * @returns points actually banked.
   */
  creditIncident(id: RivalId, basePoints: number, playerPoints: number): number {
    const rival = this.rivals.get(id);
    if (!rival || basePoints <= 0) return 0;

    const previous = this.rank(id);
    const gained = basePoints * RIVAL_CREDIT_MULTIPLIER[id];
    rival.points += gained;
    rival.sharedCredit += gained;
    rival.jointIncidents++;
    this.publish(rival, previous);

    if (gained > playerPoints * 1.5 && playerPoints >= 0) {
      log.info(
        `${rival.displayName} banked ${gained.toFixed(1)} for the incident; ` +
          `the player banked ${playerPoints.toFixed(1)}`
      );
    }
    return gained;
  }

  /**
   * Advance every rival's off-screen career.
   *
   * Without it the ladder freezes the moment the player stops playing hero,
   * and the whole table becomes a mirror rather than a league. Genos does not
   * stop working because you went shopping.
   *
   * @param days In-game days elapsed since the last call.
   */
  advanceOffscreen(days: number): void {
    if (!this.offscreenProgress || days <= 0) return;
    for (const rival of this.rivals.values()) {
      const previous = this.rank(rival.id);
      const gained = RIVAL_OFFSCREEN_POINTS_PER_DAY[rival.id] * days;
      rival.points += gained;
      rival.offscreenCredit += gained;
      this.publish(rival, previous);
    }
  }

  /** A rival was defeated: they lose ground, as the Association records it. */
  penalise(id: RivalId, points: number): void {
    const rival = this.rivals.get(id);
    if (!rival) return;
    const previous = this.rank(id);
    rival.points = Math.max(0, rival.points - Math.abs(points));
    this.publish(rival, previous);
  }

  /** Full table, plus each rival's distance from the player. */
  snapshot(playerRank: IHeroRank): readonly IRivalSnapshot[] {
    return [...this.rivals.values()].map((rival) => {
      const rank = this.rank(rival.id);
      return {
        id: rival.id,
        displayName: rival.displayName,
        rank,
        sharedCredit: rival.sharedCredit,
        offscreenCredit: rival.offscreenCredit,
        jointIncidents: rival.jointIncidents,
        seatsAbovePlayer: rankGap(rank, playerRank),
      };
    });
  }

  /** Serialise for the save file. */
  serialise(): Record<string, { points: number; shared: number; offscreen: number; joint: number }> {
    const out: Record<string, { points: number; shared: number; offscreen: number; joint: number }> = {};
    for (const rival of this.rivals.values()) {
      out[rival.id] = {
        points: rival.points,
        shared: rival.sharedCredit,
        offscreen: rival.offscreenCredit,
        joint: rival.jointIncidents,
      };
    }
    return out;
  }

  /** Restore from a save. Unknown ids are ignored, missing ones keep defaults. */
  restore(data: Readonly<Record<string, { points?: number; shared?: number; offscreen?: number; joint?: number }>> | undefined): void {
    if (!data) return;
    for (const [id, entry] of Object.entries(data)) {
      const rival = this.rivals.get(id as RivalId);
      if (!rival) continue;
      if (typeof entry.points === 'number') rival.points = entry.points;
      if (typeof entry.shared === 'number') rival.sharedCredit = entry.shared;
      if (typeof entry.offscreen === 'number') rival.offscreenCredit = entry.offscreen;
      if (typeof entry.joint === 'number') rival.jointIncidents = entry.joint;
    }
  }

  private publish(rival: IRivalState, previous: IHeroRank): void {
    if (!this.onChanged) return;
    const next = this.rank(rival.id);
    if (next.heroClass === previous.heroClass && next.rank === previous.rank) return;
    this.onChanged(
      {
        id: rival.id,
        displayName: rival.displayName,
        rank: next,
        sharedCredit: rival.sharedCredit,
        offscreenCredit: rival.offscreenCredit,
        jointIncidents: rival.jointIncidents,
        seatsAbovePlayer: 0,
      },
      previous
    );
  }
}

/** Points that exactly hold a seat, so a rival's first award moves them. */
function startingPointsFor(heroClass: IHeroRank['heroClass'], rank: number): number {
  return pointsForIndex(indexForRank(heroClass, rank));
}
