/**
 * COMBAT-LOCAL CONTRACTS
 *
 * Plain-data projections of the shared contracts in `src/types/combat.ts`.
 *
 * ── WHY PROJECT INSTEAD OF USING `HitInfo` / `IPunchEvent` DIRECTLY ────────
 * Those interfaces carry `THREE.Vector3` and live `IEntity` / `IActor`
 * references. This system's ONLY output is the event bus, and `events.ts`
 * states the payload rule plainly:
 *
 *     "Payloads carry IDs and PLAIN DATA, never live entity references."
 *
 * So the resolver works in `Vec3` and `EntityId` from end to end. That is what
 * lets it import NOTHING but `@/types` and `@/util` — no `three`, no entity
 * module, no spawner — which is in turn what lets the VFX, destruction, audio
 * and quest workstreams be built in parallel against it.
 *
 * ── HOW THE PROJECTIONS STAY HONEST ────────────────────────────────────────
 * Each one is declared as `Omit<TheSharedContract, ...the reference fields>`,
 * so every field that is NOT a vector or an entity handle is inherited from
 * the canonical type. Add a field to `HitInfo` and `ICombatHit` gains it too,
 * and this file stops compiling until the resolver populates it. The
 * projection cannot silently drift from the contract.
 */

import type {
  DamageType,
  EntityId,
  EntityType,
  Faction,
  HitInfo,
  IDamageable,
  IPunchEvent,
  IPunchResult,
  IShockwave,
  LethalIntent,
  ThreatTier,
  Vec3,
} from '@/types';

/* -------------------------------------------------------------------------- */
/* Targets                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The resolver's entire view of something that can be hit.
 *
 * ── THE ASYMMETRY THAT IS THE GAME ─────────────────────────────────────────
 * Note what is here: `health`, `maxHealth`, `resistances`. EVERYONE has real
 * hit points — Genos, Mumen Rider, Tatsumaki, every civilian on the street —
 * and every one of them can really lose. The protagonist is the single
 * exception, and he does not have a damage number at all; he has
 * `LethalIntent`. The world's weakness is the content.
 */
export interface ICombatTarget {
  readonly id: EntityId;
  readonly type: EntityType;
  readonly faction: Faction;
  /** Shown on the nameplate and in `AllyDowned`. */
  readonly displayName: string;
  /** World position. Mutated in place as the entity moves. */
  position: Vec3;
  /** Bounding radius in metres — the sphere the cone test uses. */
  readonly radius: number;
  /** Mass in kilograms. Turns a knockback delta-v into newton-seconds. */
  readonly massKg: number;
  health: number;
  readonly maxHealth: number;
  /** Multiplier per damage type; 1.0 neutral, 0 immune. Ignored by lethal intent. */
  readonly resistances?: Partial<Record<DamageType, number>>;
  /** Present for monsters. Drives triviality weighting and reward points. */
  readonly threatTier?: ThreatTier;
  /** Monster spec id, when applicable. */
  readonly specId?: string;
  /**
   * A named story boss. Bosses die in ONE hit like everything else — but only
   * after `phaseResolved`, which is a narrative gate, never an HP gate.
   */
  readonly isBoss: boolean;
  /**
   * True once the scripted encounter phase has resolved. Set from a
   * `BossPhaseChanged` event with `isFinalPhase`, or scripted directly.
   */
  phaseResolved: boolean;
  /** Hero points awarded on defeat. */
  readonly rewardPoints: number;
  /** Immune to everything — the player, cutscene actors, scenery actors. */
  readonly invulnerable?: boolean;
  /** Set once `EntityKilled` has fired, so it can never fire twice. */
  dead: boolean;
}

/**
 * Compile-time proof that the projection did not drift from `IDamageable`:
 * the shared numeric/health fields must be assignable in that direction.
 * If `IDamageable` changes shape, this line stops compiling.
 */
export type TargetCoversDamageableData =
  ICombatTarget extends Pick<IDamageable, 'health' | 'maxHealth' | 'resistances'> ? true : never;

