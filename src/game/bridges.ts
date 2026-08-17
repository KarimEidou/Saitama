/**
 * THE BRIDGES
 *
 * Every system in this repository imports `@/types` and `@/util` and talks over
 * the event bus. That rule is what let seventeen of them be built in parallel,
 * and it is not weakened here. But a bus carries EVENTS, and three of the joins
 * this game needs are not events — they are continuous mirrors of one system's
 * state into another's index, re-established every frame:
 *
 *   monsters  -> combat's target registry      (what can be punched)
 *   monsters  -> the crowd's threat list       (what people run from)
 *   civilians -> progression's witness field   (who saw it)
 *
 * Each of those would be a cyclic import if either side did it. They live here
 * because the composition root is the one module allowed to hold both ends.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE AIM-POINT OFFSET — read this before touching `syncCombatTargets`
 * ══════════════════════════════════════════════════════════════════════════
 * A monster's canonical position is at its FEET, because that is what
 * navigation, spawning and ground clamping all need. Combat resolves a punch
 * against a SPHERE centred on the target's `position`, so registering a monster
 * at its own coordinates puts the hittable sphere around its ankles: a jab
 * thrown at chest height at something standing in front of you misses, and the
 * only way to connect is to punch the pavement.
 *
 * `MonsterSystem.describeForCombat()` already solves this — it lifts the point
 * to `y + bodyHeight * 0.5` and widens the radius to `max(radius, 0.42 *
 * height)`, i.e. the torso rather than the footprint. The failure mode this
 * bridge exists to prevent is the OTHER path: reading `monster.brain.position`
 * or `snapshots()` and registering that instead, which type-checks perfectly
 * and produces a game where nothing can be hit.
 *
 * So: `describeForCombat()` is the ONLY source used here, on registration AND
 * on every position update, and `assertAimOffset` proves it at runtime.
 */

import type { EntityId, IQualityTier, Vec3 } from '@/types';
import type { CombatSystem } from '@/gameplay/combat';
import type { MonsterSystem, IMonsterCombatDescriptor, IMonsterTarget } from '@/entities/monster';
import type { CrowdSystem, IThreatSource } from '@/entities/npc';
import { makeThreat } from '@/entities/npc';
import type { ProgressionCoordinator } from '@/gameplay/progression';
import * as THREE from 'three';
import { MAX_TRACKED_WITNESSES, WITNESS_RESYNC_DISTANCE } from './config';

/* -------------------------------------------------------------------------- */
/* Monsters -> combat                                                         */
/* -------------------------------------------------------------------------- */

/** What the last sync did, so the harness can assert on it. */
export interface ICombatSyncReport {
  registered: number;
  updated: number;
  removed: number;
  /** Smallest `aimY - feetY` seen this sync. Zero means the offset was lost. */
  minAimLift: number;
  /** Smallest hit radius registered. */
  minRadius: number;
}

/**
 * Mirror live monsters into combat's target registry.
 *
 * Position and health every frame; `phaseResolved` ONCE, at registration —
 * after that the boss gate belongs to the bus, and writing it again from a
 * descriptor would let a stale poll re-close a gate the script already opened.
 */
export class CombatTargetBridge {
  private readonly registered = new Set<EntityId>();
  readonly report: ICombatSyncReport = {
    registered: 0,
    updated: 0,
    removed: 0,
    minAimLift: Infinity,
    minRadius: Infinity,
  };

  constructor(
    private readonly monsters: MonsterSystem,
    private readonly combat: CombatSystem
  ) {}

  sync(): void {
    const report = this.report;
    report.registered = 0;
    report.updated = 0;
    report.removed = 0;
    report.minAimLift = Infinity;
    report.minRadius = Infinity;

    const seen = new Set<EntityId>();
    // describeForCombat() — NOT snapshots(), NOT brain.position. See header.
    for (const descriptor of this.monsters.describeForCombat()) {
      seen.add(descriptor.id);
      this.observe(descriptor, report);

      if (!this.registered.has(descriptor.id)) {
        this.registered.add(descriptor.id);
        this.combat.addTarget({
          id: descriptor.id,
          type: descriptor.type,
          faction: descriptor.faction,
          position: descriptor.position,
          radius: descriptor.radius,
          massKg: descriptor.massKg,
          maxHealth: descriptor.maxHealth,
          health: descriptor.health,
          displayName: descriptor.displayName,
          threatTier: descriptor.threatTier,
          specId: descriptor.specId,
          isBoss: descriptor.isBoss,
          phaseResolved: descriptor.phaseResolved,
          rewardPoints: descriptor.rewardPoints,
        });
        report.registered++;
        continue;
      }
      this.combat.targets.setPosition(
        descriptor.id,
        descriptor.position.x,
        descriptor.position.y,
        descriptor.position.z
      );
      report.updated++;
    }

    for (const id of this.registered) {
      if (seen.has(id)) continue;
      this.registered.delete(id);
      this.combat.targets.remove(id);
      report.removed++;
    }
    if (report.minAimLift === Infinity) report.minAimLift = 0;
    if (report.minRadius === Infinity) report.minRadius = 0;
  }

