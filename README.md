# Orbit Explorer: an orbital digital twin

**Every tracked object in Earth orbit, propagated live in the browser, with Starlink laser-link routing, conjunction screening and coverage analysis. All of it is built from first principles and checked against published references.**

![Orbit Explorer: the full public catalogue of 32,583 objects, the Starlink laser mesh and a London → New York route](docs/media/hero.jpg)

<p align="center"><img src="docs/media/orbit.webp" width="420" alt="The laser mesh flowing over the Atlantic at 10 minutes per second while the London–New York route re-routes"><br><sub>10 min/s: satellites move, the mesh rebuilds and the London → New York path re-routes.</sub></p>

It also flies to **the Moon and Mars**. Their orbiters (LRO, Danuri, MRO, Mars Odyssey, the Trace Gas Orbiter and more) and Mars' two moons fly on their missions' own trajectories from JPL Horizons, over 16k LRO and Viking maps with laser-altimeter relief. A relay planner shows when a rover can talk to Earth, and how long the signal takes.

<p align="center"><img src="docs/media/moon-flight.webp" width="720" alt="The camera rises off the Earth, swings round past the Milky Way and the Sun, and falls toward the lit side of the Moon, where the lunar orbiters' paths appear"><br><sub>Earth to the Moon: the camera climbs away, turns toward the destination and arrives on the lit side, with the lunar orbiters' paths.</sub></p>

A packet from London to New York over Starlink's lasers takes **~21 ms**. The best fibre possible, a straight cable along the great circle, takes **27.3 ms**. The twin computes that difference live from the satellites' real positions, and shows the path hop by hop.

| | What Orbit Explorer computes | How it is checked |
|---|---|---|
| **Orbits** | SGP4/SDP4 written from the model definition (Vallado et al. 2006), including deep-space resonance and every `sgp4fix`. TEME → ECEF → WGS-84 geodetic, Sun position, conical Earth-shadow model. | **666/666** Vallado verification states to **0.12 mm**, and the reference's 7 error cases reproduced. **77.4% bit-identical** to satellite.js across the live catalogue (worst 13 mm, on a 14-day high-elliptical orbit). The `sgp4` crate agrees to **0.7 µm**. Meeus 25.a Sun; published sunrise times to < 2 min. |
| **Laser links** | Shells and orbital planes recovered from mean elements by gap clustering; +Grid topology rebuilt every 250 ms; Dijkstra from ground terminal to ground terminal. | Synthetic Walker shells give exactly 2N links; path length equals the sum of its hops; a test proves the result is never shorter than the chord. |
| **Conjunctions** | All-vs-all screening with a spatial hash and search radii sized from each object's top speed, so no encounter between samples can be missed; a linear TCA estimate, then Newton refinement on full SGP4 states. | Identical results at 10, 20, 60 and 120 s steps (**60,756 encounters < 5 km over 24 h, every step size**), including a transfer orbit meeting a LEO satellite head-on at ~18 km/s midway between samples. Grid == brute force, pair for pair. |
| **Coverage** | Visibility-cap stamping on a 2° grid (O(sats × cap) rather than O(sats × cells)). | Stamp == brute-force cell test on every cell; cap angle matches the textbook value. |
| **Moon & Mars** | Moon (MiniMoon + 31 Meeus distance terms), Mars and Sun (Standish elements) in the equator of date; IAU 2009 rotation models; 12 orbiters and moons sampled from JPL Horizons and Hermite-interpolated; relay passes over a surface site. | Against Horizons over 2025–27: Moon **≤ 0.7′ and 6 km**, Mars **≤ 0.4′**, Sun **< 1′**; the Moon's libration (sub-Earth point) to **0.013°**, Mars' sub-Earth longitude to **0.012°** (light time included). Interpolation **≤ 16 m**, measured by decimation. |

## Numbers

Apple M1. Native rows: release build, one thread. Browser rows: Chrome 155, production build. 32,583 objects: the full public catalogue from Space-Track, 9 Oct 2026.

