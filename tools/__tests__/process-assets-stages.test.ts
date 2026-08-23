/**
 * STAGE RESOLUTION
 *
 * `loadStage` used to swallow ANY failure to import `./process-models.ts` — a
 * missing dependency, a syntax error, a throwing module-scope statement, a
 * renamed export — into a warning and return `undefined`. `main()` then skipped
 * the stage, wrote a runtime index with no model outputs at all, and exited 0.
 *
 * The rationale was correct when it was written: `process-models.ts` belonged
 * to another workstream and might not exist yet. It exists, exports
 * `processModels`, and produces the 39 `.glb` files the game needs, so the
 * degradation now only converts a hard failure into a silently incomplete
 * build.
 *
 * The happy-path cases below are a real regression test in their own right:
 * they fail the moment a stage stops exporting its entry point, which used to
 * produce nothing but a warning buried in a build log.
 *
 * Importing the model stage pulls in `@gltf-transform/*`, `meshoptimizer` and
 * `sharp` — about a second of module loading. Nothing else happens: no `ktx`
 * invocation and no filesystem write occurs at module scope.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadStage } from '../process-assets.ts';

afterEach(() => {
  vi.doUnmock('../process-models.ts');
  vi.resetModules();
});

describe('loadStage', () => {
  it.each(['textures', 'hdri', 'models'] as const)('resolves the %s stage', async (name) => {
    expect(typeof (await loadStage(name))).toBe('function');
  });

  it('returns a stage function, not a re-exported constant', () => {
    // Cheap shape check: every stage takes an options object.
    return expect(loadStage('models').then((fn) => fn.length)).resolves.toBeGreaterThanOrEqual(1);
  });

  it('fails the build when the model stage exports no entry point', async () => {
    // The behaviour change: this used to log a warning, skip the stage, write a
    // runtime index containing no models, and exit 0.
    vi.resetModules();
    vi.doMock('../process-models.ts', () => ({ processModels: undefined }));

    const { loadStage: reloaded } = await import('../process-assets.ts');
    await expect(reloaded('models')).rejects.toThrow(/does not export processModels/);
  });

  it('fails the build when the model stage cannot be imported at all', async () => {
    vi.resetModules();
    vi.doMock('../process-models.ts', () => {
      throw new Error('a missing dependency');
    });

    // The import error itself is wrapped by the mocking layer, so only the
    // propagation is asserted — which is the whole behaviour under test.
    const { loadStage: reloaded } = await import('../process-assets.ts');
    await expect(reloaded('models')).rejects.toThrow();
  });
});
