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
import type { IAssetRegistry, TextureHandle } from '@/types';
import { applyInstanceVariation, hasSpecularOnlyEnvironment, MaterialLib } from '../material-lib';
import { hasShaderHooks, shaderHookKeys } from '../shader-hooks';
import { featureDefines, featureKey, hasAnyFeature, NO_FEATURES } from '../shader-chunks';

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

/*
 * ── THE LIBRARY'S OBSERVABLE CONTRACT ──────────────────────────────────────
 *
 * `material-lib.ts` is the only thing defending the "<= 24 distinct shader
 * programs" whole-game budget its header describes, and its observable surface
 * — one material per id, the signature counter, the injection gating, the
 * by-reference global uniforms — is pure JS. Before these cases a refactor
 * could silently turn "one material per id" into "one per acquire" and every
 * test in the repo would stay green.
 */

/** Compile a material against a fresh stub and hand the stub back. */
function run(
  material: THREE.Material,
  shader: THREE.WebGLProgramParametersWithUniforms = shaderStub()
): THREE.WebGLProgramParametersWithUniforms {
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return shader;
}

/** A registry that resolves every key to one retained handle. */
function fakeRegistry(): {
  registry: IAssetRegistry;
  handle: TextureHandle;
  retain: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  const texture = pixelTexture();
  const retain = vi.fn(() => handle);
  const release = vi.fn();
  const handle = { texture, retain, release } as unknown as TextureHandle;
  const registry = { getTexture: () => handle } as unknown as IAssetRegistry;
  return { registry, handle, retain, release };
}

describe('MaterialLib caching', () => {
  it('returns one material per id, never one per acquire', () => {
    const lib = new MaterialLib();
    const first = lib.acquire({ spec: { id: 'mat.one', kind: 'standard' } });
    const second = lib.acquire({ spec: { id: 'mat.one', kind: 'standard' } });

    expect(second).toBe(first);
    expect(lib.size).toBe(1);
    expect(lib.get('mat.one')).toBe(first);
    expect(lib.has('mat.one')).toBe(true);
    expect(lib.get('mat.absent')).toBeUndefined();

    lib.dispose();
  });

  it('warns on a conflicting spec and lets the first one win', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lib = new MaterialLib();

    const first = lib.acquire({ spec: { id: 'm', kind: 'standard', color: 0xff0000 } });
    const second = lib.acquire({ spec: { id: 'm', kind: 'standard', color: 0x00ff00 } });

    expect(second).toBe(first);
    expect((first as THREE.MeshStandardMaterial).color.getHex()).toBe(0xff0000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[1])).toContain('two different specs');

    warn.mockRestore();
    lib.dispose();
  });

  it('empties itself on dispose', () => {
    const lib = new MaterialLib();
    lib.acquire({ spec: { id: 'mat.gone', kind: 'standard' } });

    lib.dispose();

    expect(lib.size).toBe(0);
    expect(lib.get('mat.gone')).toBeUndefined();
    expect(lib.programCount).toBe(0);
  });
});

describe('MaterialLib program budget', () => {
  it('collapses identically-shaped materials onto one signature', () => {
    const lib = new MaterialLib();
    for (const id of ['a', 'b', 'c']) lib.acquire({ spec: { id, kind: 'standard' } });

    expect(lib.size).toBe(3);
    // Fifty materials that bind the same maps are ONE program; that is the
    // whole argument for this class existing.
    expect(lib.programCount).toBe(1);
    const [signature] = [...lib.programSignatures.keys()];
    expect(lib.programSignatures.get(signature!)).toBe(3);

    lib.dispose();
  });

  it('counts a different map set as a different program', () => {
    const lib = new MaterialLib();
    for (const id of ['a', 'b', 'c']) lib.acquire({ spec: { id, kind: 'standard' } });
    lib.acquire({ spec: { id: 'd', kind: 'standard' }, textures: { normalMap: pixelTexture() } });

    expect(lib.programCount).toBe(2);
    lib.dispose();
  });

  it('warns once, at the moment the offending material is created', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lib = new MaterialLib({ programBudget: 1 });

    lib.acquire({ spec: { id: 'a', kind: 'standard' } });
    lib.acquire({ spec: { id: 'b', kind: 'standard' }, textures: { map: pixelTexture() } });

    const budgetCalls = (): number =>
      warn.mock.calls.filter((call) => String(call[1]).includes('program budget exceeded')).length;
    expect(budgetCalls()).toBe(1);

    // `budgetWarned` latches: one warning per library, not one per material.
    lib.acquire({ spec: { id: 'c', kind: 'standard' }, textures: { normalMap: pixelTexture() } });
    expect(budgetCalls()).toBe(1);

    warn.mockRestore();
    lib.dispose();
  });

  it('puts vertexColors on the material and in the signature', () => {
    const lib = new MaterialLib();
    const material = lib.acquire({
      spec: { id: 'mat.debris', kind: 'standard' },
      vertexColors: true,
    });

    expect(material.vertexColors).toBe(true);
    expect([...lib.programSignatures.keys()][0]).toContain('V');

    lib.dispose();
  });
});

