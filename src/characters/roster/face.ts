/**
 * FACES
 *
 * A face on a 3.5k-triangle character is PAINTED, never modelled. The mesh
 * generator knows this and published exactly where the face lands —
 * `HEAD_LANDMARK_V`, `FACE_CENTER_U`, `faceOffsetU` — so this file can place
 * eyes, brows and a mouth on the right texels of any head, at any scale,
 * without a single magic number tied to one character's proportions.
 *
 * ── WHY VECTORS, AND WHY A SEPARATE STRIP ─────────────────────────────────
 * Face art is emitted as SVG. Two reasons, both practical:
 *
 *   1. The same description rasterises offline through `sharp` at whatever
 *      resolution the atlas patch happens to be, and stays crisp — a face is
 *      the one place on a character where a texel is worth ten elsewhere.
 *   2. The atlas gives the face a rectangle of roughly 300x130 texels at 1024.
 *      That is not enough for an eye. So the four expressions are ALSO baked
 *      into a small dedicated strip texture at full resolution, stacked
 *      vertically, and the character material samples the strip over the
 *      atlas inside the face rectangle. One extra sampler, no extra draw call,
 *      no extra material, and swapping expression is a uniform write.
 *
 * ── ANISOTROPY, HANDLED ONCE ──────────────────────────────────────────────
 * The atlas rectangle is roughly twice as dense across the face as up it, so a
 * circle drawn in atlas space would arrive as an ellipse. Every coordinate here
 * is therefore authored in METRES ACROSS and METRES UP the face, and the tile
 * is sized to that aspect. Draw a circle, get a circle.
 *
 * ── SAITAMA ───────────────────────────────────────────────────────────────
 * The blank stare is the joke and it is load-bearing. Two small flat ovals, no
 * brows, a short straight mouth, and a lot of empty head. `bored` narrows the
 * eyes further, drops a heavy upper lid and flattens the mouth to a dash —
 * that is the expression the Boredom gameplay state swaps to.
 */

import { FACE_CENTER_U, HEAD_LANDMARK_V, faceOffsetU, faceUV } from '@/characters/mesh';
import { clamp01 } from '@/util';
import type { Expression, FaceRect, FaceStyle } from './types';
import type { HeadMetrics } from './geometry';

/** Width of one expression tile in the strip texture, in pixels. */
export const FACE_TILE_WIDTH = 448;

/** Which layer of the face is being drawn. */
export type FaceLayer = 'albedo' | 'orm' | 'emissive';

/* -------------------------------------------------------------------------- */
/* Region                                                                     */
/* -------------------------------------------------------------------------- */

/** Where a face lives, in every coordinate system that matters. */
export interface FaceRegion {
  /** Ring parameter bounds of the patch. */
  readonly uMin: number;
  readonly uMax: number;
  /** Strand-local v bounds of the patch. */
  readonly vMin: number;
  readonly vMax: number;
  /** Patch width across the face, in metres. */
  readonly metricWidth: number;
  /** Patch height up the face, in metres. */
  readonly metricHeight: number;
  /** Metres of head per unit of strand-local v. */
  readonly metresPerV: number;
  /** Tile size for the strip texture. */
  readonly tileWidth: number;
  readonly tileHeight: number;
  /** The patch's rectangle in ATLAS uv. */
  readonly atlas: FaceRect;
  readonly headHalfWidth: number;
}

/**
 * Resolve the patch a face occupies.
 *
 * The bounds are the union over all four expressions — `surprised` raises the
 * brows and `bored` drops the lids — because the strip's tiles must be
 * interchangeable, which means they must share one rectangle.
 */
export function faceRegion(style: FaceStyle, head: HeadMetrics): FaceRegion {
  const metresPerV = head.height / (HEAD_LANDMARK_V.crown - HEAD_LANDMARK_V.chin);

  const halfMetres = Math.max(
    style.eyeSpread + style.eyeWidth * 2.1,
    style.mouthWidth * 1.7,
    head.halfWidth * 0.78
  );
  const uSpan = faceOffsetU(halfMetres, head.halfWidth);
  const uMin = FACE_CENTER_U - uSpan;
  const uMax = FACE_CENTER_U + uSpan;

  const topMetres = Math.max(style.eyeHeight * 2.4, 0.045);
  const vMax = Math.min(style.browV + topMetres / metresPerV, HEAD_LANDMARK_V.skull);
  const vMin = Math.max(style.mouthV - 0.055, HEAD_LANDMARK_V.jaw - 0.02);

  const metricWidth = halfMetres * 2;
  const metricHeight = (vMax - vMin) * metresPerV;

  const tileWidth = FACE_TILE_WIDTH;
  const tileHeight = Math.max(2, Math.round((tileWidth * metricHeight) / metricWidth / 2) * 2);

  const [au0, av0] = faceUV(uMin, vMin);
  const [au1, av1] = faceUV(uMax, vMax);

  return {
    uMin,
    uMax,
    vMin,
    vMax,
    metricWidth,
    metricHeight,
    metresPerV,
    tileWidth,
    tileHeight,
    atlas: { u0: au0, v0: av0, u1: au1, v1: av1 },
    headHalfWidth: head.halfWidth,
  };
}

