/**
 * THE IMPOSTOR MATERIAL'S ONE SHARED SLOT
 *
 * `IStreamingMaterialOptions.impostorMaterial` explicitly invites a material
 * from somewhere else — the material library, or one the shadow system has
 * already registered — and `THREE.Material.onBeforeCompile` is a SINGLE SLOT
 * that at least three systems want. Assigning it outright deletes whatever was
 * there with no error anywhere; the symptom is a horizon rendering three times
 * too bright, because CSM's cascade uniforms quietly stopped being installed.
 *
 * These tests pin both directions of the shared convention, which is the only
 * thing that makes the slot safe: streaming arriving first, and streaming
 * arriving second.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { StreamingMaterials } from '../materials';

/** The smallest thing the residency injection will accept. */
function makeShader(): THREE.WebGLProgramParametersWithUniforms {
  return {
    uniforms: {},
    vertexShader: '#include <common>\nvoid main() {\n#include <project_vertex>\n}',
    fragmentShader: 'void main() {}',
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
}

const renderer = {} as THREE.WebGLRenderer;

/** One record in the composed dispatcher's hook list. */
interface IEngineHook {
  readonly key: string;
  readonly fn: (
    shader: THREE.WebGLProgramParametersWithUniforms,
    renderer: THREE.WebGLRenderer
  ) => void;
}

describe('injected impostor material', () => {
  it('adopts a hook already in the slot instead of deleting it', () => {
    const injected = new THREE.MeshLambertMaterial({ vertexColors: true });
    const ran: string[] = [];
    injected.onBeforeCompile = (shader): void => {
      ran.push('prior');
      shader.vertexShader = `// prior-hook\n${shader.vertexShader}`;
    };
    injected.customProgramCacheKey = (): string => 'csm:3';

    const materials = new StreamingMaterials({ impostorMaterial: injected });
    const shader = makeShader();
    injected.onBeforeCompile(shader, renderer);

    // Both injections ran, in registration order.
    expect(ran).toEqual(['prior']);
    expect(shader.vertexShader).toContain('// prior-hook');
    expect(shader.vertexShader).toContain('uResidency');
    expect(shader.uniforms['uResidency']).toBeDefined();

    // And the cache key describes both, or three hands one material the
    // other's compiled program.
    const key = injected.customProgramCacheKey();
    expect(key).toContain('csm:3');
    expect(key).toContain('streaming.residency');

    materials.dispose();
    injected.dispose();
  });

  it('appends to a dispatcher another system installed first', () => {
    const injected = new THREE.MeshLambertMaterial({ vertexColors: true });
    const ran: string[] = [];
    // The shape the renderer workstream parks on `userData`. Streaming cannot
    // import that module — a system depends on `@/types` and `@/util` only — so
    // interop is by convention, and this is the convention.
    const hooks: IEngineHook[] = [
      {
        key: 'engine.night',
        fn: (shader): void => {
          ran.push('engine');
          shader.vertexShader = `// engine-hook\n${shader.vertexShader}`;
        },
      },
    ];
    injected.userData['engineShaderHooks'] = hooks;
    injected.onBeforeCompile = (shader, r): void => {
      for (const hook of hooks) hook.fn(shader, r);
    };
    injected.customProgramCacheKey = (): string => 'engine:engine.night|';

    const materials = new StreamingMaterials({ impostorMaterial: injected });
    const shader = makeShader();
    injected.onBeforeCompile(shader, renderer);

    // Streaming appended rather than replacing: the existing dispatcher is
    // still the one in the slot, and it now runs two hooks.
    expect(hooks.length).toBe(2);
    expect(ran).toEqual(['engine']);
    expect(shader.vertexShader).toContain('// engine-hook');
    expect(shader.vertexShader).toContain('uResidency');

    materials.dispose();
    injected.dispose();
  });

  it('still installs the residency test on its own default material', () => {
    const materials = new StreamingMaterials();
    const shader = makeShader();
    materials.impostor.onBeforeCompile(shader, renderer);
    expect(shader.vertexShader).toContain('uResidency');
    expect(shader.vertexShader).toContain('aChunkId');
    materials.dispose();
  });

  it('leaves the slot untouched when suppression is disabled', () => {
    const materials = new StreamingMaterials({ disableImpostorSuppression: true });
    const shader = makeShader();
    materials.impostor.onBeforeCompile(shader, renderer);
    expect(shader.vertexShader).not.toContain('uResidency');
    materials.dispose();
  });
});
