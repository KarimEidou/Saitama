/**
 * STREAMING MATERIALS
 *
 * Two materials for the entire streamed world, and that is the point.
 *
 * Every chunk at every ring shares ONE vertex-coloured material. Materials are
 * what break batching: two meshes with different material instances can never
 * merge into one draw call and force a program/uniform rebind between them.
 * A city built out of one material and per-vertex colour is a city whose draw
 * call count is exactly its mesh count, which is what makes "256 resident
 * chunks" a sane sentence on a phone.
 *
 * ── THE IMPOSTOR MATERIAL DOES THE INTERESTING WORK ────────────────────────
 * The impostor ring is one merged mesh covering all 256 chunks, and it must not
 * draw over chunks that are streamed in for real. Splitting the mesh to skip
 * them would cost the one draw call that justifies its existence, so the
 * suppression happens in the vertex shader instead:
 *
 *   • every impostor vertex carries `aChunkId`, the chunk it came from;
 *   • a 16x16 residency texture — literally the chunk grid, 256 bytes — is
 *     uploaded whenever the resident set changes;
 *   • a vertex belonging to a resident chunk is pushed outside the clip volume,
 *     so its triangles vanish with no fragment cost and no branch in the
 *     fragment shader.
 *
 * One draw call, exact suppression, and a 256-byte upload per change instead of
 * a geometry rebuild.
 *
 * ── ASSET COUPLING ─────────────────────────────────────────────────────────
 * These are procedural defaults, deliberately not wired to `IAssetRegistry`.
 * When the material library and the KTX2 façade atlases land, an owner passes
 * its own `THREE.Material` into `StreamingMaterials` and none of the streaming
 * logic changes — the only requirement streaming imposes is that the chunk
 * material consumes a `color` vertex attribute.
 */

import * as THREE from 'three';
import { CHUNK_GRID } from '@/spatial/constants';

/** Injected uniform name for the residency lookup. */
const RESIDENCY_UNIFORM = 'uResidency';

/** `aChunkId` value that is never suppressed (the impostor's ground plane). */
export const IMPOSTOR_ALWAYS_VISIBLE = 0xffff;

export interface IStreamingMaterialOptions {
  /** Override the shared chunk material, e.g. with one from the material lib. */
  readonly chunkMaterial?: THREE.Material;
  /** Override the impostor material. Must still accept `aChunkId`. */
  readonly impostorMaterial?: THREE.Material;
  /** Disable the vertex-shader residency test. Diagnostics only. */
  readonly disableImpostorSuppression?: boolean;
}

/**
 * Owns the shared materials and the residency texture. One instance per
 * streaming system; disposed with it.
 */
export class StreamingMaterials {
  /** Shared by every streamed chunk at every ring. */
  readonly chunk: THREE.Material;
  /** Used by the single merged impostor mesh. */
  readonly impostor: THREE.Material;
  /** 16x16 R8 texture: 255 where the real chunk is resident. */
  readonly residency: THREE.DataTexture;

  private readonly residencyData: Uint8Array;
  private readonly ownsChunk: boolean;
  private readonly ownsImpostor: boolean;

  constructor(options: IStreamingMaterialOptions = {}) {
    this.residencyData = new Uint8Array(CHUNK_GRID * CHUNK_GRID);
    this.residency = new THREE.DataTexture(
      this.residencyData,
      CHUNK_GRID,
      CHUNK_GRID,
      THREE.RedFormat,
      THREE.UnsignedByteType
    );
    this.residency.magFilter = THREE.NearestFilter;
    this.residency.minFilter = THREE.NearestFilter;
    this.residency.generateMipmaps = false;
    this.residency.needsUpdate = true;

    this.ownsChunk = options.chunkMaterial === undefined;
    this.chunk =
      options.chunkMaterial ??
      new THREE.MeshLambertMaterial({
        vertexColors: true,
        // Buildings are closed boxes; the inside of a wall is never wanted, and
        // back-face culling halves the fragment work on the densest ring.
        side: THREE.FrontSide,
      });
    this.chunk.name = 'streaming.chunk';

    this.ownsImpostor = options.impostorMaterial === undefined;
    this.impostor =
      options.impostorMaterial ??
      new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.FrontSide });
    this.impostor.name = 'streaming.impostor';

    if (options.disableImpostorSuppression !== true) {
      this.installResidencyTest(this.impostor);
    }
  }

  /**
   * Patch a material's vertex shader with the residency test.
   *
   * `project_vertex` is the hook because `gl_Position` only exists after it —
   * the suppression has to move the vertex in CLIP space, and doing it in
   * object space (pushing `transformed` to a huge coordinate) would break as
   * soon as anything read the vertex position afterwards.
   */
  private installResidencyTest(material: THREE.Material): void {
    const residency = this.residency;
    const grid = CHUNK_GRID.toFixed(1);
    material.onBeforeCompile = (shader): void => {
      shader.uniforms[RESIDENCY_UNIFORM] = { value: residency };
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute float aChunkId;
uniform sampler2D ${RESIDENCY_UNIFORM};`
        )
        .replace(
          '#include <project_vertex>',
          `#include <project_vertex>
  if ( aChunkId < 65534.0 ) {
    float chunkCol = mod( aChunkId, ${grid} );
    float chunkRow = floor( aChunkId / ${grid} );
    vec2 residencyUv = ( vec2( chunkCol, chunkRow ) + 0.5 ) / ${grid};
    if ( texture2D( ${RESIDENCY_UNIFORM}, residencyUv ).r > 0.5 ) {
      // Outside the clip volume on every axis: the triangle is discarded
      // before rasterisation, with no fragment cost at all.
      gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    }
  }`
        );
    };
    material.needsUpdate = true;
  }

  /** Mark a chunk resident (its real geometry is in the scene). */
  setResident(chunk: number, resident: boolean): void {
    if (chunk < 0 || chunk >= this.residencyData.length) return;
    const value = resident ? 255 : 0;
    if (this.residencyData[chunk] === value) return;
    this.residencyData[chunk] = value;
    this.residency.needsUpdate = true;
  }

  /** Clear every residency bit. */
  clearResidency(): void {
    this.residencyData.fill(0);
    this.residency.needsUpdate = true;
  }

  /** Resident chunk count, for the debug overlay. */
  residentCount(): number {
    let count = 0;
    for (let i = 0; i < this.residencyData.length; i++) if (this.residencyData[i]! > 0) count++;
    return count;
  }

  /** Release the materials this instance created plus the residency texture. */
  dispose(): void {
    this.residency.dispose();
    if (this.ownsChunk) this.chunk.dispose();
    if (this.ownsImpostor) this.impostor.dispose();
  }
}
