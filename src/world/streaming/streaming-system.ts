/**
 * OPEN-WORLD CHUNK STREAMING
 *
 * The system that decides what exists. Its contract with the rest of the game
 * is one sentence: **the world may be arbitrarily large and the frame cost of
 * that must be bounded and constant.**
 *
 * Everything below follows from that sentence.
 *
 * ── THE BUDGET IS THE DESIGN ───────────────────────────────────────────────
 * At most `MAX_UPLOADS_PER_FRAME` chunks and `UPLOAD_BUDGET_MS` milliseconds of
 * main-thread time per frame, enforced with ADMISSION CONTROL rather than
 * hope: before starting a second upload the system checks the measured moving
 * average of what an upload costs and refuses if it would not fit. A budget
 * checked only after the fact is not a budget.
 *
 * Nothing else on the load path touches the main thread. Layout, geometry and
 * the impostor bake all happen on two workers and come back as transferable
 * `ArrayBuffer`s, so the main thread's entire share is wrapping them in
 * `BufferAttribute`s — see `chunk.ts`.
 *
 * ── ORDER MATTERS AS MUCH AS RATE ──────────────────────────────────────────
 * Two chunks per frame is only acceptable if they are the right two. The
 * priority queue scores by (ring, angle to view direction, distance) and is
 * re-scored every frame, so the queue tracks where the player is *looking*, not
 * where they were when a job was queued. That is also why jobs in flight are
 * capped at four: a worker three jobs deep cannot be redirected, and a pool
 * that has swallowed the queue has quietly taken the scheduling decision away
 * from the scheduler. See `priority-queue.ts`.
 *
 * ── STABILITY ──────────────────────────────────────────────────────────────
 * Ring membership is hysteretic (`lod-rings.ts`) so a camera parked on a
 * boundary cannot thrash rebuilds, and eviction uses a wider radius than
 * loading for the same reason at chunk granularity.
 *
 * ── THE WORLD REMEMBERS ────────────────────────────────────────────────────
 * A chunk is otherwise a pure function of `(seed, coord, ring)`, which is what
 * makes it safe to throw away. The single exception is destruction, kept as an
 * 8 KB bitmask (`damage-state.ts`) that travels to the worker with the job, so
 * a rebuilt chunk comes back as the player left it at no extra cost.
 *
 * ── WHAT THIS SYSTEM DOES NOT DO ───────────────────────────────────────────
 * It does not own physics, NPCs, or rendering. Colliders and crowd slots are
 * handed to injected sinks and chunk arrival/departure is announced on the
 * event bus; no other system's implementation is imported here, and none of
 * them import this one.
 */

import * as THREE from 'three';
import type {
  ChunkKey,
  IChunk,
  IChunkCoord,
  IEventBus,
  IQualityTier,
  IStreamingStats,
  IStreamingSystem,
  IWorldConfig,
} from '@/types';
import {
  CHUNK_COUNT,
  CHUNK_GRID,
  CHUNK_SIZE,
  chunkIndex,
  chunkIndexToX,
  chunkIndexToZ,
  isChunkInWorld,
  worldToChunkX,
  worldToChunkZ,
} from '@/spatial/constants';
import {
  EVICT_MARGIN_CHUNKS,
  MAX_BUILD_ATTEMPTS,
  MAX_UNLOADS_PER_FRAME,
  MAX_UPLOADS_PER_FRAME,
  REQUEST_PIN_SCORE,
  RING_COLLIDER_MODE,
  RING_COUNT,
  RING_PRIORITY_STRIDE,
  RING_R0,
  RING_R3,
  STREAMING_LOD_LEVELS,
  STREAMING_WORKER_COUNT,
  UNLOAD_BUDGET_MS,
  UPLOAD_BUDGET_MS,
  UPLOAD_COST_EMA_ALPHA,
  UPLOAD_MS_PER_BYTE_FLOOR,
  UPLOAD_MS_PER_BYTE_SEED,
  type ColliderMode,
  type CrowdMode,
} from './constants';
import { ChunkDamageState } from './damage-state';
import {
  ChunkPriorityQueue,
  chunkDistanceUnits,
  scoreChunk,
  type IPriorityView,
} from './priority-queue';
import { RingAssigner, residentRadiusFor, shouldEvict, shouldLoad } from './lod-rings';
import { ChunkWorkerPool } from './worker-pool';
import { DEFAULT_GENERATOR } from './chunk-worker';
import { StreamedChunk, type IChunkHost } from './chunk';
import { StreamingMaterials, type IStreamingMaterialOptions } from './materials';
import { ImpostorRing, type IImpostorStats } from './impostor-ring';
import type { IChunkBuildResult, IColliderBox, ICrowdSlot, WorkerResponse } from './protocol';

/* -------------------------------------------------------------------------- */
/* Injection points                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Where static collision goes. Implemented by the physics workstream; streaming
 * only decides HOW MUCH collision a ring deserves, never how it is simulated.
 */
export interface IColliderSink {
  setChunkColliders(chunk: number, mode: ColliderMode, boxes: readonly IColliderBox[]): void;
  clearChunkColliders(chunk: number): void;
}

/** Where NPC population goes. Implemented by the entity/AI workstream. */
export interface ICrowdSink {
  setChunkCrowd(chunk: number, mode: CrowdMode, slots: readonly ICrowdSlot[]): void;
  clearChunkCrowd(chunk: number): void;
}

/**
 * Optional hook that forces the driver to take a newly-created geometry's
 * buffers INSIDE the measured upload bracket.
 *
 * Without it, `bufferData` is deferred to the first draw and the cost lands in
 * an unrelated frame, where it is real but unattributable. The renderer
 * workstream supplies the concrete implementation (a scissored one-pixel draw
 * of just this object); streaming only needs the seam so its own numbers are
 * honest.
 */
export type GpuUploadHook = (object: THREE.Object3D) => void;

