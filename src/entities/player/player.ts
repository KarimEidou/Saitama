/**
 * PLAYER COMPOSITION
 *
 * `PlayerController` and `ThirdPersonCameraRig` are usable on their own, and
 * unit-tested that way. In a running game they are always paired, and the
 * pairing has an ORDER that is easy to get wrong and hard to notice when you
 * do:
 *
 *   1. camera yaw is copied into the controller — the stick is camera-relative,
 *      so movement must be resolved against the yaw the player can SEE, which
 *      is last frame's;
 *   2. the controller decides and commands one kinematic move;
 *   3. the caller steps physics;
 *   4. the controller re-reads the solved transform;
 *   5. only then does the camera frame it.
 *
 * Get 1 and 5 the other way round and the character drifts off-centre at speed
 * while the camera chases a position it has already invalidated. `PlayerRig`
 * exists so that order is written once.
 *
 * ── PHYSICS STEPPING IS NOT OWNED HERE ─────────────────────────────────────
 * The rig deliberately does NOT step the world. The game loop owns the fixed
 * timestep accumulator, and a system that steps physics on its own schedule is
 * how you end up with two accumulators and a non-deterministic build.
 */

import type * as THREE from 'three';
import type { InputState } from '@/types';
import {
  PlayerController,
  type IPlayerControllerOptions,
} from './player-controller';
import {
  ThirdPersonCameraRig,
  type ICameraProbe,
  type IThirdPersonCameraOptions,
} from './camera-rig';
import { DEFAULT_PLAYER_TUNING, type IPlayerTuning } from './tuning';

export interface IPlayerRigOptions extends Omit<IPlayerControllerOptions, 'tuning'> {
  readonly camera: THREE.PerspectiveCamera;
  readonly tuning?: IPlayerTuning;
  /** World geometry probe for the camera arm. */
  readonly probe?: ICameraProbe | null;
  /** Starting camera azimuth. Defaults to the controller's starting yaw. */
  readonly cameraYaw?: number;
  readonly cameraPitchDeg?: number;
  /** Let the rig write `camera.fov`. */
  readonly driveFov?: boolean;
}

/**
 * The player: a locomotion controller and the camera that frames it, wired in
 * the correct order.
 */
export class PlayerRig {
  readonly controller: PlayerController;
  readonly camera: ThirdPersonCameraRig;

  private disposed = false;

  constructor(options: IPlayerRigOptions) {
    const tuning = options.tuning ?? DEFAULT_PLAYER_TUNING;
    this.controller = new PlayerController({ ...options, tuning });

    const cameraOptions: IThirdPersonCameraOptions = {
      camera: options.camera,
      target: this.controller,
      tuning,
      probe: options.probe ?? null,
      bus: options.bus,
      yaw: options.cameraYaw ?? this.controller.yaw,
      pitchDeg: options.cameraPitchDeg,
      driveFov: options.driveFov,
    };
    this.camera = new ThirdPersonCameraRig(cameraOptions);
    this.controller.cameraYaw = this.camera.yaw;
  }

  /**
   * Steps 1-2: resolve intent against the camera the player can see, and
   * command one kinematic move. Call `postPhysics()` after stepping the world.
   */
  update(input: InputState, dt: number): void {
    if (this.disposed) return;
    this.controller.cameraYaw = this.camera.yaw;
    this.controller.update(input, dt);
  }

  /** Steps 4-5: re-read the solved transform, then frame it. */
  postPhysics(input: InputState, dt: number): void {
    if (this.disposed) return;
    this.controller.postStep();
    this.camera.update(input, dt);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.camera.dispose();
    this.controller.dispose();
  }
}
