/**
 * VFX BASE GEOMETRY
 *
 * Two shapes, built once and shared by every instance of everything.
 *
 *   quad       a unit square. Every sprite in the game is this, four vertices,
 *              positioned entirely by the vertex shader from instance data.
 *   arc grid   a (u, v) lattice. The shockwave's real shape — a 22-degree
 *              punch cone or a full 360-degree ring — is computed per vertex
 *              in the shader, so the same lattice serves both and no geometry
 *              is ever rebuilt at runtime.
 */

import * as THREE from 'three';

/**
 * A unit quad centred on the origin, as an `InstancedBufferGeometry`.
 *
 * `position` carries corners in [-0.5, 0.5] and `uv` the usual 0..1. No
 * `normal` attribute: nothing here is lit by three, and an unused attribute is
 * a vertex-fetch cost paid on every particle of every frame.
 */
export function createQuadGeometry(): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.name = 'vfx.quad';
  // prettier-ignore
  const positions = new Float32Array([
    -0.5, -0.5, 0,
     0.5, -0.5, 0,
     0.5,  0.5, 0,
    -0.5,  0.5, 0,
  ]);
  // prettier-ignore
  const uvs = new Float32Array([
    0, 0,
    1, 0,
    1, 1,
    0, 1,
  ]);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  // Positions are instance data, so the geometry's own bounds are meaningless.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
  return geometry;
}

/**
 * A (u, v) lattice for the shockwave shell.
 *
 * `position.x` is u — around the arc; `position.y` is v — across the wave's
 * thickness, with 1 at the leading edge. `position.z` is unused and stays 0.
 *
 * @param arcSegments    Subdivisions around the arc. Drives how smooth a
 *                       180-metre ring's silhouette is; the dominant cost.
 * @param radialSegments Subdivisions across the thickness. Four is enough for
 *                       the profile to interpolate cleanly.
 */
export function createArcGridGeometry(
  arcSegments: number,
  radialSegments: number
): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.name = `vfx.arcGrid.${arcSegments}x${radialSegments}`;

  const columns = arcSegments + 1;
  const rows = radialSegments + 1;
  const positions = new Float32Array(columns * rows * 3);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const index = (row * columns + column) * 3;
      positions[index] = column / arcSegments;
      positions[index + 1] = row / radialSegments;
      positions[index + 2] = 0;
    }
  }

  const indices = new Uint16Array(arcSegments * radialSegments * 6);
  let cursor = 0;
  for (let row = 0; row < radialSegments; row++) {
    for (let column = 0; column < arcSegments; column++) {
      const a = row * columns + column;
      const b = a + 1;
      const c = a + columns;
      const d = c + 1;
      indices[cursor++] = a;
      indices[cursor++] = c;
      indices[cursor++] = b;
      indices[cursor++] = b;
      indices[cursor++] = c;
      indices[cursor++] = d;
    }
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
  return geometry;
}

/** A clip-space-filling quad for the speedline overlay. */
export function createFullScreenGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.name = 'vfx.fullscreen';
  // prettier-ignore
  const positions = new Float32Array([
    -1, -1, 0,
     3, -1, 0,
    -1,  3, 0,
  ]);
  // One oversized triangle rather than two: half the vertices, no diagonal
  // seam, and the rasteriser clips the overhang for free.
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
  return geometry;
}
