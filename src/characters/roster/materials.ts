/**
 * CHARACTER MATERIALS — one material, one draw call, three injections
 *
 * A roster character binds ONE `MeshStandardMaterial` to a baked atlas. Region
 * colour, weave, wear, occlusion, per-texel roughness AND per-texel metalness
 * all live in that atlas, so Genos' bare alloy forearm (metalness 1.0) and his
 * cotton shirt (metalness 0.0) render in the same draw call.
 *
 * Three shader injections extend it, all through `onBeforeCompile` on the SAME
 * material rather than as material variants, because shader PROGRAMS are the
 * scarce resource here, not materials:
 *
 *   FACE     samples a 4-tile expression strip inside the face rectangle and
 *            replaces the baked face. Swapping expression is a uniform write —
 *            no texture swap, no material swap, no draw call.
 *   CROWD    reads four instanced colour attributes and recolours by a
 *            single-channel tint mask, so one shared civilian sheet dresses an
 *            entire street.
 *   FADE     a 4x4 ordered-dither screen door driven by the camera's
 *            `armCollapseRatio`. Only the player's material carries it.
 *
 * ── WHY DITHER AND NOT ALPHA ──────────────────────────────────────────────
 * The camera collapses to ~1.5 m in a narrow alley and the player fills the
 * frame. Alpha blending would need a transparent pass, correct sorting against
 * a skinned mesh that self-overlaps constantly, and would still leave the cape
 * z-fighting with the torso. A screen door needs none of that: it stays in the
 * opaque pass, keeps depth writes, sorts correctly by construction, and costs
 * one `discard`. That `discard` is why the injection is opt-in per material —
 * a fragment shader containing one disables early-Z on many mobile GPUs, and
 * two hundred civilians must not pay for a camera problem that only ever
 * affects the player.
 */

import * as THREE from 'three';
import { clamp01 } from '@/util';
import type { Expression, FaceRect } from './types';
import { EXPRESSIONS } from './types';

/* -------------------------------------------------------------------------- */
/* Texture set                                                                */
/* -------------------------------------------------------------------------- */

/** The maps one character's material binds. */
export interface RosterTextures {
  /** Base colour, opaque RGB. */
  readonly map: THREE.Texture;
  readonly normalMap: THREE.Texture;
  /** Packed AO (R) / roughness (G) / metalness (B). */
  readonly ormMap: THREE.Texture;
  readonly emissiveMap?: THREE.Texture;
  /** Four stacked expression tiles, bottom tile = `EXPRESSIONS[0]`. */
  readonly faceMap?: THREE.Texture;
  /**
   * Single-channel per-instance tint mask. Crowd characters only.
   *
   * It is a separate map rather than the albedo's alpha channel because an
   * all-zero alpha is a minefield: libvips flattens such an image on save and
   * some browsers premultiply it to black on upload. See `AtlasMaps.mask`.
   */
  readonly maskMap?: THREE.Texture;
}

/** Options for one character's material. */
export interface RosterMaterialOptions {
  readonly name?: string;
  /** Where the face patch sits in the atlas. Required with `faceMap`. */
  readonly faceRect?: FaceRect;
  readonly expression?: Expression;
  /** Enable the instanced crowd tint injection. */
  readonly crowdTint?: boolean;
  /** Enable the camera-proximity dither. Player only. */
  readonly proximityFade?: boolean;
  readonly envMapIntensity?: number;
  readonly normalScale?: number;
  readonly emissiveIntensity?: number;
  /** Force a specific side; characters are closed solids so front is right. */
  readonly side?: THREE.Side;
}

/** Uniform handles kept on the material so callers can drive them per frame. */
export interface RosterUniforms {
  readonly faceRect: { value: THREE.Vector4 };
  readonly faceSelect: { value: THREE.Vector2 };
  readonly faceMap: { value: THREE.Texture | null };
  readonly crowdMask: { value: THREE.Texture | null };
  readonly proximityFade: { value: number };
}

/** A `MeshStandardMaterial` that carries roster uniforms. */
export type RosterMaterial = THREE.MeshStandardMaterial & {
  userData: { roster: RosterUniforms; features: string };
};

/* -------------------------------------------------------------------------- */
/* Shader chunks                                                              */
/* -------------------------------------------------------------------------- */

