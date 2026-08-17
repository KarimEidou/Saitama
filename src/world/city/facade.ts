/**
 * FACADE PANEL KIT
 *
 * A building's skin is a ring of 2.4 m panels per floor, each drawn from a kit.
 * Panels are the unit of authorship (a zone says "60% window, 20% blank, 10%
 * balcony"), the unit of variety, and — grouped by floor and quadrant — the
 * unit of destruction.
 *
 * ── WHY 2.4 m ──────────────────────────────────────────────────────────────
 * It is roughly one structural bay of a Japanese mid-rise, it divides a
 * typical 12–24 m frontage into a whole number of bays, and at a 3.3 m storey
 * it gives a window aperture near 1.5 x 1.95 m — real proportions. Panel width
 * is nudged per edge so an edge always holds a whole number of panels; a
 * partial panel at a corner is the most obvious procedural tell there is.
 *
 * ── WHAT MAKES IT READ AS A CITY RATHER THAN BOXES ─────────────────────────
 * Three things, in order of impact:
 *   1. RECESSED openings. A window is not a dark quad on a wall, it is a hole
 *      with 14 cm of reveal, and the reveal's baked shading is what draws the
 *      shadow line that reads as depth at 60 m.
 *   2. A DIFFERENT GROUND FLOOR. Shopfronts, shutters, doors and awnings at
 *      street level, flats above. A building with the same panel top to bottom
 *      looks like a texture swatch.
 *   3. CLUTTER on the skin — air-conditioners, balcony parapets, fire-escape
 *      brackets, drainpipes, signage. It breaks the silhouette everywhere the
 *      eye lands.
 *
 * All shading is baked into the vertex colour, which costs three floats and
 * survives the block merge — a per-panel material would not.
 */

import type { IRandom } from '@/util';
import { MatSlot, type MeshBuilder } from './mesh-builder';
import { shadeTint } from './materials';

/** Panel archetypes in the kit. */
export type PanelKind =
  | 'window'
  | 'shopfront'
  | 'door'
  | 'blank'
  | 'balcony'
  | 'ac_unit'
  | 'fire_escape_anchor';

/** Every kind, in a stable order — weight tables index against this. */
export const PANEL_KINDS: readonly PanelKind[] = [
  'window',
  'shopfront',
  'door',
  'blank',
  'balcony',
  'ac_unit',
  'fire_escape_anchor',
];

/** Geometric detail level requested of the facade. */
export type FacadeDetail = 'full' | 'reduced';

/** A model that should be instanced onto the facade at this point. */
export interface IFacadeAttachment {
  readonly assetKey: string;
  /** World-space position, filled in by the building generator. */
  readonly position: readonly [number, number, number];
  readonly rotationY: number;
  readonly scale: number;
}

/** Everything a panel emitter needs. Reused across a whole facade ring. */
export interface IPanelContext {
  readonly builder: MeshBuilder;
  /** Bottom-left corner of the panel on the wall plane, in building-local space. */
  origin: [number, number, number];
  /** Unit vector along the wall, pointing to the panel's far edge. */
  right: [number, number, number];
  /** Outward unit normal of the wall. */
  normal: [number, number, number];
  width: number;
  height: number;
  /** Running distance along this facade edge in metres, for continuous UVs. */
  uStart: number;
  /** 1 / tileSizeMeters for each material slot. */
  facadeUv: number;
  glassUv: number;
  roofUv: number;
  /** Building base tint. */
  tint: readonly [number, number, number];
  /** Baked ambient factor for this floor — lower near the ground. */
  shade: number;
  /** Glass tint for this panel; warmer and brighter when lit. */
  glassTint: readonly [number, number, number];
  rng: IRandom;
  detail: FacadeDetail;
  /** Emitters push model overlays here; the caller transforms to world space. */
  attachments: IFacadeAttachment[];
  /** True on the lowest storey — enables shopfronts, doors and steps. */
  isGround: boolean;
  /** True on the topmost storey — suppresses balconies under the parapet. */
  isTop: boolean;
  /**
   * 0..1 chance a bay carries a projecting sign. High in a shotengai, near
   * zero in a housing block. Projecting signage is the single strongest
   * "this is a Japanese shopping street" cue there is, so it is a dial rather
   * than a constant.
   */
  signage: number;
}

/* -------------------------------------------------------------------------- */
/* Local frame helper                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Point on the panel: `u` metres along the wall, `v` metres up, `d` metres out
 * along the wall normal (negative goes into the building).
 */
function pt(
  c: IPanelContext,
  u: number,
  v: number,
  d: number
): [number, number, number] {
  return [
    c.origin[0] + c.right[0] * u + c.normal[0] * d,
    c.origin[1] + v,
    c.origin[2] + c.right[2] * u + c.normal[2] * d,
  ];
}

