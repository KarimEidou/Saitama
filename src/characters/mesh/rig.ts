/**
 * HUMANOID RIG
 *
 * Builds the 27-bone Mixamo-named skeleton and, just as importantly, the
 * dimension table the mesh is lofted around. Skeleton and skin are generated
 * from ONE set of numbers, which is why the bind pose can never drift out of
 * agreement with the geometry.
 *
 * ── NAMES vs AXES ─────────────────────────────────────────────────────────
 * Bone names follow Mixamo exactly (`BoneName` in types/character.ts), so a
 * retargeter can map third-party clips onto this rig by name. The AXES are
 * ours: the engine's characters face -Z (`ITransform.forward`), while Mixamo
 * rigs face +Z, so this skeleton is mirrored — `LeftArm` sits at NEGATIVE X.
 * Retargeting across that mirror is a rotation basis change the retargeter
 * already has to do for bone roll anyway.
 *
 * ── REST ROTATIONS ARE IDENTITY ───────────────────────────────────────────
 * Mixamo bakes bone roll into rest rotations so each bone's local +Y runs
 * down its own length. We deliberately do not: every bone rests with an
 * identity quaternion and a pure translation offset. That means a procedural
 * animator can say "rotate LeftForeArm about Z to bend the elbow" and be right
 * without consulting a per-bone basis, which matters far more for hand-written
 * procedural animation than for imported clips.
 *
 * ── PROPORTIONS ───────────────────────────────────────────────────────────
 * Landmarks are stored as fractions of standing height, taken from adult
 * anthropometric means (crotch 0.48H, knee 0.285H, shoulder 0.80H, head
 * height 0.128H ≈ the classic 7.5-head canon). `BodyProfile.limbLength`
 * rescales limb segments, which changes standing height — so the whole rig is
 * renormalised afterwards to land exactly on `BodyProfile.height`.
 */

import * as THREE from 'three';
import type { BodyArchetype, BodyProfile, BoneName } from '@/types';
import { clamp } from '@/util';

/* -------------------------------------------------------------------------- */
/* Bone table                                                                 */
/* -------------------------------------------------------------------------- */

/** Every bone, parents strictly before children. */
export const BONE_ORDER: readonly BoneName[] = [
  'Hips',
  'Spine',
  'Spine1',
  'Spine2',
  'Neck',
  'Head',
  'HeadTop_End',
  'LeftShoulder',
  'LeftArm',
  'LeftForeArm',
  'LeftHand',
  'LeftHandIndex1',
  'LeftHandThumb1',
  'RightShoulder',
  'RightArm',
  'RightForeArm',
  'RightHand',
  'RightHandIndex1',
  'RightHandThumb1',
  'LeftUpLeg',
  'LeftLeg',
  'LeftFoot',
  'LeftToeBase',
  'RightUpLeg',
  'RightLeg',
  'RightFoot',
  'RightToeBase',
];

/** Parent of each bone; `null` for the root. */
export const BONE_PARENT: Readonly<Record<BoneName, BoneName | null>> = {
  Hips: null,
  Spine: 'Hips',
  Spine1: 'Spine',
  Spine2: 'Spine1',
  Neck: 'Spine2',
  Head: 'Neck',
  HeadTop_End: 'Head',
  LeftShoulder: 'Spine2',
  LeftArm: 'LeftShoulder',
  LeftForeArm: 'LeftArm',
  LeftHand: 'LeftForeArm',
  LeftHandIndex1: 'LeftHand',
  LeftHandThumb1: 'LeftHand',
  RightShoulder: 'Spine2',
  RightArm: 'RightShoulder',
  RightForeArm: 'RightArm',
  RightHand: 'RightForeArm',
  RightHandIndex1: 'RightHand',
  RightHandThumb1: 'RightHand',
  LeftUpLeg: 'Hips',
  LeftLeg: 'LeftUpLeg',
  LeftFoot: 'LeftLeg',
  LeftToeBase: 'LeftFoot',
  RightUpLeg: 'Hips',
  RightLeg: 'RightUpLeg',
  RightFoot: 'RightLeg',
  RightToeBase: 'RightFoot',
};

/* -------------------------------------------------------------------------- */
/* Normalised proportions                                                     */
/* -------------------------------------------------------------------------- */

