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

|                                                               | State                                                                                                    |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Engine, physics, world, characters, combat, VFX, audio, input | implemented, each with its own harness under [`harness/`](harness/)                                      |
| `src/main.ts`                                                 | the real entry point — hands off to `src/game/`, the composition root that wires every system            |
| `npm run dev`                                                 | serves the game; boots to City Z in ~4.8 s                                                               |
| `npm run assets`                                              | works — fetches 1.65 GB and encodes it; a warm re-run is a ~0.6 s no-op                                  |
| Android APK                                                   | builds; a 118 MB debug APK has been produced from this tree                                              |
| iOS                                                           | runs in Safari today via Add to Home Screen; the Xcode project generates here but needs macOS to compile |
| Frame rate                                                    | **never measured on real hardware** — see [Performance](#performance-what-is-measured-and-what-is-not)   |

To see a system working today, run its harness rather than the game: `npx vite`
and open `/harness/city.html` (or `combat`, `crowd`, `physics`, `renderer`,
`streaming`, `vfx`, `audio`, `input`, `player`, `progression`, `spatial`,
`anim`, `humanoid`, `roster`). The matching `npx tsx harness/<name>.verify.ts`
drives the same page headlessly and writes its evidence to `docs/screenshots/`.

---

## Setup

```bash
npm install          # Node >= 22.12
npm run assets       # fetch + process the CC0 asset set  (~10-25 min, once)
npm run dev          # http://localhost:5173
```

### Running it on a phone

`localhost` is not reachable from your phone. Both commands below print a
`Network:` URL — an address on your LAN like `http://192.168.1.42:5173`. Use
that one, with the phone on the same Wi-Fi.

```bash
npm run dev -- --host            # dev server, fastest way onto a device
# or, the optimised build:
npx tsx scripts/build-web.ts     # prunes 262 MB -> 135 MB, one asset tier
npx serve -s dist
```

**iOS**: open the `Network:` URL in **Safari** — not Chrome or Firefox, which
use the same engine on iOS but cannot install to the home screen — then
**Share → Add to Home Screen**. That gives a fullscreen app with an icon and no
browser chrome. It works because iOS 15+ Safari has WebGL2 and Apple GPUs
support ASTC, one of the transcode targets the KTX2 pipeline already emits.
Verified booting at a 390×844 viewport: `__GAME_READY__` true, 0 HTTP 404s, 0
console errors. Frame rate on a real device remains unmeasured.

A **native** iOS app needs macOS:

```bash
npm i @capacitor/ios && npx tsx scripts/build-web.ts && npx cap add ios
```

generates and structurally validates `ios/App/App.xcodeproj` (bundle
`com.saitama.onepunch`, deployment target 15.0) on any platform — but only
Xcode on a Mac can compile and sign it. A free Apple ID sideloads for 7 days;
a paid account for a year.

If a firewall blocks the port, macOS and Windows both prompt on first run —
allow it, or the phone just times out.

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

| Command                               | What it does                                                       |
| ------------------------------------- | ------------------------------------------------------------------ |
| `npm run build`                       | production web build into `dist/`                                  |
| `npm test`                            | Vitest unit tests                                                  |
| `npm run typecheck`                   | `tsc --noEmit`, strict                                             |
| `npm run lint`                        | ESLint over the whole tree                                         |
| `npm run guard`                       | refuse tracked binaries and files over 5 MB                        |
| `npm run verify`                      | build, serve, drive headless Chromium, prove a real frame rendered |
| `npx tsx verification/soak.verify.ts` | drive the whole game 1800 frames; zero errors, loop still drawing  |
| `npx tsx tools/attribution.ts`        | regenerate `ATTRIBUTION.md` from the manifests                     |

---

## Known issues

**The game used to stop rendering a few seconds after boot; it is fixed.**
`THREE.InstancedMesh.updateMorphTargets()` is an empty override in three r185 —
per-instance morph state is meant to live in `morphTexture` — so an
`InstancedMesh` never allocates `morphTargetInfluences`. But
`WebGLRenderer.setProgram` decides to touch morph state from the GEOMETRY
alone, and `WebGLMorphtargets.update` then reads
`object.morphTargetInfluences.length`. Two prop GLBs
(`model.prop.rusted_wheel_rim_01` / `_02`) carry a one-target blend shape from
their source asset, and street furniture is instanced — so from the moment the
background prop load attached one, every frame threw
`Cannot read properties of undefined (reading 'length')` out of
`renderBufferDirect` inside the shadow pass, `renderer.info` froze mid-frame,
and nothing was presented again. `instanceableGeometry()` in
`src/world/city/runtime.ts` now drops morph attributes at the point of
instancing. It survived every earlier check because every check sampled only
the first seconds of a session; `verification/soak.verify.ts` is the run that
would have caught it.

**`npm run assets` used to fail on a fresh clone; it is fixed.**
`loadSourceManifests()` (`tools/lib/manifest.ts`) globbed every
`tools/manifest/*.json` and validated each against the _third-party
source-entry_ schema. `characters.json` describes first-party generated
characters and is deliberately a different shape, so the load aborted with 46
validation errors and took the whole pipeline down with it. It now uses the
`MANIFEST_FILES` list that already named exactly the three source manifests.

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
