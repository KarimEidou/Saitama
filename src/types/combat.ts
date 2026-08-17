/**
 * COMBAT CONTRACT
 *
 * Canonical home for threat classification, damage, punches and hit
 * resolution. Progression, quests and the day/night cycle live in gameplay.ts;
 * breakable geometry lives in destruction.ts.
 *
 * TYPE-ONLY file. No runtime exports.
 *
 * NOTE: `ThreatTier` is defined HERE. entity.ts imports it. Do not redeclare.
 */

import type * as THREE from 'three';
import type { IUpdatable, IDisposable } from './engine';
import type { IActor, IEntity, EntityId, Faction } from './entity';

/* -------------------------------------------------------------------------- */
/* Threat classification                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Hero Association threat level, ascending in danger:
 * `wolf` < `tiger` < `demon` < `dragon` < `god`.
 */
export type ThreatTier = 'wolf' | 'tiger' | 'demon' | 'dragon' | 'god';

/* -------------------------------------------------------------------------- */
/* Intent                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How much force the attacker is committing.
 *
 * This is the central dial of the whole game: the protagonist can end almost
 * any fight instantly, so restraint is a gameplay resource. `LethalIntent`
 * scales damage, VFX, destruction radius and the reputation penalty for
 * collateral damage.
 */
export type LethalIntent =
  /** Pulled punch. Non-lethal, minimal collateral. Used around civilians. */
  | 'restrained'
  /** Ordinary combat force. */
  | 'normal'
  /** Committed strike; significant knockback and structural damage. */
  | 'serious'
  /** No restraint whatsoever. City-block-scale consequences. */
  | 'full';

/* -------------------------------------------------------------------------- */
/* Damage                                                                     */
/* -------------------------------------------------------------------------- */

/** Damage classification, used for resistances and VFX. */
export type DamageType = 'blunt' | 'slash' | 'pierce' | 'energy' | 'explosive' | 'environmental';

/** A resolved damage application. */
export interface IDamageInfo {
  readonly amount: number;
  readonly type: DamageType;
  readonly source?: IActor;
  /** Impact point in world space. */
  readonly point: THREE.Vector3;
  /** Knockback impulse in newton-seconds. */
  readonly impulse: THREE.Vector3;
  /** True for a critical / finisher hit. */
  readonly critical: boolean;
  /** Force commitment behind the hit. */
  readonly intent: LethalIntent;
}

/** Anything that can receive damage. */
export interface IDamageable {
  readonly health: number;
  readonly maxHealth: number;
  readonly isAlive: boolean;
  /** Multiplier per damage type; 1.0 neutral, 0 immune. */
  readonly resistances?: Partial<Record<DamageType, number>>;
  /**
   * Apply damage; returns the amount actually applied after resistances.
   * Must clamp health at 0 and fire death exactly once.
   */
  applyDamage(info: IDamageInfo): number;
}

/* -------------------------------------------------------------------------- */
/* Hits                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A single resolved contact between an attack and a target. Emitted for every
 * affected entity, so one punch may produce many `HitInfo` records.
 */
export interface HitInfo {
  /** What was hit. */
  readonly target: IEntity;
  /** Who hit it. Undefined for environmental damage. */
  readonly attacker?: IActor;
  /** Contact point in world space. */
  readonly point: THREE.Vector3;
  /** Surface normal at the contact point, pointing away from the target. */
  readonly normal: THREE.Vector3;
  /** Damage actually dealt after resistances. */
  readonly damage: number;
  readonly damageType: DamageType;
  readonly intent: LethalIntent;
  /** Impulse imparted, in newton-seconds. */
  readonly impulse: THREE.Vector3;
  /** Metres from the attack origin to the contact point. */
  readonly distance: number;
  /** True when this hit reduced the target to 0 health. */
  readonly killed: boolean;
  /** True when the target blocked or was invulnerable. */
  readonly blocked: boolean;
  /** True for a critical / weak-point hit. */
  readonly critical: boolean;
  /** Bone/socket hit, when the target is a skinned character. */
  readonly bone?: string;
}

/* -------------------------------------------------------------------------- */
/* Punches                                                                    */
/* -------------------------------------------------------------------------- */

