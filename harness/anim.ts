/**
 * VISUAL HARNESS — procedural animation
 *
 * The unit tests prove the planted foot's contact point moves 0.045 mm per
 * stance. None of that proves the walk looks like a person walking, and
 * "looks like a person" is the requirement, so this page renders the gait for
 * a human to judge.
 *
 * Three modes, selected by `?mode=`:
 *
 *   walk   EIGHT PHASES of one cycle, side on, over a world-fixed ground
 *          ruler. The ruler is the whole point: the character is drawn in
 *          place, so a planted foot that stays on the same tick across panels
 *          is planted, and one that crawls across ticks is sliding. Foot
 *          sliding is invisible on a moving character and obvious here.
 *   clips  the clip library at its most characteristic frame, plus the gait
 *          ladder and the body-proportion range side by side on one ground
 *          plane.
 *   crowd  250 civilians skinned from the VAT in one InstancedMesh, next to
 *          CPU-skinned characters running the same clip at the same time. If
 *          the two paths disagree, the difference is visible in one frame.
 *
 * Every mode publishes its measurements to `__HARNESS_STATS__`; the driver
 * asserts them AND checks the pixels, because a WebGL page that throws still
 * screenshots cleanly.
 */

import * as THREE from 'three';
import type { BodyProfile } from '@/types';
import {
  buildCivilian,
  buildHumanoid,
  createCharacterParts,
  showcaseBodies,
  type HumanoidBuild,
} from '@/characters/mesh';
import {
  applyPose,
  applyVatSkinning,
  bakeVat,
  copyPose,
  createPose,
  findClip,
  LocomotionSolver,
  measureFootSlide,
  measureNaiveFootSlide,
  measureVatRoundTrip,
  ProceduralAnimator,
  resolveRig,
  sampleClip,
  vatInstanceAttribute,
  type AnimRig,
  type LocomotionReport,
  type Pose,
} from '@/characters/anim';
import { createRng } from '@/util';

declare global {
  interface Window {
    __HARNESS_READY__?: boolean;
    __HARNESS_STATS__?: unknown;
    __HARNESS_ERROR__?: string;
  }
}

const params = new URLSearchParams(location.search);
const MODE = params.get('mode') ?? 'walk';

const LAYOUTS: Record<string, { width: number; height: number }> = {
  walk: { width: 1840, height: 1080 },
  clips: { width: 1840, height: 1180 },
  crowd: { width: 1680, height: 920 },
};
const LAYOUT = LAYOUTS[MODE] ?? LAYOUTS.walk!;
const WIDTH = LAYOUT.width;
const HEIGHT = LAYOUT.height;

/* -------------------------------------------------------------------------- */
/* Scene scaffolding                                                          */
/* -------------------------------------------------------------------------- */

const canvas = document.getElementById('view') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLDivElement;
const stage = document.getElementById('stage') as HTMLDivElement;
const readout = document.getElementById('readout') as HTMLDivElement;
stage.style.width = `${WIDTH}px`;
stage.style.height = `${HEIGHT}px`;
canvas.style.width = `${WIDTH}px`;
canvas.style.height = `${HEIGHT}px`;

// `preserveDrawingBuffer` because this harness renders ONCE at load rather
// than in a loop: without it the driver's pixel read-back sees a cleared
// buffer and reports a blank frame for a page that drew perfectly.
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(1);
renderer.setSize(WIDTH, HEIGHT, false);
renderer.setClearColor(0x0a0d15, 1);
renderer.autoClear = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();

/**
 * Three lights, no environment map.
 *
 * A key from the front-right reads the silhouette, a cool fill from the
 * opposite side stops the shadow side going to black, and a low rim from
 * behind separates the legs from the ground — which is the pair of shapes this
 * harness exists to let you look at.
 */
