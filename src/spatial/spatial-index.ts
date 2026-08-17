/**
 * SPATIAL INDEX FACADE
 *
 * One object holding the four structures and the wiring between them, so the
 * renderer, the streaming system and combat each talk to a single surface
 * instead of assembling a quadtree, a PVS and an entity grid themselves.
 *
 * Per frame the renderer does:
 *
 *     index.cull(camera);
 *     for (let i = 0; i < index.visibleInstances.length; i++) { ... }
 *
 * and the streaming system reads `visibleChunks` from the same pass. The PVS is
 * applied INSIDE the quadtree walk, so both outputs come from one traversal
 * rather than a chunk pass followed by an instance pass.
 *
 * ── OWNERSHIP BOUNDARY ─────────────────────────────────────────────────────
 * This module indexes space. It does not load chunks, does not resolve damage
 * and does not draw anything. `visibleChunks` is the handoff to the streaming
 * workstream; `queryCone` is the handoff to combat. Neither system's logic
 * lives here, and this file imports no system's implementation.
 */

import type * as THREE from 'three';
import { CHUNK_COUNT, chunkIndexAt } from './constants';
import { Frustum } from './frustum';
import { IndexList } from './index-list';
import { Quadtree, createCullStats, type ICullStats, type IQuadtreeOptions } from './quadtree';
import { DynamicEntityGrid } from './entity-grid';
import { PvsTable } from './pvs';
import type { GroundBVH } from './mesh-bvh';

/** Construction options. */
export interface ISpatialIndexOptions {
  readonly quadtree?: IQuadtreeOptions;
  /** Entity slots pre-allocated in the dynamic grid. */
  readonly entityCapacity?: number;
  /** Cached visibility table. Without one, no chunk is ever PVS-rejected. */
  readonly pvs?: PvsTable;
}

/** Aggregate telemetry for the debug HUD. */
export interface ISpatialStats {
  readonly staticInstances: number;
  readonly quadtreeNodes: number;
  readonly quadtreeBytes: number;
  readonly dynamicEntities: number;
  readonly pvsBytes: number;
  readonly pvsAverageVisible: number;
  readonly visibleInstances: number;
  readonly visibleChunks: number;
  readonly lastCull: ICullStats;
}

export class SpatialIndex {
  /** Static instance AABBs. */
  readonly quadtree: Quadtree;
  /** Moving actors, rebuilt every frame. */
  readonly entities: DynamicEntityGrid;
  /** Working frustum, refreshed by `cull`. */
  readonly frustum = new Frustum();

  /** Instance handles surviving the last cull. */
  readonly visibleInstances = new IndexList(4096);
  /** Dense chunk indices surviving the last cull. */
  readonly visibleChunks = new IndexList(CHUNK_COUNT);
  /** Stats from the last cull. */
  readonly cullStats: ICullStats = createCullStats();

  /** Precomputed visibility. `undefined` until `setPvs`. */
  private pvsTable: PvsTable | undefined;
  /** Triangle BVH over the merged ground/road mesh. */
  private ground: GroundBVH | undefined;

  private readonly viewProjection = new Float64Array(16);
  private readonly chunkBounds = new Float64Array(6);
  private viewChunk = -1;
  private frame = 0;

  constructor(options: ISpatialIndexOptions = {}) {
    this.quadtree = new Quadtree(options.quadtree);
    this.entities = new DynamicEntityGrid(options.entityCapacity ?? 512);
    this.pvsTable = options.pvs;
  }

  /* ------------------------------------------------------------------ */
  /* Static geometry                                                    */
  /* ------------------------------------------------------------------ */

  /** Index one static AABB. Returns a handle for `removeStatic`. */
  insertStatic(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    ref?: unknown
  ): number {
    return this.quadtree.insert(minX, minY, minZ, maxX, maxY, maxZ, ref);
  }

  /** Index a `THREE.Box3`. Convenience for callers already holding one. */
  insertStaticBox(box: THREE.Box3, ref?: unknown): number {
    return this.quadtree.insert(
      box.min.x,
      box.min.y,
      box.min.z,
      box.max.x,
      box.max.y,
      box.max.z,
      ref
    );
  }

  /** Drop a static instance — a destroyed building, an unloaded chunk. */
  removeStatic(handle: number): boolean {
    return this.quadtree.remove(handle);
  }

  /**
   * Tighten quadtree bounds after a batch of removals. Optional: queries do it
   * lazily anyway. Call it explicitly after a chunk unload so the cost lands in
   * the streaming budget rather than in the middle of a frame.
   */
  refit(): void {
    this.quadtree.refit();
  }

