/**
 * CITY MATERIAL BINDING
 *
 * The city references materials by their stable manifest id and nothing else —
 * never a file path, never a texture filename. Every id in this file exists in
 * `tools/manifest/textures.json` (41 curated CC0 entries); resolution to actual
 * KTX2 bytes is `IAssetRegistry`'s job, and swapping the delivery mechanism
 * must not touch a line here.
 *
 * ── THE THREE-SLOT BUDGET ──────────────────────────────────────────────────
 * A merged block resolves to exactly three materials: facade, glass, roof.
 * That is what holds a block to three draw calls. Visual variety therefore
 * cannot come from "use a fourth material" — it comes from
 *
 *   • a different facade/roof id PER BLOCK (so the brick block next to the
 *     concrete block next to the plaster block reads as different streets), and
 *   • a per-vertex tint multiplied into the map WITHIN a block (so buildings
 *     on the same street are cream, grey-blue, salmon, off-white).
 *
 * Baked vertex tint is close to free — three floats a vertex — and it is the
 * only variety mechanism that survives the merge.
 *
 * UV CONVENTION: the city writes UVs in metres divided by the material's
 * `tileSizeMeters`, so every merged geometry samples at correct real-world
 * density with `uvRepeat = (1, 1)`. Tile sizes are mirrored here from the
 * manifest; `verifyMaterialTable` cross-checks them against the manifest in a
 * unit test so the two can never drift silently.
 */

/** Material ids the city can bind, grouped by the role they play. */
export const CITY_MATERIALS = {
  road: {
    worn: 'mat.road.asphalt.worn',
    rough: 'mat.road.asphalt.rough',
    clean: 'mat.road.asphalt.clean',
    damaged: 'mat.road.asphalt.damaged',
    cobble: 'mat.ground.cobblestone.alley',
    markings: 'mat.road.markings',
  },
  ground: {
    sidewalkSlabs: 'mat.ground.sidewalk.slabs',
    sidewalkConcrete: 'mat.ground.sidewalk.concrete',
    plaza: 'mat.ground.plaza.tiles',
    gravel: 'mat.ground.gravel',
    dirt: 'mat.ground.dirt.dry',
    grass: 'mat.ground.grass.leafy',
    rubble: 'mat.debris.rubble.wall',
    stones: 'mat.debris.gravel.stones',
  },
  wall: {
    concreteDirty: 'mat.wall.concrete.dirty',
    concretePlain: 'mat.wall.concrete.plain',
    concreteCracked: 'mat.wall.concrete.cracked',
    concreteLayers: 'mat.wall.concrete.layers',
    concretePainted: 'mat.wall.concrete.painted',
    brickRed: 'mat.wall.brick.red',
    brickWeathered: 'mat.wall.brick.weathered',
    brickBroken: 'mat.wall.brick.broken',
    plasterBeige: 'mat.wall.plaster.beige',
    plasterWhite: 'mat.wall.plaster.white',
    plasterBroken: 'mat.wall.plaster.broken',
    factoryPanel: 'mat.metal.panel.factory',
    corrugated: 'mat.metal.corrugated',
    corrugatedWorn: 'mat.metal.corrugated.worn',
    shutter: 'mat.metal.shutter.painted',
    container: 'mat.metal.container.side',
    planks: 'mat.wood.planks.weathered',
  },
  roof: {
    bitumen: 'mat.roof.bitumen.flat',
    tilesGrey: 'mat.roof.tiles.grey',
    tilesCeramic: 'mat.roof.tiles.ceramic',
    corrugated: 'mat.metal.corrugated',
    corrugatedWorn: 'mat.metal.corrugated.worn',
    metalPlate: 'mat.metal.plate.industrial',
    rustFine: 'mat.metal.rust.fine',
    rustCoarse: 'mat.metal.rust.coarse',
    grate: 'mat.metal.grate.rusty',
  },
  glass: 'mat.glass.window',
} as const;

/**
 * Real-world size of one UV tile, in metres, mirrored from the manifest's
 * `tileSizeMeters`. Used to convert a metre measurement into UV space at
 * generation time.
 *
 * Kept as a plain table rather than read from the manifest at runtime because
 * generation runs inside a worker that must not depend on manifest I/O — and
 * because a wrong tile size is a silent visual bug, so it gets a test.
 */
