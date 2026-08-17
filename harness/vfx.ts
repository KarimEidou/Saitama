/**
 * VFX VERIFICATION HARNESS
 *
 * A city street, the real renderer stack, and `window.__VFX_HARNESS__` for
 * Playwright to drive.
 *
 * ── WHY A CITY AND NOT A GREY PLANE ────────────────────────────────────────
 * A shockwave has no scale without something to be big NEXT TO. Buildings
 * receding down a street are the only way a 180-metre cone reads as 180 metres
 * rather than as a large decal, and the dust only reads as a body of dust when
 * it occludes something. The street also gives the fixed camera real depth
 * cues, so the captured evidence can be judged rather than merely inspected.
 *
 * ── WHY THE SIMULATION STEPS AT A FIXED DELTA ──────────────────────────────
 * Under SwiftShader a frame can take half a second, and an effect driven by
 * wall-clock time would be at a completely different point in its life on
 * every machine. The loop therefore advances the VFX by exactly 1/60 s per
 * PRESENTED frame, and only when told to. "Frame 8 of the serious punch" is
 * then the same instant everywhere, which is what makes a screenshot evidence.
 *
 * ── HOW THE PROGRAM BUDGET IS MEASURED ─────────────────────────────────────
 * Baseline first: the scene is fully warmed and rendered with the VFX hidden,
 * and `renderer.info.programs.length` is recorded. Then the VFX are made
 * visible with live content and rendered again. The DELTA is what this
 * workstream costs, measured through the tier's real post chain — which
 * matters, because a program compiled for the default framebuffer is a
 * different program from the one compiled for the composer's render target.
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
  renderProfileFor,
} from '@/engine';
import { VFXSystem, type IVFXDiagnostics } from '@/vfx';

/* -------------------------------------------------------------------------- */
/* Control surface                                                            */
/* -------------------------------------------------------------------------- */

/** Scenarios the driver can fire. One per screenshot, plus the combined shot. */
export type VFXScenario =
  | 'shockwaveCone'
  | 'shockwaveRing'
  | 'dustPlume'
  | 'speedlines'
  | 'debrisTrails'
  | 'groundCracks'
  | 'cloudParting'
  | 'impactFlash'
  | 'seriousPunch';

export type CameraPreset = 'street' | 'hero' | 'punch' | 'wide' | 'sky' | 'ground';

interface IBudgetReport {
  /** Programs live with the VFX hidden. */
  baselinePrograms: number;
  /** Programs live once every VFX material has drawn. */
  totalPrograms: number;
  /** The delta — what this workstream costs. */
  vfxPrograms: number;
  /** Whole-frame draw calls with the VFX hidden. */
  baselineDrawCalls: number;
  /** Whole-frame draw calls with the VFX drawing. */
  totalDrawCalls: number;
  vfxDrawCalls: number;
  vfxTriangles: number;
  programKeys: string[];
}

interface IAllocationReport {
  supported: boolean;
  frames: number;
  /** Bytes the heap grew across N `vfx.update()` calls with no rendering. */
  simBytes: number;
  simBytesPerFrame: number;
  /** The same across N full frames, rendering included. Reported, not gated. */
  frameBytes: number;
  frameBytesPerFrame: number;
  /** Live particle count while the sample was taken — proof it was busy. */
  spritesDuringSample: number;
  heapBefore: number;
  heapAfter: number;
}

interface IVFXHarnessSnapshot {
  tier: IQualityTier;
  isWebGL2: boolean;
  rendererString: string;
  drawCalls: number;
  triangles: number;
  programs: number;
  programKeys: string[];
  presentedFrames: number;
  simSeconds: number;
  scenario: string;
  cameraPreset: string;
  vfx: IVFXDiagnostics;
  budget: IBudgetReport;
  post: { mode: string; direct: boolean; passNames: string[] };
  atlasBytes: number;
  clock: { timeScale: number };
  impact: { active: boolean; phase: string; fovOffset: number };
  consoleErrors: string[];
}

interface IVFXHarness {
  snapshot(): IVFXHarnessSnapshot;
  /** Clear every effect and reset the sim clock. */
  reset(): void;
  fire(scenario: VFXScenario): void;
  setCamera(preset: CameraPreset): void;
  /** Advance the simulation by exactly `frames` presented frames. */
  advance(frames: number): Promise<void>;
  /** Present `frames` frames WITHOUT advancing the simulation. */
  hold(frames: number): Promise<void>;
  setVFXVisible(visible: boolean): void;
  setOverlayVisible(visible: boolean): void;
  measureBudget(): Promise<IBudgetReport>;
  measureAllocation(frames: number): Promise<IAllocationReport>;
  /** Trigger the renderer's impact freeze, to judge the held frame. */
  freeze(): void;
  isFrozen(): boolean;
}

