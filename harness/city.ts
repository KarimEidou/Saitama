/**
 * CITY Z HARNESS
 *
 * Builds City Z from the committed plan and renders it three ways, so the two
 * claims that cannot be checked by a unit test can be checked by eye:
 *
 *   1. does the geometry read as a real city street, and
 *   2. is the district layout legible from above.
 *
 * A third view destroys a band of fracture chunks, which turns "the buildings
 * are pre-fractured" from an assertion into something visible: the seams the
 * generator baked in are exactly where the holes appear.
 *
 * Draw calls are read from `renderer.info.render.calls` after a real frame, so
 * the budget claim is measured rather than modelled. Frame timings are NOT
 * reported: this runs on SwiftShader, and a software-rasteriser frame time says
 * nothing about a phone.
 *
 * Playwright control surface: `window.__CITY_HARNESS__`.
 */

import * as THREE from 'three';
import rawPlan from '../assets/district/cityz.plan.json';
import {
  CityGenerator,
  buildBlockMesh,
  buildGroundMesh,
  destroyFractureChunk,
  installDestructionHook,
  mergeChunkGrounds,
  reportDrawCalls,
  type ICityChunkBuild,
  type ICityPlan,
} from '@/world/city';
import { FallbackMaterialLibrary, buildProceduralSky } from './city.materials';
import { ProxyModelLibrary } from './city.props';
import { RealAssetLibrary } from './city.assets';

/* -------------------------------------------------------------------------- */
/* Setup                                                                      */
/* -------------------------------------------------------------------------- */

const canvas = document.getElementById('view') as HTMLCanvasElement;
const statsEl = document.getElementById('stats')!;
const overlayEl = document.getElementById('overlay')!;
const materialsNoteEl = document.getElementById('materials-note')!;

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const materials = new FallbackMaterialLibrary(4, installDestructionHook);
const proxies = new ProxyModelLibrary(installDestructionHook);
const sky = buildProceduralSky(renderer);

const plan = rawPlan as unknown as ICityPlan;
const generator = new CityGenerator(plan, { defaultDetail: 'full', includeProps: true });

/**
 * The processed Poly Haven set, when it is on disk.
 *
 * Resolution goes real-first, stand-in-second, per id: a texture that failed to
 * transcode falls back on its own rather than dropping the whole city back to
 * synthesised materials.
 */
let real: RealAssetLibrary | undefined;

function resolveMaterial(key: string): THREE.Material {
  return real?.getMaterial(key) ?? materials.get(key);
}

function resolveModel(key: string) {
  return real?.getModel(key) ?? proxies.get(key);
}

/**
 * Where the street camera stands: North 4 Street, the shotengai, looking north
 * towards the arcade.
 *
 * Deliberately NOT on Route Z. The arterial is 26 m of carriageway plus 5 m
 * pavements, so a shot from its centreline is 40% empty asphalt and reads as a
 * boulevard. The shopping street is 12 m of carriageway between building lines
 * 18 m apart, which is the proportion a Japanese shopping street actually has
 * and the one the geometry has to survive.
 */
const STREET_EYE = new THREE.Vector3(93.4, 1.72, -286);
const STREET_LOOK = new THREE.Vector3(97.5, 6.2, -372);

/** Chebyshev chunk radius kept resident, matching `IWorldConfig`. */
const RESIDENT_RADIUS = 2;

/* -------------------------------------------------------------------------- */
/* Scene construction                                                         */
/* -------------------------------------------------------------------------- */

interface IBuiltScene {
  readonly scene: THREE.Scene;
  readonly chunks: readonly ICityChunkBuild[];
  /** Chunks inside the streaming radius — the set the budget is written for. */
  readonly coreChunks: readonly ICityChunkBuild[];
  readonly blockMeshes: ReturnType<typeof buildBlockMesh>[];
  readonly generationMs: number;
  readonly buildMs: number;
}

