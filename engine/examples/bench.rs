//! Native benchmarks on the real catalogue snapshot, plus synthetic scaling.
//!
//!     cargo run --release --example bench -- ../web/public/data/catalog.bin [out.json]
//!
//! Browser (WASM) numbers are measured live in the app's Benchmarks panel.

use kessler_engine::batch::{Batch, ELEMENT_STRIDE};
use kessler_engine::conjunction::Screener;
use kessler_engine::frames::C_KM_S;
use kessler_engine::grid::{brute_force_pairs, SpatialHash};
use kessler_engine::isl::{self, IslConfig, Terminal};
use kessler_engine::sgp4::gstime;
use std::time::Instant;

struct Snapshot {
    packed: Vec<f64>,
    category: Vec<u8>,
    generated_jd: f64,
}

fn load(path: &str) -> Snapshot {
    let b = std::fs::read(path).expect("read snapshot");
    assert_eq!(&b[0..4], b"KSLR");
    let n = u32::from_le_bytes(b[8..12].try_into().unwrap()) as usize;
    let gen_ms = f64::from_le_bytes(b[16..24].try_into().unwrap());
    let f64_at = |off: usize, i: usize| f64::from_le_bytes(b[off + 8 * i..off + 8 * i + 8].try_into().unwrap());
    let f32_at = |off: usize, i: usize| f32::from_le_bytes(b[off + 4 * i..off + 4 * i + 4].try_into().unwrap()) as f64;
    let mut packed = vec![0.0; n * ELEMENT_STRIDE];
    let base = 32;
    for i in 0..n {
        let e = &mut packed[i * ELEMENT_STRIDE..(i + 1) * ELEMENT_STRIDE];
        e[0] = f64_at(base, i);
        e[1] = f64_at(base + 8 * n, i);
        for k in 0..6 {
            e[2 + k] = f32_at(base + 16 * n + 4 * n * k, i);
        }
    }
    let cat_off = base + 16 * n + 24 * n + 4 * n;
    Snapshot { packed, category: b[cat_off..cat_off + n].to_vec(), generated_jd: gen_ms / 86_400_000.0 + 2440587.5 }
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1e3
}