declare global {
  interface Window {
    __VFX_HARNESS__?: IVFXHarness;
    gc?: () => void;
  }
}

interface ChromeMemory {
  usedJSHeapSize: number;
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

const consoleErrors: string[] = [];
const statusElement = document.getElementById('status');
const overlayElement = document.getElementById('overlay');
const fatalElement = document.getElementById('fatal');

/** Fixed simulation step. See the file header. */
const FIXED_DT = 1 / 60;

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

function heapBytes(): number {
  const memory = (performance as unknown as { memory?: ChromeMemory }).memory;
  return memory ? memory.usedJSHeapSize : 0;
}

function main(): void {
  const tier = readTier();
  const profile = renderProfileFor(tier);

  const canvas = document.getElementById('harness-canvas') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('#harness-canvas missing');

  /* ------------------------------ lighting ------------------------------ */

  const lighting = new MutableLightingState();
  // Low afternoon sun raking across the street from behind the camera's right
  // shoulder. SIDE lighting, not front or back: a front-lit plume is a flat
  // grey wall, and a purely back-lit street is a row of black slabs with the
  // sun disc parked in shot.
  lighting.sunDirection.set(0.55, -0.66, -0.52).normalize();
  lighting.sunColor.setHex(0xffe6c2);
  lighting.sunIntensity = 3.2;
  lighting.ambientColor.setHex(0x8caedd);
  lighting.exposure = 0.86;
  lighting.envMapIntensity = 1;
  lighting.fogColor.setHex(0x9fb4cc);
  lighting.fogDensity = 0.0016;

  const renderer = new Renderer({
    canvas,
    profile,
    lighting,
    preserveDrawingBuffer: true,
    width: window.innerWidth,
    height: window.innerHeight,
    // Screenshots must be comparable frame to frame; the governor is exercised
    // by the renderer's own harness, not this one.
    adaptiveResolution: false,
  });

  const scene = new THREE.Scene();
  scene.name = 'vfxHarnessScene';
  scene.fog = new THREE.FogExp2(lighting.fogColor.getHex(), lighting.fogDensity);

  const camera = new THREE.PerspectiveCamera(
    54,
    window.innerWidth / Math.max(1, window.innerHeight),
    0.4,
    profile.settings.drawDistance
  );

  const bus = createEventBus();
  const clock = new GameClock();

  /* ---------------------------- environment ----------------------------- */

  setStatus('building environment');
  const skyTexture = createProceduralSkyTexture({
    width: 256,
    sunDirection: lighting.sunDirection,
    sunColor: lighting.sunColor,
    sunIntensity: 120,
    // Heavy overcast: the cloud-parting effect needs a sky worth parting.
    cloudiness: 0.72,
  });

  const anisotropy = Math.min(
    profile.settings.anisotropy,
    renderer.getCapabilities().maxAnisotropy
  );
  const materials = new MaterialLib({ anisotropy, programBudget: 24 });

  const environment = new EnvironmentLighting(renderer.raw, scene, {
    mode: profile.ibl,
    showBackground: true,
    intensity: lighting.envMapIntensity,
    specularCubeSize: 32,
    onSpecularOnlyChanged: (specularOnly) => materials.setSpecularOnlyEnvironment(specularOnly),
  });
  environment.setEnvironment(skyTexture);
  environment.applyLightingState(lighting);

  const shadows = new ShadowSystem(scene, camera, { profile: profile.shadows, lighting });
  materials.onMaterialCreated((material) => shadows.registerMaterial(material));

  /* ----------------------------- materials ------------------------------ */

  setStatus('building materials');
  const roadAlbedo = createNoiseAlbedo({ size: 256, color: 0x76736e, accent: 0x494744, seed: 5 });
  const roadNormal = createNoiseNormal(256, 2.2, 5);
  const roadOrm = createOrmTexture({ size: 256, roughness: 0.9, metalness: 0, seed: 5 });

  const wallAlbedo = createNoiseAlbedo({
    size: 256,
    color: 0x8e897f,
    accent: 0x4d4941,
    grid: 0.9,
    seed: 13,
  });
  const wallNormal = createNoiseNormal(256, 1.5, 13);
  const wallOrm = createOrmTexture({ size: 256, roughness: 0.68, metalness: 0.02, seed: 13 });

  const spec = (id: string, extra: Partial<MaterialSpec> = {}): MaterialSpec => ({
    id,
    kind: 'standard',
    ...extra,
  });

  const roadMaterial = materials.acquire({
    spec: spec('vfx.road', { roughness: 0.93, metalness: 0, color: 0xffffff }),
    features: { triplanar: true, damageMask: true },
    triplanarScale: 0.09,
    triplanarSharpness: 6,
    textures: { map: roadAlbedo, normalMap: roadNormal, ormMap: roadOrm },
  });

  const buildingMaterial = materials.acquire({
    spec: spec('vfx.building', { roughness: 0.72, metalness: 0.04, color: 0xffffff }),
    features: { damageMask: true },
    textures: { map: wallAlbedo, normalMap: wallNormal, ormMap: wallOrm },
  });

  const propMaterial = materials.acquire({
    spec: spec('vfx.prop.instanced', { roughness: 0.7, metalness: 0.05, color: 0xffffff }),
    features: { instanceVariation: true, damageMask: true },
    textures: { map: wallAlbedo, normalMap: wallNormal, ormMap: wallOrm },
  });

  const signMaterial = materials.acquire({
    spec: spec('vfx.sign', {
      color: 0x101014,
      roughness: 0.4,
      metalness: 0,
      emissive: 0xff8a2b,
      emissiveIntensity: 3.6,
    }),
  });

  /* ------------------------------ the street ---------------------------- */

  setStatus('building city');
  const random = createRng('vfx.harness.city');

  const road = new THREE.Mesh(new THREE.PlaneGeometry(900, 900, 1, 1), roadMaterial);
  road.rotation.x = -Math.PI / 2;
  road.receiveShadow = true;
  road.name = 'road';
  scene.add(road);

  // Two rows of towers flanking a street that runs down -Z. The punch is fired
  // along that street, so the cone recedes between them and the dust wall has
  // facades to eat.
  const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  const buildings = new THREE.Group();
  buildings.name = 'buildings';
  const streetHalfWidth = 17;
  for (let side = -1; side <= 1; side += 2) {
    let z = -8;
    while (z > -430) {
      const depth = 16 + random.next() * 26;
      const width = 14 + random.next() * 20;
      const height = 14 + Math.pow(random.next(), 1.6) * 78;
      const mesh = new THREE.Mesh(boxGeometry, buildingMaterial);
      mesh.scale.set(width, height, depth);
      mesh.position.set(
        side * (streetHalfWidth + width * 0.5 + random.next() * 5),
        height * 0.5,
        z - depth * 0.5
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      buildings.add(mesh);
      z -= depth + 5 + random.next() * 7;
    }
  }
  // A back wall of towers so the far end of the street is not empty sky, and
  // so the shockwave's leading edge has something to be measured against.
  for (let i = 0; i < 9; i++) {
    const height = 40 + random.next() * 90;
    const mesh = new THREE.Mesh(boxGeometry, buildingMaterial);
    mesh.scale.set(26 + random.next() * 26, height, 26 + random.next() * 22);
    mesh.position.set(-160 + i * 40 + random.next() * 12, height * 0.5, -470 - random.next() * 90);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    buildings.add(mesh);
  }
  scene.add(buildings);

  // Street furniture: instanced boxes lining the kerbs. Small, human-scaled
  // objects are what tell the eye how big the wave actually is.
  const PROPS = 260;
  const props = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), propMaterial, PROPS);
  props.name = 'props';
  props.castShadow = true;
  props.receiveShadow = true;
  {
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const scale = new THREE.Vector3();
    for (let i = 0; i < PROPS; i++) {
      const side = random.bool() ? 1 : -1;
      const z = 8 - random.next() * 430;
      const height = 1.2 + random.next() * 3.4;
      position.set(
        side * (streetHalfWidth - 1.5 - random.next() * 4),
        height * 0.5,
        z
      );
      euler.set(0, random.next() * Math.PI * 2, 0);
      quaternion.setFromEuler(euler);
      scale.set(0.7 + random.next() * 1.6, height, 0.7 + random.next() * 1.6);
      matrix.compose(position, quaternion, scale);
      props.setMatrixAt(i, matrix);
    }
    props.instanceMatrix.needsUpdate = true;
  }
  applyInstanceVariation(props, () => random.next(), {
    baseColor: 0xffffff,
    tintRange: [0.6, 1.15],
    wearRange: [0.1, 0.95],
    hueJitter: 0.04,
  });
  scene.add(props);

