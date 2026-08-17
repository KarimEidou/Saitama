/**
 * PROCEDURAL VFX ATLASES
 *
 * Two textures, both generated on the CPU at boot from a seed. Nothing is
 * fetched, nothing is committed to the repository, and the same seed produces
 * byte-identical output everywhere.
 *
 *   particle atlas   4x4 tiles — dust, cloud, flash, spark, streak, ring, ...
 *   crack atlas      2x2 tiles — the persistent ground fractures
 *
 * ── WHY THE CHANNELS ARE NOT JUST ALPHA ────────────────────────────────────
 * A dust puff drawn from a plain alpha mask is a grey disc, and a hundred grey
 * discs are a grey puff. What makes dust read as VOLUME is:
 *
 *   R  density — the shader raises a threshold against this over the
 *      particle's life, so the wispy edges evaporate FIRST and the puff
 *      dissolves. Fading uniform opacity instead is the single most common
 *      reason particle smoke looks like a decal.
 *   G  self-occlusion — dark in the interior, bright on the shell. Multiplied
 *      into the fake sun shading, this is what gives a billboard a lit side
 *      and a shadowed side.
 *   B  rim — a thin bright band at the silhouette, so back-lit dust glows at
 *      its edge the way real airborne dust does.
 *   A  coverage.
 *
 * Every tile is authored with a transparent margin so mip-mapping never bleeds
 * one tile into its neighbour.
 */

import * as THREE from 'three';
import { createRng, type IRandom } from '@/util';
import { ATLAS_TILES, CRACK_TILES, CrackTile, SpriteTile } from './constants';
import { distanceToSegmentSq, fbm, hash1, ridgedFbm, smoothstep, valueNoise } from './noise';

/** Fraction of a tile kept transparent on every side, to stop mip bleed. */
const TILE_MARGIN = 0.045;

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** One tile's writer: takes tile-local uv in [0,1] and returns RGBA in [0,1]. */
type TilePainter = (u: number, v: number, out: Float32Array) => void;

/**
 * Paint one tile of an atlas.
 *
 * The margin is applied by REMAPPING the uv the painter sees rather than by
 * masking afterwards, so the painter always works in a clean 0..1 square and
 * the transparent border costs nothing in authoring complexity.
 */
function paintTile(
  data: Uint8Array,
  atlasSize: number,
  tilesPerSide: number,
  tileIndex: number,
  painter: TilePainter
): void {
  const tileSize = atlasSize / tilesPerSide;
  const tx = (tileIndex % tilesPerSide) * tileSize;
  const ty = Math.floor(tileIndex / tilesPerSide) * tileSize;
  const scratch = new Float32Array(4);
  const inner = 1 - TILE_MARGIN * 2;

  for (let y = 0; y < tileSize; y++) {
    for (let x = 0; x < tileSize; x++) {
      const u = (x + 0.5) / tileSize;
      const v = (y + 0.5) / tileSize;
      const pu = (u - TILE_MARGIN) / inner;
      const pv = (v - TILE_MARGIN) / inner;

      scratch[0] = 0;
      scratch[1] = 0;
      scratch[2] = 0;
      scratch[3] = 0;
      if (pu >= 0 && pu <= 1 && pv >= 0 && pv <= 1) painter(pu, pv, scratch);

      // Row 0 of a DataTexture is v = 0, so the painter's v axis and the
      // sampled v axis already agree — no flip, and no shader compensating
      // for one. This matters for the streak tile, whose bright end must be
      // at v = 1 because that is where the velocity-stretched quad puts its
      // leading edge.
      const px = tx + x;
      const py = ty + y;
      const i = (py * atlasSize + px) * 4;
      data[i] = Math.round(clamp01(scratch[0]!) * 255);
      data[i + 1] = Math.round(clamp01(scratch[1]!) * 255);
      data[i + 2] = Math.round(clamp01(scratch[2]!) * 255);
      data[i + 3] = Math.round(clamp01(scratch[3]!) * 255);
    }
  }
}

function makeTexture(size: number, data: Uint8Array, name: string): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.name = name;
  // DATA, not colour. These channels are thresholds and masks; tagging them
  // sRGB would apply a transfer function to an occlusion term.
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/* -------------------------------------------------------------------------- */
/* Particle tiles                                                             */
/* -------------------------------------------------------------------------- */

