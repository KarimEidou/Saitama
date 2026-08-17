/**
 * HARNESS MATERIAL FALLBACK
 *
 * The city binds materials by manifest id and never by path. At runtime those
 * ids resolve through `IAssetRegistry` to the CC0 Poly Haven KTX2 set. While
 * the texture pipeline is still transcoding — `public/assets/` is gitignored
 * and built separately — the registry cannot serve them, so the harness
 * supplies a stand-in per id.
 *
 * These are NOT the shipping materials and the harness says so in its readout.
 * They exist so the screenshot measures the GEOMETRY: whether the massing,
 * window rhythm, roofline, kerb heights and street proportions read as a city.
 * A flat-grey fallback would hide exactly the thing the screenshot is for, so
 * each stand-in is synthesised to roughly the albedo and grain the manifest
 * entry describes — red brick with mortar courses, ribbed corrugated iron,
 * jointed paving slabs — and a normal map is derived from it so the relief
 * catches the sun.
 *
 * Every stand-in is keyed by the SAME id the shipping material uses, so
 * swapping in the real registry is a one-line change in `city.ts` and nothing
 * in `src/world/city/**` moves.
 */

import * as THREE from 'three';
import { MATERIAL_TILE_SIZE } from '@/world/city';

/** Per-id look description used to synthesise a stand-in. */
interface ILook {
  /** Base albedo. */
  readonly color: string;
  /** Secondary colour used by the pattern. */
  readonly accent: string;
  readonly pattern: 'noise' | 'brick' | 'slab' | 'ribs' | 'speckle' | 'planks' | 'plain' | 'tiles';
  readonly roughness: number;
  readonly metalness: number;
  /** Grain amplitude, 0..1. */
  readonly grain: number;
  /** Normal-map strength. */
  readonly bump: number;
}

const DEFAULT_LOOK: ILook = {
  color: '#b8b4ad',
  accent: '#9d9992',
  pattern: 'noise',
  roughness: 0.9,
  metalness: 0,
  grain: 0.16,
  bump: 0.6,
};

/**
 * Look table, derived from each manifest entry's own description. Ids not
 * listed fall back to grey concrete, which is the right default for a city.
 */
