/**
 * RENDERER VERIFICATION HARNESS
 *
 * A standalone PBR scene that exercises every path `src/engine/**` owns, and a
 * control surface on `window.__RENDER_HARNESS__` for Playwright to drive.
 *
 * ── WHAT THE SCENE IS FOR ──────────────────────────────────────────────────
 * Every object is here to make a specific claim falsifiable:
 *
 *   sphere grid (5x5)     metalness x roughness — proves IBL, PMREM/SH and the
 *                         ACES pipeline actually respond to material parameters.
 *                         25 DISTINCT MATERIALS, ONE SHADER PROGRAM: the whole
 *                         point of `MaterialLib`'s signature model.
 *   ground plane          triplanar projection + the global damage/dust mask.
 *   towers                large shadow casters spanning several cascades.
 *   instanced props       per-instance tint/wear from instanced attributes.
 *   instanced debris      instancing + vertex colours — the exact permutation
 *                         whose first compile costs ~400ms without warmup.
 *   distant crowd         placed BEYOND the cascade range so the instanced
 *                         blob-shadow decals are the thing under them.
 *   emissive sign        an emissive surface above the bloom threshold.
 *
 * ── WHAT IT IS NOT ─────────────────────────────────────────────────────────
 * Not a benchmark. This runs under SwiftShader in CI, which is a CPU software
 * rasteriser: frame rate here is meaningless and is never asserted on. The
 * harness verifies COUNTED things — draw calls, triangles, shader programs,
 * texture bytes — and that the resulting pixels are not blank.
 */

import * as THREE from 'three';
import type { IGameDiagnostics, IQualityTier, MaterialSpec } from '@/types';
import { createEventBus, createRng } from '@/util';
import {
  ANIME_GRADE,
  EnvironmentLighting,
  GameClock,
  ImpactFreeze,
  MaterialLib,
  MutableLightingState,
  PostProcessing,
  Renderer,
  ShaderWarmup,
  ShadowSystem,
  applyInstanceVariation,
  createNoiseAlbedo,
  createNoiseNormal,
  createOrmTexture,
  createProceduralSkyTexture,
  estimateSceneMemory,
  hasSpecularOnlyEnvironment,
  formatBytes,
  renderProfileFor,
  submitCrowdBlobShadows,
  type ISceneMemoryReport,
} from '@/engine';

/* -------------------------------------------------------------------------- */
/* Harness control surface                                                    */
/* -------------------------------------------------------------------------- */

interface IHarnessSnapshot {
  readonly tier: IQualityTier;
  readonly isWebGL2: boolean;
  readonly rendererString: string;
  readonly vendor: string;
  readonly maxTextureSize: number;
  readonly maxAnisotropy: number;
  readonly compressedFormats: readonly string[];
  readonly hasParallelShaderCompile: boolean;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly points: number;
  readonly lines: number;
  readonly geometries: number;
  readonly textures: number;
  readonly programs: number;
  readonly programKeys: readonly string[];
  readonly frameCount: number;
  readonly frameTimeMs: number;
  readonly drawingBuffer: { width: number; height: number };
  readonly pixelRatio: number;
  readonly resolutionScale: number;
  readonly medianFrameMs: number;
  readonly materialCount: number;
  readonly materialSignatures: readonly string[];
  /** Managed materials whose environment map is cancelled to specular-only. */
  readonly specularOnlyMaterials: number;
  readonly warmup: {
    materials: number;
    meshes: number;
    compiled: number;
    programsAfter: number;
    durationMs: number;
    destinations: string[];
  };
  readonly post: {
    mode: string;
    direct: boolean;
    passCount: number;
    passNames: readonly string[];
    msaaSamples: number;
    bloomScale: number;
    bloomKind: string;
    bloomBytes: number;
  };
  readonly shadows: {
    cascades: number;
    mapSize: number;
    maxDistance: number;
    shadowMapBytes: number;
    blobShadows: number;
    registeredMaterials: number;
  };
  readonly environment: {
    mode: string;
    gpuBytes: number;
    resolution: number;
    hasSphericalHarmonics: boolean;
    lastBuildMs: number;
    specularOnly: boolean;
    specularCubeSize: number;
  };
  readonly memory: ISceneMemoryReport;
  readonly clock: { timeScale: number; elapsed: number; unscaledElapsed: number };
  readonly impact: { active: boolean; phase: string; fovOffset: number };
  readonly cameraFov: number;
  readonly consoleErrors: readonly string[];
}

