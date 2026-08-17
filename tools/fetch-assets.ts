/**
 * ASSET FETCH — `npm run assets:fetch`
 *
 * Downloads every source file `tools/manifest/*.json` declares, verifies it
 * against the md5 the provider publishes, and writes `assets/assets.lock.json`.
 *
 * ── WHAT IT GUARANTEES ─────────────────────────────────────────────────────
 *   • Nothing lands on disk unverified. Every byte is md5-checked against
 *     api.polyhaven.com, and a mismatch deletes the blob, retries once, then
 *     fails the build. There is no path that keeps a corrupt file.
 *   • A warm re-run is a no-op. Cached blobs are confirmed by index lookup and
 *     size, with no network and no re-hashing.
 *   • The result is reproducible. Every source file's sha256 is committed to
 *     `assets/assets.lock.json`; `--frozen` turns that record into an
 *     assertion for CI.
 *   • Binaries stay out of git. `assets/source/` and `assets/generated/` are
 *     gitignored and `npm run guard` enforces a 5 MB cap on tracked files.
 *
 * ── USAGE ──────────────────────────────────────────────────────────────────
 *   npm run assets:fetch
 *   npm run assets:fetch -- --only asphalt,fire_hydrant   subset by id substring
 *   npm run assets:fetch -- --kind hdri                   subset by kind
 *   npm run assets:fetch -- --limit 3                     first N matching entries
 *   npm run assets:fetch -- --frozen                      CI: lockfile is law
 *   npm run assets:fetch -- --verify                      re-hash every cached blob
 *   npm run assets:fetch -- --dry-run                     resolve + report, no transfer
 *   npm run assets:fetch -- --offline                     use the 24h API cache only
 *   npm run assets:fetch -- --concurrency 6               parallel transfers
 *
 * Exit codes: 0 clean, 1 anything went wrong.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import {
  Fetcher,
  Logger,
  PolyHavenClient,
  ProgressTracker,
  SourceCache,
  buildAssetManifest,
  buildLockFile,
  formatBytes,
  formatDuration,
  formatRate,
  loadSourceManifests,
  lockFilesDiffer,
  mergeLockFiles,
  readLockFile,
  writeLockFile,
  DEFAULT_CONCURRENCY,
  LOCKFILE,
  RESOLVED_MANIFEST,
  SOURCE_DIR,
  rel,
} from './lib/index.ts';
import type { AssetKind } from '@/types';
import type { AnySourceEntry } from './lib/index.ts';

/* -------------------------------------------------------------------------- */
/* Argument parsing                                                           */
/* -------------------------------------------------------------------------- */

interface ICliOptions {
  readonly only: readonly string[];
  readonly kinds: readonly AssetKind[];
  readonly limit?: number;
  readonly frozen: boolean;
  readonly verify: boolean;
  readonly dryRun: boolean;
  readonly offline: boolean;
  readonly concurrency: number;
  readonly quiet: boolean;
  readonly help: boolean;
}

function parseArgs(argv: readonly string[]): ICliOptions {
  const only: string[] = [];
  const kinds: AssetKind[] = [];
  let limit: number | undefined;
  let frozen = false;
  let verify = false;
  let dryRun = false;
  let offline = false;
  let quiet = false;
  let help = false;
  let concurrency = DEFAULT_CONCURRENCY;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = (): string => {
      const inline = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : undefined;
      if (inline !== undefined) return inline;
      i += 1;
      return argv[i] ?? '';
    };
    const name = arg.split('=')[0];
    switch (name) {
      case '--only':
        only.push(
          ...value()
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        );
        break;
      case '--kind':
        kinds.push(
          ...(value()
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean) as AssetKind[])
        );
        break;
      case '--limit':
        limit = Number.parseInt(value(), 10);
        break;
      case '--concurrency':
        concurrency = Number.parseInt(value(), 10);
        break;
      case '--frozen':
        frozen = true;
        break;
      case '--verify':
        verify = true;
        break;
      case '--dry-run':
      case '--dryrun':
        dryRun = true;
        break;
      case '--offline':
        offline = true;
        break;
      case '--quiet':
        quiet = true;
        break;
      case '-h':
      case '--help':
        help = true;
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`unknown flag: ${arg}`);
    }
  }

  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error(`--concurrency must be an integer 1..32, got ${concurrency}`);
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error(`--limit must be a positive integer`);
  }

  return { only, kinds, limit, frozen, verify, dryRun, offline, concurrency, quiet, help };
}

