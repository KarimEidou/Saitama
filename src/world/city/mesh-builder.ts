/**
 * FRACTURE-AWARE GEOMETRY BUILDER
 *
 * ── THE ONE IDEA IN THIS FILE ──────────────────────────────────────────────
 * A building has to satisfy two layout constraints that look like they
 * conflict:
 *
 *   1. DRAW CALLS. Triangles must be grouped by material so a whole block
 *      merges down to three `BufferGeometry.groups` — facade, glass, roof —
 *      and therefore three draw calls.
 *   2. FRACTURE. Every triangle must belong to exactly one fracture chunk
 *      (one floor x one facade quadrant, plus its slab) so destroying a chunk
 *      is a contiguous buffer edit and never a geometry rebuild.
 *
 * Sorting the index buffer by material breaks constraint 2; sorting it by
 * fracture chunk breaks constraint 1.
 *
 * They only conflict if you assume both constraints live in the same buffer.
 * They do not:
 *
 *   • VERTICES are laid out FRACTURE-MAJOR. Chunk k owns the contiguous vertex
 *     range `[vertexStart, vertexStart + vertexCount)`, and no vertex is shared
 *     between chunks. Destroying chunk k is one `fill(1, …)` on the per-vertex
 *     `destroyed` attribute, which the vertex shader uses to collapse the
 *     triangle to a point. No index rewrite, no realloc, no hitch.
 *
 *   • INDICES are laid out MATERIAL-MAJOR, and within a material, still
 *     fracture-ordered. So each material is one contiguous `group` (3 draw
 *     calls), AND each (chunk, material) pair is *also* a contiguous index
 *     sub-range — which is exactly what the debris path copies out when a
 *     chunk detaches.
 *
 * Indices are pointers, not storage: the two orderings are independent and both
 * constraints hold simultaneously. That is the whole trick.
 *
 * Everything is emitted into plain `number[]` while building and packed into
 * typed arrays once at the end, so a finished chunk can be transferred to the
 * main thread with zero copies.
 */

/* -------------------------------------------------------------------------- */
/* Material groups                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Material slot index within a merged geometry.
 *
 * Three slots, fixed, for every building in the city. The slot count is a hard
 * budget, not a convenience: it is what caps a merged block at three draw calls.
 * Variety within a slot comes from per-vertex tint, never from a fourth
 * material.
 */
export const enum MatSlot {
  /** Opaque architecture: walls, jambs, sills, parapets, doors, awnings. */
  Facade = 0,
  /** Emissive/transparent: window glazing, shopfront glass, lit signage. */
  Glass = 1,
  /** Roof decks, balcony slabs, rooftop clutter, fire escapes, metalwork. */
  Roof = 2,
}

/** Number of material slots a building geometry carries. */
export const MAT_SLOT_COUNT = 3;

/* -------------------------------------------------------------------------- */
/* Output shape                                                               */
/* -------------------------------------------------------------------------- */

/** A contiguous index range covering one material within a geometry. */
export interface IMaterialGroup {
  /** First index, inclusive. */
  readonly start: number;
  /** Index count. */
  readonly count: number;
  /** Slot index; also the material-array index on the Three.js mesh. */
  readonly slot: number;
}

/**
 * Packed geometry buffers. Every array is a fresh allocation whose
 * `.buffer` is safe to list in a worker transfer list.
 */
export interface IGeometryBuffers {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  /** Per-vertex tint, multiplied into the base map. RGB, 3 floats. */
  readonly colors: Float32Array;
  readonly indices: Uint32Array;
  /**
   * Per-vertex destruction flag, 0 = intact. Uint8, uploaded normalised so the
   * shader sees 0..1. One byte per vertex is the cheapest possible handle on
   * "make these triangles disappear this frame".
   */
  readonly destroyed: Uint8Array;
  readonly groups: readonly IMaterialGroup[];
  readonly vertexCount: number;
  readonly indexCount: number;
}

/** Local-space AABB as a flat sextet, worker-transfer friendly. */
export type AABB6 = readonly [number, number, number, number, number, number];

/** Vertex + per-slot index span recorded for one fracture chunk. */
export interface IChunkSpan {
  readonly vertexStart: number;
  readonly vertexCount: number;
  /** Index sub-range within each material slot, `[start, count]` pairs. */
  readonly slotRanges: readonly (readonly [number, number])[];
  /** Summed triangle area x thickness estimate, used to derive mass. */
  readonly volume: number;
  readonly centroid: readonly [number, number, number];
  readonly bounds: AABB6;
}