/** Tuning for the shared billowing-puff painter. */
interface IPuffOptions {
  readonly seed: number;
  /** Radial falloff exponent. Higher = tighter core. */
  readonly power: number;
  /** How far the silhouette is pushed around by low-frequency noise. */
  readonly lumpiness: number;
  /** fBm octaves in the density field. */
  readonly octaves: number;
  /** Vertical bias: >0 flattens the bottom, for clouds. */
  readonly flatBottom: number;
  /** Base radius before lumpiness, in tile units. */
  readonly radius: number;
  /** Horizontal stretch. 1 = round. */
  readonly aspect: number;
}

/**
 * The workhorse: a lumpy ball of dust.
 *
 * ── WHY A THRESHOLDED FIELD AND NOT A MULTIPLIED GRADIENT ──────────────────
 * The obvious construction — a radial falloff MULTIPLIED by fBm — produces a
 * puff that is semi-transparent everywhere, and a hundred of those stack into
 * flat grey haze. That is exactly the "grey puff" failure this whole system
 * has to avoid.
 *
 * So the coverage is a THRESHOLDED sum instead: `smoothstep` over
 * `falloff + density - bias`. The interior saturates to a solid core, and the
 * noise only decides where the silhouette falls. The result is a body with an
 * irregular, chewed edge — which stacks into a mass with structure, and which
 * the shader's erosion channel can then eat inward over the particle's life.
 *
 * The occlusion channel is derived from the SAME density field, so the shading
 * agrees with the shape rather than being an independent gradient laid over it.
 */
function paintPuff(options: IPuffOptions): TilePainter {
  const { seed, power, lumpiness, octaves, flatBottom, radius, aspect } = options;
  return (u, v, out) => {
    const dx = ((u - 0.5) * 2) / aspect;
    let dy = (v - 0.5) * 2;
    if (flatBottom > 0 && dy < 0) dy *= 1 + flatBottom;
    const angle = Math.atan2(dy, dx);
    const dist = Math.hypot(dx, dy);

    // Silhouette: radius pushed around the circle by two low-frequency lobes.
    const lobe =
      valueNoise(Math.cos(angle) * 2 + 2, Math.sin(angle) * 2 + 2, 8, seed + 31) - 0.5 +
      (valueNoise(Math.cos(angle) * 5 + 5, Math.sin(angle) * 5 + 5, 16, seed + 97) - 0.5) * 0.5;
    const edge = radius * (1 + lobe * lumpiness);

    const falloff = Math.pow(clamp01(1 - dist / Math.max(0.05, edge)), power);
    // Low base frequency: billows, not static.
    const density = fbm(u, v, seed, octaves, 2);

    // The bias is tuned so the SOLID core is small and the noise-decided zone
    // is wide: that is what gives the silhouette its chewed, billowing edge
    // instead of a uniform fuzzy fringe.
    const field = falloff * 0.95 + density * 0.88 - 0.6;
    // Hard border fade. Without it the noise term alone can reach the tile
    // boundary and the puff acquires a dead-straight edge — the one artefact
    // the eye picks out instantly in a cloud of irregular shapes.
    const coverage = smoothstep(0, 0.26, field) * smoothstep(1.0, 0.84, dist);
    if (coverage <= 0.003) return;

    // Occlusion: bright on the lobes the light would catch, dark in the
    // crevices between them and in the deep interior.
    const occlusion = clamp01(0.3 + density * 0.95 - falloff * 0.22);

    // Rim: the band where coverage is falling off, i.e. the silhouette.
    const rim = clamp01(smoothstep(0.05, 0.4, coverage) * (1 - smoothstep(0.4, 0.9, coverage)));

    out[0] = clamp01(falloff * 0.5 + density * 0.62);
    out[1] = occlusion;
    out[2] = rim;
    out[3] = coverage;
  };
}

