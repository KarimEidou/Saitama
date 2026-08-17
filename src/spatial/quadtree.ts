/**
 * STATIC QUADTREE — 1536 m EXTENT, DEPTH 6, 24 m LEAVES
 *
 * Holds the world-space AABB of every static instance in City Z: buildings,
 * props, street furniture, destructible pieces. It answers four questions:
 * hierarchical frustum culling, box/circle range queries, raycasts, and — with
 * a PVS attached — "which chunks does the renderer need".
 *
 * ── WHY A LINEAR, PRE-ALLOCATED TREE ───────────────────────────────────────
 * The tree is COMPLETE and its shape is fixed at construction: 5461 nodes for
 * depth 6, laid out level by level in flat typed arrays. Nothing is allocated
 * while walking it, node fields are contiguous per level, and — the reason it
 * is worth the rigidity — a node's (depth, cellX, cellZ) is recoverable by
 * subtracting a level offset. That is what makes **depth-4 cells exactly the
 * 96 m streaming chunks**, so the PVS bit for a chunk can be consulted mid-walk
 * to discard a 96 m subtree in a single test.
 *
 * Per node the tree stores the union of the bounds beneath it ("content
 * bounds"), not the cell bounds. Content bounds are tight — a chunk holding one
 * low building rejects against a 12 m-tall box rather than an unbounded 96 m
 * column — and tightness is what the exactness proof in `frustum.ts` rests on.
 *
 * ── THE PACKED LAYOUT, AND WHY IT IS THE WHOLE PERFORMANCE STORY ───────────
 * A naive quadtree walk is only a few times faster than a linear scan, because
 * with 10,000 items over 4096 leaves a node "covers" barely two items: the walk
 * pays a 12-plane node classification to save two 6-plane item tests.
 *
 * `pack()` fixes that by laying every subtree's items out CONTIGUOUSLY in one
 * Int32Array, in depth-first order, so a node's whole subtree is the run
 * `packed[start .. start + total)`. Two things follow, and together they are
 * where the order-of-magnitude comes from:
 *
 *   - a node classified INSIDE emits its entire subtree as one tight copy
 *     loop, touching no node and testing no item;
 *   - descent STOPS at `leafThreshold` items and tests that contiguous run
 *     directly, so the tree is only ever walked while nodes are still earning
 *     their keep.
 *
 * The pack is rebuilt lazily, so a burst of chunk loads costs one repack, not
 * one per instance. Static geometry changes in bursts, which is exactly the
 * shape this trade is tuned for.
 *
 * ── AND WHY THE NODE TEST IS SHAPED THE WAY IT IS ──────────────────────────
 * The other half of the story is the price of a node. A hierarchy only pays
 * off while classifying a node costs less than testing the items it covers, so
 * nodes are stored as CENTRE + HALF-EXTENT and classified by an inlined,
 * branch-free form of `Frustum.classifyCentreExtent` with the planes hoisted
 * into locals. That is deliberate asymmetry: the per-item predicate stays the
 * shared `Frustum.testPacked` that the brute-force reference also calls, so the
 * comparison between them measures the algorithm; the node test has no
 * counterpart in a linear scan, so it is optimised freely. Measured on 10,000
 * instances the sequence — loose placement, packed runs, centre/extent nodes,
 * inlined classification — moved the shipping-lens speedup from 6x to 22-25x.
 */

import {
  QUADTREE_DEPTH,
  QUADTREE_LEVEL_OFFSET,
  QUADTREE_NODE_COUNT,
  QUADTREE_CHUNK_DEPTH,
  WORLD_MIN,
  WORLD_SIZE,
  CHUNK_GRID,
} from './constants';
import { packedIntersectsBox, packedInsideBox, packedRayEntry, packedDistanceSq2D } from './aabb';
import { Frustum, ALL_PLANES, OUTSIDE, INSIDE } from './frustum';
import { IndexList, FloatList } from './index-list';

/** Construction parameters. Defaults describe City Z exactly. */
export interface IQuadtreeOptions {
  /** West edge in metres. */
  readonly originX?: number;
  /** North edge in metres. */
  readonly originZ?: number;
  /** Edge length of the root cell in metres. */
  readonly size?: number;
  /** Subdivision levels below the root. */
  readonly depth?: number;
  /** Item slots pre-allocated. Grows geometrically past this. */
  readonly initialCapacity?: number;
  /**
   * Stop descending once a subtree holds this many items or fewer, and test the
   * run directly.
   *
   * Measured on 10,000 instances, interleaved against the brute-force scan:
   * threshold 4 tests only 107 items per cull but visits 152 nodes (19x), 32
   * visits 74 and tests 221 (25x), 64 visits 41 and tests 370 (23x). The
   * optimum sits where a node classification and an item test cost about the
   * same, which after inlining the node test lands at 24-48 for a narrow phone
   * lens and 16-32 for a wide long-range one. 32 serves both.
   */
  readonly leafThreshold?: number;
  /**
   * Loose-cell factor. An item descends while its footprint fits inside
   * `looseFactor x childCellSize`; 1 is a strict quadtree, 2 is the classic
   * loose quadtree. See the placement note in the file header — this single
   * number is worth more than every micro-optimisation in the walk.
   */
  readonly looseFactor?: number;
}

/** One raycast result. Reused across calls; never allocated per hit. */
export interface IQuadtreeRayHit {
  /** Item handle, or -1 when nothing was hit. */
  handle: number;
  /** Metres along the ray to the box entry point. */
  distance: number;
}

/** Instrumentation for one `cullFrustum` call. */
export interface ICullStats {
  /** Nodes popped off the traversal stack. */
  nodesVisited: number;
  /** Subtrees discarded by a single OUTSIDE test. */
  nodesRejected: number;
  /** Subtrees accepted wholesale by a single INSIDE test. */
  nodesAccepted: number;
  /** Subtrees discarded because the PVS said their chunk is not visible. */
  chunksRejectedByPvs: number;
  /** Items that had to be tested individually against the planes. */
  itemsTested: number;
  /** Items emitted. */
  itemsVisible: number;
}

/** Fresh zeroed stats block. */
export function createCullStats(): ICullStats {
  return {
    nodesVisited: 0,
    nodesRejected: 0,
    nodesAccepted: 0,
    chunksRejectedByPvs: 0,
    itemsTested: 0,
    itemsVisible: 0,
  };
}

/** Publish the walk's local counters. Kept out of the loop deliberately. */
function writeCullStats(
  stats: ICullStats,
  visited: number,
  rejected: number,
  accepted: number,
  pvsRejected: number,
  tested: number,
  visible: number
): void {
  stats.nodesVisited = visited;
  stats.nodesRejected = rejected;
  stats.nodesAccepted = accepted;
  stats.chunksRejectedByPvs = pvsRejected;
  stats.itemsTested = tested;
  stats.itemsVisible = visible;
}

