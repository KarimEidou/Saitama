/**
 * VISUAL HARNESS — procedural humanoid mesh
 *
 * The unit tests prove the mesh is watertight, correctly wound and correctly
 * skinned. None of that proves it looks like a person, and "looks like a
 * person" is the actual requirement, so this page renders the generator's
 * output under PBR lighting from four angles and lets a human judge it.
 *
 * Four panels, chosen so each one can fail independently:
 *
 *   ROW        six distinct body types plus Saitama, side by side. Proves the
 *              profile parameters produce genuinely different silhouettes and
 *              not one mannequin at seven scales.
 *   HEAD       close-up. The head is where a stylised character passes or
 *              fails, and it is the part a wide shot flatters most.
 *   PROFILE    side and back. A generated torso can read fine from the front
 *              and be a slab from the side; this is the angle that catches it.
 *   POSE       arms and legs bent hard. A bind-pose screenshot says nothing
 *              about whether the analytic skin weights actually deform — this
 *              panel is the only place that claim is visible.
 *   LOD        the same character at all three detail tiers.
 *
 * Posing here is a handful of bone rotations for display only. Animation is a
 * separate workstream; nothing in this file is meant to survive into it.
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { BoneName } from '@/types';
import {
  analyseSkinning,
  analyseTopology,
  buildHumanoid,
  createSkinnedMesh,
  measureSilhouette,
  showcaseBodies,
  silhouetteDistance,
  FACE_CENTER_U,
  faceOffsetU,
  faceUV,
  type HumanoidBuild,
} from '@/characters/mesh';

declare global {
  interface Window {
    __HARNESS_READY__?: boolean;
    __HARNESS_STATS__?: unknown;
    __HARNESS_ERROR__?: string;
  }
}

const WIDTH = 1800;
const HEIGHT = 1200;
const ROW_HEIGHT = 700;

/* -------------------------------------------------------------------------- */
/* Materials                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Paint a face into the shared atlas.
 *
 * This is the proof that the UV layout works. The generator makes no attempt
 * to model eyes or a mouth — at this triangle budget that would look far worse
 * than drawing them, and One Punch Man's faces are flat graphic shapes anyway.
 * So the mesh publishes exactly where the face lands (`HEAD_LANDMARK_V`,
 * `faceOffsetU`) and a texture puts features there.
 *
 * The atlas is WHITE everywhere else and multiplies against the vertex colour
 * the generator already baked in, so one map serves every region without
 * disturbing the jumpsuit, the gloves or the boots.
 */
function makeFaceAtlas(headHalfWidth: number): THREE.CanvasTexture {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  // Canvas y runs downward; texture v runs upward (three.js flips on upload).
  const toPixels = (u: number, v: number): [number, number] => {
    const [au, av] = faceUV(u, v);
    return [au * size, (1 - av) * size];
  };

  const ellipse = (
    u: number,
    v: number,
    halfMetres: number,
    halfV: number,
    fill: string
  ): void => {
    const [cx, cy] = toPixels(u, v);
    const [ex] = toPixels(u + faceOffsetU(halfMetres, headHalfWidth), v);
    const [, ey] = toPixels(u, v + halfV);
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.abs(ex - cx), Math.abs(ey - cy), 0, 0, Math.PI * 2);
    ctx.fill();
  };

  const eyeV = 0.744;
  const browV = 0.781;
  const mouthV = 0.658;
  const eyeSpread = faceOffsetU(0.032, headHalfWidth);

  for (const side of [-1, 1]) {
    const u = FACE_CENTER_U + side * eyeSpread;
    ellipse(u, eyeV, 0.0155, 0.019, '#1a1a1f');
    // A brow above each eye is what gives a bald head an expression at all.
    ellipse(u, browV, 0.019, 0.005, '#6a5541');
  }
  ellipse(FACE_CENTER_U, mouthV, 0.021, 0.006, '#8d5348');

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/**
 * One material per `MeshSlot`.
 *
 * All of them read vertex colour, which is where the generator puts region
 * colour, so a single atlas-less build still shows jumpsuit yellow against red
 * gloves. The slots exist so metal can actually be metal.
 */
function makeMaterials(face: THREE.Texture): THREE.Material[] {
  const base = (
    roughness: number,
    metalness: number,
    extra: Partial<THREE.MeshStandardMaterialParameters> = {}
  ): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness,
      metalness,
      ...extra,
    });

  return [
    base(0.74, 0.0, { map: face }), // skin — carries the face
    base(0.9, 0.0), // cloth
    base(0.62, 0.04), // accent
    base(0.55, 0.0), // hair
    base(0.3, 0.88), // metal
  ];
}