/* -------------------------------------------------------------------------- */
/* Expression modifiers                                                       */
/* -------------------------------------------------------------------------- */

interface Mood {
  /** Vertical scale on the eye opening. */
  readonly eyeScaleY: number;
  /** Horizontal scale on the eye opening. */
  readonly eyeScaleX: number;
  /** Fraction of the eye covered by the upper lid, 0..1. */
  readonly lid: number;
  /** Brow lift in metres; negative lowers. */
  readonly browRaise: number;
  /** Brow inner-end tilt in metres; negative = angry. */
  readonly browTilt: number;
  /** Mouth width multiplier. */
  readonly mouthScale: number;
  /** Mouth corner curve in metres; negative frowns. */
  readonly mouthCurve: number;
  /** Mouth opening height in metres. */
  readonly mouthOpen: number;
  /** Pupil size multiplier. */
  readonly pupilScale: number;
  /** Extra shadow under the eyes, 0..1. */
  readonly hollow: number;
}

const MOODS: Readonly<Record<Expression, Mood>> = {
  neutral: {
    eyeScaleY: 1,
    eyeScaleX: 1,
    lid: 0.14,
    browRaise: 0,
    browTilt: 0,
    mouthScale: 1,
    mouthCurve: 0,
    mouthOpen: 0,
    pupilScale: 1,
    hollow: 0,
  },
  // The vacancy. Lids fall, the eye flattens into a slot, the mouth loses its
  // corners entirely, and a faint hollow appears under each eye.
  bored: {
    eyeScaleY: 0.54,
    eyeScaleX: 0.98,
    lid: 0.46,
    browRaise: -0.006,
    browTilt: 0.002,
    mouthScale: 0.82,
    mouthCurve: -0.0015,
    mouthOpen: 0,
    pupilScale: 0.86,
    hollow: 0.55,
  },
  serious: {
    eyeScaleY: 0.82,
    eyeScaleX: 1.04,
    lid: 0.3,
    browRaise: -0.008,
    browTilt: -0.009,
    mouthScale: 1.05,
    mouthCurve: -0.004,
    mouthOpen: 0,
    pupilScale: 0.78,
    hollow: 0.2,
  },
  surprised: {
    eyeScaleY: 1.42,
    eyeScaleX: 1.12,
    lid: 0,
    browRaise: 0.013,
    browTilt: 0.004,
    mouthScale: 0.62,
    mouthCurve: 0.002,
    mouthOpen: 0.02,
    pupilScale: 0.7,
    hollow: 0,
  },
};

/**
 * The expression a boredom level should wear.
 *
 * Gameplay owns the boredom value; this mapping is here because the face is
 * here. Above 0.6 the character has stopped being present, which is exactly
 * what the `bored` tile draws.
 */
export function expressionForBoredom(boredom: number): Expression {
  const b = clamp01(boredom);
  if (b >= 0.6) return 'bored';
  if (b <= 0.12) return 'serious';
  return 'neutral';
}

/* -------------------------------------------------------------------------- */
/* SVG primitives                                                             */
/* -------------------------------------------------------------------------- */

