/**
 * THE ROSTER
 *
 * Every character the game can put on screen, as data: a mesh recipe, a colour
 * table that says what each painted region is MADE of, a face, and any
 * per-class surface overrides.
 *
 * ── HEROES REUSE THE MESH WORKSTREAM'S RECIPES ────────────────────────────
 * `mesh/characters.ts` already owns Saitama's proportions and costume. This
 * file does not restate them — it imports `characterRecipe(id)` and adds only
 * the layer that was missing: what the colours MEAN materially. The colour
 * tables therefore mirror the costume constants exactly, and
 * `__tests__/classify.test.ts` asserts that every colour a build actually
 * produces is declared here. If the mesh workstream re-tunes a costume, the
 * test names the new colour instead of the roster silently mis-materialising
 * it.
 *
 * ── CIVILIANS ARE ONE SHEET, NOT N SHEETS ─────────────────────────────────
 * The crowd shares a single neutral-grey atlas and recolours per instance
 * through instanced attributes (see `crowd.ts`). That is what makes a street
 * full of people cost one material and one draw call instead of two hundred.
 */

import * as THREE from 'three';
import type { LodLevel } from '@/characters/mesh';
import {
  buildHumanoid,
  characterRecipe,
  civilianOptions,
  civilianProfile,
  type CharacterId,
  type HumanoidBuild,
  type Palette,
} from '@/characters/mesh';
import { baseFace } from './face';
import { namedMonsters, tierMooks } from './monsters';
import type { ClassColor, RosterEntry, SurfaceClass } from './types';

/* -------------------------------------------------------------------------- */
/* Heroes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * SAITAMA.
 *
 * Four colours, and one of them is the entire joke. The face is deliberately
 * the emptiest in the cast: two flat ovals, no brows at all, and a mouth that
 * is a short straight line. Everything else about him — bald head, plain
 * jumpsuit, no ornament — exists to leave that face nothing to hide behind.
 */
function saitamaEntry(): RosterEntry {
  return {
    id: 'chr.saitama',
    name: 'Saitama',
    kind: 'hero',
    seed: 1,
    player: true,
    restExpression: 'neutral',
    recipe: characterRecipe('saitama'),
    colors: [
      { hex: 0xf6cda6, surface: 'skin', note: 'skin' },
      { hex: 0xf2c22e, surface: 'cloth', note: 'jumpsuit and collar' },
      { hex: 0xb92b22, surface: 'leather', note: 'gloves, boots and belt' },
      { hex: 0xf4f2ea, surface: 'cape', note: 'cape' },
    ],
    surfaces: {
      // A hero costume is matte cotton, not lycra. Roughness at 0.95 with a
      // woven normal is the difference between cloth and a bin bag.
      cloth: { roughness: 0.95, detail: { tiles: 28, patternStrength: 0.5 } },
      leather: { roughness: 0.44, detail: { tiles: 20 } },
      cape: { roughness: 0.96, tone: 1, detail: { tiles: 13 } },
      skin: { roughness: 0.58 },
    },
    face: baseFace({
      eye: 'dot',
      eyeSpread: 0.03,
      eyeWidth: 0.0118,
      eyeHeight: 0.0098,
      eyeV: 0.7415,
      pupil: 0x16161a,
      sclera: 0x16161a,
      iris: 0x16161a,
      brow: 'none',
      mouth: 'line',
      mouthWidth: 0.0175,
      mouthV: 0.6625,
      mouthColor: 0x8a5148,
      shadow: 0x9c6a4c,
      blush: 0.35,
    }),
  };
}

/**
 * GENOS.
 *
 * The metal test. Everything from the elbow down and the knee down is bare
 * machined alloy at metalness 1.0, and the ONLY thing that stops a metalness-1
 * surface from rendering black is a specular environment probe. If his forearms
 * look like grey plastic in the harness, the probe is not reaching him and that
 * is a renderer bug worth catching here rather than in a night fight.
 */