/// Replicate the catalogue with shifted mean anomalies up to `n` objects.
fn synthetic(packed: &[f64], n: usize) -> Vec<f64> {
    let m = packed.len() / ELEMENT_STRIDE;
    let mut out = Vec::with_capacity(n * ELEMENT_STRIDE);
    for k in 0..n {
        let src = &packed[(k % m) * ELEMENT_STRIDE..(k % m + 1) * ELEMENT_STRIDE];
        let mut e = src.to_vec();
        let copy = (k / m) as f64;
        e[6] = (e[6] + copy * 137.508).rem_euclid(360.0); // golden-angle offsets
        e[4] = (e[4] + copy * 7.3).rem_euclid(360.0);
        out.extend_from_slice(&e);
    }
    out
}

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| "../web/public/data/catalog.bin".into());
    let out_json = std::env::args().nth(2);
    let snap = load(&path);
    let n = snap.category.len();
    let jd = snap.generated_jd;
    println!("catalogue: {n} objects ({path})");
    let mut report = Vec::<String>::new();

    // ---- propagation ----
    let t = Instant::now();
    let mut batch = Batch::from_packed(&snap.packed);
    let init_ms = ms(t);
    let reps = 20;
    let t = Instant::now();
    let mut ok = 0;
    for k in 0..reps {
        ok = batch.propagate(jd + k as f64 / 1440.0, true);
    }
    let prop_ms = ms(t) / reps as f64;
    println!("sgp4init: {init_ms:.1} ms | propagate all + eclipse: {prop_ms:.2} ms ({:.0} ns/object, {ok} ok)", prop_ms * 1e6 / n as f64);
    report.push(format!("\"objects\": {n}, \"sgp4init_ms\": {init_ms:.2}, \"propagate_ms\": {prop_ms:.3}"));

    // ---- laser-link graph + routing ----
    let sl: Vec<f64> = (0..n)
        .filter(|&i| snap.category[i] == 1)
        .flat_map(|i| snap.packed[i * ELEMENT_STRIDE..(i + 1) * ELEMENT_STRIDE].to_vec())
        .collect();
    let mut sb = Batch::from_packed(&sl);
    sb.propagate(jd, false);
    let t = Instant::now();
    let g = isl::build(&sb, &IslConfig::default());
    let build_ms = ms(t);
    let linked = g.shell_of.iter().filter(|&&s| s >= 0).count();
    println!("ISL graph: {} sats, {linked} linked, {} edges in {build_ms:.2} ms", sb.len(), g.edges.len());
    for s in &g.shells {
        println!("   shell {:6.2} deg {:6.1} km: {:5} sats, {:3} planes", s.inclination_deg, s.altitude_km, s.satellites, s.planes);
    }
    let gm = gstime(jd);
    let london = Terminal::new(51.5072, -0.1276, gm);
    let nyc = Terminal::new(40.7128, -74.0060, gm);
    let t = Instant::now();
    let r = isl::route(&g, &sb, &london, &nyc, 25.0);
    let route_ms = ms(t);
    if let Some(r) = &r {
        let fibre_km = 5570.0; // great circle
        println!(
            "London->NYC: {:.0} km, {} sats, {:.2} ms one-way (fibre great-circle {:.2} ms) | dijkstra {route_ms:.3} ms",
            r.total_km,
            r.path.len(),
            r.total_km / C_KM_S * 1e3,
            fibre_km / (C_KM_S / 1.4682) * 1e3
        );
    } else {
        println!("London->NYC: no route");
    }
    report.push(format!("\"isl_sats\": {}, \"isl_edges\": {}, \"isl_build_ms\": {build_ms:.3}, \"dijkstra_ms\": {route_ms:.4}", sb.len(), g.edges.len()));

    // ---- conjunction sieve: one instant, grid vs all pairs ----
    batch.propagate(jd, false);
    let radius = 10.0;
    let mut grid = SpatialHash::new(radius);
    let t = Instant::now();
    grid.build(&batch.pos, &batch.ok);
    let mut pairs_grid = 0;
    grid.for_each_pair_within(&batch.pos, radius, |_, _, _| pairs_grid += 1);
    let grid_ms = ms(t);
    let t = Instant::now();
    let mut pairs_brute = 0;
    brute_force_pairs(&batch.pos, &batch.ok, radius, |_, _, _| pairs_brute += 1);
    let brute_ms = ms(t);
    assert_eq!(pairs_grid, pairs_brute);
    println!("pairs < {radius} km: grid {grid_ms:.2} ms vs all-pairs {brute_ms:.1} ms ({:.0}x), {pairs_grid} pairs", brute_ms / grid_ms);
    report.push(format!("\"sieve_grid_ms\": {grid_ms:.3}, \"sieve_brute_ms\": {brute_ms:.2}"));

    // ---- full screening window ----
    for &(hours, step) in &[(1.0, 20.0), (24.0, 20.0), (24.0, 60.0), (24.0, 120.0)] {
        let mut s = Screener::new(Batch::from_packed(&snap.packed));
        s.begin(jd, hours * 60.0, step, 5.0);
        let t = Instant::now();
        s.advance(u32::MAX);
        let el = ms(t);
        let ev = s.events();
        println!(
            "screen {hours} h @ {step} s, 5 km: {:.2} s, {} steps, {} candidate pairs, {} events",
            el / 1e3,
            s.stats.steps,
            s.stats.candidate_pairs,
            ev.len()
        );
        report.push(format!("\"screen_{}h_{}s\": {{\"seconds\": {:.3}, \"events\": {}}}", hours as u32, step as u32, el / 1e3, ev.len()));
    }

    // ---- synthetic scaling ----
    println!("synthetic scaling (catalogue replicated with phase offsets):");
    let mut rows = Vec::new();
    for &size in &[10_000usize, 30_000, 100_000] {
        let p = synthetic(&snap.packed, size);
        let mut b = Batch::from_packed(&p);
        let t = Instant::now();
        b.propagate(jd, false);
        let prop = ms(t);
        let mut grid = SpatialHash::new(radius);
        let t = Instant::now();
        grid.build(&b.pos, &b.ok);
        let mut pg = 0u64;
        grid.for_each_pair_within(&b.pos, radius, |_, _, _| pg += 1);
        let gms = ms(t);
        let t = Instant::now();
        let mut pb = 0u64;
        brute_force_pairs(&b.pos, &b.ok, radius, |_, _, _| pb += 1);
        let bms = ms(t);
        assert_eq!(pg, pb);
        println!("   {size:>7}: propagate {prop:7.2} ms | grid {gms:6.2} ms | all-pairs {bms:9.1} ms ({:.0}x)", bms / gms);
        rows.push(format!("{{\"n\": {size}, \"propagate_ms\": {prop:.3}, \"grid_ms\": {gms:.3}, \"brute_ms\": {bms:.2}}}"));
    }
    report.push(format!("\"scaling\": [{}]", rows.join(", ")));

    if let Some(p) = out_json {
        let machine = std::env::var("BENCH_MACHINE").unwrap_or_else(|_| std::env::consts::ARCH.to_string());
        let body = format!("{{\n  \"machine\": \"{machine}\",\n  {}\n}}\n", report.join(",\n  "));
        std::fs::write(&p, body).unwrap();
        println!("wrote {p}");
    }
}
