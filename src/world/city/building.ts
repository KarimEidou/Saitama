/**
 * PRE-FRACTURED BUILDING GENERATOR
 *
 * Footprint -> storeys -> a ring of 2.4 m facade panels per storey -> roof,
 * emitted in fracture order so the result is destructible the instant it
 * exists.
 *
 * ── EMISSION ORDER IS THE DESIGN ───────────────────────────────────────────
 * Geometry is not emitted wall by wall. It is emitted chunk by chunk:
 *
 *     for floor f:
 *       for quadrant q in E, S, W, N:
 *         beginChunk()
 *           panels of floor f facing quadrant q
 *           the slab wedge under them
 *           on the top storey: roof deck wedge, parapet run, rooftop plant
 *         endChunk()
 *
 * which makes each chunk's vertices contiguous by construction, with no
 * post-pass sort and no shared vertices between chunks. Everything else in the
 * destruction pipeline follows from that layout.
 *
 * Panel KINDS are chosen in a separate, earlier pass that walks
 * (floor, edge, panel) order and stores a per-panel seed. Choice order is
 * therefore independent of emission order, so the same building comes out
 * byte-identical no matter how the loops are arranged later.
 *
 * All geometry is LOCAL: origin at the footprint centroid, y = 0 at the
 * foundation. `block.ts` applies position and rotation during the merge, which
 * keeps fracture centroids in the parent's local space exactly as
 * `FractureChunk` specifies.
 */

import { createRng, type IRandom } from '@/util';
import type { BuildingStyle, StructureMaterial } from '@/types';
import {
  MatSlot,
  MeshBuilder,
  type AABB6,
  type IGeometryBuffers,
} from './mesh-builder';
import { shadeTint, tintToRgb, uvScaleFor } from './materials';
import {
  emitPanel,
  panelSupport,
  type FacadeDetail,
  type IFacadeAttachment,
  type IPanelContext,
  type PanelKind,
} from './facade';
import {
  COLLAPSE_SUPPORT_RATIO,
  QUADRANTS,
  STRUCTURE_DENSITY,
  neighboursOf,
  quadrantOf,
  type IBuildingFractureChunk,
  type IFloorSupport,
  type IFractureLayout,
  type IFractureSlotRange,
} from './fracture';
import {
  polygonCentroid,
  triangulate,
  type Polygon,
  type Vec2,
} from './polygon';

/** Nominal facade module. See `facade.ts` for why it is 2.4 m. */
export const PANEL_WIDTH = 2.4;

/** How much geometry a building is worth. */
export type BuildingDetail = 'full' | 'reduced' | 'box';

/** Everything needed to generate one building. */
export interface IBuildingRecipe {
  readonly id: string;
  /** Footprint in LOCAL metres, CCW, roughly centred on the origin. */
  readonly footprint: Polygon;
  readonly floors: number;
  readonly floorHeight: number;
  /** Ground storey height multiplier; shopfronts want ~1.3. */
  readonly groundFloorScale: number;
  readonly style: BuildingStyle;
  readonly facadeMaterial: string;
  readonly roofMaterial: string;
  readonly glassMaterial: string;
  /** Base tint as a hex int, multiplied into the facade map. */
  readonly tint: number;
  readonly seed: number;
  readonly detail: BuildingDetail;
  /** Relative weights over panel kinds on upper storeys. */
  readonly panelWeights: Readonly<Partial<Record<PanelKind, number>>>;
  /** Relative weights over panel kinds on the ground storey. */
  readonly groundWeights: Readonly<Partial<Record<PanelKind, number>>>;
  /** 0..1 rooftop plant density. */
  readonly rooftopClutter: number;
  readonly parapetHeight: number;
  /** 0..1 chance a given window reads as lit. */
  readonly litWindowChance: number;
  /** 0..1 chance a bay carries a projecting sign. */
  readonly signage?: number;
  readonly structureMaterial: StructureMaterial;
  /** Model ids overlaid on hero buildings; empty for ordinary fill. */
  readonly heroOverlays?: boolean;
}