function makeScene(fogNear: number, fogFar: number): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = sky.texture;
  scene.environment = sky.environment;
  scene.environmentIntensity = 0.85;
  scene.fog = new THREE.Fog(0xb9c6d4, fogNear, fogFar);

  const sun = new THREE.DirectionalLight(0xfff2dd, 2.6);
  // Low-ish afternoon sun: long shadows down the street, which is what makes a
  // row of buildings read as separate volumes rather than one wall.
  sun.position.set(-160, 190, -120);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 700;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.05;
  scene.add(sun);
  scene.add(sun.target);

  const hemi = new THREE.HemisphereLight(0xa9c6e8, 0x5b5348, 0.65);
  scene.add(hemi);
  return scene;
}

/** Aim the shadow camera at a point, with a given half-extent in metres. */
function focusShadows(scene: THREE.Scene, at: THREE.Vector3, extent: number): void {
  const sun = scene.children.find((c) => c instanceof THREE.DirectionalLight) as
    | THREE.DirectionalLight
    | undefined;
  if (!sun) return;
  sun.target.position.copy(at);
  sun.target.updateMatrixWorld();
  sun.position.set(at.x - 170, at.y + 210, at.z - 130);
  const cam = sun.shadow.camera;
  cam.left = -extent;
  cam.right = extent;
  cam.top = extent;
  cam.bottom = -extent;
  cam.updateProjectionMatrix();
}

/**
 * Build a region of the city into a scene.
 *
 * Detail falls off with chunk distance from the focus, which is the same
 * policy `detailForDistance` gives streaming: full relief nearby, flat panels
 * in the middle band, extruded footprints for the skyline. Ground is merged
 * across the whole region — that is what turns 4 draw calls per chunk into 4
 * for the region.
 */
function buildRegion(
  focusChunk: readonly [number, number],
  radii: { full: number; reduced: number; box: number },
  options: { props: boolean; fog: [number, number] }
): IBuiltScene {
  const scene = makeScene(options.fog[0], options.fog[1]);
  const t0 = performance.now();
  const chunks: ICityChunkBuild[] = [];
  for (let cz = focusChunk[1] - radii.box; cz <= focusChunk[1] + radii.box; cz++) {
    for (let cx = focusChunk[0] - radii.box; cx <= focusChunk[0] + radii.box; cx++) {
      if (cx < -8 || cx > 7 || cz < -8 || cz > 7) continue;
      const distance = Math.max(Math.abs(cx - focusChunk[0]), Math.abs(cz - focusChunk[1]));
      const detail = distance <= radii.full ? 'full' : distance <= radii.reduced ? 'reduced' : 'box';
      chunks.push(
        generator.generate(cx, cz, { detail, includeProps: options.props && distance <= radii.reduced })
      );
    }
  }
  const t1 = performance.now();

  const blockMeshes: ReturnType<typeof buildBlockMesh>[] = [];
  const resolve = resolveMaterial;

  for (const chunk of chunks) {
    for (const block of chunk.blocks) {
      if (block.geometry.buffers.vertexCount === 0) continue;
      const mesh = buildBlockMesh(block, resolve);
      blockMeshes.push(mesh);
      scene.add(mesh.mesh);
    }
  }

  // Ground merges across the region: 4 draw calls per material set, not per chunk.
  const grounds = chunks.map((c) => c.ground).filter((g): g is NonNullable<typeof g> => !!g);
  for (const merged of mergeChunkGrounds(grounds)) {
    scene.add(buildGroundMesh(merged, resolve));
  }

  // Props instance across the whole region, one draw call per model.
  const byKey = new Map<string, number[]>();
  for (const chunk of chunks) {
    for (const batch of chunk.instances) {
      const list = byKey.get(batch.assetKey) ?? [];
      for (let i = 0; i < batch.matrices.length; i++) list.push(batch.matrices[i]);
      byKey.set(batch.assetKey, list);
    }
  }
  const matrix = new THREE.Matrix4();
  for (const key of [...byKey.keys()].sort()) {
    const flat = byKey.get(key)!;
    const model = resolveModel(key);
    if (!model) continue;
    const count = flat.length / 16;
    const instanced = new THREE.InstancedMesh(model.geometry, model.material, count);
    for (let i = 0; i < count; i++) {
      matrix.fromArray(flat, i * 16);
      instanced.setMatrixAt(i, matrix);
    }
    instanced.instanceMatrix.needsUpdate = true;
    instanced.castShadow = true;
    instanced.receiveShadow = true;
    scene.add(instanced);
  }

  // The resident set is what `IWorldConfig.streamingRadiusChunks` keeps loaded
  // (2 -> 5 x 5). Everything the harness builds beyond that exists so the
  // skyline is not empty; counting it against the resident budget would be
  // measuring the backdrop.
  const coreChunks = chunks.filter(
    (c) =>
      Math.max(Math.abs(c.coord.x - focusChunk[0]), Math.abs(c.coord.z - focusChunk[1])) <=
      RESIDENT_RADIUS
  );

  return {
    scene,
    chunks,
    coreChunks,
    blockMeshes,
    generationMs: t1 - t0,
    buildMs: performance.now() - t1,
  };
}