/** UV pair for a wall-plane point, in the facade material's tile units. */
function wallUv(
  c: IPanelContext,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  scale: number
): [number, number, number, number] {
  return [
    (c.uStart + u0) * scale,
    (c.origin[1] + v0) * scale,
    (c.uStart + u1) * scale,
    (c.origin[1] + v1) * scale,
  ];
}

/**
 * Emit a flat wall-plane quad at depth `d`, spanning u0..u1 by v0..v1.
 *
 * WINDING: the panel frame is (along-wall, up, outward), which is LEFT-handed
 * — `along x up` gives the INWARD normal. Every wall-plane quad therefore
 * winds from u1 to u0 so the face points out of the building. Getting this
 * wrong does not produce an obvious error, it produces a city you can see
 * straight through from outside, so it is centralised here and in
 * `boxAlongWall` rather than repeated at each call site.
 */
function wallQuad(
  c: IPanelContext,
  slot: number,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  d: number,
  shade: number,
  scale: number,
  tint = c.tint
): void {
  c.builder.quad(
    slot,
    pt(c, u1, v0, d),
    pt(c, u0, v0, d),
    pt(c, u0, v1, d),
    pt(c, u1, v1, d),
    wallUv(c, u0, v0, u1, v1, scale),
    shadeTint(tint, shade)
  );
}

/**
 * Emit the four faces of a rectangular reveal: the two jamb sides, the head
 * soffit and the sill top, sunk `depth` metres behind the wall plane.
 *
 * The shading gradient across these four faces (dark head, mid jambs, light
 * sill) is what makes a window read as a hole rather than a decal.
 */
function reveal(
  c: IPanelContext,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  depth: number
): void {
  const s = c.facadeUv;
  const b = c.builder;
  const shadeSide = c.shade * 0.5;
  const shadeHead = c.shade * 0.34;
  const shadeSill = c.shade * 0.78;

  // Left jamb — faces +u.
  b.quad(
    MatSlot.Facade,
    pt(c, u0, v0, -depth),
    pt(c, u0, v0, 0),
    pt(c, u0, v1, 0),
    pt(c, u0, v1, -depth),
    [0, c.origin[1] * s + v0 * s, depth * s, c.origin[1] * s + v1 * s],
    shadeTint(c.tint, shadeSide)
  );
  // Right jamb — faces -u.
  b.quad(
    MatSlot.Facade,
    pt(c, u1, v0, 0),
    pt(c, u1, v0, -depth),
    pt(c, u1, v1, -depth),
    pt(c, u1, v1, 0),
    [0, c.origin[1] * s + v0 * s, depth * s, c.origin[1] * s + v1 * s],
    shadeTint(c.tint, shadeSide)
  );
  // Head soffit — faces down.
  b.quad(
    MatSlot.Facade,
    pt(c, u0, v1, 0),
    pt(c, u1, v1, 0),
    pt(c, u1, v1, -depth),
    pt(c, u0, v1, -depth),
    [(c.uStart + u0) * s, 0, (c.uStart + u1) * s, depth * s],
    shadeTint(c.tint, shadeHead)
  );
  // Sill — faces up.
  b.quad(
    MatSlot.Facade,
    pt(c, u0, v0, -depth),
    pt(c, u1, v0, -depth),
    pt(c, u1, v0, 0),
    pt(c, u0, v0, 0),
    [(c.uStart + u0) * s, 0, (c.uStart + u1) * s, depth * s],
    shadeTint(c.tint, shadeSill)
  );
}

/* -------------------------------------------------------------------------- */
/* Panel emitters                                                             */
/* -------------------------------------------------------------------------- */

const REVEAL_DEPTH = 0.14;

/** Solid wall, with an occasional drainpipe or vent to break the flatness. */
export function emitBlank(c: IPanelContext): void {
  wallQuad(c, MatSlot.Facade, 0, 0, c.width, c.height, 0, c.shade, c.facadeUv);
  c.builder.addVolume(c.width * c.height * 0.22);

  if (c.detail === 'full' && c.rng.bool(0.16)) {
    // Downpipe hugging the wall: two narrow boxes read as a pipe at any range.
    const u = c.rng.range(0.25, c.width - 0.25);
    const p = pt(c, u, c.height * 0.5, 0.07);
    c.builder.box(
      MatSlot.Facade,
      p[0],
      p[1],
      p[2],
      0.07,
      c.height * 0.5,
      0.07,
      c.roofUv,
      shadeTint([0.42, 0.4, 0.38], c.shade),
      0b101111
    );
  }
}

