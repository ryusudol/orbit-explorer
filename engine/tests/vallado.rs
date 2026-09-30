//! SGP4/SDP4 against the Vallado et al. (2006) verification set: 33 objects
//! covering near-Earth drag, deep-space resonance (12 h and 24 h), Lyddane
//! singularities, low perigee and decay.

use orbit_explorer_engine::sgp4::OpsMode;
use orbit_explorer_engine::verification::{expected_errors, load, run};

const TLE: &str = include_str!("../testdata/SGP4-VER.TLE");
const OUT: &str = include_str!("../testdata/tcppver.out");

#[test]
fn matches_vallado_reference_output() {
    let cases = load(TLE, OUT);
    assert_eq!(cases.len(), 33);
    let samples = run(&cases, OpsMode::Improved);
    assert!(samples.len() > 500, "only {} rows compared", samples.len());

    let worst_r = samples.iter().max_by(|a, b| a.dr_km.total_cmp(&b.dr_km)).unwrap();
    let worst_v = samples.iter().max_by(|a, b| a.dv_kms.total_cmp(&b.dv_kms)).unwrap();
    println!(
        "{} rows; max |dr| = {:.3e} km (sat {} t={}), max |dv| = {:.3e} km/s (sat {} t={})",
        samples.len(), worst_r.dr_km, worst_r.satnum, worst_r.tsince, worst_v.dv_kms, worst_v.satnum, worst_v.tsince
    );
    // the reference prints 8 decimals of km: anything below ~1e-6 km is print rounding
    assert!(worst_r.dr_km < 1e-6, "position error {:.3e} km", worst_r.dr_km);
    assert!(worst_v.dv_kms < 1e-8, "velocity error {:.3e} km/s", worst_v.dv_kms);
}

/// Objects whose reference output stops early must fail at exactly that step
/// with a real SGP4 error (decay, eccentricity blow-up, ...), not silently continue.
#[test]
fn reproduces_reference_error_cases() {
    let cases = load(TLE, OUT);
    let errs = expected_errors(&cases, OpsMode::Improved);
    for (sat, t, code) in &errs {
        println!("sat {sat}: error {code} at t = {t} min");
    }
    // eccentricity x2, decay x2, semi-latus rectum, perturbed eccentricity, decay:
    // the same sequence python-sgp4's verification run reports
    let codes: Vec<u8> = errs.iter().map(|e| e.2).collect();
    assert_eq!(codes, vec![1, 1, 6, 6, 4, 3, 6]);
}
