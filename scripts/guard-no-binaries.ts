/**
 * BINARY GUARD
 *
 * Makes GitHub's 100 MB hard limit STRUCTURALLY unreachable rather than
 * something 30+ parallel agents have to remember to avoid.
 *
 * Two rules, enforced over files git actually tracks (plus anything staged):
 *
 *   1. SIZE   — no tracked file may exceed MAX_FILE_BYTES (5 MB).
 *   2. FORMAT — no tracked file may carry a binary game-asset extension,
 *               except inside the allow-listed documentation directory.
 *
 * Game binaries are REPRODUCIBLE: `assets/source/` is re-fetchable and
 * `assets/generated/` is re-derivable via `npm run assets`. Committing them
 * buys nothing and permanently bloats history — a repo cannot be un-fattened
 * without a force-push rewrite, so the cheap fix is to never let it happen.
 *
 * Run: `npm run guard`   (also suitable for a pre-commit hook / CI step)
 * Exit code 0 = clean, 1 = violations found.
 */

import { execFileSync } from 'node:child_process';
import { statSync, existsSync } from 'node:fs';
import path from 'node:path';

/** Hard ceiling for any single tracked file. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Extensions that must never be committed (lowercase, with dot). */
const FORBIDDEN_EXTENSIONS = new Set([
  '.ktx2',
  '.glb',
  '.gltf',
  '.bin',
  '.hdr',
  '.exr',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.basis',
  '.dds',
  '.fbx',
  '.mp3',
  '.ogg',
  '.wav',
  '.mp4',
  '.webm',
]);

/**
 * Path prefixes exempt from the FORMAT rule (still subject to the SIZE rule).
 * Documentation screenshots are the only sanctioned committed binaries.
 */
const ALLOWED_PREFIXES = ['docs/screenshots/'];

interface Violation {
  readonly file: string;
  readonly rule: 'size' | 'format';
  readonly detail: string;
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Tracked files plus anything currently staged, de-duplicated. */
function collectFiles(): string[] {
  const files = new Set<string>();
  for (const line of git(['ls-files']).split('\n')) {
    if (line.trim()) files.add(line.trim());
  }
  // Staged additions are not yet in `ls-files` output on a fresh repo.
  try {
    const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
    for (const line of staged.split('\n')) {
      if (line.trim()) files.add(line.trim());
    }
  } catch {
    // No HEAD yet (unborn branch) — `ls-files` alone is sufficient.
  }
  return [...files];
}

function isAllowed(file: string): boolean {
  const normalized = file.split(path.sep).join('/');
  return ALLOWED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function main(): void {
  const files = collectFiles();
  const violations: Violation[] = [];
  let totalBytes = 0;

  for (const file of files) {
    if (!existsSync(file)) continue; // deleted but still staged
    let size: number;
    try {
      const stat = statSync(file);
      if (!stat.isFile()) continue;
      size = stat.size;
    } catch {
      continue;
    }
    totalBytes += size;

    if (size > MAX_FILE_BYTES) {
      violations.push({
        file,
        rule: 'size',
        detail: `${formatBytes(size)} exceeds the ${formatBytes(MAX_FILE_BYTES)} limit`,
      });
    }

    const ext = path.extname(file).toLowerCase();
    if (FORBIDDEN_EXTENSIONS.has(ext) && !isAllowed(file)) {
      violations.push({
        file,
        rule: 'format',
        detail: `"${ext}" is a binary asset; allowed only under ${ALLOWED_PREFIXES.join(', ')}`,
      });
    }
  }

  if (violations.length === 0) {
    console.log(
      `binary guard OK — ${files.length} tracked files, ${formatBytes(totalBytes)} total, ` +
        `largest limit ${formatBytes(MAX_FILE_BYTES)}`
    );
    return;
  }

  console.error(`\nBINARY GUARD FAILED — ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`  [${v.rule}] ${v.file}\n          ${v.detail}`);
  }
  console.error(
    `\nBinary game assets must NOT be committed. They are reproducible:\n` +
      `  assets/source/     -> npm run assets:fetch\n` +
      `  assets/generated/  -> npm run assets:process\n` +
      `Add the path to .gitignore, then \`git rm --cached <file>\`.\n`
  );
  process.exit(1);
}

main();
