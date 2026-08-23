/**
 * WEB BUILD — icons -> characters -> vite build -> single-tier prune.
 *
 * This is the build you serve to a phone browser, and the only practical way to
 * run the game on iOS without a Mac: Safari supports WebGL2, and Apple GPUs
 * support ASTC, which is one of the transcode targets the KTX2 pipeline already
 * emits. Add to Home Screen then gives a fullscreen app.
 *
 *   npx tsx scripts/build-web.ts                # mobile tier (default)
 *   npx tsx scripts/build-web.ts --tier high    # desktop / high-DPI
 *   npx tsx scripts/build-web.ts --no-prune     # every tier (262 MB; diagnostic)
 *
 * ── WHY PRUNE ──────────────────────────────────────────────────────────────
 * `vite build` copies all of public/assets, which holds every quality tier:
 * mobile 91.5 MB + high 62.5 MB + ultra 54.5 MB. Serving 262 MB to a phone over
 * mobile data is not a thing anyone should do, and the high/ultra maps are never
 * requested once the runtime pins a tier.
 *
 * ── THE FILTER IS THE FILENAME TOKEN, AND ONLY THAT ────────────────────────
 * `assets.runtime.json` indexes the texture/model pipeline's outputs and
 * records a `tier` per file, but nothing here reads it: character assets come
 * from a separate pipeline (tools/build-characters) and are absent from the
 * index, so a manifest-only rule would silently delete every character. The
 * `.tier.` token covers both pipelines, and on the current payload the token
 * and the manifest agree on all 192 tiered outputs.
 *
 * `scripts/build-apk.ts` DOES consult the manifest first — see its header. The
 * difference is insurance against a pipeline that emits a tiered file with no
 * token in its name; it is not a live difference today.
 *
 * ── SCRATCH IS NOT PART OF THE TIER FILTER ─────────────────────────────────
 * `--no-prune` selects every tier. It does NOT keep `.work/` and `.cache/`:
 * `public/assets/mdl/.cache` alone is 200 MB of content-addressed
 * intermediates, and vite copies dot-directories out of `public/` verbatim, so
 * serving an "unpruned" dist would publish the pipeline's scratch store.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Repo root — this file lives in `scripts/`. Never `process.cwd()`: this build
 * belongs to a specific checkout, not to whatever directory invoked it. Run
 * from anywhere else, a cwd-relative `dist` prunes a directory that is not the
 * one vite just wrote, and says nothing about it.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

/** Tier tokens the asset pipeline embeds in filenames, e.g. `albedo.mobile.ktx2`. */
const TIER_TOKEN = /\.(mobile|high|ultra)\./;

/** Pipeline scratch that must never reach a served build. */
const SCRATCH = /(^|\/)(\.work|\.cache)(\/|$)/;

type Tier = 'mobile' | 'high' | 'ultra';

function log(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

function mb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function sizeOf(files: readonly string[]): number {
  return files.reduce((sum, f) => sum + statSync(f).size, 0);
}

/**
 * Run a build step, anchored to the repo and reported as a message.
 *
 * `execFileSync` THROWS on a non-zero exit, so a failing `make-icons.ts` or
 * `vite build` used to end this script with a `Command failed` stack trace
 * instead of naming the step. `scripts/build-apk.ts:138` is the model.
 */
function run(cmd: string, args: readonly string[]): void {
  log(`$ ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args as string[], { stdio: 'inherit', cwd: ROOT });
  if (result.error) {
    process.stderr.write(`\nFAILED: ${cmd} could not be launched: ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.stderr.write(`\nFAILED: ${cmd} ${args.join(' ')} exited ${String(result.status)}\n`);
    process.exit(1);
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  // `indexOf` returns -1 when the flag is absent, and `argv[-1 + 1]` is
  // `argv[0]` — so `build-web.ts ultra --no-prune` used to silently build the
  // ultra tier while the operator believed they had asked for the default.
  const tierIndex = argv.indexOf('--tier');
  const tierArg: string | undefined = tierIndex >= 0 ? argv[tierIndex + 1] : 'mobile';
  if (tierArg !== 'high' && tierArg !== 'ultra' && tierArg !== 'mobile') {
    process.stderr.write(
      `\nFAILED: --tier needs one of mobile|high|ultra (got ${JSON.stringify(tierArg)}).\n`
    );
    process.exit(1);
  }
  const tier: Tier = tierArg;
  const prune = !argv.includes('--no-prune');

  log(`building web bundle  tier=${tier}  prune=${prune}`);

  run('npx', ['tsx', 'scripts/make-icons.ts']);
  // Characters are build output for exactly the reason icons are: `tools/build-
  // characters.ts` is the only writer of `public/assets/chr/`, and that tree is
  // gitignored, so a clean checkout has no character art at all.
  run('npx', ['tsx', 'tools/build-characters.ts']);
  run('npm', ['run', 'build']);

  // This build used to ship with no characters and say nothing about it: vite
  // copies whatever `public/assets` happens to hold, so a missing bake exits 0
  // and publishes a game that boots with all fourteen characters drawn in the
  // mesh generator's flat vertex colours. Assert the one file the runtime asks
  // for first, before the prune, so the wiring above cannot silently rot again.
  const chrIndex = path.join(DIST, 'assets', 'chr', 'characters.runtime.json');
  if (!existsSync(chrIndex)) {
    process.stderr.write(
      `\nFAILED: dist/assets/chr/characters.runtime.json is missing — ` +
        `tools/build-characters.ts produced no baked atlases.\n`
    );
    process.exit(1);
  }

  const all = walk(DIST);
  const before = sizeOf(all);

  const scratch = all.filter((f) => SCRATCH.test(path.relative(DIST, f).split(path.sep).join('/')));
  // Scratch goes in every mode; only the tier filter answers to `--no-prune`.
  const doomed = prune
    ? all.filter((f) => {
        const rel = path.relative(DIST, f).split(path.sep).join('/');
        if (SCRATCH.test(rel)) return true;
        // BASENAME, not the whole path: `RegExp.exec` returns the FIRST match,
        // so a directory carrying a token (`chr/saitama.high.bake/…`) would
        // otherwise decide the fate of every file beneath it — and delete the
        // correct `atlas.mobile.ktx2` inside it. `build-apk.ts` matches the
        // basename; these two must agree.
        const match = TIER_TOKEN.exec(path.basename(rel));
        // Untiered files (code, index, manifest, icons, the runtime index) always stay.
        return match !== null && match[1] !== tier;
      })
    : scratch;

  const freed = sizeOf(doomed);
  for (const f of doomed) rmSync(f, { force: true });

  const after = sizeOf(walk(DIST));
  if (!prune) {
    log(`\n  removed ${scratch.length} pipeline scratch files, freed ${mb(freed)}`);
    log(`  dist    ${mb(before)} -> ${mb(after)} (every tier)`);
    return;
  }
  log(`\n  removed ${doomed.length} files, freed ${mb(freed)} (${scratch.length} scratch)`);
  log(`  dist    ${mb(before)} -> ${mb(after)}`);
  log(`\nserve it:  npx serve dist`);
  log('on iOS:    open the URL in Safari, then Share -> Add to Home Screen');
}

main();
