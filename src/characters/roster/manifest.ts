/**
 * ASSET IDS AND MATERIAL SPECS
 *
 * The naming convention every baked character file follows, in one place, so
 * the offline baker, the runtime registry and the tests cannot disagree about
 * what a character's albedo is called.
 *
 * Ids are dot-namespaced exactly as `@/types/assets.ts` requires, and nothing
 * anywhere resolves a PATH: `chr.saitama.albedo` is the key, and the manifest
 * says which file serves it at which quality tier.
 */

import type { MaterialSpec } from '@/types';
import type { Expression, RosterEntry } from './types';
import { EXPRESSIONS } from './types';

/** Texture roles a baked character ships. */
export type CharacterMapRole = 'albedo' | 'normal' | 'orm' | 'emissive' | 'face';

/** Asset id for one of a character's maps. */
export function mapAssetId(entry: RosterEntry, role: CharacterMapRole): string {
  return `${entry.id}.${role}`;
}

/** Asset id for a character's material description. */
export function materialAssetId(entry: RosterEntry): string {
  return `${entry.id}.material`;
}

/** File name (relative to the character's directory) for a map at a tier. */
export function mapFileName(role: CharacterMapRole, tier: string): string {
  return `${role}.${tier}.png`;
}

/** Directory a character's built files live in, under the generated root. */
export function characterDir(entry: RosterEntry): string {
  return `chr/${entry.id.replace(/^chr\./, '')}`;
}

/**
 * The declarative material description for a character.
 *
 * `roughness` and `metalness` are 1.0 because both are supplied per texel by
 * the ORM map and three MULTIPLIES the scalar by the sampled value. Setting
 * them to anything else would silently scale the whole bake.
 */
export function materialSpecFor(entry: RosterEntry): MaterialSpec {
  return {
    id: materialAssetId(entry),
    kind: 'standard',
    color: 0xffffff,
    roughness: 1,
    metalness: 1,
    mapKey: mapAssetId(entry, 'albedo'),
    normalMapKey: mapAssetId(entry, 'normal'),
    ormMapKey: mapAssetId(entry, 'orm'),
    emissiveMapKey: entryGlows(entry) ? mapAssetId(entry, 'emissive') : undefined,
    normalScale: 1,
    uvRepeat: [1, 1],
    castShadow: true,
    receiveShadow: true,
    instanced: entry.crowd === true,
  };
}

/** True when a character needs an emissive map baked. */
export function entryGlows(entry: RosterEntry): boolean {
  if (entry.face.glow !== undefined) return true;
  const surfaces = entry.surfaces;
  if (surfaces === undefined) return false;
  return Object.values(surfaces).some((style) => style?.emissive !== undefined);
}

/** Expressions a character ships, in strip order (index 0 at the bottom). */
export function entryExpressions(_entry: RosterEntry): readonly Expression[] {
  return EXPRESSIONS;
}

/** Every asset id a character contributes to the manifest. */
export function entryAssetIds(entry: RosterEntry): string[] {
  const ids = [
    entry.id,
    materialAssetId(entry),
    mapAssetId(entry, 'albedo'),
    mapAssetId(entry, 'normal'),
    mapAssetId(entry, 'orm'),
    mapAssetId(entry, 'face'),
  ];
  if (entryGlows(entry)) ids.push(mapAssetId(entry, 'emissive'));
  return ids;
}