function addLights(target: THREE.Scene): void {
  const key = new THREE.DirectionalLight(0xfff2e0, 2.6);
  key.position.set(2.2, 3.4, 2.6);
  target.add(key);
  const fill = new THREE.DirectionalLight(0x9fc4ff, 0.85);
  fill.position.set(-3, 1.6, 1.4);
  target.add(fill);
  const rim = new THREE.DirectionalLight(0xffd9a8, 1.1);
  rim.position.set(-1.2, 0.9, -3.2);
  target.add(rim);
  target.add(new THREE.HemisphereLight(0x4a5a74, 0x14171d, 0.55));
}
addLights(scene);

/* -------------------------------------------------------------------------- */
/* Characters                                                                 */
/* -------------------------------------------------------------------------- */

interface Actor {
  readonly name: string;
  readonly build: HumanoidBuild;
  readonly root: THREE.Object3D;
  readonly rig: AnimRig;
  readonly pose: Pose;
}

function material(): THREE.Material {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.72,
    metalness: 0.06,
  });
}

function makeActor(name: string, build: HumanoidBuild): Actor {
  const parts = createCharacterParts(build, material());
  const rig = resolveRig(parts);
  scene.add(parts.root);
  parts.root.visible = false;
  return { name, build, root: parts.root, rig, pose: createPose(rig.boneCount) };
}

const recipes = showcaseBodies();
const saitama = makeActor('Saitama', buildHumanoid(recipes[0]!.profile, { ...recipes[0]!.options }));

/* -------------------------------------------------------------------------- */
/* Ground                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The ground ruler.
 *
 * Ticks every 25 cm, laid out in WORLD space and shifted into the character's
 * model space each frame. Because the character is drawn in place, a ruler
 * that slides underneath it is exactly the treadmill a real walk cycle needs,
 * and a planted foot that keeps its tick is proof of planting that survives
 * being looked at.
 */
const TICK_SPACING = 0.25;

function makeGround(): { group: THREE.Group; setOffset: (z: number) => void } {
  const group = new THREE.Group();
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(14, 6),
    new THREE.MeshStandardMaterial({ color: 0x1c2130, roughness: 0.95, metalness: 0 })
  );
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = -0.002;
  group.add(plane);

  const ticks = new THREE.Group();
  const major = new THREE.MeshBasicMaterial({ color: 0x5d7396 });
  const minor = new THREE.MeshBasicMaterial({ color: 0x2f3c52 });
  for (let i = -24; i <= 24; i++) {
    const isMajor = i % 4 === 0;
    const bar = new THREE.Mesh(
      new THREE.PlaneGeometry(isMajor ? 1.6 : 1.0, isMajor ? 0.016 : 0.008),
      isMajor ? major : minor
    );
    bar.rotation.x = -Math.PI / 2;
    bar.position.set(0, 0.001, i * TICK_SPACING);
    ticks.add(bar);
  }
  group.add(ticks);
  return {
    group,
    setOffset: (z: number): void => {
      // Wrap so the ruler never runs out, but keep the phase: the ticks stay
      // world-locked, they just recycle.
      ticks.position.z = -(((z % TICK_SPACING) + TICK_SPACING) % TICK_SPACING);
    },
  };
}

const ground = makeGround();
scene.add(ground.group);
ground.group.visible = false;

/** Small rings marking where the solver pinned each foot, in model space. */
function makePlantMarkers(): { group: THREE.Group; set: (report: LocomotionReport, solver: LocomotionSolver) => void } {
  const group = new THREE.Group();
  const make = (color: number): THREE.Mesh => {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.05, 0.075, 24),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, side: THREE.DoubleSide })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.004;
    group.add(mesh);
    return mesh;
  };
  const left = make(0x5ad2ff);
  const right = make(0xff9a5a);
  const scratch = new THREE.Vector3();
  return {
    group,
    set: (report, solver): void => {
      for (const [mesh, foot] of [
        [left, report.left],
        [right, report.right],
      ] as const) {
        mesh.visible = foot.phase === 'stance';
        if (!mesh.visible) continue;
        solver.worldToModel(foot.plantWorld, scratch);
        mesh.position.set(scratch.x, 0.004, scratch.z);
      }
    },
  };
}

