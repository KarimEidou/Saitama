# Architecture

How this codebase is put together, and — more usefully — why it is put together
that way. The short version fits in a box:

> **Systems import only from `src/types/` and `src/util/`. A system never
> imports another system's implementation. All cross-system communication goes
> over the event bus.**

Everything below is a consequence of that rule.

---

## 1. Why the rule exists

This project was built by seventeen workstreams running in parallel. Parallel
work on a shared codebase fails in one specific way: two people reach for the
same seam at the same time, and merging their assumptions costs more than the
work did. The usual mitigations — code review, careful ownership, "just talk to
each other" — scale badly and depend on everyone being available at once.

The alternative is to make the seams unusable. If a system _cannot_ import
another system, it cannot depend on that system's internals, cannot be broken by
a refactor inside it, and cannot block on it being finished. What it can do is
depend on a contract that was agreed before either of them existed.

That produces three properties worth having long after the parallel build is
over:

- **Any system is removable.** Delete `src/vfx/` and nothing fails to compile;
  the events it subscribed to simply have one fewer listener.
- **Any system is testable alone.** A harness constructs a bus, the system under
  test, and nothing else.
- **The whole frame is recordable.** Because events carry plain data rather than
  object references, the bus can be serialised, replayed, and diffed.

## 2. The two legal imports

### `src/types/` — the contract layer

Every interface, every event, every payload. It is **type-only**: every file is
re-exported with `export type *`, so the entire barrel erases at build time and
costs nothing at runtime. That is what made it safe to freeze the contracts
before any implementation existed — an early commitment with no runtime price.

The barrel documents symbol ownership explicitly, because the failure mode of a
big shared type layer is two people defining `ILODLevel` to mean two different
things. Each name has exactly one home:

| Symbol                                                         | Defined in       |
| -------------------------------------------------------------- | ---------------- |
| `IRenderer`, `RenderStats`, `MaterialSpec`                     | `render.ts`      |
| `ThreatTier`, `LethalIntent`, `HitInfo`, `IDamageable`         | `combat.ts`      |
| `IDestructible`, `FractureChunk`                               | `destruction.ts` |
| `ClipName`, `BoneName`, `BodyProfile`                          | `character.ts`   |
| `HeroClass`, `QuestState`, `DayPhase`, `IHeroRank`             | `gameplay.ts`    |
| `ILODLevel` (a render-distance band)                           | `world.ts`       |
| `IAssetLOD` (a decimated mesh variant)                         | `assets.ts`      |
| `IQualityTier` (`low`/`medium`/`high`, a runtime setting)      | `engine.ts`      |
| `QualityTier` (`mobile`/`high`/`ultra`, an asset build target) | `assets.ts`      |

The last two pairs are the ones that actually bit: two different meanings of
"LOD" and two different meanings of "quality tier", each legitimate in its own
domain. Naming them apart in one place was cheaper than discovering the
confusion at integration.

### `src/util/` — shared runtime

Real code, but dependency-free: seeded RNG, math, ring buffers, logging, and the
concrete `EventBus`. Anything here must be safe for every system to use, which
in practice means it may not import a system, and it may not import `three`.

## 3. The event bus

`src/util/event-bus.ts` implements `IEventBus` from `src/types/events.ts`. Its
guarantees are load-bearing enough to list:

1. **Synchronous dispatch.** Handlers run before `emit()` returns. No deferred
   queue means no "which frame did this land in?" debugging.
2. **Handler isolation.** A throwing handler is caught and logged. One system's
   bug cannot kill the frame or starve its siblings.
3. **Mutation safety.** Subscribing or unsubscribing during dispatch is legal
   and takes effect on the next emit; the bus iterates a snapshot.
4. **Vector copying.** `Vec3`-shaped payload fields are copied on emit, so
   callers may pass a reused scratch `THREE.Vector3` without handlers later
   observing it mutated.
5. **Stable ordering.** Handlers run in subscription order.

### Payloads carry data, never references

An event says `{ entityId: 42 }`, not `{ entity: theActualObject }`. This is a
deliberate constraint with three payoffs: the bus can be recorded and replayed
deterministically, handlers cannot accidentally retain despawned entities, and
events stay cheap to log. If a handler needs the live object it looks it up
through `IEntitySpawner`.

### The vocabulary

Eighteen event types, and the set is small on purpose — an event bus with a
hundred message types has just re-invented direct calls with worse tooling.

| Domain      | Events                                                              |
| ----------- | ------------------------------------------------------------------- |
| Combat      | `ShockwaveFired`, `EntityDamaged`, `EntityKilled`, `ImpulseApplied` |
| Destruction | `ChunkDetached`                                                     |
| Stakes      | `CivilianSaved`, `CivilianLost`, `AllyDowned`                       |
| Encounters  | `EncounterStarted`, `EncounterEnded`, `BossPhaseChanged`            |
| Progression | `QuestStateChanged`, `RankChanged`, `BoredomChanged`                |
| World       | `ChunkStreamedIn`, `ChunkStreamedOut`, `TimeOfDayChanged`           |
| Player      | `PlayerLanded`                                                      |

A worked example of the rule in practice: a serious punch emits
`ShockwaveFired`. VFX draws the cone, audio synthesises the boom, the camera
shakes, destruction fractures whatever the cone crosses, and progression starts
totting up the collateral. Combat knows about none of them.

## 4. The wave structure

Workstreams were sequenced into waves, where a wave may depend only on contracts
an earlier wave has already frozen.

**Wave 0 — contracts.** `src/types/`, written and agreed first. Zero runtime
footprint, so the commitment was free.

