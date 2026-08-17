/**
 * CHUNK GEOMETRY WORKER
 *
 * The entry point for the two background threads that build the city.
 *
 * ── WHAT THIS FILE MAY IMPORT ──────────────────────────────────────────────
 * Only pure computation: the deterministic layout, the geometry emitters, the
 * seeded RNG and the chunk-addressing constants. Emphatically NOT `three`.
 *
 * A worker that imports three drags in the whole WebGL renderer — the shader
 * library, the material system, the loaders — and parses it a second time, per
 * worker, on a device where JavaScript parse time is the scarcest resource on
 * the critical path. There is also nothing for it to do there: a worker has no
 * GL context, so every `BufferGeometry` it built would be a plain object it
 * then had to copy across the boundary anyway. Building raw typed arrays and
 * TRANSFERRING them means the main thread's entire share of the work is
 * `new THREE.BufferAttribute(transferredArray, 3)`, which allocates nothing.
 *
 * ── THE GENERATOR SEAM ─────────────────────────────────────────────────────
 * Jobs name their generator by id, because functions cannot cross a
 * `postMessage`. The city-generation workstream plugs in by calling
 * `registerChunkGenerator('city', ...)` from a module this file imports; the
 * streaming system then sets `generator: 'city'` on its jobs and nothing else
 * changes. Until then the built-in procedural block city stands in.
 */

import { buildChunkGeometry, buildImpostorGeometry } from './chunk-geometry';
import type {
  IChunkBuildResult,
  IImpostorBuildResult,
  WorkerRequest,
  WorkerResponse,
} from './protocol';
import { geometryTransferables } from './protocol';

/* -------------------------------------------------------------------------- */
/* Worker scope                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Minimal structural type for a dedicated worker's global scope.
 *
 * Declared locally rather than using `DedicatedWorkerGlobalScope`, because that
 * type only exists with the full `WebWorker` lib enabled and `tsconfig.json`
 * (owned by the bootstrap workstream) enables only `WebWorker.ImportScripts`.
 * The two members used here are the two members that matter.
 */
interface IWorkerScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, options?: { transfer?: Transferable[] }): void;
}

/* -------------------------------------------------------------------------- */
/* Generator registry                                                         */
/* -------------------------------------------------------------------------- */

/** A chunk generator: seed and address in, transferable buffers out. */
export type ChunkGeneratorFn = (
  seed: number,
  cx: number,
  cz: number,
  ring: number,
  damage: Uint32Array | undefined
) => Omit<IChunkBuildResult, 'id'>;

/** An impostor baker: seed in, the whole world's silhouette out. */
export type ImpostorGeneratorFn = (seed: number) => Omit<IImpostorBuildResult, 'id'>;

/** Id of the generator this workstream ships. */
export const DEFAULT_GENERATOR = 'procedural-block-city';

const chunkGenerators = new Map<string, ChunkGeneratorFn>([
  [DEFAULT_GENERATOR, buildChunkGeometry],
]);

const impostorGenerators = new Map<string, ImpostorGeneratorFn>([
  [DEFAULT_GENERATOR, buildImpostorGeometry],
]);

/** Register a generator. Called from worker-side module init, never over the wire. */
export function registerChunkGenerator(
  id: string,
  chunk: ChunkGeneratorFn,
  impostor: ImpostorGeneratorFn
): void {
  chunkGenerators.set(id, chunk);
  impostorGenerators.set(id, impostor);
}

/* -------------------------------------------------------------------------- */
/* Request handling                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Execute one request. Exported and side-effect free so the inline fallback in
 * `worker-pool.ts` runs the exact same code path the workers do — a fallback
 * that diverges from the real path is a fallback that hides bugs.
 */
export function handleRequest(request: WorkerRequest): WorkerResponse {
  try {
    if (request.kind === 'ping') {
      return { kind: 'pong', id: request.id };
    }
    if (request.kind === 'impostor') {
      const generator = impostorGenerators.get(request.generator);
      if (generator === undefined) {
        return { kind: 'error', id: request.id, message: `unknown generator "${request.generator}"` };
      }
      return { ...generator(request.seed), id: request.id };
    }
    const generator = chunkGenerators.get(request.generator);
    if (generator === undefined) {
      return { kind: 'error', id: request.id, message: `unknown generator "${request.generator}"` };
    }
    return {
      ...generator(request.seed, request.cx, request.cz, request.ring, request.damage),
      id: request.id,
    };
  } catch (error) {
    return { kind: 'error', id: request.id, message: String(error) };
  }
}

/** Buffers to hand to the transfer list for a response. */
export function responseTransferables(response: WorkerResponse): Transferable[] {
  if (response.kind === 'chunk') return geometryTransferables(response.buffers);
  if (response.kind === 'impostor') {
    return [...geometryTransferables(response.buffers), response.chunkIds.buffer as ArrayBuffer];
  }
  return [];
}

/* -------------------------------------------------------------------------- */
/* Wiring                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Install the message handler when this module is actually running as a worker.
 *
 * Guarded because the module is also imported by `worker-pool.ts` on the main
 * thread for its inline fallback, where `self` is the window and hijacking
 * `window.onmessage` would break every other listener on the page.
 */
const scope = typeof self !== 'undefined' ? (self as unknown as IWorkerScope) : undefined;

/**
 * `window` is absent inside any worker and present on every main thread, and
 * `self` is absent in bare Node. Deliberately NOT `typeof importScripts`: that
 * classic-worker global does not exist in a module worker, which is exactly
 * what this is.
 */
const isWorkerScope = scope !== undefined && typeof window === 'undefined';

if (scope !== undefined && isWorkerScope) {
  scope.onmessage = (event: MessageEvent): void => {
    const response = handleRequest(event.data as WorkerRequest);
    scope.postMessage(response, { transfer: responseTransferables(response) });
  };
}