/** A hot, hard-edged multi-point star with a blown-out core. */
function paintFlashStar(seed: number): TilePainter {
  return (u, v, out) => {
    const dx = (u - 0.5) * 2;
    const dy = (v - 0.5) * 2;
    const dist = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);

    const core = Math.pow(clamp01(1 - dist / 0.22), 2.2);
    const halo = Math.pow(clamp01(1 - dist / 0.95), 3.4) * 0.5;

    // Four long spikes plus four short ones, with a per-arm length jitter.
    let spikes = 0;
    for (let arm = 0; arm < 8; arm++) {
      const armAngle = (arm / 8) * Math.PI * 2;
      const long = arm % 2 === 0;
      const length = (long ? 1 : 0.52) * (0.72 + hash1(arm + seed, seed) * 0.35);
      let delta = Math.abs(((angle - armAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      delta = Math.PI - delta;
      const width = 0.035 + (1 - clamp01(dist / length)) * 0.12;
      const along = clamp01(1 - dist / length);
      spikes = Math.max(spikes, Math.pow(clamp01(1 - delta / width), 1.5) * Math.pow(along, 1.6));
    }

    const coverage = clamp01(core + halo + spikes * 0.95);
    out[0] = clamp01(core + spikes * 0.6);
    out[1] = 1;
    out[2] = clamp01(spikes);
    out[3] = coverage;
  };
}

/** Smooth radial glow. The cheapest and most useful tile in the atlas. */
function paintGlow(power: number): TilePainter {
  return (u, v, out) => {
    const dist = Math.hypot((u - 0.5) * 2, (v - 0.5) * 2);
    const a = Math.pow(clamp01(1 - dist), power);
    out[0] = a;
    out[1] = 1;
    out[2] = clamp01(a * 1.2 - 0.2);
    out[3] = a;
  };
}

/** A tiny hot point with a faint cross flare — hit sparks and embers. */
function paintSpark(seed: number): TilePainter {
  return (u, v, out) => {
    const dx = (u - 0.5) * 2;
    const dy = (v - 0.5) * 2;
    const dist = Math.hypot(dx, dy);
    const core = Math.pow(clamp01(1 - dist / 0.26), 1.6);
    const flare =
      Math.pow(clamp01(1 - Math.abs(dy) / 0.05), 2) * clamp01(1 - Math.abs(dx)) * 0.55 +
      Math.pow(clamp01(1 - Math.abs(dx) / 0.05), 2) * clamp01(1 - Math.abs(dy)) * 0.55;
    const jitter = 0.85 + hash1(Math.round(u * 32) * 71 + Math.round(v * 32), seed) * 0.3;
    const a = clamp01((core + flare * 0.7) * jitter);
    out[0] = a;
    out[1] = 1;
    out[2] = core;
    out[3] = a;
  };
}

/**
 * A vertical streak, bright at the top.
 *
 * VERTICAL because the streak quad mode maps uv.y along the velocity vector,
 * so `v = 1` is the leading end of a spark or a debris trail.
 */
function paintStreak(seed: number): TilePainter {
  return (u, v, out) => {
    const dx = Math.abs((u - 0.5) * 2);
    // Taper: full width at the head, pinched to nothing at the tail.
    const width = 0.09 + Math.pow(v, 1.7) * 0.32;
    const across = Math.pow(clamp01(1 - dx / width), 1.5);
    const along = Math.pow(clamp01(v), 1.25) * smoothstep(0, 0.08, v);
    const flicker = 0.82 + valueNoise(v * 12, u * 2, 12, seed) * 0.36;
    const a = clamp01(across * along * flicker);
    out[0] = a;
    out[1] = 1;
    out[2] = clamp01(a * 1.4 - 0.4);
    out[3] = a;
  };
}

/** A thin soft annulus, for expanding ring pops at the impact point. */
function paintRing(seed: number): TilePainter {
  return (u, v, out) => {
    const dx = (u - 0.5) * 2;
    const dy = (v - 0.5) * 2;
    const dist = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    const wobble =
      (valueNoise(Math.cos(angle) * 4 + 4, Math.sin(angle) * 4 + 4, 12, seed) - 0.5) * 0.09;
    const band = Math.abs(dist - (0.74 + wobble));
    // Radial spokes through the band. A clean hoop reads as a portal hanging in
    // the street; broken up it reads as air being shoved outward.
    const spoke =
      0.55 +
      0.45 * valueNoise(Math.cos(angle) * 11 + 11, Math.sin(angle) * 11 + 11, 26, seed + 5);
    const a = Math.pow(clamp01(1 - band / 0.30), 2.0) * spoke;
    out[0] = a;
    out[1] = 1;
    out[2] = a;
    out[3] = a;
  };
}

/** An angular chip of concrete, seen as a dark silhouette against the dust. */
function paintShard(seed: number): TilePainter {
  // Few vertices and a wide radius spread: a chip of concrete is angular, and
  // an eleven-sided polygon with small variance is just a circle.
  const points = 6;
  const radii = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    // A convex-ish irregular hexagon: reads as a chip of concrete rather than
    // as a star, at the one-metre scale these are actually drawn.
    radii[i] = 0.55 + hash1(i * 13 + 1, seed) * 0.38;
  }
  return (u, v, out) => {
    const dx = (u - 0.5) * 2;
    const dy = (v - 0.5) * 2;
    const dist = Math.hypot(dx, dy);
    let angle = Math.atan2(dy, dx) / (Math.PI * 2) + 0.5;
    angle *= points;
    const i0 = Math.floor(angle) % points;
    const i1 = (i0 + 1) % points;
    const f = angle - Math.floor(angle);
    const edge = radii[i0]! * (1 - f) + radii[i1]! * f;
    const a = smoothstep(edge + 0.03, edge - 0.03, dist);
    const shade = 0.35 + (1 - clamp01(dist / edge)) * 0.4;
    out[0] = a;
    out[1] = shade;
    out[2] = smoothstep(edge - 0.16, edge, dist) * a;
    out[3] = a;
  };
}

/** A rolling smoke swirl — ridged noise wrapped around a spiral. */
function paintSwirl(seed: number): TilePainter {
  return (u, v, out) => {
    const dx = (u - 0.5) * 2;
    const dy = (v - 0.5) * 2;
    const dist = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    const spiral = angle / (Math.PI * 2) + dist * 1.35;
    const n = ridgedFbm(spiral, dist * 1.4, seed, 4, 3);
    const falloff = Math.pow(clamp01(1 - dist), 1.7);
    const a = clamp01(falloff * (0.25 + n * 1.3));
    out[0] = clamp01(n * 0.9 + falloff * 0.3);
    out[1] = clamp01(0.3 + n * 0.8);
    out[2] = clamp01(smoothstep(0.05, 0.28, a) * (1 - smoothstep(0.28, 0.7, a)));
    out[3] = a;
  };
}

/**
 * Build the 4x4 particle atlas.
 *
 * @param size Edge length in texels. 512 on MEDIUM/HIGH, 256 on LOW.
 * @param seed Deterministic generator seed.
 */
export function createParticleAtlas(size = 512, seed: number | string = 'vfx.particles'): THREE.DataTexture {
  const rng = createRng(seed);
  const base = rng.nextUint32();
  const data = new Uint8Array(size * size * 4);

  // The radius stays clear of 1.0 on purpose: a puff clipped by the tile edge
  // shows a dead-straight silhouette, which is the one artefact the eye picks
  // out instantly in a cloud of otherwise irregular shapes.
  const dust = (s: number, power: number, lump: number): TilePainter =>
    paintPuff({
      seed: base + s,
      power,
      lumpiness: lump,
      octaves: 5,
      flatBottom: 0,
      radius: 0.8,
      aspect: 1,
    });

  paintTile(data, size, ATLAS_TILES, SpriteTile.DustSoft, dust(11, 1.0, 0.18));
  paintTile(data, size, ATLAS_TILES, SpriteTile.DustDense, dust(23, 0.72, 0.14));
  paintTile(
    data,
    size,
    ATLAS_TILES,
    SpriteTile.DustWisp,
    paintPuff({
      seed: base + 37,
      power: 1.55,
      lumpiness: 0.2,
      octaves: 6,
      flatBottom: 0,
      radius: 0.82,
      aspect: 1.15,
    })
  );
  paintTile(
    data,
    size,
    ATLAS_TILES,
    SpriteTile.Cloud,
    paintPuff({
      seed: base + 53,
      power: 0.8,
      lumpiness: 0.16,
      octaves: 5,
      flatBottom: 0.5,
      radius: 0.8,
      aspect: 1.6,
    })
  );

  paintTile(data, size, ATLAS_TILES, SpriteTile.FlashStar, paintFlashStar(base + 71));
  paintTile(data, size, ATLAS_TILES, SpriteTile.Glow, paintGlow(2.6));
  paintTile(data, size, ATLAS_TILES, SpriteTile.Spark, paintSpark(base + 89));
  paintTile(data, size, ATLAS_TILES, SpriteTile.Streak, paintStreak(base + 101));

  paintTile(data, size, ATLAS_TILES, SpriteTile.Ring, paintRing(base + 113));
  paintTile(data, size, ATLAS_TILES, SpriteTile.Shard, paintShard(base + 127));
  paintTile(data, size, ATLAS_TILES, SpriteTile.Ember, paintGlow(4.5));
  paintTile(data, size, ATLAS_TILES, SpriteTile.Swirl, paintSwirl(base + 139));

  paintTile(data, size, ATLAS_TILES, SpriteTile.DustVariantA, dust(151, 1.3, 0.2));
  paintTile(data, size, ATLAS_TILES, SpriteTile.DustVariantB, dust(163, 0.88, 0.22));
  paintTile(data, size, ATLAS_TILES, SpriteTile.DustVariantC, dust(179, 1.55, 0.15));
  paintTile(data, size, ATLAS_TILES, SpriteTile.DustVariantD, dust(191, 1.1, 0.24));

  return makeTexture(size, data, 'vfx.atlas.particles');
}

/* -------------------------------------------------------------------------- */
/* Crack tiles                                                                */
/* -------------------------------------------------------------------------- */

interface CrackSegment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Half-width in tile units at the `a` end. */
  wa: number;
  /** Half-width at the `b` end. */
  wb: number;
}

