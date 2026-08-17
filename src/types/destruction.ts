/**
 * DESTRUCTION CONTRACT
 *
 * Breakable geometry, mesh fracturing and debris.
 *
 * TYPE-ONLY file. No runtime exports.
 *
 * NOTE: `FractureChunk` is defined HERE. world.ts imports it for
 * `ChunkPayload`. Do not redeclare it.
 */

import type * as THREE from 'three';
import type { IUpdatable, IDisposable } from './engine';
import type { IDamageable, IPunchEvent, LethalIntent } from './combat';

/* -------------------------------------------------------------------------- */
/* Destructibles                                                              */
/* -------------------------------------------------------------------------- */

/** How a destructible comes apart. */
export type DestructionMode =
  /** Breaks into many small rigid pieces (glass, concrete). */
  | 'shatter'
  /** Hinges and falls over as one body (streetlights, signage). */
  | 'topple'
  /** Collapses floor by floor (buildings). */
  | 'collapse'
  /** Removed entirely with no debris (serious-punch overkill). */
  | 'vaporise'
  /** Deforms but survives (vehicles, metal). */
  | 'dent';

/** Material class driving fracture pattern and debris audio. */
export type StructureMaterial = 'concrete' | 'glass' | 'metal' | 'wood' | 'brick' | 'asphalt';

/** World geometry that can be broken by combat. */
export interface IDestructible extends IDamageable {
  /** Stable id, unique within the world. */
  readonly id: string;
  /** Structural integrity remaining; 0 triggers destruction. */
  readonly integrity: number;
  readonly maxIntegrity: number;
  /** Minimum punch `power` that can damage this at all. */
  readonly damageThreshold: number;
  readonly destructionMode: DestructionMode;
  readonly structureMaterial: StructureMaterial;
  readonly isDestroyed: boolean;
  /** Debris pieces to spawn on destruction. */
  readonly debrisCount: number;
  /** World AABB, used for broad-phase punch queries. */
  readonly bounds: THREE.Box3;

  /** Resolve a punch. Returns integrity removed. */
  applyPunch(punch: IPunchEvent): number;
  /** Force immediate destruction, skipping integrity. */
  destroy(punch?: IPunchEvent): void;
  /** Restore to pristine state. Called on chunk reload. */
  repair(): void;
}

/* -------------------------------------------------------------------------- */
/* Fracture                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One piece of a fractured mesh.
 *
 * Fracture is PRE-COMPUTED at asset-build time, not at runtime: a destructible
 * mesh ships already split into chunks, and destruction simply reveals them
 * and hands them to physics. This keeps a 300-body collapse affordable on
 * mobile.
 */
export interface FractureChunk {
  /** Index within the parent's chunk array. */
  readonly index: number;
  /** Geometry for this piece. May be shared across instances. */
  readonly geometry: THREE.BufferGeometry;
  /** Centre of mass in the parent's LOCAL space. */
  readonly centroid: THREE.Vector3;
  /** Piece volume in cubic metres; drives mass. */
  readonly volume: number;
  /** Mass in kilograms, derived from volume and material density. */
  readonly mass: number;
  /** Local-space AABB. */
  readonly bounds: THREE.Box3;
  /** Indices of chunks sharing a face with this one. */
  readonly neighbours: readonly number[];
  /**
   * True when this chunk touches the ground/foundation. Grounded chunks are
   * kept kinematic until their supporting neighbours are gone, so buildings
   * collapse plausibly instead of exploding outward.
   */
  readonly isGrounded: boolean;
  /** Physics body handle once the chunk is released. */
  bodyHandle?: number;
  /** True once detached and simulated. */
  detached: boolean;
}

/**
 * Index range describing a contiguous run of fracture chunks within a parent
 * mesh, grouped by the structural tier they belong to (e.g. one floor of a
 * building). Destruction proceeds range by range so a collapse can be
 * staggered over several frames instead of spawning 300 bodies at once.
 */
export interface IFractureChunkRange {
  /** Human-readable label, e.g. 'floor-03'. */
  readonly label: string;
  /** First chunk index, inclusive. */
  readonly start: number;
  /** Last chunk index, exclusive. */
  readonly end: number;
  /** Height band this range occupies, in local metres. */
  readonly heightRange: readonly [number, number];
  /** Ranges that must detach before this one becomes unstable. */
  readonly supportedBy: readonly number[];
}

/** Ordered structural tiers of a fractured mesh, lowest first. */
export type FractureChunkRanges = readonly IFractureChunkRange[];

/**
 * Pre-computed fracture data for a mesh, produced by the asset pipeline and
 * referenced from the asset manifest.
 */
export interface IFractureData {
  /** Asset key of the intact source mesh. */
  readonly sourceKey: string;
  readonly chunks: readonly FractureChunk[];
  readonly ranges: FractureChunkRanges;
  readonly structureMaterial: StructureMaterial;
  /** Total mass of the intact object in kg. */
  readonly totalMass: number;
}

/* -------------------------------------------------------------------------- */
/* Debris                                                                     */
/* -------------------------------------------------------------------------- */

/** A live debris body. */
export interface IDebrisPiece {
  readonly id: number;
  readonly mesh: THREE.Object3D;
  /** Physics body handle. */
  readonly bodyHandle: number;
  /** Seconds remaining before despawn. */
  lifetime: number;
  /** True once the body has come to rest and been put to sleep. */
  settled: boolean;
}

/**
 * Debris budget manager. Enforces `IQualitySettings.maxRigidBodies` by
 * recycling the oldest settled pieces — never let a collapse exceed budget.
 */
export interface IDebrisPool extends IUpdatable, IDisposable {
  /** Live debris count. */
  readonly count: number;
  /** Hard ceiling from the active quality tier. */
  readonly capacity: number;

  /**
   * Spawn debris for a detached fracture chunk. Returns undefined when the
   * budget is exhausted and no piece could be recycled.
   */
  spawn(
    chunk: FractureChunk,
    worldMatrix: THREE.Matrix4,
    impulse: THREE.Vector3
  ): IDebrisPiece | undefined;
  /** Recycle a specific piece. */
  release(id: number): void;
  /** Recycle everything, e.g. on chunk unload or fast travel. */
  clear(): void;
}

/* -------------------------------------------------------------------------- */
/* Destruction system                                                         */
/* -------------------------------------------------------------------------- */

/** Central destruction manager. One instance. */
export interface IDestructionSystem extends IUpdatable, IDisposable {
  readonly debris: IDebrisPool;
  /** Every registered destructible by id. */
  readonly destructibles: ReadonlyMap<string, IDestructible>;

  /** Register a destructible so punches can find it. */
  register(target: IDestructible): void;
  /** Deregister on chunk unload. */
  unregister(id: string): void;
  /** Destructibles whose bounds intersect a sphere. */
  queryRadius(centre: THREE.Vector3, radius: number): IDestructible[];
  /**
   * Apply a punch to all destructibles in range, staggering collapses across
   * frames to respect the debris budget.
   */
  applyPunch(punch: IPunchEvent): number;
  /** Total collateral cost accumulated this session. */
  readonly collateralTotal: number;
  /** Reset collateral accounting, e.g. at mission start. */
  resetCollateral(): void;
  /** Minimum intent that may damage structures. Tunable for restraint play. */
  minimumDestructiveIntent: LethalIntent;
}
