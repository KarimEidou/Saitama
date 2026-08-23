/**
 * THE DESTRUCTION SYSTEM — WHERE THE CITY ACTUALLY BREAKS
 *
 * Everything else in this game is a setup for one moment: the punch lands and
 * three blocks of City Z stop existing. This is the file that has to deliver
 * it, and the reason it can is that almost none of the work happens here.
 *
 *   • The city ships PRE-FRACTURED. A 12-storey building is 48 chunks with
 *     baked vertex ranges, masses, centroids and AABBs. There is no runtime
 *     Voronoi, no CSG, no re-index.
 *   • Removing a chunk is `Uint8Array.fill(255, start, start + count)` on a
 *     per-vertex attribute the vertex shader degenerates. One memory fill and
 *     one partial buffer upload, on a range the generator already computed.
 *   • Physics owns the 300-body debris pool, the LRU, the fade and the
 *     ballistic gravel path. Destruction hands over mass, centroid and AABB.
 *   • Streaming owns the 8 KB persistent bitmask. Destruction writes bits.
 *
 * What is genuinely decided here is the part that reads as spectacle:
 *
 *   WHICH chunks a shockwave takes (a conservative cone sweep, so a punch
 *   carves a tunnel rather than deleting whole buildings),
 *   WHEN a structure stops standing (per-floor support, >60% lost),
 *   HOW it comes down (staggered across three frames, lowest storey first, so
 *   a collapse reads as a wave travelling up the building), and
 *   WITH WHAT VELOCITY every piece leaves (a target Δv scaled by mass, so a
 *   400 kg parapet and a 9000 kg slab leave the wall together).
 *
 * ── EMISSION, NOT CONSUMPTION ──────────────────────────────────────────────
 * `ChunkDetached` is emitted HERE, once per piece. Combat's scorecard prices
 * it, VFX turns it into dust and debris trails, audio picks a material impact
 * — and none of them import this directory, exactly as
 * `src/gameplay/combat/structures.ts` promises. The system also ACCEPTS
 * `ChunkDetached` from elsewhere (scripted set-pieces, replay), which is safe
 * because every detach path is idempotent AND a foreign detach is applied
 * silently — the event is already on the bus, so echoing it would make every
 * other subscriber count the piece twice.
 *
 * ── ALLOCATION ─────────────────────────────────────────────────────────────
 * Zero per detach in the steady state. Scratch vectors, the event payload, the
 * debris box geometries, the collapse queue and the impact ring are all
 * allocated once. See `__tests__/allocation.test.ts`, which measures it.
 */

import * as THREE from 'three';
import type { EntityId, GameEventOf, IEventBus, LethalIntent, Vec3 } from '@/types';
import { clamp, clamp01, createRng, hashString, mixSeeds, type IRandom } from '@/util';
import {
  BLAST_DELTA_V_FAR,
  BLAST_DELTA_V_NEAR,
  BLAST_LIFT_FRACTION,
  BLAST_SPREAD_FRACTION,
  COLLAPSE_DELTA_V,
  COLLAPSE_OUTWARD_DELTA_V,
  DEBRIS_HARD_CAP,
  DESTRUCTION_RNG_LABEL,
  DETACH_JITTER_DELTA_V,
  IMPACT_HISTORY,
  INTENT_BLAST_SCALE,
  INTENT_RANK,
  MINIMUM_DESTRUCTIVE_INTENT_RANK,
  RAGDOLL_DELTA_V_NEAR,
  RAGDOLL_IMPACT_RADIUS,
  RAGDOLL_IMPACT_WINDOW_SECONDS,
  RAGDOLL_MASS_KG,
} from './constants';
import { CollapseScheduler } from './collapse-scheduler';
import { DebrisShapePool } from './debris-shapes';
import { damageSlot, pieceForChunk } from './damage-address';
import { aabbInCone, aabbInSphere, normaliseInto } from './geometry';
import { collapsingFloors as fallbackCollapsingFloors } from './support';
import { RegisteredStructure, type DetachCause } from './structure';
import type {
  CollapsingFloorsFn,
  IDamageSink,
  IDebrisSink,
  IRagdollSink,
  IStructureSpec,
} from './ports';

/* -------------------------------------------------------------------------- */
/* Options and telemetry                                                      */
/* -------------------------------------------------------------------------- */

export interface IDestructionSystemOptions {
  /** The bus. Subscribed immediately; unsubscribed on `dispose()`. */
  readonly bus: IEventBus;
  /** Physics debris budget. Omit to run visual-only (tests, headless replay). */
  readonly debris?: IDebrisSink;
  /** Persistent damage bitmask. Omit to run without persistence. */
  readonly damage?: IDamageSink;
  /** Ragdoll launcher. Omit and nobody gets thrown. */
  readonly ragdolls?: IRagdollSink;
  /**
   * The authoritative "which floors fail" rule. Inject the city generator's
   * `collapsingFloors`; the local fallback is behaviourally identical and
   * exists so this system runs standalone.
   */
  readonly collapsingFloors?: CollapsingFloorsFn;
  /** Seed for detach jitter. Same seed + same punch = identical result. */
  readonly seed?: number | string;
  /** Lowest `LethalIntent` that may damage structures. Default `normal`. */
  readonly minimumIntent?: LethalIntent;
  /**
   * Replay the coarse persistent bitmask onto a structure that has no exact
   * ledger entry — i.e. a city restored from a save file. Default true.
   */
  readonly restoreFromDamageMask?: boolean;
  /** Exact per-structure ledger entries retained. Default 8192 (~400 KB). */
  readonly maxLedgerEntries?: number;
}

