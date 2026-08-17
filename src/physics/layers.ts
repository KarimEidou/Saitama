/**
 * COLLISION LAYERS
 *
 * Rapier filters pairs with a single 32-bit value per collider: the high 16
 * bits are the layers the collider BELONGS to, the low 16 bits are the layers
 * it COLLIDES WITH. A pair interacts only when both directions agree:
 *
 *   ((a >> 16) & b) !== 0 && ((b >> 16) & a) !== 0
 *
 * That symmetry is the part people get wrong. Declaring "debris collides with
 * world" is not enough — the world must also accept debris, or the pair is
 * silently dropped. `interactionGroups()` builds the value; the defaults below
 * are already symmetric.
 */

import type { PhysicsLayer } from '@/types';

/** Every layer, in bit order. Index === bit index. */
export const PHYSICS_LAYERS: readonly PhysicsLayer[] = [
  'world',
  'player',
  'monster',
  'npc',
  'debris',
  'projectile',
  'trigger',
  'ragdoll',
];

/** Single-bit membership mask per layer. */
export const LAYER_BIT: Readonly<Record<PhysicsLayer, number>> = {
  world: 1 << 0,
  player: 1 << 1,
  monster: 1 << 2,
  npc: 1 << 3,
  debris: 1 << 4,
  projectile: 1 << 5,
  trigger: 1 << 6,
  ragdoll: 1 << 7,
};

/** Mask matching every layer. */
export const ALL_LAYERS = 0xffff;

/**
 * Default collision matrix. Chosen for cost as much as correctness: debris
 * against debris is the single most expensive pair class in a collapse, so it
 * is kept but everything gratuitous (debris vs npc, ragdoll vs ragdoll) is not.
 */
export const DEFAULT_COLLISION_MATRIX: Readonly<Record<PhysicsLayer, readonly PhysicsLayer[]>> = {
  world: ['world', 'player', 'monster', 'npc', 'debris', 'projectile', 'ragdoll'],
  player: ['world', 'monster', 'npc', 'debris', 'projectile', 'trigger', 'ragdoll'],
  monster: ['world', 'player', 'npc', 'debris', 'projectile', 'trigger', 'ragdoll'],
  npc: ['world', 'player', 'monster', 'projectile', 'trigger'],
  debris: ['world', 'player', 'monster', 'debris', 'ragdoll'],
  projectile: ['world', 'player', 'monster', 'npc'],
  trigger: ['player', 'monster', 'npc'],
  ragdoll: ['world', 'player', 'monster', 'debris'],
};

/** Fold a list of layers into a 16-bit mask. */
export function layerMask(layers: readonly PhysicsLayer[] | undefined): number {
  if (layers === undefined || layers.length === 0) return ALL_LAYERS;
  let mask = 0;
  for (const layer of layers) mask |= LAYER_BIT[layer];
  return mask;
}

/**
 * Pack membership and filter masks into Rapier's `InteractionGroups`.
 * Returned as an unsigned 32-bit value.
 */
export function interactionGroups(membership: number, filter: number): number {
  return (((membership & 0xffff) << 16) | (filter & 0xffff)) >>> 0;
}

/** Interaction groups for a body on `layer` colliding with `collidesWith`. */
export function groupsFor(layer: PhysicsLayer, collidesWith: readonly PhysicsLayer[]): number {
  return interactionGroups(LAYER_BIT[layer], layerMask(collidesWith));
}

/**
 * Interaction groups for a QUERY (raycast, overlap) restricted to `layers`.
 * A query belongs to every layer so any target that accepts anything sees it,
 * and filters down to the layers asked for.
 */
export function queryGroups(layers: readonly PhysicsLayer[] | undefined): number {
  return interactionGroups(ALL_LAYERS, layerMask(layers));
}

/** The layer a membership mask names, or undefined when it names none/many. */
export function layerFromMask(mask: number): PhysicsLayer | undefined {
  for (const layer of PHYSICS_LAYERS) {
    if (LAYER_BIT[layer] === (mask & 0xffff)) return layer;
  }
  return undefined;
}

/** Would these two layers interact under `DEFAULT_COLLISION_MATRIX`? */
export function layersInteract(a: PhysicsLayer, b: PhysicsLayer): boolean {
  return DEFAULT_COLLISION_MATRIX[a].includes(b) && DEFAULT_COLLISION_MATRIX[b].includes(a);
}
