/**
 * The VFX materials — the render state that decides what the whole suite costs.
 *
 * There is no GL context here, so nothing is compiled: these assertions are on
 * the state three reads to decide how many passes and how many program cache
 * keys the suite produces.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { vfxProfileFor } from '../constants';
import {
  createDecalMaterial,
  createShockwaveMaterial,
  createSharedUniforms,
  createSpeedlinesMaterial,
  createSpriteMaterial,
} from '../materials';

const profile = vfxProfileFor('medium');
const shared = createSharedUniforms();
const sprite = createSpriteMaterial(new THREE.Texture(), shared, profile);
const decal = createDecalMaterial(new THREE.Texture(), shared, profile);
const shockwave = createShockwaveMaterial(shared, profile);
const speedlines = createSpeedlinesMaterial(profile);

describe('vfx materials', () => {
  it('draws every transparent double-sided material in ONE pass', () => {
    // three renders `transparent` + `DoubleSide` TWICE — back faces, then front
    // faces — and `flipSided` is part of the program cache key. Without this
    // flag the suite costs 6 programs and 7 draw calls instead of the 3 and 4
    // the whole design is built around. The split is by winding, which also
    // lands velocity-stretched streak quads (whose screen-space Jacobian is
    // negated) in a different pass from every billboard, so the sprite layer's
    // back-to-front sort could not order the two groups against each other at
    // all.
    for (const material of [sprite, decal, shockwave, speedlines]) {
      expect(material.transparent, material.name).toBe(true);
      expect(material.forceSinglePass, material.name).toBe(true);
    }
  });

  it('builds the decals from the sprite program, not a second one', () => {
    // Blending, depth state and bound textures are GL state, not program
    // identity: this is the trick the three-program budget rests on.
    expect(decal.vertexShader).toBe(sprite.vertexShader);
    expect(decal.fragmentShader).toBe(sprite.fragmentShader);
    expect(decal.defines).toEqual(sprite.defines);
  });
});
