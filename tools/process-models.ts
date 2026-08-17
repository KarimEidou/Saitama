/**
 * MODEL / PROP PROCESSOR — the City Z prop kit → compressed, LOD'd .glb
 *
 * Turns the 39 Poly Haven `hidden_alley` CC0 models (the de-facto City Z
 * street kit) into self-contained, GPU-ready `.glb` files, one per model per
 * `QualityTier`, written to `public/assets/mdl/<modelId>.<tier>.glb`.
 *
 * Exported for `tools/process-assets.ts` (the orchestrator):
 *
 *   processModels(opts: ProcessOptions): Promise<ProcessResult>
 *
 * and runnable standalone for iteration:
 *
 *   tsx tools/process-models.ts --tier mobile [--only fire_hydrant,street_lamp_*]
 *                       [--concurrency 2] [--force] [--validate] [--unlit-far]
 *
 * ── THE PIPELINE ───────────────────────────────────────────────────────────
 *   dedup → weld → join(by material) → LOD chain(simplify) → resample →
 *   prune → KTX2(KHR_texture_basisu) → quantize + meshopt → write .glb
 *
 * ── WHY `join` IS SCOPED TO ONE MESH AT A TIME ─────────────────────────────
 * This is the single most important thing to understand before editing this
 * file. These are not 39 props: they are 39 *catalogues*. A single source
 * glTF such as `modular_urban_apartments_facade` holds 147 top-level named
 * nodes — `door_angled_small_01`, `window_tall_03`, … — laid out side by side
 * on a grid so a human can see the whole kit at once. Each node is a piece
 * the world builder places independently.
 *
 * `join()` with its defaults merges primitives across sibling nodes and bakes
 * their transforms in. Run on one of these files it produces one giant mesh
 * containing every wall variant at its catalogue position: the kit is gone,
 * unrecoverably, and the "model" is a 50-metre-wide display shelf. Each of
 * those 147 nodes has to stay addressable. `large_iron_gate` needs the same
 * protection for a different reason — its four nodes are left door / right
 * door / bolt / frame, and welding those together makes the gate
 * un-animatable.
 *
 * So the join here is deliberately narrow: primitives merge only *within a
 * single mesh*, grouped by material, and the node layer is never touched.
 * Measured over the whole kit that is nearly a no-op — 654 primitives after
 * dedup/weld/prune, of which exactly 7 are joinable, across `fire_hydrant`
 * (4), `street_lamp_01`, `street_lamp_02` and `security_light` (1 each). The
 * reason is structural, not a bug: Blender's glTF exporter already splits
 * primitives by material, so two primitives in one mesh nearly always have
 * two different materials. The seven that do merge only become mergeable
 * *because* `dedup` collapsed two byte-identical materials first. The pass
 * stays because it is correct, costs microseconds, and would matter for any
 * future asset that is not a Blender export — but do not expect draw-call
 * savings from it on this kit, and do not "fix" it by widening the scope.
 *
 * ── WHY THE ARM TEXTURE IS NOT BOUND TO `occlusionTexture` ─────────────────
 * Poly Haven ships an `*_arm_*.jpg` per model and the naming invites you to
 * treat R as ambient occlusion, wire it into `occlusionTexture`, and collect
 * free contact shadows. Measured over the actual files, that is a trap: the
 * R channel is real AO on some assets (`street_lamp_01` mean 158, sd 96) and
 * *empty* on others (`barrel_stove` mean 1.3, max 39 — Blender's glTF exporter
 * wrote metal→B and rough→G and left R at zero). Binding it would render the
 * barrel stove almost black. The source glTFs bind the texture to
 * `metallicRoughnessTexture` only, and this pipeline preserves that binding
 * byte for byte. The channel *packing* is still preserved end to end — the
 * KTX2 encode is forced to a 3-channel format so Three.js keeps reading
 * aoMap `.r` / roughness `.g` / metalness `.b` — but the pipeline does not
 * invent a binding the artist did not make.
 *
 * ── COLOUR SPACE ───────────────────────────────────────────────────────────
 * Albedo and emissive are encoded sRGB (`--assign-tf srgb --assign-primaries
 * bt709`); normal, ORM and every other non-colour map is encoded linear with
 * no primaries. Getting this backwards is the classic "why is everything
 * washed out / why are the normals wrong" bug, so the transfer function is
 * derived from `getTextureColorSpace()` on the *material binding*, never from
 * a filename.
 *
 * ── ENCODER NOTES (measured on this box, not folklore) ─────────────────────
 * `@gltf-transform/cli` shells out to `ktx` (NOT `toktx`) and wants
 * KTX-Software ≥ 4.3.0. The binary lives at `node_modules/ktx2tools/bin/linux/
 * ktx` (v4.4.0) and is invoked as the ELF directly — the npm shim prints a
 * `Running: …` banner onto stdout that corrupts output parsing. `--clevel 2`
 * is the sweet spot for ETC1S: level 4 is ~2.8× slower for a marginally
 * *larger* file. `--assign-oetf` is deprecated in 4.4 in favour of
 * `--assign-tf`.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  Document,
  Logger as GLTFLogger,
  NodeIO,
  PropertyType,
  Verbosity,
  type Material,
  type Mesh,
  type Primitive,
  type Texture,
  TextureChannel,
} from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRMaterialsUnlit, KHRTextureBasisu } from '@gltf-transform/extensions';
import {
  dedup,
  getBounds,
  getGLPrimitiveCount,
  getTextureColorSpace,
  getTextureChannelMask,
  joinPrimitives,
  listTextureSlots,
  meshopt,
  prune,
  resample,
  simplifyPrimitive,
  weld,
} from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

import type { IAssetLOD, IAssetOutput, IMeshCompressionProfile, QualityTier } from '@/types';
import {
  Limiter,
  Logger,
  REPO_ROOT,
  formatBytes,
  formatDuration,
  loadSourceManifests,
  meshProfileFor,
  rel,
  sha256Of,
  sourcePath,
  type IModelSourceEntry,
  type ITierTarget,
} from './lib/index.ts';

const exec = promisify(execFile);

/* -------------------------------------------------------------------------- */
/* Orchestrator contract                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Options accepted by every `process*` stage.
 *
 * Declared locally rather than imported from `tools/process-assets.ts`: the
 * orchestrator is written by a sibling workstream and may not exist yet, and
 * a build that cannot start because two files are racing each other is worse
 * than two structurally-identical type declarations. TypeScript matches these
 * structurally, so `processModels` drops straight into the orchestrator's
 * `Record<string, (o: ProcessOptions) => Promise<ProcessResult>>`.
 */