const markers = makePlantMarkers();
scene.add(markers.group);
markers.group.visible = false;

/* -------------------------------------------------------------------------- */
/* Overlay text                                                               */
/* -------------------------------------------------------------------------- */

function label(x: number, y: number, html: string, align: 'left' | 'center' = 'left'): void {
  const node = document.createElement('div');
  node.className = 'cell-label';
  node.style.left = `${x}px`;
  node.style.top = `${y}px`;
  if (align === 'center') node.style.transform = 'translateX(-50%)';
  node.innerHTML = html;
  overlay.appendChild(node);
}

function divider(x: number, y: number, w: number, h: number): void {
  const node = document.createElement('div');
  node.className = 'divider';
  node.style.left = `${x}px`;
  node.style.top = `${y}px`;
  node.style.width = `${w}px`;
  node.style.height = `${h}px`;
  overlay.appendChild(node);
}

/* -------------------------------------------------------------------------- */
/* Viewport rendering                                                         */
/* -------------------------------------------------------------------------- */

interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Render the scene into one sub-rectangle. GL y is measured from the bottom. */
function renderCell(cell: Cell, camera: THREE.Camera): void {
  const glY = HEIGHT - cell.y - cell.h;
  renderer.setViewport(cell.x, glY, cell.w, cell.h);
  renderer.setScissor(cell.x, glY, cell.w, cell.h);
  renderer.setScissorTest(true);
  renderer.render(scene, camera);
}

/** A side-on camera framing a character of the given height. */
function profileCamera(cell: Cell, height: number, centerZ = 0): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(26, cell.w / cell.h, 0.1, 60);
  const distance = height * 4.4;
  camera.position.set(distance, height * 0.56, centerZ);
  camera.lookAt(0, height * 0.5, centerZ);
  return camera;
}

/* -------------------------------------------------------------------------- */
/* Mode: walk cycle                                                           */
/* -------------------------------------------------------------------------- */

interface WalkStats {
  phases: number;
  speed: number;
  cadence: number;
  strideLength: number;
  duty: number;
  maxContactDrift: number;
  maxFlatDrift: number;
  naiveContactDrift: number;
  reachDrop: number;
  stanceCounts: number[];
}