/**
 * Minimal read side of a PVS, so the quadtree does not depend on the builder.
 * `pvs.ts` implements it.
 */
export interface IChunkVisibility {
  /** True when chunk `to` may be visible from chunk `from`. */
  isVisible(from: number, to: number): boolean;
}

export class Quadtree {
  readonly originX: number;
  readonly originZ: number;
  readonly size: number;
  readonly depth: number;
  readonly nodeCount: number;
  readonly leafThreshold: number;
  readonly looseFactor: number;
  /** True when the tree spans the canonical world, so chunk indices are real. */
  readonly canonical: boolean;

  /* ---- node arrays (fixed size, allocated once) ---- */
  /** minX minY minZ maxX maxY maxZ per node — the union of the subtree. */
  private readonly nodeBounds: Float32Array;
  /** Items in the whole subtree; skips empty branches instantly. */
  private readonly nodeTotal: Int32Array;
  /** Index of child (0,0), or -1 at the deepest level. */
  private readonly nodeChild0: Int32Array;
  /** Row stride between child (x,0) and child (x,1). */
  private readonly nodeChildStride: Int32Array;
  private readonly nodeDepth: Uint8Array;
  /** Dense chunk index for depth-`QUADTREE_CHUNK_DEPTH` nodes, else -1. */
  private readonly nodeChunk: Int32Array;
  /** Items owned directly by a node. Allocated lazily, only where non-empty. */
  private readonly nodeItems: (number[] | undefined)[];
  /**
   * Node bounds as `cx cy cz ex ey ez` — centre and half-extent, derived from
   * the min/max content bounds with a safety inflation. The frustum walk
   * classifies nodes against these; see `Frustum.classifyCentreExtent`.
   */
  private readonly nodeCentreExtent: Float32Array;
  /** Offset of this subtree's run in `packed`. */
  private readonly packStart: Int32Array;
  /** Items owned by this node itself; they lead the node's packed run. */
  private readonly nodeOwnCount: Int32Array;

  /* ---- item arrays (grow geometrically) ---- */
  private itemBounds: Float32Array;
  private itemNode: Int32Array;
  /** Position of the item within `nodeItems[node]`, for O(1) swap-removal. */
  private itemSlot: Int32Array;
  /** Dense chunk index of the item centre, or -1 outside the world. */
  private itemChunk: Int32Array;
  private itemRefs: (unknown | undefined)[];
  private itemAlive: Uint8Array;
  private capacity: number;
  private highWater = 0;
  private readonly freeSlots: number[] = [];
  private liveCount = 0;

  /** Depth-first item order; subtree runs are contiguous. */
  private packed: Int32Array;
  /**
   * Item bounds in `packed` order.
   *
   * Duplicating 24 bytes per item buys the sweep loops a strictly sequential
   * read instead of a random gather across a 240 KB buffer. On 10,000
   * instances that gather was costing more than the plane arithmetic it fed.
   */
  private packedBounds: Float32Array;

  private boundsDirty = false;
  private packDirty = false;

  /* ---- scratch (never allocated during a query) ---- */
  private readonly pathScratch = new Int32Array(QUADTREE_DEPTH + 2);
  private pathLength = 0;
  /** Frustum walk stack: interleaved (node, mask). */
  private readonly cullStack: Int32Array;
  /** Stack for box / radius / ray walks. */
  private readonly walkStack: Int32Array;
  /** The four child indices of the node currently being expanded. */
  private readonly childScratch = new Int32Array(4);
  private readonly internalStats = createCullStats();

  constructor(options: IQuadtreeOptions = {}) {
    this.originX = options.originX ?? WORLD_MIN;
    this.originZ = options.originZ ?? WORLD_MIN;
    this.size = options.size ?? WORLD_SIZE;
    this.depth = options.depth ?? QUADTREE_DEPTH;
    this.leafThreshold = Math.max(1, options.leafThreshold ?? 32);
    this.looseFactor = Math.max(1, options.looseFactor ?? 2);

    if (this.depth < 0 || this.depth > 10) {
      throw new Error(`Quadtree: depth ${this.depth} out of range 0..10`);
    }

    this.canonical =
      this.originX === WORLD_MIN &&
      this.originZ === WORLD_MIN &&
      this.size === WORLD_SIZE &&
      this.depth >= QUADTREE_CHUNK_DEPTH;

    this.nodeCount =
      this.depth === QUADTREE_DEPTH ? QUADTREE_NODE_COUNT : ((1 << (2 * (this.depth + 1))) - 1) / 3;

    this.nodeBounds = new Float32Array(this.nodeCount * 6);
    this.nodeTotal = new Int32Array(this.nodeCount);
    this.nodeChild0 = new Int32Array(this.nodeCount);
    this.nodeChildStride = new Int32Array(this.nodeCount);
    this.nodeDepth = new Uint8Array(this.nodeCount);
    this.nodeChunk = new Int32Array(this.nodeCount).fill(-1);
    this.nodeItems = new Array<number[] | undefined>(this.nodeCount);
    this.nodeCentreExtent = new Float32Array(this.nodeCount * 6);
    this.packStart = new Int32Array(this.nodeCount);
    this.nodeOwnCount = new Int32Array(this.nodeCount);

    // A depth-first walk of a 4-ary tree holds at most 3 siblings per level.
    this.cullStack = new Int32Array((3 * (this.depth + 1) + 4) * 2);
    this.walkStack = new Int32Array(3 * (this.depth + 1) + 4);

    this.buildTopology();
    this.clearNodeBounds();

    this.capacity = Math.max(16, options.initialCapacity ?? 1024);
    this.itemBounds = new Float32Array(this.capacity * 6);
    this.itemNode = new Int32Array(this.capacity);
    this.itemSlot = new Int32Array(this.capacity);
    this.itemChunk = new Int32Array(this.capacity);
    this.itemAlive = new Uint8Array(this.capacity);
    this.itemRefs = new Array<unknown>(this.capacity);
    this.packed = new Int32Array(this.capacity);
    this.packedBounds = new Float32Array(this.capacity * 6);
  }

  /* ------------------------------------------------------------------ */
  /* Topology                                                           */
  /* ------------------------------------------------------------------ */

  private levelOffset(d: number): number {
    return this.depth === QUADTREE_DEPTH ? QUADTREE_LEVEL_OFFSET[d]! : ((1 << (2 * d)) - 1) / 3;
  }

