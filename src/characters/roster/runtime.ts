/**
 * BAKED ROSTER AT RUNTIME — load what the baker made, never bake in the frame
 *
 *   const roster = new RosterRuntime({ provider, anisotropy: 4 });
 *   await roster.load('chr.saitama');
 *   const body = roster.buildBody('chr.saitama', 0, { proximityFade: true });
 *
 * `tools/build-characters.ts` already produced everything a character needs:
 * a per-texel albedo/ORM/normal atlas with woven cloth and pored skin, a
 * four-tile expression strip, and a crowd tint mask. That work is SECONDS per
 * character and must never happen while the game is running — but *loading* its
 * output is three PNG fetches, and skipping that is what left the protagonist a
 * blank-faced flat-yellow mannequin in the first assembled build.
 *
 * So this module is the missing half of the pipeline: the runtime consumer of
 * `public/assets/chr/**`.
 *
 * ── THE ONE THING THAT IS EASY TO GET WRONG ───────────────────────────────
 * The atlas was baked against REMAPPED UVs. `prepareRosterGeometry` moves the
 * cape out of the whole-sheet island the generator emits and splits rectangles
 * shared by differently-painted regions; the baker runs it before it rasterises
 * anything. A runtime mesh that skips it samples the atlas with the generator's
 * raw layout and wears a smeared copy of its own face on its cape.
 *
 * The plan is therefore computed ONCE per character at LOD0 and reused for
 * every other LOD, exactly as the baker does it — for the three cape-wearing
 * characters the move is derived from measured island bounds, and measuring
 * them on a decimated mesh gives a subtly different rectangle.
 *
 * ── UPGRADE IN PLACE, DO NOT BLOCK THE BOOT ───────────────────────────────
 * Boot has about a second of headroom and the full cast is 251 MB of GPU
 * texture at `high`. So bodies are built the moment they are needed, with
 * whatever material is available at that instant, and `reskin()` swaps the real
 * one on when its atlas lands. A character that is still loading looks like the
 * mesh generator's vertex colours for a second; a character that blocked the
 * boot on 251 MB would look like a progress bar for a minute.
 */

import * as THREE from 'three';
import { buildHumanoid, type HumanoidBuild, type LodLevel } from '@/characters/mesh';
import type { QualityTier } from '@/types';
import { createLogger } from '@/util';
import { faceRegion } from './face';
import { measureHead, prepareRosterGeometry, type AtlasPlan } from './geometry';
import { characterDir, entryGlows, mapFileName, type CharacterMapRole } from './manifest';
import {
  createRosterMaterial,
  type RosterMaterial,
  type RosterMaterialOptions,
  type RosterTextures,
} from './materials';
import { rosterEntry } from './roster';
import type { FaceRect, RosterEntry } from './types';

const log = createLogger('roster:runtime');

/* -------------------------------------------------------------------------- */
/* Provider                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The slice of the asset provider this module needs.
 *
 * Structural rather than a concrete `HttpAssetProvider` so the harness can feed
 * it a directory reader, and so `@/characters` does not take a hard dependency
 * on `@/assets`. `HttpAssetProvider` satisfies it as-is.
 */
export interface IBakedAssetSource {
  /** Absolute-ish URL for a path relative to the generated asset root. */
  resolveFile(file: string): string;
  /** Tier the device settled on. Files are named `<role>.<tier>.png`. */
  selectTier(): QualityTier;
}

/** What one loaded character owns on the GPU. */
interface LoadedCharacter {
  readonly textures: RosterTextures;
  readonly tier: QualityTier;
  readonly bytes: number;
}

export interface IRosterRuntimeOptions {
  readonly source: IBakedAssetSource;
  readonly anisotropy?: number;
  /**
   * Tier override. Character atlases are baked at `mobile` and `high` only, so
   * an `ultra` device resolves to `high` — the same downgrade rule the main
   * manifest uses.
   */
  readonly tier?: QualityTier;
}

/** A body built against the baked atlas. */
export interface IRosterBody {
  readonly entry: RosterEntry;
  readonly build: HumanoidBuild;
  /** Where the face patch sits in the atlas, in UV. */
  readonly faceRect: FaceRect;
  /**
   * The real material when the atlas was resident, `undefined` when it was not.
   * A caller that gets `undefined` should bind its own stand-in and call
   * `reskin` later.
   */
  readonly material: RosterMaterial | undefined;
}

