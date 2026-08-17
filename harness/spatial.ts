/**
 * SPATIAL HARNESS — TOP-DOWN VIEW OF THE INDEX
 *
 * Renders, over one synthetic City Z layout:
 *
 *   - the building footprints, so occlusion is visible;
 *   - the occupied quadtree cells at a chosen depth;
 *   - the camera frustum's ground footprint;
 *   - each chunk shaded by what culling decided about it — kept by the
 *     frustum, kept by frustum + PVS, or removed by the PVS;
 *   - the instances the hierarchical cull actually returned;
 *   - optionally, the PVS mask of the chunk the camera stands in.
 *
 * Everything is drawn on a 2D canvas from the same structures the game uses;
 * nothing here reimplements culling.
 *
 * Playwright control surface: `window.__SPATIAL_HARNESS__`.
 */

import {
  buildPvs,
  generateSyntheticCity,
  measureCullRates,
  sampleStreetCameras,
  Frustum,
  IndexList,
  Quadtree,
  SpatialIndex,
  composeViewProjection,
  CHUNK_COUNT,
  CHUNK_GRID,
  CHUNK_SIZE,
  WORLD_MIN,
  WORLD_SIZE,
  chunkIndexAt,
  type ICameraSample,
  type ICullRateReport,
} from '@/spatial';

/* -------------------------------------------------------------------------- */
/* Setup                                                                      */
/* -------------------------------------------------------------------------- */

const canvas = document.getElementById('map') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const statsEl = document.getElementById('stats')!;

const FOV_DEGREES = 60;
const ASPECT = 900 / 1600;
const NEAR = 0.3;
const FAR = 400;

const city = generateSyntheticCity();
const pvs = buildPvs(city.footprints, { rayCount: 128, originSamples: 9 });

const index = new SpatialIndex({
  quadtree: { initialCapacity: city.instances.length },
  pvs,
});
for (const instance of city.instances) {
  index.insertStatic(
    instance.minX,
    instance.minY,
    instance.minZ,
    instance.maxX,
    instance.maxY,
    instance.maxZ,
    instance
  );
}
index.refit();

const cameras: ICameraSample[] = sampleStreetCameras(city, 512);
const frustumOnly = new IndexList(4096);
const viewProjection = new Float64Array(16);
const scratchFrustum = new Frustum();
const nodeCell = new Float64Array(3);

let cameraIndex = 0;
let overlayDepth = 5;
let showPvsMask = false;
let usePvs = true;
let report: ICullRateReport | undefined;

/* -------------------------------------------------------------------------- */
/* Projection                                                                 */
/* -------------------------------------------------------------------------- */

const scale = canvas.width / WORLD_SIZE;
const toPixelX = (x: number): number => (x - WORLD_MIN) * scale;
const toPixelZ = (z: number): number => (z - WORLD_MIN) * scale;

/* -------------------------------------------------------------------------- */
/* Drawing                                                                    */
/* -------------------------------------------------------------------------- */

function currentCamera(): ICameraSample {
  return cameras[cameraIndex % cameras.length]!;
}

function drawChunkShading(visibleChunks: Set<number>, frustumChunks: Set<number>): void {
  for (let c = 0; c < CHUNK_COUNT; c++) {
    const inFrustum = frustumChunks.has(c);
    if (!inFrustum) continue;
    const kept = visibleChunks.has(c);
    ctx.fillStyle = kept ? 'rgba(60, 220, 160, 0.22)' : 'rgba(255, 90, 90, 0.28)';
    const x = toPixelX((c % CHUNK_GRID) * CHUNK_SIZE + WORLD_MIN);
    const z = toPixelZ(Math.floor(c / CHUNK_GRID) * CHUNK_SIZE + WORLD_MIN);
    ctx.fillRect(x, z, CHUNK_SIZE * scale, CHUNK_SIZE * scale);
  }
}

function drawPvsMask(from: number): void {
  ctx.fillStyle = 'rgba(120, 90, 220, 0.16)';
  for (let c = 0; c < CHUNK_COUNT; c++) {
    if (!pvs.isVisible(from, c)) continue;
    const x = toPixelX((c % CHUNK_GRID) * CHUNK_SIZE + WORLD_MIN);
    const z = toPixelZ(Math.floor(c / CHUNK_GRID) * CHUNK_SIZE + WORLD_MIN);
    ctx.fillRect(x, z, CHUNK_SIZE * scale, CHUNK_SIZE * scale);
  }
}

