# Draft: 20,000 satellites in a browser tab, and three bugs only the tests could see

*Draft blog post for Kessler. Numbers are from an Apple M1 with Chrome on the 30 September 2026 CelesTrak snapshot; every figure links back to a test or benchmark in the repo.*

---

A packet from London to New York takes about 27 ms through the best fibre physically possible: a straight cable along the great circle, with light slowed to c/1.468 by the glass. Over Starlink's lasers it takes about 21 ms, even though it first climbs ~500 km to the shell, hops through 7–11 satellites, and comes back down.

I wanted to *watch* that happen with real satellites in their real positions, and to compute it myself rather than read it off someone's API. The result is Kessler: a browser tab that propagates every one of the 19,887 objects CelesTrak publishes, rebuilds a model of the Starlink laser mesh four times a second, routes packets over it, and screens the whole catalogue for close approaches, at 60 fps.

The rendering was the easy part. What I want to write about is how I convinced myself the numbers are right, because each of the three bugs I found would have produced a demo that looked perfect.

## 1. SGP4 from the paper, and a reference file that lies once

Satellite positions come from two-line elements via SGP4, the model the elements are fitted with. I wrote it in Rust from Vallado, Crawford, Hujsak & Kelso's *Revisiting Spacetrack Report #3* (AIAA 2006-6753). That includes the deep-space half: the lunar-solar periodics, and the 12-hour and 24-hour resonance integrator that keeps Molniya and GEO orbits honest. It compiles to a 157 KB WASM module.

The paper ships a verification set: 33 objects chosen to break implementations (near-singular inclinations, decaying orbits, a 0.00001 rev/day orbit that has no business existing) and the reference program's output. My implementation matches all 666 states to 0.12 mm, which is below the reference file's own print rounding.

One object didn't match at first. Object 33334 should fail at t = 0 with error 3 (perturbed eccentricity out of range), and mine did. But the reference file shows a perfectly good-looking state vector for it. On closer inspection, that "state" is the previous object's last row, byte for byte. The C++ driver prints whatever is left in its buffer when propagation fails. The harness now detects stale rows and asserts that every object the reference abandons fails at exactly that step, with the same codes: `[1, 1, 6, 6, 4, 3, 6]`.

Then two independent cross-checks. The Rust `sgp4` crate agrees to 0.7 µm. satellite.js, run against my WASM build on ~2,800 catalogue objects from −1 to +3 days, is bit-identical 83.6% of the time. The worst difference is 4 mm, on a 14-day orbit, three days out: floating-point, not physics.

## 2. SGP4 at 12 Hz, not 60 × 20,000 times a second

Running SGP4 for every object every frame would work (6.4 ms natively), but it would spend the whole frame budget on something you can't see. Instead, four workers propagate their slice of the catalogue into a `SharedArrayBuffer`. The main thread requests a keyframe by writing a Julian date and bumping an `Int32` with `Atomics.notify`. Workers blocked in `Atomics.wait` wake, propagate, and increment a done-counter. No messages, no copies.

Every frame interpolates all 19,887 positions between two keyframes with a cubic Hermite spline on position *and velocity*. That takes 0.25 ms. For a circular orbit the error is about r(ωh)⁴/384, which is where I had written "≈0.3 m at 60 s" in a comment. The test that measures it against exact SGP4 across 600 LEO objects said **0.995 m**. Eccentric orbits near perigee are worse than circular ones. The test now asserts < 2 m, the comment says 1 m, and the 1 h/s time-warp case (300 s keyframes) is 0.27 km. The object you've selected is propagated exactly every frame anyway.

## 3. float32 is the real precision problem

JavaScript numbers are float64 already, so moving the physics to WASM is about speed, not precision. The precision problem is on the GPU. float32 resolves about half a metre at 7,000 km from Earth's centre, and when the camera follows a satellite from a few hundred kilometres away, that shows up as jitter.

