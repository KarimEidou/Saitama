/**
 * Browser entry point for the offline render harness.
 *
 * Bundled by `__tests__/browser-harness.ts` and injected into a headless
 * Chromium page, where it exposes the probe API on the global object. It is
 * never part of the game bundle — nothing in `src/main.ts` reaches it.
 */

import { installProbeApi } from './offline-probe';

installProbeApi();
