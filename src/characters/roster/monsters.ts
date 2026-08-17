/**
 * MONSTER ROSTER
 *
 * Every monster in this game is built by the SAME humanoid generator the
 * heroes use. That is not a shortcut — it is the reason a monster can be
 * punched through a wall by the same code that punches a civilian, share the
 * same 27-bone rig, the same animation clips and the same one-draw-call
 * material path.
 *
 * ── ORIGINAL DESIGNS, DELIBERATELY ────────────────────────────────────────
 * These are OUR monsters. Nothing here is traced, ripped or downloaded from
 * the source material: each design is a set of proportions, a colour scheme
 * and a face, all authored in this file, and the textures under them are
 * either synthesised or CC0 with a recorded author. The names are the roles
 * they play in the story; the bodies are ours.
 *
 * ── WHAT VARIES, AND WHY ──────────────────────────────────────────────────
 * The generator gives four independent levers, and each monster is a different
 * combination of them, so the cast reads as a cast rather than as one body at
 * five scales:
 *
 *   PROPORTION   height, bulk, limb length, head scale — the silhouette.
 *   SHAPE        muscle, belly, angular — soft flesh versus hard carapace.
 *   COSTUME      a `PaintFn` that maps every cross-section to a colour, so a
 *                pale belly, dark dorsal hide and darker claws cost nothing.
 *   SURFACE      the class each colour maps to: chitin is glossy and hard,
 *                hide is matte and coarse, scale catches the light in rows.
 *
 * ── THREAT TIERS ──────────────────────────────────────────────────────────
 * `mookEntry(tier, seed)` generates an anonymous monster for any `ThreatTier`,
 * deterministically. The tier drives mass, palette and how much of the body is
 * armour, so a dragon-level threat is visibly a different order of thing from
 * a wolf-level one before a single number is shown to the player.
 */

import * as THREE from 'three';
import type { BodyProfile, ThreatTier } from '@/types';
import { createRng } from '@/util';
import type { CharacterRecipe, Coat, PaintFn } from '@/characters/mesh';
import { resolvePalette } from '@/characters/mesh';
import { baseFace } from './face';
import type { ClassColor, RosterEntry, SurfaceClass, SurfaceOverrides } from './types';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function coat(hex: number, inflate?: number, exponent?: number): Coat {
  return { color: new THREE.Color(hex), inflate, exponent };
}

/** Assemble the colour table and the paint function from one description. */
interface Skin {
  /** Main body colour. */
  readonly body: number;
  readonly bodyClass: SurfaceClass;
  /** Belly / underside, painted below the chest. */
  readonly belly: number;
  readonly bellyClass: SurfaceClass;
  /** Limb extremities: claws, hooves, hands and feet. */
  readonly claw: number;
  readonly clawClass: SurfaceClass;
  /** Optional garment (loincloth, harness) painted over the hips. */
  readonly cloth?: number;
  readonly clothClass?: SurfaceClass;
  /** Optional plating painted over the forearms and shins. */
  readonly plate?: number;
  readonly plateClass?: SurfaceClass;
  readonly hair: number;
  readonly hairClass: SurfaceClass;
}

function monsterPaint(skin: Skin): PaintFn {
  const body = coat(skin.body);
  const belly = coat(skin.belly);
  const claw = coat(skin.claw);
  const cloth = skin.cloth === undefined ? undefined : coat(skin.cloth, 1.04);
  const plate = skin.plate === undefined ? undefined : coat(skin.plate, 1.05, 0.8);

  return (part, _key, at) => {
    switch (part) {
      case 'torso':
        if (cloth !== undefined && at > 0.05 && at < 0.24) return cloth;
        // Chest and abdomen are the pale underside; the yoke and skull are not.
        if (at > 0.14 && at < 0.56) return belly;
        return body;
      case 'arm':
        if (plate !== undefined && at > 1.1 && at < 1.78) return plate;
        return body;
      case 'leg':
        if (plate !== undefined && at > 1.15 && at < 1.85) return plate;
        return body;
      case 'hand':
      case 'foot':
        return claw;
      default:
        return body;
    }
  };
}

