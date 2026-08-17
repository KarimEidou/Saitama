/**
 * INSTANCED CROWD — 250 people, six draw calls
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE ARITHMETIC THAT DECIDES THIS
 *
 *  A `THREE.SkinnedMesh` per civilian is one draw call and a 27-matrix CPU
 *  pass each. At 250 that is 250 draw calls and 6,750 matrix composes per
 *  frame, before a single triangle is submitted. On a mid-tier Android phone
 *  that is the entire frame budget, spent on background pedestrians.
 *
 *  The animation workstream already solved the skinning half: the bone palette
 *  for every frame of every clip lives in one texture, so the vertex shader
 *  skins from a texture fetch and the CPU does nothing. What is left is the
 *  DRAW CALL, and one `InstancedMesh` per body archetype takes it from 250 to
 *  6 — one per distinct geometry, which is the floor.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── SIX ARCHETYPES, SIXTEEN WARDROBES, TWO HUNDRED AND FIFTY PEOPLE ───────
 * Six shared bodies would be six clones repeated forty times each, which the
 * eye picks out immediately. So variation is split by cost:
 *
 *   SHAPE     six geometries. Expensive (a geometry is a draw call), so six.
 *   WARDROBE  sixteen palettes, one integer per instance, recoloured in the
 *             shader. Free.
 *   MOTION    a per-instance time offset and playback rate. Free, and the one
 *             that matters most — 250 people stepping in unison is instantly
 *             and ruinously wrong, and the fix costs one float.
 *
 * Six shapes times sixteen wardrobes times a continuum of gait phases is not
 * 250 distinct people, but it is far past the point where anyone counts.
 *
 * ── WHY THE RECOLOUR NEEDS A PER-VERTEX REGION ────────────────────────────
 * `InstancedMesh.instanceColor` exists and would be simpler. It multiplies the
 * whole body, so tinting somebody's shirt blue also tints their face and hands
 * blue. The mesh generator bakes region colour into a vertex-colour attribute
 * with exactly four distinct values (skin, cloth, accent, hair) — so a
 * one-byte-per-vertex REGION attribute, classified against the palette the
 * body was built with, lets the shader replace only the clothing. Computed
 * once at build time; costs one float per vertex on a 305-vertex LOD2 body.
 */

import * as THREE from 'three';
import { createRng } from '@/util';
import {
  buildHumanoid,
  civilianOptions,
  civilianProfile,
  createCharacterParts,
  type HumanoidBuild,
} from '@/characters/mesh';
import {
  applyVatSkinning,
  bakeVat,
  findClip,
  resolveRig,
  vatClipFps,
  type ClipEntry,
  type VatBake,
} from '@/characters/anim';
import { CROWD_ARCHETYPES, CROWD_PALETTES, MID_CAP } from './constants';
import { COWER_CLIP, COWER_KEY, GAWK_CLIP, GAWK_KEY } from './crowd-clips';
import {
  CrowdAgents,
  MOOD_COMMUTE,
  MOOD_COWER,
  MOOD_DOWN,
  MOOD_FLEE,
  MOOD_GAWK,
} from './crowd-agents';
import type { ICrowdArchetype } from './types';

/** Frames per clip in the palette atlas. Matches the animation workstream's bake. */
const VAT_FRAMES = 32;

/** Clip slots in the crowd bake, in atlas order. */
export const CROWD_CLIP_IDLE = 0;
export const CROWD_CLIP_WALK = 1;
export const CROWD_CLIP_RUN = 2;
export const CROWD_CLIP_FLEE = 3;
export const CROWD_CLIP_GAWK = 4;
export const CROWD_CLIP_COWER = 5;

/** Bake keys, in the same order. */
const CLIP_KEYS = [
  'idle:civilian',
  'walk:default',
  'run:default',
  'flee:default',
  GAWK_KEY,
  COWER_KEY,
] as const;

