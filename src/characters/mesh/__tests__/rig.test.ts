/**
 * SKELETON CONTRACT
 *
 * The rig is the interface between this workstream and every other one that
 * touches a character — animation, combat sockets, IK, ragdoll. A silent
 * change to a bone name or a rest transform breaks all of them at once and
 * shows up as a subtly wrong pose three systems away, so the shape of the
 * skeleton is nailed down here.
 *
 * The identity-rest-rotation rule is the one worth defending. Mixamo bakes
 * bone roll into rest rotations; we do not. That means an animator can say
 * "rotate LeftForeArm about Y to bend the elbow" and be right without
 * consulting a per-bone basis — which matters far more for hand-written
 * procedural animation than for imported clips, and imported clips need a
 * retargeting pass regardless.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { BoneName } from '@/types';
import { BONE_ORDER, BONE_PARENT, buildRig, resolveDimensions } from '../rig';
import { buildCharacter, showcaseBodies } from '../characters';
import { buildHumanoid } from '../assemble';
import { createCharacterParts } from '../instance';

const PROFILE = showcaseBodies()[0]!.profile;

describe('humanoid rig', () => {
  it('carries the full Mixamo bone set exactly once', () => {
    expect(BONE_ORDER).toHaveLength(27);
    expect(new Set(BONE_ORDER).size).toBe(27);
    const rig = buildRig(PROFILE);
    expect(rig.bones).toHaveLength(27);
    for (const name of BONE_ORDER) {
      expect(rig.get(name).name).toBe(name);
      expect(rig.bones[rig.index[name]]!.name).toBe(name);
    }
  });

  it('declares parents before children', () => {
    const seen = new Set<BoneName>();
    for (const name of BONE_ORDER) {
      const parent = BONE_PARENT[name];
      if (parent !== null) expect(seen.has(parent), `${name} before ${parent}`).toBe(true);
      seen.add(name);
    }
  });

  it('wires the hierarchy the way the table says', () => {
    const rig = buildRig(PROFILE);
    for (const name of BONE_ORDER) {
      const parent = BONE_PARENT[name];
      if (parent === null) continue;
      expect(rig.get(name).parent?.name, `${name}`).toBe(parent);
    }
    expect(rig.root.name).toBe('Hips');
  });

  it('rests every bone with an identity rotation and unit scale', () => {
    const rig = buildRig(PROFILE);
    for (const bone of rig.bones) {
      expect(bone.quaternion.x).toBeCloseTo(0, 9);
      expect(bone.quaternion.y).toBeCloseTo(0, 9);
      expect(bone.quaternion.z).toBeCloseTo(0, 9);
      expect(bone.quaternion.w).toBeCloseTo(1, 9);
      expect(bone.scale.x).toBeCloseTo(1, 9);
    }
  });

  it('places every bone where the rest table says', () => {
    const rig = buildRig(PROFILE);
    rig.root.updateMatrixWorld(true);
    const world = new THREE.Vector3();
    for (const name of BONE_ORDER) {
      rig.get(name).getWorldPosition(world);
      expect(world.distanceTo(rig.restPosition[name]), name).toBeLessThan(1e-6);
    }
  });

  it('orders limb joints down the limb', () => {
    const rest = buildRig(PROFILE).restPosition;
    // Arms travel outward and slightly down.
    expect(Math.abs(rest.LeftForeArm.x)).toBeGreaterThan(Math.abs(rest.LeftArm.x));
    expect(Math.abs(rest.LeftHand.x)).toBeGreaterThan(Math.abs(rest.LeftForeArm.x));
    expect(rest.LeftHand.y).toBeLessThan(rest.LeftArm.y);
    // Legs descend.
    expect(rest.LeftLeg.y).toBeLessThan(rest.LeftUpLeg.y);
    expect(rest.LeftFoot.y).toBeLessThan(rest.LeftLeg.y);
    // Toes lead forward, and forward is -Z.
    expect(rest.LeftToeBase.z).toBeLessThan(rest.LeftFoot.z);
    // Spine ascends.
    expect(rest.Spine.y).toBeLessThan(rest.Spine1.y);
    expect(rest.Spine1.y).toBeLessThan(rest.Spine2.y);
    expect(rest.Spine2.y).toBeLessThan(rest.Neck.y);
    expect(rest.Neck.y).toBeLessThan(rest.Head.y);
    expect(rest.Head.y).toBeLessThan(rest.HeadTop_End.y);
  });

  it('scales the whole rig with the profile', () => {
    const small = resolveDimensions({ ...PROFILE, height: 1.2 });
    const large = resolveDimensions({ ...PROFILE, height: 2.4 });
    expect(large.unit / small.unit).toBeCloseTo(2, 3);
    expect(large.headTopY).toBeCloseTo(2.4, 3);
    expect(small.headTopY).toBeCloseTo(1.2, 3);
  });

  it('exposes combat sockets in world space', () => {
    const build = buildCharacter('saitama', 0);
    const parts = createCharacterParts(build, new THREE.MeshBasicMaterial());
    parts.root.position.set(10, 0, -4);
    parts.root.updateMatrixWorld(true);

    const out = new THREE.Vector3();
    parts.getSocketWorldPosition('RightHand', out);
    expect(out.x).toBeGreaterThan(9);
    expect(out.y).toBeGreaterThan(0.4);
    expect(parts.getBone('Head')).toBeDefined();
    expect(parts.meshes).toHaveLength(1);
    expect(parts.skeleton.bones).toHaveLength(27);
    parts.dispose();
  });

  it('is deterministic: same profile, byte-identical mesh', () => {
    const recipe = showcaseBodies()[5]!;
    const a = buildHumanoid(recipe.profile, recipe.options);
    const b = buildHumanoid(recipe.profile, recipe.options);
    const pa = a.geometry.getAttribute('position').array as Float32Array;
    const pb = b.geometry.getAttribute('position').array as Float32Array;
    expect(pa.length).toBe(pb.length);
    for (let i = 0; i < pa.length; i++) expect(pb[i]).toBe(pa[i]);

    const wa = a.geometry.getAttribute('skinWeight').array as Float32Array;
    const wb = b.geometry.getAttribute('skinWeight').array as Float32Array;
    for (let i = 0; i < wa.length; i++) expect(wb[i]).toBe(wa[i]);
  });
});
