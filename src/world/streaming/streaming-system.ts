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
  CHUNK_SIZE,
  chunkIndex,
  chunkIndexToX,
  chunkIndexToZ,
  isChunkInWorld,
  worldToChunkX,
  worldToChunkZ,
} from '@/spatial/constants';
import {
  MAX_IN_FLIGHT_JOBS,
  MAX_UNLOADS_PER_FRAME,
  MAX_UPLOADS_PER_FRAME,
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
  type ColliderMode,
  type CrowdMode,
} from './constants';
import { ChunkDamageState } from './damage-state';
import { ChunkPriorityQueue, chunkDistanceUnits, scoreChunk, type IPriorityView } from './priority-queue';
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
  readonly residentChunks: number;
  readonly activeChunks: number;
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

/* -------------------------------------------------------------------------- */
/* System                                                                     */
/* -------------------------------------------------------------------------- */

export class StreamingSystem implements IStreamingSystem, IChunkHost {
  readonly config: IWorldConfig;
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

  private uploadCostEma = 0.5;
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
    this.config = {
      seed,
      chunkSize: CHUNK_SIZE,
      worldRadiusChunks: 8,
      lodLevels: STREAMING_LOD_LEVELS,
      streamingRadiusChunks: this.residentRadius,
      evictionRadiusChunks: this.residentRadius + 0.5,
      maxConcurrentLoads: MAX_IN_FLIGHT_JOBS,
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

    this.applyDamageDirt();
    const evictions = this.assignRings();
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
        if (existing !== undefined && shouldEvict(distance, this.residentRadius)) {
          evictions.push(index);
        }
        continue;
      }

      const ring = this.rings.assign(index, distance);
      if (ring >= RING_R3) {
        // Past R2 the impostor is the representation. Nothing to stream.
        if (existing !== undefined) evictions.push(index);
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

      this.enqueue(chunk, ring);
    }

    return evictions;
  }

  /** Queue or re-score a build for a chunk. */
  private enqueue(chunk: StreamedChunk, ring: number, priorityOverride?: number): void {
    const visible = this.isPotentiallyVisible(chunk.index);
    const scored = scoreChunk(chunk.index, ring, this.view, visible);
    this.queue.push({
      chunk: chunk.index,
      ring,
      score: priorityOverride ?? scored.score,
      distance: scored.distance,
      angleTerm: scored.angleTerm,
      pvsVisible: visible,
      enqueuedFrame: this.frame,
    });
    if (chunk.state === 'unloaded') chunk.state = 'loading';
  }

  /** Hand queued work to the pool, highest priority first. */
  private dispatch(): void {
    while (this.queue.size > 0 && this.pool.inFlight + this.pool.queued < MAX_IN_FLIGHT_JOBS) {
      const entry = this.queue.pop()!;
      const chunk = this.byIndex[entry.chunk];
      if (chunk === undefined) continue;

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
   * if the exponential moving average of what an upload costs still fits in the
   * remaining budget. The first upload of a frame is always admitted — an
   * upload cannot be split, and refusing every upload because the average is
   * high would starve the world instead of smoothing it.
   */
  private uploadPass(): void {
    if (this.ready.length === 0) return;

    // Re-score against the CURRENT view: a result that has been waiting is
    // ordered by where the camera is now, not by where it was when queued.
    for (const item of this.ready) {
      item.score = scoreChunk(
        item.chunk.index,
        item.result.ring,
        this.view,
        this.isPotentiallyVisible(item.chunk.index)
      ).score;
    }
    this.ready.sort((a, b) => a.score - b.score);

    let spent = 0;
    let uploads = 0;

    while (uploads < this.maxUploads && this.ready.length > 0) {
      if (uploads > 0 && spent + this.uploadCostEma > this.uploadBudgetMs) break;

      const item = this.ready.shift()!;
      const chunk = item.chunk;
      if (this.byIndex[chunk.index] !== chunk) continue; // evicted while waiting

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
      this.uploadCostEma =
        this.uploadCostEma * (1 - UPLOAD_COST_EMA_ALPHA) + cost * UPLOAD_COST_EMA_ALPHA;
      if (cost > this.peakChunkUploadMs) this.peakChunkUploadMs = cost;

      this.totalBytes += bytes;
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

  /** Drop the furthest chunks when resident bytes exceed the soft ceiling. */
  private enforceMemoryBudget(): void {
    if (this.totalBytes <= this.memoryBudget) return;
    const resident = [...this.chunks.values()].sort(
      (a, b) => b.distanceToFocus - a.distanceToFocus
    );
    for (const chunk of resident) {
      if (this.totalBytes <= this.memoryBudget) break;
      this.unloadChunk(chunk.index, true);
    }
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
      if (mode === 'none') this.colliderSink.clearChunkColliders(chunk.index);
      else this.colliderSink.setChunkColliders(chunk.index, mode, chunk.colliders);
    }
    if (this.crowdSink !== undefined) {
      if (chunk.crowdMode === 'none') this.crowdSink.clearChunkCrowd(chunk.index);
      else this.crowdSink.setChunkCrowd(chunk.index, chunk.crowdMode, chunk.crowd);
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
    const ring = Math.min(this.rings.assign(index, distance), RING_R3 - 1);
    chunk.setLOD(ring);
    if (chunk.jobId === -1 && !this.hasReadyBuild(index) && chunk.builtRing !== ring) {
      // Negative override: an explicit request outranks every distance-scored
      // entry in the queue, which is what "bypassing the heuristic" means.
      this.enqueue(chunk, ring, priority ?? -1e9);
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
    const ring = Math.min(this.rings.assign(index, distance), RING_R3 - 1);
    chunk.setLOD(ring);
    // Behind every distance-scored entry in the queue: a hint is not a demand.
    this.enqueue(chunk, ring, RING_COUNT * RING_PRIORITY_STRIDE + distance * CHUNK_SIZE);
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
    for (const chunk of this.chunks.values()) if (chunk.state === 'loading') loading++;
    return {
      activeChunks: this.chunks.size,
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
    let active = 0;
    for (const chunk of this.chunks.values()) {
      if (chunk.builtRing >= 0 && chunk.builtRing < RING_COUNT) byRing[chunk.builtRing]!++;
      if (chunk.isActive) active++;
    }
    const poolStats = this.pool.stats();
    const damageStats = this.damage.stats();
    return {
      ...this.getStats(),
      frame: this.frame,
      residentChunks: this.chunks.size,
      activeChunks: active,
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
    this.enqueue(chunk, ring, -1e9);
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
