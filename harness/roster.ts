/**
 * VISUAL HARNESS — the character roster under real PBR lighting
 *
 * Unit tests prove the atlas is deterministic, that every material binds a
 * base-colour map and that no character needs more than one draw call. None of
 * that proves a character LOOKS like anything, and "looks like something" is
 * the actual requirement — so this page renders the shipping assets under a
 * real CC0 HDRI and lets a human judge.
 *
 * It renders THE BAKED FILES, not an in-browser approximation: the same PNGs
 * `tools/build-characters.ts` writes into `public/assets/chr/`, bound through
 * the same `createRosterMaterial` the game uses. If the bake is wrong, this
 * page is wrong in exactly the same way, which is the point.
 *
 * Four modes, chosen so each can fail independently:
 *
 *   SHEET  the whole cast — four heroes, a civilian, four named monsters and
 *          one representative of each threat tier — side by side. Proves the
 *          cast reads as a cast and that nothing renders as untextured grey.
 *   FACE   Saitama at close range, plus all four expressions. This is the
 *          screenshot that decides whether the face work succeeded: the joke
 *          is a blank stare, and a blank stare either reads or it does not.
 *   METAL  Genos' forearm filling the frame. Metalness 1.0 has nothing to
 *          reflect without an environment probe, so if this panel is flat grey
 *          the specular path is broken and the harness says so.
 *   CROWD  instanced civilians recoloured per instance off ONE atlas, with the
 *          draw-call count on screen.
 */

import * as THREE from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import type { LodLevel } from '@/characters/mesh';
import { buildHumanoid, createSkinnedMesh } from '@/characters/mesh';
import {
  attachCrowdAttributes,
  attachSoloCrowdColors,
  auditMaterial,
  crowdColors,
  buildCrowdAttributes,
  characterDir,
  civilianEntry,
  createRosterMaterial,
  distinctCrowdPalettes,
  entryGlows,
  faceRegion,
  listRoster,
  measureHead,
  prepareRosterGeometry,
  proximityFadeAmount,
  rosterEntry,
  setProximityFade,
  type Expression,
  type RosterEntry,
  type RosterMaterial,
} from '@/characters/roster';

declare global {
  interface Window {
    __HARNESS_READY__?: boolean;
    __HARNESS_STATS__?: unknown;
    __HARNESS_ERROR__?: string;
  }
}

type Mode = 'sheet' | 'face' | 'metal' | 'crowd';

const params = new URLSearchParams(location.search);
const MODE = (params.get('mode') ?? 'sheet') as Mode;

const LAYOUT: Readonly<Record<Mode, { width: number; height: number }>> = {
  sheet: { width: 1920, height: 840 },
  face: { width: 1600, height: 900 },
  metal: { width: 1600, height: 900 },
  crowd: { width: 1600, height: 760 },
};

const WIDTH = LAYOUT[MODE].width;
const HEIGHT = LAYOUT[MODE].height;

const stage = document.getElementById('stage') as HTMLDivElement;
const canvas = document.getElementById('view') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLDivElement;
const readout = document.getElementById('readout') as HTMLDivElement;
const errorBox = document.getElementById('error') as HTMLPreElement;
stage.style.width = `${WIDTH}px`;
stage.style.height = `${HEIGHT}px`;
canvas.style.width = `${WIDTH}px`;
canvas.style.height = `${HEIGHT}px`;

/* -------------------------------------------------------------------------- */
/* Asset loading                                                              */
/* -------------------------------------------------------------------------- */

/** Where the baked characters are served from. */
const CHR_ROOT = '/assets';

const textureLoader = new THREE.TextureLoader();

async function loadTexture(url: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    textureLoader.load(
      url,
      (texture) => resolve(texture),
      undefined,
      () => reject(new Error(`missing texture ${url}`))
    );
  });
}

interface LoadedMaps {
  readonly map: THREE.Texture;
  readonly normalMap: THREE.Texture;
  readonly ormMap: THREE.Texture;
  readonly faceMap: THREE.Texture;
  readonly emissiveMap?: THREE.Texture;
  readonly maskMap?: THREE.Texture;
  readonly bytes: number;
}