/** A generated building: geometry plus its baked fracture layout. */
export interface IBuildingBuild {
  readonly id: string;
  readonly buffers: IGeometryBuffers;
  readonly fracture: IFractureLayout;
  readonly floors: number;
  readonly height: number;
  readonly footprint: Polygon;
  readonly bounds: AABB6;
  /** Model overlays in LOCAL space; `block.ts` transforms them to world. */
  readonly attachments: readonly IFacadeAttachment[];
  readonly triangles: number;
  readonly panelCount: number;
}

/* -------------------------------------------------------------------------- */
/* Internal layout records                                                    */
/* -------------------------------------------------------------------------- */

interface IEdge {
  readonly a: Vec2;
  readonly b: Vec2;
  readonly length: number;
  /** Unit direction a -> b. */
  readonly dir: readonly [number, number];
  /** Outward unit normal. */
  readonly normal: readonly [number, number];
  readonly panelCount: number;
  readonly panelWidth: number;
}

interface IPanelPlan {
  readonly floor: number;
  readonly edge: number;
  readonly slot: number;
  readonly kind: PanelKind;
  readonly quadrant: number;
  readonly seed: number;
  readonly lit: boolean;
  /** Distance along the edge to the panel's leading corner. */
  readonly u: number;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

/** Generate one pre-fractured building. */
export function generateBuilding(recipe: IBuildingRecipe): IBuildingBuild {
  const centroid = polygonCentroid(recipe.footprint);
  // Re-centre so local space really is centred on the footprint; fracture
  // centroids and the quadrant test both depend on it.
  const footprint: Vec2[] = recipe.footprint.map((p) => [p[0] - centroid[0], p[1] - centroid[1]]);

  const edges = buildEdges(footprint);
  const floorTops = computeFloorTops(recipe);
  const height = floorTops[floorTops.length - 1];

  const rng = createRng(recipe.seed);
  const panels = planPanels(recipe, edges, rng);

  const builder = new MeshBuilder();
  const attachments: IFacadeAttachment[] = [];
  const facadeUv = uvScaleFor(recipe.facadeMaterial);
  const glassUv = uvScaleFor(recipe.glassMaterial);
  const roofUv = uvScaleFor(recipe.roofMaterial);
  const baseTint = tintToRgb(recipe.tint);
  const roofTintBase = shadeTint(baseTint, 0.62);

  const slabTris = triangulate(footprint);
  const clutter = planRoofClutter(recipe, footprint, height, createRng(recipe.seed ^ 0x5eed1a));

  const chunks: IBuildingFractureChunk[] = [];
  const floorInfos: IFloorSupport[] = [];
  const density = STRUCTURE_DENSITY[recipe.structureMaterial];
  let totalMass = 0;

  for (let f = 0; f < recipe.floors; f++) {
    const y0 = f === 0 ? 0 : floorTops[f - 1];
    const y1 = floorTops[f];
    const isTop = f === recipe.floors - 1;
    const floorChunks: number[] = [];
    let floorSupport = 0;

    for (let q = 0; q < QUADRANTS; q++) {
      builder.beginChunk();
      let support = 0;

      // --- facade panels ------------------------------------------------
      for (const panel of panels) {
        if (panel.floor !== f || panel.quadrant !== q) continue;
        const edge = edges[panel.edge];
        support += panelSupport(panel.kind) * edge.panelWidth;
        emitOnePanel(
          builder,
          recipe,
          panel,
          edge,
          y0,
          y1 - y0,
          baseTint,
          facadeUv,
          glassUv,
          roofUv,
          attachments,
          height,
          isTop
        );
      }

      // --- slab wedge ---------------------------------------------------
      emitWedge(
        builder,
        footprint,
        slabTris,
        y0 + 0.02,
        q,
        MatSlot.Facade,
        facadeUv * 0.5,
        shadeTint([0.55, 0.54, 0.52], 1)
      );

      // --- roof, parapet, plant ----------------------------------------
      if (isTop) {
        emitWedge(builder, footprint, slabTris, y1, q, MatSlot.Roof, roofUv, roofTintBase);
        emitParapet(builder, edges, y1, recipe.parapetHeight, q, facadeUv, baseTint);
        for (const item of clutter) {
          if (item.quadrant !== q) continue;
          emitClutter(builder, item, y1, roofUv);
        }
        support += 0.001; // keep a roof-only quadrant from having zero support
      }

      const span = builder.endChunk();
      const index = f * QUADRANTS + q;
      // Wall area x nominal 0.22 m of concrete is a better mass proxy than the
      // triangle-area sum, which double counts reveals and clutter.
      const volume = Math.max(0.05, span.volume);
      const mass = volume * density;
      totalMass += mass;
      floorSupport += support;

      const parts: IFractureSlotRange[] = [];
      for (let slot = 0; slot < span.slotRanges.length; slot++) {
        const [start, count] = span.slotRanges[slot];
        if (count > 0) parts.push({ slot, start, count });
      }

      chunks.push({
        index,
        floor: f,
        quadrant: q,
        start: 0,
        count: 0,
        parts,
        vertexStart: span.vertexStart,
        vertexCount: span.vertexCount,
        centroid: span.centroid,
        volume,
        mass,
        aabb: span.bounds,
        grounded: f === 0,
        neighbours: neighboursOf(f, q, recipe.floors),
        supportShare: support,
      });
      floorChunks.push(index);
    }

    floorInfos.push({ floor: f, y0, y1, chunks: floorChunks, totalSupport: floorSupport });
  }

  const buffers = builder.build();

  // Rebase every slot-local index range onto the packed buffer, and normalise
  // each chunk's support into a share of its floor.
  const slotOffsets: number[] = [];
  for (let slot = 0; slot < 3; slot++) slotOffsets.push(builder.slotOffset(slot));

  const finalChunks: IBuildingFractureChunk[] = chunks.map((chunk) => {
    const parts = chunk.parts.map((p) => ({
      slot: p.slot,
      start: p.start + slotOffsets[p.slot],
      count: p.count,
    }));
    const facade = parts.find((p) => p.slot === MatSlot.Facade) ?? parts[0];
    const floorTotal = floorInfos[chunk.floor].totalSupport;
    return {
      ...chunk,
      parts,
      start: facade ? facade.start : 0,
      count: facade ? facade.count : 0,
      supportShare: floorTotal > 0 ? chunk.supportShare / floorTotal : 0.25,
    };
  });

  const fracture: IFractureLayout = {
    chunks: finalChunks,
    floors: floorInfos,
    structureMaterial: recipe.structureMaterial,
    totalMass,
    collapseSupportRatio: COLLAPSE_SUPPORT_RATIO,
    slotBase: slotOffsets,
  };

  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of footprint) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1];
    if (p[1] > maxZ) maxZ = p[1];
  }

  return {
    id: recipe.id,
    buffers,
    fracture,
    floors: recipe.floors,
    height,
    footprint,
    bounds: [minX, 0, minZ, maxX, height + recipe.parapetHeight, maxZ],
    attachments,
    triangles: buffers.indexCount / 3,
    panelCount: panels.length,
  };
}

