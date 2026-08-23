/**
 * APP ICONS
 *
 * Resizes ONE committed artwork master into every home-screen icon size the web
 * app and the Capacitor builds ask for, plus the web manifest that names them.
 *
 * The derived files stay build output — `public/icons/` is gitignored and this
 * script is the only writer — but the master is not. `npm run guard` rejects
 * tracked images everywhere except `docs/screenshots/` and `assets/icon/`, and
 * the second exemption exists for exactly this file: a painting cannot be
 * regenerated from a manifest the way `npm run assets` regenerates the game
 * binaries, so the one raster it starts from lives in git and the five sizes
 * derived from it do not. Run this before `npm run build` (or before
 * `cap sync`) and they land in public/icons/.
 *
 * iOS specifics that drive the master's shape:
 *   - Safari's "Add to Home Screen" uses `apple-touch-icon` at 180x180 and does
 *     NOT read the web manifest for it, so that file has to exist by name.
 *   - iOS applies its own rounded-rect mask and adds no background, so the art
 *     must be full-bleed and opaque or it composites onto black. The master is
 *     stored as a square with no rounded corners of its own for that reason —
 *     Android's adaptive mask and the manifest's `purpose: "any"` want the same
 *     square, and baking a second set of corners inside the platform's mask
 *     shows up as a dark ring around the icon on every device.
 *   - No transparency: an alpha channel on iOS renders as black, not as the
 *     wallpaper.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

/**
 * Repo root — this file lives in `scripts/`. Never `process.cwd()`: these are
 * build outputs of a specific checkout, not of whatever directory ran them. A
 * cwd-relative path writes a stray `public/icons` beside the caller while the
 * build reads the real one, with no error on either side.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'icons');

/**
 * The committed artwork, 1024x1024 and full-bleed. Every output below is a pure
 * downscale of it, so the icons cannot drift from what the repo ships.
 */
const MASTER = path.join(ROOT, 'assets', 'icon', 'icon-source.png');

/** Sizes iOS and Android actually ask for. 180 is the apple-touch-icon. */
const SIZES = [180, 192, 256, 384, 512] as const;

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });

  for (const size of SIZES) {
    const png = await sharp(MASTER)
      // `cover` + centre, not the default `fit`: a master that is ever replaced
      // with a non-square file must still yield a full-bleed square. `contain`
      // would letterbox it and hand the platform mask a bordered icon.
      .resize(size, size, { fit: 'cover', position: 'centre', kernel: 'lanczos3' })
      // flatten(): kill the alpha channel. iOS renders transparency as black.
      .flatten({ background: '#000000' })
      // adaptiveFiltering is off by default and worth 15-18% here: the source
      // is a painting, not the flat vector fills this script used to draw, and
      // per-row filter selection is what PNG has for gradients. Still lossless
      // — do NOT reach for `effort`, which silently turns on 256-colour palette
      // quantization and bands the dark vignette.
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
    const name = size === 180 ? 'apple-touch-icon.png' : `icon-${size}.png`;
    await writeFile(path.join(OUT, name), png);
    process.stdout.write(`  ${name.padEnd(24)} ${(png.length / 1024).toFixed(1)} KB\n`);
  }

  const manifest = {
    name: 'One Punch Man — City Z',
    short_name: 'One Punch Man',
    description:
      'An open-world City Z where the only question is how much of it you are willing to destroy.',
    start_url: './',
    scope: './',
    display: 'fullscreen',
    orientation: 'portrait',
    background_color: '#000000',
    theme_color: '#000000',
    icons: SIZES.filter((s) => s !== 180).map((s) => ({
      src: `./icons/icon-${s}.png`,
      sizes: `${s}x${s}`,
      type: 'image/png',
      purpose: 'any',
    })),
  };
  await writeFile(
    path.join(ROOT, 'public', 'manifest.webmanifest'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  process.stdout.write('  manifest.webmanifest\n');
}

void main().catch((error: unknown) => {
  // sharp names the missing input itself ("Input file is missing: <MASTER>"),
  // which is the only failure a caller is likely to hit, so this needs no
  // second path of its own.
  process.stderr.write(`icon generation failed: ${String(error)}\n`);
  process.exitCode = 1;
});
