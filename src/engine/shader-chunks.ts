/**
 * SHADER INJECTION CHUNKS
 *
 * GLSL fragments spliced into `MeshStandardMaterial` by `MaterialLib` through
 * `onBeforeCompile`. Kept in one file so the whole injected surface area of the
 * renderer is reviewable in a single sitting — an ad-hoc `onBeforeCompile` in
 * every system is how a project ends up with 200 shader programs.
 *
 * ── WHY EXTEND THE BUILT-IN MATERIAL AT ALL ────────────────────────────────
 * Writing a bespoke `ShaderMaterial` would mean reimplementing three's lighting,
 * shadows, IBL, fog and tone mapping. Injecting into `meshphysical` keeps all of
 * that (and keeps CSM, which patches the same lighting chunks) while adding the
 * three things this game actually needs:
 *
 *   1. TRIPLANAR terrain mapping — the city ground is procedurally deformed and
 *      cratered at runtime, so it has no stable UV set to unwrap.
 *   2. PER-INSTANCE variation — thousands of instanced props sharing ONE
 *      material need per-copy colour and wear or the city reads as clone-stamped.
 *   3. A GLOBAL damage/dust mask — after a fight, everything downwind must go
 *      dusty. One world-space mask texture sampled by every material does that
 *      without touching a single material instance.
 *
 * ── GLSL DIALECT ───────────────────────────────────────────────────────────
 * three upgrades built-in materials to GLSL ES 3.00 on WebGL2 and supplies
 * compatibility defines (`varying` -> in/out, `attribute` -> in, `texture2D` ->
 * texture). Writing GLSL1-style here is therefore correct and portable; do NOT
 * hand-write `#version` or `in`/`out`.
 *
 * ── SPLICE POINTS (order inside meshphysical) ──────────────────────────────
 *   vertex:   <common>                 -> declarations
 *             <fog_vertex>             -> world position / normal / instancing
 *   fragment: <common>                 -> declarations
 *             <map_fragment>           -> triplanar albedo
 *             <roughnessmap_fragment>  -> triplanar roughness
 *             <metalnessmap_fragment>  -> triplanar metalness + surface block
 *             <normal_fragment_maps>   -> triplanar normal (whiteout blend)
 */

/** Which injections a material opts into. Every flag costs a shader program. */
export interface IMaterialFeatures {
  /** World-space triplanar projection of albedo/roughness/metalness/normal. */
  readonly triplanar: boolean;
  /** Per-instance tint + wear from instanced attributes. */
  readonly instanceVariation: boolean;
  /** Sample the global world-space damage/dust mask. */
  readonly damageMask: boolean;
}

export const NO_FEATURES: IMaterialFeatures = {
  triplanar: false,
  instanceVariation: false,
  damageMask: false,
};

/** Instanced attribute name carrying a per-copy multiplicative tint. */
export const INSTANCE_TINT_ATTRIBUTE = 'instanceTint';
/** Instanced attribute name carrying per-copy wear in 0..1. */
export const INSTANCE_WEAR_ATTRIBUTE = 'instanceWear';

/** True when the feature set injects anything at all. */
export function hasAnyFeature(features: IMaterialFeatures): boolean {
  return features.triplanar || features.instanceVariation || features.damageMask;
}

/** Stable short key for the feature set. Feeds `customProgramCacheKey`. */
export function featureKey(features: IMaterialFeatures): string {
  return (
    (features.triplanar ? 'T' : '-') +
    (features.instanceVariation ? 'I' : '-') +
    (features.damageMask ? 'D' : '-')
  );
}

/** `material.defines` entries for a feature set. Part of the program cache key. */
export function featureDefines(features: IMaterialFeatures): Record<string, string> {
  const defines: Record<string, string> = {};
  if (features.triplanar) defines.ENGINE_TRIPLANAR = '1';
  if (features.instanceVariation) defines.ENGINE_INSTANCE_VARIATION = '1';
  if (features.damageMask) defines.ENGINE_DAMAGE_MASK = '1';
  return defines;
}

/* -------------------------------------------------------------------------- */
/* Vertex stage                                                               */
/* -------------------------------------------------------------------------- */

/** Declarations for the vertex shader, spliced after `#include <common>`. */
export function vertexDeclarations(features: IMaterialFeatures): string {
  const needsWorldPos = features.triplanar || features.damageMask;
  const lines: string[] = [];
  if (needsWorldPos) lines.push('varying vec3 vEngineWorldPos;');
  if (features.triplanar) lines.push('varying vec3 vEngineWorldNormal;');
  if (features.instanceVariation) {
    lines.push(
      `attribute vec3 ${INSTANCE_TINT_ATTRIBUTE};`,
      `attribute float ${INSTANCE_WEAR_ATTRIBUTE};`,
      'varying vec3 vEngineTint;',
      'varying float vEngineWear;'
    );
  }
  return lines.join('\n');
}