const mapCache = new Map<string, Promise<LoadedMaps>>();

function textureBytes(texture: THREE.Texture): number {
  const image = texture.image as { width?: number; height?: number } | undefined;
  const width = image?.width ?? 0;
  const height = image?.height ?? 0;
  // RGBA on upload, plus the mip chain.
  return Math.round(width * height * 4 * 1.34);
}

async function loadMaps(entry: RosterEntry, tier: 'mobile' | 'high'): Promise<LoadedMaps> {
  const key = `${entry.id}:${tier}`;
  const cached = mapCache.get(key);
  if (cached !== undefined) return cached;

  const dir = `${CHR_ROOT}/${characterDir(entry)}`;
  const promise = (async (): Promise<LoadedMaps> => {
    const [map, normalMap, ormMap, faceMap] = await Promise.all([
      loadTexture(`${dir}/albedo.${tier}.png`),
      loadTexture(`${dir}/normal.${tier}.png`),
      loadTexture(`${dir}/orm.${tier}.png`),
      loadTexture(`${dir}/face.${tier}.png`),
    ]);
    const emissiveMap = entryGlows(entry)
      ? await loadTexture(`${dir}/emissive.${tier}.png`)
      : undefined;
    const maskMap = entry.crowd === true ? await loadTexture(`${dir}/mask.${tier}.png`) : undefined;
    const bytes =
      textureBytes(map) +
      textureBytes(normalMap) +
      textureBytes(ormMap) +
      textureBytes(faceMap) +
      (emissiveMap === undefined ? 0 : textureBytes(emissiveMap)) +
      (maskMap === undefined ? 0 : textureBytes(maskMap));
    return { map, normalMap, ormMap, faceMap, emissiveMap, maskMap, bytes };
  })();

  mapCache.set(key, promise);
  return promise;
}

/* -------------------------------------------------------------------------- */
/* Renderer and environment                                                   */
/* -------------------------------------------------------------------------- */

// `preserveDrawingBuffer` matters here: a mode that awaits anything between
// its last render and the screenshot would otherwise be composited away and
// read back as a black frame.
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  preserveDrawingBuffer: true,
});
renderer.setSize(WIDTH, HEIGHT, false);
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.92;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();

/**
 * Each mode publishes how to draw its final frame.
 *
 * Set by the mode, called once by `main` immediately before the pixel check,
 * so what is measured is exactly what is screenshotted — no matter how much
 * asynchronous work the mode did after its first render.
 */
let redraw: () => void = () => {};

/**
 * Load the real CC0 environment.
 *
 * A metalness-1.0 surface reflects the environment and NOTHING else — with no
 * probe it renders black, and with a flat grey probe it renders flat grey,
 * which is indistinguishable from untextured geometry. So the harness insists
 * on the shipping HDRI and reports which one it actually got.
 */
async function loadEnvironment(): Promise<{ env: THREE.Texture; source: string }> {
  const loader = new KTX2Loader().setTranscoderPath(`${CHR_ROOT}/basis/`).detectSupport(renderer);
  const url = `${CHR_ROOT}/env/hdri.sky.day.mobile.ktx2`;
  const texture = await loader.loadAsync(url);
  // KTX2Loader hands back a DataTexture with NearestFilter; PMREM needs a
  // proper mip chain or the reflection comes back blocky.
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const env = pmrem.fromEquirectangular(texture).texture;
  pmrem.dispose();
  loader.dispose();
  return { env, source: 'hdri.sky.day (Poly Haven, CC0)' };
}

/* -------------------------------------------------------------------------- */
/* Character construction                                                     */
/* -------------------------------------------------------------------------- */

interface BuiltCharacter {
  readonly entry: RosterEntry;
  readonly root: THREE.Object3D;
  readonly mesh: THREE.SkinnedMesh;
  readonly material: RosterMaterial;
  readonly triangles: number;
  readonly height: number;
  readonly bytes: number;
  readonly drawCalls: number;
}

