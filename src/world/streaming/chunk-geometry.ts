/**
 * CHUNK GEOMETRY GENERATION — THE PART THAT RUNS OFF THE MAIN THREAD
 *
 * Turns a deterministic chunk layout into raw attribute buffers. Everything in
 * this file is written to be callable from a Web Worker, which imposes two
 * hard constraints that shape all of it:
 *
 *  1. **No `three`.** Not the renderer, not `BufferGeometry`, not even
 *     `Vector3`. A worker that imports three pulls the entire WebGL renderer
 *     into a second module graph — hundreds of kilobytes parsed twice, on a
 *     device where parse time is the scarcest resource. The output is plain
 *     typed arrays; the main thread wraps them in `BufferGeometry` in O(1).
 *  2. **Everything transferable.** The buffers returned here are handed to
 *     `postMessage` in the transfer list, so crossing the thread boundary
 *     costs a pointer move rather than a structured-clone copy of a megabyte.
 *
 * ── WHAT EACH RING EMITS ───────────────────────────────────────────────────
 *   R0  every surviving fracture piece as its own box, window bands on the
 *       outer faces, roof slabs, street furniture. Per-building colliders.
 *   R1  one box per surviving building plus a roof slab, no props. ONE merged
 *       collider for the whole block.
 *   R2  one 5-face box per surviving building, merged into a single block mesh.
 *       No props, no colliders, no crowd.
 *   R3  not a per-chunk job at all — see `buildImpostorGeometry`.
 *
 * ── DAMAGE ─────────────────────────────────────────────────────────────────
 * The persistent damage bitmask arrives with the job and is consulted while
 * emitting. A destroyed fracture piece is simply never written, so a rebuilt
 * chunk costs no more than a pristine one and the city stays as the player left
 * it. Interior faces of every piece are emitted precisely so that a missing
 * piece reveals a plausible hollow instead of a hole into the void.
 */

import {
  CHUNK_COORD_MAX,
  CHUNK_COORD_MIN,
  CHUNK_SIZE,
  WORLD_MAX,
  WORLD_MIN,
  chunkIndex,
} from '@/spatial/constants';
import {
  FRACTURE_HEIGHT_BANDS,
  RING_COLLIDER_MODE,
  RING_CROWD_MODE,
  RING_R0,
  RING_R1,
  STREET_WIDTH,
} from './constants';
import { damageSlot } from './damage-state';
import {
  fracturePieces,
  layoutChunk,
  type IBuildingLayout,
  type IChunkLayout,
} from './chunk-layout';
import type {
  IChunkBuildResult,
  IColliderBox,
  ICrowdSlot,
  IGeometryBuffers,
  IImpostorBuildResult,
} from './protocol';

/* -------------------------------------------------------------------------- */
/* Accumulator                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Growable attribute arrays.
 *
 * Doubling typed arrays rather than pushing onto `number[]`: a `number[]` of
 * 40 000 vertices is 120 000 boxed doubles the GC then has to walk, and the
 * final conversion to a typed array is a second full pass. Doubling costs one
 * amortised copy and the result is already in the layout the GPU wants.
 */
class GeometryAccumulator {
  positions: Float32Array;
  normals: Float32Array;
  colors: Uint8Array;
  indices: Uint32Array;
  vertexCount = 0;
  indexCount = 0;

  minX = Infinity;
  minY = Infinity;
  minZ = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;
  maxZ = -Infinity;

  constructor(vertexCapacity = 4096, indexCapacity = 6144) {
    this.positions = new Float32Array(vertexCapacity * 3);
    this.normals = new Float32Array(vertexCapacity * 3);
    this.colors = new Uint8Array(vertexCapacity * 3);
    this.indices = new Uint32Array(indexCapacity);
  }

