/**
 * THE VFX MATERIALS — three programs, four materials.
 *
 * `sprite` and `decal` are built from the SAME shader source. three keys its
 * program cache on the shader source, the defines and the custom cache key —
 * NOT on blending, depth state or which textures happen to be bound. So a
 * second material instance that swaps the atlas and turns on polygon offset
 * costs one draw call and zero programs, which is the only reason the entire
 * suite fits in the five programs the renderer has left on the tier that ships
 * to phones.
 *
 * ── WHY THE UNIFORM OBJECTS ARE SHARED BY REFERENCE ────────────────────────
 * Sun direction, fog and the master intensity are written once per frame and
 * must reach every VFX material. Rather than a loop that pushes the same value
 * into four uniform objects, the materials literally hold the same objects.
 * Writing `shared.uIntensity.value` updates all of them, and there is no path
 * where one material silently keeps a stale sun direction.
 */

import * as THREE from 'three';
import { ATLAS_TILES, CRACK_TILES, type IVFXTierProfile } from './constants';
import {
  SHOCKWAVE_FRAGMENT,
  SHOCKWAVE_VERTEX,
  SPEEDLINES_FRAGMENT,
  SPEEDLINES_VERTEX,
  SPRITE_FRAGMENT,
  SPRITE_VERTEX,
} from './shaders';

/** Per-frame globals every VFX material reads. Shared by reference. */
export interface IVFXSharedUniforms {
  /** Sun TRAVEL direction in VIEW space. Recomputed on the CPU each frame. */
  readonly uSunView: { value: THREE.Vector3 };
  readonly uSunColor: { value: THREE.Color };
  readonly uAmbientColor: { value: THREE.Color };
  readonly uFogColor: { value: THREE.Color };
  readonly uFogDensity: { value: number };
  /** Master fade, 0..1. Used to dim the whole suite, e.g. in a menu. */
  readonly uIntensity: { value: number };
  /** Colour of freshly exposed concrete at a crack lip. */
  readonly uDecalRim: { value: THREE.Color };
}

/** Build the shared uniform block. */
export function createSharedUniforms(): IVFXSharedUniforms {
  return {
    uSunView: { value: new THREE.Vector3(0, -1, 0) },
    uSunColor: { value: new THREE.Color(0xfff0d6) },
    uAmbientColor: { value: new THREE.Color(0x2c3648) },
    uFogColor: { value: new THREE.Color(0xa9c0d8) },
    uFogDensity: { value: 0.0022 },
    uIntensity: { value: 1 },
    uDecalRim: { value: new THREE.Color(0xbdb6ab) },
  };
}

/**
 * Premultiplied-alpha blending.
 *
 * `NormalBlending` plus `premultipliedAlpha` resolves to
 * `ONE, ONE_MINUS_SRC_ALPHA`, which lets one fragment shader emit additive
 * glow, alpha compositing or multiplicative darkening depending on the values
 * it writes. Every effect in this system depends on that.
 */
function applyPremultipliedBlend(material: THREE.ShaderMaterial): void {
  material.transparent = true;
  material.blending = THREE.NormalBlending;
  material.premultipliedAlpha = true;
  material.depthWrite = false;
  material.toneMapped = true;
}

/** The instanced sprite material: dust, clouds, sparks, flashes, streaks. */
export function createSpriteMaterial(
  atlas: THREE.Texture,
  shared: IVFXSharedUniforms,
  profile: IVFXTierProfile
): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    name: 'vfx.sprite',
    vertexShader: SPRITE_VERTEX,
    fragmentShader: SPRITE_FRAGMENT,
    defines: { VFX_QUALITY: profile.shaderQuality },
    uniforms: {
      uAtlas: { value: atlas },
      uAtlasTiles: { value: ATLAS_TILES },
      uSunView: shared.uSunView,
      uSunColor: shared.uSunColor,
      uAmbientColor: shared.uAmbientColor,
      uFogColor: shared.uFogColor,
      uFogDensity: shared.uFogDensity,
      uIntensity: shared.uIntensity,
      uDecalRim: shared.uDecalRim,
    },
    // Streaks and surface quads can be seen from either face.
    side: THREE.DoubleSide,
    depthTest: true,
  });
  applyPremultipliedBlend(material);
  return material;
}

/**
 * The ground-crack material.
 *
 * Same program as the sprites. The polygon offset is what keeps a decal lying
 * on a road out of a z-fight with it; the negative units pull it toward the
 * camera in depth without moving it in space, so it stays flat on uneven
 * ground instead of hovering.
 */
export function createDecalMaterial(
  crackAtlas: THREE.Texture,
  shared: IVFXSharedUniforms,
  profile: IVFXTierProfile
): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    name: 'vfx.decal',
    vertexShader: SPRITE_VERTEX,
    fragmentShader: SPRITE_FRAGMENT,
    defines: { VFX_QUALITY: profile.shaderQuality },
    uniforms: {
      uAtlas: { value: crackAtlas },
      uAtlasTiles: { value: CRACK_TILES },
      uSunView: shared.uSunView,
      uSunColor: shared.uSunColor,
      uAmbientColor: shared.uAmbientColor,
      uFogColor: shared.uFogColor,
      uFogDensity: shared.uFogDensity,
      uIntensity: shared.uIntensity,
      uDecalRim: shared.uDecalRim,
    },
    side: THREE.DoubleSide,
    depthTest: true,
  });
  applyPremultipliedBlend(material);
  material.polygonOffset = true;
  material.polygonOffsetFactor = -4;
  material.polygonOffsetUnits = -8;
  return material;
}

/** The shockwave shell material. */
export function createShockwaveMaterial(
  shared: IVFXSharedUniforms,
  profile: IVFXTierProfile
): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    name: 'vfx.shockwave',
    vertexShader: SHOCKWAVE_VERTEX,
    fragmentShader: SHOCKWAVE_FRAGMENT,
    defines: { VFX_QUALITY: profile.shaderQuality },
    uniforms: {
      uFogColor: shared.uFogColor,
      uFogDensity: shared.uFogDensity,
      uIntensity: shared.uIntensity,
    },
    // The player is regularly INSIDE the cone. Culling either face would make
    // the wave vanish at exactly the moment it is most impressive.
    side: THREE.DoubleSide,
    depthTest: true,
  });
  applyPremultipliedBlend(material);
  return material;
}

/** The full-screen speedline overlay material. */
export function createSpeedlinesMaterial(profile: IVFXTierProfile): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    name: 'vfx.speedlines',
    vertexShader: SPEEDLINES_VERTEX,
    fragmentShader: SPEEDLINES_FRAGMENT,
    defines: { VFX_QUALITY: profile.shaderQuality },
    uniforms: {
      uAspect: { value: new THREE.Vector2(1.78, 1) },
      uFocus: { value: new THREE.Vector2(0, 0) },
      uColor: { value: new THREE.Color(0xffffff) },
      uIntensity: { value: 0 },
      uInner: { value: 0.55 },
      uDensity: { value: 150 },
      uGlow: { value: 1.15 },
      uPhase: { value: 0 },
    },
    depthTest: false,
    side: THREE.FrontSide,
  });
  applyPremultipliedBlend(material);
  return material;
}