  /* ------------------------------------------------------------------ */
  /* Attachments                                                        */
  /* ------------------------------------------------------------------ */

  /** Install a visibility table. Pass `undefined` to disable PVS culling. */
  setPvs(table: PvsTable | undefined): void {
    this.pvsTable = table;
  }

  /** The installed table, if any. */
  get pvs(): PvsTable | undefined {
    return this.pvsTable;
  }

  /** Install the ground BVH used for character and projectile raycasts. */
  setGround(bvh: GroundBVH | undefined): void {
    this.ground = bvh;
  }

  /** The installed ground BVH, if any. */
  get groundBvh(): GroundBVH | undefined {
    return this.ground;
  }

  /* ------------------------------------------------------------------ */
  /* Culling                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Cull against a camera. Fills `visibleInstances`, `visibleChunks`,
   * `cullStats` and refreshes `frustum`.
   *
   * `camera.updateMatrixWorld()` must already have run this frame.
   */
  cull(camera: THREE.Camera): ICullStats {
    this.frustum.setFromCamera(camera);
    const p = camera.matrixWorld.elements;
    return this.cullWithFrustum(p[12]!, p[14]!);
  }

  /**
   * Cull from a raw view-projection matrix and eye position. The camera-free
   * path, used by tests, the harness and any off-thread visibility prepass.
   */
  cullFromViewProjection(
    elements: ArrayLike<number>,
    eyeX: number,
    eyeZ: number
  ): ICullStats {
    this.frustum.setFromViewProjection(elements);
    return this.cullWithFrustum(eyeX, eyeZ);
  }

  /** Scratch matrix for callers composing their own view-projection. */
  get viewProjectionScratch(): Float64Array {
    return this.viewProjection;
  }

  private cullWithFrustum(eyeX: number, eyeZ: number): ICullStats {
    this.frame++;
    this.viewChunk = chunkIndexAt(eyeX, eyeZ);

    this.quadtree.cullFrustum(
      this.frustum,
      this.visibleInstances,
      this.cullStats,
      this.pvsTable,
      this.pvsTable !== undefined ? this.viewChunk : -1
    );

    this.collectVisibleChunks();
    return this.cullStats;
  }

  /**
   * Chunk-level visibility for the streaming system.
   *
   * Only 256 boxes, so a flat loop beats any structure — and using the
   * quadtree's depth-4 content bounds means an empty or low-rise chunk rejects
   * against its real extent instead of a nominal column.
   */
  private collectVisibleChunks(): void {
    this.visibleChunks.clear();
    const bounds = this.chunkBounds;
    const pvs = this.pvsTable;

    for (let c = 0; c < CHUNK_COUNT; c++) {
      const node = this.quadtree.chunkNode(c);
      if (node < 0 || this.quadtree.getNodeTotal(node) === 0) continue;
      if (pvs !== undefined && this.viewChunk >= 0 && !pvs.isVisible(this.viewChunk, c)) continue;
      this.quadtree.getNodeBounds(node, bounds);
      if (
        this.frustum.testBox(bounds[0]!, bounds[1]!, bounds[2]!, bounds[3]!, bounds[4]!, bounds[5]!)
      ) {
        this.visibleChunks.push(c);
      }
    }
  }

  /** Dense chunk index the last cull's camera stood in, or -1. */
  get currentChunk(): number {
    return this.viewChunk;
  }

  /** Frames culled since construction. */
  get frameIndex(): number {
    return this.frame;
  }

  /**
   * Could chunk `to` be visible from chunk `from`? The predicate the streaming
   * system uses to prioritise loads. Always true without a PVS installed.
   */
  isChunkPotentiallyVisible(from: number, to: number): boolean {
    return this.pvsTable === undefined ? true : this.pvsTable.isVisible(from, to);
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  /** Snapshot for the debug overlay. */
  getStats(): ISpatialStats {
    const tree = this.quadtree.describe();
    const pvsStats = this.pvsTable?.stats();
    return {
      staticInstances: tree.items,
      quadtreeNodes: tree.nodes,
      quadtreeBytes: tree.bytes,
      dynamicEntities: this.entities.size,
      pvsBytes: pvsStats?.bytes ?? 0,
      pvsAverageVisible: pvsStats?.averageVisible ?? CHUNK_COUNT,
      visibleInstances: this.visibleInstances.length,
      visibleChunks: this.visibleChunks.length,
      lastCull: this.cullStats,
    };
  }

  /** Release everything. The BVH and PVS are owned by their providers. */
  dispose(): void {
    this.quadtree.clear();
    this.entities.beginFrame();
    this.visibleInstances.clear();
    this.visibleChunks.clear();
    this.pvsTable = undefined;
    this.ground = undefined;
  }
}