const FACE_DECLARATIONS = /* glsl */ `
uniform sampler2D faceMap;
uniform vec4 faceRect;
uniform vec2 faceSelect;
`;

/**
 * Sampled unconditionally and masked afterwards.
 *
 * Sampling inside an `if` leaves the implicit derivative undefined for quads
 * straddling the face rectangle, which shows up as a one-pixel mip seam around
 * the jaw. Sampling always and mixing by a step mask costs one texture fetch
 * on every character texel and is correct everywhere.
 */
const FACE_FRAGMENT = /* glsl */ `
#ifdef USE_MAP
  vec2 rosterFaceUv = (vMapUv - faceRect.xy) * faceRect.zw;
  float rosterInFace =
    step(0.0, rosterFaceUv.x) * step(rosterFaceUv.x, 1.0) *
    step(0.0, rosterFaceUv.y) * step(rosterFaceUv.y, 1.0);
  vec2 rosterTileUv = vec2(
    clamp(rosterFaceUv.x, 0.002, 0.998),
    (clamp(rosterFaceUv.y, 0.002, 0.998) + faceSelect.x) * faceSelect.y
  );
  vec4 rosterFace = texture2D(faceMap, rosterTileUv);
  diffuseColor.rgb = mix(diffuseColor.rgb, rosterFace.rgb, rosterInFace * rosterFace.a);
#endif
`;

const CROWD_VERTEX_DECLARATIONS = /* glsl */ `
attribute vec3 instanceSkin;
attribute vec3 instanceCloth;
attribute vec3 instanceAccent;
attribute vec3 instanceHair;
varying vec3 vRosterSkin;
varying vec3 vRosterCloth;
varying vec3 vRosterAccent;
varying vec3 vRosterHair;
`;

const CROWD_VERTEX_BODY = /* glsl */ `
  vRosterSkin = instanceSkin;
  vRosterCloth = instanceCloth;
  vRosterAccent = instanceAccent;
  vRosterHair = instanceHair;
`;

const CROWD_FRAGMENT_DECLARATIONS = /* glsl */ `
uniform sampler2D crowdMask;
varying vec3 vRosterSkin;
varying vec3 vRosterCloth;
varying vec3 vRosterAccent;
varying vec3 vRosterHair;
`;

/**
 * Recolour by the baked tint mask.
 *
 * Levels are 0 (fixed), 0.25 hair, 0.5 skin, 0.75 accent, 1.0 cloth — read
 * with band tests rather than branches so every fragment costs the same.
 */
const CROWD_FRAGMENT = /* glsl */ `
#ifdef USE_MAP
  float rosterMask = texture2D(crowdMask, vMapUv).r;
  vec3 rosterTint = vec3(1.0);
  rosterTint = mix(rosterTint, vRosterHair, step(0.125, rosterMask) * step(rosterMask, 0.375));
  rosterTint = mix(rosterTint, vRosterSkin, step(0.375, rosterMask) * step(rosterMask, 0.625));
  rosterTint = mix(rosterTint, vRosterAccent, step(0.625, rosterMask) * step(rosterMask, 0.875));
  rosterTint = mix(rosterTint, vRosterCloth, step(0.875, rosterMask));
  diffuseColor.rgb *= rosterTint;
#endif
`;

const FADE_DECLARATIONS = /* glsl */ `
uniform float proximityFade;

// Compact ordered Bayer without array indexing, which GLSL ES 1.00 will not
// allow with a non-constant index.
float rosterBayer2(vec2 a) {
  vec2 p = floor(a);
  return fract(p.x * 0.5 + p.y * p.y * 0.75);
}
float rosterBayer4(vec2 a) {
  return rosterBayer2(0.5 * a) * 0.25 + rosterBayer2(a);
}
`;

const FADE_FRAGMENT = /* glsl */ `
  if (proximityFade > 0.0 && rosterBayer4(gl_FragCoord.xy) < proximityFade) discard;
`;

/* -------------------------------------------------------------------------- */
/* Material                                                                   */
/* -------------------------------------------------------------------------- */