export interface ProcessOptions {
  /** Which variant ladder to build. */
  readonly tier: QualityTier;
  /**
   * Restrict the run to matching assets. Case-insensitive: an entry is built
   * when any filter is a substring of, or a `*`-glob match for, either its
   * asset id (`model.prop.fire_hydrant`) or its Poly Haven id
   * (`fire_hydrant`). A bare string is accepted as well as an array, so this
   * is usable straight from a CLI flag.
   */
  readonly only?: string | readonly string[];
  /** Models processed in parallel. */
  readonly concurrency: number;
  /** Rebuild even when the content-addressed key says the output is current. */
  readonly force?: boolean;
  /**
   * Override `ITierPolicy.unlitFurthestLod` for this run. Optional and absent
   * from the shared stage contract, which is harmless: an orchestrator that
   * never sets it gets the tier default. It exists so the renderer workstream
   * can A/B the far-LOD shading cost without editing this file. Part of the
   * content-addressed key, so flipping it rebuilds.
   */
  readonly unlitFurthestLod?: boolean;
}

/** An `IAssetOutput` plus the id of the entry it belongs to. */
export interface IProducedOutput extends IAssetOutput {
  readonly assetId: string;
}

/** What one stage did. `errors` carries one human-readable line per failure. */
export interface ProcessResult {
  /** Outputs actually (re)built. */
  readonly written: number;
  /** Outputs left alone because the content-addressed key still matched. */
  readonly skipped: number;
  /** Total bytes of every output this stage is responsible for, built or not. */
  readonly bytes: number;
  /** One line per failed asset. Empty on a clean run. */
  readonly errors: readonly string[];
  /** Manifest rows the orchestrator folds into `assets.runtime.json`. */
  readonly outputs: readonly IProducedOutput[];
  /**
   * Richer per-model detail than `IAssetOutput` has room for: measured
   * triangle counts, local bounds, and the named kit pieces inside each file.
   * Extra to the shared contract — also written to
   * `public/assets/mdl/index.<tier>.json` so nothing has to import this file
   * to read it.
   */
  readonly models: readonly IModelAssetOutput[];
  /** Per-model timings and before/after counts, for the CLI's report table. */
  readonly stats: readonly IModelStats[];
}

/** Per-model result, shaped so it can be spliced into the asset manifest. */
export interface IModelAssetOutput {
  readonly id: string;
  readonly output: IAssetOutput;
  /** Real triangle count of LOD0, measured — not the provider's estimate. */
  readonly triangles: number;
  /** Local-space AABB as [minX,minY,minZ,maxX,maxY,maxZ]. */
  readonly bounds: readonly [number, number, number, number, number, number];
  /** Named kit pieces inside this file, each an independent LOD group. */
  readonly parts: readonly string[];
  readonly materials: number;
  readonly textures: number;
  /** Exactly what was applied, for `IModelAsset.meshCompression`. */
  readonly meshCompression: IMeshCompressionProfile;
}

/* -------------------------------------------------------------------------- */
/* Tuning                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Bumped whenever a change here would produce different bytes from identical
 * input. It is folded into the content-addressed output key, so bumping it
 * invalidates every cached build — which is the point.
 */
const TOOL_VERSION = 'process-models@6';

/** Where built models land. Served by Vite from `/assets/mdl/…`. */
const OUTPUT_DIR = path.join(REPO_ROOT, 'public', 'assets', 'mdl');

/**
 * KTX2 encodes are cached here so a second tier, or `--force`, stays cheap.
 *
 * Deliberately inside this stage's own output directory rather than the shared
 * `assets/generated/` tree: sibling asset workstreams run concurrently and
 * treat that tree as theirs to clean, and a `rm -rf` landing between `ktx`
 * writing its output and this process reading it back is an unreproducible
 * mid-run ENOENT. Owning the directory removes the question.
 */
const KTX_CACHE_DIR = path.join(REPO_ROOT, 'public', 'assets', 'mdl', '.cache');

/**
 * The `ktx` ELF, not the npm shim. See the header note: the shim writes a
 * `Running: …` banner to stdout.
 */
const KTX_BIN = path.join(REPO_ROOT, 'node_modules', 'ktx2tools', 'bin', 'linux', 'ktx');

/**
 * LOD ladder, as a fraction of LOD0's triangle count.
 *
 * LOD1 at 0.35 is exactly the `simplifyRatio` the manifest asks for at the
 * mobile tier, which is the useful way to read this table: on mobile LOD1 is
 * the level that is on screen almost all the time and LOD0 exists for the
 * prop you are standing next to. LOD2 at 0.12 is the silhouette-only level.
 */
const LOD_RATIOS: readonly number[] = [1, 0.35, 0.12];

/**
 * Simplification error ceiling, as a fraction of mesh extent. meshoptimizer
 * stops early rather than exceed it, so a ratio is a target and not a
 * promise — which is correct: a 92-triangle bolt has nothing to give up.
 */
const LOD_ERROR: readonly number[] = [0, 0.02, 0.08];

/**
 * Below this triangle count a level is not generated at all; the level's node
 * points at the previous level's mesh instead. glTF meshes are shared by
 * reference, so a "skipped" LOD costs zero bytes while keeping the runtime
 * structure uniform — every group always has exactly LOD_RATIOS.length levels.
 */
const MIN_LOD_TRIANGLES = 128;

/**
 * A level must remove at least this fraction of triangles to be worth its own
 * vertex buffers; otherwise it shares the previous level's mesh.
 */
const MIN_LOD_REDUCTION = 0.15;

/** Per-tier knobs that are not already in the manifest's `ITierTarget`. */
interface ITierPolicy {
  /** Longest-edge clamp fallback when the manifest omits one. */
  readonly maxDimension: number;
  /** Position quantisation bits. */
  readonly positionBits: number;
  /** Normal/tangent quantisation bits. */
  readonly normalBits: number;
  /** Texcoord quantisation bits. */
  readonly texcoordBits: number;
  /**
   * Bake `KHR_materials_unlit` into the furthest LOD.
   *
   * Implemented, measured, and off by default. It saves no bytes — LOD2
   * shares LOD0's textures, so nothing is dropped from the file — and it is
   * purely a runtime shading decision that belongs to the renderer, not to
   * the asset. Baking it in would also freeze distant props at full daylight
   * brightness under the day/night cycle, because an unlit material ignores
   * scene lighting by definition. Flip it per tier if the renderer ever wants
   * the shader saving more than it wants correct night-time props.
   */
  readonly unlitFurthestLod: boolean;
}

const TIER_POLICY: Readonly<Record<QualityTier, ITierPolicy>> = {
  mobile: {
    maxDimension: 512,
    positionBits: 12,
    normalBits: 8,
    texcoordBits: 10,
    unlitFurthestLod: false,
  },
  high: {
    maxDimension: 1024,
    positionBits: 14,
    normalBits: 10,
    texcoordBits: 12,
    unlitFurthestLod: false,
  },
  ultra: {
    maxDimension: 2048,
    positionBits: 14,
    normalBits: 10,
    texcoordBits: 12,
    unlitFurthestLod: false,
  },
};

