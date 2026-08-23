/**
 * THE COMPLIANCE GATE'S PURE CORE
 *
 * `auditCharacters` is the function this project's licensing posture rests on,
 * `creditEntry` is what stops a copyleft asset shipping in the APK, and
 * `summariseTree` is what stops a copyleft transitive dependency doing the
 * same. All three are pure functions of their arguments, and until this file
 * existed all three were untested — the nine checks carrying the load-bearing
 * "no third-party character art" claim had no coverage at all.
 *
 * These assert PROPERTIES, not evidence strings: which checks pass, which
 * problems are raised and at what severity. The wording of `check.detail` is
 * prose that will be rewritten; a test pinning it would have to be deleted
 * rather than trusted.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  auditCharacters,
  byKey,
  cell,
  creditEntry,
  groupDigits,
  hostOf,
  licenseOf,
  link,
  parseArgs,
  plural,
  renderMarkdown,
  summariseTree,
  urlsIn,
  type IAttributionBlock,
  type ICharacterManifestFile,
  type ICreditedAsset,
  type IInputs,
  type ILockFile,
  type IPackageLock,
  type IProblem,
  type ISourceEntry,
  type ISourceManifestFile,
} from '../attribution.ts';

/* -------------------------------------------------------------------------- */
/* licenceOf                                                                  */
/* -------------------------------------------------------------------------- */

describe('licenseOf', () => {
  it.each([
    [{ license: 'MIT' }, 'MIT'],
    [{ license: '  ISC  ' }, 'ISC'],
    [{ license: { type: 'Apache-2.0' } }, 'Apache-2.0'],
    [{ licenses: [{ type: 'MIT' }, { type: 'ISC' }] }, 'MIT OR ISC'],
    [{ licenses: ['MIT'] }, 'MIT'],
    [{}, ''],
  ])('normalises %o to %p', (pkg, expected) => {
    expect(licenseOf(pkg)).toBe(expected);
  });
});

/* -------------------------------------------------------------------------- */
/* hostOf / urlsIn                                                            */
/* -------------------------------------------------------------------------- */

describe('hostOf', () => {
  it('reads the host out of a URL', () => {
    expect(hostOf('https://dl.polyhaven.org/f/x.jpg')).toBe('dl.polyhaven.org');
  });

  it('lower-cases, so a shouted URL cannot dodge the host allow-list', () => {
    expect(hostOf('HTTPS://DL.PolyHaven.ORG/x')).toBe('dl.polyhaven.org');
  });

  it('returns empty for something that is not a URL', () => {
    expect(hostOf('not a url')).toBe('');
  });
});