  // Signage: something above the bloom threshold, so the tier's bloom is
  // demonstrably running while the VFX are measured against it.
  for (let i = 0; i < 10; i++) {
    const sign = new THREE.Mesh(new THREE.BoxGeometry(0.5, 5.5, 2.4), signMaterial);
    sign.position.set(
      (i % 2 === 0 ? -1 : 1) * (streetHalfWidth + 0.4),
      8 + random.next() * 12,
      -20 - i * 38
    );
    scene.add(sign);
  }

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

  /* -------------------------------- VFX --------------------------------- */

  setStatus('generating VFX atlases');
  const vfx = new VFXSystem({
    tier,
    quality: profile.settings,
    bus,
    camera,
    seed: 'saitama.vfx.harness',
    cloudAltitude: 210,
  });
  // The multipliers put the dust in the same exposure bracket as the concrete
  // it is blowing off. Dust is translucent, so it takes a little under half the
  // scene's direct sun and a little over half its ambient.
  vfx.setSun(lighting.sunDirection, 0xfff2e2, 0x93aed0, 1.5, 0.62);
  vfx.setFog(lighting.fogColor.getHex(), lighting.fogDensity);
  vfx.setViewport(window.innerWidth, window.innerHeight);
  scene.add(vfx.root);
  vfx.root.visible = false;

