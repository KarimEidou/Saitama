/**
 * PROCEDURAL ANIMATION
 *
 *   import { ProceduralAnimator, bakeVat } from '@/characters/anim';
 *
 * Attaches an `IAnimator` to the parts the mesh generator produces, completing
 * an `ICharacterInstance`:
 *
 *   const parts = createCharacterParts(build, material);       // mesh system
 *   const animator = new ProceduralAnimator(parts, parts.root, {
 *     variants: { idle: 'bored' },                             // Saitama
 *   });
 *   const character: ICharacterInstance = { ...parts, animator };
 *
 * ── WHAT IS GUARANTEED ────────────────────────────────────────────────────
 *  - A planted foot's loaded contact point moves under 0.1 mm per stance, at
 *    every speed, while accelerating, and while turning — measured through the
 *    full pipeline in `analysis.ts`, not asserted.
 *  - The gait is frame-rate independent: an 8x change in time step moves no
 *    bone by more than 0.05 degrees, so the offline VAT bake and the runtime
 *    produce the same animation.
 *  - Bones never stretch (rotation-only, ~1e-7 relative), knees never invert,
 *    and no sole ever penetrates the ground — across a 1.22 m child, a 2.45 m
 *    monster and everything between.
 *  - Same seed and same input sequence produce a bit-identical pose sequence.
 *    `Math.random` appears nowhere.
 *  - Twenty-one clips covering all seventeen `ClipName` slots, including
 *    Saitama's bored slouch and its yawn.
 *
 * All of the above is asserted in `__tests__`, not merely intended.
 */

export {
  ProceduralAnimator,
  allClips,
  type AnimatorOptions,
} from './animator';

export {
  LocomotionSolver,
  solveGait,
  type LocomotionOptions,
} from './locomotion';

export {
  CLIP_LIBRARY,
  clipDuration,
  clipSpeed,
  defaultClipParams,
  findClip,
  hasClip,
  type ClipContext,
  type ClipEntry,
  type ClipFn,
} from './clips';

export {
  bakeAnimationClips,
  maskFor,
  sampleClip,
  toAnimationClip,
  type SampleOptions,
} from './bake';

export {
  applyVatSkinning,
  bakeVat,
  readVatMatrix,
  sampleVatMatrix,
  vatClipFps,
  vatInstanceAttribute,
  TEXELS_PER_BONE,
  type VatBake,
  type VatClipRange,
  type VatInstance,
  type VatOptions,
  type VatUniforms,
} from './vat';

export {
  makeChain,
  setModelRotation,
  solveChain,
  twoBoneJointPositions,
  type IKChain,
  type IKOptions,
  type IKResult,
} from './ik';

export {
  applyPose,
  blendPose,
  blendPoseMasked,
  boneModelPosition,
  capturePose,
  copyPose,
  createPose,
  getRotation,
  getTranslation,
  lowerBodyMask,
  poseAngleDelta,
  poseEquals,
  poseToModelMatrices,
  resetPose,
  rotateBone,
  setEuler,
  setRotation,
  setTranslation,
  skinningMatrices,
  subtreeMask,
  upperBodyMask,
  UPPER_BODY_BONES,
} from './pose';

export {
  poseArm,
  poseHead,
  poseLeg,
  posePelvis,
  poseSpine,
  bump,
  springDecay,
  strikeCurve,
  type ArmPose,
  type LegPose,
  type SideSign,
  type SpinePose,
} from './posture';

export {
  clipTimeScale,
  resolveRig,
  ANIM_BONE_ORDER,
  REFERENCE_HEIGHT,
  REFERENCE_LEG,
} from './rig';

export {
  gaitProfile,
  measureFootSlide,
  measureLimbSanity,
  measureNaiveFootSlide,
  measureVatRoundTrip,
  sampleGaitPhases,
  stanceProgress,
  type FootSlideOptions,
  type FootSlideReport,
  type GaitRow,
  type LimbReport,
  type SkinnedGeometryData,
  type StanceMeasurement,
  type VatErrorReport,
} from './analysis';

export type {
  AnimEvent,
  AnimEventListener,
  AnimRig,
  BodyMetrics,
  BoneMask,
  ClipDefinition,
  ClipMarker,
  ClipParams,
  ClipVariant,
  FootPhase,
  FootReport,
  GaitName,
  GaitSolution,
  LocomotionInput,
  LocomotionReport,
  Pose,
  RagdollHandoff,
  RigLike,
} from './types';
