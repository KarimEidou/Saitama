/**
 * CHUNK STREAMING HARNESS
 *
 * Puts `src/world/streaming/**` under the only conditions that can falsify it:
 * a real WebGL2 context, real Web Workers, real transferable buffers, and a
 * camera crossing 1500 m of city fast enough that the streamer never gets to
 * rest.
 *
 * ── WHAT IS ACTUALLY BEING MEASURED ────────────────────────────────────────
 * Main-thread milliseconds spent uploading chunks, and the number of uploads
 * per frame. Both come from `performance.now()` brackets around the work
 * itself, and both are real regardless of what renders the pixels.
 *
 * FRAME RATE IS NOT REPORTED, ANYWHERE. The verification runs under
 * SwiftShader, a CPU rasteriser; an fps number from it measures the software
 * renderer's fill rate and says nothing about whether streaming hitches on a
 * phone. Upload time, upload count, chunk counts, ring transitions and heap
 * are all independent of how the frame is rasterised, so those are the numbers
 * this harness produces.
 *
 * ── FORCING THE UPLOAD TO HAPPEN WHEN WE SAY ───────────────────────────────
 * WebGL defers `bufferData` to a geometry's first draw. Left alone, a chunk
 * created in frame N pays its driver cost in frame N+1 or later, where it is
 * real but unattributable — precisely the hitch this system exists to prevent
 * and precisely the one a naive measurement would miss. So the harness passes
 * a `gpuUpload` hook that renders the new chunk alone into a one-pixel scissor
 * rect inside the measured bracket. That is a prewarm draw, which is what a
 * real frame would do anyway, so the number it produces is the number a player
 * would feel.
 *
 * ── THE PVS IS REAL TOO ────────────────────────────────────────────────────
 * The cached visibility table from `src/spatial/` is built from the same
 * building footprints the streamer generates, and both of the spatial index's
 * handoffs are wired: `isChunkPotentiallyVisible` into load prioritisation and
 * `visibleChunks` into the eviction ordering.
 */

import * as THREE from 'three';
import { EventBus } from '@/util';
import {
  CHUNK_COORD_MAX,
  CHUNK_COORD_MIN,
  CHUNK_GRID,
  CHUNK_SIZE,
  CHUNK_COUNT,
  WORLD_MIN,
  WORLD_SIZE,
  chunkCentreX,
  chunkCentreZ,
  chunkIndex,
  chunkIndexToX,
  chunkIndexToZ,
} from '@/spatial/constants';
import { SpatialIndex } from '@/spatial/spatial-index';
import { buildPvs, type IFootprint } from '@/spatial/pvs';
import {
  StreamingSystem,
  ChunkDamageState,
  buildChunkGeometry,
  layoutChunk,
  MAX_UPLOADS_PER_FRAME,
  UPLOAD_BUDGET_MS,
  RING_R0,
  RING_R1,
  RING_R2,
  RING_R3,
  type IColliderSink,
  type ICrowdSink,
  type ColliderMode,
  type CrowdMode,
  type IColliderBox,
  type ICrowdSlot,
} from '@/world/streaming';

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

const SEED = 0x0c17972;

/** Fixed simulation step, so the flight is identical on any machine. */
const FIXED_DT = 1 / 60;

/** Flight speed in metres per second. Fast: a bored hero covers ground. */
const FLIGHT_SPEED = 150;

/** Drone-camera height, high enough to see the ring structure at once. */
const EYE_HEIGHT = 46;

/** The 1500 m district traverse the verification flies. */
const PATH_START = new THREE.Vector3(-700, EYE_HEIGHT, -300);
const PATH_END = new THREE.Vector3(700, EYE_HEIGHT, 300);
const PATH_LENGTH = PATH_START.distanceTo(PATH_END);

/**
 * Drawing-buffer size during the timed laps.
 *
 * Small on purpose. The laps run under SwiftShader, which rasterises on the
 * CPU, so a full-size buffer would spend the whole run measuring the software
 * renderer's fill rate. Nothing being measured — geometry upload, buffer
 * creation, teardown, priority — depends on the viewport, and the pipeline is
 * still exercised end to end at this size. The final screenshot is taken at
 * full size.
 */
const LAP_RESOLUTION = { width: 400, height: 260 };

/** Reach of the view cone drawn on the minimap, in metres: R2's outer edge. */
const RING_OUTER_METRES = 768;

/* -------------------------------------------------------------------------- */
/* Types exposed to Playwright                                                */
/* -------------------------------------------------------------------------- */

interface ILapReport {
  readonly lap: number;
  readonly frames: number;
  readonly uploads: number;
  readonly evictions: number;
  readonly maxUploadsPerFrame: number;
  readonly maxUploadMs: number;
  readonly p95UploadMs: number;
  readonly meanUploadMs: number;
  readonly maxChunkUploadMs: number;
  readonly framesOver4ms: number;
  readonly framesOver50ms: number;
  readonly maxUnloadMs: number;
  readonly ringTransitions: number;
  /** Heap in bytes after the lap settled, or 0 where unavailable. */
  readonly heapBytes: number;
  readonly residentChunks: number;
  readonly residentBytes: number;
  readonly geometries: number;
}

/** Ahead-vs-behind arrival comparison for one band of equal distance. */
interface IPriorityBand {
  /** Chebyshev distance from the cold-start camera, in whole chunks. */
  readonly distanceChunks: number;
  readonly ahead: number;
  readonly behind: number;
  readonly aheadMeanRank: number;
  readonly behindMeanRank: number;
  /** Every chunk ahead arrived before every chunk behind, within this band. */
  readonly strictlySeparated: boolean;
}