/** Punch variants. Drives animation, VFX intensity and camera shake. */
export type PunchKind =
  | 'normal'
  | 'consecutive'
  | 'heavy'
  | 'uppercut'
  | 'slam'
  | 'serious'
  | 'seriousTableflip'
  | 'environmental';

/** Directional shockwave propagating from an impact. */
export interface IShockwave {
  /** Cone length in metres. */
  readonly range: number;
  /** Cone half-angle in radians. `Math.PI` is omnidirectional. */
  readonly angle: number;
  /** Force at the origin; falls off with distance. */
  readonly force: number;
  /** Whether the shockwave fractures terrain and buildings in its path. */
  readonly destroysTerrain: boolean;
  /** Seconds for the wave to travel `range`. 0 is instantaneous. */
  readonly travelTime: number;
}

/**
 * A single punch/impact event.
 *
 * `power` is deliberately UNBOUNDED so a serious punch can carry values orders
 * of magnitude above a normal hit. Consumers must not assume a ceiling, and
 * must not naively normalise it into a 0..1 range without clamping.
 */
export interface IPunchEvent {
  /** World-space origin, usually the fist socket position. */
  readonly origin: THREE.Vector3;
  /** Unit vector along the punch. Drives knockback and shockwave orientation. */
  readonly direction: THREE.Vector3;
  /** Force magnitude. Normal hits 10–1000; serious punches may exceed 1e6. */
  readonly power: number;
  /** Effective impact radius in metres. */
  readonly radius: number;
  /** Who threw it. Undefined for environmental impacts. */
  readonly source?: IActor;
  readonly kind: PunchKind;
  /** How much force the attacker committed. */
  readonly intent: LethalIntent;
  /** Seconds since boot when the punch landed. */
  readonly time: number;
  /** Optional cone extending beyond `radius`. */
  readonly shockwave?: IShockwave;
  /** Ignore invulnerability frames. */
  readonly unblockable?: boolean;
}

/** Everything a punch affected. */
export interface IPunchResult {
  readonly punch: IPunchEvent;
  /** Every resolved contact. */
  readonly hits: readonly HitInfo[];
  /** Ids of destructibles damaged, with integrity removed. */
  readonly destructiblesHit: readonly { id: string; integrityRemoved: number }[];
  /** True when nothing was in range. */
  readonly whiffed: boolean;
  /** Suggested camera trauma in 0..1, derived from `power`. */
  readonly cameraShake: number;
  /** Estimated collateral damage cost, feeding the reputation penalty. */
  readonly collateralCost: number;
}

/* -------------------------------------------------------------------------- */
/* Combat system                                                              */
/* -------------------------------------------------------------------------- */

/** Central combat resolver. One instance. */
export interface ICombatSystem extends IUpdatable, IDisposable {
  /**
   * Resolve a punch: query overlapping actors and destructibles, apply damage,
   * emit VFX/audio events. Returns everything affected.
   */
  resolvePunch(punch: IPunchEvent): IPunchResult;
  /** Direct single-target damage, bypassing spatial queries. */
  applyDirectDamage(target: IDamageable, info: IDamageInfo): number;
  /** Spatial query for targeting and AI. */
  query(query: ITargetQuery): ITargetHit[];
  /** Subscribe to resolved punches. Returns an unsubscribe fn. */
  onPunch(cb: (result: IPunchResult) => void): () => void;
  /** Subscribe to kills. */
  onKill(cb: (victim: IActor, killer?: IActor) => void): () => void;
}

/* -------------------------------------------------------------------------- */
/* Targeting                                                                  */
/* -------------------------------------------------------------------------- */

/** Spatial query used by combat and AI. */
export interface ITargetQuery {
  readonly origin: THREE.Vector3;
  readonly radius: number;
  readonly faction?: Faction;
  /** Entity ids to exclude. */
  readonly exclude?: readonly EntityId[];
  /** Cone half-angle in radians; omit for a sphere query. */
  readonly coneAngle?: number;
  /** Cone axis; required when `coneAngle` is set. */
  readonly direction?: THREE.Vector3;
  /** Require unobstructed line of sight. */
  readonly requireLineOfSight?: boolean;
  /** Cap on results, nearest first. */
  readonly limit?: number;
}

/** One row from a target query. */
export interface ITargetHit {
  readonly entity: IEntity;
  readonly distance: number;
  readonly point: THREE.Vector3;
}