  private buildTopology(): void {
    for (let d = 0; d <= this.depth; d++) {
      const dim = 1 << d;
      const base = this.levelOffset(d);
      const childBase = d < this.depth ? this.levelOffset(d + 1) : -1;
      const childDim = dim * 2;

      for (let cz = 0; cz < dim; cz++) {
        for (let cx = 0; cx < dim; cx++) {
          const n = base + cz * dim + cx;
          this.nodeDepth[n] = d;
          if (childBase >= 0) {
            this.nodeChild0[n] = childBase + cz * 2 * childDim + cx * 2;
            this.nodeChildStride[n] = childDim;
          } else {
            this.nodeChild0[n] = -1;
            this.nodeChildStride[n] = 0;
          }
          // Depth-4 cells are 96 m when the tree spans the canonical world, so
          // they coincide with streaming chunks and carry a PVS bit index.
          if (this.canonical && d === QUADTREE_CHUNK_DEPTH && dim === CHUNK_GRID) {
            this.nodeChunk[n] = cz * CHUNK_GRID + cx;
          }
        }
      }
    }
  }

  private clearNodeBounds(): void {
    const b = this.nodeBounds;
    for (let n = 0; n < this.nodeCount; n++) {
      const o = n * 6;
      b[o] = Infinity;
      b[o + 1] = Infinity;
      b[o + 2] = Infinity;
      b[o + 3] = -Infinity;
      b[o + 4] = -Infinity;
      b[o + 5] = -Infinity;
    }
    this.nodeTotal.fill(0);
  }

  /* ------------------------------------------------------------------ */
  /* Capacity                                                           */
  /* ------------------------------------------------------------------ */

  /** Live items. */
  get count(): number {
    return this.liveCount;
  }

  /** Highest handle ever issued + 1. Handles below this may be dead. */
  get handleWatermark(): number {
    return this.highWater;
  }

  /** True when `handle` refers to a live item. */
  isAlive(handle: number): boolean {
    return handle >= 0 && handle < this.highWater && this.itemAlive[handle] === 1;
  }

  private ensureCapacity(n: number): void {
    if (n < this.capacity) return;
    let next = this.capacity * 2;
    while (next <= n) next *= 2;

    const bounds = new Float32Array(next * 6);
    bounds.set(this.itemBounds);
    this.itemBounds = bounds;

    const node = new Int32Array(next);
    node.set(this.itemNode);
    this.itemNode = node;

    const slot = new Int32Array(next);
    slot.set(this.itemSlot);
    this.itemSlot = slot;

    const chunk = new Int32Array(next);
    chunk.set(this.itemChunk);
    this.itemChunk = chunk;

    const alive = new Uint8Array(next);
    alive.set(this.itemAlive);
    this.itemAlive = alive;

    this.packed = new Int32Array(next);
    this.packedBounds = new Float32Array(next * 6);
    this.itemRefs.length = next;
    this.capacity = next;
  }

  /* ------------------------------------------------------------------ */
  /* Insert / remove                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Add a static AABB.
   *
   * The bounds are stored as float32 and then READ BACK before the descent is
   * computed. Locating with the rounded values — not the float64 inputs — is
   * what guarantees `remove` retraces exactly the same path, even when rounding
   * nudges a coordinate across a cell boundary.
   *
   * @returns A stable handle for `remove`, `getBounds` and query results.
   */
  insert(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    ref?: unknown
  ): number {
    let handle = this.freeSlots.pop();
    if (handle === undefined) {
      handle = this.highWater++;
      this.ensureCapacity(handle);
    }

    const o = handle * 6;
    const b = this.itemBounds;
    b[o] = minX;
    b[o + 1] = minY;
    b[o + 2] = minZ;
    b[o + 3] = maxX;
    b[o + 4] = maxY;
    b[o + 5] = maxZ;

    const fMinX = b[o]!;
    const fMinY = b[o + 1]!;
    const fMinZ = b[o + 2]!;
    const fMaxX = b[o + 3]!;
    const fMaxY = b[o + 4]!;
    const fMaxZ = b[o + 5]!;

    this.itemRefs[handle] = ref;
    this.itemAlive[handle] = 1;
    this.itemChunk[handle] = this.chunkOfCentre(fMinX, fMinZ, fMaxX, fMaxZ);

    const node = this.locate(fMinX, fMinZ, fMaxX, fMaxZ);

    let bucket = this.nodeItems[node];
    if (bucket === undefined) {
      bucket = [];
      this.nodeItems[node] = bucket;
    }
    this.itemSlot[handle] = bucket.length;
    this.itemNode[handle] = node;
    bucket.push(handle);

    // Expand the union along the path root -> node.
    const nb = this.nodeBounds;
    for (let i = 0; i < this.pathLength; i++) {
      const n = this.pathScratch[i]!;
      const no = n * 6;
      if (fMinX < nb[no]!) nb[no] = fMinX;
      if (fMinY < nb[no + 1]!) nb[no + 1] = fMinY;
      if (fMinZ < nb[no + 2]!) nb[no + 2] = fMinZ;
      if (fMaxX > nb[no + 3]!) nb[no + 3] = fMaxX;
      if (fMaxY > nb[no + 4]!) nb[no + 4] = fMaxY;
      if (fMaxZ > nb[no + 5]!) nb[no + 5] = fMaxZ;
      this.nodeTotal[n] = this.nodeTotal[n]! + 1;
    }

    this.liveCount++;
    this.packDirty = true;
    return handle;
  }

  /** Remove by handle. Silently ignores a stale or already-freed handle. */
  remove(handle: number): boolean {
    if (!this.isAlive(handle)) return false;

    const o = handle * 6;
    const b = this.itemBounds;
    const node = this.itemNode[handle]!;

    const bucket = this.nodeItems[node];
    if (bucket !== undefined) {
      const slot = this.itemSlot[handle]!;
      const last = bucket.pop()!;
      if (slot < bucket.length) {
        bucket[slot] = last;
        this.itemSlot[last] = slot;
      }
    }

    // Retrace the descent to decrement subtree counts.
    this.locate(b[o]!, b[o + 2]!, b[o + 3]!, b[o + 5]!);
    for (let i = 0; i < this.pathLength; i++) {
      const n = this.pathScratch[i]!;
      this.nodeTotal[n] = this.nodeTotal[n]! - 1;
    }

    this.itemAlive[handle] = 0;
    this.itemRefs[handle] = undefined;
    this.freeSlots.push(handle);
    this.liveCount--;

    // The union along the path may now be too large. Correct lazily: static
    // geometry is removed in bursts (a building collapses, a chunk unloads), so
    // one refit after the burst beats shrinking six floats per ancestor per
    // removal.
    this.boundsDirty = true;
    this.packDirty = true;
    return true;
  }

  /** Drop every item; keeps the allocated arrays. */
  clear(): void {
    for (let n = 0; n < this.nodeCount; n++) {
      const bucket = this.nodeItems[n];
      if (bucket !== undefined) bucket.length = 0;
    }
    this.clearNodeBounds();
    this.itemAlive.fill(0);
    this.itemRefs.length = 0;
    this.itemRefs.length = this.capacity;
    this.freeSlots.length = 0;
    this.highWater = 0;
    this.liveCount = 0;
    this.boundsDirty = false;
    this.packDirty = true;
  }

