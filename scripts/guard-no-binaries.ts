/**
 * BINARY GUARD
 *
 * Makes GitHub's 100 MB hard limit STRUCTURALLY unreachable rather than
 * something 30+ parallel agents have to remember to avoid.
 *
 * Two rules, enforced over files git actually tracks (plus anything staged):
 *
 *   1. SIZE   — no tracked file may exceed MAX_FILE_BYTES (5 MB), measured on
 *               the larger of the STAGED BLOB and the working copy.
 *   2. FORMAT — no tracked file may carry a binary game-asset extension,
 *               except inside the two allow-listed directories.
 *               Decided from the PATH alone, so a staged-then-deleted binary
 *               cannot slip past by having no file on disk.
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
import { statSync } from 'node:fs';
import path from 'node:path';

/** Hard ceiling for any single tracked file. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Extensions that must never be committed (lowercase, with dot).
 *
 * Wider than the formats this pipeline emits on purpose: the SIZE rule holds
 * the 100 MB line, but history bloat arrives one sub-5-MB file at a time, and
 * the FORMAT rule is the one that is meant to stop it before it starts. Every
 * binary an authoring tool, an archiver or a build step can drop into the tree
 * belongs here, not just the ones `npm run assets` produces.
 */
const FORBIDDEN_EXTENSIONS = new Set([
  // Textures and images.
  '.ktx2',
  '.basis',
  '.dds',
  '.hdr',
  '.exr',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.avif',
  '.gif',
  '.bmp',
  '.tga',
  '.tif',
  '.tiff',
  '.psd',
  // Models and scenes.
  '.glb',
  '.gltf',
  '.bin',
  '.fbx',
  '.obj',
  '.mtl',
  '.blend',
  '.usdz',
  '.vrm',
  // Audio and video.
  '.mp3',
  '.ogg',
  '.wav',
  '.aac',
  '.m4a',
  '.flac',
  '.mp4',
  '.webm',
  '.mov',
  // Fonts.
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  // Archives and build artifacts.
  '.zip',
  '.7z',
  '.tar',
  '.gz',
  '.wasm',
  '.apk',
  '.aab',
]);

/**
 * Path prefixes exempt from the FORMAT rule (still subject to the SIZE rule).
 * Two, and the reason is the same both times: what lives there is NOT
 * reproducible, so keeping it out of git would not "save" it anywhere.
 *
 *   docs/screenshots/  A small curated evidence copy of the verification
 *                      harness output. The harness rewrites its own PNGs into
 *                      gitignored paths; these are the ones a reader needs.
 *
 *   assets/icon/       The app icon ships from a committed raster master —
 *                      artwork, not a build product, with no manifest to
 *                      re-fetch it from and no `npm run assets` step that
 *                      re-derives it. `scripts/make-icons.ts` reads it and
 *                      writes every home-screen size into the gitignored
 *                      `public/icons/`, so exactly one image is tracked here
 *                      and everything generated from it still stays out.
 *
 * Neither exemption touches the SIZE rule: a 6 MB master is still rejected.
 */
const ALLOWED_PREFIXES = ['docs/screenshots/', 'assets/icon/'];