/** Derived liveness, mirroring `IDamageable.isAlive`. */
export function isTargetAlive(target: ICombatTarget): boolean {
  return !target.dead && target.health > 0;
}

/* -------------------------------------------------------------------------- */
/* Punch request                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A punch to resolve — `IPunchEvent` with plain-data vectors and an id instead
 * of a live `IActor`, plus the three fields the resolver needs that the shared
 * contract has no room for.
 */
export interface IPunchRequest
  extends Omit<IPunchEvent, 'origin' | 'direction' | 'source' | 'shockwave'> {
  /** World-space origin — the fist socket, or the crater centre for a slam. */
  readonly origin: Vec3;
  /** Unit propagation axis. Normalised by the resolver if it is not already. */
  readonly direction: Vec3;
  /** Who threw it. */
  readonly sourceId?: EntityId;
  /** Cone extending beyond `radius`. Present for serious punches and slams. */
  readonly shockwave?: IShockwave;
  /**
   * Contact cone half-angle in radians. `Math.PI` makes the resolution RADIAL,
   * which is exactly what the ground slam wants.
   */
  readonly halfAngle: number;
  /** Cap on victims, nearest first. 1 for a single-target tap. */
  readonly maxTargets?: number;
  /** Charge 0..1 that produced this punch. Diagnostics and scoring. */
  readonly charge?: number;
  /** Chain index for consecutive punches; 1 for the first of a chain. */
  readonly chainIndex?: number;
  /** Peak knockback delta-v in m/s, at the origin. Falls off with distance. */
  readonly knockbackMps?: number;
}

/* -------------------------------------------------------------------------- */
/* Hits                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One resolved contact — `HitInfo` with ids and plain vectors.
 *
 * `damage` is 0 for an instant kill. That is not a bug and not a placeholder:
 * a lethal hit does not compute a number, it sets a flag. Anything reading
 * `damage` to size a health bar is reading the wrong field; read `killed`.
 */
export interface ICombatHit
  extends Omit<HitInfo, 'target' | 'attacker' | 'point' | 'normal' | 'impulse'> {
  readonly targetId: EntityId;
  readonly targetType: EntityType;
  readonly faction: Faction;
  readonly attackerId?: EntityId;
  readonly point: Vec3;
  readonly normal: Vec3;
  readonly impulse: Vec3;
  /** True when the target was killed instantly by lethal intent. */
  readonly instantKill: boolean;
  /** True when a boss absorbed the hit because its phase had not resolved. */
  readonly phaseGated: boolean;
}

/** Everything a punch affected — `IPunchResult` over the projected types. */
export interface IPunchOutcome extends Omit<IPunchResult, 'punch' | 'hits'> {
  readonly punch: IPunchRequest;
  readonly hits: readonly ICombatHit[];
  /** Kill count, for the encounter tally. */
  readonly kills: number;
  /** Civilians killed by this punch. The number that should hurt. */
  readonly civiliansKilled: number;
}

/* -------------------------------------------------------------------------- */
/* Broad phase                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Candidate supplier for a punch.
 *
 * INJECTED, never implemented here. `src/spatial`'s `DynamicEntityGrid`
 * already has a cone query on a 24 m grid; the integration layer adapts it to
 * this interface. Combat may not import it (architectural rule), and combat
 * must not grow a second broad phase (duplicated culling is how two systems
 * start disagreeing about who is in range).
 *
 * Implementations MAY over-report — the resolver runs the exact narrow phase
 * on everything handed to it. They must NEVER under-report.
 */
export interface ICombatBroadPhase {
  /**
   * Ids whose bounding sphere may intersect the cone.
   * @returns the number written into `out`.
   */
  queryCone(
    origin: Vec3,
    direction: Vec3,
    range: number,
    halfAngle: number,
    out: EntityId[]
  ): number;
  /** Ids whose bounding sphere may intersect the sphere. */
  queryRadius(origin: Vec3, range: number, out: EntityId[]): number;
}