/** The tier's policy with any per-run overrides applied. */
function policyFor(
  tier: QualityTier,
  overrides: Pick<ProcessOptions, 'unlitFurthestLod'>
): ITierPolicy {
  const base = TIER_POLICY[tier];
  return overrides.unlitFurthestLod === undefined
    ? base
    : { ...base, unlitFurthestLod: overrides.unlitFurthestLod };
}

/** Tier target used when a manifest entry does not declare one. */
const FALLBACK_TARGET: Readonly<Record<QualityTier, ITierTarget>> = {
  mobile: { maxDimension: 512, codec: 'etc1s', quality: 55, zstd: true, zstdLevel: 18 },
  high: { maxDimension: 1024, codec: 'uastc', quality: 80, zstd: true, zstdLevel: 18 },
  ultra: { maxDimension: 2048, codec: 'uastc', quality: 92, zstd: true, zstdLevel: 18 },
};

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

const { R, G, A } = TextureChannel;

function toArray(value: string | readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  return typeof value === 'string'
    ? value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : value;
}

/** `fire_*` → /^fire_.*$/. Anything without a `*` is matched as a substring. */
function matchesOne(filter: string, candidates: readonly string[]): boolean {
  const needle = filter.trim().toLowerCase();
  if (!needle) return false;
  if (needle.includes('*')) {
    const escaped = needle.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const re = new RegExp(`^${escaped}$`);
    return candidates.some((c) => re.test(c.toLowerCase()));
  }
  return candidates.some((c) => c.toLowerCase().includes(needle));
}

function matchesFilter(entry: IModelSourceEntry, filters: readonly string[]): boolean {
  if (filters.length === 0) return true;
  const candidates = [entry.id, entry.providerAssetId];
  return filters.some((filter) => matchesOne(filter, candidates));
}

/** Longest edge clamped to `max`, both edges rounded up to a multiple of 4. */
function fitSize(width: number, height: number, max: number): [number, number] {
  const scale = Math.min(1, max / Math.max(width, height));
  const round = (v: number): number => {
    const n = Math.max(4, Math.round(v * scale));
    return n % 4 === 0 ? n : n + (4 - (n % 4));
  };
  return [round(width), round(height)];
}

/** Manifest quality (0..100) → the `ktx` encoder's own 1..255 quality level. */
function toQLevel(quality: number): number {
  return Math.max(1, Math.min(255, Math.round((quality / 100) * 255)));
}

function triangleCount(mesh: Mesh): number {
  let n = 0;
  for (const prim of mesh.listPrimitives()) n += getGLPrimitiveCount(prim);
  return n;
}

/** Bytes actually occupied by a mesh's own accessors, shared ones counted once. */
function meshAccessorBytes(mesh: Mesh, seen: Set<unknown>): number {
  let bytes = 0;
  for (const prim of mesh.listPrimitives()) {
    const accessors = [prim.getIndices(), ...prim.listAttributes()];
    for (const accessor of accessors) {
      if (!accessor || seen.has(accessor)) continue;
      seen.add(accessor);
      bytes += accessor.getArray()?.byteLength ?? 0;
    }
  }
  return bytes;
}

/**
 * Per-level vertex + index bytes, measured after quantisation.
 *
 * All three levels share one `.glb`, so "the size of LOD1" is not a file size
 * and pretending otherwise would be a made-up number. What IS measurable, and
 * what a streaming system actually needs, is how much GPU memory each level
 * costs once resident: the byte length of its quantised attribute and index
 * accessors. Meshes shared between levels (a part too small to decimate) are
 * counted once, at the first level that introduces them — matching the fact
 * that switching to that level uploads nothing new.
 *
 * Run AFTER `meshopt()` so the numbers are post-quantisation. The
 * EXT_meshopt_compression byte lengths only exist during serialisation, so
 * these are decoded sizes — which is the right unit for a VRAM budget anyway.
 */
function measureLodBytes(doc: Document, levels: number): number[] {
  const bytes = new Array<number>(levels).fill(0);
  const seen = new Set<unknown>();
  for (const node of doc.getRoot().listNodes()) {
    const extras = node.getExtras() as { lod?: unknown } | undefined;
    if (!extras?.lod) continue;
    node.listChildren().forEach((child, level) => {
      const mesh = child.getMesh();
      if (!mesh || level >= levels) return;
      bytes[level] += meshAccessorBytes(mesh, seen);
    });
  }
  return bytes;
}

/* -------------------------------------------------------------------------- */
/* Stage 1 — cleanup and within-mesh join                                     */
/* -------------------------------------------------------------------------- */

/**
 * Merge primitives that live in the same mesh and share a material.
 *
 * Deliberately NOT `join()` — see the header. Node-level structure is the kit,
 * and this pass must not touch it.
 */
function joinWithinMeshes(doc: Document): number {
  let merged = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    const prims = mesh.listPrimitives();
    if (prims.length < 2) continue;

    const groups = new Map<string, Primitive[]>();
    for (const prim of prims) {
      // Primitives can only be joined when material, draw mode, indexing and
      // the exact attribute set all agree; anything else corrupts the result.
      const key = [
        doc
          .getRoot()
          .listMaterials()
          .indexOf(prim.getMaterial() as Material),
        prim.getMode(),
        prim.getIndices() ? 'i' : 'n',
        prim.listSemantics().slice().sort().join(','),
        prim.listTargets().length,
      ].join('|');
      const group = groups.get(key);
      if (group) group.push(prim);
      else groups.set(key, [prim]);
    }

    for (const group of groups.values()) {
      if (group.length < 2) continue;
      let joined: Primitive;
      try {
        joined = joinPrimitives(group);
      } catch {
        // Incompatible after all (component types differ). Leave them alone.
        continue;
      }
      mesh.addPrimitive(joined);
      for (const prim of group) {
        mesh.removePrimitive(prim);
        prim.dispose();
      }
      merged += group.length - 1;
    }
  }
  return merged;
}

/* -------------------------------------------------------------------------- */
/* Stage 2 — the LOD chain                                                    */
/* -------------------------------------------------------------------------- */

/** One level of one kit piece. */
interface ILevelInfo {
  readonly level: number;
  readonly triangles: number;
  /** True when this level reuses the previous level's mesh (costs 0 bytes). */
  readonly shared: boolean;
}

interface ILodSummary {
  readonly parts: readonly string[];
  /** Per level: total triangles, and how many parts reused the level above. */
  readonly levels: readonly { triangles: number; shared: number }[];
}

