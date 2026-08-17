/**
 * THE IMPORT RULE, ENFORCED MECHANICALLY
 *
 * `src/types/events.ts` states the architectural rule of this codebase:
 *
 *     Systems import ONLY from `src/types/` and `src/util/`.
 *     A system must NEVER import another system's implementation module.
 *
 * For this workstream the rule is the load-bearing one. The combat resolver is
 * what VFX, destruction, audio, physics, the renderer and the quest system all
 * hang off; if it reaches back into any of them, none of those workstreams can
 * be built, tested or replaced independently, and the parallel build stops
 * working.
 *
 * A comment saying "do not import anything" is worth nothing at 3 a.m. six
 * weeks from now. This file reads every source file in the module and fails
 * the build on the first specifier that is not on the list.
 *
 * ── WHAT IS ALLOWED, AND WHY ───────────────────────────────────────────────
 *   `@/types`     type-only contracts; erases completely at build time.
 *   `@/util`      dependency-free shared helpers, sanctioned by the rule.
 *   `./sibling`   inside the module, which is what a module IS.
 *
 * NOT allowed, and specifically checked for: `three`. Even a type-only import
 * of it would be harmless at runtime, but taking it means the resolver's data
 * shapes start carrying `Vector3` instances, and then the bus payloads do, and
 * then the rule about payloads being plain data is gone. Combat speaks `Vec3`.
 *
 * ── THE ONE EXEMPTION, STATED OUT LOUD ─────────────────────────────────────
 * Test files may additionally import `vitest`, node's own `fs`/`path`/`url`,
 * and `@/ui/input` — the verified synthetic input driver, which the brief
 * requires a full encounter to be scripted through. Test code ships in no
 * bundle and the exemption is enumerated here rather than assumed.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** The module under enforcement. */
const MODULE_DIR = path.resolve(import.meta.dirname, '..');

/** Specifiers production code may import. Nothing else. Ever. */
const PRODUCTION_ALLOWLIST: ReadonlySet<string> = new Set(['@/types', '@/util']);

/** Additional specifiers test code may import. Enumerated, not assumed. */
const TEST_ALLOWLIST: ReadonlySet<string> = new Set([
  'vitest',
  'node:fs',
  'node:path',
  'node:url',
  // The synthetic input driver. The brief requires a scripted encounter, and
  // the input workstream's own documentation names this as THE entry point.
  '@/ui/input',
]);

/** Anything matching these must never appear, in production or in a test. */
const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /^three(\/|$)/,
  /^@\/vfx(\/|$)/,
  /^@\/gameplay\/destruction(\/|$)/,
  /^@\/audio(\/|$)/,
  /^@\/physics(\/|$)/,
  /^@\/engine(\/|$)/,
  /^@\/entities(\/|$)/,
  /^@\/world(\/|$)/,
  /^@\/spatial(\/|$)/,
  /^@\/characters(\/|$)/,
];

/* -------------------------------------------------------------------------- */
/* Scanner                                                                    */
/* -------------------------------------------------------------------------- */

/** Every `.ts` file in the module, recursively, relative to `MODULE_DIR`. */
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
 * Without this the scanner would flag the prose in `cone.ts` that explains WHY
 * `src/spatial`'s predicate is mirrored rather than imported — i.e. it would
 * punish the documentation of the very rule it enforces.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Every module specifier a file imports, by any syntax. */
function importsOf(source: string): string[] {
  const code = stripComments(source);
  const found: string[] = [];
  const patterns: readonly RegExp[] = [
    // `import x from 'y'`, `import type {a} from 'y'`, `export * from 'y'`
    /\bfrom\s*['"]([^'"]+)['"]/g,
    // `import 'y'` (side effect)
    /\bimport\s+['"]([^'"]+)['"]/g,
    // `import('y')`
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    // `require('y')`
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) found.push(match[1]!);
  }
  return found;
}

const isTestFile = (file: string): boolean => file.startsWith('__tests__/');
const isRelative = (specifier: string): boolean => specifier.startsWith('.');

/** A relative specifier that climbs out of the module is an import of another system. */
function escapesModule(file: string, specifier: string): boolean {
  const resolved = path.resolve(MODULE_DIR, path.dirname(file), specifier);
  return !resolved.startsWith(MODULE_DIR);
}

/* -------------------------------------------------------------------------- */
/* The tests                                                                  */
/* -------------------------------------------------------------------------- */