export interface IStreamingSystemOptions {
  /** Scene chunks are added to. */
  readonly scene: THREE.Scene;
  /** Master world seed. Identical seeds MUST yield an identical world. */
  readonly seed?: number;
  /** Event bus for `ChunkStreamedIn` / `ChunkStreamedOut`. */
  readonly bus?: IEventBus;
  /** Starting render tier. Drives the resident radius. */
  readonly quality?: IQualityTier;
  /** Workers to spawn. Defaults to two. */
  readonly workerCount?: number;
  /** Force the inline (main-thread) build path. Tests only. */
  readonly inlineWorkers?: boolean;
  /** Generator id sent with every job. See the seam note in `chunk-worker.ts`. */
  readonly generator?: string;
  /** Existing damage state, e.g. restored from a save. */
  readonly damage?: ChunkDamageState;
  /** Material overrides. */
  readonly materials?: IStreamingMaterialOptions;
  readonly colliderSink?: IColliderSink;
  readonly crowdSink?: ICrowdSink;
  /**
   * `SpatialIndex.isChunkPotentiallyVisible`, injected rather than imported so
   * streaming depends on the spatial index's CONTRACT and not its construction.
   */
  readonly isChunkPotentiallyVisible?: (from: number, to: number) => boolean;
  /** Override the per-frame upload count cap. */
  readonly maxUploadsPerFrame?: number;
  /** Override the per-frame upload time cap, in milliseconds. */
  readonly uploadBudgetMs?: number;
  /** Soft ceiling on resident chunk bytes before memory-driven eviction. */
  readonly memoryBudgetBytes?: number;
  /** See `GpuUploadHook`. */
  readonly gpuUpload?: GpuUploadHook;
  /** Bake and upload the impostor ring at boot. Defaults to true. */
  readonly buildImpostor?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Telemetry                                                                  */
/* -------------------------------------------------------------------------- */

/** Everything the debug HUD and the verification harness read. */
export interface IStreamingDetailedStats extends IStreamingStats {
  readonly frame: number;
  /**
   * Chunks in any state, including ones still being built. Distinct from the
   * inherited `activeChunks`, which counts only the ones in the scene graph —
   * this field exists so the two never have to share a name.
   */
  readonly residentChunks: number;
  readonly chunksByRing: readonly number[];
  readonly queued: number;
  readonly inFlight: number;
  readonly readyToUpload: number;
  /** Uploads performed in the last frame. Must never exceed the cap. */
  readonly uploadsLastFrame: number;
  /** Main-thread upload milliseconds in the last frame. */
  readonly uploadMsLastFrame: number;
  /** Worst single-frame upload milliseconds since construction. */
  readonly peakUploadMs: number;
  /** Worst single-chunk upload milliseconds since construction. */
  readonly peakChunkUploadMs: number;
  readonly unloadsLastFrame: number;
  readonly unloadMsLastFrame: number;
  readonly totalLoads: number;
  readonly totalEvictions: number;
  readonly ringTransitions: number;
  readonly ringTransitionsSuppressed: number;
  readonly residentRadiusChunks: number;
  readonly quality: IQualityTier;
  readonly workerTimeMs: number;
  readonly workersInline: boolean;
  readonly impostor: IImpostorStats;
  readonly damagedChunks: number;
  readonly destroyedPieces: number;
  /** Main-thread milliseconds the impostor bake cost at boot. Not frame cost. */
  readonly impostorUploadMs: number;
}

/** A completed build waiting for budget. */
interface IReadyBuild {
  readonly result: IChunkBuildResult;
  readonly chunk: StreamedChunk;
  score: number;
}

/** How an enqueue departs from the plain distance score. See `IQueuedChunk`. */
interface IEnqueueOptions {
  /** Absolute score that survives the per-frame re-score. */
  readonly pin?: number;
  /** Additive offset reapplied on every re-score. */
  readonly bias?: number;
}

/* -------------------------------------------------------------------------- */
/* System                                                                     */
/* -------------------------------------------------------------------------- */

export class StreamingSystem implements IStreamingSystem, IChunkHost {
  /** Point streaming is centred on — normally the player. */
  readonly focus = new THREE.Vector3();

  private readonly scene: THREE.Scene;
  private readonly bus: IEventBus | undefined;
  private readonly chunks = new Map<ChunkKey, StreamedChunk>();
  private readonly byIndex: (StreamedChunk | undefined)[] = new Array(CHUNK_COUNT).fill(undefined);
  private readonly queue = new ChunkPriorityQueue();
  private readonly ready: IReadyBuild[] = [];
  private readonly rings = new RingAssigner();
  private readonly pool: ChunkWorkerPool;
  private readonly damage: ChunkDamageState;
  private readonly materials: StreamingMaterials;
  private readonly impostorRing: ImpostorRing;
  private readonly generator: string;
  private readonly colliderSink: IColliderSink | undefined;
  private readonly crowdSink: ICrowdSink | undefined;
  private readonly pvs: (from: number, to: number) => boolean;
  private readonly gpuUpload: GpuUploadHook | undefined;
  private readonly maxUploads: number;
  private readonly uploadBudgetMs: number;
  private readonly memoryBudget: number;

  /** Backing store for the `config` getter; the radii track the quality tier. */
  private worldConfig: IWorldConfig;
  /**
   * Chunks an explicit `requestChunk` is waiting on.
   *
   * Without this the assignment pass evicts a chunk requested beyond the
   * resident radius — which is every fast-travel destination — on the very next
   * frame, and the caller's promise settles on a chunk with no geometry.
   * Cleared the moment the chunk uploads, so a pin cannot pile up a working set
   * the memory budget never sees.
   */
  private readonly pinned = new Set<number>();
  /** Chunks this frame's assignment pass has already condemned. */
  private readonly evicting = new Set<number>();