| | |
|---|---|
| Render | **60 fps** at the MacBook Air's own resolution (1440×900 at 2×); all per-frame JavaScript takes **~2.6 ms**, interpolating all 32,583 positions **0.22 ms** of it. The frame is GPU-bound: on a 4K external display the same M1 ran at 12–40 fps depending on the browser (measured at 19,887 objects; see *Limits*) |
| SGP4, all objects | **11.1 ms** native (340 ns/object) · **7.5 ms** per keyframe across 4 WASM workers |
| Keyframe interpolation error (cubic Hermite) | **2.5 m** worst case at 60 s spacing, for COSMOS 1174, a dead satellite on a 367 × 1,028 km orbit (near-circular orbits stay near 1 m) · 0.28 km at 300 s (1 h/s time warp) |
| Laser mesh rebuild | 10,847 linked satellites, 17,719 links in **2.8 ms** · Dijkstra **0.32 ms** |
| Conjunction sieve, one instant, pairs < 10 km | spatial hash **7.5 ms** vs all pairs **624 ms** (**84×**); **305×** at 100k objects · 102× in WASM |
| 24 h screen, whole catalogue, 5 km | **63 s** native (1,441 time steps, 460 M sieve pairs, 60,756 encounters) · 6 h in the browser: 27 s |
| Cold load to first interactive frame | **1.2 s** at 50 Mbps · **1.9 s** at 20 Mbps (production build, 20 ms round trip, no CDN compression) |

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
- `web/src/engine.crosscheck.test.ts`: the compiled WASM against satellite.js on ~2,500 catalogue objects × 7 times (−1 d … +3 d).
- `engine/src/sun.rs`: Meeus example 25.a (RA/Dec to 0.02°); sunrise at London and New York on both solstices within 2 minutes of published tables.
- `engine/src/conjunction.rs`: the sieve must return identical encounters at 10 s and 60 s steps, and must catch a transfer-orbit object passing a LEO satellite head-on at ~18 km/s between two 120 s samples (the case a single 16 km/s bound let through).
- `web/src/sim/keyframes.test.ts`: measures the interpolation error quoted above against exact SGP4.
- `web/src/sim/solar.test.ts`: the Moon, Mars and the Sun against JPL Horizons vectors at three dates, and both worlds' rotation against Horizons' sub-Earth points.
- `web/src/sim/ephemeris.test.ts`: every orbiter snapshot is bound and above the surface; dropping every other sample and interpolating must land within 50 m of JPL's value (Hermite error scales with step⁴).
- `web/src/sim/relay.test.ts`: the Earth never sets at Tranquility Base and never rises at Chang'e 4's far-side site; at Jezero it is up for 8–16 h of a sol; MRO's passes last minutes.
- `web/src/scene/travel.test.ts`: a flight between worlds starts and ends exactly where planned, never enters either body, and never jumps by more than a few percent of the current scale.

## How it works

```
             every deploy (6 h)
 CelesTrak or Space-Track ──────► catalog.bin  (1.9 MB at 32.6k objects: f64 epoch + mean motion, f32 angles, SoA)
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

             same deploy
 JPL Horizons ───────────────────► ephemeris-{moon,mars}.bin  (~0.7 MB each: 12 days of
                                   position + velocity per orbiter, 3–10 min steps)
```

**Simulation state never lives in React.** The render loop is a plain `SceneController` class that owns the renderer, the animation loop and the workers. React starts it from one `useEffect` and afterwards only reads summaries (clock, selected object, route latency, screening progress) that the scene publishes to a Zustand store about 5 times a second. Each D3 panel is a `<div>` React renders once and never touches again.