/**
 * Grow a fracture network.
 *
 * Cracks are generated as a branching walk with a persistent heading and a
 * width that tapers as it travels, because that is what a real brittle
 * fracture does. Drawing straight rays from a point instead reads as a
 * cartoon star — fine for one tile, wrong for the ground under a city.
 */
function growCracks(
  segments: CrackSegment[],
  rng: IRandom,
  startX: number,
  startY: number,
  heading: number,
  width: number,
  energy: number,
  depth: number
): void {
  if (energy < 0.04 || depth > 4 || segments.length > 900) return;

  let x = startX;
  let y = startY;
  let angle = heading;
  let w = width;
  let remaining = energy;

  while (remaining > 0.03) {
    const step = 0.035 + rng.next() * 0.05;
    angle += (rng.next() - 0.5) * 0.85;
    const nx = x + Math.cos(angle) * step;
    const ny = y + Math.sin(angle) * step;
    const nextW = w * (0.86 + rng.next() * 0.1);
    segments.push({ ax: x, ay: y, bx: nx, by: ny, wa: w, wb: nextW });

    x = nx;
    y = ny;
    w = nextW;
    remaining -= step;

    // Off the tile: stop rather than wrap, or cracks reappear on the far side.
    if (x < -0.05 || x > 1.05 || y < -0.05 || y > 1.05) return;

    if (rng.next() < 0.16 && depth < 4) {
      const branchAngle = angle + (rng.bool() ? 1 : -1) * (0.5 + rng.next() * 0.7);
      growCracks(segments, rng, x, y, branchAngle, w * 0.62, remaining * 0.55, depth + 1);
    }
  }
}

