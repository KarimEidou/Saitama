/**
 * ASSET RUNTIME HARNESS
 *
 * Drives `@/assets` against the REAL generated tree in `public/assets/` —
 * 153 KTX2 textures, 39 meshopt GLBs, 4 HDRIs — inside a real WebGL2 context,
 * and publishes measurements the node driver asserts on.
 *
 * ── THE FOUR CLAIMS UNDER TEST ─────────────────────────────────────────────
 *  1. TRANSCODE. Every texture reaches the GPU as a genuinely block-compressed
 *     format (`isCompressedTexture === true`), and the harness names the
 *     target it landed on rather than asserting a hard-coded one.
 *
 *  2. ORM. One packed map binds to aoMap + roughnessMap + metalnessMap, with
 *     `aoMap.channel === 0`. Three slots, one upload, UV0.
 *
 *  3. TIER FALLBACK. `?root=apk` points the provider at a mirror of the tree
 *     that 404s every `.high.` and `.ultra.` file — precisely what the Android
 *     package does with the 26 files the manifest declares but does not
 *     contain. With the native signal set, the runtime must select `mobile`
 *     and issue ZERO requests for the absent tiers. The driver counts 404s
 *     from Playwright's side, so the page cannot mark its own homework.
 *
 *  4. LRU. With a deliberately tiny budget, eviction takes the least recently
 *     used UNREFERENCED texture and never a retained one.
 *
 * Modes: `?mode=grid` (default), `?mode=apk`, `?mode=budget`.
 */

import * as THREE from 'three';
import {
  AssetRegistry,
  HttpAssetProvider,
  isMissingAsset,
  type ILoadedEnvironment,
  type IManagedTextureHandle,
} from '@/assets';
import type { IMaterialAsset, QualityTier } from '@/types';

/* -------------------------------------------------------------------------- */
/* Published measurements                                                     */
/* -------------------------------------------------------------------------- */

interface ITextureRow {
  key: string;
  tier: string;
  gpuFormat: string;
  compressed: boolean;
  codec: string;
  colorSpace: string;
  width: number;
  height: number;
  gpuBytes: number;
  mipLevels: number;
  flipY: boolean;
  fallback: boolean;
}

interface IMaterialRow {
  id: string;
  ormBound: boolean;
  aoChannel: number;
  aoIsRoughness: boolean;
  aoIsMetalness: boolean;
  albedoColorSpace: string;
  normalColorSpace: string;
  albedoCompressed: boolean;
  missing: string[];
  usesFallbackTexture: boolean;
  tiers: string[];
}

interface IModelRow {
  id: string;
  lodGroups: number;
  lodCount: number;
  triangles: number[];
  activeLevel: number;
  /** Visible children per `__LOD` group. Must be exactly 1 everywhere. */
  visiblePerGroup: number[];
  meshes: number;
  embeddedTexturesCompressed: number;
  embeddedTexturesTotal: number;
}

interface IEnvironmentRow {
  key: string;
  mode: string;
  meanLuminance: number;
  maxLuminance: number;
  shCoefficients: number;
  minFilterIsLinear: boolean;
  magFilterIsLinear: boolean;
  equirectMapping: boolean;
  flipY: boolean;
  gpuBytes: number;
  fallback: boolean;
}

interface IBudgetReport {
  budgetBytes: number;
  residentBefore: number;
  residentAfter: number;
  evicted: string[];
  pinned: string[];
  retainedKeys: string[];
  retainedStillResident: boolean;
  evictedWereUnreferenced: boolean;
  evictedInLruOrder: boolean;
  overBudget: boolean;
}

interface IHarnessStats {
  mode: string;
  root: string;
  tier: QualityTier;
  tierReason: string;
  transcodeTarget: string;
  transcodeAvailable: string[];
  emulatedFormatsSuppressed: boolean;
  renderer: string;
  maxTextureSize: number;
  anisotropy: number;
  textures: ITextureRow[];
  materials: IMaterialRow[];
  models: IModelRow[];
  environments: IEnvironmentRow[];
  budget?: IBudgetReport;
  requestedTiers: string[];
  tierMisses: { key: string; tier: string; reason: string }[];
  unavailableTiers: string[];
  missing: string[];
  failures: { key: string; kind: string; reason: string }[];
  textureBytes: number;
  textureBudgetBytes: number;
  gpuBytes: number;
  progressSamples: { fraction: number; loaded: number; total: number; bytesLoaded: number }[];
  progressMonotonic: boolean;
  drawCalls: number;
  sceneTriangles: number;
  characterCount: number;
  loadMs: number;
}

