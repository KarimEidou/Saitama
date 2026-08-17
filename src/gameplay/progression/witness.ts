/**
 * WHO SAW IT
 *
 * ── WHY A WHOLE SUBSYSTEM FOR THIS ─────────────────────────────────────────
 * Because it is the load-bearing idea. In a world where the protagonist wins
 * every fight in one punch, the only variable left with any range in it is
 * whether anyone can tell that he did. Witnesses are the difference between a
 * promotion and another Tuesday, and the game has to model them properly or
 * the joke does not land as a system.
 *
 * ── THE ASYMMETRY ──────────────────────────────────────────────────────────
 * `corroboration()` gates CREDIT. `collateralReportRate()` gates BLAME — and
 * it starts at 0.55 with nobody watching at all, because a flattened city
 * block is still flattened in the morning whether or not there was an audience.
 *
 * Credibility is the Association's, not ours: a registered hero's account is
 * taken at face value, a civilian's with a shrug, and the player's own report
 * of what he did is worth exactly zero.
 *
 * Positions are plain numbers, never live entities — the field is fed from bus
 * events and from the crowd system through the bootstrap, and must stay
 * serialisable and replayable.
 */

import { clamp01, distanceSq3 } from '@/util';
import type { Vec3 } from '@/types';
import {
  COLLATERAL_REPORT_BASE,
  COLLATERAL_REPORT_WITNESSED,
  WITNESS_CREDIBILITY,
  WITNESS_RADIUS,
  WITNESS_SATURATION,
  type WitnessKind,
} from './constants';

/** One potential witness standing somewhere in the world. */
export interface IWitness {
  readonly id: string;
  readonly kind: WitnessKind;
  x: number;
  y: number;
  z: number;
  /** False while unconscious, fleeing blind, or otherwise unable to testify. */
  active: boolean;
}

/** What the Association ended up hearing about an incident. */
export interface IWitnessReport {
  /** Number of active witnesses in range. */
  readonly count: number;
  /** Summed credibility of those witnesses. */
  readonly credibility: number;
  /** Credibility normalised against saturation, 0..1. */
  readonly corroboration: number;
  /** Fraction of collateral damage that gets reported, 0..1. */
  readonly collateralReportRate: number;
  /** Ids of the heroes present. Rivals bank credit off this. */
  readonly heroIds: readonly string[];
}

/** An empty report, for incidents nobody was anywhere near. */
export const NO_WITNESSES: IWitnessReport = {
  count: 0,
  credibility: 0,
  corroboration: 0,
  collateralReportRate: COLLATERAL_REPORT_BASE,
  heroIds: [],
};

/**
 * Spatial register of everyone who could testify.
 *
 * Deliberately a flat array with a linear scan. The realistic population is
 * dozens, the query runs on incident resolution rather than per frame, and a
 * spatial index here would be a structure to keep in sync for no measurable
 * gain. If the crowd system ever registers thousands, swap the scan for
 * `IEntityGrid` — the interface does not change.
 */
export class WitnessField {
  private readonly witnesses = new Map<string, IWitness>();

  get size(): number {
    return this.witnesses.size;
  }

  /** Register or move a witness. Idempotent by id. */
  register(id: string, kind: WitnessKind, position: Vec3): IWitness {
    const existing = this.witnesses.get(id);
    if (existing) {
      existing.x = position.x;
      existing.y = position.y;
      existing.z = position.z;
      return existing;
    }
    const witness: IWitness = {
      id,
      kind,
      x: position.x,
      y: position.y,
      z: position.z,
      active: true,
    };
    this.witnesses.set(id, witness);
    return witness;
  }

  move(id: string, position: Vec3): void {
    const witness = this.witnesses.get(id);
    if (!witness) return;
    witness.x = position.x;
    witness.y = position.y;
    witness.z = position.z;
  }

  /** Mark a witness unable to testify without forgetting they exist. */
  setActive(id: string, active: boolean): void {
    const witness = this.witnesses.get(id);
    if (witness) witness.active = active;
  }

  remove(id: string): void {
    this.witnesses.delete(id);
  }

  clear(): void {
    this.witnesses.clear();
  }

  has(id: string): boolean {
    return this.witnesses.has(id);
  }

  /** Everyone currently registered, for debug overlays and tests. */
  all(): readonly IWitness[] {
    return [...this.witnesses.values()];
  }

  /**
   * Who could see an incident at `position`.
   *
   * @param radius Metres. Defaults to `WITNESS_RADIUS`.
   */
  report(position: Vec3, radius = WITNESS_RADIUS): IWitnessReport {
    const radiusSq = radius * radius;
    let count = 0;
    let credibility = 0;
    const heroIds: string[] = [];

    for (const witness of this.witnesses.values()) {
      if (!witness.active) continue;
      if (distanceSq3(position.x, position.y, position.z, witness.x, witness.y, witness.z) > radiusSq) {
        continue;
      }
      count++;
      credibility += WITNESS_CREDIBILITY[witness.kind];
      if (witness.kind === 'hero') heroIds.push(witness.id);
    }

    const corroboration = clamp01(credibility / WITNESS_SATURATION);
    return {
      count,
      credibility,
      corroboration,
      // BLAME, unlike credit, has a floor with no witnesses at all.
      collateralReportRate: clamp01(
        COLLATERAL_REPORT_BASE + COLLATERAL_REPORT_WITNESSED * corroboration
      ),
      heroIds,
    };
  }
}

/**
 * Merge two reports, keeping the strongest account of each part.
 *
 * An incident spread over a street has several moments; the Association files
 * one report, and it is built from the best evidence available for each claim,
 * not from an average that would let a hero dilute his own collateral by
 * fighting the second half of it somewhere quiet.
 */
export function mergeReports(a: IWitnessReport, b: IWitnessReport): IWitnessReport {
  const heroIds = [...new Set([...a.heroIds, ...b.heroIds])];
  return {
    count: Math.max(a.count, b.count),
    credibility: Math.max(a.credibility, b.credibility),
    corroboration: Math.max(a.corroboration, b.corroboration),
    collateralReportRate: Math.max(a.collateralReportRate, b.collateralReportRate),
    heroIds,
  };
}