The fix is camera-relative rendering. Every instanced layer sits *at the camera*, and each instance stores `position − camera`, subtracted on the CPU in float64. Near the camera the numbers are small and exact; far from it the error is below a pixel. The model-view matrix collapses to the camera's rotation, which three.js composes in float64 before upload. The cost is re-uploading 240 KB of offsets per frame, which is nothing.

## 4. Recovering Starlink's shells without being told

Nothing in the element sets says "this satellite is in shell 3, plane 41". Kessler recovers that on every update from the singly-averaged mean elements SGP4 already computes. It gap-clusters inclination (0.08°), then altitude (6 km), into shells, drops "shells" under 200 satellites (launch batches still raising orbit), clusters RAAN on the circle (0.9°) into planes, and sorts each plane by argument of latitude.

On the current catalogue that yields six shells, the biggest being 5,049 satellites at 53.2° and 455 km in 76 planes. Each satellite links fore and aft in its plane and to the nearest satellite in the next plane east (+Grid): 18,422 links, rebuilt in 2.8 ms. Dijkstra from terminal to terminal takes 0.35 ms. The first version allowed 3,000 km links and let small shells participate, and the mesh looked like a spider had been at it. Measuring the link-length histogram per shell showed the long diagonals all came from half-empty shells.

The fibre comparison is deliberately generous to fibre. It assumes a straight great-circle cable with no repeaters and no switching; real transatlantic routes are 10–30% longer. Ignoring slant range, lasers win past 2h/(n − 1) ≈ 2,000 km for a 480 km shell. With real uplink geometry and +Grid staircases, it's more like 3,000 km.

## 5. A conjunction sieve with a proof, and the one pair it dropped

Screening 19,887 objects all-against-all is 198 million pairs per instant. A spatial hash reduces that to 27 neighbour cells per object: 3.3 ms instead of 280 ms, and 274× faster at 100,000 objects.

The subtle part is time. Objects move 7.5 km/s, so sampling every Δt can step straight over a close approach. The fix is a bound. Two objects that pass within d at closest approach are, at the nearest sample, at most d + v_rel,max·Δt/2 apart. Make *that* the hash radius and nothing can slip between samples. Each surviving pair gets a linear time-of-closest-approach estimate, and Newton iterations on full SGP4 states refine it.

A bound is only as good as its implementation, so the test is blunt: screen the same scenario at 10 s and 60 s steps and demand identical encounters. On synthetic crossing shells it passed. On the real catalogue over 24 hours, 60 s and 120 s steps found 44,179 encounters and the 20 s step found 44,178.

The missing pair was *slow*. When two objects drift past each other at metres per second, the linear TCA estimate −(Δr·Δv)/|Δv|² is ill-conditioned: tiny curvature errors throw it outside every fine window, while a coarse window happened to catch it. Pairs already inside the threshold at a sample are now always refined, whatever the linear estimate says. All step sizes agree on 44,179.

## What the data says

- **Starlink is its own biggest traffic hazard.** 73% of the 2,378 sub-5 km encounters in the next hour are Starlink–Starlink, most of them at more than 10 km/s between crossing planes of the 450–485 km shells. TLE accuracy is ~1 km, so these are screening hits, not collision probabilities. The pattern is the point.
- **Coverage is total but lumpy.** Every point on Earth sees at least 5 Starlinks above 25° right now, 46 on average, and density peaks near ±50° where the 53° shells turn around.

## Numbers

| | |
|---|---|
| Objects | 19,887 (CelesTrak; the full 30k needs Space-Track) |
| Frame | 60 fps, 3 ms CPU; interpolation 0.25 ms |
| SGP4 | 323 ns/object native; 7 ms per keyframe on 4 WASM workers |
| Laser mesh | 18,422 links in 2.8 ms; Dijkstra 0.35 ms |
| Sieve, one instant | 3.3 ms vs 280 ms all-pairs (85×); 274× at 100k |
| 24 h screen | 38 s native, 44,179 encounters < 5 km |
| Cold load | 0.75 s at 50 Mbps, 1.4 s at 20 Mbps |

Code, tests, validation plots and the live demo: *[link]*.