function genosEntry(): RosterEntry {
  return {
    id: 'chr.genos',
    name: 'Genos',
    kind: 'hero',
    seed: 2,
    restExpression: 'serious',
    recipe: characterRecipe('genos'),
    colors: [
      { hex: 0xf2c9a6, surface: 'skin', note: 'face and neck' },
      { hex: 0x1b1e24, surface: 'cloth', note: 'sleeveless top' },
      { hex: 0x14161a, surface: 'cloth', note: 'trousers' },
      { hex: 0x98a2ad, surface: 'metal', note: 'machined limbs and plating' },
      { hex: 0x3a4048, surface: 'joint', note: 'elbow and knee sleeves' },
      { hex: 0x15181c, surface: 'vent', note: 'vent grilles' },
      { hex: 0xe8cf87, surface: 'hair', note: 'hair' },
      { hex: 0x8f9aa6, surface: 'armor', note: 'belt' },
    ],
    surfaces: {
      // Brushed alloy, not chrome: roughness 0.28 keeps a readable highlight
      // that travels along the limb as the camera moves, which is exactly the
      // cue that says "metal" rather than "grey".
      metal: { roughness: 0.28, metalness: 1, detail: { tiles: 6.5, roughnessStrength: 0.95 } },
      vent: { roughness: 0.66, metalness: 0.85 },
      joint: { roughness: 0.7, metalness: 0.12 },
      cloth: { roughness: 0.82, detail: { tiles: 30 } },
      hair: { roughness: 0.36 },
    },
    face: baseFace({
      eye: 'almond',
      eyeSpread: 0.031,
      eyeWidth: 0.0175,
      eyeHeight: 0.0092,
      eyeV: 0.7455,
      sclera: 0x14161c,
      iris: 0xf0a52c,
      pupil: 0x2a1606,
      brow: 'bold',
      browColor: 0xc8ab63,
      mouth: 'line',
      mouthWidth: 0.019,
      mouthColor: 0x7d4a44,
      shadow: 0x8a6248,
      blush: 0.2,
      glow: 0xffb03a,
      marking: 'plate',
      markingColor: 0x8a929c,
    }),
  };
}

/** TATSUMAKI — the large-eyed end of the face range. */
function tatsumakiEntry(): RosterEntry {
  return {
    id: 'chr.tatsumaki',
    name: 'Tatsumaki',
    kind: 'hero',
    seed: 3,
    restExpression: 'serious',
    recipe: characterRecipe('tatsumaki'),
    colors: [
      { hex: 0xf9d6b6, surface: 'skin', note: 'skin' },
      { hex: 0x16171b, surface: 'cloth', note: 'dress and skirt' },
      { hex: 0x0e0f12, surface: 'accent', note: 'trim' },
      { hex: 0x2fbf7a, surface: 'hair', note: 'hair' },
    ],
    surfaces: {
      // A fitted dress is a finer weave than a jumpsuit and takes a light
      // sheen; tiles go up and roughness comes down a little.
      cloth: { roughness: 0.86, detail: { tiles: 34, patternStrength: 0.4 } },
      hair: { roughness: 0.34, detail: { tiles: 13, patternStrength: 0.65 } },
      skin: { roughness: 0.55 },
    },
    face: baseFace({
      eye: 'anime',
      eyeSpread: 0.031,
      eyeWidth: 0.0175,
      eyeHeight: 0.0135,
      eyeV: 0.7465,
      sclera: 0xf6f2ea,
      iris: 0x2f8f5e,
      pupil: 0x10231a,
      brow: 'thin',
      browColor: 0x1f7a4c,
      browV: 0.7885,
      mouth: 'small',
      mouthWidth: 0.0125,
      mouthV: 0.6605,
      mouthColor: 0xa85a55,
      shadow: 0xa87a5e,
      blush: 0.9,
    }),
  };
}

