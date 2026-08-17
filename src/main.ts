/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  TEMPORARY BOOTSTRAP — NOT THE GAME                                      ║
 * ║                                                                          ║
 * ║  This file exists ONLY to prove the toolchain works end to end:          ║
 * ║  Vite build -> Three.js -> WebGL2 context -> PBR frame on screen.        ║
 * ║                                                                          ║
 * ║  The real renderer, scene graph and game loop are owned by the engine    ║
 * ║  workstream and will REPLACE this file wholesale. Do not build features  ║
 * ║  on top of it, and do not import from it.                                ║
 * ║                                                                          ║
 * ║  The one part that MUST survive replacement is the diagnostics contract  ║
 * ║  at the bottom: `window.__GAME_READY__` and `window.__GAME_DIAG__`, which ║
 * ║  the automated verification harness depends on. Keep those semantics.    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import * as THREE from 'three';
import type { IGameDiagnostics, IQualityTier } from '@/types';
import { clamp, createLogger, NumericRingBuffer } from '@/util';

const log = createLogger('bootstrap');

/* -------------------------------------------------------------------------- */
/* Boot screen helpers                                                        */
/* -------------------------------------------------------------------------- */

const bootScreen = document.getElementById('boot-screen');
const bootStatus = document.getElementById('boot-status');
const bootBarFill = document.getElementById('boot-bar-fill');
const bootError = document.getElementById('boot-error');

function setStatus(text: string, progress: number): void {
  if (bootStatus) bootStatus.textContent = text;
  if (bootBarFill) bootBarFill.style.width = `${clamp(progress, 0, 1) * 100}%`;
}

function fail(message: string, error: unknown): void {
  log.error(message, error);
  const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
  if (bootStatus) bootStatus.textContent = 'Failed to start';
  if (bootError) {
    bootError.style.display = 'block';
    bootError.textContent = `${message}\n\n${detail}`;
  }
  const diag = window.__GAME_DIAG__;
  if (diag) (diag.errors ??= []).push(`${message}: ${detail}`);
}

/* -------------------------------------------------------------------------- */
/* GPU capability probing                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Map GL compressed-texture extensions onto the codec names the asset
 * pipeline uses. Probed from the live context rather than sniffing the user
 * agent, which is unreliable across Android WebView builds.
 */
function detectCompressedFormats(gl: WebGL2RenderingContext | WebGLRenderingContext): string[] {
  const probes: readonly [string, string][] = [
    ['WEBGL_compressed_texture_astc', 'astc'],
    ['WEBGL_compressed_texture_etc', 'etc2'],
    ['WEBGL_compressed_texture_etc1', 'etc1'],
    ['WEBGL_compressed_texture_s3tc', 's3tc'],
    ['WEBGL_compressed_texture_s3tc_srgb', 's3tc_srgb'],
    ['WEBGL_compressed_texture_pvrtc', 'pvrtc'],
    ['EXT_texture_compression_bptc', 'bc7'],
    ['EXT_texture_compression_rgtc', 'rgtc'],
  ];
  const found: string[] = [];
  for (const [extension, codec] of probes) {
    if (gl.getExtension(extension)) found.push(codec);
  }
  return found;
}

/** Pick a starting quality tier from coarse device signals. */
function detectQualityTier(): IQualityTier {
  const cores = navigator.hardwareConcurrency ?? 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (!isMobile && cores >= 8) return 'high';
  if (cores >= 8 && memory >= 6) return 'high';
  if (cores >= 4 && memory >= 3) return 'medium';
  return 'low';
}

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

