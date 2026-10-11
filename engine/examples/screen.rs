//! Time the app's default conjunction screen on the catalogue snapshot.
//!
//!     cargo run --release --example screen -- ../web/public/data/catalog.bin [hours] [step_s] [parts] [events.csv]
//!
//! Prints wall time, sieve counters and the event count. With `parts` > 1 the
//! window is split as the web app's workers split it, one thread per part, and
//! the events are merged by pair. With a fifth argument it writes every event,
//! sorted by pair, so two builds (or part counts) can be diffed.

use orbit_explorer_engine::batch::{Batch, ELEMENT_STRIDE};
use orbit_explorer_engine::conjunction::{Event, Screener, Stats};
use std::collections::HashMap;
use std::time::Instant;

fn load(path: &str) -> (Vec<f64>, f64) {
    let b = std::fs::read(path).expect("read snapshot");
    assert_eq!(&b[0..4], b"ORBX");
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
    (packed, gen_ms / 86_400_000.0 + 2440587.5)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = args.get(1).cloned().unwrap_or_else(|| "../web/public/data/catalog.bin".into());
    let hours: f64 = args.get(2).map_or(6.0, |s| s.parse().unwrap());
    let step: f64 = args.get(3).map_or(60.0, |s| s.parse().unwrap());
    let parts: u32 = args.get(4).map_or(1, |s| s.parse().unwrap());
    let (packed, jd) = load(&path);
    let n = packed.len() / ELEMENT_STRIDE;

    let t = Instant::now();
    let results: Vec<(Vec<Event>, Stats)> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..parts)
            .map(|part| {
                let packed = &packed;
                scope.spawn(move || {
                    let mut s = Screener::new(Batch::from_packed(packed));
                    s.begin_part(jd, hours * 60.0, step, 5.0, part, parts);
                    s.advance(u32::MAX);
                    (s.events(), s.stats)
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let secs = t.elapsed().as_secs_f64();

    let mut merged: HashMap<(u32, u32), Event> = HashMap::new();
    let mut st = Stats::default();
    for (events, s) in &results {
        st.steps += s.steps;
        st.candidate_pairs += s.candidate_pairs;
        st.refined += s.refined;
        for e in events {
            let m = merged.entry((e.a, e.b)).or_insert(*e);
            if e.miss_km < m.miss_km {
                *m = *e;
            }
        }
    }
    println!(
        "{n} objects, {hours} h @ {step} s, 5 km, {parts} part(s): {secs:.2} s | {} steps, {} pairs sieved, {} refined, {} events",
        st.steps,
        st.candidate_pairs,
        st.refined,
        merged.len()
    );

    if let Some(out) = args.get(5) {
        let mut rows: Vec<&Event> = merged.values().collect();
        rows.sort_by_key(|e| (e.a, e.b));
        let body: String = rows.iter().map(|e| format!("{},{},{:.9},{:.6}\n", e.a, e.b, e.tca_jd, e.miss_km)).collect();
        std::fs::write(out, body).unwrap();
    }
}