/**
 * The six bodies.
 *
 * Hand-picked seeds rather than the first six integers: `civilianProfile`
 * draws its archetype from a weighted table, and consecutive seeds happen to
 * give four ordinary adults and no child. These six are chosen so the crowd
 * contains a child, a heavy build and a lithe one — the silhouettes that make
 * a crowd read as a population rather than as a clone army.
 */
const ARCHETYPE_SEEDS: readonly number[] = [8101, 2207, 6631, 4409, 9973, 1553];

/** Region ids written into the per-vertex `crowdRegion` attribute. */
const REGION_FIXED = 0;
const REGION_CLOTH = 1;
const REGION_ACCENT = 2;

interface ArchetypeResources {
  readonly info: ICrowdArchetype;
  readonly build: HumanoidBuild;
  readonly bake: VatBake;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.MeshStandardMaterial;
  readonly mesh: THREE.InstancedMesh;
  readonly vatParams: THREE.InstancedBufferAttribute;
  readonly crowdParams: THREE.InstancedBufferAttribute;
  readonly clipRows: Float32Array;
  readonly clipFrames: Float32Array;
  readonly vatTime: { value: number };
  readonly vatFps: { value: number };
  count: number;
}

export interface ICrowdRenderStats {
  /** Instances submitted this frame. */
  readonly instances: number;
  /** Archetype meshes with at least one instance — the crowd's draw calls. */
  readonly activeMeshes: number;
  readonly triangles: number;
  /** Total VAT palette bytes across all archetypes. */
  readonly paletteBytes: number;
  /** Distinct rounded time offsets in use. High means the crowd is not marching. */
  readonly distinctOffsets: number;
}

export class CrowdRenderer {
  /** Parent this to the scene. Holds one `InstancedMesh` per archetype. */
  readonly group = new THREE.Group();
  readonly archetypes: ICrowdArchetype[] = [];

  private readonly resources: ArchetypeResources[] = [];
  /** 16 wardrobes x (cloth, trim), as linear-space vec3s for the shader. */
  private readonly palette: THREE.Color[] = [];
  private readonly paletteUniform: { value: THREE.Color[] };
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly euler = new THREE.Euler();
  private readonly offsets = new Set<number>();

  private time = 0;
  private stats: ICrowdRenderStats = {
    instances: 0,
    activeMeshes: 0,
    triangles: 0,
    paletteBytes: 0,
    distinctOffsets: 0,
  };

  constructor(seed = 0x5a17a) {
    this.group.name = 'crowd-instanced';
    const rng = createRng(seed).derive('wardrobe');
    for (let i = 0; i < CROWD_PALETTES; i++) {
      this.palette.push(new THREE.Color(rng.pick(CLOTH_TONES)));
      this.palette.push(new THREE.Color(rng.pick(TRIM_TONES)));
    }
    this.paletteUniform = { value: this.palette };
    this.build();
  }

