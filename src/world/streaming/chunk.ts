/**
 * A STREAMED CHUNK
 *
 * `IChunk` from `@/types/world`, plus the one thing the interface deliberately
 * does not describe: what actually happens on the main thread when a chunk
 * arrives.
 *
 * ── THE UPLOAD IS THE WHOLE COST ───────────────────────────────────────────
 * Generation happens on a worker. Fetching happens on a worker. What is left
 * for the main thread is `applyBuild`, and it is written to be as close to
 * nothing as the API allows:
 *
 *   • `THREE.BufferAttribute` wraps the transferred typed array in place. No
 *     copy, no per-vertex loop, no allocation proportional to the geometry.
 *   • The bounding sphere is SET from the value the worker computed. Letting
 *     three call `computeBoundingSphere()` would walk every vertex on the main
 *     thread at exactly the moment the budget is tightest — for a 40 000-vertex
 *     chunk that is the difference between a 0.1 ms upload and a 2 ms one.
 *   • One mesh, one shared material. Splitting a chunk into per-material meshes
 *     would multiply both the draw calls and the upload's fixed costs.
 *
 * Everything after that is GL's problem, and GL's share is a `bufferData` the
 * driver can pipeline.
 *
 * ── LOD CHANGES ARE REBUILDS ───────────────────────────────────────────────
 * `setLOD` records intent; it does not morph geometry, because the rings emit
 * structurally different meshes (fracture pieces vs. one box vs. a merged block
 * mesh) rather than decimations of one another. The streaming system notices
 * the mismatch and queues a rebuild through the same budgeted path as a fresh
 * load, so a ring change can never bypass the frame budget.
 */

import * as THREE from 'three';
import type { ChunkKey, ChunkState, IChunk, IChunkCoord, ICityBlock, IWorldBounds } from '@/types';
import { CHUNK_SIZE, chunkIndexToX, chunkIndexToZ } from '@/spatial/constants';
import { RING_CROWD_MODE, RING_DESTRUCTIBLE, STREAMING_LOD_LEVELS } from './constants';
import type { CrowdMode } from './constants';
import type { IChunkBuildResult, IColliderBox, ICrowdSlot } from './protocol';
import type { StreamingMaterials } from './materials';

/** What a chunk asks of its owner. Keeps the chunk free of system knowledge. */
export interface IChunkHost {
  /** Queue a build for this chunk at its current desired ring. */
  requestBuild(chunk: StreamedChunk): void;
}

/** One outstanding `load()` call. */
interface IPendingLoad {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  /** Drops the caller's `abort` listener. See the note in `load`. */
  readonly detach: () => void;
}

/**
 * Conservative ceiling for a chunk's AABB before anything is built.
 *
 * The tallest thing the generator emits is a downtown tower at roughly 94 m
 * plus its parapet, so one chunk edge covers it with room to spare. A zero
 * height would be worse than a wrong one: `bounds` is contracted as covering
 * all content in the chunk and is read from the moment `createChunk` runs, so a
 * flat plate at y = 0 tells a frustum pre-pass or a spawn query that a tower
 * block occupies no vertical space at all.
 */
const PROVISIONAL_CEILING = CHUNK_SIZE;

export class StreamedChunk implements IChunk {
  readonly coord: IChunkCoord;
  readonly key: ChunkKey;
  /** Dense 0..255 index — the PVS bit, the damage key, the residency texel. */
  readonly index: number;
  readonly bounds: IWorldBounds;
  readonly root: THREE.Group;

  state: ChunkState = 'unloaded';
  lodIndex = -1;
  distanceToFocus = Infinity;
  blocks?: ICityBlock[];
  error?: string;
  lastSeenFrame = -1;

  /** Ring the resident geometry was built at, or -1 when nothing is built. */
  builtRing = -1;
  /** Ring the chunk should be at. Differs from `builtRing` during a rebuild. */
  desiredRing = -1;
  /** In-flight build job id, or -1. */
  jobId = -1;
  /**
   * Ring the in-flight job is building, or -1. Tracked so a ring change while a
   * build is in flight cancels it instead of uploading geometry that is already
   * known to be the wrong detail level.
   */
  jobRing = -1;
  /**
   * Set when the chunk must be rebuilt for a reason other than a ring change —
   * in practice, persistent damage arriving while the chunk is resident.
   */
  pendingRebuild = false;
  /** Static colliders for the built ring. Handed to the physics sink. */
  colliders: readonly IColliderBox[] = [];
  /** Crowd slots for the built ring. Handed to the crowd sink. */
  crowd: readonly ICrowdSlot[] = [];
  /** How NPCs should be represented at the built ring. */
  crowdMode: CrowdMode = 'none';
  /** Buildings standing after damage was applied, at the built ring. */
  standingBuildings = 0;
  /** Fracture pieces the damage mask suppressed at the built ring. */
  destroyedPieces = 0;
  /** Deterministic hash of the built geometry. Determinism assertions read it. */
  contentHash = 0;
  /** Milliseconds a worker spent on the resident build. */
  generationTimeMs = 0;
  /** Milliseconds the main thread spent uploading the resident build. */
  uploadTimeMs = 0;
  /** Consecutive failed builds. Reset by a build that lands. */
  buildFailures = 0;

