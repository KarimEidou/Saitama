/**
 * ANDROID SDK INSTALLER — idempotent, non-interactive, proxy-aware.
 *
 * Provisions the exact Android SDK components the Capacitor 8.5.0 / AGP 8.13.0
 * Android build needs, so `scripts/build-apk.ts` can run `./gradlew assembleDebug`
 * on a machine that starts with no `ANDROID_HOME`, no `adb`, and no SDK at all.
 *
 * Run:
 *   npx tsx scripts/android-sdk.ts            # install (no-op if already done)
 *   npx tsx scripts/android-sdk.ts --list     # print what is installed, install nothing
 *   npx tsx scripts/android-sdk.ts --force    # re-run sdkmanager even if markers exist
 *
 * WHY THE SDK LIVES OUTSIDE THE REPOSITORY
 * ----------------------------------------
 * Default root is `<repo>/../android-sdk` (i.e. a sibling of the checkout), NOT
 * a directory inside it. This is deliberate and load-bearing:
 *
 *   - `npm run format` is `prettier --write "**\/*.{ts,tsx,js,mjs,json,css,html,md}"`
 *     and the repo has no `.prettierignore`. An in-repo SDK would have thousands
 *     of its own JSON/JS files rewritten in place by any agent running `format`.
 *   - `eslint.config.js` ignores `android/**` but not an SDK directory, so `npm run lint`
 *     would walk ~3 GB of third-party sources.
 *   - Keeping ~3 GB of re-downloadable third-party binaries out of the work tree
 *     removes any chance of them being caught by `git add -A`.
 *
 * Override with `ANDROID_SDK_ROOT` or `ANDROID_HOME` if you want it elsewhere.
 *
 * LICENCES
 * --------
 * Licences are accepted by writing the SHA-1 licence-hash files directly into
 * `$ANDROID_HOME/licenses/`. This is what `sdkmanager` itself checks, and it is
 * far more reliable than piping `yes` into `sdkmanager --licenses`, which
 * deadlocks or half-accepts when stdin is not a TTY.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ config */

/**
 * Command-line tools package. `_latest.zip` is a moving target on Google's side,
 * so the build number is pinned in the URL and the payload is pinned by SHA-256
 * below — a silent upstream swap should fail loudly, not install something else.
 */
const CMDLINE_TOOLS_BUILD = '13114758';
const CMDLINE_TOOLS_URL =
  `https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_BUILD}_latest.zip`;
const CMDLINE_TOOLS_SHA256 = '7ec965280a073311c339e571cd5de778b9975026cfcbe79f2b1cdcb1e15317ee';
const CMDLINE_TOOLS_BYTES = 164_760_899;

/**
 * SDK packages to install.
 *
 * `compileSdk`/`targetSdk` come from `@capacitor/android@8.5.0`'s
 * `capacitor/build.gradle` (both 36, minSdk 24); AGP 8.13.0 pairs with
 * build-tools 36.0.0. android-35 / build-tools 35.0.0 are installed too because
 * third-party plugin modules pin older compileSdk values and AGP will not
 * silently downgrade for them.
 *
 * `marker` is a path relative to the SDK root whose existence means "installed";
 * it is what makes re-running this script a fast no-op.
 */
interface SdkPackage {
  readonly id: string;
  readonly marker: string;
  readonly why: string;
}

const PACKAGES: readonly SdkPackage[] = [
  { id: 'platform-tools', marker: 'platform-tools/adb', why: 'adb + core device tooling' },
  {
    id: 'platforms;android-36',
    marker: 'platforms/android-36/android.jar',
    why: 'compileSdk/targetSdk 36 (Capacitor 8.5.0 default)',
  },
  {
    id: 'platforms;android-35',
    marker: 'platforms/android-35/android.jar',
    why: 'fallback compileSdk for plugin modules pinned to 35',
  },
  {
    id: 'build-tools;36.0.0',
    marker: 'build-tools/36.0.0/aapt2',
    why: 'aapt2/d8/zipalign/apksigner for AGP 8.13.0',
  },
  {
    id: 'build-tools;35.0.0',
    marker: 'build-tools/35.0.0/aapt2',
    why: 'fallback build-tools for modules pinned to 35',
  },
];

