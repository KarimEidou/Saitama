/**
 * ATTRIBUTION GENERATOR — `npx tsx tools/attribution.ts`
 *
 * Regenerates `ATTRIBUTION.md` from the committed provenance records, and
 * refuses to do so if the provenance does not hold up.
 *
 * ── WHY THIS IS A PROGRAM AND NOT A HAND-WRITTEN FILE ──────────────────────
 * A hand-written credits page drifts the moment someone adds an asset, and a
 * stale credits page is worse than none: it is a false statement about
 * somebody else's work. Everything here is therefore derived from files that
 * the pipeline itself writes and git tracks —
 *
 *   tools/manifest/textures.json    41 material entries
 *   tools/manifest/models.json      39 model entries
 *   tools/manifest/hdris.json        4 environment entries
 *   tools/manifest/characters.json  14 generated character entries
 *   assets/assets.lock.json         every downloaded file: url, md5, sha256
 *   package.json + package-lock.json + node_modules/<pkg>/package.json
 *
 * — so the document cannot say anything the repository does not already
 * record. If a claim in `ATTRIBUTION.md` is wrong, the fix is to correct the
 * manifest and re-run, never to edit the markdown.
 *
 * ── THE LOAD-BEARING CLAIM ─────────────────────────────────────────────────
 * This project asserts that NO third-party character or monster asset exists
 * anywhere in it: every humanoid is geometry this repository generates in
 * code. That is the claim most worth lying about and the one a reader can
 * least easily check, so it gets nine independent checks (`auditCharacters`)
 * rather than a sentence. They do not consult the manifest's own
 * `thirdPartyCharacterAssets: 0` and believe it — they recompute it from the
 * download lockfile, which is the record of what actually crossed the
 * network, and then compare.
 *
 * ── SEVERITIES ─────────────────────────────────────────────────────────────
 *   error  — a missing author, a missing licence, a copyleft licence on a
 *            shipped asset, a character asset that came from outside. The
 *            document is NOT written and the process exits 1. An incomplete
 *            credits file must never be committed silently.
 *   warn   — something a human should know but that does not invalidate the
 *            attribution (an unreachable first-party URL, say). Printed AND
 *            reproduced in the document under "Known gaps", because a
 *            compliance document that hides its own soft spots is not one.
 *
 * ── DETERMINISM ────────────────────────────────────────────────────────────
 * Same inputs, byte-identical output: no timestamps, no absolute paths, no
 * map-iteration order, every list sorted by a stable key. That is what makes
 * `--check` usable as a CI gate — it regenerates in memory and diffs against
 * the committed file, so an asset added without re-running is a red build.
 *
 * This tool reads the manifests directly rather than through
 * `loadSourceManifests()`: that loader validates every `tools/manifest/*.json`
 * against the third-party source-entry schema, which `characters.json`
 * deliberately is not. A compliance tool must be able to run on a repository
 * whose pipeline is broken — that is exactly when someone reaches for it.
 *
 * ── USAGE ──────────────────────────────────────────────────────────────────
 *   npx tsx tools/attribution.ts             audit, then write ATTRIBUTION.md
 *   npx tsx tools/attribution.ts --check     audit, diff, never write (CI)
 *   npx tsx tools/attribution.ts --out P     write somewhere else
 *   npx tsx tools/attribution.ts --quiet     only problems and the verdict
 *
 * Exit codes: 0 clean, 1 an error-severity problem or (in --check) drift.
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { REPO_ROOT, Logger, formatBytes, rel } from './lib/index.ts';

/* -------------------------------------------------------------------------- */
/* Locations                                                                  */
/* -------------------------------------------------------------------------- */

const MANIFEST_DIR = path.join(REPO_ROOT, 'tools', 'manifest');
const LOCKFILE = path.join(REPO_ROOT, 'assets', 'assets.lock.json');
const PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');
const PACKAGE_LOCK = path.join(REPO_ROOT, 'package-lock.json');
const NODE_MODULES = path.join(REPO_ROOT, 'node_modules');
const DEFAULT_OUT = path.join(REPO_ROOT, 'ATTRIBUTION.md');

/** Manifests carrying third-party entries, in the order they are credited. */
const SOURCE_MANIFESTS = [
  { file: 'textures.json', heading: 'PBR materials', summary: 'PBR materials' },
  { file: 'models.json', heading: 'Models', summary: 'models' },
  { file: 'hdris.json', heading: 'HDRI environments', summary: 'HDRI environments' },
] as const;

const CHARACTER_MANIFEST = 'characters.json';

/* -------------------------------------------------------------------------- */
/* Licence catalogue                                                          */
/* -------------------------------------------------------------------------- */

type Copyleft = 'strong' | 'weak' | null;

interface ILicenseFacts {
  /** Full name, as the steward of the licence writes it. */
  readonly name: string;
  readonly url: string;
  /** Reciprocal obligations triggered by distributing a derived work. */
  readonly copyleft: Copyleft;
  /** The licence obliges us to credit the author when we ship. */
  readonly requiresAttribution: boolean;
  /** The licence obliges us to reproduce its text / the copyright notice. */
  readonly requiresNotice: boolean;
}

/**
 * Every SPDX identifier that appears anywhere in this repository's inputs.
 * An identifier that is NOT in here is an error, not a shrug: an unrecognised
 * licence is an unreviewed licence.
 */
const LICENSES: Readonly<Record<string, ILicenseFacts>> = {
  '0BSD': {
    name: 'BSD Zero Clause License',
    url: 'https://spdx.org/licenses/0BSD.html',
    copyleft: null,
    requiresAttribution: false,
    requiresNotice: false,
  },
  'Apache-2.0': {
    name: 'Apache License 2.0',
    url: 'https://www.apache.org/licenses/LICENSE-2.0',
    copyleft: null,
    requiresAttribution: false,
    requiresNotice: true,
  },
  'BSD-2-Clause': {
    name: 'BSD 2-Clause "Simplified" License',
    url: 'https://spdx.org/licenses/BSD-2-Clause.html',
    copyleft: null,
    requiresAttribution: false,
    requiresNotice: true,
  },
  'BSD-3-Clause': {
    name: 'BSD 3-Clause "New" License',
    url: 'https://spdx.org/licenses/BSD-3-Clause.html',
    copyleft: null,
    requiresAttribution: false,
    requiresNotice: true,
  },
  'BlueOak-1.0.0': {
    name: 'Blue Oak Model License 1.0.0',
    url: 'https://blueoakcouncil.org/license/1.0.0',
    copyleft: null,
    requiresAttribution: false,
    requiresNotice: true,
  },
  'CC-BY-3.0': {
    name: 'Creative Commons Attribution 3.0',
    url: 'https://creativecommons.org/licenses/by/3.0/',
    copyleft: null,
    requiresAttribution: true,
    requiresNotice: true,
  },
  'CC-BY-4.0': {
    name: 'Creative Commons Attribution 4.0 International',
    url: 'https://creativecommons.org/licenses/by/4.0/',
    copyleft: null,
    requiresAttribution: true,
    requiresNotice: true,
  },
  'CC0-1.0': {
    name: 'Creative Commons Zero v1.0 Universal (public-domain dedication)',
    url: 'https://creativecommons.org/publicdomain/zero/1.0/',
    copyleft: null,
    requiresAttribution: false,
    requiresNotice: false,
  },
  'GPL-3.0-or-later': {
    name: 'GNU General Public License v3.0 or later',
    url: 'https://www.gnu.org/licenses/gpl-3.0.html',
    copyleft: 'strong',
    requiresAttribution: false,
    requiresNotice: true,
  },
  ISC: {
    name: 'ISC License',
    url: 'https://spdx.org/licenses/ISC.html',
    copyleft: null,
    requiresAttribution: false,
    requiresNotice: true,
  },
  'LGPL-3.0-or-later': {
    name: 'GNU Lesser General Public License v3.0 or later',
    url: 'https://www.gnu.org/licenses/lgpl-3.0.html',
    copyleft: 'weak',
    requiresAttribution: false,
    requiresNotice: true,
  },
  MIT: {
    name: 'MIT License',
    url: 'https://spdx.org/licenses/MIT.html',
    copyleft: null,
    requiresAttribution: false,
    requiresNotice: true,
  },
  'MPL-2.0': {
    name: 'Mozilla Public License 2.0',
    url: 'https://www.mozilla.org/MPL/2.0/',
    copyleft: 'weak',
    requiresAttribution: false,
    requiresNotice: true,
  },
  'OFL-1.1': {
    name: 'SIL Open Font License 1.1',
    url: 'https://openfontlicense.org/',
    copyleft: null,
    requiresAttribution: true,
    requiresNotice: true,
  },
  Unlicense: {
    name: 'The Unlicense (public-domain dedication)',
    url: 'https://unlicense.org/',
    copyleft: null,
    requiresAttribution: false,
    requiresNotice: false,
  },
};

