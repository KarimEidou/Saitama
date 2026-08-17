/**
 * VFX BUDGETS AND TIER PROFILES
 *
 * ── THE TWO NUMBERS THAT SHAPE THIS WHOLE SYSTEM ───────────────────────────
 *
 *  1. DRAW CALLS ≤ 12 for the entire suite.
 *  2. SHADER PROGRAMS ≤ 5 on the MEDIUM tier, because the verified renderer
 *     already spends 19 of its 24-program budget and mobile has no
 *     `KHR_parallel_shader_compile` — every new program is a synchronous
 *     compile stall on the main thread, which is the #1 Android hitch source.
 *
 * Everything below follows from those. There is no "dust material" and no
 * "spark material": there are THREE programs, and every effect in the game is
 * an entry in one of them.
 *
 *   sprite     one instanced quad program covering dust, clouds, sparks,
 *              flashes, embers, debris streaks and the shockwave dust front.
 *   shockwave  one instanced arc-shell program covering the ground skirt and
 *              the axial air cone.
 *   speedlines one full-screen program.
 *
 * Live draw calls: 4 (sprites, decals, shockwave shells, speedlines). Decals
 * reuse the SPRITE program with a different material instance — blending,
 * depth state and bound textures are GL state, not program identity, so a
 * second material built from the same shader source costs a draw call and
 * zero programs. That is the single trick that makes this budget reachable.
 *
 * ── PREMULTIPLIED ALPHA IS WHY ONE PASS IS ENOUGH ──────────────────────────
 * Every VFX material blends `ONE, ONE_MINUS_SRC_ALPHA`. A fragment with a
 * bright colour and near-zero alpha is ADDITIVE; a fragment with a dark
 * colour and high alpha is a MULTIPLY-like darkening; anything between is
 * ordinary alpha compositing. So a spark, a dust puff and the dark
 * compression band behind a shockwave edge can all live in one draw call and
 * choose their blend mode per pixel.
 */

import type { IQualitySettings, IQualityTier } from '@/types';

/* -------------------------------------------------------------------------- */
/* Hard budgets                                                               */
/* -------------------------------------------------------------------------- */

/** Draw calls the whole VFX suite may add to a frame. Asserted by the harness. */
export const VFX_DRAW_CALL_BUDGET = 12;

/**
 * Distinct shader programs the whole VFX suite may add. The renderer measured
 * MEDIUM at 19 of 24, so this is the entire remaining headroom.
 */
export const VFX_PROGRAM_BUDGET = 5;

/* -------------------------------------------------------------------------- */
/* Sprite atlas layout                                                        */
/* -------------------------------------------------------------------------- */

/** The particle atlas is a 4x4 grid of tiles. */
export const ATLAS_TILES = 4;

/**
 * Tile indices into the particle atlas.
 *
 * Channel convention for EVERY tile:
 *   R  density / erosion threshold — high in the core, low in the wisps, so
 *      raising a threshold against it eats the edges first and the particle
 *      dissolves instead of ghosting out at uniform opacity.
 *   G  self-occlusion — 1 at the lit shell, lower in the interior. Multiplied
 *      into the fake volumetric shading so a puff reads as a ball of dust
 *      rather than a flat disc.
 *   B  rim highlight.
 *   A  coverage.
 */
export const SpriteTile = {
  DustSoft: 0,
  DustDense: 1,
  DustWisp: 2,
  Cloud: 3,
  FlashStar: 4,
  Glow: 5,
  Spark: 6,
  Streak: 7,
  Ring: 8,
  Shard: 9,
  Ember: 10,
  Swirl: 11,
  DustVariantA: 12,
  DustVariantB: 13,
  DustVariantC: 14,
  DustVariantD: 15,
} as const;

/** Dust tiles chosen at random per puff, so a plume is not sixteen clones. */
export const DUST_TILES: readonly number[] = [
  SpriteTile.DustSoft,
  SpriteTile.DustDense,
  SpriteTile.DustVariantA,
  SpriteTile.DustVariantB,
  SpriteTile.DustVariantC,
  SpriteTile.DustVariantD,
];

/**
 * Quad orientation modes understood by the sprite vertex shader.
 *
 *   Billboard — camera-facing with an arbitrary roll.
 *   Streak    — stretched along screen-space velocity; sparks, debris trails.
 *   Upright   — billboards about world +Y only, so dust columns and clouds
 *               never tip over when the camera pitches down.
 *   Surface   — lies flat against a normal. Ground decals.
 */
export const SpriteMode = {
  Billboard: 0,
  Streak: 1,
  Upright: 2,
  Surface: 3,
} as const;

/** The crack decal atlas is a 2x2 grid. */
export const CRACK_TILES = 2;

/**
 * Tile indices into the crack atlas.
 *
 *   Star     — radial fracture; the impact point itself.
 *   BranchA/B— a fracture running away from the bottom edge of the quad, so
 *              an elongated quad pointing outward reads as a crack racing
 *              away from the impact.
 *   Smear    — soft dark blotch: scorch and settled dust.
 */