function hex(value: number): string {
  return `#${(value >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
}

function n(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '0';
}

/** Drawing context: metres in, tile pixels out. */
class Pen {
  readonly parts: string[] = [];

  constructor(private readonly region: FaceRegion) {}

  /** Pixels per metre across the face. */
  get sx(): number {
    return this.region.tileWidth / this.region.metricWidth;
  }

  /** Pixels per metre up the face. */
  get sy(): number {
    return this.region.tileHeight / this.region.metricHeight;
  }

  /** Tile x for a signed distance from the centre line, in metres. */
  x(metres: number): number {
    return this.region.tileWidth * 0.5 + metres * this.sx;
  }

  /** Tile y for a strand-local v. */
  y(v: number): number {
    const t = (v - this.region.vMin) / Math.max(this.region.vMax - this.region.vMin, 1e-6);
    return (1 - t) * this.region.tileHeight;
  }

  /** Tile y for a v offset by metres up the face. */
  yOffset(v: number, metres: number): number {
    return this.y(v + metres / this.region.metresPerV);
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, fill: string, opacity = 1): void {
    this.parts.push(
      `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(Math.max(rx, 0.4))}" ry="${n(
        Math.max(ry, 0.4)
      )}" fill="${fill}"${opacity < 1 ? ` opacity="${opacity.toFixed(3)}"` : ''}/>`
    );
  }

  path(d: string, fill: string, opacity = 1): void {
    this.parts.push(
      `<path d="${d}" fill="${fill}"${opacity < 1 ? ` opacity="${opacity.toFixed(3)}"` : ''}/>`
    );
  }

  stroke(d: string, color: string, width: number, opacity = 1, cap = 'round'): void {
    this.parts.push(
      `<path d="${d}" fill="none" stroke="${color}" stroke-width="${n(
        Math.max(width, 0.6)
      )}" stroke-linecap="${cap}"${opacity < 1 ? ` opacity="${opacity.toFixed(3)}"` : ''}/>`
    );
  }

  raw(markup: string): void {
    this.parts.push(markup);
  }
}

/* -------------------------------------------------------------------------- */
/* Feature drawing                                                            */
/* -------------------------------------------------------------------------- */

interface EyeGeom {
  readonly cx: number;
  readonly cy: number;
  readonly rx: number;
  readonly ry: number;
  readonly side: -1 | 1;
}

function eyeGeometry(pen: Pen, style: FaceStyle, mood: Mood, side: -1 | 1): EyeGeom {
  const cx = pen.x(side * style.eyeSpread);
  const cy = pen.y(style.eyeV);
  const rx = style.eyeWidth * mood.eyeScaleX * pen.sx;
  const ry = style.eyeHeight * mood.eyeScaleY * pen.sy;
  return { cx, cy, rx, ry, side };
}

/** Soft socket shading, drawn under everything. */
function drawSocket(pen: Pen, style: FaceStyle, mood: Mood, eye: EyeGeom): void {
  const shadow = style.shadow;
  if (shadow === undefined) return;
  // Deliberately small and faint. A wide halo around each eye stops reading as
  // a socket and starts reading as a second, paler eye — which is exactly what
  // it looked like at 1.9x the eye radius.
  const strength = 0.1 + mood.hollow * 0.16;
  pen.ellipse(eye.cx, eye.cy + eye.ry * 0.35, eye.rx * 1.3, eye.ry * 1.45, hex(shadow), strength);
  if (mood.hollow > 0.2) {
    // The hollow under a tired eye is a crescent, not a disc.
    pen.stroke(
      `M ${n(eye.cx - eye.rx * 0.95)} ${n(eye.cy + eye.ry * 1.15)}` +
        ` Q ${n(eye.cx)} ${n(eye.cy + eye.ry * 1.9)} ${n(eye.cx + eye.rx * 0.95)} ${n(eye.cy + eye.ry * 1.15)}`,
      hex(shadow),
      Math.max(eye.ry * 0.3, 1.2),
      0.3 * mood.hollow
    );
  }
}

/**
 * Draw one eye, with the upper lid applied as a CLIP rather than as a painted
 * cap.
 *
 * Clipping is the only honest way to do this: the face patch composites over
 * the atlas, so "covered by the lid" must mean "transparent here, let the skin
 * through", not "paint something skin-ish and hope the colours match". It also
 * gives the bored expression its shape — a dark slot with a flat top and a
 * curved bottom — instead of a shrunken circle.
 */