  /** Unit forward on the XZ plane. Drives the angle term of the priority. */
  private forwardX = 0;
  private forwardZ = -1;
  private viewChunk = -1;
  private frame = 0;
  private quality: IQualityTier;
  private residentRadius: number;
  private nextJobId = 1;
  /** Job id -> chunk index, so a result can find its chunk after a rebuild. */
  private readonly jobOwners = new Map<number, number>();
  private impostorJobId = -1;
  private impostorUploadMs = 0;

  /** Frames since the last visibility handoff marked a chunk seen. */
  private readonly lastSeen = new Int32Array(CHUNK_COUNT).fill(-1);

  /** Admission-control predictor: milliseconds of upload per payload byte. */
  private uploadMsPerByte = UPLOAD_MS_PER_BYTE_SEED;
  private uploadsLastFrame = 0;
  private uploadMsLastFrame = 0;
  private unloadsLastFrame = 0;
  private unloadMsLastFrame = 0;
  private peakUploadMs = 0;
  private peakChunkUploadMs = 0;
  private totalLoads = 0;
  private totalEvictions = 0;
  private totalBytes = 0;
  private loadsThisSecond = 0;
  private evictionsThisSecond = 0;
  private secondAccumulator = 0;
  private generationTimeMs = 0;
  private idleWaiters: (() => void)[] = [];
  private disposed = false;

  constructor(options: IStreamingSystemOptions) {
    this.scene = options.scene;
    this.bus = options.bus;
    this.generator = options.generator ?? DEFAULT_GENERATOR;
    this.damage = options.damage ?? new ChunkDamageState();
    this.materials = new StreamingMaterials(options.materials);
    this.impostorRing = new ImpostorRing(this.materials);
    this.colliderSink = options.colliderSink;
    this.crowdSink = options.crowdSink;
    this.pvs = options.isChunkPotentiallyVisible ?? ((): boolean => true);
    this.gpuUpload = options.gpuUpload;
    this.maxUploads = options.maxUploadsPerFrame ?? MAX_UPLOADS_PER_FRAME;
    this.uploadBudgetMs = options.uploadBudgetMs ?? UPLOAD_BUDGET_MS;
    this.quality = options.quality ?? 'high';
    this.residentRadius = residentRadiusFor(this.quality);
    this.memoryBudget = options.memoryBudgetBytes ?? 192 * 1024 * 1024;

    const seed = options.seed ?? 0x0c17972;
    this.worldConfig = {
      seed,
      chunkSize: CHUNK_SIZE,
      // The contract reads this as a SYMMETRIC extent: the playable area is
      // `(2r + 1)^2` chunks on a `-r..r` grid. The real world is 16x16 on an
      // asymmetric `-8..7` grid, so publishing 8 sends a consumer that follows
      // the documented reading to `chunkIndex(8, z)`, which is -1. Seven is the
      // largest radius on which the documented reading is true. See the note in
      // `typeChangeRequests`: the contract wants a `worldGridChunks` field.
      worldRadiusChunks: (CHUNK_GRID >> 1) - 1,
      lodLevels: STREAMING_LOD_LEVELS,
      streamingRadiusChunks: this.residentRadius,
      evictionRadiusChunks: this.residentRadius + EVICT_MARGIN_CHUNKS,
      // Documented as the PER-FRAME load cap, which is the upload cap. The
      // in-flight job cap is a different number with a different job.
      maxConcurrentLoads: this.maxUploads,
      memoryBudgetBytes: this.memoryBudget,
      groundLevel: 0,
      gravity: -9.81,
    };

    this.pool = new ChunkWorkerPool({
      workerCount: options.workerCount ?? STREAMING_WORKER_COUNT,
      inline: options.inlineWorkers,
      onResult: (response) => this.onWorkerResult(response),
      onError: (message) => console.error(`[streaming] ${message}`),
    });

    this.impostorRing.attach(this.scene);
    if (options.buildImpostor !== false) this.bakeImpostor();
  }

  /**
   * The published world configuration.
   *
   * A getter rather than a frozen field because two of its numbers are derived
   * from the quality tier, and a tier change that left them at their boot
   * values published a resident radius up to 90% larger than the one actually
   * in force — to a field the harness treats as the authority on the resident
   * set.
   */
  get config(): IWorldConfig {
    return this.worldConfig;
  }

  /* ------------------------------------------------------------------ */
  /* View                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Set the streaming focus and the direction it is looking.
   *
   * The forward vector is flattened to XZ and normalised here rather than at
   * every scoring site: priority is evaluated for up to 256 chunks per frame
   * and none of them care about pitch.
   */
  setView(position: THREE.Vector3, forward: THREE.Vector3): void {
    this.focus.copy(position);
    const fx = forward.x;
    const fz = forward.z;
    const length = Math.sqrt(fx * fx + fz * fz);
    if (length > 1e-6) {
      this.forwardX = fx / length;
      this.forwardZ = fz / length;
    }
    this.viewChunk = chunkIndex(worldToChunkX(this.focus.x), worldToChunkZ(this.focus.z));
  }

  /** The view state the priority queue is scored against. */
  private get view(): IPriorityView {
    return {
      x: this.focus.x,
      z: this.focus.z,
      forwardX: this.forwardX,
      forwardZ: this.forwardZ,
      viewChunk: this.viewChunk,
    };
  }

