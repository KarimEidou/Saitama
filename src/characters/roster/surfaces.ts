/**
 * SURFACE STYLES — what each class is physically made of
 *
 * One table, keyed by `SurfaceClass`, giving the baker its roughness,
 * metalness, occlusion strength and detail source. Characters layer partial
 * overrides on top (`RosterEntry.surfaces`), which is how Mumen Rider's helmet
 * becomes painted metal while every other character's hair stays hair.
 *
 * ── WHERE THE CC0 LIBRARY HELPS AND WHERE IT DOES NOT ─────────────────────
 * The processed library is a CITY library: asphalt, brick, plaster, corrugated
 * iron, industrial plate. That is exactly right for machinery and exactly
 * wrong for cotton, so:
 *
 *   METAL, VENT, JOINT, ARMOR  bind the real Poly Haven maps. Genos' forearms
 *                              are `mat.metal.plate.industrial` — its ARM map
 *                              drives roughness per texel, which is what makes
 *                              the specular probe break up across a limb
 *                              instead of sliding over it like plastic.
 *   CLOTH, CAPE, LEATHER       bind a CC0 map for irregular grain and get
 *                              their thread structure from a synthesised
 *                              weave. Tiling brick onto a jumpsuit would be
 *                              worse than no map at all.
 *   SKIN, HAIR                 are entirely synthetic. There is no CC0 skin in
 *                              the set, and photographic plaster on a face
 *                              reads as a disease.
 *
 * Every CC0 id referenced here is recorded in the character manifest with its
 * author, so the credits screen is generated rather than remembered.
 */

import type { DetailSpec, SurfaceClass, SurfaceStyle, SurfaceStyleSet } from './types';
import { SURFACE_CLASSES } from './types';

function detail(spec: Partial<DetailSpec>): DetailSpec {
  return {
    pattern: 'none',
    tiles: 8,
    albedoStrength: 0.3,
    normalStrength: 0.6,
    patternStrength: 0.5,
    roughnessStrength: 0.5,
    ...spec,
  };
}

/**
 * The default table.
 *
 * Roughness values are chosen against the physical reference, not by eye:
 * cotton is fully diffuse (0.9+), skin has a broad specular lobe (~0.6),
 * machined steel is 0.3, and painted metal sits between the two because the
 * coat, not the metal, is the visible surface.
 */