/** Configure a texture the way the asset pipeline's output expects. */
function prepare(texture: THREE.Texture, srgb: boolean, anisotropy: number): THREE.Texture {
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = anisotropy;
  // Roster maps are authored with row 0 at v = 0 (see `atlas.ts`), which is
  // glTF's convention and the one `KTX2Loader` forces. Flipping here would
  // put the face on the back of the head.
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Build a character material.
 *
 * The ORM texture is bound to three slots at once. That is the whole point of
 * the packing: `aoMap`, `roughnessMap` and `metalnessMap` all sample the same
 * upload, and `aoMap.channel = 0` because three defaults ambient occlusion to
 * UV1 — a second UV set these meshes do not have, and binding it would light
 * the character from a channel of zeros.
 */
export function createRosterMaterial(
  textures: RosterTextures,
  options: RosterMaterialOptions = {}
): RosterMaterial {
  const anisotropy = 4;
  prepare(textures.map, true, anisotropy);
  prepare(textures.normalMap, false, anisotropy);
  prepare(textures.ormMap, false, anisotropy);
  if (textures.emissiveMap !== undefined) prepare(textures.emissiveMap, true, anisotropy);
  if (textures.faceMap !== undefined) prepare(textures.faceMap, true, anisotropy);
  if (textures.maskMap !== undefined) prepare(textures.maskMap, false, anisotropy);

  // Built without an `emissiveMap` key when there is none: three warns loudly
  // about parameters whose value is `undefined`, and a warning per character
  // per load is noise that hides real ones.
  const parameters: THREE.MeshStandardMaterialParameters = {
    name: options.name ?? 'roster',
    map: textures.map,
    normalMap: textures.normalMap,
    aoMap: textures.ormMap,
    roughnessMap: textures.ormMap,
    metalnessMap: textures.ormMap,
    emissive: textures.emissiveMap === undefined ? 0x000000 : 0xffffff,
    emissiveIntensity: options.emissiveIntensity ?? 1,
    color: 0xffffff,
    roughness: 1,
    metalness: 1,
    vertexColors: false,
    side: options.side ?? THREE.FrontSide,
  };
  if (textures.emissiveMap !== undefined) parameters.emissiveMap = textures.emissiveMap;
  const material = new THREE.MeshStandardMaterial(parameters) as RosterMaterial;

  material.aoMapIntensity = 1;
  material.normalScale = new THREE.Vector2(options.normalScale ?? 1, options.normalScale ?? 1);
  material.envMapIntensity = options.envMapIntensity ?? 1;
  // The ORM is bound to aoMap, and three defaults ambient occlusion to UV1.
  material.aoMap!.channel = 0;

  const rect = options.faceRect;
  const uniforms: RosterUniforms = {
    faceRect: {
      value: new THREE.Vector4(
        rect?.u0 ?? 0,
        rect?.v0 ?? 0,
        1 / Math.max((rect?.u1 ?? 1) - (rect?.u0 ?? 0), 1e-5),
        1 / Math.max((rect?.v1 ?? 1) - (rect?.v0 ?? 0), 1e-5)
      ),
    },
    faceSelect: {
      value: new THREE.Vector2(
        Math.max(0, EXPRESSIONS.indexOf(options.expression ?? 'neutral')),
        1 / EXPRESSIONS.length
      ),
    },
    faceMap: { value: textures.faceMap ?? null },
    crowdMask: { value: textures.maskMap ?? null },
    proximityFade: { value: 0 },
  };

  const useFace = textures.faceMap !== undefined && rect !== undefined;
  const useCrowd = options.crowdTint === true && textures.maskMap !== undefined;
  const useFade = options.proximityFade === true;
  const features = `${useFace ? 'F' : '-'}${useCrowd ? 'C' : '-'}${useFade ? 'D' : '-'}`;

  material.userData = { roster: uniforms, features };

  material.onBeforeCompile = (shader) => {
    if (useFace) {
      shader.uniforms.faceMap = uniforms.faceMap;
      shader.uniforms.faceRect = uniforms.faceRect;
      shader.uniforms.faceSelect = uniforms.faceSelect;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FACE_DECLARATIONS}`)
        .replace('#include <map_fragment>', `#include <map_fragment>\n${FACE_FRAGMENT}`);
    }
    if (useCrowd) {
      shader.uniforms.crowdMask = uniforms.crowdMask;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${CROWD_VERTEX_DECLARATIONS}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${CROWD_VERTEX_BODY}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${CROWD_FRAGMENT_DECLARATIONS}`)
        .replace('#include <map_fragment>', `#include <map_fragment>\n${CROWD_FRAGMENT}`);
    }
    if (useFade) {
      shader.uniforms.proximityFade = uniforms.proximityFade;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FADE_DECLARATIONS}`)
        .replace(
          '#include <clipping_planes_fragment>',
          `#include <clipping_planes_fragment>\n${FADE_FRAGMENT}`
        );
    }
  };

  // Program identity must follow the injected source, or three will hand a
  // crowd-tinted civilian the player's dithered program.
  material.customProgramCacheKey = () => `roster:${features}`;

  return material;
}