function drawFootprints(): void {
  ctx.fillStyle = '#3c4c6e';
  for (const instance of city.instances) {
    if (!instance.occluder) continue;
    ctx.fillRect(
      toPixelX(instance.minX),
      toPixelZ(instance.minZ),
      (instance.maxX - instance.minX) * scale,
      (instance.maxZ - instance.minZ) * scale
    );
  }
}

function drawQuadtreeCells(tree: Quadtree, depth: number): void {
  ctx.strokeStyle = '#223250';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  for (let node = tree.levelStart(depth); node < tree.levelEnd(depth); node++) {
    if (tree.getNodeTotal(node) === 0) continue;
    tree.getNodeCell(node, nodeCell);
    ctx.rect(
      toPixelX(nodeCell[0]!),
      toPixelZ(nodeCell[1]!),
      nodeCell[2]! * scale,
      nodeCell[2]! * scale
    );
  }
  ctx.stroke();
}

function drawChunkGrid(): void {
  ctx.strokeStyle = '#141c2e';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= CHUNK_GRID; i++) {
    const p = i * CHUNK_SIZE * scale;
    ctx.moveTo(p, 0);
    ctx.lineTo(p, canvas.height);
    ctx.moveTo(0, p);
    ctx.lineTo(canvas.width, p);
  }
  ctx.stroke();
}

function drawVisibleInstances(): void {
  ctx.fillStyle = '#ffd230';
  for (let i = 0; i < index.visibleInstances.length; i++) {
    const ref = index.quadtree.getRef(index.visibleInstances.at(i)) as
      | { minX: number; minZ: number; maxX: number; maxZ: number }
      | undefined;
    if (ref === undefined) continue;
    ctx.fillRect(
      toPixelX(ref.minX),
      toPixelZ(ref.minZ),
      Math.max(1.5, (ref.maxX - ref.minX) * scale),
      Math.max(1.5, (ref.maxZ - ref.minZ) * scale)
    );
  }
}

function drawFrustum(cam: ICameraSample): void {
  // Ground footprint of the frustum: apex plus the far-plane edge, swept by the
  // horizontal half-angle. Enough to read the culling against.
  const halfV = (FOV_DEGREES * Math.PI) / 360;
  const halfH = Math.atan(Math.tan(halfV) * ASPECT);
  const left = cam.yaw + halfH;
  const right = cam.yaw - halfH;

  ctx.beginPath();
  ctx.moveTo(toPixelX(cam.x), toPixelZ(cam.z));
  ctx.lineTo(
    toPixelX(cam.x - Math.sin(left) * FAR),
    toPixelZ(cam.z - Math.cos(left) * FAR)
  );
  ctx.lineTo(
    toPixelX(cam.x - Math.sin(right) * FAR),
    toPixelZ(cam.z - Math.cos(right) * FAR)
  );
  ctx.closePath();
  ctx.fillStyle = 'rgba(255, 107, 107, 0.12)';
  ctx.fill();
  ctx.strokeStyle = '#ff6b6b';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(toPixelX(cam.x), toPixelZ(cam.z), 5, 0, Math.PI * 2);
  ctx.fillStyle = '#ff6b6b';
  ctx.fill();
}

/* -------------------------------------------------------------------------- */
/* Frame                                                                      */
/* -------------------------------------------------------------------------- */

function chunkSet(list: IndexList): Set<number> {
  const set = new Set<number>();
  for (let i = 0; i < list.length; i++) set.add(list.at(i));
  return set;
}

/** Chunks the frustum alone keeps — the comparison the PVS is judged against. */
function frustumChunkSet(): Set<number> {
  const set = new Set<number>();
  const bounds = new Float64Array(6);
  for (let c = 0; c < CHUNK_COUNT; c++) {
    const node = index.quadtree.chunkNode(c);
    if (node < 0 || index.quadtree.getNodeTotal(node) === 0) continue;
    index.quadtree.getNodeBounds(node, bounds);
    if (
      scratchFrustum.testBox(
        bounds[0]!,
        bounds[1]!,
        bounds[2]!,
        bounds[3]!,
        bounds[4]!,
        bounds[5]!
      )
    ) {
      set.add(c);
    }
  }
  return set;
}