/**
 * A relaxed standing pose.
 *
 * The generator's bind pose is a T-pose — correct for skinning, useless for a
 * model sheet, and it makes a 3.5 m monster four metres wide. Dropping the arms
 * to ~70 degrees is what turns a row of mannequins into a cast, and it is also
 * what lets the sheet fit fourteen characters without them overlapping.
 *
 * Animation is a separate workstream; nothing here is meant to survive into it.
 */
function poseForDisplay(mesh: THREE.SkinnedMesh, seed: number): void {
  const bone = (name: string): THREE.Bone | undefined =>
    mesh.skeleton.bones.find((candidate) => candidate.name === name);
  const wave = (offset: number): number => Math.sin(seed * 1.7 + offset);

  const armL = bone('LeftArm');
  const armR = bone('RightArm');
  const foreL = bone('LeftForeArm');
  const foreR = bone('RightForeArm');
  const spine = bone('Spine1');
  const head = bone('Head');
  const drop = 1.16 + wave(0.3) * 0.07;

  // The arms rest along -X (left) and +X (right); a rotation about Z swings
  // them down towards the hips.
  if (armL !== undefined) armL.rotation.z = drop;
  if (armR !== undefined) armR.rotation.z = -drop;
  if (foreL !== undefined) foreL.rotation.z = 0.22 + wave(2.0) * 0.12;
  if (foreR !== undefined) foreR.rotation.z = -0.22 - wave(2.6) * 0.12;
  if (spine !== undefined) spine.rotation.y = wave(0.9) * 0.05;
  if (head !== undefined) head.rotation.y = wave(1.6) * 0.09;
  mesh.skeleton.bones[0]?.updateMatrixWorld(true);
}

const probeScene = new THREE.Scene();
const probeCamera = new THREE.PerspectiveCamera(40, 1, 0.1, 60);

/**
 * Draw calls for ONE character, measured rather than asserted.
 *
 * Rendering the whole sheet and dividing would fold in the ground plane and
 * whatever else is in the scene, so each character is rendered alone into a
 * 1x1 scratch viewport and `renderer.info` is read directly.
 */
function measureDrawCalls(root: THREE.Object3D, height: number): number {
  probeScene.clear();
  probeScene.environment = scene.environment;
  const parent = root.parent;
  probeScene.add(root);
  probeCamera.position.set(0, height * 0.6, height * 1.6);
  probeCamera.lookAt(0, height * 0.5, 0);
  const target = renderer.getRenderTarget();
  renderer.setRenderTarget(null);
  renderer.setViewport(0, 0, 4, 4);
  renderer.setScissorTest(false);
  renderer.info.reset();
  renderer.render(probeScene, probeCamera);
  const calls = renderer.info.render.calls;
  renderer.setRenderTarget(target);
  probeScene.remove(root);
  if (parent !== null) parent.add(root);
  return calls;
}

async function buildCharacter(
  entry: RosterEntry,
  lod: LodLevel = 0,
  tier: 'mobile' | 'high' = 'high',
  expression?: Expression
): Promise<BuiltCharacter> {
  const build = buildHumanoid(entry.recipe.profile, { ...entry.recipe.options, lod });
  prepareRosterGeometry(build);
  // A crowd character rendered on its own still runs the tint injection, so it
  // needs the four colour attributes present or it multiplies to black.
  if (entry.crowd === true) attachSoloCrowdColors(build.geometry, crowdColors(entry.seed));
  const head = measureHead(build);
  const region = faceRegion(entry.face, head);
  const maps = await loadMaps(entry, tier);

  const material = createRosterMaterial(maps, {
    name: entry.id,
    faceRect: region.atlas,
    expression: expression ?? entry.restExpression ?? 'neutral',
    crowdTint: entry.crowd === true,
    proximityFade: entry.player === true,
    envMapIntensity: 1,
  });

  const { mesh, root } = createSkinnedMesh(build, material);
  poseForDisplay(mesh, entry.seed);

  const drawCalls = measureDrawCalls(root, build.stats.height);

  return {
    entry,
    root,
    mesh,
    material,
    triangles: build.stats.triangles,
    height: build.stats.height,
    bytes: maps.bytes,
    drawCalls,
  };
}