interface IPriorityReport {
  readonly sampled: number;
  readonly aheadMeanRank: number;
  readonly behindMeanRank: number;
  readonly aheadWorstRank: number;
  readonly behindBestRank: number;
  /** Across the whole sample. Expected FALSE — see the note in `priorityReport`. */
  readonly strictlyOrdered: boolean;
  readonly bands: readonly IPriorityBand[];
  /** Bands with enough chunks on both sides to compare. */
  readonly bandsComparable: number;
  /** Comparable bands where the mean arrival rank ahead beat the mean behind. */
  readonly bandsOrderedByMean: number;
  /** Comparable bands where the separation was total. */
  readonly bandsStrictlySeparated: number;
  /** Of the first 20 direction-classified arrivals, the fraction facing the camera. */
  readonly firstTwentyAheadFraction: number;
}

interface IDamageReport {
  readonly chunk: number;
  readonly buildingsBefore: number;
  readonly buildingsAfterDestroy: number;
  readonly destroyedPiecesAfterDestroy: number;
  readonly hashAfterDestroy: number;
  readonly evicted: boolean;
  readonly buildingsAfterReload: number;
  readonly destroyedPiecesAfterReload: number;
  readonly hashAfterReload: number;
  readonly persisted: boolean;
}

interface IDeterminismReport {
  /** FNV fold over every chunk's content hash. Compare across page loads. */
  readonly worldFingerprint: number;
  readonly chunksHashed: number;
  /** Chunks whose worker-built hash matched a main-thread rebuild. */
  readonly workerAgreements: number;
  readonly workerMismatches: number;
}

interface IImpostorReport {
  readonly built: boolean;
  readonly buildings: number;
  readonly triangles: number;
  readonly bytes: number;
  readonly generationTimeMs: number;
  readonly uploadTimeMs: number;
  /** Draw calls to render the ENTIRE far city. Must be 1. */
  readonly drawCalls: number;
  readonly contentHash: number;
}

interface ISnapshot {
  readonly ready: boolean;
  readonly workersInline: boolean;
  readonly workerCount: number;
  readonly residentChunks: number;
  readonly chunksByRing: readonly number[];
  readonly queued: number;
  readonly inFlight: number;
  readonly uploadsLastFrame: number;
  readonly uploadMsLastFrame: number;
  readonly peakUploadMs: number;
  readonly totalLoads: number;
  readonly totalEvictions: number;
  readonly residentBytes: number;
  readonly streamedIn: number;
  readonly streamedOut: number;
  readonly colliderChunks: number;
  readonly colliderBoxes: number;
  readonly crowdChunks: number;
  readonly crowdSlots: number;
  readonly pvsBytes: number;
  readonly pvsAverageVisible: number;
  readonly visibleChunks: number;
  readonly sceneDrawCalls: number;
  readonly sceneTriangles: number;
  /** Times a settle gave up. Non-zero means something never went quiet. */
  readonly settleTimeouts: number;
}

interface IStreamingHarness {
  snapshot(): ISnapshot;
  settle(maxFrames?: number): Promise<number>;
  runLaps(count: number): Promise<ILapReport[]>;
  priorityReport(): IPriorityReport;
  runDamageProbe(): Promise<IDamageReport>;
  determinismReport(): IDeterminismReport;
  impostorReport(): IImpostorReport;
  setCameraForShot(): Promise<void>;
  setResolution(width: number, height: number): void;
  quality(tier: 'low' | 'medium' | 'high'): void;
}

declare global {
  interface Window {
    __STREAMING_HARNESS__?: IStreamingHarness;
    __STREAMING_READY__?: boolean;
    /** Present with `--js-flags=--expose-gc`. */
    gc?: () => void;
  }
}

/* -------------------------------------------------------------------------- */
/* Sinks                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Stand-ins for the physics and entity workstreams.
 *
 * They exist so the ring policy is EXERCISED rather than merely declared: the
 * harness asserts that R0 chunks register one collider per building, R1 chunks
 * register exactly one merged collider for the block, and R2 registers none.
 */
class CountingColliderSink implements IColliderSink {
  readonly byChunk = new Map<number, { mode: ColliderMode; boxes: readonly IColliderBox[] }>();
  setChunkColliders(chunk: number, mode: ColliderMode, boxes: readonly IColliderBox[]): void {
    this.byChunk.set(chunk, { mode, boxes });
  }
  clearChunkColliders(chunk: number): void {
    this.byChunk.delete(chunk);
  }
  get boxCount(): number {
    let total = 0;
    for (const entry of this.byChunk.values()) total += entry.boxes.length;
    return total;
  }
}

class CountingCrowdSink implements ICrowdSink {
  readonly byChunk = new Map<number, { mode: CrowdMode; slots: readonly ICrowdSlot[] }>();
  setChunkCrowd(chunk: number, mode: CrowdMode, slots: readonly ICrowdSlot[]): void {
    this.byChunk.set(chunk, { mode, slots });
  }
  clearChunkCrowd(chunk: number): void {
    this.byChunk.delete(chunk);
  }
  get slotCount(): number {
    let total = 0;
    for (const entry of this.byChunk.values()) total += entry.slots.length;
    return total;
  }
}

/* -------------------------------------------------------------------------- */
/* Scene                                                                      */
/* -------------------------------------------------------------------------- */

const viewCanvas = document.getElementById('view') as HTMLCanvasElement;
const mapCanvas = document.getElementById('map') as HTMLCanvasElement;
const mapCtx = mapCanvas.getContext('2d')!;
const phaseLabel = document.getElementById('phase') as HTMLDivElement;
const budgetPanel = document.getElementById('budget') as HTMLDivElement;
const worldPanel = document.getElementById('world') as HTMLDivElement;
const workerPanel = document.getElementById('workers') as HTMLDivElement;