export const DEFAULT_SURFACES: SurfaceStyleSet = {
  skin: {
    roughness: 0.62,
    metalness: 0,
    ao: 0.7,
    tint: 'skin',
    detail: detail({ pattern: 'pores', tiles: 30, patternStrength: 0.3, normalStrength: 0 }),
  },
  cloth: {
    roughness: 0.93,
    metalness: 0,
    ao: 0.85,
    tint: 'cloth',
    detail: detail({
      material: 'mat.wall.plaster.white',
      pattern: 'weave',
      tiles: 15,
      albedoStrength: 0.3,
      normalStrength: 0.45,
      patternStrength: 0.85,
      roughnessStrength: 0.35,
    }),
  },
  accent: {
    roughness: 0.88,
    metalness: 0,
    ao: 0.9,
    tint: 'accent',
    detail: detail({
      material: 'mat.wall.plaster.white',
      pattern: 'twill',
      tiles: 22,
      albedoStrength: 0.26,
      normalStrength: 0.5,
      patternStrength: 0.8,
      roughnessStrength: 0.35,
    }),
  },
  leather: {
    roughness: 0.52,
    metalness: 0.02,
    ao: 0.9,
    tint: 'accent',
    detail: detail({
      material: 'mat.road.asphalt.clean',
      pattern: 'leather',
      tiles: 11,
      albedoStrength: 0.22,
      normalStrength: 0.75,
      patternStrength: 0.7,
      roughnessStrength: 0.55,
    }),
  },
  cape: {
    roughness: 0.95,
    metalness: 0,
    ao: 0.72,
    tint: 'cloth',
    tone: 0.98,
    detail: detail({
      material: 'mat.wall.plaster.beige',
      pattern: 'canvas',
      tiles: 8,
      albedoStrength: 0.3,
      normalStrength: 0.5,
      patternStrength: 0.9,
      roughnessStrength: 0.3,
    }),
  },
  hair: {
    roughness: 0.44,
    metalness: 0,
    ao: 0.75,
    tint: 'hair',
    detail: detail({ pattern: 'strand', tiles: 9, patternStrength: 0.95, normalStrength: 0 }),
  },
  metal: {
    roughness: 0.34,
    metalness: 1,
    ao: 0.6,
    tint: 'none',
    detail: detail({
      material: 'mat.metal.plate.industrial',
      pattern: 'brushed',
      tiles: 4.5,
      albedoStrength: 0.5,
      normalStrength: 0.85,
      patternStrength: 0.45,
      roughnessStrength: 0.9,
    }),
  },
  vent: {
    roughness: 0.62,
    metalness: 0.9,
    ao: 1,
    tint: 'none',
    detail: detail({
      material: 'mat.metal.grate.rusty',
      pattern: 'none',
      tiles: 7,
      albedoStrength: 0.45,
      normalStrength: 0.8,
      roughnessStrength: 0.8,
    }),
  },
  joint: {
    roughness: 0.74,
    metalness: 0.2,
    ao: 0.95,
    tint: 'none',
    detail: detail({
      material: 'mat.metal.corrugated',
      pattern: 'none',
      tiles: 6,
      albedoStrength: 0.35,
      normalStrength: 0.7,
      roughnessStrength: 0.6,
    }),
  },
  armor: {
    roughness: 0.46,
    metalness: 0.85,
    ao: 0.7,
    tint: 'none',
    detail: detail({
      material: 'mat.metal.panel.factory',
      pattern: 'brushed',
      tiles: 3.5,
      albedoStrength: 0.42,
      normalStrength: 0.8,
      patternStrength: 0.3,
      roughnessStrength: 0.8,
    }),
  },
  hide: {
    roughness: 0.82,
    metalness: 0,
    ao: 0.85,
    tint: 'none',
    detail: detail({
      material: 'mat.wall.concrete.cracked',
      pattern: 'pebble',
      tiles: 9,
      albedoStrength: 0.3,
      normalStrength: 0.7,
      patternStrength: 0.7,
      roughnessStrength: 0.5,
    }),
  },
  chitin: {
    roughness: 0.3,
    metalness: 0.14,
    ao: 0.8,
    tint: 'none',
    detail: detail({
      material: 'mat.metal.shutter.painted',
      pattern: 'hexcell',
      tiles: 12,
      albedoStrength: 0.22,
      normalStrength: 0.5,
      patternStrength: 0.85,
      roughnessStrength: 0.5,
    }),
  },
  scale: {
    roughness: 0.44,
    metalness: 0.06,
    ao: 0.85,
    tint: 'none',
    detail: detail({
      material: 'mat.roof.tiles.grey',
      pattern: 'scale',
      tiles: 9,
      albedoStrength: 0.32,
      normalStrength: 0.75,
      patternStrength: 0.9,
      roughnessStrength: 0.5,
    }),
  },
  slime: {
    roughness: 0.16,
    metalness: 0,
    ao: 0.75,
    tint: 'none',
    detail: detail({ pattern: 'pebble', tiles: 16, patternStrength: 0.35, normalStrength: 0 }),
  },
  glow: {
    roughness: 0.35,
    metalness: 0,
    ao: 0.4,
    tint: 'none',
    emissive: 0xffffff,
    emissiveStrength: 1,
    detail: detail({ pattern: 'none', tiles: 4, albedoStrength: 0, normalStrength: 0 }),
  },
};

/** Merge per-character overrides over the defaults. */
export function resolveSurfaces(
  overrides?: Partial<Record<SurfaceClass, Partial<SurfaceStyle>>>
): SurfaceStyleSet {
  if (overrides === undefined) return DEFAULT_SURFACES;
  const out = {} as Record<SurfaceClass, SurfaceStyle>;
  for (const key of SURFACE_CLASSES) {
    const base = DEFAULT_SURFACES[key];
    const patch = overrides[key];
    out[key] =
      patch === undefined
        ? base
        : { ...base, ...patch, detail: { ...base.detail, ...(patch.detail ?? {}) } };
  }
  return out;
}

/** Every CC0 material id a style set references, deduplicated and sorted. */
export function detailMaterialIds(styles: SurfaceStyleSet): string[] {
  const ids = new Set<string>();
  for (const key of SURFACE_CLASSES) {
    const id = styles[key].detail.material;
    if (id !== undefined) ids.add(id);
  }
  return [...ids].sort();
}

/** Ids referenced by the classes a particular character actually uses. */
export function usedDetailMaterialIds(
  styles: SurfaceStyleSet,
  classes: Iterable<SurfaceClass>
): string[] {
  const ids = new Set<string>();
  for (const key of classes) {
    const id = styles[key].detail.material;
    if (id !== undefined) ids.add(id);
  }
  return [...ids].sort();
}