  private ensureVertices(extra: number): void {
    const needed = this.vertexCount + extra;
    if (needed * 3 <= this.positions.length) return;
    let capacity = this.positions.length / 3;
    while (capacity < needed) capacity *= 2;
    const positions = new Float32Array(capacity * 3);
    positions.set(this.positions.subarray(0, this.vertexCount * 3));
    const normals = new Float32Array(capacity * 3);
    normals.set(this.normals.subarray(0, this.vertexCount * 3));
    const colors = new Uint8Array(capacity * 3);
    colors.set(this.colors.subarray(0, this.vertexCount * 3));
    this.positions = positions;
    this.normals = normals;
    this.colors = colors;
  }

  private ensureIndices(extra: number): void {
    const needed = this.indexCount + extra;
    if (needed <= this.indices.length) return;
    let capacity = this.indices.length;
    while (capacity < needed) capacity *= 2;
    const indices = new Uint32Array(capacity);
    indices.set(this.indices.subarray(0, this.indexCount));
    this.indices = indices;
  }

  /**
   * Append one quad as two triangles. Corners must be given in counter-
   * clockwise order when viewed from the side the normal points at.
   */
  addQuad(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    nx: number, ny: number, nz: number,
    colour: number
  ): void {
    this.ensureVertices(4);
    this.ensureIndices(6);

    const v = this.vertexCount;
    const p = v * 3;
    const positions = this.positions;
    const normals = this.normals;
    const colors = this.colors;

    positions[p] = ax; positions[p + 1] = ay; positions[p + 2] = az;
    positions[p + 3] = bx; positions[p + 4] = by; positions[p + 5] = bz;
    positions[p + 6] = cx; positions[p + 7] = cy; positions[p + 8] = cz;
    positions[p + 9] = dx; positions[p + 10] = dy; positions[p + 11] = dz;

    for (let i = 0; i < 4; i++) {
      normals[p + i * 3] = nx;
      normals[p + i * 3 + 1] = ny;
      normals[p + i * 3 + 2] = nz;
    }

    const r = (colour >> 16) & 0xff;
    const g = (colour >> 8) & 0xff;
    const b = colour & 0xff;
    for (let i = 0; i < 4; i++) {
      colors[p + i * 3] = r;
      colors[p + i * 3 + 1] = g;
      colors[p + i * 3 + 2] = b;
    }

    const indices = this.indices;
    const o = this.indexCount;
    indices[o] = v; indices[o + 1] = v + 1; indices[o + 2] = v + 2;
    indices[o + 3] = v; indices[o + 4] = v + 2; indices[o + 5] = v + 3;

    this.vertexCount += 4;
    this.indexCount += 6;

    if (ax < this.minX) this.minX = ax;
    if (bx < this.minX) this.minX = bx;
    if (cx < this.minX) this.minX = cx;
    if (dx < this.minX) this.minX = dx;
    if (ax > this.maxX) this.maxX = ax;
    if (bx > this.maxX) this.maxX = bx;
    if (cx > this.maxX) this.maxX = cx;
    if (dx > this.maxX) this.maxX = dx;
    if (ay < this.minY) this.minY = ay;
    if (by < this.minY) this.minY = by;
    if (cy < this.minY) this.minY = cy;
    if (dy < this.minY) this.minY = dy;
    if (ay > this.maxY) this.maxY = ay;
    if (by > this.maxY) this.maxY = by;
    if (cy > this.maxY) this.maxY = cy;
    if (dy > this.maxY) this.maxY = dy;
    if (az < this.minZ) this.minZ = az;
    if (bz < this.minZ) this.minZ = bz;
    if (cz < this.minZ) this.minZ = cz;
    if (dz < this.minZ) this.minZ = dz;
    if (az > this.maxZ) this.maxZ = az;
    if (bz > this.maxZ) this.maxZ = bz;
    if (cz > this.maxZ) this.maxZ = cz;
    if (dz > this.maxZ) this.maxZ = dz;
  }