**SGP4 runs at 1–12 Hz, not per frame.** Four workers propagate their slice of the catalogue straight into a `SharedArrayBuffer` with four keyframe slots. The main thread requests a keyframe by writing a Julian date and bumping an `Int32` with `Atomics.notify`. Workers blocked in `Atomics.wait` wake up, propagate, and bump a done-counter. No `postMessage` happens per keyframe and nothing is copied. Each frame interpolates every object between two keyframes with a cubic Hermite spline on position and velocity, a 4th-order method whose measured error is quoted above. Keyframe spacing scales with time warp (1 s at real time, 300 s at 1 h/s). The **selected object is propagated exactly every frame**, and the routing and screening workers always use exact SGP4 states.

**Camera-relative rendering.** JavaScript numbers are already float64, so WASM here is about speed, not precision. The precision problem is on the GPU: float32 resolves ~0.5 m at 7,000 km from Earth's centre, which is visible jitter when the camera follows a satellite from a few hundred kilometres away. So every instanced layer (satellites, stars, links, route, orbits) is placed *at the camera*, and each instance stores `position − camera`, subtracted on the CPU in float64. Near the camera the offsets are small and exact; far away the float32 error is sub-pixel. The model-view matrix is then just the camera rotation, which three.js composes in float64. The trade-off is re-uploading instance data every frame: about 0.9 MB for 32.6k satellites, measured. The star field is re-uploaded the same way, another 3.2 MB per frame, although its offsets never change; uploading it once is the obvious next saving.

**Laser mesh.** Starlink's real inter-satellite topology isn't public, so Orbit Explorer models the +Grid used in the ISL literature: two in-plane links (fore and aft) plus one to the nearest satellite in the next plane east. Nothing is labelled. Every update, the analysis worker clusters mean inclination, then mean altitude (gaps > 0.08° and > 6 km), into shells. Shells under 200 satellites are launch batches still raising orbit, and get no links. It then clusters RAAN on the circle into planes (gaps > 0.9°) and orders each plane by argument of latitude. On the October 2026 catalogue this recovers seven shells, including the 4,640-satellite 53.2° shell at 464 km in 100 planes. Links must stay above 80 km altitude end to end, and are capped at 2,600 km in-plane and 1,500 km cross-plane. Routing adds the two ground terminals as graph nodes, connected to every shell satellite above 25° elevation. Latency is the path length divided by c.

**Other worlds.** There are no TLEs beyond Earth, and SGP4 models Earth's gravity and air, so the Moon's and Mars' orbiters use their missions' own trajectories: the navigation teams' reconstructions and predictions, as served by JPL Horizons. Every deploy samples them and the scene Hermite-interpolates, as it does for SGP4 keyframes. The worlds themselves come from compact analytic series, so they're available at any date: MiniMoon plus the largest Meeus distance terms for the Moon, and Standish's Keplerian elements for Mars and the Earth–Moon barycentre. Horizons and the IAU rotation models are in ICRF (J2000), so they're precessed to the scene's equator of date, as are the stars and the Milky Way (0.36° in 2026). Distances span 10⁸ km, so the scene's origin is wherever precision matters: the centre of the world in focus, re-anchored every frame because Mars moves at ~20 km/s relative to us. In transit the origin is the camera itself. A world beyond 700,000 km is drawn at that distance and scaled down by the same factor, keeping its direction, angular size and lighting. Below a few pixels across it becomes a point of light at its apparent magnitude, so Mars is a red star from Earth.

**Flying between worlds** is planned in log-distance (`scene/travel.ts`). The camera rises off one world, its distance growing geometrically while it swings round to the side facing the destination and turns to look at it. It then falls toward the destination, distance shrinking geometrically, and swings round to the lit side, 50° off the Sun so the terminator shows the relief. Time is split between the two halves in proportion to their log-distance ranges, so the speed is continuous where they meet. That takes ~2.6 s to the Moon and ~5 s to Mars.

