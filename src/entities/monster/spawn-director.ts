/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THE SPAWN DIRECTOR — PACING, ZONING, AND THE RING RULE                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Decides WHAT appears, WHERE, and — the part that is actually hard — WHEN.
 *
 * ── THE PROBLEM ───────────────────────────────────────────────────────────
 * A city that is always fighting is exhausting; a city that never fights is a
 * walking simulator with a very strong protagonist. Sampling a constant spawn
 * rate produces both at once, in clumps, because a Poisson process has no
 * memory and no shape. So the director does not sample a rate — it runs a
 * CYCLE:
 *
 *     lull ──▶ build ──▶ peak ──▶ cooldown ──▶ lull
 *      38s      26s       34s       18s
 *
 * `lull` is not dead air. It is where the crowd, the traffic, the skyline and
 * the boredom meter get to be the content, and it is the reason the next
 * monster reads as an event rather than as weather. The one adjustment is that
 * an EMPTY lull runs faster: a player who cleared the district does not have
 * to wait out the full timer to be given something, which is the "left idle"
 * half of the brief.
 *
 * ── THE RING RULE, AND WHY IT IS ABSOLUTE ─────────────────────────────────
 * Streaming publishes four rings: R0 full detail, R1 instanced, R2 a single
 * merged block mesh with NO NPCs and NO colliders, R3 pre-baked impostors. A
 * monster spawned in R2 would be invisible, would have nothing to collide
 * with, and would have nobody to threaten — it would exist only as CPU cost
 * and as a nasty surprise when the player walked into its chunk. The director
 * refuses to place one, and `harness/monster` asserts that over thousands of
 * orders rather than trusting this paragraph.
 *
 * It equally refuses to place a monster ON the player. Turning around into
 * something that was not there a moment ago reads as a bug even when it is a
 * spawn, and it is the single cheapest-feeling thing an open world can do.
 *
 * ── WHAT THIS FILE MAY NOT DO ─────────────────────────────────────────────
 * It does not construct monsters, does not touch the scene, and does not
 * import the streaming system it obeys. It emits ORDERS — plain data — and the
 * monster system turns them into brains. `ringAt` and `districtAt` are
 * injected, exactly as combat injects `districtAt` and `lineOfSight`, so the
 * real streaming ring can be handed in without this module ever importing it.
 */

import type { DistrictType, EntityId, ThreatTier, Vec3 } from '@/types';
import { clamp, createRng, type IRandom } from '@/util';
import { archetypesForDistrict } from './archetypes';
import type {
  DistrictTierWeights,
  ISpawnDirectorStats,
  ISpawnOrder,
  ISpawnPolicy,
  SpawnPacingState,
} from './types';

/* -------------------------------------------------------------------------- */
/* Ring geometry — MIRRORED from streaming, never imported                    */
/* -------------------------------------------------------------------------- */

/**
 * Chunk edge length in metres.
 *
 * Mirrors `CHUNK_SIZE` in `src/spatial/constants`. It is duplicated rather
 * than imported because this module may not depend on another system's
 * implementation — and duplicating a constant is a smaller sin than a
 * dependency edge that makes both systems unshippable alone. `ringAt` is
 * injectable precisely so the real streaming answer can override this one.
 */
export const MONSTER_CHUNK_SIZE_METRES = 96;

/**
 * Outer edge of rings R0, R1, R2 in CHUNK UNITS, measured as Chebyshev
 * distance from the streaming focus. Mirrors `RING_OUTER_CHUNKS`.
 */
export const MONSTER_RING_OUTER_CHUNKS: readonly number[] = Object.freeze([1.5, 4.5, 8.5]);

/**
 * Streaming ring at a position, given the focus.
 *
 * Conservative by construction: it measures to the POSITION rather than to its
 * chunk centre, so it can only ever report a ring that is the same or finer
 * than streaming's own answer — and a spawn that is wrongly rejected costs one
 * retry, while a spawn that is wrongly accepted is an invisible monster.
 */
export function ringBetween(position: Vec3, focus: Vec3): number {
  const chebyshev = Math.max(Math.abs(position.x - focus.x), Math.abs(position.z - focus.z));
  const chunks = chebyshev / MONSTER_CHUNK_SIZE_METRES;
  for (let ring = 0; ring < MONSTER_RING_OUTER_CHUNKS.length; ring++) {
    if (chunks <= MONSTER_RING_OUTER_CHUNKS[ring]!) return ring;
  }
  return MONSTER_RING_OUTER_CHUNKS.length;
}