/* -------------------------------------------------------------------------- */
/* Texture decode                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Decode one baked PNG into a texture.
 *
 * `createImageBitmap` rather than `TextureLoader`: it decodes off the main
 * thread, which matters when four 1024² atlases land at once during play.
 *
 * NO orientation change is requested and `createRosterMaterial` binds with
 * `flipY = false`. The bake writes row 0 at v = 0 (`atlas.ts` states this for
 * the whole workstream), and an ImageBitmap uploaded without a flip puts row 0
 * at v = 0. Two conventions that already agree; the bug is only ever
 * introduced by "fixing" one of them.
 */
async function decodePng(url: string, anisotropy: number): Promise<THREE.Texture> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const bitmap = await createImageBitmap(await response.blob());
  const texture = new THREE.Texture(bitmap);
  texture.name = url.slice(url.lastIndexOf('/') + 1);
  texture.anisotropy = anisotropy;
  // Characters are viewed from two metres to two hundred; without mips the
  // woven jumpsuit aliases into a shimmering moiré the moment he walks away.
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  // Colour space, wrap mode and `flipY` are set by `createRosterMaterial`,
  // which is the single place that knows which role each map plays.
  texture.needsUpdate = true;
  return texture;
}

/** Bytes one decoded atlas occupies on the GPU, mip chain included. */
function gpuBytesOf(texture: THREE.Texture): number {
  const image = texture.image as { width?: number; height?: number } | undefined;
  const width = image?.width ?? 0;
  const height = image?.height ?? 0;
  return Math.round(width * height * 4 * 1.34);
}

/* -------------------------------------------------------------------------- */
/* Runtime                                                                    */
/* -------------------------------------------------------------------------- */

export class RosterRuntime {
  private readonly source: IBakedAssetSource;
  private readonly anisotropy: number;
  private readonly forcedTier: QualityTier | undefined;

  private readonly loaded = new Map<string, LoadedCharacter>();
  private readonly pending = new Map<string, Promise<boolean>>();
  private readonly plans = new Map<string, AtlasPlan>();
  private readonly faceRects = new Map<string, FaceRect>();
  private readonly failures = new Map<string, string>();
  private loadMsTotal = 0;
  private disposed = false;

  constructor(options: IRosterRuntimeOptions) {
    this.source = options.source;
    this.anisotropy = options.anisotropy ?? 4;
    this.forcedTier = options.tier;
  }

  /* -- state -------------------------------------------------------------- */

  /** Ids whose atlases are resident. */
  get residentIds(): readonly string[] {
    return [...this.loaded.keys()];
  }

  /** GPU bytes across every resident character atlas. */
  get residentBytes(): number {
    let total = 0;
    for (const record of this.loaded.values()) total += record.bytes;
    return total;
  }

  /** Ids whose load failed, with the reason. Surfaced in boot diagnostics. */
  get failed(): ReadonlyMap<string, string> {
    return this.failures;
  }

  /**
   * Milliseconds spent fetching and decoding atlases, cumulative.
   *
   * Reported separately from the boot total because it is the ONE number this
   * module adds to the boot path, and a boot measured on a contended machine
   * cannot be differenced against a baseline measured on a quiet one.
   */
  get loadMs(): number {
    return Math.round(this.loadMsTotal);
  }

  isResident(id: string): boolean {
    return this.loaded.has(id);
  }

  /* -- loading ------------------------------------------------------------ */

  /**
   * Fetch and decode one character's atlas set. Idempotent and de-duplicated.
   *
   * Resolves `false` rather than rejecting when the bake is absent: a fresh
   * clone that has not run `npx tsx tools/build-characters.ts` must still boot,
   * and the caller falls back to the generator's vertex colours.
   */
  async load(id: string): Promise<boolean> {
    if (this.disposed) return false;
    if (this.loaded.has(id)) return true;
    const existing = this.pending.get(id);
    if (existing !== undefined) return existing;

    const task = this.doLoad(id).finally(() => this.pending.delete(id));
    this.pending.set(id, task);
    return task;
  }

