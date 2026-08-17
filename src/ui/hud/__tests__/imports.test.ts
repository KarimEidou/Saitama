/**
 * THE IMPORT RULE, ENFORCED MECHANICALLY
 *
 * `src/types/events.ts` states the architectural rule of this codebase:
 *
 *     Systems import ONLY from `src/types/` and `src/util/`.
 *     A system must NEVER import another system's implementation module.
 *
 * For the HUD the temptation to break it is constant and specific. Every screen
 * here renders somebody else's numbers, and every one of them would be easier
 * to write with a direct import: `BOREDOM_RANK_FLOOR` from progression, the
 * zoning table from combat, `THUMB_ARC` from the input overlay. Each of those
 * would turn a display layer into a build dependency of a gameplay system, and
 * the parallel build stops working the day one of them changes.
 *
 * So the HUD subscribes to the bus, takes explicit pushes for what the bus
 * cannot carry, and MIRRORS the two constants it needs for display with the
 * mirror documented at the site. This file fails the build on the first
 * specifier that is not on the list.
 *
 * ── WHAT IS ALLOWED, AND WHY ───────────────────────────────────────────────
 *   `@/types`                              type-only contracts.
 *   `@/util`                               dependency-free shared helpers.
 *   `three` + `CSS2DRenderer`              markers.ts only. Positioning DOM
 *                                          against a camera is exactly what
 *                                          the addon is for, and re-deriving a
 *                                          projection here would be a second,
 *                                          worse copy of it.
 *   `@fontsource/*`                        fonts.ts only. CSS, no code.
 *   `./sibling`                            inside the module, which is what a
 *                                          module IS.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MODULE_DIR = path.resolve(import.meta.dirname, '..');

/** Specifiers any production file may import. */
const PRODUCTION_ALLOWLIST: ReadonlySet<string> = new Set(['@/types', '@/util']);

/** Specifiers allowed only in the named file. */
const FILE_EXEMPTIONS: Readonly<Record<string, readonly string[]>> = {
  'markers.ts': ['three', 'three/examples/jsm/renderers/CSS2DRenderer.js'],
  'fonts.ts': ['@fontsource/bebas-neue/400.css', '@fontsource/inter/400.css', '@fontsource/inter/600.css'],
};

const TEST_ALLOWLIST: ReadonlySet<string> = new Set([
  'vitest',
  'node:fs',
  'node:path',
  'node:url',
]);

/**
 * Never, anywhere in this module — including in a test.
 *
 * `@/ui/input` is on the list even though the HUD sits beside it in `src/ui/`:
 * the input layer owns the stick and the buttons, the HUD owns everything else,
 * and the moment the HUD reads the input layer's geometry directly the two stop
 * being separable. The harness may import it (it does, to prove the HUD clears
 * the thumb arc); the module may not.
 */
const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /^@\/gameplay(\/|$)/,
  /^@\/entities(\/|$)/,
  /^@\/world(\/|$)/,
  /^@\/engine(\/|$)/,
  /^@\/vfx(\/|$)/,
  /^@\/audio(\/|$)/,
  /^@\/physics(\/|$)/,
  /^@\/spatial(\/|$)/,
  /^@\/characters(\/|$)/,
  /^@\/ui\/input(\/|$)/,
];

/* -------------------------------------------------------------------------- */

function sourceFiles(dir = MODULE_DIR, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith('.ts')) out.push(rel);
  }
  return out.sort();
}

/**
 * Remove comments before scanning.
 *
 * Without this the scanner would flag the prose in `store.ts` explaining WHY
 * progression's boredom curve is mirrored rather than imported — punishing the
 * documentation of the rule it enforces.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function importsOf(source: string): string[] {
  const code = stripComments(source);
  const found: string[] = [];
  const patterns: readonly RegExp[] = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) found.push(match[1]!);
  }
  return found;
}

const isTestFile = (file: string): boolean => file.startsWith('__tests__/');
const isRelative = (specifier: string): boolean => specifier.startsWith('.');

function escapesModule(file: string, specifier: string): boolean {
  const resolved = path.resolve(MODULE_DIR, path.dirname(file), specifier);
  return !resolved.startsWith(MODULE_DIR);
}

/* -------------------------------------------------------------------------- */

describe('the HUD imports nothing but its contracts', () => {
  const files = sourceFiles();

  it('finds the module on disk', () => {
    expect(files.length).toBeGreaterThan(12);
    expect(files).toContain('manager.ts');
    expect(files).toContain('store.ts');
    expect(files).toContain('screens/combat-hud.ts');
  });

  it('has NO production file importing outside the allowlist', () => {
    const violations: string[] = [];
    for (const file of files) {
      if (isTestFile(file)) continue;
      const source = readFileSync(path.join(MODULE_DIR, file), 'utf8');
      const exempt = new Set(FILE_EXEMPTIONS[file] ?? []);
      for (const specifier of importsOf(source)) {
        if (isRelative(specifier)) {
          if (escapesModule(file, specifier)) {
            violations.push(`${file}: relative import escapes the module -> "${specifier}"`);
          }
          continue;
        }
        if (PRODUCTION_ALLOWLIST.has(specifier) || exempt.has(specifier)) continue;
        violations.push(`${file}: forbidden import -> "${specifier}"`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('never imports another gameplay system, in production or in a test', () => {
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(path.join(MODULE_DIR, file), 'utf8');
      for (const specifier of importsOf(source)) {
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (pattern.test(specifier)) violations.push(`${file}: "${specifier}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('confines three to the marker layer', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file === 'markers.ts') continue;
      const source = readFileSync(path.join(MODULE_DIR, file), 'utf8');
      for (const specifier of importsOf(source)) {
        if (/^three(\/|$)/.test(specifier)) offenders.push(`${file}: "${specifier}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps test files on their own allowlist', () => {
    const violations: string[] = [];
    for (const file of files) {
      if (!isTestFile(file)) continue;
      const source = readFileSync(path.join(MODULE_DIR, file), 'utf8');
      for (const specifier of importsOf(source)) {
        if (isRelative(specifier) || TEST_ALLOWLIST.has(specifier)) continue;
        if (PRODUCTION_ALLOWLIST.has(specifier)) continue;
        violations.push(`${file}: "${specifier}"`);
      }
    }
    expect(violations).toEqual([]);
  });
});
