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
import { describe, expect, it, vi } from 'vitest';
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
    expect(compile(window).fragmentShader).toContain(
      'uWindowColor * uWindowIntensity * uNightFactor'
    );
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

  it('builds the world position through instanceMatrix and batchingMatrix', () => {
    // The lit surfaces this module exists for are MOSTLY INSTANCED, and every
    // instance of an InstancedMesh shares one modelMatrix. Without the ladder
    // below, all 400 panes of a facade hash to a single cell and light — or go
    // dark — as one block.
    const uniforms = new NightUniforms();
    const material = new THREE.MeshStandardMaterial();
    uniforms.attach(material, 'window');
    const vertex = compile(material).vertexShader;

    expect(vertex).toContain('#ifdef USE_INSTANCING');
    expect(vertex).toContain('instanceMatrix * skyWorldPos');
    expect(vertex).toContain('#ifdef USE_BATCHING');
    expect(vertex).toContain('batchingMatrix * skyWorldPos');
    // ...and the instance placement is applied BEFORE the model matrix, which
    // is the order three's own <worldpos_vertex> uses.
    expect(vertex.indexOf('instanceMatrix * skyWorldPos')).toBeLessThan(
      vertex.indexOf('vSkyWorldPos = (modelMatrix')
    );
  });

  it('warns instead of silently doing nothing when the material has no emissive stage', () => {
    // `String.replace` with an absent needle returns the subject unchanged, so
    // a MeshBasicMaterial used to report a successful attach and stay dark.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const uniforms = new NightUniforms();
      const material = new THREE.MeshBasicMaterial({ name: 'vending.glow' });
      uniforms.attach(material, 'lamp');

      const shader = fakeShader();
      shader.fragmentShader = '#include <common>\nvoid main() {}';
      material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);

      expect(shader.fragmentShader).not.toContain('uLampIntensity * uNightFactor');
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0]?.join(' '))).toContain('emissivemap_fragment');
    } finally {
      warn.mockRestore();
    }
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

  it('wraps the lamp phase without changing the flicker it produces', () => {
    // Callers feed an unbounded clock (`clock.unscaledElapsed`). GLSL floats
    // are fp32 and the shader multiplies by 22, so after a day of uptime the
    // argument's ulp is ~0.13 rad and the buzz stair-steps; at `mediump` the
    // uniform saturates after ~18 h. `sin(x * 22)` has period 2π/22 in x, so
    // wrapping there is exactly the same flicker.
    const uniforms = new NightUniforms();
    const period = (Math.PI * 2) / 22;
    for (const elapsed of [0, 12, 3600, 86400, 1e6]) {
      uniforms.update(1, 1, elapsed);
      const phase = uniforms.uLampPhase.value;
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(period);
      expect(Math.sin(phase * 22)).toBeCloseTo(Math.sin(elapsed * 22), 6);
    }

    uniforms.update(1, 1, Number.NaN);
    expect(Number.isFinite(uniforms.uLampPhase.value)).toBe(true);
    uniforms.update(1, 1, Number.POSITIVE_INFINITY);
    expect(Number.isFinite(uniforms.uLampPhase.value)).toBe(true);
  });

  it('keeps the shader literal and the wrap period in step', () => {
    // The wrap is only behaviour-preserving while the TS constant and the GLSL
    // literal agree. `.toFixed(1)` is load-bearing too: a bare `22` is an int
    // literal and `float * int` does not compile in GLSL ES 3.00.
    const uniforms = new NightUniforms();
    const material = new THREE.MeshStandardMaterial();
    uniforms.attach(material, 'lamp');
    expect(compile(material).fragmentShader).toContain('sin(uLampPhase * 22.0');
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
    hooks!.push({
      key: 'csm2',
      fn: (s: unknown, r: unknown) => assigned.call(material, s as never, r as never),
    });
    // -----------------------------------------------------------------------

    const shader = compile(material);
    expect(csmRan).toBe(true);
    expect(shader.uniforms.uCsm).toBeDefined();
    // THE assertion: the emissive injection survived.
    expect(shader.fragmentShader).toContain('uLampIntensity * uNightFactor');
    expect(shader.uniforms.uNightFactor).toBe(uniforms.uNightFactor);
  });

  it('carries a cache key that was assigned directly onto the material', () => {
    // The city's destructible materials assign BOTH `onBeforeCompile` and
    // `customProgramCacheKey = () => 'city-destroy-v1'`. Installing the
    // dispatcher over the top of that key collapses every such material onto
    // one composed key — the adopted hook is always keyed 'adopted', whatever
    // it injects — and three then hands one of them the other's program.
    const uniforms = new NightUniforms();
    const destructible = new THREE.MeshStandardMaterial();
    destructible.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '// destroy clip');
    };
    destructible.customProgramCacheKey = () => 'city-destroy-v1';

    const roster = new THREE.MeshStandardMaterial();
    roster.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '// roster tint');
    };
    roster.customProgramCacheKey = () => 'roster:F-D';

    uniforms.attach(destructible, 'lamp');
    uniforms.attach(roster, 'lamp');

    expect(destructible.customProgramCacheKey()).toContain('city-destroy-v1');
    expect(roster.customProgramCacheKey()).toContain('roster:F-D');
    expect(destructible.customProgramCacheKey()).not.toBe(roster.customProgramCacheKey());
  });

  it('appends to an existing engineShaderHooks array rather than replacing it', () => {
    const uniforms = new NightUniforms();
    const material = new THREE.MeshStandardMaterial();

    // Another system got there first, using the shared convention.
    let firstRan = false;
    const hooks: { key: string; fn: (s: unknown, r: unknown) => void }[] = [
      {
        key: 'materialLib',
        fn: () => {
          firstRan = true;
        },
      },
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

  it('rebuilds the hook chain on a cloned material', () => {
    // `THREE.Material.copy` is `userData = JSON.parse(JSON.stringify(...))` and
    // does NOT copy `onBeforeCompile` / `customProgramCacheKey`. So a clone
    // carries the hook KEYS with every `fn` dropped, behind the prototype's
    // no-op slot. Appending to that array reports success, installs a hook
    // nothing ever calls, and leaves the clone dark at midnight — and the next
    // system to build a dispatcher over it calls `undefined` and throws.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const uniforms = new NightUniforms();
      const source = new THREE.MeshStandardMaterial();
      uniforms.attach(source, 'lamp');

      const clone = source.clone();
      expect((clone.userData as { engineShaderHooks?: unknown[] }).engineShaderHooks).toBeDefined();

      expect(uniforms.attach(clone, 'window')).toBe(true);
      const shader = compile(clone);
      expect(shader.fragmentShader).toContain('uWindowIntensity * uNightFactor');
      expect(shader.uniforms.uNightFactor).toBe(uniforms.uNightFactor);
      expect(shader.vertexShader.split('varying vec3 vSkyWorldPos;').length - 1).toBe(1);
      expect(clone.customProgramCacheKey()).toContain('skyNight:window');
      expect(clone.customProgramCacheKey()).not.toContain('skyNight:lamp');
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses a second NightUniforms on the same material', () => {
    // `attached` is per-instance, so nothing else notices the collision. A
    // second block redeclares `vSkyWorldPos` on both stages, GLSL rejects it,
    // and the material compiles to nothing.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const a = new NightUniforms();
      const b = new NightUniforms();
      const material = new THREE.MeshStandardMaterial();
      expect(a.attach(material, 'lamp')).toBe(true);
      expect(b.attach(material, 'window')).toBe(false);

      expect(b.materialCount).toBe(0);
      expect(a.materialCount).toBe(1);
      const shader = compile(material);
      expect(shader.vertexShader.split('varying vec3 vSkyWorldPos;').length - 1).toBe(1);
      expect(shader.fragmentShader).not.toContain('uWindowIntensity');

      // One warning per material, however many meshes share it.
      b.attach(material, 'window');
      b.attach(material, 'window');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
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

  it('counts MATERIALS, not mesh/material pairs', () => {
    // A city block is 200 lamp meshes sharing one material. Counting the
    // visits reports 200 attachments against a materialCount of 1, and a
    // caller using the return value as a wiring check is two orders of
    // magnitude out.
    const uniforms = new NightUniforms();
    const root = new THREE.Group();
    const shared = new THREE.MeshStandardMaterial({ name: 'city.lamp.head' });
    const geometry = new THREE.BoxGeometry();
    for (let i = 0; i < 200; i++) root.add(new THREE.Mesh(geometry, shared));

    const count = uniforms.attachByName(root, (name) =>
      name.includes('lamp') ? 'lamp' : undefined
    );
    expect(count).toBe(1);
    expect(count).toBe(uniforms.materialCount);
  });
});