/** Live counters. The same object every frame; copy it if you keep it. */
export interface IDestructionStats {
  readonly structures: number;
  readonly damagedStructures: number;
  readonly chunksDestroyed: number;
  readonly chunksDestroyedThisFrame: number;
  readonly debrisSpawned: number;
  readonly debrisLive: number;
  /** Detaches that removed geometry but spawned no body: the cap held. */
  readonly visualOnlyDetaches: number;
  readonly collapsesTriggered: number;
  readonly floorsCollapsed: number;
  readonly pendingCollapseChunks: number;
  readonly ragdollsLaunched: number;
  readonly ragdollsSuppressed: number;
  readonly destroyedMassKg: number;
  readonly collateralTotal: number;
  /** Bits newly set in the persistent damage bitmask. */
  readonly persistedPieces: number;
  /** Chunks replayed onto freshly streamed-in geometry. */
  readonly restoredChunks: number;
  readonly frame: number;
}

interface IMutableStats {
  structures: number;
  damagedStructures: number;
  chunksDestroyed: number;
  chunksDestroyedThisFrame: number;
  debrisSpawned: number;
  debrisLive: number;
  visualOnlyDetaches: number;
  collapsesTriggered: number;
  floorsCollapsed: number;
  pendingCollapseChunks: number;
  ragdollsLaunched: number;
  ragdollsSuppressed: number;
  destroyedMassKg: number;
  collateralTotal: number;
  persistedPieces: number;
  restoredChunks: number;
  frame: number;
}

/** Mutable mirror of `ChunkDetachedEvent`'s payload, reused every emit. */
interface IMutableDetachPayload {
  structureId: string;
  chunkIndex: number;
  position: { x: number; y: number; z: number };
  mass: number;
  impulse: { x: number; y: number; z: number };
  material: string;
  collateralCost: number;
}

/* -------------------------------------------------------------------------- */
/* Deterministic jitter                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A float in [-1, 1) derived from a seed triple.
 *
 * Order-INDEPENDENT by construction: the value for chunk 17 of building B is
 * the same whether it detached first or fortieth, so a punch is reproducible
 * regardless of how the sweep happened to visit structures. This is the same
 * discipline `src/physics` uses for ragdoll tumble, and it is the only reason
 * "same seed, same punch, identical result" survives a change in registration
 * order.
 */
function signedUnit(seed: number, a: number, b: number): number {
  const h = mixSeeds(mixSeeds(seed, a >>> 0), b >>> 0);
  return h / 2147483648 - 1;
}

/* -------------------------------------------------------------------------- */
/* The system                                                                 */
/* -------------------------------------------------------------------------- */

export class DestructionSystem {
  readonly shapes: DebrisShapePool;

  private readonly bus: IEventBus;
  private readonly debris: IDebrisSink | undefined;
  private readonly damage: IDamageSink | undefined;
  private readonly ragdolls: IRagdollSink | undefined;
  private readonly collapsingFloorsFn: CollapsingFloorsFn;
  private readonly rng: IRandom;
  private readonly seed: number;
  private readonly minimumIntentRank: number;
  private readonly restoreFromMask: boolean;
  private readonly maxLedgerEntries: number;

  private readonly byId = new Map<string, RegisteredStructure>();
  /**
   * Structures in id order. Sweeps iterate THIS, never the map, so the set of
   * chunks a punch takes does not depend on registration order — which is the
   * order streaming happens to load chunks in, i.e. the order the player
   * happened to walk.
   */
  private readonly ordered: RegisteredStructure[] = [];

  /** Exact per-structure destroyed sets, retained across stream-out/in. */
  private readonly ledger = new Map<string, Uint8Array>();

  private readonly scheduler = new CollapseScheduler();

  private readonly unsubscribes: (() => void)[] = [];
  private disposed = false;

  /** Internal clock and frame counter; never trusts the bus stamp. */
  private clock = 0;
  private frameIndex = 0;

  /** Recent impacts, for the "died near an explosion" ragdoll rule. */
  private readonly impactRing = new Float64Array(IMPACT_HISTORY * 5);
  private impactCount = 0;

  private emittingDetach = false;

  /**
   * True once `update()` has closed the frame's detach window.
   *
   * `chunksDestroyedThisFrame` has to survive being read on BOTH sides of the
   * update: a blast lands between updates and a debug HUD reads the counter
   * after `update()`, so zeroing it at the top of `update()` guarantees the one
   * number that shows a punch's cost never shows it. Instead the window is
   * closed here and cleared lazily by the first detach that opens the next one.
   */
  private frameWindowClosed = true;

  private readonly stats: IMutableStats = {
    structures: 0,
    damagedStructures: 0,
    chunksDestroyed: 0,
    chunksDestroyedThisFrame: 0,
    debrisSpawned: 0,
    debrisLive: 0,
    visualOnlyDetaches: 0,
    collapsesTriggered: 0,
    floorsCollapsed: 0,
    pendingCollapseChunks: 0,
    ragdollsLaunched: 0,
    ragdollsSuppressed: 0,
    destroyedMassKg: 0,
    collateralTotal: 0,
    persistedPieces: 0,
    restoredChunks: 0,
    frame: 0,
  };

  /* -------- scratch, all allocated once -------- */
  private readonly axis = new Float64Array(3);
  private readonly chunkBounds = new Float64Array(6);
  private readonly chunkCentre = new Float64Array(3);
  private readonly deltaV = new Float64Array(3);
  private readonly impulseVec = new THREE.Vector3();
  private readonly payload: IMutableDetachPayload = {
    structureId: '',
    chunkIndex: 0,
    position: { x: 0, y: 0, z: 0 },
    mass: 0,
    impulse: { x: 0, y: 0, z: 0 },
    material: 'concrete',
    collateralCost: 0,
  };
  /** Reused impulse handed to the ragdoll sink. */
  private readonly ragdollImpulse = { x: 0, y: 0, z: 0 };
  /**
   * Structures with vertices blanked but no update range recorded yet.
   * Overwritten in place; grows to the widest batch and never again.
   */
  private readonly dirtyStructures: (RegisteredStructure | undefined)[] = [];
  private dirtyCount = 0;
  /** Blast parameters of the sweep in progress, so `detach` stays argument-light. */
  private blastOriginX = 0;
  private blastOriginY = 0;
  private blastOriginZ = 0;
  private blastRange = 1;
  private blastScale = 1;

