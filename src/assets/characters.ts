/**
 * CHARACTER ASSET INDEX
 *
 * Characters come from a SEPARATE pipeline (`tools/build-characters.ts`) and
 * are deliberately NOT in `assets.runtime.json`. They live under
 * `assets/chr/<name>/` with a sibling index, `chr/characters.runtime.json`.
 *
 * Two consequences the rest of the runtime has to respect:
 *
 *   1. `IAssetRegistry.getEntry('chr.saitama')` returns undefined, and that is
 *      correct rather than a bug — there is no manifest entry to return, and
 *      synthesising one would mean inventing the licence fields that
 *      `types/assets.ts` calls a shipping blocker. `getCharacter()`, `load()`
 *      and `isLoaded()` all work; only the manifest view is empty.
 *
 *   2. Tier is carried in the FILENAME (`albedo.mobile.png`,
 *      `normal.high.png`), so `parseTierToken` is the fallback path when the
 *      index is absent or a file appears that the index does not list. The
 *      index's own `tier` field is preferred when present because it is
 *      authoritative and cheaper.
 *
 * Character textures are PNG, not KTX2 — the character pipeline bakes atlases
 * at runtime-ish sizes and leaves them browser-decodable. They are therefore
 * uncompressed on the GPU (4 bytes/px), which is why they are budgeted through
 * the same LRU as everything else rather than treated as free.
 */

import type { QualityTier } from '@/types';
import { TIER_ORDER, TIER_RANK } from './constants';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** Semantic slot a character texture fills. */
export type CharacterTextureRole = 'albedo' | 'normal' | 'orm' | 'emissive' | 'face' | 'mask';

/** One baked character texture at one tier. */
export interface ICharacterFile {
  /** Stable key, e.g. `chr.saitama.albedo`. */
  readonly key: string;
  readonly role: CharacterTextureRole;
  readonly tier: QualityTier;
  /** Path relative to the asset root, e.g. `chr/saitama/albedo.mobile.png`. */
  readonly file: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
}

/** One character as the bake pipeline describes it. */
export interface ICharacterRecord {
  /** e.g. `chr.saitama`. */
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  /** Standing height in metres, for scale normalisation. */
  readonly height: number;
  /** Directory under the asset root, e.g. `chr/saitama`. */
  readonly dir: string;
  /** Rigged mesh; one GLB regardless of tier. */
  readonly modelFile: string;
  /** Vertex-animation texture sidecars, when the bake produced them. */
  readonly vatFile?: string;
  readonly vatMetaFile?: string;
  readonly triangles: Readonly<Record<string, number>>;
  readonly files: readonly ICharacterFile[];
  /** Uncompressed GPU bytes per tier, as measured by the baker. */
  readonly gpuBytes: Readonly<Partial<Record<QualityTier, number>>>;
}

/* -------------------------------------------------------------------------- */
/* Filename tier token                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Read the `.tier.` token out of a character filename.
 *
 * `chr/saitama/albedo.mobile.png` -> 'mobile'.
 * `chr/saitama/face.png`          -> undefined (tier-less source art).
 *
 * The token is matched between dots so a directory containing the word
 * "mobile" cannot masquerade as a tier.
 */
export function parseTierToken(file: string): QualityTier | undefined {
  const base = file.slice(file.lastIndexOf('/') + 1);
  for (const tier of TIER_ORDER) {
    if (base.includes(`.${tier}.`)) return tier;
  }
  return undefined;
}

/** Role implied by a character filename, when it follows the bake convention. */
export function parseRoleToken(file: string): CharacterTextureRole | undefined {
  const base = file.slice(file.lastIndexOf('/') + 1);
  const head = base.split('.')[0];
  const roles: readonly CharacterTextureRole[] = [
    'albedo',
    'normal',
    'orm',
    'emissive',
    'face',
    'mask',
  ];
  return roles.find((role) => role === head);
}

/* -------------------------------------------------------------------------- */
/* Index                                                                      */
/* -------------------------------------------------------------------------- */

interface IRawCharacterFile {
  readonly key?: unknown;
  readonly role?: unknown;
  readonly tier?: unknown;
  readonly file?: unknown;
  readonly bytes?: unknown;
  readonly width?: unknown;
  readonly height?: unknown;
}