/* -------------------------------------------------------------------------- */
/* Attacker                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Where the punch comes from and which way it points.
 *
 * The player controller supplies this. Combat cannot import
 * `@/entities/player`, and would not want to: a monster, a scripted set piece
 * or a replay can supply the same three fields.
 */
export interface IAttackerSource {
  readonly id: EntityId;
  /** Fist socket in world space. */
  getOrigin(out: IMutableVec3): void;
  /** Unit facing. */
  getFacing(out: IMutableVec3): void;
}

/** A writable `Vec3`, for the fill-in-place accessors above. */
export interface IMutableVec3 {
  x: number;
  y: number;
  z: number;
}

/* -------------------------------------------------------------------------- */
/* Encounter scoring                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The scorecard for one fight.
 *
 * There is no damage dealt, no accuracy, no combo rating — none of that means
 * anything when every hit is fatal. What is left is the only thing the player
 * actually controlled: how long it took, who died, and what it cost.
 */
export interface IEncounterResult {
  readonly encounterId: string;
  /** Seconds from the encounter starting to the last hostile dying. */
  readonly timeToKill: number;
  readonly civiliansSaved: number;
  readonly civiliansLost: number;
  /** Allies who were registered at the start and still standing at the end. */
  readonly alliesSaved: number;
  readonly alliesDowned: number;
  /** Destroyed fracture-chunk mass in kilograms. */
  readonly debrisMassKg: number;
  /** `debrisMassKg` weighted by the zoning value where each piece fell. */
  readonly propertyDamageYen: number;
  /** Sum of the destruction system's own collateral estimates, as a cross-check. */
  readonly collateralCost: number;
  /** Did a civilian have line-of-sight when the killing blow landed. */
  readonly witnessed: number;
  /** Hostiles killed. */
  readonly kills: number;
  /** True when every registered hostile died. */
  readonly victory: boolean;
  /** Serious punches thrown. The collateral decision, counted. */
  readonly seriousPunches: number;
  /** Normal punches thrown, chained links included. */
  readonly normalPunches: number;
  /** Longest consecutive-punch chain reached. */
  readonly longestChain: number;
  /** Boredom at the start and end, so the fight's tone shift is legible. */
  readonly boredomBefore: number;
  readonly boredomAfter: number;
}

/* -------------------------------------------------------------------------- */
/* Heroism                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The acts that lower boredom.
 *
 * Boredom is the systemic answer to invincibility: killing instantly RAISES
 * it, and the only thing that lowers it is behaving like a hero rather than
 * like a weapon. Every kind below is something the player chose to do that
 * winning did not require.
 */
export type HeroismKind =
  /** Reached a civilian before the thing that was going to kill them did. */
  | 'arrivedInTime'
  /** Took a hit that was aimed at an ally. */
  | 'bodyBlock'
  /** Caught falling debris over a crowd. */
  | 'debrisCaught'
  /** Finished a fight with no collateral and no civilian losses. */
  | 'cleanVictory'
  /** The fight actually took time — the rarest and most valuable of all. */
  | 'challenge';

/** One reported act of heroism. */
export interface IHeroismReport {
  readonly kind: HeroismKind;
  /** Who benefited, when applicable. */
  readonly subjectId?: EntityId;
  readonly position?: Vec3;
}

/**
 * Starting a fight by hand, e.g. from a quest script or a test.
 *
 * `time` and the starting boredom are filled in from the combat system's own
 * clock and meter when omitted, so a caller only has to say who is fighting.
 */
export interface IEncounterStartLike {
  readonly encounterId: string;
  readonly hostileIds: readonly EntityId[];
  readonly allyIds?: readonly EntityId[];
  readonly time?: number;
}

/* -------------------------------------------------------------------------- */
/* Re-exported vocabulary                                                     */
/* -------------------------------------------------------------------------- */

export type { DamageType, EntityId, EntityType, Faction, LethalIntent, ThreatTier, Vec3 };
