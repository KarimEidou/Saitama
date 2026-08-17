/**
 * THE IMPORT RULE, ENFORCED MECHANICALLY
 *
 * `src/types/events.ts` states the architectural rule of this codebase:
 *
 *     Systems import ONLY from `src/types/` and `src/util/`.
 *     A system must NEVER import another system's implementation module.
 *
 * For monsters the rule is load-bearing in an unusual way: this module is
 * downstream of combat (which decides who dies), the roster (which builds the
 * bodies), streaming (whose rings it obeys), the crowd (whose civilians it
 * threatens) and audio (which voices its roars) — and it must import NONE of
 * them, because every one of those workstreams is being built in parallel with
 * this one.
 *
 * A comment saying "do not import the roster" is worth nothing six weeks from
 * now. This file reads every source file in the module and fails on the first
 * specifier that is not on the list.
 *
 * ── WHAT IS ALLOWED, AND WHY ──────────────────────────────────────────────
 *   `@/types`   type-only contracts; erases completely at build time.
 *   `@/util`    dependency-free shared helpers, sanctioned by the rule.
 *   `three`     ALLOWED HERE, unlike in combat. This is an entity system: it
 *               owns scene nodes and drives an `ICharacterInstance`, both of
 *               which are `three` objects in the shared contract. The line is
 *               drawn instead at where `three` may appear — `monster.ts` and
 *               nowhere else, asserted below, so the FSM, the archetype table,
 *               the spawn director and all four boss scripts stay plain data
 *               and stay testable with no renderer present.
 *   `./sibling` inside the module, which is what a module IS.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MODULE_DIR = path.resolve(import.meta.dirname, '..');

/** Specifiers production code may import. Nothing else. Ever. */
const PRODUCTION_ALLOWLIST: ReadonlySet<string> = new Set(['@/types', '@/util', 'three']);

/** Additional specifiers test code may import. Enumerated, not assumed. */
const TEST_ALLOWLIST: ReadonlySet<string> = new Set(['vitest', 'node:fs', 'node:path', 'node:url']);

/**
 * Files permitted to import `three`.
 *
 * Exactly one. Behaviour is arithmetic and geometry is somebody else's
 * workstream; the moment a `Vector3` reaches the FSM or the spawn director,
 * neither can be tested without a renderer and both start carrying scene
 * state they have no business owning.
 */
const THREE_ALLOWED_FILES: ReadonlySet<string> = new Set(['monster.ts']);

/** Anything matching these must never appear, in production or in a test. */
const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /^@\/gameplay(\/|$)/,
  /^@\/entities\/npc(\/|$)/,
  /^@\/entities\/player(\/|$)/,
  /^@\/characters(\/|$)/,
  /^@\/world(\/|$)/,
  /^@\/spatial(\/|$)/,
  /^@\/audio(\/|$)/,
  /^@\/vfx(\/|$)/,
  /^@\/physics(\/|$)/,
  /^@\/engine(\/|$)/,
  /^@\/ui(\/|$)/,
];

/* -------------------------------------------------------------------------- */
/* Scanner                                                                    */
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
 * Strip block and line comments.
 *
 * Necessary, not fastidious: this module's own documentation contains the
 * sentences "`Math.random()` appears nowhere" and "'dead' is unreachable from
 * 'idle'", both of which a naive scanner reports as violations of the very
 * rules they are describing.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Every module specifier in a file: static imports, type imports, re-exports.
 *
 * The span between `import`/`export` and `from` may not contain a `;` or a
 * backtick, which is what keeps a multi-line import matching while stopping
 * the scan from running past the end of an unrelated statement and finding the
 * word "from" inside a template literal three functions later.
 */
function specifiersIn(source: string): string[] {
  const clean = stripComments(source);
  const out: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)\s[^;`]*?\sfrom\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(clean)) !== null) out.push(match[1]!);
  const bare = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  while ((match = bare.exec(clean)) !== null) out.push(match[1]!);
  const dynamic = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamic.exec(clean)) !== null) out.push(match[1]!);
  return out;
}

const FILES = sourceFiles();

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('monster module import rule', () => {
  it('finds the module source, so an empty scan cannot pass vacuously', () => {
    expect(FILES.length).toBeGreaterThan(8);
    expect(FILES).toContain('index.ts');
    expect(FILES).toContain('boss-encounter.ts');
  });

  it('imports nothing outside @/types, @/util, three and its own siblings', () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const isTest = file.startsWith('__tests__/');
      const source = readFileSync(path.join(MODULE_DIR, file), 'utf8');
      for (const specifier of specifiersIn(source)) {
        if (specifier.startsWith('.')) continue;
        if (PRODUCTION_ALLOWLIST.has(specifier)) continue;
        if (isTest && TEST_ALLOWLIST.has(specifier)) continue;
        violations.push(`${file} imports '${specifier}'`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('never imports another system, in production or in a test', () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(path.join(MODULE_DIR, file), 'utf8');
      for (const specifier of specifiersIn(source)) {
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (pattern.test(specifier)) violations.push(`${file} imports '${specifier}'`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('confines `three` to the one file that adapts behaviour to a scene node', () => {
    const violations: string[] = [];
    for (const file of FILES) {
      if (THREE_ALLOWED_FILES.has(file) || file.startsWith('__tests__/')) continue;
      const source = readFileSync(path.join(MODULE_DIR, file), 'utf8');
      for (const specifier of specifiersIn(source)) {
        if (/^three(\/|$)/.test(specifier)) violations.push(`${file} imports '${specifier}'`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('never calls Math.random — the world must replay from a seed', () => {
    const violations: string[] = [];
    for (const file of FILES) {
      const source = stripComments(readFileSync(path.join(MODULE_DIR, file), 'utf8'));
      if (/Math\s*\.\s*random\s*\(/.test(source)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });
});