/* -------------------------------------------------------------------------- */
/* Display posing                                                             */
/* -------------------------------------------------------------------------- */

type PoseName = 'bind' | 'relaxed' | 'action';

/**
 * Rotate a few bones for display.
 *
 * Rest rotations in this rig are identity (see rig.ts), so a bone's local axes
 * are the model's axes and "bend the elbow" really is one Euler term. That is
 * the whole argument for identity rest poses, and this function is the
 * cheapest possible demonstration of it.
 */
function pose(build: HumanoidBuild, name: PoseName): void {
  if (name === 'bind') return;
  const bone = (n: BoneName): THREE.Bone => build.rig.bones[build.rig.index[n]]!;
  const set = (n: BoneName, x: number, y: number, z: number): void => {
    bone(n).rotation.set(x, y, z);
  };

  if (name === 'relaxed') {
    // Arms down and slightly forward, elbows softened.
    set('LeftArm', 0, -0.16, 1.16);
    set('RightArm', 0, 0.16, -1.16);
    set('LeftForeArm', 0, -0.34, 0.16);
    set('RightForeArm', 0, 0.34, -0.16);
    set('LeftHand', 0, -0.12, 0.08);
    set('RightHand', 0, 0.12, -0.08);
    set('LeftShoulder', 0, 0, 0.06);
    set('RightShoulder', 0, 0, -0.06);
    set('LeftUpLeg', 0.03, 0, 0.035);
    set('RightUpLeg', 0.03, 0, -0.035);
    set('LeftLeg', -0.06, 0, 0);
    set('RightLeg', -0.06, 0, 0);
    set('Spine1', -0.02, 0, 0);
    set('Head', 0.02, 0, 0);
  } else {
    // Deliberately extreme: 90 degrees at both elbows, a deep knee bend and a
    // twisted spine. If the analytic weights were wrong, this is where the
    // shoulder would tear and the knee would collapse to a crease.
    set('LeftArm', 0, -0.2, 1.05);
    set('RightArm', -0.5, 0.1, -1.9);
    set('LeftForeArm', 0, -1.6, 0.1);
    set('RightForeArm', 0, 1.75, 0);
    set('LeftHand', 0, -0.3, 0);
    set('RightHand', 0, 0.35, 0);
    set('LeftUpLeg', -0.95, 0.12, 0.12);
    set('LeftLeg', 1.5, 0, 0);
    set('LeftFoot', -0.45, 0, 0);
    set('RightUpLeg', 0.42, -0.06, -0.06);
    set('RightLeg', -0.28, 0, 0);
    set('RightFoot', -0.1, 0, 0);
    set('Spine', 0.05, -0.24, 0);
    set('Spine1', 0.04, -0.16, 0);
    set('Spine2', 0.02, -0.12, 0);
    set('Neck', -0.06, 0.2, 0);
    set('Head', -0.04, 0.22, 0);
  }
  build.rig.root.updateMatrixWorld(true);
}

/* -------------------------------------------------------------------------- */
/* Scene                                                                      */
/* -------------------------------------------------------------------------- */

interface Placed {
  readonly name: string;
  readonly build: HumanoidBuild;
  readonly root: THREE.Object3D;
}

interface Panel {
  readonly title: string;
  /** CSS-pixel rect, origin top-left. */
  readonly rect: readonly [number, number, number, number];
  readonly camera: THREE.PerspectiveCamera;
  /** Region the shadow map is fitted to before this panel renders. */
  readonly focus: THREE.Vector3;
  readonly focusRadius: number;
}

// Head half-width for a 1.75 m adult; the face atlas is authored against it
// and read by every character, which is exactly what a shared atlas means.
const materials = makeMaterials(makeFaceAtlas(0.087));

function place(
  scene: THREE.Object3D,
  name: string,
  build: HumanoidBuild,
  x: number,
  z: number,
  yaw: number,
  poseName: PoseName
): Placed {
  const { root } = createSkinnedMesh(build, materials);
  root.position.set(x, 0, z);
  root.rotation.y = yaw;
  scene.add(root);
  pose(build, poseName);
  return { name, build, root };
}