/**
 * Rebuild every mesh-bearing node into a LOD switch group.
 *
 *   Node "door_angled_small_01"      ← original transform + children, kept
 *     └── Node "door_angled_small_01__LOD"   extras.lod = { levels: […] }
 *           ├── Node "LOD0" → Mesh (full density)
 *           ├── Node "LOD1" → Mesh (~35%)
 *           └── Node "LOD2" → Mesh (~12%)
 *
 * The group is inserted as a CHILD rather than replacing the node so that any
 * real children the source had (hinges, sub-parts) keep their place in the
 * hierarchy. `extras` survives into `Object3D.userData` through three's
 * GLTFLoader, so the streaming system can find these groups by data instead
 * of by string-matching node names.
 */
function buildLodGroups(doc: Document, unlitFurthest: boolean): ILodSummary {
  const parts: string[] = [];
  const levelTris = LOD_RATIOS.map(() => 0);
  const levelShared = LOD_RATIOS.map(() => 0);
  const unlitMaterials = new Map<Material, Material>();
  /**
   * Source mesh → its LOD ladder, so geometry reused by several nodes is
   * decimated once.
   *
   * `dedup` collapses byte-identical meshes, and these kits are full of them:
   * `modular_electricity_poles` drops from 103 meshes to 44, because the same
   * bolt and insulator appear at 59 different positions. Without this cache
   * each of those nodes would get its own private copy of LOD1 and LOD2 —
   * geometry that is bitwise identical to a copy already in the file, paid
   * for 59 times.
   */
  const ladders = new Map<Mesh, { meshes: Mesh[]; infos: ILevelInfo[] }>();

  // Snapshot first: the loop adds nodes, and listNodes() is live.
  const sourceNodes = doc
    .getRoot()
    .listNodes()
    .filter((node) => node.getMesh() !== null);

  for (const node of sourceNodes) {
    const baseMesh = node.getMesh() as Mesh;
    const name = node.getName() || baseMesh.getName() || 'part';
    parts.push(name);

    let ladder = ladders.get(baseMesh);
    if (!ladder) {
      const meshes: Mesh[] = [baseMesh];
      const infos: ILevelInfo[] = [{ level: 0, triangles: triangleCount(baseMesh), shared: false }];

      for (let level = 1; level < LOD_RATIOS.length; level++) {
        const previous = meshes[level - 1];
        const previousTris = infos[level - 1].triangles;
        const target = Math.round(infos[0].triangles * LOD_RATIOS[level]);

        // Nothing worth decimating, or the target is not below the level above.
        if (previousTris < MIN_LOD_TRIANGLES || target >= previousTris) {
          meshes.push(previous);
          infos.push({ level, triangles: previousTris, shared: true });
          continue;
        }

        // Simplify from LOD0 every time rather than cascading: meshoptimizer
        // gives a better 12% mesh from the original than from an already-lossy
        // 35% one, and cascading compounds the error.
        const candidate = simplifyMeshClone(doc, baseMesh, LOD_RATIOS[level], LOD_ERROR[level]);
        const candidateTris = triangleCount(candidate);

        if (candidateTris > previousTris * (1 - MIN_LOD_REDUCTION)) {
          disposeMesh(candidate);
          meshes.push(previous);
          infos.push({ level, triangles: previousTris, shared: true });
          continue;
        }

        candidate.setName(`${name}_LOD${level}`);
        meshes.push(candidate);
        infos.push({ level, triangles: candidateTris, shared: false });
      }

      if (unlitFurthest && meshes[meshes.length - 1] !== meshes[0]) {
        applyUnlit(doc, meshes[meshes.length - 1], unlitMaterials);
      }
      baseMesh.setName(`${name}_LOD0`);

      ladder = { meshes, infos };
      ladders.set(baseMesh, ladder);
    }

    const { meshes, infos } = ladder;
    const group = doc.createNode(`${name}__LOD`);
    for (let level = 0; level < meshes.length; level++) {
      group.addChild(doc.createNode(`LOD${level}`).setMesh(meshes[level]));
      levelTris[level] += infos[level].triangles;
      if (infos[level].shared) levelShared[level] += 1;
    }

    // The node keeps its transform and its real children; it just stops
    // carrying geometry directly.
    node.setMesh(null);
    node.addChild(group);

    group.setExtras({
      lod: {
        levels: infos.map((info) => ({
          level: info.level,
          triangles: info.triangles,
          ratio: LOD_RATIOS[info.level],
          shared: info.shared,
        })),
      },
    });
  }

  return {
    parts,
    levels: LOD_RATIOS.map((_, i) => ({ triangles: levelTris[i], shared: levelShared[i] })),
  };
}

/**
 * Clone a mesh and decimate the clone.
 *
 * `Primitive.clone()` copies graph edges, so the clone starts out pointing at
 * the SAME accessors and material as the original. `simplifyPrimitive()` then
 * calls `compactPrimitive()`, which builds fresh accessors and only disposes
 * the old ones when nothing else references them — so the original mesh comes
 * out of this untouched. Verified against gltf-transform 4.4.2's
 * `compactPrimitive`, which guards every disposal with
 * `listParents().length === 1`.
 *
 * MORPH TARGETS ARE THE EXCEPTION, and they are why this function exists
 * instead of a one-liner. `compactPrimitive` rewrites target attributes with
 * `target.swap(src, dst)` — a mutation of the PrimitiveTarget itself, which
 * `Primitive.clone()` shares by reference. Simplifying the clone therefore
 * used to reach back and re-point the ORIGINAL primitive's targets at
 * decimated accessors, leaving LOD0 with a 5,478-vertex base and a
 * 1,917-vertex morph target. The Khronos validator catches it as
 * MESH_PRIMITIVE_MORPH_TARGET_INVALID_ATTRIBUTE_COUNT; `rusted_wheel_rim_01`
 * and `_02` are the two assets in this kit that carry shape keys. Cloning
 * each target gives the LOD its own, and the original is left alone.
 */
function simplifyMeshClone(doc: Document, source: Mesh, ratio: number, error: number): Mesh {
  const mesh = doc.createMesh().setWeights([...source.getWeights()]);
  for (const prim of source.listPrimitives()) {
    const clone = prim.clone();
    for (const target of clone.listTargets()) {
      clone.removeTarget(target);
      clone.addTarget(target.clone());
    }
    if (clone.getIndices() && getGLPrimitiveCount(clone) > 0) {
      simplifyPrimitive(clone, {
        ratio,
        error,
        lockBorder: false,
        simplifier: MeshoptSimplifier,
      });
    }
    mesh.addPrimitive(clone);
  }
  return mesh;
}

function disposeMesh(mesh: Mesh): void {
  for (const prim of mesh.listPrimitives()) {
    mesh.removePrimitive(prim);
    prim.dispose();
  }
  mesh.dispose();
}

