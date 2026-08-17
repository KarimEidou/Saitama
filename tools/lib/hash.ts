/**
 * STREAMING HASHES
 *
 * sha256 and md5 over files that do not fit in memory. A 4K PBR material is
 * ~40 MB and the full cold fetch is ~1.7 GB, so nothing here ever calls
 * readFileSync.
 *
 * Both digests are computed in ONE pass: md5 is what the provider publishes
 * (so it is what proves the download is intact), sha256 is what the lockfile
 * records (so it is what proves the build is reproducible). Reading a 40 MB
 * file twice to get two digests would be pure waste.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';

/** Both digests of a byte stream, computed in a single pass. */
export interface IDigests {
  readonly sha256: string;
  readonly md5: string;
  readonly bytes: number;
}

/** sha256 + md5 + length of a file on disk, streamed. */
export async function hashFile(filePath: string): Promise<IDigests> {
  const sha = createHash('sha256');
  const md5 = createHash('md5');
  let bytes = 0;

  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      sha.update(chunk);
      md5.update(chunk);
      bytes += chunk.length;
      cb();
    },
  });

  await pipeline(createReadStream(filePath, { highWaterMark: 1 << 20 }), sink);
  return { sha256: sha.digest('hex'), md5: md5.digest('hex'), bytes };
}

/** sha256 of an in-memory value. Used for small things: strings, JSON. */
export function sha256Of(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** md5 of an in-memory value. */
export function md5Of(data: string | Buffer): string {
  return createHash('md5').update(data).digest('hex');
}

/**
 * Digest of a MULTI-FILE asset.
 *
 * A material is three JPEGs and a glTF model is a document plus a .bin plus
 * textures, so there is no single "the file" to hash. This folds the members
 * into one stable id: sort by path, join `"<sha256>  <path>"` lines with
 * newlines (the `sha256sum` format, deliberately), and sha256 that.
 *
 * Sorting by path makes it independent of fetch order and of the order files
 * happen to appear in the manifest, so two machines that download the same
 * bytes always agree.
 */
export function entryDigest(members: readonly { sha256: string; path: string }[]): string {
  const lines = [...members]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((m) => `${m.sha256}  ${m.path}`);
  return sha256Of(lines.join('\n'));
}
