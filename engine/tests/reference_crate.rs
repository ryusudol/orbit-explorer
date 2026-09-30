//! Cross-check against an independent Rust implementation (the `sgp4` crate,
//! test-only dependency) on the Vallado objects at many times.

use orbit_explorer_engine::sgp4::{Gravity, OpsMode, Satrec};
use orbit_explorer_engine::tle::parse_tle;

const TLE: &str = include_str!("../testdata/SGP4-VER.TLE");

#[test]
fn agrees_with_sgp4_crate() {
    let lines: Vec<&str> = TLE.lines().filter(|l| !l.starts_with('#') && !l.trim().is_empty()).collect();
    let mut compared = 0;
    let mut worst = 0.0f64;
    for pair in lines.chunks(2) {
        let l1 = pair[0];
        let l2: String = pair[1].chars().take(69).collect();
        let Ok(reference) = sgp4::Elements::from_tle(None, l1.as_bytes(), l2.as_bytes()) else { continue };
        let Ok(constants) = sgp4::Constants::from_elements_afspc_compatibility_mode(&reference) else { continue };
        let el = parse_tle(l1, &l2).unwrap();
        let mut ours = Satrec::new(&el, Gravity::wgs72(), OpsMode::Afspc);
        for k in 0..=48 {
            let t = k as f64 * 30.0; // one day at 30 min
            let theirs = constants.propagate_afspc_compatibility_mode(sgp4::MinutesSinceEpoch(t));
            let mine = ours.propagate(t);
            match (theirs, mine) {
                (Ok(p), Ok((r, _))) => {
                    let d = ((p.position[0] - r[0]).powi(2) + (p.position[1] - r[1]).powi(2) + (p.position[2] - r[2]).powi(2)).sqrt();
                    worst = worst.max(d);
                    compared += 1;
                }
                _ => {}
            }
        }
    }
    println!("compared {compared} states, max |dr| = {worst:.3e} km");
    assert!(compared > 1000);
    assert!(worst < 1e-5, "max difference {worst} km");
}