  private readonly host: IChunkHost;
  private mesh: THREE.Mesh | undefined;
  private geometry: THREE.BufferGeometry | undefined;
  private bytes = 0;
  private inScene = false;
  private pending: IPendingLoad[] = [];

  constructor(index: number, host: IChunkHost) {
    this.index = index;
    const cx = chunkIndexToX(index);
    const cz = chunkIndexToZ(index);
    this.coord = { x: cx, z: cz };
    this.key = `${cx},${cz}`;
    this.host = host;
    this.root = new THREE.Group();
    this.root.name = `chunk:${this.key}`;
    // Chunks never move, and skipping the per-frame matrix walk over hundreds
    // of resident groups is free performance.
    this.root.matrixAutoUpdate = false;
    this.root.position.set(0, 0, 0);
    this.root.updateMatrix();

    // Conservative-but-valid until `applyBuild` tightens it to the real AABB.
    this.bounds = {
      min: new THREE.Vector3(cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE),
      max: new THREE.Vector3((cx + 1) * CHUNK_SIZE, PROVISIONAL_CEILING, (cz + 1) * CHUNK_SIZE),
    };
  }

  /** Approximate bytes held by this chunk's GPU buffers. */
  get memoryBytes(): number {
    return this.bytes;
  }

  /** True when the chunk's geometry is attached to the scene. */
  get isActive(): boolean {
    return this.inScene;
  }

  /** True when the resident build no longer matches the desired ring. */
  get needsRebuild(): boolean {
    return this.desiredRing >= 0 && this.builtRing !== this.desiredRing;
  }

  /* ------------------------------------------------------------------ */
  /* IChunk                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Ask the owner to build this chunk and resolve once its geometry is
   * actually resident.
   *
   * Resident, not `state === 'ready'`: 'ready' also covers "a worker result has
   * arrived and is queued for upload", and a caller that awaited `load()`
   * expects a chunk it can use, not one whose buffers have not been wrapped
   * yet. The two coincide for every chunk that has been through `applyBuild`.
   *
   * The abort signal drops the caller's interest only; the build itself is not
   * cancelled here, because another caller may still want it and a half-built
   * chunk is not a thing the pool can produce.
   */
  load(signal?: AbortSignal): Promise<void> {
    if (this.builtRing >= 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new Error(`chunk ${this.key}: aborted before load`));
        return;
      }
      // The listener has to come off on the NORMAL path too. `{ once: true }`
      // only detaches once the event fires, so a caller holding one long-lived
      // controller for a whole fast-travel sequence would otherwise accumulate
      // a listener per chunk on it — each closure retaining the chunk, its
      // `root`, its colliders and its crowd long after the chunk was unloaded.
      const onAbort = (): void => {
        this.pending = this.pending.filter((p) => p.reject !== reject);
        reject(new Error(`chunk ${this.key}: load aborted`));
      };
      this.pending.push({
        resolve,
        reject,
        detach: (): void => signal?.removeEventListener('abort', onAbort),
      });
      signal?.addEventListener('abort', onAbort, { once: true });