describe('the combat module imports nothing but @/types and @/util', () => {
  const files = sourceFiles();

  it('finds the module on disk', () => {
    expect(files.length).toBeGreaterThan(8);
    expect(files).toContain('resolver.ts');
    expect(files).toContain('cone.ts');
    expect(files).toContain('combat-system.ts');
  });

  it('has NO production file importing anything outside the allowlist', () => {
    const violations: string[] = [];

    for (const file of files) {
      if (isTestFile(file)) continue;
      const source = readFileSync(path.join(MODULE_DIR, file), 'utf8');
      for (const specifier of importsOf(source)) {
        if (isRelative(specifier)) {
          if (escapesModule(file, specifier)) {
            violations.push(`${file}: relative import escapes the module -> "${specifier}"`);
          }
          continue;
        }
        if (!PRODUCTION_ALLOWLIST.has(specifier)) {
          violations.push(`${file}: forbidden import -> "${specifier}"`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('never imports three — not even type-only', () => {
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(path.join(MODULE_DIR, file), 'utf8');
      for (const specifier of importsOf(source)) {
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (pattern.test(specifier)) violations.push(`${file} -> "${specifier}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps the test exemption to the enumerated list', () => {
    const violations: string[] = [];
    for (const file of files) {
      if (!isTestFile(file)) continue;
      const source = readFileSync(path.join(MODULE_DIR, file), 'utf8');
      for (const specifier of importsOf(source)) {
        if (isRelative(specifier)) {
          if (escapesModule(file, specifier)) {
            violations.push(`${file}: relative import escapes the module -> "${specifier}"`);
          }
          continue;
        }
        if (!PRODUCTION_ALLOWLIST.has(specifier) && !TEST_ALLOWLIST.has(specifier)) {
          violations.push(`${file}: forbidden import -> "${specifier}"`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('reports the complete external import surface, so a reviewer can see it', () => {
    const external = new Set<string>();
    for (const file of files) {
      if (isTestFile(file)) continue;
      const source = readFileSync(path.join(MODULE_DIR, file), 'utf8');
      for (const specifier of importsOf(source)) {
        if (!isRelative(specifier)) external.add(specifier);
      }
    }
    // The WHOLE dependency surface of the one-punch combat system.
    expect([...external].sort()).toEqual(['@/types', '@/util']);
  });

  it('would catch a violation if one were introduced', () => {
    // Proof the scanner is not vacuous: a synthetic file with forbidden
    // imports must be flagged by the same code path the real files run through.
    //
    // The keyword is spliced in at runtime rather than written literally,
    // because this file is itself one of the files the scanner reads — a
    // verbatim `from 'three'` here would be a real violation of this module's
    // own rule, and the test that proves the scanner works would be the one
    // thing that breaks it.
    const kw = 'fr' + 'om';
    const fake = [
      `import * as THREE ${kw} 'three';`,
      `import { VfxSystem } ${kw} '@/vfx';`,
      `import { detach } ${kw} '../../destruction/detach';`,
      `import { clamp01 } ${kw} '@/util';`,
    ].join('\n');
    const specifiers = importsOf(fake);
    expect(specifiers).toEqual(['three', '@/vfx', '../../destruction/detach', '@/util']);

    const flagged = specifiers.filter((specifier) =>
      isRelative(specifier)
        ? escapesModule('resolver.ts', specifier)
        : !PRODUCTION_ALLOWLIST.has(specifier)
    );
    expect(flagged).toEqual(['three', '@/vfx', '../../destruction/detach']);
  });

  it('the emitted-event surface is the whole of the outbound contract', () => {
    // Every `this.emit(...)` / `bus.emit(...)` target in production code. If a
    // new one appears, this list is where a reviewer finds out.
    const emitted = new Set<string>();
    for (const file of files) {
      if (isTestFile(file)) continue;
      const source = stripComments(readFileSync(path.join(MODULE_DIR, file), 'utf8'));
      for (const match of source.matchAll(/\.emit\(\s*'([A-Za-z]+)'/g)) emitted.add(match[1]!);
    }
    expect([...emitted].sort()).toEqual([
      'AllyDowned',
      'BoredomChanged',
      'CivilianLost',
      'CivilianSaved',
      'EncounterEnded',
      'EntityDamaged',
      'EntityKilled',
      'ImpulseApplied',
      'ShockwaveFired',
    ]);
  });
});