/**
 * SHA-1 licence hashes accepted by `sdkmanager`. Each file may hold several
 * hashes (one per line); sdkmanager treats the licence as accepted if any line
 * matches the hash it computes for the licence text it is carrying, so listing
 * both current and historical hashes keeps this working across SDK releases.
 */
const LICENSES: Readonly<Record<string, readonly string[]>> = {
  'android-sdk-license': [
    '24333f8a63b6825ea9c5514f83c2829b004d1fee',
    '8933bad161af4178b1185d1a37fbf41ea5269c55',
    'd56f5187479451eabf01fb78af6dfcb131a6481e',
  ],
  'android-sdk-preview-license': [
    '84831b9409646a918e30573bab4c9c91346d8abd',
    '504667f4c0de7af1a06de9f4b1727b84351f2910',
  ],
  'android-sdk-arm-dbt-license': ['859f317696f67ef3d7f30a50a5560e7834b43903'],
  'android-googletv-license': ['601085b94cd77f0b54ff86406957099ebe79c4d6'],
  'android-sdk-preview-license-old': ['79120722343a6f314e0719f863036c702b0e6b2a'],
  'google-gdk-license': ['33b6a2b64607f11b759f320ef9dff4ae5c47d97a'],
  'intel-android-extra-license': ['d975f751698a77b662f1254ddbeed3901e976f5a'],
  'mips-android-sysimage-license': ['e9acab5b5fbb560a72cfaecce8946896ff6aab9d'],
};

/* ------------------------------------------------------------------- utils */

function log(msg: string): void {
  console.log(`[android-sdk] ${msg}`);
}