  /** Measure the lift actually applied, against the monster's own feet. */
  private observe(descriptor: IMonsterCombatDescriptor, report: ICombatSyncReport): void {
    const monster = this.monsters.get(descriptor.id);
    if (monster !== undefined) {
      const lift = descriptor.position.y - monster.brain.position.y;
      if (lift < report.minAimLift) report.minAimLift = lift;
    }
    if (descriptor.radius < report.minRadius) report.minRadius = descriptor.radius;
  }

  clear(): void {
    for (const id of this.registered) this.combat.targets.remove(id);
    this.registered.clear();
  }
}

/**
 * Prove the offset survived the trip into combat.
 *
 * Called once per second in a debug build and by the verification harness.
 * Returns the ids of any monster whose registered aim point is at or below its
 * own feet, which is the exact symptom of the bug this file guards against.
 */
export function auditAimPoints(
  monsters: MonsterSystem,
  combat: CombatSystem
): { readonly id: EntityId; readonly lift: number; readonly radius: number }[] {
  const bad: { id: EntityId; lift: number; radius: number }[] = [];
  for (const descriptor of monsters.describeForCombat()) {
    const target = combat.targets.get(descriptor.id);
    const monster = monsters.get(descriptor.id);
    if (target === undefined || monster === undefined) continue;
    const lift = target.position.y - monster.brain.position.y;
    const wanted = monster.archetype.bodyHeightMetres * 0.5;
    if (lift < wanted - 1e-3 || target.radius < monster.archetype.bodyHeightMetres * 0.42 - 1e-3) {
      bad.push({ id: descriptor.id, lift, radius: target.radius });
    }
  }
  return bad;
}

/* -------------------------------------------------------------------------- */
/* Monsters -> the crowd                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Publish every live monster as a threat the crowd can panic about.
 *
 * The crowd never learns what a monster IS — it takes a position, an intensity
 * and a tier, which is all a panicking civilian knows either.
 */
export class ThreatBridge {
  private readonly scratch = new Map<EntityId, THREE.Vector3>();

  constructor(
    private readonly monsters: MonsterSystem,
    private readonly crowd: CrowdSystem
  ) {}

  sync(): void {
    const threats: IThreatSource[] = [];
    for (const snapshot of this.monsters.snapshots()) {
      if (snapshot.state === 'dead') continue;
      let vector = this.scratch.get(snapshot.id);
      if (vector === undefined) {
        vector = new THREE.Vector3();
        this.scratch.set(snapshot.id, vector);
      }
      vector.set(snapshot.position.x, snapshot.position.y, snapshot.position.z);
      threats.push(makeThreat(snapshot.id, vector, tierIntensity(snapshot.tier), snapshot.tier));
    }
    this.crowd.setThreats(threats);
  }
}

/** How frightening each tier is, 0..1. A wolf empties a street; a dragon a ward. */
function tierIntensity(tier: string): number {
  switch (tier) {
    case 'god':
      return 1;
    case 'dragon':
      return 0.95;
    case 'demon':
      return 0.8;
    case 'tiger':
      return 0.55;
    default:
      return 0.35;
  }
}