function boot(): void {
  setStatus('Creating renderer', 0.1);

  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('#game-canvas not found in index.html');

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    // Required so the verification harness can read pixels back reliably.
    preserveDrawingBuffer: true,
  });

  const quality = detectQualityTier();
  // Cap DPR: rendering at a phone's native 3x ratio is the single fastest way
  // to become fragment-bound on mobile for no visible gain.
  const maxPixelRatio = quality === 'high' ? 2 : quality === 'medium' ? 1.5 : 1;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  // Correct colour pipeline: linear working space, sRGB output, ACES filmic.
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = quality !== 'low';
  // PCFSoftShadowMap is deprecated in r185: WebGLShadowMap.render() silently
  // rewrites it to PCFShadowMap on the first shadow render, which happens after
  // materials have already compiled against the old type — so every material
  // recompiles. Set the real type up front.
  renderer.shadowMap.type = THREE.PCFShadowMap;

  setStatus('Building scene', 0.35);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0d14);
  scene.fog = new THREE.Fog(0x0a0d14, 12, 42);

  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 200);
  camera.position.set(0, 2.4, 6.5);
  camera.lookAt(0, 0.8, 0);

  // --- Lighting: key + rim + hemisphere bounce -----------------------------
  const hemi = new THREE.HemisphereLight(0x93b8ff, 0x241a12, 0.55);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xfff2d8, 3.2);
  key.position.set(5, 8, 4);
  key.castShadow = renderer.shadowMap.enabled;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 40;
  key.shadow.bias = -0.0015;
  scene.add(key);

  const rim = new THREE.DirectionalLight(0xffc857, 1.6);
  rim.position.set(-6, 3, -5);
  scene.add(rim);

  // --- Geometry ------------------------------------------------------------
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(14, 64),
    new THREE.MeshStandardMaterial({ color: 0x14181f, roughness: 0.95, metalness: 0.0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = renderer.shadowMap.enabled;
  scene.add(ground);

  // Rotating PBR object — exercises the standard material, shadows and
  // tone mapping in one draw.
  const hero = new THREE.Mesh(
    new THREE.TorusKnotGeometry(1.05, 0.34, 180, 32),
    new THREE.MeshStandardMaterial({
      color: 0xffd230,
      roughness: 0.22,
      metalness: 0.85,
    })
  );
  hero.position.set(0, 1.7, 0);
  hero.castShadow = renderer.shadowMap.enabled;
  scene.add(hero);

  const companion = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.42, 0),
    new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.4, metalness: 0.1 })
  );
  companion.castShadow = renderer.shadowMap.enabled;
  scene.add(companion);

  setStatus('Probing GPU', 0.6);

  // --- Diagnostics ---------------------------------------------------------
  const gl = renderer.getContext();
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const rendererString = debugInfo
    ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))
    : 'unknown';
  const vendorString = debugInfo
    ? String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL))
    : 'unknown';

  const diagnostics: IGameDiagnostics = {
    renderer: rendererString,
    vendor: vendorString,
    isWebGL2: renderer.capabilities.isWebGL2 ?? typeof WebGL2RenderingContext !== 'undefined',
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
    compressedFormats: detectCompressedFormats(gl),
    drawCalls: 0,
    triangles: 0,
    fps: 0,
    frameCount: 0,
    quality,
    bootTimeMs: 0,
    build: import.meta.env?.MODE ?? 'unknown',
    errors: [],
  };
  window.__GAME_DIAG__ = diagnostics;

  log.info('GPU', rendererString, '| WebGL2:', diagnostics.isWebGL2);
  log.info('compressed formats:', diagnostics.compressedFormats.join(', ') || 'none');

  // --- Resize --------------------------------------------------------------
  function onResize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPixelRatio));
    renderer.setSize(width, height, false);
  }
  window.addEventListener('resize', onResize, { passive: true });
  window.addEventListener('orientationchange', onResize, { passive: true });

  // --- Loop ----------------------------------------------------------------
  setStatus('Starting', 0.85);

  const clock = new THREE.Clock();
  const frameTimes = new NumericRingBuffer(120);
  let frameCount = 0;
  let ready = false;

  function tick(): void {
    requestAnimationFrame(tick);

    const dt = Math.min(clock.getDelta(), 1 / 15);
    const elapsed = clock.elapsedTime;

    hero.rotation.x += dt * 0.45;
    hero.rotation.y += dt * 0.62;

    companion.position.set(
      Math.cos(elapsed * 0.9) * 3.1,
      1.0 + Math.sin(elapsed * 1.7) * 0.35,
      Math.sin(elapsed * 0.9) * 3.1
    );

    renderer.render(scene, camera);

    frameCount++;
    if (dt > 0) frameTimes.push(dt * 1000);

    diagnostics.drawCalls = renderer.info.render.calls;
    diagnostics.triangles = renderer.info.render.triangles;
    diagnostics.frameCount = frameCount;
    const avgMs = frameTimes.average;
    diagnostics.fps = avgMs > 0 ? Math.round(1000 / avgMs) : 0;

    // Flip READY only after a frame has actually presented, so the harness
    // never screenshots an empty canvas.
    if (!ready && frameCount >= 2) {
      ready = true;
      diagnostics.bootTimeMs = Math.round(performance.now());
      window.__GAME_READY__ = true;
      setStatus('Ready', 1);
      bootScreen?.classList.add('hidden');
      log.info(`ready in ${diagnostics.bootTimeMs}ms — ${diagnostics.drawCalls} draw calls`);
    }
  }

  tick();
}

try {
  boot();
} catch (error) {
  fail('Bootstrap failed', error);
}