  /**
   * Load several characters one after another, yielding between each.
   *
   * Sequential ON PURPOSE. Four concurrent atlas sets are twelve simultaneous
   * PNG decodes and ~50 MB of texture upload; issued in parallel they land in
   * the same frame and produce exactly the hitch the progressive load exists to
   * avoid. Failures are logged and skipped, never thrown.
   */
  async loadSequential(ids: readonly string[], between?: () => Promise<void>): Promise<void> {
    for (const id of ids) {
      if (this.disposed) return;
      await this.load(id);
      if (between !== undefined) await between();
    }
  }

  private async doLoad(id: string): Promise<boolean> {
    const entry = this.entryOrUndefined(id);
    if (entry === undefined) return false;
    const started = performance.now();

    const tier = this.tierFor();
    const dir = characterDir(entry);
    const roles: CharacterMapRole[] = ['albedo', 'normal', 'orm'];
    if (entryGlows(entry)) roles.push('emissive');
    roles.push('face');
    if (entry.crowd === true) roles.push('mask');

    try {
      const decoded = new Map<CharacterMapRole, THREE.Texture>();
      for (const role of roles) {
        const url = this.source.resolveFile(`${dir}/${mapFileName(role, tier)}`);
        // Only the three PBR maps are structural. A missing face or mask is a
        // character that renders correctly minus one feature, which is a much
        // better outcome than no character at all.
        try {
          decoded.set(role, await decodePng(url, this.anisotropy));
        } catch (error) {
          if (role === 'albedo' || role === 'normal' || role === 'orm') throw error;
          log.warn(`${id}: optional map "${role}" missing (${String(error)})`);
        }
      }
      if (this.disposed) {
        for (const texture of decoded.values()) texture.dispose();
        return false;
      }

      const textures: RosterTextures = {
        map: decoded.get('albedo')!,
        normalMap: decoded.get('normal')!,
        ormMap: decoded.get('orm')!,
        emissiveMap: decoded.get('emissive'),
        faceMap: decoded.get('face'),
        maskMap: decoded.get('mask'),
      };
      let bytes = 0;
      for (const texture of decoded.values()) bytes += gpuBytesOf(texture);

      this.loaded.set(id, { textures, tier, bytes });
      this.failures.delete(id);
      const ms = performance.now() - started;
      this.loadMsTotal += ms;
      log.info(
        `${id}: ${decoded.size} maps at '${tier}' ` +
          `(${(bytes / 1048576).toFixed(1)} MB, ${ms.toFixed(0)}ms)`
      );
      return true;
    } catch (error) {
      this.loadMsTotal += performance.now() - started;
      this.failures.set(id, String(error));
      log.warn(`${id}: baked atlas unavailable — falling back to vertex colours (${String(error)})`);
      return false;
    }
  }

  /* -- geometry ----------------------------------------------------------- */

  /**
   * The atlas plan and face rectangle the BAKE used, for one character.
   *
   * Both are properties of the character, not of the body in front of us, and
   * both are derived the way `tools/build-characters.ts` derives them: from an
   * LOD0 build of the roster's own recipe, with the plan computed before the
   * head is measured.
   *
   * That distinction matters twice.
   *
   *   THE PLAN. Moves for a displaced island (the capes on Saitama, Mosquito
   *   Girl and Boros) come from its MEASURED bounds, and a decimated mesh
   *   measures slightly smaller. Sharing one plan across every LOD is what
   *   keeps all three LODs sampling a single texture.
   *
   *   THE FACE RECT. Every near-tier civilian is a different seed with
   *   different proportions, but they all share ONE baked sheet. Measuring each
   *   body would put each one's expression tile somewhere slightly different
   *   from where its face was actually painted, leaving a double image.
   */
  private canonical(id: string, from?: HumanoidBuild): { plan: AtlasPlan; faceRect: FaceRect } {
    const cachedPlan = this.plans.get(id);
    const cachedRect = this.faceRects.get(id);
    if (cachedPlan !== undefined && cachedRect !== undefined) {
      return { plan: cachedPlan, faceRect: cachedRect };
    }

    const entry = rosterEntry(id);
    // `from` is an LOD0 build of this very character that the caller is making
    // anyway — the overwhelmingly common case, and worth not duplicating.
    const reference =
      from ?? buildHumanoid(entry.recipe.profile, { ...entry.recipe.options, lod: 0 });
    const plan = prepareRosterGeometry(reference).plan;
    const faceRect = faceRegion(entry.face, measureHead(reference)).atlas;
    if (from === undefined) reference.geometry.dispose();

    this.plans.set(id, plan);
    this.faceRects.set(id, faceRect);
    return { plan, faceRect };
  }