/** The workhorse: a recessed opening with glazing. */
export function emitWindow(c: IPanelContext): void {
  const margin = Math.min(0.5, c.width * 0.21);
  const sill = c.isGround ? 1.05 : 0.92;
  const head = c.height - Math.min(0.55, c.height * 0.16);
  const u0 = margin;
  const u1 = c.width - margin;

  // Wall around the opening.
  wallQuad(c, MatSlot.Facade, 0, 0, c.width, sill, 0, c.shade, c.facadeUv);
  wallQuad(c, MatSlot.Facade, 0, head, c.width, c.height, 0, c.shade, c.facadeUv);
  wallQuad(c, MatSlot.Facade, 0, sill, u0, head, 0, c.shade, c.facadeUv);
  wallQuad(c, MatSlot.Facade, u1, sill, c.width, head, 0, c.shade, c.facadeUv);

  if (c.detail === 'full') {
    reveal(c, u0, sill, u1, head, REVEAL_DEPTH);
    // Projecting sill: a 7 cm ledge that catches the sun and throws a line.
    boxAlongWall(
      c,
      MatSlot.Facade,
      (u0 + u1) * 0.5,
      sill - 0.03,
      0.05,
      (u1 - u0) * 0.5 + 0.09,
      0.035,
      0.05,
      shadeTint(c.tint, c.shade * 0.95)
    );
  }

  if (c.detail === 'full') {
    // Frame. Four flat plates around the opening rather than four boxes: a
    // window is the most repeated element in the city, and boxes here would
    // cost more triangles than every roof in the district put together.
    const frame: readonly [number, number, number] = [0.86, 0.85, 0.82];
    const t = 0.075;
    wallQuad(c, MatSlot.Facade, u0, sill, u1, sill + t, -REVEAL_DEPTH + 0.012, c.shade * 0.9, c.facadeUv, frame);
    wallQuad(c, MatSlot.Facade, u0, head - t, u1, head, -REVEAL_DEPTH + 0.012, c.shade * 0.72, c.facadeUv, frame);
    wallQuad(c, MatSlot.Facade, u0, sill, u0 + t, head, -REVEAL_DEPTH + 0.012, c.shade * 0.82, c.facadeUv, frame);
    wallQuad(c, MatSlot.Facade, u1 - t, sill, u1, head, -REVEAL_DEPTH + 0.012, c.shade * 0.82, c.facadeUv, frame);
  }

  // Glazing, sunk behind the reveal.
  const glassDepth = c.detail === 'full' ? REVEAL_DEPTH : 0.04;
  wallQuad(
    c,
    MatSlot.Glass,
    u0,
    sill,
    u1,
    head,
    -glassDepth,
    1,
    c.glassUv,
    c.glassTint
  );
  // Mullion: one vertical bar splits the light and reads as a real window.
  if (c.detail === 'full' && u1 - u0 > 1.1) {
    boxAlongWall(
      c,
      MatSlot.Facade,
      (u0 + u1) * 0.5,
      (sill + head) * 0.5,
      -glassDepth + 0.03,
      0.035,
      (head - sill) * 0.5,
      0.035,
      shadeTint(c.tint, c.shade * 0.6)
    );
  }
  if (c.detail === 'full' && !c.isTop && c.rng.bool(c.signage * 0.2)) {
    emitProjectingSign(c, c.height - 0.35);
  }
  c.builder.addVolume(c.width * c.height * 0.2);
}

/** Ground-floor retail: stall riser, deep glazing, signboard, awning. */
export function emitShopfront(c: IPanelContext): void {
  const riser = 0.34;
  const signTop = c.height - 0.18;
  const signBottom = c.height - 0.95;
  const glassTop = signBottom - 0.08;
  const inset = c.detail === 'full' ? 0.3 : 0.05;
  const margin = 0.16;

  wallQuad(c, MatSlot.Facade, 0, 0, c.width, riser, 0, c.shade * 0.85, c.facadeUv);
  wallQuad(c, MatSlot.Facade, 0, signTop, c.width, c.height, 0, c.shade, c.facadeUv);
  wallQuad(c, MatSlot.Facade, 0, riser, margin, signBottom, 0, c.shade, c.facadeUv);
  wallQuad(
    c,
    MatSlot.Facade,
    c.width - margin,
    riser,
    c.width,
    signBottom,
    0,
    c.shade,
    c.facadeUv
  );

  if (c.detail === 'full') {
    reveal(c, margin, riser, c.width - margin, glassTop, inset);
    // Dark shop interior behind the glass so the window is not a mirror of sky.
    wallQuad(
      c,
      MatSlot.Facade,
      margin,
      riser,
      c.width - margin,
      glassTop,
      -inset - 0.02,
      c.shade * 0.16,
      c.facadeUv
    );
  }

  // Glazing. Much darker than a residential window: a shopfront is a hole you
  // look INTO, and at the sky-reflection brightness of an upper-storey window
  // it reads as a blank panel instead.
  wallQuad(
    c,
    MatSlot.Glass,
    margin,
    riser,
    c.width - margin,
    glassTop,
    -inset,
    1,
    c.glassUv,
    shadeTint(c.glassTint, 0.38)
  );

  // Signboard: lives in the emissive slot so shop signs glow at dusk.
  const signTint = SIGN_TINTS[c.rng.int(0, SIGN_TINTS.length - 1)];
  c.builder.quad(
    MatSlot.Glass,
    pt(c, c.width - 0.05, signBottom, 0.06),
    pt(c, 0.05, signBottom, 0.06),
    pt(c, 0.05, signTop, 0.06),
    pt(c, c.width - 0.05, signTop, 0.06),
    [0.5, 0.5, 0.502, 0.502],
    signTint
  );
  if (c.detail === 'full') emitFasciaLettering(c, signBottom, signTop, signTint);
  // Sign body, so it has thickness rather than floating on the wall.
  boxAlongWall(
    c,
    MatSlot.Facade,
    c.width * 0.5,
    (signBottom + signTop) * 0.5,
    0.03,
    c.width * 0.5 - 0.05,
    (signTop - signBottom) * 0.5,
    0.03,
    shadeTint(c.tint, c.shade * 0.7)
  );

  if (c.detail === 'full' && c.rng.bool(0.55)) {
    emitAwning(c, riser, signBottom);
  }
  if (c.detail === 'full' && c.rng.bool(c.signage)) {
    emitProjectingSign(c, c.height - 0.5);
  }
  c.builder.addVolume(c.width * c.height * 0.25);
}