declare global {
  interface Window {
    __HARNESS_READY__?: boolean;
    __HARNESS_ERROR__?: string;
    __HARNESS_STATS__?: unknown;
  }
}

/* -------------------------------------------------------------------------- */
/* Curated content                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Twelve materials spanning every surface family the city uses, chosen so the
 * grid shows real variation in albedo, roughness and metalness rather than
 * twelve grey slabs. `mat.road.asphalt.worn`, `mat.wall.brick.red` and
 * `mat.metal.rust.coarse` are the three that exist at every tier — they are
 * the assets the Android package is missing.
 */
const GRID_MATERIALS = [
  'mat.road.asphalt.worn',
  'mat.wall.brick.red',
  'mat.metal.rust.coarse',
  'mat.ground.sidewalk.slabs',
  'mat.wall.concrete.dirty',
  'mat.wall.plaster.beige',
  'mat.metal.corrugated',
  'mat.roof.tiles.ceramic',
  'mat.wood.planks.weathered',
  'mat.ground.cobblestone.alley',
  'mat.ground.grass.leafy',
  'mat.metal.plate.industrial',
] as const;

/** Eight models with legible silhouettes and modest triangle counts. */
const GRID_MODELS = [
  'model.prop.barrel_stove',
  'model.prop.fire_hydrant',
  'model.prop.metal_trash_can',
  'model.prop.street_lamp_02',
  'model.prop.old_tyre',
  'model.prop.utility_box_01',
  'model.building.rollershutter_door',
  'model.prop.security_light',
] as const;

const ENVIRONMENTS = ['hdri.sky.day', 'hdri.sky.dusk'] as const;

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

const params = new URLSearchParams(location.search);
const mode = params.get('mode') ?? 'grid';
const rootName = params.get('root') ?? 'assets';
/** `apk` mirrors the tree with every `.high.`/`.ultra.` file withheld. */
const baseUrl = rootName === 'apk' ? '/apk-assets' : '/assets';
const width = Number(params.get('w') ?? 1600);
const height = Number(params.get('h') ?? 900);

const stage = document.getElementById('stage') as HTMLDivElement;
const canvas = document.getElementById('view') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLDivElement;
const readout = document.getElementById('readout') as HTMLDivElement;
const errorBox = document.getElementById('error') as HTMLPreElement;

stage.style.width = `${width}px`;
stage.style.height = `${height}px`;

function fail(error: unknown): void {
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  window.__HARNESS_ERROR__ = text;
  errorBox.style.display = 'block';
  errorBox.textContent = text;
  window.__HARNESS_READY__ = true;
}

function bytesMb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

main().catch(fail);

