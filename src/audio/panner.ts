/**
 * 3D POSITIONAL AUDIO
 *
 * Every one-shot voice owns a `PannerNode` for its entire lifetime — the node
 * is built with the voice and reconfigured on trigger, never allocated per
 * impact.
 *
 * DESIGN NOTES
 *  • `panningModel` is 'equalpower', not 'HRTF'. HRTF convolution is roughly
 *    an order of magnitude more expensive per voice and is inaudible through
 *    a phone speaker, which is the primary output for this game.
 *  • `distanceModel` is 'inverse' — the physically correct 1/r law. A city
 *    block is ~80 m, so `refDistance` defaults to 6 m and `maxDistance` to
 *    500 m: a serious punch stays audible across several blocks while a
 *    footstep does not.
 *  • The positional and dry paths are separate gain nodes rather than a
 *    reconnect, because `connect`/`disconnect` on the audio thread is far more
 *    expensive than writing a gain value, and 2D/3D flips happen per trigger.
 *  • Both the AudioParam form (`positionX`) and the legacy setter form
 *    (`setPosition`) are supported. Chromium exposes the former; some
 *    WebViews still only expose the latter.
 */

import type { Vec3 } from '@/types';

/** Distance attenuation configuration for a spatial voice. */
export interface ISpatialSettings {
  /** Distance in metres at which attenuation begins. */
  readonly refDistance: number;
  /** Distance beyond which the sound is inaudible. */
  readonly maxDistance: number;
  /** How aggressively level falls with distance. 1 is the physical 1/r law. */
  readonly rolloffFactor: number;
}

/** Sensible per-voice-class defaults, in metres. */
export const SPATIAL_DEFAULTS: ISpatialSettings = {
  refDistance: 6,
  maxDistance: 500,
  rolloffFactor: 1,
};

/** Create a configured panner. Called once per voice, at construction. */
export function createSpatialPanner(
  ctx: BaseAudioContext,
  settings: ISpatialSettings = SPATIAL_DEFAULTS
): PannerNode {
  const panner = ctx.createPanner();
  panner.panningModel = 'equalpower';
  panner.distanceModel = 'inverse';
  panner.refDistance = settings.refDistance;
  panner.maxDistance = settings.maxDistance;
  panner.rolloffFactor = settings.rolloffFactor;
  // Omnidirectional: game sound sources are not cones.
  panner.coneInnerAngle = 360;
  panner.coneOuterAngle = 360;
  panner.coneOuterGain = 1;
  return panner;
}

/** Apply distance settings to an existing panner (voices are reused across calls). */
export function configurePanner(panner: PannerNode, settings: ISpatialSettings): void {
  panner.refDistance = Math.max(settings.refDistance, 0.01);
  panner.maxDistance = Math.max(settings.maxDistance, panner.refDistance + 0.01);
  panner.rolloffFactor = Math.max(settings.rolloffFactor, 0);
}

/** Node exposing the modern AudioParam position interface. */
interface PositionParams {
  positionX?: AudioParam;
  positionY?: AudioParam;
  positionZ?: AudioParam;
  setPosition?: (x: number, y: number, z: number) => void;
}

/** Node exposing the modern AudioParam orientation interface. */
interface OrientationParams {
  forwardX?: AudioParam;
  forwardY?: AudioParam;
  forwardZ?: AudioParam;
  upX?: AudioParam;
  upY?: AudioParam;
  upZ?: AudioParam;
  setOrientation?: (x: number, y: number, z: number, ux: number, uy: number, uz: number) => void;
}

/**
 * Move a panner or the listener. `time` schedules the move on the audio
 * timeline where AudioParams are available, which avoids the zipper noise a
 * per-frame `setPosition` produces on a fast-moving source.
 */
export function setSpatialPosition(
  target: PannerNode | AudioListener,
  position: Vec3,
  time: number
): void {
  const t = target as unknown as PositionParams;
  if (t.positionX && t.positionY && t.positionZ) {
    t.positionX.setValueAtTime(position.x, time);
    t.positionY.setValueAtTime(position.y, time);
    t.positionZ.setValueAtTime(position.z, time);
    return;
  }
  t.setPosition?.(position.x, position.y, position.z);
}

/** Orient the listener from a camera basis. */
export function setListenerOrientation(
  listener: AudioListener,
  forward: Vec3,
  up: Vec3,
  time: number
): void {
  const l = listener as unknown as OrientationParams;
  if (l.forwardX && l.forwardY && l.forwardZ && l.upX && l.upY && l.upZ) {
    l.forwardX.setValueAtTime(forward.x, time);
    l.forwardY.setValueAtTime(forward.y, time);
    l.forwardZ.setValueAtTime(forward.z, time);
    l.upX.setValueAtTime(up.x, time);
    l.upY.setValueAtTime(up.y, time);
    l.upZ.setValueAtTime(up.z, time);
    return;
  }
  l.setOrientation?.(forward.x, forward.y, forward.z, up.x, up.y, up.z);
}

/**
 * Squared distance from the listener, used for voice-priority decisions
 * (a far-away debris impact loses to a near one) without a `Math.sqrt`.
 */
export function distanceSqTo(listener: Vec3, position: Vec3): number {
  const dx = position.x - listener.x;
  const dy = position.y - listener.y;
  const dz = position.z - listener.z;
  return dx * dx + dy * dy + dz * dz;
}