/** Landmark table in fractions of standing height. */
interface Proportions {
  ankleY: number;
  kneeY: number;
  hipJointY: number;
  hipJointX: number;
  ankleX: number;
  crotchY: number;
  hipsY: number;
  spineY: number;
  spine1Y: number;
  spine2Y: number;
  neckY: number;
  chinY: number;
  headY: number;
  headTopY: number;
  shoulderY: number;
  shoulderX: number;
  clavicleY: number;
  clavicleX: number;
  upperArm: number;
  foreArm: number;
  hand: number;
  footForward: number;
  toeForward: number;
  heelBack: number;
  /** Forward lean of the upper spine, in fractions of height. */
  hunch: number;
  /** Downward droop of the T-pose arms, radians. */
  armDroop: number;
}

/** Adult reference, before archetype and profile adjustment. */
function baseProportions(): Proportions {
  return {
    ankleY: 0.039,
    kneeY: 0.285,
    hipJointY: 0.53,
    hipJointX: 0.055,
    ankleX: 0.045,
    crotchY: 0.48,
    hipsY: 0.545,
    spineY: 0.585,
    spine1Y: 0.65,
    spine2Y: 0.715,
    neckY: 0.822,
    chinY: 0.87,
    headY: 0.885,
    headTopY: 1.0,
    shoulderY: 0.8,
    shoulderX: 0.105,
    clavicleY: 0.795,
    clavicleX: 0.03,
    upperArm: 0.18,
    foreArm: 0.145,
    hand: 0.098,
    footForward: 0.1,
    toeForward: 0.03,
    heelBack: 0.022,
    hunch: 0,
    armDroop: (7 * Math.PI) / 180,
  };
}

/** Per-archetype multipliers on the reference table. */
interface ArchetypeTweak {
  readonly leg: number;
  readonly arm: number;
  readonly head: number;
  readonly shoulder: number;
  readonly hunch: number;
}

const ARCHETYPE_TWEAKS: Readonly<Record<BodyArchetype, ArchetypeTweak>> = {
  hero: { leg: 1.0, arm: 1.0, head: 1.0, shoulder: 1.04, hunch: 0 },
  civilian: { leg: 1.0, arm: 1.0, head: 1.0, shoulder: 1.0, hunch: 0.004 },
  child: { leg: 0.86, arm: 0.9, head: 1.32, shoulder: 0.92, hunch: 0 },
  heavy: { leg: 0.96, arm: 0.97, head: 1.02, shoulder: 1.06, hunch: 0.008 },
  lithe: { leg: 1.05, arm: 1.03, head: 0.97, shoulder: 0.94, hunch: 0 },
  monsterHumanoid: { leg: 0.98, arm: 1.18, head: 1.08, shoulder: 1.18, hunch: 0.03 },
  monsterBeast: { leg: 0.86, arm: 1.34, head: 1.14, shoulder: 1.24, hunch: 0.062 },
};

/* -------------------------------------------------------------------------- */
/* Dimensions                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every landmark the mesh generator needs, in METRES, already scaled so the
 * crown of the skull sits at `standingHeight`.
 */
export interface RigDimensions {
  readonly profile: BodyProfile;
  /** Achieved crown height in metres (`height * uniformScale`). */
  readonly standingHeight: number;
  /** Metres per unit of the normalised proportion table. */
  readonly unit: number;

  readonly ankleY: number;
  readonly kneeY: number;
  readonly hipJointY: number;
  readonly hipJointX: number;
  readonly ankleX: number;
  readonly crotchY: number;
  readonly hipsY: number;
  readonly spineY: number;
  readonly spine1Y: number;
  readonly spine2Y: number;
  readonly neckY: number;
  readonly chinY: number;
  readonly headY: number;
  readonly headTopY: number;
  readonly shoulderY: number;
  readonly shoulderX: number;
  readonly clavicleY: number;
  readonly clavicleX: number;
  readonly upperArm: number;
  readonly foreArm: number;
  readonly hand: number;
  readonly footForward: number;
  readonly toeForward: number;
  readonly heelBack: number;
  readonly hunch: number;
  readonly armDroop: number;
  readonly thigh: number;
  readonly shank: number;
  /** Unit direction the left arm travels in the bind pose. */
  readonly leftArmDir: THREE.Vector3;
  /** Head scale factor already folded into the head landmarks. */
  readonly headScale: number;
}