/* -------------------------------------------------------------------------- */
/* Scene furniture                                                            */
/* -------------------------------------------------------------------------- */

function addGround(size: number, y = 0): THREE.Mesh {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.94, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = y;
  ground.receiveShadow = true;
  scene.add(ground);
  return ground;
}

function addLights(distance: number): void {
  const sun = new THREE.DirectionalLight(0xfff4e4, 1.7);
  sun.position.set(distance * 0.6, distance * 1.1, distance * 0.9);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const extent = distance * 1.2;
  sun.shadow.camera.left = -extent;
  sun.shadow.camera.right = extent;
  sun.shadow.camera.top = extent;
  sun.shadow.camera.bottom = -extent;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = distance * 4;
  sun.shadow.bias = -0.0012;
  scene.add(sun);

  // A cool rim from behind separates dark monsters from a dark background.
  const rim = new THREE.DirectionalLight(0xbcd4ff, 0.45);
  rim.position.set(-distance * 0.9, distance * 0.5, -distance);
  scene.add(rim);
}

function label(x: number, y: number, text: string, sub?: string): void {
  const node = document.createElement('div');
  node.className = 'label';
  node.style.left = `${x}px`;
  node.style.top = `${y}px`;
  node.innerHTML = sub === undefined ? text : `${text}<small>${sub}</small>`;
  overlay.appendChild(node);
}

function panelTitle(x: number, y: number, text: string): void {
  const node = document.createElement('div');
  node.className = 'panel-title';
  node.style.left = `${x}px`;
  node.style.top = `${y}px`;
  node.textContent = text;
  overlay.appendChild(node);
}

/** Project a world point into overlay pixels, honouring a scissor panel. */
function project(
  position: THREE.Vector3,
  camera: THREE.Camera,
  panel: { x: number; width: number } = { x: 0, width: WIDTH }
): { x: number; y: number } {
  const projected = position.clone().project(camera);
  return {
    x: panel.x + (projected.x * 0.5 + 0.5) * panel.width,
    y: (-projected.y * 0.5 + 0.5) * HEIGHT,
  };
}

/* -------------------------------------------------------------------------- */
/* Pixel checks                                                               */
/* -------------------------------------------------------------------------- */

interface FrameStats {
  readonly distinctColors: number;
  readonly stdDev: number;
  readonly magentaPixels: number;
  readonly meanLuma: number;
}

function inspectFrame(): FrameStats {
  const scratch = document.createElement('canvas');
  scratch.width = 240;
  scratch.height = 160;
  const context = scratch.getContext('2d');
  if (context === null) {
    return { distinctColors: 0, stdDev: 0, magentaPixels: 0, meanLuma: 0 };
  }
  context.drawImage(canvas, 0, 0, 240, 160);
  const data = context.getImageData(0, 0, 240, 160).data;
  const colors = new Set<number>();
  let sum = 0;
  let sumSq = 0;
  let magenta = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    colors.add((r << 16) | (g << 8) | b);
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    sum += luma;
    sumSq += luma * luma;
    if (r > 190 && b > 190 && g < 90) magenta++;
  }
  const n = data.length / 4;
  const mean = sum / n;
  return {
    distinctColors: colors.size,
    stdDev: Math.sqrt(Math.max(0, sumSq / n - mean * mean)),
    magentaPixels: magenta,
    meanLuma: mean,
  };
}

/* -------------------------------------------------------------------------- */
/* Modes                                                                      */
/* -------------------------------------------------------------------------- */

interface CharacterRow {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly threat?: string;
  readonly triangles: number;
  readonly height: number;
  readonly drawCalls: number;
  readonly textureBytes: number;
  readonly maps: readonly string[];
  readonly missing: readonly string[];
  readonly features: string;
  readonly aoChannel: number;
}

