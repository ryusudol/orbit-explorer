//! Writes the per-row SGP4 errors against the Vallado reference to CSV
//! (consumed by `web/scripts/plots.ts` to draw the validation figures).
//!
//!     cargo run --release --example validate -- ../docs/validation/vallado-errors.csv

use kessler_engine::sgp4::OpsMode;
use kessler_engine::verification::{load, run};
use std::io::Write;

fn main() {
    let out_path = std::env::args().nth(1).unwrap_or_else(|| "vallado-errors.csv".into());
    let cases = load(include_str!("../testdata/SGP4-VER.TLE"), include_str!("../testdata/tcppver.out"));
    let samples = run(&cases, OpsMode::Improved);
    let mut f = std::fs::File::create(&out_path).expect("create csv");
    writeln!(f, "satnum,tsince_min,dr_mm,dv_um_s,deep_space").unwrap();
    for s in &samples {
        writeln!(f, "{},{},{:.6e},{:.6e},{}", s.satnum, s.tsince, s.dr_km * 1e6, s.dv_kms * 1e9, s.deep_space as u8).unwrap();
    }
    let max_dr = samples.iter().map(|s| s.dr_km).fold(0.0, f64::max);
    eprintln!("{} rows from {} objects -> {out_path} (max |dr| {:.3} mm)", samples.len(), cases.len(), max_dr * 1e6);
}