/**
 * A sign board cantilevered out perpendicular to the wall, WITH CONTENT.
 *
 * ── WHY THE BOARD IS NOT A COLOURED QUAD ───────────────────────────────────
 * A shotengai is defined by its signage, and there are dozens of boards at eye
 * height in any street-level frame — which makes them the first thing that
 * reads as placeholder if they are flat rectangles of colour. The fix is not a
 * texture: signage shares the emissive slot with every window in the block, so
 * a per-sign texture would cost a per-sign material and blow the three-slot
 * budget that holds a block to three draw calls.
 *
 * The fix is GEOMETRY. Each board gets a frame, a face plate proud of it, and
 * rows — or, on a banner, a column — of small blocks standing in for glyphs,
 * all carried in vertex colour. Real signage IS flat blocks of colour on a
 * panel, so jittered rectangles at a few millimetres of relief read as
 * lettering from any distance a player stands at, and they merge into the same
 * three draw calls as the wall behind them.
 *
 * Two forms, because a real shopping street has both: a wide horizontal board
 * with one or two lines, and the tall narrow banner hanging down the face with
 * a single vertical column of characters.
 */
function emitProjectingSign(c: IPanelContext, v: number): void {
  const face = SIGN_TINTS[c.rng.int(0, SIGN_TINTS.length - 1)];
  const vertical = c.rng.bool(0.42);
  const reach = vertical ? c.rng.range(0.42, 0.62) : c.rng.range(0.75, 1.15);
  const height = vertical ? c.rng.range(1.5, 2.4) : c.rng.range(0.55, 0.85);
  const u = c.rng.range(0.35, Math.max(0.4, c.width - 0.35));
  const centre = v - height * 0.5;
  if (centre - height * 0.5 < 0.35) return;

  const d0 = 0.09;
  const d1 = d0 + reach;
  const v0 = centre - height * 0.5;
  const v1 = centre + height * 0.5;
  const half = 0.035;

  // Bracket back to the wall, plus a fixing plate against it.
  boxAlongWall(
    c,
    MatSlot.Facade,
    u,
    v1 - 0.05,
    (d0 + d1) * 0.5,
    0.02,
    0.02,
    reach * 0.5,
    [0.3, 0.29, 0.28]
  );
  boxAlongWall(c, MatSlot.Facade, u, centre, d0 * 0.5, 0.05, height * 0.42, d0 * 0.5, [
    0.34, 0.33, 0.32,
  ]);

  // Board body in the opaque slot; the face plates stand proud of it so the
  // border reads as a frame rather than as a painted edge.
  boxAlongWall(c, MatSlot.Facade, u, centre, (d0 + d1) * 0.5, half, height * 0.5, reach * 0.5, [
    0.24, 0.23, 0.22,
  ]);

  const border = 0.055;
  for (const side of [1, -1] as const) {
    const uf = u + side * (half + 0.004);
    signFace(c, MatSlot.Glass, uf, d0 + border, d1 - border, v0 + border, v1 - border, side, face);
    emitGlyphs(c, uf + side * 0.005, d0 + border, d1 - border, v0 + border, v1 - border, side, face, vertical);
  }
  c.builder.addVolume(reach * height * 0.06);
}

/**
 * A quad in the (outward, up) plane at a fixed distance along the wall.
 *
 * `outward` is +1 for a face whose normal points along +u and -1 for -u. The
 * winding differs between them, and getting it wrong makes every sign in the
 * district invisible from one side of the street.
 */