/* -------------------------------------------------------------------------- */
/* Views                                                                      */
/* -------------------------------------------------------------------------- */

type ViewName = 'street' | 'map' | 'skyline' | 'fracture';

interface IView {
  readonly built: IBuiltScene;
  readonly camera: THREE.Camera;
  readonly label: string;
}

const views = new Map<ViewName, IView>();
let current: ViewName = 'street';

function aspect(): number {
  return canvas.clientWidth / Math.max(1, canvas.clientHeight);
}

function makeStreetView(): IView {
  const built = buildRegion([0, -3], { full: 2, reduced: 4, box: 6 }, {
    props: true,
    fog: [180, 1100],
  });
  focusShadows(built.scene, STREET_EYE, 110);
  const camera = new THREE.PerspectiveCamera(58, aspect(), 0.2, 1400);
  camera.position.copy(STREET_EYE);
  camera.lookAt(STREET_LOOK);
  return {
    built,
    camera,
    label: 'North 4 Street — the Z-City shotengai, eye height 1.72 m',
  };
}

function makeMapView(): IView {
  const built = buildRegion([0, 0], { full: -1, reduced: 0, box: 8 }, {
    props: false,
    fog: [2000, 4000],
  });
  built.scene.background = new THREE.Color(0x1a2130);
  focusShadows(built.scene, new THREE.Vector3(0, 0, 0), 820);
  const half = 800;
  const a = aspect();
  const camera = new THREE.OrthographicCamera(-half * a, half * a, half, -half, 1, 3000);
  camera.position.set(0, 1200, 0.001);
  camera.lookAt(0, 0, 0);
  return { built, camera, label: 'City Z — 1536 m x 1536 m district map, 16 x 16 chunks' };
}

function makeSkylineView(): IView {
  const built = buildRegion([1, 0], { full: 1, reduced: 3, box: 7 }, {
    props: true,
    fog: [200, 1100],
  });
  focusShadows(built.scene, new THREE.Vector3(0, 20, 0), 320);
  const camera = new THREE.PerspectiveCamera(46, aspect(), 0.5, 2200);
  camera.position.set(330, 132, 330);
  camera.lookAt(-30, 24, -60);
  return { built, camera, label: 'Downtown from the south-east, 132 m' };
}

function makeFractureView(): IView {
  const built = buildRegion([1, -4], { full: 1, reduced: 2, box: 3 }, {
    props: true,
    fog: [180, 900],
  });
  focusShadows(built.scene, new THREE.Vector3(96, 12, -330), 120);

  // Take out floors 1-3 of everything near the camera. The holes land on the
  // baked chunk seams: one floor x one facade quadrant at a time.
  let destroyedChunks = 0;
  for (const blockMesh of built.blockMeshes) {
    for (const [buildingId, layout] of Object.entries(blockMesh.fractures)) {
      for (const chunk of layout.chunks) {
        if (chunk.floor < 1 || chunk.floor > 3) continue;
        if (chunk.quadrant !== 0 && chunk.quadrant !== 3) continue;
        destroyFractureChunk(blockMesh, buildingId, chunk.index);
        destroyedChunks++;
      }
    }
  }
  const camera = new THREE.PerspectiveCamera(52, aspect(), 0.2, 1200);
  camera.position.set(148, 34, -268);
  camera.lookAt(86, 12, -344);
  return {
    built,
    camera,
    label:
      `Baked fracture: ${destroyedChunks} chunks removed — floors 2-4, east and ` +
      `north quadrants. Every hole lands on a seam the generator baked in.`,
  };
}

