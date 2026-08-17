/**
 * SHARED UTILITIES BARREL
 *
 *   import { createRng, clamp, EventBus, createLogger } from '@/util';
 *
 * Systems may import from `src/types/` and `src/util/` ONLY — never from
 * another system's implementation. Everything here is dependency-free
 * (aside from the type contracts) and safe for any system to use.
 *
 * Unlike `src/types/`, these are REAL runtime modules.
 */

export { createRng, createChunkRng, hashString, hashCoord, mixSeeds, type IRandom } from './rng';

export { EventBus, createEventBus, type IEventBusOptions } from './event-bus';

export {
  DEG2RAD,
  RAD2DEG,
  TAU,
  EPSILON,
  clamp,
  clamp01,
  lerp,
  inverseLerp,
  remap,
  remapClamped,
  damp,
  smoothstep,
  smootherstep,
  moveTowards,
  mod,
  wrapAngle,
  angleDelta,
  lerpAngle,
  dampAngle,
  approximately,
  distanceSq2,
  distanceSq3,
  isPowerOfTwo,
  nextPowerOfTwo,
  snap,
  applyDeadZone,
  falloff,
  saturate,
} from './math';

export { ObjectPool, FixedPool, type IPoolOptions, type IPoolStats } from './pool';

export { RingBuffer, NumericRingBuffer } from './ring-buffer';

export {
  createLogger,
  log,
  setLogLevel,
  getLogLevel,
  muteNamespace,
  unmuteNamespace,
  resetLogState,
  type ILogger,
  type LogLevel,
} from './logger';
