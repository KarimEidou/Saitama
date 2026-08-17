/**
 * NAMED CHARACTERS AND CROWD VARIATION
 *
 * Every character in this game is generated, because the alternative — using
 * the show's actual models — is not available to us. That constraint turns out
 * to suit the source material: One Punch Man's designs are flat, bold and
 * low-detail, so the gap between "generated" and "on model" is much smaller
 * here than it would be for a photoreal game.
 *
 * The three leads exercise three different parts of the generator, which is
 * why they are the ones defined here rather than left to content authoring:
 *
 *   SAITAMA    the easy case, and deliberately first. Bald, plain yellow
 *              jumpsuit, white cape, red gloves and boots. No hair to solve,
 *              a silhouette made entirely of primary shapes.
 *   GENOS      the case procedural generation WINS. Panels, vents and machined
 *              cylinders are loops; a human artist finds them tedious and a
 *              generator finds them free.
 *   TATSUMAKI  the hard case. Small frame, and the hair is the whole design.
 *              Solved as sculpted lobes rather than strands or cards — see
 *              hair.ts for why that is the only affordable answer.
 */

import * as THREE from 'three';
import type { BodyArchetype, BodyProfile } from '@/types';
import { createRng, lerp } from '@/util';
import type { HumanoidBuild, HumanoidOptions, Palette } from './assemble';
import { bodysuitCostume, buildHumanoid, casualCostume, resolvePalette } from './assemble';
import type { Coat, PaintFn } from './body';
import type { LodLevel } from './types';

export type CharacterId = 'saitama' | 'genos' | 'tatsumaki' | 'mumenRider';

/** A profile plus everything needed to dress it. */
export interface CharacterRecipe {
  readonly name: string;
  readonly profile: BodyProfile;
  readonly options: HumanoidOptions;
}

/* -------------------------------------------------------------------------- */
/* Saitama                                                                    */
/* -------------------------------------------------------------------------- */

const SAITAMA_PROFILE: BodyProfile = {
  archetype: 'hero',
  height: 1.75,
  shoulderWidth: 1.06,
  bulk: 1.02,
  limbLength: 1.0,
  headScale: 1.04,
  uniformScale: 1,
  skinTone: 0xf6cda6,
  primaryColor: 0xf2c22e,
  secondaryColor: 0xb92b22,
  seed: 1,
};