/* -------------------------------------------------------------------------- */
/* Layout passes                                                              */
/* -------------------------------------------------------------------------- */

function buildEdges(footprint: Polygon): IEdge[] {
  const edges: IEdge[] = [];
  for (let i = 0, n = footprint.length; i < n; i++) {
    const a = footprint[i];
    const b = footprint[(i + 1) % n];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const length = Math.hypot(dx, dz);
    if (length < 0.2) continue;
    const dir: [number, number] = [dx / length, dz / length];
    // CCW ring: the right-hand normal of the travel direction faces outward.
    const normal: [number, number] = [dir[1], -dir[0]];
    // Whole panels only. A clipped panel at a corner is the loudest possible
    // procedural tell, so the module width flexes instead.
    const panelCount = Math.max(1, Math.round(length / PANEL_WIDTH));
    edges.push({ a, b, length, dir, normal, panelCount, panelWidth: length / panelCount });
  }
  return edges;
}

/** Cumulative height of the top of each storey. */
function computeFloorTops(recipe: IBuildingRecipe): number[] {
  const tops: number[] = [];
  let y = 0;
  for (let f = 0; f < recipe.floors; f++) {
    y += f === 0 ? recipe.floorHeight * recipe.groundFloorScale : recipe.floorHeight;
    tops.push(y);
  }
  return tops;
}