interface IRawCharacter {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly kind?: unknown;
  readonly height?: unknown;
  readonly triangles?: unknown;
  readonly files?: unknown;
  readonly gpuBytes?: unknown;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Directory a character's files live in.
 *
 * Derived from the first listed file when possible, because the id-to-folder
 * mapping is not mechanical: `chr.mook.wolf` lives in `chr/mook.wolf/` but
 * `chr.saitama` lives in `chr/saitama/`, and only the file paths know which.
 */
function directoryOf(files: readonly ICharacterFile[], id: string): string {
  const first = files[0]?.file;
  if (first !== undefined && first.includes('/')) {
    return first.slice(0, first.lastIndexOf('/'));
  }
  return `chr/${id.replace(/^chr\./, '')}`;
}

/** Parse `chr/characters.runtime.json`. Tolerant: bad rows are skipped. */
export function parseCharacterIndex(raw: unknown): readonly ICharacterRecord[] {
  const source = (raw ?? {}) as { characters?: unknown };
  if (!Array.isArray(source.characters)) return [];

  const out: ICharacterRecord[] = [];
  for (const candidate of source.characters as IRawCharacter[]) {
    if (typeof candidate?.id !== 'string') continue;

    const files: ICharacterFile[] = [];
    for (const rawFile of Array.isArray(candidate.files)
      ? (candidate.files as IRawCharacterFile[])
      : []) {
      if (typeof rawFile?.file !== 'string') continue;
      // Prefer the declared tier; fall back to the filename token. A file that
      // has neither is tier-less source art and is skipped rather than guessed.
      const tier =
        TIER_ORDER.find((known) => known === rawFile.tier) ?? parseTierToken(rawFile.file);
      if (tier === undefined) continue;
      const role =
        (typeof rawFile.role === 'string'
          ? (rawFile.role as CharacterTextureRole)
          : undefined) ?? parseRoleToken(rawFile.file);
      if (role === undefined) continue;

      files.push({
        key: typeof rawFile.key === 'string' ? rawFile.key : `${candidate.id}.${role}`,
        role,
        tier,
        file: rawFile.file,
        bytes: num(rawFile.bytes),
        width: num(rawFile.width),
        height: num(rawFile.height),
      });
    }

    const dir = directoryOf(files, candidate.id);
    const gpu = (candidate.gpuBytes ?? {}) as Partial<Record<QualityTier, unknown>>;

    out.push({
      id: candidate.id,
      name: typeof candidate.name === 'string' ? candidate.name : candidate.id,
      kind: typeof candidate.kind === 'string' ? candidate.kind : 'unknown',
      height: num(candidate.height, 1.75),
      dir,
      modelFile: `${dir}/model.glb`,
      vatFile: `${dir}/vat.bin`,
      vatMetaFile: `${dir}/vat.json`,
      triangles: (candidate.triangles ?? {}) as Record<string, number>,
      files,
      gpuBytes: {
        mobile: num(gpu.mobile) || undefined,
        high: num(gpu.high) || undefined,
        ultra: num(gpu.ultra) || undefined,
      },
    });
  }
  return out;
}

/**
 * Build an index from a bare file listing, with no `characters.runtime.json`.
 *
 * This is the "index them by the filename token" path the brief calls for: it
 * is what keeps characters addressable if the bake's index is missing or a
 * future bake stops writing one.
 */
export function indexCharacterFiles(paths: readonly string[]): readonly ICharacterRecord[] {
  const byDir = new Map<string, ICharacterFile[]>();
  for (const path of paths) {
    const tier = parseTierToken(path);
    const role = parseRoleToken(path);
    if (tier === undefined || role === undefined) continue;
    const dir = path.slice(0, path.lastIndexOf('/'));
    const id = `chr.${dir.slice(dir.lastIndexOf('/') + 1)}`;
    const list = byDir.get(dir) ?? [];
    list.push({ key: `${id}.${role}`, role, tier, file: path, bytes: 0, width: 0, height: 0 });
    byDir.set(dir, list);
  }

  const out: ICharacterRecord[] = [];
  for (const [dir, files] of byDir) {
    const name = dir.slice(dir.lastIndexOf('/') + 1);
    out.push({
      id: `chr.${name}`,
      name,
      kind: 'unknown',
      height: 1.75,
      dir,
      modelFile: `${dir}/model.glb`,
      vatFile: `${dir}/vat.bin`,
      vatMetaFile: `${dir}/vat.json`,
      triangles: {},
      files,
      gpuBytes: {},
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Lookup wrapper over the parsed records. */
export class CharacterIndex {
  private readonly byId: ReadonlyMap<string, ICharacterRecord>;

  constructor(records: readonly ICharacterRecord[]) {
    const map = new Map<string, ICharacterRecord>();
    for (const record of records) map.set(record.id, record);
    this.byId = map;
  }

  get size(): number {
    return this.byId.size;
  }

  list(): readonly ICharacterRecord[] {
    return [...this.byId.values()];
  }

  get(id: string): ICharacterRecord | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Tiers this character actually has files for. */
  tiersFor(id: string): readonly QualityTier[] {
    const record = this.byId.get(id);
    if (!record) return [];
    const tiers = new Set(record.files.map((file) => file.tier));
    return TIER_ORDER.filter((tier) => tiers.has(tier));
  }

  /**
   * Texture files for one character at the best tier at or below `preferred`.
   *
   * Same downgrade rule as the main manifest: the character bake produces
   * `mobile` and `high` only, so a device on `ultra` resolves to `high`
   * without anyone special-casing it.
   */
  filesFor(id: string, preferred: QualityTier): readonly ICharacterFile[] {
    const record = this.byId.get(id);
    if (!record) return [];
    const available = this.tiersFor(id);
    let chosen: QualityTier | undefined;
    for (let rank = TIER_RANK[preferred]; rank >= 0; rank--) {
      const tier = TIER_ORDER[rank]!;
      if (available.includes(tier)) {
        chosen = tier;
        break;
      }
    }
    chosen ??= available[0];
    if (chosen === undefined) return [];
    return record.files.filter((file) => file.tier === chosen);
  }
}
