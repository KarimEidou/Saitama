/**
 * `HalfResSSAOPass` advertises itself as "one extra scene traversal, at a
 * quarter of the pixels" writing into an R8 buffer, and as a joint BILATERAL
 * upsample. All three claims were false, and none of them is visible from
 * anywhere else in the engine — a doubled shadow pass just makes the frame
 * slower, and a too-loose depth weight just makes the AO slightly wrong.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { HalfResSSAOPass } from '../post/ssao-pass';

interface IShadowMapState {
  autoUpdate: boolean;
  needsUpdate: boolean;
}

interface ISceneRender {
  readonly autoUpdate: boolean;
  readonly needsUpdate: boolean;
  readonly hasOverride: boolean;
}

/**
 * Minimal `WebGLRenderer` stand-in that records the shadow-map flags in force
 * at each full scene render. `WebGLRenderer.render()` runs the shadow pass on
 * every call and ignores `scene.overrideMaterial` while doing it, so the flags
 * at that moment are exactly what decides whether the cascades are rasterised
 * a second time for a buffer that discards them.
 */
function recordingRenderer(shadowMap: IShadowMapState, sceneRenders: ISceneRender[]) {
  return {
    shadowMap,
    getClearAlpha: () => 1,
    getClearColor: (target: THREE.Color) => target.set(0x101010),
    setClearColor: () => undefined,
    setRenderTarget: () => undefined,
    clear: () => undefined,
    render: (object: THREE.Object3D) => {
      const scene = object as THREE.Scene;
      if (scene.isScene !== true) return;
      sceneRenders.push({
        autoUpdate: shadowMap.autoUpdate,
        needsUpdate: shadowMap.needsUpdate,
        hasOverride: scene.overrideMaterial !== null,
      });
    },
  } as unknown as THREE.WebGLRenderer;
}

function build(): {
  pass: HalfResSSAOPass;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  write: THREE.WebGLRenderTarget;
  read: THREE.WebGLRenderTarget;
} {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2400);
  const pass = new HalfResSSAOPass(scene, camera, { radius: 0.8, scale: 0.5 });
  pass.setSize(1920, 1080);
  return {
    pass,
    scene,
    camera,
    write: new THREE.WebGLRenderTarget(1920, 1080),
    read: new THREE.WebGLRenderTarget(1920, 1080),
  };
}

function material(
  pass: HalfResSSAOPass,
  name: 'normalDepthMaterial' | 'compositeMaterial'
): THREE.ShaderMaterial {
  return (pass as unknown as Record<string, THREE.ShaderMaterial>)[name]!;
}

describe('HalfResSSAOPass prepass', () => {
  it('renders the guide buffer without re-running the shadow cascades', () => {
    const { pass, write, read } = build();
    const shadowMap: IShadowMapState = { autoUpdate: true, needsUpdate: false };
    const sceneRenders: ISceneRender[] = [];

    pass.render(recordingRenderer(shadowMap, sceneRenders), write, read);

    expect(sceneRenders).toHaveLength(1);
    expect(sceneRenders[0]!.hasOverride).toBe(true);
    // `WebGLShadowMap.render` bails only when BOTH are false.
    expect(sceneRenders[0]!.autoUpdate).toBe(false);
    expect(sceneRenders[0]!.needsUpdate).toBe(false);
    pass.dispose();
  });

  it('restores the shadow-map flags it borrowed', () => {
    const { pass, write, read } = build();
    const shadowMap: IShadowMapState = { autoUpdate: true, needsUpdate: true };
    pass.render(recordingRenderer(shadowMap, []), write, read);
    expect(shadowMap).toEqual({ autoUpdate: true, needsUpdate: true });

    const off: IShadowMapState = { autoUpdate: false, needsUpdate: false };
    pass.render(recordingRenderer(off, []), write, read);
    expect(off).toEqual({ autoUpdate: false, needsUpdate: false });
    pass.dispose();
  });

  it('declares batchingMatrix ahead of both chunks that consume it', () => {
    const { pass } = build();
    const vertex = material(pass, 'normalDepthMaterial').vertexShader;
    const batching = vertex.indexOf('#include <batching_vertex>');
    expect(batching).toBeGreaterThan(-1);
    expect(batching).toBeLessThan(vertex.indexOf('#include <defaultnormal_vertex>'));
    expect(batching).toBeLessThan(vertex.indexOf('#include <project_vertex>'));
    pass.dispose();
  });
});

describe('HalfResSSAOPass buffers', () => {
  it('allocates the AO buffer as R8, matching the documented footprint', () => {
    const { pass } = build();
    const ao = (pass as unknown as { aoTarget: THREE.WebGLRenderTarget }).aoTarget;
    expect(ao.texture.format).toBe(THREE.RedFormat);
    expect(ao.texture.type).toBe(THREE.UnsignedByteType);
    pass.dispose();
  });
});

describe('HalfResSSAOPass bilateral upsample', () => {
  it('weighs tap separation in metres rather than far-plane fractions', () => {
    const { pass, camera, write, read } = build();
    const composite = material(pass, 'compositeMaterial');
    expect(composite.fragmentShader).toContain('uCameraFar');

    pass.render(recordingRenderer({ autoUpdate: true, needsUpdate: false }, []), write, read);
    expect(composite.uniforms.uCameraFar!.value).toBe(camera.far);

    // Halving the far plane must not change how the filter treats an edge.
    camera.far = 600;
    pass.render(recordingRenderer({ autoUpdate: true, needsUpdate: false }, []), write, read);
    expect(composite.uniforms.uCameraFar!.value).toBe(600);
    pass.dispose();
  });

  it('rejects taps well inside the AO sampling radius', () => {
    const { pass } = build();
    const composite = material(pass, 'compositeMaterial');
    const sigma = composite.uniforms.uDepthSigmaPerMetre!.value as number;
    // Half-weight separation, in metres. The AO radius is 0.8 m on HIGH; the
    // old far-plane-normalised constant put this at 7.6 m, which accepted the
    // wall behind a character at 83 % weight and made the filter a box blur.
    expect(Math.LN2 / sigma).toBeLessThan(0.2);
    expect(Math.LN2 / sigma).toBeGreaterThan(0.01);
    pass.dispose();
  });
});