**Conjunction screening.** Two objects that pass within `d` at their time of closest approach are, at the nearest sample, at most `d + v_rel·Δt/2` apart, and v_rel is at most the sum of the two objects' top speeds, their speeds at perigee. 95% of the catalogue never exceeds 8 km/s, so any two of those close at under 16 km/s, and that bound sizes the spatial hash. The other ~1,700 objects (transfer orbits, Molniyas, eccentric debris) each search their own wider radius, from their top speed plus the fastest object's. A single 16 km/s bound once let a transfer-orbit rocket body slip past a LEO satellite at 16.8 km/s between samples; a test now pins that case. With both radii the sieve cannot miss anything between samples, and the step-size independence test is the proof in practice. Each candidate pair gets a linear TCA estimate, and pairs whose estimate lands in the current window are refined by Newton iterations on d/dt |Δr|² = 0 using full SGP4 states. Pairs already inside the threshold at a sample are always refined, because for slow pairs the linear estimate is ill-conditioned. Pairs slower than 10 m/s are docked vehicles or formations (the ISS modules, for example) and are counted, not reported.

## The interface

The globe fills the screen; the interface is a few pieces of type and thin-lined black panels that appear when needed, in a monochrome, uppercase-labelled style after SpaceX's mission graphics. Colour is reserved for data.

- **Modes** across the top: Explore (just the globe), Routing, Conjunctions, Coverage and Catalogue. Each opens one panel on the right; the globe re-centres into the space that is left by shifting the projection, not the camera.
- **⌘K** opens one search box for every object in the catalogue (by name, or by NORAD ID typed as `100855`, `#100855` or `NORAD 100855`, matching as you type), well-known objects and view actions.
- **Selecting** an object shows its live state and always draws its orbit, fading behind it and bright ahead. **Follow** flies the camera there along a great-circle arc and rides along; stopping zooms back out with the object still centred. Selecting a conjunction draws both objects' orbits, so the crossing geometry is visible.
- **The time bar** is a mission timeline: ±24 h around now, with each screened conjunction marked where it happens. Click one to jump to 90 s before closest approach.
- **Earth · Moon · Mars** at the top fly the camera to another world (also **E**, **M** and **.**, or click a world's name where it hangs in the sky). The panels change with the world: around the Moon and Mars, **Orbiters** lists what is there with live altitude and period, and **Link to Earth** charts the next 24 hours at a landing site. It shows when the Earth is above the horizon (never at Chang'e 4 on the far side, always at Tranquility Base) and when each relay orbiter passes, with the one-way light time. Phobos and Deimos are drawn as cratered bodies, and spacecraft get a model when followed.
- **Layers** toggle the laser mesh, route, terminal visibility cones, coverage heatmap and the sky, and choose the reference frame: *Rotate with Earth* (ground fixed, satellites sweep over it) or *Fixed to stars* (orbital planes fixed, the Earth turns beneath them).
- **Object groups** use Paul Tol's high-contrast scheme (Starlink blue, other satellites yellow, debris red), whose hues also differ in lightness, so they survive colour-blindness and greyscale. The dark blue is lifted on the globe and ringed in the legend to stay legible against black.

**Each Starlink is drawn as its hardware generation.** The NORAD ID says which launch a satellite came from, and so which hardware it carries: V1.0/V1.5 (Falcon 9, 2019–23), V2 Mini including its Direct-to-Cell variant (Falcon 9, 2023 on), or V3 (Starship, from September 2026). Through mid-2023 SpaceX alternated V1.5 and V2 Mini launches, so the version comes from a table of ID ranges built from Jonathan McDowell's launch list (`starlinkVersion` in `web/src/sim/catalog.ts`), not a single cut-off. SpaceX hasn't published V3's layout; its model is an approximation from the reported ~7.5 m bus and ~60 m span.

