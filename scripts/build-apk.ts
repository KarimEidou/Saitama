/**
 * APK BUILDER — web build -> Capacitor sync -> mobile-tier prune -> gradle assemble.
 *
 * Run:
 *   npx tsx scripts/build-apk.ts                 # debug APK, full pipeline
 *   npx tsx scripts/build-apk.ts --release       # unsigned release APK
 *   npx tsx scripts/build-apk.ts --skip-web      # reuse the existing dist/
 *   npx tsx scripts/build-apk.ts --skip-web --skip-sync   # re-package only
 *   npx tsx scripts/build-apk.ts --tier high     # bundle a different asset tier
 *   npx tsx scripts/build-apk.ts --no-prune      # bundle every tier (huge; diagnostic)
 *
 * PREREQUISITES
 *   1. `npx tsx scripts/android-sdk.ts`  — installs the SDK (idempotent).
 *   2. `npx cap add android`             — generates `android/` (gitignored; see below).
 *
 * WHY THE PRUNE STEP EXISTS
 * -------------------------
 * Vite copies all of `public/` verbatim into `dist/`, and `cap sync` copies all of
 * `dist/` into `android/app/src/main/assets/public/`. The asset pipeline emits three
 * tiers (mobile/high/ultra) plus its own scratch directories, so an unpruned sync
 * ships ~296 MB — over Google Play's ~200 MB base limit and full of assets a phone
 * will never load. Filtering has to happen here because `vite.config.ts` and the
 * asset pipeline belong to other workstreams; this script only ever deletes from
 * the generated `android/` copy and never touches `dist/` or `public/`.
 *
 * WHY THIS DOES NOT DELEGATE TO `scripts/build-web.ts`
 * ---------------------------------------------------
 * That script prunes too, and the two filters look like duplication. They are
 * not interchangeable, for three reasons — in descending order of importance:
 *
 *   1. DIFFERENT TREE. `build-web.ts` prunes `dist/`, the build you serve to a
 *      browser. This prunes the throwaway copy under `android/`. Routing the APK
 *      build through it would make packaging destructive to `dist/` — which is a
 *      served artifact and, during parallel work, may be live behind `npx serve`.
 *      Packaging must stay read-only with respect to `dist/`.
 *   2. BROADER SCRATCH RULE. This drops any path with a dot-prefixed segment;
 *      `build-web.ts` matches only `.work/` and `.cache/`, so `.process-cache.json`
 *      (68 KB) and `mdl/.gitignore` survive there and would ride into the APK.
 *   3. MANIFEST AUTHORITY. This trusts `assets.runtime.json`'s declared tier and
 *      falls back to the filename token; `build-web.ts` has only the token rule.
 *      Measured on the current payload the two agree on all 192 tiered outputs,
 *      so this buys nothing today — it is insurance against a pipeline that emits
 *      a tiered file without a `.tier.` token, not a live difference.
 *
 * (1) and (2) are real and load-bearing. Sharing the filter would mean extracting
 * it to take a root and a scratch predicate — worth doing only if a third caller
 * ever appears; with two, the indirection costs more than the ~20 duplicated lines.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sdkRoot } from './android-sdk.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID_DIR = path.join(REPO_ROOT, 'android');
const WEB_ASSETS = path.join(ANDROID_DIR, 'app', 'src', 'main', 'assets', 'public');
const GAME_ASSETS = path.join(WEB_ASSETS, 'assets');
const MANIFEST = path.join(GAME_ASSETS, 'assets.runtime.json');

/** Tier tokens the asset pipeline embeds in filenames, e.g. `albedo.mobile.ktx2`. */
const TIER_TOKEN = /\.(mobile|high|ultra)\./;

/* ------------------------------------------------------------------- utils */

function log(msg: string): void {
  console.log(`[build-apk] ${msg}`);
}