/* -------------------------------------------------------------------------- */
/* Zoning                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Threat-tier weighting per district. Rows need not sum to 1.
 *
 * This table is the game's difficulty curve, and it is expressed as GEOGRAPHY
 * rather than as a level number: the wasteland is where the serious things
 * live, downtown is where the consequences live, and the park is where a
 * wolf-tier pest is the whole afternoon. A player who wants a real fight walks
 * out of town to find one, which is a better system than a slider.
 *
 * Note `heroAssociation` skews high. Monsters go where the heroes are — that
 * is the setting's entire premise, and it also means the district with the
 * best rewards is the one that costs the most to fight in.
 */
export const DISTRICT_TIER_WEIGHTS: DistrictTierWeights = Object.freeze({
  downtown: Object.freeze({ wolf: 0.34, tiger: 0.35, demon: 0.22, dragon: 0.08, god: 0.01 }),
  residential: Object.freeze({ wolf: 0.55, tiger: 0.3, demon: 0.13, dragon: 0.02, god: 0 }),
  industrial: Object.freeze({ wolf: 0.3, tiger: 0.38, demon: 0.25, dragon: 0.07, god: 0 }),
  park: Object.freeze({ wolf: 0.6, tiger: 0.28, demon: 0.12, dragon: 0, god: 0 }),
  waterfront: Object.freeze({ wolf: 0.32, tiger: 0.34, demon: 0.25, dragon: 0.09, god: 0 }),
  wasteland: Object.freeze({ wolf: 0.18, tiger: 0.26, demon: 0.3, dragon: 0.2, god: 0.06 }),
  heroAssociation: Object.freeze({ wolf: 0.2, tiger: 0.3, demon: 0.3, dragon: 0.18, god: 0.02 }),
});

/** Tier order, ascending. Iteration order is stable, which determinism needs. */
const TIER_ORDER: readonly ThreatTier[] = Object.freeze([
  'wolf',
  'tiger',
  'demon',
  'dragon',
  'god',
]);

/* -------------------------------------------------------------------------- */
/* Policy                                                                     */
/* -------------------------------------------------------------------------- */

/** The shipped pacing and placement policy. */
export const DEFAULT_SPAWN_POLICY: ISpawnPolicy = Object.freeze({
  maxActive: 14,
  maxPerTier: Object.freeze({ wolf: 8, tiger: 5, demon: 3, dragon: 1, god: 1 }),
  waveSizeByState: Object.freeze({ lull: 1, build: 2, peak: 3, cooldown: 0 }),
  stateSecondsByState: Object.freeze({ lull: 38, build: 26, peak: 34, cooldown: 18 }),
  waveIntervalSeconds: 7,
  minSpawnDistanceMetres: 34,
  maxSpawnDistanceMetres: 520,
  spawnSeparationMetres: 9,
  maxSpawnRing: 1,
  worldRadiusMetres: 768,
  placementAttempts: 12,
  staleSeconds: 150,
  recycleDistanceMetres: 620,
});

/** Multiplier on the lull clock when nothing at all is alive. */
const EMPTY_LULL_ACCELERATION = 1.8;

/** The cycle, in order. */
const PACING_CYCLE: readonly SpawnPacingState[] = Object.freeze([
  'lull',
  'build',
  'peak',
  'cooldown',
]);

/* -------------------------------------------------------------------------- */
/* Context                                                                    */
/* -------------------------------------------------------------------------- */

/** One live monster, as the director needs to see it. */
export interface ILiveMonsterRef {
  readonly id: EntityId;
  readonly tier: ThreatTier;
  readonly position: Vec3;
  /** Seconds since this monster was placed. */
  readonly age: number;
  /** True when it currently has a target. Engaged monsters are never culled. */
  readonly engaged: boolean;
  /** True for boss minions and scripted actors, which the director ignores. */
  readonly scripted: boolean;
}

/** Everything the director reads about the world, per tick. */
export interface ISpawnContext {
  /** Streaming focus — the player. */
  readonly focus: Vec3;
  /** Every live monster. Read-only; the director never mutates it. */
  readonly live: readonly ILiveMonsterRef[];
  /** True while a boss encounter owns the screen. Suppresses all spawning. */
  readonly encounterActive?: boolean;
}

