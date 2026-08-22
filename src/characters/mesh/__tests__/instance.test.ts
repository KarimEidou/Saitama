/**
 * SCENE-GRAPH BINDING
 *
 * Two contracts a caller cannot check for itself, both of which fail silently.
 *
 * DISPOSAL RELEASES EVERYTHING THIS OWNS. A character owns a geometry AND a
 * skeleton; three.js allocates the skeleton's bone texture lazily on the first
 * render and only `Skeleton.dispose()` frees it. A generator that churns
 * characters — roster previews, LOD rebuilds, boss spawns — otherwise leaks one
 * GL texture per character, unbounded, which is exactly the resource a mid-tier
 * Android driver runs out of first.
 *
 * A MATERIAL ARRAY IS INDEXED, NOT PACKED. three.js resolves a group's material
 * as `material[group.materialIndex]` and skips the group when that entry is
 * missing, so anything that tells a caller how long the array must be has to
 * count up to the HIGHEST slot in the build, not the number of slots used.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildCharacter } from '../characters';
import { createCharacterParts, usedSlots } from '../instance';
import { MeshSlot, SLOT_NAMES } from '../types';

describe('character parts', () => {
  it('releases the skeleton bone texture on dispose', () => {
    const build = buildCharacter('saitama', 2);
    const parts = createCharacterParts(build, new THREE.MeshBasicMaterial());
    // What the renderer does on the first draw call.
    parts.skeleton.computeBoneTexture();
    expect(parts.skeleton.boneTexture).not.toBeNull();

    parts.dispose();
    expect(parts.skeleton.boneTexture, 'leaked bone texture').toBeNull();
  });
});

describe('material slots', () => {
  it('lists slots so the array can be indexed by MeshSlot', () => {
    const build = buildCharacter('genos', 0);
    const slots = usedSlots(build);

    // Genos has no cloth geometry at all, but every panel he wears is Metal.
    // A compacted list would be four long and three.js would silently drop
    // every pauldron, elbow ring, knee guard and vent grille.
    const highest = Math.max(...build.geometry.groups.map((group) => group.materialIndex ?? 0));
    expect(highest).toBe(MeshSlot.Metal);
    expect(slots).toHaveLength(highest + 1);
    for (const group of build.geometry.groups) {
      expect(slots[group.materialIndex ?? 0]).toBe(SLOT_NAMES[group.materialIndex ?? 0]);
    }
  });
});