/**
 * World-space data, spliced BEFORE `#include <fog_vertex>` — the last thing in
 * meshphysical's vertex main, where `transformed` and `objectNormal` are both
 * final. `<worldpos_vertex>` cannot be relied on: it only emits
 * `worldPosition` when an envmap, shadow map or transmission is in play.
 */
export function vertexBody(features: IMaterialFeatures): string {
  const needsWorldPos = features.triplanar || features.damageMask;
  const lines: string[] = [];

  if (needsWorldPos || features.triplanar) {
    lines.push(
      'vec4 engineWorldPos4 = vec4( transformed, 1.0 );',
      '#ifdef USE_INSTANCING',
      '\tengineWorldPos4 = instanceMatrix * engineWorldPos4;',
      '#endif',
      'engineWorldPos4 = modelMatrix * engineWorldPos4;'
    );
  }
  if (needsWorldPos) lines.push('vEngineWorldPos = engineWorldPos4.xyz;');
  if (features.triplanar) {
    lines.push(
      'vec3 engineObjectNormal = objectNormal;',
      '#ifdef USE_INSTANCING',
      '\tengineObjectNormal = mat3( instanceMatrix ) * engineObjectNormal;',
      '#endif',
      'vEngineWorldNormal = normalize( mat3( modelMatrix ) * engineObjectNormal );'
    );
  }
  if (features.instanceVariation) {
    lines.push(
      `vEngineTint = ${INSTANCE_TINT_ATTRIBUTE};`,
      `vEngineWear = ${INSTANCE_WEAR_ATTRIBUTE};`
    );
  }
  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* Fragment stage                                                             */
/* -------------------------------------------------------------------------- */

/** Declarations for the fragment shader, spliced after `#include <common>`. */
export function fragmentDeclarations(features: IMaterialFeatures): string {
  const needsWorldPos = features.triplanar || features.damageMask;
  const lines: string[] = [];
  if (needsWorldPos) lines.push('varying vec3 vEngineWorldPos;');
  if (features.triplanar) {
    lines.push(
      'varying vec3 vEngineWorldNormal;',
      'uniform float uEngineTriplanarScale;',
      'uniform float uEngineTriplanarSharpness;'
    );
  }
  if (features.instanceVariation) {
    lines.push('varying vec3 vEngineTint;', 'varying float vEngineWear;', 'uniform float uEngineWearRoughness;');
  }
  if (features.damageMask) {
    lines.push(
      'uniform sampler2D uEngineDamageMask;',
      // xy = world-space centre on the XZ plane, zw = 1 / world extent.
      'uniform vec4 uEngineDamageRect;',
      'uniform vec3 uEngineDustColor;',
      'uniform float uEngineDustAmount;'
    );
  }
  return lines.join('\n');
}

/**
 * Triplanar albedo. Replaces `#include <map_fragment>` entirely, so it is only
 * ever spliced in when the material actually has a `map` bound — without one,
 * the `map` uniform does not exist and this would fail to compile.
 *
 * Also declares `tpBlend` / `tpUvX|Y|Z`, which the roughness, metalness and
 * normal splices below reuse. They all live in the same `main()` scope and run
 * strictly after this one.
 */
export const TRIPLANAR_MAP_FRAGMENT = /* glsl */ `
	vec3 tpBlend = pow( abs( normalize( vEngineWorldNormal ) ), vec3( uEngineTriplanarSharpness ) );
	tpBlend /= max( tpBlend.x + tpBlend.y + tpBlend.z, 1e-4 );
	vec2 tpUvX = vEngineWorldPos.zy * uEngineTriplanarScale;
	vec2 tpUvY = vEngineWorldPos.xz * uEngineTriplanarScale;
	vec2 tpUvZ = vEngineWorldPos.xy * uEngineTriplanarScale;
	vec4 sampledDiffuseColor = texture2D( map, tpUvX ) * tpBlend.x
		+ texture2D( map, tpUvY ) * tpBlend.y
		+ texture2D( map, tpUvZ ) * tpBlend.z;
	diffuseColor *= sampledDiffuseColor;
`;

/** Triplanar roughness. Replaces `#include <roughnessmap_fragment>`. */
export const TRIPLANAR_ROUGHNESS_FRAGMENT = /* glsl */ `
	float roughnessFactor = roughness;
	vec4 tpTexelRoughness = texture2D( roughnessMap, tpUvX ) * tpBlend.x
		+ texture2D( roughnessMap, tpUvY ) * tpBlend.y
		+ texture2D( roughnessMap, tpUvZ ) * tpBlend.z;
	roughnessFactor *= tpTexelRoughness.g;
`;

/** Triplanar metalness. Replaces `#include <metalnessmap_fragment>`. */
export const TRIPLANAR_METALNESS_FRAGMENT = /* glsl */ `
	float metalnessFactor = metalness;
	vec4 tpTexelMetalness = texture2D( metalnessMap, tpUvX ) * tpBlend.x
		+ texture2D( metalnessMap, tpUvY ) * tpBlend.y
		+ texture2D( metalnessMap, tpUvZ ) * tpBlend.z;
	metalnessFactor *= tpTexelMetalness.b;
`;

/**
 * Triplanar tangent-space normal via the "whiteout" blend (Colin Barré-Brisebois
 * / Ben Golus). Replaces `#include <normal_fragment_maps>`.
 *
 * A naive triplanar normal blend flattens detail because the three samples
 * disagree about which way is up. Whiteout keeps the perturbation in the plane
 * of each projection and adds the geometric normal on the third axis, which
 * preserves detail strength across the blend region.
 */
export const TRIPLANAR_NORMAL_FRAGMENT = /* glsl */ `
	{
		vec3 tpWorldN = normalize( vEngineWorldNormal );
		vec3 tnX = texture2D( normalMap, tpUvX ).xyz * 2.0 - 1.0;
		vec3 tnY = texture2D( normalMap, tpUvY ).xyz * 2.0 - 1.0;
		vec3 tnZ = texture2D( normalMap, tpUvZ ).xyz * 2.0 - 1.0;
		tnX.xy *= normalScale;
		tnY.xy *= normalScale;
		tnZ.xy *= normalScale;
		tnX = vec3( tnX.xy + tpWorldN.zy, abs( tnX.z ) * tpWorldN.x );
		tnY = vec3( tnY.xy + tpWorldN.xz, abs( tnY.z ) * tpWorldN.y );
		tnZ = vec3( tnZ.xy + tpWorldN.xy, abs( tnZ.z ) * tpWorldN.z );
		vec3 tpNormal = normalize( tnX.zyx * tpBlend.x + tnY.xzy * tpBlend.y + tnZ.xyz * tpBlend.z );
		normal = normalize( ( viewMatrix * vec4( tpNormal, 0.0 ) ).xyz );
	}
`;

/**
 * Per-instance variation and the global damage/dust mask, spliced AFTER
 * `#include <metalnessmap_fragment>` — the first point where `diffuseColor`,
 * `roughnessFactor` and `metalnessFactor` all exist and nothing has consumed
 * them yet.
 */
export function surfaceFragment(features: IMaterialFeatures): string {
  const lines: string[] = [];

  if (features.instanceVariation) {
    lines.push(
      '\tfloat engineWear = clamp( vEngineWear, 0.0, 1.0 );',
      '\tdiffuseColor.rgb *= vEngineTint;',
      // Wear darkens, roughens and de-metals: grime is a dielectric layer.
      '\tdiffuseColor.rgb *= mix( 1.0, 0.62, engineWear );',
      '\troughnessFactor = clamp( roughnessFactor + engineWear * uEngineWearRoughness, 0.04, 1.0 );',
      '\tmetalnessFactor *= mix( 1.0, 0.35, engineWear );'
    );
  }

  if (features.damageMask) {
    lines.push(
      '\tvec2 engineMaskUv = ( vEngineWorldPos.xz - uEngineDamageRect.xy ) * uEngineDamageRect.zw + 0.5;',
      '\tvec2 engineMaskIn = step( vec2( 0.0 ), engineMaskUv ) * step( engineMaskUv, vec2( 1.0 ) );',
      '\tfloat engineDust = clamp(',
      '\t\ttexture2D( uEngineDamageMask, engineMaskUv ).r * engineMaskIn.x * engineMaskIn.y',
      '\t\t\t+ uEngineDustAmount, 0.0, 1.0 );',
      '\tdiffuseColor.rgb = mix( diffuseColor.rgb, uEngineDustColor, engineDust * 0.8 );',
      '\troughnessFactor = mix( roughnessFactor, 0.95, engineDust );',
      '\tmetalnessFactor *= ( 1.0 - engineDust * 0.85 );'
    );
  }

  return lines.join('\n');
}
