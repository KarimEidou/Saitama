/**
 * TARGET REGISTRY AND THE REFERENCE BROAD PHASE
 *
 * The registry is combat's own index of what can be hit: id → plain record.
 * It holds no scene nodes, no physics bodies and no entity objects, so it can
 * be built by hand in a test in three lines and by the spawner adapter at
 * runtime with the same call.
 *
 * ── `LinearScan` IS NOT A BROAD PHASE ──────────────────────────────────────
 * It is the BRUTE FORCE REFERENCE. It exists so that:
 *   • unit tests can resolve punches with no spatial system present, and
 *   • the accelerated path (`src/spatial`'s `DynamicEntityGrid`, injected as
 *     `ICombatBroadPhase`) can be checked against something obviously correct.
 *
 * Shipping it as the production candidate supplier would be a mistake at a few
 * hundred actors, which is why `CombatSystem` takes the real one by injection
 * and only falls back to this when none is given.
 */

import type { EntityId, Faction, Vec3 } from '@/types';
import { sphereInCone, sphereInSphere, normalise } from './cone';
import type { ICombatBroadPhase, ICombatTarget } from './types';

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

/** Fields a caller must supply to register a target. */
export interface ICombatTargetSpec {
  readonly id: EntityId;
  readonly type: ICombatTarget['type'];
  readonly faction: Faction;
  readonly position: Vec3;
  readonly radius?: number;
  readonly maxHealth?: number;
  readonly health?: number;
  readonly displayName?: string;
  readonly threatTier?: ICombatTarget['threatTier'];
  readonly specId?: string;
  readonly isBoss?: boolean;
  readonly phaseResolved?: boolean;
  readonly rewardPoints?: number;
  readonly invulnerable?: boolean;
  readonly resistances?: ICombatTarget['resistances'];
}

/** Default bounding radius when a caller does not supply one, in metres. */
const DEFAULT_TARGET_RADIUS = 0.45;

/**
 * Everything the resolver may hit, keyed by id.
 *
 * Iteration order is INSERTION ORDER (a `Map`), which is deterministic for a
 * given registration sequence. The resolver never relies on it anyway — it
 * sorts candidates by (distance, id) before emitting, so two runs that
 * register the same set in a different order still produce the same events.
 */
export class TargetRegistry {
  private readonly targets = new Map<EntityId, ICombatTarget>();

  /** Register or replace a target. Returns the stored record. */
  add(spec: ICombatTargetSpec): ICombatTarget {
    const maxHealth = spec.maxHealth ?? 100;
    const target: ICombatTarget = {
      id: spec.id,
      type: spec.type,
      faction: spec.faction,
      displayName: spec.displayName ?? spec.id,
      position: { x: spec.position.x, y: spec.position.y, z: spec.position.z },
      radius: spec.radius ?? DEFAULT_TARGET_RADIUS,
      health: spec.health ?? maxHealth,
      maxHealth,
      resistances: spec.resistances,
      threatTier: spec.threatTier,
      specId: spec.specId,
      isBoss: spec.isBoss ?? false,
      phaseResolved: spec.phaseResolved ?? (spec.isBoss !== true),
      rewardPoints: spec.rewardPoints ?? 0,
      invulnerable: spec.invulnerable,
      dead: false,
    };
    this.targets.set(target.id, target);
    return target;
  }

  get(id: EntityId): ICombatTarget | undefined {
    return this.targets.get(id);
  }

  has(id: EntityId): boolean {
    return this.targets.has(id);
  }

  remove(id: EntityId): boolean {
    return this.targets.delete(id);
  }

  clear(): void {
    this.targets.clear();
  }

  get size(): number {
    return this.targets.size;
  }

  /** Live iteration, in registration order. */
  values(): IterableIterator<ICombatTarget> {
    return this.targets.values();
  }

  /** Snapshot as an array. Allocates — diagnostics and tests only. */
  all(): ICombatTarget[] {
    return [...this.targets.values()];
  }

  /** Move a target. The registry owns the vector, so callers write through this. */
  setPosition(id: EntityId, x: number, y: number, z: number): void {
    const target = this.targets.get(id);
    if (target === undefined) return;
    target.position = { x, y, z };
  }

  /** Everything alive matching a faction. */
  aliveByFaction(faction: Faction): ICombatTarget[] {
    const out: ICombatTarget[] = [];
    for (const target of this.targets.values()) {
      if (target.faction === faction && !target.dead && target.health > 0) out.push(target);
    }
    return out;
  }
}

/* -------------------------------------------------------------------------- */
/* Reference broad phase                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Brute-force candidate supplier over the registry.
 *
 * Applies the SAME narrow-phase predicate the resolver will apply, so its
 * output is exactly the true answer set — which is the property that makes it
 * a useful reference for the grid-backed implementation.
 */
export class LinearScan implements ICombatBroadPhase {
  private readonly registry: TargetRegistry;

  constructor(registry: TargetRegistry) {
    this.registry = registry;
  }

  queryCone(
    origin: Vec3,
    direction: Vec3,
    range: number,
    halfAngle: number,
    out: EntityId[]
  ): number {
    out.length = 0;
    const axis = normalise(direction.x, direction.y, direction.z);
    for (const target of this.registry.values()) {
      if (
        sphereInCone(
          target.position.x - origin.x,
          target.position.y - origin.y,
          target.position.z - origin.z,
          target.radius,
          axis.x,
          axis.y,
          axis.z,
          range,
          halfAngle
        )
      ) {
        out.push(target.id);
      }
    }
    return out.length;
  }

  queryRadius(origin: Vec3, range: number, out: EntityId[]): number {
    out.length = 0;
    for (const target of this.registry.values()) {
      if (
        sphereInSphere(
          target.position.x - origin.x,
          target.position.y - origin.y,
          target.position.z - origin.z,
          target.radius,
          range
        )
      ) {
        out.push(target.id);
      }
    }
    return out.length;
  }
}
