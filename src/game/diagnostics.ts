/**
 * THE DIAGNOSTICS CONTRACT
 *
 * `window.__GAME_READY__` and `window.__GAME_DIAG__` are the only two globals
 * this game promises. The verification harness reads them, so their SEMANTICS
 * are frozen even though everything around them was replaced:
 *
 *   __GAME_READY__  flips to true once a real frame has presented — not when
 *                   the bundle parsed, not when the loop started.
 *   __GAME_DIAG__   live, mutated in place, never reassigned after boot so a
 *                   harness that captured the object keeps seeing fresh values.
 *
 * `IGameDiagnostics` (src/types/engine.ts) is the frozen part. Everything the
 * integration adds hangs off `systems`, `world` and `timings`, which are
 * additive: a harness written against the old shape still passes.
 */

import type { IGameDiagnostics, IQualityTier, QualityTier } from '@/types';

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

/** CPU milliseconds spent in each phase of the last frame. Never GPU time. */
export interface IFrameTimings {
  /** Input poll. */
  input: number;
  /** Every gameplay system's `update`. */
  simulation: number;
  /** Rapier stepping plus debris and ragdolls. */
  physics: number;
  /** Player post-step, camera rig, shake, culling. */
  camera: number;
  /** City chunk generation and upload. */
  streaming: number;
  /** `renderer.render()`, CPU side only. */
  render: number;
  /** HUD DOM writes. */
  hud: number;
  /** Sum of the above. */
  total: number;
}

/** Per-phase milliseconds of the boot sequence. */
export interface IBootTimings {
  probe: number;
  renderer: number;
  assets: number;
  physics: number;
  /** HDRI load plus the first radiance build. The most expensive single step. */
  sky: number;
  /** Instanced crowd bodies and their animation bake. */
  crowd: number;
  /** City chunk generation and upload for the boot ring. */
  world: number;
  systems: number;
  warmup: number;
  firstFrame: number;
}

/** Which systems actually came up, and what they are doing. */
export interface ISystemDiagnostics {
  /** Systems that constructed and are ticking. */
  online: string[];
  /** Systems deliberately not composed, with the reason. */
  skipped: Record<string, string>;
  /** Systems that threw during boot and were degraded past. */
  failed: Record<string, string>;
}

/** Live world state, sampled every frame. */
export interface IWorldDiagnostics {
  /** Asset tier actually in use, after clamping. */
  assetTier: QualityTier;
  /** Tier the heuristics asked for before clamping. */
  assetTierRequested: QualityTier;
  assetTierReason: string;
  /** Per-asset tier demotions recorded by `TierAvailability`. */
  assetTierMisses: number;
  /** Tiers written off wholesale after repeated misses. */
  assetTiersUnavailable: string[];
  /** Manifest ids that resolved to a marked fallback. */
  assetsMissing: number;
  /** Native/Capacitor shell detected. */
  isNative: boolean;
  platform: string;

  chunkIndex: number;
  residentChunks: number;
  pendingChunks: number;
  registeredStructures: number;
  chunksDetached: number;
  debrisLive: number;

  /** Distant buildings in the impostor ring. Constant for the session. */
  impostorBuildings: number;
  impostorTriangles: number;
  /** Milliseconds the skyline bake cost at BOOT. Never a frame cost. */
  impostorBakeMs: number;
  /** Main-thread milliseconds spent uploading it. Also a boot cost. */
  impostorUploadMs: number;
  /**
   * Silhouettes that did not match the building generated in their place.
   * Must be 0 — see `bakeSkyline` in `city-streamer.ts`.
   */
  impostorDrift: number;

  monsters: number;
  civilians: number;
  civiliansLost: number;
  civiliansSaved: number;
  allies: number;
  alliesDown: number;
  /** Progression's witness field size — the single source of truth for saves. */
  witnesses: number;

  playerPosition: { x: number; y: number; z: number };
  playerState: string;
  timeOfDay: number;
  dayPhase: string;
  /** ACES exposure the output pass is running at. */
  exposure: number;
  sunIntensity: number;
  ambientIntensity: number;
  envMapIntensity: number;
  rank: string;
  boredom: number;

  physicsBodies: number;
  vfxEffects: number;
  shaderPrograms: number;
  resolutionScale: number;
  timeScale: number;