function fail(msg: string): never {
  console.error(`\n[build-apk] FAILED: ${msg}\n`);
  process.exit(1);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

function sizeOf(files: readonly string[]): number {
  let total = 0;
  for (const f of files) {
    try {
      total += statSync(f).size;
    } catch {
      /* raced away */
    }
  }
  return total;
}

function run(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): void {
  log(`$ ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (result.error) fail(`${cmd} could not be launched: ${result.error.message}`);
  if (result.status !== 0) fail(`${cmd} ${args.join(' ')} exited ${result.status}`);
}

/* ------------------------------------------------------------ preflight */

function requireSdk(): string {
  const root = sdkRoot();
  const needed = [
    'cmdline-tools/latest/bin/sdkmanager',
    'platforms/android-36/android.jar',
    'build-tools/36.0.0/aapt2',
  ];
  const missing = needed.filter((rel) => !existsSync(path.join(root, rel)));
  if (missing.length > 0) {
    fail(
      `Android SDK incomplete at ${root} (missing: ${missing.join(', ')}).\n` +
        `Run:  npx tsx scripts/android-sdk.ts`
    );
  }
  return root;
}

function requireAndroidProject(): void {
  if (!existsSync(path.join(ANDROID_DIR, 'gradlew'))) {
    fail(
      `No Android project at ${ANDROID_DIR}.\n` +
        `It is gitignored and generated on demand. Run:\n` +
        `  npm run build && npx cap add android`
    );
  }
}

/* -------------------------------------------------------- gradle config */

/**
 * Write `local.properties` (SDK location) and append proxy/memory settings to
 * `gradle.properties`. Both files are generated, so this is re-applied on every
 * build rather than assumed to survive a regeneration of `android/`.
 *
 * Proxy values are read from the environment at build time instead of being
 * hardcoded — the sandbox routes HTTPS through a local agent proxy, but a
 * developer machine will have none and must not inherit a dead proxy setting.
 */
function configureGradle(sdk: string): void {
  writeFileSync(
    path.join(ANDROID_DIR, 'local.properties'),
    `# Generated by scripts/build-apk.ts — do not edit by hand.\nsdk.dir=${sdk}\n`,
    'utf8'
  );

  const propsFile = path.join(ANDROID_DIR, 'gradle.properties');
  const MARKER = '# --- managed by scripts/build-apk.ts ---';
  const base = existsSync(propsFile)
    ? readFileSync(propsFile, 'utf8').split(MARKER)[0].trimEnd()
    : '';

  const managed: string[] = [
    MARKER,
    '# Regenerated on every build; edits below this line are overwritten.',
    'org.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1g -Dfile.encoding=UTF-8',
    'org.gradle.parallel=true',
    'org.gradle.caching=true',
    'android.useAndroidX=true',
  ];

  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? '';
  if (proxy) {
    try {
      const url = new URL(proxy);
      const port = url.port || (url.protocol === 'https:' ? '443' : '80');
      // Gradle resolves AGP + AndroidX from dl.google.com and repo1.maven.org;
      // without these it hangs until the 10s network timeout on every request.
      managed.push(
        `systemProp.https.proxyHost=${url.hostname}`,
        `systemProp.https.proxyPort=${port}`,
        `systemProp.http.proxyHost=${url.hostname}`,
        `systemProp.http.proxyPort=${port}`
      );
      const noProxy = (process.env.NO_PROXY ?? process.env.no_proxy ?? '')
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean)
        .map((h) => (h.startsWith('.') ? `*${h}` : h))
        .join('|');
      if (noProxy) {
        managed.push(
          `systemProp.http.nonProxyHosts=${noProxy}`,
          `systemProp.https.nonProxyHosts=${noProxy}`
        );
      }
      log(`gradle proxy -> ${url.hostname}:${port}`);
    } catch {
      log(`WARNING: could not parse proxy URL ${proxy}; leaving gradle proxy unset`);
    }
  }

  // The agent proxy presents a custom CA. JAVA_TOOL_OPTIONS already points the
  // JVM at the PKCS12 truststore; mirror it here so a build works even when that
  // variable is not exported (e.g. run from an IDE).
  const trustStore = '/root/.ccr/java-truststore.p12';
  if (existsSync(trustStore)) {
    managed.push(
      `systemProp.javax.net.ssl.trustStore=${trustStore}`,
      'systemProp.javax.net.ssl.trustStoreType=PKCS12',
      'systemProp.javax.net.ssl.trustStorePassword=changeit'
    );
  }

  writeFileSync(propsFile, `${base}\n\n${managed.join('\n')}\n`, 'utf8');
  log(`configured ${propsFile}`);
  configureNoCompress();
}