function drawEye(pen: Pen, style: FaceStyle, mood: Mood, eye: EyeGeom, id: string): void {
  const sclera = hex(style.sclera);
  const iris = hex(style.iris);
  const pupil = hex(style.pupil);
  const start = pen.parts.length;

  switch (style.eye) {
    case 'dot': {
      // A solid oval. No sclera, no iris: the entire eye is one shape, which
      // is what makes the stare read as blank from across a street.
      pen.ellipse(eye.cx, eye.cy, eye.rx, eye.ry, pupil);
      pen.ellipse(
        eye.cx - eye.side * eye.rx * 0.3,
        eye.cy - eye.ry * 0.36,
        eye.rx * 0.24,
        eye.ry * 0.3,
        '#ffffff',
        0.5
      );
      break;
    }
    case 'almond': {
      const d =
        `M ${n(eye.cx - eye.rx)} ${n(eye.cy)}` +
        ` Q ${n(eye.cx)} ${n(eye.cy - eye.ry * 1.5)} ${n(eye.cx + eye.rx)} ${n(eye.cy)}` +
        ` Q ${n(eye.cx)} ${n(eye.cy + eye.ry * 1.25)} ${n(eye.cx - eye.rx)} ${n(eye.cy)} Z`;
      pen.path(d, sclera);
      pen.ellipse(eye.cx, eye.cy, eye.ry * 0.92, eye.ry * 0.92, iris);
      pen.ellipse(
        eye.cx,
        eye.cy,
        eye.ry * 0.42 * mood.pupilScale,
        eye.ry * 0.46 * mood.pupilScale,
        pupil
      );
      pen.ellipse(
        eye.cx - eye.rx * 0.22,
        eye.cy - eye.ry * 0.42,
        eye.rx * 0.16,
        eye.ry * 0.2,
        '#ffffff',
        0.85
      );
      break;
    }
    case 'anime': {
      pen.ellipse(eye.cx, eye.cy, eye.rx, eye.ry, sclera);
      pen.ellipse(eye.cx, eye.cy + eye.ry * 0.06, eye.rx * 0.78, eye.ry * 0.84, iris);
      pen.ellipse(
        eye.cx,
        eye.cy + eye.ry * 0.06,
        eye.rx * 0.4 * mood.pupilScale,
        eye.ry * 0.46 * mood.pupilScale,
        pupil
      );
      // Two highlights: the big one sells the volume, the small one the gloss.
      pen.ellipse(
        eye.cx - eye.rx * 0.34,
        eye.cy - eye.ry * 0.4,
        eye.rx * 0.22,
        eye.ry * 0.26,
        '#ffffff',
        0.95
      );
      pen.ellipse(
        eye.cx + eye.rx * 0.3,
        eye.cy + eye.ry * 0.34,
        eye.rx * 0.12,
        eye.ry * 0.14,
        '#ffffff',
        0.6
      );
      break;
    }
    case 'slit': {
      const d =
        `M ${n(eye.cx - eye.rx)} ${n(eye.cy + eye.ry * 0.3)}` +
        ` Q ${n(eye.cx)} ${n(eye.cy - eye.ry * 1.1)} ${n(eye.cx + eye.rx)} ${n(eye.cy - eye.ry * 0.2)}` +
        ` Q ${n(eye.cx)} ${n(eye.cy + eye.ry * 0.8)} ${n(eye.cx - eye.rx)} ${n(eye.cy + eye.ry * 0.3)} Z`;
      pen.path(d, sclera);
      pen.ellipse(eye.cx, eye.cy, eye.rx * 0.3, eye.ry * 0.75, iris);
      pen.ellipse(eye.cx, eye.cy, eye.rx * 0.1 * mood.pupilScale, eye.ry * 0.62, pupil);
      break;
    }
    case 'compound': {
      pen.ellipse(eye.cx, eye.cy, eye.rx, eye.ry, iris);
      // Facets. Deterministic lattice, not noise: an insect eye is a grid.
      const cols = 7;
      const rows = 5;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const fx = eye.cx + ((c + 0.5) / cols - 0.5) * eye.rx * 2;
          const fy = eye.cy + ((r + 0.5) / rows - 0.5) * eye.ry * 2;
          const dx = (fx - eye.cx) / eye.rx;
          const dy = (fy - eye.cy) / eye.ry;
          if (dx * dx + dy * dy > 0.92) continue;
          pen.ellipse(fx, fy, (eye.rx / cols) * 0.78, (eye.ry / rows) * 0.78, sclera, 0.3);
        }
      }
      pen.ellipse(
        eye.cx - eye.rx * 0.3,
        eye.cy - eye.ry * 0.35,
        eye.rx * 0.26,
        eye.ry * 0.3,
        '#ffffff',
        0.35
      );
      break;
    }
    case 'socket': {
      pen.ellipse(eye.cx, eye.cy, eye.rx * 1.15, eye.ry * 1.25, hex(style.sclera));
      pen.ellipse(
        eye.cx,
        eye.cy,
        eye.rx * 0.44 * mood.pupilScale,
        eye.ry * 0.5 * mood.pupilScale,
        iris
      );
      break;
    }
    case 'round': {
      pen.ellipse(eye.cx, eye.cy, eye.rx, eye.ry, sclera);
      pen.ellipse(eye.cx, eye.cy, eye.rx * 0.62, eye.ry * 0.62, iris);
      pen.ellipse(
        eye.cx,
        eye.cy,
        eye.rx * 0.3 * mood.pupilScale,
        eye.ry * 0.3 * mood.pupilScale,
        pupil
      );
      pen.ellipse(
        eye.cx - eye.rx * 0.28,
        eye.cy - eye.ry * 0.3,
        eye.rx * 0.18,
        eye.ry * 0.18,
        '#ffffff',
        0.8
      );
      break;
    }
  }

  const markup = pen.parts.splice(start).join('');

  if (mood.lid <= 0.01) {
    pen.raw(markup);
    return;
  }

  const lidY = eye.cy - eye.ry + eye.ry * 2 * mood.lid;
  const left = eye.cx - eye.rx * 2.2;
  const right = eye.cx + eye.rx * 2.2;
  const bottom = eye.cy + eye.ry * 4;
  const clip =
    `M ${n(left)} ${n(lidY)} Q ${n(eye.cx)} ${n(lidY - eye.ry * 0.55)} ${n(right)} ${n(lidY)}` +
    ` L ${n(right)} ${n(bottom)} L ${n(left)} ${n(bottom)} Z`;
  pen.raw(
    `<defs><clipPath id="lid-${id}"><path d="${clip}"/></clipPath></defs>` +
      `<g clip-path="url(#lid-${id})">${markup}</g>`
  );
  // Lash line along the lid edge, outside the clip so it stays crisp.
  pen.stroke(
    `M ${n(eye.cx - eye.rx * 1.02)} ${n(lidY + eye.ry * 0.06)}` +
      ` Q ${n(eye.cx)} ${n(lidY - eye.ry * 0.5)} ${n(eye.cx + eye.rx * 1.02)} ${n(lidY + eye.ry * 0.06)}`,
    hex(style.pupil),
    Math.max(eye.ry * 0.3, 1.4),
    0.92
  );
}

