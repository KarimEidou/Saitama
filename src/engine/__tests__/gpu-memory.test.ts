/**
 * THE MEMORY REPORT HAS TO BE RIGHT IN BOTH DIRECTIONS
 *
 * `estimateSceneMemory` exists to catch a budget being blown. A number that
 * over-reports interleaved geometry threefold while ignoring instance matrices
 * entirely is not conservative — it is wrong twice, and it is wrong exactly
 * where a real city scene lives: glTF-loaded props use interleaved buffers, and
 * a crowd's `instanceMatrix` is 64 bytes per copy of pure GPU memory that hangs
 * off the mesh rather than the geometry.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { estimateSceneMemory } from '../gpu-memory';

describe('estimateSceneMemory geometry accounting', () => {
  it('counts an interleaved vertex buffer once, not once per attribute view', () => {
    // position(3) + normal(3) + uv(2) = 8 floats per vertex, over 3 vertices —
    // the standard packed-prop layout, and ONE upload as far as three is
    // concerned because it keys its GPU buffer on the InterleavedBuffer.
    const data = new Float32Array(8 * 3);
    const interleaved = new THREE.InterleavedBuffer(data, 8);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.InterleavedBufferAttribute(interleaved, 3, 0));
    geometry.setAttribute('normal', new THREE.InterleavedBufferAttribute(interleaved, 3, 3));
    geometry.setAttribute('uv', new THREE.InterleavedBufferAttribute(interleaved, 2, 6));

    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));

    expect(estimateSceneMemory(scene).geometryBytes).toBe(data.byteLength);
  });

  it('still counts separate attributes separately', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(9), 3));

    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));

    expect(estimateSceneMemory(scene).geometryBytes).toBe(9 * 4 * 2);
  });

  it('counts the instance matrix, which lives on the mesh and not the geometry', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    const scene = new THREE.Scene();
    scene.add(new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial(), 100));

    const report = estimateSceneMemory(scene);
    expect(report.instanceCount).toBe(100);
    // 9 position floats plus a 16-float matrix per instance.
    expect(report.geometryBytes).toBe(9 * 4 + 100 * 16 * 4);
  });
});