  /** Append an axis-aligned box. `skipBottom` drops the face nobody can see. */
  addBox(
    minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number,
    sideColour: number,
    topColour: number,
    skipBottom: boolean
  ): void {
    // +X
    this.addQuad(maxX, minY, maxZ, maxX, minY, minZ, maxX, maxY, minZ, maxX, maxY, maxZ, 1, 0, 0, sideColour);
    // -X
    this.addQuad(minX, minY, minZ, minX, minY, maxZ, minX, maxY, maxZ, minX, maxY, minZ, -1, 0, 0, sideColour);
    // +Z
    this.addQuad(minX, minY, maxZ, maxX, minY, maxZ, maxX, maxY, maxZ, minX, maxY, maxZ, 0, 0, 1, sideColour);
    // -Z
    this.addQuad(maxX, minY, minZ, minX, minY, minZ, minX, maxY, minZ, maxX, maxY, minZ, 0, 0, -1, sideColour);
    // +Y
    this.addQuad(minX, maxY, maxZ, maxX, maxY, maxZ, maxX, maxY, minZ, minX, maxY, minZ, 0, 1, 0, topColour);
    if (!skipBottom) {
      // -Y
      this.addQuad(minX, minY, minZ, maxX, minY, minZ, maxX, minY, maxZ, minX, minY, maxZ, 0, -1, 0, topColour);
    }
  }

  /** A horizontal quad at height `y`, facing up. */
  addGroundQuad(minX: number, minZ: number, maxX: number, maxZ: number, y: number, colour: number): void {
    this.addQuad(minX, y, maxZ, maxX, y, maxZ, maxX, y, minZ, minX, y, minZ, 0, 1, 0, colour);
  }

  /** Exactly-sized copies, ready to transfer. */
  finish(): IGeometryBuffers {
    const positions = this.positions.slice(0, this.vertexCount * 3);
    const normals = this.normals.slice(0, this.vertexCount * 3);
    const colors = this.colors.slice(0, this.vertexCount * 3);
    const indices = this.indices.slice(0, this.indexCount);

    const cx = (this.minX + this.maxX) * 0.5;
    const cy = (this.minY + this.maxY) * 0.5;
    const cz = (this.minZ + this.maxZ) * 0.5;
    const dx = this.maxX - cx;
    const dy = this.maxY - cy;
    const dz = this.maxZ - cz;
    const radius = this.vertexCount === 0 ? 0 : Math.sqrt(dx * dx + dy * dy + dz * dz);

    return {
      positions,
      normals,
      colors,
      indices,
      vertexCount: this.vertexCount,
      indexCount: this.indexCount,
      boundingSphere: [
        this.vertexCount === 0 ? 0 : cx,
        this.vertexCount === 0 ? 0 : cy,
        this.vertexCount === 0 ? 0 : cz,
        radius,
      ],
    };
  }

  /** World AABB of everything appended, as a flat 6-tuple. */
  boundsTuple(): [number, number, number, number, number, number] {
    if (this.vertexCount === 0) return [0, 0, 0, 0, 0, 0];
    return [this.minX, this.minY, this.minZ, this.maxX, this.maxY, this.maxZ];
  }
}

/* -------------------------------------------------------------------------- */
/* Content hash                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Order-sensitive FNV-1a over the emitted buffers.
 *
 * Determinism is asserted by comparing this number across runs rather than by
 * shipping golden buffers: a 500 KB fixture per chunk is unmaintainable, and a
 * hash catches the failure that actually happens — a generator that quietly
 * depends on load order or on a shared RNG.
 */
export function hashGeometry(buffers: IGeometryBuffers): number {
  let h = 0x811c9dc5;
  const positionWords = new Uint32Array(
    buffers.positions.buffer,
    buffers.positions.byteOffset,
    buffers.positions.length
  );
  for (let i = 0; i < positionWords.length; i++) {
    h = Math.imul(h ^ positionWords[i]!, 0x01000193) >>> 0;
  }
  const colors = buffers.colors;
  for (let i = 0; i < colors.length; i++) {
    h = Math.imul(h ^ colors[i]!, 0x01000193) >>> 0;
  }
  const indices = buffers.indices;
  for (let i = 0; i < indices.length; i++) {
    h = Math.imul(h ^ indices[i]!, 0x01000193) >>> 0;
  }
  return (h ^ Math.imul(buffers.vertexCount, 0x9e3779b1)) >>> 0;
}