function drawBrow(pen: Pen, style: FaceStyle, mood: Mood, side: -1 | 1): void {
  if (style.brow === 'none') return;
  const inner = pen.x(side * (style.eyeSpread * 0.42));
  const outer = pen.x(side * (style.eyeSpread + style.eyeWidth * 1.15));
  const baseV = style.browV;
  const innerY = pen.yOffset(baseV, mood.browRaise + mood.browTilt);
  const outerY = pen.yOffset(baseV, mood.browRaise - mood.browTilt * 0.35);
  const midX = (inner + outer) * 0.5;
  const midY = Math.min(innerY, outerY) - Math.abs(outer - inner) * 0.16;

  const width =
    style.brow === 'bold'
      ? 0.011
      : style.brow === 'angular'
        ? 0.009
        : style.brow === 'thin'
          ? 0.0055
          : 0.004;
  const opacity = style.brow === 'faint' ? 0.34 : 0.95;
  pen.stroke(
    `M ${n(inner)} ${n(innerY)} Q ${n(midX)} ${n(midY)} ${n(outer)} ${n(outerY)}`,
    hex(style.browColor),
    width * pen.sy,
    opacity
  );
}

function drawMouth(pen: Pen, style: FaceStyle, mood: Mood): void {
  const halfWidth = style.mouthWidth * mood.mouthScale * pen.sx;
  const cx = pen.x(0);
  const cy = pen.y(style.mouthV);
  const curve = mood.mouthCurve * pen.sy;
  const color = hex(style.mouthColor);

  switch (style.mouth) {
    case 'line': {
      if (mood.mouthOpen > 0.001) {
        // Surprise opens even a line mouth. Without this the "surprised" tile
        // differs from neutral only in the eyes, which reads as a stare.
        // Rounder than tall: an open mouth drawn as a narrow vertical ellipse
        // reads as a scratch, not as surprise.
        const open = Math.min(mood.mouthOpen * pen.sy, halfWidth * 0.8);
        pen.ellipse(cx, cy + open * 0.35, halfWidth * 0.62, open, color);
        break;
      }
      pen.stroke(
        `M ${n(cx - halfWidth)} ${n(cy - curve)} Q ${n(cx)} ${n(cy + curve * 2)} ${n(cx + halfWidth)} ${n(cy - curve)}`,
        color,
        Math.max(0.0035 * pen.sy, 1.5),
        0.9
      );
      break;
    }
    case 'small': {
      if (mood.mouthOpen > 0.001) {
        pen.ellipse(cx, cy, halfWidth * 0.5, mood.mouthOpen * pen.sy, color);
      } else {
        pen.stroke(
          `M ${n(cx - halfWidth * 0.7)} ${n(cy)} Q ${n(cx)} ${n(cy + curve * 2)} ${n(cx + halfWidth * 0.7)} ${n(cy)}`,
          color,
          Math.max(0.004 * pen.sy, 1.6),
          0.92
        );
      }
      break;
    }
    case 'wide': {
      pen.path(
        `M ${n(cx - halfWidth)} ${n(cy)} Q ${n(cx)} ${n(cy + halfWidth * 0.55)} ${n(cx + halfWidth)} ${n(cy)}` +
          ` Q ${n(cx)} ${n(cy + halfWidth * 0.2)} ${n(cx - halfWidth)} ${n(cy)} Z`,
        color
      );
      break;
    }
    case 'grin': {
      const h = halfWidth * 0.5;
      pen.path(
        `M ${n(cx - halfWidth)} ${n(cy - h * 0.2)} Q ${n(cx)} ${n(cy + h * 1.4)} ${n(cx + halfWidth)} ${n(cy - h * 0.2)}` +
          ` Q ${n(cx)} ${n(cy + h * 0.2)} ${n(cx - halfWidth)} ${n(cy - h * 0.2)} Z`,
        color
      );
      // Teeth line.
      pen.stroke(
        `M ${n(cx - halfWidth * 0.82)} ${n(cy + h * 0.12)} Q ${n(cx)} ${n(cy + h * 0.5)} ${n(cx + halfWidth * 0.82)} ${n(cy + h * 0.12)}`,
        '#f2ece0',
        Math.max(h * 0.22, 1.2),
        0.85
      );
      break;
    }
    case 'fanged': {
      const h = halfWidth * 0.62;
      pen.path(
        `M ${n(cx - halfWidth)} ${n(cy - h * 0.1)} Q ${n(cx)} ${n(cy + h * 1.5)} ${n(cx + halfWidth)} ${n(cy - h * 0.1)}` +
          ` Q ${n(cx)} ${n(cy - h * 0.35)} ${n(cx - halfWidth)} ${n(cy - h * 0.1)} Z`,
        color
      );
      const teeth = 7;
      for (let i = 0; i < teeth; i++) {
        const t = (i + 0.5) / teeth;
        const tx = cx + (t - 0.5) * halfWidth * 1.85;
        const top = cy - h * 0.05 + Math.sin(t * Math.PI) * h * 0.12;
        const drop = h * (0.35 + 0.45 * Math.sin(t * Math.PI));
        pen.path(
          `M ${n(tx - halfWidth * 0.1)} ${n(top)} L ${n(tx + halfWidth * 0.1)} ${n(top)} L ${n(tx)} ${n(top + drop)} Z`,
          '#f6f1e4'
        );
      }
      break;
    }
    case 'mandible': {
      for (const side of [-1, 1] as const) {
        pen.stroke(
          `M ${n(cx + side * halfWidth * 0.2)} ${n(cy - halfWidth * 0.3)}` +
            ` Q ${n(cx + side * halfWidth * 1.1)} ${n(cy + halfWidth * 0.1)} ${n(cx + side * halfWidth * 0.55)} ${n(cy + halfWidth * 0.95)}`,
          color,
          Math.max(halfWidth * 0.24, 1.6),
          0.95
        );
      }
      pen.ellipse(cx, cy, halfWidth * 0.26, halfWidth * 0.34, color, 0.9);
      break;
    }
    case 'beak': {
      pen.path(
        `M ${n(cx - halfWidth * 0.8)} ${n(cy - halfWidth * 0.25)} L ${n(cx + halfWidth * 0.8)} ${n(cy - halfWidth * 0.25)} L ${n(cx)} ${n(cy + halfWidth * 0.9)} Z`,
        color
      );
      break;
    }
  }
}