function render(): void {
  const cam = currentCamera();
  composeViewProjection(
    viewProjection,
    cam.x,
    cam.y,
    cam.z,
    cam.yaw,
    cam.pitch,
    (FOV_DEGREES * Math.PI) / 180,
    ASPECT,
    NEAR,
    FAR
  );

  index.setPvs(usePvs ? pvs : undefined);
  index.cullFromViewProjection(viewProjection, cam.x, cam.z);
  scratchFrustum.setFromViewProjection(viewProjection);
  index.quadtree.cullFrustum(scratchFrustum, frustumOnly);

  const keptChunks = chunkSet(index.visibleChunks);
  const frustumChunks = frustumChunkSet();

  ctx.fillStyle = '#06080d';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (showPvsMask) drawPvsMask(chunkIndexAt(cam.x, cam.z));
  drawChunkShading(keptChunks, frustumChunks);
  drawFootprints();
  drawQuadtreeCells(index.quadtree, overlayDepth);
  drawChunkGrid();
  drawVisibleInstances();
  drawFrustum(cam);

  writeStats(cam, keptChunks.size, frustumChunks.size);
}

function row(key: string, value: string): string {
  return `<tr><td class="k">${key}</td><td class="v">${value}</td></tr>`;
}

function writeStats(cam: ICameraSample, keptChunks: number, frustumChunks: number): void {
  const tree = index.quadtree.describe();
  const pvsStats = pvs.stats();
  const viewChunk = chunkIndexAt(cam.x, cam.z);

  statsEl.innerHTML =
    '<table>' +
    row('world', `${WORLD_SIZE} x ${WORLD_SIZE} m`) +
    row('chunks', `${CHUNK_GRID} x ${CHUNK_GRID} @ ${CHUNK_SIZE} m`) +
    row('quadtree', `depth ${index.quadtree.depth}, ${tree.nodes} nodes`) +
    row('leaf size', `${WORLD_SIZE / (1 << index.quadtree.depth)} m`) +
    row('static instances', `${tree.items}`) +
    row('index memory', `${(tree.bytes / 1024).toFixed(0)} KB`) +
    '</table><h2>PVS</h2><table>' +
    row('table size', `${pvsStats.bytes} B`) +
    row('build time', `${pvsStats.buildMs.toFixed(0)} ms`) +
    row('visible / chunk', `${pvsStats.averageVisible.toFixed(1)} of ${CHUNK_COUNT}`) +
    row('pairwise occlusion', `${(pvsStats.occlusionRate * 100).toFixed(1)}%`) +
    '</table><h2>This camera</h2><table>' +
    row('chunk', `${viewChunk}`) +
    row('position', `${cam.x.toFixed(0)}, ${cam.z.toFixed(0)}`) +
    row('yaw', `${((cam.yaw * 180) / Math.PI).toFixed(0)}&deg;`) +
    row('far plane', `${FAR} m`) +
    row('chunks: frustum', `${frustumChunks}`) +
    row('chunks: + PVS', `${keptChunks}`) +
    row('instances: frustum', `${frustumOnly.length}`) +
    row('instances: + PVS', `${index.visibleInstances.length}`) +
    row('nodes visited', `${index.cullStats.nodesVisited}`) +
    row('subtrees accepted', `${index.cullStats.nodesAccepted}`) +
    row('PVS subtree cuts', `${index.cullStats.chunksRejectedByPvs}`) +
    '</table>' +
    (report === undefined
      ? ''
      : '<h2>Sweep (220 cameras)</h2><table>' +
        row('chunks: frustum', report.chunksAfterFrustum.toFixed(2)) +
        row('chunks: + PVS', report.chunksAfterPvs.toFixed(2)) +
        row('PVS elimination', `${(report.pvsEliminationRate * 100).toFixed(1)}%`) +
        row('instances: frustum', report.instancesAfterFrustum.toFixed(1)) +
        row('instances: + PVS', report.instancesAfterPvs.toFixed(1)) +
        '</table>');
}

/* -------------------------------------------------------------------------- */
/* Control surface                                                            */
/* -------------------------------------------------------------------------- */