/**
 * Rasterise a crack network into a tile.
 *
 * The whole tile's unsigned distance field is built first (bounded per segment
 * by its own bounding box, so this stays roughly linear in segment count), and
 * every channel is then derived from that one field. Deriving depth, rim and
 * dust from a shared field is what makes them agree: the bright lip of
 * displaced concrete sits exactly against the dark core instead of near it.
 */
function paintCrackTile(
  data: Uint8Array,
  atlasSize: number,
  tileIndex: number,
  segments: readonly CrackSegment[],
  seed: number,
  extraSmear: number
): void {
  const tileSize = atlasSize / CRACK_TILES;
  const distance = new Float32Array(tileSize * tileSize).fill(4);

  for (const s of segments) {
    const maxW = Math.max(s.wa, s.wb) * 3.5;
    const minX = Math.max(0, Math.floor((Math.min(s.ax, s.bx) - maxW) * tileSize));
    const maxX = Math.min(tileSize - 1, Math.ceil((Math.max(s.ax, s.bx) + maxW) * tileSize));
    const minY = Math.max(0, Math.floor((Math.min(s.ay, s.by) - maxW) * tileSize));
    const maxY = Math.min(tileSize - 1, Math.ceil((Math.max(s.ay, s.by) + maxW) * tileSize));

    for (let y = minY; y <= maxY; y++) {
      const v = (y + 0.5) / tileSize;
      for (let x = minX; x <= maxX; x++) {
        const u = (x + 0.5) / tileSize;
        const dSq = distanceToSegmentSq(u, v, s.ax, s.ay, s.bx, s.by);
        // Normalise by the local half-width so a tapering crack keeps a
        // constant apparent softness along its length.
        const width = (s.wa + s.wb) * 0.5;
        const d = Math.sqrt(dSq) / Math.max(1e-4, width);
        const index = y * tileSize + x;
        if (d < distance[index]!) distance[index] = d;
      }
    }
  }

  const painter: TilePainter = (u, v, out) => {
    const x = Math.min(tileSize - 1, Math.floor(u * tileSize));
    const y = Math.min(tileSize - 1, Math.floor(v * tileSize));
    const d = distance[y * tileSize + x]!;

    // Edge roughness: perturbing the distance field with fine noise stops the
    // crack from looking like an antialiased vector path.
    const grain = (fbm(u, v, seed + 17, 4, 24) - 0.5) * 0.55;
    const dr = d + grain;

    const core = Math.pow(clamp01(1 - dr / 1.05), 1.35);
    const rim = clamp01(smoothstep(1.9, 1.1, dr) * (1 - smoothstep(1.15, 0.75, dr)));
    const dusting = clamp01(smoothstep(3.4, 1.2, dr)) * 0.55;

    let coverage = clamp01(core + rim * 0.55 + dusting * 0.42);
    if (extraSmear > 0) {
      const blot = clamp01(
        Math.pow(clamp01(1 - Math.hypot((u - 0.5) * 2, (v - 0.5) * 2)), 1.4) *
          (0.4 + fbm(u, v, seed + 91, 5, 3) * 1.3)
      );
      coverage = clamp01(coverage + blot * extraSmear);
    }

    out[0] = core;
    out[1] = rim;
    out[2] = dusting;
    out[3] = coverage;
  };

  paintTile(data, atlasSize, CRACK_TILES, tileIndex, painter);
}