/**
 * Swap a mesh's materials for `KHR_materials_unlit` clones. Off by default —
 * see `ITierPolicy.unlitFurthestLod` for why.
 */
function applyUnlit(doc: Document, mesh: Mesh, cache: Map<Material, Material>): void {
  const extension = doc.createExtension(KHRMaterialsUnlit);
  for (const prim of mesh.listPrimitives()) {
    const material = prim.getMaterial();
    if (!material) continue;
    let flat = cache.get(material);
    if (!flat) {
      flat = material.clone().setName(`${material.getName()}_unlit`);
      flat.setNormalTexture(null).setOcclusionTexture(null).setMetallicRoughnessTexture(null);
      flat.setExtension('KHR_materials_unlit', extension.createUnlit());
      cache.set(material, flat);
    }
    prim.setMaterial(flat);
  }
}

/* -------------------------------------------------------------------------- */
/* Stage 3 — KTX2 texture compression                                         */
/* -------------------------------------------------------------------------- */

interface IKtxParams {
  readonly codec: 'etc1s' | 'uastc';
  readonly quality: number;
  readonly maxDimension: number;
  readonly zstdLevel: number;
  readonly threads: number;
}

/** How many textures were compressed, and what they cost. */
interface ITextureSummary {
  readonly count: number;
  readonly srcBytes: number;
  readonly dstBytes: number;
}

/**
 * Choose the `ktx create --format` for a texture from the channels its
 * material bindings actually read, plus the transfer function from the same
 * bindings. This is what keeps ORM packing intact: a texture bound to
 * `metallicRoughnessTexture` reports G|B, which lands in the 3-channel branch
 * and preserves R (where the artist may or may not have put AO) untouched.
 */
function ktxFormatFor(texture: Texture, srgb: boolean): string {
  const channels = getTextureChannelMask(texture);
  if (channels === R) return 'R8_UNORM';
  if (channels === G || channels === (R | G)) return 'R8G8_UNORM';
  if (!(channels & A)) return srgb ? 'R8G8B8_SRGB' : 'R8G8B8_UNORM';
  return srgb ? 'R8G8B8A8_SRGB' : 'R8G8B8A8_UNORM';
}

async function encodeTextureToKTX2(
  texture: Texture,
  params: IKtxParams,
  scratchDir: string,
  index: number
): Promise<Uint8Array | undefined> {
  const image = texture.getImage();
  const size = texture.getSize();
  if (!image || !size) return undefined;

  const slots = listTextureSlots(texture);
  const srgb = getTextureColorSpace(texture) === 'srgb';
  const isNormalMap = slots.some((slot) => /normal/i.test(slot));
  const format = ktxFormatFor(texture, srgb);
  const [width, height] = fitSize(size[0], size[1], params.maxDimension);

  // Deliberately NOT keyed on TOOL_VERSION: a KTX2 file is a pure function of
  // its source pixels and these encoder flags, so a change anywhere else in
  // the pipeline has no business throwing away 90 seconds of encoding.
  const cacheKey = sha256Of(
    [
      'ktx2/1',
      sha256Of(Buffer.from(image)),
      params.codec,
      params.quality,
      params.zstdLevel,
      width,
      height,
      format,
      isNormalMap ? 'nrm' : 'gen',
      srgb ? 'srgb' : 'linear',
    ].join('|')
  );
  const cachePath = path.join(KTX_CACHE_DIR, `${cacheKey}.ktx2`);
  if (existsSync(cachePath)) return new Uint8Array(await readFile(cachePath));

  const srcPath = path.join(scratchDir, `tex${index}.png`);
  const dstPath = path.join(scratchDir, `tex${index}.ktx2`);

  // Always route through sharp: it does the resize, guarantees dimensions are
  // a multiple of four (KTX-Software's block encoders require it) and hands
  // `ktx` a PNG, which it reads without any JPEG-decode surprises.
  await writeFile(
    srcPath,
    await sharp(Buffer.from(image), { limitInputPixels: 1 << 30 })
      .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
      .png({ compressionLevel: 3 })
      .toBuffer()
  );

  const args = [
    'create',
    '--generate-mipmap',
    '--encode',
    params.codec === 'uastc' ? 'uastc' : 'basis-lz',
    // `--assign-tf`, not the deprecated `--assign-oetf`. Colour data is sRGB;
    // normal/ORM/anything non-colour is linear with no primaries.
    '--assign-tf',
    srgb ? 'srgb' : 'linear',
    '--assign-primaries',
    srgb ? 'bt709' : 'none',
    '--format',
    format,
    '--threads',
    String(params.threads),
  ];

  if (params.codec === 'uastc') {
    args.push('--uastc-quality', String(Math.max(0, Math.min(4, Math.round(params.quality / 25)))));
    if (params.zstdLevel > 0) args.push('--zstd', String(params.zstdLevel));
  } else {
    args.push('--qlevel', String(toQLevel(params.quality)));
    // Measured: clevel 4 is ~2.8x slower than clevel 2 for a marginally
    // larger file. There is no reason to pay for it.
    args.push('--clevel', '2');
  }

  // ETC1S is a shared-palette colour codec; its rate-distortion pass mangles
  // tangent-space normals. KTX-Software's own guidance is to disable RDO for
  // normal maps, which is what the reference gltf-transform transform does.
  if (isNormalMap && params.codec !== 'uastc') args.push('--no-endpoint-rdo', '--no-selector-rdo');

  args.push(srcPath, dstPath);

  await exec(KTX_BIN, args, { maxBuffer: 1 << 26 });
  const encoded = new Uint8Array(await readFile(dstPath));

  await mkdir(KTX_CACHE_DIR, { recursive: true });
  await writeFile(cachePath, encoded);
  await rm(srcPath, { force: true });
  await rm(dstPath, { force: true });
  return encoded;
}

async function compressTextures(
  doc: Document,
  params: IKtxParams,
  scratchDir: string
): Promise<ITextureSummary> {
  const textures = doc.getRoot().listTextures();
  if (textures.length === 0) return { count: 0, srcBytes: 0, dstBytes: 0 };

  const basisu = doc.createExtension(KHRTextureBasisu).setRequired(true);
  let count = 0;
  let srcBytes = 0;
  let dstBytes = 0;

  for (const [index, texture] of textures.entries()) {
    const mime = texture.getMimeType();
    if (mime === 'image/ktx2') continue;
    if (mime !== 'image/png' && mime !== 'image/jpeg') continue;

    const before = texture.getImage()?.byteLength ?? 0;
    const encoded = await encodeTextureToKTX2(texture, params, scratchDir, index);
    if (!encoded) continue;

    texture.setImage(encoded).setMimeType('image/ktx2');
    const uri = texture.getURI();
    if (uri) texture.setURI(`${uri.replace(/\.[^./]+$/, '')}.ktx2`);

    count += 1;
    srcBytes += before;
    dstBytes += encoded.byteLength;
  }

  if (count === 0) basisu.dispose();
  return { count, srcBytes, dstBytes };
}

