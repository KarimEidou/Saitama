/**
 * POLY HAVEN API CLIENT
 *
 * https://api.polyhaven.com — 849 textures, 986 HDRIs, 521 models, every one
 * of them CC0.
 *
 * ── WHY THIS IS THE PRIMARY PROVIDER ───────────────────────────────────────
 * `/files/<id>` returns, for every map at every resolution in every format,
 * a `{url, size, md5}` triple. That is a ready-made integrity manifest
 * published by the source itself, which is what makes end-to-end verification
 * possible at all. ambientCG has four times the material count but ships
 * whole-material zips with no hashes, so it can only ever be a fallback.
 *
 * ── THE `arm` MAP ──────────────────────────────────────────────────────────
 * Alongside the usual `Diffuse`/`nor_gl`/`Rough`/`AO`, Poly Haven publishes
 * `arm`: ambient occlusion, roughness and metalness already packed into R, G
 * and B. Three.js `MeshStandardMaterial` samples `aoMap` from .r,
 * `roughnessMap` from .g and `metalnessMap` from .b, so a single `arm` upload
 * fills all three slots — one texture instead of three, i.e. a 3x cut in both
 * VRAM and texture-unit pressure for free. Prefer it wherever it exists.
 *
 * ── CACHING ────────────────────────────────────────────────────────────────
 * Responses are cached for 24h under `assets/source/api/`. The manifests
 * already record url+md5+bytes, so the API is consulted to *cross-check* the
 * manifest against what the provider currently publishes, not to discover
 * anything. Drift shows up as a loud warning rather than a silent mismatch.
 */

import path from 'node:path';
import { API_CACHE_DIR } from './paths.ts';
import { readJsonCache, writeJsonCache } from './cache.ts';
import { fetchJson } from './http.ts';
import type { PolyHavenType } from './types.ts';

export const API_BASE = 'https://api.polyhaven.com';
/** Provider metadata is stable; a day is plenty and keeps CI off the API. */
export const API_TTL_MS = 24 * 60 * 60 * 1000;

/** One downloadable file as Poly Haven describes it. */
export interface IPolyHavenFile {
  readonly url: string;
  readonly size: number;
  readonly md5: string;
  /** Present on glTF entries: every .bin and texture the document needs. */
  readonly include?: Record<string, IPolyHavenFile>;
}

/**
 * `/files/<id>`, shaped as it actually arrives:
 * map -> resolution -> format -> file. glTF nests one level differently
 * (`gltf.<res>.gltf`), which `resolveFile()` hides.
 */
export type PolyHavenFiles = Record<string, Record<string, Record<string, IPolyHavenFile>>>;

/** `/info/<id>` — the fields this pipeline actually uses. */
export interface IPolyHavenInfo {
  readonly name: string;
  readonly type: number;
  /** author name -> their role ("All", "Photography", "Processing"). */
  readonly authors: Record<string, string>;
  readonly date_published?: number;
  readonly categories?: readonly string[];
  readonly tags?: readonly string[];
  readonly description?: string;
  /** Physical size of one tile in millimetres, for textures. */
  readonly dimensions?: readonly number[];
  readonly max_resolution?: readonly number[];
  readonly polycount?: number;
  readonly download_count?: number;
  readonly thumbnail_url?: string;
}

/** Canonical human-facing page for an asset. */
export function assetPageUrl(id: string): string {
  return `https://polyhaven.com/a/${id}`;
}

function cacheFile(kind: string, id: string): string {
  // Ids are `[a-z0-9_]`, but sanitise anyway — a manifest is editable by hand.
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(API_CACHE_DIR, `${kind}_${safe}.json`);
}

async function cached<T>(kind: string, id: string, url: string, offline: boolean): Promise<T> {
  const file = cacheFile(kind, id);
  const hit = await readJsonCache<T>(file);
  if (hit !== undefined) return hit;
  if (offline) {
    throw new Error(
      `polyhaven: ${kind}/${id} is not in the 24h API cache and --offline was requested`
    );
  }
  const value = await fetchJson<T>(url);
  await writeJsonCache(file, value, API_TTL_MS);
  return value;
}

export interface IPolyHavenClientOptions {
  /** Never touch the network; fail if the API cache cannot answer. */
  readonly offline?: boolean;
}

export class PolyHavenClient {
  private readonly offline: boolean;
  private readonly memo = new Map<string, Promise<unknown>>();

  constructor(options: IPolyHavenClientOptions = {}) {
    this.offline = options.offline ?? false;
  }

  /** Memoise per process so 39 props sharing an id fetch it once. */
  private once<T>(key: string, make: () => Promise<T>): Promise<T> {
    const existing = this.memo.get(key);
    if (existing) return existing as Promise<T>;
    const created = make();
    this.memo.set(key, created);
    return created;
  }

  /** `/assets?type=<type>` — the full index for a category. */
  async list(type: PolyHavenType): Promise<Record<string, IPolyHavenInfo>> {
    return this.once(`list:${type}`, () =>
      cached<Record<string, IPolyHavenInfo>>(
        'assets',
        type,
        `${API_BASE}/assets?type=${type}`,
        this.offline
      )
    );
  }

  /** `/files/<id>` — every file, resolution and format, each with md5. */
  async files(id: string): Promise<PolyHavenFiles> {
    return this.once(`files:${id}`, () =>
      cached<PolyHavenFiles>('files', id, `${API_BASE}/files/${id}`, this.offline)
    );
  }

  /** `/info/<id>` — authorship and licence data for the credits screen. */
  async info(id: string): Promise<IPolyHavenInfo> {
    return this.once(`info:${id}`, () =>
      cached<IPolyHavenInfo>('info', id, `${API_BASE}/info/${id}`, this.offline)
    );
  }

  /**
   * Look up one concrete file the way the manifest addresses it.
   *
   *   texture: resolveFile(files, 'Diffuse', '4k', 'jpg')
   *   hdri:    resolveFile(files, 'hdri',    '4k', 'hdr')
   *   model:   resolveFile(files, 'gltf',    '2k', 'gltf')
   *
   * Returns undefined rather than throwing so callers can report a precise
   * "manifest asks for a map this asset does not publish" message.
   */
  static resolveFile(
    files: PolyHavenFiles,
    map: string,
    resolution: string,
    format: string
  ): IPolyHavenFile | undefined {
    const byResolution = files[map];
    if (!byResolution) return undefined;
    const byFormat = byResolution[resolution];
    if (!byFormat) return undefined;
    return byFormat[format];
  }

  /** Attribution string from `/info`, e.g. "Dario Barresi, Charlotte Baglioni". */
  static authorsOf(info: IPolyHavenInfo): string {
    const names = Object.keys(info.authors ?? {});
    return names.length > 0 ? names.join(', ') : 'Poly Haven';
  }
}
