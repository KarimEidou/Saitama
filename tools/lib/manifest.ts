/**
 * MANIFEST LOADING, VALIDATION AND COMPILATION
 *
 * Three jobs:
 *
 *   1. LOAD    `tools/manifest/*.json` off disk.
 *   2. VALIDATE every field, hard, before a single byte is downloaded. A
 *      typo'd md5 that only surfaces 1.7 GB into a cold fetch has cost real
 *      minutes; the same typo caught by a structural pass costs nothing.
 *   3. COMPILE the source manifest plus the fetch results into a conforming
 *      `IAssetManifest` (src/types/assets.ts), which is what every downstream
 *      consumer actually reads.
 *
 * ── VALIDATION IS ALSO LICENCE ENFORCEMENT ─────────────────────────────────
 * `AssetLicense` deliberately keeps a `(string & {})` arm so an unusual but
 * valid SPDX id still type-checks. That means the type system CANNOT stop a
 * GPL asset from being added, so this file does: copyleft and share-alike ids
 * are rejected outright, and every entry must carry a real author and source
 * URL. Shipping a closed APK with a GPL texture in it is not a bug you get to
 * find in QA.
 *
 * ── ONE MATERIAL BECOMES FOUR ENTRIES ──────────────────────────────────────
 * The hand-authored manifest has one entry per material — that is the unit a
 * human curates. The built manifest has one `IMaterialAsset` plus one
 * `ITextureAsset` per map, because that is the unit the runtime registry
 * loads and reference-counts. `buildAssetManifest()` performs that expansion,
 * so neither side has to compromise.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AnyAssetEntry,
  ColorSpace,
  IAssetManifest,
  IAssetOutput,
  ICompressionProfile,
  IHDRIAsset,
  IMaterialAsset,
  IMeshCompressionProfile,
  IModelAsset,
  ITextureAsset,
  QualityTier,
  TextureRole,
} from '@/types';
import { MANIFEST_DIR } from './paths.ts';
import type {
  AnySourceEntry,
  IFetchedEntry,
  IHDRISourceEntry,
  IMaterialSourceEntry,
  IModelSourceEntry,
  ISourceFile,
  ISourceManifest,
  ITierTarget,
} from './types.ts';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

export const MANIFEST_FILES = ['textures.json', 'models.json', 'hdris.json'] as const;

export const QUALITY_TIERS: readonly QualityTier[] = ['mobile', 'high', 'ultra'];

const VALID_ROLES: readonly TextureRole[] = [
  'albedo',
  'normal',
  'roughness',
  'metalness',
  'orm',
  'occlusion',
  'emissive',
  'height',
  'alpha',
  'environment',
];

/** SPDX ids permitted for bundled art. Anything else is rejected by hand. */
const ALLOWED_LICENSES = new Set([
  'CC0-1.0',
  'CC-BY-4.0',
  'CC-BY-3.0',
  'MIT',
  'Apache-2.0',
  'OFL-1.1',
  'Unlicense',
  'public-domain',
]);

/** Licences that cannot ship in a closed APK, matched case-insensitively. */
const FORBIDDEN_LICENSE_PATTERNS = [
  /gpl/i,
  /\bsa\b/i,
  /share.?alike/i,
  /\bnc\b/i,
  /noncommercial/i,
];

/** Licences whose terms make `attributionUrl` mandatory. */
const ATTRIBUTION_REQUIRED = /^(CC-BY|OFL)/i;

const MD5_RE = /^[0-9a-f]{32}$/;
const ID_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

export class ManifestValidationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `manifest validation failed with ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`
    );
    this.name = 'ManifestValidationError';
  }
}