/* -------------------------------------------------------------------------- */
/* Damage helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Read one bit out of a job's transferred damage mask. */
function isPieceDestroyed(mask: Uint32Array | undefined, slot: number): boolean {
  if (mask === undefined) return false;
  return (mask[slot >>> 5]! & (1 << (slot & 31))) !== 0;
}

/**
 * Height of a damaged building: the top of its highest surviving band.
 * Returns 0 when nothing is left standing.
 */
function survivingHeight(building: IBuildingLayout, mask: Uint32Array | undefined): number {
  if (mask === undefined) return building.height;
  const bandHeight = building.height / FRACTURE_HEIGHT_BANDS;
  for (let band = FRACTURE_HEIGHT_BANDS - 1; band >= 0; band--) {
    for (let p = 0; p < 4; p++) {
      const slot = damageSlot(building.index, band * 4 + p);
      if (!isPieceDestroyed(mask, slot)) return (band + 1) * bandHeight;
    }
  }
  return 0;
}

/* -------------------------------------------------------------------------- */
/* Detail emitters                                                            */
/* -------------------------------------------------------------------------- */

/** Window band colour: dark glass by day, so the façades read as buildings. */
const WINDOW_COLOUR = 0x1b2330;

/** Metres a window is inset from the façade plane. Small, but enough to shade. */
const WINDOW_OFFSET = 0.06;

/**
 * Window grid on one outward-facing wall of a fracture piece.
 *
 * Windows are the reason an R0 chunk is worth ~10x an R2 chunk: they are what
 * makes a façade read as a building from the street, and they are also the
 * single biggest contributor to the upload the budget has to absorb. Emitted
 * only for faces that lie on the building's outer boundary — an interior
 * partition between two fracture pieces never gets glazed.
 */
function addWindows(
  out: GeometryAccumulator,
  axis: 0 | 2,
  sign: 1 | -1,
  planeCoord: number,
  spanMin: number,
  spanMax: number,
  minY: number,
  maxY: number
): void {
  const spanWidth = spanMax - spanMin;
  const height = maxY - minY;
  const cols = Math.max(1, Math.floor(spanWidth / 3.4));
  const rows = Math.max(1, Math.floor(height / 3.6));
  const cellW = spanWidth / cols;
  const cellH = height / rows;
  const paneW = cellW * 0.52;
  const paneH = cellH * 0.46;
  const plane = planeCoord + sign * WINDOW_OFFSET;

  for (let r = 0; r < rows; r++) {
    const y0 = minY + r * cellH + (cellH - paneH) * 0.55;
    const y1 = y0 + paneH;
    for (let c = 0; c < cols; c++) {
      const s0 = spanMin + c * cellW + (cellW - paneW) * 0.5;
      const s1 = s0 + paneW;
      if (axis === 0) {
        // Wall faces +/-X; the pane spans Z.
        if (sign > 0) {
          out.addQuad(plane, y0, s1, plane, y0, s0, plane, y1, s0, plane, y1, s1, 1, 0, 0, WINDOW_COLOUR);
        } else {
          out.addQuad(plane, y0, s0, plane, y0, s1, plane, y1, s1, plane, y1, s0, -1, 0, 0, WINDOW_COLOUR);
        }
      } else {
        // Wall faces +/-Z; the pane spans X.
        if (sign > 0) {
          out.addQuad(s0, y0, plane, s1, y0, plane, s1, y1, plane, s0, y1, plane, 0, 0, 1, WINDOW_COLOUR);
        } else {
          out.addQuad(s1, y0, plane, s0, y0, plane, s0, y1, plane, s1, y1, plane, 0, 0, -1, WINDOW_COLOUR);
        }
      }
    }
  }
}