function getView(name: ViewName): IView {
  let view = views.get(name);
  if (!view) {
    view =
      name === 'street'
        ? makeStreetView()
        : name === 'map'
          ? makeMapView()
          : name === 'skyline'
            ? makeSkylineView()
            : makeFractureView();
    views.set(name, view);
  }
  return view;
}

/* -------------------------------------------------------------------------- */
/* Rendering and readout                                                      */
/* -------------------------------------------------------------------------- */

function resize(): void {
  const width = canvas.clientWidth || 1280;
  const height = canvas.clientHeight || 720;
  renderer.setSize(width, height, false);
  for (const view of views.values()) {
    if (view.camera instanceof THREE.PerspectiveCamera) {
      view.camera.aspect = width / height;
      view.camera.updateProjectionMatrix();
    }
  }
}

interface IHarnessStats {
  readonly view: string;
  readonly chunks: number;
  readonly blocks: number;
  readonly buildings: number;
  readonly triangles: number;
  readonly drawCallsRendered: number;
  readonly drawCallsPerBlockWorst: number;
  /** Draw calls for the 5 x 5 resident set — the budget that has to hold. */
  readonly residentReport: ReturnType<typeof reportDrawCalls>;
  /** Draw calls for everything the harness built, backdrop included. */
  readonly regionReport: ReturnType<typeof reportDrawCalls>;
  readonly generationMs: number;
  readonly buildMs: number;
  readonly materialsSynthesised: number;
  /** Materials resolved from the processed Poly Haven KTX2 set. */
  readonly realMaterials: number;
  /** Prop models resolved from the processed GLB set. */
  readonly realModels: number;
  readonly assetProblems: readonly string[];
  readonly propsResolved: number;
  readonly propsMissing: readonly string[];
  readonly usingRealTextures: boolean;
}

let lastStats: IHarnessStats | undefined;

function render(): IHarnessStats {
  resize();
  const view = getView(current);
  renderer.info.reset();
  renderer.render(view.built.scene, view.camera);

  let buildings = 0;
  let worstBlock = 0;
  for (const chunk of view.built.chunks) {
    for (const block of chunk.blocks) {
      buildings += block.buildings.length;
      worstBlock = Math.max(worstBlock, block.drawCalls);
    }
  }

  const stats: IHarnessStats = {
    view: current,
    chunks: view.built.chunks.length,
    blocks: view.built.chunks.reduce((n, c) => n + c.blocks.length, 0),
    buildings,
    triangles: renderer.info.render.triangles,
    drawCallsRendered: renderer.info.render.calls,
    drawCallsPerBlockWorst: worstBlock,
    residentReport: reportDrawCalls(view.built.coreChunks),
    regionReport: reportDrawCalls(view.built.chunks),
    generationMs: view.built.generationMs,
    buildMs: view.built.buildMs,
    materialsSynthesised: materials.size,
    realMaterials: real?.materialCount() ?? 0,
    realModels: real?.modelCount() ?? 0,
    assetProblems: (real?.problems() ?? []).slice(0, 6),
    propsResolved: proxies.resolved().length,
    propsMissing: proxies.missing(),
    usingRealTextures: (real?.materialCount() ?? 0) > 0,
  };
  lastStats = stats;
  paintReadout(stats, view.label);
  return stats;
}