function drawMarking(pen: Pen, style: FaceStyle, region: FaceRegion): void {
  const marking = style.marking ?? 'none';
  if (marking === 'none') return;
  const color = hex(style.markingColor ?? 0x1a1a1a);

  switch (marking) {
    case 'scar': {
      const x0 = pen.x(-style.eyeSpread * 1.15);
      pen.stroke(
        `M ${n(x0)} ${n(pen.yOffset(style.browV, 0.02))} L ${n(pen.x(-style.eyeSpread * 0.7))} ${n(
          pen.yOffset(style.mouthV, 0.03)
        )}`,
        color,
        Math.max(0.004 * pen.sy, 1.4),
        0.75
      );
      break;
    }
    case 'plate': {
      // A machined cheek plate: two seams and a row of rivets.
      const top = pen.yOffset(style.eyeV, -0.012);
      const bottom = pen.yOffset(style.mouthV, 0.006);
      const x0 = pen.x(style.eyeSpread * 0.55);
      const x1 = pen.x(style.eyeSpread + style.eyeWidth * 1.9);
      pen.stroke(`M ${n(x0)} ${n(top)} L ${n(x1)} ${n(top + (bottom - top) * 0.2)}`, color, 2, 0.7);
      pen.stroke(
        `M ${n(x0)} ${n(bottom)} L ${n(x1)} ${n(bottom - (bottom - top) * 0.15)}`,
        color,
        2,
        0.55
      );
      for (let i = 0; i < 3; i++) {
        const t = (i + 0.5) / 3;
        pen.ellipse(
          x0 + (x1 - x0) * t,
          top + (bottom - top) * (0.18 + 0.1 * t),
          2.4,
          2.4,
          color,
          0.6
        );
      }
      break;
    }
    case 'stripes': {
      for (let i = 0; i < 3; i++) {
        const v = style.browV + 0.012 * i;
        pen.stroke(
          `M ${n(pen.x(-region.metricWidth * 0.3))} ${n(pen.y(v))} L ${n(pen.x(region.metricWidth * 0.3))} ${n(pen.y(v))}`,
          color,
          Math.max(0.003 * pen.sy, 1.2),
          0.4
        );
      }
      break;
    }
    case 'gills': {
      for (const side of [-1, 1] as const) {
        for (let i = 0; i < 3; i++) {
          const x = pen.x(side * (style.eyeSpread + style.eyeWidth * (1.5 + i * 0.5)));
          pen.stroke(
            `M ${n(x)} ${n(pen.yOffset(style.mouthV, 0.012))} L ${n(x)} ${n(pen.yOffset(style.mouthV, -0.014))}`,
            color,
            Math.max(0.0035 * pen.sy, 1.3),
            0.7
          );
        }
      }
      break;
    }
  }
}