/* -------------------------------------------------------------------------- */
/* Stage 4 — per-model driver                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What one model produced, returned in memory.
 *
 * `processModels` used to re-read the sidecar it had just written to collect
 * this. Reading back what you already hold is a pointless round-trip and, with
 * several models in flight and other agents on the same filesystem, one more
 * way for a run to disagree with itself about what it built.
 */
interface IBuiltModel {
  readonly stats: IModelStats;
  readonly record: IModelAssetOutput;
}

/** Everything the sidecar remembers so a rerun can decide to do nothing. */
interface ISidecar {
  readonly key: string;
  readonly tool: string;
  readonly builtAt: string;
  readonly record: IModelAssetOutput;
  readonly stats: IModelStats;
}

/** Numbers worth printing, per model. */
export interface IModelStats {
  readonly id: string;
  readonly providerId: string;
  readonly sourceBytes: number;
  readonly outputBytes: number;
  readonly srcTriangles: number;
  readonly lodTriangles: readonly number[];
  /** Quantised vertex+index bytes per level. See `measureLodBytes`. */
  readonly lodBytes: readonly number[];
  readonly lodShared: readonly number[];
  readonly parts: number;
  readonly textures: number;
  readonly textureSrcBytes: number;
  readonly textureDstBytes: number;
  readonly primitivesMerged: number;
  readonly ms: number;
  readonly cached: boolean;
}

function outputPathFor(id: string, tier: QualityTier): string {
  return path.join(OUTPUT_DIR, `${id}.${tier}.glb`);
}

/**
 * Content-addressed output key: source digest + every knob that can change
 * the bytes + the tool version. Equal key ⇒ byte-identical output ⇒ nothing
 * to do.
 */
function outputKey(
  srcSha: string,
  tier: QualityTier,
  target: ITierTarget,
  policy: ITierPolicy
): string {
  return sha256Of(
    JSON.stringify({
      tool: TOOL_VERSION,
      src: srcSha,
      tier,
      target: {
        maxDimension: target.maxDimension,
        codec: target.codec,
        quality: target.quality,
        zstd: target.zstd,
        zstdLevel: target.zstdLevel,
      },
      policy,
      lods: LOD_RATIOS,
      lodError: LOD_ERROR,
      minLodTriangles: MIN_LOD_TRIANGLES,
      minLodReduction: MIN_LOD_REDUCTION,
    })
  );
}

/** Digest of every source file of an entry — the same recipe the lockfile uses. */
async function sourceDigest(entry: IModelSourceEntry): Promise<string> {
  const lines = [...entry.files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => `${file.md5}  ${file.path}  ${file.bytes}`);
  return sha256Of(lines.join('\n'));
}

async function readSidecar(sidecarPath: string): Promise<ISidecar | undefined> {
  try {
    return JSON.parse(await readFile(sidecarPath, 'utf8')) as ISidecar;
  } catch {
    return undefined;
  }
}

