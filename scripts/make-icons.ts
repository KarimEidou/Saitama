/**
 * APP ICONS
 *
 * Generates the home-screen icons from an inline SVG. They are build output,
 * not source: `npm run guard` rejects any tracked PNG outside docs/screenshots,
 * and weakening that rule to store six icons would be a bad trade. Run this
 * before `npm run build` (or before `cap sync`) and they land in public/icons/.
 *
 * iOS specifics that drive the design:
 *   - Safari's "Add to Home Screen" uses `apple-touch-icon` at 180x180 and does
 *     NOT read the web manifest for it, so that file has to exist by name.
 *   - iOS applies its own rounded-rect mask and adds no background, so the art
 *     must be full-bleed and opaque or it composites onto black.
 *   - No transparency: an alpha channel on iOS renders as black, not as the
 *     wallpaper.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const OUT = path.resolve('public/icons');

/** Sizes iOS and Android actually ask for. 180 is the apple-touch-icon. */
const SIZES = [180, 192, 256, 384, 512] as const;

/**
 * Saitama reduced to the two shapes that survive at 40px on a home screen: the
 * bald head and the red glove. Anything with more detail turns to mush.
 */
function icon(size: number): Buffer {
  const s = size;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#F2C230"/>
  <circle cx="256" cy="150" r="16" fill="#FFFFFF" opacity="0.16"/>
  <!-- cape -->
  <path d="M256 236 L392 470 L120 470 Z" fill="#F7F3EA"/>
  <!-- head -->
  <ellipse cx="256" cy="196" rx="104" ry="118" fill="#F6DFC4"/>
  <!-- the deadpan: two dots and a flat line, nothing more -->
  <ellipse cx="218" cy="196" rx="15" ry="21" fill="#1A1A1A"/>
  <ellipse cx="294" cy="196" rx="15" ry="21" fill="#1A1A1A"/>
  <rect x="230" y="256" width="52" height="9" rx="4" fill="#C6836B"/>
  <!-- glove -->
  <circle cx="256" cy="404" r="66" fill="#C1272D"/>
  <circle cx="256" cy="404" r="66" fill="none" stroke="#8E1B20" stroke-width="10"/>
</svg>`);
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });

  for (const size of SIZES) {
    // flatten(): kill the alpha channel. iOS renders transparency as black.
    const png = await sharp(icon(size))
      .resize(size, size)
      .flatten({ background: '#F2C230' })
      .png({ compressionLevel: 9 })
      .toBuffer();
    const name = size === 180 ? 'apple-touch-icon.png' : `icon-${size}.png`;
    await writeFile(path.join(OUT, name), png);
    process.stdout.write(`  ${name.padEnd(24)} ${(png.length / 1024).toFixed(1)} KB\n`);
  }

  const manifest = {
    name: 'One Punch Man — City Z',
    short_name: 'One Punch Man',
    description: 'An open-world City Z where the only question is how much of it you are willing to destroy.',
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
    path.resolve('public/manifest.webmanifest'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  process.stdout.write('  manifest.webmanifest\n');
}

void main().catch((error: unknown) => {
  process.stderr.write(`icon generation failed: ${String(error)}\n`);
  process.exitCode = 1;
});