  /** Measurements from the last `update`. */
  get lastStats(): ICrowdRenderStats {
    return this.stats;
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                       */
  /* ------------------------------------------------------------------ */

  private build(): void {
    const clips: ClipEntry[] = [
      findClip('idle', 'civilian'),
      findClip('walk'),
      findClip('run'),
      findClip('flee'),
      GAWK_CLIP,
      COWER_CLIP,
    ];

    let paletteBytes = 0;
    for (let a = 0; a < CROWD_ARCHETYPES; a++) {
      const seed = ARCHETYPE_SEEDS[a] ?? 1000 + a;
      const profile = civilianProfile(seed);
      // LOD2 unconditionally. The instanced tier starts at 40 m, where a
      // 452-triangle body is already more geometry than the pixels can show;
      // spending LOD0 on it would be paying for detail the screen deletes.
      const options = civilianOptions(profile, 2);
      const build = buildHumanoid(profile, options);
      // A throwaway bind purely to resolve the rig: `resolveRig` needs the
      // skeleton's inverse bind matrices, and those are snapshotted by
      // `SkinnedMesh.bind`, which `createCharacterParts` performs in the
      // correct order. Re-deriving them here would duplicate that ordering
      // rule and get it wrong the first time somebody changes the rig.
      const scratchMaterial = new THREE.MeshBasicMaterial();
      const parts = createCharacterParts(build, scratchMaterial);
      const rig = resolveRig(parts);
      const bake = bakeVat(rig, clips, { frames: VAT_FRAMES, halfFloat: true });
      paletteBytes += bake.bytes;

      const geometry = build.geometry.clone();
      geometry.setAttribute(
        'crowdRegion',
        classifyRegions(build, options.palette?.cloth, options.palette?.accent)
      );

      const material = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.82,
        metalness: 0.02,
      });
      const vatUniforms = applyVatSkinning(material, bake);
      this.patchPalette(material, bake);

      const vatParams = new THREE.InstancedBufferAttribute(new Float32Array(MID_CAP * 4), 4);
      vatParams.setUsage(THREE.DynamicDrawUsage);
      const crowdParams = new THREE.InstancedBufferAttribute(new Float32Array(MID_CAP * 2), 2);
      crowdParams.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute('vatParams', vatParams);
      geometry.setAttribute('crowdParams', crowdParams);

      const mesh = new THREE.InstancedMesh(geometry, material, MID_CAP);
      mesh.name = `crowd-archetype-${a}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Every instance is repositioned every frame, so a bounding volume
      // computed at construction is meaningless. The crowd only exists in a
      // 150 m annulus round the player and is always partly on screen, so
      // per-mesh frustum culling would reject nothing anyway.
      mesh.frustumCulled = false;
      // No shadow pass. A shadow map render doubles the crowd's draw calls to
      // buy contact shadows on people who are at least forty metres away.
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.count = 0;
      mesh.visible = false;
      this.group.add(mesh);

      const clipRows = new Float32Array(clips.length);
      const clipFrames = new Float32Array(clips.length);
      for (let c = 0; c < CLIP_KEYS.length; c++) {
        const index = bake.index.get(CLIP_KEYS[c]!) ?? 0;
        const range = bake.clips[index]!;
        clipRows[c] = range.row;
        clipFrames[c] = range.frames;
      }

      const info: ICrowdArchetype = {
        index: a,
        seed,
        archetype: profile.archetype,
        height: profile.height,
      };
      this.archetypes.push(info);
      this.resources.push({
        info,
        build,
        bake,
        geometry,
        material,
        mesh,
        vatParams,
        crowdParams,
        clipRows,
        clipFrames,
        vatTime: vatUniforms.vatTime,
        vatFps: vatUniforms.vatFps,
        count: 0,
      });
      // NOT `parts.dispose()`: that disposes `build.geometry`, which the
      // instanced geometry was cloned from and which the near tier still reads
      // its vertex colours out of.
      scratchMaterial.dispose();
    }
    this.stats = { ...this.stats, paletteBytes };
  }

  /**
   * Chain a wardrobe recolour onto the VAT material.
   *
   * `applyVatSkinning` owns `onBeforeCompile`, so this wraps rather than
   * replaces it — overwriting the hook is how the crowd ends up correctly
   * coloured and completely unskinned. The cache key is extended too, because
   * three.js keys compiled programs on that string and two materials whose
   * shader source differs must not share a program.
   */
  private patchPalette(material: THREE.MeshStandardMaterial, bake: VatBake): void {
    const inner = material.onBeforeCompile.bind(material);
    const paletteUniform = this.paletteUniform;
    material.onBeforeCompile = (shader, renderer) => {
      inner(shader, renderer);
      shader.uniforms.crowdPalette = paletteUniform;
      shader.vertexShader =
        `attribute float crowdRegion;\n` +
        `attribute vec2 crowdParams;\n` +
        `uniform vec3 crowdPalette[${CROWD_PALETTES * 2}];\n` +
        shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <color_vertex>',
        `#include <color_vertex>
  {
    int wardrobe = int(crowdParams.x + 0.5) * 2;
    if (crowdRegion > 1.5) vColor.rgb = crowdPalette[wardrobe + 1];
    else if (crowdRegion > 0.5) vColor.rgb = crowdPalette[wardrobe];
  }`
      );
    };
    material.customProgramCacheKey = (): string =>
      `crowd-vat-${bake.width}x${bake.height}-${CROWD_PALETTES}`;
    material.needsUpdate = true;
  }

  /* ------------------------------------------------------------------ */
  /* Per-frame                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Pack every agent without a skinned body into its archetype's instance
   * buffer.
   *
   * `skip` is the set of agent indices the near tier has taken over with a
   * real `SkinnedMesh`; drawing them twice would leave a VAT ghost standing
   * inside the character.
   */
  update(agents: CrowdAgents, dt: number, skip: ReadonlySet<number>): void {
    this.time += dt;
    for (const resource of this.resources) resource.count = 0;
    this.offsets.clear();

    let instances = 0;
    for (let i = 0; i < agents.extent; i++) {
      if (agents.active[i] === 0 || skip.has(i)) continue;
      const resource = this.resources[agents.archetype[i]!];
      if (resource === undefined || resource.count >= MID_CAP) continue;
      const slot = resource.count++;
      instances++;

      const mood = agents.mood[i]!;
      const clip = clipForMood(mood, agents.velX[i]!, agents.velZ[i]!);
      const p = slot * 4;
      resource.vatParams.array[p] = resource.clipRows[clip]!;
      resource.vatParams.array[p + 1] = resource.clipFrames[clip]!;
      resource.vatParams.array[p + 2] = agents.timeOffset[i]!;
      // Rate 0 freezes an instance on the clip's first frame, which is exactly
      // what a body on the pavement needs — and it costs nothing extra, since
      // the shader already multiplies by this.
      resource.vatParams.array[p + 3] = mood === MOOD_DOWN ? 0 : agents.rate[i]!;

      const q = slot * 2;
      resource.crowdParams.array[q] = agents.palette[i]!;
      resource.crowdParams.array[q + 1] = agents.bravado[i]!;

      this.position.set(agents.posX[i]!, 0, agents.posZ[i]!);
      if (mood === MOOD_DOWN) {
        // Face-down on the pavement: pitch the whole instance forward and drop
        // it by roughly a shoulder width so the body sits on the ground rather
        // than hovering at standing height.
        this.euler.set(-Math.PI / 2, agents.yaw[i]!, 0, 'YXZ');
        this.quaternion.setFromEuler(this.euler);
        this.position.y = 0.16;
      } else {
        this.euler.set(0, agents.yaw[i]!, 0, 'YXZ');
        this.quaternion.setFromEuler(this.euler);
      }
      this.scale.setScalar(1);
      resource.mesh.setMatrixAt(slot, this.matrix.compose(this.position, this.quaternion, this.scale));
      this.offsets.add(Math.round(agents.timeOffset[i]! * 256));
    }

    let activeMeshes = 0;
    let triangles = 0;
    for (const resource of this.resources) {
      resource.mesh.count = resource.count;
      resource.mesh.visible = resource.count > 0;
      if (resource.count > 0) {
        activeMeshes++;
        const index = resource.geometry.getIndex();
        triangles += ((index?.count ?? 0) / 3) * resource.count;
      }
      resource.mesh.instanceMatrix.needsUpdate = true;
      resource.vatParams.needsUpdate = true;
      resource.crowdParams.needsUpdate = true;
      resource.vatTime.value = this.time;
      // All six clips are baked at the same frame count, so one FPS serves the
      // whole atlas: the shader's `mod(t, frames)` handles the differing
      // durations through the per-clip frame count in `vatParams.y`.
      resource.vatFps.value = vatClipFps(resource.bake.clips[CROWD_CLIP_WALK]!);
    }

    this.stats = {
      instances,
      activeMeshes,
      triangles,
      paletteBytes: this.stats.paletteBytes,
      distinctOffsets: this.offsets.size,
    };
  }

  /** The archetype table, for the near tier to match bodies against. */
  archetypeInfo(index: number): ICrowdArchetype | undefined {
    return this.archetypes[index];
  }

  /** The LOD2 build for an archetype. Shared; never mutated by callers. */
  archetypeBuild(index: number): HumanoidBuild | undefined {
    return this.resources[index]?.build;
  }

  dispose(): void {
    for (const resource of this.resources) {
      resource.mesh.removeFromParent();
      resource.mesh.dispose();
      resource.geometry.dispose();
      resource.material.dispose();
      resource.bake.dispose();
      resource.build.geometry.dispose();
    }
    this.resources.length = 0;
    this.archetypes.length = 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Which baked clip a mood plays.
 *
 * `commute` splits on actual speed rather than on the mood, because a
 * commuting civilian who has been stopped by the crowd in front of them should
 * be standing, not moonwalking. Foot sliding is the single most obvious crowd
 * artefact and it is entirely caused by playing a locomotion clip on a body
 * that is not moving.
 */
export function clipForMood(mood: number, velX: number, velZ: number): number {
  switch (mood) {
    case MOOD_FLEE:
      return CROWD_CLIP_FLEE;
    case MOOD_GAWK:
      return CROWD_CLIP_GAWK;
    case MOOD_COWER:
    case MOOD_DOWN:
      return CROWD_CLIP_COWER;
    case MOOD_COMMUTE:
    default: {
      const speedSq = velX * velX + velZ * velZ;
      if (speedSq < 0.09) return CROWD_CLIP_IDLE;
      return speedSq > 6.25 ? CROWD_CLIP_RUN : CROWD_CLIP_WALK;
    }
  }
}

/**
 * Classify every vertex as fixed (skin, hair), cloth or accent.
 *
 * The mesh generator writes exactly four distinct colours into the `color`
 * attribute — the palette's skin, cloth, accent and hair, in linear working
 * space — so this is an exact match against two of them rather than a
 * heuristic. The tolerance covers float round-tripping through the attribute,
 * nothing more.
 */
function classifyRegions(
  build: HumanoidBuild,
  cloth: THREE.Color | undefined,
  accent: THREE.Color | undefined
): THREE.BufferAttribute {
  const colour = build.geometry.getAttribute('color');
  const out = new Float32Array(colour.count);
  if (cloth === undefined || accent === undefined) {
    return new THREE.BufferAttribute(out, 1);
  }
  const TOLERANCE = 1e-3;
  for (let i = 0; i < colour.count; i++) {
    const r = colour.getX(i);
    const g = colour.getY(i);
    const b = colour.getZ(i);
    if (
      Math.abs(r - cloth.r) < TOLERANCE &&
      Math.abs(g - cloth.g) < TOLERANCE &&
      Math.abs(b - cloth.b) < TOLERANCE
    ) {
      out[i] = REGION_CLOTH;
    } else if (
      Math.abs(r - accent.r) < TOLERANCE &&
      Math.abs(g - accent.g) < TOLERANCE &&
      Math.abs(b - accent.b) < TOLERANCE
    ) {
      out[i] = REGION_ACCENT;
    } else {
      out[i] = REGION_FIXED;
    }
  }
  return new THREE.BufferAttribute(out, 1);
}

/** Shirt colours. Muted and desaturated: City Z is not a fashion capital. */
const CLOTH_TONES: readonly number[] = [
  0x3d5a80, 0x8d5a3c, 0x4f6f52, 0x7a3b4a, 0x2f3540, 0x8a7d4f, 0x5b4b7a, 0xa8563f, 0x365c6b,
  0x6d6f75, 0xb08a5a, 0x455a4a,
];

/** Trouser and shoe colours. Darker still, so the shirt carries the read. */
const TRIM_TONES: readonly number[] = [
  0x22252b, 0x3a3f47, 0x6b5642, 0x2b3a2f, 0x4a2f33, 0x1d2028, 0x54453a,
];