  constructor(options: IDestructionSystemOptions) {
    this.bus = options.bus;
    this.debris = options.debris;
    this.damage = options.damage;
    this.ragdolls = options.ragdolls;
    this.collapsingFloorsFn = options.collapsingFloors ?? fallbackCollapsingFloors;
    this.restoreFromMask = options.restoreFromDamageMask ?? true;
    this.maxLedgerEntries = Math.max(0, options.maxLedgerEntries ?? 8192);

    const seedSource = options.seed ?? DESTRUCTION_RNG_LABEL;
    this.seed = typeof seedSource === 'number' ? seedSource >>> 0 : hashString(seedSource);
    // Held so callers can branch a child stream off a known-seeded generator
    // rather than reaching for `Math.random()`, which is banned outright.
    this.rng = createRng(this.seed);

    this.minimumIntentRank =
      options.minimumIntent === undefined
        ? MINIMUM_DESTRUCTIVE_INTENT_RANK
        : (INTENT_RANK[options.minimumIntent] ?? MINIMUM_DESTRUCTIVE_INTENT_RANK);

    this.shapes = new DebrisShapePool(this.debris?.capacity ?? DEBRIS_HARD_CAP);

    this.unsubscribes.push(
      this.bus.on('ShockwaveFired', (event) => this.onShockwaveFired(event)),
      this.bus.on('ChunkDetached', (event) => this.onExternalChunkDetached(event)),
      this.bus.on('EntityKilled', (event) => this.onEntityKilled(event)),
      this.bus.on('PlayerLanded', (event) => this.onPlayerLanded(event))
    );
  }

  /** The seeded stream this system derives from. Never `Math.random()`. */
  get random(): IRandom {
    return this.rng;
  }

  /* ------------------------------------------------------------------ */
  /* Registration                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Register a pre-fractured structure and immediately replay any damage it
   * has already taken.
   *
   * The replay is what makes destruction survive streaming: a chunk unloads,
   * its meshes are thrown away, the chunk loads again and the generator hands
   * back a pristine building — and this puts the hole back before the mesh is
   * ever drawn.
   */
  register(spec: IStructureSpec): RegisteredStructure {
    const existing = this.byId.get(spec.id);
    if (existing !== undefined) this.unregister(spec.id);

    const structure = new RegisteredStructure(spec);
    this.byId.set(structure.id, structure);
    this.insertOrdered(structure);
    this.stats.structures = this.ordered.length;

    const saved = this.ledger.get(structure.id);
    if (saved !== undefined) {
      // The exact ledger is a state the live model really reached, so it is
      // already settled: whatever was standing when it streamed out stands now.
      this.stats.restoredChunks += structure.restoreFrom(saved);
    } else if (this.restoreFromMask && this.damage !== undefined && structure.damageChunk >= 0) {
      this.stats.restoredChunks += this.restoreFromBitmask(structure);
      this.stats.restoredChunks += this.settleRestoredCollapse(structure);
    }
    // A restore is not a detach batch: the range it accumulated must not widen
    // the next one. Nothing put this structure in the flush list, so the span
    // would just sit there and be unioned into the first real detach's upload —
    // a six-figure-byte `bufferSubData` standing in for one chunk's forty. The
    // mesh is brand new and `needsUpdate` is already set, so three still gives
    // it its one full upload.
    structure.clearUploadRange();
    if (structure.destroyedCount > 0) this.recountDamaged();
    return structure;
  }

  /**
   * Deregister on chunk unload, snapshotting the exact destroyed set first.
   *
   * The snapshot is the reason the city stays broken. The 8 KB bitmask alone
   * is a coarser tier (4 bands x 4 quarters) and would restore a punched-out
   * corner as a punched-out third of the building.
   */
  unregister(id: string): boolean {
    const structure = this.byId.get(id);
    if (structure === undefined) return false;
    if (structure.destroyedCount > 0) this.saveToLedger(structure);
    this.scheduler.removeStructure(structure);
    this.byId.delete(id);
    const index = this.ordered.indexOf(structure);
    if (index !== -1) this.ordered.splice(index, 1);
    this.stats.structures = this.ordered.length;
    this.recountDamaged();
    return true;
  }

  get structures(): ReadonlyMap<string, RegisteredStructure> {
    return this.byId;
  }

  /** Structures in the deterministic sweep order. */
  get orderedStructures(): readonly RegisteredStructure[] {
    return this.ordered;
  }

  /* ------------------------------------------------------------------ */
  /* Frame                                                              */
  /* ------------------------------------------------------------------ */

  update(dt: number): void {
    if (this.disposed) return;
    this.clock += dt;
    this.frameIndex++;
    this.stats.frame = this.frameIndex;

    // Collapse waves come due here, so a collapse queued by a punch on frame n
    // spreads over n, n+1, n+2 — never all inside the punch's own frame.
    this.scheduler.drain(this.frameIndex, this.drainCollapse);
    this.flushUploads();
    this.stats.pendingCollapseChunks = this.scheduler.pending;

    if (this.debris !== undefined) {
      this.shapes.reclaim(this.debris);
      this.stats.debrisLive = this.debris.count;
    }

    // The frame's window closes AFTER the drain, so a reader here sees the
    // blast that landed between updates plus the collapse wave it triggered.
    // A frame in which nothing detached at all still reports zero, because the
    // window was already closed when this update began.
    if (this.frameWindowClosed) this.stats.chunksDestroyedThisFrame = 0;
    this.frameWindowClosed = true;
  }

  /** Bound once; passing `this.drainCollapse` allocates no closure per frame. */
  private readonly drainCollapse = (structure: RegisteredStructure, chunkIndex: number): void => {
    this.detachChunk(structure, chunkIndex, 'collapse');
  };