/** Resolve a profile into concrete, metre-space landmarks. */
export function resolveDimensions(profile: BodyProfile): RigDimensions {
  const p = baseProportions();
  const tweak = ARCHETYPE_TWEAKS[profile.archetype];

  const limb = Math.max(0.4, profile.limbLength);
  const headScale = Math.max(0.4, profile.headScale) * tweak.head;

  // --- Legs. Scaling the leg moves every landmark above the hip. -----------
  const legScale = limb * tweak.leg;
  const baseThigh = p.hipJointY - p.kneeY;
  const baseShank = p.kneeY - p.ankleY;
  const thigh = baseThigh * legScale;
  const shank = baseShank * legScale;
  const ankleY = p.ankleY;
  const kneeY = ankleY + shank;
  const hipJointY = kneeY + thigh;
  const rise = hipJointY - p.hipJointY;

  // --- Torso stack rides on top of the hip joint. --------------------------
  const crotchY = p.crotchY + rise;
  const hipsY = p.hipsY + rise;
  const spineY = p.spineY + rise;
  const spine1Y = p.spine1Y + rise;
  const spine2Y = p.spine2Y + rise;
  const neckY = p.neckY + rise;
  // The skull scales about the CHIN: a big head grows up and out, it does not
  // sink into the ribcage. That is what keeps child and hero proportions
  // reading correctly from the same table.
  const chinY = p.chinY + rise;
  const headBaseY = chinY + (p.headY - p.chinY) * headScale;
  const headTopY = chinY + (p.headTopY - p.chinY) * headScale;
  const shoulderY = p.shoulderY + rise;
  const clavicleY = p.clavicleY + rise;

  // --- Arms. ---------------------------------------------------------------
  const armScale = limb * tweak.arm;
  const upperArm = p.upperArm * armScale;
  const foreArm = p.foreArm * armScale;
  const hand = p.hand * armScale;
  const shoulderX = p.shoulderX * profile.shoulderWidth * tweak.shoulder;
  const clavicleX = p.clavicleX * profile.shoulderWidth * tweak.shoulder;

  // Renormalise: the crown must land exactly on the requested height.
  const nominal = headTopY;
  const unit = (profile.height * profile.uniformScale) / nominal;

  const droop = p.armDroop;
  const leftArmDir = new THREE.Vector3(-Math.cos(droop), -Math.sin(droop), 0).normalize();

  return {
    profile,
    standingHeight: profile.height * profile.uniformScale,
    unit,
    ankleY: ankleY * unit,
    kneeY: kneeY * unit,
    hipJointY: hipJointY * unit,
    hipJointX: p.hipJointX * unit,
    ankleX: p.ankleX * unit,
    crotchY: crotchY * unit,
    hipsY: hipsY * unit,
    spineY: spineY * unit,
    spine1Y: spine1Y * unit,
    spine2Y: spine2Y * unit,
    neckY: neckY * unit,
    chinY: chinY * unit,
    headY: headBaseY * unit,
    headTopY: headTopY * unit,
    shoulderY: shoulderY * unit,
    shoulderX: shoulderX * unit,
    clavicleY: clavicleY * unit,
    clavicleX: clavicleX * unit,
    upperArm: upperArm * unit,
    foreArm: foreArm * unit,
    hand: hand * unit,
    footForward: p.footForward * unit * Math.sqrt(limb),
    toeForward: p.toeForward * unit * Math.sqrt(limb),
    heelBack: p.heelBack * unit * Math.sqrt(limb),
    hunch: (p.hunch + tweak.hunch) * unit,
    armDroop: droop,
    thigh: thigh * unit,
    shank: shank * unit,
    leftArmDir,
    headScale,
  };
}

/* -------------------------------------------------------------------------- */
/* Skeleton construction                                                      */
/* -------------------------------------------------------------------------- */

/** A built skeleton plus the lookups the generator and gameplay need. */
export interface HumanoidRig {
  readonly root: THREE.Bone;
  readonly bones: readonly THREE.Bone[];
  readonly skeleton: THREE.Skeleton;
  readonly dims: RigDimensions;
  /** Index into `bones` (and therefore into `skinIndex`) by canonical name. */
  readonly index: Readonly<Record<BoneName, number>>;
  /** Model-space bind position of every bone. */
  readonly restPosition: Readonly<Record<BoneName, THREE.Vector3>>;
  get(name: BoneName): THREE.Bone;
}

