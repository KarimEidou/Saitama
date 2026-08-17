# One Punch Man — open-world mobile game

A non-commercial fan project: an open-world City Z built for phones, in WebGL2
and Three.js, packaged for Android with Capacitor.

> **This is a fan project and nothing else.** One Punch Man is created by ONE,
> illustrated by Yusuke Murata and published by Shueisha; the anime is produced
> by Madhouse and J.C.Staff. This project is **unaffiliated with all of them,
> not endorsed or approved by any of them, and is not for sale or commercial
> distribution.**
>
> **No copyrighted One Punch Man material is included here** — no artwork, no
> models, no audio, no music, no fonts, no logos, no screen captures, no text
> from the manga or anime. Character names and the hero-ranking premise are used
> referentially. Every character and monster in the game is **original geometry
> generated procedurally by code in this repository**, and
> [`ATTRIBUTION.md`](ATTRIBUTION.md) proves it with nine mechanical checks
> rather than a promise.

Everything else that ships is CC0 or generated: 82 public-domain Poly Haven
assets, two procedurally generated materials, fourteen generated characters, and
zero audio files — every sound is synthesised at runtime by the Web Audio API.

---

## Status — read this before running anything

The systems are built and individually verified. **They are not yet assembled
into a playable game.**

|                                                               | State                                                                                                                              |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Engine, physics, world, characters, combat, VFX, audio, input | implemented, each with its own harness under [`harness/`](harness/)                                                                |
| `src/main.ts`                                                 | still the scaffold's **temporary bootstrap** — a spinning-primitive scene that proves the toolchain, wiring up none of the systems |
| `npm run dev`                                                 | serves that bootstrap scene, not the game                                                                                          |
| `npm run assets`                                              | **currently fails** — see [Known issues](#known-issues)                                                                            |
| Android APK                                                   | builds; a 118 MB debug APK has been produced from this tree                                                                        |
| Frame rate                                                    | **never measured on real hardware** — see [Performance](#performance-what-is-measured-and-what-is-not)                             |

To see a system working today, run its harness rather than the game: `npx vite`
and open `/harness/city.html` (or `combat`, `crowd`, `physics`, `renderer`,
`streaming`, `vfx`, `audio`, `input`, `player`, `progression`, `spatial`,
`anim`, `humanoid`, `roster`). The matching `npx tsx harness/<name>.verify.ts`
drives the same page headlessly and writes its evidence to `docs/screenshots/`.

---

## Setup

```bash
npm install          # Node >= 22.12
npm run assets       # fetch + process the CC0 asset set  (see the caveat below)
npm run dev          # http://localhost:5173
```

`npm run assets` is two stages:

- **`assets:fetch`** downloads **1.65 GB** across **376 files** from Poly Haven
  into a content-addressed store under `assets/source/` (gitignored). Every file
  is verified against the provider-published md5 and recorded in the committed
  [`assets/assets.lock.json`](assets/assets.lock.json) with a sha256.
- **`assets:process`** transcodes that into the GPU-native build under
  `public/assets/` — KTX2 textures, Draco/meshopt GLB meshes, SH9-baked
  environments. Roughly **6 minutes for the mobile tier** on the build machine;
  a **warm re-run is a sub-second no-op**, because every output is keyed by a
  content hash of its inputs and encoder flags.

Both stages are re-runnable and idempotent. Neither downloaded nor generated
assets are committed — `npm run guard` rejects any tracked binary outside
`docs/screenshots/`.

Other scripts:

| Command                        | What it does                                                       |
| ------------------------------ | ------------------------------------------------------------------ |
| `npm run build`                | production web build into `dist/`                                  |
| `npm test`                     | Vitest unit tests                                                  |
| `npm run typecheck`            | `tsc --noEmit`, strict                                             |
| `npm run lint`                 | ESLint over the whole tree                                         |
| `npm run guard`                | refuse tracked binaries and files over 5 MB                        |
| `npm run verify`               | build, serve, drive headless Chromium, prove a real frame rendered |
| `npx tsx tools/attribution.ts` | regenerate `ATTRIBUTION.md` from the manifests                     |

---

## Known issues

**`npm run assets` does not work on a fresh clone.** `loadSourceManifests()`
(`tools/lib/manifest.ts`) globs every `tools/manifest/*.json` and validates each
one against the _third-party source-entry_ schema. `tools/manifest/characters.json`
is a character manifest with a deliberately different shape, so the load aborts
with 46 validation errors:

```
$ npx tsx tools/fetch-assets.ts --dry-run
  ✗ manifest validation failed with 46 problem(s):
  - chr.saitama: providerAssetId is required
  - chr.saitama: tags must be an array
  …
```

Consequences:

- `assets:fetch` exits 1 and downloads nothing.
- `assets:process` still builds textures and environments — those read the
  already-resolved `assets/source/manifest.resolved.json` — but the **model
  stage fails**, because `tools/process-models.ts` calls the same loader.

The fix is one of: teach the loader to skip non-source manifests, restrict it to
`MANIFEST_FILES` (which already exists in that file and lists exactly the three
source manifests), or move `characters.json` out of `tools/manifest/`. This is
in another workstream's files, so it is reported here rather than patched.

Also worth knowing:

- `ffmpeg-static` is a declared devDependency that no code references. It is
  GPL-3.0-or-later, which is the one licence family this project's asset policy
  rules out; it is build-only and never distributed, so nothing is currently
  wrong, but the clean answer is to drop the dependency.
- `@fontsource/inter` and `@fontsource/bebas-neue` are declared and referenced by
  family name in CSS, but no module imports their stylesheets, so no font binary
  reaches the bundle and the UI falls back to `system-ui`.
- `src/assets/` and `src/ui/hud/` are empty placeholders.

---

## Architecture

### The one rule

> **Systems import only from `src/types/` and `src/util/`. A system never
> imports another system's implementation. All cross-system communication goes
> over the event bus.**

`src/types/` is type-only and erases completely at build time; `src/util/` is
dependency-free runtime code (event bus, RNG, math, logging). Concretely: the
destruction system does not import the quest system to tell it a building fell —
it emits `ChunkDetached`, and the quest system subscribes.

This is what let seventeen workstreams be built in parallel without colliding,
and it is what keeps any single system removable. Event payloads carry ids and
plain data, never live entity references, so the bus can be recorded and
replayed for deterministic tests.

### The wave structure

The codebase was built by parallel workstreams organised into waves, where a
wave may only depend on contracts that an earlier wave has already frozen:

1. **Contracts.** `src/types/` — every interface, every event, every payload,
   written and agreed before any implementation existed. Nothing in here has a
   runtime footprint, so committing to it early cost nothing and bought
   everything.
2. **Foundations.** The asset pipeline, renderer, physics wrapper, spatial
   index, input, and the character mesh generator — each against the contracts
   only, none aware of the others.
3. **Systems.** City generation, world streaming, day/night, animation, audio
   synthesis, VFX, crowd, combat, progression — built on the foundations,
   talking to each other exclusively through the bus.
4. **Integration and evidence.** Per-system harnesses, headless verification,
   APK packaging, licensing and documentation.

Each workstream owns exactly one directory. Anything shared is promoted into
`src/types/` first, which is why that barrel documents symbol ownership file by
file: each name is defined in exactly one place and imported everywhere else.

### Where each system lives

| Directory                   | Owns                                                                             |
| --------------------------- | -------------------------------------------------------------------------------- |
| `src/types/`                | every interface contract; type-only, no runtime cost                             |
| `src/util/`                 | event bus, seeded RNG, math, logging — the only other legal import               |
| `src/engine/`               | WebGL2 renderer, material library, shadows, IBL/SH9, post-processing, hit-stop   |
| `src/engine/post/`          | tier-gated post chains (bloom in three shader programs)                          |
| `src/world/city/`           | procedural City Z: districts, blocks, buildings, pre-fractured geometry          |
| `src/world/streaming/`      | chunk streaming, LOD rings, worker pool, damage persistence, impostor ring       |
| `src/world/sky/`            | day/night clock, HDRI blending, exposure normalisation                           |
| `src/spatial/`              | quadtree, precomputed visibility, frustum culling, entity grid, ground BVH       |
| `src/physics/`              | Rapier wrapper: character controller, ragdolls, debris pool, impulse propagation |
| `src/characters/mesh/`      | procedural humanoid geometry and the 27-bone skeleton                            |
| `src/characters/roster/`    | surfaces, faces, texture-atlas baking, the cast list                             |
| `src/characters/anim/`      | locomotion, clip library, IK, VAT baking for crowds                              |
| `src/entities/player/`      | locomotion feel and the third-person camera rig                                  |
| `src/entities/npc/`         | civilians, panic propagation, the allies who can actually lose                   |
| `src/entities/monster/`     | threat state machine and monster types                                           |
| `src/gameplay/combat/`      | one-punch resolution, the serious-punch cone, encounter results                  |
| `src/gameplay/progression/` | hero rank on witnessed saves and reported collateral                             |
| `src/vfx/`                  | shockwaves, particles, ground decals, speedlines, camera shake                   |
| `src/audio/`                | the entire soundtrack and every sound effect, synthesised at runtime             |
| `src/ui/input/`             | touch, keyboard, gamepad and synthetic input behind one `InputState`             |
| `tools/`                    | the asset pipeline and this project's own generators                             |
| `harness/`                  | one page per system, plus the headless driver that captures its evidence         |

### Asset pipeline

Manifest → fetch → process → runtime, documented in
[`docs/asset-pipeline.md`](docs/asset-pipeline.md). The short version: three
committed manifests declare every third-party asset with a per-file md5; the
fetcher downloads into a content-addressed store and writes a lockfile; the
processor transcodes to KTX2/GLB in three quality tiers with a content-hash skip
cache; the runtime loads one `assets.runtime.json` index.

---

## Platforms

**Web.** The primary target. `npm run build` produces `dist/`. WebGL2 is
required. The Three.js chunk is 522 KB raw / 129 KB gzipped.

**Android.** Capacitor packages the web build into an APK that loads assets from
the bundle and renders in the system WebView.

```bash
npx tsx scripts/android-sdk.ts        # provision the SDK (idempotent, sibling dir)
npm run build && npx cap add android  # android/ is generated, not committed
npx tsx scripts/build-apk.ts          # -> android/app/build/outputs/apk/debug/
```

`build-apk.ts` prunes every non-mobile asset tier out of the Capacitor copy
before Gradle runs; without that the APK is ~296 MB, over Google Play's base
limit. A debug APK built from this tree is **118 MB**. Running
`scripts/android-sdk.ts` accepts Google's Android SDK licence terms on your
behalf — read them first.

**iOS. Cannot be built here.** An iOS Capacitor project can be generated on any
platform, but compiling it requires **macOS with Xcode** and Apple's toolchain.
This repository has never been built for iOS, and this environment cannot do it.
Treat iOS as untested.

---

## Performance: what is measured, and what is not

**No frame rate in this repository has been measured on real hardware.**

Every verification harness runs headless Chromium over **SwiftShader**, a CPU
software rasteriser. An fps number from that describes the build machine's CPU,
not a phone's GPU, so the harnesses deliberately refuse to report one. Where a
budget is quoted anywhere in this project, it is a **counted budget** — draw
calls, triangles, texture bytes, shader programs, main-thread milliseconds — not
a frame rate.

Examples of what _is_ real, from the committed harness reports in
`docs/screenshots/`:

| Counted                               | Measured value                                   |
| ------------------------------------- | ------------------------------------------------ |
| Street-level draw calls               | 185 rendered across 156 chunks / 2,283 buildings |
| Worst-case draw calls per city block  | 3                                                |
| Shader programs, low tier             | 14, against a budget of 24                       |
| Streaming: resident chunks after boot | 92, 2.9 MB resident, peak upload 13.7 ms/frame   |
| Precomputed visibility table          | 8 KB for the whole city                          |
| Mobile-tier texture payload           | 52.4 MiB materials + 9.7 MiB environments        |
| Mobile-tier mesh payload              | 24.2 MiB across 39 models                        |

Those numbers are the ones a phone's budget is actually spent against, and they
are reproducible. **What none of them tell you is whether the game holds 60 fps
on a mid-range Android device — that is unknown, and no claim is made about it.**

---

## Licences

- **Code and generated assets:** MIT — [`LICENSE`](LICENSE).
- **Downloaded assets:** CC0-1.0, all 82 of them, from Poly Haven. Every author
  is credited by name in [`ATTRIBUTION.md`](ATTRIBUTION.md) even though CC0 does
  not require it.
- **Dependencies:** every runtime package is permissively licensed. The only
  reciprocal-licensed packages in the tree are build tools that are never
  distributed; `ATTRIBUTION.md` lists all 41 and shows that none of them ships.
- **One Punch Man itself:** not licensed to this project and not included in it.
  See the notice at the top of this file and section 8 of `ATTRIBUTION.md`.

`ATTRIBUTION.md` is generated, never hand-written:

```bash
npx tsx tools/attribution.ts           # regenerate
npx tsx tools/attribution.ts --check   # CI gate: fail if it is out of date
```

It refuses to write the file if any asset lacks an author or a licence, if any
asset carries a licence the project cannot ship, or if the
zero-third-party-characters assertion stops holding.