async function main(): Promise<void> {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const gl = renderer.getContext();
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const rendererName =
    debugInfo === null ? 'unknown' : String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL));

  // Simulating the Android package means simulating the Android SIGNAL too:
  // the runtime picks `mobile` because it is inside a native shell, not
  // because it probed a slow GPU.
  const nativeSignals =
    rootName === 'apk' ? { isNative: true, platform: 'android' as const } : undefined;

  const provider = new HttpAssetProvider({
    baseUrl,
    signals: nativeSignals,
    tier: (params.get('tier') as QualityTier | null) ?? undefined,
  });

  const started = performance.now();
  const registry = await AssetRegistry.open({
    provider,
    renderer,
    anisotropy: renderer.capabilities.getMaxAnisotropy(),
    memoryBudgetBytes: mode === 'budget' ? 24 * 1024 * 1024 : undefined,
    concurrency: 6,
  });

  const progressSamples: IHarnessStats['progressSamples'] = [];
  const keys = [...GRID_MATERIALS, ...GRID_MODELS, ...ENVIRONMENTS];
  await registry.loadAll(keys, (progress) => {
    progressSamples.push({
      fraction: progress.fraction,
      loaded: progress.loaded,
      total: progress.total,
      bytesLoaded: progress.bytesLoaded,
    });
  });
  await registry.idle();
  const loadMs = performance.now() - started;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0d14);

  const environments: ILoadedEnvironment[] = [];
  for (const key of ENVIRONMENTS) {
    const environment = registry.getEnvironment(key);
    if (environment) environments.push(environment);
  }
  const sky = environments[0];
  if (sky !== undefined) {
    // PMREM where it was built, the equirect otherwise; on the SH path the
    // probe carries the diffuse term instead of a texture.
    scene.environment = registry.getHDRI(sky.key) ?? null;
    // The four skies are not exposure-matched; normalise by the measured mean
    // before using one as a light source.
    scene.environmentIntensity = 1 / Math.max(1e-6, sky.meanLuminance);
    if (sky.mode === 'sh' && sky.sh !== undefined) {
      // Mobile path: 27 baked floats instead of a PMREM chain.
      scene.add(new THREE.LightProbe(sky.sh, 1 / Math.max(1e-6, sky.meanLuminance)));
    }
  }

  const key = new THREE.DirectionalLight(0xfff4e0, 2.1);
  key.position.set(4, 6, 5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x9fb6ff, 0.55);
  fill.position.set(-5, 2, -3);
  scene.add(fill);
  scene.add(new THREE.AmbientLight(0xffffff, 0.12));

  const camera = new THREE.PerspectiveCamera(38, width / height, 0.05, 200);

  const labels: { text: string; sub: string; position: THREE.Vector3 }[] = [];
  const materialRows = buildMaterialGrid(scene, registry, labels);
  const modelRows = buildModelRow(scene, registry, labels);

  camera.position.set(0, 1.55, 12.4);
  camera.lookAt(0, 0.75, 0);

  renderer.render(scene, camera);
  drawLabels(camera, labels);

  const budget = mode === 'budget' ? await runBudgetProbe(registry) : undefined;

  const diagnostics = registry.diagnostics();
  const textures = collectTextures(registry, materialRows);
  const stats: IHarnessStats = {
    mode,
    root: baseUrl,
    tier: registry.tier,
    tierReason: diagnostics.tierReason,
    transcodeTarget: diagnostics.transcode.predictedTarget,
    transcodeAvailable: [...diagnostics.transcode.extensions],
    emulatedFormatsSuppressed: diagnostics.transcode.emulatedFormatsSuppressed,
    renderer: rendererName,
    maxTextureSize: renderer.capabilities.maxTextureSize,
    anisotropy: renderer.capabilities.getMaxAnisotropy(),
    textures,
    materials: materialRows,
    models: modelRows,
    environments: environments.map(describeEnvironment),
    budget,
    requestedTiers: [...new Set(textures.map((row) => row.tier))],
    tierMisses: diagnostics.tierMisses.map((miss) => ({ ...miss })),
    unavailableTiers: [...diagnostics.unavailableTiers],
    missing: [...diagnostics.missing],
    failures: diagnostics.failures.map((failure) => ({ ...failure })),
    textureBytes: diagnostics.textureBytes,
    textureBudgetBytes: diagnostics.textureBudgetBytes,
    gpuBytes: diagnostics.gpuBytes,
    progressSamples,
    progressMonotonic: progressSamples.every(
      (sample, index) => index === 0 || sample.fraction >= progressSamples[index - 1]!.fraction
    ),
    drawCalls: renderer.info.render.calls,
    sceneTriangles: renderer.info.render.triangles,
    characterCount: registry.characterIndex.length,
    loadMs: Math.round(loadMs),
  };

  renderReadout(stats);
  window.__HARNESS_STATS__ = stats;
  window.__HARNESS_READY__ = true;
}

/* -------------------------------------------------------------------------- */
/* Scene building                                                             */
/* -------------------------------------------------------------------------- */