const HELP = `
asset fetch — download and verify every source file in tools/manifest/*.json

  --only <a,b>        keep entries whose id or provider id contains any of these
  --kind <k,...>      keep entries of these kinds (material, model, hdri)
  --limit <n>         keep only the first n matching entries
  --frozen            fail if anything is not already in assets.lock.json
  --verify            re-hash every cached blob instead of trusting the index
  --dry-run           resolve and report; transfer nothing
  --offline           use the 24h API cache only; never touch the network
  --concurrency <n>   parallel transfers (default ${DEFAULT_CONCURRENCY})
  --quiet             warnings and errors only
  -h, --help          this text
`;

/* -------------------------------------------------------------------------- */
/* Selection                                                                  */
/* -------------------------------------------------------------------------- */

function selectEntries(
  entries: readonly AnySourceEntry[],
  options: ICliOptions
): readonly AnySourceEntry[] {
  let selected = entries;
  if (options.kinds.length > 0) {
    selected = selected.filter((e) => options.kinds.includes(e.kind));
  }
  if (options.only.length > 0) {
    selected = selected.filter((e) =>
      options.only.some((needle) => e.id.includes(needle) || e.providerAssetId.includes(needle))
    );
  }
  if (options.limit !== undefined) selected = selected.slice(0, options.limit);
  return selected;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  const log = new Logger({ level: options.quiet ? 'warn' : 'info' });
  const startedAt = Date.now();

  log.heading('asset fetch');

  /* 1 — manifests ------------------------------------------------------- */
  const loaded = await loadSourceManifests();
  log.ok(
    `manifests: ${Object.keys(loaded.byFile).length} files, ${loaded.entries.length} entries, ` +
      `${loaded.totalFiles} source files, ${formatBytes(loaded.totalBytes)} declared`
  );
  for (const [name, manifest] of Object.entries(loaded.byFile)) {
    log.debug(`${name}: ${manifest.entries.length} ${manifest.kind} entries`);
  }

  const selected = selectEntries(loaded.entries, options);
  if (selected.length === 0) {
    log.error('no entries matched the selection');
    return 1;
  }
  if (selected.length !== loaded.entries.length) {
    log.info(`selection: ${selected.length}/${loaded.entries.length} entries`);
  }

  const downloadable = selected.filter((e) => e.files.length > 0);
  const procedural = selected.length - downloadable.length;
  if (procedural > 0) {
    log.info(`${procedural} procedural entr${procedural === 1 ? 'y' : 'ies'} need no download`);
  }

  /* 2 — cache and lockfile ---------------------------------------------- */
  await mkdir(SOURCE_DIR, { recursive: true });
  await SourceCache.ensureDirs();
  const cache = new SourceCache();
  await cache.load();
  const existingLock = await readLockFile();
  log.info(
    `cache: ${cache.size} known urls` +
      (existingLock ? `; lockfile: ${existingLock.totals.files} files` : '; no lockfile yet')
  );
  if (options.frozen && !existingLock) {
    log.error('--frozen was requested but assets/assets.lock.json does not exist');
    return 1;
  }

  /* 3 — resolve against the provider ------------------------------------ */
  const client = new PolyHavenClient({ offline: options.offline });
  const fetcher = new Fetcher({
    logger: log,
    cache,
    client,
    concurrency: options.concurrency,
    verify: options.verify,
    frozen: options.frozen,
    lock: existingLock,
    dryRun: options.dryRun,
  });

  log.heading('resolving against api.polyhaven.com');
  const plan = await fetcher.resolveAll(selected);
  log.ok(
    `resolved ${plan.totalFiles} files, ${formatBytes(plan.totalBytes)}` +
      (plan.drifted > 0 ? `, ${plan.drifted} DRIFTED from the manifest` : ', 0 drifted')
  );
  for (const warning of fetcher.warningLog) log.warn(warning);

  fetcher.assertFrozen(plan);
  if (options.frozen) log.ok('--frozen: every file is vouched for by assets.lock.json');

  /* 4 — transfer -------------------------------------------------------- */
  log.heading(
    options.dryRun
      ? 'dry run — nothing will be transferred'
      : `fetching (concurrency ${options.concurrency})`
  );
  const progress = new ProgressTracker({
    totalItems: plan.totalFiles,
    totalBytes: plan.totalBytes,
    logger: log,
    label: options.dryRun ? 'plan ' : 'fetch',
  });

  let fetched;
  try {
    fetched = await fetcher.fetchPlan(plan, progress);
  } finally {
    progress.done();
    await cache.save();
    await Fetcher.cleanTemp();
  }

  const summary = progress.summary();
  if (options.dryRun) {
    log.ok(
      `${summary.items} files planned, ${formatBytes(summary.bytesDone)} would be considered ` +
        `(${summary.cached} already cached)`
    );
    log.heading('dry run complete — no lockfile written');
    return 0;
  }
  log.ok(
    `${summary.items} files: ${summary.cached} cached, ${summary.downloaded} downloaded ` +
      `(${formatBytes(summary.transferred)} over the wire in ${formatDuration(summary.elapsedMs)}` +
      `${summary.transferred > 0 ? `, ${formatRate(summary.transferred, summary.elapsedMs)}` : ''})`
  );

  /* 5 — lockfile -------------------------------------------------------- */
  const partial = selected.length !== loaded.entries.length;
  const built = buildLockFile(fetched);
  const merged = partial ? mergeLockFiles(existingLock, built) : built;
  const changed = lockFilesDiffer(existingLock, merged);

  if (options.frozen && changed) {
    log.error('--frozen: the fetch would change assets.lock.json; refusing to write it');
    return 1;
  }
  if (changed) {
    await writeLockFile(merged);
    log.ok(
      `wrote ${rel(LOCKFILE)} — ${merged.totals.entries} entries, ` +
        `${merged.totals.files} files, ${formatBytes(merged.totals.bytes)}`
    );
  } else {
    log.ok(`${rel(LOCKFILE)} unchanged — this run was a no-op`);
  }

  /* 6 — resolved manifest for the processing stage ----------------------- */
  const resolvedManifest = buildAssetManifest(fetched, {
    generator: 'tools/fetch-assets.ts',
  });
  await writeFile(RESOLVED_MANIFEST, `${JSON.stringify(resolvedManifest, null, 2)}\n`);
  log.ok(
    `wrote ${rel(RESOLVED_MANIFEST)} — ${resolvedManifest.entries.length} IAssetManifest entries ` +
      `(gitignored; outputs[] filled in by assets:process)`
  );

  /* 7 — attribution rollup ---------------------------------------------- */
  const authors = new Set<string>();
  const licenses = new Map<string, number>();
  for (const result of fetched) {
    authors.add(result.entry.attribution.author);
    const license = String(result.entry.attribution.license);
    licenses.set(license, (licenses.get(license) ?? 0) + 1);
  }
  log.info(
    `attribution: ${authors.size} authors; ` +
      [...licenses].map(([l, n]) => `${l} x${n}`).join(', ')
  );

  log.heading(`done in ${formatDuration(Date.now() - startedAt)}`);
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