      // Only kick a build from a state where nothing is already pending: a
      // chunk in 'ready' has a result waiting for upload, and asking for a
      // second build of it would burn a worker slot on geometry already in hand.
      if (this.state === 'unloaded' || this.state === 'error') {
        this.state = 'loading';
        this.host.requestBuild(this);
      }
    });
  }

  /** Attach to the scene. Cheap: one `add`, no traversal. */
  activate(scene: THREE.Scene): void {
    if (this.inScene) return;
    scene.add(this.root);
    this.inScene = true;
    this.state = 'active';
  }

  /** Detach without releasing GPU resources. */
  deactivate(scene: THREE.Scene): void {
    if (!this.inScene) return;
    scene.remove(this.root);
    this.inScene = false;
    if (this.state === 'active') this.state = 'ready';
  }

  /**
   * Record the ring this chunk should render at.
   *
   * Shadow casting is the one property that can change without a rebuild, so it
   * is applied immediately; the geometry swap waits for the budgeted rebuild.
   */
  setLOD(lodIndex: number): void {
    this.desiredRing = lodIndex;
    this.lodIndex = lodIndex;
    const level = STREAMING_LOD_LEVELS[lodIndex];
    if (this.mesh !== undefined && level !== undefined) {
      this.mesh.castShadow = level.castShadows;
      this.mesh.receiveShadow = level.castShadows;
    }
  }

  /** Release every GPU resource. Idempotent. */
  dispose(): void {
    this.releaseGeometry();
    this.root.clear();
    this.colliders = [];
    this.crowd = [];
    this.crowdMode = 'none';
    this.builtRing = -1;
    this.state = 'unloaded';
    this.bytes = 0;
    // REJECT, not resolve. A chunk that was torn down before its build landed
    // has no mesh, no colliders and no crowd, and resolving handed that back to
    // the caller as a success with no way to tell anything had gone wrong.
    this.failPending(new Error(`chunk ${this.key}: unloaded before the load completed`));
  }

  /* ------------------------------------------------------------------ */
  /* Upload                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Install a worker build result. THIS IS THE BUDGETED CALL — everything it
   * does happens inside the caller's `performance.now()` bracket.
   *
   * Returns the bytes now resident, so the streaming system can maintain its
   * memory total without re-inspecting the geometry.
   */
  applyBuild(result: IChunkBuildResult, materials: StreamingMaterials): number {
    this.releaseGeometry();

    const buffers = result.buffers;
    const geometry = new THREE.BufferGeometry();
    geometry.name = `chunk:${this.key}:r${result.ring}`;
    // In-place wrappers over the transferred buffers: no copy happens here.
    geometry.setAttribute('position', new THREE.BufferAttribute(buffers.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(buffers.normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(buffers.colors, 3, true));
    geometry.setIndex(new THREE.BufferAttribute(buffers.indices, 1));

    // Set, never compute: `computeBoundingSphere` is an O(vertices) main-thread
    // walk and the worker already paid for it.
    const [sx, sy, sz, radius] = buffers.boundingSphere;
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(sx, sy, sz), radius);
    geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3(result.bounds[0], result.bounds[1], result.bounds[2]),
      new THREE.Vector3(result.bounds[3], result.bounds[4], result.bounds[5])
    );

    const level = STREAMING_LOD_LEVELS[result.ring];
    const mesh = new THREE.Mesh(geometry, materials.chunk);
    mesh.name = `chunk:${this.key}`;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    // The chunk group is already frustum-culled by the spatial index; three's
    // per-object test would only repeat that work per frame.
    mesh.frustumCulled = true;
    mesh.castShadow = level?.castShadows ?? false;
    mesh.receiveShadow = level?.castShadows ?? false;

    this.root.add(mesh);
    this.mesh = mesh;
    this.geometry = geometry;

    this.bytes = result.bytes;
    this.builtRing = result.ring;
    this.lodIndex = result.ring;
    this.colliders = result.colliders;
    this.crowd = result.crowd;
    this.crowdMode = result.crowdMode;
    this.standingBuildings = result.standingBuildings;
    this.destroyedPieces = result.destroyedPieces;
    this.contentHash = result.contentHash;
    this.generationTimeMs = result.generationTimeMs;
    this.jobId = -1;
    this.jobRing = -1;
    this.pendingRebuild = false;
    this.error = undefined;
    this.buildFailures = 0;
    this.state = this.inScene ? 'active' : 'ready';

    this.bounds.min.set(result.bounds[0], result.bounds[1], result.bounds[2]);
    this.bounds.max.set(result.bounds[3], result.bounds[4], result.bounds[5]);

    this.settlePending();
    return this.bytes;
  }

  /** Record a failed build so the system can retry or surface it. */
  failBuild(message: string): void {
    this.error = message;
    this.state = 'error';
    this.jobId = -1;
    this.jobRing = -1;
    this.buildFailures++;
    this.failPending(new Error(`chunk ${this.key}: ${message}`));
  }

  /** True when destruction should be simulated at the built ring. */
  get destructibleActive(): boolean {
    return RING_DESTRUCTIBLE[this.builtRing] ?? false;
  }

  /** Crowd representation implied by the built ring. */
  get ringCrowdMode(): CrowdMode {
    return RING_CROWD_MODE[this.builtRing] ?? 'none';
  }

  private releaseGeometry(): void {
    if (this.mesh !== undefined) {
      this.root.remove(this.mesh);
      this.mesh = undefined;
    }
    if (this.geometry !== undefined) {
      // Frees the GL buffers. The material is shared and outlives every chunk.
      this.geometry.dispose();
      this.geometry = undefined;
    }
    this.bytes = 0;
  }

  /** Resolve every outstanding `load()`. Only ever called from `applyBuild`. */
  private settlePending(): void {
    if (this.pending.length === 0) return;
    const waiting = this.pending;
    this.pending = [];
    for (const entry of waiting) {
      entry.detach();
      entry.resolve();
    }
  }

  /** Reject every outstanding `load()`: the build will not arrive. */
  private failPending(error: Error): void {
    if (this.pending.length === 0) return;
    const waiting = this.pending;
    this.pending = [];
    for (const entry of waiting) {
      entry.detach();
      entry.reject(error);
    }
  }
}