/* -------------------------------------------------------------------------- */
/* Builder                                                                    */
/* -------------------------------------------------------------------------- */

const IDENTITY_COLOR: readonly [number, number, number] = [1, 1, 1];

/**
 * Accumulates geometry for a single object, tracking fracture chunk boundaries.
 *
 * Usage:
 *   const b = new MeshBuilder();
 *   b.beginChunk();
 *     b.quad(MatSlot.Facade, a, b, c, d, uv, tint);
 *   const span = b.endChunk();
 *   const buffers = b.build();
 */
export class MeshBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly uvs: number[] = [];
  private readonly colors: number[] = [];
  /** One index list per material slot; concatenated at build time. */
  private readonly slotIndices: number[][] = [];

  /** Vertex index where the open chunk started, or -1 when none is open. */
  private chunkVertexStart = -1;
  private chunkSlotStart: number[] = [];
  private chunkVolume = 0;
  private chunkMoment = [0, 0, 0];
  private chunkAreaSum = 0;
  private chunkBounds: number[] = [];

  constructor(readonly slotCount: number = MAT_SLOT_COUNT) {
    for (let i = 0; i < slotCount; i++) this.slotIndices.push([]);
  }

  /** Vertices emitted so far. */
  get vertexCount(): number {
    return this.positions.length / 3;
  }

  /** Triangles emitted so far, across all slots. */
  get triangleCount(): number {
    let total = 0;
    for (const list of this.slotIndices) total += list.length;
    return total / 3;
  }

  /** True when at least one vertex has been emitted. */
  get isEmpty(): boolean {
    return this.positions.length === 0;
  }

  /* ---------------------------------------------------------------------- */
  /* Chunk bracketing                                                        */
  /* ---------------------------------------------------------------------- */

  /** Open a fracture chunk. Every vertex emitted until `endChunk` belongs to it. */
  beginChunk(): void {
    if (this.chunkVertexStart >= 0) throw new Error('MeshBuilder: chunk already open');
    this.chunkVertexStart = this.vertexCount;
    this.chunkSlotStart = this.slotIndices.map((list) => list.length);
    this.chunkVolume = 0;
    this.chunkMoment = [0, 0, 0];
    this.chunkAreaSum = 0;
    this.chunkBounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  }

  /** Close the open fracture chunk and return its spans. */
  endChunk(): IChunkSpan {
    if (this.chunkVertexStart < 0) throw new Error('MeshBuilder: no chunk open');
    const vertexStart = this.chunkVertexStart;
    const vertexCount = this.vertexCount - vertexStart;
    const slotRanges: [number, number][] = this.slotIndices.map((list, i) => [
      this.chunkSlotStart[i],
      list.length - this.chunkSlotStart[i],
    ]);
    const area = this.chunkAreaSum;
    const centroid: [number, number, number] =
      area > 1e-9
        ? [this.chunkMoment[0] / area, this.chunkMoment[1] / area, this.chunkMoment[2] / area]
        : [
            (this.chunkBounds[0] + this.chunkBounds[3]) * 0.5,
            (this.chunkBounds[1] + this.chunkBounds[4]) * 0.5,
            (this.chunkBounds[2] + this.chunkBounds[5]) * 0.5,
          ];
    const bounds: AABB6 = vertexCount
      ? [
          this.chunkBounds[0],
          this.chunkBounds[1],
          this.chunkBounds[2],
          this.chunkBounds[3],
          this.chunkBounds[4],
          this.chunkBounds[5],
        ]
      : [0, 0, 0, 0, 0, 0];

    this.chunkVertexStart = -1;
    return { vertexStart, vertexCount, slotRanges, volume: this.chunkVolume, centroid, bounds };
  }

  /* ---------------------------------------------------------------------- */
  /* Primitives                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Emit a quad `a-b-c-d` (counter-clockwise seen from the front face).
   *
   * `uv` is `[u0, v0, u1, v1]` mapped corner-wise: a=(u0,v0), b=(u1,v0),
   * c=(u1,v1), d=(u0,v1). UVs are given in METRES divided by the material's
   * tile size by the caller, so a merged geometry needs no per-instance repeat.
   */
  quad(
    slot: number,
    a: readonly number[],
    b: readonly number[],
    c: readonly number[],
    d: readonly number[],
    uv: readonly [number, number, number, number],
    color: readonly [number, number, number] = IDENTITY_COLOR
  ): void {
    const nx = faceNormal(a, b, c);
    const base = this.vertexCount;
    this.vertex(a, nx, uv[0], uv[1], color);
    this.vertex(b, nx, uv[2], uv[1], color);
    this.vertex(c, nx, uv[2], uv[3], color);
    this.vertex(d, nx, uv[0], uv[3], color);
    const list = this.slotIndices[slot];
    list.push(base, base + 1, base + 2, base, base + 2, base + 3);

    const area = triArea(a, b, c) + triArea(a, c, d);
    this.accumulate(area, [
      (a[0] + b[0] + c[0] + d[0]) * 0.25,
      (a[1] + b[1] + c[1] + d[1]) * 0.25,
      (a[2] + b[2] + c[2] + d[2]) * 0.25,
    ]);
  }

  /** Emit a triangle with explicit per-corner UVs. */
  triangle(
    slot: number,
    a: readonly number[],
    b: readonly number[],
    c: readonly number[],
    uvA: readonly [number, number],
    uvB: readonly [number, number],
    uvC: readonly [number, number],
    color: readonly [number, number, number] = IDENTITY_COLOR
  ): void {
    const n = faceNormal(a, b, c);
    const base = this.vertexCount;
    this.vertex(a, n, uvA[0], uvA[1], color);
    this.vertex(b, n, uvB[0], uvB[1], color);
    this.vertex(c, n, uvC[0], uvC[1], color);
    this.slotIndices[slot].push(base, base + 1, base + 2);
    this.accumulate(triArea(a, b, c), [
      (a[0] + b[0] + c[0]) / 3,
      (a[1] + b[1] + c[1]) / 3,
      (a[2] + b[2] + c[2]) / 3,
    ]);
  }

  /**
   * Emit an axis-aligned box. `uvScale` converts metres to UV units.
   *
   * `faces` is a 6-bit mask, `+X +Y +Z -X -Y -Z`, so hidden faces (a box sunk
   * into a wall, a parapet's inner face) cost nothing. Suppressing them is
   * worth real money: rooftop clutter is the single biggest triangle consumer
   * in the city and most of its faces are never seen.
   */
  box(
    slot: number,
    cx: number,
    cy: number,
    cz: number,
    hx: number,
    hy: number,
    hz: number,
    uvScale: number,
    color: readonly [number, number, number] = IDENTITY_COLOR,
    faces = 0b111111
  ): void {
    const x0 = cx - hx;
    const x1 = cx + hx;
    const y0 = cy - hy;
    const y1 = cy + hy;
    const z0 = cz - hz;
    const z1 = cz + hz;
    const su = (v: number) => v * uvScale;

    if (faces & 0b000001) {
      this.quad(
        slot,
        [x1, y0, z1],
        [x1, y0, z0],
        [x1, y1, z0],
        [x1, y1, z1],
        [su(z0), su(y0), su(z1), su(y1)],
        color
      );
    }
    if (faces & 0b000010) {
      this.quad(
        slot,
        [x0, y1, z1],
        [x1, y1, z1],
        [x1, y1, z0],
        [x0, y1, z0],
        [su(x0), su(z0), su(x1), su(z1)],
        color
      );
    }
    if (faces & 0b000100) {
      this.quad(
        slot,
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
        [su(x0), su(y0), su(x1), su(y1)],
        color
      );
    }
    if (faces & 0b001000) {
      this.quad(
        slot,
        [x0, y0, z0],
        [x0, y0, z1],
        [x0, y1, z1],
        [x0, y1, z0],
        [su(z0), su(y0), su(z1), su(y1)],
        color
      );
    }
    if (faces & 0b010000) {
      this.quad(
        slot,
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y0, z1],
        [x0, y0, z1],
        [su(x0), su(z0), su(x1), su(z1)],
        color
      );
    }
    if (faces & 0b100000) {
      this.quad(
        slot,
        [x1, y0, z0],
        [x0, y0, z0],
        [x0, y1, z0],
        [x1, y1, z0],
        [su(x0), su(y0), su(x1), su(y1)],
        color
      );
    }
  }

  /** Vertical cylinder (water tanks, poles, ducts). Caps optional. */
  cylinder(
    slot: number,
    cx: number,
    cy: number,
    cz: number,
    radius: number,
    height: number,
    segments: number,
    uvScale: number,
    color: readonly [number, number, number] = IDENTITY_COLOR,
    capTop = true
  ): void {
    const y0 = cy;
    const y1 = cy + height;
    const circumference = 2 * Math.PI * radius;
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const x0 = cx + Math.cos(a0) * radius;
      const z0 = cz + Math.sin(a0) * radius;
      const x1 = cx + Math.cos(a1) * radius;
      const z1 = cz + Math.sin(a1) * radius;
      const u0 = ((i / segments) * circumference) * uvScale;
      const u1 = (((i + 1) / segments) * circumference) * uvScale;
      this.quad(
        slot,
        [x0, y0, z0],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z0],
        [u0, y0 * uvScale, u1, y1 * uvScale],
        color
      );
    }
    if (capTop) {
      for (let i = 0; i < segments; i++) {
        const a0 = (i / segments) * Math.PI * 2;
        const a1 = ((i + 1) / segments) * Math.PI * 2;
        this.triangle(
          slot,
          [cx, y1, cz],
          [cx + Math.cos(a0) * radius, y1, cz + Math.sin(a0) * radius],
          [cx + Math.cos(a1) * radius, y1, cz + Math.sin(a1) * radius],
          [0.5, 0.5],
          [0.5 + Math.cos(a0) * 0.5, 0.5 + Math.sin(a0) * 0.5],
          [0.5 + Math.cos(a1) * 0.5, 0.5 + Math.sin(a1) * 0.5],
          color
        );
      }
    }
  }

  /**
   * Emit a horizontal polygon at height `y`, wound so the face points up
   * (or down when `up` is false). UVs are world-planar in metres x `uvScale`.
   */
  horizontalPolygon(
    slot: number,
    ring: readonly (readonly [number, number])[],
    tris: readonly number[],
    y: number,
    uvScale: number,
    color: readonly [number, number, number] = IDENTITY_COLOR,
    up = true
  ): void {
    const base = this.vertexCount;
    const normal = up ? [0, 1, 0] : [0, -1, 0];
    for (const p of ring) {
      this.vertex([p[0], y, p[1]], normal, p[0] * uvScale, p[1] * uvScale, color);
    }
    const list = this.slotIndices[slot];
    for (let i = 0; i < tris.length; i += 3) {
      // A CCW ring in (x, z) is clockwise when viewed from +Y, so the winding
      // is flipped here for up-facing polygons. This is the single place the
      // XZ-plane convention meets Three's front-face rule.
      if (up) list.push(base + tris[i], base + tris[i + 2], base + tris[i + 1]);
      else list.push(base + tris[i], base + tris[i + 1], base + tris[i + 2]);
    }
    let area = 0;
    let mx = 0;
    let mz = 0;
    for (let i = 0; i < tris.length; i += 3) {
      const a = ring[tris[i]];
      const b = ring[tris[i + 1]];
      const c = ring[tris[i + 2]];
      const t = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) * 0.5;
      area += t;
      mx += ((a[0] + b[0] + c[0]) / 3) * t;
      mz += ((a[1] + b[1] + c[1]) / 3) * t;
    }
    if (area > 1e-9) this.accumulate(area, [mx / area, y, mz / area]);
  }

  /** Add to the open chunk's volume estimate: surface area x nominal thickness. */
  addVolume(volume: number): void {
    this.chunkVolume += volume;
  }

  /* ---------------------------------------------------------------------- */
  /* Packing                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Pack into typed arrays. Index lists are concatenated slot by slot, so each
   * slot becomes one contiguous `group` and therefore one draw call.
   */
  build(): IGeometryBuffers {
    const vertexCount = this.vertexCount;
    const groups: IMaterialGroup[] = [];
    let indexCount = 0;
    for (const list of this.slotIndices) indexCount += list.length;

    const indices = new Uint32Array(indexCount);
    let cursor = 0;
    for (let slot = 0; slot < this.slotIndices.length; slot++) {
      const list = this.slotIndices[slot];
      if (list.length > 0) groups.push({ start: cursor, count: list.length, slot });
      indices.set(list, cursor);
      cursor += list.length;
    }

    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      uvs: new Float32Array(this.uvs),
      colors: new Float32Array(this.colors),
      indices,
      destroyed: new Uint8Array(vertexCount),
      groups,
      vertexCount,
      indexCount,
    };
  }

  /**
   * Index offset of a slot inside the packed index buffer. Fracture ranges are
   * recorded slot-local while building and rebased through this at pack time.
   */
  slotOffset(slot: number): number {
    let offset = 0;
    for (let i = 0; i < slot; i++) offset += this.slotIndices[i].length;
    return offset;
  }

  /** Index count in a slot. */
  slotLength(slot: number): number {
    return this.slotIndices[slot].length;
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  private vertex(
    p: readonly number[],
    n: readonly number[],
    u: number,
    v: number,
    color: readonly [number, number, number]
  ): void {
    this.positions.push(p[0], p[1], p[2]);
    this.normals.push(n[0], n[1], n[2]);
    this.uvs.push(u, v);
    this.colors.push(color[0], color[1], color[2]);
    if (this.chunkVertexStart >= 0) {
      const b = this.chunkBounds;
      if (p[0] < b[0]) b[0] = p[0];
      if (p[1] < b[1]) b[1] = p[1];
      if (p[2] < b[2]) b[2] = p[2];
      if (p[0] > b[3]) b[3] = p[0];
      if (p[1] > b[4]) b[4] = p[1];
      if (p[2] > b[5]) b[5] = p[2];
    }
  }

  private accumulate(area: number, centre: readonly number[]): void {
    if (this.chunkVertexStart < 0) return;
    this.chunkAreaSum += area;
    this.chunkMoment[0] += centre[0] * area;
    this.chunkMoment[1] += centre[1] * area;
    this.chunkMoment[2] += centre[2] * area;
  }
}