describe('MaterialLib injection gating', () => {
  it('refuses injections on a non-PBR kind rather than silently no-op', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lib = new MaterialLib();

    // The splice points are meshphysical chunk names; the replace would find
    // nothing in a toon shader and the injection would vanish without a word.
    const material = lib.acquire({
      spec: { id: 'mat.toon', kind: 'toon' },
      features: { damageMask: true },
    });

    expect(hasShaderHooks(material)).toBe(false);
    expect(material.defines?.ENGINE_DAMAGE_MASK).toBeUndefined();
    expect(String(warn.mock.calls[0]?.[1])).toContain('injections apply to');

    warn.mockRestore();
    lib.dispose();
  });

  it('refuses triplanar without an albedo map, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lib = new MaterialLib();

    const material = lib.acquire({
      spec: { id: 'mat.terrain', kind: 'standard' },
      features: { triplanar: true },
    });

    // Without a map the injected GLSL references an undeclared sampler and the
    // material fails to compile.
    expect(material.defines?.ENGINE_TRIPLANAR).toBeUndefined();
    expect(String(warn.mock.calls[0]?.[1])).toContain('without an');
    // Every standard material still carries a hook: the specular-only toggle
    // is global and has to reach all of them.
    expect(hasShaderHooks(material)).toBe(true);
    expect(shaderHookKeys(material)[0]).toMatch(/^mat/);

    warn.mockRestore();
    lib.dispose();
  });

  it('injects triplanar at the documented splice points when a map is bound', () => {
    const lib = new MaterialLib();
    const material = lib.acquire({
      spec: { id: 'mat.terrain', kind: 'standard' },
      features: { triplanar: true },
      textures: { map: pixelTexture() },
    });

    expect(material.defines?.ENGINE_TRIPLANAR).toBe('1');

    const shader = run(material);
    expect(shader.vertexShader).toContain('vEngineWorldNormal');
    expect(shader.fragmentShader).toContain('tpBlend');
    expect(shader.fragmentShader).not.toContain('#include <map_fragment>');
    expect((shader.uniforms.uEngineTriplanarScale as { value: number }).value).toBe(0.25);

    const custom = lib.acquire({
      spec: { id: 'mat.terrain2', kind: 'standard' },
      features: { triplanar: true },
      triplanarScale: 0.5,
      textures: { map: pixelTexture() },
    });
    expect((run(custom).uniforms.uEngineTriplanarScale as { value: number }).value).toBe(0.5);

    lib.dispose();
  });
});

describe('MaterialLib global uniforms', () => {
  it('shares one uniform object across every injected material', () => {
    const lib = new MaterialLib();
    const a = lib.acquire({ spec: { id: 'a', kind: 'standard' }, features: { damageMask: true } });
    const b = lib.acquire({ spec: { id: 'b', kind: 'standard' }, features: { damageMask: true } });

    const sa = run(a);
    const sb = run(b);

    // BY REFERENCE — this is the class's central claim. One write updates every
    // material in the scene with no traversal and no per-material bookkeeping.
    expect(sa.uniforms.uEngineDamageMask).toBe(sb.uniforms.uEngineDamageMask);
    expect(sa.uniforms.uEngineDustAmount).toBe(sb.uniforms.uEngineDustAmount);

    lib.setDustAmount(0.7);
    expect((sa.uniforms.uEngineDustAmount as { value: number }).value).toBe(0.7);
    expect((sb.uniforms.uEngineDustAmount as { value: number }).value).toBe(0.7);

    lib.dispose();
  });

  it('keeps a neutral 1x1 placeholder in the damage-mask slot', () => {
    const lib = new MaterialLib();
    const material = lib.acquire({
      spec: { id: 'a', kind: 'standard' },
      features: { damageMask: true },
    });
    const shader = run(material);

    lib.setDamageMask(pixelTexture(), 0, 0, 256, 256);
    const rect = shader.uniforms.uEngineDamageRect as { value: THREE.Vector4 };
    expect(rect.value.z).toBe(1 / 256);
    expect(rect.value.w).toBe(1 / 256);

    // A null sampler binds three's internal empty texture, whose contents are
    // undefined: materials would sample garbage dust.
    lib.setDamageMask(null);
    const mask = shader.uniforms.uEngineDamageMask as { value: THREE.Texture | null };
    expect(mask.value).not.toBeNull();
    expect((mask.value!.image as { width: number }).width).toBe(1);

    lib.dispose();
  });
});

