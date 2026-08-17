/**
 * LAZY RAPIER LOADER
 *
 * `@dimforge/rapier3d-compat` ships its 2 MB WebAssembly module INLINED AS
 * BASE64 inside a ~2.8 MB JavaScript file. A static `import` of that package
 * therefore lands in the entry chunk and is parsed, decoded and instantiated
 * before the first frame can present — on a mid-tier Android phone that is
 * hundreds of milliseconds of blank screen.
 *
 * So the package is NEVER statically imported anywhere in `src/`. The only
 * runtime reference to it is the `await import()` below, which Vite splits
 * into its own chunk that is fetched after the boot screen is up. Every other
 * physics module imports from it with `import type`, which erases completely.
 *
 * Callers:
 *   await initPhysics();            // once, during boot, off the critical path
 *   const world = new RapierPhysicsWorld();   // everything after assumes init
 *
 * `initPhysics()` is idempotent and safe to call concurrently: the in-flight
 * promise is shared, so N systems awaiting it produce exactly one wasm
 * instantiation.
 */

import type * as RapierNamespace from '@dimforge/rapier3d-compat';

/**
 * The Rapier module namespace, obtained only via `initPhysics()`.
 *
 * Exposed so wrapper code can take the module as a parameter rather than
 * reaching for a global.
 */
export type Rapier = typeof RapierNamespace;

let loadingPromise: Promise<Rapier> | undefined;
let loadedModule: Rapier | undefined;
let initDurationMs = 0;

/**
 * Load and initialise Rapier. Resolves with the module namespace.
 *
 * Idempotent: repeat calls return the same promise (or an already-resolved one)
 * and never re-instantiate the wasm module. A failed load clears the cached
 * promise so a later call can retry.
 */
export function initPhysics(): Promise<Rapier> {
  if (loadedModule !== undefined) return Promise.resolve(loadedModule);
  if (loadingPromise !== undefined) return loadingPromise;

  const started = now();
  const promise = (async (): Promise<Rapier> => {
    const mod = await import('@dimforge/rapier3d-compat');
    // Decodes the inlined base64 payload and instantiates the wasm module.
    await mod.init();
    loadedModule = mod;
    initDurationMs = now() - started;
    return mod;
  })();

  loadingPromise = promise.catch((error: unknown) => {
    // Allow a retry after a transient failure (chunk fetch aborted, OOM…).
    loadingPromise = undefined;
    throw error;
  });

  return loadingPromise;
}

/**
 * The already-initialised module.
 *
 * Throws when physics has not been initialised — a loud failure at construction
 * time is far easier to diagnose than a null dereference three frames later.
 */
export function getRapier(): Rapier {
  if (loadedModule === undefined) {
    throw new Error(
      'Physics used before initialisation. `await initPhysics()` during boot ' +
        'before constructing a physics world.'
    );
  }
  return loadedModule;
}

/** True once the wasm module is live. Never triggers a load. */
export function isPhysicsReady(): boolean {
  return loadedModule !== undefined;
}

/** Milliseconds spent loading + instantiating Rapier. 0 until initialised. */
export function physicsInitDurationMs(): number {
  return initDurationMs;
}

/** Monotonic clock that also works in a plain Node/vitest process. */
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * TEST-ONLY. Drops the cached module so a suite can exercise the loading path
 * again. Does not tear down the wasm instance — Rapier has no such API.
 */
export function __resetPhysicsLoaderForTests(): void {
  loadedModule = undefined;
  loadingPromise = undefined;
  initDurationMs = 0;
}