function signFace(
  c: IPanelContext,
  slot: number,
  u: number,
  dLow: number,
  dHigh: number,
  v0: number,
  v1: number,
  outward: 1 | -1,
  color: readonly [number, number, number]
): void {
  // A sign shares the glazing material, and the glazing texture has pane
  // divisions in it. Sampling a whole tile would print window panes onto every
  // shop board — which is precisely why the boards read as little windows
  // before this. Collapsing the UVs onto a single texel makes the board a flat
  // surface whose colour comes from the vertex tint, and the lettering from the
  // glyph blocks standing proud of it.
  const uv: [number, number, number, number] = [0.5, 0.5, 0.502, 0.502];
  if (outward > 0) {
    c.builder.quad(
      slot,
      pt(c, u, v0, dLow),
      pt(c, u, v0, dHigh),
      pt(c, u, v1, dHigh),
      pt(c, u, v1, dLow),
      uv,
      color
    );
  } else {
    c.builder.quad(
      slot,
      pt(c, u, v0, dHigh),
      pt(c, u, v0, dLow),
      pt(c, u, v1, dLow),
      pt(c, u, v1, dHigh),
      uv,
      color
    );
  }
}

/**
 * Rows — or, on a banner, a column — of small blocks standing in for lettering.
 *
 * Deliberately irregular: real signage has words of different lengths, a large
 * headline and smaller lines under it. An even grid reads as a checkerboard,
 * which is worse than no glyphs at all.
 */
function emitGlyphs(
  c: IPanelContext,
  u: number,
  dLow: number,
  dHigh: number,
  v0: number,
  v1: number,
  outward: 1 | -1,
  face: readonly [number, number, number],
  vertical: boolean
): void {
  // Ink either much darker or much lighter than the board, whichever gives
  // more contrast: the one property that has to survive at distance is that
  // the marks are legible AS marks.
  const luma = face[0] * 0.299 + face[1] * 0.587 + face[2] * 0.114;
  const ink: readonly [number, number, number] =
    luma > 0.5 ? [0.09, 0.08, 0.09] : [0.95, 0.94, 0.9];

  const width = dHigh - dLow;
  const height = v1 - v0;

  if (vertical) {
    const count = c.rng.int(3, 6);
    const cell = height / count;
    const size = Math.min(cell * 0.58, width * 0.62);
    for (let i = 0; i < count; i++) {
      emitGlyphBlock(c, u, (dLow + dHigh) * 0.5, v1 - cell * (i + 0.5), size, size, outward, ink);
    }
    return;
  }

  const lines = c.rng.bool(0.45) ? 2 : 1;
  let cursorV = v1;
  for (let line = 0; line < lines; line++) {
    const lineH = height * (lines === 1 ? 0.52 : line === 0 ? 0.4 : 0.22);
    const cy = cursorV - lineH * 0.5 - height * 0.07;
    cursorV -= lineH + height * 0.12;
    const count = c.rng.int(3, 5);
    const pad = width * 0.07;
    const span = width - pad * 2;
    let x = dLow + pad;
    for (let i = 0; i < count; i++) {
      const w = (span / count) * c.rng.range(0.5, 0.9);
      emitGlyphBlock(c, u, x + w * 0.5, cy, w, lineH * 0.8, outward, ink);
      x += span / count;
    }
  }
}

/**
 * One character: two to four strokes inside its cell, not a solid block.
 *
 * A filled rectangle reads as a pixel; a few bars inside a square read as a
 * character. That distinction is the whole difference between signage and
 * confetti at the distance a player stands from a shop front, and it costs a
 * handful of quads on the few dozen boards actually in frame.
 */
function emitGlyphBlock(
  c: IPanelContext,
  u: number,
  d: number,
  v: number,
  w: number,
  h: number,
  outward: 1 | -1,
  ink: readonly [number, number, number]
): void {
  // Thin strokes: at 19% of the cell the ink averaged out to the board's
  // colour at street distance and every sign went pale. Lettering has to read
  // as marks ON a coloured board, not as a second colour.
  const stroke = Math.max(0.011, Math.min(w, h) * 0.12);
  const bars = c.rng.int(2, 3);
  // Horizontal strokes, spread down the cell.
  for (let i = 0; i < bars; i++) {
    const t = bars === 1 ? 0.5 : i / (bars - 1);
    const cy = v - h * 0.5 + stroke * 0.5 + t * (h - stroke);
    const inset = c.rng.range(0, w * 0.18);
    emitStroke(c, u, d - w * 0.5 + inset, d + w * 0.5 - inset, cy - stroke * 0.5, cy + stroke * 0.5, outward, ink);
  }
  // One or two vertical strokes crossing them.
  const uprights = 1;
  for (let i = 0; i < uprights; i++) {
    const t = uprights === 1 ? 0.5 : 0.28 + i * 0.44;
    const cx = d - w * 0.5 + t * w;
    emitStroke(c, u, cx - stroke * 0.5, cx + stroke * 0.5, v - h * 0.5, v + h * 0.5, outward, ink);
  }
}

/** A single stroke of a character. */
function emitStroke(
  c: IPanelContext,
  u: number,
  dLow: number,
  dHigh: number,
  v0: number,
  v1: number,
  outward: 1 | -1,
  ink: readonly [number, number, number]
): void {
  signFace(c, MatSlot.Glass, u, dLow, dHigh, v0, v1, outward, ink);
}