/** Snapshot Playwright asserts on. */
export interface ISpatialHarnessSnapshot {
  readonly instances: number;
  readonly nodes: number;
  readonly pvsBytes: number;
  readonly pvsAverageVisible: number;
  readonly viewChunk: number;
  readonly chunksFrustum: number;
  readonly chunksWithPvs: number;
  readonly instancesFrustum: number;
  readonly instancesWithPvs: number;
  readonly sweep: ICullRateReport | undefined;
}

interface ISpatialHarness {
  setCamera(i: number): void;
  nextCamera(): void;
  setOverlayDepth(depth: number): void;
  setShowPvsMask(on: boolean): void;
  setUsePvs(on: boolean): void;
  /** Find a camera whose PVS removes the most chunks — the interesting shot. */
  focusMostOccluded(): number;
  runSweep(samples?: number): ICullRateReport;
  snapshot(): ISpatialHarnessSnapshot;
}

const harness: ISpatialHarness = {
  setCamera(i: number): void {
    cameraIndex = ((i % cameras.length) + cameras.length) % cameras.length;
    render();
  },
  nextCamera(): void {
    cameraIndex = (cameraIndex + 1) % cameras.length;
    render();
  },
  setOverlayDepth(depth: number): void {
    overlayDepth = Math.max(0, Math.min(index.quadtree.depth, Math.round(depth)));
    render();
  },
  setShowPvsMask(on: boolean): void {
    showPvsMask = on;
    render();
  },
  setUsePvs(on: boolean): void {
    usePvs = on;
    render();
  },
  focusMostOccluded(): number {
    let bestIndex = 0;
    let bestGain = -1;
    const bounds = new Float64Array(6);
    for (let i = 0; i < cameras.length; i++) {
      const cam = cameras[i]!;
      composeViewProjection(
        viewProjection,
        cam.x,
        cam.y,
        cam.z,
        cam.yaw,
        cam.pitch,
        (FOV_DEGREES * Math.PI) / 180,
        ASPECT,
        NEAR,
        FAR
      );
      scratchFrustum.setFromViewProjection(viewProjection);
      let inFrustum = 0;
      let kept = 0;
      for (let c = 0; c < CHUNK_COUNT; c++) {
        const node = index.quadtree.chunkNode(c);
        if (node < 0 || index.quadtree.getNodeTotal(node) === 0) continue;
        index.quadtree.getNodeBounds(node, bounds);
        if (
          !scratchFrustum.testBox(
            bounds[0]!,
            bounds[1]!,
            bounds[2]!,
            bounds[3]!,
            bounds[4]!,
            bounds[5]!
          )
        ) {
          continue;
        }
        inFrustum++;
        if (pvs.isVisible(cam.chunk, c)) kept++;
      }
      const gain = inFrustum - kept;
      if (gain > bestGain) {
        bestGain = gain;
        bestIndex = i;
      }
    }
    cameraIndex = bestIndex;
    render();
    return bestIndex;
  },
  runSweep(samples = 220): ICullRateReport {
    report = measureCullRates(index.quadtree, pvs, cameras.slice(0, samples), {
      fovDegrees: FOV_DEGREES,
      aspect: ASPECT,
      near: NEAR,
      far: FAR,
    });
    render();
    return report;
  },
  snapshot(): ISpatialHarnessSnapshot {
    const cam = currentCamera();
    const tree = index.quadtree.describe();
    const pvsStats = pvs.stats();
    return {
      instances: tree.items,
      nodes: tree.nodes,
      pvsBytes: pvsStats.bytes,
      pvsAverageVisible: pvsStats.averageVisible,
      viewChunk: chunkIndexAt(cam.x, cam.z),
      chunksFrustum: frustumChunkSet().size,
      chunksWithPvs: index.visibleChunks.length,
      instancesFrustum: frustumOnly.length,
      instancesWithPvs: index.visibleInstances.length,
      sweep: report,
    };
  },
};

declare global {
  interface Window {
    __SPATIAL_HARNESS__?: ISpatialHarness;
    __SPATIAL_READY__?: boolean;
  }
}

harness.focusMostOccluded();
harness.runSweep();
window.__SPATIAL_HARNESS__ = harness;
window.__SPATIAL_READY__ = true;