/** Road surface, pavements and the block pad for one chunk. */
function addGround(out: GeometryAccumulator, layout: IChunkLayout, coarse: boolean): void {
  const x0 = layout.originX;
  const z0 = layout.originZ;
  const x1 = x0 + CHUNK_SIZE;
  const z1 = z0 + CHUNK_SIZE;
  const half = STREET_WIDTH * 0.5;

  // Roadway covers the whole chunk; the block pad sits on top of it.
  out.addGroundQuad(x0, z0, x1, z1, 0, layout.roadColour);
  if (coarse) return;

  out.addGroundQuad(x0 + half, z0 + half, x1 - half, z1 - half, 0.02, layout.pavementColour);

  // Lane markings down the middle of each boundary street, 0.3 m wide.
  const mid = 0.15;
  out.addGroundQuad(x0, z0 - mid, x1, z0 + mid, 0.012, 0xb8b06a);
  out.addGroundQuad(x0 - mid, z0, x0 + mid, z1, 0.012, 0xb8b06a);
}

/** Street furniture: a pole and a head, two boxes. */
function addProps(out: GeometryAccumulator, layout: IChunkLayout): void {
  for (const prop of layout.props) {
    const poleHalf = 0.11;
    out.addBox(
      prop.x - poleHalf, 0, prop.z - poleHalf,
      prop.x + poleHalf, prop.height, prop.z + poleHalf,
      0x3d434c, 0x3d434c, true
    );
    // Head offset by a quarter turn so props are not all identical.
    const reach = 0.7;
    const ox = prop.quarterTurns === 0 ? reach : prop.quarterTurns === 2 ? -reach : 0;
    const oz = prop.quarterTurns === 1 ? reach : prop.quarterTurns === 3 ? -reach : 0;
    out.addBox(
      prop.x + ox - 0.36, prop.height - 0.24, prop.z + oz - 0.2,
      prop.x + ox + 0.36, prop.height + 0.06, prop.z + oz + 0.2,
      prop.colour, prop.colour, false
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Per-ring chunk build                                                       */
/* -------------------------------------------------------------------------- */

/** Everything `buildChunkGeometry` produces, minus the job id the pool stamps. */
export type ChunkBuildOutput = Omit<IChunkBuildResult, 'id'>;

/**
 * Build one chunk at one ring. Pure and order-independent: the same
 * `(seed, cx, cz, ring, damage)` always yields byte-identical buffers.
 */
export function buildChunkGeometry(
  seed: number,
  cx: number,
  cz: number,
  ring: number,
  damage: Uint32Array | undefined
): ChunkBuildOutput {
  const started = now();
  const layout = layoutChunk(seed, cx, cz);
  const out = new GeometryAccumulator(ring === RING_R0 ? 8192 : 512, ring === RING_R0 ? 12288 : 768);

  addGround(out, layout, ring > RING_R1);

  const colliders: IColliderBox[] = [];
  let standingBuildings = 0;
  let destroyedPieces = 0;

  let blockMinX = Infinity;
  let blockMinZ = Infinity;
  let blockMaxX = -Infinity;
  let blockMaxZ = -Infinity;
  let blockMaxY = 0;

  for (const building of layout.buildings) {
    const aliveHeight = survivingHeight(building, damage);
    if (aliveHeight <= 0) {
      destroyedPieces += 16;
      continue;
    }
    standingBuildings++;

    if (blockMinX > building.minX) blockMinX = building.minX;
    if (blockMinZ > building.minZ) blockMinZ = building.minZ;
    if (blockMaxX < building.maxX) blockMaxX = building.maxX;
    if (blockMaxZ < building.maxZ) blockMaxZ = building.maxZ;
    if (blockMaxY < aliveHeight) blockMaxY = aliveHeight;

    if (ring === RING_R0) {
      const pieces = fracturePieces(building);
      for (const piece of pieces) {
        if (isPieceDestroyed(damage, damageSlot(building.index, piece.piece))) {
          destroyedPieces++;
          continue;
        }
        // Interior faces kept: a missing neighbour must reveal a wall, not a
        // hole. The bottom face is dropped only where it rests on the ground.
        out.addBox(
          piece.minX, piece.minY, piece.minZ,
          piece.maxX, piece.maxY, piece.maxZ,
          building.colour,
          piece.maxY >= aliveHeight - 1e-4 ? building.roofColour : building.colour,
          piece.band === 0
        );
        // Glaze only the faces on the building's outer boundary.
        if (piece.maxX >= building.maxX - 1e-4) {
          addWindows(out, 0, 1, piece.maxX, piece.minZ, piece.maxZ, piece.minY, piece.maxY);
        }
        if (piece.minX <= building.minX + 1e-4) {
          addWindows(out, 0, -1, piece.minX, piece.minZ, piece.maxZ, piece.minY, piece.maxY);
        }
        if (piece.maxZ >= building.maxZ - 1e-4) {
          addWindows(out, 2, 1, piece.maxZ, piece.minX, piece.maxX, piece.minY, piece.maxY);
        }
        if (piece.minZ <= building.minZ + 1e-4) {
          addWindows(out, 2, -1, piece.minZ, piece.minX, piece.maxX, piece.minY, piece.maxY);
        }
      }
      // Parapet on the surviving roof.
      out.addBox(
        building.minX - 0.25, aliveHeight, building.minZ - 0.25,
        building.maxX + 0.25, aliveHeight + 0.55, building.maxZ + 0.25,
        building.roofColour, building.roofColour, true
      );
      colliders.push({
        centerX: (building.minX + building.maxX) * 0.5,
        centerY: aliveHeight * 0.5,
        centerZ: (building.minZ + building.maxZ) * 0.5,
        halfX: (building.maxX - building.minX) * 0.5,
        halfY: aliveHeight * 0.5,
        halfZ: (building.maxZ - building.minZ) * 0.5,
        buildingIndex: building.index,
      });
    } else if (ring === RING_R1) {
      out.addBox(
        building.minX, 0, building.minZ,
        building.maxX, aliveHeight, building.maxZ,
        building.colour, building.roofColour, true
      );
      out.addBox(
        building.minX + 0.8, aliveHeight, building.minZ + 0.8,
        building.maxX - 0.8, aliveHeight + 0.7, building.maxZ - 0.8,
        building.roofColour, building.roofColour, true
      );
    } else {
      // R2: one 5-face box, merged with every other building in the block into
      // this single geometry. No roof detail, no bottom face.
      out.addBox(
        building.minX, 0, building.minZ,
        building.maxX, aliveHeight, building.maxZ,
        building.colour, building.roofColour, true
      );
    }
  }

  // R1 collapses the block's colliders into one. A merged box is coarser than
  // the buildings it replaces, but at 200-400 m nothing is standing on a ledge
  // and the saving is one rigid body per block instead of nine.
  if (ring === RING_R1 && standingBuildings > 0) {
    colliders.push({
      centerX: (blockMinX + blockMaxX) * 0.5,
      centerY: blockMaxY * 0.5,
      centerZ: (blockMinZ + blockMaxZ) * 0.5,
      halfX: (blockMaxX - blockMinX) * 0.5,
      halfY: blockMaxY * 0.5,
      halfZ: (blockMaxZ - blockMinZ) * 0.5,
      buildingIndex: -1,
    });
  }

  if (ring === RING_R0) addProps(out, layout);

  const crowdMode = RING_CROWD_MODE[ring] ?? 'none';
  const crowd: ICrowdSlot[] =
    crowdMode === 'none'
      ? []
      : layout.spawns.map((s) => ({
          x: s.x,
          y: 0,
          z: s.z,
          rotationY: s.quarterTurns * (Math.PI * 0.5),
        }));

  const buffers = out.finish();
  return {
    kind: 'chunk',
    chunk: layout.chunk,
    ring,
    seed,
    buffers,
    bounds: out.boundsTuple(),
    colliders: RING_COLLIDER_MODE[ring] === 'none' ? [] : colliders,
    crowd,
    crowdMode,
    standingBuildings,
    destroyedPieces,
    generationTimeMs: now() - started,
    bytes:
      buffers.positions.byteLength +
      buffers.normals.byteLength +
      buffers.colors.byteLength +
      buffers.indices.byteLength,
    contentHash: hashGeometry(buffers),
  };
}

/* -------------------------------------------------------------------------- */
/* Impostor ring (R3)                                                         */
/* -------------------------------------------------------------------------- */

/** Fraction a silhouette box is shrunk in plan, so real geometry always wins. */
const IMPOSTOR_SHRINK = 0.94;

/** Fraction of true height a silhouette box keeps. */
const IMPOSTOR_HEIGHT = 0.97;

/** Everything `buildImpostorGeometry` produces, minus the job id. */
export type ImpostorBuildOutput = Omit<IImpostorBuildResult, 'id'>;

/**
 * Bake the entire distant skyline into ONE mesh.
 *
 * Every building in all 256 chunks becomes a 5-face box, and the whole world's
 * ground becomes two more triangles, all in a single index buffer — one draw
 * call for the far city, forever, regardless of how much of it is in view.
 *
 * The per-vertex `chunkIds` attribute is what makes that legitimate rather than
 * a cheat: the vertex shader looks the chunk up in a 16x16 residency texture
 * and collapses the vertex when the real chunk is loaded, so the impostor never
 * double-draws over streamed geometry. Suppression by attribute keeps it one
 * draw call; suppression by splitting the mesh would not.
 *
 * The boxes are additionally shrunk to 94% in plan and 97% in height, which
 * means that even with the residency test disabled the silhouette is strictly
 * inside the real geometry and cannot z-fight through it.
 *
 * Damage is deliberately NOT applied: this is baked once at boot from the seed
 * alone, and a missing corner is not resolvable at 800 m.
 */
export function buildImpostorGeometry(seed: number): ImpostorBuildOutput {
  const started = now();
  const out = new GeometryAccumulator(65536, 98304);
  let chunkIds = new Uint16Array(65536);
  let buildingCount = 0;

  const markChunk = (from: number, to: number, id: number): void => {
    if (to > chunkIds.length) {
      let capacity = chunkIds.length;
      while (capacity < to) capacity *= 2;
      const grown = new Uint16Array(capacity);
      grown.set(chunkIds.subarray(0, from));
      chunkIds = grown;
    }
    chunkIds.fill(id, from, to);
  };

  // Distant ground first, tagged 0xffff so it is never suppressed. Slightly
  // below y=0 so streamed chunk ground quads always win the depth test.
  out.addGroundQuad(WORLD_MIN, WORLD_MIN, WORLD_MAX, WORLD_MAX, -0.06, 0x2a2d33);
  markChunk(0, out.vertexCount, 0xffff);

  for (let cz = CHUNK_COORD_MIN; cz <= CHUNK_COORD_MAX; cz++) {
    for (let cx = CHUNK_COORD_MIN; cx <= CHUNK_COORD_MAX; cx++) {
      const layout = layoutChunk(seed, cx, cz);
      const index = chunkIndex(cx, cz);
      const before = out.vertexCount;

      for (const building of layout.buildings) {
        const midX = (building.minX + building.maxX) * 0.5;
        const midZ = (building.minZ + building.maxZ) * 0.5;
        const halfX = (building.maxX - building.minX) * 0.5 * IMPOSTOR_SHRINK;
        const halfZ = (building.maxZ - building.minZ) * 0.5 * IMPOSTOR_SHRINK;
        out.addBox(
          midX - halfX, 0, midZ - halfZ,
          midX + halfX, building.height * IMPOSTOR_HEIGHT, midZ + halfZ,
          building.colour, building.roofColour, true
        );
        buildingCount++;
      }

      if (out.vertexCount > before) markChunk(before, out.vertexCount, index);
    }
  }

  const buffers = out.finish();
  const ids = chunkIds.slice(0, out.vertexCount);
  return {
    kind: 'impostor',
    seed,
    buffers,
    chunkIds: ids,
    buildingCount,
    generationTimeMs: now() - started,
    bytes:
      buffers.positions.byteLength +
      buffers.normals.byteLength +
      buffers.colors.byteLength +
      buffers.indices.byteLength +
      ids.byteLength,
    contentHash: hashGeometry(buffers),
  };
}

/* -------------------------------------------------------------------------- */
/* Timing                                                                     */
/* -------------------------------------------------------------------------- */

/** `performance.now()` where available, `Date.now()` in bare Node contexts. */
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