  /* ------------------------------ warmup -------------------------------- */

  setStatus('compiling shaders');
  const composerTier = profile.post.mode !== 'off';
  const warmup = new ShaderWarmup(renderer.raw, scene, {
    size: 4,
    includeOffscreen: composerTier,
    includeDirectFramebuffer: !composerTier,
    warmShadows: true,
  });
  warmup.add(roadMaterial, ['static']);
  warmup.add(buildingMaterial, ['static']);
  warmup.add(propMaterial, ['instanced']);
  warmup.add(signMaterial, ['static']);
  warmup.run();
  post.warmup();
  warmup.dispose();

  /* ----------------------------- impact feel ---------------------------- */

  const impact = new ImpactFreeze(clock, camera, bus, {
    onImpact: (intensity) => post.triggerImpact(intensity),
  });

  /* ------------------------------ camera -------------------------------- */

  const CAMERAS: Record<CameraPreset, { eye: THREE.Vector3; target: THREE.Vector3; fov: number }> =
    {
      // Down the street from behind the punch: the default composition.
      street: {
        eye: new THREE.Vector3(6, 16, 98),
        target: new THREE.Vector3(-2, 12, -140),
        fov: 52,
      },
      // Close, low and three-quarter. The shot the freeze holds on.
      hero: {
        eye: new THREE.Vector3(34, 7.5, 52),
        target: new THREE.Vector3(-8, 11, -78),
        fov: 56,
      },
      // Elevated three-quarter, ~75 m out. Far enough that a 130-metre wave
      // fits, close enough that the buildings still tower.
      punch: {
        eye: new THREE.Vector3(62, 26, 72),
        target: new THREE.Vector3(-8, 15, -86),
        fov: 52,
      },
      // High and back, so a 180-metre cone fits the frame with the city.
      wide: {
        eye: new THREE.Vector3(120, 82, 175),
        target: new THREE.Vector3(-10, 20, -150),
        fov: 50,
      },
      // Looking up, for cloud parting.
      sky: {
        eye: new THREE.Vector3(34, 3, 74),
        target: new THREE.Vector3(0, 190, -80),
        fov: 66,
      },
      // Street level, right in the path.
      ground: {
        eye: new THREE.Vector3(6, 2.1, 46),
        target: new THREE.Vector3(-1, 5, -70),
        fov: 62,
      },
    };

  let cameraPreset: CameraPreset = 'street';
  function applyCamera(preset: CameraPreset): void {
    const entry = CAMERAS[preset];
    cameraPreset = preset;
    camera.position.copy(entry.eye);
    camera.lookAt(entry.target);
    camera.fov = entry.fov;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    shadows.onCameraChanged();
  }
  applyCamera('street');

  /* ----------------------------- scenarios ------------------------------ */