/** Everything monsters are allowed to perceive: the player, allies, civilians. */
export function perceivableTargets(
  playerId: EntityId,
  playerPosition: Vec3,
  crowd: CrowdSystem,
  out: IMonsterTarget[]
): readonly IMonsterTarget[] {
  out.length = 0;
  // `Faction` has no 'player' member and should not: to a monster, Saitama is
  // one more hero standing in the street. Priority is what separates them.
  out.push({ id: playerId, position: playerPosition, faction: 'hero', alive: true, priority: 1 });
  for (const ally of crowd.allies) {
    // Allies stay in the list once downed as well as alive: `alive: false` is
    // how a brain learns to stop chasing a body, and dropping the entry
    // entirely would leave the monster's last target dangling instead.
    out.push({
      id: ally.id,
      position: ally.transform.position,
      faction: 'hero',
      alive: !ally.isDead,
      // Above the player on purpose. A monster that always picks the nearest
      // target never threatens anybody the player is trying to protect, and
      // "the world's weakness is the game" needs the world to be reachable.
      priority: 1.6,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Civilians -> progression's witness field                                   */
/* -------------------------------------------------------------------------- */

/**
 * ══════════════════════════════════════════════════════════════════════════
 *  THE WITNESS BRIDGE — the second thing that silently diverges
 * ══════════════════════════════════════════════════════════════════════════
 * Two systems model who saw what, for two different reasons, and both are
 * right to.
 *
 *   `CrowdLedger` (src/entities/npc/witness.ts) decides, at the moment a
 *   civilian is saved or lost, how many people could see it. It is a
 *   per-outcome snapshot and it feeds the crowd's own reputation scaling.
 *
 *   `WitnessField` (src/gameplay/progression/witness.ts) decides what the Hero
 *   Association hears about an INCIDENT — corroboration for credit, report rate
 *   for blame. Rank moves on witnessed saves and on nothing else.
 *
 * If the crowd walks 250 civilians around City Z and the witness field is never
 * told, then `ProgressionSystem` resolves every incident against an empty
 * register, `corroboration()` returns 0, and the player is never promoted for
 * anything they did in front of a crowd. The two do not contradict each other
 * loudly; they just quietly disagree, forever.
 *
 * So the crowd's agents are published into the witness field continuously —
 * nearest first, capped, and with the DEAD marked inactive rather than removed,
 * because a body is not a witness but it is still evidence that somebody was
 * standing there.
 */
export class WitnessBridge {
  private readonly published = new Map<string, { x: number; z: number }>();
  private readonly candidates: { index: number; distanceSq: number }[] = [];
  private readonly scratch = { x: 0, y: 0, z: 0 };

  /** Witnesses registered by the last sweep. */
  tracked = 0;
  /** Civilians whose record was moved because they walked far enough. */
  moved = 0;
  /** Allies published as high-credibility witnesses. */
  heroes = 0;

  constructor(
    private readonly crowd: CrowdSystem,
    private readonly progression: ProgressionCoordinator
  ) {}

  /**
   * Republish the register around a point.
   *
   * Not every frame: incidents resolve on kills and quest beats, not at 60 Hz,
   * and 250 linear-scan distance checks per frame to service an event that
   * happens twice a minute is the definition of a bad trade.
   */
  sync(focus: Vec3): void {
    const witnesses = this.progression.witnesses;
    const agents = this.crowd.agents;

    this.candidates.length = 0;
    for (let i = 0; i < agents.extent; i++) {
      if (agents.active[i] === 0) continue;
      const dx = agents.posX[i]! - focus.x;
      const dz = agents.posZ[i]! - focus.z;
      this.candidates.push({ index: i, distanceSq: dx * dx + dz * dz });
    }
    this.candidates.sort((a, b) => a.distanceSq - b.distanceSq);

    const keep = new Set<string>();
    this.moved = 0;
    const limit = Math.min(this.candidates.length, MAX_TRACKED_WITNESSES);
    for (let n = 0; n < limit; n++) {
      const index = this.candidates[n]!.index;
      const id = String(agents.idOf(index));
      keep.add(id);
      const x = agents.posX[index]!;
      const z = agents.posZ[index]!;

      const last = this.published.get(id);
      const drifted =
        last === undefined ||
        Math.abs(last.x - x) > WITNESS_RESYNC_DISTANCE ||
        Math.abs(last.z - z) > WITNESS_RESYNC_DISTANCE;
      if (drifted) {
        this.scratch.x = x;
        this.scratch.y = 0.9;
        this.scratch.z = z;
        witnesses.register(id, 'civilian', this.scratch);
        this.published.set(id, { x, z });
        this.moved++;
      }
      // A civilian on the ground cannot give a statement, but their record
      // stays: `setActive(false)` is the difference between "nobody saw it" and
      // "everybody who saw it is dead", and only one of those is the player's
      // fault in a way the Association will hear about.
      witnesses.setActive(id, agents.health[index]! > 0);
    }

    // Allies are witnesses too, and expensive ones: a registered hero's account
    // is worth 4.5 civilians. Genos filing a sensor recording is exactly why
    // the player's own rank barely moves at a fight he attended.
    this.heroes = 0;
    for (const ally of this.crowd.allies) {
      const id = String(ally.id);
      keep.add(id);
      this.scratch.x = ally.transform.position.x;
      this.scratch.y = ally.transform.position.y;
      this.scratch.z = ally.transform.position.z;
      witnesses.register(id, 'hero', this.scratch);
      witnesses.setActive(id, !ally.isDead);
      this.heroes++;
    }

    for (const id of [...this.published.keys()]) {
      if (keep.has(id)) continue;
      witnesses.remove(id);
      this.published.delete(id);
    }
    this.tracked = witnesses.size;
  }
}

/* -------------------------------------------------------------------------- */
/* Quality fan-out                                                            */
/* -------------------------------------------------------------------------- */

/** Systems that care when the settings screen moves the quality slider. */
export interface IQualityConsumers {
  setQuality(tier: IQualityTier): void;
}