/* -------------------------------------------------------------------------- */
/* Free functions                                                             */
/* -------------------------------------------------------------------------- */

function faceNormal(a: readonly number[], b: readonly number[], c: readonly number[]): number[] {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-12) return [0, 1, 0];
  return [nx / len, ny / len, nz / len];
}

function triArea(a: readonly number[], b: readonly number[], c: readonly number[]): number {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  return Math.hypot(nx, ny, nz) * 0.5;
}

/**
 * Concatenate several geometries into one, preserving material slots.
 *
 * This is the block-level merge: N buildings in, one geometry with three groups
 * out. Returns the per-source offsets so fracture ranges recorded against a
 * source geometry can be rebased into the merged buffer without re-deriving
 * anything.
 */
export interface IMergeOffsets {
  readonly vertexOffset: number;
  /** Index offset for each material slot inside the merged index buffer. */
  readonly slotIndexOffset: readonly number[];
}

export interface IMergedGeometry {
  readonly buffers: IGeometryBuffers;
  readonly offsets: readonly IMergeOffsets[];
}

/** Merge geometries slot-major so the result still has one group per material. */
export function mergeGeometries(
  sources: readonly IGeometryBuffers[],
  slotCount = MAT_SLOT_COUNT
): IMergedGeometry {
  let totalVertices = 0;
  const slotTotals = new Array<number>(slotCount).fill(0);
  for (const src of sources) {
    totalVertices += src.vertexCount;
    for (const g of src.groups) slotTotals[g.slot] += g.count;
  }

  let totalIndices = 0;
  const slotBase = new Array<number>(slotCount).fill(0);
  for (let s = 0; s < slotCount; s++) {
    slotBase[s] = totalIndices;
    totalIndices += slotTotals[s];
  }

  const positions = new Float32Array(totalVertices * 3);
  const normals = new Float32Array(totalVertices * 3);
  const uvs = new Float32Array(totalVertices * 2);
  const colors = new Float32Array(totalVertices * 3);
  const indices = new Uint32Array(totalIndices);
  const destroyed = new Uint8Array(totalVertices);

  const slotCursor = slotBase.slice();
  const offsets: IMergeOffsets[] = [];
  let vertexCursor = 0;

  for (const src of sources) {
    positions.set(src.positions, vertexCursor * 3);
    normals.set(src.normals, vertexCursor * 3);
    uvs.set(src.uvs, vertexCursor * 2);
    colors.set(src.colors, vertexCursor * 3);

    const slotIndexOffset = new Array<number>(slotCount).fill(0);
    for (const g of src.groups) {
      const dst = slotCursor[g.slot];
      slotIndexOffset[g.slot] = dst;
      for (let i = 0; i < g.count; i++) {
        indices[dst + i] = src.indices[g.start + i] + vertexCursor;
      }
      slotCursor[g.slot] = dst + g.count;
    }
    offsets.push({ vertexOffset: vertexCursor, slotIndexOffset });
    vertexCursor += src.vertexCount;
  }

  const groups: IMaterialGroup[] = [];
  for (let s = 0; s < slotCount; s++) {
    if (slotTotals[s] > 0) groups.push({ start: slotBase[s], count: slotTotals[s], slot: s });
  }

  return {
    buffers: {
      positions,
      normals,
      uvs,
      colors,
      indices,
      destroyed,
      groups,
      vertexCount: totalVertices,
      indexCount: totalIndices,
    },
    offsets,
  };
}
