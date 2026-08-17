/**
 * STRUCTURE SWEEP — WHICH BUILDINGS DID THAT PUNCH ENGULF
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
 * It is NOT the destruction system. Nothing here fractures a mesh, detaches a
 * chunk, spawns debris or touches physics. The destruction workstream owns all
 * of that and drives it from `ShockwaveFired` on the bus, exactly as the
 * architectural rule requires.
 *
 * ── WHAT IT IS FOR ─────────────────────────────────────────────────────────
 * Two things combat genuinely needs to know for itself:
 *
 *  1. `IPunchResult.destructiblesHit` is part of the combat contract — the
 *     HUD, the quest tracker and the replay log all want to know what a punch
 *     reached without waiting for the collapse to finish.
 *
 *  2. THE CHARGE METER'S PRICE TAG. The entire game loop is "how much of City
 *     Z am I willing to destroy", and that question is unanswerable if the
 *     player only finds out after releasing. Sweeping registered structure
 *     boxes against the cone WHILE IT CHARGES gives a live yen estimate, which
 *     is what turns a power fantasy into a decision.
 *
 * The authoritative figure is still the sum of `ChunkDetached` events after
 * the fact; this is the forecast, and `IEncounterResult.propertyDamageYen` is
 * the invoice.
 */

import type { DistrictType, Vec3 } from '@/types';
import { aabbInCone, aabbInSphere, normalise, type ICombatAabb } from './cone';
import { ZONING_YEN_PER_KG } from './tuning';

/** A registered breakable structure, as combat sees it: a box and a price. */
export interface ICombatStructure {
  readonly id: string;
  readonly bounds: ICombatAabb;
  /** Total mass of the intact structure in kilograms. */
  readonly massKg: number;
  /** District the structure stands in; selects the zoning rate. */
  readonly district: DistrictType;
}

/** Registration payload. */
export interface ICombatStructureSpec {
  readonly id: string;
  readonly bounds: ICombatAabb;
  readonly massKg?: number;
  readonly district?: DistrictType;
}

/** Default mass when the caller does not supply one — a small shopfront. */
const DEFAULT_STRUCTURE_MASS_KG = 240_000;

/**
 * Boxes only, keyed by id.
 *
 * Deliberately a flat list: this is swept once per punch and once per charging
 * frame over the structures the streaming system has resident, which is tens,
 * not thousands. Adding a tree here would duplicate `src/spatial`'s quadtree,
 * and two culling structures that can disagree is worse than a loop.
 */
export class StructureIndex {
  private readonly structures = new Map<string, ICombatStructure>();

  add(spec: ICombatStructureSpec): ICombatStructure {
    const structure: ICombatStructure = {
      id: spec.id,
      bounds: spec.bounds,
      massKg: spec.massKg ?? DEFAULT_STRUCTURE_MASS_KG,
      district: spec.district ?? 'residential',
    };
    this.structures.set(structure.id, structure);
    return structure;
  }

  get(id: string): ICombatStructure | undefined {
    return this.structures.get(id);
  }

  remove(id: string): boolean {
    return this.structures.delete(id);
  }

  clear(): void {
    this.structures.clear();
  }

  get size(): number {
    return this.structures.size;
  }

  values(): IterableIterator<ICombatStructure> {
    return this.structures.values();
  }

  /**
   * Structures whose box intersects the cone, sorted by id so the result is
   * order-independent and byte-identical between runs.
   */
  sweepCone(
    origin: Vec3,
    direction: Vec3,
    range: number,
    halfAngle: number
  ): ICombatStructure[] {
    const axis = normalise(direction.x, direction.y, direction.z);
    const out: ICombatStructure[] = [];
    for (const structure of this.structures.values()) {
      if (
        aabbInCone(
          structure.bounds,
          origin.x,
          origin.y,
          origin.z,
          axis.x,
          axis.y,
          axis.z,
          range,
          halfAngle
        )
      ) {
        out.push(structure);
      }
    }
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }

  /** Structures whose box intersects a sphere — the ground slam's crater. */
  sweepRadius(origin: Vec3, radius: number): ICombatStructure[] {
    const out: ICombatStructure[] = [];
    for (const structure of this.structures.values()) {
      if (aabbInSphere(structure.bounds, origin.x, origin.y, origin.z, radius)) {
        out.push(structure);
      }
    }
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }
}

/**
 * Forecast yen for a set of structures.
 *
 * `mass × zoning value`, the same formula the invoice uses, applied to the
 * INTACT mass rather than to the chunks that actually came off. It therefore
 * reads high — which is the right way for a warning to be wrong.
 */
export function forecastYen(structures: readonly ICombatStructure[]): number {
  let total = 0;
  for (const structure of structures) {
    total += structure.massKg * ZONING_YEN_PER_KG[structure.district];
  }
  return total;
}