describe('MaterialLib global switches', () => {
  it('reaches existing and future materials with specular-only environment', () => {
    const lib = new MaterialLib();
    const a = lib.acquire({ spec: { id: 'a', kind: 'standard' } });

    lib.setSpecularOnlyEnvironment(true);
    expect(hasSpecularOnlyEnvironment(a)).toBe(true);

    const b = lib.acquire({ spec: { id: 'b', kind: 'standard' } });
    expect(hasSpecularOnlyEnvironment(b)).toBe(true);
    expect(run(b).fragmentShader).toContain('iblIrradiance = vec3( 0.0 );');

    lib.setSpecularOnlyEnvironment(false);
    expect(hasSpecularOnlyEnvironment(a)).toBe(false);
    expect(hasSpecularOnlyEnvironment(b)).toBe(false);
    expect(run(b).fragmentShader).not.toContain('iblIrradiance = vec3( 0.0 );');

    lib.dispose();
  });

  it('notifies observers about existing and later materials, until unsubscribed', () => {
    const lib = new MaterialLib();
    lib.acquire({ spec: { id: 'before', kind: 'standard' } });

    const seen = vi.fn();
    const unsubscribe = lib.onMaterialCreated(seen);
    // Fires immediately for what already exists — how the shadow system
    // attaches CSM without either system importing the other.
    expect(seen.mock.calls.map((call) => call[1])).toEqual(['before']);

    lib.acquire({ spec: { id: 'after', kind: 'standard' } });
    expect(seen.mock.calls.map((call) => call[1])).toEqual(['before', 'after']);

    unsubscribe();
    lib.acquire({ spec: { id: 'later', kind: 'standard' } });
    expect(seen).toHaveBeenCalledTimes(2);

    lib.dispose();
  });

  it('sets envMapIntensity on PBR materials and skips those without it', () => {
    const lib = new MaterialLib();
    const standard = lib.acquire({ spec: { id: 'pbr', kind: 'standard' } });
    const basic = lib.acquire({ spec: { id: 'flat', kind: 'basic' } });

    lib.setEnvMapIntensity(0.4);

    expect((standard as THREE.MeshStandardMaterial).envMapIntensity).toBe(0.4);
    // `MeshBasicMaterial` has no such field; writing one would create it.
    expect('envMapIntensity' in basic).toBe(false);

    lib.dispose();
  });
});

describe('MaterialLib texture resolution', () => {
  it('binds the visible placeholder when a key does not resolve', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lib = new MaterialLib();

    const material = lib.acquire({
      spec: { id: 'mat.broken', kind: 'standard', mapKey: 'tex.nope' },
    }) as THREE.MeshStandardMaterial;

    // Binding nothing renders flat white and looks deliberate, so broken
    // material wiring ships.
    expect(material.map).not.toBeNull();
    expect(material.map!.name).toBe('texture.missing');
    expect(String(warn.mock.calls[0]?.[1])).toContain('is not resident');

    warn.mockRestore();
    lib.dispose();
  });

  it('retains a registry handle on acquire and releases it on dispose', () => {
    const { registry, retain, release } = fakeRegistry();
    const lib = new MaterialLib({ registry });

    lib.acquire({ spec: { id: 'mat.real', kind: 'standard', mapKey: 'tex.wall' } });
    expect(retain).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();

    lib.dispose();
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('shader-chunks feature helpers', () => {
  it('encodes a feature set as a stable key', () => {
    expect(featureKey({ triplanar: true, instanceVariation: false, damageMask: true })).toBe('T-D');
    expect(featureKey(NO_FEATURES)).toBe('---');
    expect(hasAnyFeature(NO_FEATURES)).toBe(false);
    expect(hasAnyFeature({ ...NO_FEATURES, damageMask: true })).toBe(true);
  });

  it('emits exactly one define per set flag', () => {
    expect(featureDefines(NO_FEATURES)).toEqual({});
    expect(featureDefines({ triplanar: true, instanceVariation: true, damageMask: true })).toEqual({
      ENGINE_TRIPLANAR: '1',
      ENGINE_INSTANCE_VARIATION: '1',
      ENGINE_DAMAGE_MASK: '1',
    });
    expect(featureDefines({ ...NO_FEATURES, instanceVariation: true })).toEqual({
      ENGINE_INSTANCE_VARIATION: '1',
    });
  });
});
