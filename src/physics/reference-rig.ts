/**
 * REFERENCE HUMANOID RIG
 *
 * A 24-bone Mixamo-compatible skeleton built from proportions rather than an
 * asset.
 *
 * WHY IT LIVES IN PHYSICS: the ragdoll factory has to size capsules and place
 * joints even when the incoming rig is incomplete — a monster whose GLB is
 * missing `LeftToeBase`, or a procedural civilian built before the character
 * pipeline has run. The proportion table below is that fallback, and building
 * a whole skeleton from it is a few extra lines that give the harness and the
 * unit tests a rig to ragdoll without loading any assets.
 *
 * This is NOT the character factory. Real characters come from
 * `ICharacterFactory` in the character workstream; anything built here is a
 * stand-in with no skinning, no materials and no animation.
 */

import * as THREE from 'three';
import type { BoneName } from '@/types';

/** Reference height the offsets below are authored at. */
export const REFERENCE_HEIGHT = 1.75;

/**
 * Bone parent + local offset at `REFERENCE_HEIGHT`, in metres, in the order
 * bones must be created (parents first). A T-pose: arms along +/-X, legs down.
 */
export const REFERENCE_SKELETON: readonly {
  readonly bone: BoneName;
  readonly parent: BoneName | undefined;
  readonly offset: readonly [number, number, number];
}[] = [
  { bone: 'Hips', parent: undefined, offset: [0, 0.98, 0] },
  { bone: 'Spine', parent: 'Hips', offset: [0, 0.1, 0] },
  { bone: 'Spine1', parent: 'Spine', offset: [0, 0.12, 0] },
  { bone: 'Spine2', parent: 'Spine1', offset: [0, 0.12, 0] },
  { bone: 'Neck', parent: 'Spine2', offset: [0, 0.14, 0] },
  { bone: 'Head', parent: 'Neck', offset: [0, 0.09, 0] },
  { bone: 'HeadTop_End', parent: 'Head', offset: [0, 0.19, 0] },

  { bone: 'LeftShoulder', parent: 'Spine2', offset: [0.06, 0.1, 0] },
  { bone: 'LeftArm', parent: 'LeftShoulder', offset: [0.14, 0, 0] },
  { bone: 'LeftForeArm', parent: 'LeftArm', offset: [0.28, 0, 0] },
  { bone: 'LeftHand', parent: 'LeftForeArm', offset: [0.26, 0, 0] },
  { bone: 'LeftHandIndex1', parent: 'LeftHand', offset: [0.09, 0, 0] },
  { bone: 'LeftHandThumb1', parent: 'LeftHand', offset: [0.03, 0, 0.03] },

  { bone: 'RightShoulder', parent: 'Spine2', offset: [-0.06, 0.1, 0] },
  { bone: 'RightArm', parent: 'RightShoulder', offset: [-0.14, 0, 0] },
  { bone: 'RightForeArm', parent: 'RightArm', offset: [-0.28, 0, 0] },
  { bone: 'RightHand', parent: 'RightForeArm', offset: [-0.26, 0, 0] },
  { bone: 'RightHandIndex1', parent: 'RightHand', offset: [-0.09, 0, 0] },
  { bone: 'RightHandThumb1', parent: 'RightHand', offset: [-0.03, 0, 0.03] },

  { bone: 'LeftUpLeg', parent: 'Hips', offset: [0.09, -0.06, 0] },
  { bone: 'LeftLeg', parent: 'LeftUpLeg', offset: [0, -0.42, 0] },
  { bone: 'LeftFoot', parent: 'LeftLeg', offset: [0, -0.42, 0] },
  { bone: 'LeftToeBase', parent: 'LeftFoot', offset: [0, -0.07, 0.14] },

  { bone: 'RightUpLeg', parent: 'Hips', offset: [-0.09, -0.06, 0] },
  { bone: 'RightLeg', parent: 'RightUpLeg', offset: [0, -0.42, 0] },
  { bone: 'RightFoot', parent: 'RightLeg', offset: [0, -0.42, 0] },
  { bone: 'RightToeBase', parent: 'RightFoot', offset: [0, -0.07, 0.14] },
];

/**
 * The minimum a ragdoll needs from a rig.
 *
 * `ICharacterInstance` satisfies this structurally, so a real character can be
 * passed straight to `createRagdoll` with no adapter.
 */
export interface IRagdollRigSource {
  /** Scene root the bones hang beneath. */
  readonly root: THREE.Object3D;
  /** Canonical bone lookup; undefined when the rig lacks the bone. */
  getBone(name: BoneName): THREE.Bone | undefined;
}

/** A built reference rig. */
export interface IReferenceRig extends IRagdollRigSource {
  readonly root: THREE.Object3D;
  readonly bones: ReadonlyMap<BoneName, THREE.Bone>;
  /** Height the rig was scaled to. */
  readonly height: number;
}

/**
 * Build a reference skeleton scaled to `height` metres and positioned so the
 * feet rest on `origin`.
 */
export function createReferenceRig(
  height = REFERENCE_HEIGHT,
  origin?: THREE.Vector3
): IReferenceRig {
  const scale = height / REFERENCE_HEIGHT;
  const root = new THREE.Object3D();
  root.name = 'reference-rig';
  if (origin !== undefined) root.position.copy(origin);

  const bones = new Map<BoneName, THREE.Bone>();
  for (const entry of REFERENCE_SKELETON) {
    const bone = new THREE.Bone();
    bone.name = entry.bone;
    bone.position.set(
      entry.offset[0] * scale,
      entry.offset[1] * scale,
      entry.offset[2] * scale
    );
    const parent = entry.parent === undefined ? root : bones.get(entry.parent);
    (parent ?? root).add(bone);
    bones.set(entry.bone, bone);
  }
  root.updateMatrixWorld(true);

  return {
    root,
    bones,
    height,
    getBone: (name: BoneName): THREE.Bone | undefined => bones.get(name),
  };
}

/**
 * Nudge a rig out of its T-pose into a loose idle, so tests and the harness
 * blend a ragdoll from something other than a perfectly symmetric pose.
 * Angles are fixed, not random — the harness must stay deterministic.
 */
export function poseRigIdle(rig: IRagdollRigSource): void {
  const set = (name: BoneName, x: number, y: number, z: number): void => {
    const bone = rig.getBone(name);
    if (bone !== undefined) bone.rotation.set(x, y, z);
  };
  // Arms down and slightly forward.
  set('LeftArm', 0.15, 0, -1.28);
  set('RightArm', 0.15, 0, 1.28);
  set('LeftForeArm', 0, -0.35, -0.25);
  set('RightForeArm', 0, 0.35, 0.25);
  // Slight stagger in the legs and a small forward lean.
  set('LeftUpLeg', -0.12, 0, 0.04);
  set('RightUpLeg', 0.16, 0, -0.04);
  set('LeftLeg', 0.2, 0, 0);
  set('RightLeg', 0.12, 0, 0);
  set('Spine', 0.05, 0, 0);
  set('Head', -0.08, 0.1, 0);
  rig.root.updateMatrixWorld(true);
}