function validateFile(where: string, file: ISourceFile, problems: string[]): void {
  if (!file.url || !/^https:\/\//.test(file.url)) {
    problems.push(`${where}: url must be an https URL, got ${JSON.stringify(file.url)}`);
  }
  if (!MD5_RE.test(file.md5 ?? '')) {
    problems.push(`${where}: md5 must be 32 lowercase hex chars, got ${JSON.stringify(file.md5)}`);
  }
  if (!Number.isInteger(file.bytes) || file.bytes <= 0) {
    problems.push(`${where}: bytes must be a positive integer, got ${JSON.stringify(file.bytes)}`);
  }
  if (!file.path || path.isAbsolute(file.path) || file.path.split('/').includes('..')) {
    problems.push(
      `${where}: path must be relative and free of "..", got ${JSON.stringify(file.path)}`
    );
  }
  if (!file.format) problems.push(`${where}: format is required`);
  if (file.role !== undefined) {
    if (!VALID_ROLES.includes(file.role)) {
      problems.push(`${where}: unknown texture role ${JSON.stringify(file.role)}`);
    }
    if (file.colorSpace !== 'srgb' && file.colorSpace !== 'linear') {
      problems.push(`${where}: colorSpace must accompany role and be 'srgb' or 'linear'`);
    }
    // The single most common source of visual bugs, so it is checked, not trusted.
    const wantsSrgb = file.role === 'albedo' || file.role === 'emissive';
    if (wantsSrgb && file.colorSpace !== 'srgb') {
      problems.push(`${where}: role '${file.role}' is colour data and must be 'srgb'`);
    }
    if (!wantsSrgb && file.colorSpace === 'srgb') {
      problems.push(`${where}: role '${file.role}' is non-colour data and must be 'linear'`);
    }
  }
}

function validateTiers(
  where: string,
  tiers: Readonly<Partial<Record<string, ITierTarget>>>,
  problems: string[]
): void {
  for (const [tier, target] of Object.entries(tiers)) {
    if (!QUALITY_TIERS.includes(tier as QualityTier)) {
      problems.push(`${where}: unknown quality tier ${JSON.stringify(tier)}`);
      continue;
    }
    if (!target) continue;
    if (
      !Number.isInteger(target.maxDimension) ||
      target.maxDimension < 1 ||
      target.maxDimension > 8192
    ) {
      problems.push(`${where}.${tier}: maxDimension must be 1..8192, got ${target.maxDimension}`);
    }
    if (typeof target.quality !== 'number' || target.quality < 0 || target.quality > 100) {
      problems.push(`${where}.${tier}: quality must be 0..100, got ${target.quality}`);
    }
    if (
      target.simplifyRatio !== undefined &&
      (target.simplifyRatio <= 0 || target.simplifyRatio > 1)
    ) {
      problems.push(
        `${where}.${tier}: simplifyRatio must be in (0, 1], got ${target.simplifyRatio}`
      );
    }
  }
}