/**
 * Decide every panel's kind up front, walking (floor, edge, panel) order.
 *
 * Kept separate from emission so the choice sequence never depends on the
 * fracture loop's order. Each panel also gets its own seed here, which is what
 * lets the emitters jitter geometry without the draw order mattering.
 */
function planPanels(recipe: IBuildingRecipe, edges: readonly IEdge[], rng: IRandom): IPanelPlan[] {
  const out: IPanelPlan[] = [];
  const upper = normaliseWeights(recipe.panelWeights);
  const ground = normaliseWeights(recipe.groundWeights);

  for (let f = 0; f < recipe.floors; f++) {
    const isGround = f === 0;
    const table = isGround ? ground : upper;
    for (let e = 0; e < edges.length; e++) {
      const edge = edges[e];
      for (let p = 0; p < edge.panelCount; p++) {
        const u = p * edge.panelWidth;
        const cx = edge.a[0] + edge.dir[0] * (u + edge.panelWidth * 0.5);
        const cz = edge.a[1] + edge.dir[1] * (u + edge.panelWidth * 0.5);
        let kind = rng.weighted(table.kinds, table.weights);
        // A doorway only makes sense at street level, and only once per edge.
        if (kind === 'door' && !isGround) kind = 'window';
        if (kind === 'shopfront' && !isGround) kind = 'window';
        out.push({
          floor: f,
          edge: e,
          slot: p,
          kind,
          quadrant: quadrantOf(cx, cz),
          seed: rng.nextUint32(),
          lit: rng.bool(recipe.litWindowChance),
          u,
        });
      }
    }
  }
  return out;
}

interface IWeightTable {
  readonly kinds: PanelKind[];
  readonly weights: number[];
}

function normaliseWeights(weights: Readonly<Partial<Record<PanelKind, number>>>): IWeightTable {
  const kinds: PanelKind[] = [];
  const values: number[] = [];
  // Iterate a FIXED kind order, not Object.keys, so the table is
  // insertion-order independent and the city cannot drift when the plan JSON
  // is reformatted.
  for (const kind of [
    'window',
    'shopfront',
    'door',
    'blank',
    'balcony',
    'ac_unit',
    'fire_escape_anchor',
  ] as const) {
    const w = weights[kind];
    if (w !== undefined && w > 0) {
      kinds.push(kind);
      values.push(w);
    }
  }
  if (kinds.length === 0) {
    kinds.push('blank');
    values.push(1);
  }
  return { kinds, weights: values };
}

/* -------------------------------------------------------------------------- */
/* Emission                                                                   */
/* -------------------------------------------------------------------------- */

const GLASS_DARK: readonly [number, number, number] = [0.1, 0.13, 0.17];
const GLASS_LIT: readonly [number, number, number] = [0.98, 0.84, 0.55];