export const MATERIAL_TILE_SIZE: Readonly<Record<string, number>> = {
  'mat.road.asphalt.worn': 3,
  'mat.road.asphalt.rough': 2.08,
  'mat.road.asphalt.damaged': 2.2,
  'mat.road.asphalt.clean': 2.1,
  'mat.ground.sidewalk.slabs': 1.8,
  'mat.ground.sidewalk.concrete': 2.12,
  'mat.ground.cobblestone.alley': 2,
  'mat.ground.plaza.tiles': 3,
  'mat.wall.concrete.dirty': 3,
  'mat.wall.concrete.plain': 2.16,
  'mat.wall.concrete.cracked': 1,
  'mat.wall.concrete.layers': 2,
  'mat.wall.concrete.painted': 4,
  'mat.wall.brick.red': 1,
  'mat.wall.brick.weathered': 3,
  'mat.wall.brick.broken': 1.8,
  'mat.wall.plaster.beige': 3,
  'mat.wall.plaster.white': 1,
  'mat.wall.plaster.broken': 1.5,
  'mat.metal.rust.fine': 1,
  'mat.metal.rust.coarse': 2.2,
  'mat.metal.corrugated': 1.12,
  'mat.metal.corrugated.worn': 1.8,
  'mat.metal.shutter.painted': 2,
  'mat.metal.plate.industrial': 0.5,
  'mat.metal.panel.factory': 3,
  'mat.metal.grate.rusty': 0.5,
  'mat.metal.container.side': 1.94,
  'mat.roof.tiles.grey': 1.5,
  'mat.roof.tiles.ceramic': 3.5,
  'mat.roof.bitumen.flat': 20,
  'mat.wood.planks.weathered': 1.8,
  'mat.wood.planks.dirty': 2,
  'mat.ground.grass.leafy': 2,
  'mat.terrain.grass.aerial': 15,
  'mat.ground.dirt.dry': 1.3,
  'mat.ground.gravel': 2,
  'mat.debris.gravel.stones': 2,
  'mat.debris.rubble.wall': 3,
  // Procedural, generated rather than downloaded — Poly Haven has neither a
  // glass nor a road-marking texture, so these two are synthesised.
  'mat.glass.window': 2.4,
  'mat.road.markings': 8,
};

/** UV scale (1 / tile size) for a material id. Falls back to 1 m tiles. */
export function uvScaleFor(materialKey: string): number {
  const tile = MATERIAL_TILE_SIZE[materialKey];
  return tile && tile > 0 ? 1 / tile : 1;
}

/** Every material id the city can reference, for preloading. */
export function allCityMaterialKeys(): string[] {
  const out = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      out.add(node);
      return;
    }
    if (node && typeof node === 'object') {
      for (const value of Object.values(node as Record<string, unknown>)) walk(value);
    }
  };
  walk(CITY_MATERIALS);
  return [...out].sort();
}

/* -------------------------------------------------------------------------- */
/* Per-block material selection                                               */
/* -------------------------------------------------------------------------- */

/** The three material ids a merged block geometry binds, in slot order. */
export interface IBlockMaterialSet {
  /** Slot 0 — walls and opaque architecture. */
  readonly facade: string;
  /** Slot 1 — glazing and lit signage. */
  readonly glass: string;
  /** Slot 2 — roofs, balcony slabs, rooftop plant, metalwork. */
  readonly roof: string;
}

/** The materials a chunk's ground geometry binds, in slot order. */
export interface IGroundMaterialSet {
  /** Slot 0 — carriageway. */
  readonly road: string;
  /** Slot 1 — sidewalks, kerbs, parcel surfaces. */
  readonly paving: string;
  /** Slot 2 — lane markings and crossings. */
  readonly markings: string;
}

/* -------------------------------------------------------------------------- */
/* Tint helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Unpack a hex int into linear-ish RGB floats for the vertex colour buffer. */
export function tintToRgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255];
}

/** Multiply a tint by a scalar, clamped to 0..1. Used for baked shading. */
export function shadeTint(
  tint: readonly [number, number, number],
  factor: number
): [number, number, number] {
  return [
    Math.min(1, Math.max(0, tint[0] * factor)),
    Math.min(1, Math.max(0, tint[1] * factor)),
    Math.min(1, Math.max(0, tint[2] * factor)),
  ];
}

/**
 * Cross-check the mirrored tile-size table against a loaded manifest.
 * Returns the ids that disagree, so a test can fail loudly on drift.
 */
export function verifyMaterialTable(
  entries: readonly { id: string; tileSizeMeters?: number }[]
): string[] {
  const problems: string[] = [];
  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const key of allCityMaterialKeys()) {
    const entry = byId.get(key);
    if (!entry) {
      problems.push(`${key}: not present in the asset manifest`);
      continue;
    }
    const expected = MATERIAL_TILE_SIZE[key];
    if (expected === undefined) {
      problems.push(`${key}: missing from MATERIAL_TILE_SIZE`);
      continue;
    }
    // Procedural materials carry no manifest tile size; the city defines theirs.
    if (entry.tileSizeMeters === undefined) continue;
    if (Math.abs(entry.tileSizeMeters - expected) > 1e-6) {
      problems.push(`${key}: manifest ${entry.tileSizeMeters} m vs table ${expected} m`);
    }
  }
  return problems;
}
