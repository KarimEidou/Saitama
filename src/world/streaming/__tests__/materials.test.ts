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

import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { CHUNK_GRID } from '@/spatial/constants';
import { resetLogState } from '@/util';
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

  it('warns once instead of silently disabling suppression on a hookless material', () => {
    // A ShaderMaterial has neither `#include`, so both `String.replace` calls
    // would return their input unchanged and report nothing — the impostor then
    // draws over every streamed chunk for the rest of the session.
    resetLogState();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = new THREE.ShaderMaterial({
      vertexShader: 'void main(){ gl_Position = vec4(0.0); }',
      fragmentShader: 'void main(){ gl_FragColor = vec4(1.0); }',
    });
    const materials = new StreamingMaterials({ impostorMaterial: raw });

    const shader = {
      uniforms: {},
      vertexShader: raw.vertexShader,
      fragmentShader: raw.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    raw.onBeforeCompile(shader, renderer);
    raw.onBeforeCompile(shader, renderer);

    // Once, not once per compile: a warning fired from a hot path is its own
    // performance problem.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(shader.vertexShader).not.toContain('aChunkId');
    expect(shader.uniforms['uResidency']).toBeUndefined();

    warn.mockRestore();
    materials.dispose();
    raw.dispose();
  });
});

describe('material ownership', () => {
  it('names only the materials it creates', () => {
    const owned = new StreamingMaterials();
    expect(owned.chunk.name).toBe('streaming.chunk');
    expect(owned.impostor.name).toBe('streaming.impostor');
    owned.dispose();

    // An injected material's name may key a material-library lookup or a debug
    // filter. `ownsChunk`/`ownsImpostor` already gate disposal; naming was the
    // one place they were ignored.
    const mine = new THREE.MeshLambertMaterial({ vertexColors: true });
    mine.name = 'city.facade';
    const injected = new StreamingMaterials({ chunkMaterial: mine });
    expect(injected.chunk).toBe(mine);
    expect(mine.name).toBe('city.facade');
    injected.dispose();
    mine.dispose();
  });

  it('disposes only the materials it created', () => {
    let disposed = false;
    const mine = new THREE.MeshBasicMaterial();
    mine.addEventListener('dispose', () => {
      disposed = true;
    });

    const materials = new StreamingMaterials({ impostorMaterial: mine });
    materials.dispose();
    expect(disposed).toBe(false);

    mine.dispose();
    expect(disposed).toBe(true);
  });
});

describe('the residency grid', () => {
  it('writes the grid and bumps the texture version only on a change', () => {
    const materials = new StreamingMaterials();
    const data = materials.residency.image.data as Uint8Array;

    const v0 = materials.residency.version;
    materials.setResident(5, true);
    expect(data[5]).toBe(255);
    expect(materials.residentCount()).toBe(1);
    // `THREE.Texture.needsUpdate` is a setter with no getter, so the upload is
    // only observable through `version`.
    expect(materials.residency.version).toBeGreaterThan(v0);

    const v1 = materials.residency.version;
    materials.setResident(5, true);
    expect(materials.residency.version).toBe(v1);

    // Out of range on both ends: 256 bytes of texture, and a stray write would
    // suppress the wrong chunk or corrupt neighbouring texels.
    materials.setResident(-1, true);
    materials.setResident(CHUNK_GRID * CHUNK_GRID, true);
    expect(materials.residentCount()).toBe(1);

    materials.clearResidency();
    expect(materials.residentCount()).toBe(0);
    expect(data[5]).toBe(0);
    materials.dispose();
  });
});
