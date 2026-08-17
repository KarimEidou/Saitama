/**
 * ASSET PROCESSING — STUB
 *
 * Placeholder so `npm run assets:process` fails with a clear message instead
 * of "module not found". Implementation is owned by the asset-pipeline
 * workstream, which should REPLACE this file entirely.
 *
 * Contract to implement (see src/types/assets.ts):
 *   • Read the manifest written by `assets:fetch`.
 *   • Transcode into `assets/generated/` (gitignored) per `QualityTier`
 *     ('mobile' | 'high' | 'ultra'), filling in `IAssetOutput` per tier.
 *   • Textures -> KTX2. Respect `ColorSpace`: 'srgb' for albedo/emissive,
 *     'linear' for normal/roughness/metalness/AO. Getting this wrong is the
 *     most common source of visual bugs.
 *   • Normal maps must use the encoder's normal-optimised mode
 *     (`ICompressionProfile.isNormalMap`).
 *   • Meshes -> GLB with Draco/meshopt and an `IAssetLOD` chain.
 *
 * Verified encoders in this environment (all confirmed working):
 *   ktx      node_modules/ktx2tools/bin/linux/ktx              v4.4.0
 *   ktx2check node_modules/ktx2tools/bin/linux/ktx2check       v4.4.0
 *   basisu   node_modules/@gpu-tex-enc/basis/bin/linux-x64/basisu  v1.15 (+zstd)
 *   ffmpeg   node_modules/ffmpeg-static/ffmpeg
 *
 * NOTE: `@gltf-transform/cli` spawns `ktx` (not `toktx`) and needs
 * KTX-Software >= 4.3.0 — satisfied by the 4.4.0 binary above. Put
 * `node_modules/ktx2tools/bin/linux` on PATH before invoking it.
 *
 * NOTE: the `ktx2tools` npm bin shims print a "Running: ..." banner to stdout.
 * Invoke the ELF binaries directly when parsing output.
 */

console.error(
  [
    'npm run assets:process is not implemented yet.',
    '',
    'tools/process-assets.ts is a scaffold stub owned by the asset-pipeline',
    'workstream. It must produce IAssetOutput entries per QualityTier.',
  ].join('\n')
);
process.exit(1);
