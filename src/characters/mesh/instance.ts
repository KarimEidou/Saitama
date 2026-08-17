/**
 * SCENE-GRAPH BINDING
 *
 * Turns a built mesh + rig into a `THREE.SkinnedMesh` and into the object
 * shape the character factory needs.
 *
 * ── WHERE THIS STOPS ──────────────────────────────────────────────────────
 * It stops one field short of `ICharacterInstance`: everything except
 * `animator`. Animation playback is a separate workstream, and a mesh
 * generator that also constructed animators would either duplicate that work
 * or lock its shape in. `CharacterParts` is the seam — the factory takes these
 * parts, attaches an `IAnimator`, and has a complete `ICharacterInstance`.
 *
 * ── MATERIALS ARE THE CALLER'S ────────────────────────────────────────────
 * Nothing here creates a material. The mesh ships colour in a `color` vertex
 * attribute and slot boundaries in `geometry.groups`, so:
 *
 *   one material  -> groups are ignored by three.js, one draw call, region
 *                    colour still comes through if `vertexColors: true`
 *   material array-> one draw call per slot, indexed by `MeshSlot`
 *
 * Either way the material's own look (roughness maps, rim light, toon ramp)
 * belongs to the render workstream, not to geometry.
 */

import * as THREE from 'three';
import type { BodyProfile, BoneName, SocketBone } from '@/types';
import type { HumanoidBuild } from './assemble';
import { SLOT_NAMES } from './types';

/**
 * A constructed character, minus animation.
 *
 * Field-for-field compatible with `ICharacterInstance` so the factory can
 * spread these parts and add an `animator`.
 */
export interface CharacterParts {
  readonly root: THREE.Object3D;
  readonly meshes: readonly THREE.SkinnedMesh[];
  readonly skeleton: THREE.Skeleton;
  readonly profile: BodyProfile;
  getBone(name: BoneName): THREE.Bone | undefined;
  getSocketWorldPosition(bone: SocketBone, out: THREE.Vector3): THREE.Vector3;
  dispose(): void;
}

/**
 * Bind geometry and skeleton into a `SkinnedMesh`.
 *
 * Order matters: the root bone must be parented into the same subtree BEFORE
 * `bind()`, because bind snapshots each bone's inverse world matrix and that
 * snapshot is the bind pose. Binding first and parenting after is the classic
 * route to a character that renders inside out.
 */
export function createSkinnedMesh(
  build: HumanoidBuild,
  material: THREE.Material | THREE.Material[]
): { mesh: THREE.SkinnedMesh; root: THREE.Object3D } {
  const root = new THREE.Group();
  root.name = 'humanoid';

  const mesh = new THREE.SkinnedMesh(build.geometry, material);
  mesh.name = `humanoid_lod${build.stats.lod}`;
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  root.add(build.rig.root);
  root.add(mesh);
  root.updateMatrixWorld(true);
  mesh.bind(build.rig.skeleton, new THREE.Matrix4());

  return { mesh, root };
}

/** Assemble the non-animation half of an `ICharacterInstance`. */
export function createCharacterParts(
  build: HumanoidBuild,
  material: THREE.Material | THREE.Material[]
): CharacterParts {
  const { mesh, root } = createSkinnedMesh(build, material);
  const rig = build.rig;

  return {
    root,
    meshes: [mesh],
    skeleton: rig.skeleton,
    profile: build.profile,
    getBone(name: BoneName): THREE.Bone | undefined {
      const index = rig.index[name];
      return index === undefined ? undefined : rig.bones[index];
    },
    getSocketWorldPosition(bone: SocketBone, out: THREE.Vector3): THREE.Vector3 {
      const target = rig.bones[rig.index[bone]];
      if (target === undefined) return out.set(0, 0, 0);
      return target.getWorldPosition(out);
    },
    dispose(): void {
      build.geometry.dispose();
    },
  };
}

/**
 * Names of the material slots present in a build, in `geometry.groups` order.
 *
 * Lets a caller size a material array correctly without guessing: a bald
 * civilian has no `hair` group and Saitama has no `metal` one.
 */
export function usedSlots(build: HumanoidBuild): string[] {
  const seen = new Set<number>();
  for (const group of build.geometry.groups) {
    if (group.materialIndex !== undefined) seen.add(group.materialIndex);
  }
  return [...seen].sort((a, b) => a - b).map((i) => SLOT_NAMES[i] ?? `slot${i}`);
}