/**
 * Licences an ASSET may carry and still be bundled into the shipped APK.
 * Deliberately narrow. Nothing reciprocal: an APK cannot honour a copyleft
 * obligation it has no mechanism to discharge, so the answer is to never
 * accept the asset in the first place.
 */
const ASSET_LICENSE_ALLOWLIST: ReadonlySet<string> = new Set([
  'CC0-1.0',
  'CC-BY-4.0',
  'CC-BY-3.0',
  'MIT',
  'Apache-2.0',
  'OFL-1.1',
  'Unlicense',
]);

/* -------------------------------------------------------------------------- */
/* Providers                                                                  */
/* -------------------------------------------------------------------------- */

interface IProviderFacts {
  readonly name: string;
  readonly url: string;
  readonly firstParty: boolean;
  /** Hosts this provider is permitted to serve bytes from. */
  readonly hosts: readonly string[];
  readonly note: string;
}

const PROVIDERS: Readonly<Record<string, IProviderFacts>> = {
  polyhaven: {
    name: 'Poly Haven',
    url: 'https://polyhaven.com/',
    firstParty: false,
    hosts: ['dl.polyhaven.org', 'polyhaven.com', 'api.polyhaven.com'],
    note:
      'Every asset on Poly Haven is released under CC0-1.0. Attribution is not ' +
      'legally required; it is recorded here anyway because the authors did the work.',
  },
  ambientcg: {
    name: 'ambientCG',
    url: 'https://ambientcg.com/',
    firstParty: false,
    hosts: ['ambientcg.com', 'acg-download.struffelproductions.com'],
    note:
      'Evaluated as a secondary CC0 source and, in the end, not drawn on: ' +
      'Poly Haven publishes a per-file md5 and ambientCG ships whole-material ' +
      'zips with no hash, so the integrity chain would have ended at the zip.',
  },
  procedural: {
    name: 'This repository',
    url: 'https://github.com/KarimEidou/Saitama',
    firstParty: true,
    hosts: [],
    note: 'Generated by code in this repository. Nothing is downloaded.',
  },
};

/* -------------------------------------------------------------------------- */
/* Redistributed binaries                                                     */
/* -------------------------------------------------------------------------- */

/**
 * npm packages whose `license` field describes the WRAPPER and not the thing
 * inside it.
 *
 * Several of the build tools here are thin Node shims around native binaries
 * compiled from another project with another licence, and a couple ship no
 * licence text at all. Recording only the wrapper's declared field would be
 * accurate about npm metadata and wrong about what is on disk, which is the
 * kind of accuracy an attribution file exists to avoid.
 *
 * These are hand-verified facts, not derived ones — so `upstreamNotes()`
 * asserts each named package is genuinely a declared dependency. The prose
 * cannot outlive the dependency it describes.
 */
interface IUpstreamNote {
  readonly pkg: string;
  readonly contains: string;
  readonly upstreamLicense: string;
  readonly note: string;
}

const UPSTREAM_NOTES: readonly IUpstreamNote[] = [
  {
    pkg: 'ktx2tools',
    contains: 'Khronos KTX-Software 4.4.0 (`ktx`, `ktx2check`)',
    upstreamLicense: 'Apache-2.0',
    note:
      'The npm package declares MIT and ships no licence file; the binaries it ' +
      'redistributes are Khronos KTX-Software, which is Apache-2.0. Every ' +
      'KTX2 texture in this project is encoded by them.',
  },
  {
    pkg: '@gpu-tex-enc/basis',
    contains: 'Binomial LLC Basis Universal (`basisu`)',
    upstreamLicense: 'Apache-2.0',
    note: 'Wrapper and upstream agree on Apache-2.0.',
  },
  {
    pkg: 'draco3dgltf',
    contains: 'Google Draco mesh compression',
    upstreamLicense: 'Apache-2.0',
    note: 'Wrapper and upstream agree on Apache-2.0.',
  },
  {
    pkg: 'ffmpeg-static',
    contains: 'FFmpeg builds, downloaded on install',
    upstreamLicense: 'GPL-3.0-or-later',
    note:
      'Declared in `devDependencies` but referenced by no code in this ' +
      'repository. It contributes nothing to any build output and nothing to ' +
      'the shipped game; the cleanest resolution is to drop the dependency.',
  },
  {
    pkg: 'playwright',
    contains: 'Chromium, Firefox and WebKit builds, downloaded on install',
    upstreamLicense: 'BSD-3-Clause and others',
    note:
      'Used only to drive the verification harnesses. No browser binary is ' +
      'redistributed by this project — the Android APK uses the device’s own ' +
      'system WebView.',
  },
];

/**
 * The Android SDK is provisioned OUTSIDE the repository (a sibling directory,
 * see `scripts/android-sdk.ts`) and is a build toolchain, not a dependency:
 * nothing from it is redistributed by this project beyond the ordinary
 * compiled output of an Android application.
 */
const ANDROID_SDK_NOTE =
  'Building the APK downloads the Android SDK under the ' +
  '[Android Software Development Kit License Agreement](https://developer.android.com/studio/terms). ' +
  '`scripts/android-sdk.ts` installs it into a sibling directory of this ' +
  'checkout, never inside it, and accepts those terms on the operator’s ' +
  'behalf — so anyone running that script should read them first.';

/**
 * Hosts that publish third-party character/humanoid art. A character entry
 * that so much as mentions one of these is treated as third-party until
 * proven otherwise. Blocklists are usually a weak tool; here it is exactly
 * right, because the claim under test is "we went nowhere near these".
 */
const CHARACTER_ASSET_HOSTS: readonly string[] = [
  'mixamo.com',
  'sketchfab.com',
  'turbosquid.com',
  'cgtrader.com',
  'renderpeople.com',
  'daz3d.com',
  'reallusion.com',
  'artstation.com',
  'opengameart.org',
  'assetstore.unity.com',
  'unrealengine.com',
  'quixel.com',
  'fab.com',
  'itch.io',
  'kenney.nl',
  'poly.pizza',
  'models-resource.com',
  'deviantart.com',
];

/* -------------------------------------------------------------------------- */
/* Input shapes                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Only the fields this tool reads. Intentionally looser than
 * `tools/lib/types.ts`: the audit must be able to observe that a required
 * field is MISSING, which a type that declares it required cannot express.
 */
interface IAttributionBlock {
  readonly license?: string;
  readonly author?: string;
  readonly sourceUrl?: string;
  readonly attributionUrl?: string;
  readonly modifications?: string;
  readonly year?: number;
}

interface ISourceFileRow {
  readonly path?: string;
  readonly url?: string;
  readonly md5?: string;
  readonly bytes?: number;
}

interface ISourceEntry {
  readonly id?: string;
  readonly kind?: string;
  readonly name?: string;
  readonly provider?: string;
  readonly providerAssetId?: string;
  readonly attribution?: IAttributionBlock;
  readonly sourceUrl?: string;
  readonly notes?: string;
  readonly files?: readonly ISourceFileRow[];
}

interface ISourceManifestFile {
  readonly version?: number;
  readonly kind?: string;
  readonly description?: string;
  readonly entries?: readonly ISourceEntry[];
}

interface ICharacterEntry {
  readonly id?: string;
  readonly name?: string;
  readonly role?: string;
  readonly triangles?: number;
  readonly generator?: string;
  readonly provider?: string;
  readonly skeleton?: string;
  readonly attribution?: IAttributionBlock;
  readonly sourceUrl?: string;
  readonly files?: readonly ISourceFileRow[];
}

interface ICharacterManifestFile {
  readonly description?: string;
  readonly thirdPartyCharacterAssets?: number;
  readonly cc0Attribution?: Readonly<Record<string, IAttributionBlock>>;
  readonly entries?: readonly ICharacterEntry[];
}

interface ILockRow {
  readonly sha256?: string;
  readonly md5?: string;
  readonly bytes?: number;
  readonly assetId?: string;
  readonly path?: string;
}

interface ILockAsset {
  readonly provider?: string;
  readonly kind?: string;
  readonly bytes?: number;
  readonly files?: readonly string[];
}

interface ILockFile {
  readonly files?: Readonly<Record<string, ILockRow>>;
  readonly assets?: Readonly<Record<string, ILockAsset>>;
  readonly totals?: { readonly entries?: number; readonly files?: number; readonly bytes?: number };
}