/** What one tick of the director produced. */
export interface ISpawnDecision {
  readonly orders: readonly ISpawnOrder[];
  /** Monsters that drifted out of relevance and should be recycled. */
  readonly retire: readonly EntityId[];
}

export interface ISpawnDirectorOptions {
  /** Deterministic seed. Same seed plus same tick script = same city. */
  readonly seed: number | string;
  readonly policy?: Partial<ISpawnPolicy>;
  /** District under a position. Absent, everything is residential. */
  readonly districtAt?: (position: Vec3) => DistrictType;
  /**
   * Streaming ring at a position. Absent, the mirrored Chebyshev rule above is
   * used against the focus, which is conservative and correct.
   */
  readonly ringAt?: (position: Vec3) => number;
  /** Ground height, so orders land on the pavement rather than at y=0. */
  readonly groundHeight?: (x: number, z: number) => number;
  /** Pacing state to start in. `lull`, so a session opens quietly. */
  readonly initialState?: SpawnPacingState;
}

/* -------------------------------------------------------------------------- */
/* Director                                                                   */
/* -------------------------------------------------------------------------- */

export class SpawnDirector {
  readonly policy: ISpawnPolicy;

  private readonly rng: IRandom;
  private readonly districtAt: ((position: Vec3) => DistrictType) | undefined;
  private readonly ringAt: ((position: Vec3) => number) | undefined;
  private readonly groundHeight: ((x: number, z: number) => number) | undefined;

  private pacing: SpawnPacingState;
  private secondsInState = 0;
  private waveTimer = 0;
  private waveCounter = 0;
  private serial = 0;
  private ordersIssued = 0;
  private ordersRejected = 0;
  private lastRejection: string | undefined;

  /** Reused across a tick so a wave allocates one array, not one per order. */
  private readonly orders: ISpawnOrder[] = [];
  private readonly retire: EntityId[] = [];
  private readonly tierCandidates: ThreatTier[] = [];
  private readonly tierWeights: number[] = [];
  private readonly activeByTier: Record<ThreatTier, number> = {
    wolf: 0,
    tiger: 0,
    demon: 0,
    dragon: 0,
    god: 0,
  };

  constructor(options: ISpawnDirectorOptions) {
    this.policy = { ...DEFAULT_SPAWN_POLICY, ...options.policy };
    this.rng = createRng(options.seed);
    this.districtAt = options.districtAt;
    this.ringAt = options.ringAt;
    this.groundHeight = options.groundHeight;
    this.pacing = options.initialState ?? 'lull';
  }

  /* ---------------------------------------------------------------------- */
  /* Tick                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Advance pacing and, when the cycle allows, issue a wave.
   *
   * Returns arrays owned by the director and reused on the next tick — copy
   * them if they need to outlive the frame. That is the same contract the
   * streaming system's per-frame lists use, and it is what keeps a director
   * running at 60 Hz from producing garbage.
   */
  update(dt: number, context: ISpawnContext): ISpawnDecision {
    this.orders.length = 0;
    this.retire.length = 0;

    this.tally(context.live);
    this.advancePacing(dt, context);
    this.cull(context);

    // A boss owns the screen. Adding street monsters to a scripted encounter
    // does not raise the stakes, it dilutes them.
    if (context.encounterActive === true) {
      return { orders: this.orders, retire: this.retire };
    }

    this.waveTimer -= dt;
    const size = this.policy.waveSizeByState[this.pacing];
    if (this.waveTimer > 0 || size <= 0) {
      return { orders: this.orders, retire: this.retire };
    }
    this.waveTimer = this.policy.waveIntervalSeconds;
    this.issueWave(size, context);
    return { orders: this.orders, retire: this.retire };
  }

  /* ---------------------------------------------------------------------- */
  /* Pacing                                                                 */
  /* ---------------------------------------------------------------------- */

  private advancePacing(dt: number, context: ISpawnContext): void {
    const unscripted = this.countUnscripted(context.live);
    // An empty lull runs fast. The player who cleared the block should not
    // have to stand in it waiting for a timer they cannot see.
    const scale = this.pacing === 'lull' && unscripted === 0 ? EMPTY_LULL_ACCELERATION : 1;
    this.secondsInState += dt * scale;

    const limit = this.policy.stateSecondsByState[this.pacing];
    if (this.secondsInState < limit) return;

    const index = PACING_CYCLE.indexOf(this.pacing);
    this.pacing = PACING_CYCLE[(index + 1) % PACING_CYCLE.length]!;
    this.secondsInState = 0;
    // A new state gets its first wave promptly; otherwise `peak` would spend
    // its first seven seconds looking exactly like `cooldown`.
    this.waveTimer = Math.min(this.waveTimer, 1.5);
  }

