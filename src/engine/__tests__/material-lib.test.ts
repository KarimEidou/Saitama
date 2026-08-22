/**
 * WHAT THE MATERIAL LIBRARY IS AND IS NOT ALLOWED TO TOUCH
 *
 * Three claims this file pins down:
 *
 *   1. Textures resolved through the registry belong to the registry.
 *      `colorSpace` and `anisotropy` are per-texture-object state, and the same
 *      page is legitimately a colour map for one material and an ORM/normal map
 *      for another. Writing either in place makes the LAST acquire win and puts
 *      one of the two materials a full gamma out, with no diagnostic.
 *   2. The duplicate-id guard has to compare the fields that actually build the
 *      material. `uvRepeat` is the one most likely to differ between two call
 *      sites reusing an id, and it was not compared at all.
 *   3. The triplanar normal splice replaces three's `<normal_fragment_maps>`
 *      wholesale, so it has to carry three's double-sided face handling itself.
 */

import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { applyInstanceVariation, MaterialLib } from '../material-lib';

function pixelTexture(r = 255, g = 255, b = 255): THREE.DataTexture {
  return new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1);
}

/** The splice points the injection anchors on, in meshphysical's order. */
function shaderStub(): THREE.WebGLProgramParametersWithUniforms {
  return {
    vertexShader: ['#include <common>', '#include <fog_vertex>'].join('\n'),
    fragmentShader: [
      '#include <common>',
      '#include <map_fragment>',
      '#include <roughnessmap_fragment>',
      '#include <metalnessmap_fragment>',
      '#include <normal_fragment_maps>',
      '#include <lights_fragment_maps>',
    ].join('\n'),
    uniforms: {},
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
}

describe('MaterialLib texture ownership', () => {
  it('never retags a texture it does not own', () => {
    // One shared page bound as albedo AND as a normal map — the aliasing case.
    const shared = pixelTexture();
    shared.colorSpace = THREE.NoColorSpace;
    shared.anisotropy = 1;

    const lib = new MaterialLib({ anisotropy: 4 });
    const material = lib.acquire({
      spec: { id: 'mat.shared', kind: 'standard' },
      textures: { map: shared, normalMap: shared },
    }) as THREE.MeshStandardMaterial;

    // Each slot gets the colour space it needs...
    expect(material.map?.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(material.normalMap?.colorSpace).toBe(THREE.NoColorSpace);
    expect(material.map?.anisotropy).toBe(4);
    // ...and the object the caller still owns is exactly as it was.
    expect(shared.colorSpace).toBe(THREE.NoColorSpace);
    expect(shared.anisotropy).toBe(1);
    expect(material.map).not.toBe(shared);
    // Cloning shares `source`, so no image data is duplicated on the CPU.
    expect(material.map?.source).toBe(shared.source);

    lib.dispose();
  });

  it('hands back the original when nothing about it has to change', () => {
    const texture = pixelTexture();
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;

    const lib = new MaterialLib({ anisotropy: 4 });
    const material = lib.acquire({
      spec: { id: 'mat.exact', kind: 'standard' },
      textures: { map: texture },
    }) as THREE.MeshStandardMaterial;

    expect(material.map).toBe(texture);
    lib.dispose();
  });

  it('drops the shared damage-mask uniform on dispose', () => {
    const lib = new MaterialLib();
    const material = lib.acquire({
      spec: { id: 'mat.dusty', kind: 'standard' },
      features: { damageMask: true },
    });
    const shader = shaderStub();
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    const uniform = shader.uniforms.uEngineDamageMask as { value: THREE.Texture | null };
    expect(uniform.value).not.toBeNull();

    // `globals` escaped by reference; leaving a disposed texture in the slot has
    // three re-upload it from its retained JS array on the next bind.
    lib.dispose();
    expect(uniform.value).toBeNull();
  });
});

describe('MaterialLib duplicate-id guard', () => {
  it('warns when one id is acquired with two different uvRepeats', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lib = new MaterialLib();

    lib.acquire({ spec: { id: 'mat.concrete', kind: 'standard', uvRepeat: [8, 8] } });
    expect(warn).not.toHaveBeenCalled();

    // A bollard reusing the road's id would silently inherit 8x8 tiling.
    lib.acquire({ spec: { id: 'mat.concrete', kind: 'standard', uvRepeat: [1, 1] } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[1])).toContain('two different specs');

    warn.mockRestore();
    lib.dispose();
  });

  it('stays quiet for two equivalent specs', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lib = new MaterialLib();

    lib.acquire({
      spec: { id: 'mat.brick', kind: 'standard', uvRepeat: [4, 4], normalScale: 0.8 },
    });
    lib.acquire({
      spec: { id: 'mat.brick', kind: 'standard', uvRepeat: [4, 4], normalScale: 0.8 },
    });

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    lib.dispose();
  });
});

describe('triplanar normal splice', () => {
  it("keeps three's double-sided face-direction handling", () => {
    const lib = new MaterialLib();
    const material = lib.acquire({
      spec: { id: 'mat.terrain', kind: 'standard', side: 'double' },
      features: { triplanar: true },
      textures: { map: pixelTexture(), normalMap: pixelTexture(128, 128, 255) },
    });

    const shader = shaderStub();
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);

    // The stock chunk it replaces gets its facing term from `tbn`; this one
    // rebuilds the normal from the geometric world normal and has to apply it.
    expect(shader.fragmentShader).not.toContain('#include <normal_fragment_maps>');
    expect(shader.fragmentShader).toContain('#ifdef DOUBLE_SIDED');
    expect(shader.fragmentShader).toContain('tpNormal *= faceDirection;');

    lib.dispose();
  });
});

describe('applyInstanceVariation', () => {
  it('warns when two InstancedMeshes of different sizes share one geometry', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial();
    const big = new THREE.InstancedMesh(geometry, material, 400);
    const small = new THREE.InstancedMesh(geometry, material, 120);
    const random = (): number => 0.5;

    applyInstanceVariation(big, random);
    expect(warn).not.toHaveBeenCalled();

    // The second call replaces the first mesh's attribute: instances 120..399
    // of `big` now read off the end of the buffer and tint to black.
    applyInstanceVariation(small, random);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[1])).toContain('past 120 black');

    warn.mockRestore();
  });
});
