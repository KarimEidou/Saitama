/**
 * DESTRUCTION PORTS — EVERYTHING THIS SYSTEM TALKS TO, AS A SHAPE
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY THIS FILE EXISTS
 *
 *  The architectural rule (`src/types/events.ts`) is absolute: a system
 *  imports `@/types` and `@/util` and NOTHING ELSE. Destruction is the system
 *  that rule is hardest on, because it is inherently a JOIN — it has to write
 *  into city geometry, hand mass to the physics debris pool, tick the
 *  streaming damage bitmask and launch a ragdoll, all in one frame.
 *
 *  The resolution is dependency INVERSION, not an import. Every collaborator
 *  is described here as a structural interface, and the bootstrap injects the
 *  real object. `DebrisPool`, `ChunkDamageState` and `IBlockMesh` satisfy
 *  these shapes exactly as written — verified by `harness/destruction.ts`,
 *  which assigns the real instances into these types with no cast — but this
 *  directory never names them, so destruction stays removable, unit-testable
 *  without a Rapier wasm boot, and immune to a refactor two directories away.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── ON MIRRORING THE BAKED FRACTURE LAYOUT ─────────────────────────────────
 * `IStructureLayout` below is a faithful re-declaration of the baked layout
 * the city generator produces. That is deliberate and unavoidable: the shared
 * contract in `src/types/destruction.ts` describes a `FractureChunk` (a live
 * geometry, one per detached piece) but has no name for the flat
 * `{start, count, centroid, mass, aabb}` table a pre-fractured building ships
 * with. The table is the thing destruction actually consumes, so it is
 * declared here as a port and satisfied by the generator's output verbatim.
 *
 * MAINTENANCE: keep this structurally identical to the generator's layout. It
 * is not "nearly" the same shape — `harness/destruction.ts` assigns a real
 * layout straight into `IStructureLayout` and passes the generator's own
 * `collapsingFloors` in as `CollapsingFloorsFn`, so any drift is a type error
 * at the wiring site rather than a silent divergence.
 */

import type * as THREE from 'three';
import type { EntityId, FractureChunk, StructureMaterial, Vec3 } from '@/types';

/* -------------------------------------------------------------------------- */
/* Geometry side                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The per-vertex `aDestroyed` attribute of a block mesh.
 *
 * `THREE.BufferAttribute` satisfies this. Note `array` is deliberately typed
 * for `fill` and indexed reads only: destruction never resizes it, never
 * replaces it, and never re-indexes the geometry.
 */
export interface IDestroyedAttribute {
  readonly array: ArrayLike<number> & {
    fill(value: number, start?: number, end?: number): unknown;
  };
  /** Mark a byte range dirty so only that range is re-uploaded. */
  addUpdateRange(start: number, count: number): void;
  needsUpdate: boolean;
}

/** A mesh destruction can write into. `IBlockMesh` from the city satisfies it. */
export interface IDestructionTarget {
  readonly destroyed: IDestroyedAttribute;
}

/* -------------------------------------------------------------------------- */
/* The baked fracture layout                                                  */
/* -------------------------------------------------------------------------- */

/** A contiguous index range inside one material slot. */
export interface IStructureSlotRange {
  readonly slot: number;
  readonly start: number;
  readonly count: number;
}

/**
 * One baked fracture chunk: one floor x one facade quadrant, plus that
 * quadrant's share of the slab.
 */
export interface IStructureChunk {
  /** Position in the parent's chunk array; equals `floor * 4 + quadrant`. */
  readonly index: number;
  readonly floor: number;
  /** 0 = +X (east), 1 = +Z (south), 2 = -X (west), 3 = -Z (north). */
  readonly quadrant: number;
  readonly start: number;
  readonly count: number;
  readonly parts: readonly IStructureSlotRange[];
  /** Contiguous vertex range owned exclusively by this chunk. */
  readonly vertexStart: number;
  readonly vertexCount: number;
  /** Centre of mass in the structure's LOCAL space. */
  readonly centroid: readonly [number, number, number];
  readonly volume: number;
  readonly mass: number;
  /** Local-space AABB, `[minX, minY, minZ, maxX, maxY, maxZ]`. */
  readonly aabb: readonly [number, number, number, number, number, number];
  readonly grounded: boolean;
  readonly neighbours: readonly number[];
  /** Share of this floor's total structural support, 0..1. */
  readonly supportShare: number;
}

