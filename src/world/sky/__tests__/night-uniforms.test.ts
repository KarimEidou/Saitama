/**
 * SHARED NIGHT UNIFORM TESTS
 *
 * The composition test at the bottom is a REGRESSION test for a bug that was
 * caught by looking at a screenshot rather than by any assertion: the shadow
 * system adopts a plain `onBeforeCompile` into its own hook chain and, in
 * doing so, dropped this module's emissive injection entirely. Every street
 * lamp and window in the city stayed dark at midnight and nothing failed.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { NightUniforms } from '../night-uniforms';

/** A stand-in for the three shader object `onBeforeCompile` receives. */
function fakeShader(): THREE.WebGLProgramParametersWithUniforms {
  return {
    uniforms: {},
    vertexShader: [
      '#include <common>',
      'void main() {',
      '  vec3 transformed = position;',
      '  #include <fog_vertex>',
      '}',
    ].join('\n'),
    fragmentShader: [
      '#include <common>',
      'void main() {',
      '  vec3 totalEmissiveRadiance = emissive;',
      '  #include <emissivemap_fragment>',
      '}',
    ].join('\n'),
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
}

function compile(material: THREE.Material): THREE.WebGLProgramParametersWithUniforms {
  const shader = fakeShader();
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return shader;
}

describe('NightUniforms', () => {
  it('shares ONE uniform object across every attached material', () => {
    const uniforms = new NightUniforms();
    const lamp = new THREE.MeshStandardMaterial();
    const window = new THREE.MeshStandardMaterial();
    uniforms.attach(lamp, 'lamp');
    uniforms.attach(window, 'window');

    const lampShader = compile(lamp);
    const windowShader = compile(window);

    // Identity, not equality: one write must move every lit surface.
    expect(lampShader.uniforms.uNightFactor).toBe(uniforms.uNightFactor);
    expect(windowShader.uniforms.uNightFactor).toBe(uniforms.uNightFactor);
    expect(lampShader.uniforms.uNightFactor).toBe(windowShader.uniforms.uNightFactor);

    uniforms.update(0.7, 0.4, 12);
    expect(lampShader.uniforms.uNightFactor!.value).toBe(0.7);
    expect(windowShader.uniforms.uWindowLitFraction!.value).toBe(0.4);
  });

  it('injects the lamp term for lamps and the window term for windows', () => {
    const uniforms = new NightUniforms();
    const lamp = new THREE.MeshStandardMaterial();
    const window = new THREE.MeshStandardMaterial();
    uniforms.attach(lamp, 'lamp');
    uniforms.attach(window, 'window');

    expect(compile(lamp).fragmentShader).toContain('uLampColor * uLampIntensity * uNightFactor');
    expect(compile(window).fragmentShader).toContain('uWindowColor * uWindowIntensity * uNightFactor');
    expect(compile(lamp).fragmentShader).not.toContain('uWindowLitFraction');
  });

  it('declares the world-position varying on both stages', () => {
    const uniforms = new NightUniforms();
    const material = new THREE.MeshStandardMaterial();
    uniforms.attach(material, 'lamp');
    const shader = compile(material);
    expect(shader.vertexShader).toContain('varying vec3 vSkyWorldPos;');
    expect(shader.vertexShader).toContain('vSkyWorldPos = (modelMatrix');
    expect(shader.fragmentShader).toContain('varying vec3 vSkyWorldPos;');
  });

  it('is idempotent per material', () => {
    const uniforms = new NightUniforms();
    const material = new THREE.MeshStandardMaterial();
    uniforms.attach(material, 'lamp');
    uniforms.attach(material, 'lamp');
    uniforms.attach(material, 'window');
    expect(uniforms.materialCount).toBe(1);

    const shader = compile(material);
    // Exactly one injection, not three.
    expect(shader.fragmentShader.split('uLampIntensity * uNightFactor').length - 1).toBe(1);
  });

  it('gives lamp and window materials DIFFERENT program cache keys', () => {
    // Without this, three hands the window material the lamp's cached program.
    const uniforms = new NightUniforms();
    const lamp = new THREE.MeshStandardMaterial();
    const window = new THREE.MeshStandardMaterial();
    uniforms.attach(lamp, 'lamp');
    uniforms.attach(window, 'window');
    expect(lamp.customProgramCacheKey()).not.toBe(window.customProgramCacheKey());
    expect(lamp.customProgramCacheKey()).toContain('skyNight:lamp');
  });
});

describe('onBeforeCompile composition — the regression', () => {
  it('does not lose a hook assigned BEFORE it', () => {
    const uniforms = new NightUniforms();
    const material = new THREE.MeshStandardMaterial();

    let otherRan = false;
    material.onBeforeCompile = (shader) => {
      otherRan = true;
      shader.uniforms.uOther = { value: 1 };
    };
    uniforms.attach(material, 'lamp');

    const shader = compile(material);
    expect(otherRan).toBe(true);
    expect(shader.uniforms.uOther).toBeDefined();
    expect(shader.fragmentShader).toContain('uLampIntensity');
  });

  it('does not lose a hook assigned AFTER it, when that system composes too', () => {
    // This is exactly what `ShadowSystem.registerMaterial` does: CSM assigns
    // the slot outright, then the engine folds the assignment into
    // `userData.engineShaderHooks`. Before the fix, that step created a fresh
    // array and threw this module's injection away.
    const uniforms = new NightUniforms();
    const material = new THREE.MeshStandardMaterial();
    uniforms.attach(material, 'lamp');

    // -- the engine's adoptAssignedHook, reproduced --------------------------
    const previous = material.onBeforeCompile;
    let csmRan = false;
    material.onBeforeCompile = (shader) => {
      csmRan = true;
      shader.uniforms.uCsm = { value: 2 };
    };
    const assigned = material.onBeforeCompile;
    material.onBeforeCompile = previous;
    const hooks = (material.userData as { engineShaderHooks?: { key: string; fn: unknown }[] })
      .engineShaderHooks;
    expect(hooks).toBeDefined();
    hooks!.push({ key: 'csm2', fn: (s: unknown, r: unknown) => assigned.call(material, s as never, r as never) });
    // -----------------------------------------------------------------------

    const shader = compile(material);
    expect(csmRan).toBe(true);
    expect(shader.uniforms.uCsm).toBeDefined();
    // THE assertion: the emissive injection survived.
    expect(shader.fragmentShader).toContain('uLampIntensity * uNightFactor');
    expect(shader.uniforms.uNightFactor).toBe(uniforms.uNightFactor);
  });

  it('appends to an existing engineShaderHooks array rather than replacing it', () => {
    const uniforms = new NightUniforms();
    const material = new THREE.MeshStandardMaterial();

    // Another system got there first, using the shared convention.
    let firstRan = false;
    const hooks: { key: string; fn: (s: unknown, r: unknown) => void }[] = [
      { key: 'materialLib', fn: () => { firstRan = true; } },
    ];
    (material.userData as { engineShaderHooks?: unknown }).engineShaderHooks = hooks;
    material.onBeforeCompile = (shader, renderer) => {
      for (const hook of hooks) hook.fn(shader, renderer);
    };
    material.customProgramCacheKey = () => `engine:${hooks.map((h) => h.key).join('|')}|`;

    uniforms.attach(material, 'window');

    expect(hooks).toHaveLength(2);
    const shader = compile(material);
    expect(firstRan).toBe(true);
    expect(shader.fragmentShader).toContain('uWindowIntensity');
    expect(material.customProgramCacheKey()).toContain('materialLib');
    expect(material.customProgramCacheKey()).toContain('skyNight:window');
  });
});

describe('attachByName', () => {
  it('wires a subtree by material name', () => {
    const uniforms = new NightUniforms();
    const root = new THREE.Group();
    const lamp = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial({ name: 'city.lamp.head' })
    );
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial({ name: 'city.wall' })
    );
    root.add(lamp, wall);

    const count = uniforms.attachByName(root, (name) =>
      name.includes('lamp') ? 'lamp' : undefined
    );
    expect(count).toBe(1);
    expect(uniforms.materialCount).toBe(1);
  });
});