function describe(built: BuiltCharacter): CharacterRow {
  const audit = auditMaterial(built.material);
  const maps: string[] = ['map', 'normalMap', 'ormMap'];
  if (audit.hasEmissive) maps.push('emissiveMap');
  if (audit.hasFace) maps.push('faceMap');
  return {
    id: built.entry.id,
    name: built.entry.name,
    kind: built.entry.kind,
    threat: built.entry.threat,
    triangles: built.triangles,
    height: Number(built.height.toFixed(2)),
    drawCalls: built.drawCalls,
    textureBytes: built.bytes,
    maps,
    missing: audit.missing,
    features: audit.features,
    aoChannel: audit.aoChannel,
  };
}

async function runSheet(): Promise<Record<string, unknown>> {
  const entries = listRoster();
  const camera = new THREE.PerspectiveCamera(32, WIDTH / HEIGHT, 0.5, 200);
  addLights(14);
  addGround(80, 0);

  const perRow = 7;
  const spacing = 2.45;
  const rowDepth = 3.9;
  const rows: CharacterRow[] = [];
  const built: BuiltCharacter[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const character = await buildCharacter(entry, 0, 'high');
    const column = i % perRow;
    const row = Math.floor(i / perRow);
    character.root.position.set(
      (column - (perRow - 1) / 2) * spacing,
      0,
      row * -rowDepth + (row === 1 ? 0 : 0)
    );
    character.root.rotation.y = Math.PI + (column - (perRow - 1) / 2) * 0.05;
    scene.add(character.root);
    built.push(character);
    rows.push(describe(character));
  }

  camera.position.set(0, 2.3, 13.6);
  camera.lookAt(0, 1.75, -2.2);
  scene.add(camera);

  redraw = (): void => {
    renderer.setViewport(0, 0, WIDTH, HEIGHT);
    renderer.setScissorTest(false);
    renderer.render(scene, camera);
  };
  renderer.setViewport(0, 0, WIDTH, HEIGHT);
  renderer.setScissorTest(false);
  renderer.info.reset();
  renderer.render(scene, camera);
  const sceneCalls = renderer.info.render.calls;
  const sceneTriangles = renderer.info.render.triangles;

  for (const character of built) {
    const head = new THREE.Vector3(0, character.height + 0.16, 0).add(character.root.position);
    const point = project(head, camera);
    // Stagger alternate labels, and lift the back row clear of the front one:
    // the two rows share columns, so their labels project into the same band.
    const index = built.indexOf(character);
    const stagger = (index % 2) * 34 + Math.floor(index / perRow) * 30;
    const sub =
      character.entry.threat === undefined
        ? `${character.triangles} tris · ${character.drawCalls} call`
        : `${character.entry.threat} · ${character.triangles} tris · ${character.drawCalls} call`;
    label(point.x, point.y - 40 - stagger, character.entry.name, sub);
  }

  return {
    mode: 'sheet',
    characters: rows,
    sceneCalls,
    sceneTriangles,
    totalTextureBytes: rows.reduce((sum, row) => sum + row.textureBytes, 0),
  };
}