/** Structural summary of one storey. */
export interface IStructureFloor {
  readonly floor: number;
  readonly y0: number;
  readonly y1: number;
  readonly chunks: readonly number[];
  readonly totalSupport: number;
}

/** Everything destruction needs to know about one pre-fractured structure. */
export interface IStructureLayout {
  readonly chunks: readonly IStructureChunk[];
  readonly floors: readonly IStructureFloor[];
  /**
   * Typed as the shared `StructureMaterial` union, NOT as `string`.
   *
   * `CollapsingFloorsFn` takes this layout as a parameter, and parameters are
   * checked contravariantly: widening this field to `string` would make the
   * generator's own `collapsingFloors` un-assignable to the port and force a
   * cast at every wiring site — which is exactly the drift this file exists to
   * catch.
   */
  readonly structureMaterial: StructureMaterial;
  readonly totalMass: number;
  /** Fraction of support that must SURVIVE for a floor to stay standing. */
  readonly collapseSupportRatio: number;
  /** Index offset of each material slot; carried so a layout can be rebased. */
  readonly slotBase: readonly number[];
}

/**
 * "Which floors must come down, given what is already destroyed."
 *
 * Injected rather than reimplemented-and-hoped: the city generator owns the
 * support model, and `support.ts` here carries an identical fallback purely so
 * the system runs standalone in a unit test. `__tests__/support.test.ts` pins
 * the two together.
 */
export type CollapsingFloorsFn = (
  layout: IStructureLayout,
  isDestroyed: (chunkIndex: number) => boolean
) => readonly number[];

/* -------------------------------------------------------------------------- */
/* Physics side                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The debris budget. `DebrisPool` from `@/physics` satisfies this.
 *
 * Destruction never creates a rigid body, never touches Rapier and never
 * decides the fade curve — it hands over mass, centroid and AABB and lets the
 * pool enforce its own 300-piece ceiling.
 */
export interface IDebrisSink {
  /** Live pieces. */
  readonly count: number;
  /** Hard ceiling. */
  readonly capacity: number;
  spawn(
    chunk: FractureChunk,
    worldMatrix: THREE.Matrix4,
    impulse: THREE.Vector3
  ): { readonly id: number } | undefined;
  /** Look up a live piece; used to reclaim pooled debris geometry. */
  get?(id: number): unknown;
}

/**
 * The persistent 8 KB damage bitmask. `ChunkDamageState` from
 * `@/world/streaming` satisfies this.
 */
export interface IDamageSink {
  /** Record one destroyed fracture piece. True when the bit was newly set. */
  setDestroyed(chunk: number, slot: number): boolean;
  isDestroyed(chunk: number, slot: number): boolean;
}

/**
 * Ragdoll launcher.
 *
 * Deliberately NOT `RagdollManager`: building a ragdoll needs the victim's
 * rig, and destruction has no business knowing what an entity's skeleton looks
 * like. The bootstrap supplies an adapter that resolves the rig and calls
 * `RagdollManager.spawn`; destruction only decides WHETHER and with WHAT
 * impulse, and refuses to ask once `activeCount` has reached `maxActive`.
 */
export interface IRagdollSink {
  readonly activeCount: number;
  readonly maxActive: number;
  /** Launch. Return false when the entity had no rig or was already ragdolled. */
  launch(entityId: EntityId, position: Vec3, impulse: Vec3): boolean;
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

/** One destructible structure, as the bootstrap hands it over. */
export interface IStructureSpec {
  /** Stable id. Travels in `ChunkDetached.structureId`. */
  readonly id: string;
  /** The baked fracture table, already rebased into `target`'s geometry. */
  readonly layout: IStructureLayout;
  /** The mesh whose `aDestroyed` attribute this structure writes into. */
  readonly target: IDestructionTarget;
  /** World-space origin of the structure's local space. */
  readonly position: Vec3;
  /** Yaw about +Y, radians. Procedural city buildings are axis-aligned (0). */
  readonly rotationY?: number;
  /**
   * Dense streaming chunk index, for the persistent damage bitmask. Omit to
   * opt this structure out of persistence (props, test fixtures).
   */
  readonly chunkIndex?: number;
  /** Building index 0..15 inside that streaming chunk. */
  readonly buildingIndex?: number;
  /** Collateral units per kilogram for `ChunkDetached.collateralCost`. */
  readonly collateralPerKg?: number;
}
