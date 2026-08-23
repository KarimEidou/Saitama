/**
 * MATERIALS — one draw call, every map bound, no accidental program explosion
 *
 * The visual harness proves the materials LOOK right. These tests pin the
 * properties a screenshot cannot show:
 *
 *   - every required map is bound, so nothing can silently render flat white;
 *   - ambient occlusion reads UV0, because the shared ORM texture must never
 *     arrive with another channel pinned on it;
 *   - the injected variants get distinct program cache keys, so a civilian
 *     cannot be handed the player's dithered program;
 *   - the proximity fade curve does nothing until the camera is genuinely
 *     collapsing, then ramps smoothly and stops short of erasing the player.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  BAYER4_MAX,
  auditMaterial,
  createRosterMaterial,
  getExpression,
  getProximityFade,
  proximityFadeAmount,
  setExpression,
  setProximityFade,
  type RosterTextures,
} from '../materials';
import { EXPRESSIONS } from '../types';

/**
 * The dither matrix from `FADE_DECLARATIONS`, in TypeScript.
 *
 * The fade is a scalar compared against these sixteen thresholds, so the
 * scalar on its own says nothing about whether anything survives: what matters
 * is whether it clears the LARGEST of them. Mirroring the GLSL is the only way
 * a unit test can see that.
 */
function bayer2(x: number, y: number): number {
  const px = Math.floor(x);
  const py = Math.floor(y);
  const value = px * 0.5 + py * py * 0.75;
  return value - Math.floor(value);
}

function bayer4(x: number, y: number): number {
  return bayer2(0.5 * x, 0.5 * y) * 0.25 + bayer2(x, y);
}

/** Every threshold a 4x4 screen block produces, at fragment centres. */
function bayerCells(): number[] {
  const cells: number[] = [];
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) cells.push(bayer4(x + 0.5, y + 0.5));
  }
  return cells;
}

/** Fragments the shader would KEEP at a given coverage: `bayer < fade` discards. */
function keptCells(fade: number): number {
  return bayerCells().filter((threshold) => !(threshold < fade)).length;
}

function fakeTexture(): THREE.Texture {
  const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  texture.needsUpdate = true;
  return texture;
}

function textures(extra: Partial<RosterTextures> = {}): RosterTextures {
  return {
    map: fakeTexture(),
    normalMap: fakeTexture(),
    ormMap: fakeTexture(),
    faceMap: fakeTexture(),
    ...extra,
  };
}

const RECT = { u0: 0.4, v0: 0.8, u1: 0.6, v1: 0.9 };

