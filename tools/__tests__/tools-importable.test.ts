/**
 * Importing a tool must not RUN it.
 *
 * Both modules used to call `main()` at module scope, which is why neither had
 * tests: a test that imported `build-characters.ts` baked 14 characters, and
 * one that imported `attribution.ts` rewrote ATTRIBUTION.md. The guard is one
 * line and silently reverts, so it gets a test that fails loudly if it ever
 * does.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('tools are importable', () => {
  it('importing build-characters.ts runs nothing', async () => {
    const mod = await import('../build-characters.ts');
    expect(typeof mod.parseArgs).toBe('function');
  });

  it('importing attribution.ts runs nothing and does not touch ATTRIBUTION.md', async () => {
    const before = readFileSync(path.join(ROOT, 'ATTRIBUTION.md'), 'utf8');
    const mod = await import('../attribution.ts');
    expect(typeof mod.auditCharacters).toBe('function');
    expect(readFileSync(path.join(ROOT, 'ATTRIBUTION.md'), 'utf8')).toBe(before);
  });
});