/**
 * Build the 2x2 crack decal atlas.
 *
 * @param size Edge length in texels.
 * @param seed Deterministic generator seed.
 */
export function createCrackAtlas(size = 512, seed: number | string = 'vfx.cracks'): THREE.DataTexture {
  const rng = createRng(seed);
  const data = new Uint8Array(size * size * 4);

  // Star: radial fracture from the centre. This one goes under the impact.
  {
    const segments: CrackSegment[] = [];
    const arms = 11;
    for (let i = 0; i < arms; i++) {
      const angle = (i / arms) * Math.PI * 2 + rng.range(-0.18, 0.18);
      growCracks(segments, rng.derive(`star${i}`), 0.5, 0.5, angle, 0.02, 0.55, 0);
    }
    paintCrackTile(data, size, CrackTile.Star, segments, rng.nextUint32(), 0.22);
  }

  // Two directional branches. An elongated quad pointing away from the impact
  // turns these into a fracture racing outward.
  for (const tile of [CrackTile.BranchA, CrackTile.BranchB]) {
    const segments: CrackSegment[] = [];
    const child = rng.derive(`branch${tile}`);
    for (let i = 0; i < 3; i++) {
      growCracks(
        segments,
        child.derive(i),
        0.5 + child.range(-0.12, 0.12),
        0.02,
        Math.PI / 2 + child.range(-0.35, 0.35),
        0.019,
        1.1,
        0
      );
    }
    paintCrackTile(data, size, tile, segments, child.nextUint32(), 0);
  }

  // Smear: no cracks at all, just a dirty blot for scorch and settled dust.
  paintCrackTile(data, size, CrackTile.Smear, [], rng.nextUint32(), 1);

  return makeTexture(size, data, 'vfx.atlas.cracks');
}

/** Rough GPU footprint of an atlas including its mip chain, in bytes. */
export function atlasBytes(size: number): number {
  return Math.round(size * size * 4 * (4 / 3));
}
