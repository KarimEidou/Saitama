/**
 * ASSET FETCH — STUB
 *
 * Placeholder so `npm run assets:fetch` fails with a clear message instead of
 * "module not found". Implementation is owned by the asset-pipeline
 * workstream, which should REPLACE this file entirely.
 *
 * Contract to implement (see src/types/assets.ts):
 *   • Download sources into `assets/source/` (gitignored — never commit them).
 *   • Record a conforming `IAssetEntry` per asset, including `sha256` of the
 *     ORIGINAL file and a complete `IAssetAttribution` block.
 *   • Write the manifest as `IAssetManifest` under `tools/manifest/`.
 *
 * Licence compliance is a hard requirement: every entry needs a real
 * `license`, `author` and `sourceUrl`, plus `attributionUrl` when the licence
 * demands attribution. Omit an asset rather than guessing its provenance.
 *
 * Verified tooling available in this environment:
 *   ktx      -> node_modules/ktx2tools/bin/linux/ktx        (KTX-Software 4.4.0)
 *   basisu   -> node_modules/@gpu-tex-enc/basis/bin/linux-x64/basisu
 *   ffmpeg   -> node_modules/ffmpeg-static/ffmpeg
 *   sharp    -> libvips 8.18.3
 */

console.error(
  [
    'npm run assets:fetch is not implemented yet.',
    '',
    'tools/fetch-assets.ts is a scaffold stub owned by the asset-pipeline',
    'workstream. It must write an IAssetManifest (see src/types/assets.ts).',
  ].join('\n')
);
process.exit(1);