describe('roster material', () => {
  it('binds every required map and reads AO from UV0', () => {
    const material = createRosterMaterial(textures(), { faceRect: RECT, name: 'test' });
    const audit = auditMaterial(material);
    expect(audit.missing).toEqual([]);
    expect(audit.aoChannel).toBe(0);
    expect(audit.hasFace).toBe(true);
    expect(material.roughness).toBe(1);
    expect(material.metalness).toBe(1);
    expect(material.vertexColors).toBe(false);
  });

  it('binds one ORM upload to three slots', () => {
    const orm = fakeTexture();
    const material = createRosterMaterial(textures({ ormMap: orm }), { faceRect: RECT });
    expect(material.aoMap).toBe(orm);
    expect(material.roughnessMap).toBe(orm);
    expect(material.metalnessMap).toBe(orm);
  });

  it('never flips a roster texture', () => {
    // Roster maps are authored with row 0 at v = 0 — glTF's convention and the
    // one KTX2Loader forces. A flip here puts the face on the back of the head.
    const material = createRosterMaterial(textures(), { faceRect: RECT });
    expect(material.map?.flipY).toBe(false);
    expect(material.normalMap?.flipY).toBe(false);
    expect(material.aoMap?.flipY).toBe(false);
  });

  it('marks colour maps sRGB and data maps linear', () => {
    const material = createRosterMaterial(textures({ emissiveMap: fakeTexture() }), {
      faceRect: RECT,
    });
    expect(material.map?.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(material.emissiveMap?.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(material.normalMap?.colorSpace).toBe(THREE.NoColorSpace);
    expect(material.aoMap?.colorSpace).toBe(THREE.NoColorSpace);
  });

  it('gives each injected feature set its own program cache key', () => {
    const plain = createRosterMaterial(textures(), { faceRect: RECT });
    const crowd = createRosterMaterial(textures({ maskMap: fakeTexture() }), {
      faceRect: RECT,
      crowdTint: true,
    });
    const player = createRosterMaterial(textures(), { faceRect: RECT, proximityFade: true });

    const keys = [plain, crowd, player].map((material) => material.customProgramCacheKey());
    expect(new Set(keys).size).toBe(3);
    // Two materials with the same features must SHARE a program.
    const twin = createRosterMaterial(textures(), { faceRect: RECT });
    expect(twin.customProgramCacheKey()).toBe(plain.customProgramCacheKey());
  });

  it('will not enable crowd tinting without a mask to read', () => {
    const material = createRosterMaterial(textures(), { faceRect: RECT, crowdTint: true });
    expect(auditMaterial(material).features).not.toContain('C');
  });

  it('does not re-upload the shared atlas for every body that binds it', () => {
    // One texture set serves every copy of a character, and `needsUpdate` on a
    // three texture bumps its source version — which re-uploads the pixels and
    // regenerates the mipmaps of a 1024² sheet on the next frame. Spawning
    // civilians must not drag ~20 MB back over the bus each time.
    const map = fakeTexture();
    const normalMap = fakeTexture();
    const ormMap = fakeTexture();
    const faceMap = fakeTexture();
    const maskMap = fakeTexture();
    const shared: RosterTextures = { map, normalMap, ormMap, faceMap, maskMap };
    const sheets = [map, normalMap, ormMap, faceMap, maskMap];

    createRosterMaterial(shared, { faceRect: RECT, crowdTint: true });
    const versions = sheets.map((texture) => texture.version);

    for (let i = 0; i < 3; i++) createRosterMaterial(shared, { faceRect: RECT, crowdTint: true });
    expect(sheets.map((texture) => texture.version)).toEqual(versions);
  });

  it('binds the tint mask as an index map, not a colour map', () => {
    // Its texels are class ids decoded by band tests. Averaging two ids yields
    // a third valid id, so a skin/cloth seam would filter into the accent band
    // and tint a collar with the trousers colour.
    const mask = fakeTexture();
    const material = createRosterMaterial(textures({ maskMap: mask }), {
      faceRect: RECT,
      crowdTint: true,
    });
    expect(auditMaterial(material).features).toContain('C');
    expect(mask.anisotropy).toBe(1);
    expect(material.map?.anisotropy).toBeGreaterThan(1);
  });

  it('swaps expression with a uniform write', () => {
    const material = createRosterMaterial(textures(), { faceRect: RECT, expression: 'neutral' });
    expect(getExpression(material)).toBe('neutral');
    for (const expression of EXPRESSIONS) {
      setExpression(material, expression);
      expect(getExpression(material)).toBe(expression);
    }
    // The face rectangle is stored as origin + reciprocal span for the shader.
    const uniforms = material.userData.roster;
    expect(uniforms.faceRect.value.x).toBeCloseTo(RECT.u0, 6);
    expect(uniforms.faceRect.value.z).toBeCloseTo(1 / (RECT.u1 - RECT.u0), 4);
    expect(uniforms.faceSelect.value.y).toBeCloseTo(1 / EXPRESSIONS.length, 6);
  });

  it('injects the dither only where it is asked for', () => {
    const player = createRosterMaterial(textures(), { faceRect: RECT, proximityFade: true });
    const npc = createRosterMaterial(textures(), { faceRect: RECT });
    expect(auditMaterial(player).features).toContain('D');
    expect(auditMaterial(npc).features).not.toContain('D');
  });
});

describe('camera proximity fade', () => {
  it('does nothing until the spring arm is genuinely collapsing', () => {
    expect(proximityFadeAmount(0)).toBe(0);
    expect(proximityFadeAmount(0.4)).toBe(0);
    expect(proximityFadeAmount(0.3)).toBe(0);
  });

  it('exports the real maximum of the dither matrix', () => {
    // Sixteen thresholds, k/16 — so the top one is 15/16, NOT 1.0. A coverage
    // above it clears every cell and the character disappears outright.
    const cells = bayerCells();
    expect(new Set(cells).size).toBe(16);
    expect(Math.max(...cells)).toBe(BAYER4_MAX);
    expect(BAYER4_MAX).toBeLessThan(1);
  });

  it('ramps smoothly and never erases the silhouette completely', () => {
    const samples = [0.5, 0.6, 0.7, 0.8, 0.9, 1].map(proximityFadeAmount);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]!);
    }
    expect(samples.at(-1)!).toBeGreaterThan(0.9);
    // The property this test is named for is about COVERAGE, not the scalar:
    // at full collapse at least one dither cell has to survive the discard.
    expect(proximityFadeAmount(1)).toBeLessThanOrEqual(BAYER4_MAX);
    expect(keptCells(proximityFadeAmount(1))).toBeGreaterThan(0);
    // And every fragment must still be there before the ramp begins.
    expect(keptCells(proximityFadeAmount(0.4))).toBe(16);
  });

  it('would catch a coverage retuned past the top matrix cell', () => {
    // The guard above is only worth having if it can fail: 0.94 — the constant
    // this curve used to end on — erases all sixteen cells.
    expect(keptCells(0.94)).toBe(0);
  });

  it('drives the uniform from the camera ratio', () => {
    const material = createRosterMaterial(textures(), { faceRect: RECT, proximityFade: true });
    expect(getProximityFade(material)).toBe(0);
    setProximityFade(material, 1);
    expect(getProximityFade(material)).toBeCloseTo(proximityFadeAmount(1), 6);
    setProximityFade(material, 0);
    expect(getProximityFade(material)).toBe(0);
  });

  it('ignores materials that never opted in', () => {
    const plain = new THREE.MeshStandardMaterial();
    expect(() => setProximityFade(plain, 1)).not.toThrow();
    expect(getProximityFade(plain)).toBe(0);
  });
});
