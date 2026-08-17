/**
 * ══════════════════════════════════════════════════════════════════════════
 *  PLAYER — public surface
 *
 *    import { PlayerRig, createPhysicsCameraProbe } from '@/entities/player';
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Saitama's locomotion feel and the third-person camera that frames it.
 *
 * ── WHAT LIVES HERE ────────────────────────────────────────────────────────
 *   tuning.ts             every tunable number, with the reasoning attached
 *   locomotion.ts         the eight-state machine and its transition table
 *   player-controller.ts  intent → acceleration → coyote/buffer → jump → land
 *   camera-rig.ts         spring arm, collision sweep, FOV, impact lag
 *   player.ts             the two of them wired in the right order
 *
 * ── WHAT DOES NOT ──────────────────────────────────────────────────────────
 * Collision solving, gravity, slopes and the ground slam are the physics
 * module's (`ICharacterController`); reading a thumb is the input module's
 * (`InputState`); hit-stop and the FOV punch are the renderer's. This module
 * consumes all three through CONTRACTS in `src/types/` and reaches combat and
 * physics only over the event bus — it imports no other system's code.
 *
 * ── WIRING IT UP ───────────────────────────────────────────────────────────
 *
 *   const player = new PlayerRig({
 *     controller: physics.createCharacterController(spawn, 1.75, 0.3),
 *     camera: engineCamera,
 *     probe: createPhysicsCameraProbe(physics, { exclude: [capsuleHandle] }),
 *     bus,
 *     character,                      // optional; animator may be absent
 *   });
 *
 *   function frame(frameIndex: number, time: number, dt: number) {
 *     const input = inputManager.poll(frameIndex, time);
 *     player.update(input, dt);       // decides + commands the move
 *     physics.step(fixedStep, steps); // the move is APPLIED here
 *     player.postPhysics(input, dt);  // re-read, then frame it
 *   }
 *
 * ── THE NUMBERS THIS WORKSTREAM COMMITS TO ─────────────────────────────────
 *   run 9 m/s · dash 22 m/s · tap-jump apex ~12 m · held-jump apex ~27 m
 *   coyote 120 ms · jump buffer 150 ms · crater above a 15 m fall
 *   camera arm 4.5 m resting / 9 m charging / 14 m at apex · FOV 55° → 72°
 * All of them are measured, not asserted, by `harness/player.verify.ts`.
 */

/* -- tuning ---------------------------------------------------------------- */
export {
  DEFAULT_PLAYER_TUNING,
  DEFAULT_LOCOMOTION_TUNING,
  DEFAULT_CAMERA_TUNING,
  resolvePlayerTuning,
  apexForLaunchSpeed,
  heldJumpSpeedCeiling,
  heldJumpApex,
  landingRecoverySeconds,
  turnRateRadPerSec,
  type IPlayerTuning,
  type IPlayerTuningPatch,
  type IPlayerLocomotionTuning,
  type IPlayerCameraTuning,
} from './tuning';

/* -- state machine --------------------------------------------------------- */
export {
  LocomotionStateMachine,
  PLAYER_LOCO_STATES,
  isAirborneState,
  isRecoveryState,
  resolveGroundState,
  toActorState,
  toClipName,
  type PlayerLocoState,
} from './locomotion';

/* -- controller ------------------------------------------------------------ */
export {
  PlayerController,
  type IPlayerControllerOptions,
  type IPlayerDiagnostics,
  type IPlayerLandingInfo,
} from './player-controller';

/* -- camera ---------------------------------------------------------------- */
export {
  ThirdPersonCameraRig,
  createPhysicsCameraProbe,
  type ICameraDiagnostics,
  type ICameraProbe,
  type ICameraTarget,
  type IPhysicsCameraProbeOptions,
  type IThirdPersonCameraOptions,
} from './camera-rig';

/* -- composition ----------------------------------------------------------- */
export { PlayerRig, type IPlayerRigOptions } from './player';