function renderWalkCycle(): WalkStats {
  const actor = saitama;
  actor.root.visible = true;
  ground.group.visible = true;
  markers.group.visible = true;

  const rig = actor.rig;
  const speed = 1.4;
  const solver = new LocomotionSolver(rig);
  const probe = createPose(rig.boneCount);
  copyPose(probe, rig.rest);
  const period = 1 / solver.update(1e-6, { speed }, probe).solution.cycleFrequency;

  const PHASES = 8;
  const SUBSTEPS = 10;
  const dt = period / (PHASES * SUBSTEPS);
  solver.reset(0);
  // Warm up four whole cycles, then a HALF SAMPLE more. Sampling exactly on
  // phase 0 and 0.5 lands on the two touchdown instants, where float error
  // decides which side of the stance test a foot falls on — so the strip can
  // miss double support entirely, which is the one thing a walk cycle has to
  // show. Half a sample off the boundary shows the middle of each phase.
  const warmup = PHASES * SUBSTEPS * 4 + Math.floor(SUBSTEPS / 2);
  for (let i = 0; i < warmup; i++) {
    copyPose(probe, rig.rest);
    solver.update(dt, { speed }, probe);
  }

  const cols = 4;
  const rows = 2;
  const top = 74;
  const cellW = Math.floor(WIDTH / cols);
  const cellH = Math.floor((HEIGHT - top) / rows);
  const stanceCounts: number[] = [];
  let report: LocomotionReport | undefined;

  renderer.clear();
  for (let i = 0; i < PHASES; i++) {
    const pose = copyPose(actor.pose, probe);
    applyPose(pose, rig);
    actor.root.updateMatrixWorld(true);
    report = solver.update(0, { speed }, createPose(rig.boneCount));
    // Re-derive the report for the CURRENT state without advancing time, so
    // the labels describe the frame actually drawn.
    ground.setOffset(solver.rootPosition.z);
    markers.set(report, solver);

    const col = i % cols;
    const row = Math.floor(i / cols);
    const cell: Cell = {
      x: col * cellW,
      y: top + row * cellH,
      w: cellW,
      h: cellH,
    };
    renderCell(cell, profileCamera(cell, rig.metrics.height, 0));

    const phase = solver.phase;
    const stance = [report.left, report.right].filter((f) => f.phase === 'stance').length;
    stanceCounts.push(stance);
    const foot = (f: typeof report.left): string =>
      f.phase === 'stance'
        ? `<span class="ok">stance ${(f.progress * 100).toFixed(0)}%</span>`
        : `<span class="dim">swing  ${(f.progress * 100).toFixed(0)}%</span>`;
    label(
      cell.x + 16,
      cell.y + 12,
      `<b>phase ${(phase * 100).toFixed(0)}%</b>\n` +
        `L ${foot(report.left)}\n` +
        `R ${foot(report.right)}\n` +
        `<span class="dim">pelvis ${(report.pelvisY * 100).toFixed(1)} cm</span>`
    );
    if (col > 0) divider(cell.x, cell.y, 1, cell.h);
    if (row > 0) divider(cell.x, cell.y, cell.w, 1);

    for (let s = 0; s < SUBSTEPS; s++) {
      copyPose(probe, rig.rest);
      solver.update(dt, { speed }, probe);
    }
  }
  renderer.setScissorTest(false);

  const slide = measureFootSlide(rig, { speed, seconds: 8 });
  const naive = measureNaiveFootSlide(rig, speed, 8);
  const gait = solver.gait;
  return {
    phases: PHASES,
    speed,
    cadence: gait.cycleFrequency,
    strideLength: gait.strideLength,
    duty: gait.duty,
    maxContactDrift: slide.maxContactDrift,
    maxFlatDrift: slide.maxFlatDrift,
    naiveContactDrift: naive.maxContactDrift,
    reachDrop: slide.maxReachDrop,
    stanceCounts,
  };
}

/* -------------------------------------------------------------------------- */
/* Mode: clip library                                                         */
/* -------------------------------------------------------------------------- */

interface ClipsStats {
  clipCells: number;
  gaitCells: number;
  bodies: { name: string; height: number; legLength: number; cadence: number; stride: number }[];
  distinctPoses: number;
}

/** Pose an actor from a clip at a given normalised time. */
function poseFromClip(
  actor: Actor,
  slot: Parameters<typeof findClip>[0],
  variant: Parameters<typeof findClip>[1],
  t: number
): void {
  const entry = findClip(slot, variant);
  const frames = 48;
  const poses = sampleClip(actor.rig, entry, { frames });
  const index = Math.min(frames - 1, Math.max(0, Math.round(t * (frames - 1))));
  copyPose(actor.pose, poses[index]!);
  applyPose(actor.pose, actor.rig);
  actor.root.updateMatrixWorld(true);
}