**Wave 1 — foundations.** Systems that depend on the contracts and on nothing
else: the asset pipeline, the renderer, the physics wrapper, the spatial index,
input, and the character mesh generator.

**Wave 2 — systems.** City generation, world streaming, day/night, animation,
audio synthesis, VFX, crowd, combat, progression. These consume the foundations
through their contracts and reach each other only over the bus.

**Wave 3 — integration and evidence.** Per-system harnesses, headless
verification, APK packaging, licensing and documentation.

Each workstream owns exactly one directory, and promotion into `src/types/` is
the only sanctioned way to share something new.

## 5. The map

| Directory                   | Owns                                                              |
| --------------------------- | ----------------------------------------------------------------- |
| `src/types/`                | interface contracts; type-only                                    |
| `src/util/`                 | event bus, RNG, math, logging                                     |
| `src/engine/`               | WebGL2 renderer, materials, shadows, IBL/SH9, hit-stop            |
| `src/engine/post/`          | tier-gated post-processing chains                                 |
| `src/world/city/`           | procedural City Z: districts, blocks, pre-fractured buildings     |
| `src/world/streaming/`      | chunk streaming, LOD rings, worker pool, damage persistence       |
| `src/world/sky/`            | day/night clock, HDRI blending, exposure normalisation            |
| `src/spatial/`              | quadtree, PVS, frustum culling, entity grid, ground BVH           |
| `src/physics/`              | Rapier wrapper: controller, ragdolls, debris, impulse propagation |
| `src/characters/mesh/`      | procedural humanoid geometry, 27-bone skeleton                    |
| `src/characters/roster/`    | surfaces, faces, atlas baking, the cast list                      |
| `src/characters/anim/`      | locomotion, clips, IK, VAT baking                                 |
| `src/entities/player/`      | locomotion feel, third-person camera rig                          |
| `src/entities/npc/`         | civilians, panic propagation, allies                              |
| `src/entities/monster/`     | threat state machine and monster types                            |
| `src/gameplay/combat/`      | one-punch resolution, serious-punch cone, encounters              |
| `src/gameplay/progression/` | rank, quests, witnesses, collateral                               |
| `src/vfx/`                  | shockwaves, particles, decals, speedlines, camera shake           |
| `src/audio/`                | every sound, synthesised at runtime                               |
| `src/ui/input/`             | touch, keyboard, gamepad, synthetic                               |
| `tools/`                    | asset pipeline and generators                                     |
| `harness/`                  | one page per system, plus the headless drivers                    |

`src/assets/` and `src/ui/hud/` are placeholders and currently empty.

## 6. The world, in numbers

| Constant                     | Value                             | Where                                 |
| ---------------------------- | --------------------------------- | ------------------------------------- |
| World size                   | 1536 m square                     | `src/spatial/constants.ts`            |
| Chunk size                   | 96 m                              | `src/spatial/constants.ts`            |
| Chunk grid                   | 16 × 16 = 256 chunks              | `src/spatial/constants.ts`            |
| Quadtree                     | depth 6, 24 m leaves              | `src/spatial/`                        |
| Precomputed visibility table | 8 KB total                        | `src/spatial/`                        |
| Persistent destruction state | 8 KB bitmask                      | `src/world/streaming/damage-state.ts` |
| Skeleton                     | 27 bones, Mixamo-compatible names | `src/characters/mesh/rig.ts`          |
| Streaming workers            | 2                                 | `src/world/streaming/worker-pool.ts`  |

## 7. Design decisions worth knowing before changing things

**Rank does not move on kills.** `POINTS_PER_KILL` is 0 and that is deliberate:
the protagonist wins every fight instantly, so a kill counter measures nothing.
Rank moves on _witnessed_ saves and _reported_ collateral, and the asymmetry —
credit needs an audience, blame does not — is the design.

**The crowd is the stakes.** The player cannot be hurt. That is the premise, not
a balance bug, and a premise like that leaves a game with nothing to lose unless
something else can be lost. `src/entities/npc/` exists to be that something.

**Bosses die in one hit too.** A boss's phases are a narrative gate, never an HP
gate. Combat carries a `LethalIntent` flag, not a damage number.

**Audio has no files.** Every sound is synthesised (`src/audio/`). This buys
continuously adaptive audio — threat tier, material, debris count and crowd
density are synthesis parameters rather than a crossfade between fixed
recordings — and it removes the entire audio licensing surface. See
[`../ATTRIBUTION.md`](../ATTRIBUTION.md).

**Nothing outside `src/physics/` imports Rapier**, and `initPhysics()` is the
only thing that pulls in the 2.8 MB wasm chunk, behind a dynamic import so the
first frame never waits on it.

## 8. Verification

Each system has a page under `harness/` and, for most, a `*.verify.ts` driver
that runs it headlessly and writes evidence into `docs/screenshots/`.

`npm run verify` builds, serves, launches Chromium and proves a real frame
rendered — reading the pixels back and rejecting a blank, uniform or flat-black
frame. A WebGL page that throws still "loads" and still screenshots, so
`__GAME_READY__` alone is not evidence.

**All of it runs on SwiftShader, a CPU software rasteriser.** Every harness
therefore refuses to report a frame rate, and every budget in this project is a
_counted_ one — draw calls, triangles, bytes, programs, main-thread
milliseconds. See the performance section of [`../README.md`](../README.md).

## 9. Current state

`src/main.ts` is still the scaffold's temporary bootstrap: it proves the
toolchain end to end and wires up none of the systems above. The integration
bootstrap that replaces it has not landed. To see a system working, run its
harness.