/**
 * Store KTX2 textures uncompressed inside the APK.
 *
 * Measured on this project's own payload (`unzip -v` over the packaged APK):
 *
 *     ktx2   62.11 MB -> 62.06 MB   deflate saves  0.1%
 *     glb    42.37 MB -> 32.78 MB   deflate saves 22.6%
 *     bin     5.82 MB ->  2.60 MB   deflate saves 55.3%
 *
 * KTX2 payloads are already Basis-supercompressed, so deflating them buys ~50 KB
 * across 127 files while forcing the WebView to inflate every texture on load
 * instead of reading it in place. GLB and VAT `.bin` still compress well and are
 * deliberately left deflated — a blanket `noCompress` would cost ~13 MB of APK.
 *
 * This must go through the AGP DSL: `android.aaptOptions.noCompress` in
 * `gradle.properties` is silently ignored (it is not a real AGP property), which
 * is why the first build of this project shipped every KTX2 deflated.
 *
 * `android/app/build.gradle` is Capacitor-generated, so the block is re-injected
 * on every build and delimited by markers to stay idempotent.
 */
function configureNoCompress(): void {
  const gradleFile = path.join(ANDROID_DIR, 'app', 'build.gradle');
  if (!existsSync(gradleFile)) {
    log(`WARNING: ${gradleFile} absent — skipping noCompress configuration`);
    return;
  }
  const BEGIN = '    // >>> managed by scripts/build-apk.ts — noCompress';
  const END = '    // <<< managed by scripts/build-apk.ts';
  const block = [
    BEGIN,
    '    androidResources {',
    "        noCompress += ['ktx2']",
    '    }',
    END,
  ].join('\n');

  const original = readFileSync(gradleFile, 'utf8');
  const stripped = original.replace(
    new RegExp(`\\n?${escapeRegExp(BEGIN)}[\\s\\S]*?${escapeRegExp(END)}\\n?`),
    '\n'
  );

  const anchor = stripped.match(/^android\s*\{[^\n]*\n/m);
  if (!anchor || anchor.index === undefined) {
    log(`WARNING: no \`android {\` block found in ${gradleFile}; noCompress not applied`);
    return;
  }
  const at = anchor.index + anchor[0].length;
  const next = `${stripped.slice(0, at)}${block}\n${stripped.slice(at)}`;
  if (next !== original) {
    writeFileSync(gradleFile, next, 'utf8');
    log(`injected androidResources.noCompress += ['ktx2'] into ${gradleFile}`);
  } else {
    log(`noCompress block already current in ${gradleFile}`);
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ----------------------------------------------------------- asset prune */

interface PruneResult {
  readonly keptFiles: number;
  readonly keptBytes: number;
  readonly droppedTier: number;
  readonly droppedTierBytes: number;
  readonly droppedScratch: number;
  readonly droppedScratchBytes: number;
  readonly byGroup: ReadonlyMap<string, { files: number; bytes: number }>;
}

/**
 * Delete everything from the packaged asset tree that is not part `tier`.
 *
 * Two classifiers, because two independent pipelines produce these files:
 *
 *   1. `assets.runtime.json` (`tools/process-assets.ts`) records an explicit
 *      `outputs[].tier` per file — authoritative where present.
 *   2. The character pipeline emits `chr/**` which the runtime manifest does not
 *      index, but which follows the same `<name>.<tier>.<ext>` convention.
 *
 * A file is kept when the manifest says it is `tier`, or — when unclaimed — when
 * its filename carries no foreign tier token. Untiered support files
 * (`model.glb`, `vat.bin`, `*.sh9.json`, `basis/*`) are therefore kept, which is
 * correct: every tier shares them.
 */
function pruneAssets(tier: string): PruneResult {
  if (!existsSync(GAME_ASSETS)) {
    fail(`no game assets at ${GAME_ASSETS} — did \`npx cap sync android\` run?`);
  }

  const tierOf = new Map<string, string>();
  if (existsSync(MANIFEST)) {
    try {
      const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
        entries?: { outputs?: { tier?: string; file?: string }[] }[];
      };
      for (const entry of manifest.entries ?? []) {
        for (const output of entry.outputs ?? []) {
          if (output.file && output.tier) tierOf.set(output.file, output.tier);
        }
      }
      log(`manifest indexes ${tierOf.size} tiered outputs`);
    } catch (err) {
      fail(`could not parse ${MANIFEST}: ${(err as Error).message}`);
    }
  } else {
    log(`WARNING: ${MANIFEST} absent — falling back to filename tier tokens only`);
  }

  const kept: string[] = [];
  const droppedTier: string[] = [];
  const droppedScratch: string[] = [];

  for (const abs of walk(GAME_ASSETS)) {
    const rel = path.relative(GAME_ASSETS, abs).split(path.sep).join('/');

    // Pipeline scratch/caches (`.work/`, `mdl/.cache/`, `.process-cache.json`).
    // aapt would skip dot-prefixed entries anyway; deleting them keeps the
    // reported payload honest and the intermediate copy small.
    if (rel.split('/').some((seg) => seg.startsWith('.'))) {
      droppedScratch.push(abs);
      continue;
    }

    const declared = tierOf.get(rel);
    if (declared !== undefined) {
      (declared === tier ? kept : droppedTier).push(abs);
      continue;
    }

    const token = path.basename(rel).match(TIER_TOKEN);
    if (token && token[1] !== tier) droppedTier.push(abs);
    else kept.push(abs);
  }

  const keptBytes = sizeOf(kept);
  const droppedTierBytes = sizeOf(droppedTier);
  const droppedScratchBytes = sizeOf(droppedScratch);

  for (const file of [...droppedTier, ...droppedScratch]) rmSync(file, { force: true });
  pruneEmptyDirs(GAME_ASSETS);

  const byGroup = new Map<string, { files: number; bytes: number }>();
  for (const abs of kept) {
    const rel = path.relative(GAME_ASSETS, abs).split(path.sep).join('/');
    const group = rel.includes('/') ? rel.split('/')[0] : '(root)';
    const bucket = byGroup.get(group) ?? { files: 0, bytes: 0 };
    bucket.files += 1;
    bucket.bytes += statSync(abs).size;
    byGroup.set(group, bucket);
  }

  return {
    keptFiles: kept.length,
    keptBytes,
    droppedTier: droppedTier.length,
    droppedTierBytes,
    droppedScratch: droppedScratch.length,
    droppedScratchBytes,
    byGroup,
  };
}

function pruneEmptyDirs(dir: string): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) pruneEmptyDirs(path.join(dir, entry.name));
  }
  try {
    if (readdirSync(dir).length === 0 && dir !== GAME_ASSETS) rmSync(dir, { recursive: true });
  } catch {
    /* raced away */
  }
}

