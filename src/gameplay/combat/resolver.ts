/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THE HIT RESOLVER — THE SIGNATURE MECHANIC                               ║
 * ║                                                                          ║
 * ║  IMPORTS: `@/types`, `@/util`, and its own siblings. NOTHING ELSE.        ║
 * ║  OUTPUTS: `GameEvent`s on the bus. NOTHING ELSE.                         ║
 * ║                                                                          ║
 * ║  It does not know VFX exists. It does not know destruction exists. It    ║
 * ║  does not know audio, quests, physics or the renderer exist. That is not ║
 * ║  tidiness — it is the reason seventeen workstreams can build at once,    ║
 * ║  and `__tests__/imports.test.ts` fails the build if it stops being true. ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── THE DAMAGE MODEL, AND WHY IT IS DELIBERATELY ASYMMETRIC ────────────────
 * Saitama's attacks carry NO DAMAGE NUMBER. They carry a `LethalIntent` flag,
 * and any lethal-intent hit on any non-boss is an INSTANT KILL: no health bar,
 * no resistances, no tier check, no exceptions. A god-tier dragon and a
 * mosquito resolve through the identical branch, in the identical number of
 * lines, and that fact IS the characterisation.
 *
 * Bosses die in one hit too — but only once their scripted phase resolves.
 * The gate is a `BossPhaseChanged` event, i.e. NARRATIVE. It is not an HP
 * gate, and no amount of punching can force it, because forcing it would make
 * the boss merely tough, which is the one thing this game must never do.
 *
 * Everyone ELSE — Genos, Mumen Rider, Tatsumaki, every civilian on the street
 * — has real hit points and really loses them. The asymmetry is the content.
 *
 * ── EVENT ORDER (assert against this; it is a contract) ────────────────────
 *   1. `ShockwaveFired`                     once, ALWAYS, even on a whiff
 *   2. per victim, nearest first:
 *        `EntityKilled` or `EntityDamaged`
 *        `CivilianLost` or `AllyDowned`     when the victim was one
 *        `ImpulseApplied`                   AFTER the death, so the ragdoll
 *                                           that death spawns is there to
 *                                           receive it
 *
 * ── DETERMINISM ────────────────────────────────────────────────────────────
 * Victims are sorted by (distance, id) before anything is emitted, so the
 * broad phase may hand them over in any order. Every random draw comes from a
 * stream derived per (punch sequence number, target id) — never from one
 * shared stream consumed in iteration order — so identical input produces
 * byte-identical events regardless of registration or query order.
 */

import type {
  EntityId,
  EntityType,
  Faction,
  GameEventPayload,
  IEventBus,
  LethalIntent,
  Vec3,
} from '@/types';
import { clamp01, createRng, falloff, type IRandom } from '@/util';
import { normalise, sphereInCone, sphereInSphere } from './cone';
import { forecastYen, StructureIndex } from './structures';
import { TargetRegistry } from './targets';
import { isLethalIntent, tierScalar, type ICombatTuning } from './tuning';
import type {
  ICombatBroadPhase,
  ICombatHit,
  ICombatTarget,
  IPunchOutcome,
  IPunchRequest,
} from './types';

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

export interface IHitResolverOptions {
  readonly bus: IEventBus;
  readonly registry: TargetRegistry;
  readonly tuning: ICombatTuning;
  /** Candidate supplier. `src/spatial`'s grid, adapted, in the real game. */
  readonly broadPhase: ICombatBroadPhase;
  /** Optional structure boxes, for `destructiblesHit` and the yen forecast. */
  readonly structures?: StructureIndex;
  /** Deterministic stream. Never `Math.random()`. */
  readonly rng: IRandom;
  /**
   * Line-of-sight test, injected. `src/spatial` owns the BVH raycast; combat
   * may not import it, so the integration layer passes a closure. Absent, the
   * world is treated as open ground.
   */
  readonly lineOfSight?: (from: Vec3, to: Vec3) => boolean;
}

/**
 * Bone sockets a hit can land on, in a fixed order so a seeded pick is
 * reproducible. Consumed by VFX for impact placement and by the animator for
 * a reaction; combat itself only reports it.
 */
const HIT_SOCKETS: readonly string[] = Object.freeze([
  'spine_02',
  'head',
  'clavicle_l',
  'clavicle_r',
  'pelvis',
]);

/** Scratch reused across a resolve, so a punch allocates no vectors. */
interface IScratchHit {
  target: ICombatTarget;
  distance: number;
}

/* -------------------------------------------------------------------------- */
/* Resolver                                                                   */
/* -------------------------------------------------------------------------- */

export class HitResolver {
  private readonly bus: IEventBus;
  private readonly registry: TargetRegistry;
  private readonly tuning: ICombatTuning;
  private readonly broadPhase: ICombatBroadPhase;
  private readonly structures: StructureIndex | undefined;
  private readonly rng: IRandom;
  private readonly lineOfSight: ((from: Vec3, to: Vec3) => boolean) | undefined;