  /**
   * Recompute every node's union bottom-up, tightening bounds loosened by
   * removals. 5461 nodes; costs microseconds.
   */
  refit(): void {
    const nb = this.nodeBounds;
    const ib = this.itemBounds;

    for (let d = this.depth; d >= 0; d--) {
      const dim = 1 << d;
      const base = this.levelOffset(d);
      const end = base + dim * dim;

      for (let n = base; n < end; n++) {
        const no = n * 6;
        let minX = Infinity;
        let minY = Infinity;
        let minZ = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        let maxZ = -Infinity;
        let total = 0;

        const bucket = this.nodeItems[n];
        if (bucket !== undefined) {
          for (let i = 0; i < bucket.length; i++) {
            const io = bucket[i]! * 6;
            if (ib[io]! < minX) minX = ib[io]!;
            if (ib[io + 1]! < minY) minY = ib[io + 1]!;
            if (ib[io + 2]! < minZ) minZ = ib[io + 2]!;
            if (ib[io + 3]! > maxX) maxX = ib[io + 3]!;
            if (ib[io + 4]! > maxY) maxY = ib[io + 4]!;
            if (ib[io + 5]! > maxZ) maxZ = ib[io + 5]!;
            total++;
          }
        }

        const c0 = this.nodeChild0[n]!;
        if (c0 >= 0) {
          const stride = this.nodeChildStride[n]!;
          for (let k = 0; k < 4; k++) {
            const c = k < 2 ? c0 + k : c0 + stride + (k - 2);
            if (this.nodeTotal[c] === 0) continue;
            const co = c * 6;
            if (nb[co]! < minX) minX = nb[co]!;
            if (nb[co + 1]! < minY) minY = nb[co + 1]!;
            if (nb[co + 2]! < minZ) minZ = nb[co + 2]!;
            if (nb[co + 3]! > maxX) maxX = nb[co + 3]!;
            if (nb[co + 4]! > maxY) maxY = nb[co + 4]!;
            if (nb[co + 5]! > maxZ) maxZ = nb[co + 5]!;
            total += this.nodeTotal[c]!;
          }
        }

        nb[no] = minX;
        nb[no + 1] = minY;
        nb[no + 2] = minZ;
        nb[no + 3] = maxX;
        nb[no + 4] = maxY;
        nb[no + 5] = maxZ;
        this.nodeTotal[n] = total;
      }
    }

    this.boundsDirty = false;
  }

  /**
   * Rewrite the depth-first item order so every subtree is one contiguous run.
   * Called automatically before any query that needs it; call it directly after
   * a batch of chunk loads to move the cost out of the render frame.
   */
  pack(): void {
    if (this.packed.length < this.liveCount) {
      this.packed = new Int32Array(Math.max(this.liveCount, this.capacity));
    }
    if (this.packedBounds.length < this.liveCount * 6) {
      this.packedBounds = new Float32Array(Math.max(this.liveCount, this.capacity) * 6);
    }
    this.packNode(0, 0);
    this.updateNodeExtents();
    this.packDirty = false;
  }

  /**
   * Recompute every node's centre/half-extent form from its min/max bounds.
   *
   * The extent is inflated by `EXTENT_SCALE` and `EXTENT_EPSILON` so the
   * classified box strictly encloses the node's real content by about a
   * centimetre — two orders of magnitude above the float32 ulp at world scale
   * (1.2e-4 m at 1536 m). Without that margin a node's centre/extent box could
   * round to marginally SMALLER than the items inside it, and a subtree could
   * be rejected while one of its buildings was genuinely on screen.
   */
  private updateNodeExtents(): void {
    const nb = this.nodeBounds;
    const ce = this.nodeCentreExtent;
    for (let n = 0; n < this.nodeCount; n++) {
      const o = n * 6;
      if (this.nodeTotal[n] === 0) {
        ce[o] = 0;
        ce[o + 1] = 0;
        ce[o + 2] = 0;
        ce[o + 3] = -1;
        ce[o + 4] = -1;
        ce[o + 5] = -1;
        continue;
      }
      const minX = nb[o]!;
      const minY = nb[o + 1]!;
      const minZ = nb[o + 2]!;
      const maxX = nb[o + 3]!;
      const maxY = nb[o + 4]!;
      const maxZ = nb[o + 5]!;
      ce[o] = (minX + maxX) * 0.5;
      ce[o + 1] = (minY + maxY) * 0.5;
      ce[o + 2] = (minZ + maxZ) * 0.5;
      ce[o + 3] = (maxX - minX) * 0.5 * EXTENT_SCALE + EXTENT_EPSILON;
      ce[o + 4] = (maxY - minY) * 0.5 * EXTENT_SCALE + EXTENT_EPSILON;
      ce[o + 5] = (maxZ - minZ) * 0.5 * EXTENT_SCALE + EXTENT_EPSILON;
    }
  }

  /** Depth 7 at most, so recursion is the clearest correct expression here. */
  private packNode(node: number, cursor: number): number {
    this.packStart[node] = cursor;
    if (this.nodeTotal[node] === 0) {
      this.nodeOwnCount[node] = 0;
      return cursor;
    }

    const bucket = this.nodeItems[node];
    const own = bucket === undefined ? 0 : bucket.length;
    this.nodeOwnCount[node] = own;
    const ib = this.itemBounds;
    const pb = this.packedBounds;
    for (let i = 0; i < own; i++) {
      const h = bucket![i]!;
      this.packed[cursor] = h;
      const src = h * 6;
      const dst = cursor * 6;
      pb[dst] = ib[src]!;
      pb[dst + 1] = ib[src + 1]!;
      pb[dst + 2] = ib[src + 2]!;
      pb[dst + 3] = ib[src + 3]!;
      pb[dst + 4] = ib[src + 4]!;
      pb[dst + 5] = ib[src + 5]!;
      cursor++;
    }

    const c0 = this.nodeChild0[node]!;
    if (c0 >= 0) {
      const stride = this.nodeChildStride[node]!;
      cursor = this.packNode(c0, cursor);
      cursor = this.packNode(c0 + 1, cursor);
      cursor = this.packNode(c0 + stride, cursor);
      cursor = this.packNode(c0 + stride + 1, cursor);
    }
    return cursor;
  }

  /** Run any pending refit / repack. */
  private sync(): void {
    if (this.boundsDirty) this.refit();
    if (this.packDirty) this.pack();
  }

