/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THE MONSTER SYSTEM — ONE OWNER, ONE SUBSCRIPTION SET, ONE TICK          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Holds every live monster, runs the spawn director, owns the active boss
 * encounter, and is the ONLY thing in this module that touches the event bus's
 * subscribe side. Three hundred monsters do not mean three hundred handlers:
 * one `EntityKilled` subscription serves all of them, which is the difference
 * between a leak-prone system and a system that can be disposed in one call.
 *
 * ── WHAT IT LISTENS TO, AND WHY EACH ONE ──────────────────────────────────
 *   `EntityKilled`      combat is authoritative on death. A brain never
 *                       decides it has died.
 *   `EntityDamaged`     ditto for damage — and for a GATED boss this arrives
 *                       with `amount: 0`, which is exactly why boss phases
 *                       count HITS and not damage.
 *   `ShockwaveFired`    the district wakes up. A serious punch three blocks
 *                       away turns every monster inside its hearing radius
 *                       toward the noise, with no monster subscribing itself.
 *   `AllyDowned`        the hero-NPC workstream owns Mumen Rider. If HE goes
 *                       down before the Deep Sea King script's clock expires,
 *                       the beat is already resolved and the script must not
 *                       fire a second one.
 *   `EncounterEnded`    combat owns that event (see `combat/encounter.ts`).
 *                       This system listens rather than emits.
 *
 * ── WHAT IT EMITS ─────────────────────────────────────────────────────────
 *   `EncounterStarted`  when a boss encounter opens, and when an open-world
 *                       wave first engages the player.
 *   `BossPhaseChanged`  THE GATE. `isFinalPhase: true` is what makes a boss
 *                       killable, and nothing else in the game can produce it.
 *   `ShockwaveFired`    every monster attack and every scripted pulse.
 *
 * It emits no damage, no kills and no `EncounterEnded`, because it is not
 * authoritative on any of those.
 */

import type { DistrictType, EntityId, GameEventOf, IEventBus, ThreatTier, Vec3 } from '@/types';
import { clamp01, createRng, type IRandom } from '@/util';
import { monsterArchetype } from './archetypes';
import { BossEncounter, type IEncounterAlly } from './boss-encounter';
import { bossScript } from './boss-scripts';
import { Monster, type SceneNode } from './monster';
import { SpawnDirector, type ILiveMonsterRef, type ISpawnDirectorOptions } from './spawn-director';
import type {
  IBossPhaseState,
  IMonsterArchetype,
  IMonsterSnapshot,
  IMonsterTarget,
  IMonsterWorld,
  ISpawnDirectorStats,
  ISpawnOrder,
  ISpawnPolicy,
} from './types';

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

export interface IMonsterSystemOptions {
  readonly bus: IEventBus;
  /** Deterministic seed. Same seed plus same tick script = same world. */
  readonly seed: number | string;
  readonly policy?: Partial<ISpawnPolicy>;
  readonly districtAt?: (position: Vec3) => DistrictType;
  readonly ringAt?: (position: Vec3) => number;
  readonly groundHeight?: (x: number, z: number) => number;
  readonly lineOfSight?: (from: Vec3, to: Vec3) => boolean;
  /** Scene parent for monster roots. Omitted, roots are unparented. */
  readonly parent?: SceneNode;
  /**
   * Called once for every monster placed, before its first tick.
   *
   * THE seam between behaviour and geometry: the host resolves
   * `archetype.assetKey` through the roster and `ICharacterFactory` and calls
   * `monster.attach(instance)`. This module never does, and a monster with no
   * body ticks perfectly well — which is what lets every test in
   * `__tests__` run with no renderer at all.
   */
  readonly onSpawned?: (monster: Monster) => void;
  /** Called just before a monster is disposed, so the host can release its body. */
  readonly onDespawned?: (monster: Monster) => void;
  /** Seconds a corpse stays in the world before disposal. */
  readonly corpseSeconds?: number;
}