  /**
   * Baked character atlases: milliseconds spent loading, how many are resident
   * and what they cost on the GPU.
   *
   * `rosterLoadMs` is reported on its own because it is the only thing the
   * character pipeline adds to the boot path. A boot TOTAL measured while
   * something else is using the machine cannot be differenced against a
   * baseline measured on a quiet one; this number can.
   */
  rosterLoadMs: number;
  rosterResident: number;
  rosterBytes: number;
}

/** The full object published on `window.__GAME_DIAG__`. */
export interface IIntegrationDiagnostics extends IGameDiagnostics {
  /** Milliseconds from navigation start to the first presented frame. */
  readonly bootTimeMs: number;
  boot: IBootTimings;
  timings: IFrameTimings;
  systems: ISystemDiagnostics;
  world: IWorldDiagnostics;
}

/* -------------------------------------------------------------------------- */
/* Construction                                                               */
/* -------------------------------------------------------------------------- */

function zeroFrameTimings(): IFrameTimings {
  return {
    input: 0,
    simulation: 0,
    physics: 0,
    camera: 0,
    streaming: 0,
    render: 0,
    hud: 0,
    total: 0,
  };
}

function zeroBootTimings(): IBootTimings {
  return {
    probe: 0,
    renderer: 0,
    assets: 0,
    physics: 0,
    sky: 0,
    crowd: 0,
    world: 0,
    systems: 0,
    warmup: 0,
    firstFrame: 0,
  };
}

/**
 * Build the diagnostics object and publish it immediately.
 *
 * Published BEFORE anything can fail, so a boot that dies in the renderer still
 * leaves a readable `errors` array behind instead of an undefined global.
 */
export function createDiagnostics(quality: IQualityTier, build: string): IIntegrationDiagnostics {
  const diagnostics: IIntegrationDiagnostics = {
    renderer: 'unknown',
    vendor: 'unknown',
    isWebGL2: false,
    maxTextureSize: 0,
    maxAnisotropy: 0,
    compressedFormats: [],
    drawCalls: 0,
    triangles: 0,
    fps: 0,
    frameCount: 0,
    quality,
    bootTimeMs: 0,
    build,
    errors: [],
    boot: zeroBootTimings(),
    timings: zeroFrameTimings(),
    systems: { online: [], skipped: {}, failed: {} },
    world: {
      assetTier: 'mobile',
      assetTierRequested: 'mobile',
      assetTierReason: 'not selected yet',
      assetTierMisses: 0,
      assetTiersUnavailable: [],
      assetsMissing: 0,
      isNative: false,
      platform: 'unknown',
      chunkIndex: -1,
      residentChunks: 0,
      pendingChunks: 0,
      registeredStructures: 0,
      chunksDetached: 0,
      debrisLive: 0,
      impostorBuildings: 0,
      impostorTriangles: 0,
      impostorBakeMs: 0,
      impostorUploadMs: 0,
      impostorDrift: 0,
      monsters: 0,
      civilians: 0,
      civiliansLost: 0,
      civiliansSaved: 0,
      allies: 0,
      alliesDown: 0,
      witnesses: 0,
      playerPosition: { x: 0, y: 0, z: 0 },
      playerState: 'none',
      timeOfDay: 0,
      dayPhase: 'unknown',
      exposure: 1,
      sunIntensity: 0,
      ambientIntensity: 0,
      envMapIntensity: 1,
      rank: '-',
      boredom: 0,
      physicsBodies: 0,
      vfxEffects: 0,
      shaderPrograms: 0,
      resolutionScale: 1,
      timeScale: 1,
      rosterLoadMs: 0,
      rosterResident: 0,
      rosterBytes: 0,
    },
  };
  window.__GAME_DIAG__ = diagnostics;
  return diagnostics;
}

/** Record a non-fatal problem. Always visible to the harness, never thrown. */
export function recordError(
  diagnostics: IIntegrationDiagnostics,
  scope: string,
  error: unknown
): void {
  const detail = error instanceof Error ? `${error.message}` : String(error);
  (diagnostics.errors ??= []).push(`${scope}: ${detail}`);
  diagnostics.systems.failed[scope] = detail;
}