const LOOKS: Readonly<Record<string, Partial<ILook>>> = {
  // Roads
  'mat.road.asphalt.worn': { color: '#4a4a4c', accent: '#3a3a3c', pattern: 'speckle', grain: 0.2, roughness: 0.97 },
  'mat.road.asphalt.rough': { color: '#4f4d4b', accent: '#3c3a38', pattern: 'speckle', grain: 0.26, roughness: 0.98 },
  'mat.road.asphalt.clean': { color: '#535356', accent: '#434347', pattern: 'speckle', grain: 0.13, roughness: 0.93 },
  'mat.road.asphalt.damaged': { color: '#46443f', accent: '#2e2c28', pattern: 'speckle', grain: 0.34, roughness: 0.99 },
  'mat.road.markings': { color: '#e8e6df', accent: '#d6d4cc', pattern: 'plain', grain: 0.05, roughness: 0.7, bump: 0.1 },
  // Paving
  'mat.ground.sidewalk.slabs': { color: '#a6a49e', accent: '#8b8983', pattern: 'slab', grain: 0.12, roughness: 0.9 },
  'mat.ground.sidewalk.concrete': { color: '#adaaa3', accent: '#93908a', pattern: 'slab', grain: 0.13, roughness: 0.92 },
  'mat.ground.plaza.tiles': { color: '#b4b1a9', accent: '#98958e', pattern: 'tiles', grain: 0.1, roughness: 0.85 },
  'mat.ground.cobblestone.alley': { color: '#8e8a84', accent: '#6d6a65', pattern: 'tiles', grain: 0.24, roughness: 0.95 },
  'mat.ground.gravel': { color: '#9c9489', accent: '#7a7469', pattern: 'speckle', grain: 0.35, roughness: 1 },
  'mat.ground.dirt.dry': { color: '#8d7d67', accent: '#6f6151', pattern: 'noise', grain: 0.26, roughness: 1 },
  'mat.ground.grass.leafy': { color: '#4d6b34', accent: '#3a5427', pattern: 'noise', grain: 0.3, roughness: 1 },
  'mat.debris.rubble.wall': { color: '#8f877c', accent: '#6c655c', pattern: 'speckle', grain: 0.4, roughness: 1 },
  'mat.debris.gravel.stones': { color: '#96907f', accent: '#736e60', pattern: 'speckle', grain: 0.42, roughness: 1 },
  // Walls
  'mat.wall.concrete.dirty': { color: '#a8a49b', accent: '#8d8981', pattern: 'noise', grain: 0.2 },
  'mat.wall.concrete.plain': { color: '#b6b3ac', accent: '#9b9891', pattern: 'noise', grain: 0.12 },
  'mat.wall.concrete.cracked': { color: '#a09a90', accent: '#7d786f', pattern: 'noise', grain: 0.3 },
  'mat.wall.concrete.layers': { color: '#b0aca4', accent: '#928e86', pattern: 'ribs', grain: 0.14 },
  'mat.wall.concrete.painted': { color: '#c3c0b7', accent: '#a7a49b', pattern: 'noise', grain: 0.1 },
  'mat.wall.brick.red': { color: '#9d5b45', accent: '#c9beae', pattern: 'brick', grain: 0.18, roughness: 0.92 },
  'mat.wall.brick.weathered': { color: '#8e6551', accent: '#bdb3a6', pattern: 'brick', grain: 0.24, roughness: 0.94 },
  'mat.wall.brick.broken': { color: '#8a6252', accent: '#a89c8e', pattern: 'brick', grain: 0.32, roughness: 0.96 },
  'mat.wall.plaster.beige': { color: '#cfc4ad', accent: '#b4a993', pattern: 'noise', grain: 0.1 },
  'mat.wall.plaster.white': { color: '#d8d5cd', accent: '#bcb9b1', pattern: 'noise', grain: 0.09 },
  'mat.wall.plaster.broken': { color: '#bfb5a4', accent: '#95886f', pattern: 'noise', grain: 0.3 },
  'mat.wall.planks': { color: '#8a7255', accent: '#6c5740', pattern: 'planks', grain: 0.22 },
  'mat.wood.planks.weathered': { color: '#8a7255', accent: '#6c5740', pattern: 'planks', grain: 0.22 },
  // Metal
  'mat.metal.corrugated': { color: '#9aa0a2', accent: '#767c7f', pattern: 'ribs', grain: 0.12, roughness: 0.6, metalness: 0.55 },
  'mat.metal.corrugated.worn': { color: '#8b8579', accent: '#6a6559', pattern: 'ribs', grain: 0.24, roughness: 0.75, metalness: 0.4 },
  'mat.metal.panel.factory': { color: '#9a9d99', accent: '#7b7e7a', pattern: 'ribs', grain: 0.16, roughness: 0.65, metalness: 0.5 },
  'mat.metal.container.side': { color: '#7d8a86', accent: '#5e6b67', pattern: 'ribs', grain: 0.2, roughness: 0.7, metalness: 0.5 },
  'mat.metal.plate.industrial': { color: '#8d9195', accent: '#6d7175', pattern: 'noise', grain: 0.14, roughness: 0.55, metalness: 0.7 },
  'mat.metal.shutter.painted': { color: '#8b9099', accent: '#6a6f78', pattern: 'ribs', grain: 0.12, roughness: 0.6, metalness: 0.4 },
  'mat.metal.rust.fine': { color: '#8a6144', accent: '#5f4230', pattern: 'noise', grain: 0.3, roughness: 0.85, metalness: 0.35 },
  'mat.metal.rust.coarse': { color: '#7f5b3f', accent: '#57402d', pattern: 'speckle', grain: 0.36, roughness: 0.9, metalness: 0.3 },
  'mat.metal.grate.rusty': { color: '#6b5c4d', accent: '#463c32', pattern: 'tiles', grain: 0.3, roughness: 0.85, metalness: 0.4 },
  // Roofs
  'mat.roof.bitumen.flat': { color: '#4d4b48', accent: '#3b3936', pattern: 'noise', grain: 0.18, roughness: 0.96 },
  'mat.roof.tiles.grey': { color: '#6f7276', accent: '#575a5e', pattern: 'tiles', grain: 0.16, roughness: 0.88 },
  'mat.roof.tiles.ceramic': { color: '#8f5f45', accent: '#6d4733', pattern: 'tiles', grain: 0.18, roughness: 0.85 },
  // Glass: near-white so the per-vertex tint carries the colour of every
  // window and every shop sign.
  'mat.glass.window': { color: '#eef2f4', accent: '#dfe6ea', pattern: 'plain', grain: 0.03, roughness: 0.12, metalness: 0.05, bump: 0 },
};

/* -------------------------------------------------------------------------- */
/* Texture synthesis                                                          */
/* -------------------------------------------------------------------------- */