function renderClips(): ClipsStats {
  const actor = saitama;
  actor.root.visible = true;
  ground.group.visible = true;
  markers.group.visible = false;
  ground.setOffset(0);

  const grid: Array<{
    slot: Parameters<typeof findClip>[0];
    variant: Parameters<typeof findClip>[1];
    t: number;
    caption: string;
  }> = [
    { slot: 'idle', variant: 'bored', t: 0.1, caption: 'idle · bored\nSaitama slouch' },
    { slot: 'idle', variant: 'bored', t: 0.68, caption: 'idle · bored\nyawn peak' },
    { slot: 'idle', variant: 'combat', t: 0.25, caption: 'idle · combat\nguard set' },
    { slot: 'idle', variant: 'civilian', t: 0.5, caption: 'idle · civilian' },
    { slot: 'attack', variant: 'default', t: 0.24, caption: 'attack\nwind-up' },
    { slot: 'attack', variant: 'default', t: 0.47, caption: 'attack\nimpact' },
    { slot: 'heavyAttack', variant: 'default', t: 0.4, caption: 'heavyAttack\ncharge hold' },
    { slot: 'heavyAttack', variant: 'default', t: 0.62, caption: 'heavyAttack\nrelease' },
    { slot: 'special', variant: 'default', t: 0.56, caption: 'special\nserious punch' },
    { slot: 'block', variant: 'default', t: 1, caption: 'block' },
    { slot: 'hit', variant: 'default', t: 0.16, caption: 'hit\nflinch' },
    { slot: 'stagger', variant: 'default', t: 0.3, caption: 'stagger' },
    { slot: 'jump', variant: 'default', t: 0.3, caption: 'jump\nload' },
    { slot: 'jump', variant: 'default', t: 0.72, caption: 'jump\nlaunch' },
    { slot: 'land', variant: 'default', t: 0.16, caption: 'land\nabsorb' },
    { slot: 'death', variant: 'default', t: 0.62, caption: 'death\nragdoll cue' },
    { slot: 'dodge', variant: 'default', t: 0.42, caption: 'dodge' },
    { slot: 'taunt', variant: 'default', t: 0.5, caption: 'taunt' },
  ];

  const cols = 6;
  const top = 78;
  const clipRows = 3;
  const cellW = Math.floor(WIDTH / cols);
  const cellH = 300;
  const poses: string[] = [];

  renderer.clear();
  grid.forEach((item, i) => {
    poseFromClip(actor, item.slot, item.variant, item.t);
    poses.push(Array.from(actor.pose.rot).map((v) => v.toFixed(3)).join(','));
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cell: Cell = { x: col * cellW, y: top + row * cellH, w: cellW, h: cellH };
    const camera = new THREE.PerspectiveCamera(24, cell.w / cell.h, 0.1, 60);
    // Three-quarter view: the strikes read best off-axis, and a pure profile
    // hides the shoulder rotation that carries the punch.
    camera.position.set(3.4, 1.35, 5.6);
    camera.lookAt(0, 0.92, 0);
    renderCell(cell, camera);
    const [name, detail] = item.caption.split('\n');
    label(
      cell.x + 14,
      cell.y + 10,
      `<b>${name}</b>${detail === undefined ? '' : `\n<span class="dim">${detail}</span>`}`
    );
    if (col > 0) divider(cell.x, cell.y, 1, cell.h);
    if (row > 0) divider(cell.x, cell.y, cell.w, 1);
  });

  // --- Bottom strip: the proportion range, all mid-stride -------------------
  const stripTop = top + clipRows * cellH;
  divider(0, stripTop, WIDTH, 1);
  const bodyOrder = ['Child', 'Tatsumaki', 'Saitama', 'Heavy civilian', 'Monster humanoid'];
  const bodies: ClipsStats['bodies'] = [];
  const stripCols = bodyOrder.length + 1;
  const stripW = Math.floor(WIDTH / stripCols);
  const stripH = HEIGHT - stripTop;

  actor.root.visible = false;
  bodyOrder.forEach((name, i) => {
    const recipe = recipes.find((r) => r.name === name)!;
    const other = makeActor(name, buildHumanoid(recipe.profile, { ...recipe.options }));
    other.root.visible = true;
    const rig = other.rig;
    const speed = 0.47 * Math.sqrt(9.81 * rig.metrics.legLength);
    const solver = new LocomotionSolver(rig);
    const pose = createPose(rig.boneCount);
    // Land on the same cycle phase for every body, so the silhouettes are
    // directly comparable rather than caught at random moments.
    const period = 1 / solver.update(1e-6, { speed }, pose).solution.cycleFrequency;
    const steps = 400;
    const dt = (period * 4.18) / steps;
    solver.reset(0);
    for (let s = 0; s < steps; s++) {
      copyPose(pose, rig.rest);
      solver.update(dt, { speed }, pose);
    }
    applyPose(pose, rig);
    other.root.updateMatrixWorld(true);
    ground.setOffset(solver.rootPosition.z);

    const cell: Cell = { x: i * stripW, y: stripTop, w: stripW, h: stripH };
    renderCell(cell, profileCamera(cell, 2.5));
    const gait = solver.gait;
    bodies.push({
      name,
      height: rig.metrics.height,
      legLength: rig.metrics.legLength,
      cadence: gait.cycleFrequency,
      stride: gait.strideLength,
    });
    label(
      cell.x + 14,
      cell.y + 10,
      `<b>${name}</b>\n` +
        `<span class="dim">${rig.metrics.height.toFixed(2)} m · leg ${(rig.metrics.legLength * 100).toFixed(0)} cm</span>\n` +
        `<span class="dim">${(gait.cycleFrequency * 120).toFixed(0)} steps/min · ${gait.strideLength.toFixed(2)} m stride</span>`
    );
    if (i > 0) divider(cell.x, cell.y, 1, cell.h);
    other.root.visible = false;
  });

  // --- Last cell: the gait ladder, one body at five speeds ------------------
  {
    const rig = saitama.rig;
    saitama.root.visible = true;
    const cell: Cell = { x: bodyOrder.length * stripW, y: stripTop, w: stripW, h: stripH };
    const speeds = [0, 1.4, 3.0, 5.0, 8.0];
    const inner = Math.floor(cell.w / speeds.length);
    speeds.forEach((speed, i) => {
      const solver = new LocomotionSolver(rig);
      const pose = createPose(rig.boneCount);
      const period = 1 / solver.update(1e-6, { speed }, pose).solution.cycleFrequency;
      const steps = 300;
      const dt = (period * 4.3) / steps;
      solver.reset(0);
      for (let s = 0; s < steps; s++) {
        copyPose(pose, rig.rest);
        solver.update(dt, { speed }, pose);
      }
      applyPose(pose, rig);
      saitama.root.updateMatrixWorld(true);
      ground.setOffset(solver.rootPosition.z);
      const sub: Cell = { x: cell.x + i * inner, y: cell.y, w: inner, h: cell.h };
      const camera = new THREE.PerspectiveCamera(20, sub.w / sub.h, 0.1, 60);
      camera.position.set(9.5, 1.0, 0);
      camera.lookAt(0, 0.9, 0);
      renderCell(sub, camera);
      label(
        sub.x + 6,
        sub.y + 10,
        `<b>${speed.toFixed(1)}</b>\n<span class="dim">${solver.gait.gait}</span>`
      );
    });
    label(cell.x + 14, cell.y + cell.h - 34, `<b>gait ladder</b> <span class="dim">m/s</span>`);
    divider(cell.x, cell.y, 1, cell.h);
  }
  renderer.setScissorTest(false);

  return {
    clipCells: grid.length,
    gaitCells: 5,
    bodies,
    distinctPoses: new Set(poses).size,
  };
}

