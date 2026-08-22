/**
 * The output pass IS tone mapping for every composer tier. The LOW tier gets
 * three's in-material `ACESFilmicToneMapping` instead, and the two are mutually
 * exclusive — three only tone maps in-material when rendering to the default
 * framebuffer — so any disagreement between the fits shows up as the whole
 * frame changing brightness the moment the quality slider crosses LOW.
 *
 * GLSL cannot be executed here, so the fit is asserted against three's own
 * shader chunk at the source level. Comments are stripped first: a comment
 * mentioning a constant must not be able to satisfy these.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { OutputLutPass } from '../post/output-lut-pass';

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('OutputLutPass ACES fit', () => {
  const pass = new OutputLutPass();
  const source = stripComments(pass.material.fragmentShader);
  const threeChunk = stripComments(THREE.ShaderChunk.tonemapping_pars_fragment);

  it("carries three's 1/0.6 viewing-environment gain", () => {
    // three folds it into the exposure multiply (`toneMappingExposure / 0.6`);
    // this pass applies exposure separately, so it scales by 1/0.6 itself.
    // Dropping it renders every composer tier ~0.74 EV darker than the direct
    // tier the header claims it matches.
    expect(threeChunk).toMatch(/toneMappingExposure\s*\/\s*0\.6/);
    expect(source).toMatch(/1\.0\s*\/\s*0\.6/);
  });

  it('applies the gain before the ACES input matrix, as three does', () => {
    const gain = source.search(/1\.0\s*\/\s*0\.6/);
    const inputMatrix = source.indexOf('ACESInputMat * color');
    expect(gain).toBeGreaterThan(-1);
    expect(inputMatrix).toBeGreaterThan(gain);
  });

  it('uses the same ACES matrices and RRT/ODT rational as three', () => {
    for (const constant of [
      '0.59719',
      '0.90834',
      '0.83777',
      '1.60475',
      '1.07602',
      '0.0245786',
      '0.983729',
      '0.238081',
    ]) {
      expect(threeChunk).toContain(constant);
      expect(source).toContain(constant);
    }
  });
});

describe('OutputLutPass live state', () => {
  it('reads back the vignette and grading blend it was given', () => {
    const pass = new OutputLutPass({ vignette: 0.4, vignetteSoftness: 0.3 });
    expect(pass.vignette).toBeCloseTo(0.4, 6);
    expect(pass.vignetteSoftness).toBeCloseTo(0.3, 6);
    // No LUT bound, so grading is off regardless of the requested intensity.
    expect(pass.lutIntensity).toBe(0);

    pass.setVignette(0.1, 0.5);
    expect(pass.vignette).toBeCloseTo(0.1, 6);
    expect(pass.vignetteSoftness).toBeCloseTo(0.5, 6);
    pass.dispose();
  });
});