interface IRenderHarness {
  readonly ready: boolean;
  snapshot(): IHarnessSnapshot;
  /** Fire the lethal-hit event on the bus; drives the impact freeze. */
  emitLethalHit(): void;
  /** Cheap poll for the impact freeze, without building a full snapshot. */
  isImpactActive(): boolean;
  /** Force a resolution scale so the governor path can be observed. */
  setResolutionScale(scale: number): void;
  /** Push a global dust level into every injected material. */
  setDust(amount: number): void;
  /**
   * Stop the camera orbit so two frames can be compared pixel for pixel.
   * Without this, any A/B test is confounded by the camera having moved.
   */
  setCameraFrozen(frozen: boolean): void;
  /**
   * Turn the SH path's specular-only probe on or off. Off is the "smooth metal
   * renders black" state, kept reachable purely so the fix can be measured.
   */
  setSpecularProbe(enabled: boolean): void;
  /** Switch tier inside this context. Program counts ACCUMULATE afterwards. */
  setTier(tier: IQualityTier): void;
  /** Resolve after `count` more presented frames. */
  waitFrames(count: number): Promise<void>;
}

declare global {
  interface Window {
    __RENDER_HARNESS__?: IRenderHarness;
  }
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

const consoleErrors: string[] = [];
const statusElement = document.getElementById('status');
const overlayElement = document.getElementById('overlay');
const fatalElement = document.getElementById('fatal');

function setStatus(text: string): void {
  if (statusElement) statusElement.textContent = text;
}

function fatal(message: string, error: unknown): void {
  const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  consoleErrors.push(`${message}: ${detail}`);
  console.error(message, error);
  if (fatalElement) {
    fatalElement.style.display = 'block';
    fatalElement.textContent = `${message}\n\n${detail}`;
  }
  statusElement?.classList.add('hidden');
}

function readTier(): IQualityTier {
  const value = new URLSearchParams(window.location.search).get('tier');
  return value === 'low' || value === 'medium' || value === 'high' ? value : 'medium';
}

function main(): void {
  const tier = readTier();
  const profile = renderProfileFor(tier);

  const canvas = document.getElementById('harness-canvas') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('#harness-canvas missing');

  /* ---------------------------- core objects ---------------------------- */

  const lighting = new MutableLightingState();
  // Mid-afternoon key from the upper left. Chosen so the fixed camera angle
  // below is side-lit: shadows fall across the frame instead of hiding behind
  // their casters, and the sun disc stays out of shot so nothing blows out.
  lighting.sunDirection.set(-0.62, -0.52, -0.59).normalize();
  lighting.sunColor.setHex(0xfff0d6);
  lighting.sunIntensity = 3.0;
  lighting.ambientColor.setHex(0x8fb0e0);
  lighting.exposure = 0.72;
  lighting.envMapIntensity = 1;
  lighting.fogColor.setHex(0xa9c0d8);
  lighting.fogDensity = 0.0022;

  const renderer = new Renderer({
    canvas,
    profile,
    lighting,
    // Harness-only: lets the driver read the drawing buffer back directly if a
    // compositor screenshot is ever in doubt. Never enable this in the game.
    preserveDrawingBuffer: true,
    width: window.innerWidth,
    height: window.innerHeight,
    // Deterministic screenshots: the governor must not change resolution
    // between the frame that settles and the frame that is captured. It is
    // exercised explicitly through `setResolutionScale()` instead.
    adaptiveResolution: false,
  });

  const scene = new THREE.Scene();
  scene.name = 'harnessScene';
  scene.fog = new THREE.FogExp2(lighting.fogColor.getHex(), lighting.fogDensity);

  const camera = new THREE.PerspectiveCamera(
    52,
    window.innerWidth / Math.max(1, window.innerHeight),
    0.25,
    profile.settings.drawDistance
  );
  camera.position.set(11.5, 6.4, 15.5);
  camera.lookAt(0, 2.0, -2);

  const bus = createEventBus();
  const clock = new GameClock();

  /* ------------------------------ lighting ------------------------------ */

  setStatus('building environment');
  // Procedural stand-in. The asset workstream will hand a real Poly Haven HDRI
  // through `IAssetRegistry.getHDRI()`; nothing here is coupled to either.
  const skyTexture = createProceduralSkyTexture({
    width: 256,
    sunDirection: lighting.sunDirection,
    sunColor: lighting.sunColor,
    // A 260x sun disc is physically closer to the truth but makes every frame
    // that catches the sun a white rectangle after ACES. 130 keeps the disc
    // above the bloom threshold without swamping the exposure.
    sunIntensity: 130,
    cloudiness: 0.5,
  });

  // The material library is constructed BEFORE the environment on purpose. On
  // the SH path the environment map lights specular only, and every material
  // has to cancel its diffuse term or it is lit twice. Building the library
  // first means materials are born with the define instead of being recompiled
  // a frame later.
  const anisotropy = Math.min(
    profile.settings.anisotropy,
    renderer.getCapabilities().maxAnisotropy
  );
  const materials = new MaterialLib({ anisotropy, programBudget: 24 });

  const environment = new EnvironmentLighting(renderer.raw, scene, {
    mode: profile.ibl,
    showBackground: true,
    intensity: lighting.envMapIntensity,
    // 32px cube faces: enough angular detail to read as a reflection on
    // corrugated iron or a street lamp, small enough to be a few hundred KB
    // instead of the tens of megabytes a real HDRI's full PMREM would cost.
    specularCubeSize: 32,
    onSpecularOnlyChanged: (specularOnly) => materials.setSpecularOnlyEnvironment(specularOnly),
  });
  environment.setEnvironment(skyTexture);
  environment.applyLightingState(lighting);

  const shadows = new ShadowSystem(scene, camera, { profile: profile.shadows, lighting });

  /* ----------------------------- materials ------------------------------ */

  setStatus('building materials');
  // Every lit material must be registered with the shadow system, or the
  // non-CSM branch of the lighting chunk accumulates all N cascade lights and
  // the object renders N times too bright.
  materials.onMaterialCreated((material) => shadows.registerMaterial(material));

  const groundAlbedo = createNoiseAlbedo({ size: 256, color: 0x74706a, accent: 0x46443f, seed: 3 });
  const groundNormal = createNoiseNormal(256, 2.6, 3);
  const groundOrm = createOrmTexture({ size: 256, roughness: 0.86, metalness: 0, seed: 3 });

  const panelAlbedo = createNoiseAlbedo({
    size: 256,
    color: 0x9c9689,
    accent: 0x585349,
    grid: 0.85,
    seed: 11,
  });
  const panelNormal = createNoiseNormal(256, 1.6, 11);
  const panelOrm = createOrmTexture({ size: 256, roughness: 0.62, metalness: 0, seed: 11 });

  const spec = (id: string, extra: Partial<MaterialSpec> = {}): MaterialSpec => ({
    id,
    kind: 'standard',
    ...extra,
  });

  const groundMaterial = materials.acquire({
    spec: spec('harness.ground', { roughness: 0.9, metalness: 0, color: 0xffffff }),
    features: { triplanar: true, damageMask: true },
    triplanarScale: 0.22,
    triplanarSharpness: 6,
    textures: { map: groundAlbedo, normalMap: groundNormal, ormMap: groundOrm },
  });

  const structureMaterial = materials.acquire({
    spec: spec('harness.structure', { roughness: 0.75, metalness: 0.05, color: 0xffffff }),
    features: { damageMask: true },
    textures: { map: panelAlbedo, normalMap: panelNormal, ormMap: panelOrm },
  });

  const propMaterial = materials.acquire({
    spec: spec('harness.prop.instanced', { roughness: 0.7, metalness: 0.04, color: 0xffffff }),
    features: { instanceVariation: true, damageMask: true },
    textures: { map: panelAlbedo, normalMap: panelNormal, ormMap: panelOrm },
  });

  const debrisMaterial = materials.acquire({
    spec: spec('harness.debris.instanced', { roughness: 0.88, metalness: 0 }),
    features: { instanceVariation: true },
    vertexColors: true,
  });

  const emissiveMaterial = materials.acquire({
    spec: spec('harness.emissive', {
      color: 0x141414,
      roughness: 0.4,
      metalness: 0,
      emissive: 0xffd230,
      emissiveIntensity: 3.4,
    }),
  });

  // Skinned characters are a distinct program variant; warm one so the real
  // game's first character draw is not a compile.
  const characterMaterial = materials.acquire({
    spec: spec('harness.character', { color: 0xd8c9a8, roughness: 0.62, metalness: 0 }),
  });

  /* ------------------- the PBR grid: 25 materials, 1 program ------------- */

  const sphereMaterials: THREE.Material[] = [];
  const GRID = 5;
  for (let m = 0; m < GRID; m++) {
    for (let r = 0; r < GRID; r++) {
      sphereMaterials.push(
        materials.acquire({
          spec: spec(`harness.sphere.m${m}.r${r}`, {
            color: 0xc6cad0,
            metalness: m / (GRID - 1),
            // Never exactly 0: a perfect mirror has no visible roughness
            // response and makes the grid's left column uninformative.
            roughness: Math.max(0.045, r / (GRID - 1)),
          }),
        })
      );
    }
  }

  /* ------------------------------ geometry ------------------------------ */

  setStatus('building geometry');
  const random = createRng(0xa17e);
  const rand = (): number => random.next();

  // Ground: a large plane, triplanar-projected so it needs no UV set at all.
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(160, 160, 1, 1), groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.name = 'ground';
  scene.add(ground);

  // Sphere grid.
  const sphereGeometry = new THREE.SphereGeometry(0.78, 32, 24);
  const spheres = new THREE.Group();
  spheres.name = 'sphereGrid';
  for (let m = 0; m < GRID; m++) {
    for (let r = 0; r < GRID; r++) {
      const mesh = new THREE.Mesh(sphereGeometry, sphereMaterials[m * GRID + r]!);
      mesh.position.set((r - (GRID - 1) / 2) * 1.95, 1.05 + m * 1.95, -1.5);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      spheres.add(mesh);
    }
  }
  scene.add(spheres);

  // Towers: large casters that straddle several cascades.
  const towerGeometry = new THREE.BoxGeometry(1, 1, 1);
  const towers = new THREE.Group();
  towers.name = 'towers';
  for (let i = 0; i < 9; i++) {
    const mesh = new THREE.Mesh(towerGeometry, structureMaterial);
    const height = 7 + rand() * 22;
    mesh.scale.set(4 + rand() * 4, height, 4 + rand() * 4);
    const angle = (i / 9) * Math.PI * 2 + rand() * 0.4;
    const distance = 34 + rand() * 34;
    mesh.position.set(Math.cos(angle) * distance, height / 2, Math.sin(angle) * distance - 8);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    towers.add(mesh);
  }
  scene.add(towers);

  // A slab in front of the grid, purely so the sun casts a hard shadow across
  // the ground where the screenshot check will see it.
  const slab = new THREE.Mesh(new THREE.BoxGeometry(9, 4.2, 0.9), structureMaterial);
  slab.position.set(-1.5, 2.1, -8.5);
  slab.castShadow = true;
  slab.receiveShadow = true;
  scene.add(slab);

  // Instanced props with per-copy tint and wear.
  const PROP_COUNT = 220;
  const propMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.9, 0.9, 0.9),
    propMaterial,
    PROP_COUNT
  );
  propMesh.name = 'props';
  propMesh.castShadow = true;
  propMesh.receiveShadow = true;
  {
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const scale = new THREE.Vector3();
    for (let i = 0; i < PROP_COUNT; i++) {
      const angle = rand() * Math.PI * 2;
      const distance = 6 + rand() * 46;
      const size = 0.6 + rand() * 1.5;
      position.set(Math.cos(angle) * distance, size * 0.45, Math.sin(angle) * distance - 4);
      euler.set(0, rand() * Math.PI * 2, 0);
      quaternion.setFromEuler(euler);
      scale.setScalar(size);
      matrix.compose(position, quaternion, scale);
      propMesh.setMatrixAt(i, matrix);
    }
    propMesh.instanceMatrix.needsUpdate = true;
  }
  applyInstanceVariation(propMesh, rand, {
    baseColor: 0xffffff,
    tintRange: [0.72, 1.12],
    wearRange: [0, 0.9],
    hueJitter: 0.03,
  });
  scene.add(propMesh);

  // Instanced, vertex-coloured debris — the permutation that stalls without
  // warmup. Kept in the scene so the harness always draws it.
  const DEBRIS_COUNT = 320;
  const debrisGeometry = new THREE.TetrahedronGeometry(0.34, 0);
  {
    const count = debrisGeometry.attributes.position!.count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const shade = 0.35 + rand() * 0.5;
      colors[i * 3] = shade;
      colors[i * 3 + 1] = shade * 0.94;
      colors[i * 3 + 2] = shade * 0.86;
    }
    debrisGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  const debrisMesh = new THREE.InstancedMesh(debrisGeometry, debrisMaterial, DEBRIS_COUNT);
  debrisMesh.name = 'debris';
  debrisMesh.castShadow = true;
  {
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const scale = new THREE.Vector3();
    for (let i = 0; i < DEBRIS_COUNT; i++) {
      const angle = rand() * Math.PI * 2;
      const distance = 2 + rand() * 20;
      position.set(Math.cos(angle) * distance, 0.12 + rand() * 0.5, Math.sin(angle) * distance - 3);
      euler.set(rand() * 6.28, rand() * 6.28, rand() * 6.28);
      quaternion.setFromEuler(euler);
      scale.setScalar(0.55 + rand() * 1.1);
      matrix.compose(position, quaternion, scale);
      debrisMesh.setMatrixAt(i, matrix);
    }
    debrisMesh.instanceMatrix.needsUpdate = true;
  }
  applyInstanceVariation(debrisMesh, rand, {
    baseColor: 0xffffff,
    tintRange: [0.6, 1.05],
    wearRange: [0.2, 1],
  });
  scene.add(debrisMesh);

  // Emissive sign: proves the emissive path and gives bloom something above
  // the 1.0 threshold to find.
  const sign = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.9, 0.16), emissiveMaterial);
  sign.position.set(4.6, 3.1, -7.6);
  scene.add(sign);

  /* -------- distant crowd: beyond the cascades, so blobs take over ------- */

  const CROWD = 72;
  const crowdMesh = new THREE.InstancedMesh(
    new THREE.CapsuleGeometry(0.28, 1.0, 3, 8),
    characterMaterial,
    CROWD
  );
  crowdMesh.name = 'crowd';
  crowdMesh.castShadow = true;
  const crowdEntries: { x: number; groundY: number; z: number; radius: number }[] = [];
  {
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    const beyond = Math.max(profile.shadows.maxDistance, 40);
    for (let i = 0; i < CROWD; i++) {
      const angle = rand() * Math.PI * 2;
      // Deliberately outside the cascade range: these must be blob-shadowed.
      const distance = beyond * (1.05 + rand() * 0.55);
      const x = Math.cos(angle) * distance;
      const z = Math.sin(angle) * distance;
      position.set(x, 0.79, z);
      matrix.compose(position, quaternion, scale);
      crowdMesh.setMatrixAt(i, matrix);
      crowdEntries.push({ x, groundY: 0, z, radius: 0.42 });
    }
    crowdMesh.instanceMatrix.needsUpdate = true;
  }
  scene.add(crowdMesh);

  /* --------------------------- damage/dust mask ------------------------- */

  // A world-space mask the destruction system would paint into. Here it is a
  // static blast smear around the origin, proving the injection samples it.
  const MASK_SIZE = 128;
  const maskData = new Uint8Array(MASK_SIZE * MASK_SIZE * 4);
  for (let y = 0; y < MASK_SIZE; y++) {
    for (let x = 0; x < MASK_SIZE; x++) {
      const dx = (x / MASK_SIZE - 0.5) * 2;
      const dy = (y / MASK_SIZE - 0.5) * 2;
      const d = Math.hypot(dx, dy);
      const value = Math.max(0, 1 - d * 1.35) ** 1.7;
      const i = (y * MASK_SIZE + x) * 4;
      maskData[i] = Math.round(value * 255);
      maskData[i + 1] = maskData[i]!;
      maskData[i + 2] = maskData[i]!;
      maskData[i + 3] = 255;
    }
  }
  const maskTexture = new THREE.DataTexture(maskData, MASK_SIZE, MASK_SIZE, THREE.RGBAFormat);
  maskTexture.colorSpace = THREE.NoColorSpace;
  maskTexture.needsUpdate = true;
  materials.setDamageMask(maskTexture, 0, -4, 90, 90);
  materials.setDustAmount(0.06);

  /* --------------------------- post-processing -------------------------- */

  setStatus('building post chain');
  const post = new PostProcessing({
    renderer: renderer.raw,
    scene,
    camera,
    profile: profile.post,
    grade: ANIME_GRADE,
    exposure: lighting.exposure,
  });
  renderer.setPostProcessing(post);

  /* ------------------------------ warmup -------------------------------- */

  setStatus('compiling shaders');
  // Warm ONLY the destination this tier will actually draw to. three compiles
  // a different program for the default framebuffer (sRGB + tone mapping) than
  // for a render target (linear + none), so warming both would double the
  // material program count with variants half of which can never be used.
  const composerTier = profile.post.mode !== 'off';
  const warmup = new ShaderWarmup(renderer.raw, scene, {
    size: 4,
    includeOffscreen: composerTier,
    includeDirectFramebuffer: !composerTier,
    warmShadows: true,
  });
  warmup.add(groundMaterial, ['static']);
  warmup.add(structureMaterial, ['static']);
  warmup.add(propMaterial, ['instanced']);
  warmup.add(debrisMaterial, ['instancedVertexColors']);
  warmup.add(emissiveMaterial, ['static']);
  warmup.add(characterMaterial, ['instanced', 'skinned']);
  // One representative sphere: all 25 share a signature, so warming one warms
  // the program the other 24 will use.
  warmup.add(sphereMaterials[0]!, ['static']);
  const warmupReport = warmup.run();
  post.warmup();
  warmup.dispose();

  /* ----------------------------- impact feel ---------------------------- */

  const impact = new ImpactFreeze(clock, camera, bus, {
    onImpact: (intensity) => post.triggerImpact(intensity),
  });

  /* -------------------------------- loop -------------------------------- */

  const diagnostics: IGameDiagnostics = {
    renderer: renderer.getCapabilities().renderer,
    vendor: renderer.getCapabilities().vendor,
    isWebGL2: renderer.getCapabilities().isWebGL2,
    maxTextureSize: renderer.getCapabilities().maxTextureSize,
    maxAnisotropy: renderer.getCapabilities().maxAnisotropy,
    compressedFormats: [...renderer.getCapabilities().compressedFormats],
    drawCalls: 0,
    triangles: 0,
    fps: 0,
    frameCount: 0,
    quality: tier,
    bootTimeMs: 0,
    build: 'renderer-harness',
    errors: consoleErrors,
  };
  window.__GAME_DIAG__ = diagnostics;

  let presentedFrames = 0;
  let cameraFrozen = false;
  const frameWaiters: { target: number; resolve: () => void }[] = [];

  function onResize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    post.setSize(renderer.width, renderer.height);
    shadows.onCameraChanged();
  }
  window.addEventListener('resize', onResize, { passive: true });

  function tick(now: number): void {
    requestAnimationFrame(tick);

    clock.tick(now);
    bus.setFrame(clock.frameCount, clock.elapsed);

    // Impact freeze runs on REAL time: feeding it the scaled delta would turn a
    // 90ms hit-stop into 2.25 seconds of apparent hang.
    impact.update(clock.rawDelta);

    // Orbit driven by FRAME COUNT, not elapsed time. The scene still moves —
    // proving the frame is live rather than a stuck buffer — but every tier
    // reaches an identical camera pose after the same number of frames, so the
    // three screenshots are directly comparable. Under SwiftShader, where frame
    // times vary by an order of magnitude, a time-driven orbit would put each
    // tier at a different angle and turn the evidence into noise.
    if (!cameraFrozen) {
      const t = 0.8 + presentedFrames * 0.01;
      camera.position.set(Math.sin(t) * 21, 7.4, Math.cos(t) * 21);
      camera.lookAt(0, 3.2, -2);
    }

    shadows.applyLightingState(lighting);
    shadows.update();
    submitCrowdBlobShadows(
      shadows.blobShadows,
      camera,
      crowdEntries,
      shadows.cascadeRange,
      profile.settings.drawDistance
    );

    renderer.render(scene, camera);

    presentedFrames++;
    const stats = renderer.getStats();
    diagnostics.drawCalls = stats.drawCalls;
    diagnostics.triangles = stats.triangles;
    diagnostics.fps = stats.fps;
    diagnostics.frameCount = presentedFrames;

    for (let i = frameWaiters.length - 1; i >= 0; i--) {
      if (presentedFrames >= frameWaiters[i]!.target) {
        frameWaiters[i]!.resolve();
        frameWaiters.splice(i, 1);
      }
    }

    if (presentedFrames === 2) {
      diagnostics.bootTimeMs = Math.round(performance.now());
      window.__GAME_READY__ = true;
      statusElement?.classList.add('hidden');
    }

    if (presentedFrames % 10 === 0 && overlayElement) {
      const memory = estimateSceneMemory(scene);
      overlayElement.textContent = [
        `tier        ${tier}   post ${post.getStats().mode}${post.isDirect ? ' (direct)' : ''}`,
        `draws       ${stats.drawCalls}    tris ${stats.triangles.toLocaleString()}`,
        `programs    ${stats.programs}    materials ${materials.size} / ${materials.programCount} sig`,
        `buffer      ${renderer.width}x${renderer.height} @ dpr ${renderer.pixelRatio.toFixed(2)} x${renderer.governor.scale.toFixed(2)}`,
        `shadows     ${shadows.cascadeCount}x${profile.shadows.mapSize} / ${shadows.cascadeRange}m   blobs ${shadows.blobShadows.count}`,
        `ibl         ${environment.mode}${environment.getStats().specularOnly ? ' +spec' : ''}  ${formatBytes(environment.getStats().gpuBytes)}`,
        `textures    ${memory.textureCount} / ${formatBytes(memory.textureBytes)}`,
        `timeScale   ${clock.timeScale.toFixed(3)}   fov ${camera.fov.toFixed(1)}`,
      ].join('\n');
    }
  }
  requestAnimationFrame(tick);

  /* -------------------------- control surface --------------------------- */

  /**
   * How many managed materials carry the specular-only define. On the SH path
   * this must be ALL of them: a material that misses it is lit by the SH probe
   * AND the probe texture, i.e. a stop too bright.
   */
  function countSpecularOnlyMaterials(): number {
    let count = 0;
    materials.forEach((material) => {
      if (hasSpecularOnlyEnvironment(material)) count++;
    });
    return count;
  }

  const harness: IRenderHarness = {
    get ready(): boolean {
      return window.__GAME_READY__ === true;
    },

    snapshot(): IHarnessSnapshot {
      const stats = renderer.getStats();
      const capabilities = renderer.getCapabilities();
      const postStats = post.getStats();
      const shadowStats = shadows.getStats();
      const environmentStats = environment.getStats();
      const impactState = impact.getState();
      return {
        tier: renderer.tier,
        isWebGL2: capabilities.isWebGL2,
        rendererString: capabilities.renderer,
        vendor: capabilities.vendor,
        maxTextureSize: capabilities.maxTextureSize,
        maxAnisotropy: capabilities.maxAnisotropy,
        compressedFormats: [...capabilities.compressedFormats],
        hasParallelShaderCompile: capabilities.extensions.includes('KHR_parallel_shader_compile'),
        drawCalls: stats.drawCalls,
        triangles: stats.triangles,
        points: stats.points,
        lines: stats.lines,
        geometries: stats.geometries,
        textures: stats.textures,
        programs: stats.programs,
        programKeys: renderer.getProgramCacheKeys(),
        frameCount: presentedFrames,
        frameTimeMs: stats.frameTimeMs,
        drawingBuffer: { width: renderer.width, height: renderer.height },
        pixelRatio: renderer.pixelRatio,
        resolutionScale: renderer.governor.scale,
        medianFrameMs: renderer.governor.medianFrameMs,
        materialCount: materials.size,
        materialSignatures: [...materials.programSignatures.keys()],
        specularOnlyMaterials: countSpecularOnlyMaterials(),
        warmup: {
          materials: warmupReport.materials,
          meshes: warmupReport.meshes,
          compiled: warmupReport.compiled,
          programsAfter: warmupReport.programsAfter,
          durationMs: warmupReport.durationMs,
          destinations: [...warmupReport.destinations],
        },
        post: {
          mode: postStats.mode,
          direct: postStats.direct,
          passCount: postStats.passCount,
          passNames: [...postStats.passNames],
          msaaSamples: postStats.msaaSamples,
          bloomScale: postStats.bloomScale,
          bloomKind: postStats.bloomKind,
          bloomBytes: postStats.bloomBytes,
        },
        shadows: {
          cascades: shadowStats.cascades,
          mapSize: shadowStats.mapSize,
          maxDistance: shadowStats.maxDistance,
          shadowMapBytes: shadowStats.shadowMapBytes,
          blobShadows: shadowStats.blobShadows,
          registeredMaterials: shadowStats.registeredMaterials,
        },
        environment: {
          mode: environmentStats.mode,
          gpuBytes: environmentStats.gpuBytes,
          resolution: environmentStats.resolution,
          hasSphericalHarmonics: environmentStats.hasSphericalHarmonics,
          lastBuildMs: environmentStats.lastBuildMs,
          specularOnly: environmentStats.specularOnly,
          specularCubeSize: environmentStats.specularCubeSize,
        },
        memory: estimateSceneMemory(scene),
        clock: {
          timeScale: clock.timeScale,
          elapsed: clock.elapsed,
          unscaledElapsed: clock.unscaledElapsed,
        },
        impact: {
          active: impactState.active,
          phase: impactState.phase,
          fovOffset: impactState.fovOffset,
        },
        cameraFov: camera.fov,
        consoleErrors: [...consoleErrors],
      };
    },

    emitLethalHit(): void {
      // Exactly what the combat system would publish. The renderer subscribes;
      // neither side imports the other.
      bus.emit('EntityKilled', {
        entityId: 'harness.monster.001',
        entityType: 'monster',
        faction: 'monster',
        position: { x: 0, y: 1.5, z: -2 },
        killerId: 'harness.player',
        threatTier: 'dragon',
        specId: 'harness.spec',
        intent: 'full',
        rewardPoints: 500,
      });
    },

    isImpactActive(): boolean {
      return impact.isActive;
    },

    setResolutionScale(scale: number): void {
      renderer.governor.setScale(scale);
      // The governor's callback is what normally applies the scale; forcing a
      // size push here makes the change deterministic for the driver.
      renderer.setSize(window.innerWidth, window.innerHeight);
    },

    setDust(amount: number): void {
      materials.setDustAmount(amount);
    },

    setCameraFrozen(frozen: boolean): void {
      cameraFrozen = frozen;
    },

    setSpecularProbe(enabled: boolean): void {
      environment.setSpecularCubeSize(enabled ? 32 : 0);
    },

    setTier(next: IQualityTier): void {
      const nextProfile = renderer.setQualityTier(next);
      shadows.setProfile(nextProfile.shadows);
      environment.setMode(nextProfile.ibl);
      environment.setEnvironment(skyTexture);
      materials.setAnisotropy(
        Math.min(nextProfile.settings.anisotropy, renderer.getCapabilities().maxAnisotropy)
      );
      camera.far = nextProfile.settings.drawDistance;
      camera.updateProjectionMatrix();
      shadows.onCameraChanged();
    },

    waitFrames(count: number): Promise<void> {
      return new Promise<void>((resolve) => {
        frameWaiters.push({ target: presentedFrames + Math.max(1, count), resolve });
      });
    },
  };

  window.__RENDER_HARNESS__ = harness;
}

window.addEventListener('error', (event) => {
  consoleErrors.push(`error: ${event.message}`);
});
window.addEventListener('unhandledrejection', (event) => {
  consoleErrors.push(`unhandledrejection: ${String(event.reason)}`);
});

try {
  main();
} catch (error) {
  fatal('renderer harness failed to start', error);
}