<table>
  <tr>
    <td><img src="docs/media/starlink-v1.jpg" alt="A V1.5 Starlink: a small flat bus with one solar array, over sunlit land"></td>
    <td><img src="docs/media/starlink-v2.jpg" alt="A V2 Mini Starlink: a larger bus with a long two-panel array on one side, over the ocean"></td>
    <td><img src="docs/media/starlink-v3.jpg" alt="A V3 Starlink: a long bus with a two-panel array on each side, over the ocean"></td>
  </tr>
  <tr>
    <td align="center"><sub><b>V1.5</b> · STARLINK-4190<br>~300 kg, one 8 m array</sub></td>
    <td align="center"><sub><b>V2 Mini</b> · STARLINK-33927<br>~800 kg, ~30 m array</sub></td>
    <td align="center"><sub><b>V3</b> · STARLINK-40083 (Starship flight 14)<br>~1.9 t, ~60 m across</sub></td>
  </tr>
</table>

Each close-up is framed to fit the model, so the three aren't to the same scale.

**The sky is data too.** The Milky Way is NASA SVS's *Deep Star Maps 2020* (Gaia DR2, bright stars removed) placed on the celestial sphere in the scene's equatorial frame. The stars it removed come back as the 116,833 Hipparcos stars, each drawn as a Gaussian point-spread function sized in device pixels from its V magnitude and coloured by B−V, so they stay sharp on 4K screens. The Sun sits where the engine puts it, at its true 0.53° with limb darkening, and sets behind the Earth's limb.

**The Moon and Mars** use the same tile pipeline (`scripts/planets.mjs`). The Moon is LRO's wide-angle colour mosaic with LOLA's 64 px/° elevation model. Mars is the Viking Orbiter colour mosaic (925 m/px) with MOLA's 32 px/° elevation. The elevation is baked into slope maps that the shader lights with the real Sun, so craters and canyons cast shadow at the terminator. Reflectance is Minnaert's law, with k = 0.5 for the Moon (the full Moon is a flat disc, with no darkening at the limb) and 0.8 for Mars.

**Imagery** streams in sharper each step: 2k JPEG at first paint, then 4k KTX2, then on high-density displays a 16384×8192 Earth (Blue Marble NG by day, 500 m Black Marble lights by night) and a 16k sky, each as a 4×4 grid of 4096×2048 tiles because WebGPU only guarantees 8192-pixel textures. Tiles facing the camera load first. Basis builds mipmaps with wrap-around addressing by default, which drew faint lines along tile seams at lower mip levels; the texture scripts switch it to clamping.

## What the data says

- **Starlink is its own biggest traffic hazard.** Of the 2,981 sub-5 km encounters in the next hour, 55% are Starlink–Starlink, and 68% of all of them happen at more than 10 km/s, between crossing planes of the dense 450–485 km shells. Another 30% involve debris or a spent rocket body, which only the full catalogue shows. A density estimate (5,000 satellites in a ~10 km-thick shell, σ = π·5², v ≈ 10 km/s) predicts thousands per hour unless phasing is actively maintained. TLE errors are ~1 km, so these are screening hits, not collision probabilities.
- **Light in vacuum beats glass past a few thousand kilometres.** Ignoring slant range and grid zig-zags, the break-even is where the climb to the shell and back down (2h) equals the fibre penalty: 2h / (n − 1) ≈ 2,000 km for a 480 km shell with n = 1.468. Real uplinks at 25° elevation and +Grid staircases push it toward ~3,000 km. London–New York saves ~6 ms one way, and the saving grows with distance.
- **Coverage is total, and uneven.** Every point on Earth sees at least 6 Starlinks above 25°, 46 on average, but density peaks near ±50° where the 53° shells turn around.

## Run it

Requires Rust (with `rustup target add wasm32-unknown-unknown`), Node 24 and pnpm 10.

