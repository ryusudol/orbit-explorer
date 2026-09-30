# Orbit Explorer: an orbital digital twin

**Every tracked object in Earth orbit, propagated live in the browser, with Starlink laser-link routing, conjunction screening and coverage analysis. All of it is built from first principles and checked against published references.**

![Orbit Explorer: 19,887 objects, the Starlink laser mesh and a London → New York route](docs/media/hero.jpg)

<p align="center"><img src="docs/media/orbit.webp" width="420" alt="The laser mesh flowing over the Atlantic at 10 minutes per second while the London–New York route re-routes"><br><sub>10 min/s: satellites move, the mesh rebuilds and the London → New York path re-routes, four times a second.</sub></p>

A packet from London to New York over Starlink's lasers takes **~21 ms**. The best fibre possible, a straight cable along the great circle, takes **27.3 ms**. The twin computes that difference live from the satellites' real positions, and shows the path hop by hop.

| | What Orbit Explorer computes | How it is checked |
|---|---|---|
| **Orbits** | SGP4/SDP4 written from the model definition (Vallado et al. 2006), including deep-space resonance and every `sgp4fix`. TEME → ECEF → WGS-84 geodetic, Sun position, conical Earth-shadow model. | **666/666** Vallado verification states to **0.12 mm**, and the reference's 7 error cases reproduced. **83.6% bit-identical** to satellite.js across the live catalogue (worst 4 mm). The `sgp4` crate agrees to **0.7 µm**. Meeus 25.a Sun; published sunrise times to < 2 min. |
| **Laser links** | Shells and orbital planes recovered from mean elements by gap clustering; +Grid topology rebuilt every 250 ms; Dijkstra from ground terminal to ground terminal. | Synthetic Walker shells give exactly 2N links; path length equals the sum of its hops; a test proves the result is never shorter than the chord. |
| **Conjunctions** | All-vs-all screening with a spatial hash sized so no encounter between samples can be missed, a linear TCA estimate, then Newton refinement on full SGP4 states. | Identical results at 10, 20, 60 and 120 s steps (**44,179 encounters < 5 km over 24 h, every step size**). Grid == brute force, pair for pair. |
| **Coverage** | Visibility-cap stamping on a 2° grid (O(sats × cap) rather than O(sats × cells)). | Stamp == brute-force cell test on every cell; cap angle matches the textbook value. |

## Numbers

Apple M1, Chrome, 19,887 objects (CelesTrak snapshot, 30 Sep 2026).

| | |
|---|---|
| Render | **60 fps**, 3 ms of CPU per frame; interpolating all 19,887 positions takes **0.25 ms** |
| SGP4, all objects | **6.4 ms** native (323 ns/object) · **7 ms** per keyframe across 4 WASM workers |
| Keyframe interpolation error (cubic Hermite) | **1.0 m** worst case at 60 s spacing · 0.27 km at 300 s (1 h/s time warp) |
| Laser mesh rebuild | 10,766 linked satellites, 18,422 links in **2.8 ms** · Dijkstra **0.35 ms** |
| Conjunction sieve, one instant, pairs < 10 km | spatial hash **3.3 ms** vs all pairs **280 ms** (**85×**); **274×** at 100k objects · 57× in WASM |
| 24 h screen, whole catalogue, 5 km | **38 s** native (1,441 time steps, 257 M sieve pairs, 44,179 encounters) · 6 h in the browser: 20 s |
| Cold load to first interactive frame | **0.75 s** at 50 Mbps · **1.4 s** at 20 Mbps (production build, no CDN compression) |

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/benchmark-scaling-dark.svg">
  <img alt="Conjunction sieve scaling: spatial hash vs all pairs from 10k to 100k objects" src="docs/benchmark-scaling-light.svg">
</picture>

## Validation

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/validation/vallado-dark.svg">
  <img alt="SGP4 position error against the Vallado reference output, all 33 verification objects" src="docs/validation/vallado-light.svg">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/validation/satellitejs-dark.svg">
  <img alt="Distribution of differences between Orbit Explorer's SGP4 and satellite.js on the live catalogue" src="docs/validation/satellitejs-light.svg">
</picture>

What each test proves, and where it lives:

- `engine/tests/vallado.rs`: all 33 objects of the AIAA 2006-6753 verification set, 666 states, position error < 1e-6 km. The objects that decay or go hyperbolic must fail at exactly the step where the reference stops, with the same error codes `[1, 1, 6, 6, 4, 3, 6]`. (The reference `tcppver.out` prints the *previous* object's state when an object fails at t = 0; the harness detects and drops those stale rows.)
- `engine/tests/reference_crate.rs`: independent Rust implementation, AFSPC mode, 1,343 states.
- `web/src/engine.crosscheck.test.ts`: the compiled WASM against satellite.js on ~2,800 catalogue objects × 7 times (−1 d … +3 d).
- `engine/src/sun.rs`: Meeus example 25.a (RA/Dec to 0.02°); sunrise at London and New York on both solstices within 2 minutes of published tables.
- `engine/src/conjunction.rs`: the sieve must return identical encounters at 10 s and 60 s steps.
- `web/src/sim/keyframes.test.ts`: measures the interpolation error quoted above against exact SGP4.

## How it works

```
             daily GitHub Action
 CelesTrak ─────────────────────► catalog.bin  (1.15 MB: f64 epoch + mean motion, f32 angles, SoA)
                                       │
                               main thread (React + Three.js)
                                       │ decode
      ┌────────────────────────────────┼─────────────────────────────┐
      ▼                                ▼                             ▼
 4 × SGP4 worker                 analysis worker                conjunction worker
 (Rust → WASM)                   (Rust → WASM)                  (Rust → WASM)
 propagate slice ──► SharedArrayBuffer   Starlink subset:        whole catalogue, 60 s steps:
 Atomics.wait/notify, keyframes   │      +Grid graph, Dijkstra,  spatial hash → linear TCA →
 no messages per frame            │      coverage caps           Newton on SGP4 states
                                  ▼            │ 4 Hz                    │ streamed progress
                  render loop (SceneController, plain Three.js, WebGPU/TSL)
                  Hermite interpolation → camera-relative instances → bloom
                                  │ ~5 Hz summaries
                                  ▼
                        Zustand store → React HUD → D3 panels
```

**Simulation state never lives in React.** The render loop is a plain `SceneController` class that owns the renderer, the animation loop and the workers. React starts it from one `useEffect` and afterwards only reads summaries (clock, selected object, route latency, screening progress) that the scene publishes to a Zustand store about 5 times a second. Each D3 panel is a `<div>` React renders once and never touches again.

**SGP4 runs at 1–12 Hz, not per frame.** Four workers propagate their slice of the catalogue straight into a `SharedArrayBuffer` with four keyframe slots. The main thread requests a keyframe by writing a Julian date and bumping an `Int32` with `Atomics.notify`. Workers blocked in `Atomics.wait` wake up, propagate, and bump a done-counter. No `postMessage` happens per keyframe and nothing is copied. Each frame interpolates every object between two keyframes with a cubic Hermite spline on position and velocity, a 4th-order method whose measured error is quoted above. Keyframe spacing scales with time warp (1 s at real time, 300 s at 1 h/s). The **selected object is propagated exactly every frame**, and the routing and screening workers always use exact SGP4 states.

**Camera-relative rendering.** JavaScript numbers are already float64, so WASM here is about speed, not precision. The precision problem is on the GPU: float32 resolves ~0.5 m at 7,000 km from Earth's centre, which is visible jitter when the camera follows a satellite from a few hundred kilometres away. So every instanced layer (satellites, links, route, orbit trail) is placed *at the camera*, and each instance stores `position − camera`, subtracted on the CPU in float64. Near the camera the offsets are small and exact; far away the float32 error is sub-pixel. The model-view matrix is then just the camera rotation, which three.js composes in float64. The trade-off is ~240 KB of instance data re-uploaded per frame at 20k objects, which is noise next to the frame budget.

**Laser mesh.** Starlink's real inter-satellite topology isn't public, so Orbit Explorer models the +Grid used in the ISL literature: two in-plane links (fore and aft) plus one to the nearest satellite in the next plane east. Nothing is labelled. Every update, the analysis worker clusters mean inclination, then mean altitude (gaps > 0.08° and > 6 km), into shells. Shells under 200 satellites are launch batches still raising orbit, and get no links. It then clusters RAAN on the circle into planes (gaps > 0.9°) and orders each plane by argument of latitude. On the September 2026 catalogue this recovers six shells, including the 5,049-satellite 53.2° shell at 455 km in 76 planes. Links must stay above 80 km altitude end to end, and are capped at 2,600 km in-plane and 1,500 km cross-plane. Routing adds the two ground terminals as graph nodes, connected to every shell satellite above 25° elevation. Latency is the path length divided by c.

**Conjunction screening.** Two objects that pass within `d` at their time of closest approach are, at the nearest sample, at most `d + v_rel,max·Δt/2` apart. With v_rel,max = 16 km/s, that bound is the spatial-hash radius, so the sieve cannot miss anything between samples. The step-size independence test is the proof in practice. Each candidate pair gets a linear TCA estimate, and pairs whose estimate lands in the current window are refined by Newton iterations on d/dt |Δr|² = 0 using full SGP4 states. Pairs already inside the threshold at a sample are always refined, because for slow pairs the linear estimate is ill-conditioned. Pairs slower than 10 m/s are docked vehicles or formations (the ISS modules, for example) and are counted, not reported.

## What the data says

- **Starlink is its own biggest traffic hazard.** Of the 2,378 sub-5 km encounters in the next hour, 73% are Starlink–Starlink, and 62% of all of them happen at more than 10 km/s, between crossing planes of the dense 450–485 km shells. A density estimate (5,000 satellites in a ~10 km-thick shell, σ = π·5², v ≈ 10 km/s) predicts thousands per hour unless phasing is actively maintained. TLE errors are ~1 km, so these are screening hits, not collision probabilities.
- **Light in vacuum beats glass past a few thousand kilometres.** Ignoring slant range and grid zig-zags, the break-even is where the climb to the shell and back down (2h) equals the fibre penalty: 2h / (n − 1) ≈ 2,000 km for a 480 km shell with n = 1.468. Real uplinks at 25° elevation and +Grid staircases push it toward ~3,000 km. London–New York saves ~6 ms one way, and the saving grows with distance.
- **Coverage is total, and uneven.** Every point on Earth sees at least 5 Starlinks above 25°, 46 on average, but density peaks near ±50° where the 53° shells turn around.

## Run it

Requires Rust (with `rustup target add wasm32-unknown-unknown`), Node 24 and pnpm 10.

```sh
pnpm install
pnpm dev            # builds the WASM engine, then serves http://localhost:5173
pnpm test           # cargo test (engine) + vitest (web, incl. the satellite.js cross-check)
pnpm validate       # regenerate docs/validation/*.svg
pnpm bench          # native benchmarks → docs/benchmarks-native.json
pnpm data           # refresh the catalogue snapshot from CelesTrak (cached; respects its 2 h update cycle)
```

In the app: drag to orbit, scroll to zoom, click a satellite to select it, **F** to follow, **R** to reset, **Space** to pause. The Conjunctions tab's *Watch it happen* jumps the clock to 90 s before the closest approach and rides along with the first object.

The page must be **cross-origin isolated** (`COOP: same-origin`, `COEP: require-corp`) for `SharedArrayBuffer`. The Vite config sends the headers in dev and preview, and `web/public/_headers` does the same on Cloudflare Pages or Netlify. GitHub Pages can't set headers, which is why `.github/workflows/deploy.yml` targets Cloudflare Pages.

## Layout

```
engine/          Rust → WASM: sgp4, frames, sun, grid, conjunction, isl, coverage, batch
  tests/         Vallado verification set, sgp4-crate cross-check
  examples/      validate (error CSV), bench (native benchmarks)
web/             Vite + React 19 + Three.js (WebGPURenderer, TSL) + D3
  src/scene/     SceneController, Earth shader, camera-relative sprite/line layers, overlays
  src/workers/   SGP4 pool (SharedArrayBuffer), analysis (links/routing/coverage), conjunctions
  src/sim/       snapshot decoder, keyframes + Hermite, clock, physics, cities
  src/ui/        React HUD         src/panels/   D3 charts in React-owned containers
  scripts/       NASA textures → JPEG + KTX2, validation/benchmark plots
data/            snapshot builder (CelesTrak, or Space-Track with credentials)
docs/            validation plots, benchmarks, blog draft
.github/         CI, daily TLE snapshot, Cloudflare Pages deploy
```

## Limits, stated plainly

- **~20k objects, not 30k.** CelesTrak publishes active payloads plus the major debris clouds. The full public catalogue (~30k) requires a Space-Track account. `data/fetch-tles.mjs` uses it when `SPACETRACK_USER`/`SPACETRACK_PASS` are set, but that path hasn't been run against the live service yet. The engine is benchmarked to 100k synthetic objects.
- **TLE accuracy is ~1 km** at epoch and grows by km/day; SGP4 is exact to its own model, not to reality.
- **The laser topology is a model.** +Grid is the standard assumption in the literature; SpaceX's actual link scheduling is not public. The fibre comparison is deliberately the physical best case for fibre.
- UT1 is taken as UTC (≤ 0.9 s), polar motion is ignored (< 15 m), and the Sun uses the Astronomical Almanac low-precision series (0.01°).

## Credits & licences

Orbital elements: [CelesTrak](https://celestrak.org) GP data (snapshotted daily, never fetched at runtime). Earth imagery: NASA Blue Marble Next Generation and Black Marble 2016 (public domain). SGP4 verification data: Vallado, Crawford, Hujsak & Kelso, *Revisiting Spacetrack Report #3*, AIAA 2006-6753. Test references only: satellite.js (MIT) and the `sgp4` crate (MIT).