/* -------------------------------------------------------------------------- */
/* Mode: VAT crowd                                                            */
/* -------------------------------------------------------------------------- */

interface CrowdStats {
  instances: number;
  drawCalls: number;
  triangles: number;
  textureBytes: number;
  textureSize: [number, number];
  quantisationMax: number;
  temporalMax: number;
  distinctOffsets: number;
  cpuReferences: number;
}

function renderCrowd(): CrowdStats {
  ground.group.visible = false;
  markers.group.visible = false;
  saitama.root.visible = false;

  const crowdScene = new THREE.Scene();
  crowdScene.background = new THREE.Color(0x0a0d15);
  addLights(crowdScene);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 120),
    new THREE.MeshStandardMaterial({ color: 0x1b2030, roughness: 0.96 })
  );
  floor.rotation.x = -Math.PI / 2;
  crowdScene.add(floor);

  // One shared body for the whole crowd. LOD2, because a crowd is background.
  const crowdBuild = buildCivilian(4242, 2);
  const crowdParts = createCharacterParts(crowdBuild, material());
  const crowdRig = resolveRig(crowdParts);
  crowdParts.root.visible = false;

  const clips = [
    findClip('idle', 'civilian'),
    findClip('walk'),
    findClip('run'),
    findClip('idle', 'panicked'),
  ];
  const bake = bakeVat(crowdRig, clips, { frames: 32, halfFloat: true });

  const INSTANCES = 250;
  const geometry = crowdBuild.geometry.clone();
  const crowdMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.78,
    metalness: 0.04,
  });
  const uniforms = applyVatSkinning(crowdMaterial, bake);

  const rng = createRng(90210).derive('crowd');
  const instances = Array.from({ length: INSTANCES }, (_, i) => ({
    clip: i % clips.length,
    // A golden-ratio sequence rather than a random draw: it de-correlates the
    // crowd more evenly than uniform noise, so no two neighbours land on the
    // same frame by accident.
    offset: (i * 0.6180339887498949) % 1,
    rate: 0.88 + ((i * 7) % 13) * 0.02,
  }));
  geometry.setAttribute('vatParams', vatInstanceAttribute(bake, instances));

  const mesh = new THREE.InstancedMesh(geometry, crowdMaterial, INSTANCES);
  mesh.frustumCulled = false;
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  for (let i = 0; i < INSTANCES; i++) {
    const col = i % 25;
    const row = Math.floor(i / 25);
    position.set(-11.5 + col * 0.96 + rng.range(-0.14, 0.14), 0, -row * 1.55 + rng.range(-0.2, 0.2));
    quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(-0.5, 0.5) + Math.PI);
    const s = rng.range(0.9, 1.12);
    scale.set(s, s, s);
    mesh.setMatrixAt(i, matrix.compose(position, quaternion, scale));
  }
  mesh.instanceMatrix.needsUpdate = true;
  crowdScene.add(mesh);

  // Three CPU-skinned references running the SAME clip at the same time, so
  // any disagreement between the two skinning paths is visible side by side.
  const references: ProceduralAnimator[] = [];
  const walkClip = bake.clips[bake.index.get('walk:default')!]!;
  for (let i = 0; i < 3; i++) {
    const parts = createCharacterParts(buildCivilian(4242, 2), material());
    const animator = new ProceduralAnimator(parts, parts.root);
    parts.root.position.set(-2.4 + i * 2.4, 0, 3.4);
    parts.root.rotation.y = Math.PI;
    crowdScene.add(parts.root);
    animator.play('walk', { fade: 0 });
    references.push(animator);
  }

  const time = 1.37;
  uniforms.vatTime.value = time;
  uniforms.vatFps.value = walkClip.frames / walkClip.duration;
  for (const animator of references) {
    const steps = Math.round(time * 120);
    for (let s = 0; s < steps; s++) animator.update(1 / 120);
    animator.rig.bones[0]!.updateMatrixWorld(true);
  }

  const camera = new THREE.PerspectiveCamera(38, WIDTH / HEIGHT, 0.1, 200);
  camera.position.set(0.5, 5.6, 15.5);
  camera.lookAt(0, 1.0, -4);

  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, WIDTH, HEIGHT);
  renderer.clear();
  renderer.info.reset();
  renderer.render(crowdScene, camera);
  const drawCalls = renderer.info.render.calls;
  const triangles = renderer.info.render.triangles;

  const report = measureVatRoundTrip(
    crowdRig,
    bake,
    findClip('walk'),
    bake.index.get('walk:default')!,
    {
      position: crowdBuild.geometry.getAttribute('position').array as Float32Array,
      skinIndex: crowdBuild.geometry.getAttribute('skinIndex').array as ArrayLike<number>,
      skinWeight: crowdBuild.geometry.getAttribute('skinWeight').array as ArrayLike<number>,
    },
    { stride: 5, subSamples: 4 }
  );

  label(
    24,
    HEIGHT - 132,
    `<b>VAT crowd</b>\n` +
      `<span class="dim">${INSTANCES} civilians · 1 InstancedMesh · ${clips.length} clips in one texture</span>\n` +
      `<span class="dim">palette ${bake.width}x${bake.height} RGBA16F · ${(bake.bytes / 1024).toFixed(1)} KB</span>\n` +
      `<span class="ok">${drawCalls} draw calls</span> <span class="dim">for the whole frame</span>`
  );
  label(
    WIDTH - 420,
    HEIGHT - 96,
    `<b>front row: CPU-skinned reference</b>\n` +
      `<span class="dim">same clip, same clock, SkinnedMesh path</span>\n` +
      `<span class="dim">round-trip max ${(report.quantisationMax * 1000).toFixed(2)} mm quantisation</span>`
  );

  for (const animator of references) animator.dispose();

  return {
    instances: INSTANCES,
    drawCalls,
    triangles,
    textureBytes: bake.bytes,
    textureSize: [bake.width, bake.height],
    quantisationMax: report.quantisationMax,
    temporalMax: report.temporalMax,
    distinctOffsets: new Set(instances.map((i) => Math.round(i.offset * 1000))).size,
    cpuReferences: references.length,
  };
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