  private tally(live: readonly ILiveMonsterRef[]): void {
    for (const tier of TIER_ORDER) this.activeByTier[tier] = 0;
    for (const monster of live) {
      if (monster.scripted) continue;
      this.activeByTier[monster.tier]++;
    }
  }

  private countUnscripted(live: readonly ILiveMonsterRef[]): number {
    let count = 0;
    for (const monster of live) if (!monster.scripted) count++;
    return count;
  }

  /**
   * Retire monsters that stopped mattering.
   *
   * Two reasons, and engagement vetoes both: a monster that is currently
   * chasing someone is never recycled, because despawning a live threat in
   * front of the player is worse than the cost of keeping it.
   */
  private cull(context: ISpawnContext): void {
    for (const monster of context.live) {
      if (monster.scripted || monster.engaged) continue;
      const dx = monster.position.x - context.focus.x;
      const dz = monster.position.z - context.focus.z;
      const distance = Math.hypot(dx, dz);
      if (distance > this.policy.recycleDistanceMetres || monster.age > this.policy.staleSeconds) {
        this.retire.push(monster.id);
        continue;
      }
      // The ring rule, applied symmetrically. A monster that drifted a full
      // ring past where it was allowed to be placed is now in territory with
      // no NPCs and no colliders — the same reason it could not spawn there is
      // the reason it should not stay there.
      const ring = this.ringAt?.(monster.position) ?? ringBetween(monster.position, context.focus);
      if (ring > this.policy.maxSpawnRing + 1) this.retire.push(monster.id);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Placement                                                              */
  /* ---------------------------------------------------------------------- */

  private issueWave(size: number, context: ISpawnContext): void {
    const waveId = this.waveCounter++;
    // Per-wave stream: wave 7 is identical whether or not waves 1-6 happened,
    // so a replay that starts mid-session still matches.
    const rng = this.rng.derive(`wave:${waveId}`);

    const unscripted = this.countUnscripted(context.live);
    let placed = 0;

    for (let i = 0; i < size; i++) {
      if (unscripted + this.orders.length >= this.policy.maxActive) {
        this.reject('maxActive');
        break;
      }
      const order = this.placeOne(rng.derive(i), waveId, context);
      if (order === undefined) continue;
      this.orders.push(order);
      this.activeByTier[order.tier]++;
      this.ordersIssued++;
      placed++;
    }

    if (placed === 0 && this.lastRejection === undefined) this.reject('noPlacement');
  }

  /** One placement attempt loop. Returns undefined when the wave slot is lost. */
  private placeOne(rng: IRandom, waveId: number, context: ISpawnContext): ISpawnOrder | undefined {
    const policy = this.policy;

    for (let attempt = 0; attempt < policy.placementAttempts; attempt++) {
      /* ---- a point in the annulus around the focus --------------------- */
      const angle = rng.range(0, Math.PI * 2);
      // sqrt keeps the sample uniform by AREA, so the ring nearest the player
      // is not over-represented — which it visibly is with a linear draw.
      const t = Math.sqrt(rng.next());
      const distance =
        policy.minSpawnDistanceMetres +
        t * (policy.maxSpawnDistanceMetres - policy.minSpawnDistanceMetres);
      const x = context.focus.x + Math.sin(angle) * distance;
      const z = context.focus.z + Math.cos(angle) * distance;

      /* ---- world bounds ------------------------------------------------ */
      if (Math.abs(x) > policy.worldRadiusMetres || Math.abs(z) > policy.worldRadiusMetres) {
        this.reject('outsideWorld');
        continue;
      }

      /* ---- THE RING RULE ---------------------------------------------- */
      const probe: Vec3 = { x, y: 0, z };
      const ring = this.ringAt?.(probe) ?? ringBetween(probe, context.focus);
      if (ring > policy.maxSpawnRing) {
        this.reject('ring');
        continue;
      }

      /* ---- never on top of the player --------------------------------- */
      if (distance < policy.minSpawnDistanceMetres) {
        this.reject('tooClose');
        continue;
      }

      /* ---- separation from everything already there -------------------- */
      if (this.tooCrowded(x, z, context)) {
        this.reject('separation');
        continue;
      }

      /* ---- zoning ------------------------------------------------------ */
      const district = this.districtAt?.(probe) ?? 'residential';
      const tier = this.pickTier(district, rng);
      if (tier === undefined) {
        this.reject('tierCapped');
        continue;
      }
      const candidates = archetypesForDistrict(district, tier);
      if (candidates.length === 0) {
        this.reject('noArchetype');
        continue;
      }
      const archetype = rng.pick(candidates);

      const y = this.groundHeight?.(x, z) ?? 0;
      return {
        serial: this.serial++,
        archetypeId: archetype.id,
        tier,
        position: { x, y, z },
        // Facing the player. A monster that spawns looking the other way has
        // to spend its first two seconds turning around, which is exactly when
        // the player is deciding whether it noticed them.
        yaw: Math.atan2(context.focus.x - x, context.focus.z - z),
        district,
        ring,
        waveId,
        distanceFromFocus: distance,
      };
    }
    return undefined;
  }

  private tooCrowded(x: number, z: number, context: ISpawnContext): boolean {
    const min = this.policy.spawnSeparationMetres;
    const minSq = min * min;
    for (const monster of context.live) {
      const dx = monster.position.x - x;
      const dz = monster.position.z - z;
      if (dx * dx + dz * dz < minSq) return true;
    }
    for (const order of this.orders) {
      const dx = order.position.x - x;
      const dz = order.position.z - z;
      if (dx * dx + dz * dz < minSq) return true;
    }
    return false;
  }

  /**
   * Weighted tier draw for a district, with capped tiers removed.
   *
   * Removal rather than re-roll: re-rolling a capped tier biases the result
   * toward whichever tier happens to be adjacent in the table, and the whole
   * point of the zoning table is that its shape is meaningful.
   */
  private pickTier(district: DistrictType, rng: IRandom): ThreatTier | undefined {
    const row = DISTRICT_TIER_WEIGHTS[district];
    this.tierCandidates.length = 0;
    this.tierWeights.length = 0;
    let total = 0;
    for (const tier of TIER_ORDER) {
      const weight = row[tier];
      if (weight <= 0) continue;
      if (this.activeByTier[tier] >= this.policy.maxPerTier[tier]) continue;
      this.tierCandidates.push(tier);
      this.tierWeights.push(weight);
      total += weight;
    }
    if (total <= 0) return undefined;
    return rng.weighted(this.tierCandidates, this.tierWeights);
  }

  private reject(reason: string): void {
    this.ordersRejected++;
    this.lastRejection = reason;
  }

  /* ---------------------------------------------------------------------- */
  /* Control and diagnostics                                                */
  /* ---------------------------------------------------------------------- */

  /** Force a pacing state, for the harness and for scripted set pieces. */
  setPacing(state: SpawnPacingState): void {
    this.pacing = state;
    this.secondsInState = 0;
    this.waveTimer = 0;
  }

  /** Skip the wave timer so the next `update` issues immediately. */
  requestWaveNow(): void {
    this.waveTimer = 0;
  }

  stats(): ISpawnDirectorStats {
    let active = 0;
    for (const tier of TIER_ORDER) active += this.activeByTier[tier];
    return {
      pacing: this.pacing,
      secondsInState: this.secondsInState,
      active,
      activeByTier: { ...this.activeByTier },
      waves: this.waveCounter,
      ordersIssued: this.ordersIssued,
      ordersRejected: this.ordersRejected,
      lastRejection: this.lastRejection,
      nextWaveIn: Math.max(0, this.waveTimer),
    };
  }

  /** Reset to a clean session, keeping the seed. */
  reset(): void {
    this.rng.reset();
    this.pacing = 'lull';
    this.secondsInState = 0;
    this.waveTimer = 0;
    this.waveCounter = 0;
    this.serial = 0;
    this.ordersIssued = 0;
    this.ordersRejected = 0;
    this.lastRejection = undefined;
    this.orders.length = 0;
    this.retire.length = 0;
    for (const tier of TIER_ORDER) this.activeByTier[tier] = 0;
  }
}

/** Clamp a proposed spawn to the world box. Exported for the harness. */
export function clampToWorld(position: Vec3, radiusMetres: number): Vec3 {
  return {
    x: clamp(position.x, -radiusMetres, radiusMetres),
    y: position.y,
    z: clamp(position.z, -radiusMetres, radiusMetres),
  };
}