function validateEntry(entry: AnySourceEntry, expectedKind: string, problems: string[]): void {
  const where = entry.id ?? '<missing id>';

  if (!entry.id || !ID_RE.test(entry.id)) {
    problems.push(`${where}: id must be lowercase dot-namespaced, e.g. 'mat.wall.brick.red'`);
  }
  if (entry.kind !== expectedKind) {
    problems.push(
      `${where}: kind '${entry.kind}' does not match this manifest's kind '${expectedKind}'`
    );
  }
  if (!entry.name) problems.push(`${where}: name is required (it appears in the credits screen)`);
  if (!entry.providerAssetId) problems.push(`${where}: providerAssetId is required`);
  if (!entry.targetFormat) problems.push(`${where}: targetFormat is required`);

  const attribution = entry.attribution;
  if (!attribution) {
    problems.push(
      `${where}: attribution block is required — an asset with unknown provenance cannot ship`
    );
  } else {
    const license = String(attribution.license ?? '');
    if (!license) {
      problems.push(`${where}: attribution.license is required`);
    } else if (FORBIDDEN_LICENSE_PATTERNS.some((re) => re.test(license))) {
      problems.push(
        `${where}: licence '${license}' is copyleft/share-alike/non-commercial and cannot ship in a closed APK`
      );
    } else if (!ALLOWED_LICENSES.has(license)) {
      problems.push(
        `${where}: licence '${license}' is not on the permitted list (${[...ALLOWED_LICENSES].join(', ')})`
      );
    }
    if (!attribution.author) problems.push(`${where}: attribution.author is required`);
    if (!attribution.sourceUrl) problems.push(`${where}: attribution.sourceUrl is required`);
    if (ATTRIBUTION_REQUIRED.test(license) && !attribution.attributionUrl) {
      problems.push(
        `${where}: licence '${license}' demands attribution, so attributionUrl is required`
      );
    }
  }

  if (!entry.sourceUrl) problems.push(`${where}: sourceUrl is required`);
  if (!Array.isArray(entry.tags)) problems.push(`${where}: tags must be an array`);
  if (!Array.isArray(entry.files)) {
    problems.push(`${where}: files must be an array`);
  } else {
    if (entry.provider === 'procedural' && entry.files.length > 0) {
      problems.push(`${where}: procedural entries must declare no files`);
    }
    if (entry.provider !== 'procedural' && entry.files.length === 0) {
      problems.push(
        `${where}: provider '${entry.provider}' entries must declare at least one file`
      );
    }
    const seenPaths = new Set<string>();
    for (const file of entry.files) {
      validateFile(`${where}.files[${file.key}]`, file, problems);
      if (seenPaths.has(file.path)) {
        problems.push(`${where}: duplicate file path ${file.path}`);
      }
      seenPaths.add(file.path);
    }
  }

  validateTiers(`${where}.tiers`, entry.tiers ?? {}, problems);

  if (entry.kind === 'material') {
    const material = entry as IMaterialSourceEntry;
    if (!material.spec) {
      problems.push(`${where}: material entries need a spec`);
    } else if (material.spec.id !== entry.id) {
      problems.push(`${where}: spec.id '${material.spec.id}' must equal the entry id`);
    }
    const roles = new Set(entry.files.map((f) => f.role).filter(Boolean));
    for (const [role, key] of Object.entries(material.textureKeys ?? {})) {
      if (key !== `${entry.id}.${role}`) {
        problems.push(`${where}: textureKeys.${role} must be '${entry.id}.${role}', got '${key}'`);
      }
      if (entry.provider !== 'procedural' && !roles.has(role as TextureRole)) {
        problems.push(`${where}: textureKeys declares role '${role}' but no file supplies it`);
      }
    }
    if (material.tileSizeMeters !== undefined && material.tileSizeMeters <= 0) {
      problems.push(`${where}: tileSizeMeters must be positive`);
    }
  }

  if (entry.kind === 'hdri') {
    const hdri = entry as IHDRISourceEntry;
    if (!Number.isInteger(hdri.resolution) || hdri.resolution <= 0) {
      problems.push(`${where}: hdri resolution must be a positive integer width in px`);
    }
    if (entry.files.filter((f) => f.root).length !== 1) {
      problems.push(`${where}: hdri entries need exactly one file marked root:true`);
    }
  }

  if (entry.kind === 'model') {
    if (entry.provider !== 'procedural' && entry.files.filter((f) => f.root).length !== 1) {
      problems.push(`${where}: model entries need exactly one file marked root:true (the .gltf)`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                    */
/* -------------------------------------------------------------------------- */

export interface ILoadedManifests {
  /** Every entry across every manifest file, in file then declaration order. */
  readonly entries: readonly AnySourceEntry[];
  /** Per-file manifests, keyed by basename. */
  readonly byFile: Readonly<Record<string, ISourceManifest>>;
  /** Total declared bytes across every file of every entry. */
  readonly totalBytes: number;
  /** Total declared source files. */
  readonly totalFiles: number;
}

/**
 * Load and validate every manifest in `tools/manifest/`.
 *
 * Throws `ManifestValidationError` listing EVERY problem found, not just the
 * first — fixing manifests one error per run is miserable.
 */
export async function loadSourceManifests(dir: string = MANIFEST_DIR): Promise<ILoadedManifests> {
  // Only the THIRD-PARTY source manifests belong here. `tools/manifest/` also
  // holds `characters.json`, which describes first-party generated characters
  // and is deliberately a different shape — globbing `*.json` fed it to the
  // source-entry validator and aborted the whole asset pipeline with 46 errors,
  // so `npm run assets` failed on a fresh clone.
  const present = new Set(await readdir(dir));
  const names = MANIFEST_FILES.filter((n) => present.has(n));

  const problems: string[] = [];
  const byFile: Record<string, ISourceManifest> = {};
  const entries: AnySourceEntry[] = [];
  const seenIds = new Map<string, string>();
  let totalBytes = 0;
  let totalFiles = 0;

  for (const name of names) {
    const full = path.join(dir, name);
    let manifest: ISourceManifest;
    try {
      manifest = JSON.parse(await readFile(full, 'utf8')) as ISourceManifest;
    } catch (error) {
      problems.push(`${name}: not valid JSON — ${(error as Error).message}`);
      continue;
    }
    if (manifest.version !== 1) {
      problems.push(`${name}: unsupported manifest version ${manifest.version}`);
      continue;
    }
    if (!Array.isArray(manifest.entries)) {
      problems.push(`${name}: entries must be an array`);
      continue;
    }
    byFile[name] = manifest;

    for (const entry of manifest.entries) {
      validateEntry(entry, manifest.kind, problems);
      const previous = seenIds.get(entry.id);
      if (previous) {
        problems.push(`${entry.id}: duplicate id, already declared in ${previous}`);
      } else {
        seenIds.set(entry.id, name);
      }
      entries.push(entry);
      for (const file of entry.files ?? []) {
        totalBytes += file.bytes ?? 0;
        totalFiles += 1;
      }
    }
  }

  if (names.length === 0) problems.push(`${dir}: no manifest files found`);
  if (problems.length > 0) throw new ManifestValidationError(problems);

  return { entries, byFile, totalBytes, totalFiles };
}

/* -------------------------------------------------------------------------- */
/* Compression profile derivation                                             */
/* -------------------------------------------------------------------------- */

/**
 * Turn a per-tier target plus a file's role into a full `ICompressionProfile`.
 *
 * The manifest stores only what genuinely varies per asset (dimension, codec,
 * quality). Everything else is mechanically implied by the file itself:
 *   • colour space follows the role, always;
 *   • normal maps get the encoder's two-channel mode;
 *   • JPEG sources have no alpha to preserve, so alpha is dropped — and
 *     dropping it is a real bandwidth win, not a rounding error.
 *
 * Normal maps are also never encoded with ETC1S in its default mode: it is a
 * shared-palette *colour* codec and mangles tangent vectors. When a tier asks
 * for ETC1S on a normal map the profile still says etc1s, but with
 * `isNormalMap: true`, which is the encoder's normal-optimised path.
 */
export function compressionProfileFor(file: ISourceFile, target: ITierTarget): ICompressionProfile {
  const role = file.role;
  const colorSpace: ColorSpace =
    file.colorSpace ?? (role === 'albedo' || role === 'emissive' ? 'srgb' : 'linear');
  const format = file.format.toLowerCase();
  return {
    codec: target.codec,
    quality: target.quality,
    maxDimension: target.maxDimension,
    generateMipmaps: true,
    colorSpace,
    isNormalMap: role === 'normal',
    zstd: target.zstd ?? true,
    zstdLevel: target.zstdLevel ?? 18,
    hasAlpha: format === 'png' || role === 'alpha',
  };
}

/** Mesh decimation settings for one tier. */
export function meshProfileFor(target: ITierTarget): IMeshCompressionProfile {
  return {
    simplifyRatio: target.simplifyRatio ?? 1,
    draco: target.draco ?? false,
    meshopt: target.meshopt ?? true,
    positionBits: target.positionBits,
    normalBits: target.normalBits,
  };
}

/* -------------------------------------------------------------------------- */
/* Compilation to IAssetManifest                                              */
/* -------------------------------------------------------------------------- */

const EMPTY_OUTPUTS: readonly IAssetOutput[] = [];

function textureEntryFor(
  material: IMaterialSourceEntry,
  file: ISourceFile,
  fileSha: string
): ITextureAsset {
  const role = file.role as TextureRole;
  const compression: Partial<Record<QualityTier, ICompressionProfile>> = {};
  for (const tier of QUALITY_TIERS) {
    const target = material.tiers[tier];
    if (target) compression[tier] = compressionProfileFor(file, target);
  }
  const width = material.sourceResolution?.[0] ?? undefined;
  const height = material.sourceResolution?.[1] ?? undefined;
  return {
    id: `${material.id}.${role}`,
    kind: 'texture',
    name: `${material.name} — ${role}`,
    attribution: material.attribution,
    sourceUrl: file.url,
    sha256: fileSha,
    sourceFile: file.path,
    sourceBytes: file.bytes,
    targetFormat: 'ktx2',
    outputs: EMPTY_OUTPUTS,
    tags: material.tags,
    preload: material.preload,
    role,
    colorSpace: file.colorSpace ?? 'linear',
    compression,
    tileable: true,
    sourceWidth: typeof width === 'number' ? width : undefined,
    sourceHeight: typeof height === 'number' ? height : undefined,
  };
}

/**
 * Compile source entries + fetch results into a conforming `IAssetManifest`.
 *
 * `outputs` is left empty everywhere: this function runs after the FETCH
 * stage, and nothing has been transcoded yet. `process-assets` fills them in.
 * Every `sha256` here is real, measured from bytes on disk.
 */
export function buildAssetManifest(
  fetched: readonly IFetchedEntry[],
  options: { generator?: string; generatedRoot?: string } = {}
): IAssetManifest {
  const entries: AnyAssetEntry[] = [];

  for (const result of fetched) {
    const source = result.entry;
    const shaByPath = new Map(result.files.map((f) => [f.file.path, f.sha256]));

    if (source.kind === 'material') {
      const material = source as IMaterialSourceEntry;
      const textureKeys: Partial<Record<TextureRole, string>> = {};

      for (const file of material.files) {
        if (!file.role) continue;
        const sha = shaByPath.get(file.path);
        if (!sha) continue;
        entries.push(textureEntryFor(material, file, sha));
        textureKeys[file.role] = `${material.id}.${file.role}`;
      }

      const asset: IMaterialAsset = {
        id: material.id,
        kind: 'material',
        name: material.name,
        attribution: material.attribution,
        sourceUrl: material.sourceUrl,
        sha256: result.digest,
        targetFormat: 'json',
        outputs: EMPTY_OUTPUTS,
        tags: material.tags,
        preload: material.preload,
        sourceBytes: result.bytes,
        spec: material.spec,
        textureKeys,
        tileSizeMeters: material.tileSizeMeters,
      };
      entries.push(asset);
      continue;
    }

    if (source.kind === 'model') {
      const model = source as IModelSourceEntry;
      const root = model.files.find((f) => f.root);
      const asset: IModelAsset = {
        id: model.id,
        kind: 'model',
        name: model.name,
        attribution: model.attribution,
        sourceUrl: model.sourceUrl,
        sha256: result.digest,
        sourceFile: root?.path,
        targetFormat: 'glb',
        outputs: EMPTY_OUTPUTS,
        tags: model.tags,
        preload: model.preload,
        sourceBytes: result.bytes,
        meshCompression: model.tiers.high ? meshProfileFor(model.tiers.high) : undefined,
        lodLevels: [],
        // Poly Haven models embed their own textures, so they bind no shared
        // material ids. The processing stage may still hoist duplicates out.
        materialKeys: [],
        triangles: model.sourcePolycount ?? 0,
        instanced: model.instanced,
      };
      entries.push(asset);
      continue;
    }

    const hdri = source as IHDRISourceEntry;
    const root = hdri.files.find((f) => f.root);
    const asset: IHDRIAsset = {
      id: hdri.id,
      kind: 'hdri',
      name: hdri.name,
      attribution: hdri.attribution,
      sourceUrl: hdri.sourceUrl,
      sha256: result.digest,
      sourceFile: root?.path,
      targetFormat: hdri.targetFormat,
      outputs: EMPTY_OUTPUTS,
      tags: hdri.tags,
      preload: hdri.preload,
      sourceBytes: result.bytes,
      resolution: hdri.resolution,
      timeOfDay: hdri.timeOfDay,
      hasIrradiance: hdri.hasIrradiance,
    };
    entries.push(asset);
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    generator: options.generator ?? 'tools/fetch-assets.ts',
    entries,
    generatedRoot: options.generatedRoot ?? 'assets/generated',
  };
}