function saitamaRecipe(): CharacterRecipe {
  const palette = resolvePalette(SAITAMA_PROFILE);
  return {
    name: 'Saitama',
    profile: SAITAMA_PROFILE,
    options: {
      // Deliberately understated: the joke is that he looks like nobody.
      // Muscle high enough to read as an adult male, nowhere near a bodybuilder.
      shape: { muscle: 0.58, belly: 0.04 },
      palette,
      paint: bodysuitCostume(palette, { gloveFrom: 1.58, bootFrom: 1.42, neckTo: 0.665 }),
      garments: {
        cape: true,
        gloves: true,
        boots: true,
        belt: true,
        collar: true,
        capeColor: 0xf4f2ea,
      },
      hair: { style: 'bald', color: 0x000000 },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Genos                                                                      */
/* -------------------------------------------------------------------------- */

const GENOS_PROFILE: BodyProfile = {
  archetype: 'hero',
  height: 1.78,
  shoulderWidth: 1.16,
  bulk: 1.12,
  limbLength: 1.0,
  headScale: 1.0,
  uniformScale: 1,
  skinTone: 0xf2c9a6,
  primaryColor: 0x1b1e24,
  secondaryColor: 0x8f9aa6,
  seed: 2,
};

/**
 * Black sleeveless top, black trousers, everything else machinery.
 *
 * The mechanical sections also square off their cross-sections via
 * `Coat.exponent` — a machined forearm is the same anatomy table as a human
 * one with its corners taken off, which is exactly the kind of reuse the
 * costume hook exists for.
 */
function genosCostume(palette: Palette): PaintFn {
  const shirt: Coat = { color: new THREE.Color(0x1b1e24), inflate: 1.03 };
  const trousers: Coat = { color: new THREE.Color(0x14161a), inflate: 1.03 };
  const metal: Coat = { color: palette.metal, inflate: 1.06, exponent: 1.4 };
  const joint: Coat = { color: new THREE.Color(0x3a4048), inflate: 1.0, exponent: 0.6 };
  const skin: Coat = { color: palette.skin };

  return (part, _key, at) => {
    switch (part) {
      case 'torso':
        if (at < 0.2) return trousers;
        if (at < 0.665) return shirt;
        return skin;
      case 'arm':
        return at > 0.94 && at < 1.08 ? joint : metal;
      case 'leg':
        if (at < 1.05) return trousers;
        return at < 1.16 ? joint : metal;
      case 'hand':
        return metal;
      case 'foot':
        return metal;
      default:
        return skin;
    }
  };
}

function genosRecipe(): CharacterRecipe {
  const palette = resolvePalette(GENOS_PROFILE, {
    hair: new THREE.Color(0xe8cf87),
    metal: new THREE.Color(0x98a2ad),
    vent: new THREE.Color(0x15181c),
  });
  return {
    name: 'Genos',
    profile: GENOS_PROFILE,
    options: {
      shape: { muscle: 0.92, belly: 0.0 },
      palette,
      paint: genosCostume(palette),
      garments: { belt: true },
      hair: { style: 'spiky', color: 0xe8cf87, thickness: 0.014, lobes: 6 },
      hardSurface: {
        arms: true,
        legs: true,
        torso: false,
        metalColor: 0x98a2ad,
        ventColor: 0x15181c,
        panelRows: 2,
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Tatsumaki                                                                  */
/* -------------------------------------------------------------------------- */

const TATSUMAKI_PROFILE: BodyProfile = {
  archetype: 'lithe',
  height: 1.44,
  shoulderWidth: 0.84,
  bulk: 0.76,
  limbLength: 1.0,
  headScale: 1.18,
  uniformScale: 1,
  skinTone: 0xf9d6b6,
  primaryColor: 0x16171b,
  secondaryColor: 0x0e0f12,
  seed: 3,
};

/** Long-sleeved black dress; bare legs. */
function tatsumakiCostume(palette: Palette): PaintFn {
  const dress: Coat = { color: new THREE.Color(0x16171b), inflate: 1.025 };
  const skin: Coat = { color: palette.skin };
  return (part, _key, at) => {
    switch (part) {
      case 'torso':
        return at > 0.13 && at < 0.645 ? dress : skin;
      case 'arm':
        return at < 1.72 ? dress : skin;
      default:
        return skin;
    }
  };
}

function tatsumakiRecipe(): CharacterRecipe {
  const palette = resolvePalette(TATSUMAKI_PROFILE, { hair: new THREE.Color(0x2fbf7a) });
  return {
    name: 'Tatsumaki',
    profile: TATSUMAKI_PROFILE,
    options: {
      shape: { muscle: 0.18, belly: 0.03, yoke: 0.9 },
      palette,
      paint: tatsumakiCostume(palette),
      garments: { skirt: true, primary: 0x16171b },
      hair: { style: 'bob', color: 0x2fbf7a, thickness: 0.024, line: 0.63, lobes: 7 },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Mumen Rider                                                                */
/* -------------------------------------------------------------------------- */

const MUMEN_PROFILE: BodyProfile = {
  archetype: 'civilian',
  height: 1.71,
  shoulderWidth: 0.98,
  bulk: 0.94,
  limbLength: 1.0,
  headScale: 1.0,
  uniformScale: 1,
  skinTone: 0xecc09a,
  primaryColor: 0x2f7d4f,
  secondaryColor: 0xd9dde2,
  seed: 4,
};

function mumenRecipe(): CharacterRecipe {
  const palette = resolvePalette(MUMEN_PROFILE, { hair: new THREE.Color(0xdfe3e8) });
  return {
    name: 'Mumen Rider',
    profile: MUMEN_PROFILE,
    options: {
      shape: { muscle: 0.34, belly: 0.12 },
      palette,
      paint: bodysuitCostume(palette, { gloveFrom: 1.5, bootFrom: 1.5, neckTo: 0.665 }),
      garments: { gloves: true, boots: true, belt: true, collar: true },
      // The helmet reuses the hair shell: a thick offset scalp in white, pulled
      // down past the ears, is exactly a bike helmet and costs nothing new.
      hair: { style: 'short', color: 0xdfe3e8, thickness: 0.03, line: 0.56, lobes: 0 },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

const RECIPES: Readonly<Record<CharacterId, () => CharacterRecipe>> = {
  saitama: saitamaRecipe,
  genos: genosRecipe,
  tatsumaki: tatsumakiRecipe,
  mumenRider: mumenRecipe,
};

/** The recipe for a named character. */
export function characterRecipe(id: CharacterId): CharacterRecipe {
  return RECIPES[id]();
}

/** Build a named character at a given LOD. */
export function buildCharacter(id: CharacterId, lod: LodLevel = 0): HumanoidBuild {
  const recipe = characterRecipe(id);
  return buildHumanoid(recipe.profile, { ...recipe.options, lod });
}

/* -------------------------------------------------------------------------- */
/* Procedural civilians                                                       */
/* -------------------------------------------------------------------------- */

const CIVILIAN_ARCHETYPES: readonly BodyArchetype[] = [
  'civilian',
  'civilian',
  'civilian',
  'lithe',
  'heavy',
  'child',
];

const SKIN_TONES: readonly number[] = [
  0xf6d5bd, 0xeec39f, 0xdda87e, 0xc68a5e, 0xa2673f, 0x7a4a2b, 0x53341f,
];

const CLOTH_TONES: readonly number[] = [
  0x3d5a80, 0x8d5a3c, 0x4f6f52, 0x7a3b4a, 0x2f3540, 0x8a7d4f, 0x5b4b7a, 0xa8563f, 0x365c6b,
];

const TRIM_TONES: readonly number[] = [0x22252b, 0x3a3f47, 0x6b5642, 0x2b3a2f, 0x4a2f33];

const HAIR_TONES: readonly number[] = [0x161310, 0x2e2016, 0x4a3220, 0x6d4b2a, 0x8a6a3c, 0x9c9a95];

/**
 * A deterministic civilian.
 *
 * The point of this function is that it is CHEAP variation: one generator,
 * one atlas, one skeleton, and the differences come from six scalars and four
 * colours. Two civilians sharing an archetype still differ because
 * `resolveShape` jitters muscle and belly off the same seed.
 */
export function civilianProfile(seed: number): BodyProfile {
  const rng = createRng(seed).derive('civilian');
  const archetype = rng.pick(CIVILIAN_ARCHETYPES);
  const child = archetype === 'child';

  const height = child ? rng.range(1.1, 1.42) : rng.gaussian(1.71, 0.075);
  const bulk =
    archetype === 'heavy'
      ? rng.range(1.25, 1.65)
      : archetype === 'lithe'
        ? rng.range(0.76, 0.94)
        : rng.range(0.88, 1.22);

  return {
    archetype,
    height: Math.min(Math.max(height, 1.05), 2.02),
    shoulderWidth: rng.range(0.9, 1.12),
    bulk,
    limbLength: rng.range(0.94, 1.06),
    headScale: child ? rng.range(1.0, 1.12) : rng.range(0.94, 1.06),
    uniformScale: 1,
    skinTone: rng.pick(SKIN_TONES),
    primaryColor: rng.pick(CLOTH_TONES),
    secondaryColor: rng.pick(TRIM_TONES),
    seed,
  };
}

/** Dress and hair a civilian profile. */
export function civilianOptions(profile: BodyProfile, lod: LodLevel = 0): HumanoidOptions {
  const rng = createRng(profile.seed ?? 0).derive('wardrobe');
  const palette = resolvePalette(profile, { hair: new THREE.Color(rng.pick(HAIR_TONES)) });
  const style = rng.weighted(['short', 'bob', 'spiky', 'long', 'bald'] as const, [6, 3, 2, 2, 1]);

  return {
    lod,
    palette,
    paint: casualCostume(palette),
    garments: {
      belt: rng.bool(0.4),
      coat: rng.bool(0.22),
    },
    hair: {
      style,
      color: palette.hair.getHex(),
      thickness: lerp(0.01, 0.02, rng.next()),
      lobes: style === 'bob' ? 4 : 5,
    },
  };
}

/** Build a complete randomised civilian from a seed. */
export function buildCivilian(seed: number, lod: LodLevel = 0): HumanoidBuild {
  const profile = civilianProfile(seed);
  return buildHumanoid(profile, civilianOptions(profile, lod));
}

/* -------------------------------------------------------------------------- */
/* Showcase                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Six deliberately distinct body types plus the Saitama build.
 *
 * Shared by the visual harness and by the unit test that asserts the
 * silhouettes measurably differ — the same list proving the same claim two
 * ways, so a regression cannot pass the test and fail the eye.
 */
export function showcaseBodies(): CharacterRecipe[] {
  const heavy: BodyProfile = {
    archetype: 'heavy',
    height: 1.74,
    shoulderWidth: 1.12,
    bulk: 1.52,
    limbLength: 0.97,
    headScale: 1.0,
    uniformScale: 1,
    skinTone: 0xe3ab7f,
    primaryColor: 0x7a4a3a,
    secondaryColor: 0x30343c,
    seed: 41,
  };
  const child: BodyProfile = {
    archetype: 'child',
    height: 1.22,
    shoulderWidth: 0.92,
    bulk: 0.96,
    limbLength: 1.0,
    headScale: 1.06,
    uniformScale: 1,
    skinTone: 0xf7d3b4,
    primaryColor: 0xd05a4a,
    secondaryColor: 0x2f3a52,
    seed: 42,
  };
  const monster: BodyProfile = {
    archetype: 'monsterHumanoid',
    height: 2.45,
    shoulderWidth: 1.4,
    bulk: 1.5,
    limbLength: 1.08,
    headScale: 0.92,
    uniformScale: 1,
    skinTone: 0x6f7f5a,
    primaryColor: 0x40342a,
    secondaryColor: 0x22201c,
    seed: 43,
  };

  const heavyPalette = resolvePalette(heavy, { hair: new THREE.Color(0x2a1f18) });
  const childPalette = resolvePalette(child, { hair: new THREE.Color(0x3a2a1c) });
  const monsterPalette = resolvePalette(monster, { hair: new THREE.Color(0x2b2a24) });

  return [
    saitamaRecipe(),
    genosRecipe(),
    tatsumakiRecipe(),
    mumenRecipe(),
    {
      name: 'Heavy civilian',
      profile: heavy,
      options: {
        palette: heavyPalette,
        paint: casualCostume(heavyPalette),
        garments: { belt: true },
        hair: { style: 'short', color: 0x2a1f18, thickness: 0.012 },
      },
    },
    {
      name: 'Child',
      profile: child,
      options: {
        palette: childPalette,
        paint: casualCostume(childPalette),
        hair: { style: 'bob', color: 0x3a2a1c, thickness: 0.014, lobes: 4 },
      },
    },
    {
      name: 'Monster humanoid',
      profile: monster,
      options: {
        shape: { muscle: 1, belly: 0.25, angular: 0.12 },
        palette: monsterPalette,
        paint: bodysuitCostume(monsterPalette, { gloveFrom: 2.2, bootFrom: 2.2, neckTo: 0.24 }),
        hair: { style: 'spiky', color: 0x2b2a24, thickness: 0.012, lobes: 6 },
      },
    },
  ];
}
