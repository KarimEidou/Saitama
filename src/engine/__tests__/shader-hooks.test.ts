/**
 * `addShaderHook` MUST NOT EAT AN INJECTION THAT WAS ALREADY THERE
 *
 * Four systems in this repo assign `material.onBeforeCompile` directly — VAT
 * crowd skinning, the roster's face/tint pass, the city runtime and the
 * streamer's materials — and the hook registry is exported for exactly those
 * systems to build on. Installing the composed dispatcher over such a callback
 * used to discard it silently while KEEPING its `customProgramCacheKey`: the
 * bind-pose bug this module was written to prevent, reproduced from its own
 * documented entry point. `adoptAssignedHook` handled it; `addShaderHook`, the
 * obvious call, did not.
 *
 * The adoption now lives in `addShaderHook`, which means `adoptAssignedHook`
 * must NOT also register the same callback — hence the double-run test.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { addShaderHook, adoptAssignedHook, shaderHookKeys } from '../shader-hooks';

/** A minimal stand-in for the shader object three hands `onBeforeCompile`. */
function shaderStub(): THREE.WebGLProgramParametersWithUniforms {
  return {
    vertexShader: ['#include <common>', '#include <begin_vertex>'].join('\n'),
    fragmentShader: ['#include <common>', '#include <map_fragment>'].join('\n'),
    uniforms: {},
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
}

/** What `CrowdRenderer` produces: a direct assignment plus its own cache key. */
function vatLikeMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial();
  material.onBeforeCompile = (shader): void => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  transformed = (vatSkinMatrix() * vec4(transformed, 1.0)).xyz;'
    );
  };
  material.customProgramCacheKey = (): string => 'crowd-vat-81x192-16';
  return material;
}

describe('addShaderHook self-adoption', () => {
  it('keeps a directly-assigned onBeforeCompile when the dispatcher is installed', () => {
    const material = vatLikeMaterial();

    addShaderHook(material, 'dissolve', (shader) => {
      shader.fragmentShader = `// dissolve\n${shader.fragmentShader}`;
    });

    expect(shaderHookKeys(material)).toEqual(['assigned', 'dissolve']);

    const shader = shaderStub();
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain('vatSkinMatrix()');
    expect(shader.fragmentShader).toContain('dissolve');
    // The adopted callback's own cache key still distinguishes the material.
    expect(material.customProgramCacheKey()).toContain('crowd-vat-81x192-16');
  });

  it('invents no "assigned" entry for a material that had nothing in the slot', () => {
    const material = new THREE.MeshStandardMaterial();
    addShaderHook(material, 'triplanar', () => {});
    expect(shaderHookKeys(material)).toEqual(['triplanar']);
  });

  it('runs an adopted third-party callback exactly once when it had no predecessor', () => {
    // `ShadowSystem.attachCsm` on a material CSM is the first to touch: the
    // slot holds CSM's own callback and `previous` is undefined, so the
    // registry must not adopt it in addition to registering it.
    const material = new THREE.MeshStandardMaterial();
    let calls = 0;
    material.onBeforeCompile = (): void => {
      calls++;
    };

    adoptAssignedHook(material, 'csm3', undefined);

    expect(shaderHookKeys(material)).toEqual(['csm3']);
    material.onBeforeCompile(shaderStub(), {} as THREE.WebGLRenderer);
    expect(calls).toBe(1);
  });
});