/** Materials on spheres: curvature exercises normal, roughness and IBL at once. */
function buildMaterialGrid(
  scene: THREE.Scene,
  registry: AssetRegistry,
  labels: { text: string; sub: string; position: THREE.Vector3 }[]
): IMaterialRow[] {
  const rows: IMaterialRow[] = [];
  const geometry = new THREE.SphereGeometry(0.46, 48, 32);
  const columns = 6;
  const spacing = 1.34;

  GRID_MATERIALS.forEach((id, index) => {
    const material = registry.getMaterial(id);
    const detail = registry.getMaterialDetail(id);
    const entry = registry.getEntry(id) as IMaterialAsset | undefined;
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = (column - (columns - 1) / 2) * spacing;
    const y = 1.62 - row * spacing;

    const mesh = new THREE.Mesh(geometry, material ?? new THREE.MeshStandardMaterial());
    mesh.position.set(x, y, 0);
    scene.add(mesh);

    const pbr = material as THREE.MeshStandardMaterial | undefined;
    const albedo = pbr?.map ?? undefined;
    const ao = pbr?.aoMap ?? undefined;
    const tiers = new Set<string>();
    for (const textureKey of Object.values(entry?.textureKeys ?? {})) {
      if (typeof textureKey !== 'string') continue;
      const handle = registry.getTextureDetail(textureKey);
      if (handle) tiers.add(handle.tier);
    }

    rows.push({
      id,
      ormBound: detail?.ormBound === true,
      aoChannel: ao?.channel ?? -1,
      aoIsRoughness: ao !== undefined && ao === pbr?.roughnessMap,
      aoIsMetalness: ao !== undefined && ao === pbr?.metalnessMap,
      albedoColorSpace: albedo?.colorSpace ?? 'none',
      normalColorSpace: pbr?.normalMap?.colorSpace ?? 'none',
      albedoCompressed:
        (albedo as { isCompressedTexture?: boolean } | undefined)?.isCompressedTexture === true,
      missing: [...(detail?.missingTextures ?? [])],
      usesFallbackTexture: isMissingAsset(albedo),
      tiers: [...tiers],
    });

    // Last two segments only: the full id collides with its neighbour at this
    // cell width, and the family is obvious from the sphere.
    labels.push({
      text: id.split('.').slice(-2).join('.'),
      sub: `${[...tiers].join('/') || '—'} · ${albedo?.image?.width ?? 0}px`,
      position: new THREE.Vector3(x, y - 0.62, 0),
    });
  });

  return rows;
}

/** Models along the bottom, each normalised to a common cell height. */
function buildModelRow(
  scene: THREE.Scene,
  registry: AssetRegistry,
  labels: { text: string; sub: string; position: THREE.Vector3 }[]
): IModelRow[] {
  const rows: IModelRow[] = [];
  const spacing = 1.55;

  GRID_MODELS.forEach((id, index) => {
    const model = registry.getModelAsset(id);
    const x = (index - (GRID_MODELS.length - 1) / 2) * spacing;
    const y = -1.62;

    let meshes = 0;
    let compressed = 0;
    let total = 0;
    const visiblePerGroup: number[] = [];

    if (model !== undefined) {
      const instance = model.scene.clone(true);
      // A clone copies `visible`, so LOD0-only selection carries over — but
      // re-apply it in case a caller changed the template.
      model.setLodLevel(0);
      const box = new THREE.Box3();
      instance.updateWorldMatrix(true, true);
      instance.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh || !mesh.visible) return;
        let node: THREE.Object3D | null = mesh;
        let visible = true;
        while (node !== null) {
          if (!node.visible) visible = false;
          node = node.parent;
        }
        if (!visible) return;
        box.expandByObject(mesh);
      });

      const size = new THREE.Vector3();
      const centre = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(centre);
      const scale = size.y > 0 ? 1.0 / Math.max(size.x, size.y, size.z) : 1;
      instance.scale.setScalar(scale);
      instance.position.set(x - centre.x * scale, y - (centre.y - size.y / 2) * scale, 0);
      instance.rotation.y = Math.PI * 0.18;
      scene.add(instance);

      for (const group of model.lodGroups) {
        visiblePerGroup.push(group.levels.filter((level) => level.object.visible).length);
      }

      model.scene.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        meshes++;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          const pbr = material as THREE.MeshStandardMaterial;
          for (const texture of [pbr.map, pbr.normalMap, pbr.roughnessMap]) {
            if (!texture) continue;
            total++;
            if ((texture as { isCompressedTexture?: boolean }).isCompressedTexture === true) {
              compressed++;
            }
          }
        }
      });
    }

    rows.push({
      id,
      lodGroups: model?.lodGroups.length ?? 0,
      lodCount: model?.lodCount ?? 0,
      triangles: trianglesPerLevel(model),
      activeLevel: model?.activeLevel ?? -1,
      visiblePerGroup,
      meshes,
      embeddedTexturesCompressed: compressed,
      embeddedTexturesTotal: total,
    });

    labels.push({
      text: id.replace(/^model\.(prop|building)\./, ''),
      sub: `${model?.lodCount ?? 0} LOD · ${(model?.triangles ?? 0).toLocaleString()} tri`,
      position: new THREE.Vector3(x, y - 0.58, 0),
    });
  });

  return rows;
}

