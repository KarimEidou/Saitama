/**
 * THE IMPOSTOR RING (R3) — ONE DRAW CALL FOR THE ENTIRE FAR CITY
 *
 * Everything past R2 is not streamed. It is a single pre-baked mesh containing
 * a low-poly silhouette of every building in all 256 chunks, plus the world's
 * ground plane, in one index buffer with one material.
 *
 * ── WHY A BAKED RING AND NOT MORE LOD BANDS ────────────────────────────────
 * The instinct is to add R3, R4, R5 as ever-coarser streamed chunks. That
 * trades triangles for draw calls, and on mobile GPUs draw calls are the
 * scarcer resource: 200 distant chunks at 40 triangles each is 200 state
 * changes to draw 8 000 triangles, which is a far worse deal than 8 000
 * triangles in one call. Baking removes the streaming cost of the far world
 * entirely — no jobs, no uploads, no evictions, no pop — and replaces it with
 * one allocation held for the lifetime of the session.
 *
 * ── HOW IT AVOIDS DRAWING OVER REAL CHUNKS ─────────────────────────────────
 * Two independent mechanisms, because this is the kind of artefact that is
 * invisible in testing and obvious on a player's screen:
 *
 *  1. The vertex shader suppresses any vertex whose chunk is resident, using
 *     the 16x16 residency texture (see `materials.ts`). Exact, and it keeps the
 *     single draw call.
 *  2. The silhouettes are baked at 94% in plan and 97% in height, so even with
 *     suppression disabled they sit strictly INSIDE the real geometry and
 *     cannot z-fight through a façade.
 *
 * ── COST ───────────────────────────────────────────────────────────────────
 * The bake is one worker job at boot, and its upload is a single ~1 MB
 * `bufferData` during the loading screen — deliberately outside the per-frame
 * streaming budget, and measured separately so it can never hide inside it.
 */

import * as THREE from 'three';
import type { IImpostorBuildResult } from './protocol';
import type { StreamingMaterials } from './materials';

/** What the impostor bake produced, for stats and verification. */
export interface IImpostorStats {
  readonly built: boolean;
  readonly buildings: number;
  readonly vertices: number;
  readonly triangles: number;
  readonly bytes: number;
  /** Worker milliseconds spent baking. */
  readonly generationTimeMs: number;
  /** Main-thread milliseconds spent uploading. Boot cost, not frame cost. */
  readonly uploadTimeMs: number;
  readonly contentHash: number;
}

export class ImpostorRing {
  /** The single mesh. Added to the scene once and never touched again. */
  readonly root = new THREE.Group();

  private mesh: THREE.Mesh | undefined;
  private geometry: THREE.BufferGeometry | undefined;
  private stats: IImpostorStats = {
    built: false,
    buildings: 0,
    vertices: 0,
    triangles: 0,
    bytes: 0,
    generationTimeMs: 0,
    uploadTimeMs: 0,
    contentHash: 0,
  };

  constructor(private readonly materials: StreamingMaterials) {
    this.root.name = 'impostor-ring';
    this.root.matrixAutoUpdate = false;
    this.root.updateMatrix();
  }

  /** True once the bake has been uploaded. */
  get isBuilt(): boolean {
    return this.mesh !== undefined;
  }

  /**
   * Upload the baked silhouette. Returns main-thread milliseconds spent, which
   * the caller reports as a BOOT cost — never folded into the frame budget.
   */
  apply(result: IImpostorBuildResult): number {
    const started = performance.now();
    this.release();

    const buffers = result.buffers;
    const geometry = new THREE.BufferGeometry();
    geometry.name = 'impostor-ring';
    geometry.setAttribute('position', new THREE.BufferAttribute(buffers.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(buffers.normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(buffers.colors, 3, true));
    // Not normalised: the shader wants the raw 0..255 / 0xffff chunk id as a
    // float, and normalising it would divide it by 65535 on the way in.
    geometry.setAttribute('aChunkId', new THREE.BufferAttribute(result.chunkIds, 1, false));
    geometry.setIndex(new THREE.BufferAttribute(buffers.indices, 1));

    const [sx, sy, sz, radius] = buffers.boundingSphere;
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(sx, sy, sz), radius);

    const mesh = new THREE.Mesh(geometry, this.materials.impostor);
    mesh.name = 'impostor-ring';
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    // The mesh spans the entire world, so a frustum test on it can only ever
    // return true — and it must never be culled, because it IS the horizon.
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // Drawn first so the depth buffer is populated cheaply before the detailed
    // near rings overwrite it.
    mesh.renderOrder = -1;

    this.root.add(mesh);
    this.mesh = mesh;
    this.geometry = geometry;

    const uploadTimeMs = performance.now() - started;
    this.stats = {
      built: true,
      buildings: result.buildingCount,
      vertices: buffers.vertexCount,
      triangles: buffers.indexCount / 3,
      bytes: result.bytes,
      generationTimeMs: result.generationTimeMs,
      uploadTimeMs,
      contentHash: result.contentHash,
    };
    return uploadTimeMs;
  }

  /** Add the ring to a scene. */
  attach(scene: THREE.Scene): void {
    scene.add(this.root);
  }

  /** Remove the ring from a scene without releasing it. */
  detach(scene: THREE.Scene): void {
    scene.remove(this.root);
  }

  /** Snapshot for the debug HUD and verification. */
  getStats(): IImpostorStats {
    return this.stats;
  }

  /** Release the baked geometry. */
  dispose(): void {
    this.release();
    this.root.clear();
  }

  private release(): void {
    if (this.mesh !== undefined) {
      this.root.remove(this.mesh);
      this.mesh = undefined;
    }
    if (this.geometry !== undefined) {
      this.geometry.dispose();
      this.geometry = undefined;
    }
    this.stats = { ...this.stats, built: false };
  }
}