function emitOnePanel(
  builder: MeshBuilder,
  recipe: IBuildingRecipe,
  panel: IPanelPlan,
  edge: IEdge,
  y0: number,
  panelHeight: number,
  tint: readonly [number, number, number],
  facadeUv: number,
  glassUv: number,
  roofUv: number,
  attachments: IFacadeAttachment[],
  totalHeight: number,
  isTop: boolean
): void {
  const rng = createRng(panel.seed);
  // Baked sky occlusion: darker at the pavement, brighter towards the parapet.
  const shade = 0.7 + 0.3 * Math.min(1, (y0 + panelHeight * 0.5) / Math.max(6, totalHeight));

  const glassJitter = 0.85 + rng.next() * 0.3;
  const glassTint: [number, number, number] = panel.lit
    ? [GLASS_LIT[0] * glassJitter, GLASS_LIT[1] * glassJitter, GLASS_LIT[2] * glassJitter]
    : [
        GLASS_DARK[0] * glassJitter + shade * 0.06,
        GLASS_DARK[1] * glassJitter + shade * 0.08,
        GLASS_DARK[2] * glassJitter + shade * 0.11,
      ];

  const context: IPanelContext = {
    builder,
    origin: [
      edge.a[0] + edge.dir[0] * panel.u,
      y0,
      edge.a[1] + edge.dir[1] * panel.u,
    ],
    right: [edge.dir[0], 0, edge.dir[1]],
    normal: [edge.normal[0], 0, edge.normal[1]],
    width: edge.panelWidth,
    height: panelHeight,
    uStart: panel.u,
    facadeUv,
    glassUv,
    roofUv,
    tint,
    shade,
    glassTint,
    rng,
    detail: recipe.detail === 'full' ? 'full' : ('reduced' as FacadeDetail),
    attachments,
    isGround: panel.floor === 0,
    isTop,
    signage: recipe.signage ?? 0,
  };

  if (recipe.detail === 'box') {
    // Box detail still emits one quad per bay so the storey banding survives —
    // a flat prism reads as a monolith even from the air.
    const band = 0.9 + ((panel.floor % 2) - 0.5) * 0.06;
    emitFlatBay(context, shadeTint(tint, shade * band), facadeUv);
    return;
  }
  emitPanel(panel.kind, context);
}

function emitFlatBay(
  c: IPanelContext,
  color: readonly [number, number, number],
  scale: number
): void {
  const o = c.origin;
  const r = c.right;
  const w = c.width;
  const h = c.height;
  c.builder.quad(
    MatSlot.Facade,
    [o[0] + r[0] * w, o[1], o[2] + r[2] * w],
    [o[0], o[1], o[2]],
    [o[0], o[1] + h, o[2]],
    [o[0] + r[0] * w, o[1] + h, o[2] + r[2] * w],
    [c.uStart * scale, o[1] * scale, (c.uStart + w) * scale, (o[1] + h) * scale],
    color
  );
  c.builder.addVolume(w * h * 0.22);
}

/**
 * Emit the wedge of a horizontal polygon belonging to one quadrant.
 *
 * The polygon is fanned from its centroid, and each triangle is assigned to
 * the quadrant of the edge it spans — so the slab wedge under a quadrant's
 * panels is exactly the slab those panels sit on, and destroying the chunk
 * takes the floor with the wall.
 */
function emitWedge(
  builder: MeshBuilder,
  footprint: Polygon,
  _tris: readonly number[],
  y: number,
  quadrant: number,
  slot: number,
  uvScale: number,
  color: readonly [number, number, number]
): void {
  const n = footprint.length;
  for (let i = 0; i < n; i++) {
    const a = footprint[i];
    const b = footprint[(i + 1) % n];
    const mx = (a[0] + b[0]) * 0.5;
    const mz = (a[1] + b[1]) * 0.5;
    if (quadrantOf(mx, mz) !== quadrant) continue;
    builder.triangle(
      slot,
      [0, y, 0],
      [b[0], y, b[1]],
      [a[0], y, a[1]],
      [0, 0],
      [b[0] * uvScale, b[1] * uvScale],
      [a[0] * uvScale, a[1] * uvScale],
      color
    );
  }
}