function trianglesPerLevel(model: ReturnType<AssetRegistry['getModelAsset']>): number[] {
  if (model === undefined) return [];
  const counts: number[] = [];
  const restore = model.activeLevel;
  for (let level = 0; level < model.lodCount; level++) {
    model.setLodLevel(level);
    counts.push(model.triangles);
  }
  model.setLodLevel(restore);
  return counts;
}

function describeEnvironment(environment: ILoadedEnvironment): IEnvironmentRow {
  const texture = environment.texture;
  return {
    key: environment.key,
    mode: environment.mode,
    meanLuminance: environment.meanLuminance,
    maxLuminance: environment.maxLuminance,
    shCoefficients: environment.sh9?.length ?? 0,
    minFilterIsLinear:
      texture.minFilter === THREE.LinearMipmapLinearFilter ||
      texture.minFilter === THREE.LinearFilter,
    magFilterIsLinear: texture.magFilter === THREE.LinearFilter,
    equirectMapping: texture.mapping === THREE.EquirectangularReflectionMapping,
    flipY: texture.flipY,
    gpuBytes: environment.gpuBytes,
    fallback: environment.fallback,
  };
}

function collectTextures(registry: AssetRegistry, materials: IMaterialRow[]): ITextureRow[] {
  const rows: ITextureRow[] = [];
  const seen = new Set<string>();
  for (const row of materials) {
    const entry = registry.getEntry(row.id) as IMaterialAsset | undefined;
    for (const textureKey of Object.values(entry?.textureKeys ?? {})) {
      if (typeof textureKey !== 'string' || seen.has(textureKey)) continue;
      seen.add(textureKey);
      const handle = registry.getTextureDetail(textureKey);
      if (handle) rows.push(describeTexture(handle));
    }
  }
  return rows;
}

function describeTexture(handle: IManagedTextureHandle): ITextureRow {
  return {
    key: handle.key,
    tier: handle.tier,
    gpuFormat: handle.gpuFormat,
    compressed: handle.compressed,
    codec: handle.codec,
    colorSpace: handle.colorSpace,
    width: handle.width,
    height: handle.height,
    gpuBytes: handle.gpuBytes,
    mipLevels: handle.texture.mipmaps?.length ?? 0,
    flipY: handle.texture.flipY,
    fallback: handle.fallback,
  };
}

/* -------------------------------------------------------------------------- */
/* LRU probe                                                                  */
/* -------------------------------------------------------------------------- */

function texturesOf(registry: AssetRegistry, materialId: string): string[] {
  const entry = registry.getEntry(materialId) as IMaterialAsset | undefined;
  return Object.values(entry?.textureKeys ?? {}).filter(
    (value): value is string => typeof value === 'string'
  );
}

/**
 * Squeeze the resident set against a small budget and check what goes.
 *
 * The setup is the real streaming case, not a synthetic one: half the
 * materials are unloaded (as a city block would be when the player leaves),
 * which drops their textures to refCount 0 while the other half stay bound to
 * live materials. Then — and this is the point — the UNREFERENCED half is
 * touched LAST, so it is the most recently used. A pure LRU would evict the
 * referenced textures first. Eviction must choose on reference count instead,
 * because a referenced texture is one something is drawing with right now.
 */