function monsterColors(skin: Skin): ClassColor[] {
  const out: ClassColor[] = [
    { hex: skin.body, surface: skin.bodyClass, note: 'body' },
    { hex: skin.belly, surface: skin.bellyClass, note: 'underside' },
    { hex: skin.claw, surface: skin.clawClass, note: 'claws' },
    { hex: skin.hair, surface: skin.hairClass, note: 'crest' },
  ];
  if (skin.cloth !== undefined) {
    out.push({ hex: skin.cloth, surface: skin.clothClass ?? 'cloth', note: 'garment' });
  }
  if (skin.plate !== undefined) {
    out.push({ hex: skin.plate, surface: skin.plateClass ?? 'armor', note: 'plating' });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Named monsters                                                             */
/* -------------------------------------------------------------------------- */

/**
 * MOSQUITO GIRL — demon tier.
 *
 * Long limbs, narrow ribcage, a carapace instead of skin. The wings are the
 * cape shell: a folded membrane hanging off the shoulders, which costs 356
 * triangles that were already paid for and gives her the only silhouette in
 * the cast that is wider than it is tall from behind.
 */
function mosquitoGirl(): RosterEntry {
  const profile: BodyProfile = {
    archetype: 'monsterHumanoid',
    height: 1.74,
    shoulderWidth: 0.9,
    bulk: 0.74,
    limbLength: 1.16,
    headScale: 0.94,
    uniformScale: 1,
    skinTone: 0x3f3350,
    primaryColor: 0x2a2136,
    secondaryColor: 0x120e18,
    seed: 101,
  };
  const skin: Skin = {
    body: 0x3f3350,
    bodyClass: 'chitin',
    belly: 0xb9a7c4,
    bellyClass: 'chitin',
    claw: 0x120e18,
    clawClass: 'chitin',
    hair: 0x1b1524,
    hairClass: 'chitin',
    plate: 0x584a6d,
    plateClass: 'chitin',
  };
  const palette = resolvePalette(profile, {
    skin: new THREE.Color(skin.body),
    hair: new THREE.Color(skin.hair),
  });

  return {
    id: 'chr.mosquitoGirl',
    name: 'Mosquito Girl',
    kind: 'monster',
    threat: 'demon',
    seed: 101,
    recipe: {
      name: 'Mosquito Girl',
      profile,
      options: {
        shape: { muscle: 0.42, belly: 0.02, angular: 0.28, neck: 0.86 },
        palette,
        paint: monsterPaint(skin),
        garments: { cape: true, capeColor: 0x8d93a8 },
        hair: { style: 'spiky', color: skin.hair, thickness: 0.012, lobes: 5, line: 0.66 },
      },
    },
    colors: [...monsterColors(skin), { hex: 0x8d93a8, surface: 'chitin', note: 'wing membrane' }],
    surfaces: {
      chitin: { roughness: 0.26, metalness: 0.16 },
    },
    face: baseFace({
      eye: 'compound',
      eyeSpread: 0.03,
      eyeWidth: 0.021,
      eyeHeight: 0.014,
      eyeV: 0.749,
      sclera: 0x2b1c2c,
      iris: 0x8e2f3c,
      pupil: 0x1a0f16,
      brow: 'none',
      mouth: 'mandible',
      mouthWidth: 0.016,
      mouthColor: 0x1c1420,
      shadow: 0x1a1220,
      blush: 0,
      marking: 'stripes',
      markingColor: 0x241a2e,
    }),
  };
}

/**
 * VACCINE MAN — demon tier.
 *
 * Tall, thin and wet-looking: `slime` is the only class in the set with a
 * roughness under 0.2, so he is the character that proves the environment probe
 * is actually being sampled. Hollow sockets with a lit pupil, and a grin.
 */
function vaccineMan(): RosterEntry {
  const profile: BodyProfile = {
    archetype: 'monsterHumanoid',
    height: 2.08,
    shoulderWidth: 0.96,
    bulk: 0.82,
    limbLength: 1.14,
    headScale: 1.08,
    uniformScale: 1,
    skinTone: 0x2fb0a4,
    primaryColor: 0x1a6f6a,
    secondaryColor: 0x0d3d3c,
    seed: 102,
  };
  const skin: Skin = {
    body: 0x2fb0a4,
    bodyClass: 'slime',
    belly: 0x9fe4d6,
    bellyClass: 'slime',
    claw: 0x0d3d3c,
    clawClass: 'slime',
    hair: 0x125754,
    hairClass: 'slime',
  };
  const palette = resolvePalette(profile, {
    skin: new THREE.Color(skin.body),
    hair: new THREE.Color(skin.hair),
  });

  return {
    id: 'chr.vaccineMan',
    name: 'Vaccine Man',
    kind: 'monster',
    threat: 'demon',
    seed: 102,
    recipe: {
      name: 'Vaccine Man',
      profile,
      options: {
        shape: { muscle: 0.6, belly: 0.0, angular: 0.06, yoke: 1.06 },
        palette,
        paint: monsterPaint(skin),
        hair: { style: 'spiky', color: skin.hair, thickness: 0.016, lobes: 7, line: 0.7 },
      },
    },
    colors: monsterColors(skin),
    surfaces: {
      slime: { roughness: 0.14, ao: 0.7 },
    },
    face: baseFace({
      eye: 'socket',
      eyeSpread: 0.034,
      eyeWidth: 0.019,
      eyeHeight: 0.013,
      eyeV: 0.748,
      sclera: 0x06201f,
      iris: 0xd8fff6,
      pupil: 0xffffff,
      brow: 'none',
      mouth: 'grin',
      mouthWidth: 0.03,
      mouthV: 0.657,
      mouthColor: 0x06201f,
      shadow: 0x073330,
      blush: 0,
      glow: 0x8ffff0,
    }),
  };
}

/**
 * DEEP SEA KING — dragon tier.
 *
 * The mass test. At 2.72 m and bulk 1.62 he is nearly twice a civilian's
 * volume, which is exactly the case where a generator usually falls apart: the
 * shoulders outrun the ribcage and the result reads as an inflated human. The
 * `scale` class earns its keep here — rows of overlapping scales give the eye a
 * sense of size that flat colour cannot.
 */
function deepSeaKing(): RosterEntry {
  const profile: BodyProfile = {
    archetype: 'monsterHumanoid',
    height: 2.72,
    shoulderWidth: 1.46,
    bulk: 1.62,
    limbLength: 1.02,
    headScale: 0.96,
    uniformScale: 1,
    skinTone: 0x2b5f63,
    primaryColor: 0x3a2f28,
    secondaryColor: 0x123037,
    seed: 103,
  };
  const skin: Skin = {
    body: 0x2b5f63,
    bodyClass: 'scale',
    belly: 0xa8c0ad,
    bellyClass: 'scale',
    claw: 0x101f26,
    clawClass: 'chitin',
    cloth: 0x3a2f28,
    clothClass: 'cloth',
    hair: 0x123037,
    hairClass: 'scale',
  };
  const palette = resolvePalette(profile, {
    skin: new THREE.Color(skin.body),
    hair: new THREE.Color(skin.hair),
  });

  return {
    id: 'chr.deepSeaKing',
    name: 'Deep Sea King',
    kind: 'monster',
    threat: 'dragon',
    seed: 103,
    recipe: {
      name: 'Deep Sea King',
      profile,
      options: {
        shape: { muscle: 1, belly: 0.22, angular: 0.14, yoke: 1.18, neck: 1.2 },
        palette,
        paint: monsterPaint(skin),
        garments: { belt: true, primary: 0x3a2f28, accent: 0x1d1712 },
        hair: { style: 'spiky', color: skin.hair, thickness: 0.02, lobes: 6, line: 0.62 },
      },
    },
    colors: [...monsterColors(skin), { hex: 0x1d1712, surface: 'leather', note: 'belt' }],
    surfaces: {
      scale: { roughness: 0.38 },
    },
    face: baseFace({
      eye: 'round',
      eyeSpread: 0.042,
      eyeWidth: 0.019,
      eyeHeight: 0.017,
      eyeV: 0.752,
      sclera: 0xe8d98a,
      iris: 0xc8a33a,
      pupil: 0x0d0c0a,
      brow: 'bold',
      browColor: 0x123037,
      mouth: 'fanged',
      mouthWidth: 0.038,
      mouthV: 0.652,
      mouthColor: 0x22161a,
      shadow: 0x14343a,
      blush: 0,
      marking: 'gills',
      markingColor: 0x0d2429,
    }),
  };
}

/**
 * BOROS — dragon tier, edging into god.
 *
 * The boss silhouette: tall, lean, armoured torso, long cape. The single lit
 * eye is the only emissive on a hero-scale character, and it is what the
 * bloom pass will find in a night fight.
 */
function boros(): RosterEntry {
  const profile: BodyProfile = {
    archetype: 'monsterHumanoid',
    height: 2.18,
    shoulderWidth: 1.22,
    bulk: 1.06,
    limbLength: 1.08,
    headScale: 1.0,
    uniformScale: 1,
    skinTone: 0xd6cbe8,
    primaryColor: 0x2b2233,
    secondaryColor: 0x7a2d3c,
    seed: 104,
  };
  const skinColor = 0xd6cbe8;
  const armour = 0x2b2233;
  const trim = 0x6f5fbe;
  const claw = 0x1a1520;
  const hair = 0x9d8ee6;

  const skinCoat = coat(skinColor);
  const armourCoat = coat(armour, 1.05, 0.7);
  const trimCoat = coat(trim, 1.03);
  const clawCoat = coat(claw);

  const paint: PaintFn = (part, _key, at) => {
    switch (part) {
      case 'torso':
        if (at < 0.2) return armourCoat;
        if (at < 0.6) return armourCoat;
        if (at < 0.665) return trimCoat;
        return skinCoat;
      case 'arm':
        return at < 0.9 ? armourCoat : at < 1.74 ? skinCoat : trimCoat;
      case 'leg':
        return at < 1.5 ? armourCoat : trimCoat;
      case 'hand':
      case 'foot':
        return clawCoat;
      default:
        return skinCoat;
    }
  };

  const palette = resolvePalette(profile, {
    skin: new THREE.Color(skinColor),
    hair: new THREE.Color(hair),
  });

  return {
    id: 'chr.boros',
    name: 'Boros',
    kind: 'monster',
    threat: 'dragon',
    seed: 104,
    recipe: {
      name: 'Boros',
      profile,
      options: {
        shape: { muscle: 0.86, belly: 0.0, angular: 0.18, yoke: 1.1 },
        palette,
        paint,
        garments: { cape: true, capeColor: 0x7a2d3c, belt: true, collar: true, accent: trim },
        hair: { style: 'spiky', color: hair, thickness: 0.015, lobes: 6 },
      },
    },
    colors: [
      { hex: skinColor, surface: 'skin', note: 'alien skin' },
      { hex: armour, surface: 'armor', note: 'plate' },
      { hex: trim, surface: 'metal', note: 'trim' },
      { hex: claw, surface: 'chitin', note: 'claws' },
      { hex: hair, surface: 'hair', note: 'crest' },
      { hex: 0x7a2d3c, surface: 'cape', note: 'cape' },
    ],
    surfaces: {
      armor: { roughness: 0.36, metalness: 0.9 },
      cape: { roughness: 0.82 },
    },
    face: baseFace({
      eye: 'slit',
      eyeSpread: 0.032,
      eyeWidth: 0.02,
      eyeHeight: 0.011,
      eyeV: 0.7465,
      sclera: 0x1a1420,
      iris: 0x63f0ff,
      pupil: 0x0a1a20,
      brow: 'angular',
      browColor: 0x6f5fbe,
      mouth: 'line',
      mouthWidth: 0.019,
      mouthColor: 0x6b4a58,
      shadow: 0x3a2f4a,
      blush: 0,
      glow: 0x63f0ff,
      marking: 'scar',
      markingColor: 0x8b6d9e,
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Threat-tier mooks                                                          */
/* -------------------------------------------------------------------------- */

interface TierSpec {
  readonly height: [number, number];
  readonly bulk: [number, number];
  readonly limb: [number, number];
  readonly head: [number, number];
  readonly muscle: number;
  readonly angular: number;
  readonly surface: SurfaceClass;
  readonly palettes: readonly [number, number, number][];
  readonly plated: boolean;
  readonly glow?: number;
  readonly label: string;
}

/**
 * Per-tier body language.
 *
 * Height alone would make the ladder read as one monster on a zoom slider, so
 * every tier also changes MATERIAL and PROPORTION: wolves are lean hide,
 * demons are plated carapace, dragons are scaled masses, and a god-tier threat
 * is armoured and lit from inside.
 */
const TIERS: Readonly<Record<ThreatTier, TierSpec>> = {
  wolf: {
    height: [1.42, 1.68],
    bulk: [0.82, 1.0],
    limb: [1.0, 1.12],
    head: [0.9, 1.02],
    muscle: 0.55,
    angular: 0.05,
    surface: 'hide',
    palettes: [
      [0x6b6152, 0xa79b86, 0x2c2620],
      [0x5d6b52, 0x98a887, 0x24291f],
      [0x6b5a52, 0xa89283, 0x2a231f],
    ],
    plated: false,
    label: 'Wolf-tier threat',
  },
  tiger: {
    height: [1.82, 2.05],
    bulk: [1.12, 1.34],
    limb: [1.0, 1.08],
    head: [0.92, 1.0],
    muscle: 0.78,
    angular: 0.1,
    surface: 'hide',
    palettes: [
      [0x8a5a2f, 0xd8bb8a, 0x33241a],
      [0x7a4a3a, 0xc4a08c, 0x2c1d18],
      [0x5f6b3a, 0xb2bd88, 0x252a18],
    ],
    plated: false,
    label: 'Tiger-tier threat',
  },
  demon: {
    height: [2.2, 2.6],
    bulk: [1.34, 1.62],
    limb: [1.0, 1.06],
    head: [0.86, 0.96],
    muscle: 0.94,
    angular: 0.3,
    surface: 'chitin',
    palettes: [
      [0x4a2c3a, 0x8a6273, 0x1a0f16],
      [0x33384a, 0x6f7a96, 0x12141c],
      [0x4a3a22, 0x8a7145, 0x1a1410],
    ],
    plated: true,
    label: 'Demon-tier threat',
  },
  dragon: {
    height: [2.8, 3.3],
    bulk: [1.6, 1.9],
    limb: [0.98, 1.04],
    head: [0.82, 0.92],
    muscle: 1,
    angular: 0.22,
    surface: 'scale',
    palettes: [
      [0x2f4a3a, 0x7fa88c, 0x101c16],
      [0x4a2f2f, 0xa87f7f, 0x1c1010],
      [0x2f3a4a, 0x7f8fa8, 0x10161c],
    ],
    plated: true,
    glow: 0xff8a3a,
    label: 'Dragon-tier threat',
  },
  god: {
    height: [3.3, 3.8],
    bulk: [1.75, 2.0],
    limb: [1.0, 1.08],
    head: [0.8, 0.9],
    muscle: 1,
    angular: 0.4,
    surface: 'armor',
    palettes: [
      [0x24222c, 0x585469, 0x0d0c11],
      [0x2c2422, 0x695a54, 0x110d0c],
    ],
    plated: true,
    glow: 0x9fe8ff,
    label: 'God-tier threat',
  },
};

/** Every threat tier, weakest first. */
export const THREAT_TIERS: readonly ThreatTier[] = ['wolf', 'tiger', 'demon', 'dragon', 'god'];

/**
 * A deterministic anonymous monster.
 *
 * Same `(tier, seed)` always produces the same creature, on every device and
 * in every run — the spawner can therefore reconstruct a monster from an id
 * instead of serialising its appearance.
 */
export function mookEntry(tier: ThreatTier, seed: number): RosterEntry {
  const spec = TIERS[tier];
  const rng = createRng(seed).derive(`mook:${tier}`);
  const [body, belly, claw] = rng.pick(spec.palettes);

  const profile: BodyProfile = {
    archetype: 'monsterHumanoid',
    height: rng.range(spec.height[0], spec.height[1]),
    shoulderWidth: rng.range(1.06, 1.42),
    bulk: rng.range(spec.bulk[0], spec.bulk[1]),
    limbLength: rng.range(spec.limb[0], spec.limb[1]),
    headScale: rng.range(spec.head[0], spec.head[1]),
    uniformScale: 1,
    skinTone: body,
    primaryColor: belly,
    secondaryColor: claw,
    seed,
  };

  const plate = spec.plated ? mixHex(body, 0xffffff, 0.22) : undefined;
  const skin: Skin = {
    body,
    bodyClass: spec.surface,
    belly,
    bellyClass: spec.surface,
    claw,
    clawClass: 'chitin',
    hair: claw,
    hairClass: 'chitin',
    plate,
    plateClass: spec.surface === 'armor' ? 'metal' : 'armor',
  };

  const palette = resolvePalette(profile, {
    skin: new THREE.Color(body),
    hair: new THREE.Color(claw),
  });

  const glow = spec.glow;
  return {
    id: `chr.mook.${tier}`,
    name: spec.label,
    kind: 'monster',
    threat: tier,
    seed,
    recipe: {
      name: spec.label,
      profile,
      options: {
        shape: {
          muscle: spec.muscle,
          belly: rng.range(0.05, 0.28),
          angular: spec.angular,
          yoke: rng.range(1.0, 1.2),
        },
        palette,
        paint: monsterPaint(skin),
        garments: spec.plated ? { belt: true, accent: claw } : undefined,
        hair: {
          style: 'spiky',
          color: claw,
          thickness: 0.014,
          lobes: tier === 'god' ? 8 : 5,
          line: 0.64,
        },
      },
    },
    colors: monsterColors(skin),
    surfaces: tierSurfaces(tier),
    face: baseFace({
      eye: glow === undefined ? 'slit' : 'socket',
      eyeSpread: 0.034,
      eyeWidth: 0.019,
      eyeHeight: 0.011,
      eyeV: 0.749,
      sclera: 0x140f12,
      iris: glow ?? 0xd8a03a,
      pupil: 0x080607,
      brow: 'angular',
      browColor: claw,
      mouth: 'fanged',
      mouthWidth: 0.03,
      mouthV: 0.654,
      mouthColor: 0x1a1114,
      shadow: 0x1b1418,
      blush: 0,
      glow,
    }),
  };
}

function tierSurfaces(tier: ThreatTier): SurfaceOverrides {
  switch (tier) {
    case 'wolf':
      return { hide: { roughness: 0.88 } };
    case 'tiger':
      return { hide: { roughness: 0.8 } };
    case 'demon':
      return { chitin: { roughness: 0.28, metalness: 0.2 } };
    case 'dragon':
      return { scale: { roughness: 0.4, metalness: 0.08 } };
    case 'god':
      return { armor: { roughness: 0.3, metalness: 0.95 }, metal: { roughness: 0.24 } };
  }
}

/** Blend two hex colours in sRGB byte space. */
function mixHex(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/** The four named monsters. */
export function namedMonsters(): RosterEntry[] {
  return [mosquitoGirl(), vaccineMan(), deepSeaKing(), boros()];
}

/** One representative mook per threat tier. */
export function tierMooks(): RosterEntry[] {
  return THREAT_TIERS.map((tier, index) => mookEntry(tier, 900 + index));
}

/** Recipe for a monster without going through the roster registry. */
export function monsterRecipe(entry: RosterEntry): CharacterRecipe {
  return entry.recipe;
}