const TEX_SIZE = 256;

/** Deterministic 32-bit hash so a given id always synthesises the same grain. */
function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state ^ (state >>> 15), state | 1) + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawAlbedo(look: ILook, seed: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = TEX_SIZE;
  canvas.height = TEX_SIZE;
  const ctx = canvas.getContext('2d')!;
  const rng = makeRng(seed);

  ctx.fillStyle = look.color;
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);

  switch (look.pattern) {
    case 'brick': {
      // Courses of 1/8 the tile height; every other course offset by half.
      const rows = 8;
      const cols = 4;
      const h = TEX_SIZE / rows;
      const w = TEX_SIZE / cols;
      ctx.fillStyle = look.accent;
      ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
      for (let r = 0; r < rows; r++) {
        const offset = (r % 2) * (w / 2);
        for (let c = -1; c <= cols; c++) {
          const shade = 0.82 + rng() * 0.36;
          ctx.fillStyle = tintHex(look.color, shade);
          ctx.fillRect(c * w + offset + 1.5, r * h + 1.5, w - 3, h - 3);
        }
      }
      break;
    }
    case 'slab': {
      const cells = 3;
      const s = TEX_SIZE / cells;
      ctx.fillStyle = look.accent;
      ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
      for (let y = 0; y < cells; y++) {
        for (let x = 0; x < cells; x++) {
          ctx.fillStyle = tintHex(look.color, 0.9 + rng() * 0.2);
          ctx.fillRect(x * s + 1.5, y * s + 1.5, s - 3, s - 3);
        }
      }
      break;
    }
    case 'tiles': {
      const cells = 6;
      const s = TEX_SIZE / cells;
      ctx.fillStyle = look.accent;
      ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
      for (let y = 0; y < cells; y++) {
        for (let x = 0; x < cells; x++) {
          ctx.fillStyle = tintHex(look.color, 0.85 + rng() * 0.3);
          ctx.fillRect(x * s + 1, y * s + 1, s - 2, s - 2);
        }
      }
      break;
    }
    case 'ribs': {
      for (let x = 0; x < TEX_SIZE; x += 8) {
        ctx.fillStyle = tintHex(look.color, 0.78 + (x % 16 === 0 ? 0.34 : 0));
        ctx.fillRect(x, 0, 4, TEX_SIZE);
      }
      break;
    }
    case 'planks': {
      const rows = 6;
      const h = TEX_SIZE / rows;
      for (let r = 0; r < rows; r++) {
        ctx.fillStyle = tintHex(look.color, 0.82 + rng() * 0.34);
        ctx.fillRect(0, r * h + 1, TEX_SIZE, h - 2);
      }
      break;
    }
    default:
      break;
  }

  // Grain, applied on top of every pattern.
  const image = ctx.getImageData(0, 0, TEX_SIZE, TEX_SIZE);
  const data = image.data;
  const amp = look.grain * 255;
  const speckle = look.pattern === 'speckle';
  for (let i = 0; i < data.length; i += 4) {
    const n = (rng() - 0.5) * amp * (speckle && rng() > 0.86 ? 2.6 : 1);
    data[i] = clamp255(data[i] + n);
    data[i + 1] = clamp255(data[i + 1] + n);
    data[i + 2] = clamp255(data[i + 2] + n);
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** Sobel the albedo's luminance into a tangent-space normal map. */
function deriveNormalMap(albedo: HTMLCanvasElement, strength: number): HTMLCanvasElement {
  const src = albedo.getContext('2d')!.getImageData(0, 0, TEX_SIZE, TEX_SIZE).data;
  const out = document.createElement('canvas');
  out.width = TEX_SIZE;
  out.height = TEX_SIZE;
  const ctx = out.getContext('2d')!;
  const image = ctx.createImageData(TEX_SIZE, TEX_SIZE);

  const lum = (x: number, y: number): number => {
    const xi = (x + TEX_SIZE) % TEX_SIZE;
    const yi = (y + TEX_SIZE) % TEX_SIZE;
    const i = (yi * TEX_SIZE + xi) * 4;
    return (src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114) / 255;
  };

  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const dx =
        lum(x - 1, y - 1) + 2 * lum(x - 1, y) + lum(x - 1, y + 1) -
        (lum(x + 1, y - 1) + 2 * lum(x + 1, y) + lum(x + 1, y + 1));
      const dy =
        lum(x - 1, y - 1) + 2 * lum(x, y - 1) + lum(x + 1, y - 1) -
        (lum(x - 1, y + 1) + 2 * lum(x, y + 1) + lum(x + 1, y + 1));
      const nx = dx * strength;
      const ny = dy * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const i = (y * TEX_SIZE + x) * 4;
      image.data[i] = ((nx / len) * 0.5 + 0.5) * 255;
      image.data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
      image.data[i + 2] = ((nz / len) * 0.5 + 0.5) * 255;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return out;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function tintHex(hex: string, factor: number): string {
  const r = clamp255(parseInt(hex.slice(1, 3), 16) * factor);
  const g = clamp255(parseInt(hex.slice(3, 5), 16) * factor);
  const b = clamp255(parseInt(hex.slice(5, 7), 16) * factor);
  return `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
}

/* -------------------------------------------------------------------------- */
/* Material factory                                                           */
/* -------------------------------------------------------------------------- */

/** Builds and caches one stand-in material per manifest id. */
export class FallbackMaterialLibrary {
  private readonly cache = new Map<string, THREE.Material>();
  private readonly disposables: (THREE.Texture | THREE.Material)[] = [];

  constructor(
    private readonly anisotropy: number,
    private readonly decorate: (material: THREE.Material) => THREE.Material
  ) {}

  /** Number of distinct materials synthesised so far. */
  get size(): number {
    return this.cache.size;
  }

  /** Ids synthesised so far, for the harness readout. */
  keys(): string[] {
    return [...this.cache.keys()].sort();
  }

  get(key: string): THREE.Material {
    const cached = this.cache.get(key);
    if (cached) return cached;

    const look: ILook = { ...DEFAULT_LOOK, ...(LOOKS[key] ?? {}) };
    const seed = hash(key);
    const albedo = drawAlbedo(look, seed);
    const map = new THREE.CanvasTexture(albedo);
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.RepeatWrapping;
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = this.anisotropy;
    // One texture tile covers `tileSizeMeters`, and the city already wrote UVs
    // in tile units — so repeat stays at 1 and the density is correct by
    // construction. The lookup is here purely to assert that.
    const tile = MATERIAL_TILE_SIZE[key];
    if (!tile) console.warn(`[city-harness] no tile size for ${key}`);

    const material = new THREE.MeshStandardMaterial({
      map,
      color: 0xffffff,
      roughness: look.roughness,
      metalness: look.metalness,
      vertexColors: true,
    });

    if (look.bump > 0) {
      const normalCanvas = deriveNormalMap(albedo, look.bump * 3);
      const normalMap = new THREE.CanvasTexture(normalCanvas);
      normalMap.wrapS = THREE.RepeatWrapping;
      normalMap.wrapT = THREE.RepeatWrapping;
      normalMap.anisotropy = this.anisotropy;
      material.normalMap = normalMap;
      material.normalScale = new THREE.Vector2(0.8, 0.8);
      this.disposables.push(normalMap);
    }

    if (key === 'mat.road.markings') {
      // Paint sits on the asphalt; offset stops it z-fighting at grazing angles.
      material.polygonOffset = true;
      material.polygonOffsetFactor = -2;
      material.polygonOffsetUnits = -2;
    }

    const decorated = this.decorate(material);
    this.disposables.push(map, decorated);
    this.cache.set(key, decorated);
    return decorated;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.cache.clear();
    this.disposables.length = 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Sky                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A procedural equirectangular sky, used both as the background and — through
 * PMREM — as the scene's environment map.
 *
 * Image-based lighting is doing real work here rather than decorating: without
 * it every surface facing away from the sun is flat ambient grey, glass has
 * nothing to reflect, and the whole city looks like untextured geometry no
 * matter how good the geometry is.
 */
export function buildProceduralSky(renderer: THREE.WebGLRenderer): {
  texture: THREE.Texture;
  environment: THREE.Texture;
} {
  const width = 512;
  const height = 256;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, '#3f74b8');
  gradient.addColorStop(0.42, '#9fc0dd');
  gradient.addColorStop(0.5, '#cdd8e0');
  gradient.addColorStop(0.54, '#aab6c0');
  gradient.addColorStop(1, '#7d8792');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // A soft sun disc so specular highlights have something to come from.
  const sun = ctx.createRadialGradient(width * 0.68, height * 0.24, 0, width * 0.68, height * 0.24, 70);
  sun.addColorStop(0, 'rgba(255, 250, 235, 0.95)');
  sun.addColorStop(1, 'rgba(255, 250, 235, 0)');
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, width, height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromEquirectangular(texture).texture;
  pmrem.dispose();
  return { texture, environment };
}