/* -------------------------------------------------------------------------- */
/* Runtime controls                                                           */
/* -------------------------------------------------------------------------- */

/** Swap the face expression. One uniform write; no rebuild, no rebind. */
export function setExpression(material: THREE.Material, expression: Expression): void {
  const uniforms = (material.userData as { roster?: RosterUniforms }).roster;
  if (uniforms === undefined) return;
  uniforms.faceSelect.value.x = Math.max(0, EXPRESSIONS.indexOf(expression));
}

/** The expression a material is currently showing. */
export function getExpression(material: THREE.Material): Expression {
  const uniforms = (material.userData as { roster?: RosterUniforms }).roster;
  const index = uniforms === undefined ? 0 : Math.round(uniforms.faceSelect.value.x);
  return EXPRESSIONS[index] ?? 'neutral';
}

/**
 * Curve from the camera rig's `armCollapseRatio` to a dither coverage.
 *
 * Nothing happens until the arm is 40% collapsed — by then the character is
 * still framed and fading would be a distraction. From there it ramps to 94%
 * coverage; the remaining 6% keeps a faint ghost of the silhouette so the
 * player can still read which way they are facing while the camera is
 * effectively inside them.
 */
export function proximityFadeAmount(armCollapseRatio: number): number {
  const t = clamp01((clamp01(armCollapseRatio) - 0.4) / 0.5);
  return t * t * (3 - 2 * t) * 0.94;
}

/**
 * Drive the screen door from the camera.
 *
 * Call once per frame with `ICameraDiagnostics.armCollapseRatio`, and ONLY on
 * the player's material — see the header for why NPCs must not carry the
 * injection at all.
 */
export function setProximityFade(material: THREE.Material, armCollapseRatio: number): void {
  const uniforms = (material.userData as { roster?: RosterUniforms }).roster;
  if (uniforms === undefined) return;
  uniforms.proximityFade.value = proximityFadeAmount(armCollapseRatio);
}

/** Current dither coverage, 0 when the character is fully solid. */
export function getProximityFade(material: THREE.Material): number {
  const uniforms = (material.userData as { roster?: RosterUniforms }).roster;
  return uniforms === undefined ? 0 : uniforms.proximityFade.value;
}

/* -------------------------------------------------------------------------- */
/* Verification helpers                                                       */
/* -------------------------------------------------------------------------- */

/** Every map a roster material is expected to bind. */
export const REQUIRED_MAPS = ['map', 'normalMap', 'aoMap', 'roughnessMap', 'metalnessMap'] as const;

/** Report of what a material actually has bound. */
export interface MaterialAudit {
  readonly name: string;
  readonly missing: readonly string[];
  readonly hasEmissive: boolean;
  readonly hasFace: boolean;
  readonly aoChannel: number;
  readonly features: string;
}

/**
 * Check a material against the contract.
 *
 * The harness asserts `missing` is empty for every character: a material with
 * no base-colour map is exactly the "untextured geometry" failure this whole
 * workstream exists to remove, and it should fail loudly rather than render
 * flat white.
 */
export function auditMaterial(material: THREE.Material): MaterialAudit {
  const standard = material as THREE.MeshStandardMaterial;
  const missing: string[] = [];
  for (const key of REQUIRED_MAPS) {
    if (standard[key] === null || standard[key] === undefined) missing.push(key);
  }
  const uniforms = (material.userData as { roster?: RosterUniforms }).roster;
  return {
    name: material.name,
    missing,
    hasEmissive: standard.emissiveMap !== null && standard.emissiveMap !== undefined,
    hasFace: uniforms?.faceMap.value !== null && uniforms?.faceMap.value !== undefined,
    aoChannel: standard.aoMap?.channel ?? -1,
    features: (material.userData as { features?: string }).features ?? '',
  };
}