/** What the host pushes in every frame. */
export interface IMonsterFrame {
  /** Seconds since boot. Monotonic. */
  readonly time: number;
  /** Streaming focus — the player. */
  readonly focus: Vec3;
  /** Everything monsters may notice: the player, allies, civilians. */
  readonly targets: readonly IMonsterTarget[];
}

/**
 * A monster, described in exactly the fields combat's target registry needs.
 *
 * Plain data, deliberately: this module may not import `@/gameplay/combat`, so
 * the integration layer maps this onto `ICombatTargetSpec`. Every field here
 * exists on that interface under the same name, so the mapping is a spread.
 */
export interface IMonsterCombatDescriptor {
  readonly id: EntityId;
  readonly type: 'monster';
  readonly faction: 'monster';
  /**
   * The AIM POINT — mid-body, not the feet.
   *
   * `Monster.transform.position` is at ground level, which is right for
   * navigation and wrong for hit resolution: the resolver tests a SPHERE
   * centred on this point, and a sphere centred on a 3 m monster's feet is a
   * sphere the player has to punch the pavement to reach. A jab thrown at
   * chest height at something visibly within arm's reach must connect, so the
   * descriptor lifts the centre to half the body height.
   */
  readonly position: Vec3;
  /**
   * Radius of that sphere — the TORSO, not the footprint.
   *
   * `archetype.radiusMetres` is the horizontal silhouette used by the spatial
   * broad phase. Reused verbatim as a sphere radius it would make a tall
   * monster a narrow ball floating at chest height, so this widens it to
   * 0.42 × body height, which is the sphere that actually contains a
   * humanoid's torso and head.
   */
  readonly radius: number;
  readonly massKg: number;
  readonly maxHealth: number;
  readonly health: number;
  readonly displayName: string;
  readonly threatTier: ThreatTier;
  readonly specId: string;
  readonly isBoss: boolean;
  /** THE GATE, in the exact field name combat's registry reads. */
  readonly phaseResolved: boolean;
  readonly rewardPoints: number;
}

/* -------------------------------------------------------------------------- */
/* Scripted minion budget                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Live minions `summon` will carry at once.
 *
 * Scripted monsters are invisible to the spawn director in both directions —
 * they do not count against its budget and its recycler will not touch them —
 * which is exactly right for the fourteen a phase places and a leak for the
 * fourteen an ATTACK places every sixteen seconds. Mosquito Girl's `summon`
 * competes with `dive` on weight for the length of her encounter, so a player
 * who takes their time accumulates a hundred-plus permanent, inert entities,
 * each one a full brain per frame, a combat target and a crowd threat.
 *
 * Twenty-eight is a phase's full swarm plus one volley on top of it. Past that
 * a volley places what fits and no more: fewer mosquitoes is a tuning
 * disappointment, unbounded mosquitoes is a frame-rate cliff.
 */
export const MAX_SCRIPTED_MINIONS = 28;

/* -------------------------------------------------------------------------- */
/* World view                                                                 */
/* -------------------------------------------------------------------------- */

/** One reused object, so a frame with 300 monsters allocates no world views. */
class WorldView implements IMonsterWorld {
  time = 0;
  targets: readonly IMonsterTarget[] = [];
  lineOfSight: ((from: Vec3, to: Vec3) => boolean) | undefined;
  groundHeight: ((x: number, z: number) => number) | undefined;
  ringAt: ((position: Vec3) => number) | undefined;
  districtAt: ((position: Vec3) => DistrictType) | undefined;
}

/* -------------------------------------------------------------------------- */
/* System                                                                     */
/* -------------------------------------------------------------------------- */

export class MonsterSystem {
  readonly bus: IEventBus;
  readonly director: SpawnDirector;

  private readonly rng: IRandom;
  private readonly parent: SceneNode | undefined;
  private readonly onSpawned: IMonsterSystemOptions['onSpawned'];
  private readonly onDespawned: IMonsterSystemOptions['onDespawned'];
  private readonly corpseSeconds: number;
  private readonly unsubscribes: (() => void)[] = [];

