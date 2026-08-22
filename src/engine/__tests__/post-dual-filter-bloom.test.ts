/**
 * Two invariants of the Kawase pyramid that nothing downstream would notice
 * breaking:
 *
 *  - the downsample kernel is sized against the DESTINATION, not the source.
 *    The first step is a 1/scale reduction (4x by default), so a source-sized
 *    kernel collapses all five taps into the central 2x2 of each 4x4 source
 *    block and never fetches the outer 12 texels — every sub-4px highlight
 *    then pops its bloom halo on and off as the camera pans.
 *  - `setSize` is idempotent. It allocates rather than resizes, and mobile
 *    fires `resize` per frame while the URL bar animates, usually at an
 *    unchanged drawing-buffer size.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DualFilterBloomPass } from '../post/dual-filter-bloom-pass';

/** The pyramid is private, and the identity of its targets is the assertion. */
function mips(pass: DualFilterBloomPass): THREE.WebGLRenderTarget[] {
  return (pass as unknown as { mips: THREE.WebGLRenderTarget[] }).mips;
}

interface IRecordedStep {
  readonly material: string;
  readonly targetWidth: number;
  readonly targetHeight: number;
  readonly texelX: number;
  readonly texelY: number;
}

/**
 * Minimal `WebGLRenderer` stand-in: records the bound target and the live
 * `uTexel` at every full-screen draw. `FullScreenQuad.render` is a single
 * `renderer.render( mesh, camera )`, so the mesh carries the current material.
 */
function recordingRenderer(steps: IRecordedStep[]): THREE.WebGLRenderer {
  let target: THREE.WebGLRenderTarget | null = null;
  return {
    autoClear: true,
    setRenderTarget(next: THREE.WebGLRenderTarget | null): void {
      target = next;
    },
    render(object: THREE.Mesh): void {
      const material = object.material as THREE.ShaderMaterial;
      const texel = material.uniforms.uTexel?.value as THREE.Vector2 | undefined;
      steps.push({
        material: material.name,
        targetWidth: target?.width ?? 0,
        targetHeight: target?.height ?? 0,
        texelX: texel?.x ?? 0,
        texelY: texel?.y ?? 0,
      });
    },
  } as unknown as THREE.WebGLRenderer;
}

describe('DualFilterBloomPass downsample footprint', () => {
  const steps: IRecordedStep[] = [];
  const pass = new DualFilterBloomPass({ scale: 0.25, iterations: 4 });
  pass.setSize(1024, 512);
  const read = new THREE.WebGLRenderTarget(1024, 512);
  const write = new THREE.WebGLRenderTarget(1024, 512);
  pass.render(recordingRenderer(steps), write, read);
  const downsamples = steps.filter((step) => step.material === 'DualFilterBloom.down');

  it('runs one downsample per pyramid level', () => {
    expect(downsamples.length).toBe(mips(pass).length);
  });

  it('sizes every downsample kernel against its destination', () => {
    for (const step of downsamples) {
      expect(step.texelX).toBeCloseTo(0.5 / step.targetWidth, 12);
      expect(step.texelY).toBeCloseTo(0.5 / step.targetHeight, 12);
    }
  });

  it('spans the whole source block on the 4x first step', () => {
    const first = downsamples[0]!;
    expect(first.targetWidth).toBe(256);
    // The diagonal taps sit at `uTexel * 0.5`. Expressed in SOURCE texels that
    // must be 1.0 for a 4x reduction — reaching the outer ring of the 4x4
    // block. The bug this guards left it at 0.5: the central 2x2 only.
    const halfTexelInSourceTexels = first.texelX * 0.5 * read.width;
    expect(halfTexelInSourceTexels).toBeCloseTo(1, 12);
  });
});

describe('DualFilterBloomPass.setSize', () => {
  it('keeps the pyramid across a repeated size', () => {
    const pass = new DualFilterBloomPass();
    pass.setSize(1920, 1080);
    const before = [...mips(pass)];
    expect(before.length).toBeGreaterThan(0);

    pass.setSize(1920, 1080);
    expect(mips(pass).length).toBe(before.length);
    for (let i = 0; i < before.length; i++) expect(mips(pass)[i]).toBe(before[i]);

    // Sub-pixel jitter that rounds to the same size is also a no-op.
    pass.setSize(1920.2, 1079.6);
    expect(mips(pass)[0]).toBe(before[0]);
    pass.dispose();
  });

  it('still reallocates for a genuinely different size', () => {
    const pass = new DualFilterBloomPass();
    pass.setSize(1920, 1080);
    const before = mips(pass)[0];
    pass.setSize(1280, 720);
    expect(mips(pass)[0]).not.toBe(before);
    expect(mips(pass)[0]!.width).toBe(320);
    pass.dispose();
  });
});