interface Violation {
  readonly file: string;
  readonly rule: 'size' | 'format';
  readonly detail: string;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * The repository root, resolved once and used as the cwd for every git call
 * and as the base of every filesystem path.
 *
 * Without it the two git commands disagree about what their output is relative
 * to: `git ls-files` restricts itself to the CWD subtree AND prints cwd-relative
 * paths, while `git diff --cached --name-only` always prints root-relative ones.
 * Run from `scripts/` — or from a CI step whose working directory is not the
 * root, which this script advertises itself for — the guard then checks a
 * handful of files, misses every staged path, and prints OK.
 */
function repoRoot(): string {
  return git(['rev-parse', '--show-toplevel'], process.cwd()).trim();
}

/**
 * Split NUL-delimited git output.
 *
 * `-z` is not a nicety. `core.quotePath` defaults to true, so without it any
 * path holding a non-ASCII or control byte arrives C-quoted — `"h\303\251ro.png"`,
 * quotes and backslashes included — which matches no file on disk and is then
 * skipped by BOTH rules, silently and without appearing in the file count.
 */
function splitNul(output: string): string[] {
  return output.split('\0').filter((entry) => entry !== '');
}

/** Tracked files plus anything currently staged, de-duplicated, root-relative. */
function collectFiles(root: string): string[] {
  const files = new Set<string>(splitNul(git(['ls-files', '-z', '--full-name'], root)));
  // Staged additions are not yet in `ls-files` output on a fresh repo.
  try {
    const staged = git(['diff', '--cached', '-z', '--name-only', '--diff-filter=ACMR'], root);
    for (const file of splitNul(staged)) files.add(file);
  } catch {
    // No HEAD yet (unborn branch) — `ls-files` alone is sufficient.
  }
  return [...files];
}

/**
 * Byte size of every blob in the INDEX, keyed by root-relative path.
 *
 * The index is what a commit ships, and it is not the working tree:
 * `git add huge.json` then overwriting the working copy with a stub leaves a
 * 200 MB blob staged behind a small file, and `git add city.glb && rm city.glb`
 * leaves a staged binary with no file at all. `statSync` alone misses both.
 */
function indexSizes(root: string): Map<string, number> {
  const oids: string[] = [];
  const paths: string[] = [];
  for (const record of splitNul(git(['ls-files', '-s', '-z', '--full-name'], root))) {
    // `<mode> <oid> <stage>\t<path>`
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const oid = record.slice(0, tab).split(' ')[1];
    if (oid === undefined) continue;
    oids.push(oid);
    paths.push(record.slice(tab + 1));
  }

  const sizes = new Map<string, number>();
  if (oids.length === 0) return sizes;
  // `--batch-check` emits one `<oid> <type> <size>` line per input line, in order.
  const listing = execFileSync('git', ['cat-file', '--batch-check'], {
    cwd: root,
    encoding: 'utf8',
    input: `${oids.join('\n')}\n`,
    maxBuffer: 64 * 1024 * 1024,
  }).split('\n');
  for (let i = 0; i < paths.length; i++) {
    const parts = (listing[i] ?? '').split(' ');
    if (parts[1] !== 'blob') continue;
    const size = Number(parts[2]);
    if (Number.isFinite(size)) sizes.set(paths[i]!, size);
  }
  return sizes;
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
  const root = repoRoot();
  const files = collectFiles(root);
  const staged = indexSizes(root);
  const violations: Violation[] = [];
  /** Paths with neither an index blob nor a readable file — reported, never dropped. */
  const unmeasured: string[] = [];
  let totalBytes = 0;

  for (const file of files) {
    // FORMAT first, and from the PATH ALONE. `git add city.glb && rm city.glb`
    // still commits a `.glb`; the rule needs nothing but the name to reject it,
    // so it must not sit behind a filesystem lookup.
    const ext = path.extname(file).toLowerCase();
    if (FORBIDDEN_EXTENSIONS.has(ext) && !isAllowed(file)) {
      violations.push({
        file,
        rule: 'format',
        detail: `"${ext}" is a binary asset; allowed only under ${ALLOWED_PREFIXES.join(', ')}`,
      });
    }

    // SIZE against the LARGER of the staged blob and the working copy: either
    // one can be what ends up in history.
    const stagedSize = staged.get(file);
    let workingSize: number | undefined;
    try {
      const stat = statSync(path.join(root, file));
      if (stat.isFile()) workingSize = stat.size;
    } catch {
      // Deleted, unreadable or a submodule — the index reading still counts.
    }
    const size = Math.max(stagedSize ?? -1, workingSize ?? -1);
    if (size < 0) {
      unmeasured.push(file);
      continue;
    }
    totalBytes += size;

    if (size > MAX_FILE_BYTES) {
      const fromIndex = stagedSize !== undefined && stagedSize >= (workingSize ?? -1);
      violations.push({
        file,
        rule: 'size',
        detail:
          `${formatBytes(size)} exceeds the ${formatBytes(MAX_FILE_BYTES)} limit` +
          (fromIndex ? ' (measured on the staged blob)' : ''),
      });
    }
  }

  if (unmeasured.length > 0) {
    console.log(
      `binary guard: ${unmeasured.length} path(s) could not be measured — ` +
        `${unmeasured.slice(0, 3).join(', ')}`
    );
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