/** Perimeter parapet run belonging to one quadrant. */
function emitParapet(
  builder: MeshBuilder,
  edges: readonly IEdge[],
  y: number,
  height: number,
  quadrant: number,
  uvScale: number,
  tint: readonly [number, number, number]
): void {
  if (height <= 0.01) return;
  const thickness = 0.22;
  for (const edge of edges) {
    const mx = (edge.a[0] + edge.b[0]) * 0.5;
    const mz = (edge.a[1] + edge.b[1]) * 0.5;
    if (quadrantOf(mx, mz) !== quadrant) continue;

    const nx = edge.normal[0];
    const nz = edge.normal[1];
    const outer: [Vec2, Vec2] = [edge.a, edge.b];
    const inner: [Vec2, Vec2] = [
      [edge.a[0] - nx * thickness, edge.a[1] - nz * thickness],
      [edge.b[0] - nx * thickness, edge.b[1] - nz * thickness],
    ];
    const uv: [number, number, number, number] = [0, y * uvScale, edge.length * uvScale, (y + height) * uvScale];

    // Outer face — continues the wall, so it takes the wall material.
    builder.quad(
      MatSlot.Facade,
      [outer[1][0], y, outer[1][1]],
      [outer[0][0], y, outer[0][1]],
      [outer[0][0], y + height, outer[0][1]],
      [outer[1][0], y + height, outer[1][1]],
      uv,
      shadeTint(tint, 1.02)
    );
    // Inner face, in shadow.
    builder.quad(
      MatSlot.Facade,
      [inner[0][0], y, inner[0][1]],
      [inner[1][0], y, inner[1][1]],
      [inner[1][0], y + height, inner[1][1]],
      [inner[0][0], y + height, inner[0][1]],
      uv,
      shadeTint(tint, 0.62)
    );
    // Coping.
    builder.quad(
      MatSlot.Facade,
      [inner[0][0], y + height, inner[0][1]],
      [inner[1][0], y + height, inner[1][1]],
      [outer[1][0], y + height, outer[1][1]],
      [outer[0][0], y + height, outer[0][1]],
      [0, 0, edge.length * uvScale, thickness * uvScale],
      shadeTint(tint, 1.12)
    );
    builder.addVolume(edge.length * height * thickness);
  }
}

/* -------------------------------------------------------------------------- */
/* Rooftop plant                                                              */
/* -------------------------------------------------------------------------- */

type ClutterKind = 'hvac' | 'tank' | 'bulkhead' | 'mast' | 'vent' | 'duct';

interface IClutterItem {
  readonly kind: ClutterKind;
  readonly x: number;
  readonly z: number;
  readonly rotation: number;
  readonly scale: number;
  readonly quadrant: number;
  readonly tint: readonly [number, number, number];
}

/**
 * Scatter rooftop plant.
 *
 * This is the highest value-per-triangle geometry in the whole city: from the
 * street a roofline reads as a silhouette, and water tanks on legs, aircon
 * banks and antenna masts are what make that silhouette look Japanese rather
 * than generic. It is also nearly free — a few hundred triangles a building.
 */
function planRoofClutter(
  recipe: IBuildingRecipe,
  footprint: Polygon,
  height: number,
  rng: IRandom
): IClutterItem[] {
  if (recipe.detail === 'box' && recipe.rooftopClutter < 0.5) return [];
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of footprint) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1];
    if (p[1] > maxZ) maxZ = p[1];
  }
  const inset = 1.6;
  const w = maxX - minX - inset * 2;
  const d = maxZ - minZ - inset * 2;
  if (w < 2 || d < 2) return [];

  const area = w * d;
  const budget = Math.max(1, Math.round((area / 42) * recipe.rooftopClutter * 2.2));
  const items: IClutterItem[] = [];

  const place = (kind: ClutterKind, scale: number, tint: readonly [number, number, number]) => {
    const x = minX + inset + rng.next() * w;
    const z = minZ + inset + rng.next() * d;
    items.push({ kind, x, z, rotation: rng.int(0, 3) * (Math.PI / 2), scale, quadrant: quadrantOf(x, z), tint });
  };

  // Every building tall enough to need stairs gets a bulkhead.
  if (recipe.floors >= 3) place('bulkhead', rng.range(0.9, 1.3), [0.62, 0.6, 0.58]);
  // The rooftop water tank on stilts: the signature Japanese roofline element.
  if (recipe.floors >= 3 && rng.bool(0.62)) place('tank', rng.range(0.85, 1.25), [0.66, 0.64, 0.6]);
  if (height > 24 && rng.bool(0.7)) place('mast', rng.range(0.9, 1.6), [0.5, 0.48, 0.46]);

  for (let i = 0; i < budget; i++) {
    const roll = rng.next();
    if (roll < 0.5) place('hvac', rng.range(0.8, 1.3), [0.7, 0.69, 0.66]);
    else if (roll < 0.72) place('vent', rng.range(0.7, 1.2), [0.45, 0.4, 0.36]);
    else if (roll < 0.88) place('duct', rng.range(0.8, 1.2), [0.55, 0.53, 0.5]);
    else place('tank', rng.range(0.7, 1.0), [0.6, 0.58, 0.55]);
  }
  return items;
}