  private readonly monsters = new Map<EntityId, Monster>();
  /** Everything `summon` placed, so the script that owns them can release them. */
  private readonly scriptedMinions = new Set<EntityId>();
  private readonly corpses = new Map<EntityId, number>();
  private readonly world = new WorldView();
  private readonly liveRefs: ILiveMonsterRef[] = [];
  private readonly reap: EntityId[] = [];

  private encounter: BossEncounter | undefined;
  private encounterBoss: Monster | undefined;

  private serial = 0;
  private time = 0;
  /**
   * Set by `dispose()`, checked by `update()`.
   *
   * Without it a disposed system silently repopulates itself: the
   * subscriptions are gone but the director still runs, still issues orders,
   * and `materialise` still turns them into live monsters — each with a scene
   * node and a ticking brain, and none of them reachable by `EntityKilled` or
   * `EntityDamaged` any more, so they can never die and never be swept.
   * `CrowdSystem` and `CombatSystem` both carry the same flag.
   */
  private disposed = false;

  /** Waves that have engaged the player, so one wave announces itself once. */
  private readonly announcedWaves = new Set<number>();
  private readonly waveOfMonster = new Map<EntityId, number>();

  constructor(options: IMonsterSystemOptions) {
    this.bus = options.bus;
    this.rng = createRng(options.seed);
    this.parent = options.parent;
    this.onSpawned = options.onSpawned;
    this.onDespawned = options.onDespawned;
    this.corpseSeconds = options.corpseSeconds ?? 6;

    const directorOptions: ISpawnDirectorOptions = {
      seed: `${String(options.seed)}:director`,
      policy: options.policy,
      districtAt: options.districtAt,
      ringAt: options.ringAt,
      groundHeight: options.groundHeight,
    };
    this.director = new SpawnDirector(directorOptions);

    this.world.lineOfSight = options.lineOfSight;
    this.world.groundHeight = options.groundHeight;
    this.world.ringAt = options.ringAt;
    this.world.districtAt = options.districtAt;

    this.unsubscribes.push(
      this.bus.on('EntityKilled', (event) => this.onEntityKilled(event)),
      this.bus.on('EntityDamaged', (event) => this.onEntityDamaged(event)),
      this.bus.on('ShockwaveFired', (event) => this.onShockwave(event)),
      this.bus.on('AllyDowned', (event) => this.onAllyDowned(event)),
      this.bus.on('EncounterEnded', (event) => this.onEncounterEnded(event))
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Queries                                                                */
  /* ---------------------------------------------------------------------- */

  get count(): number {
    return this.monsters.size;
  }

  get activeEncounter(): BossEncounter | undefined {
    return this.encounter;
  }

  get boss(): Monster | undefined {
    return this.encounterBoss;
  }

  get(id: EntityId): Monster | undefined {
    return this.monsters.get(id);
  }

  all(): readonly Monster[] {
    return [...this.monsters.values()];
  }

  /**
   * THE GATE, directly readable.
   *
   * True for every non-boss monster from the moment it spawns — a wolf and a
   * god-tier threat are equally killable — and true for a boss only once its
   * scripted phase has resolved. Combat reads its own mirror of this, set from
   * the `BossPhaseChanged` event; this accessor exists for the HUD, for tests
   * and for anything that would rather poll than subscribe.
   */
  isPhaseResolved(id: EntityId): boolean {
    const monster = this.monsters.get(id);
    return monster === undefined ? true : monster.brain.phaseResolved;
  }

  /** Live boss phase state, or undefined when no boss encounter is running. */
  phaseState(): IBossPhaseState | undefined {
    return this.encounter?.state();
  }

  snapshots(): IMonsterSnapshot[] {
    const out: IMonsterSnapshot[] = [];
    for (const monster of this.monsters.values()) out.push(monster.snapshot());
    return out;
  }

  stats(): ISpawnDirectorStats {
    return this.director.stats();
  }

  /** Every live monster, in the shape combat's target registry wants. */
  describeForCombat(): IMonsterCombatDescriptor[] {
    const out: IMonsterCombatDescriptor[] = [];
    for (const monster of this.monsters.values()) {
      const archetype = monster.archetype;
      const position = monster.brain.position;
      out.push({
        id: monster.id,
        type: 'monster',
        faction: 'monster',
        // A fresh object, not the live vector: this is the aim point, which is
        // half a body above where the monster is standing.
        position: {
          x: position.x,
          y: position.y + archetype.bodyHeightMetres * 0.5,
          z: position.z,
        },
        radius: Math.max(archetype.radiusMetres, archetype.bodyHeightMetres * 0.42),
        massKg: archetype.massKg,
        maxHealth: archetype.maxHealth,
        health: monster.brain.health,
        displayName: archetype.name,
        threatTier: archetype.threatTier,
        specId: archetype.id,
        isBoss: archetype.isBoss,
        phaseResolved: monster.brain.phaseResolved,
        rewardPoints: archetype.rewardPoints,
      });
    }
    return out;
  }

  /* ---------------------------------------------------------------------- */
  /* Tick                                                                   */
  /* ---------------------------------------------------------------------- */

  update(dt: number, frame: IMonsterFrame): void {
    if (this.disposed) return;
    this.time = frame.time;
    this.world.time = frame.time;
    this.world.targets = frame.targets;

    /* ---- brains -------------------------------------------------------- */
    for (const monster of this.monsters.values()) {
      monster.tick(dt, this.world);
    }

    /* ---- the boss script ------------------------------------------------ */
    if (this.encounter !== undefined && !this.encounter.finished) {
      this.encounter.update(dt, frame.focus);
      if (this.encounterBoss !== undefined) {
        this.encounterBoss.bossPhaseIndex = this.encounter.currentPhaseIndex;
      }
    }

    /* ---- open-world announcements --------------------------------------- */
    this.announceEngagements();

    /* ---- the director --------------------------------------------------- */
    this.collectLiveRefs();
    const decision = this.director.update(dt, {
      focus: frame.focus,
      live: this.liveRefs,
      encounterActive: this.encounter !== undefined && !this.encounter.finished,
    });
    for (const id of decision.retire) this.despawn(id);
    for (const order of decision.orders) this.materialise(order);

    /* ---- corpses -------------------------------------------------------- */
    this.sweepCorpses(dt);
  }

  /**
   * Announce an open-world wave the first time any of its monsters acquires a
   * target, whoever that target is.
   *
   * Not "the first time it engages the player": the condition is
   * `currentTargetId !== undefined`, and this module is handed a list of
   * `IMonsterTarget`s with no way to tell which of them is the player. A wave
   * that noticed a fleeing civilian announces itself, by design — that is a
   * fight starting too.
   *
   * `EncounterStarted` is what the audio system keys the tier-sized
   * `monster.roar` off, what the crowd keys its panic off, and what combat
   * keys the scorecard off — so it has to fire when a fight actually STARTS,
   * not when a monster is placed 300 m away in a chunk the player will never
   * visit. One announcement per wave, keyed by the highest tier in it.
   */
  private announceEngagements(): void {
    for (const monster of this.monsters.values()) {
      if (monster.scripted || monster.isDead) continue;
      const wave = this.waveOfMonster.get(monster.id);
      if (wave === undefined || this.announcedWaves.has(wave)) continue;
      if (monster.brain.currentTargetId === undefined) continue;

      this.announcedWaves.add(wave);
      const participants: EntityId[] = [];
      let tier: ThreatTier = monster.archetype.threatTier;
      let best = 0;
      for (const other of this.monsters.values()) {
        if (this.waveOfMonster.get(other.id) !== wave) continue;
        participants.push(other.id);
        const rank = TIER_RANK[other.archetype.threatTier];
        if (rank > best) {
          best = rank;
          tier = other.archetype.threatTier;
        }
      }
      this.bus.emit('EncounterStarted', {
        encounterId: `wave.${wave}`,
        threatTier: tier,
        position: monster.brain.position,
        radius: 40,
        participantIds: participants,
        isBoss: false,
      });
      // One announcement per frame keeps a whole district engaging at once
      // from putting five roars on the same millisecond.
      return;
    }
  }

  private collectLiveRefs(): void {
    this.liveRefs.length = 0;
    for (const monster of this.monsters.values()) {
      if (monster.isDead) continue;
      this.liveRefs.push({
        id: monster.id,
        tier: monster.archetype.threatTier,
        position: monster.brain.position,
        age: monster.age,
        engaged: monster.brain.currentTargetId !== undefined,
        scripted: monster.scripted,
      });
    }
  }

  private sweepCorpses(dt: number): void {
    if (this.corpses.size === 0) return;
    this.reap.length = 0;
    for (const [id, remaining] of this.corpses) {
      const next = remaining - dt;
      if (next <= 0) this.reap.push(id);
      else this.corpses.set(id, next);
    }
    for (const id of this.reap) {
      this.corpses.delete(id);
      this.despawn(id);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Spawning                                                               */
  /* ---------------------------------------------------------------------- */

  private materialise(order: ISpawnOrder): Monster {
    const monster = this.spawn(monsterArchetype(order.archetypeId), order.position, order.yaw);
    this.waveOfMonster.set(monster.id, order.waveId);
    return monster;
  }

  /**
   * Place a monster.
   *
   * The id encodes the archetype and a monotonic serial, which makes a log
   * line readable and — more usefully — makes the per-monster random stream
   * reproducible from the id alone.
   */
  spawn(
    archetype: IMonsterArchetype,
    position: Vec3,
    yaw = 0,
    options: { readonly scripted?: boolean } = {}
  ): Monster {
    const serial = this.serial++;
    const id: EntityId = `${archetype.id}#${serial}`;
    const monster = new Monster({
      id,
      archetype,
      bus: this.bus,
      rng: this.rng.derive(id),
      position,
      yaw,
      parent: this.parent,
      onSummon: (archetypeId, count, origin) => {
        this.summon(archetypeId, count, origin);
      },
    });
    monster.scripted = options.scripted ?? false;
    this.monsters.set(id, monster);
    this.onSpawned?.(monster);
    return monster;
  }

  /**
   * Release minions around a point.
   *
   * Scripted, so the spawn director neither counts them against its budget nor
   * culls them: a swarm that despawned because the director thought the
   * district was busy would silently unblock its own phase gate. That immunity
   * is why the volley is capped here — nothing downstream of this call will
   * ever retire one, so this is the only place a bound can live. See
   * `MAX_SCRIPTED_MINIONS`.
   */
  summon(archetypeId: string, count: number, origin: Vec3): EntityId[] {
    const archetype = monsterArchetype(archetypeId);
    const rng = this.rng.derive(`summon:${archetypeId}:${this.serial}`);
    const ids: EntityId[] = [];
    const room = Math.max(0, MAX_SCRIPTED_MINIONS - this.scriptedMinions.size);
    const wanted = Math.min(count, room);
    for (let i = 0; i < wanted; i++) {
      const angle = (i / Math.max(1, wanted)) * Math.PI * 2 + rng.range(-0.25, 0.25);
      const radius = rng.range(2.5, 7);
      const monster = this.spawn(
        archetype,
        {
          x: origin.x + Math.sin(angle) * radius,
          y: origin.y + archetype.movement.hoverHeightMetres * 0.5,
          z: origin.z + Math.cos(angle) * radius,
        },
        angle + Math.PI,
        { scripted: true }
      );
      ids.push(monster.id);
      this.scriptedMinions.add(monster.id);
    }
    return ids;
  }

  /** Remove a monster now, disposing its scene node. */
  despawn(id: EntityId): void {
    const monster = this.monsters.get(id);
    if (monster === undefined) return;
    this.onDespawned?.(monster);
    monster.dispose();
    this.monsters.delete(id);
    this.scriptedMinions.delete(id);
    this.corpses.delete(id);
    this.waveOfMonster.delete(id);
    // Never hand out a disposed body: `boss` is read by the HUD and the
    // harness, and the corpse sweep disposes the boss `corpseSeconds` after a
    // legitimate kill.
    if (this.encounterBoss?.id === id) this.encounterBoss = undefined;
  }

  /* ---------------------------------------------------------------------- */
  /* Boss encounters                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Open one of the four scripted encounters.
   *
   * Places the boss, builds the script runner, emits `EncounterStarted`, and
   * enters phase 0 — which, for every script that has more than one phase,
   * CLOSES the kill gate. From this moment a lethal punch is absorbed until
   * the script says otherwise.
   */
  startBossEncounter(
    encounterId: string,
    position: Vec3,
    options: { readonly yaw?: number; readonly ally?: IEncounterAlly } = {}
  ): BossEncounter {
    // Opening a second encounter over the top of a live one used to strand the
    // first boss: gated for ever, invisible to the recycler, and no longer
    // reachable by any hit that could re-open the gate.
    this.closeEncounter();
    const script = bossScript(encounterId);
    const archetype = monsterArchetype(script.archetypeId);
    const boss = this.spawn(archetype, position, options.yaw ?? 0, { scripted: true });

    const encounter = new BossEncounter({
      bus: this.bus,
      script,
      boss: boss.brain,
      rng: this.rng.derive(`encounter:${encounterId}`),
      ally: options.ally,
      onSummon: (archetypeId, count, origin) => this.summon(archetypeId, count, origin),
    });

    this.encounter = encounter;
    this.encounterBoss = boss;
    encounter.begin(this.time);
    boss.bossPhaseIndex = encounter.currentPhaseIndex;
    return encounter;
  }

  /** Abandon the active encounter without a victory, e.g. on a fast travel. */
  abortEncounter(): void {
    this.closeEncounter();
  }

  /**
   * ══════════════════════════════════════════════════════════════════════
   *  THE ONE TEARDOWN PATH — dropping the reference is not enough
   * ══════════════════════════════════════════════════════════════════════
   * A boss is spawned `scripted` and starts GATED, and both of those are
   * written on the assumption that a script is running. Forgetting the script
   * without undoing them leaves the worst object in the game behind: a boss
   * with `phaseResolved === false`, so `describeForCombat` keeps telling the
   * resolver to absorb every lethal punch; with nothing left to call
   * `onBossHit`, so no hit can ever re-open the gate; and `scripted`, so the
   * director will not recycle it and it has no corpse timer. It walks the city
   * for the rest of the session emitting full-intent cones.
   *
   * So: release the gate, hand the boss back to the ordinary rules, and clear
   * the minions the script — not the world — put there.
   */
  private closeEncounter(): void {
    const encounter = this.encounter;
    const boss = this.encounterBoss;
    this.encounter = undefined;
    this.encounterBoss = undefined;
    if (encounter === undefined) return;

    // The script placed these and the script is over. Nothing else can ever
    // retire a scripted minion, and they have no corpse timer of their own.
    for (const id of [...this.scriptedMinions]) this.despawn(id);
    this.scriptedMinions.clear();

    if (boss === undefined || boss.isDead || boss.brain.phaseResolved) return;
    boss.scripted = false;
    boss.brain.phaseResolved = true;
    const finalPhase = Math.max(0, encounter.script.phases.length - 1);
    this.bus.emit('BossPhaseChanged', {
      entityId: boss.id,
      specId: boss.archetype.id,
      previousPhase: boss.bossPhaseIndex,
      phase: finalPhase,
      healthFraction: clamp01(boss.brain.health / Math.max(1, boss.archetype.maxHealth)),
      isFinalPhase: true,
    });
    boss.bossPhaseIndex = finalPhase;
  }

  /* ---------------------------------------------------------------------- */
  /* Bus handlers                                                           */
  /* ---------------------------------------------------------------------- */

  private onEntityKilled(event: GameEventOf<'EntityKilled'>): void {
    const monster = this.monsters.get(event.entityId);
    if (monster === undefined) return;
    monster.brain.onKilled();
    this.corpses.set(event.entityId, this.corpseSeconds);

    const encounter = this.encounter;
    if (encounter === undefined) return;
    if (event.entityId === encounter.bossId) encounter.onBossKilled();
    else encounter.onMonsterKilled(event.entityId);
  }

  private onEntityDamaged(event: GameEventOf<'EntityDamaged'>): void {
    const monster = this.monsters.get(event.entityId);
    if (monster === undefined) return;
    monster.brain.onDamaged(event.healthRemaining, event.amount);
    // A hit is a hit even when it dealt nothing: a gated boss reports
    // `amount: 0` by design, and the phase counts contacts.
    if (this.encounter !== undefined && event.entityId === this.encounter.bossId) {
      this.encounter.onBossHit();
    }
  }

  /**
   * A shockwave went off somewhere. Wake the neighbourhood.
   *
   * Intensity is log-scaled from `power` for the same reason audio and the
   * camera do it: `power` spans six decades, so a linear read would round
   * every ordinary punch to zero and make the whole dial live inside the last
   * one per cent of a serious hit.
   */
  private onShockwave(event: GameEventOf<'ShockwaveFired'>): void {
    // Monsters do not chase each other's noise. Without this, a swarm alerts
    // itself into a permanent `alerted` loop and never idles again.
    if (event.sourceId !== undefined && this.monsters.has(event.sourceId)) return;
    // The bus is somebody else's surface. A non-finite power or origin would
    // pass every distance test below (NaN comparisons are false) and either
    // wake the entire map or write NaN into a brain's position permanently:
    // `clamp01(NaN)` is `NaN`, `NaN <= 0` is false, and `distance > NaN` is
    // false for every monster at every distance.
    if (!Number.isFinite(event.power)) return;
    if (
      !Number.isFinite(event.origin.x) ||
      !Number.isFinite(event.origin.y) ||
      !Number.isFinite(event.origin.z)
    ) {
      return;
    }
    const intensity = event.power <= 1 ? 0 : clamp01(Math.log10(event.power) / 6);
    if (intensity <= 0) return;
    for (const monster of this.monsters.values()) {
      if (monster.isDead) continue;
      monster.brain.notice(event.origin.x, event.origin.y, event.origin.z, intensity);
    }
  }

  private onAllyDowned(event: GameEventOf<'AllyDowned'>): void {
    this.encounter?.onAllyDowned(event.entityId);
  }

  private onEncounterEnded(event: GameEventOf<'EncounterEnded'>): void {
    const encounter = this.encounter;
    if (encounter === undefined) return;
    encounter.onEncounterEnded(event.encounterId);
    // Whoever ended it and however it ended — victory, 'fled', 'aborted' —
    // the same teardown runs. `EncounterEnded` carries an outcome this module
    // is deliberately not authoritative on, and a boss left standing after a
    // retreat must still be killable.
    if (encounter.finished) this.closeEncounter();
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                              */
  /* ---------------------------------------------------------------------- */

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
    for (const monster of this.monsters.values()) {
      this.onDespawned?.(monster);
      monster.dispose();
    }
    this.monsters.clear();
    this.scriptedMinions.clear();
    this.corpses.clear();
    this.waveOfMonster.clear();
    this.announcedWaves.clear();
    this.encounter = undefined;
    this.encounterBoss = undefined;
  }
}

/** Tier ranks, for choosing the loudest member of a wave. */
const TIER_RANK: Readonly<Record<ThreatTier, number>> = Object.freeze({
  wolf: 0,
  tiger: 1,
  demon: 2,
  dragon: 3,
  god: 4,
});