  /**
   * Deepest loose cell the item belongs to. Fills `pathScratch` /
   * `pathLength` with the root-to-node path as a side effect, which is how
   * insert and remove keep subtree counts in step.
   *
   * Depends only on the stored float32 bounds, so `remove` retraces exactly
   * the path `insert` took.
   */
  private locate(minX: number, minZ: number, maxX: number, maxZ: number): number {
    const path = this.pathScratch;
    let node = 0;
    path[0] = 0;
    let len = 1;

    const centreX = (minX + maxX) * 0.5;
    const centreZ = (minZ + maxZ) * 0.5;
    const spanX = maxX - minX;
    const spanZ = maxZ - minZ;
    const extent = spanX > spanZ ? spanX : spanZ;

    for (let d = 0; d < this.depth; d++) {
      const childDim = 1 << (d + 1);
      const childCell = this.size / childDim;
      // Loose rule: the item must fit in a cell scaled by `looseFactor`, and it
      // is placed by its centre rather than by containment.
      if (extent > this.looseFactor * childCell) break;

      const inv = childDim / this.size;
      const gx = Math.floor((centreX - this.originX) * inv);
      const gz = Math.floor((centreZ - this.originZ) * inv);
      // Outside the root cell: park it at the current node, which keeps the
      // item queryable instead of dropping it.
      if (gx < 0 || gx >= childDim || gz < 0 || gz >= childDim) break;

      node = this.levelOffset(d + 1) + gz * childDim + gx;
      path[len++] = node;
    }

    this.pathLength = len;
    return node;
  }

  private chunkOfCentre(minX: number, minZ: number, maxX: number, maxZ: number): number {
    if (!this.canonical) return -1;
    const cell = this.size / CHUNK_GRID;
    const cx = Math.floor(((minX + maxX) * 0.5 - this.originX) / cell);
    const cz = Math.floor(((minZ + maxZ) * 0.5 - this.originZ) / cell);
    if (cx < 0 || cx >= CHUNK_GRID || cz < 0 || cz >= CHUNK_GRID) return -1;
    return cz * CHUNK_GRID + cx;
  }

  /* ------------------------------------------------------------------ */
  /* Accessors                                                          */
  /* ------------------------------------------------------------------ */

  /** Payload handed to `insert`. */
  getRef(handle: number): unknown {
    return this.itemRefs[handle];
  }

  /** Dense chunk index containing the item's centre, or -1. */
  getChunk(handle: number): number {
    return this.itemChunk[handle]!;
  }

  /** Copy an item's stored (float32) bounds into `target`. */
  getBounds(handle: number, target: number[] | Float32Array | Float64Array): void {
    const o = handle * 6;
    for (let i = 0; i < 6; i++) target[i] = this.itemBounds[o + i]!;
  }

  /** Raw item bounds. Read-only in spirit; exposed for benchmarks. */
  get boundsArray(): Float32Array {
    return this.itemBounds;
  }

  /** Copy a node's content bounds. Debug and harness use. */
  getNodeBounds(node: number, target: number[] | Float32Array | Float64Array): void {
    this.sync();
    const o = node * 6;
    for (let i = 0; i < 6; i++) target[i] = this.nodeBounds[o + i]!;
  }

  /** Items in a node's whole subtree. */
  getNodeTotal(node: number): number {
    this.sync();
    return this.nodeTotal[node]!;
  }

  /** Depth of a node. */
  getNodeDepth(node: number): number {
    return this.nodeDepth[node]!;
  }

  /** Cell bounds (not content bounds) of a node, as `[minX, minZ, size]`. */
  getNodeCell(node: number, target: number[] | Float64Array): void {
    const d = this.nodeDepth[node]!;
    const dim = 1 << d;
    const local = node - this.levelOffset(d);
    const cellSize = this.size / dim;
    target[0] = this.originX + (local % dim) * cellSize;
    target[1] = this.originZ + Math.floor(local / dim) * cellSize;
    target[2] = cellSize;
  }

  /** First node index at `depth`, for level-order iteration in the harness. */
  levelStart(d: number): number {
    return this.levelOffset(d);
  }

  /** One past the last node at `depth`. */
  levelEnd(d: number): number {
    const dim = 1 << d;
    return this.levelOffset(d) + dim * dim;
  }

  /**
   * Node whose cell IS the given streaming chunk, or -1 when this tree does not
   * span the canonical world. The depth-4 level is stored in the same
   * `cz * 16 + cx` order the chunk index uses, so this is one addition.
   */
  chunkNode(chunk: number): number {
    if (!this.canonical || chunk < 0 || chunk >= CHUNK_GRID * CHUNK_GRID) return -1;
    return this.levelOffset(QUADTREE_CHUNK_DEPTH) + chunk;
  }