async function runFace(): Promise<Record<string, unknown>> {
  const saitama = rosterEntry('chr.saitama');
  addLights(3);
  const camera = new THREE.PerspectiveCamera(24, WIDTH / HEIGHT, 0.05, 40);

  // Two panels: the portrait on the left, the four expression tiles on the
  // right. Splitting by scissor rather than by distance means the expressions
  // are rendered at the same texel density as the portrait — the whole point
  // is to judge whether they are legible, and a wide shot would not show that.
  const portraitWidth = Math.round(WIDTH * 0.42);
  const hero = await buildCharacter(saitama, 0, 'high', 'neutral');
  hero.root.rotation.y = Math.PI + 0.2;
  scene.add(hero.root);

  const expressions: Expression[] = ['neutral', 'bored', 'serious', 'surprised'];
  const strip: BuiltCharacter[] = [];
  for (let i = 0; i < expressions.length; i++) {
    const character = await buildCharacter(saitama, 0, 'high', expressions[i]!);
    // One ROW, not a grid: stacked heads are occluded by the shoulders of the
    // character in front of them, which is how the first attempt hid two of
    // the four expressions entirely.
    character.root.position.set(6 + i * 0.45, 0, 0);
    character.root.rotation.y = Math.PI;
    scene.add(character.root);
    strip.push(character);
  }

  const eyeY = hero.height * 0.93;
  camera.position.set(0.02, eyeY + 0.01, 1.0);
  camera.lookAt(0, eyeY - 0.015, 0);

  const grid = new THREE.PerspectiveCamera(26, (WIDTH - portraitWidth) / HEIGHT, 0.05, 40);
  grid.position.set(6.675, eyeY - 0.06, 3.4);
  grid.lookAt(6.675, eyeY - 0.06, 0);

  redraw = (): void => {
    renderer.setScissorTest(true);
    renderer.setViewport(0, 0, portraitWidth, HEIGHT);
    renderer.setScissor(0, 0, portraitWidth, HEIGHT);
    renderer.render(scene, camera);
    renderer.setViewport(portraitWidth, 0, WIDTH - portraitWidth, HEIGHT);
    renderer.setScissor(portraitWidth, 0, WIDTH - portraitWidth, HEIGHT);
    renderer.render(scene, grid);
    renderer.setScissorTest(false);
  };
  renderer.info.reset();
  redraw();

  for (let i = 0; i < strip.length; i++) {
    const character = strip[i]!;
    const point = project(
      new THREE.Vector3(0, character.height * 0.8, 0).add(character.root.position),
      grid,
      { x: portraitWidth, width: WIDTH - portraitWidth }
    );
    label(point.x, point.y + 18, expressions[i]!);
  }
  panelTitle(40, HEIGHT - 46, 'Saitama · the deadpan, at 1 m');
  panelTitle(portraitWidth + 40, HEIGHT - 46, 'the four expression tiles · one uniform apart');

  return {
    mode: 'face',
    characters: [describe(hero)],
    expressions,
    faceTile: (() => {
      const build = buildHumanoid(saitama.recipe.profile, saitama.recipe.options);
      prepareRosterGeometry(build);
      const region = faceRegion(saitama.face, measureHead(build));
      build.geometry.dispose();
      return {
        tile: [region.tileWidth, region.tileHeight],
        atlas: region.atlas,
        headHalfWidth: Number(region.headHalfWidth.toFixed(4)),
      };
    })(),
    drawCalls: renderer.info.render.calls,
  };
}