  /**
   * Handoff from `SpatialIndex.visibleChunks` — the dense chunk indices the
   * frustum walk kept this frame.
   *
   * Used for `lastSeenFrame` and to bias eviction away from chunks the player
   * was looking at a moment ago. Streaming deliberately does NOT re-derive
   * visibility: the spatial index already produced it in the same traversal
   * that produced the visible instances, and a second pass would be pure waste.
   */
  setVisibleChunks(indices: ArrayLike<number>, count = indices.length): void {
    for (let i = 0; i < count; i++) {
      const index = indices[i]!;
      if (index < 0 || index >= CHUNK_COUNT) continue;
      this.lastSeen[index] = this.frame;
      const chunk = this.byIndex[index];
      if (chunk !== undefined) chunk.lastSeenFrame = this.frame;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Frame                                                              */
  /* ------------------------------------------------------------------ */

  update(dt: number): void {
    if (this.disposed) return;
    this.frame++;
    this.uploadsLastFrame = 0;
    this.uploadMsLastFrame = 0;
    this.unloadsLastFrame = 0;
    this.unloadMsLastFrame = 0;
    this.generationTimeMs = 0;

    this.secondAccumulator += dt;
    if (this.secondAccumulator >= 1) {
      this.secondAccumulator = 0;
      this.loadsThisSecond = 0;
      this.evictionsThisSecond = 0;
    }

    // `focus` is public and `IStreamingSystem` declares it writable, so a
    // driver coded against the contract mutates it directly and never calls
    // `setView` — which is where the derived view chunk used to be written.
    // Left stale it pins the PVS term of the priority score to the boot chunk,
    // or disables it outright, silently either way.
    this.viewChunk = chunkIndex(worldToChunkX(this.focus.x), worldToChunkZ(this.focus.z));

    this.applyDamageDirt();
    const evictions = this.assignRings();
    // Anything condemned this frame must not be handed a worker slot or an
    // upload slot on its way out: both are budgets the arriving neighbourhood
    // needs, and every such upload also fires a ChunkStreamedIn/Out pair for
    // geometry that was never on screen.
    this.evicting.clear();
    for (const index of evictions) this.evicting.add(index);

    this.queue.rescore(this.view, (chunk) => this.isPotentiallyVisible(chunk));
    this.dispatch();
    this.uploadPass();
    this.unloadPass(evictions);
    this.enforceMemoryBudget();

    if (this.isIdle()) this.settleIdleWaiters();
  }

  /**
   * Walk all 256 chunks, assign rings with hysteresis and decide what to load.
   *
   * A flat loop over the whole world rather than a spiral around the focus: 256
   * iterations of integer arithmetic is a couple of microseconds, and the
   * alternative costs more in bookkeeping than it saves in iterations while
   * making eviction a separate pass that can disagree with loading.
   */
  private assignRings(): number[] {
    const evictions: number[] = [];
    this.rings.beginPass();

    for (let index = 0; index < CHUNK_COUNT; index++) {
      const distance = chunkDistanceUnits(index, this.focus.x, this.focus.z);
      const existing = this.byIndex[index];

      if (!shouldLoad(distance, this.residentRadius)) {
        if (
          existing !== undefined &&
          shouldEvict(distance, this.residentRadius) &&
          !this.pinned.has(index)
        ) {
          evictions.push(index);
        }
        continue;
      }

      const ring = this.rings.assign(index, distance);
      if (ring >= RING_R3) {
        // Past R2 the impostor is the representation. Nothing to stream.
        if (existing !== undefined) evictions.push(index);
        // A chunk that was never resident has no `unloadChunk` coming to call
        // `forget` for it, so an R3 recorded here would stick to the slot for
        // the session and hold the chunk at R3 no matter how close it got.
        else this.rings.forget(index);
        continue;
      }

      const chunk = existing ?? this.createChunk(index);
      chunk.distanceToFocus = distance * CHUNK_SIZE;
      chunk.setLOD(ring);

      // A build already running for the ring we still want is left alone; one
      // running for a ring we have since left is cancelled rather than allowed
      // to consume upload budget on geometry known to be the wrong detail.
      if (chunk.jobId !== -1) {
        if (chunk.jobRing === ring) continue;
        this.pool.cancel(chunk.jobId);
        this.jobOwners.delete(chunk.jobId);
        chunk.jobId = -1;
        chunk.jobRing = -1;
      }

      const readyAt = this.ready.findIndex((item) => item.chunk.index === index);
      if (readyAt !== -1) {
        if (this.ready[readyAt]!.result.ring === ring && !chunk.pendingRebuild) continue;
        this.ready.splice(readyAt, 1);
      } else if (!chunk.needsRebuild && !chunk.pendingRebuild) {
        continue;
      }

      // A build that has failed this many times running fails for a reason
      // another attempt will not change. Leave the chunk in 'error', where
      // `IChunk.error` and the stats can see it, rather than re-queuing it
      // every frame for the rest of the session.
      if (chunk.buildFailures >= MAX_BUILD_ATTEMPTS) continue;

      this.enqueue(chunk, ring);
    }

    return evictions;
  }

  /**
   * Queue or re-score a build for a chunk.
   *
   * `pin` and `bias` are the two ways an entry departs from the plain distance
   * score, and both are recorded ON the entry: the queue is re-scored before
   * every dispatch, so a score written here and nowhere else is erased before
   * anything acts on it.
   */
  private enqueue(chunk: StreamedChunk, ring: number, options: IEnqueueOptions = {}): void {
    const visible = this.isPotentiallyVisible(chunk.index);
    const scored = scoreChunk(chunk.index, ring, this.view, visible);
    const bias = options.bias ?? 0;
    this.queue.push({
      chunk: chunk.index,
      ring,
      score: options.pin ?? scored.score + bias,
      distance: scored.distance,
      angleTerm: scored.angleTerm,
      pvsVisible: visible,
      pinned: options.pin !== undefined,
      bias,
      enqueuedFrame: this.frame,
    });
    if (chunk.state === 'unloaded') chunk.state = 'loading';
  }

  /** Hand queued work to the pool, highest priority first. */
  private dispatch(): void {
    while (this.queue.size > 0 && this.pool.inFlight + this.pool.queued < this.pool.capacity) {
      const entry = this.queue.pop()!;
      const chunk = this.byIndex[entry.chunk];
      if (chunk === undefined) continue;
      // Condemned this frame: the chunk is on its way out and `assignRings`
      // will not ask for it again, so drop the entry instead of spending one of
      // only a handful of in-flight slots on it.
      if (this.evicting.has(entry.chunk)) continue;

      const id = this.nextJobId++;
      chunk.jobId = id;
      chunk.jobRing = entry.ring;
      chunk.pendingRebuild = false;
      this.jobOwners.set(id, chunk.index);
      this.pool.submit({
        kind: 'chunk',
        id,
        generator: this.generator,
        chunk: chunk.index,
        cx: chunk.coord.x,
        cz: chunk.coord.z,
        seed: this.config.seed,
        ring: entry.ring,
        damage: this.damage.cloneMask(chunk.index),
      });
    }
  }

  /**
   * THE BUDGETED SECTION.
   *
   * Admission control, not post-hoc accounting: the second upload only starts
   * if the PREDICTED cost of the specific chunk at the head of the queue still
   * fits in the remaining budget. The first upload of a frame is always
   * admitted — an upload cannot be split, and refusing every upload because the
   * prediction is high would starve the world instead of smoothing it.
   *
   * The prediction is per byte, not per chunk. A single average over all rings
   * and districts describes no chunk in the queue: a park R2 chunk and a
   * downtown R0 chunk differ by two orders of magnitude, so an average dragged
   * down by a run of cheap uploads happily admits a 10 ms one against a 4 ms
   * cap. Every pending item already carries its exact byte count.
   */
  private uploadPass(): void {
    if (this.ready.length === 0) return;

    // Re-score against the CURRENT view: a result that has been waiting is
    // ordered by where the camera is now, not by where it was when queued.
    for (const item of this.ready) {
      const scored = scoreChunk(
        item.chunk.index,
        item.result.ring,
        this.view,
        this.isPotentiallyVisible(item.chunk.index)
      ).score;
      // An explicit request leads here too. Winning dispatch only to queue
      // behind a hundred nearer chunks for one of two upload slots is not
      // "load now" — it just moves the wait one stage later.
      item.score = this.pinned.has(item.chunk.index) ? scored + REQUEST_PIN_SCORE : scored;
    }
    this.ready.sort((a, b) => a.score - b.score);

    let spent = 0;
    let uploads = 0;

    while (uploads < this.maxUploads && this.ready.length > 0) {
      const item = this.ready[0]!;
      const chunk = item.chunk;
      // Evicted while waiting, or condemned by this frame's assignment pass:
      // the result is geometry for a chunk that is leaving.
      if (this.byIndex[chunk.index] !== chunk || this.evicting.has(chunk.index)) {
        this.ready.shift();
        continue;
      }
      if (uploads > 0 && spent + this.predictUploadMs(item.result.bytes) > this.uploadBudgetMs) {
        break;
      }
      this.ready.shift();

      // A rebuild replaces geometry the chunk already held; the accounting has
      // to net the two off or the resident total drifts upward forever and the
      // memory ceiling starts evicting a world that is not actually large.
      const previousBytes = chunk.memoryBytes;
      const started = performance.now();
      const bytes = chunk.applyBuild(item.result, this.materials);
      const wasActive = chunk.isActive;
      chunk.activate(this.scene);
      // Force the driver to take the buffers now, so the cost is measured here
      // rather than surfacing inside an unrelated frame's draw.
      this.gpuUpload?.(chunk.root);
      const cost = performance.now() - started;

      spent += cost;
      uploads++;
      chunk.uploadTimeMs = cost;
      const perByte = cost / Math.max(item.result.bytes, 1);
      this.uploadMsPerByte = Math.max(
        this.uploadMsPerByte * (1 - UPLOAD_COST_EMA_ALPHA) + perByte * UPLOAD_COST_EMA_ALPHA,
        UPLOAD_MS_PER_BYTE_FLOOR
      );
      if (cost > this.peakChunkUploadMs) this.peakChunkUploadMs = cost;

      // The caller of `requestChunk` has what it asked for; the chunk goes back
      // to being ordinary and the distance heuristic owns it again.
      this.pinned.delete(chunk.index);
      this.totalBytes += bytes - previousBytes;
      this.totalLoads++;
      this.loadsThisSecond++;
      this.generationTimeMs += item.result.generationTimeMs;
      this.materials.setResident(chunk.index, true);
      this.publishChunkContent(chunk);

      if (!wasActive) {
        this.bus?.emit('ChunkStreamedIn', {
          key: chunk.key,
          coord: chunk.coord,
          loadTimeMs: item.result.generationTimeMs + cost,
          memoryBytes: bytes,
        });
      }
    }

    this.uploadsLastFrame = uploads;
    this.uploadMsLastFrame = spent;
    if (spent > this.peakUploadMs) this.peakUploadMs = spent;
  }

  /** Predicted main-thread milliseconds to upload a payload of `bytes`. */
  private predictUploadMs(bytes: number): number {
    return this.uploadMsPerByte * Math.max(bytes, 1);
  }

  /** Tear down chunks that have drifted out of range, also under budget. */
  private unloadPass(evictions: number[]): void {
    if (evictions.length === 0) return;

    // Evict the ones the player has looked at least recently first: a chunk
    // still on screen is the worst possible thing to drop, even out of range.
    evictions.sort((a, b) => (this.lastSeen[a] ?? -1) - (this.lastSeen[b] ?? -1));

    const started = performance.now();
    let unloaded = 0;
    for (const index of evictions) {
      if (unloaded >= MAX_UNLOADS_PER_FRAME) break;
      if (performance.now() - started > UNLOAD_BUDGET_MS) break;
      this.unloadChunk(index, false);
      unloaded++;
    }
    this.unloadsLastFrame = unloaded;
    this.unloadMsLastFrame = performance.now() - started;
  }

  /**
   * Drop the furthest chunks when resident bytes exceed the soft ceiling.
   *
   * Shares the teardown budget with `unloadPass` rather than running to
   * completion: a tight `memoryBudgetBytes` on a low-memory device is exactly
   * the configuration where this fires, and an uncapped loop there is a
   * several-hundred-millisecond dispose storm plus one synchronous
   * `ChunkStreamedOut` per chunk — the hitch `MAX_UNLOADS_PER_FRAME` exists to
   * forbid. Whatever it cannot do this frame it does on the next one.
   */
  private enforceMemoryBudget(): void {
    if (this.totalBytes <= this.memoryBudget) return;
    const allowance = MAX_UNLOADS_PER_FRAME - this.unloadsLastFrame;
    const timeLeft = UNLOAD_BUDGET_MS - this.unloadMsLastFrame;
    if (allowance <= 0 || timeLeft <= 0) return;

    // Sort on a distance computed HERE. `distanceToFocus` is only refreshed for
    // chunks that passed `shouldLoad`, and is still Infinity for a chunk that
    // `prefetch` or `requestChunk` created — precisely the chunks this pass
    // would then evict first, wherever they actually are.
    const resident = [...this.chunks.values()]
      .map((chunk) => ({
        chunk,
        distance: chunkDistanceUnits(chunk.index, this.focus.x, this.focus.z),
      }))
      .sort((a, b) => b.distance - a.distance);

    const started = performance.now();
    let unloaded = 0;
    for (const entry of resident) {
      if (this.totalBytes <= this.memoryBudget) break;
      if (unloaded >= allowance) break;
      if (performance.now() - started > timeLeft) break;
      this.unloadChunk(entry.chunk.index, true);
      unloaded++;
    }
    this.unloadsLastFrame += unloaded;
    this.unloadMsLastFrame += performance.now() - started;
  }

  private unloadChunk(index: number, forMemory: boolean): void {
    const chunk = this.byIndex[index];
    if (chunk === undefined) return;

    if (chunk.jobId !== -1) {
      this.pool.cancel(chunk.jobId);
      this.jobOwners.delete(chunk.jobId);
      chunk.jobId = -1;
    }
    this.queue.remove(index);
    for (let i = this.ready.length - 1; i >= 0; i--) {
      if (this.ready[i]!.chunk.index === index) this.ready.splice(i, 1);
    }

    const wasActive = chunk.isActive;
    this.totalBytes -= chunk.memoryBytes;
    if (this.totalBytes < 0) this.totalBytes = 0;

    chunk.state = 'unloading';
    chunk.deactivate(this.scene);
    chunk.dispose();

    this.colliderSink?.clearChunkColliders(index);
    this.crowdSink?.clearChunkCrowd(index);
    this.materials.setResident(index, false);
    this.rings.forget(index);
    this.pinned.delete(index);
    this.chunks.delete(chunk.key);
    this.byIndex[index] = undefined;
    this.totalEvictions++;
    this.evictionsThisSecond++;

    if (wasActive) {
      this.bus?.emit('ChunkStreamedOut', {
        key: chunk.key,
        coord: chunk.coord,
        evictedForMemory: forMemory,
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Worker results                                                     */
  /* ------------------------------------------------------------------ */

  private onWorkerResult(response: WorkerResponse): void {
    if (this.disposed) return;

    if (response.kind === 'impostor') {
      if (response.id !== this.impostorJobId) return;
      this.impostorUploadMs = this.impostorRing.apply(response);
      return;
    }
    if (response.kind === 'error') {
      this.onJobFailed(response.id, response.message);
      return;
    }
    if (response.kind !== 'chunk') return;

    const ownerIndex = this.jobOwners.get(response.id);
    this.jobOwners.delete(response.id);
    if (ownerIndex === undefined) return;

    const chunk = this.byIndex[ownerIndex];
    if (chunk === undefined || chunk.jobId !== response.id) return;

    chunk.jobId = -1;
    chunk.state = 'ready';
    this.ready.push({ result: response, chunk, score: 0 });
  }

  /**
   * A job that came back as a failure instead of geometry.
   *
   * Without this the chunk keeps `jobId` set and `state === 'loading'` forever:
   * the assignment pass sees a build in flight and never re-queues, the
   * `jobOwners` entry is never released, `IChunk.load()` never settles, and
   * `isIdle()` — which only looks at the queue, the ready list and the pool —
   * reports the world as fully streamed while it is empty.
   */
  private onJobFailed(id: number, message: string): void {
    if (id === this.impostorJobId) {
      this.impostorJobId = -1;
      return;
    }
    const ownerIndex = this.jobOwners.get(id);
    this.jobOwners.delete(id);
    if (ownerIndex === undefined) return;

    const chunk = this.byIndex[ownerIndex];
    if (chunk === undefined || chunk.jobId !== id) return;
    // Moves the chunk to 'error', clears the job and rejects the outstanding
    // `load()` promises. `assignRings` re-queues it up to `MAX_BUILD_ATTEMPTS`.
    chunk.failBuild(message);
  }

  private hasReadyBuild(index: number): boolean {
    for (const item of this.ready) if (item.chunk.index === index) return true;
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* Sinks                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Publish a freshly uploaded chunk's non-visual content.
   *
   * The ring decides the representation and this is where that decision leaves
   * the streaming system: R0 gets a collider per building and skinned NPCs, R1
   * gets ONE merged collider for the whole block and an instanced crowd, R2 and
   * beyond get neither. Streaming states the policy; the physics and entity
   * workstreams implement it.
   */
  private publishChunkContent(chunk: StreamedChunk): void {
    const mode = RING_COLLIDER_MODE[chunk.builtRing] ?? 'none';
    if (this.colliderSink !== undefined) {
      // An empty parcel registers NOTHING rather than an empty entry: a park
      // chunk that publishes a zero-box collider set still costs the physics
      // world a body handle and a map entry it can never use.
      if (mode === 'none' || chunk.colliders.length === 0) {
        this.colliderSink.clearChunkColliders(chunk.index);
      } else {
        this.colliderSink.setChunkColliders(chunk.index, mode, chunk.colliders);
      }
    }
    if (this.crowdSink !== undefined) {
      if (chunk.crowdMode === 'none' || chunk.crowd.length === 0) {
        this.crowdSink.clearChunkCrowd(chunk.index);
      } else {
        this.crowdSink.setChunkCrowd(chunk.index, chunk.crowdMode, chunk.crowd);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Damage                                                             */
  /* ------------------------------------------------------------------ */

  /** The persistent destruction record. Survives unload/reload by construction. */
  get damageState(): ChunkDamageState {
    return this.damage;
  }

  /**
   * Record a destroyed fracture piece and schedule the chunk's rebuild.
   *
   * Called by the destruction system through its own channel; the bit is what
   * persists, the rebuild is only how the current frame catches up.
   */
  destroyPiece(chunk: number, slot: number): boolean {
    return this.damage.setDestroyed(chunk, slot);
  }

  /** Level a building. Returns pieces newly destroyed. */
  destroyBuilding(chunk: number, buildingIndex: number): number {
    return this.damage.destroyBuilding(chunk, buildingIndex);
  }

  /** Rebuild any resident chunk whose damage changed since the last frame. */
  private applyDamageDirt(): void {
    if (this.damage.dirtyCount === 0) return;
    for (const index of this.damage.takeDirty()) {
      const chunk = this.byIndex[index];
      if (chunk === undefined) continue;
      chunk.pendingRebuild = true;
    }
  }

  /* ------------------------------------------------------------------ */
  /* IStreamingSystem                                                   */
  /* ------------------------------------------------------------------ */

  get loadedChunks(): ReadonlyMap<ChunkKey, IChunk> {
    return this.chunks;
  }

  worldToChunk(position: THREE.Vector3): IChunkCoord {
    return { x: worldToChunkX(position.x), z: worldToChunkZ(position.z) };
  }

  chunkToWorld(coord: IChunkCoord): THREE.Vector3 {
    return new THREE.Vector3(
      coord.x * CHUNK_SIZE + CHUNK_SIZE * 0.5,
      0,
      coord.z * CHUNK_SIZE + CHUNK_SIZE * 0.5
    );
  }

  chunkKey(coord: IChunkCoord): ChunkKey {
    return `${coord.x},${coord.z}`;
  }

  getChunk(coord: IChunkCoord): IChunk | undefined {
    return this.chunks.get(this.chunkKey(coord));
  }

  /** Force a chunk to load now, bypassing the distance heuristic. */
  requestChunk(coord: IChunkCoord, priority?: number): Promise<IChunk> {
    if (!isChunkInWorld(coord.x, coord.z)) {
      return Promise.reject(new Error(`chunk ${coord.x},${coord.z} is outside the world`));
    }
    const index = chunkIndex(coord.x, coord.z);
    const chunk = this.byIndex[index] ?? this.createChunk(index);
    const distance = chunkDistanceUnits(index, this.focus.x, this.focus.z);
    // `ringForChunk`, not `assign`: this runs between frames, and `assign`
    // writes both the ring memory and the pass-scoped population counters that
    // `beginPass` owns — recording, in this case, an UNCLAMPED ring the chunk
    // is then never built at.
    const ring = Math.min(this.rings.ringForChunk(index, distance), RING_R3 - 1);
    chunk.setLOD(ring);
    if (chunk.builtRing !== ring) {
      // Held against eviction until it uploads. A destination beyond the
      // resident radius — which is what "bypassing the distance heuristic" is
      // for — is otherwise torn down by the very next assignment pass, and the
      // caller's promise settles on a chunk with nothing in it. Only taken when
      // there is a build to wait for: a pin with no upload coming would never
      // be released.
      this.pinned.add(index);
      if (chunk.jobId === -1 && !this.hasReadyBuild(index)) {
        // A pin, not a one-shot score: the queue is re-scored before every
        // dispatch, so an explicit request that is merely written into `score`
        // is back behind every nearby chunk one frame later.
        this.enqueue(chunk, ring, { pin: priority ?? REQUEST_PIN_SCORE });
      }
    }
    return chunk.load().then(() => chunk);
  }

  /** Hint that a chunk may be needed soon. Queued, but behind everything real. */
  prefetch(coord: IChunkCoord): void {
    if (!isChunkInWorld(coord.x, coord.z)) return;
    const index = chunkIndex(coord.x, coord.z);
    if (this.byIndex[index] !== undefined) return;
    const chunk = this.createChunk(index);
    const distance = chunkDistanceUnits(index, this.focus.x, this.focus.z);
    const ring = Math.min(this.rings.ringForChunk(index, distance), RING_R3 - 1);
    chunk.setLOD(ring);
    // Behind every distance-scored entry in the queue: a hint is not a demand.
    // A bias rather than a fixed score, so the hint still tracks the camera
    // among other hints — and so it is dropped the moment the assignment pass
    // decides it wants this chunk for real.
    this.enqueue(chunk, ring, { bias: RING_COUNT * RING_PRIORITY_STRIDE });
  }

  /** Drop a chunk regardless of distance. */
  evictChunk(coord: IChunkCoord): void {
    if (!isChunkInWorld(coord.x, coord.z)) return;
    this.unloadChunk(chunkIndex(coord.x, coord.z), false);
  }

  /**
   * Resolve once nothing is queued, in flight or waiting to upload.
   *
   * Requires `update()` to keep being called — the promise is settled from
   * inside the frame loop, because that is the only place the budget is spent.
   */
  waitForIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private isIdle(): boolean {
    return this.queue.size === 0 && this.ready.length === 0 && this.pool.idle;
  }

  private settleIdleWaiters(): void {
    if (this.idleWaiters.length === 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** Re-evaluate budgets after a quality-tier change. */
  applyQuality(tier: IQualityTier): void {
    if (tier === this.quality) return;
    this.quality = tier;
    this.residentRadius = residentRadiusFor(tier);
    // The published config carries the resident radius, so it moves with it or
    // it is a lie — consumers size working sets and prefetch corridors from it.
    this.worldConfig = {
      ...this.worldConfig,
      streamingRadiusChunks: this.residentRadius,
      evictionRadiusChunks: this.residentRadius + EVICT_MARGIN_CHUNKS,
    };
    // Chunks outside the new radius are picked up by the next assignment pass,
    // and are evicted under the same per-frame budget as everything else — a
    // tier change must not be allowed to stall a frame either.
  }

  /** The tier currently in force. */
  get qualityTier(): IQualityTier {
    return this.quality;
  }

  getStats(): IStreamingStats {
    let loading = 0;
    let active = 0;
    for (const chunk of this.chunks.values()) {
      if (chunk.state === 'loading') loading++;
      // ACTIVE means in the scene graph, which is what the sibling
      // `loadingChunks` / `pooledChunks` fields imply and what
      // `getDetailedStats` already reported under the same name. Counting every
      // resident chunk made this read 250 on the frame two were drawable.
      if (chunk.isActive) active++;
    }
    return {
      activeChunks: active,
      loadingChunks: loading,
      pooledChunks: this.ready.length,
      totalMemoryBytes: this.totalBytes,
      loadsThisSecond: this.loadsThisSecond,
      evictionsThisSecond: this.evictionsThisSecond,
      generationTimeMs: this.generationTimeMs,
    };
  }

  /** Full telemetry for the debug HUD and the verification harness. */
  getDetailedStats(): IStreamingDetailedStats {
    const byRing: number[] = new Array(RING_COUNT).fill(0);
    for (const chunk of this.chunks.values()) {
      if (chunk.builtRing >= 0 && chunk.builtRing < RING_COUNT) byRing[chunk.builtRing]!++;
    }
    const poolStats = this.pool.stats();
    const damageStats = this.damage.stats();
    return {
      ...this.getStats(),
      frame: this.frame,
      residentChunks: this.chunks.size,
      chunksByRing: byRing,
      queued: this.queue.size,
      inFlight: this.pool.inFlight,
      readyToUpload: this.ready.length,
      uploadsLastFrame: this.uploadsLastFrame,
      uploadMsLastFrame: this.uploadMsLastFrame,
      peakUploadMs: this.peakUploadMs,
      peakChunkUploadMs: this.peakChunkUploadMs,
      unloadsLastFrame: this.unloadsLastFrame,
      unloadMsLastFrame: this.unloadMsLastFrame,
      totalLoads: this.totalLoads,
      totalEvictions: this.totalEvictions,
      ringTransitions: this.rings.transitionCount,
      ringTransitionsSuppressed: this.rings.suppressedCount,
      residentRadiusChunks: this.residentRadius,
      quality: this.quality,
      workerTimeMs: poolStats.workerTimeMs,
      workersInline: poolStats.inline,
      impostor: this.impostorRing.getStats(),
      damagedChunks: damageStats.damagedChunks,
      destroyedPieces: damageStats.destroyedPieces,
      impostorUploadMs: this.impostorUploadMs,
    };
  }

  /** The impostor ring, for scene wiring and verification. */
  get impostor(): ImpostorRing {
    return this.impostorRing;
  }

  /** The shared materials, for scene wiring and verification. */
  get sharedMaterials(): StreamingMaterials {
    return this.materials;
  }

  /** The resident chunk at a dense index, if any. */
  chunkAtIndex(index: number): StreamedChunk | undefined {
    return this.byIndex[index];
  }

  /** Reset the peak counters. Used between harness laps. */
  resetPeaks(): void {
    this.peakUploadMs = 0;
    this.peakChunkUploadMs = 0;
    this.rings.resetCounters();
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const index of [...this.byIndex.keys()]) {
      if (this.byIndex[index] !== undefined) this.unloadChunk(index, false);
    }
    this.queue.clear();
    this.ready.length = 0;
    this.jobOwners.clear();
    this.pool.dispose();
    this.impostorRing.detach(this.scene);
    this.impostorRing.dispose();
    this.materials.dispose();
    this.settleIdleWaiters();
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                          */
  /* ------------------------------------------------------------------ */

  private createChunk(index: number): StreamedChunk {
    const chunk = new StreamedChunk(index, this);
    this.chunks.set(chunk.key, chunk);
    this.byIndex[index] = chunk;
    return chunk;
  }

  /** `IChunkHost` — a chunk asking to be built via `IChunk.load()`. */
  requestBuild(chunk: StreamedChunk): void {
    if (chunk.jobId !== -1 || this.queue.has(chunk.index)) return;
    const ring = chunk.desiredRing >= 0 ? chunk.desiredRing : RING_R0;
    this.enqueue(chunk, ring, { pin: REQUEST_PIN_SCORE });
  }

  private isPotentiallyVisible(chunk: number): boolean {
    if (this.viewChunk < 0) return true;
    return this.pvs(this.viewChunk, chunk);
  }

  /** Queue the one-off impostor bake. Its upload is a boot cost, not a frame cost. */
  private bakeImpostor(): void {
    this.impostorJobId = this.nextJobId++;
    this.pool.submit({
      kind: 'impostor',
      id: this.impostorJobId,
      generator: this.generator,
      seed: this.config.seed,
    });
  }
}

/** Dense chunk index for a world position, or -1 outside the world. */
export function chunkIndexForPosition(x: number, z: number): number {
  return chunkIndex(worldToChunkX(x), worldToChunkZ(z));
}

/** Signed chunk coordinate for a dense index. */
export function coordForChunkIndex(index: number): IChunkCoord {
  return { x: chunkIndexToX(index), z: chunkIndexToZ(index) };
}