  /* ------------------------------------------------------------------ */
  /* Hierarchical frustum culling                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Collect every item whose stored AABB passes the frustum test.
   *
   * Guaranteed to return EXACTLY the set `bruteForceCull` returns — see the
   * proof in `frustum.ts`.
   *
   * @param visibility Optional PVS. With `viewChunk >= 0`, a depth-4 node whose
   *   chunk bit is clear is discarded before any plane test.
   * @param viewChunk Dense index of the chunk the camera occupies, or -1.
   */
  cullFrustum(
    frustum: Frustum,
    out: IndexList,
    stats?: ICullStats,
    visibility?: IChunkVisibility,
    viewChunk = -1
  ): number {
    this.sync();
    const s = stats ?? this.internalStats;
    out.clear();

    // Every array and counter is hoisted into a local for the duration of the
    // walk. `this.nodeTotal[c]` inside the loop is two loads and a bounds check
    // per access and the walk makes a dozen per node, so hoisting was worth
    // about half the node cost on the benchmark.
    const usePvs = visibility !== undefined && viewChunk >= 0;
    const nce = this.nodeCentreExtent;
    const nb = this.nodeBounds;
    const pb = this.packedBounds;
    const packed = this.packed;
    const nodeTotal = this.nodeTotal;
    const nodeChild0 = this.nodeChild0;
    const nodeChildStride = this.nodeChildStride;
    const nodeChunk = this.nodeChunk;
    const packStart = this.packStart;
    const nodeOwnCount = this.nodeOwnCount;
    const threshold = this.leafThreshold;
    const chunkCell = this.size / CHUNK_GRID;
    const originX = this.originX;
    const originZ = this.originZ;
    const stack = this.cullStack;
    const kids = this.childScratch;

    // Plane data hoisted into locals so the inlined child classification below
    // touches no typed array at all. Six planes x (normal, offset, |normal|).
    const pl = frustum.planes;
    const pa = frustum.planesAbs;
    const q0x = pl[0]!, q0y = pl[1]!, q0z = pl[2]!, q0w = pl[3]!;
    const q1x = pl[4]!, q1y = pl[5]!, q1z = pl[6]!, q1w = pl[7]!;
    const q2x = pl[8]!, q2y = pl[9]!, q2z = pl[10]!, q2w = pl[11]!;
    const q3x = pl[12]!, q3y = pl[13]!, q3z = pl[14]!, q3w = pl[15]!;
    const q4x = pl[16]!, q4y = pl[17]!, q4z = pl[18]!, q4w = pl[19]!;
    const q5x = pl[20]!, q5y = pl[21]!, q5z = pl[22]!, q5w = pl[23]!;
    const a0x = pa[0]!, a0y = pa[1]!, a0z = pa[2]!;
    const a1x = pa[3]!, a1y = pa[4]!, a1z = pa[5]!;
    const a2x = pa[6]!, a2y = pa[7]!, a2z = pa[8]!;
    const a3x = pa[9]!, a3y = pa[10]!, a3z = pa[11]!;
    const a4x = pa[12]!, a4y = pa[13]!, a4z = pa[14]!;
    const a5x = pa[15]!, a5y = pa[16]!, a5z = pa[17]!;

    // Seeded to 1 for the root, which is classified below rather than in the
    // loop; the loop counts only the children it expands.
    let visited = 1;
    let rejected = 0;
    let accepted = 0;
    let pvsRejected = 0;
    let tested = 0;
    let visible = 0;
    let sp = 0;

    /* ---------------------------- root -------------------------------- */
    // The root is dispatched here rather than through the loop because the
    // loop below is specialised: it only ever pops nodes already known to be
    // internal AND straddling, which is what lets it skip a classification and
    // a stack round trip for every child it can settle on the spot.
    const rootTotal = nodeTotal[0]!;
    if (rootTotal === 0) {
      writeCullStats(s, 0, 0, 0, 0, 0, 0);
      return 0;
    }

    const rootClass = frustum.classifyCentreExtent(nce, 0, ALL_PLANES);
    const rootCode = rootClass & 3;
    if (rootCode === OUTSIDE) {
      writeCullStats(s, 1, 1, 0, 0, 0, 0);
      return 0;
    }
    if (rootCode === INSIDE) {
      out.pushRange(packed, packStart[0]!, rootTotal);
      writeCullStats(s, 1, 0, 1, 0, 0, rootTotal);
      return out.length;
    }
    const rootMask = rootClass >>> 2;
    if (rootTotal <= threshold || nodeChild0[0]! < 0) {
      const start = packStart[0]!;
      for (let i = start; i < start + rootTotal; i++) {
        if (frustum.testPacked(pb, i * 6, rootMask)) {
          out.push(packed[i]!);
          visible++;
        }
      }
      writeCullStats(s, 1, 0, 0, 0, rootTotal, visible);
      return out.length;
    }
    stack[sp++] = 0;
    stack[sp++] = rootMask;

    /* --------------------------- descent ------------------------------ */
    while (sp > 0) {
      const mask = stack[--sp]!;
      const node = stack[--sp]!;

      // Items the node owns itself lead its packed run.
      const own = nodeOwnCount[node]!;
      if (own > 0) {
        const start = packStart[node]!;
        tested += own;
        for (let i = start; i < start + own; i++) {
          if (frustum.testPacked(pb, i * 6, mask)) {
            out.push(packed[i]!);
            visible++;
          }
        }
      }

      const c0 = nodeChild0[node]!;
      const stride = nodeChildStride[node]!;
      kids[0] = c0;
      kids[1] = c0 + 1;
      kids[2] = c0 + stride;
      kids[3] = kids[2]! + 1;

      for (let k = 0; k < 4; k++) {
        const child = kids[k]!;
        const total = nodeTotal[child]!;
        if (total === 0) continue;
        visited++;

        const co = child * 6;

        if (usePvs) {
          const chunk = nodeChunk[child]!;
          if (chunk >= 0 && !visibility.isVisible(viewChunk, chunk)) {
            // Loose placement lets a subtree's contents overhang its own cell,
            // and a PVS bit only speaks for the chunk's own footprint. Reject
            // on the bit ONLY when everything below really does live inside the
            // chunk; otherwise fall through and let the frustum decide. Without
            // this guard an awning over a street corner would vanish whenever
            // the chunk it is centred in happened to be occluded.
            const cellMinX = originX + (chunk % CHUNK_GRID) * chunkCell;
            const cellMinZ = originZ + Math.floor(chunk / CHUNK_GRID) * chunkCell;
            if (
              nb[co]! >= cellMinX &&
              nb[co + 3]! <= cellMinX + chunkCell &&
              nb[co + 2]! >= cellMinZ &&
              nb[co + 5]! <= cellMinZ + chunkCell
            ) {
              pvsRejected++;
              continue;
            }
          }
        }

        // Inlined `Frustum.classifyCentreExtent`: same arithmetic, but with the
        // planes already in locals it reads nothing but the six centre/extent
        // floats. Node classification is the hierarchy's own overhead — the
        // linear scan it is measured against has no equivalent — so this is the
        // one place where unrolling genuinely buys the algorithm something.
        const cx = nce[co]!;
        const cy = nce[co + 1]!;
        const cz = nce[co + 2]!;
        const ex = nce[co + 3]!;
        const ey = nce[co + 4]!;
        const ez = nce[co + 5]!;
        let childMask = mask;
        let outside = false;

        classify: {
          if ((childMask & 1) !== 0) {
            const dc = q0x * cx + q0y * cy + q0z * cz + q0w;
            const r = a0x * ex + a0y * ey + a0z * ez;
            if (dc + r < 0) {
              outside = true;
              break classify;
            }
            if (dc - r >= 0) childMask &= ~1;
          }
          if ((childMask & 2) !== 0) {
            const dc = q1x * cx + q1y * cy + q1z * cz + q1w;
            const r = a1x * ex + a1y * ey + a1z * ez;
            if (dc + r < 0) {
              outside = true;
              break classify;
            }
            if (dc - r >= 0) childMask &= ~2;
          }
          if ((childMask & 4) !== 0) {
            const dc = q2x * cx + q2y * cy + q2z * cz + q2w;
            const r = a2x * ex + a2y * ey + a2z * ez;
            if (dc + r < 0) {
              outside = true;
              break classify;
            }
            if (dc - r >= 0) childMask &= ~4;
          }
          if ((childMask & 8) !== 0) {
            const dc = q3x * cx + q3y * cy + q3z * cz + q3w;
            const r = a3x * ex + a3y * ey + a3z * ez;
            if (dc + r < 0) {
              outside = true;
              break classify;
            }
            if (dc - r >= 0) childMask &= ~8;
          }
          if ((childMask & 16) !== 0) {
            const dc = q4x * cx + q4y * cy + q4z * cz + q4w;
            const r = a4x * ex + a4y * ey + a4z * ez;
            if (dc + r < 0) {
              outside = true;
              break classify;
            }
            if (dc - r >= 0) childMask &= ~16;
          }
          if ((childMask & 32) !== 0) {
            const dc = q5x * cx + q5y * cy + q5z * cz + q5w;
            const r = a5x * ex + a5y * ey + a5z * ez;
            if (dc + r < 0) {
              outside = true;
              break classify;
            }
            if (dc - r >= 0) childMask &= ~32;
          }
        }

        if (outside) {
          rejected++;
          continue;
        }

        const start = packStart[child]!;

        // Whole subtree inside: one contiguous copy, no tests, no descent.
        if (childMask === 0) {
          accepted++;
          visible += total;
          out.pushRange(packed, start, total);
          continue;
        }

        // Small enough that descending costs more than testing: sweep the run.
        if (total <= threshold || nodeChild0[child]! < 0) {
          tested += total;
          for (let i = start; i < start + total; i++) {
            if (frustum.testPacked(pb, i * 6, childMask)) {
              out.push(packed[i]!);
              visible++;
            }
          }
          continue;
        }

        stack[sp++] = child;
        stack[sp++] = childMask;
      }
    }

    writeCullStats(s, visited, rejected, accepted, pvsRejected, tested, visible);
    return out.length;
  }