function drawVisor(pen: Pen, style: FaceStyle, region: FaceRegion): void {
  if (style.visor === undefined) return;
  const top = pen.yOffset(style.eyeV, style.eyeHeight * 2.2);
  const bottom = pen.yOffset(style.eyeV, -style.eyeHeight * 2.1);
  const left = pen.x(-region.metricWidth * 0.46);
  const right = pen.x(region.metricWidth * 0.46);
  pen.parts.push(
    `<rect x="${n(left)}" y="${n(top)}" width="${n(right - left)}" height="${n(bottom - top)}" rx="${n(
      (bottom - top) * 0.35
    )}" fill="${hex(style.visor)}" opacity="0.42"/>`
  );
  pen.stroke(`M ${n(left)} ${n(top)} L ${n(right)} ${n(top)}`, hex(style.visor), 3, 0.9);
  pen.stroke(`M ${n(left)} ${n(bottom)} L ${n(right)} ${n(bottom)}`, hex(style.visor), 3, 0.9);
  // Glass glare, so the visor reads as glass rather than as a painted band.
  pen.path(
    `M ${n(left + (right - left) * 0.08)} ${n(bottom)} L ${n(left + (right - left) * 0.3)} ${n(top)}` +
      ` L ${n(left + (right - left) * 0.42)} ${n(top)} L ${n(left + (right - left) * 0.2)} ${n(bottom)} Z`,
    '#ffffff',
    0.16
  );
}

/* -------------------------------------------------------------------------- */
/* Layers                                                                     */
/* -------------------------------------------------------------------------- */