export const CrackTile = {
  Star: 0,
  BranchA: 1,
  BranchB: 2,
  Smear: 3,
} as const;

/* -------------------------------------------------------------------------- */
/* Tier profile                                                               */
/* -------------------------------------------------------------------------- */

/** Everything the VFX system sizes itself from. */
export interface IVFXTierProfile {
  readonly tier: IQualityTier;
  /** Instanced quads available to every sprite effect combined. */
  readonly spriteCapacity: number;
  /** Live shockwave shells. A single punch uses two or three. */
  readonly shockwaveCapacity: number;
  /** Persistent ground decals. Oldest is recycled once full — the city stays broken. */
  readonly decalCapacity: number;
  /** Debris trails tracked at once. */
  readonly trailCapacity: number;
  /** Arc subdivisions of a shockwave shell. */
  readonly shockwaveArcSegments: number;
  /** Radial subdivisions across a shockwave shell's thickness. */
  readonly shockwaveRadialSegments: number;
  /** Edge size of the generated particle atlas, in texels. */
  readonly atlasSize: number;
  /** Edge size of the generated crack atlas, in texels. */
  readonly crackAtlasSize: number;
  /** Sky-level cloud parting on a maximum-charge punch. */
  readonly cloudParting: boolean;
  /** Camera-space speedlines. */
  readonly speedlines: boolean;
  /** Multiplier on every emitted particle count. */
  readonly particleScale: number;
  /**
   * Shader complexity switch compiled into the materials.
   * 0 drops the volumetric shading and the chromatic fringe.
   */
  readonly shaderQuality: 0 | 1 | 2;
  /** Depth buckets used to sort transparent sprites. More = finer ordering. */
  readonly sortBuckets: number;
}

const LOW: IVFXTierProfile = {
  tier: 'low',
  spriteCapacity: 320,
  shockwaveCapacity: 4,
  decalCapacity: 48,
  trailCapacity: 12,
  shockwaveArcSegments: 40,
  shockwaveRadialSegments: 5,
  atlasSize: 256,
  crackAtlasSize: 256,
  cloudParting: false,
  speedlines: true,
  particleScale: 0.45,
  shaderQuality: 0,
  sortBuckets: 32,
};

const MEDIUM: IVFXTierProfile = {
  tier: 'medium',
  spriteCapacity: 900,
  shockwaveCapacity: 8,
  decalCapacity: 128,
  trailCapacity: 32,
  shockwaveArcSegments: 80,
  shockwaveRadialSegments: 7,
  atlasSize: 512,
  crackAtlasSize: 512,
  cloudParting: true,
  speedlines: true,
  particleScale: 1,
  shaderQuality: 1,
  sortBuckets: 64,
};

const HIGH: IVFXTierProfile = {
  tier: 'high',
  spriteCapacity: 1800,
  shockwaveCapacity: 14,
  decalCapacity: 256,
  trailCapacity: 64,
  shockwaveArcSegments: 128,
  shockwaveRadialSegments: 9,
  atlasSize: 512,
  crackAtlasSize: 512,
  cloudParting: true,
  speedlines: true,
  particleScale: 1.7,
  shaderQuality: 2,
  sortBuckets: 96,
};

/** Every VFX tier profile, keyed by render tier. */
export const VFX_TIER_PROFILES: Readonly<Record<IQualityTier, IVFXTierProfile>> = {
  low: LOW,
  medium: MEDIUM,
  high: HIGH,
};

/** The VFX profile for a render tier. */
export function vfxProfileFor(tier: IQualityTier): IVFXTierProfile {
  return VFX_TIER_PROFILES[tier];
}

/**
 * Concurrent composite effects allowed.
 *
 * This is `IQualitySettings.maxParticleSystems` verbatim — 4 / 8 / 16. It is
 * a small number, which is why a "serious punch" is ONE effect that emits a
 * shell, a dust front, a flash and a crack set, rather than five requests
 * competing for the same budget.
 */
export function effectCapacityFor(settings: IQualitySettings): number {
  return Math.max(1, settings.maxParticleSystems);
}

/* -------------------------------------------------------------------------- */
/* Look tuning                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Force commitment -> visual drama. The whole game is a restraint dial and
 * this table is where that dial becomes light and dust.
 */
export const INTENT_POWER: Readonly<Record<string, number>> = {
  restrained: 0.18,
  normal: 0.42,
  serious: 0.78,
  full: 1,
};

/** Concrete dust. Warm grey, deliberately DARKER than instinct suggests: the */
/** shockwave edge only reads as white-hot if the dust around it is not white. */
export const DUST_COLOR = 0xa39e95;
export const DUST_COLOR_DARK = 0x55524d;
/** The pressure edge and the impact flash. Slightly blue-white, like an arc. */
export const SHOCK_COLOR = 0xdfeaff;
export const SPARK_COLOR = 0xffd9a0;
export const CLOUD_COLOR = 0xd9e2ee;
