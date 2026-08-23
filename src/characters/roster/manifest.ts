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
import { resolveSurfaces } from './surfaces';
import type { RosterEntry } from './types';

/** Texture roles a baked character ships. */
export type CharacterMapRole = 'albedo' | 'normal' | 'orm' | 'emissive' | 'face' | 'mask';

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

/**
 * True when a character needs an emissive map baked.
 *
 * Derived from the RESOLVED surface table, restricted to the classes the
 * character actually paints — because that is exactly what the baker keys off
 * (`atlas.ts` sets `glowing` whenever a painted texel's resolved style has an
 * `emissive`). Consulting only `entry.surfaces` missed the `glow` class, which
 * carries an emissive in `DEFAULT_SURFACES` and needs no override to be used:
 * the bake would write `emissive.<tier>.png`, the manifest would omit the
 * texture and the runtime would never fetch it, leaving glowing cores flat.
 */
export function entryGlows(entry: RosterEntry): boolean {
  if (entry.face.glow !== undefined) return true;
  const styles = resolveSurfaces(entry.surfaces);
  return entry.colors.some((color) => styles[color.surface].emissive !== undefined);
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
  if (entry.crowd === true) ids.push(mapAssetId(entry, 'mask'));
  return ids;
}