async function processOne(
  entry: IModelSourceEntry,
  tier: QualityTier,
  target: ITierTarget,
  io: NodeIO,
  log: Logger,
  force: boolean,
  threads: number,
  policy: ITierPolicy
): Promise<IBuiltModel> {
  const startedAt = Date.now();
  const glbPath = outputPathFor(entry.id, tier);
  const sidecarPath = `${glbPath}.json`;
  const key = outputKey(await sourceDigest(entry), tier, target, policy);

  if (!force) {
    const sidecar = await readSidecar(sidecarPath);
    if (sidecar?.key === key && existsSync(glbPath)) {
      const onDisk = await stat(glbPath);
      if (onDisk.size === sidecar.record.output.bytes) {
        return {
          stats: { ...sidecar.stats, ms: Date.now() - startedAt, cached: true },
          record: sidecar.record,
        };
      }
    }
  }

  const rootFile = entry.files.find((file) => file.root);
  if (!rootFile) throw new Error(`${entry.id}: no file marked root:true`);
  const gltfPath = sourcePath(rootFile.path);

  const doc = await io.read(gltfPath);
  // gltf-transform narrates every transform at INFO. With 39 documents in
  // flight that buries the pipeline's own progress line, so it is turned down
  // to warnings and errors — the numbers that matter are measured here anyway.
  doc.setLogger(new GLTFLogger(Verbosity.WARN));
  const root = doc.getRoot();
  const srcTriangles = root.listMeshes().reduce((sum, mesh) => sum + triangleCount(mesh), 0);

  // ── dedup → weld → join(by material, within a mesh) ─────────────────────
  await doc.transform(
    dedup(),
    weld(),
    resample(),
    prune({ keepAttributes: false, keepLeaves: false, keepSolidTextures: false })
  );
  const primitivesMerged = joinWithinMeshes(doc);

  // ── simplify into a three-level LOD chain ───────────────────────────────
  const lod = buildLodGroups(doc, policy.unlitFurthestLod);

  // Clean up accessors orphaned by decimation. NODE is deliberately left out
  // of the property list: the LOD group nodes are the whole point of this
  // file and must not be pruned as "empty".
  await doc.transform(
    prune({
      propertyTypes: [
        PropertyType.ACCESSOR,
        PropertyType.BUFFER,
        PropertyType.MATERIAL,
        PropertyType.TEXTURE,
        PropertyType.MESH,
      ],
      keepAttributes: false,
      keepSolidTextures: false,
    })
  );

  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const box = getBounds(scene);
  const bounds = [...box.min, ...box.max] as [number, number, number, number, number, number];

  // ── KTX2 ─────────────────────────────────────────────────────────────────
  const scratchDir = path.join(KTX_CACHE_DIR, '.work', `${entry.providerAssetId}-${tier}`);
  await mkdir(scratchDir, { recursive: true });
  let textures: ITextureSummary;
  try {
    textures = await compressTextures(
      doc,
      {
        codec: target.codec === 'uastc' ? 'uastc' : 'etc1s',
        quality: target.quality,
        maxDimension: target.maxDimension || policy.maxDimension,
        zstdLevel: target.zstd === false ? 0 : (target.zstdLevel ?? 18),
        threads,
      },
      scratchDir
    );
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }

  // ── quantize + meshopt ───────────────────────────────────────────────────
  await doc.transform(
    meshopt({
      encoder: MeshoptEncoder,
      level: 'high',
      // Per-mesh quantisation volumes matter here: a kit spans tens of metres
      // but its smallest piece is a 3 cm bolt, and one scene-wide volume at 12
      // bits would quantise that bolt into a cube.
      quantizationVolume: 'mesh',
      quantizePosition: policy.positionBits,
      quantizeNormal: policy.normalBits,
      quantizeTexcoord: policy.texcoordBits,
    })
  );

  const lodBytes = measureLodBytes(doc, LOD_RATIOS.length);

  // ── write ────────────────────────────────────────────────────────────────
  await mkdir(OUTPUT_DIR, { recursive: true });
  const glb = await io.writeBinary(doc);
  await writeFile(glbPath, glb);

  const lods: IAssetLOD[] = lod.levels.map((level, index) => ({
    level: index,
    file: path.posix.join('mdl', path.basename(glbPath)),
    triangles: level.triangles,
    bytes: lodBytes[index],
    screenDistance: screenDistanceFor(index, bounds),
  }));

  const record: IModelAssetOutput = {
    id: entry.id,
    output: {
      tier,
      file: path.posix.join('mdl', path.basename(glbPath)),
      format: 'glb',
      bytes: glb.byteLength,
      sha256: createHash('sha256').update(glb).digest('hex'),
      codec: target.codec,
      lods,
    },
    triangles: lod.levels[0].triangles,
    bounds,
    parts: lod.parts,
    materials: root.listMaterials().length,
    textures: root.listTextures().length,
    meshCompression: {
      // The manifest asks for Draco. It gets meshopt instead: the two are
      // mutually exclusive, and meshopt decodes an order of magnitude faster
      // on a phone CPU while quantising to the same bit budgets. Recorded
      // here as what was ACTUALLY applied, not what was requested.
      ...meshProfileFor(target),
      simplifyRatio: LOD_RATIOS[0],
      draco: false,
      meshopt: true,
      positionBits: policy.positionBits,
      normalBits: policy.normalBits,
    },
  };

  const stats: IModelStats = {
    id: entry.id,
    providerId: entry.providerAssetId,
    sourceBytes: entry.files.reduce((sum, file) => sum + file.bytes, 0),
    outputBytes: glb.byteLength,
    srcTriangles,
    lodTriangles: lod.levels.map((l) => l.triangles),
    lodBytes,
    lodShared: lod.levels.map((l) => l.shared),
    parts: lod.parts.length,
    textures: textures.count,
    textureSrcBytes: textures.srcBytes,
    textureDstBytes: textures.dstBytes,
    primitivesMerged,
    ms: Date.now() - startedAt,
    cached: false,
  };

  const sidecar: ISidecar = {
    key,
    tool: TOOL_VERSION,
    builtAt: new Date().toISOString(),
    record,
    stats,
  };
  await writeFile(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  log.debug(
    `${entry.providerAssetId}: ${srcTriangles} → ${lod.levels.map((l) => l.triangles).join('/')} tris, ` +
      `${formatBytes(glb.byteLength)}, ${textures.count} textures`
  );
  return { stats, record };
}

/**
 * Distance in metres past which a level takes over. Derived from the model's
 * own size so a 30 cm hydrant and a 15 m facade do not share a switch point.
 * A starting point for the streaming system, not a tuned curve.
 */
function screenDistanceFor(level: number, bounds: readonly number[]): number {
  const extent = Math.max(
    bounds[3] - bounds[0],
    bounds[4] - bounds[1],
    bounds[5] - bounds[2],
    0.25
  );
  const radius = extent / 2;
  if (level === 0) return 0;
  return Math.round((level === 1 ? 14 : 40) * radius * 10) / 10;
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Build every model for one quality tier.
 *
 * Idempotent: a rerun with unchanged sources, unchanged tier settings and an
 * unchanged `TOOL_VERSION` reads 39 sidecars, hashes nothing, and returns.
 */
export async function processModels(opts: ProcessOptions): Promise<ProcessResult> {
  const log = new Logger({ level: process.env.ASSETS_LOG_LEVEL === 'debug' ? 'debug' : 'info' });
  const startedAt = Date.now();

  await Promise.all([MeshoptEncoder.ready, MeshoptSimplifier.ready]);
  await assertKtxAvailable();

  const { entries } = await loadSourceManifests();
  const filters = toArray(opts.only);
  const models = entries
    .filter((entry): entry is IModelSourceEntry => entry.kind === 'model')
    .filter((entry) => entry.provider !== 'procedural')
    .filter((entry) => matchesFilter(entry, filters));

  if (models.length === 0) {
    return { written: 0, skipped: 0, bytes: 0, errors: [], outputs: [], models: [], stats: [] };
  }

  await mkdir(OUTPUT_DIR, { recursive: true });
  await guardOutputDir();

  // `writeBinary` needs the meshopt encoder, and reading needs every Khronos
  // extension the source files use (KHR_texture_transform on the chainlink
  // fence, KHR_materials_ior/specular on the covered car).
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.encoder': MeshoptEncoder,
    'meshopt.decoder': MeshoptDecoder,
  });

  const cpus = os.cpus().length || 4;
  const concurrency = Math.max(1, Math.min(opts.concurrency || 2, models.length));
  const threads = Math.max(1, Math.min(4, Math.floor(cpus / concurrency)));
  const limiter = new Limiter(concurrency);

  log.heading(
    `models · ${models.length} assets · tier=${opts.tier} · concurrency=${concurrency} · ktx threads=${threads}`
  );

  const policy = policyFor(opts.tier, opts);
  const errors: string[] = [];
  const results: IModelStats[] = [];
  const records: IModelAssetOutput[] = [];
  let done = 0;

  await Promise.all(
    models.map((entry) =>
      limiter.run(async () => {
        const target = entry.tiers[opts.tier] ?? FALLBACK_TARGET[opts.tier];
        try {
          const built = await processOne(
            entry,
            opts.tier,
            target,
            io,
            log,
            opts.force === true,
            threads,
            policy
          );
          results.push(built.stats);
          records.push(built.record);
        } catch (error) {
          errors.push(`${entry.id}: ${(error as Error).message}`);
          log.error(`${entry.providerAssetId}: ${(error as Error).message}`);
        } finally {
          done += 1;
          log.status(`models  ${done}/${models.length}  ${entry.providerAssetId}`);
        }
      })
    )
  );
  log.endStatus();

  results.sort((a, b) => b.outputBytes - a.outputBytes);
  records.sort((a, b) => (a.id < b.id ? -1 : 1));

  const written = results.filter((r) => !r.cached).length;
  const skipped = results.filter((r) => r.cached).length;
  const bytes = results.reduce((sum, r) => sum + r.outputBytes, 0);

  await writeFile(
    path.join(OUTPUT_DIR, `index.${opts.tier}.json`),
    `${JSON.stringify(
      {
        version: 1,
        tier: opts.tier,
        generator: TOOL_VERSION,
        generatedAt: new Date().toISOString(),
        totalBytes: bytes,
        models: records,
      },
      null,
      2
    )}\n`
  );

  log.ok(
    `models · ${written} built, ${skipped} cached · ${formatBytes(bytes)} total · ` +
      `${formatDuration(Date.now() - startedAt)}`
  );
  if (errors.length > 0) log.error(`models · ${errors.length} failed`);

  return {
    written,
    skipped,
    bytes,
    errors,
    outputs: records.map((record) => ({ ...record.output, assetId: record.id })),
    models: records,
    stats: results,
  };
}