  /**
   * Rewrite a caller-built body's UVs into the baked atlas's layout.
   *
   * For meshes this module did not create — the crowd builds its own near-tier
   * civilians from per-agent seeds. Returns the character's canonical face
   * rectangle. Safe to call on a body of any LOD and any profile, because the
   * unwrap is parametric: a taller civilian's head still lands in the same
   * atlas rectangle.
   */
  prepareForeign(id: string, build: HumanoidBuild): FaceRect {
    const { plan, faceRect } = this.canonical(id);
    prepareRosterGeometry(build, plan);
    return faceRect;
  }

  /** Build a character's mesh with UVs that match the baked atlas. */
  buildGeometry(id: string, lod: LodLevel = 0): { build: HumanoidBuild; faceRect: FaceRect } {
    const entry = rosterEntry(id);
    const build = buildHumanoid(entry.recipe.profile, { ...entry.recipe.options, lod });
    if (lod === 0 && !this.plans.has(id)) {
      // `canonical` prepares this build in place and keeps its plan.
      return { build, faceRect: this.canonical(id, build).faceRect };
    }
    const { plan, faceRect } = this.canonical(id);
    prepareRosterGeometry(build, plan);
    return { build, faceRect };
  }

  /* -- materials ---------------------------------------------------------- */

  /**
   * The material for a resident character, or `undefined` when its atlas is
   * not loaded yet.
   *
   * A NEW material per call. They are cheap objects and they must not be
   * shared: expression is a per-material uniform, so one shared Saitama
   * material would make every copy of him blink at once — and the proximity
   * dither belongs to the player alone.
   */
  createMaterial(
    id: string,
    faceRect: FaceRect,
    options: Omit<RosterMaterialOptions, 'faceRect'> = {}
  ): RosterMaterial | undefined {
    const record = this.loaded.get(id);
    if (record === undefined) return undefined;
    const entry = this.entryOrUndefined(id);
    return createRosterMaterial(record.textures, {
      name: id,
      faceRect,
      expression: options.expression ?? entry?.restExpression ?? 'neutral',
      crowdTint: options.crowdTint ?? entry?.crowd === true,
      ...options,
    });
  }

  /**
   * Build geometry AND its material in one step.
   *
   * `material` is `undefined` when the atlas has not landed; the caller binds
   * a stand-in and calls `reskin` once it has.
   */
  buildBody(
    id: string,
    lod: LodLevel = 0,
    options: Omit<RosterMaterialOptions, 'faceRect'> = {}
  ): IRosterBody {
    const entry = rosterEntry(id);
    const { build, faceRect } = this.buildGeometry(id, lod);
    return { entry, build, faceRect, material: this.createMaterial(id, faceRect, options) };
  }

  /**
   * Swap the real material onto an already-built body.
   *
   * Returns the material that was installed, or `undefined` when the atlas is
   * still absent. The OLD material is disposed by the caller if it owns it —
   * this function does not, because a stand-in is often shared.
   */
  reskin(
    root: THREE.Object3D,
    id: string,
    faceRect: FaceRect,
    options: Omit<RosterMaterialOptions, 'faceRect'> = {}
  ): RosterMaterial | undefined {
    const material = this.createMaterial(id, faceRect, options);
    if (material === undefined) return undefined;
    root.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh !== true) return;
      mesh.material = material;
    });
    return material;
  }

  /* -- lifecycle ---------------------------------------------------------- */

  dispose(): void {
    this.disposed = true;
    for (const record of this.loaded.values()) {
      for (const texture of Object.values(record.textures)) {
        (texture as THREE.Texture | undefined)?.dispose();
      }
    }
    this.loaded.clear();
    this.plans.clear();
    this.faceRects.clear();
  }

  /* -- internals ---------------------------------------------------------- */

  /** Character atlases exist at `mobile` and `high`; `ultra` reuses `high`. */
  private tierFor(): QualityTier {
    const tier = this.forcedTier ?? this.source.selectTier();
    return tier === 'ultra' ? 'high' : tier;
  }

  private entryOrUndefined(id: string): RosterEntry | undefined {
    try {
      return rosterEntry(id);
    } catch {
      log.warn(`"${id}" is not a roster character`);
      return undefined;
    }
  }
}