```sh
pnpm install
pnpm dev            # fetches the snapshots on first run, builds the WASM engine, then serves http://localhost:5173
pnpm test           # cargo test (engine) + vitest (web, incl. the satellite.js cross-check)
pnpm validate       # regenerate docs/validation/*.svg
pnpm bench          # native benchmarks → docs/benchmarks-native.json
pnpm data           # refresh the catalogue snapshot from CelesTrak (cached; respects its 2 h update cycle),
                    # then the Moon's and Mars' orbiters from JPL Horizons. The snapshots aren't in git:
                    # dev, build, test and bench fetch them once if missing, and only this refreshes them
pnpm --filter web textures   # Earth imagery: 2k, 4k and 16k (4x4 tiles of 4096x2048) KTX2 tiers + ocean mask
pnpm --filter web sky        # Milky Way (16k, tiled) and the Hipparcos star catalogue
                             # (both download ~700 MB of NASA/ESA sources once, cached in data/cache/)
pnpm --filter web planets    # Moon and Mars colour + relief tiers (downloads ~2.2 GB of NASA/USGS sources once)
```

In the app: drag to orbit, scroll to zoom, click a satellite to select it. **⌘K** (or **/**) searches objects, orbiters, worlds and actions, **E**, **M** and **.** fly to the Earth, the Moon and Mars, **1–5** switch between Explore, Routing, Conjunctions, Coverage and Catalogue (at the Moon and Mars: Explore, Orbiters, Link to Earth), **F** flies to the selection and follows it, **Esc** zooms back out, **R** resets, **L** opens layers, **H** hides the interface, **Space** pauses. The Conjunctions view's *Watch it happen* jumps the clock to 90 s before the closest approach and rides along with the first object, with both objects' orbits drawn.

Imagery streams in sharper each step: 2k JPEG at first paint, then 4k KTX2, then, on displays at least ~2560 device pixels across, 16k Earth and sky as 4x4 grids of tiles, nearest-to-view first. `?quality=uhd` or `?quality=standard` overrides the choice.

The page must be **cross-origin isolated** (`COOP: same-origin`, `COEP: require-corp`) for `SharedArrayBuffer`. The Vite config sends the headers in dev and preview, and `web/public/_headers` does the same on Cloudflare Pages or Netlify. GitHub Pages can't set headers, which is why `.github/workflows/deploy.yml` targets Cloudflare Pages.

## Layout

```
engine/          Rust → WASM: sgp4, frames, sun, grid, conjunction, isl, coverage, batch
  tests/         Vallado verification set, sgp4-crate cross-check
  examples/      validate (error CSV), bench (native benchmarks)
web/             Vite + React 19 + Three.js (WebGPURenderer, TSL) + D3
  src/scene/     SceneController (camera flights, follow), tiled Earth shader, sky (Milky Way, stars, Sun), camera-relative sprite/line layers,
                 Moon/Mars globes and Phobos/Deimos (planet), worlds and orbiters (system), flights between worlds (travel)
  src/workers/   SGP4 pool (SharedArrayBuffer), analysis (links/routing/coverage), conjunctions
  src/sim/       snapshot decoder, keyframes + Hermite, clock, physics, cities; Moon/Mars/Sun series and IAU rotation (solar),
                 Horizons snapshots (ephemeris), relay passes (relay), worlds, orbiters and sites (bodies)
  src/ui/        React HUD: header, mode panels, ⌘K palette, timeline     src/panels/   D3 charts in React-owned containers
  scripts/       NASA textures → JPEG + tiled KTX2, sky (Milky Way map, Hipparcos stars), Moon/Mars colour + relief, validation/benchmark plots
data/            snapshot builders: CelesTrak (or Space-Track with credentials), JPL Horizons
docs/            validation plots, benchmarks, blog draft
.github/         CI, Cloudflare Pages deploy (on push, and every 6 h with fresh snapshots)
```

## Limits, stated plainly

- **The full catalogue needs a Space-Track account.** Without one, CelesTrak publishes active payloads plus the major debris clouds, about 20k objects. With `SPACETRACK_USER`/`SPACETRACK_PASS` set, `data/fetch-tles.mjs` pulls the full public catalogue instead: 32,583 objects on 9 Oct 2026, including ~2,100 rocket bodies and ~11,600 pieces of debris that CelesTrak's groups leave out. The screenshots and the *Numbers* section above use it. The engine is benchmarked to 100k synthetic objects.
- **TLE accuracy is ~1 km** at epoch and grows by km/day; SGP4 is exact to its own model, not to reality.
- **The laser topology is a model.** +Grid is the standard assumption in the literature; SpaceX's actual link scheduling is not public. The fibre comparison is deliberately the physical best case for fibre.
- UT1 is taken as UTC (≤ 0.9 s), polar motion is ignored (< 15 m), and the Sun uses the Astronomical Almanac low-precision series (0.01°).
- **Rendering is GPU-bound and doesn't adapt yet.** The canvas always renders at the display's density (up to 2×), with a half-resolution bloom pass on top. On an M1 driving a 4K external display that measured 12–18 fps in Zen (Firefox) and roughly 25–40 fps in Chrome. Adaptive resolution and a cheaper bloom are the planned fixes.
- **The UHD imagery is heavy:** ~29 MB of tiles for the Earth and sky (18 MB of it the sky), plus 33 MB for the Moon and 18 MB for Mars. Tiles download only on high-density displays, and a world's tiles only when you go there.
- **Beyond Earth, a trajectory is only as current as its mission's last prediction.** The snapshot covers 2 days back and 10 ahead, and some kernels end sooner, so an orbiter disappears when you scrub past its window, and its card says so. Predictions change at every manoeuvre. MAVEN (silent since late 2025), Tianwen-1 and the Queqiao relays aren't in Horizons, so they aren't shown.
- **The worlds' positions are analytic**, good to about an arcminute over this century. That's far below what the scene can show, but it isn't JPL's DE440. Mars' rotation uses the IAU 2009 model, and the Moon's uses its full libration series.
- **Phobos' and Deimos' shapes are made up**: true sizes and orientation, with procedural craters (plus Stickney on Phobos), not the shape models.

## Credits & licences

Orbital elements: [CelesTrak](https://celestrak.org) GP data, or the full public catalogue from [Space-Track.org](https://www.space-track.org) when credentials are set (snapshotted at each deploy, every 6 hours, never fetched at runtime). Starlink hardware generations: Jonathan McDowell, [planet4589.org](https://planet4589.org/space/con/star/stats.html) (CC-BY). Earth imagery: NASA Blue Marble Next Generation and Black Marble 2016 (public domain). Milky Way: NASA/Goddard Space Flight Center Scientific Visualization Studio, *Deep Star Maps 2020*, built on Gaia DR2 (ESA/Gaia/DPAC). Stars: the Hipparcos main catalogue (ESA 1997, CDS I/239). Moon: NASA LRO, LROC WAC colour mosaic and LOLA elevation, via the NASA SVS *CGI Moon Kit*. Mars: Viking Orbiter colour mosaic (USGS Astrogeology) and MGS MOLA MEGDR elevation (NASA PDS). Lunar and Martian trajectories: [JPL Horizons](https://ssd.jpl.nasa.gov/horizons/) (Solar System Dynamics Group). Rotation: Archinal et al., *Report of the IAU WGCCRE: 2009*. Moon series: Montenbruck & Pfleger, *Astronomy on the Personal Computer*, and Meeus, *Astronomical Algorithms*. Planets: Standish, *Keplerian Elements for Approximate Positions of the Major Planets*. Spacecraft models: *Hubble Space Telescope (A)* (DigitalSpace Corporation) and *International Space Station (ISS) (B)* (NASA/Michael D. Carbajal) from [NASA 3D Resources](https://science.nasa.gov/3d-resources/), used under NASA's media usage guidelines and decoded with Google's Draco (Apache-2.0); every other model is generated in code. Object colours: Paul Tol's high-contrast scheme. Type: Barlow and Geist Mono (SIL OFL). SGP4 verification data: Vallado, Crawford, Hujsak & Kelso, *Revisiting Spacetrack Report #3*, AIAA 2006-6753. Test references only: satellite.js (MIT) and the `sgp4` crate (MIT).