  /**
   * Record one coalesced update range per structure touched by the batch that
   * just finished. Synchronous, so a chunk blanked this frame is uploaded this
   * frame regardless of where `update()` sits in the game loop.
   */
  private flushUploads(): void {
    for (let i = 0; i < this.dirtyCount; i++) {
      const structure = this.dirtyStructures[i];
      this.dirtyStructures[i] = undefined;
      if (structure !== undefined) structure.flushUpload();
    }
    this.dirtyCount = 0;
  }

  /* ------------------------------------------------------------------ */
  /* Shockwaves                                                         */
  /* ------------------------------------------------------------------ */

  private onShockwaveFired(event: GameEventOf<'ShockwaveFired'>): void {
    this.applyShockwave(
      event.origin,
      event.direction,
      event.range,
      event.angle,
      event.power,
      event.intent
    );
  }

  /**
   * Sweep the cone and detach everything inside it.
   *
   * Returns the number of chunks taken. Public so a scripted set-piece or the
   * verification harness can fire one without a bus round trip; the bus path
   * calls straight through to it.
   */
  applyShockwave(
    origin: Vec3,
    direction: Vec3,
    range: number,
    halfAngle: number,
    power: number,
    intent: LethalIntent
  ): number {
    if (this.disposed) return 0;
    if ((INTENT_RANK[intent] ?? 0) < this.minimumIntentRank) return 0;
    // A NaN range makes every reject in `aabbInCone` fall through — `d > NaN`
    // is false — so one bad number upstream accepts every structure in front of
    // the apex at unlimited distance. `range <= 0` alone does not catch it:
    // every comparison against NaN is false, which is exactly why the test is
    // written the positive way round. This one is load-bearing; the clamps
    // downstream bound the impulse but cannot bound the SWEEP.
    if (!Number.isFinite(range) || range <= 0) return 0;
    if (!Number.isFinite(halfAngle) || !Number.isFinite(power)) return 0;
    if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y) || !Number.isFinite(origin.z)) {
      return 0;
    }

    // Recorded HERE, past the gates, and not in the bus handler: all three
    // entry points then agree on what counts as an impact. A pulled punch does
    // not leave one (`constants.ts` — restraint leaves the city alone, and it
    // should not launch bodies either), and a set-piece that calls this
    // directly gets the same ragdolls the bus path would have thrown.
    this.rememberImpact(origin, power);

    normaliseInto(this.axis, direction.x, direction.y, direction.z);
    const ax = this.axis[0]!;
    const ay = this.axis[1]!;
    const az = this.axis[2]!;

    // `power` is unbounded — a full-charge serious punch exceeds 1e6 — so it
    // is folded logarithmically rather than divided by a magic ceiling.
    const magnitude = clamp01(Math.log10(Math.max(1, power)) / 6);
    this.blastOriginX = origin.x;
    this.blastOriginY = origin.y;
    this.blastOriginZ = origin.z;
    this.blastRange = range;
    this.blastScale = (INTENT_BLAST_SCALE[intent] ?? 1) * (0.55 + 0.45 * magnitude);

    let detached = 0;
    // Indexed loops throughout the sweep: `for..of` over an array allocates an
    // iterator, and this loop runs across every resident structure on the
    // frame a punch lands.
    for (let s = 0; s < this.ordered.length; s++) {
      const structure = this.ordered[s]!;
      const b = structure.worldBounds;
      if (
        !aabbInCone(
          b[0]!,
          b[1]!,
          b[2]!,
          b[3]!,
          b[4]!,
          b[5]!,
          origin.x,
          origin.y,
          origin.z,
          ax,
          ay,
          az,
          range,
          halfAngle
        )
      ) {
        continue;
      }
      let took = 0;
      for (let i = 0; i < structure.chunkCount; i++) {
        if (structure.destroyed[i] === 1) continue;
        if (!structure.chunkWorldBounds(i, this.chunkBounds)) continue;
        const c = this.chunkBounds;
        if (
          !aabbInCone(
            c[0]!,
            c[1]!,
            c[2]!,
            c[3]!,
            c[4]!,
            c[5]!,
            origin.x,
            origin.y,
            origin.z,
            ax,
            ay,
            az,
            range,
            halfAngle
          )
        ) {
          continue;
        }
        if (this.detachChunk(structure, i, 'blast')) took++;
      }
      if (took > 0) {
        detached += took;
        this.evaluateCollapse(structure);
      }
    }
    this.flushUploads();
    if (detached > 0) this.recountDamaged();
    return detached;
  }

  /** Radial variant: ground slams, landing craters, explosions. */
  applyRadial(origin: Vec3, radius: number, power: number, intent: LethalIntent): number {
    if (this.disposed) return 0;
    if ((INTENT_RANK[intent] ?? 0) < this.minimumIntentRank) return 0;
    // Same reject as `applyShockwave`, and reachable without a single bad line
    // in this unit: `onPlayerLanded` derives BOTH arguments from
    // `event.impactSpeed`, and while `clamp` now floors the radius at 4 rather
    // than passing NaN on, `impactSpeed * 400` is not clamped at all.
    if (!Number.isFinite(radius) || radius <= 0) return 0;
    if (!Number.isFinite(power)) return 0;
    if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y) || !Number.isFinite(origin.z)) {
      return 0;
    }

    this.rememberImpact(origin, power);
    const magnitude = clamp01(Math.log10(Math.max(1, power)) / 6);
    this.blastOriginX = origin.x;
    this.blastOriginY = origin.y;
    this.blastOriginZ = origin.z;
    this.blastRange = radius;
    this.blastScale = (INTENT_BLAST_SCALE[intent] ?? 1) * (0.55 + 0.45 * magnitude);
    // A crater has NO axis, and the detach velocity is written by the same
    // `'blast'` branch a cone punch uses. Leaving the previous punch's axis in
    // place sends 70% of every rim piece off in that direction — a crater that
    // was punched sideways rather than stamped — and it only shows up after the
    // session's first cone, since the initial axis is already zero.
    this.axis[0] = 0;
    this.axis[1] = 0;
    this.axis[2] = 0;

    let detached = 0;
    for (let s = 0; s < this.ordered.length; s++) {
      const structure = this.ordered[s]!;
      const b = structure.worldBounds;
      if (
        !aabbInSphere(
          b[0]!,
          b[1]!,
          b[2]!,
          b[3]!,
          b[4]!,
          b[5]!,
          origin.x,
          origin.y,
          origin.z,
          radius
        )
      ) {
        continue;
      }
      let took = 0;
      for (let i = 0; i < structure.chunkCount; i++) {
        if (structure.destroyed[i] === 1) continue;
        if (!structure.chunkWorldBounds(i, this.chunkBounds)) continue;
        const c = this.chunkBounds;
        if (
          !aabbInSphere(
            c[0]!,
            c[1]!,
            c[2]!,
            c[3]!,
            c[4]!,
            c[5]!,
            origin.x,
            origin.y,
            origin.z,
            radius
          )
        ) {
          continue;
        }
        if (this.detachChunk(structure, i, 'blast')) took++;
      }
      if (took > 0) {
        detached += took;
        this.evaluateCollapse(structure);
      }
    }
    this.flushUploads();
    if (detached > 0) this.recountDamaged();
    return detached;
  }

  private onPlayerLanded(event: GameEventOf<'PlayerLanded'>): void {
    if (!event.createsCrater) return;
    // A hero landing is a point impact, not a cone: radius grows with the
    // speed they arrived at.
    const radius = clamp(event.impactSpeed * 0.35, 4, 45);
    this.applyRadial(event.position, radius, event.impactSpeed * 400, event.intent);
  }

  /* ------------------------------------------------------------------ */
  /* Detaching one chunk                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Take one fracture chunk off a structure.
   *
   * The whole pipeline in order: mark the geometry (one `fill`), record the
   * persistent bit, hand mass/centroid/AABB to the debris pool if the budget
   * allows, and emit `ChunkDetached` — unless `cause` is `'external'`, which
   * says the event that caused this detach is already on the bus. Idempotent —
   * a chunk already gone returns false and does nothing.
   */
  detachChunk(structure: RegisteredStructure, chunkIndex: number, cause: DetachCause): boolean {
    const chunk = structure.layout.chunks[chunkIndex];
    if (chunk === undefined) return false;
    if (!structure.markDestroyed(chunkIndex)) return false;
    if (!structure.uploadPending) {
      structure.uploadPending = true;
      if (this.dirtyCount < this.dirtyStructures.length) {
        this.dirtyStructures[this.dirtyCount] = structure;
      } else {
        this.dirtyStructures.push(structure);
      }
      this.dirtyCount++;
    }

    this.stats.chunksDestroyed++;
    // First detach since the last `update()` opens a new frame window.
    if (this.frameWindowClosed) {
      this.stats.chunksDestroyedThisFrame = 0;
      this.frameWindowClosed = false;
    }
    this.stats.chunksDestroyedThisFrame++;
    this.stats.destroyedMassKg += chunk.mass;

    structure.chunkWorldCentroid(chunkIndex, this.chunkCentre);
    const wx = this.chunkCentre[0]!;
    const wy = this.chunkCentre[1]!;
    const wz = this.chunkCentre[2]!;

    this.writeDetachVelocity(structure, chunkIndex, cause, wx, wy, wz);
    // The clamp is what the impulse was built from, so it is the mass that goes
    // out on the wire too: every consumer reconstructs Δv as `impulse / mass`,
    // and a zero here makes that Infinity. `collateral` below still prices the
    // real `chunk.mass`, so combat's invoice is unchanged.
    const mass = chunk.mass > 0 ? chunk.mass : 1;
    const ix = this.deltaV[0]! * mass;
    const iy = this.deltaV[1]! * mass;
    const iz = this.deltaV[2]! * mass;

    this.persist(structure, chunk.floor, chunk.quadrant);
    this.spawnDebris(structure, chunkIndex, ix, iy, iz);

    const collateral = chunk.mass * structure.collateralPerKg;
    this.stats.collateralTotal += collateral;
    // `external` means the event for this piece is ALREADY on the bus — that is
    // where the detach came from. Echoing it would bill every other subscriber
    // twice for one slab (double collateral, two dust bursts, two impacts, a
    // replay that diverges from its own recording), and `ChunkDetached` is
    // contractually emitted once per piece.
    if (cause !== 'external') {
      this.emitDetached(structure, chunkIndex, wx, wy, wz, mass, ix, iy, iz, collateral);
    }
    return true;
  }

  /**
   * Δv for a detaching chunk, written into `this.deltaV`.
   *
   * Expressed as a VELOCITY and multiplied by mass at the call site, because a
   * fixed impulse makes a light parapet rocket away and a heavy slab sit
   * still — which reads as a physics bug rather than as a building coming
   * apart.
   */
  private writeDetachVelocity(
    structure: RegisteredStructure,
    chunkIndex: number,
    cause: DetachCause,
    wx: number,
    wy: number,
    wz: number
  ): void {
    const jx = signedUnit(this.seed, structure.seedHash, chunkIndex * 3);
    const jy = signedUnit(this.seed, structure.seedHash, chunkIndex * 3 + 1);
    const jz = signedUnit(this.seed, structure.seedHash, chunkIndex * 3 + 2);

    if (cause === 'blast') {
      const dx = wx - this.blastOriginX;
      const dy = wy - this.blastOriginY;
      const dz = wz - this.blastOriginZ;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const t = clamp01(distance / this.blastRange);
      const speed =
        (BLAST_DELTA_V_NEAR + (BLAST_DELTA_V_FAR - BLAST_DELTA_V_NEAR) * t) * this.blastScale;

      const ax = this.axis[0]!;
      const ay = this.axis[1]!;
      const az = this.axis[2]!;
      // Radial component: what makes the tunnel walls spall sideways instead
      // of every piece flying down the same line.
      const along = dx * ax + dy * ay + dz * az;
      let rx = dx - ax * along;
      let ry = dy - ay * along;
      let rz = dz - az * along;
      const radial = Math.sqrt(rx * rx + ry * ry + rz * rz);
      if (radial > 1e-4) {
        rx /= radial;
        ry /= radial;
        rz /= radial;
      } else {
        rx = 0;
        ry = 0;
        rz = 0;
      }

      const forward = 1 - BLAST_SPREAD_FRACTION;
      let vx = ax * forward + rx * BLAST_SPREAD_FRACTION;
      let vy = ay * forward + ry * BLAST_SPREAD_FRACTION + BLAST_LIFT_FRACTION;
      let vz = az * forward + rz * BLAST_SPREAD_FRACTION;
      const length = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
      vx /= length;
      vy /= length;
      vz /= length;

      this.deltaV[0] = vx * speed + jx * DETACH_JITTER_DELTA_V;
      this.deltaV[1] = vy * speed + jy * DETACH_JITTER_DELTA_V;
      this.deltaV[2] = vz * speed + jz * DETACH_JITTER_DELTA_V;
      return;
    }

    // Collapse (and anything external): gravity leads, the facade peels
    // outward from the building's own axis. Deliberately an order of magnitude
    // slower than a blast — a collapsing floor falls, it does not explode.
    const ox = wx - structure.originX;
    const oz = wz - structure.originZ;
    const horizontal = Math.sqrt(ox * ox + oz * oz);
    const outX = horizontal > 1e-4 ? ox / horizontal : jx;
    const outZ = horizontal > 1e-4 ? oz / horizontal : jz;
    const outward =
      cause === 'collapse' ? COLLAPSE_OUTWARD_DELTA_V : COLLAPSE_OUTWARD_DELTA_V * 0.5;

    this.deltaV[0] = outX * outward + jx * DETACH_JITTER_DELTA_V;
    this.deltaV[1] = -COLLAPSE_DELTA_V + jy * DETACH_JITTER_DELTA_V * 0.5;
    this.deltaV[2] = outZ * outward + jz * DETACH_JITTER_DELTA_V;
  }

  /**
   * Hand the chunk to the debris pool — unless the 300-body cap is already
   * met, in which case the chunk still LEAVES THE BUILDING and simply does not
   * become a rigid body.
   *
   * The check is `count < capacity`, not "let the pool evict for me". The pool
   * would happily LRU out a piece that spawned two frames ago, and a collapse
   * whose first pieces vanish mid-air while later ones appear looks far worse
   * than a collapse whose tail is dust-only.
   */
  private spawnDebris(
    structure: RegisteredStructure,
    chunkIndex: number,
    ix: number,
    iy: number,
    iz: number
  ): void {
    const debris = this.debris;
    if (debris === undefined) {
      this.stats.visualOnlyDetaches++;
      return;
    }
    if (debris.count >= debris.capacity) {
      this.stats.visualOnlyDetaches++;
      return;
    }
    const source = structure.layout.chunks[chunkIndex];
    if (source === undefined) return;
    const record = this.shapes.acquire(source);
    if (record === undefined) {
      this.stats.visualOnlyDetaches++;
      return;
    }
    this.impulseVec.set(ix, iy, iz);
    const piece = debris.spawn(record, structure.matrix, this.impulseVec);
    this.shapes.bind(piece?.id);
    if (piece === undefined) {
      this.stats.visualOnlyDetaches++;
      return;
    }
    this.stats.debrisSpawned++;
    this.stats.debrisLive = debris.count;
  }

  /** Set the persistent bit. Coarser than the live geometry; see damage-address.ts. */
  private persist(structure: RegisteredStructure, floor: number, quadrant: number): void {
    const damage = this.damage;
    if (damage === undefined || structure.damageChunk < 0) return;
    const piece = pieceForChunk(floor, quadrant, structure.floorCount);
    if (damage.setDestroyed(structure.damageChunk, damageSlot(structure.damageBuilding, piece))) {
      this.stats.persistedPieces++;
    }
  }

  private emitDetached(
    structure: RegisteredStructure,
    chunkIndex: number,
    wx: number,
    wy: number,
    wz: number,
    mass: number,
    ix: number,
    iy: number,
    iz: number,
    collateral: number
  ): void {
    const payload = this.payload;
    payload.structureId = structure.id;
    payload.chunkIndex = chunkIndex;
    payload.position.x = wx;
    payload.position.y = wy;
    payload.position.z = wz;
    payload.mass = mass;
    payload.impulse.x = ix;
    payload.impulse.y = iy;
    payload.impulse.z = iz;
    payload.material = structure.layout.structureMaterial;
    payload.collateralCost = collateral;

    // The bus copies vectors on emit, so one reused payload is safe and no
    // handler can ever observe a mutated position.
    this.emittingDetach = true;
    try {
      this.bus.emit('ChunkDetached', payload);
    } finally {
      this.emittingDetach = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Collapse                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Has this structure lost a floor?
   *
   * The hot path is a scalar scan of the incrementally maintained per-floor
   * support totals — no allocation, no call into the injected rule. Only when
   * a NEW failure appears is `collapsingFloors` consulted for the
   * authoritative list, which happens at most once per structure per cascade.
   */
  private evaluateCollapse(structure: RegisteredStructure): void {
    const threshold = structure.layout.collapseSupportRatio;
    let failing = -1;
    for (let f = 0; f < structure.floorCount; f++) {
      if (structure.collapsed[f] === 1) continue;
      if (structure.floorSupport[f]! < threshold) {
        failing = f;
        break;
      }
    }
    if (failing < 0) return;

    const floors = this.collapsingFloorsFn(structure.layout, structure.isChunkDestroyed);
    if (floors.length === 0) return;

    // `floors` is the whole failing set, not the increment: a cascade extended
    // downward (floor 5 went first, a later punch takes floor 2) returns
    // [2..11] again, and adding its length would report 17 collapsed storeys
    // for a 12-storey building. Count what this call actually starts.
    let newFloors = 0;
    for (let i = 0; i < floors.length; i++) {
      const floorIndex = floors[i]!;
      if (
        structure.collapsed[floorIndex] !== 1 &&
        structure.layout.floors[floorIndex] !== undefined
      ) {
        newFloors++;
      }
    }
    let cascadeInProgress = false;
    for (let f = 0; f < structure.floorCount; f++) {
      if (structure.collapsed[f] === 1) {
        cascadeInProgress = true;
        break;
      }
    }

    // `frameIndex + 1`: a shockwave is handled BETWEEN updates, so the first
    // wave belongs to the next frame. Enqueueing against the current index
    // would make waves 0 and 1 come due on the same `update`, and a collapse
    // that arrives in two beats instead of three is visibly closer to a pop.
    const queued = this.scheduler.enqueue(structure, floors, this.frameIndex + 1);
    if (queued > 0) {
      // `collapsesTriggered` counts cascades STARTED, so a building that folds
      // further later is one collapse, not two.
      if (!cascadeInProgress) this.stats.collapsesTriggered++;
      this.stats.floorsCollapsed += newFloors;
      this.stats.pendingCollapseChunks = this.scheduler.pending;
    }
  }

  /**
   * Finish a collapse the coarse bitmask restore implies but never ran.
   *
   * `restoreFromBitmask` is an OVER-approximation — band granularity, so one
   * scraped quadrant on three storeys of the same band can come back as three
   * quadrants gone on all three. That can leave a floor below
   * `collapseSupportRatio`, a state the live model would never have left
   * standing: the tower balances on a 75%-missing storey until the next chunk
   * anywhere on it detaches, and then twelve storeys arrive at once with no
   * visible cause.
   *
   * So the cascade is applied here, silently: no debris, no events, no
   * scheduler wave. Like the rest of the restore, this is re-establishing a
   * state, not new damage happening.
   */
  private settleRestoredCollapse(structure: RegisteredStructure): number {
    const floors = this.collapsingFloorsFn(structure.layout, structure.isChunkDestroyed);
    let settled = 0;
    for (let i = 0; i < floors.length; i++) {
      const floorIndex = floors[i]!;
      const floor = structure.layout.floors[floorIndex];
      if (floor === undefined) continue;
      structure.collapsed[floorIndex] = 1;
      const members = floor.chunks;
      for (let c = 0; c < members.length; c++) {
        if (structure.markDestroyed(members[c]!)) settled++;
      }
    }
    return settled;
  }

  /* ------------------------------------------------------------------ */
  /* External detach events                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Apply a `ChunkDetached` raised by somebody else — a scripted set-piece, a
   * replay, a networked peer.
   *
   * Our own emissions land here too and are dropped by the re-entrancy guard;
   * even without it `markDestroyed` would refuse, because every detach path is
   * idempotent by construction.
   */
  private onExternalChunkDetached(event: GameEventOf<'ChunkDetached'>): void {
    if (this.emittingDetach) return;
    const structure = this.byId.get(event.structureId);
    if (structure === undefined) return;
    if (!this.detachChunk(structure, event.chunkIndex, 'external')) return;
    this.flushUploads();
    this.evaluateCollapse(structure);
    this.recountDamaged();
  }

  /* ------------------------------------------------------------------ */
  /* Ragdolls                                                           */
  /* ------------------------------------------------------------------ */

  private rememberImpact(origin: Vec3, power: number): void {
    const slot = (this.impactCount % IMPACT_HISTORY) * 5;
    this.impactRing[slot] = origin.x;
    this.impactRing[slot + 1] = origin.y;
    this.impactRing[slot + 2] = origin.z;
    this.impactRing[slot + 3] = this.clock;
    this.impactRing[slot + 4] = power;
    this.impactCount++;
  }

  /**
   * A death near a recent impact throws a ragdoll.
   *
   * "Near a recent impact" and not "every death": a monster that quietly runs
   * out of health across the street did not get hit by anything, and a ragdoll
   * launched from nowhere is the classic tell of a physics system firing on
   * the wrong signal. The 8-ragdoll ceiling is checked BEFORE asking, so
   * destruction never pushes the manager into freezing somebody mid-flight.
   */
  private onEntityKilled(event: GameEventOf<'EntityKilled'>): void {
    const ragdolls = this.ragdolls;
    if (ragdolls === undefined) return;

    let best = -1;
    let bestDistanceSq = RAGDOLL_IMPACT_RADIUS * RAGDOLL_IMPACT_RADIUS;
    const limit = Math.min(this.impactCount, IMPACT_HISTORY);
    for (let i = 0; i < limit; i++) {
      const slot = i * 5;
      if (this.clock - this.impactRing[slot + 3]! > RAGDOLL_IMPACT_WINDOW_SECONDS) continue;
      const dx = event.position.x - this.impactRing[slot]!;
      const dy = event.position.y - this.impactRing[slot + 1]!;
      const dz = event.position.z - this.impactRing[slot + 2]!;
      const distanceSq = dx * dx + dy * dy + dz * dz;
      if (distanceSq <= bestDistanceSq) {
        bestDistanceSq = distanceSq;
        best = slot;
      }
    }
    if (best < 0) return;

    if (ragdolls.activeCount >= ragdolls.maxActive) {
      this.stats.ragdollsSuppressed++;
      return;
    }

    const distance = Math.sqrt(bestDistanceSq);
    const falloff = 1 - clamp01(distance / RAGDOLL_IMPACT_RADIUS);
    let dx = event.position.x - this.impactRing[best]!;
    let dy = event.position.y - this.impactRing[best + 1]!;
    let dz = event.position.z - this.impactRing[best + 2]!;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (length > 1e-4) {
      dx /= length;
      dy /= length;
      dz /= length;
    } else {
      dx = 0;
      dy = 1;
      dz = 0;
    }

    // `EntityId` is a string alias, so this is a hash of the id itself — the
    // launch is reproducible for a given victim regardless of kill order.
    const entitySeed = hashString(event.entityId);
    const speed = RAGDOLL_DELTA_V_NEAR * (0.35 + 0.65 * falloff);
    // Upward bias so the body arcs; a purely horizontal launch skids.
    const vx = dx * speed + signedUnit(this.seed, entitySeed, 0) * 2.5;
    const vy = (dy * 0.4 + 0.75) * speed + signedUnit(this.seed, entitySeed, 1) * 2.5;
    const vz = dz * speed + signedUnit(this.seed, entitySeed, 2) * 2.5;

    this.ragdollImpulse.x = vx * RAGDOLL_MASS_KG;
    this.ragdollImpulse.y = vy * RAGDOLL_MASS_KG;
    this.ragdollImpulse.z = vz * RAGDOLL_MASS_KG;
    if (ragdolls.launch(event.entityId as EntityId, event.position, this.ragdollImpulse)) {
      this.stats.ragdollsLaunched++;
    } else {
      this.stats.ragdollsSuppressed++;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Persistence helpers                                                */
  /* ------------------------------------------------------------------ */

  private saveToLedger(structure: RegisteredStructure): void {
    if (this.maxLedgerEntries === 0) return;
    let entry = this.ledger.get(structure.id);
    if (entry === undefined || entry.length !== structure.chunkCount) {
      entry = new Uint8Array(structure.chunkCount);
      // Insertion-ordered map: the oldest damaged structure is evicted first.
      if (this.ledger.size >= this.maxLedgerEntries) {
        const oldest = this.ledger.keys().next();
        if (!oldest.done) this.ledger.delete(oldest.value);
      }
      this.ledger.set(structure.id, entry);
    }
    structure.snapshotInto(entry);
  }

  /**
   * Replay the coarse bitmask onto a structure with no ledger entry — a city
   * restored from a save. Deliberately silent: no debris, no events, no
   * collapse cascade. This is a settled state being re-established, not new
   * damage happening.
   */
  private restoreFromBitmask(structure: RegisteredStructure): number {
    const damage = this.damage;
    if (damage === undefined) return 0;
    let restored = 0;
    for (let i = 0; i < structure.chunkCount; i++) {
      const chunk = structure.layout.chunks[i];
      if (chunk === undefined) continue;
      const piece = pieceForChunk(chunk.floor, chunk.quadrant, structure.floorCount);
      if (!damage.isDestroyed(structure.damageChunk, damageSlot(structure.damageBuilding, piece))) {
        continue;
      }
      if (structure.markDestroyed(i)) restored++;
    }
    return restored;
  }

  /**
   * Snapshot of the exact destroyed set, for save files and tests.
   *
   * A COPY, and read-only in both directions. Handing out the ledger's own
   * array lets a caller that reuses it as scratch rewrite the record, and
   * writing THROUGH this accessor made a save routine that walks every
   * resident structure evict — at the 8192-entry ceiling, one per call — the
   * very damage records it was walking the city to write down.
   */
  ledgerFor(structureId: string): Uint8Array | undefined {
    const live = this.byId.get(structureId);
    if (live !== undefined && live.destroyedCount > 0) {
      const snapshot = new Uint8Array(live.chunkCount);
      live.snapshotInto(snapshot);
      return snapshot;
    }
    return this.ledger.get(structureId)?.slice();
  }

  get ledgerSize(): number {
    return this.ledger.size;
  }

  /* ------------------------------------------------------------------ */
  /* Telemetry and lifecycle                                            */
  /* ------------------------------------------------------------------ */

  get diagnostics(): IDestructionStats {
    this.stats.pendingCollapseChunks = this.scheduler.pending;
    if (this.debris !== undefined) this.stats.debrisLive = this.debris.count;
    return this.stats;
  }

  /** Reset collateral accounting, e.g. at mission start. */
  resetCollateral(): void {
    this.stats.collateralTotal = 0;
  }

  /** Drop every structure and queued collapse. Damage records are kept. */
  clear(): void {
    // Record the pending ranges FIRST: the flush list holds strong references
    // to the structures (and through them the baked layout and the block mesh),
    // and after `dispose()` no `update()` will ever come along to null them.
    this.flushUploads();
    for (const structure of this.ordered) {
      if (structure.destroyedCount > 0) this.saveToLedger(structure);
    }
    this.scheduler.clear();
    // Impacts are a 0.75 s proximity window, not a damage record: a restarted
    // mission must not inherit the previous one's reasons to throw a body.
    // `this.clock` only advances inside `update()`, so across a load — where no
    // update runs — a pre-clear impact stays permanently "recent", and the first
    // monster to die within 42 m of last mission's punch gets launched at
    // 34 m/s for no visible reason. Zeroing the count is enough:
    // `onEntityKilled` reads `min(impactCount, IMPACT_HISTORY)` slots, so the
    // stale floats are unreachable and the ring needs no fill. The clock itself
    // is left alone — it is only ever read as `clock - impactTime`, and
    // rewinding it would make old impacts look NEWER.
    this.impactCount = 0;
    this.byId.clear();
    this.ordered.length = 0;
    // NOT `shapes.releaseAll()`. `clear()` is a mission restart or a fast
    // travel, not a shutdown, and the debris pieces borrowing those boxes are
    // still mid-flight: handing the slots back would let the next detach resize
    // a box under a piece that is still on screen — the exact hazard
    // `debris-shapes.ts` refuses a ring buffer over. `reclaim()` retires them
    // as the pieces fade; `dispose()` tears the pool down outright.
    this.stats.structures = 0;
    this.stats.damagedStructures = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribes) off();
    this.unsubscribes.length = 0;
    this.clear();
    this.shapes.dispose();
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                          */
  /* ------------------------------------------------------------------ */

  private insertOrdered(structure: RegisteredStructure): void {
    let low = 0;
    let high = this.ordered.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.ordered[mid]!.id < structure.id) low = mid + 1;
      else high = mid;
    }
    this.ordered.splice(low, 0, structure);
  }

  private recountDamaged(): void {
    let damaged = 0;
    for (let i = 0; i < this.ordered.length; i++) {
      if (this.ordered[i]!.destroyedCount > 0) damaged++;
    }
    this.stats.damagedStructures = damaged;
  }
}