/** A flat-coloured quad on the wall plane, sampling a single texel. */
function wallFlat(
  c: IPanelContext,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  d: number,
  color: readonly [number, number, number]
): void {
  c.builder.quad(
    MatSlot.Glass,
    pt(c, u1, v0, d),
    pt(c, u0, v0, d),
    pt(c, u0, v1, d),
    pt(c, u1, v1, d),
    [0.5, 0.5, 0.502, 0.502],
    color
  );
}

/**
 * Lettering across the fascia board above a shopfront.
 *
 * Same reasoning as the projecting boards, applied to the flat band: without
 * marks on it, a shop fascia is a stripe of colour, and a street of stripes is
 * the single loudest placeholder signal at eye height.
 */
function emitFasciaLettering(
  c: IPanelContext,
  v0: number,
  v1: number,
  board: readonly [number, number, number]
): void {
  const luma = board[0] * 0.299 + board[1] * 0.587 + board[2] * 0.114;
  const ink: readonly [number, number, number] =
    luma > 0.5 ? [0.1, 0.09, 0.1] : [0.96, 0.95, 0.92];
  const height = (v1 - v0) * 0.48;
  const cy = (v0 + v1) * 0.5;
  const count = c.rng.int(3, 6);
  const pad = c.width * 0.12;
  const span = c.width - pad * 2;
  let x = pad;
  for (let i = 0; i < count; i++) {
    const w = (span / count) * c.rng.range(0.5, 0.88);
    // Strokes rather than a filled block, and flat colour rather than the
    // glazing texture: this is paint on a board.
    const left = x + (span / count - w) * 0.5;
    const stroke = Math.max(0.012, Math.min(w, height) * 0.13);
    const bars = c.rng.int(2, 3);
    for (let b = 0; b < bars; b++) {
      const t = bars === 1 ? 0.5 : b / (bars - 1);
      const by = cy - height * 0.5 + stroke * 0.5 + t * (height - stroke);
      wallFlat(c, left, by - stroke * 0.5, left + w, by + stroke * 0.5, 0.075, ink);
    }
    const midX = left + w * 0.5;
    wallFlat(c, midX - stroke * 0.5, cy - height * 0.5, midX + stroke * 0.5, cy + height * 0.5, 0.075, ink);
    x += span / count;
  }
}


/** Fabric awning over a shopfront, sloping down and out. */
function emitAwning(c: IPanelContext, _riser: number, signBottom: number): void {
  const depth = c.rng.range(0.8, 1.25);
  const drop = 0.42;
  const yTop = signBottom - 0.12;
  const tint = AWNING_TINTS[c.rng.int(0, AWNING_TINTS.length - 1)];
  const shaded = shadeTint(tint, c.shade);
  const u0 = 0.06;
  const u1 = c.width - 0.06;
  const b = c.builder;
  // Sloping top surface.
  b.quad(
    MatSlot.Facade,
    pt(c, u0, yTop, 0),
    pt(c, u1, yTop, 0),
    pt(c, u1, yTop - drop, depth),
    pt(c, u0, yTop - drop, depth),
    [0, 0, (u1 - u0) * c.facadeUv, depth * c.facadeUv],
    shaded
  );
  // Valance hanging off the leading edge.
  b.quad(
    MatSlot.Facade,
    pt(c, u1, yTop - drop - 0.22, depth),
    pt(c, u0, yTop - drop - 0.22, depth),
    pt(c, u0, yTop - drop, depth),
    pt(c, u1, yTop - drop, depth),
    [0, 0, (u1 - u0) * c.facadeUv, 0.22 * c.facadeUv],
    shadeTint(tint, c.shade * 0.85)
  );
  // Underside, darker.
  b.quad(
    MatSlot.Facade,
    pt(c, u1, yTop, 0),
    pt(c, u0, yTop, 0),
    pt(c, u0, yTop - drop, depth),
    pt(c, u1, yTop - drop, depth),
    [0, 0, (u1 - u0) * c.facadeUv, depth * c.facadeUv],
    shadeTint(tint, c.shade * 0.4)
  );
}

/** Entrance: recessed leaf, lintel, and a step out onto the pavement. */
export function emitDoor(c: IPanelContext): void {
  const margin = Math.max(0.32, (c.width - 1.35) * 0.5);
  const head = Math.min(c.height - 0.6, 2.25);
  const u0 = margin;
  const u1 = c.width - margin;

  wallQuad(c, MatSlot.Facade, 0, head, c.width, c.height, 0, c.shade, c.facadeUv);
  wallQuad(c, MatSlot.Facade, 0, 0, u0, head, 0, c.shade, c.facadeUv);
  wallQuad(c, MatSlot.Facade, u1, 0, c.width, head, 0, c.shade, c.facadeUv);

  const depth = c.detail === 'full' ? 0.22 : 0.05;
  if (c.detail === 'full') {
    reveal(c, u0, 0, u1, head, depth);
  }
  // Door leaf, dark and slightly warm.
  wallQuad(
    c,
    MatSlot.Facade,
    u0,
    0,
    u1,
    head,
    -depth,
    c.shade * 0.34,
    c.facadeUv,
    [0.36, 0.3, 0.26]
  );
  // Transom light above the leaf.
  wallQuad(
    c,
    MatSlot.Glass,
    u0 + 0.06,
    head - 0.42,
    u1 - 0.06,
    head - 0.08,
    -depth + 0.02,
    1,
    c.glassUv,
    c.glassTint
  );
  if (c.detail === 'full') {
    boxAlongWall(
      c,
      MatSlot.Facade,
      (u0 + u1) * 0.5,
      0.06,
      0.16,
      (u1 - u0) * 0.5 + 0.12,
      0.06,
      0.2,
      shadeTint(c.tint, c.shade * 0.8)
    );
  }
  c.builder.addVolume(c.width * c.height * 0.18);
}

