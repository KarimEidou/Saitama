/**
 * TEST FIXTURES
 *
 * Two flavours of destructible, deliberately kept separate:
 *
 *  SYNTHETIC (`makeTower`)  a hand-built layout with round numbers, so a test
 *                           about the 60% support threshold can state exactly
 *                           what it expects rather than inferring it from
 *                           whatever the generator happened to produce.
 *
 *  REAL (`realBlocks`)      layouts straight out of `@/world/city`. Importing
 *                           the generator INSIDE A TEST is not the
 *                           architectural rule being broken — the rule governs
 *                           what `src/gameplay/destruction/**` imports, and the
 *                           whole point of these tests is to prove the shapes
 *                           the generator emits satisfy the ports the system
 *                           declares, with no cast anywhere.
 */

import rawPlan from '../../../../assets/district/cityz.plan.json';
import { CityGenerator, type ICityPlan } from '@/world/city';
import type { IDebrisSink, IDestroyedAttribute, IStructureLayout } from '../ports';
import type { FractureChunk } from '@/types';

/* -------------------------------------------------------------------------- */
/* A minimal `aDestroyed` attribute                                           */
/* -------------------------------------------------------------------------- */

/**
 * Stand-in for `THREE.BufferAttribute`, matching what the GPU actually sees:
 * a Uint8 array uploaded NORMALISED.
 */
export class FakeDestroyedAttribute implements IDestroyedAttribute {
  readonly array: Uint8Array;
  needsUpdate = false;
  updateRanges: { start: number; count: number }[] = [];
  uploads = 0;

  constructor(vertexCount: number) {
    this.array = new Uint8Array(vertexCount);
  }

  addUpdateRange(start: number, count: number): void {
    this.updateRanges.push({ start, count });
    this.uploads++;
  }

  /** What the vertex shader reads for a vertex: `byte / 255`. */
  shaderValue(vertex: number): number {
    return (this.array[vertex] ?? 0) / 255;
  }

  /** What the shader's `aDestroyed > 0.5` test concludes. */
  isHidden(vertex: number): boolean {
    return this.shaderValue(vertex) > 0.5;
  }

  /** Vertices the shader would keep. */
  visibleCount(): number {
    let visible = 0;
    for (let i = 0; i < this.array.length; i++) if (!this.isHidden(i)) visible++;
    return visible;
  }
}

/* -------------------------------------------------------------------------- */
/* Synthetic layouts                                                          */
/* -------------------------------------------------------------------------- */

export interface ITowerOptions {
  readonly floors?: number;
  readonly footprint?: number;
  readonly floorHeight?: number;
  readonly verticesPerChunk?: number;
  readonly massPerChunk?: number;
}

/**
 * A square tower with four equal quadrants per floor, matching the generator's
 * chunking rule (`index === floor * 4 + quadrant`, four chunks a storey, each
 * carrying a quarter of the storey's support).
 */
export function makeTower(options: ITowerOptions = {}): {
  layout: IStructureLayout;
  attribute: FakeDestroyedAttribute;
  vertexCount: number;
} {
  const floors = options.floors ?? 12;
  const half = (options.footprint ?? 12) * 0.5;
  const floorHeight = options.floorHeight ?? 3.4;
  const verticesPerChunk = options.verticesPerChunk ?? 32;
  const mass = options.massPerChunk ?? 5200;

  const chunks: IStructureLayout['chunks'][number][] = [];
  const floorRecords: IStructureLayout['floors'][number][] = [];

  for (let floor = 0; floor < floors; floor++) {
    const y0 = floor * floorHeight;
    const y1 = y0 + floorHeight;
    const indices: number[] = [];
    for (let quadrant = 0; quadrant < 4; quadrant++) {
      const index = floor * 4 + quadrant;
      indices.push(index);
      // 0 = +X, 1 = +Z, 2 = -X, 3 = -Z. Each quadrant owns half the plan in
      // its own axis, exactly as `quadrantOf` partitions it.
      const minX = quadrant === 0 ? 0 : -half;
      const maxX = quadrant === 2 ? 0 : half;
      const minZ = quadrant === 1 ? 0 : -half;
      const maxZ = quadrant === 3 ? 0 : half;
      chunks.push({
        index,
        floor,
        quadrant,
        start: index * 96,
        count: 96,
        parts: [{ slot: 0, start: index * 96, count: 96 }],
        vertexStart: index * verticesPerChunk,
        vertexCount: verticesPerChunk,
        centroid: [(minX + maxX) * 0.5, (y0 + y1) * 0.5, (minZ + maxZ) * 0.5],
        volume: mass / 2400,
        mass,
        aabb: [minX, y0, minZ, maxX, y1, maxZ],
        grounded: floor === 0,
        neighbours: [],
        supportShare: 0.25,
      });
    }
    floorRecords.push({ floor, y0, y1, chunks: indices, totalSupport: 1 });
  }

  const vertexCount = floors * 4 * verticesPerChunk;
  return {
    layout: {
      chunks,
      floors: floorRecords,
      structureMaterial: 'concrete',
      totalMass: mass * floors * 4,
      collapseSupportRatio: 0.4,
      slotBase: [0, 0, 0],
    },
    attribute: new FakeDestroyedAttribute(vertexCount),
    vertexCount,
  };
}