function paintReadout(stats: IHarnessStats, label: string): void {
  const r = stats.residentReport;
  const rows: [string, string][] = [
    ['view', stats.view],
    ['chunks built', String(stats.chunks)],
    ['blocks', String(stats.blocks)],
    ['buildings', String(stats.buildings)],
    ['triangles drawn', stats.triangles.toLocaleString()],
    ['draw calls (frame)', String(stats.drawCallsRendered)],
    ['worst block draws', String(stats.drawCallsPerBlockWorst)],
    ['— resident 5x5 —', ''],
    ['blocks', String(r.blocks)],
    ['per-block total', String(r.perBlockTotal)],
    ['batched total', String(r.total)],
    ['  blocks (batched)', String(r.mergedBlockCalls)],
    ['  ground', String(r.groundCalls)],
    ['  props', String(r.propCalls)],
    ['— whole built region —', ''],
    ['chunks', String(stats.regionReport.chunks)],
    ['batched total', String(stats.regionReport.total)],
    ['— generation —', ''],
    ['generate', `${stats.generationMs.toFixed(0)} ms`],
    ['scene build', `${stats.buildMs.toFixed(0)} ms`],
    ['real materials', String(stats.realMaterials)],
    ['real models', String(stats.realModels)],
    ['stand-in materials', String(stats.materialsSynthesised)],
    ['stand-in props', String(stats.propsResolved)],
  ];
  statsEl.innerHTML =
    '<table>' +
    rows
      .map(([k, v]) =>
        v === ''
          ? `<tr><td class="k" colspan="2" style="color:#7f8ea8">${k}</td></tr>`
          : `<tr><td class="k">${k}</td><td class="v">${v}</td></tr>`
      )
      .join('') +
    '</table>';
  materialsNoteEl.innerHTML = stats.usingRealTextures
    ? `Bound ${stats.realMaterials} Poly Haven CC0 KTX2 materials and ` +
      `${stats.realModels} processed GLB models by manifest id.` +
      (stats.assetProblems.length > 0
        ? `<br><span class="warn">${stats.assetProblems.length} id(s) fell back: ` +
          `${stats.assetProblems[0]}</span>`
        : '')
    : '<span class="warn">Poly Haven KTX2 set not resident.</span> Materials are ' +
      'synthesised stand-ins bound to the same manifest ids; geometry, UV density ' +
      'and vertex tint are the shipping ones.';
  overlayEl.textContent = label;
}

/* -------------------------------------------------------------------------- */
/* Control surface                                                            */
/* -------------------------------------------------------------------------- */

declare global {
  interface Window {
    __CITY_HARNESS__: {
      ready: boolean;
      setView(name: ViewName): IHarnessStats;
      stats(): IHarnessStats | undefined;
      render(): IHarnessStats;
      planSummary(): Record<string, number>;
    };
  }
}

window.__CITY_HARNESS__ = {
  ready: false,
  setView(name: ViewName) {
    current = name;
    return render();
  },
  stats() {
    return lastStats;
  },
  render,
  planSummary() {
    return {
      planVersion: plan.planVersion,
      roads: plan.roads.length,
      zones: plan.zones.length,
      blocks: plan.blocks.length,
      landmarks: plan.landmarks.length,
      craters: plan.craters.length,
      intersections: plan.intersections.length,
    };
  },
};

async function boot(): Promise<void> {
  // Best effort, and strictly bounded. A fresh clone has no `public/assets/`,
  // and the harness still has to produce a picture; so must a run where one
  // texture refuses to transcode.
  try {
    real = await RealAssetLibrary.open('/game-assets', renderer, 'mobile', installDestructionHook, 4);
    if (real) {
      const required = generator.requiredAssets();
      await real.loadMaterials(required.materials);
      await real.loadModels(required.models);
      console.log(
        `[city-harness] real assets: ${real.materialCount()} materials, ` +
          `${real.modelCount()} models, ${real.problems().length} problems`
      );
      for (const problem of real.problems().slice(0, 8)) {
        console.log(`[city-harness] fallback: ${problem}`);
      }
    } else {
      console.log('[city-harness] no processed asset set; using stand-ins');
    }
  } catch (error) {
    console.log(`[city-harness] asset load failed, using stand-ins: ${String(error)}`);
    real = undefined;
  }
  window.addEventListener('resize', () => render());
  render();
  window.__CITY_HARNESS__.ready = true;
}

void boot();