const renderer = new THREE.WebGLRenderer({
  canvas: viewCanvas,
  antialias: false,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(1);
renderer.setClearColor(0x8fa6bd, 1);

const scene = new THREE.Scene();
const SKY = new THREE.Color(0x9fb6cd);
scene.background = SKY;
// Fog is not decoration here: it is what lets the impostor ring hand over to
// real geometry without a visible seam at 768 m.
scene.fog = new THREE.FogExp2(SKY.getHex(), 0.00085);

const camera = new THREE.PerspectiveCamera(62, 1, 1, 2400);
camera.position.copy(PATH_START);

function makeLightRig(): THREE.Object3D[] {
  const sky = new THREE.HemisphereLight(0xd8e6f5, 0x2a2f36, 2.0);
  const sun = new THREE.DirectionalLight(0xfff2d8, 1.7);
  sun.position.set(-320, 620, 260);
  return [sky, sun];
}

for (const light of makeLightRig()) scene.add(light);

/**
 * Scene used only for prewarm draws. Holds at most one object at a time.
 *
 * It carries the SAME light rig and fog as the real scene, and that is not
 * cosmetic: three's program cache key includes the light counts and the fog
 * flag, so a prewarm scene without them would compile a second shader variant
 * for every chunk and then discard it the moment the chunk went back to the
 * real scene. The measured "upload" would then be a shader compile that no
 * real frame ever pays.
 */
const uploadScene = new THREE.Scene();
uploadScene.fog = scene.fog;
for (const light of makeLightRig()) uploadScene.add(light);

/* -------------------------------------------------------------------------- */
/* Spatial index                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Index the city the streamer will generate, so the PVS and the frustum walk
 * describe the world that actually exists. Using synthetic boxes here would
 * make every downstream number a measurement of the fixture.
 */
function buildSpatialIndex(): { index: SpatialIndex; pvsBuildMs: number } {
  const footprints: IFootprint[] = [];
  const boxes: number[] = [];

  for (let cz = CHUNK_COORD_MIN; cz <= CHUNK_COORD_MAX; cz++) {
    for (let cx = CHUNK_COORD_MIN; cx <= CHUNK_COORD_MAX; cx++) {
      for (const building of layoutChunk(SEED, cx, cz).buildings) {
        footprints.push({
          minX: building.minX,
          minZ: building.minZ,
          maxX: building.maxX,
          maxZ: building.maxZ,
        });
        boxes.push(
          building.minX, 0, building.minZ,
          building.maxX, building.height, building.maxZ
        );
      }
    }
  }

  const started = performance.now();
  // 96 rays from 5 origins rather than the 128/9 default: the table is used
  // here for load prioritisation, where a slightly conservative mask costs
  // nothing, and the harness should not spend three seconds booting.
  const pvs = buildPvs(footprints, { rayCount: 96, originSamples: 5 });
  const pvsBuildMs = performance.now() - started;

  const index = new SpatialIndex({ pvs, quadtree: { capacity: footprints.length + 64 } });
  for (let i = 0; i < boxes.length; i += 6) {
    index.insertStatic(boxes[i]!, boxes[i + 1]!, boxes[i + 2]!, boxes[i + 3]!, boxes[i + 4]!, boxes[i + 5]!);
  }
  return { index, pvsBuildMs };
}

const { index: spatial, pvsBuildMs } = buildSpatialIndex();

/* -------------------------------------------------------------------------- */
/* Streaming system                                                           */
/* -------------------------------------------------------------------------- */

const bus = new EventBus();
const colliderSink = new CountingColliderSink();
const crowdSink = new CountingCrowdSink();
const damage = new ChunkDamageState();

let streamedIn = 0;
let streamedOut = 0;
/** Dense chunk indices in the order they first appeared, for the priority test. */
const arrivalOrder: number[] = [];
const arrivalSeen = new Set<number>();
/**
 * Arrivals are recorded only during the cold start.
 *
 * The cold start is the ONLY clean priority experiment available: nothing is
 * resident, so every chunk in range has to be built and the order they arrive
 * in is the scheduler's own answer. Once the flight begins, chunks arrive
 * because the camera moved into range, and arrival order says as much about the
 * flight path as about the priority function.
 */
let recordingArrivals = true;

/** Where the camera stood during the cold start, for the priority analysis. */
const coldStartOrigin = new THREE.Vector3();
const coldStartForward = new THREE.Vector3();

bus.on('ChunkStreamedIn', (event) => {
  streamedIn++;
  if (!recordingArrivals) return;
  const index = chunkIndex(event.coord.x, event.coord.z);
  if (!arrivalSeen.has(index)) {
    arrivalSeen.add(index);
    arrivalOrder.push(index);
  }
});
bus.on('ChunkStreamedOut', () => {
  streamedOut++;
});

/**
 * Force the driver to take a chunk's buffers inside the measured bracket.
 *
 * The object is briefly re-parented into a scratch scene, drawn into a
 * one-pixel scissor rect, and put back. Re-parenting is two array splices;
 * cloning the mesh instead would allocate exactly the geometry the upload is
 * trying to measure.
 */
function forceGpuUpload(object: THREE.Object3D): void {
  const parent = object.parent;
  const previousAutoClear = renderer.autoClear;

  // Frustum culling has to come OFF for the prewarm, or the measurement quietly
  // becomes "upload cost of chunks that happen to be on screen". A chunk that
  // arrives behind the camera would be skipped by the draw, its `bufferData`
  // deferred to whichever later frame first sees it, and that frame's spike
  // would never appear in these numbers.
  object.traverse((child) => {
    child.frustumCulled = false;
  });

  uploadScene.add(object);
  renderer.autoClear = false;
  renderer.setScissorTest(true);
  renderer.setScissor(0, 0, 1, 1);
  renderer.render(uploadScene, camera);
  renderer.setScissorTest(false);
  renderer.autoClear = previousAutoClear;
  uploadScene.remove(object);

  object.traverse((child) => {
    child.frustumCulled = true;
  });
  parent?.add(object);
}

const streaming = new StreamingSystem({
  scene,
  bus,
  seed: SEED,
  quality: 'medium',
  colliderSink,
  crowdSink,
  gpuUpload: forceGpuUpload,
  isChunkPotentiallyVisible: (from, to) => spatial.isChunkPotentiallyVisible(from, to),
});

/* -------------------------------------------------------------------------- */
/* Flight                                                                     */
/* -------------------------------------------------------------------------- */

const forward = new THREE.Vector3();
const lookTarget = new THREE.Vector3();

/**
 * Place the camera at normalised distance `t` along the traverse.
 * `direction` is +1 outbound and -1 on the return leg.
 */
function placeCamera(t: number, direction: number): void {
  camera.position.lerpVectors(PATH_START, PATH_END, t);
  forward.subVectors(PATH_END, PATH_START).normalize().multiplyScalar(direction);
  lookTarget.copy(camera.position).addScaledVector(forward, 400);
  // Look slightly down: the ring structure and the impostor horizon are both
  // in frame from a shallow dive, which is also how the game's chase camera
  // sits during traversal.
  lookTarget.y = camera.position.y - 86;
  camera.lookAt(lookTarget);
  camera.updateMatrixWorld();
}

placeCamera(0, 1);

/* -------------------------------------------------------------------------- */
/* Frame loop                                                                 */
/* -------------------------------------------------------------------------- */

let frameIndex = 0;
let phase = 'booting';

/**
 * Frames between full-scene renders while a scripted run is driving.
 *
 * The prewarm draw in `forceGpuUpload` is what forces a chunk's buffers onto
 * the GPU, so the upload measurement does not depend on the scene render at
 * all. The full render still happens regularly — it is what exercises culling
 * and the real draw path — but doing it on every one of ~4000 lap frames would
 * spend the entire run inside a CPU rasteriser measuring nothing.
 */
const SCRIPTED_RENDER_INTERVAL = 4;
let renderInterval = 1;

/** True while a scripted run owns the frame clock; the idle driver stands down. */
let driverPaused = false;
/** Set once the run is over, to leave the page still for the screenshot. */
let driverStopped = false;

interface IFrameSample {
  uploads: number;
  uploadMs: number;
  unloadMs: number;
  chunkUploadMs: number;
}

let sampling: IFrameSample[] | undefined;

function stepFrame(): void {
  frameIndex++;
  bus.setFrame(frameIndex, frameIndex * FIXED_DT);

  camera.getWorldDirection(forward);
  streaming.setView(camera.position, forward);

  // One traversal fills both outputs; streaming consumes the chunk half.
  spatial.cull(camera);
  streaming.setVisibleChunks(spatial.visibleChunks.data, spatial.visibleChunks.length);

  streaming.update(FIXED_DT);

  const stats = streaming.getDetailedStats();
  if (sampling !== undefined) {
    sampling.push({
      uploads: stats.uploadsLastFrame,
      uploadMs: stats.uploadMsLastFrame,
      unloadMs: stats.unloadMsLastFrame,
      chunkUploadMs: stats.peakChunkUploadMs,
    });
  }

  if (renderInterval === 1 || frameIndex % renderInterval === 0) renderer.render(scene, camera);
}

let lastPanelUpdate = 0;

/**
 * The idle driver. It stands down while a scripted run is stepping frames,
 * because two steppers would double the simulation rate and pollute the
 * per-frame budget samples with frames the script never asked for.
 */
function loop(): void {
  if (driverStopped) return;
  if (!driverPaused) {
    stepFrame();
    const now = performance.now();
    if (now - lastPanelUpdate > 150) {
      lastPanelUpdate = now;
      drawMap();
      drawPanels();
    }
  }
  requestAnimationFrame(loop);
}

/* -------------------------------------------------------------------------- */
/* Harness control                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Simulated frames per animation-frame callback.
 *
 * TWO, and the number is load-bearing. Worker results arrive as tasks, so they
 * are only delivered when the event loop turns — which means the number of
 * simulated frames per real tick is a hard ceiling on how many chunks can come
 * back. At the pool's four-jobs-in-flight and the budget's two uploads a frame,
 * two frames per tick is exactly break-even: the streamer can always be fed as
 * fast as its own budget allows.
 *
 * Running more frames per tick is not "faster", it is a different experiment:
 * it starves the pipeline and measures the harness rather than the system.
 * (An earlier revision ran 24 frames per tick and drove every load through a
 * four-results-per-tick funnel, which looked exactly like a slow streamer.)
 */
const FRAMES_PER_TICK = 2;

/** Run `count` frames, always turning the event loop between slices. */
function runFrames(count: number, onFrame?: (i: number) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    driverPaused = true;
    let done = 0;
    const tick = (): void => {
      for (let i = 0; i < FRAMES_PER_TICK && done < count; i++, done++) {
        onFrame?.(done);
        stepFrame();
      }
      if (done >= count) {
        driverPaused = false;
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    // Scheduled, never called inline: a synchronous first slice would let a
    // caller drain its whole loop without the event loop ever turning, and
    // nothing from a worker would arrive for the entire run.
    requestAnimationFrame(tick);
  });
}

/** Frames a single `settle` may burn before it gives up. */
const SETTLE_CAP = 3000;

/** Set when a settle hit the cap — surfaced so a stall cannot pass silently. */
let settleTimeouts = 0;

/**
 * Drive frames until nothing is queued, building, waiting or unloading.
 *
 * Waiting on the build side alone is not enough: eviction is budgeted at four
 * chunks a frame, so after a long jump the loads finish well before the unloads
 * and a build-only wait returns to a half-torn-down world.
 */
async function settle(maxFrames = SETTLE_CAP): Promise<number> {
  for (let i = 0; i < maxFrames; i += FRAMES_PER_TICK) {
    await runFrames(FRAMES_PER_TICK);
    const stats = streaming.getDetailedStats();
    if (
      stats.queued === 0 &&
      stats.inFlight === 0 &&
      stats.readyToUpload === 0 &&
      stats.unloadsLastFrame === 0
    ) {
      return i + FRAMES_PER_TICK;
    }
  }
  settleTimeouts++;
  return maxFrames;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
  return sorted[at]!;
}

function heapBytes(): number {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return memory?.usedJSHeapSize ?? 0;
}

/** Collapse garbage before sampling, where the flag allows it. */
async function collectGarbage(): Promise<void> {
  window.gc?.();
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  window.gc?.();
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
}

/**
 * Fly the traverse `count` times, out and back each lap.
 *
 * Out AND back matters for the leak detector: a lap that ends where it began
 * ends with the same resident set, so heap and chunk counts across laps are
 * directly comparable instead of being confounded by whatever happens to be in
 * range at the far end.
 */
async function runLaps(count: number): Promise<ILapReport[]> {
  const reports: ILapReport[] = [];
  const framesPerLeg = Math.round(PATH_LENGTH / (FLIGHT_SPEED * FIXED_DT));

  renderer.setSize(LAP_RESOLUTION.width, LAP_RESOLUTION.height, false);
  camera.aspect = LAP_RESOLUTION.width / LAP_RESOLUTION.height;
  camera.updateProjectionMatrix();
  renderInterval = SCRIPTED_RENDER_INTERVAL;

  for (let lap = 1; lap <= count; lap++) {
    phase = `lap ${lap}/${count} — outbound`;
    streaming.resetPeaks();
    const before = streaming.getDetailedStats();
    const samples: IFrameSample[] = [];
    sampling = samples;

    await runFrames(framesPerLeg, (i) => placeCamera(i / framesPerLeg, 1));
    phase = `lap ${lap}/${count} — return`;
    await runFrames(framesPerLeg, (i) => placeCamera(1 - i / framesPerLeg, -1));
    placeCamera(0, 1);

    phase = `lap ${lap}/${count} — settling`;
    await settle();
    sampling = undefined;

    await collectGarbage();
    const after = streaming.getDetailedStats();
    const uploadMs = samples.map((s) => s.uploadMs);

    reports.push({
      lap,
      frames: samples.length,
      uploads: after.totalLoads - before.totalLoads,
      evictions: after.totalEvictions - before.totalEvictions,
      maxUploadsPerFrame: Math.max(0, ...samples.map((s) => s.uploads)),
      maxUploadMs: Math.max(0, ...uploadMs),
      p95UploadMs: percentile(uploadMs.filter((v) => v > 0), 0.95),
      meanUploadMs:
        uploadMs.reduce((a, b) => a + b, 0) / Math.max(1, uploadMs.filter((v) => v > 0).length),
      maxChunkUploadMs: after.peakChunkUploadMs,
      framesOver4ms: uploadMs.filter((v) => v > UPLOAD_BUDGET_MS).length,
      framesOver50ms: uploadMs.filter((v) => v > 50).length,
      maxUnloadMs: Math.max(0, ...samples.map((s) => s.unloadMs)),
      ringTransitions: after.ringTransitions,
      heapBytes: heapBytes(),
      residentChunks: after.residentChunks,
      residentBytes: after.totalMemoryBytes,
      geometries: renderer.info.memory.geometries,
    });
  }

  phase = 'laps complete';
  renderInterval = 1;
  return reports;
}

/**
 * Did the city assemble in front of the camera?
 *
 * Uses the COLD-START arrival order recorded from boot, when nothing was
 * resident and every chunk in range had to be built. Chunks are split into
 * those ahead of the camera and those behind it, and their arrival ranks are
 * compared. The strict form of the claim — every chunk ahead arrived before
 * every chunk behind — is reported separately from the mean, because the strict
 * form is what "what you are looking at loads first" actually promises.
 */
function priorityReport(): IPriorityReport {
  const start = coldStartOrigin;
  const direction = coldStartForward;

  const rank = new Map<number, number>();
  arrivalOrder.forEach((index, at) => rank.set(index, at));

  const ahead: number[] = [];
  const behind: number[] = [];
  let firstTenAhead = 0;

  for (const [index, at] of rank) {
    const dx = chunkCentreX(index) - start.x;
    const dz = chunkCentreZ(index) - start.z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    if (distance < CHUNK_SIZE * 2) continue; // too close to have a direction
    const dot = (dx * direction.x + dz * direction.z) / distance;
    if (dot > 0.6) {
      ahead.push(at);
      if (at < 10) firstTenAhead++;
    } else if (dot < -0.6) {
      behind.push(at);
    }
  }

  const mean = (values: number[]): number =>
    values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

  return {
    sampled: ahead.length + behind.length,
    aheadMeanRank: mean(ahead),
    behindMeanRank: mean(behind),
    aheadWorstRank: ahead.length === 0 ? 0 : Math.max(...ahead),
    behindBestRank: behind.length === 0 ? 0 : Math.min(...behind),
    strictlyOrdered:
      ahead.length > 0 && behind.length > 0 && Math.max(...ahead) < Math.min(...behind),
    firstTenAheadFraction: firstTenAhead / 10,
  };
}

/**
 * Destroy, stream out, stream back in, and check the city remembered.
 *
 * Deliberately uses a chunk with real buildings in it and checks the CONTENT
 * HASH as well as the counts: matching counts would also be produced by a
 * regenerated chunk that happened to lose two different buildings.
 */
async function runDamageProbe(): Promise<IDamageReport> {
  phase = 'damage probe';
  // A downtown block one chunk west of the origin: nine towers.
  const targetCx = -1;
  const targetCz = 0;
  const target = chunkIndex(targetCx, targetCz);
  const near = new THREE.Vector3(targetCx * CHUNK_SIZE + CHUNK_SIZE * 0.5, EYE_HEIGHT, targetCz * CHUNK_SIZE + CHUNK_SIZE * 0.5);

  camera.position.copy(near);
  camera.lookAt(near.x, near.y - 40, near.z - 200);
  camera.updateMatrixWorld();
  await settle();

  const before = streaming.chunkAtIndex(target);
  const buildingsBefore = before?.standingBuildings ?? 0;

  streaming.destroyBuilding(target, 0);
  streaming.destroyBuilding(target, 3);
  await settle();

  const damaged = streaming.chunkAtIndex(target);
  const buildingsAfterDestroy = damaged?.standingBuildings ?? -1;
  const destroyedPiecesAfterDestroy = damaged?.destroyedPieces ?? -1;
  const hashAfterDestroy = damaged?.contentHash ?? 0;

  // Fly to the far corner: far enough that the chunk is not merely demoted to a
  // coarser ring but evicted outright.
  camera.position.set(700, EYE_HEIGHT, 700);
  camera.lookAt(700, EYE_HEIGHT - 40, 500);
  camera.updateMatrixWorld();
  await settle();
  const evicted = streaming.chunkAtIndex(target) === undefined;

  camera.position.copy(near);
  camera.lookAt(near.x, near.y - 40, near.z - 200);
  camera.updateMatrixWorld();
  await settle();

  const reloaded = streaming.chunkAtIndex(target);
  const buildingsAfterReload = reloaded?.standingBuildings ?? -1;
  const destroyedPiecesAfterReload = reloaded?.destroyedPieces ?? -1;
  const hashAfterReload = reloaded?.contentHash ?? 0;

  return {
    chunk: target,
    buildingsBefore,
    buildingsAfterDestroy,
    destroyedPiecesAfterDestroy,
    hashAfterDestroy,
    evicted,
    buildingsAfterReload,
    destroyedPiecesAfterReload,
    hashAfterReload,
    persisted:
      evicted &&
      buildingsAfterReload === buildingsAfterDestroy &&
      destroyedPiecesAfterReload === destroyedPiecesAfterDestroy &&
      hashAfterReload === hashAfterDestroy &&
      hashAfterReload !== 0,
  };
}

/**
 * A fingerprint of the whole world, plus a cross-context agreement check.
 *
 * The fingerprint folds every chunk's content hash into one number; comparing
 * it across two page loads answers "same seed, same city". The agreement check
 * compares hashes produced by a WORKER against the same chunks rebuilt on the
 * MAIN THREAD — two different execution contexts, which is the case a
 * single-threaded determinism test cannot cover.
 */
function determinismReport(): IDeterminismReport {
  let fingerprint = 0x811c9dc5;
  for (let index = 0; index < CHUNK_COUNT; index++) {
    const built = buildChunkGeometry(
      SEED,
      chunkIndexToX(index),
      chunkIndexToZ(index),
      RING_R2,
      undefined
    );
    fingerprint = Math.imul(fingerprint ^ built.contentHash, 0x01000193) >>> 0;
  }

  let workerAgreements = 0;
  let workerMismatches = 0;
  for (const chunk of streaming.loadedChunks.values()) {
    const resident = streaming.chunkAtIndex(chunkIndex(chunk.coord.x, chunk.coord.z));
    if (resident === undefined || resident.builtRing < 0) continue;
    const rebuilt = buildChunkGeometry(
      SEED,
      resident.coord.x,
      resident.coord.z,
      resident.builtRing,
      damage.cloneMask(resident.index)
    );
    if (rebuilt.contentHash === resident.contentHash) workerAgreements++;
    else workerMismatches++;
  }

  return {
    worldFingerprint: fingerprint >>> 0,
    chunksHashed: CHUNK_COUNT,
    workerAgreements,
    workerMismatches,
  };
}

/**
 * Prove the far city is one draw call by rendering ONLY the impostor and
 * reading the renderer's own counter.
 */
function impostorReport(): IImpostorReport {
  const stats = streaming.impostor.getStats();
  const root = streaming.impostor.root;
  const parent = root.parent;
  const previousAutoClear = renderer.autoClear;

  uploadScene.add(root);
  renderer.autoClear = false;
  renderer.setScissorTest(true);
  renderer.setScissor(0, 0, 2, 2);
  renderer.render(uploadScene, camera);
  renderer.setScissorTest(false);
  renderer.autoClear = previousAutoClear;
  const drawCalls = renderer.info.render.calls;
  uploadScene.remove(root);
  parent?.add(root);

  return {
    built: stats.built,
    buildings: stats.buildings,
    triangles: stats.triangles,
    bytes: stats.bytes,
    generationTimeMs: stats.generationTimeMs,
    uploadTimeMs: stats.uploadTimeMs,
    drawCalls,
    contentHash: stats.contentHash,
  };
}

function snapshot(): ISnapshot {
  const stats = streaming.getDetailedStats();
  const spatialStats = spatial.getStats();
  return {
    ready: true,
    workersInline: stats.workersInline,
    workerCount: stats.workersInline ? 0 : 2,
    residentChunks: stats.residentChunks,
    chunksByRing: stats.chunksByRing,
    queued: stats.queued,
    inFlight: stats.inFlight,
    uploadsLastFrame: stats.uploadsLastFrame,
    uploadMsLastFrame: stats.uploadMsLastFrame,
    peakUploadMs: stats.peakUploadMs,
    totalLoads: stats.totalLoads,
    totalEvictions: stats.totalEvictions,
    residentBytes: stats.totalMemoryBytes,
    streamedIn,
    streamedOut,
    colliderChunks: colliderSink.byChunk.size,
    colliderBoxes: colliderSink.boxCount,
    crowdChunks: crowdSink.byChunk.size,
    crowdSlots: crowdSink.slotCount,
    pvsBytes: spatialStats.pvsBytes,
    pvsAverageVisible: spatialStats.pvsAverageVisible,
    visibleChunks: spatialStats.visibleChunks,
    sceneDrawCalls: renderer.info.render.calls,
    sceneTriangles: renderer.info.render.triangles,
    settleTimeouts,
  };
}

/**
 * Park the camera where the ring structure photographs well and leave the page
 * completely still.
 *
 * Order matters: settle at the small lap buffer, THEN resize and render exactly
 * one full-size frame, THEN stop the frame driver. Settling at full size would
 * spend minutes in the software rasteriser, and leaving the driver running
 * would have Playwright's screenshot competing with a render that takes longer
 * than its timeout.
 */
async function setCameraForShot(): Promise<void> {
  phase = 'framing';
  renderInterval = SCRIPTED_RENDER_INTERVAL;

  // Over the downtown core looking across the whole district, so R0 detail,
  // the R1/R2 merged blocks and the impostor horizon are all in one frame.
  camera.position.set(-300, 120, 330);
  camera.lookAt(240, -30, -420);
  camera.updateMatrixWorld();
  await settle();

  driverPaused = true;
  driverStopped = true;
  renderInterval = 1;

  const stage = document.getElementById('stage') as HTMLDivElement;
  renderer.setSize(stage.clientWidth, stage.clientHeight, false);
  camera.aspect = stage.clientWidth / Math.max(1, stage.clientHeight);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  spatial.cull(camera);
  renderer.render(scene, camera);

  phase = 'ready for capture';
  drawMap();
  drawPanels();
}

/* -------------------------------------------------------------------------- */
/* Overlay                                                                    */
/* -------------------------------------------------------------------------- */

const RING_COLOURS = ['#ffd230', '#ff8f3c', '#4d8fe0', '#253046'];

function drawMap(): void {
  const size = mapCanvas.width;
  const cell = size / CHUNK_GRID;
  mapCtx.fillStyle = '#04060a';
  mapCtx.fillRect(0, 0, size, size);

  const toMapX = (worldX: number): number => ((worldX - WORLD_MIN) / WORLD_SIZE) * size;
  const toMapY = (worldZ: number): number => ((worldZ - WORLD_MIN) / WORLD_SIZE) * size;

  const queued = new Set<number>();
  const building = new Set<number>();
  for (let index = 0; index < CHUNK_COUNT; index++) {
    const chunk = streaming.chunkAtIndex(index);
    const x = toMapX(chunkIndexToX(index) * CHUNK_SIZE);
    const y = toMapY(chunkIndexToZ(index) * CHUNK_SIZE);

    if (chunk === undefined) {
      mapCtx.fillStyle = RING_COLOURS[RING_R3]!;
      mapCtx.fillRect(x, y, cell - 1, cell - 1);
      continue;
    }
    if (chunk.jobId !== -1) building.add(index);
    else if (chunk.builtRing < 0) queued.add(index);

    const ring = chunk.builtRing >= 0 ? chunk.builtRing : chunk.desiredRing;
    mapCtx.fillStyle = RING_COLOURS[Math.max(0, Math.min(3, ring))]!;
    mapCtx.fillRect(x, y, cell - 1, cell - 1);

    if (damage.isChunkDamaged(index)) {
      mapCtx.fillStyle = '#ff4d4d';
      mapCtx.fillRect(x + cell * 0.36, y + cell * 0.36, cell * 0.28, cell * 0.28);
    }
  }

  mapCtx.lineWidth = 1.5;
  for (const index of queued) {
    mapCtx.strokeStyle = '#e05fd8';
    mapCtx.strokeRect(
      toMapX(chunkIndexToX(index) * CHUNK_SIZE) + 1,
      toMapY(chunkIndexToZ(index) * CHUNK_SIZE) + 1,
      cell - 3,
      cell - 3
    );
  }
  for (const index of building) {
    mapCtx.strokeStyle = '#38d9c8';
    mapCtx.strokeRect(
      toMapX(chunkIndexToX(index) * CHUNK_SIZE) + 1,
      toMapY(chunkIndexToZ(index) * CHUNK_SIZE) + 1,
      cell - 3,
      cell - 3
    );
  }

  // Flight path.
  mapCtx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  mapCtx.lineWidth = 1;
  mapCtx.beginPath();
  mapCtx.moveTo(toMapX(PATH_START.x), toMapY(PATH_START.z));
  mapCtx.lineTo(toMapX(PATH_END.x), toMapY(PATH_END.z));
  mapCtx.stroke();

  // Camera and its view cone.
  camera.getWorldDirection(forward);
  const cx = toMapX(camera.position.x);
  const cy = toMapY(camera.position.z);
  const fx = forward.x;
  const fz = forward.z;
  const flen = Math.hypot(fx, fz) || 1;
  const half = 0.55;
  const reach = (RING_OUTER_METRES / WORLD_SIZE) * size;
  const dirX = fx / flen;
  const dirZ = fz / flen;
  const leftX = dirX * Math.cos(half) - dirZ * Math.sin(half);
  const leftZ = dirX * Math.sin(half) + dirZ * Math.cos(half);
  const rightX = dirX * Math.cos(-half) - dirZ * Math.sin(-half);
  const rightZ = dirX * Math.sin(-half) + dirZ * Math.cos(-half);

  mapCtx.fillStyle = 'rgba(255, 255, 255, 0.12)';
  mapCtx.beginPath();
  mapCtx.moveTo(cx, cy);
  mapCtx.lineTo(cx + leftX * reach, cy + leftZ * reach);
  mapCtx.lineTo(cx + rightX * reach, cy + rightZ * reach);
  mapCtx.closePath();
  mapCtx.fill();

  mapCtx.fillStyle = '#ffffff';
  mapCtx.beginPath();
  mapCtx.arc(cx, cy, 3.5, 0, Math.PI * 2);
  mapCtx.fill();

  mapCtx.strokeStyle = '#16203a';
  mapCtx.lineWidth = 1;
  mapCtx.strokeRect(0.5, 0.5, size - 1, size - 1);
}

function row(key: string, value: string, tone = ''): string {
  return `<tr><td class="k">${key}</td><td class="v ${tone}">${value}</td></tr>`;
}

function drawPanels(): void {
  const stats = streaming.getDetailedStats();
  const impostorStats = streaming.impostor.getStats();

  budgetPanel.innerHTML =
    '<table>' +
    row('uploads / frame', `${stats.uploadsLastFrame} / ${MAX_UPLOADS_PER_FRAME}`,
      stats.uploadsLastFrame > MAX_UPLOADS_PER_FRAME ? 'bad' : 'good') +
    row('upload ms (frame)', stats.uploadMsLastFrame.toFixed(3),
      stats.uploadMsLastFrame > UPLOAD_BUDGET_MS ? 'warn' : 'good') +
    row('peak frame upload ms', stats.peakUploadMs.toFixed(3),
      stats.peakUploadMs > 50 ? 'bad' : stats.peakUploadMs > UPLOAD_BUDGET_MS ? 'warn' : 'good') +
    row('peak chunk upload ms', stats.peakChunkUploadMs.toFixed(3)) +
    row('unload ms (frame)', stats.unloadMsLastFrame.toFixed(3)) +
    row('queued', String(stats.queued)) +
    row('building', String(stats.inFlight)) +
    row('awaiting upload', String(stats.readyToUpload)) +
    '</table>';

  worldPanel.innerHTML =
    '<table>' +
    row('resident chunks', String(stats.residentChunks)) +
    row('R0 / R1 / R2',
      `${stats.chunksByRing[RING_R0]} / ${stats.chunksByRing[RING_R1]} / ${stats.chunksByRing[RING_R2]}`) +
    row('resident MB', (stats.totalMemoryBytes / 1048576).toFixed(2)) +
    row('loads / evictions', `${stats.totalLoads} / ${stats.totalEvictions}`) +
    row('ring changes', `${stats.ringTransitions} (${stats.ringTransitionsSuppressed} damped)`) +
    row('colliders', `${colliderSink.byChunk.size} chunks / ${colliderSink.boxCount} boxes`) +
    row('crowd slots', `${crowdSink.byChunk.size} chunks / ${crowdSink.slotCount} slots`) +
    row('damaged chunks', String(stats.damagedChunks)) +
    row('impostor', impostorStats.built
      ? `${impostorStats.buildings} bldg / ${(impostorStats.triangles / 1000).toFixed(1)}k tri / 1 draw`
      : 'baking') +
    '</table>';

  workerPanel.innerHTML =
    '<table>' +
    row('mode', stats.workersInline ? 'INLINE (no Worker)' : '2 module workers',
      stats.workersInline ? 'bad' : 'good') +
    row('worker ms total', stats.workerTimeMs.toFixed(1)) +
    row('impostor bake ms', impostorStats.generationTimeMs.toFixed(1)) +
    row('impostor upload ms', impostorStats.uploadTimeMs.toFixed(2)) +
    row('PVS build ms', pvsBuildMs.toFixed(0)) +
    row('PVS bytes', String(spatial.getStats().pvsBytes)) +
    row('quality tier', stats.quality) +
    row('resident radius', `${stats.residentRadiusChunks} chunks`) +
    '</table>';

  phaseLabel.textContent = `${phase} — frame ${frameIndex}`;
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

const harness: IStreamingHarness = {
  snapshot,
  settle,
  runLaps,
  priorityReport,
  runDamageProbe,
  determinismReport,
  impostorReport,
  setCameraForShot,
  setResolution(width, height) {
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
  },
  quality(tier) {
    streaming.applyQuality(tier);
  },
};

async function boot(): Promise<void> {
  // Boot at the lap resolution: the cold start builds the entire resident
  // neighbourhood, and rasterising it at full size under a CPU renderer would
  // add a minute of nothing useful before the first measurement.
  renderer.setSize(LAP_RESOLUTION.width, LAP_RESOLUTION.height, false);
  camera.aspect = LAP_RESOLUTION.width / LAP_RESOLUTION.height;
  camera.updateProjectionMatrix();

  // The cold start IS the priority test: nothing is resident, every chunk in
  // range has to be built, and the order they arrive in is the evidence. It has
  // to run from the MIDDLE of the world, not from the start of the flight path:
  // the path begins hard against the western edge, where there is no city
  // behind the camera to be outranked and the comparison would be vacuous.
  phase = 'cold start';
  camera.position.set(CHUNK_SIZE * 0.5, EYE_HEIGHT, CHUNK_SIZE * 0.5);
  camera.lookAt(CHUNK_SIZE * 0.5, EYE_HEIGHT - 40, -600);
  camera.updateMatrixWorld();
  coldStartOrigin.copy(camera.position);
  camera.getWorldDirection(coldStartForward);
  coldStartForward.y = 0;
  coldStartForward.normalize();

  await settle();
  recordingArrivals = false;

  // Now move to the start of the traverse and let the world catch up, so the
  // laps begin from a settled state rather than mid-burst.
  phase = 'moving to the flight start';
  placeCamera(0, 1);
  await settle();
  phase = 'idle';

  window.__STREAMING_HARNESS__ = harness;
  window.__STREAMING_READY__ = true;
  requestAnimationFrame(loop);
}

void boot();