/** Window plus a projecting slab and solid parapet — the danchi balcony. */
export function emitBalcony(c: IPanelContext): void {
  emitWindow(c);
  if (c.detail !== 'full') return;

  const depth = c.rng.range(0.95, 1.35);
  const railHeight = 1.06;
  const slabThickness = 0.14;
  const tint = shadeTint(c.tint, c.shade * 0.9);

  // Slab. Facade slot, not roof: a balcony is cast concrete continuous with
  // the wall, and putting it in the roof slot paints it with flat black
  // bitumen — which is exactly what it looked like before this was fixed.
  boxAlongWall(
    c,
    MatSlot.Facade,
    c.width * 0.5,
    slabThickness * 0.5,
    depth * 0.5,
    c.width * 0.5,
    slabThickness * 0.5,
    depth * 0.5,
    tint
  );
  // Front parapet.
  boxAlongWall(
    c,
    MatSlot.Facade,
    c.width * 0.5,
    slabThickness + railHeight * 0.5,
    depth - 0.05,
    c.width * 0.5,
    railHeight * 0.5,
    0.05,
    shadeTint(c.tint, c.shade * 0.82)
  );
  // Side parapets.
  for (const u of [0.05, c.width - 0.05]) {
    boxAlongWall(
      c,
      MatSlot.Facade,
      u,
      slabThickness + railHeight * 0.5,
      depth * 0.5,
      0.05,
      railHeight * 0.5,
      depth * 0.5,
      shadeTint(c.tint, c.shade * 0.76)
    );
  }
  // Something on the balcony half the time: a rail of laundry poles.
  if (c.rng.bool(0.5)) {
    boxAlongWall(
      c,
      MatSlot.Facade,
      c.width * 0.5,
      slabThickness + railHeight + 0.28,
      depth * 0.55,
      c.width * 0.42,
      0.025,
      0.025,
      [0.72, 0.72, 0.7]
    );
  }
  c.builder.addVolume(c.width * depth * 0.1);
}

/** Wall with a split-unit air conditioner on brackets. */
export function emitAcUnit(c: IPanelContext): void {
  emitBlank(c);
  if (c.detail !== 'full') return;

  const v = c.rng.range(0.9, Math.max(1.1, c.height - 1.5));
  const u = c.rng.range(0.5, Math.max(0.6, c.width - 0.5));
  const shell: [number, number, number] = [0.92, 0.91, 0.87];
  boxAlongWall(c, MatSlot.Facade, u, v + 0.22, 0.28, 0.34, 0.22, 0.16, shadeTint(shell, c.shade));
  // Bracket.
  boxAlongWall(
    c,
    MatSlot.Facade,
    u,
    v - 0.03,
    0.16,
    0.32,
    0.025,
    0.14,
    shadeTint([0.5, 0.49, 0.47], c.shade)
  );
  // Grille face, a shade darker so the unit is not a featureless white brick.
  boxAlongWall(
    c,
    MatSlot.Facade,
    u,
    v + 0.22,
    0.45,
    0.24,
    0.15,
    0.01,
    shadeTint([0.6, 0.6, 0.58], c.shade)
  );
  c.builder.addVolume(0.1);
}

/**
 * Window plus the steel landing a fire escape hangs from, and an attachment
 * request for the modular fire-escape model so hero buildings get the real
 * Poly Haven kit piece over the procedural bracket.
 */
export function emitFireEscapeAnchor(c: IPanelContext): void {
  emitWindow(c);
  if (c.detail !== 'full') return;

  const steel: [number, number, number] = [0.32, 0.26, 0.22];
  const depth = 1.15;
  // Landing.
  boxAlongWall(
    c,
    MatSlot.Roof,
    c.width * 0.5,
    0.08,
    depth * 0.5,
    c.width * 0.46,
    0.04,
    depth * 0.5,
    shadeTint(steel, c.shade)
  );
  // Handrails.
  for (const h of [0.5, 0.98]) {
    boxAlongWall(
      c,
      MatSlot.Roof,
      c.width * 0.5,
      h,
      depth - 0.04,
      c.width * 0.46,
      0.03,
      0.03,
      shadeTint(steel, c.shade)
    );
  }
  for (const u of [0.1, c.width * 0.5, c.width - 0.1]) {
    boxAlongWall(c, MatSlot.Roof, u, 0.53, depth - 0.04, 0.03, 0.5, 0.03, shadeTint(steel, c.shade));
  }
  const anchor = pt(c, c.width * 0.5, 0, depth * 0.5);
  c.attachments.push({
    assetKey: 'model.building.modular_fire_escape',
    position: anchor,
    rotationY: Math.atan2(c.normal[0], c.normal[2]),
    scale: 1,
  });
  c.builder.addVolume(0.4);
}

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                   */
/* -------------------------------------------------------------------------- */