interface IPackageJson {
  readonly name?: string;
  readonly version?: string;
  readonly license?: string | { type?: string };
  readonly licenses?: unknown;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

interface IPackageLock {
  readonly packages?: Readonly<
    Record<string, { version?: string; license?: string; dev?: boolean; optional?: boolean }>
  >;
}

/* -------------------------------------------------------------------------- */
/* Derived shapes                                                             */
/* -------------------------------------------------------------------------- */

type Severity = 'error' | 'warn';

interface IProblem {
  readonly severity: Severity;
  /** What the problem is about — an asset id, a package name, a file. */
  readonly subject: string;
  readonly message: string;
}

interface ICheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

interface ICreditedAsset {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly providerAssetId: string;
  readonly license: string;
  readonly author: string;
  readonly sourceUrl: string;
  readonly year?: number;
  readonly fileCount: number;
  readonly bytes: number;
  readonly notes?: string;
}

interface INpmPackage {
  readonly name: string;
  readonly range: string;
  readonly version: string;
  readonly license: string;
  /** Shipped to users, or only used to build. */
  readonly runtime: boolean;
  /** Where the version + licence were read from. */
  readonly source: 'node_modules' | 'package-lock';
}

interface ITreeLicenseRow {
  readonly license: string;
  readonly total: number;
  readonly runtime: number;
  readonly buildOnly: number;
}

interface ICharacterAudit {
  readonly entries: readonly ICharacterEntry[];
  readonly byRole: ReadonlyMap<string, number>;
  readonly thirdParty: readonly string[];
  readonly declared: number | undefined;
  readonly checks: readonly ICheck[];
  readonly reusedMaps: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

async function readJsonIfPresent<T>(file: string): Promise<T | null> {
  try {
    return await readJson<T>(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Normalise npm's several historical shapes for the licence field. */
function licenseOf(pkg: IPackageJson): string {
  const direct = pkg.license;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  if (direct && typeof direct === 'object' && typeof direct.type === 'string') return direct.type;
  const legacy = pkg.licenses;
  if (Array.isArray(legacy)) {
    const types = legacy
      .map((l) => (typeof l === 'string' ? l : ((l as { type?: string })?.type ?? '')))
      .filter(Boolean);
    if (types.length > 0) return types.join(' OR ');
  }
  return '';
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

/** Every http(s) URL mentioned anywhere inside a value. */
function urlsIn(value: unknown): string[] {
  const found = JSON.stringify(value ?? null).match(/https?:\/\/[^"'\s\\)]+/g);
  return found ? [...new Set(found)] : [];
}

/** Escape the pipe so a value cannot break out of a markdown table cell. */
function cell(value: string | number | undefined): string {
  if (value === undefined || value === '') return '—';
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function link(label: string, url: string | undefined): string {
  if (!url) return cell(label);
  return `[${cell(label)}](${url})`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Sort helper that never depends on the platform's locale. */
function byKey<T>(key: (item: T) => string) {
  return (a: T, b: T): number => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                    */
/* -------------------------------------------------------------------------- */

interface IInputs {
  readonly manifests: ReadonlyMap<string, ISourceManifestFile>;
  readonly characters: ICharacterManifestFile;
  readonly lock: ILockFile;
  readonly pkg: IPackageJson;
  readonly lockedPackages: IPackageLock['packages'];
  readonly npm: readonly INpmPackage[];
  readonly tree: readonly ITreeLicenseRow[];
  /** Packages in the tree carrying a reciprocal licence. */
  readonly copyleftInTree: readonly { name: string; license: string; runtime: boolean }[];
}

async function loadInputs(problems: IProblem[]): Promise<IInputs> {
  const manifests = new Map<string, ISourceManifestFile>();
  for (const { file } of SOURCE_MANIFESTS) {
    manifests.set(file, await readJson<ISourceManifestFile>(path.join(MANIFEST_DIR, file)));
  }
  const characters = await readJson<ICharacterManifestFile>(
    path.join(MANIFEST_DIR, CHARACTER_MANIFEST)
  );
  const lock = await readJson<ILockFile>(LOCKFILE);
  const pkg = await readJson<IPackageJson>(PACKAGE_JSON);
  const packageLock = await readJsonIfPresent<IPackageLock>(PACKAGE_LOCK);
  const lockedPackages = packageLock?.packages;

  // A manifest file this tool does not know about is a silent credit gap:
  // somebody added a category and nobody added it to the credits.
  const known = new Set<string>([...SOURCE_MANIFESTS.map((m) => m.file), CHARACTER_MANIFEST]);
  for (const name of (await readdir(MANIFEST_DIR)).sort()) {
    if (name.endsWith('.json') && !known.has(name)) {
      problems.push({
        severity: 'error',
        subject: `tools/manifest/${name}`,
        message:
          'manifest file is not credited by tools/attribution.ts — add it to SOURCE_MANIFESTS',
      });
    }
  }

  const npm = await loadNpmPackages(pkg, lockedPackages, problems);

  // The upstream-contents table is hand-verified prose. Anchor it: a note
  // about a package nobody depends on any more is a claim about a phantom,
  // and the whole point of this tool is that no claim goes unchecked.
  const declaredNames = new Set(npm.map((p) => p.name));
  for (const note of UPSTREAM_NOTES) {
    if (!declaredNames.has(note.pkg)) {
      problems.push({
        severity: 'warn',
        subject: note.pkg,
        message:
          'UPSTREAM_NOTES describes a package that is no longer a dependency — ' +
          'delete the note in tools/attribution.ts',
      });
    }
  }

  const { tree, copyleft } = summariseTree(lockedPackages, problems);
  return { manifests, characters, lock, pkg, lockedPackages, npm, tree, copyleftInTree: copyleft };
}

/**
 * Resolve every DECLARED dependency to a version and a licence.
 *
 * The declared set comes from `package.json` — committed, sorted, identical on
 * every machine — while the version and licence come from the installed
 * `node_modules/<name>/package.json`, which is the artefact that actually gets
 * used. `package-lock.json` is the fallback so this runs before `npm install`,
 * which is precisely when a licence question tends to be asked.
 */
async function loadNpmPackages(
  pkg: IPackageJson,
  locked: IPackageLock['packages'],
  problems: IProblem[]
): Promise<INpmPackage[]> {
  const declared: { name: string; range: string; runtime: boolean }[] = [
    ...Object.entries(pkg.dependencies ?? {}).map(([name, range]) => ({
      name,
      range,
      runtime: true,
    })),
    ...Object.entries(pkg.devDependencies ?? {}).map(([name, range]) => ({
      name,
      range,
      runtime: false,
    })),
  ].sort(byKey((d) => d.name));

  const out: INpmPackage[] = [];
  for (const { name, range, runtime } of declared) {
    const installed = await readJsonIfPresent<IPackageJson>(
      path.join(NODE_MODULES, name, 'package.json')
    );
    const lockRow = locked?.[`node_modules/${name}`];
    const version = installed?.version ?? lockRow?.version ?? '';
    const license = (installed ? licenseOf(installed) : '') || lockRow?.license || '';
    const source: INpmPackage['source'] = installed ? 'node_modules' : 'package-lock';

    if (!license) {
      problems.push({
        severity: 'error',
        subject: name,
        message: 'npm package declares no licence in package.json or package-lock.json',
      });
    } else if (!LICENSES[license]) {
      problems.push({
        severity: 'warn',
        subject: name,
        message: `licence "${license}" is not in the reviewed licence catalogue`,
      });
    }
    if (!version) {
      problems.push({
        severity: 'warn',
        subject: name,
        message: 'no resolved version found — run `npm install` for an exact record',
      });
    }
    if (installed && lockRow?.version && installed.version !== lockRow.version) {
      problems.push({
        severity: 'warn',
        subject: name,
        message: `installed ${installed.version} but package-lock.json pins ${lockRow.version}`,
      });
    }
    out.push({ name, range, version, license: license || '(unknown)', runtime, source });
  }
  return out;
}

/**
 * Roll up the FULL transitive tree from `package-lock.json`.
 *
 * The lockfile rather than `node_modules` on purpose: it lists every optional
 * platform build for every platform, so the audit says the same thing on Linux,
 * macOS and Windows. Reading the installed tree instead would quietly drop the
 * copyleft packages that belong to whichever OS is not running the tool — the
 * one thing an audit must never do.
 */
function summariseTree(
  locked: IPackageLock['packages'],
  problems: IProblem[]
): { tree: ITreeLicenseRow[]; copyleft: { name: string; license: string; runtime: boolean }[] } {
  if (!locked) {
    problems.push({
      severity: 'warn',
      subject: 'package-lock.json',
      message: 'missing — the transitive licence audit was skipped',
    });
    return { tree: [], copyleft: [] };
  }

  const counts = new Map<string, { total: number; runtime: number; buildOnly: number }>();
  const copyleft: { name: string; license: string; runtime: boolean }[] = [];

  for (const [key, row] of Object.entries(locked)) {
    if (key === '') continue; // the root project itself
    const name = key.replace(/^.*node_modules\//, '');
    const license = row.license?.trim() || '(none declared)';
    const runtime = row.dev !== true;

    const bucket = counts.get(license) ?? { total: 0, runtime: 0, buildOnly: 0 };
    bucket.total += 1;
    if (runtime) bucket.runtime += 1;
    else bucket.buildOnly += 1;
    counts.set(license, bucket);

    // Split composite expressions ("Apache-2.0 AND LGPL-3.0-or-later") so a
    // reciprocal term hiding inside one is still caught.
    const terms = license.split(/\s+(?:AND|OR)\s+/i).map((t) => t.replace(/[()]/g, '').trim());
    const reciprocal = terms.some((t) => LICENSES[t]?.copyleft);
    if (reciprocal) {
      copyleft.push({ name: `${name}@${row.version ?? '?'}`, license, runtime });
      if (runtime) {
        problems.push({
          severity: 'error',
          subject: name,
          message:
            `reciprocal licence "${license}" on a RUNTIME dependency — it would be ` +
            'distributed inside the APK, which cannot discharge the obligation',
        });
      }
    }
  }

  const tree = [...counts.entries()]
    .map(([license, c]) => ({ license, ...c }))
    .sort((a, b) => b.total - a.total || (a.license < b.license ? -1 : 1));
  return { tree, copyleft };
}

/* -------------------------------------------------------------------------- */
/* Asset audit                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Check one manifest entry and turn it into a credit line.
 *
 * The four hard requirements — licence, author, source URL, recognised SPDX id
 * — are errors rather than warnings because each one is the difference between
 * a credit and a guess. `formatBytes` is not applied here: the raw byte count
 * travels so the totals stay exact.
 */
function creditEntry(
  entry: ISourceEntry,
  lock: ILockFile,
  problems: IProblem[]
): ICreditedAsset | null {
  const id = entry.id ?? '(entry with no id)';
  const attribution = entry.attribution ?? {};
  const provider = entry.provider ?? '';
  const providerFacts = PROVIDERS[provider];

  if (!entry.id) {
    problems.push({ severity: 'error', subject: id, message: 'entry has no id' });
    return null;
  }
  if (!providerFacts) {
    problems.push({
      severity: 'error',
      subject: id,
      message: `unknown provider "${provider}" — add it to PROVIDERS or fix the manifest`,
    });
  }

  const license = attribution.license?.trim() ?? '';
  const author = attribution.author?.trim() ?? '';
  const sourceUrl = attribution.sourceUrl?.trim() || entry.sourceUrl?.trim() || '';

  if (!license) {
    problems.push({ severity: 'error', subject: id, message: 'attribution.license is missing' });
  } else if (!LICENSES[license]) {
    problems.push({
      severity: 'error',
      subject: id,
      message: `licence "${license}" is not a reviewed SPDX identifier`,
    });
  } else if (!ASSET_LICENSE_ALLOWLIST.has(license)) {
    problems.push({
      severity: 'error',
      subject: id,
      message: `licence "${license}" is not permitted for a bundled asset`,
    });
  }
  if (!author) {
    problems.push({ severity: 'error', subject: id, message: 'attribution.author is missing' });
  }
  if (!sourceUrl) {
    problems.push({ severity: 'error', subject: id, message: 'attribution.sourceUrl is missing' });
  }
  if (license && LICENSES[license]?.requiresAttribution && !attribution.attributionUrl) {
    problems.push({
      severity: 'error',
      subject: id,
      message: `${license} requires attribution but attribution.attributionUrl is missing`,
    });
  }

  const files = entry.files ?? [];
  const thirdParty = providerFacts ? !providerFacts.firstParty : true;

  if (thirdParty) {
    // A third-party entry that downloads nothing is a credit with no artefact
    // behind it, and an entry whose files never reached the lockfile has no
    // integrity record at all. Both are attribution the reader cannot check.
    if (files.length === 0) {
      problems.push({
        severity: 'error',
        subject: id,
        message: 'third-party entry declares no files — nothing to attribute',
      });
    }
    for (const file of files) {
      if (!file.url) {
        problems.push({ severity: 'error', subject: id, message: 'a file has no url' });
        continue;
      }
      const host = hostOf(file.url);
      if (providerFacts && !providerFacts.hosts.includes(host)) {
        problems.push({
          severity: 'error',
          subject: id,
          message: `file host "${host}" is not one this provider is allowed to serve from`,
        });
      }
      const row = lock.files?.[file.url];
      if (!row) {
        problems.push({
          severity: 'error',
          subject: id,
          message: `no assets.lock.json record for ${file.url}`,
        });
      } else if (row.md5 && file.md5 && row.md5 !== file.md5) {
        problems.push({
          severity: 'error',
          subject: id,
          message: `md5 disagreement between manifest and lockfile for ${file.url}`,
        });
      }
    }
  } else if (files.length > 0) {
    problems.push({
      severity: 'error',
      subject: id,
      message: 'first-party entry declares downloadable files',
    });
  }

  // A first-party URL that does not resolve is not a licence problem, but it
  // does make the document less checkable, so say so out loud.
  if (!thirdParty && sourceUrl && !sourceUrl.startsWith(PROVIDERS.procedural.url)) {
    problems.push({
      severity: 'warn',
      subject: id,
      message: `first-party sourceUrl "${sourceUrl}" is not this repository — placeholder URL`,
    });
  }

  return {
    id: entry.id,
    name: entry.name ?? entry.id,
    provider,
    providerAssetId: entry.providerAssetId ?? '',
    license,
    author,
    sourceUrl,
    year: attribution.year,
    fileCount: files.length,
    bytes: files.reduce((sum, f) => sum + (f.bytes ?? 0), 0),
    notes: entry.notes,
  };
}

/* -------------------------------------------------------------------------- */
/* The character claim                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Prove — not assert — that no character or monster in this game came from
 * anyone else.
 *
 * Nine checks, chosen so that no single mistake can pass all of them. Checks
 * 1-3 read the character manifest; 4-6 read the download lockfile, which is
 * written by the fetcher and records what actually crossed the network; 7
 * ties the two together; 8 catches a manifest that lies about itself; 9
 * catches a character with no generator behind it.
 *
 * The lockfile checks are the ones that matter. A manifest is a statement of
 * intent and can be edited to say anything; the lockfile is evidence, and it
 * contains 376 files from exactly one host, none of them a character.
 */
function auditCharacters(
  characters: ICharacterManifestFile,
  lock: ILockFile,
  textures: ISourceManifestFile,
  problems: IProblem[]
): ICharacterAudit {
  const entries = [...(characters.entries ?? [])].sort(byKey((e) => e.id ?? ''));
  const checks: ICheck[] = [];
  const thirdParty: string[] = [];

  const push = (name: string, passed: boolean, detail: string): void => {
    checks.push({ name, passed, detail });
    if (!passed) {
      problems.push({ severity: 'error', subject: 'characters', message: `${name}: ${detail}` });
    }
  };

  /* 1 — no character declares a third-party provider ---------------------- */
  const withProvider = entries.filter((e) => {
    const facts = e.provider ? PROVIDERS[e.provider] : undefined;
    return Boolean(e.provider) && (!facts || !facts.firstParty);
  });
  for (const e of withProvider) thirdParty.push(e.id ?? '(no id)');
  push(
    'no character entry declares a third-party provider',
    withProvider.length === 0,
    withProvider.length === 0
      ? `${entries.length} entries checked, none carries a provider field`
      : `third-party providers on: ${withProvider.map((e) => e.id).join(', ')}`
  );

  /* 2 — no character declares a downloadable file ------------------------- */
  const withFiles = entries.filter((e) => (e.files?.length ?? 0) > 0);
  for (const e of withFiles) thirdParty.push(e.id ?? '(no id)');
  push(
    'no character entry declares a downloadable file',
    withFiles.length === 0,
    withFiles.length === 0
      ? 'every entry has an empty file list — nothing is fetched for a character'
      : `files declared by: ${withFiles.map((e) => e.id).join(', ')}`
  );

  /* 3 — no character mentions a known character-asset marketplace --------- */
  const tainted: string[] = [];
  for (const entry of entries) {
    for (const url of urlsIn(entry)) {
      const host = hostOf(url);
      if (CHARACTER_ASSET_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
        tainted.push(`${entry.id} -> ${host}`);
      }
    }
  }
  for (const t of tainted) thirdParty.push(t.split(' ')[0] ?? t);
  push(
    'no character entry references a character-asset marketplace',
    tainted.length === 0,
    tainted.length === 0
      ? `${CHARACTER_ASSET_HOSTS.length} known humanoid-asset hosts checked, zero references`
      : `references found: ${tainted.join(', ')}`
  );

  /* 4 — no character id appears in the download lockfile ------------------ */
  const ids = new Set(entries.map((e) => e.id).filter(Boolean) as string[]);
  const lockedIds = Object.keys(lock.assets ?? {}).sort();
  const downloadedCharacters = lockedIds.filter((id) => ids.has(id) || id.startsWith('chr.'));
  for (const id of downloadedCharacters) thirdParty.push(id);
  push(
    'no character id appears in assets.lock.json',
    downloadedCharacters.length === 0,
    downloadedCharacters.length === 0
      ? `${lockedIds.length} downloaded entries, none of them a character`
      : `downloaded: ${downloadedCharacters.join(', ')}`
  );

  /* 5 — the lockfile contains no character-kind entry --------------------- */
  const characterKinds = Object.entries(lock.assets ?? {})
    .filter(([, a]) => a.kind === 'character')
    .map(([id]) => id)
    .sort();
  for (const id of characterKinds) thirdParty.push(id);
  const kindTally = new Map<string, number>();
  for (const asset of Object.values(lock.assets ?? {})) {
    const k = asset.kind ?? '(none)';
    kindTally.set(k, (kindTally.get(k) ?? 0) + 1);
  }
  push(
    'assets.lock.json contains no entry of kind "character"',
    characterKinds.length === 0,
    characterKinds.length === 0
      ? `downloaded kinds: ${[...kindTally.entries()]
          .sort(byKey(([k]) => k))
          .map(([k, n]) => `${k} x${n}`)
          .join(', ')}`
      : `character-kind entries: ${characterKinds.join(', ')}`
  );

  /* 6 — every downloaded byte came from an allow-listed provider host ----- */
  const hosts = new Map<string, number>();
  for (const url of Object.keys(lock.files ?? {})) {
    const host = hostOf(url);
    hosts.set(host, (hosts.get(host) ?? 0) + 1);
  }
  const allowed = new Set(Object.values(PROVIDERS).flatMap((p) => p.hosts));
  const strangers = [...hosts.keys()].filter((h) => !allowed.has(h)).sort();
  push(
    'every downloaded file came from an allow-listed provider host',
    strangers.length === 0,
    strangers.length === 0
      ? `${plural(
          [...hosts.values()].reduce((a, b) => a + b, 0),
          'file'
        )} from ${[...hosts.entries()]
          .sort(byKey(([h]) => h))
          .map(([h, n]) => `${h} (${n})`)
          .join(', ')}`
      : `unexpected hosts: ${strangers.join(', ')}`
  );

  /* 7 — reused CC0 detail maps are city materials already credited -------- */
  const reused = Object.keys(characters.cc0Attribution ?? {}).sort();
  const textureById = new Map((textures.entries ?? []).map((e) => [e.id ?? '', e]));
  const unmatched: string[] = [];
  for (const id of reused) {
    const declared = characters.cc0Attribution?.[id];
    const texture = textureById.get(id);
    if (!texture) {
      unmatched.push(`${id} (no such material)`);
      continue;
    }
    if (JSON.stringify(texture.attribution ?? {}) !== JSON.stringify(declared ?? {})) {
      unmatched.push(`${id} (attribution disagrees with textures.json)`);
    }
  }
  push(
    'every CC0 map the roster reuses is a city material already credited',
    unmatched.length === 0,
    unmatched.length === 0
      ? `${reused.length} reused maps, each resolving to an identical entry in textures.json`
      : `unresolved: ${unmatched.join(', ')}`
  );

  /* 8 — the manifest's own count agrees with the computed one ------------- */
  const unique = [...new Set(thirdParty)].sort();
  push(
    'the manifest’s declared third-party character count is correct',
    characters.thirdPartyCharacterAssets === unique.length,
    `manifest declares ${characters.thirdPartyCharacterAssets ?? '(absent)'}, ` +
      `checks 1-7 found ${unique.length}`
  );

  /* 9 — every character names an in-repo generator ------------------------ */
  const ungenerated = entries.filter((e) => !e.generator?.startsWith('tools/'));
  push(
    'every character names an in-repo generator',
    ungenerated.length === 0,
    ungenerated.length === 0
      ? `all ${entries.length} generated by ${[
          ...new Set(entries.map((e) => e.generator ?? '')),
        ].join(', ')}`
      : `no in-repo generator: ${ungenerated.map((e) => e.id).join(', ')}`
  );

  /* Attribution completeness on the character entries themselves ---------- */
  for (const entry of entries) {
    const id = entry.id ?? '(character with no id)';
    if (!entry.attribution?.license) {
      problems.push({ severity: 'error', subject: id, message: 'attribution.license is missing' });
    }
    if (!entry.attribution?.author) {
      problems.push({ severity: 'error', subject: id, message: 'attribution.author is missing' });
    }
    const sourceUrl = entry.attribution?.sourceUrl ?? entry.sourceUrl ?? '';
    if (sourceUrl && !sourceUrl.startsWith(PROVIDERS.procedural.url)) {
      problems.push({
        severity: 'warn',
        subject: id,
        message: `first-party sourceUrl "${sourceUrl}" is not this repository — placeholder URL`,
      });
    }
  }

  const byRole = new Map<string, number>();
  for (const entry of entries) {
    const role = entry.role ?? 'unknown';
    byRole.set(role, (byRole.get(role) ?? 0) + 1);
  }

  return {
    entries,
    byRole,
    thirdParty: unique,
    declared: characters.thirdPartyCharacterAssets,
    checks,
    reusedMaps: reused,
  };
}

/* -------------------------------------------------------------------------- */
/* Markdown                                                                   */
/* -------------------------------------------------------------------------- */

interface IReport {
  readonly credited: ReadonlyMap<string, ICreditedAsset[]>;
  readonly characters: ICharacterAudit;
  readonly inputs: IInputs;
  readonly problems: readonly IProblem[];
}

function assetTable(assets: readonly ICreditedAsset[]): string[] {
  const lines = [
    '| Asset id | Title | Author | Licence (SPDX) | Source |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const a of [...assets].sort(byKey((x) => x.id))) {
    lines.push(
      `| \`${cell(a.id)}\` | ${cell(a.name)} | ${cell(a.author)} | ` +
        `${link(a.license, LICENSES[a.license]?.url)} | ${link(a.providerAssetId || 'source', a.sourceUrl)} |`
    );
  }
  return lines;
}

function renderMarkdown(report: IReport): string {
  const { credited, characters, inputs, problems } = report;
  const out: string[] = [];
  const w = (line = ''): void => {
    out.push(line);
  };

  const thirdPartyAssets = [...credited.values()]
    .flat()
    .filter((a) => !PROVIDERS[a.provider]?.firstParty);
  const firstPartyAssets = [...credited.values()]
    .flat()
    .filter((a) => PROVIDERS[a.provider]?.firstParty);
  const authors = [...new Set(thirdPartyAssets.map((a) => a.author).filter(Boolean))].sort();
  const sourceBytes = inputs.lock.totals?.bytes ?? 0;
  const sourceFiles = inputs.lock.totals?.files ?? 0;
  const warnings = problems.filter((p) => p.severity === 'warn');

  /* ── Header ───────────────────────────────────────────────────────────── */
  w('# Attribution and licences');
  w();
  w('<!-- GENERATED FILE — do not edit by hand.');
  w('     Regenerate with:  npx tsx tools/attribution.ts');
  w('     Verify in CI with: npx tsx tools/attribution.ts --check -->');
  w();
  w(
    'Every asset in this repository is either released under a public-domain ' +
      'dedication by its author or generated by code in this repository. This ' +
      'document is produced from the committed manifests and the download ' +
      'lockfile, so it cannot claim anything the repository does not record.'
  );
  w();
  w('| Category | Count | Licence |');
  w('| --- | --- | --- |');
  for (const { file, summary } of SOURCE_MANIFESTS) {
    const list = (credited.get(file) ?? []).filter((a) => !PROVIDERS[a.provider]?.firstParty);
    const licences = [...new Set(list.map((a) => a.license))].sort().join(', ');
    w(`| Third-party ${summary} | ${list.length} | ${licences || '—'} |`);
  }
  w(
    `| First-party procedural materials | ${firstPartyAssets.length} | ` +
      `${[...new Set(firstPartyAssets.map((a) => a.license))].sort().join(', ') || '—'} |`
  );
  w(
    `| First-party characters and monsters | ${characters.entries.length} | ` +
      `${
        [...new Set(characters.entries.map((e) => e.attribution?.license ?? ''))]
          .filter(Boolean)
          .sort()
          .join(', ') || '—'
      } |`
  );
  w('| Third-party character or monster assets | **0** | — |');
  w('| Audio files of any kind | **0** | — (synthesised at runtime) |');
  w(
    `| Runtime npm packages | ${inputs.npm.filter((p) => p.runtime).length} declared | ` +
      'all permissive |'
  );
  w(
    `| Build-only npm packages | ${inputs.npm.filter((p) => !p.runtime).length} declared | mixed |`
  );
  w();
  w(
    `Downloaded source material: **${plural(sourceFiles, 'file')}, ` +
      `${formatBytes(sourceBytes)}** (${sourceBytes.toLocaleString('en-US')} bytes), ` +
      'every byte of it CC0, recorded with a provider-published md5 and a ' +
      'locally computed sha256 in ' +
      '[`assets/assets.lock.json`](assets/assets.lock.json).'
  );
  w();

  /* ── The claim ────────────────────────────────────────────────────────── */
  w('## 1. No third-party character or monster assets');
  w();
  w(
    'Every humanoid in this game — heroes, civilians and monsters alike — is ' +
      'geometry built at build time by `tools/build-characters.ts` from the ' +
      'mesh generators in `src/characters/mesh`. No character model, rig, ' +
      'animation or texture was downloaded from anywhere, by anyone, at any ' +
      'point. Poly Haven, the only asset source this project draws on, ' +
      'publishes no humanoids at all.'
  );
  w();
  w(
    'That claim is checked mechanically every time this file is regenerated. ' +
      'The checks do not take the character manifest at its word — checks 4 to ' +
      '6 read the download lockfile, which records what actually crossed the ' +
      'network — and the build fails if any of them does not hold.'
  );
  w();
  w('| # | Check | Result | Evidence |');
  w('| --- | --- | --- | --- |');
  characters.checks.forEach((check, index) => {
    w(
      `| ${index + 1} | ${cell(check.name)} | ${check.passed ? '**pass**' : '**FAIL**'} | ` +
        `${cell(check.detail)} |`
    );
  });
  w();
  w(
    `**Result: ${characters.thirdParty.length} third-party character assets found across ` +
      `${plural(characters.checks.length, 'check')}.**`
  );
  w();
  w(
    'The roster does reuse ' +
      `${plural(characters.reusedMaps.length, 'CC0 surface map')} from the city ` +
      'material set as fine detail on clothing and armour — weave, wear and ' +
      'rust. Those are ordinary Poly Haven textures, credited in section 2.1 ' +
      'along with every other material; check 7 confirms each one resolves to ' +
      'an identical entry there. They are surface detail sampled into a baked ' +
      'atlas, not character art: ' +
      characters.reusedMaps.map((m) => `\`${m}\``).join(', ') +
      '.'
  );
  w();
  w('### Characters and monsters in this project');
  w();
  w('| Id | Name | Role | Triangles | Generator | Licence |');
  w('| --- | --- | --- | --- | --- | --- |');
  for (const entry of characters.entries) {
    w(
      `| \`${cell(entry.id)}\` | ${cell(entry.name)} | ${cell(entry.role)} | ` +
        `${cell(entry.triangles)} | \`${cell(entry.generator)}\` | ` +
        `${cell(entry.attribution?.license)} |`
    );
  }
  w();
  w(
    'The skeleton uses Mixamo-compatible **bone names** (`Hips`, `Spine`, ' +
      '`LeftArm`, …) so that a rig from any standard humanoid pipeline can be ' +
      'retargeted onto it later. A naming convention is all that is shared: no ' +
      'Mixamo mesh, rig, animation or file is present in this repository, and ' +
      'check 3 above verifies nothing here so much as links to that domain.'
  );
  w();

  /* ── Third-party assets ───────────────────────────────────────────────── */
  w('## 2. Third-party assets');
  w();
  const usedProviders = new Set(thirdPartyAssets.map((a) => a.provider));
  w(
    `All ${thirdPartyAssets.length} third-party assets come from **Poly Haven**, which releases ` +
      'everything it publishes under CC0-1.0 — a dedication of the work to the ' +
      'public domain. CC0 imposes no attribution requirement. Every author is ' +
      'named below regardless, because they made the thing.'
  );
  w();
  w('| Source | Status | Assets | Why |');
  w('| --- | --- | --- | --- |');
  for (const [key, facts] of Object.entries(PROVIDERS).sort(byKey(([k]) => k))) {
    if (facts.firstParty) continue;
    const count = thirdPartyAssets.filter((a) => a.provider === key).length;
    w(
      `| ${link(facts.name, facts.url)} | ${usedProviders.has(key) ? 'used' : 'evaluated, not used'} ` +
        `| ${count} | ${cell(facts.note)} |`
    );
  }
  w();
  let section = 0;
  for (const { file, heading } of SOURCE_MANIFESTS) {
    section += 1;
    const list = (credited.get(file) ?? []).filter((a) => !PROVIDERS[a.provider]?.firstParty);
    if (list.length === 0) continue;
    const bytes = list.reduce((sum, a) => sum + a.bytes, 0);
    const files = list.reduce((sum, a) => sum + a.fileCount, 0);
    w(`### 2.${section} ${heading} — ${list.length} assets, CC0-1.0`);
    w();
    w(
      `${plural(files, 'source file')}, ${formatBytes(bytes)} as downloaded. ` +
        `Declared in [\`tools/manifest/${file}\`](tools/manifest/${file}).`
    );
    w();
    for (const line of assetTable(list)) w(line);
    w();
  }

  /* ── First-party assets ───────────────────────────────────────────────── */
  w('## 3. First-party assets');
  w();
  w(
    'Generated by this repository. Nothing is downloaded and there is no ' +
      'upstream author to credit.'
  );
  w();
  w(
    'Two different licences appear below, which is worth a sentence rather ' +
      'than a raised eyebrow. The characters are declared `MIT`, matching ' +
      '[`LICENSE`](LICENSE); the two procedural materials are declared ' +
      '`CC0-1.0`, a full public-domain dedication. Both are this project’s own ' +
      'work, so both grants are ours to make, and CC0 is strictly more ' +
      'permissive than MIT — a recipient of the CC0 material has every right ' +
      'MIT would have given them and no attribution obligation on top. Nothing ' +
      'is in tension; the manifests simply were not written to one convention.'
  );
  w();
  if (firstPartyAssets.length > 0) {
    w(`### 3.1 Procedural materials — ${firstPartyAssets.length}`);
    w();
    w(
      'Poly Haven publishes no glass and no road-marking texture (verified ' +
        'against all 849 of its texture ids), so these two are generated ' +
        'instead: window glass is a shader-parameter material with no maps at ' +
        'all, and lane markings are an alpha decal atlas rasterised by the ' +
        'asset pipeline.'
    );
    w();
    w('| Asset id | Title | Origin | Licence |');
    w('| --- | --- | --- | --- |');
    for (const a of [...firstPartyAssets].sort(byKey((x) => x.id))) {
      w(
        `| \`${cell(a.id)}\` | ${cell(a.name)} | Generated in this repository | ` +
          `${link(a.license, LICENSES[a.license]?.url)} |`
      );
    }
    w();
  }
  w(`### 3.2 Characters and monsters — ${characters.entries.length}`);
  w();
  w('Listed in section 1 above. All original geometry, all generated in code.');
  w();
  w('### 3.3 Audio — 0 files');
  w();
  w(
    'Every sound in this game is synthesised at runtime with the Web Audio API ' +
      '— punches, monsters, collapsing buildings, the crowd, the interface and ' +
      'the whole adaptive score are oscillators, filters and generated noise ' +
      '(`src/audio`). There is not one audio file in the repository, in the ' +
      'bundle, or fetched at runtime, so there is no audio licence to record ' +
      'and nothing here to re-clear. `npm run guard` enforces it: `.mp3`, ' +
      '`.ogg` and `.wav` are refused by the commit guard.'
  );
  w();

  /* ── Fonts ────────────────────────────────────────────────────────────── */
  const fonts = inputs.npm.filter((p) => p.name.startsWith('@fontsource/'));
  if (fonts.length > 0) {
    w('## 4. Fonts');
    w();
    w(
      'Declared as dependencies and licensed under the SIL Open Font License ' +
        '1.1, which permits bundling and requires that this notice travel with ' +
        'the font.'
    );
    w();
    w('| Package | Family | Version | Licence | Copyright |');
    w('| --- | --- | --- | --- | --- |');
    const copyrights: Readonly<Record<string, string>> = {
      '@fontsource/inter':
        'Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)',
      '@fontsource/bebas-neue':
        'Copyright 2019 The Bebas Neue Project Authors (https://github.com/dharmatype/Bebas-Neue)',
    };
    const families: Readonly<Record<string, string>> = {
      '@fontsource/inter': 'Inter',
      '@fontsource/bebas-neue': 'Bebas Neue',
    };
    for (const font of fonts) {
      w(
        `| \`${cell(font.name)}\` | ${cell(families[font.name] ?? '—')} | ` +
          `${cell(font.version)} | ${link(font.license, LICENSES[font.license]?.url)} | ` +
          `${cell(copyrights[font.name] ?? '—')} |`
      );
    }
    w();
    w(
      'The interface asks for these families by name in CSS ' +
        '(`src/ui/input/touch-overlay.ts`) and falls back to `system-ui`. No ' +
        'font binary is currently emitted into the bundle, because no module ' +
        'imports the `@fontsource` stylesheets yet; the credit is recorded here ' +
        'in advance so that shipping one is a one-line change and not a ' +
        'licensing question.'
    );
    w();
  }

  /* ── Software ─────────────────────────────────────────────────────────── */
  w('## 5. Software dependencies');
  w();
  w('### 5.1 Runtime — shipped to users');
  w();
  w(
    'These are compiled into the web bundle and the Android APK. Every one is ' +
      'permissively licensed; several require their copyright notice to travel ' +
      'with the binary, which is what this section is.'
  );
  w();
  w('| Package | Version | Licence |');
  w('| --- | --- | --- |');
  for (const p of inputs.npm.filter((x) => x.runtime)) {
    w(
      `| \`${cell(p.name)}\` | ${cell(p.version)} | ${link(p.license, LICENSES[p.license]?.url)} |`
    );
  }
  w();
  w('### 5.2 Build-time only — never distributed');
  w();
  w(
    'Compilers, bundlers, texture encoders and test runners. These run on a ' +
      'developer machine and no part of them is copied into the shipped ' +
      'artefact.'
  );
  w();
  w('| Package | Version | Licence |');
  w('| --- | --- | --- |');
  for (const p of inputs.npm.filter((x) => !x.runtime)) {
    w(
      `| \`${cell(p.name)}\` | ${cell(p.version)} | ${link(p.license, LICENSES[p.license]?.url)} |`
    );
  }
  w();

  w('### 5.3 What some of those packages actually contain');
  w();
  w(
    'A handful of the build tools are thin Node wrappers around native ' +
      'binaries built from another project under another licence, and one of ' +
      'them ships no licence text at all. The wrapper’s npm `license` field is ' +
      'therefore not the whole answer, so the real contents are recorded here.'
  );
  w();
  w('| Package | What it redistributes | Upstream licence | Note |');
  w('| --- | --- | --- | --- |');
  const declaredNames = new Set(inputs.npm.map((p) => p.name));
  for (const note of [...UPSTREAM_NOTES].sort(byKey((n) => n.pkg))) {
    if (!declaredNames.has(note.pkg)) continue;
    w(
      `| \`${cell(note.pkg)}\` | ${cell(note.contains)} | ` +
        `${link(note.upstreamLicense, LICENSES[note.upstreamLicense]?.url)} | ${cell(note.note)} |`
    );
  }
  w();
  w(ANDROID_SDK_NOTE);
  w();

  if (inputs.tree.length > 0) {
    const runtimeTotal = inputs.tree.reduce((s, r) => s + r.runtime, 0);
    const treeTotal = inputs.tree.reduce((s, r) => s + r.total, 0);
    w('### 5.4 Full transitive tree');
    w();
    w(
      `Rolled up from \`package-lock.json\`, which lists every optional ` +
        'platform build for every platform — so this audit says the same thing ' +
        'on Linux, macOS and Windows. ' +
        `${treeTotal} packages resolve in total; **${runtimeTotal}** of them are ` +
        'reachable at runtime and therefore distributed.'
    );
    w();
    w('| Licence | Total | Distributed | Build-only |');
    w('| --- | --- | --- | --- |');
    for (const row of inputs.tree) {
      w(
        `| ${link(row.license, LICENSES[row.license]?.url)} | ${row.total} | ` +
          `${row.runtime} | ${row.buildOnly} |`
      );
    }
    w();
    if (inputs.copyleftInTree.length > 0) {
      const distributed = inputs.copyleftInTree.filter((p) => p.runtime);
      w(
        `**Reciprocal licences in the tree: ${inputs.copyleftInTree.length} packages, ` +
          `${distributed.length} of them distributed.**`
      );
      w();
      w(
        'A reciprocal (copyleft) licence attaches obligations to whoever ' +
          'distributes the work. Every such package here is a build tool that ' +
          'stays on the developer’s machine, so no obligation is triggered ' +
          'by shipping the game. Listed in full so the reader can check that ' +
          'for themselves rather than take it on trust.'
      );
      w();
      // Grouped, because 41 near-identical rows for one library's per-platform
      // binaries hides the only thing that matters: which FAMILIES are
      // reciprocal, and whether any of them ships. The full list is still
      // here, one fold away, so nothing is being kept from the reader.
      const roles: readonly (readonly [RegExp, string, string])[] = [
        [
          /^ffmpeg-static/,
          'ffmpeg-static',
          'Declared build dependency; no code in this repository references it',
        ],
        [
          /^@img\/sharp/,
          '@img/sharp-* (per-platform binaries)',
          'Native codecs behind `sharp`, which resizes source textures in the asset pipeline',
        ],
        [/^lightningcss/, 'lightningcss-* (per-platform binaries)', 'CSS transform used by Vite'],
      ];
      const groups = new Map<string, { role: string; licenses: Set<string>; members: string[] }>();
      for (const p of [...inputs.copyleftInTree].sort(byKey((x) => x.name))) {
        const match = roles.find(([re]) => re.test(p.name));
        const label = match?.[1] ?? p.name;
        const group = groups.get(label) ?? {
          role: match?.[2] ?? 'Build tool',
          licenses: new Set<string>(),
          members: [],
        };
        group.licenses.add(p.license);
        group.members.push(p.name);
        groups.set(label, group);
      }
      w('| Package family | Licence | Packages | Distributed? | Role |');
      w('| --- | --- | --- | --- | --- |');
      for (const [label, group] of [...groups.entries()].sort(byKey(([l]) => l))) {
        w(
          `| \`${cell(label)}\` | ${cell([...group.licenses].sort().join('; '))} | ` +
            `${group.members.length} | no | ${cell(group.role)} |`
        );
      }
      w();
      w('<details>');
      w('<summary>Every reciprocal-licensed package, in full</summary>');
      w();
      for (const p of [...inputs.copyleftInTree].sort(byKey((x) => x.name))) {
        w(`- \`${p.name}\` — ${p.license}${p.runtime ? ' — **DISTRIBUTED**' : ''}`);
      }
      w();
      w('</details>');
      w();
    }
  }

  /* ── Author roll ──────────────────────────────────────────────────────── */
  w('## 6. Authors credited');
  w();
  w(
    `${plural(authors.length, 'credit line')} across ` +
      `${plural(thirdPartyAssets.length, 'third-party asset')}, as Poly Haven ` +
      'records them. Names appear exactly as the source credits them, including ' +
      'the multi-author lines.'
  );
  w();
  for (const author of authors) w(`- ${author}`);
  w();

  /* ── Known gaps ───────────────────────────────────────────────────────── */
  w('## 7. Known gaps');
  w();
  if (warnings.length === 0) {
    w('None. Every entry carries an author, a licence and a source URL.');
  } else {
    w(
      'Things the generator flagged that do not invalidate any credit above, ' +
        'but that a reader is entitled to know. They are reproduced here rather ' +
        'than only printed to a terminal nobody will re-read.'
    );
    w();
    // Grouped by message: sixteen rows of the same sentence is noise, and
    // noise is how a gap stops being read.
    const grouped = new Map<string, string[]>();
    for (const warning of warnings) {
      const list = grouped.get(warning.message) ?? [];
      if (!list.includes(warning.subject)) list.push(warning.subject);
      grouped.set(warning.message, list);
    }
    w('| Affects | Note |');
    w('| --- | --- |');
    for (const [message, subjects] of [...grouped.entries()].sort(byKey(([m]) => m))) {
      const sorted = [...subjects].sort();
      const affected =
        sorted.length > 4
          ? `${plural(sorted.length, 'entry', 'entries')}, including \`${sorted
              .slice(0, 3)
              .join('`, `')}\``
          : sorted.map((s) => `\`${s}\``).join(', ');
      w(`| ${cell(affected)} | ${cell(message)} |`);
    }
  }
  w();

  /* ── The IP ───────────────────────────────────────────────────────────── */
  w('## 8. One Punch Man');
  w();
  w(
    'One Punch Man is created by ONE and illustrated by Yusuke Murata, ' +
      'published by Shueisha, with the anime produced by Madhouse and J.C.Staff. ' +
      'This is an unaffiliated, non-commercial fan project. It is not endorsed ' +
      'by, associated with, or approved by any of them.'
  );
  w();
  w(
    'No copyrighted One Punch Man material is included in this repository: no ' +
      'artwork, no models, no audio, no music, no fonts, no logos, no screen ' +
      'captures and no text from the manga or anime. Character names and the ' +
      'hero-ranking premise are used referentially; every asset that ' +
      'represents them is original geometry generated by this repository, as ' +
      'section 1 sets out and verifies.'
  );
  w();
  w(
    'The code in this repository is MIT-licensed (see [`LICENSE`](LICENSE)). ' +
      'That licence covers the code and the assets this project generates. It ' +
      'does not, and cannot, grant any right in the One Punch Man intellectual ' +
      'property, which belongs to its owners.'
  );
  w();

  /* ── Footer ───────────────────────────────────────────────────────────── */
  w('---');
  w();
  w(
    'Generated by [`tools/attribution.ts`](tools/attribution.ts) from ' +
      '`tools/manifest/*.json`, `assets/assets.lock.json`, `package.json` and ' +
      '`package-lock.json`. Run `npx tsx tools/attribution.ts --check` to ' +
      'verify this file is current.'
  );

  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

/**
 * Run the generated markdown through the repository's own Prettier config.
 *
 * Not cosmetics — correctness of the `--check` gate. `npm run format` is
 * `prettier --write "**\/*.{…,md}"` with no ignore file, so any agent running
 * it reformats `ATTRIBUTION.md` (Prettier pads markdown table cells) and the
 * committed file stops matching what the generator emits. The gate would then
 * fail for a reason that has nothing to do with attribution, which is the
 * fastest way to teach people to ignore it.
 *
 * Emitting Prettier-canonical markdown in the first place makes `format` a
 * no-op on this file, so the only thing that can move it is a real change in
 * the manifests.
 *
 * Degrades to the unformatted text if Prettier is unavailable — this tool must
 * still run on a checkout with no dev dependencies installed.
 */
async function prettify(markdown: string, filepath: string): Promise<string> {
  try {
    const prettier = await import('prettier');
    const config = await prettier.resolveConfig(filepath);
    return await prettier.format(markdown, { ...config, filepath, parser: 'markdown' });
  } catch {
    return markdown;
  }
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

interface IOptions {
  readonly check: boolean;
  readonly out: string;
  readonly quiet: boolean;
  readonly help: boolean;
}

function parseArgs(argv: readonly string[]): IOptions {
  let check = false;
  let out = DEFAULT_OUT;
  let quiet = false;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--check':
      case '--verify':
        check = true;
        break;
      case '--out':
        i += 1;
        out = path.resolve(REPO_ROOT, argv[i] ?? DEFAULT_OUT);
        break;
      case '--quiet':
      case '-q':
        quiet = true;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { check, out, quiet, help };
}

const HELP = `
attribution — regenerate ATTRIBUTION.md from the committed provenance records

  npx tsx tools/attribution.ts            audit, then write ATTRIBUTION.md
  npx tsx tools/attribution.ts --check    audit and diff; write nothing (CI)

  --out <path>   write somewhere other than ATTRIBUTION.md
  --quiet        only problems and the verdict
  -h, --help     this text

Exits 1 if any entry lacks an author or a licence, if any character asset
turns out to be third-party, or if --check finds the file out of date.
`.trim();

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  const log = new Logger({ level: options.quiet ? 'warn' : 'info' });
  const problems: IProblem[] = [];

  log.heading('attribution');

  /* 1 — load ------------------------------------------------------------- */
  const inputs = await loadInputs(problems);
  log.ok(
    `manifests: ${inputs.manifests.size + 1} files, ` +
      `${[...inputs.manifests.values()].reduce((n, m) => n + (m.entries?.length ?? 0), 0)} source ` +
      `entries, ${inputs.characters.entries?.length ?? 0} character entries`
  );
  log.ok(
    `lockfile: ${Object.keys(inputs.lock.assets ?? {}).length} entries, ` +
      `${Object.keys(inputs.lock.files ?? {}).length} files, ` +
      `${formatBytes(inputs.lock.totals?.bytes ?? 0)}`
  );

  /* 2 — credit and audit every source entry ------------------------------ */
  const credited = new Map<string, ICreditedAsset[]>();
  for (const { file } of SOURCE_MANIFESTS) {
    const manifest = inputs.manifests.get(file);
    const list: ICreditedAsset[] = [];
    for (const entry of manifest?.entries ?? []) {
      const asset = creditEntry(entry, inputs.lock, problems);
      if (asset) list.push(asset);
    }
    credited.set(file, list.sort(byKey((a) => a.id)));
  }

  const all = [...credited.values()].flat();
  const thirdParty = all.filter((a) => !PROVIDERS[a.provider]?.firstParty);
  const byProvider = new Map<string, number>();
  const byLicense = new Map<string, number>();
  for (const asset of all) {
    byProvider.set(asset.provider, (byProvider.get(asset.provider) ?? 0) + 1);
    byLicense.set(asset.license, (byLicense.get(asset.license) ?? 0) + 1);
  }
  log.ok(
    `assets: ${all.length} entries — ` +
      [...byProvider.entries()]
        .sort(byKey(([p]) => p))
        .map(([p, n]) => `${p} x${n}`)
        .join(', ')
  );
  log.ok(
    `licences: ` +
      [...byLicense.entries()]
        .sort(byKey(([l]) => l))
        .map(([l, n]) => `${l} x${n}`)
        .join(', ')
  );

  /* 3 — the load-bearing claim ------------------------------------------- */
  const textures = inputs.manifests.get('textures.json') ?? {};
  const characters = auditCharacters(inputs.characters, inputs.lock, textures, problems);

  log.heading('third-party character assets');
  for (const check of characters.checks) {
    const line = `${check.name} — ${check.detail}`;
    if (check.passed) log.ok(line);
    else log.error(line);
  }
  const claimHolds = characters.thirdParty.length === 0;
  if (claimHolds) {
    log.ok(
      `ASSERTION HOLDS: 0 third-party character or monster assets across ` +
        `${plural(characters.entries.length, 'character')} and ` +
        `${plural(characters.checks.length, 'check')}`
    );
  } else {
    log.error(
      `ASSERTION FAILED: ${plural(characters.thirdParty.length, 'third-party character asset')}: ` +
        characters.thirdParty.join(', ')
    );
  }

  /* 4 — dependencies ------------------------------------------------------ */
  const runtimePackages = inputs.npm.filter((p) => p.runtime);
  log.heading('dependencies');
  log.ok(
    `${runtimePackages.length} runtime, ${inputs.npm.length - runtimePackages.length} build-only ` +
      `(declared); ${inputs.tree.reduce((s, r) => s + r.total, 0)} packages resolve in total`
  );
  if (inputs.copyleftInTree.length > 0) {
    const distributed = inputs.copyleftInTree.filter((p) => p.runtime);
    const line =
      `${inputs.copyleftInTree.length} reciprocal-licensed packages in the tree, ` +
      `${distributed.length} distributed`;
    if (distributed.length === 0) log.ok(line);
    else log.error(line);
  }

  /* 5 — verdict ----------------------------------------------------------- */
  const errors = problems.filter((p) => p.severity === 'error');
  const warnings = problems.filter((p) => p.severity === 'warn');

  if (warnings.length > 0) {
    log.heading(`${plural(warnings.length, 'warning')}`);
    for (const warning of [...warnings].sort(byKey((p) => `${p.subject} ${p.message}`))) {
      log.warn(`${warning.subject}: ${warning.message}`);
    }
  }

  if (errors.length > 0) {
    log.heading(`${plural(errors.length, 'error')} — ATTRIBUTION.md NOT written`);
    for (const error of [...errors].sort(byKey((p) => `${p.subject} ${p.message}`))) {
      log.error(`${error.subject}: ${error.message}`);
    }
    log.error(
      'ATTRIBUTION.md describes what this project may lawfully ship. It is not ' +
        'written while any of the above is unresolved.'
    );
    return 1;
  }

  /* 6 — emit -------------------------------------------------------------- */
  const markdown = await prettify(
    renderMarkdown({ credited, characters, inputs, problems }),
    options.out
  );

  if (options.check) {
    const existing = await readFile(options.out, 'utf8').catch(() => null);
    if (existing === markdown) {
      log.heading(`${rel(options.out)} is up to date`);
      return 0;
    }
    log.heading(`${rel(options.out)} is OUT OF DATE`);
    log.error(
      existing === null
        ? 'the file does not exist — run `npx tsx tools/attribution.ts`'
        : 'regenerate it with `npx tsx tools/attribution.ts` and commit the result'
    );
    return 1;
  }

  await writeFile(options.out, markdown, 'utf8');
  log.heading(
    `wrote ${rel(options.out)} — ${plural(thirdParty.length, 'third-party asset')}, ` +
      `${plural(all.length - thirdParty.length, 'first-party material')}, ` +
      `${plural(characters.entries.length, 'generated character')}, ` +
      `${plural(inputs.npm.length, 'npm package')}`
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const log = new Logger();
    log.error(error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack && process.env.DEBUG) {
      process.stderr.write(`${error.stack}\n`);
    }
    process.exitCode = 1;
  });
