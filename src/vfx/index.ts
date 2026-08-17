/**
 * VFX BARREL
 *
 *   import { VFXSystem } from '@/vfx';
 *
 * The spectacle system. Saitama always wins, so nothing in this game is a
 * question of whether the punch lands — the entire payoff is in how it looks,
 * and this is where that lives.
 *
 * ── WHAT IT OWNS ───────────────────────────────────────────────────────────
 *   vfx-system.ts      the `IVFXSystem` implementation and the event wiring
 *   effects.ts         the recipes: what a punch actually looks like
 *   shockwave-layer.ts the signature expanding cone/ring
 *   sprite-layer.ts    every particle, in one draw call
 *   decal-layer.ts     the ground cracks the city keeps
 *   speedlines.ts      the anime overlay
 *   camera-shake.ts    trauma-based shake (`ICameraShake`)
 *   atlas.ts           the procedurally generated textures
 *   shaders.ts         the three shader programs, and only three
 *
 * ── WHAT IT DOES NOT OWN ───────────────────────────────────────────────────
 * No hit detection, no destruction, no camera. It subscribes to the event bus
 * and reacts; it imports neither `src/gameplay/**` nor `src/engine/**`, per the
 * architectural rule. The impact freeze belongs to the renderer — effects here
 * are TIMED to read well while it holds, and never reimplement it.
 */

export {
  VFXSystem,
  type IVFXSystemOptions,
  type IVFXDiagnostics,
} from './vfx-system';

export { CameraShake, type ICameraShakeOptions } from './camera-shake';
export { Speedlines, type ISpeedlinesOptions } from './speedlines';

export {
  SpriteLayer,
  createSpriteParams,
  type ISpriteParams,
} from './sprite-layer';
export { DecalLayer, createDecalParams, type IDecalParams } from './decal-layer';
export {
  ShockwaveLayer,
  createShockwaveParams,
  type IShockwaveParams,
} from './shockwave-layer';
export { EffectEmitters } from './effects';

export {
  createParticleAtlas,
  createCrackAtlas,
  atlasBytes,
} from './atlas';

export {
  createQuadGeometry,
  createArcGridGeometry,
  createFullScreenGeometry,
} from './geometry';

export {
  createSharedUniforms,
  createSpriteMaterial,
  createDecalMaterial,
  createShockwaveMaterial,
  createSpeedlinesMaterial,
  type IVFXSharedUniforms,
} from './materials';

export {
  SPRITE_VERTEX,
  SPRITE_FRAGMENT,
  SHOCKWAVE_VERTEX,
  SHOCKWAVE_FRAGMENT,
  SPEEDLINES_VERTEX,
  SPEEDLINES_FRAGMENT,
} from './shaders';

export {
  VFX_DRAW_CALL_BUDGET,
  VFX_PROGRAM_BUDGET,
  VFX_TIER_PROFILES,
  vfxProfileFor,
  effectCapacityFor,
  ATLAS_TILES,
  CRACK_TILES,
  SpriteTile,
  SpriteMode,
  CrackTile,
  DUST_TILES,
  DUST_COLOR,
  DUST_COLOR_DARK,
  SHOCK_COLOR,
  SPARK_COLOR,
  CLOUD_COLOR,
  INTENT_POWER,
  type IVFXTierProfile,
} from './constants';
