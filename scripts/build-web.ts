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
 * ── THE FILTER NEEDS TWO RULES, NOT ONE ────────────────────────────────────
 * `assets.runtime.json` only indexes the outputs the texture/model pipeline
 * produced. Character assets come from a separate pipeline (tools/build-characters)
 * and are absent from it. So: keep anything the index declares for this tier, and
 * fall back to the `.tier.` filename token for everything else. Dropping that
 * second rule silently deletes every character.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const DIST = path.resolve('dist');

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

function run(cmd: string, args: readonly string[]): void {
  execFileSync(cmd, args as string[], { stdio: 'inherit', cwd: process.cwd() });
}

function main(): void {
  const argv = process.argv.slice(2);
  const tierArg = argv[argv.indexOf('--tier') + 1];
  const tier: Tier =
    tierArg === 'high' || tierArg === 'ultra' || tierArg === 'mobile' ? tierArg : 'mobile';
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

  if (!prune) {
    log(`\n  dist ${mb(sizeOf(walk(DIST)))} (unpruned)`);
    return;
  }

  const all = walk(DIST);
  const before = sizeOf(all);

  const doomed = all.filter((f) => {
    const rel = path.relative(DIST, f).split(path.sep).join('/');
    if (SCRATCH.test(rel)) return true;
    const match = TIER_TOKEN.exec(rel);
    // Untiered files (code, index, manifest, icons, the runtime index) always stay.
    return match !== null && match[1] !== tier;
  });

  const freed = sizeOf(doomed);
  for (const f of doomed) rmSync(f, { force: true });

  const after = sizeOf(walk(DIST));
  log(`\n  removed ${doomed.length} files, freed ${mb(freed)}`);
  log(`  dist    ${mb(before)} -> ${mb(after)}`);
  log(`\nserve it:  npx serve dist`);
  log('on iOS:    open the URL in Safari, then Share -> Add to Home Screen');
}

main();