  const PUNCH_ORIGIN = { x: 0, y: 2.2, z: 18 };
  const PUNCH_DIRECTION = { x: -0.03, y: 0.04, z: -1 };
  let scenario = 'none';

  function fire(next: VFXScenario): void {
    scenario = next;
    switch (next) {
      case 'shockwaveCone':
        bus.emit('ShockwaveFired', {
          origin: PUNCH_ORIGIN,
          direction: PUNCH_DIRECTION,
          power: 4e4,
          range: 130,
          // The combat cone: ~22 degrees of half-angle.
          angle: 0.384,
          intent: 'serious',
          punchKind: 'normal',
        });
        break;

      case 'shockwaveRing':
        bus.emit('ShockwaveFired', {
          origin: PUNCH_ORIGIN,
          direction: { x: 0, y: 1, z: 0 },
          power: 2e5,
          range: 110,
          angle: Math.PI,
          intent: 'serious',
          punchKind: 'consecutive',
        });
        break;

      case 'dustPlume':
        // Three staggered plumes, as a collapsing facade would produce.
        for (let i = 0; i < 3; i++) {
          vfx.spawn('dustCloud', {
            position: new THREE.Vector3(-9 + i * 10, 1.4, 6 - i * 20),
            intensity: 0.9,
            scale: 7 + i * 2,
            priority: 0.9,
          });
        }
        break;

      case 'speedlines':
        vfx.speedlines.setFocus(0.05, -0.05);
        vfx.speedlines.setSustained(0.85);
        vfx.speedlines.burst(1, 0.35);
        break;

      case 'debrisTrails':
        for (let i = 0; i < 26; i++) {
          const angle = (i / 26) * Math.PI * 2;
          bus.emit('ChunkDetached', {
            structureId: 'facade',
            chunkIndex: i,
            position: { x: Math.cos(angle) * 6, y: 16 + (i % 5) * 4, z: -34 + Math.sin(angle) * 6 },
            mass: 260 + i * 40,
            impulse: {
              x: Math.cos(angle) * 9000,
              y: 5200 + i * 130,
              z: Math.sin(angle) * 9000 - 5000,
            },
            material: 'concrete',
            collateralCost: 12,
          });
        }
        break;

      case 'groundCracks':
        bus.emit('PlayerLanded', {
          position: { x: 0, y: 0, z: -22 },
          impactSpeed: 62,
          fallHeight: 190,
          createsCrater: true,
          intent: 'full',
        });
        break;

      case 'cloudParting':
      case 'seriousPunch':
        bus.emit('ShockwaveFired', {
          origin: PUNCH_ORIGIN,
          direction: PUNCH_DIRECTION,
          power: 1e6,
          range: 180,
          angle: 0.384,
          intent: 'full',
          punchKind: 'serious',
        });
        if (next === 'seriousPunch') {
          bus.emit('EntityKilled', {
            entityId: 1 as never,
            entityType: 'monster',
            faction: 'monster',
            position: { x: 0, y: 3.2, z: -12 },
            threatTier: 'dragon',
            intent: 'full',
            rewardPoints: 900,
          });
          for (let i = 0; i < 30; i++) {
            const angle = (i / 30) * Math.PI * 2;
            bus.emit('ChunkDetached', {
              structureId: 'facade',
              chunkIndex: i,
              position: {
                x: Math.cos(angle) * 14 + (i % 3) * 4,
                y: 8 + (i % 7) * 6,
                z: -26 - (i % 5) * 12,
              },
              mass: 300 + i * 55,
              impulse: {
                x: Math.cos(angle) * 11000,
                y: 6500 + i * 190,
                z: -9000 - i * 240,
              },
              material: 'concrete',
              collateralCost: 25,
            });
          }
        }
        break;

      case 'impactFlash':
        bus.emit('EntityKilled', {
          entityId: 2 as never,
          entityType: 'monster',
          faction: 'monster',
          position: { x: 0, y: 3.4, z: -14 },
          threatTier: 'demon',
          intent: 'full',
          rewardPoints: 400,
        });
        break;
    }
  }

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
    build: 'vfx-harness',
    errors: consoleErrors,
  };
  window.__GAME_DIAG__ = diagnostics;

  let presentedFrames = 0;
  let simSeconds = 0;
  let stepping = true;
  const frameWaiters: { target: number; resolve: () => void }[] = [];

  const budget: IBudgetReport = {
    baselinePrograms: 0,
    totalPrograms: 0,
    vfxPrograms: 0,
    baselineDrawCalls: 0,
    totalDrawCalls: 0,
    vfxDrawCalls: 0,
    vfxTriangles: 0,
    programKeys: [],
  };

  function stepSimulation(dt: number): void {
    simSeconds += dt;
    bus.setFrame(presentedFrames, simSeconds);
    // Impact freeze runs on REAL time; the sim step it scales is the fixed
    // delta below, so the freeze reads exactly as it would in the game.
    impact.update(FIXED_DT);
    vfx.update(dt * clock.timeScale);
  }

  function renderFrame(): void {
    shadows.applyLightingState(lighting);
    shadows.update();
    renderer.render(scene, camera);
    presentedFrames++;
    const stats = renderer.getStats();
    diagnostics.drawCalls = stats.drawCalls;
    diagnostics.triangles = stats.triangles;
    diagnostics.frameCount = presentedFrames;
  }

  function tick(): void {
    requestAnimationFrame(tick);
    clock.tick();
    if (stepping) stepSimulation(FIXED_DT);
    renderFrame();
    if (overlayElement && !overlayElement.classList.contains('hidden')) {
      const d = vfx.diagnostics();
      overlayElement.textContent =
        `tier ${tier}  scenario ${scenario}  cam ${cameraPreset}\n` +
        `t ${simSeconds.toFixed(2)}s  frame ${presentedFrames}\n` +
        `draws ${diagnostics.drawCalls} (vfx ${budget.vfxDrawCalls})  ` +
        `programs ${renderer.programCount} (vfx ${budget.vfxPrograms})\n` +
        `sprites ${d.sprites}/${d.spriteCapacity}  shells ${d.shockwaves}  ` +
        `decals ${d.decals}  trails ${d.trails}\n` +
        `speedlines ${d.speedlineIntensity.toFixed(2)}  trauma ${d.trauma.toFixed(2)}`;
    }
    for (let i = frameWaiters.length - 1; i >= 0; i--) {
      if (presentedFrames >= frameWaiters[i]!.target) {
        frameWaiters[i]!.resolve();
        frameWaiters.splice(i, 1);
      }
    }
  }

  function waitFrames(count: number): Promise<void> {
    if (count <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      frameWaiters.push({ target: presentedFrames + count, resolve });
    });
  }

  window.addEventListener(
    'resize',
    () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      camera.aspect = width / Math.max(1, height);
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      post.setSize(renderer.width, renderer.height);
      vfx.setViewport(width, height);
      shadows.onCameraChanged();
    },
    { passive: true }
  );

  /* --------------------------- budget measurement ----------------------- */

  async function measureBudget(): Promise<IBudgetReport> {
    const wasVisible = vfx.root.visible;
    const wasStepping = stepping;
    stepping = false;

    vfx.root.visible = false;
    await waitFrames(2);
    budget.baselinePrograms = renderer.programCount;
    budget.baselineDrawCalls = renderer.getStats().drawCalls;

    vfx.root.visible = true;
    await waitFrames(2);
    budget.totalPrograms = renderer.programCount;
    budget.totalDrawCalls = renderer.getStats().drawCalls;
    budget.vfxPrograms = budget.totalPrograms - budget.baselinePrograms;
    budget.vfxDrawCalls = budget.totalDrawCalls - budget.baselineDrawCalls;
    budget.programKeys = renderer.getProgramCacheKeys();

    // Triangles the VFX add, measured the same way.
    const withVfxTriangles = renderer.getStats().triangles;
    vfx.root.visible = false;
    await waitFrames(2);
    budget.vfxTriangles = withVfxTriangles - renderer.getStats().triangles;

    vfx.root.visible = wasVisible;
    stepping = wasStepping;
    await waitFrames(1);
    return budget;
  }

  /* ------------------------ allocation measurement ---------------------- */

  async function measureAllocation(frames: number): Promise<IAllocationReport> {
    const supported = heapBytes() > 0;
    const wasStepping = stepping;
    stepping = false;
    // Let the effect reach a steady state with hundreds of live particles.
    await waitFrames(2);

    window.gc?.();
    await waitFrames(1);
    window.gc?.();

    const spritesDuringSample = vfx.diagnostics().sprites;

    // 1. Simulation only. No rendering, no three.js in the way: this measures
    //    THIS workstream's per-frame allocation and nothing else.
    const simBefore = heapBytes();
    for (let i = 0; i < frames; i++) vfx.update(FIXED_DT);
    const simAfter = heapBytes();

    // 2. Full frames, reported for context. three's own renderer allocates a
    //    little every frame and that is not this system's to fix.
    window.gc?.();
    await waitFrames(1);
    const frameBefore = heapBytes();
    stepping = true;
    await waitFrames(frames);
    stepping = false;
    const frameAfter = heapBytes();

    stepping = wasStepping;
    return {
      supported,
      frames,
      simBytes: simAfter - simBefore,
      simBytesPerFrame: (simAfter - simBefore) / frames,
      frameBytes: frameAfter - frameBefore,
      frameBytesPerFrame: (frameAfter - frameBefore) / frames,
      spritesDuringSample,
      heapBefore: simBefore,
      heapAfter: simAfter,
    };
  }

  /* --------------------------- control surface -------------------------- */

  window.__VFX_HARNESS__ = {
    snapshot(): IVFXHarnessSnapshot {
      const stats = renderer.getStats();
      const impactState = impact.getState();
      return {
        tier,
        isWebGL2: renderer.getCapabilities().isWebGL2,
        rendererString: renderer.getCapabilities().renderer,
        drawCalls: stats.drawCalls,
        triangles: stats.triangles,
        programs: renderer.programCount,
        programKeys: renderer.getProgramCacheKeys(),
        presentedFrames,
        simSeconds,
        scenario,
        cameraPreset,
        vfx: vfx.diagnostics(),
        budget,
        post: {
          mode: profile.post.mode,
          direct: profile.post.mode === 'off',
          passNames: post.passNames ? [...post.passNames] : [],
        },
        atlasBytes: Math.round(
          (vfx.profile.atlasSize * vfx.profile.atlasSize +
            vfx.profile.crackAtlasSize * vfx.profile.crackAtlasSize) *
            4 *
            (4 / 3)
        ),
        clock: { timeScale: clock.timeScale },
        impact: {
          active: impactState.active,
          phase: impactState.phase,
          fovOffset: impactState.fovOffset,
        },
        consoleErrors,
      };
    },

    reset(): void {
      vfx.clear();
      vfx.speedlines.setSustained(0);
      impact.cancel();
      clock.timeScale = 1;
      simSeconds = 0;
      scenario = 'none';
      vfx.root.visible = true;
    },

    fire,
    setCamera: applyCamera,

    async advance(frames: number): Promise<void> {
      stepping = true;
      await waitFrames(frames);
      stepping = false;
    },

    async hold(frames: number): Promise<void> {
      stepping = false;
      await waitFrames(frames);
    },

    setVFXVisible(visible: boolean): void {
      vfx.root.visible = visible;
    },

    setOverlayVisible(visible: boolean): void {
      overlayElement?.classList.toggle('hidden', !visible);
    },

    measureBudget,
    measureAllocation,

    freeze(): void {
      impact.trigger(1);
    },

    isFrozen(): boolean {
      return impact.isActive;
    },
  };

  /* ------------------------------- prime -------------------------------- */

  // One rendered frame with the VFX hidden establishes the baseline program
  // count; one with them visible and populated compiles their three programs
  // through the tier's real destination. Doing this DURING loading is exactly
  // what the game must do — a first punch that compiles three programs on the
  // main thread is a visible hitch on Android.
  setStatus('warming VFX programs');
  requestAnimationFrame(tick);

  void (async (): Promise<void> => {
    try {
      stepping = false;
      await waitFrames(2);
      budget.baselinePrograms = renderer.programCount;

      vfx.root.visible = true;
      fire('seriousPunch');
      vfx.speedlines.setSustained(1);
      stepping = true;
      await waitFrames(3);
      stepping = false;
      budget.totalPrograms = renderer.programCount;
      budget.vfxPrograms = budget.totalPrograms - budget.baselinePrograms;
      budget.programKeys = renderer.getProgramCacheKeys();

      vfx.clear();
      vfx.speedlines.setSustained(0);
      impact.cancel();
      clock.timeScale = 1;
      simSeconds = 0;
      scenario = 'none';
      await waitFrames(2);

      statusElement?.classList.add('hidden');
      window.__GAME_READY__ = true;
    } catch (error) {
      fatal('VFX harness priming failed', error);
    }
  })();
}

try {
  main();
} catch (error) {
  fatal('VFX harness failed to start', error);
}