/** Emit one panel of the requested kind. */
export function emitPanel(kind: PanelKind, c: IPanelContext): void {
  switch (kind) {
    case 'window':
      emitWindow(c);
      return;
    case 'shopfront':
      emitShopfront(c);
      return;
    case 'door':
      emitDoor(c);
      return;
    case 'balcony':
      emitBalcony(c);
      return;
    case 'ac_unit':
      emitAcUnit(c);
      return;
    case 'fire_escape_anchor':
      emitFireEscapeAnchor(c);
      return;
    case 'blank':
      emitBlank(c);
      return;
  }
}

/**
 * Structural weight of a panel, 0..1 — how much of the floor's load this bay
 * carries. Openings carry less than solid wall, which is what makes a
 * shopfront-heavy ground floor the first thing to fail under a punch.
 */
export function panelSupport(kind: PanelKind): number {
  switch (kind) {
    case 'blank':
      return 1;
    case 'ac_unit':
      return 1;
    case 'window':
      return 0.62;
    case 'balcony':
      return 0.58;
    case 'fire_escape_anchor':
      return 0.55;
    case 'door':
      return 0.4;
    case 'shopfront':
      return 0.22;
  }
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Emit a box in the panel's local frame: centred at (`u`, `v`, `d`) with
 * half-extents along the wall / vertical / outward axes.
 *
 * Facades are not axis-aligned, so this rotates the box into the wall frame
 * by hand rather than going through `MeshBuilder.box`, which is world-aligned.
 */
function boxAlongWall(
  c: IPanelContext,
  slot: number,
  u: number,
  v: number,
  d: number,
  hu: number,
  hv: number,
  hd: number,
  color: readonly [number, number, number]
): void {
  const b = c.builder;
  const s = c.facadeUv;
  const corner = (du: number, dv: number, dd: number) => pt(c, u + du, v + dv, d + dd);

  // Outward face. Winding runs +u -> -u for the same left-handed-frame reason
  // documented on `wallQuad`.
  b.quad(
    slot,
    corner(hu, -hv, hd),
    corner(-hu, -hv, hd),
    corner(-hu, hv, hd),
    corner(hu, hv, hd),
    [0, 0, hu * 2 * s, hv * 2 * s],
    color
  );
  // Top.
  b.quad(
    slot,
    corner(hu, hv, hd),
    corner(-hu, hv, hd),
    corner(-hu, hv, -hd),
    corner(hu, hv, -hd),
    [0, 0, hu * 2 * s, hd * 2 * s],
    color
  );
  // Bottom, darker.
  b.quad(
    slot,
    corner(hu, -hv, -hd),
    corner(-hu, -hv, -hd),
    corner(-hu, -hv, hd),
    corner(hu, -hv, hd),
    [0, 0, hu * 2 * s, hd * 2 * s],
    shadeTint(color, 0.45)
  );
  // Sides.
  b.quad(
    slot,
    corner(hu, -hv, -hd),
    corner(hu, -hv, hd),
    corner(hu, hv, hd),
    corner(hu, hv, -hd),
    [0, 0, hd * 2 * s, hv * 2 * s],
    shadeTint(color, 0.72)
  );
  b.quad(
    slot,
    corner(-hu, -hv, hd),
    corner(-hu, -hv, -hd),
    corner(-hu, hv, -hd),
    corner(-hu, hv, hd),
    [0, 0, hd * 2 * s, hv * 2 * s],
    shadeTint(color, 0.72)
  );
}

/** Shop signage colours — saturated, the way a shotengai actually looks. */
const SIGN_TINTS: readonly (readonly [number, number, number])[] = [
  [0.92, 0.18, 0.16],
  [0.95, 0.62, 0.1],
  [0.14, 0.42, 0.86],
  [0.95, 0.9, 0.25],
  [0.1, 0.62, 0.42],
  [0.9, 0.35, 0.6],
  [0.96, 0.95, 0.92],
];

/** Awning fabric colours. */
const AWNING_TINTS: readonly (readonly [number, number, number])[] = [
  [0.72, 0.16, 0.14],
  [0.16, 0.32, 0.6],
  [0.2, 0.42, 0.28],
  [0.78, 0.72, 0.58],
  [0.55, 0.5, 0.46],
];