function fail(msg: string): never {
  console.error(`\n[android-sdk] FAILED: ${msg}\n`);
  process.exit(1);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Resolve the SDK root: explicit env wins, else a sibling of the repo. */
export function sdkRoot(): string {
  const fromEnv = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.resolve(REPO_ROOT, '..', 'android-sdk');
}

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/* ---------------------------------------------------------------- download */

/**
 * Download with `curl` rather than `fetch`. Node's undici does not read
 * `HTTPS_PROXY` from the environment, and this sandbox routes all outbound
 * HTTPS through an agent proxy; curl honours it natively. `-C -` resumes a
 * partial file so an interrupted 165 MB download is not restarted from zero.
 */
function download(url: string, dest: string): void {
  mkdirSync(path.dirname(dest), { recursive: true });
  const partial = `${dest}.part`;
  const result = spawnSync(
    'curl',
    [
      '-fL',
      '--retry',
      '5',
      '--retry-delay',
      '3',
      '--retry-all-errors',
      '--connect-timeout',
      '30',
      '-C',
      '-',
      '-o',
      partial,
      url,
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  );
  if (result.status !== 0) fail(`curl exited ${result.status} downloading ${url}`);
  renameSync(partial, dest);
}

/**
 * Structural + cryptographic verification of the command-line tools archive.
 * Truncation, corruption and upstream substitution are three different failure
 * modes and each gets its own check.
 */
function verifyArchive(zip: string): void {
  const size = statSync(zip).size;
  if (size !== CMDLINE_TOOLS_BYTES) {
    fail(
      `size mismatch for ${zip}: got ${size} bytes, expected ${CMDLINE_TOOLS_BYTES}. ` +
        `Delete the file and re-run to re-download.`
    );
  }

  const digest = sha256File(zip);
  if (digest !== CMDLINE_TOOLS_SHA256) {
    if (process.env.ANDROID_SDK_ALLOW_SHA_DRIFT === '1') {
      log(`WARNING: SHA-256 drift accepted via ANDROID_SDK_ALLOW_SHA_DRIFT=1 (got ${digest})`);
    } else {
      fail(
        `SHA-256 mismatch for ${zip}\n` +
          `  expected ${CMDLINE_TOOLS_SHA256}\n` +
          `  actual   ${digest}\n` +
          `Google may have re-published the pinned build. Verify the new archive, then update\n` +
          `CMDLINE_TOOLS_SHA256/CMDLINE_TOOLS_BYTES in this file, or set ANDROID_SDK_ALLOW_SHA_DRIFT=1.`
      );
    }
  }

  const listing = execFileSync('unzip', ['-l', zip], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (!listing.includes('cmdline-tools/bin/sdkmanager')) {
    fail(`${zip} does not contain cmdline-tools/bin/sdkmanager — not a command-line tools archive`);
  }
  log(`archive verified — ${formatBytes(size)}, sha256 ${digest.slice(0, 16)}…`);
}

/* ----------------------------------------------------- cmdline-tools setup */

function sdkmanagerPath(root: string): string {
  return path.join(root, 'cmdline-tools', 'latest', 'bin', 'sdkmanager');
}

/**
 * Extract into the `cmdline-tools/latest/` layout. The archive unpacks to a bare
 * `cmdline-tools/` directory; sdkmanager refuses to run unless it sits in a
 * versioned (or `latest`) subdirectory, because it locates the SDK root by
 * walking two levels up from its own bin directory.
 */
function ensureCmdlineTools(root: string): void {
  const target = sdkmanagerPath(root);
  if (existsSync(target)) {
    log(`cmdline-tools already present at ${path.dirname(path.dirname(target))}`);
    return;
  }

  const zip = path.join(root, '.downloads', path.basename(CMDLINE_TOOLS_URL));
  if (existsSync(zip)) {
    log(`reusing cached archive ${zip}`);
  } else {
    log(`downloading ${CMDLINE_TOOLS_URL} (~${formatBytes(CMDLINE_TOOLS_BYTES)}) …`);
    download(CMDLINE_TOOLS_URL, zip);
  }
  verifyArchive(zip);

  const staging = path.join(root, '.staging');
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  log(`extracting …`);
  execFileSync('unzip', ['-q', zip, '-d', staging], { stdio: 'inherit' });

  const unpacked = path.join(staging, 'cmdline-tools');
  if (!existsSync(unpacked)) fail(`expected ${unpacked} after extraction`);

  const latest = path.join(root, 'cmdline-tools', 'latest');
  mkdirSync(path.dirname(latest), { recursive: true });
  rmSync(latest, { recursive: true, force: true });
  renameSync(unpacked, latest);
  rmSync(staging, { recursive: true, force: true });

  // The zip preserves modes, but be defensive: an unexecutable sdkmanager is a
  // confusing failure mode several layers down.
  for (const bin of readdirSync(path.join(latest, 'bin'))) {
    try {
      chmodSync(path.join(latest, 'bin', bin), 0o755);
    } catch {
      /* best effort */
    }
  }
  if (!existsSync(target)) fail(`sdkmanager missing at ${target} after extraction`);
  log(`cmdline-tools installed at ${latest}`);
}

/* -------------------------------------------------------------- licences */

function writeLicenses(root: string): void {
  const dir = path.join(root, 'licenses');
  mkdirSync(dir, { recursive: true });
  let written = 0;
  for (const [name, hashes] of Object.entries(LICENSES)) {
    const file = path.join(dir, name);
    // Leading newline matches what `sdkmanager --licenses` itself writes.
    const body = `\n${hashes.join('\n')}\n`;
    const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (current !== body) {
      writeFileSync(file, body, 'utf8');
      written += 1;
    }
  }
  log(`licences accepted — ${Object.keys(LICENSES).length} files in ${dir} (${written} rewritten)`);
}

/* -------------------------------------------------------------- packages */

function missingPackages(root: string): SdkPackage[] {
  return PACKAGES.filter((pkg) => !existsSync(path.join(root, pkg.marker)));
}

function runSdkmanager(root: string, args: string[]): { status: number; stdout: string } {
  const result = spawnSync(sdkmanagerPath(root), [`--sdk_root=${root}`, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 << 20,
    env: {
      ...process.env,
      ANDROID_SDK_ROOT: root,
      ANDROID_HOME: root,
      // sdkmanager reads stdin for licence prompts; the licence files above mean
      // it should never prompt, but an EOF is safer than a dangling handle.
      REPO_OS_OVERRIDE: 'linux',
    },
    input: '',
  });
  const stdout = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { status: result.status ?? 1, stdout };
}

function installPackages(root: string, force: boolean): void {
  const missing = force ? [...PACKAGES] : missingPackages(root);
  if (missing.length === 0) {
    log(`all ${PACKAGES.length} SDK packages already installed — nothing to do`);
    return;
  }
  log(`installing ${missing.length} package(s):`);
  for (const pkg of missing) log(`    ${pkg.id.padEnd(24)} — ${pkg.why}`);

  const { status, stdout } = runSdkmanager(
    root,
    missing.map((p) => p.id)
  );
  // sdkmanager is noisy; surface it only when something is worth seeing.
  const interesting = stdout
    .split('\n')
    .filter((l) => l.trim() && !/^\[=*>?\s*\]/.test(l.trim()) && !/^\s*$/.test(l))
    .join('\n');
  if (status !== 0) {
    console.error(interesting);
    fail(`sdkmanager exited ${status} while installing: ${missing.map((p) => p.id).join(' ')}`);
  }
  if (interesting.trim()) console.log(interesting);

  const stillMissing = missingPackages(root);
  if (stillMissing.length > 0) {
    fail(
      `sdkmanager reported success but these markers are absent:\n` +
        stillMissing.map((p) => `    ${p.id} -> ${p.marker}`).join('\n')
    );
  }
}

/* ----------------------------------------------------------------- report */

function directorySize(dir: string): number {
  let total = 0;
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
      else if (entry.isFile()) {
        try {
          total += statSync(full).size;
        } catch {
          /* raced away */
        }
      }
    }
  }
  return total;
}

function report(root: string): void {
  console.log('');
  log('installed components:');
  for (const pkg of PACKAGES) {
    const present = existsSync(path.join(root, pkg.marker));
    console.log(`    ${present ? 'OK  ' : 'MISS'} ${pkg.id}`);
  }
  const { stdout } = runSdkmanager(root, ['--list_installed']);
  const rows = stdout
    .split('\n')
    .filter((l) => /^\s{2}\S/.test(l) && !/Path\s*\|/.test(l) && !/^\s*-+/.test(l));
  if (rows.length > 0) {
    console.log('');
    log('sdkmanager --list_installed:');
    for (const row of rows) console.log(`    ${row.trim()}`);
  }
  console.log('');
  log(`SDK root  : ${root}`);
  log(`SDK size  : ${formatBytes(directorySize(root))}`);
  console.log('');
  log('export these to build:');
  console.log(`    export ANDROID_SDK_ROOT="${root}"`);
  console.log(`    export ANDROID_HOME="${root}"`);
  console.log(`    export PATH="$ANDROID_HOME/platform-tools:$PATH"`);
}

/* ------------------------------------------------------------------- main */

function main(): void {
  const args = process.argv.slice(2);
  const root = sdkRoot();
  mkdirSync(root, { recursive: true });
  log(`SDK root: ${root}`);

  if (args.includes('--list')) {
    if (!existsSync(sdkmanagerPath(root))) fail(`no SDK at ${root} — run without --list first`);
    report(root);
    return;
  }

  ensureCmdlineTools(root);
  writeLicenses(root);
  installPackages(root, args.includes('--force'));

  // `local.properties` is how Gradle finds the SDK; write it whenever the
  // android project exists so the build needs no ambient environment.
  const androidDir = path.join(REPO_ROOT, 'android');
  if (existsSync(androidDir)) {
    const localProps = path.join(androidDir, 'local.properties');
    const body = `# Generated by scripts/android-sdk.ts — do not edit by hand.\nsdk.dir=${root}\n`;
    if (!existsSync(localProps) || readFileSync(localProps, 'utf8') !== body) {
      writeFileSync(localProps, body, 'utf8');
      log(`wrote ${localProps}`);
    }
  }

  report(root);
}

// Only self-execute when run directly; `scripts/build-apk.ts` imports `sdkRoot()`.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
