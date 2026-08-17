/**
 * MATERIALS — one draw call, every map bound, no accidental program explosion
 *
 * The visual harness proves the materials LOOK right. These tests pin the
 * properties a screenshot cannot show:
 *
 *   - every required map is bound, so nothing can silently render flat white;
 *   - ambient occlusion reads UV0, because three defaults it to a second UV set
 *     these meshes do not have;
 *   - the injected variants get distinct program cache keys, so a civilian
 *     cannot be handed the player's dithered program;
 *   - the proximity fade curve does nothing until the camera is genuinely
 *     collapsing, then ramps smoothly and stops short of erasing the player.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
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

  it('ramps smoothly and never erases the silhouette completely', () => {
    const samples = [0.5, 0.6, 0.7, 0.8, 0.9, 1].map(proximityFadeAmount);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]!);
    }
    expect(samples.at(-1)!).toBeGreaterThan(0.9);
    expect(samples.at(-1)!).toBeLessThan(1);
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