describe('urlsIn', () => {
  it('searches nested objects and arrays and de-duplicates', () => {
    expect(urlsIn({ a: 'https://x.test/a', b: ['https://x.test/a', 'https://y.test/b'] })).toEqual([
      'https://x.test/a',
      'https://y.test/b',
    ]);
  });

  it('stops at the JSON string boundary rather than running into the next key', () => {
    // If the match ran past the closing quote, check 3 would compare a host
    // that no manifest actually contains.
    expect(urlsIn({ a: 'https://x.test/a', b: 'plain' })).toEqual(['https://x.test/a']);
  });

  it('finds nothing in a value with no URLs', () => {
    expect(urlsIn({ a: 1, b: null })).toEqual([]);
    expect(urlsIn(undefined)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* cell / link / plural / byKey / groupDigits                                 */
/* -------------------------------------------------------------------------- */

describe('cell', () => {
  it('escapes the pipe so a value cannot break out of a table cell', () => {
    expect(cell('a|b')).toBe('a\\|b');
  });

  it('renders an absent or empty value as an em dash', () => {
    expect(cell(undefined)).toBe('—');
    expect(cell('')).toBe('—');
  });

  it('renders zero as "0", not as the em dash', () => {
    // The strict `=== ''` comparison is what makes this true; `!value` would
    // have printed a dash for every zero triangle count and byte total.
    expect(cell(0)).toBe('0');
  });

  it.each([
    ['a\r\nb', 'a b'],
    ['a\rb', 'a b'],
    ['a\nb', 'a b'],
  ])('flattens %j to %j', (input, expected) => {
    // A bare `\r` used to survive into the committed document.
    expect(cell(input)).toBe(expected);
  });
});

describe('link', () => {
  it('falls back to a plain cell with no destination', () => {
    expect(link('x', undefined)).toBe('x');
    expect(link('x', '')).toBe('x');
  });

  it('escapes the destination, not just the label', () => {
    const rendered = link('lbl', 'https://e.test/a(b)|c d');
    const destination = rendered.slice(rendered.indexOf('](') + 2, -1);
    expect(destination).toMatch(/^https:\/\/e\.test\/a%28b%29%7Cc%20d$/);
    // A raw `)` anywhere but the terminator would end the markdown link early.
    expect(rendered.slice(0, -1)).not.toContain(')');
  });
});

describe('plural', () => {
  it.each([
    [1, 'file', undefined, '1 file'],
    [0, 'file', undefined, '0 files'],
    [2, 'entry', 'entries', '2 entries'],
  ])('renders %i %s as %s', (n, one, many, expected) => {
    expect(many === undefined ? plural(n, one) : plural(n, one, many)).toBe(expected);
  });
});

describe('byKey', () => {
  it('sorts by code point, never by locale', () => {
    // `localeCompare` would give ['a','A','b','B'] — and a different answer on
    // a machine with a different locale, which is the whole objection.
    expect(['b', 'a', 'B', 'A'].sort(byKey((s: string) => s))).toEqual(['A', 'B', 'a', 'b']);
  });
});

describe('groupDigits', () => {
  it.each([0, 7, 999, 1000, 1234, 1234567, 1774041132])(
    'agrees with toLocaleString for %i',
    (n) => {
      expect(groupDigits(n)).toBe(n.toLocaleString('en-US'));
    }
  );
});

/* -------------------------------------------------------------------------- */
/* creditEntry                                                                */
/* -------------------------------------------------------------------------- */

/** Mutable mirrors of the tool's readonly input shapes, so cases can poke one field. */
interface MutableFileRow {
  url?: string;
  md5?: string;
  bytes?: number;
  path?: string;
}

interface MutableSourceEntry {
  id?: string;
  name?: string;
  provider?: string;
  providerAssetId?: string;
  attribution?: {
    license?: string;
    author?: string;
    sourceUrl?: string;
    attributionUrl?: string;
    year?: number;
  };
  sourceUrl?: string;
  notes?: string;
  files?: MutableFileRow[];
}

interface MutableLock {
  files: Record<string, { sha256?: string; md5?: string; bytes?: number }>;
  assets: Record<string, { provider?: string; kind?: string; bytes?: number; files?: string[] }>;
  totals?: { entries?: number; files?: number; bytes?: number };
}

const FILE_A = 'https://dl.polyhaven.org/file/rock_04.jpg';
const FILE_B = 'https://dl.polyhaven.org/file/rock_04_nor.jpg';

/** A polyhaven entry that satisfies every requirement, plus its lockfile rows. */
function goodCredit(): { entry: MutableSourceEntry; lock: MutableLock } {
  return {
    entry: {
      id: 'mat.rock',
      name: 'Rock 04',
      provider: 'polyhaven',
      providerAssetId: 'rock_04',
      attribution: {
        license: 'CC0-1.0',
        author: 'Rob Tuytel',
        sourceUrl: 'https://polyhaven.com/a/rock_04',
      },
      files: [
        { url: FILE_A, md5: 'aaaa', bytes: 100 },
        { url: FILE_B, md5: 'bbbb', bytes: 250 },
      ],
    },
    lock: {
      files: {
        [FILE_A]: { sha256: 'ssss', md5: 'aaaa', bytes: 100 },
        [FILE_B]: { sha256: 'tttt', md5: 'bbbb', bytes: 250 },
      },
      assets: { 'mat.rock': { provider: 'polyhaven', kind: 'texture' } },
    },
  };
}

/** Every error-severity message raised, joined so a regex can look across them. */
function errors(problems: readonly IProblem[]): string[] {
  return problems.filter((p) => p.severity === 'error').map((p) => p.message);
}

function credit(mutate: (fixture: ReturnType<typeof goodCredit>) => void): {
  asset: ICreditedAsset | null;
  problems: IProblem[];
} {
  const fixture = goodCredit();
  mutate(fixture);
  const problems: IProblem[] = [];
  const asset = creditEntry(fixture.entry as ISourceEntry, fixture.lock as ILockFile, problems);
  return { asset, problems };
}

describe('creditEntry', () => {
  it('accepts a well-formed third-party entry and totals its declared bytes', () => {
    const { asset, problems } = credit(() => {});
    expect(problems).toEqual([]);
    expect(asset).not.toBeNull();
    expect(asset?.bytes).toBe(350);
    expect(asset?.fileCount).toBe(2);
    expect(asset?.id).toBe('mat.rock');
  });

  it('rejects a reciprocal licence on a bundled asset', () => {
    const { problems } = credit((f) => {
      f.entry.attribution!.license = 'GPL-3.0-or-later';
    });
    expect(errors(problems).some((m) => /not permitted for a bundled asset/.test(m))).toBe(true);
  });

  it('rejects an SPDX id nobody reviewed', () => {
    const { problems } = credit((f) => {
      f.entry.attribution!.license = 'WTFPL';
    });
    expect(errors(problems).some((m) => /not a reviewed SPDX identifier/.test(m))).toBe(true);
  });

  it('requires a licence, an author and a source URL', () => {
    expect(
      errors(credit((f) => delete f.entry.attribution!.license).problems).some((m) =>
        /attribution\.license is missing/.test(m)
      )
    ).toBe(true);
    expect(
      errors(credit((f) => delete f.entry.attribution!.author).problems).some((m) =>
        /attribution\.author is missing/.test(m)
      )
    ).toBe(true);
    expect(
      errors(
        credit((f) => {
          delete f.entry.attribution!.sourceUrl;
          delete f.entry.sourceUrl;
        }).problems
      ).some((m) => /attribution\.sourceUrl is missing/.test(m))
    ).toBe(true);
  });

  it('gives up on an entry with no id', () => {
    const { asset, problems } = credit((f) => delete f.entry.id);
    expect(asset).toBeNull();
    expect(errors(problems).some((m) => /entry has no id/.test(m))).toBe(true);
  });

  it('requires an attributionUrl for a licence that requires attribution', () => {
    const { problems } = credit((f) => {
      f.entry.attribution!.license = 'CC-BY-4.0';
    });
    expect(errors(problems).some((m) => /requires attribution/.test(m))).toBe(true);
  });

  it('rejects a provider that is not in the catalogue', () => {
    const { problems } = credit((f) => {
      f.entry.provider = 'nowhere';
    });
    expect(errors(problems).some((m) => /unknown provider/.test(m))).toBe(true);
  });

  it('rejects a file served from a host this provider may not serve', () => {
    const { problems } = credit((f) => {
      f.entry.files = [{ url: 'https://evil.test/x.jpg', md5: 'aaaa', bytes: 100 }];
    });
    expect(errors(problems).some((m) => /not one this provider is allowed/.test(m))).toBe(true);
  });

  it('rejects a file with no lockfile record — a missing record is not a skip', () => {
    const { problems } = credit((f) => {
      delete f.lock.files[FILE_B];
    });
    expect(errors(problems).some((m) => /no assets\.lock\.json record/.test(m))).toBe(true);
  });

  it('rejects a third-party entry that downloads nothing', () => {
    const { problems } = credit((f) => {
      f.entry.files = [];
    });
    expect(errors(problems).some((m) => /declares no files/.test(m))).toBe(true);
  });

  it('rejects a first-party entry that declares downloadable files', () => {
    const { problems } = credit((f) => {
      f.entry.provider = 'procedural';
    });
    expect(errors(problems).some((m) => /first-party entry declares/.test(m))).toBe(true);
  });

  it('only WARNS about a first-party sourceUrl that is not this repository', () => {
    const { problems } = credit((f) => {
      f.entry.provider = 'procedural';
      f.entry.files = [];
      f.entry.attribution!.sourceUrl = 'https://example.test/x';
    });
    expect(errors(problems)).toEqual([]);
    expect(problems.some((p) => p.severity === 'warn' && /placeholder URL/.test(p.message))).toBe(
      true
    );
  });
});

/* -------------------------------------------------------------------------- */
/* summariseTree                                                              */
/* -------------------------------------------------------------------------- */

type Locked = NonNullable<IPackageLock['packages']>;

function tree(locked: Locked | undefined): {
  result: ReturnType<typeof summariseTree>;
  problems: IProblem[];
} {
  const problems: IProblem[] = [];
  return { result: summariseTree(locked, problems), problems };
}

describe('summariseTree', () => {
  it('counts a permissive runtime package with no complaint', () => {
    const { result, problems } = tree({ 'node_modules/a': { version: '1.0.0', license: 'MIT' } });
    expect(result.tree).toEqual([{ license: 'MIT', total: 1, runtime: 1, buildOnly: 0 }]);
    expect(result.copyleft).toEqual([]);
    expect(problems).toEqual([]);
  });

  it('errors on a reciprocal licence that ships', () => {
    const { result, problems } = tree({
      'node_modules/a': { version: '1.0.0', license: 'GPL-3.0-or-later' },
    });
    expect(result.copyleft).toEqual([
      { name: 'a@1.0.0', license: 'GPL-3.0-or-later', runtime: true },
    ]);
    expect(errors(problems).some((m) => /RUNTIME dependency/.test(m))).toBe(true);
  });

  it('records a build-only reciprocal licence without erroring', () => {
    const { result, problems } = tree({
      'node_modules/a': { version: '1.0.0', license: 'GPL-3.0-or-later', dev: true },
    });
    expect(result.copyleft).toHaveLength(1);
    expect(result.tree[0]).toEqual({
      license: 'GPL-3.0-or-later',
      total: 1,
      runtime: 0,
      buildOnly: 1,
    });
    expect(errors(problems)).toEqual([]);
  });

  it('finds a reciprocal term hiding inside a composite expression', () => {
    // The one case the expression splitter exists for. Without it,
    // "Apache-2.0 AND LGPL-3.0-or-later" reads as a single unknown id.
    const { result } = tree({
      'node_modules/a': {
        version: '1.0.0',
        license: 'Apache-2.0 AND LGPL-3.0-or-later',
        dev: true,
      },
    });
    expect(result.copyleft).toHaveLength(1);
    expect(result.copyleft[0]?.name).toBe('a@1.0.0');
  });

  it('records a nested package by its name, not its path', () => {
    const { result } = tree({
      'node_modules/x/node_modules/y': {
        version: '2.0.0',
        license: 'GPL-3.0-or-later',
        dev: true,
      },
    });
    expect(result.copyleft[0]?.name).toBe('y@2.0.0');
  });

  it('warns rather than throws when there is no lockfile', () => {
    const { result, problems } = tree(undefined);
    expect(result.tree).toEqual([]);
    expect(result.copyleft).toEqual([]);
    expect(problems).toEqual([
      {
        severity: 'warn',
        subject: 'package-lock.json',
        message: expect.stringContaining('missing') as unknown as string,
      },
    ]);
  });

  it('sorts rows by descending total', () => {
    const { result } = tree({
      'node_modules/a': { version: '1', license: 'Apache-2.0' },
      'node_modules/b': { version: '1', license: 'MIT' },
      'node_modules/c': { version: '1', license: 'MIT' },
      'node_modules/d': { version: '1', license: 'MIT' },
      'node_modules/e': { version: '1', license: 'ISC' },
      'node_modules/f': { version: '1', license: 'ISC' },
    });
    expect(result.tree.map((r) => [r.license, r.total])).toEqual([
      ['MIT', 3],
      ['ISC', 2],
      ['Apache-2.0', 1],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* auditCharacters                                                            */
/* -------------------------------------------------------------------------- */

interface MutableCharacterEntry {
  id?: string;
  name?: string;
  role?: string;
  triangles?: number;
  generator?: string;
  provider?: string;
  attribution?: {
    license?: string;
    author?: string;
    sourceUrl?: string;
  };
  sourceUrl?: string;
  files?: MutableFileRow[];
  cc0Textures?: string[];
}

interface MutableCharacters {
  thirdPartyCharacterAssets?: number;
  cc0Attribution: Record<string, IAttributionBlock>;
  entries: MutableCharacterEntry[];
}

interface MutableTextures {
  entries: { id?: string; attribution?: IAttributionBlock }[];
}

interface AuditFixture {
  characters: MutableCharacters;
  lock: MutableLock;
  textures: MutableTextures;
}

const REPO_URL = 'https://github.com/KarimEidou/Saitama';

/**
 * A roster that passes all nine checks. Every case below mutates ONE field of
 * a fresh copy, so a failure names exactly the field that caused it.
 */
function goodAudit(): AuditFixture {
  return {
    characters: {
      thirdPartyCharacterAssets: 0,
      cc0Attribution: {},
      entries: [
        {
          id: 'chr.test',
          name: 'Test',
          role: 'hero',
          triangles: 10,
          generator: 'tools/build-characters.ts',
          attribution: {
            license: 'MIT',
            author: 'Saitama project (procedural)',
            sourceUrl: REPO_URL,
          },
        },
      ],
    },
    lock: {
      files: { 'https://dl.polyhaven.org/file/rock_04.jpg': { sha256: 'ssss', md5: 'aaaa' } },
      assets: { 'mat.rock': { provider: 'polyhaven', kind: 'texture' } },
      totals: { entries: 1, files: 1, bytes: 100 },
    },
    textures: { entries: [] },
  };
}

function audit(mutate: (fixture: AuditFixture) => void = () => {}): {
  result: ReturnType<typeof auditCharacters>;
  problems: IProblem[];
  failed: string[];
} {
  const fixture = goodAudit();
  mutate(fixture);
  const problems: IProblem[] = [];
  const manifests = new Map<string, ISourceManifestFile>([
    ['textures.json', fixture.textures as ISourceManifestFile],
  ]);
  const result = auditCharacters(
    fixture.characters as ICharacterManifestFile,
    fixture.lock as ILockFile,
    manifests,
    problems
  );
  return { result, problems, failed: result.checks.filter((c) => !c.passed).map((c) => c.name) };
}

/** Which 1-based check numbers failed. */
function failedNumbers(result: ReturnType<typeof auditCharacters>): number[] {
  return result.checks.flatMap((c, i) => (c.passed ? [] : [i + 1]));
}

describe('auditCharacters', () => {
  it('passes all nine checks on a clean roster', () => {
    const { result, problems } = audit();
    expect(result.checks).toHaveLength(9);
    expect(failedNumbers(result)).toEqual([]);
    expect(result.thirdParty).toEqual([]);
    expect(errors(problems)).toEqual([]);
  });

  it('check 1 fails on a third-party provider', () => {
    const { result } = audit((f) => {
      f.characters.entries[0]!.provider = 'polyhaven';
    });
    expect(failedNumbers(result)).toContain(1);
    expect(result.thirdParty).toContain('chr.test');
  });

  it('check 1 still passes on a FIRST-party provider', () => {
    // The predicate allows one; only the evidence string reads as though it
    // does not. Assert the predicate.
    const { result } = audit((f) => {
      f.characters.entries[0]!.provider = 'procedural';
    });
    expect(failedNumbers(result)).not.toContain(1);
  });

  it('check 2 fails when a character declares a downloadable file', () => {
    const { result } = audit((f) => {
      f.characters.entries[0]!.files = [{ url: 'https://dl.polyhaven.org/x' }];
    });
    expect(failedNumbers(result)).toContain(2);
  });

  it.each([
    ['https://sketchfab.com/3d-models/x', 'sketchfab.com'],
    // A subdomain must be caught too, or the blocklist is a formality.
    ['https://cdn.mixamo.com/x', 'cdn.mixamo.com'],
  ])('check 3 fails on a marketplace URL (%s)', (url, host) => {
    const { result } = audit((f) => {
      f.characters.entries[0]!.attribution!.sourceUrl = url;
    });
    expect(failedNumbers(result)).toContain(3);
    expect(result.checks[2]?.detail).toContain(host);
  });

  it('check 4 fails when a character id appears in the download lockfile', () => {
    const { result } = audit((f) => {
      f.lock.assets['chr.saitama'] = {};
    });
    expect(failedNumbers(result)).toContain(4);
  });

  it('check 5 fails when the lockfile carries a character-kind entry', () => {
    const { result } = audit((f) => {
      f.lock.assets['mat.other'] = { kind: 'character' };
    });
    expect(failedNumbers(result)).toContain(5);
  });

  it('check 6 fails, and names the host, when a byte came from off the allow-list', () => {
    const { result } = audit((f) => {
      f.lock.files['https://evil.test/x'] = {};
    });
    expect(failedNumbers(result)).toContain(6);
    expect(result.checks[5]?.detail).toContain('evil.test');
  });

  describe('check 7 — reused CC0 maps resolve to a credited city material', () => {
    const attribution: IAttributionBlock = {
      license: 'CC0-1.0',
      author: 'Rob Tuytel',
      sourceUrl: 'https://polyhaven.com/a/rock_04',
    };

    it('passes when the credit and textures.json agree', () => {
      const { result } = audit((f) => {
        f.characters.entries[0]!.cc0Textures = ['mat.rock'];
        f.characters.cc0Attribution = { 'mat.rock': attribution };
        f.textures.entries = [{ id: 'mat.rock', attribution }];
      });
      expect(failedNumbers(result)).not.toContain(7);
    });

    it('fails when the two attributions differ by one field', () => {
      const { result } = audit((f) => {
        f.characters.entries[0]!.cc0Textures = ['mat.rock'];
        f.characters.cc0Attribution = { 'mat.rock': attribution };
        f.textures.entries = [
          { id: 'mat.rock', attribution: { ...attribution, author: 'Someone else' } },
        ];
      });
      expect(failedNumbers(result)).toContain(7);
      expect(result.checks[6]?.detail).toMatch(/disagrees with textures\.json/);
    });

    it('fails when there is no such material at all', () => {
      const { result } = audit((f) => {
        f.characters.entries[0]!.cc0Textures = ['mat.rock'];
        f.characters.cc0Attribution = { 'mat.rock': attribution };
        f.textures.entries = [];
      });
      expect(failedNumbers(result)).toContain(7);
      expect(result.checks[6]?.detail).toMatch(/no such material/);
    });

    it('fails when a map is used by the roster but absent from the credits', () => {
      const { result } = audit((f) => {
        f.characters.entries[0]!.cc0Textures = ['mat.rock'];
        f.textures.entries = [{ id: 'mat.rock', attribution }];
      });
      expect(failedNumbers(result)).toContain(7);
    });
  });

  it('check 8 fails when the manifest miscounts itself', () => {
    const { result } = audit((f) => {
      f.characters.thirdPartyCharacterAssets = 3;
    });
    expect(failedNumbers(result)).toContain(8);
  });

  it('check 9 fails when a character names no in-repo generator', () => {
    const { result } = audit((f) => {
      f.characters.entries[0]!.generator = 'blender';
    });
    expect(failedNumbers(result)).toContain(9);
  });

  it('raises an entry-scoped error for a character with no author', () => {
    const { problems } = audit((f) => {
      delete f.characters.entries[0]!.attribution!.author;
    });
    expect(
      problems.some(
        (p) =>
          p.severity === 'error' &&
          p.subject === 'chr.test' &&
          /attribution\.author is missing/.test(p.message)
      )
    ).toBe(true);
  });

  it('raises exactly one "characters" error per failed check', () => {
    // The `push` contract: a failed check must be visible as a problem, and a
    // passing one must never manufacture noise.
    const cases: ((fixture: AuditFixture) => void)[] = [
      (f) => {
        f.characters.entries[0]!.provider = 'polyhaven';
      },
      (f) => {
        f.characters.entries[0]!.files = [{ url: 'https://dl.polyhaven.org/x' }];
      },
      (f) => {
        f.characters.entries[0]!.attribution!.sourceUrl = 'https://sketchfab.com/3d-models/x';
      },
      (f) => {
        f.lock.assets['chr.saitama'] = {};
      },
      (f) => {
        f.lock.assets['mat.other'] = { kind: 'character' };
      },
      (f) => {
        f.lock.files['https://evil.test/x'] = {};
      },
      (f) => {
        f.characters.thirdPartyCharacterAssets = 3;
      },
      (f) => {
        f.characters.entries[0]!.generator = 'blender';
      },
      (f) => {
        f.characters.entries = [];
      },
    ];
    for (const mutate of cases) {
      const { result, problems } = audit(mutate);
      const onCharacters = problems.filter(
        (p) => p.severity === 'error' && p.subject === 'characters'
      );
      expect(onCharacters).toHaveLength(failedNumbers(result).length);
    }
  });

  it('fails rather than passing vacuously on an empty roster', () => {
    const { result } = audit((f) => {
      f.characters.entries = [];
    });
    // An empty list derived from an empty population is not evidence.
    expect(failedNumbers(result).length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* parseArgs                                                                  */
/* -------------------------------------------------------------------------- */

describe('parseArgs', () => {
  it('defaults to writing ATTRIBUTION.md', () => {
    const options = parseArgs([]);
    expect(options.check).toBe(false);
    expect(options.quiet).toBe(false);
    expect(options.help).toBe(false);
    expect(options.out.endsWith('ATTRIBUTION.md')).toBe(true);
  });

  it.each([['--check'], ['--verify']])('%s turns on the check gate', (flag) => {
    expect(parseArgs([flag]).check).toBe(true);
  });

  it.each([['--quiet'], ['-q']])('%s turns on quiet', (flag) => {
    expect(parseArgs([flag]).quiet).toBe(true);
  });

  it('resolves --out against the repository root', () => {
    const { out } = parseArgs(['--out', 'sub/x.md']);
    expect(path.isAbsolute(out)).toBe(true);
    expect(out.endsWith(path.join('sub', 'x.md'))).toBe(true);
  });

  it('throws on an unknown argument', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/);
  });
});

/* -------------------------------------------------------------------------- */
/* renderMarkdown                                                             */
/* -------------------------------------------------------------------------- */

function minimalReport(): Parameters<typeof renderMarkdown>[0] {
  const { result } = audit();
  const inputs: IInputs = {
    manifests: new Map(),
    characters: {},
    lock: { totals: { bytes: 1774041132, files: 376 } },
    pkg: {},
    lockedPackages: undefined,
    npm: [],
    tree: [],
    copyleftInTree: [],
    diagnostics: [],
  };
  return { credited: new Map(), characters: result, inputs, problems: [] };
}

describe('renderMarkdown', () => {
  it('is deterministic — same inputs, byte-identical output', () => {
    // The promise in the module header, and the only thing that makes `--check`
    // usable as a CI gate.
    const report = minimalReport();
    expect(renderMarkdown(report)).toBe(renderMarkdown(report));
  });

  it('ends in exactly one newline and never triple-spaces', () => {
    const markdown = renderMarkdown(minimalReport());
    expect(markdown.endsWith('\n')).toBe(true);
    expect(markdown.endsWith('\n\n')).toBe(false);
    expect(markdown).not.toContain('\n\n\n');
  });

  it('leaks no absolute path from the machine that generated it', () => {
    const markdown = renderMarkdown(minimalReport());
    expect(markdown).not.toContain(path.resolve(import.meta.dirname, '..', '..'));
  });

  it('groups the byte total without Intl', () => {
    expect(renderMarkdown(minimalReport())).toContain('1,774,041,132 bytes');
  });
});