async function runBudgetProbe(registry: AssetRegistry): Promise<IBudgetReport> {
  const keepMaterials = GRID_MATERIALS.filter((_unused, index) => index % 2 === 0);
  const dropMaterials = GRID_MATERIALS.filter((_unused, index) => index % 2 === 1);

  for (const id of dropMaterials) registry.unload(id);

  const referenced = keepMaterials
    .flatMap((id) => texturesOf(registry, id))
    .filter((key) => registry.getTextureDetail(key) !== undefined);
  const unreferenced = dropMaterials
    .flatMap((id) => texturesOf(registry, id))
    .filter((key) => registry.getTextureDetail(key) !== undefined);

  // Referenced first, unreferenced second: the unreferenced set is now the
  // most recently used, so LRU alone would spare it.
  for (const key of referenced) registry.getTexture(key);
  for (const key of unreferenced) registry.getTexture(key);

  const before = registry.textureBytes;
  const budgetBytes = Math.floor(before * 0.45);
  registry.setTextureBudget(budgetBytes);
  const report = registry.diagnostics().lastEviction;
  const after = registry.textureBytes;
  const evicted = [...(report?.evicted ?? [])];

  return {
    budgetBytes,
    residentBefore: before,
    residentAfter: after,
    evicted,
    pinned: [...(report?.pinned ?? [])],
    retainedKeys: referenced,
    retainedStillResident: referenced.every(
      (key) => registry.getTextureDetail(key) !== undefined
    ),
    evictedWereUnreferenced: evicted.every((key) => unreferenced.includes(key)),
    // Eviction walks the LRU in order, so the first key out is the oldest
    // unreferenced one even though newer unreferenced keys also qualify.
    evictedInLruOrder:
      evicted.length === 0 || (evicted[0] === unreferenced[0] && evicted.length <= unreferenced.length),
    overBudget: report?.overBudget ?? false,
  };
}

/* -------------------------------------------------------------------------- */
/* Overlay                                                                    */
/* -------------------------------------------------------------------------- */

function drawLabels(
  camera: THREE.PerspectiveCamera,
  labels: { text: string; sub: string; position: THREE.Vector3 }[]
): void {
  const projected = new THREE.Vector3();
  for (const label of labels) {
    projected.copy(label.position).project(camera);
    const x = (projected.x * 0.5 + 0.5) * width;
    const y = (-projected.y * 0.5 + 0.5) * height;
    const node = document.createElement('div');
    node.className = 'label';
    node.style.left = `${x.toFixed(1)}px`;
    node.style.top = `${y.toFixed(1)}px`;
    node.innerHTML = `${escapeHtml(label.text)}<small>${escapeHtml(label.sub)}</small>`;
    overlay.appendChild(node);
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>]/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character] ?? character
  );
}

function renderReadout(stats: IHarnessStats): void {
  const compressed = stats.textures.filter((row) => row.compressed).length;
  const ormOk = stats.materials.every(
    (row) => row.ormBound && row.aoChannel === 0 && row.aoIsRoughness && row.aoIsMetalness
  );
  const mark = (ok: boolean, text: string): string =>
    `<span class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'} ${escapeHtml(text)}</span>`;

  const lines = [
    `<b>tier</b> ${escapeHtml(stats.tier)} — ${escapeHtml(stats.tierReason)}`,
    `<b>root</b> ${escapeHtml(stats.root)}`,
    `<b>transcode</b> ${escapeHtml(stats.transcodeTarget)}`,
    `<b>available</b> ${escapeHtml(stats.transcodeAvailable.join(', ') || 'none')}`,
    mark(
      compressed === stats.textures.length && stats.textures.length > 0,
      `${compressed}/${stats.textures.length} textures block-compressed on the GPU`
    ),
    mark(ormOk, `ORM bound to ao+roughness+metalness, aoMap.channel = 0`),
    mark(stats.missing.length === 0, `${stats.missing.length} missing assets`),
    mark(
      stats.environments.every((row) => row.minFilterIsLinear && row.equirectMapping),
      `environments re-filtered to linear + equirect`
    ),
    `<b>textures</b> ${bytesMb(stats.textureBytes)} / ${bytesMb(stats.textureBudgetBytes)} budget`,
    `<b>gpu total</b> ${bytesMb(stats.gpuBytes)}`,
    `<b>models</b> ${stats.models.length}, ${stats.models.filter((row) => row.lodCount === 3).length} with a 3-LOD chain`,
    `<b>load</b> ${stats.loadMs} ms · ${stats.drawCalls} draw calls`,
  ];
  if (stats.budget) {
    lines.push(
      mark(
        stats.budget.retainedStillResident && stats.budget.evictedWereUnreferenced,
        `LRU evicted ${stats.budget.evicted.length}, kept all ${stats.budget.retainedKeys.length} referenced`
      )
    );
  }
  readout.innerHTML = lines.join('<br>');
}