function main(): void {
  if (MODE === 'walk') {
    const stats = renderWalkCycle();
    window.__HARNESS_STATS__ = { mode: MODE, ...stats };
    readout.innerHTML =
      `<b>walk cycle</b> · ${stats.speed.toFixed(2)} m/s<br>` +
      `${(stats.cadence * 120).toFixed(0)} steps/min · stride ${stats.strideLength.toFixed(2)} m · duty ${(stats.duty * 100).toFixed(0)}%<br>` +
      `contact drift <span class="ok">${(stats.maxContactDrift * 1000).toFixed(3)} mm</span> ` +
      `vs naive <span class="bad">${(stats.naiveContactDrift * 1000).toFixed(0)} mm</span><br>` +
      `pelvis reach drop ${(stats.reachDrop * 1000).toFixed(0)} mm`;
  } else if (MODE === 'clips') {
    const stats = renderClips();
    window.__HARNESS_STATS__ = { mode: MODE, ...stats };
    readout.innerHTML =
      `<b>clip library</b> · ${stats.clipCells} poses<br>` +
      `<span class="ok">${stats.distinctPoses}</span> distinct of ${stats.clipCells}<br>` +
      `${stats.bodies.length} body types, one gait model`;
  } else {
    const stats = renderCrowd();
    window.__HARNESS_STATS__ = { mode: MODE, ...stats };
    readout.innerHTML =
      `<b>VAT crowd</b> · ${stats.instances} instances<br>` +
      `<span class="ok">${stats.drawCalls}</span> draw calls · ${(stats.triangles / 1000).toFixed(0)}k tris<br>` +
      `palette ${(stats.textureBytes / 1024).toFixed(1)} KB<br>` +
      `round trip ${(stats.quantisationMax * 1000).toFixed(2)} mm`;
  }
  window.__HARNESS_READY__ = true;
}

try {
  main();
} catch (error) {
  const node = document.getElementById('error') as HTMLPreElement;
  node.style.display = 'block';
  node.textContent = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
  window.__HARNESS_ERROR__ = error instanceof Error ? error.stack ?? error.message : String(error);
  window.__HARNESS_READY__ = true;
}

export type { BodyProfile };