/** Model-space bind positions for every bone, derived from the dimensions. */
export function restPositions(d: RigDimensions): Record<BoneName, THREE.Vector3> {
  const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

  // Character faces -Z, so the character's LEFT is -X.
  const armDir = d.leftArmDir;
  const shoulderL = v(-d.shoulderX, d.shoulderY, -d.hunch * 0.81);
  const elbowL = shoulderL.clone().addScaledVector(armDir, d.upperArm);
  const wristL = elbowL.clone().addScaledVector(armDir, d.foreArm);
  const knuckleL = wristL.clone().addScaledVector(armDir, d.hand * 0.46);
  // Palms face down in the bind pose, so the thumb points forward (-Z).
  const thumbL = wristL
    .clone()
    .addScaledVector(armDir, d.hand * 0.2)
    .add(v(0, 0, -d.hand * 0.3));

  const mirror = (p: THREE.Vector3): THREE.Vector3 => v(-p.x, p.y, p.z);

  const hunchAt = (t: number): number => -d.hunch * t * t;

  return {
    Hips: v(0, d.hipsY, 0),
    Spine: v(0, d.spineY, hunchAt(0.25)),
    Spine1: v(0, d.spine1Y, hunchAt(0.55)),
    Spine2: v(0, d.spine2Y, hunchAt(0.85)),
    Neck: v(0, d.neckY, hunchAt(1.0)),
    Head: v(0, d.headY, hunchAt(1.0) - d.hunch * 0.25),
    HeadTop_End: v(0, d.headTopY, hunchAt(1.0) - d.hunch * 0.25),

    LeftShoulder: v(-d.clavicleX, d.clavicleY, hunchAt(0.9)),
    LeftArm: shoulderL,
    LeftForeArm: elbowL,
    LeftHand: wristL,
    LeftHandIndex1: knuckleL,
    LeftHandThumb1: thumbL,

    RightShoulder: v(d.clavicleX, d.clavicleY, hunchAt(0.9)),
    RightArm: mirror(shoulderL),
    RightForeArm: mirror(elbowL),
    RightHand: mirror(wristL),
    RightHandIndex1: mirror(knuckleL),
    RightHandThumb1: mirror(thumbL),

    LeftUpLeg: v(-d.hipJointX, d.hipJointY, 0),
    LeftLeg: v(-d.hipJointX * 0.92, d.kneeY, 0),
    LeftFoot: v(-d.ankleX, d.ankleY, 0),
    LeftToeBase: v(-d.ankleX, d.ankleY * 0.55, -d.footForward),

    RightUpLeg: v(d.hipJointX, d.hipJointY, 0),
    RightLeg: v(d.hipJointX * 0.92, d.kneeY, 0),
    RightFoot: v(d.ankleX, d.ankleY, 0),
    RightToeBase: v(d.ankleX, d.ankleY * 0.55, -d.footForward),
  };
}

/**
 * Build the bone tree and bind a `THREE.Skeleton` to it.
 *
 * The skeleton is created only AFTER world matrices are up to date, because
 * `Skeleton` snapshots each bone's inverse world matrix at construction — that
 * snapshot IS the bind pose, and getting it from a stale matrix is the classic
 * way to end up with a character folded inside out.
 */
export function buildRig(profile: BodyProfile): HumanoidRig {
  const dims = resolveDimensions(profile);
  const rest = restPositions(dims);

  const bones = new Map<BoneName, THREE.Bone>();
  for (const name of BONE_ORDER) {
    const bone = new THREE.Bone();
    bone.name = name;
    bones.set(name, bone);
  }

  for (const name of BONE_ORDER) {
    const bone = bones.get(name)!;
    const parentName = BONE_PARENT[name];
    const world = rest[name];
    if (parentName === null) {
      bone.position.copy(world);
    } else {
      const parent = bones.get(parentName)!;
      bone.position.copy(world).sub(rest[parentName]);
      parent.add(bone);
    }
  }

  const root = bones.get('Hips')!;
  root.updateMatrixWorld(true);

  const ordered = BONE_ORDER.map((name) => bones.get(name)!);
  const skeleton = new THREE.Skeleton(ordered);

  const index = {} as Record<BoneName, number>;
  BONE_ORDER.forEach((name, i) => {
    index[name] = i;
  });

  return {
    root,
    bones: ordered,
    skeleton,
    dims,
    index,
    restPosition: rest,
    get(name: BoneName): THREE.Bone {
      return bones.get(name)!;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Small helpers shared with the shape solver                                 */
/* -------------------------------------------------------------------------- */

/** Standing height a profile asks for, clamped to something buildable. */
export function sanitizeHeight(profile: BodyProfile): number {
  return clamp(profile.height, 0.4, 12);
}