async function runMetal(): Promise<Record<string, unknown>> {
  const genos = rosterEntry('chr.genos');
  addLights(4);
  const character = await buildCharacter(genos, 0, 'high');
  character.root.rotation.y = Math.PI + 0.5;
  scene.add(character.root);

  // Matrices must be current before any bone world position is read, or the
  // close-up frames where the character was at construction time.
  character.root.updateMatrixWorld(true);

  const wide = new THREE.PerspectiveCamera(36, WIDTH / 2 / HEIGHT, 0.05, 40);
  wide.position.set(1.5, 1.4, 2.5);
  wide.lookAt(0, 1.0, 0);

  // The forearm close-up. `getWorldPosition` already includes the root's
  // transform — running it through `localToWorld` as well (as this did) applies
  // the rotation twice and points the camera at empty space.
  const forearm = character.mesh.skeleton.bones.find((bone) => bone.name === 'LeftForeArm');
  const hand = character.mesh.skeleton.bones.find((bone) => bone.name === 'LeftHand');
  const target = new THREE.Vector3();
  const wrist = new THREE.Vector3();
  if (forearm !== undefined) forearm.getWorldPosition(target);
  else target.set(-0.32, 1.1, 0);
  if (hand !== undefined) hand.getWorldPosition(wrist);
  else wrist.copy(target);
  target.lerp(wrist, 0.45);

  // Stand OUTSIDE the arm, looking in. A fixed world-space offset puts the
  // camera inside the limb as soon as the character is rotated, which is how
  // the first attempt produced an abstract slab instead of a forearm.
  const outward = new THREE.Vector3(target.x, 0, target.z).normalize();
  if (outward.lengthSq() < 0.5) outward.set(1, 0, 0);
  const close = new THREE.PerspectiveCamera(34, WIDTH / 2 / HEIGHT, 0.02, 20);
  close.position
    .copy(target)
    .addScaledVector(outward, 0.55)
    .add(new THREE.Vector3(0, 0.06, 0.5));
  close.lookAt(target);

  redraw = (): void => {
    renderer.setScissorTest(true);
    renderer.setViewport(0, 0, WIDTH / 2, HEIGHT);
    renderer.setScissor(0, 0, WIDTH / 2, HEIGHT);
    renderer.render(scene, wide);
    renderer.setViewport(WIDTH / 2, 0, WIDTH / 2, HEIGHT);
    renderer.setScissor(WIDTH / 2, 0, WIDTH / 2, HEIGHT);
    renderer.render(scene, close);
    renderer.setScissorTest(false);
  };
  renderer.info.reset();
  redraw();

  panelTitle(40, HEIGHT - 46, 'Genos · three-quarter');
  panelTitle(WIDTH / 2 + 40, HEIGHT - 46, 'Genos · left forearm, metalness 1.0');

  // Sample the ORM atlas back to prove the metal really is metal per texel.
  const metalness = await sampleOrmMetalness(genos);

  return {
    mode: 'metal',
    characters: [describe(character)],
    metalness,
    drawCalls: renderer.info.render.calls,
  };
}

/**
 * Read the baked ORM back and report the metalness histogram.
 *
 * A screenshot can be argued with; this cannot. If the blue channel is flat,
 * the character has no metal in it whatever the render looks like.
 */
async function sampleOrmMetalness(
  entry: RosterEntry
): Promise<{ high: number; low: number; mean: number; maxRoughSpread: number }> {
  const image = new Image();
  image.src = `${CHR_ROOT}/${characterDir(entry)}/orm.high.png`;
  await image.decode();
  const scratch = document.createElement('canvas');
  scratch.width = image.width;
  scratch.height = image.height;
  const context = scratch.getContext('2d')!;
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, image.width, image.height).data;

  let high = 0;
  let low = 0;
  let sum = 0;
  let minRough = 255;
  let maxRough = 0;
  for (let i = 0; i < data.length; i += 4) {
    const metal = data[i + 2]!;
    const rough = data[i + 1]!;
    sum += metal;
    if (metal > 200) high++;
    else if (metal < 40) low++;
    if (metal > 200) {
      minRough = Math.min(minRough, rough);
      maxRough = Math.max(maxRough, rough);
    }
  }
  const texels = data.length / 4;
  return {
    high: high / texels,
    low: low / texels,
    mean: sum / texels / 255,
    maxRoughSpread: (maxRough - minRough) / 255,
  };
}