/* -------------------------------------------------------------- packaging */

function findApk(release: boolean): string {
  const dir = path.join(
    ANDROID_DIR,
    'app',
    'build',
    'outputs',
    'apk',
    release ? 'release' : 'debug'
  );
  if (!existsSync(dir)) fail(`no APK output directory at ${dir}`);
  const apks = readdirSync(dir).filter((f) => f.endsWith('.apk'));
  if (apks.length === 0) fail(`no .apk produced in ${dir}`);
  return path.join(dir, apks[0]);
}

/** Structural proof that the artifact is a real APK, not a renamed zip. */
function verifyApk(apk: string): void {
  const listing = execFileSync('unzip', ['-l', apk], { encoding: 'utf8', maxBuffer: 256 << 20 });
  const required = ['AndroidManifest.xml', 'classes.dex', 'assets/public/index.html'];
  const missing = required.filter((needle) => !listing.includes(needle));
  if (missing.length > 0) {
    fail(`APK is missing required entries: ${missing.join(', ')}`);
  }
  const assetEntries = listing.split('\n').filter((l) => l.includes('assets/public/assets/'));
  log(`APK verified — manifest + dex present, ${assetEntries.length} bundled game asset entries`);
}

/* ------------------------------------------------------------------- main */

function main(): void {
  const argv = process.argv.slice(2);
  const release = argv.includes('--release');
  const skipWeb = argv.includes('--skip-web');
  const skipSync = argv.includes('--skip-sync');
  const noPrune = argv.includes('--no-prune');
  const tierIndex = argv.indexOf('--tier');
  const tier = tierIndex >= 0 ? argv[tierIndex + 1] : 'mobile';
  if (tierIndex >= 0 && !tier) fail('--tier requires a value (mobile|high|ultra)');

  const started = Date.now();
  const sdk = requireSdk();
  log(`SDK: ${sdk}`);

  if (!skipWeb) {
    // Icons are build output, not source (`public/icons/` is gitignored because
    // `npm run guard` rejects tracked PNGs). `npm run build` does not generate
    // them, so without this a from-clean build ships an APK with no launcher
    // icon at all — `scripts/build-web.ts` runs the same step for the same reason.
    run('npx', ['tsx', 'scripts/make-icons.ts'], REPO_ROOT);
    run('npm', ['run', 'build'], REPO_ROOT);
  } else {
    log('skipping web build (--skip-web)');
  }
  if (!existsSync(path.join(REPO_ROOT, 'dist', 'index.html'))) {
    fail(`dist/index.html missing — the web build must succeed before packaging`);
  }

  requireAndroidProject();

  if (!skipSync) {
    run('npx', ['cap', 'sync', 'android'], REPO_ROOT, {
      ANDROID_SDK_ROOT: sdk,
      ANDROID_HOME: sdk,
    });
  } else {
    log('skipping capacitor sync (--skip-sync)');
  }

  configureGradle(sdk);

  const beforeBytes = sizeOf(walk(WEB_ASSETS));
  let prune: PruneResult | null = null;
  if (noPrune) {
    log(`WARNING: --no-prune — bundling every asset tier (${formatBytes(beforeBytes)})`);
  } else {
    log(`pruning packaged assets to the "${tier}" tier …`);
    prune = pruneAssets(tier);
    log(`  kept    ${String(prune.keptFiles).padStart(4)} files  ${formatBytes(prune.keptBytes)}`);
    log(
      `  dropped ${String(prune.droppedTier).padStart(4)} files  ` +
        `${formatBytes(prune.droppedTierBytes)}  (other tiers)`
    );
    log(
      `  dropped ${String(prune.droppedScratch).padStart(4)} files  ` +
        `${formatBytes(prune.droppedScratchBytes)}  (pipeline scratch)`
    );
    for (const [group, v] of [...prune.byGroup].sort((a, b) => b[1].bytes - a[1].bytes)) {
      log(
        `      ${group.padEnd(10)} ${String(v.files).padStart(4)} files  ${formatBytes(v.bytes)}`
      );
    }
  }

  const task = release ? 'assembleRelease' : 'assembleDebug';
  run('./gradlew', [task, '--no-daemon', '--stacktrace'], ANDROID_DIR, {
    ANDROID_SDK_ROOT: sdk,
    ANDROID_HOME: sdk,
  });

  const apk = findApk(release);
  const bytes = statSync(apk).size;
  verifyApk(apk);

  const PLAY_CAP = 200 * 1024 * 1024;
  const webBytes = sizeOf(walk(WEB_ASSETS));

  console.log('');
  log('='.repeat(64));
  log(`APK          ${apk}`);
  log(`size         ${bytes.toLocaleString()} bytes  (${formatBytes(bytes)})`);
  log(`web payload  ${formatBytes(webBytes)} on disk before packaging`);
  log(`variant      ${release ? 'release (unsigned)' : 'debug'}`);
  log(`asset tier   ${noPrune ? 'ALL TIERS' : tier}`);
  log(
    `Play limit   ${formatBytes(PLAY_CAP)} base cap — ` +
      `${bytes <= PLAY_CAP ? 'OK' : 'OVER'}, ` +
      `${((bytes / PLAY_CAP) * 100).toFixed(1)}% used, ` +
      `${formatBytes(Math.max(0, PLAY_CAP - bytes))} headroom`
  );
  log(`elapsed      ${((Date.now() - started) / 1000).toFixed(1)}s`);
  log('='.repeat(64));
  log('NOT VERIFIED ON DEVICE: this environment has no emulator and no attached');
  log('phone, so the APK has never been installed, launched or run. Install it on');
  log('real hardware to confirm it boots and renders.');
  console.log('');

  mkdirSync(path.join(ANDROID_DIR, 'build-reports'), { recursive: true });
  writeFileSync(
    path.join(ANDROID_DIR, 'build-reports', 'last-build.json'),
    `${JSON.stringify(
      {
        apk,
        bytes,
        variant: release ? 'release' : 'debug',
        tier: noPrune ? null : tier,
        webPayloadBytes: webBytes,
        playBaseCapBytes: PLAY_CAP,
        withinPlayCap: bytes <= PLAY_CAP,
        assetGroups: prune ? Object.fromEntries(prune.byGroup) : null,
        builtAt: new Date().toISOString(),
        deviceVerified: false,
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

main();