/** Draw one layer of one expression as a standalone SVG document. */
export function faceSvg(
  style: FaceStyle,
  expression: Expression,
  region: FaceRegion,
  layer: FaceLayer = 'albedo'
): string {
  const mood = MOODS[expression];
  const pen = new Pen(region);

  if (layer === 'albedo') {
    for (const side of [-1, 1] as const) {
      const eye = eyeGeometry(pen, style, mood, side);
      drawSocket(pen, style, mood, eye);
    }
    if (style.blush !== undefined && style.blush > 0) {
      for (const side of [-1, 1] as const) {
        pen.ellipse(
          pen.x(side * (style.eyeSpread * 1.25)),
          pen.yOffset(style.eyeV, -0.026),
          style.eyeWidth * 1.7 * pen.sx,
          style.eyeHeight * 1.5 * pen.sy,
          '#e8705e',
          0.1 * style.blush
        );
      }
    }
    for (const side of [-1, 1] as const) {
      drawEye(pen, style, mood, eyeGeometry(pen, style, mood, side), side < 0 ? 'l' : 'r');
    }
    for (const side of [-1, 1] as const) drawBrow(pen, style, mood, side);
    drawMouth(pen, style, mood);
    drawMarking(pen, style, region);
    drawVisor(pen, style, region);
  } else if (layer === 'orm') {
    // Roughness only: eyes are wet, lips are damp, everything else keeps the
    // skin the atlas already baked. Red = AO (left at full), green =
    // roughness, blue = metalness.
    for (const side of [-1, 1] as const) {
      const eye = eyeGeometry(pen, style, mood, side);
      pen.ellipse(eye.cx, eye.cy, eye.rx * 1.02, eye.ry * 1.02, 'rgb(255,42,0)');
    }
    const halfWidth = style.mouthWidth * mood.mouthScale * pen.sx;
    pen.ellipse(pen.x(0), pen.y(style.mouthV), halfWidth, halfWidth * 0.35, 'rgb(255,120,0)', 0.8);
    if (style.visor !== undefined) {
      const top = pen.yOffset(style.eyeV, style.eyeHeight * 2.2);
      const bottom = pen.yOffset(style.eyeV, -style.eyeHeight * 2.1);
      const left = pen.x(-region.metricWidth * 0.46);
      const right = pen.x(region.metricWidth * 0.46);
      pen.parts.push(
        `<rect x="${n(left)}" y="${n(top)}" width="${n(right - left)}" height="${n(
          bottom - top
        )}" rx="${n((bottom - top) * 0.35)}" fill="rgb(255,25,0)"/>`
      );
    }
  } else {
    if (style.glow === undefined) return emptySvg(region);
    for (const side of [-1, 1] as const) {
      const eye = eyeGeometry(pen, style, mood, side);
      const radius = style.eye === 'anime' || style.eye === 'almond' ? 0.8 : 0.55;
      pen.ellipse(eye.cx, eye.cy, eye.rx * radius, eye.ry * radius, hex(style.glow));
      pen.ellipse(eye.cx, eye.cy, eye.rx * 1.5, eye.ry * 1.5, hex(style.glow), 0.22);
    }
  }

  return document(region, pen.parts.join(''));
}

function document(region: FaceRegion, body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${region.tileWidth}" height="${region.tileHeight}"` +
    ` viewBox="0 0 ${region.tileWidth} ${region.tileHeight}">${body}</svg>`
  );
}

function emptySvg(region: FaceRegion): string {
  return document(region, '');
}

/** True when this face needs an emissive layer at all. */
export function faceGlows(style: FaceStyle): boolean {
  return style.glow !== undefined;
}

/* -------------------------------------------------------------------------- */
/* Presets                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A plain adult human face, as the base every character overrides.
 *
 * The v values line up with the mesh's own head cross-sections: the eye sits
 * between `cheek` (0.725) and `brow` (0.775), the brow ridge on `brow`, the
 * mouth between `jaw` (0.63) and `mouth` (0.68). Nothing here is tuned to one
 * character's head size, because every measurement is in metres or in the same
 * landmark space the mesh publishes.
 */
export function baseFace(overrides: Partial<FaceStyle> = {}): FaceStyle {
  return {
    eye: 'almond',
    eyeSpread: 0.031,
    eyeV: 0.7455,
    eyeWidth: 0.0165,
    eyeHeight: 0.0082,
    sclera: 0xf2ece2,
    iris: 0x5a4128,
    pupil: 0x14100e,
    brow: 'thin',
    browColor: 0x3a2a1c,
    browV: 0.7825,
    mouth: 'line',
    mouthWidth: 0.021,
    mouthV: 0.659,
    mouthColor: 0x8c4a44,
    shadow: 0x6a4530,
    blush: 0.55,
    marking: 'none',
    ...overrides,
  };
}