  /** Monotonic punch counter. Seeds the per-punch random stream. */
  private sequence = 0;

  private readonly candidateIds: EntityId[] = [];
  private readonly scratch: IScratchHit[] = [];

  /** Punches resolved since construction. Diagnostics. */
  get punchCount(): number {
    return this.sequence;
  }

  constructor(options: IHitResolverOptions) {
    this.bus = options.bus;
    this.registry = options.registry;
    this.tuning = options.tuning;
    this.broadPhase = options.broadPhase;
    this.structures = options.structures;
    this.rng = options.rng;
    this.lineOfSight = options.lineOfSight;
  }

  /** Reset the sequence counter, e.g. at the start of a deterministic replay. */
  reset(): void {
    this.sequence = 0;
  }

  /* ---------------------------------------------------------------------- */
  /* The one entry point                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * Resolve a punch: query, kill, emit.
   *
   * Everything the rest of the game learns about this punch, it learns from
   * the events emitted here. The returned outcome is for the caller's own
   * bookkeeping (scoring, HUD, tests) and is not a communication channel.
   */
  resolve(punch: IPunchRequest): IPunchOutcome {
    const sequence = this.sequence++;
    const punchRng = this.rng.derive(sequence);

    const axis = normalise(punch.direction.x, punch.direction.y, punch.direction.z);
    const halfAngle = punch.halfAngle;
    const radial = halfAngle >= Math.PI - 1e-6;
    const knockback = punch.knockbackMps ?? this.tuning.normalKnockbackMps;

    /* ── TWO RANGES, DELIBERATELY ─────────────────────────────────────────
       `radius` is how far the punch KILLS. `shockwave.range` is how far the
       PRESSURE reaches. For a normal punch and a serious punch they are the
       same number. For a ground slam they are not, and that gap is the whole
       difference between "the crowd was knocked over" and "the crowd was
       killed" — so the two are never allowed to collapse into one variable. */
    const lethalRange = punch.radius;
    const waveRange = punch.shockwave?.range ?? punch.radius;
    const waveAngle = punch.shockwave?.angle ?? halfAngle;

    /* ---- 1. announce the punch ---------------------------------------- */
    // Emitted BEFORE resolution and even on a whiff: physics propagates the
    // pressure wave from it, audio voices the swing from it, and VFX draws the
    // cone from it. None of those care whether anything was standing there.
    this.emit('ShockwaveFired', {
      origin: punch.origin,
      direction: { x: axis.x, y: axis.y, z: axis.z },
      power: punch.power,
      range: waveRange,
      angle: waveAngle,
      intent: punch.intent,
      punchKind: punch.kind,
      sourceId: punch.sourceId,
    });

    /* ---- 2. candidates ------------------------------------------------- */
    if (radial) {
      this.broadPhase.queryRadius(punch.origin, lethalRange, this.candidateIds);
    } else {
      this.broadPhase.queryCone(
        punch.origin,
        { x: axis.x, y: axis.y, z: axis.z },
        lethalRange,
        halfAngle,
        this.candidateIds
      );
    }

    /* ---- 3. narrow phase ----------------------------------------------- */
    this.scratch.length = 0;
    for (const id of this.candidateIds) {
      if (id === punch.sourceId) continue;
      const target = this.registry.get(id);
      if (target === undefined) continue;
      if (target.dead || target.invulnerable === true) continue;

      const dx = target.position.x - punch.origin.x;
      const dy = target.position.y - punch.origin.y;
      const dz = target.position.z - punch.origin.z;

      const inside = radial
        ? sphereInSphere(dx, dy, dz, target.radius, lethalRange)
        : sphereInCone(dx, dy, dz, target.radius, axis.x, axis.y, axis.z, lethalRange, halfAngle);
      if (!inside) continue;

      const centreDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      this.scratch.push({
        target,
        // Surface distance: what the player sees as "how far away was it".
        distance: Math.max(0, centreDistance - target.radius),
      });
    }

    // Deterministic ordering, independent of how the broad phase enumerated.
    this.scratch.sort(
      (a, b) =>
        a.distance - b.distance || (a.target.id < b.target.id ? -1 : a.target.id > b.target.id ? 1 : 0)
    );

    const limit = punch.maxTargets ?? Number.MAX_SAFE_INTEGER;
    if (this.scratch.length > limit) this.scratch.length = limit;

    /* ---- 4. resolve each victim ---------------------------------------- */
    const hits: ICombatHit[] = [];
    let kills = 0;
    let civiliansKilled = 0;

    for (const entry of this.scratch) {
      const hit = this.resolveOne(punch, entry, axis, lethalRange, knockback, punchRng);
      hits.push(hit);
      if (hit.killed) {
        kills++;
        if (entry.target.faction === 'civilian') civiliansKilled++;
      }
    }

    /* ---- 5. structures the cone engulfed -------------------------------- */
    const swept =
      this.structures === undefined
        ? []
        : waveAngle >= Math.PI - 1e-6
          ? this.structures.sweepRadius(punch.origin, waveRange)
          : this.structures.sweepCone(
              punch.origin,
              { x: axis.x, y: axis.y, z: axis.z },
              waveRange,
              waveAngle
            );
    // A serious punch does not chip a building. Anything the cone reaches at
    // lethal intent is gone; a restrained punch reaches nothing structural.
    const structural = isLethalIntent(punch.intent) && punch.intent !== 'normal';
    const destructiblesHit = structural
      ? swept.map((structure) => ({ id: structure.id, integrityRemoved: 1 }))
      : [];

    return {
      punch,
      hits,
      destructiblesHit,
      whiffed: hits.length === 0 && destructiblesHit.length === 0,
      cameraShake: cameraShakeFor(punch.power, punch.chainIndex ?? 1, this.tuning),
      collateralCost: structural ? forecastYen(swept) : 0,
      kills,
      civiliansKilled,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* One victim                                                             */
  /* ---------------------------------------------------------------------- */

  private resolveOne(
    punch: IPunchRequest,
    entry: IScratchHit,
    axis: { x: number; y: number; z: number },
    range: number,
    knockbackMps: number,
    punchRng: IRandom
  ): ICombatHit {
    const target = entry.target;
    // Per-(punch, target) stream: order-independent by construction.
    const rng = punchRng.derive(target.id);

    /* geometry of the contact */
    const dx = target.position.x - punch.origin.x;
    const dy = target.position.y - punch.origin.y;
    const dz = target.position.z - punch.origin.z;
    const toTarget = normalise(dx, dy, dz);
    const contactDistance = Math.max(0, toTarget.length - target.radius);
    const point: Vec3 = {
      x: punch.origin.x + toTarget.x * contactDistance,
      y: punch.origin.y + toTarget.y * contactDistance,
      z: punch.origin.z + toTarget.z * contactDistance,
    };
    // Points AWAY from the target, back toward whoever threw the punch.
    const normal: Vec3 = { x: -toTarget.x, y: -toTarget.y, z: -toTarget.z };

    /* knockback: the punch itself, distinct from the pressure wave.
       The wave is `ShockwaveFired` and physics propagates it separately; this
       is the directed shove the victim personally received, so it attenuates
       with distance and blends the radial push with the punch axis. */
    const attenuation = range <= 0 ? 1 : falloff(entry.distance, range);
    const deltaV = knockbackMps * attenuation;
    const blendX = toTarget.x * 0.55 + axis.x * 0.45;
    const blendY = toTarget.y * 0.55 + axis.y * 0.45 + 0.18;
    const blendZ = toTarget.z * 0.55 + axis.z * 0.45;
    const push = normalise(blendX, blendY, blendZ);
    const scale =
      deltaV *
      target.massKg *
      (punch.intent === 'restrained' ? this.tuning.restrainedKnockbackRatio : 1);
    const impulse: Vec3 = { x: push.x * scale, y: push.y * scale, z: push.z * scale };

    const socket = HIT_SOCKETS[rng.int(0, HIT_SOCKETS.length - 1)]!;
    const critical = punch.intent === 'full';

    const lethal = isLethalIntent(punch.intent);
    const gated = target.isBoss && !target.phaseResolved;

    let damage = 0;
    let killed = false;
    let instantKill = false;

    if (gated) {
      /* ---- the plot absorbs it ---------------------------------------- */
      // Health is floored at 1 so the encounter can never be won by damage.
      damage = Math.min(this.tuning.bossPhaseChipDamage, Math.max(0, target.health - 1));
      target.health -= damage;
      this.emitDamaged(target, punch, damage, point, critical);
    } else if (lethal) {
      /* ---- THE ONE PUNCH ----------------------------------------------- */
      // No health check, no resistance lookup, no tier comparison. It dies.
      instantKill = true;
      killed = true;
      target.health = 0;
      target.dead = true;
      this.emitKilled(target, punch, point);
    } else {
      /* ---- restrained: a real, small, survivable number ---------------- */
      const resistance = target.resistances?.blunt ?? 1;
      damage = Math.max(0, this.tuning.restrainedDamage * resistance);
      target.health = Math.max(0, target.health - damage);
      if (target.health <= 0) {
        killed = true;
        target.dead = true;
        this.emitKilled(target, punch, point);
      } else {
        this.emitDamaged(target, punch, damage, point, critical);
      }
    }

    /* Faction consequences. Emitted after the death so a listener that looks
       the entity up still sees a consistent `dead` flag. */
    if (killed) {
      if (target.faction === 'civilian') {
        this.emit('CivilianLost', {
          entityId: target.id,
          position: point,
          causedByPlayer: punch.sourceId !== undefined,
          reputationDelta: -12,
        });
      } else if (target.faction === 'hero' && target.type !== 'player') {
        this.emit('AllyDowned', {
          entityId: target.id,
          displayName: target.displayName,
          position: point,
          killerId: punch.sourceId,
        });
      }
    }

    /* Impulse LAST: by now the death handler has had its chance to swap in a
       ragdoll, so there is a dynamic body to receive the shove. */
    this.emit('ImpulseApplied', {
      targetId: target.id,
      impulse,
      point,
      sourceId: punch.sourceId,
    });

    return {
      targetId: target.id,
      targetType: target.type,
      faction: target.faction,
      attackerId: punch.sourceId,
      point,
      normal,
      damage,
      damageType: 'blunt',
      intent: punch.intent,
      impulse,
      distance: entry.distance,
      killed,
      blocked: gated,
      critical,
      bone: socket,
      instantKill,
      phaseGated: gated,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Emission helpers                                                       */
  /* ---------------------------------------------------------------------- */

  private emitKilled(target: ICombatTarget, punch: IPunchRequest, point: Vec3): void {
    this.emit('EntityKilled', {
      entityId: target.id,
      entityType: target.type,
      faction: target.faction,
      position: point,
      killerId: punch.sourceId,
      threatTier: target.threatTier,
      specId: target.specId,
      intent: punch.intent,
      rewardPoints: target.rewardPoints,
    });
  }

  private emitDamaged(
    target: ICombatTarget,
    punch: IPunchRequest,
    amount: number,
    point: Vec3,
    critical: boolean
  ): void {
    this.emit('EntityDamaged', {
      entityId: target.id,
      entityType: target.type,
      faction: target.faction,
      amount,
      damageType: 'blunt',
      intent: punch.intent,
      healthRemaining: target.health,
      maxHealth: target.maxHealth,
      point,
      attackerId: punch.sourceId,
      critical,
    });
  }

  /** Single funnel, so every emission is typed the same way and greppable. */
  private emit<T extends Parameters<IEventBus['emit']>[0]>(
    type: T,
    payload: GameEventPayload<T>
  ): void {
    this.bus.emit(type, payload);
  }

  /* ---------------------------------------------------------------------- */
  /* Witness                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Did any living civilian have line-of-sight to this position?
   *
   * `witnessed` is the fifth `EncounterResult` field and the strangest one:
   * it does not measure whether the player did well, it measures whether
   * anyone SAW. A hero nobody watched is a different story from a hero the
   * crowd watched, and the Hero Association's whole comedy is that it only
   * scores the second one.
   */
  isWitnessed(position: Vec3): boolean {
    const radius = this.tuning.witnessRadiusMetres;
    for (const target of this.registry.values()) {
      if (target.faction !== 'civilian' || target.dead || target.health <= 0) continue;
      const dx = target.position.x - position.x;
      const dy = target.position.y - position.y;
      const dz = target.position.z - position.z;
      if (dx * dx + dy * dy + dz * dz > radius * radius) continue;
      if (this.lineOfSight === undefined || this.lineOfSight(target.position, position)) {
        return true;
      }
    }
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Shared derivations                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Camera trauma 0..1 from an unbounded `power`, plus the chain accumulation.
 *
 * Log-scaled for the same reason the audio system log-scales it: `power` spans
 * six decades, so a linear normalisation would round every ordinary punch to
 * zero and make the whole dial live in the last 1% of a serious hit.
 */
export function cameraShakeFor(power: number, chainIndex: number, tuning: ICombatTuning): number {
  const base = power <= 1 ? 0 : clamp01(Math.log10(power) / 6);
  return clamp01(base + Math.max(0, chainIndex - 1) * tuning.chainShakePerLink);
}

/** Triviality of a kill, 0 (a god) .. 1 (a mosquito). Feeds the boredom meter. */
export function trivialityOf(tier: Parameters<typeof tierScalar>[0]): number {
  return 1 - tierScalar(tier);
}

/** Convenience factory, mostly so tests do not repeat the option bag. */
export function createHitResolver(
  bus: IEventBus,
  registry: TargetRegistry,
  tuning: ICombatTuning,
  broadPhase: ICombatBroadPhase,
  seed: number | string = 'combat',
  structures?: StructureIndex
): HitResolver {
  return new HitResolver({
    bus,
    registry,
    tuning,
    broadPhase,
    structures,
    rng: createRng(seed),
  });
}

/** Re-exported so callers do not have to reach into `@/types` for the union. */
export type { EntityType, Faction, LethalIntent };