function makeGround(): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(400, 400);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshStandardMaterial({
    color: 0x2b3038,
    roughness: 0.95,
    metalness: 0,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  return mesh;
}

function boot(): void {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const overlay = document.getElementById('overlay') as HTMLDivElement;
  const readout = document.getElementById('readout') as HTMLDivElement;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
    // Needed so the driver can read the frame back for its own pixel sanity
    // check after rendering has finished.
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(WIDTH, HEIGHT, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0e15);

  // Image-based lighting. Without an environment, metalness reads as black and
  // Genos would look like a silhouette instead of a machine.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.55;

  const hemi = new THREE.HemisphereLight(0xa8c8ff, 0x2a2620, 0.5);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xfff2e0, 2.6);
  key.position.set(4.5, 7.5, -6.5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.02;
  scene.add(key);
  scene.add(key.target);

  const rim = new THREE.DirectionalLight(0x9ec7ff, 1.35);
  rim.position.set(-6, 4.5, 7);
  scene.add(rim);

  const fill = new THREE.DirectionalLight(0xffd9b0, 0.35);
  fill.position.set(-3, 2, -8);
  scene.add(fill);

  scene.add(makeGround());

  /* ---- content --------------------------------------------------------- */

  const recipes = showcaseBodies();
  const row: Placed[] = [];
  const spacing = 1.56;

  // The camera looks along +Z (characters face -Z), so world +X lands on the
  // LEFT of the screen. Laying the row out in descending x is what puts
  // Saitama on the left where the eye starts.
  const rowX = (i: number): number => ((recipes.length - 1) / 2 - i) * spacing;

  recipes.forEach((recipe, i) => {
    const build = buildHumanoid(recipe.profile, { ...recipe.options, lod: 0 });
    row.push(place(scene, recipe.name, build, rowX(i), 0, 0, 'relaxed'));
  });

  const saitama = recipes[0]!;
  place(
    scene,
    'head',
    buildHumanoid(saitama.profile, { ...saitama.options, lod: 0 }),
    24,
    0,
    0,
    'relaxed'
  );
  place(
    scene,
    'side',
    buildHumanoid(saitama.profile, { ...saitama.options, lod: 0 }),
    40.7,
    0,
    Math.PI / 2,
    'relaxed'
  );
  place(
    scene,
    'back',
    buildHumanoid(saitama.profile, { ...saitama.options, lod: 0 }),
    39.2,
    0,
    Math.PI,
    'relaxed'
  );
  place(
    scene,
    'poseHero',
    buildHumanoid(saitama.profile, { ...saitama.options, lod: 0 }),
    57.2,
    0,
    0.55,
    'action'
  );
  place(
    scene,
    'poseGenos',
    buildHumanoid(recipes[1]!.profile, { ...recipes[1]!.options, lod: 0 }),
    55.6,
    0,
    -0.3,
    'action'
  );

  const lodBuilds: HumanoidBuild[] = [];
  const lodX = (i: number): number => 72.1 - i * 1.1;
  ([0, 1, 2] as const).forEach((lod, i) => {
    const build = buildHumanoid(saitama.profile, { ...saitama.options, lod });
    lodBuilds.push(build);
    place(scene, `lod${lod}`, build, lodX(i), 0, 0.22, 'relaxed');
  });

  /* ---- panels ---------------------------------------------------------- */

  const makeCamera = (
    fov: number,
    aspect: number,
    position: THREE.Vector3Like,
    target: THREE.Vector3Like
  ): THREE.PerspectiveCamera => {
    const camera = new THREE.PerspectiveCamera(fov, aspect, 0.05, 200);
    camera.position.set(position.x, position.y, position.z);
    camera.lookAt(target.x, target.y, target.z);
    // `Vector3.project` reads `matrixWorldInverse`, which is otherwise only
    // refreshed during a render — the HTML labels are positioned before the
    // first frame, so refresh it here.
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    return camera;
  };

  const cellW = WIDTH / 4;
  const cellH = HEIGHT - ROW_HEIGHT;

  const panels: Panel[] = [
    {
      title: 'Six body types + Saitama — LOD0, relaxed pose',
      rect: [0, 0, WIDTH, ROW_HEIGHT],
      // Characters face -Z, so the camera sits on the -Z side looking back
      // along +Z. That is also a live check of the engine's facing convention.
      camera: makeCamera(
        21,
        WIDTH / ROW_HEIGHT,
        { x: 0, y: 1.42, z: -11.55 },
        { x: 0, y: 1.26, z: 0 }
      ),
      focus: new THREE.Vector3(0, 1, 0),
      focusRadius: 7.5,
    },
    {
      title: 'Head — face from the shared atlas',
      rect: [0, ROW_HEIGHT, cellW, cellH],
      camera: makeCamera(
        26,
        cellW / cellH,
        { x: 24.26, y: 1.7, z: -1.28 },
        { x: 24.0, y: 1.6, z: 0.02 }
      ),
      focus: new THREE.Vector3(24, 1.3, 0),
      focusRadius: 1.1,
    },
    {
      title: 'Profile + back',
      rect: [cellW, ROW_HEIGHT, cellW, cellH],
      camera: makeCamera(
        20,
        cellW / cellH,
        { x: 39.95, y: 1.2, z: -7.3 },
        { x: 39.95, y: 0.92, z: 0 }
      ),
      focus: new THREE.Vector3(39.95, 1, 0),
      focusRadius: 2.2,
    },
    {
      title: 'Deformation under an extreme pose',
      rect: [cellW * 2, ROW_HEIGHT, cellW, cellH],
      camera: makeCamera(
        20,
        cellW / cellH,
        { x: 56.4, y: 1.2, z: -7.3 },
        { x: 56.4, y: 0.9, z: 0 }
      ),
      focus: new THREE.Vector3(56.4, 1, 0),
      focusRadius: 2.4,
    },
    {
      title: 'LOD ladder',
      rect: [cellW * 3, ROW_HEIGHT, cellW, cellH],
      camera: makeCamera(
        20,
        cellW / cellH,
        { x: 71.0, y: 1.2, z: -8.5 },
        { x: 71.0, y: 0.92, z: 0 }
      ),
      focus: new THREE.Vector3(71, 1, 0),
      focusRadius: 2.6,
    },
  ];

  /* ---- overlay chrome --------------------------------------------------- */

  for (const panel of panels) {
    const [px, py, , ph] = panel.rect;
    const title = document.createElement('div');
    title.className = 'panel-title';
    title.style.left = `${px + 14}px`;
    // Titles sit at the foot of each panel, clear of the stats readout.
    title.style.top = `${py + ph - 24}px`;
    title.textContent = panel.title;
    overlay.appendChild(title);
  }

  const hr = document.createElement('div');
  hr.className = 'divider';
  hr.style.cssText = `left:0;top:${ROW_HEIGHT}px;width:${WIDTH}px;height:1px;`;
  overlay.appendChild(hr);
  for (let i = 1; i < 4; i++) {
    const vr = document.createElement('div');
    vr.className = 'divider';
    vr.style.cssText = `left:${cellW * i}px;top:${ROW_HEIGHT}px;width:1px;height:${cellH}px;`;
    overlay.appendChild(vr);
  }

  const rowCamera = panels[0]!.camera;
  const projected = new THREE.Vector3();
  for (const placed of row) {
    projected.set(placed.root.position.x, 0.04, placed.root.position.z).project(rowCamera);
    const sx = ((projected.x + 1) / 2) * WIDTH;
    const sy = ((1 - projected.y) / 2) * ROW_HEIGHT;
    const label = document.createElement('div');
    label.className = 'label';
    const profile = placed.build.profile;
    label.innerHTML =
      `${placed.name}<small>${profile.archetype} · ${profile.height.toFixed(2)} m · ` +
      `${placed.build.stats.triangles} tris</small>`;
    label.style.left = `${sx}px`;
    label.style.top = `${Math.min(sy + 10, ROW_HEIGHT - 46)}px`;
    overlay.appendChild(label);
  }

  const lodLabels = ['LOD0', 'LOD1', 'LOD2'];
  lodBuilds.forEach((build, i) => {
    projected.set(lodX(i), 0.04, 0).project(panels[4]!.camera);
    const [px, py, pw, ph] = panels[4]!.rect;
    const label = document.createElement('div');
    label.className = 'label';
    label.innerHTML = `${lodLabels[i]}<small>${build.stats.triangles} tris</small>`;
    label.style.left = `${px + Math.min(Math.max(((projected.x + 1) / 2) * pw, 44), pw - 44)}px`;
    label.style.top = `${py + ((1 - projected.y) / 2) * ph + 6}px`;
    overlay.appendChild(label);
  });

  /* ---- numeric readout -------------------------------------------------- */

  const perCharacter = row.map((placed) => {
    const topology = analyseTopology(placed.build.geometry);
    const skinning = analyseSkinning(placed.build.geometry, placed.build.rig.bones.length);
    return {
      name: placed.name,
      triangles: placed.build.stats.triangles,
      vertices: placed.build.stats.vertices,
      components: topology.components,
      watertight: topology.watertight,
      degenerate: topology.degenerateTriangles,
      maxWeightError: skinning.maxWeightError,
      outOfRange: skinning.outOfRangeIndices,
      height: placed.build.stats.height,
      silhouette: measureSilhouette(placed.build.geometry),
    };
  });

  let minDistance = Number.POSITIVE_INFINITY;
  let minPair = '';
  for (let i = 0; i < perCharacter.length; i++) {
    for (let j = i + 1; j < perCharacter.length; j++) {
      const d = silhouetteDistance(perCharacter[i]!.silhouette, perCharacter[j]!.silhouette);
      if (d < minDistance) {
        minDistance = d;
        minPair = `${perCharacter[i]!.name} / ${perCharacter[j]!.name}`;
      }
    }
  }

  const allWatertight = perCharacter.every((c) => c.watertight && c.degenerate === 0);
  const allSkinned = perCharacter.every((c) => c.maxWeightError < 1e-5 && c.outOfRange === 0);
  const maxTris = Math.max(...perCharacter.map((c) => c.triangles));
  const flag = (ok: boolean): string => (ok ? 'class="ok"' : 'class="bad"');

  readout.innerHTML =
    `<b>bones</b> 27 (Mixamo names) &nbsp; <b>LOD0 max</b> ${maxTris} tris / 4000 budget<br>` +
    `<b>LOD1</b> ${lodBuilds[1]!.stats.triangles} tris &nbsp; <b>LOD2</b> ${lodBuilds[2]!.stats.triangles} tris<br>` +
    `<span ${flag(allWatertight)}>watertight ${allWatertight ? 'PASS' : 'FAIL'}</span> ` +
    `(0 boundary / 0 non-manifold / 0 degenerate edges)<br>` +
    `<span ${flag(allSkinned)}>skin weights ${allSkinned ? 'PASS' : 'FAIL'}</span> ` +
    `(4 slots, sum 1 &plusmn; ${perCharacter.reduce((m, c) => Math.max(m, c.maxWeightError), 0).toExponential(1)})<br>` +
    `<b>silhouette</b> closest pair ${minDistance.toFixed(4)} (${minPair})`;

  window.__HARNESS_STATS__ = {
    perCharacter: perCharacter.map((c) => ({
      name: c.name,
      triangles: c.triangles,
      vertices: c.vertices,
      components: c.components,
      watertight: c.watertight,
      degenerate: c.degenerate,
      maxWeightError: c.maxWeightError,
      outOfRange: c.outOfRange,
      height: c.height,
      profile: c.silhouette.profile,
    })),
    lodTriangles: lodBuilds.map((b) => b.stats.triangles),
    minSilhouetteDistance: minDistance,
    minSilhouettePair: minPair,
    allWatertight,
    allSkinned,
  };

  /* ---- render ----------------------------------------------------------- */

  const shadowCamera = key.shadow.camera;

  function renderPanel(panel: Panel): void {
    const [px, py, pw, ph] = panel.rect;
    // Refit the shadow frustum per panel: one 2048 map stretched over 80 m of
    // world would give every character the same four blocky texels.
    key.target.position.copy(panel.focus);
    key.position.copy(panel.focus).add(new THREE.Vector3(4.5, 7.5, -6.5));
    shadowCamera.left = -panel.focusRadius;
    shadowCamera.right = panel.focusRadius;
    shadowCamera.top = panel.focusRadius;
    shadowCamera.bottom = -panel.focusRadius;
    shadowCamera.near = 0.5;
    shadowCamera.far = panel.focusRadius * 4 + 12;
    shadowCamera.updateProjectionMatrix();
    key.target.updateMatrixWorld(true);

    renderer.setViewport(px, HEIGHT - py - ph, pw, ph);
    renderer.setScissor(px, HEIGHT - py - ph, pw, ph);
    renderer.render(scene, panel.camera);
  }

  renderer.setScissorTest(true);
  for (const panel of panels) renderPanel(panel);

  window.__HARNESS_READY__ = true;
}

try {
  boot();
} catch (error) {
  const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  window.__HARNESS_ERROR__ = detail;
  const box = document.getElementById('error');
  if (box) {
    box.style.display = 'block';
    box.textContent = detail;
  }
  window.__HARNESS_READY__ = true;
}
