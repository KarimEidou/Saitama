/**
 * BINARY GUARD
 *
 * Every regression here is a SILENT bypass: the guard printed "binary guard OK"
 * over a tree holding exactly what it exists to reject. That is worse than no
 * guard at all, because the whole point of the script is that nobody has to
 * remember the rule — so the tests drive the real script against real scratch
 * repositories rather than unit-testing a predicate.
 *
 * The four holes covered:
 *   1. `core.quotePath` — a path with an accent arrives C-quoted, matches no
 *      file on disk, and is dropped by BOTH rules without appearing anywhere.
 *   2. Staged then deleted — the FORMAT rule needs only the path, but ran
 *      behind an `existsSync` that a deleted-but-staged file fails.
 *   3. Staged blob vs working copy — a 200 MB blob behind a stub file passed
 *      the SIZE rule, because the size came from the filesystem.
 *   4. Run from a subdirectory — `ls-files` printed cwd-relative paths for the
 *      subtree while `diff --cached` printed root-relative ones, so almost
 *      nothing was checked.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = path.join(ROOT, 'scripts', 'guard-no-binaries.ts');
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');

/** Every scratch repository made during a test, torn down in `afterEach`. */
const scratch: string[] = [];

function git(repo: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
}

/** A fresh repository. Nothing is committed: `ls-files` reads the index. */
function freshRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'guard-'));
  scratch.push(repo);
  git(repo, ['init', '--quiet']);
  return repo;
}

interface IRun {
  readonly status: number;
  readonly output: string;
}

/** Run the guard exactly as a hook or CI step would, from `cwd`. */
function runGuard(cwd: string): IRun {
  const result = spawnSync(TSX, [GUARD], { cwd, encoding: 'utf8' });
  return { status: result.status ?? -1, output: `${result.stdout}${result.stderr}` };
}

afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true });
});

describe('guard-no-binaries', () => {
  it('passes a repository holding only text', () => {
    const repo = freshRepo();
    writeFileSync(path.join(repo, 'notes.md'), '# notes\n');
    git(repo, ['add', 'notes.md']);

    const run = runGuard(repo);
    expect(run.output).toContain('binary guard OK');
    expect(run.status).toBe(0);
  });

  it('rejects a forbidden extension on a path git quotes', () => {
    // `core.quotePath` defaults to true, so this arrives as the literal
    // 18-character string `"h\303\251ro.png"` unless the listing is NUL-delimited.
    const repo = freshRepo();
    writeFileSync(path.join(repo, 'héro.png'), 'not really a png');
    git(repo, ['add', '--', 'héro.png']);

    const run = runGuard(repo);
    expect(run.status).toBe(1);
    expect(run.output).toContain('[format]');
    expect(run.output).toContain('héro.png');
  });

  it('rejects a binary that is staged and then deleted from the working tree', () => {
    // The FORMAT rule needs nothing but the path, and this path is going into
    // the commit whether or not a file still sits behind it.
    const repo = freshRepo();
    writeFileSync(path.join(repo, 'city.glb'), 'glTF');
    git(repo, ['add', 'city.glb']);
    rmSync(path.join(repo, 'city.glb'));

    const run = runGuard(repo);
    expect(run.status).toBe(1);
    expect(run.output).toContain('[format]');
    expect(run.output).toContain('city.glb');
  });

  it('measures the staged blob, not a stub left in the working tree', () => {
    const repo = freshRepo();
    const file = path.join(repo, 'huge.json');
    writeFileSync(file, `{"pad":"${'x'.repeat(6 * 1024 * 1024)}"}`);
    git(repo, ['add', 'huge.json']);
    writeFileSync(file, '{}');

    const run = runGuard(repo);
    expect(run.status).toBe(1);
    expect(run.output).toContain('[size]');
    expect(run.output).toContain('staged blob');
  });

  it('checks the whole repository when run from a subdirectory', () => {
    const repo = freshRepo();
    writeFileSync(path.join(repo, 'city.glb'), 'glTF');
    git(repo, ['add', 'city.glb']);
    mkdirSync(path.join(repo, 'sub'));
    writeFileSync(path.join(repo, 'sub', 'inner.ts'), 'export const x = 1;\n');
    git(repo, ['add', path.join('sub', 'inner.ts')]);

    const run = runGuard(path.join(repo, 'sub'));
    expect(run.status).toBe(1);
    expect(run.output).toContain('city.glb');
  });

  it('still exempts the documentation screenshot directory', () => {
    const repo = freshRepo();
    mkdirSync(path.join(repo, 'docs', 'screenshots'), { recursive: true });
    writeFileSync(path.join(repo, 'docs', 'screenshots', 'boot.png'), 'small');
    git(repo, ['add', path.join('docs', 'screenshots', 'boot.png')]);

    const run = runGuard(repo);
    expect(run.output).toContain('binary guard OK');
    expect(run.status).toBe(0);
  });

  it('exempts the committed app-icon master', () => {
    // `scripts/make-icons.ts` derives every home-screen size FROM this file, so
    // losing it loses the artwork — there is no manifest to re-fetch it from.
    const repo = freshRepo();
    mkdirSync(path.join(repo, 'assets', 'icon'), { recursive: true });
    writeFileSync(path.join(repo, 'assets', 'icon', 'icon-source.png'), 'small');
    git(repo, ['add', path.join('assets', 'icon', 'icon-source.png')]);

    const run = runGuard(repo);
    expect(run.output).toContain('binary guard OK');
    expect(run.status).toBe(0);
  });

  it('holds the size ceiling inside assets/icon/', () => {
    // The exemption is FORMAT-only. It buys the icon master a `.png` extension,
    // not a hole in the rule that keeps history from growing without bound.
    const repo = freshRepo();
    mkdirSync(path.join(repo, 'assets', 'icon'), { recursive: true });
    writeFileSync(
      path.join(repo, 'assets', 'icon', 'icon-source.png'),
      'x'.repeat(6 * 1024 * 1024)
    );
    git(repo, ['add', path.join('assets', 'icon', 'icon-source.png')]);

    const run = runGuard(repo);
    expect(run.status).toBe(1);
    expect(run.output).toContain('[size]');
    expect(run.output).toContain('icon-source.png');
  });

  it('does not exempt a sibling of the icon directory', () => {
    // `startsWith` on a normalised path: `assets/icons/` and `assets/icon-x/`
    // are different directories and must both still be rejected.
    const repo = freshRepo();
    mkdirSync(path.join(repo, 'assets', 'icons'), { recursive: true });
    writeFileSync(path.join(repo, 'assets', 'icons', 'stray.png'), 'small');
    git(repo, ['add', path.join('assets', 'icons', 'stray.png')]);

    const run = runGuard(repo);
    expect(run.status).toBe(1);
    expect(run.output).toContain('[format]');
    expect(run.output).toContain('stray.png');
  });
});