  /**
   * Linear scan over every live item. The reference the hierarchical culler is
   * verified and benchmarked against — same data, same predicate, no tree, and
   * a strictly sequential sweep of `itemBounds`, which is the fastest a
   * brute-force culler can be.
   */
  bruteForceCull(frustum: Frustum, out: IndexList): number {
    out.clear();
    const ib = this.itemBounds;
    const alive = this.itemAlive;
    const n = this.highWater;
    for (let h = 0; h < n; h++) {
      if (alive[h] === 0) continue;
      if (frustum.testPacked(ib, h * 6)) out.push(h);
    }
    return out.length;
  }

  /* ------------------------------------------------------------------ */
  /* Range queries                                                      */
  /* ------------------------------------------------------------------ */

  /** Items whose AABB overlaps the query box (touching counts). */
  queryBox(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    out: IndexList
  ): number {
    this.sync();
    out.clear();
    if (this.nodeTotal[0] === 0) return 0;

    const nb = this.nodeBounds;
    const pb = this.packedBounds;
    const packed = this.packed;
    const stack = this.walkStack;
    let sp = 0;
    stack[sp++] = 0;

    while (sp > 0) {
      const node = stack[--sp]!;
      const no = node * 6;
      if (!packedIntersectsBox(nb, no, minX, minY, minZ, maxX, maxY, maxZ)) continue;

      const total = this.nodeTotal[node]!;
      const start = this.packStart[node]!;

      // Whole subtree inside the query box: take everything, test nothing.
      if (packedInsideBox(nb, no, minX, minY, minZ, maxX, maxY, maxZ)) {
        out.pushRange(packed, start, total);
        continue;
      }

      const c0 = this.nodeChild0[node]!;
      const leafSweep = total <= this.leafThreshold || c0 < 0;
      const sweep = leafSweep ? total : this.nodeOwnCount[node]!;
      for (let i = start; i < start + sweep; i++) {
        if (packedIntersectsBox(pb, i * 6, minX, minY, minZ, maxX, maxY, maxZ)) out.push(packed[i]!);
      }
      if (leafSweep) continue;

      const stride = this.nodeChildStride[node]!;
      const c1 = c0 + 1;
      const c2 = c0 + stride;
      const c3 = c2 + 1;
      if (this.nodeTotal[c0]! > 0) stack[sp++] = c0;
      if (this.nodeTotal[c1]! > 0) stack[sp++] = c1;
      if (this.nodeTotal[c2]! > 0) stack[sp++] = c2;
      if (this.nodeTotal[c3]! > 0) stack[sp++] = c3;
    }
    return out.length;
  }

  /** Reference implementation of `queryBox`. */
  bruteForceBox(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    out: IndexList
  ): number {
    out.clear();
    for (let h = 0; h < this.highWater; h++) {
      if (this.itemAlive[h] === 0) continue;
      if (packedIntersectsBox(this.itemBounds, h * 6, minX, minY, minZ, maxX, maxY, maxZ)) {
        out.push(h);
      }
    }
    return out.length;
  }

  /**
   * Items whose AABB comes within `radius` of `(x, z)` in the XZ plane.
   * Vertical extent is ignored — the query the AI and destruction systems want
   * ("what is near this point on the ground") is 2D.
   */
  queryRadius2D(x: number, z: number, radius: number, out: IndexList): number {
    this.sync();
    out.clear();
    const r2 = radius * radius;
    if (this.nodeTotal[0] === 0) return 0;

    const nb = this.nodeBounds;
    const pb = this.packedBounds;
    const packed = this.packed;
    const stack = this.walkStack;
    let sp = 0;
    stack[sp++] = 0;

    while (sp > 0) {
      const node = stack[--sp]!;
      if (packedDistanceSq2D(nb, node * 6, x, z) > r2) continue;

      const total = this.nodeTotal[node]!;
      const start = this.packStart[node]!;
      const c0 = this.nodeChild0[node]!;
      const leafSweep = total <= this.leafThreshold || c0 < 0;
      const sweep = leafSweep ? total : this.nodeOwnCount[node]!;

      for (let i = start; i < start + sweep; i++) {
        if (packedDistanceSq2D(pb, i * 6, x, z) <= r2) out.push(packed[i]!);
      }
      if (leafSweep) continue;

      const stride = this.nodeChildStride[node]!;
      const c1 = c0 + 1;
      const c2 = c0 + stride;
      const c3 = c2 + 1;
      if (this.nodeTotal[c0]! > 0) stack[sp++] = c0;
      if (this.nodeTotal[c1]! > 0) stack[sp++] = c1;
      if (this.nodeTotal[c2]! > 0) stack[sp++] = c2;
      if (this.nodeTotal[c3]! > 0) stack[sp++] = c3;
    }
    return out.length;
  }

  /** Reference implementation of `queryRadius2D`. */
  bruteForceRadius2D(x: number, z: number, radius: number, out: IndexList): number {
    out.clear();
    const r2 = radius * radius;
    for (let h = 0; h < this.highWater; h++) {
      if (this.itemAlive[h] === 0) continue;
      if (packedDistanceSq2D(this.itemBounds, h * 6, x, z) <= r2) out.push(h);
    }
    return out.length;
  }