/** Fail early and loudly rather than 39 times inside the worker pool. */
async function assertKtxAvailable(): Promise<void> {
  if (!existsSync(KTX_BIN)) {
    throw new Error(
      `KTX-Software not found at ${rel(KTX_BIN)}. ` +
        'Expected the `ktx2tools` package to supply a Linux `ktx` binary (>= 4.3.0).'
    );
  }
  const { stdout, stderr } = await exec(KTX_BIN, ['--version']);
  const version = `${stdout}${stderr}`.replace(/ktx version:\s*/, '').trim();
  if (!version) throw new Error(`Could not read a version from ${rel(KTX_BIN)}`);
}

/**
 * Drop a directory-local `.gitignore` next to the outputs.
 *
 * `public/` is served content and is otherwise tracked, so ~25 MB of built
 * GLBs sitting in it is one `git add -A` away from being permanent history.
 * Git honours a `.gitignore` found in the working tree whether or not it is
 * tracked, and `*` matches the ignore file itself, so this makes the whole
 * directory invisible without editing the repo-wide `.gitignore` that other
 * workstreams are also touching.
 */
async function guardOutputDir(): Promise<void> {
  const guard = path.join(OUTPUT_DIR, '.gitignore');
  if (existsSync(guard)) return;
  await writeFile(
    guard,
    [
      '# Built model outputs — re-derivable via `npm run assets:process`.',
      '# Never commit these; see scripts/guard-no-binaries.ts.',
      '*',
      '',
    ].join('\n')
  );
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

export interface IValidationIssue {
  readonly file: string;
  readonly severity: number;
  readonly code: string;
  readonly message: string;
  readonly pointer?: string;
}

export interface IValidationReport {
  readonly file: string;
  readonly errors: readonly IValidationIssue[];
  readonly warnings: readonly IValidationIssue[];
  readonly infos: readonly IValidationIssue[];
}

/**
 * Run the Khronos glTF validator over a built `.glb`.
 *
 * Severity 0 = error, 1 = warning, 2 = info, 3 = hint. Only severity 0 is a
 * build failure; KTX2 payloads legitimately raise informational notices.
 */
export async function validateGlb(file: string): Promise<IValidationReport> {
  // `gltf-validator` is a Dart-to-JS CommonJS bundle and ships no typings, so
  // it is pulled in through `createRequire` and given a hand-written shape
  // rather than fought with a module declaration this workstream cannot add.
  const validator = createRequire(import.meta.url)('gltf-validator') as {
    validateBytes(
      bytes: Uint8Array,
      options?: Record<string, unknown>
    ): Promise<{ issues: { messages: IValidationIssue[] } }>;
  };
  const bytes = new Uint8Array(await readFile(file));
  const report = await validator.validateBytes(bytes, {
    maxIssues: 200,
    externalResourceFunction: () => Promise.reject(new Error('no external resources expected')),
  });
  const messages = report.issues.messages.map((m) => ({ ...m, file }));
  return {
    file,
    errors: messages.filter((m) => m.severity === 0),
    warnings: messages.filter((m) => m.severity === 1),
    infos: messages.filter((m) => m.severity >= 2),
  };
}

/* -------------------------------------------------------------------------- */
/* Standalone CLI                                                             */
/* -------------------------------------------------------------------------- */

function parseArgs(argv: readonly string[]): {
  tier: QualityTier;
  only?: string;
  concurrency: number;
  force: boolean;
  validate: boolean;
  unlitFurthestLod?: boolean;
} {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const tier = (get('--tier') ?? 'mobile') as QualityTier;
  if (tier !== 'mobile' && tier !== 'high' && tier !== 'ultra') {
    throw new Error(`--tier must be mobile | high | ultra, got '${tier}'`);
  }
  return {
    tier,
    only: get('--only'),
    concurrency: Number(get('--concurrency') ?? 2),
    force: argv.includes('--force'),
    validate: argv.includes('--validate'),
    unlitFurthestLod: argv.includes('--unlit-far') ? true : undefined,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = new Logger();
  const result = await processModels(args);

  const stats = [...result.stats].sort((a, b) => b.outputBytes - a.outputBytes);

  log.heading(`per-model (${args.tier})`);
  console.log(
    ['model', 'parts', 'src tris', 'LOD0', 'LOD1', 'LOD2', 'tex', 'src MB', 'out MB'].join('\t')
  );
  for (const s of stats) {
    console.log(
      [
        s.providerId,
        s.parts,
        s.srcTriangles,
        ...s.lodTriangles,
        s.textures,
        (s.sourceBytes / 1048576).toFixed(2),
        (s.outputBytes / 1048576).toFixed(3),
      ].join('\t')
    );
  }
  const totals = stats.reduce(
    (acc, s) => ({
      src: acc.src + s.srcTriangles,
      out: acc.out + s.outputBytes,
      lod: acc.lod.map((v, i) => v + s.lodTriangles[i]),
    }),
    { src: 0, out: 0, lod: LOD_RATIOS.map(() => 0) }
  );
  console.log(
    ['TOTAL', '', totals.src, ...totals.lod, '', '', (totals.out / 1048576).toFixed(2)].join('\t')
  );

  if (args.validate) {
    log.heading('validation');
    let failed = 0;
    for (const record of result.models) {
      const file = outputPathFor(record.id, args.tier);
      if (!existsSync(file)) {
        failed += 1;
        log.error(`${path.basename(file)}: missing — nothing to validate`);
        continue;
      }
      const report = await validateGlb(file);
      if (report.errors.length > 0) {
        failed += 1;
        log.error(`${path.basename(file)}: ${report.errors.length} error(s)`);
        for (const issue of report.errors.slice(0, 5)) {
          log.error(`    ${issue.code} ${issue.message} ${issue.pointer ?? ''}`);
        }
      }
    }
    if (failed === 0) log.ok(`${result.models.length} files, 0 validation errors`);
    else process.exitCode = 1;
  }

  if (result.errors.length > 0) {
    for (const error of result.errors) log.error(error);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}

/** Exported for the verification harness and the orchestrator's reporting. */
export const MODEL_OUTPUT_DIR = OUTPUT_DIR;
export const MODEL_LOD_RATIOS = LOD_RATIOS;
