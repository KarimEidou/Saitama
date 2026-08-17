/**
 * THE INSTANCED CROWD KEEPS ITS SKINNING
 *
 * The mid tier is not skinned by a skeleton — it reads its pose out of a vertex
 * animation texture through an `onBeforeCompile` injection (`applyVatSkinning`,
 * plus the wardrobe recolour chained onto it in `CrowdRenderer.patchPalette`).
 * `onBeforeCompile` is a SINGLE SLOT, and in a composed build several systems
 * want it — most importantly the cascade shadow system, which calls
 * `csm.setupMaterial()` on every lit material in the scene and assigns the slot
 * outright.
 *
 * When that adoption dropped the crowd's injection the symptom was precise and
 * survived every unit test in this directory: two hundred civilians standing in
 * BIND POSE, arms straight out, while the near tier walked past them correctly.
 * Nothing threw, nothing warned, and the crowd's own harness — which has no
 * shadow system — was green throughout.
 *
 * So the claim under test is not "the shader compiles". It is:
 *
 *   1. the VAT vertex injection is still applied after a third-party system has
 *      taken and returned the slot, and
 *   2. the material's program cache key still DISTINGUISHES it, because three
 *      keys its compiled-program cache on that string and a crowd material that
 *      shares a key with an ordinary lit material is handed that material's
 *      program — the same bind pose by a different route.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { addShaderHook, adoptAssignedHook, shaderHookKeys } from '@/engine/shader-hooks';

/** A minimal stand-in for the shader object three hands `onBeforeCompile`. */
function shaderStub(): THREE.WebGLProgramParametersWithUniforms {
  return {
    vertexShader: [
      '#include <common>',
      '#include <beginnormal_vertex>',
      '#include <begin_vertex>',
      '#include <color_vertex>',
      '#include <project_vertex>',
    ].join('\n'),
    fragmentShader: ['#include <common>', '#include <map_fragment>'].join('\n'),
    uniforms: {},
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
}

/** What `CrowdRenderer` produces: a direct assignment plus its own cache key. */
function vatLikeMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true });
  material.onBeforeCompile = (shader): void => {
    shader.uniforms.vatTexture = { value: null };
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  transformed = (vatSkinMatrix() * vec4(transformed, 1.0)).xyz;'
    );
  };
  material.customProgramCacheKey = (): string => 'crowd-vat-81x192-16';
  return material;
}

/** What `ShadowSystem.attachCsm` does, with CSM's assignment stubbed. */
function adoptCsm(material: THREE.Material, key = 'csm3'): void {
  const previous = Object.prototype.hasOwnProperty.call(material, 'onBeforeCompile')
    ? material.onBeforeCompile
    : undefined;
  material.onBeforeCompile = (shader): void => {
    shader.uniforms.CSM_cascades = { value: [] };
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      '#include <common>\nuniform vec2 CSM_cascades[3];'
    );
  };
  adoptAssignedHook(material, key, previous);
}

describe('crowd skinning survives cascade-shadow registration', () => {
  it('keeps the VAT vertex injection after CSM adopts the slot', () => {
    const material = vatLikeMaterial();
    adoptCsm(material);

    const shader = shaderStub();
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);

    // The bind-pose bug, stated as an assertion.
    expect(shader.vertexShader).toContain('vatSkinMatrix()');
    expect(shader.uniforms.vatTexture).toBeDefined();
    // And the shadow system's own contribution is still there.
    expect(shader.fragmentShader).toContain('CSM_cascades');
  });

  it('carries the material-assigned cache key into the composed key', () => {
    const material = vatLikeMaterial();
    const before = material.customProgramCacheKey();
    adoptCsm(material);
    const after = material.customProgramCacheKey();

    expect(after).toContain(before);
    expect(shaderHookKeys(material)).toEqual(['assigned', 'csm3']);
  });

  it('does not let a crowd material collide with an ordinary lit material', () => {
    const crowd = vatLikeMaterial();
    const plain = new THREE.MeshStandardMaterial();
    adoptCsm(crowd);
    adoptCsm(plain);

    // Two materials whose injected GLSL differs must not share a program.
    expect(crowd.customProgramCacheKey()).not.toBe(plain.customProgramCacheKey());
  });

  it('still composes normally when the slot already held a registered hook', () => {
    const material = new THREE.MeshStandardMaterial();
    addShaderHook(material, 'triplanar', (shader) => {
      shader.vertexShader = `// triplanar\n${shader.vertexShader}`;
    });
    adoptCsm(material);

    // No spurious 'assigned' entry: the previous callback WAS the dispatcher.
    expect(shaderHookKeys(material)).toEqual(['triplanar', 'csm3']);

    const shader = shaderStub();
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain('triplanar');
    expect(shader.fragmentShader).toContain('CSM_cascades');
  });

  it('survives a shadow-profile rebuild without duplicating the adopted hook', () => {
    const material = vatLikeMaterial();
    adoptCsm(material, 'csm3');
    // `ShadowSystem.teardown` removes only its own hook, then `build`
    // re-attaches. The foreign injection must not be adopted twice.
    const hooks = (material.userData as { engineShaderHooks: { key: string }[] }).engineShaderHooks;
    hooks.splice(
      hooks.findIndex((h) => h.key === 'csm3'),
      1
    );
    adoptCsm(material, 'csm2');

    expect(shaderHookKeys(material)).toEqual(['assigned', 'csm2']);
    const shader = shaderStub();
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader.match(/vatSkinMatrix/g)).toHaveLength(1);
  });
});
