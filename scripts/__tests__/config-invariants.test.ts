/**
 * ROOT CONFIG INVARIANTS
 *
 * Four couplings between the root config files are stated in comments and
 * enforced by nothing. Every one of them fails green: a typecheck that passes
 * while the bundler resolves something else, a `cap sync` that copies an empty
 * directory, a build that only 404s on a phone.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import viteConfig from '../../vite.config';
import capacitorConfig from '../../capacitor.config';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** tsconfig.json is JSONC — it carries block comments, so JSON.parse cannot read it. */
function readTsconfig(): { compilerOptions?: { paths?: Record<string, readonly string[]> } } {
  const text = readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8');
  const parsed = ts.parseConfigFileTextToJson('tsconfig.json', text);
  expect(parsed.error).toBeUndefined();
  return parsed.config as { compilerOptions?: { paths?: Record<string, readonly string[]> } };
}

describe('root config invariants', () => {
  it('resolves `@` to src/ identically in tsconfig.json and vite.config.ts', () => {
    expect(readTsconfig().compilerOptions?.paths?.['@/*']).toEqual(['./src/*']);

    const alias = viteConfig.resolve?.alias as Record<string, string> | undefined;
    expect(alias?.['@']).toBe(path.join(ROOT, 'src'));
  });

  it('points capacitor webDir at vite build.outDir — cap sync copies that directory', () => {
    expect(capacitorConfig.webDir).toBe(viteConfig.build?.outDir);
  });

  it('keeps base relative: Capacitor file:// and the Pages sub-path both 404 on a leading /', () => {
    expect(viteConfig.base).toBe('./');
  });

  it('inlines no assets: base64 in JS spends the mobile parse budget twice', () => {
    expect(viteConfig.build?.assetsInlineLimit).toBe(0);
  });
});