  /* ------------------------------------------------------------------ */
  /* Raycast                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Every item AABB the ray enters within `maxDistance`, unordered.
   * `distances` receives the entry distance for the item at the same index.
   */
  raycastAll(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDistance: number,
    out: IndexList,
    distances?: FloatList
  ): number {
    this.sync();
    out.clear();
    distances?.clear();
    if (this.nodeTotal[0] === 0) return 0;

    const nb = this.nodeBounds;
    const pb = this.packedBounds;
    const packed = this.packed;
    const stack = this.walkStack;
    let sp = 0;
    stack[sp++] = 0;

    while (sp > 0) {
      const node = stack[--sp]!;
      if (packedRayEntry(nb, node * 6, ox, oy, oz, dx, dy, dz, maxDistance) === Infinity) continue;

      const total = this.nodeTotal[node]!;
      const start = this.packStart[node]!;
      const c0 = this.nodeChild0[node]!;
      const leafSweep = total <= this.leafThreshold || c0 < 0;
      const sweep = leafSweep ? total : this.nodeOwnCount[node]!;

      for (let i = start; i < start + sweep; i++) {
        const t = packedRayEntry(pb, i * 6, ox, oy, oz, dx, dy, dz, maxDistance);
        if (t !== Infinity) {
          out.push(packed[i]!);
          distances?.push(t);
        }
      }
      if (leafSweep) continue;

      const stride = this.nodeChildStride[node]!;
      const c1 = c0 + 1;
      const c2 = c0 + stride;
      const c3 = c2 + 1;
      if (this.nodeTotal[c0]! > 0) stack[sp++] = c0;
      if (this.nodeTotal[c1]! > 0) stack[sp++] = c1;
      if (this.nodeTotal[c2]! > 0) stack[sp++] = c2;
      if (this.nodeTotal[c3]! > 0) stack[sp++] = c3;
    }
    return out.length;
  }

  /**
   * Nearest item AABB along the ray.
   *
   * A node box contains its items' boxes, so the ray enters the node no later
   * than anything inside it and `t > best` can never hide a nearer hit. Exact
   * distance ties resolve to the lower handle, matching the ascending
   * brute-force scan.
   */
  raycastFirst(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDistance: number,
    target: IQuadtreeRayHit
  ): boolean {
    this.sync();
    target.handle = -1;
    target.distance = Infinity;
    if (this.nodeTotal[0] === 0) return false;

    const nb = this.nodeBounds;
    const pb = this.packedBounds;
    const packed = this.packed;
    const stack = this.walkStack;
    let sp = 0;
    stack[sp++] = 0;
    let best = Infinity;

    while (sp > 0) {
      const node = stack[--sp]!;
      const t = packedRayEntry(nb, node * 6, ox, oy, oz, dx, dy, dz, maxDistance);
      if (t === Infinity || t > best) continue;

      const total = this.nodeTotal[node]!;
      const start = this.packStart[node]!;
      const c0 = this.nodeChild0[node]!;
      const leafSweep = total <= this.leafThreshold || c0 < 0;
      const sweep = leafSweep ? total : this.nodeOwnCount[node]!;

      for (let i = start; i < start + sweep; i++) {
        const ti = packedRayEntry(pb, i * 6, ox, oy, oz, dx, dy, dz, maxDistance);
        if (ti === Infinity) continue;
        const h = packed[i]!;
        if (ti < best || (ti === best && h < target.handle)) {
          best = ti;
          target.handle = h;
          target.distance = ti;
        }
      }
      if (leafSweep) continue;

      const stride = this.nodeChildStride[node]!;
      const c1 = c0 + 1;
      const c2 = c0 + stride;
      const c3 = c2 + 1;
      if (this.nodeTotal[c0]! > 0) stack[sp++] = c0;
      if (this.nodeTotal[c1]! > 0) stack[sp++] = c1;
      if (this.nodeTotal[c2]! > 0) stack[sp++] = c2;
      if (this.nodeTotal[c3]! > 0) stack[sp++] = c3;
    }

    return target.handle >= 0;
  }

  /** Reference implementation of `raycastAll`. */
  bruteForceRaycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDistance: number,
    out: IndexList,
    distances?: FloatList
  ): number {
    out.clear();
    distances?.clear();
    for (let h = 0; h < this.highWater; h++) {
      if (this.itemAlive[h] === 0) continue;
      const t = packedRayEntry(this.itemBounds, h * 6, ox, oy, oz, dx, dy, dz, maxDistance);
      if (t !== Infinity) {
        out.push(h);
        distances?.push(t);
      }
    }
    return out.length;
  }

  /** Reference implementation of `raycastFirst`. */
  bruteForceRaycastFirst(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDistance: number,
    target: IQuadtreeRayHit
  ): boolean {
    target.handle = -1;
    target.distance = Infinity;
    let best = Infinity;
    for (let h = 0; h < this.highWater; h++) {
      if (this.itemAlive[h] === 0) continue;
      const t = packedRayEntry(this.itemBounds, h * 6, ox, oy, oz, dx, dy, dz, maxDistance);
      if (t === Infinity) continue;
      if (t < best) {
        best = t;
        target.handle = h;
        target.distance = t;
      }
    }
    return target.handle >= 0;
  }

  /* ------------------------------------------------------------------ */
  /* Diagnostics                                                        */
  /* ------------------------------------------------------------------ */

  /** Occupancy summary for the debug HUD and the harness. */
  describe(): {
    items: number;
    nodes: number;
    occupiedNodes: number;
    maxItemsPerNode: number;
    itemsAtDepth: number[];
    bytes: number;
  } {
    this.sync();
    const itemsAtDepth = new Array<number>(this.depth + 1).fill(0);
    let occupied = 0;
    let maxItems = 0;
    for (let n = 0; n < this.nodeCount; n++) {
      const bucket = this.nodeItems[n];
      if (bucket === undefined || bucket.length === 0) continue;
      occupied++;
      if (bucket.length > maxItems) maxItems = bucket.length;
      const d = this.nodeDepth[n]!;
      itemsAtDepth[d] = itemsAtDepth[d]! + bucket.length;
    }
    return {
      items: this.liveCount,
      nodes: this.nodeCount,
      occupiedNodes: occupied,
      maxItemsPerNode: maxItems,
      itemsAtDepth,
      bytes:
        this.nodeBounds.byteLength +
        this.nodeTotal.byteLength +
        this.nodeChild0.byteLength +
        this.nodeChildStride.byteLength +
        this.nodeDepth.byteLength +
        this.nodeChunk.byteLength +
        this.nodeCentreExtent.byteLength +
        this.packStart.byteLength +
        this.nodeOwnCount.byteLength +
        this.itemBounds.byteLength +
        this.itemNode.byteLength +
        this.itemSlot.byteLength +
        this.itemChunk.byteLength +
        this.itemAlive.byteLength +
        this.packed.byteLength +
        this.packedBounds.byteLength,
    };
  }
}

/**
 * Relative and absolute inflation applied to node half-extents. Chosen well
 * above the float32 ulp at world scale and small enough to be invisible
 * against a 24 m cell.
 */
const EXTENT_SCALE = 1 + 1e-4;
const EXTENT_EPSILON = 0.01;