function emitClutter(builder: MeshBuilder, item: IClutterItem, y: number, uvScale: number): void {
  const s = item.scale;
  switch (item.kind) {
    case 'hvac': {
      builder.box(MatSlot.Roof, item.x, y + 0.45 * s, item.z, 0.85 * s, 0.45 * s, 0.62 * s, uvScale, item.tint, 0b101111);
      // Fan cowl on top, so it is not a plain crate.
      builder.cylinder(MatSlot.Roof, item.x, y + 0.9 * s, item.z, 0.34 * s, 0.16 * s, 8, uvScale, shadeTint(item.tint, 0.8));
      break;
    }
    case 'tank': {
      const legH = 1.55 * s;
      const r = 1.05 * s;
      for (const [ox, oz] of [
        [-r * 0.65, -r * 0.65],
        [r * 0.65, -r * 0.65],
        [-r * 0.65, r * 0.65],
        [r * 0.65, r * 0.65],
      ]) {
        builder.box(MatSlot.Roof, item.x + ox, y + legH * 0.5, item.z + oz, 0.07 * s, legH * 0.5, 0.07 * s, uvScale, shadeTint(item.tint, 0.6), 0b101111);
      }
      builder.cylinder(MatSlot.Roof, item.x, y + legH, item.z, r, 1.5 * s, 10, uvScale, item.tint);
      break;
    }
    case 'bulkhead': {
      builder.box(MatSlot.Roof, item.x, y + 1.25 * s, item.z, 1.55 * s, 1.25 * s, 1.15 * s, uvScale, item.tint, 0b101111);
      builder.box(MatSlot.Roof, item.x, y + 2.56 * s, item.z, 1.65 * s, 0.06 * s, 1.25 * s, uvScale, shadeTint(item.tint, 1.1), 0b000010);
      break;
    }
    case 'mast': {
      const h = 5.5 * s;
      builder.box(MatSlot.Roof, item.x, y + h * 0.5, item.z, 0.09, h * 0.5, 0.09, uvScale, item.tint, 0b001101);
      for (let i = 1; i <= 3; i++) {
        const yy = y + (h * i) / 4;
        const len = 0.85 - i * 0.15;
        builder.box(MatSlot.Roof, item.x, yy, item.z, len, 0.035, 0.035, uvScale, item.tint, 0b111111);
      }
      break;
    }
    case 'vent': {
      builder.cylinder(MatSlot.Roof, item.x, y, item.z, 0.19 * s, 1.15 * s, 8, uvScale, item.tint);
      break;
    }
    case 'duct': {
      const len = 2.6 * s;
      const horizontal = Math.abs(Math.cos(item.rotation)) > 0.5;
      builder.box(
        MatSlot.Roof,
        item.x,
        y + 0.42 * s,
        item.z,
        horizontal ? len * 0.5 : 0.26 * s,
        0.26 * s,
        horizontal ? 0.26 * s : len * 0.5,
        uvScale,
        item.tint,
        0b101111
      );
      break;
    }
  }
}