/* -------------------------------------------------------------------------- */
/* Real generated layouts                                                     */
/* -------------------------------------------------------------------------- */

const plan = rawPlan as unknown as ICityPlan;
let generator: CityGenerator | undefined;

/** Real pre-fractured buildings from City Z, with their block vertex counts. */
export function realLayouts(
  cx: number,
  cz: number
): { id: string; layout: IStructureLayout; vertexCount: number; position: [number, number, number] }[] {
  generator ??= new CityGenerator(plan, { defaultDetail: 'full', includeProps: false });
  const chunk = generator.generate(cx, cz, { detail: 'full', includeProps: false });
  const out: {
    id: string;
    layout: IStructureLayout;
    vertexCount: number;
    position: [number, number, number];
  }[] = [];
  for (const block of chunk.blocks) {
    const vertexCount = block.geometry.buffers.vertexCount;
    if (vertexCount === 0) continue;
    const byId = new Map(block.buildings.map((b) => [b.id, b]));
    for (const [id, layout] of Object.entries(block.fractures)) {
      const summary = byId.get(id);
      if (summary === undefined) continue;
      out.push({
        id,
        // No cast: the generator's layout satisfies the port as written. If it
        // ever stops doing so, this line is the compile error that says so.
        layout,
        vertexCount,
        position: [summary.position[0], summary.position[1], summary.position[2]],
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

/** A debris pool that counts and enforces a cap, and allocates nothing. */
export class FakeDebrisPool implements IDebrisSink {
  readonly capacity: number;
  spawnCalls = 0;
  peakCount = 0;
  /** Ids of live pieces, in spawn order. */
  private readonly live: number[] = [];
  private nextId = 1;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get count(): number {
    return this.live.length;
  }

  spawn(chunk: FractureChunk, _worldMatrix: unknown, _impulse: unknown): { id: number } | undefined {
    void chunk;
    this.spawnCalls++;
    if (this.live.length >= this.capacity) return undefined;
    const id = this.nextId++;
    this.live.push(id);
    if (this.live.length > this.peakCount) this.peakCount = this.live.length;
    return { id };
  }

  get(id: number): unknown {
    return this.live.includes(id) ? id : undefined;
  }

  /** Retire the oldest `n` pieces, standing in for the 12 s fade. */
  retire(n: number): void {
    this.live.splice(0, n);
  }
}

/** A ragdoll sink with a hard ceiling, recording every launch. */
export class FakeRagdollSink {
  readonly maxActive: number;
  activeCount = 0;
  launches: { id: string; impulse: [number, number, number] }[] = [];
  refusals = 0;

  constructor(maxActive = 8) {
    this.maxActive = maxActive;
  }

  launch(entityId: string, _position: unknown, impulse: { x: number; y: number; z: number }): boolean {
    if (this.activeCount >= this.maxActive) {
      this.refusals++;
      return false;
    }
    this.activeCount++;
    this.launches.push({ id: entityId, impulse: [impulse.x, impulse.y, impulse.z] });
    return true;
  }
}