/** MUMEN RIDER — the helmet is the hair shell, so the hair class is paint. */
function mumenEntry(): RosterEntry {
  return {
    id: 'chr.mumenRider',
    name: 'Mumen Rider',
    kind: 'hero',
    seed: 4,
    restExpression: 'neutral',
    recipe: characterRecipe('mumenRider'),
    colors: [
      { hex: 0xecc09a, surface: 'skin', note: 'skin' },
      { hex: 0x2f7d4f, surface: 'cloth', note: 'green suit' },
      { hex: 0xd9dde2, surface: 'leather', note: 'gloves, boots, belt and collar' },
      { hex: 0xdfe3e8, surface: 'hair', note: 'helmet shell' },
    ],
    surfaces: {
      cloth: { roughness: 0.92, detail: { tiles: 28 } },
      leather: { roughness: 0.48, detail: { tiles: 22 } },
      // The helmet is a painted shell, so it borrows the painted-metal maps
      // and drops the hair strand pattern entirely.
      hair: {
        roughness: 0.29,
        metalness: 0.05,
        ao: 0.85,
        detail: {
          material: 'mat.metal.shutter.painted',
          pattern: 'none',
          tiles: 3,
          albedoStrength: 0.18,
          normalStrength: 0.35,
          patternStrength: 0,
          roughnessStrength: 0.4,
        },
      },
    },
    face: baseFace({
      eye: 'almond',
      eyeSpread: 0.03,
      eyeWidth: 0.0155,
      eyeHeight: 0.0085,
      eyeV: 0.7445,
      iris: 0x3d2d1e,
      brow: 'thin',
      browColor: 0x2e2118,
      mouth: 'small',
      mouthWidth: 0.017,
      mouthColor: 0x8f5049,
      visor: 0x6fa8c8,
      blush: 0.5,
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Civilians                                                                  */
/* -------------------------------------------------------------------------- */

/** Colour table straight from a resolved palette. */
export function paletteColors(palette: Palette): ClassColor[] {
  return [
    { hex: palette.skin.getHex(), surface: 'skin', note: 'skin' },
    { hex: palette.cloth.getHex(), surface: 'cloth', note: 'shirt and coat' },
    { hex: palette.accent.getHex(), surface: 'accent', note: 'trousers and shoes' },
    { hex: palette.hair.getHex(), surface: 'hair', note: 'hair' },
  ];
}

/** Seed of the civilian whose body becomes the shared crowd sheet. */
export const CROWD_SEED = 7104;

/**
 * The shared civilian.
 *
 * One body, one atlas, one material — and the variation comes from four
 * instanced colour attributes plus the mesh generator's own morph targets. The
 * atlas is baked NEUTRAL (`neutralize`), so the greys carry only weave, wear
 * and occlusion and the instanced tint carries all the hue.
 */
export function civilianEntry(seed: number = CROWD_SEED): RosterEntry {
  const profile = civilianProfile(seed);
  const options = civilianOptions(profile, 0);
  const palette = options.palette as Palette;

  return {
    id: 'chr.civilian',
    name: 'Civilian',
    kind: 'civilian',
    seed,
    crowd: true,
    restExpression: 'neutral',
    recipe: { name: 'Civilian', profile, options },
    colors: paletteColors(palette),
    surfaces: {
      cloth: { roughness: 0.9, detail: { tiles: 27 } },
      accent: { roughness: 0.88 },
    },
    face: baseFace({
      eye: 'almond',
      eyeWidth: 0.0155,
      eyeHeight: 0.008,
      brow: 'thin',
      mouth: 'line',
      blush: 0.6,
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

const HERO_IDS: readonly CharacterId[] = ['saitama', 'genos', 'tatsumaki', 'mumenRider'];

/** The four named heroes. */
export function heroEntries(): RosterEntry[] {
  return [saitamaEntry(), genosEntry(), tatsumakiEntry(), mumenEntry()];
}

/**
 * The full cast, in presentation order: heroes, the shared civilian, the named
 * monsters, then one representative of each threat tier.
 */
export function listRoster(): RosterEntry[] {
  return [...heroEntries(), civilianEntry(), ...namedMonsters(), ...tierMooks()];
}

/** Ids of every roster entry. */
export function rosterIds(): string[] {
  return listRoster().map((entry) => entry.id);
}

/** One entry by id. Throws on an unknown id — a typo should not render grey. */
export function rosterEntry(id: string): RosterEntry {
  const found = listRoster().find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`roster: unknown character "${id}"`);
  return found;
}

/** Mesh ids the heroes are built from, for cross-checking with the mesh tests. */
export function heroMeshIds(): readonly CharacterId[] {
  return HERO_IDS;
}

/** Build one roster character's geometry at a LOD. */
export function buildRosterMesh(entry: RosterEntry, lod: LodLevel = 0): HumanoidBuild {
  return buildHumanoid(entry.recipe.profile, { ...entry.recipe.options, lod });
}

/** The surface classes a character actually uses. */
export function entryClasses(entry: RosterEntry): SurfaceClass[] {
  const seen = new Set<SurfaceClass>();
  for (const color of entry.colors) seen.add(color.surface);
  return [...seen].sort();
}

/** The costume colours as `THREE.Color`, in declaration order. */
export function entryColorObjects(entry: RosterEntry): THREE.Color[] {
  return entry.colors.map((color) => new THREE.Color(color.hex));
}