async function runCrowd(): Promise<Record<string, unknown>> {
  const entry = civilianEntry();
  addLights(16);
  addGround(120, 0);

  const build = buildHumanoid(entry.recipe.profile, { ...entry.recipe.options, lod: 1 });
  prepareRosterGeometry(build);
  const region = faceRegion(entry.face, measureHead(build));
  const maps = await loadMaps(entry, 'mobile');
  const material = createRosterMaterial(maps, {
    name: `${entry.id}.crowd`,
    faceRect: region.atlas,
    crowdTint: true,
  });

  const count = 220;
  const attributes = buildCrowdAttributes(count, 4242);
  const geometry = build.geometry;
  attachCrowdAttributes(geometry, attributes);

  const instanced = new THREE.InstancedMesh(geometry, material, count);
  instanced.castShadow = true;
  instanced.receiveShadow = true;
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const column = i % 20;
    const row = Math.floor(i / 20);
    const jitter = ((attributes.seeds[i]! % 1000) / 1000 - 0.5) * 0.5;
    position.set((column - 9.5) * 1.15 + jitter, 0, -row * 1.5 - 1 + jitter * 0.6);
    quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI + jitter * 1.6);
    const s = 0.92 + ((attributes.seeds[i]! % 97) / 97) * 0.22;
    scale.set(s, s, s);
    matrix.compose(position, quaternion, scale);
    instanced.setMatrixAt(i, matrix);
  }
  instanced.instanceMatrix.needsUpdate = true;
  scene.add(instanced);

  const camera = new THREE.PerspectiveCamera(34, WIDTH / HEIGHT, 0.3, 200);
  camera.position.set(0, 2.9, 11.0);
  camera.lookAt(0, 1.45, -6);
  scene.add(camera);

  redraw = (): void => {
    renderer.setViewport(0, 0, WIDTH, HEIGHT);
    renderer.setScissorTest(false);
    renderer.render(scene, camera);
  };
  renderer.setViewport(0, 0, WIDTH, HEIGHT);
  renderer.setScissorTest(false);
  renderer.info.reset();
  renderer.render(scene, camera);

  panelTitle(
    40,
    HEIGHT - 46,
    `${count} civilians · one atlas · per-instance tint · bind pose (the crowd's motion comes from the VAT)`
  );

  return {
    mode: 'crowd',
    instances: count,
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    distinctPalettes: distinctCrowdPalettes(attributes),
    textureBytes: maps.bytes,
    perCharacterTriangles: build.stats.triangles,
  };
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  let environmentSource: string;
  try {
    const environment = await loadEnvironment();
    scene.environment = environment.env;
    scene.background = new THREE.Color(0x0a0d14);
    environmentSource = environment.source;
  } catch (error) {
    environmentSource = `FAILED: ${(error as Error).message}`;
  }

  const stats =
    MODE === 'face'
      ? await runFace()
      : MODE === 'metal'
        ? await runMetal()
        : MODE === 'crowd'
          ? await runCrowd()
          : await runSheet();

  // Final frame, after every label, camera and asynchronous readback is done.
  redraw();
  const frame = inspectFrame();
  const fade = [0, 0.4, 0.6, 0.8, 1].map((ratio) => Number(proximityFadeAmount(ratio).toFixed(3)));

  const collected = {
    ...stats,
    environment: environmentSource,
    frame,
    proximityFadeCurve: fade,
    renderer: renderer.getContext().getParameter(renderer.getContext().VERSION),
  };
  window.__HARNESS_STATS__ = collected;

  const characters = (stats.characters ?? []) as CharacterRow[];
  const worstCalls = characters.reduce((max, row) => Math.max(max, row.drawCalls), 0);
  const missing = characters.filter((row) => row.missing.length > 0);
  readout.innerHTML = [
    `<b>mode</b> ${MODE}`,
    `<b>env</b> ${environmentSource}`,
    characters.length > 0 ? `<b>characters</b> ${characters.length}` : '',
    worstCalls > 0
      ? `<b>draw calls / character</b> <span class="${worstCalls <= 1 ? 'ok' : 'bad'}">${worstCalls}</span>`
      : '',
    `<b>missing maps</b> <span class="${missing.length === 0 ? 'ok' : 'bad'}">${missing.length}</span>`,
    `<b>magenta pixels</b> <span class="${frame.magentaPixels === 0 ? 'ok' : 'bad'}">${frame.magentaPixels}</span>`,
    `<b>colours</b> ${frame.distinctColors} · <b>stdDev</b> ${frame.stdDev.toFixed(1)}`,
  ]
    .filter(Boolean)
    .join('<br>');

  window.__HARNESS_READY__ = true;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  window.__HARNESS_ERROR__ = message;
  window.__HARNESS_READY__ = true;
  errorBox.style.display = 'block';
  errorBox.textContent = message;
  console.error(error);
});

// Keep the tree-shaker from dropping a helper the shot script drives manually.
Object.assign(window, { __setProximityFade: setProximityFade });
