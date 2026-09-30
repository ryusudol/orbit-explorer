//! Vallado et al. (2006) verification set: `SGP4-VER.TLE` + `tcppver.out`.
//! Compiled for native targets only (tests, the `validate` example).

use crate::sgp4::{Gravity, OpsMode, Satrec};
use crate::tle::parse_tle;

pub struct Case {
    pub satnum: u32,
    pub line1: String,
    pub line2: String,
    /// (tsince min, r km, v km/s) rows from the reference output
    pub expected: Vec<(f64, [f64; 3], [f64; 3])>,
    /// When the reference stops early, the time at which SGP4 must report an error.
    pub error_at: Option<f64>,
}

pub struct Sample {
    pub satnum: u32,
    pub tsince: f64,
    pub dr_km: f64,
    pub dv_kms: f64,
    pub deep_space: bool,
}

pub fn load(tle_text: &str, out_text: &str) -> Vec<Case> {
    let mut tles = Vec::new();
    let mut lines = tle_text.lines().filter(|l| !l.starts_with('#') && !l.trim().is_empty());
    while let (Some(l1), Some(l2)) = (lines.next(), lines.next()) {
        tles.push((l1.to_string(), l2.to_string()));
    }

    let mut blocks: Vec<(u32, Vec<(f64, [f64; 3], [f64; 3])>)> = Vec::new();
    for line in out_text.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() == 2 && f[1] == "xx" {
            blocks.push((f[0].parse().unwrap(), Vec::new()));
        } else if f.len() >= 7 {
            let n: Vec<f64> = f[..7].iter().map(|x| x.parse().unwrap()).collect();
            blocks.last_mut().unwrap().1.push((n[0], [n[1], n[2], n[3]], [n[4], n[5], n[6]]));
        }
    }
    assert_eq!(tles.len(), blocks.len(), "TLE count vs output blocks");

    // The C++ driver prints whatever is left in its state buffer when SGP4
    // fails at t = 0, i.e. the previous object's last row. Drop those rows.
    let mut prev_last: Option<[f64; 3]> = None;
    for (_, rows) in blocks.iter_mut() {
        let last = rows.last().map(|r| r.1);
        if let (Some(first), Some(prev)) = (rows.first(), prev_last) {
            if first.0 == 0.0 && first.1 == prev {
                rows.remove(0);
            }
        }
        prev_last = last;
    }

    tles.into_iter()
        .zip(blocks)
        .map(|((line1, line2), (satnum, expected))| {
            let span: Vec<f64> = line2.get(69..).unwrap_or("").split_whitespace().map(|x| x.parse().unwrap()).collect();
            let (start, stop, step) = (span[0], span[1], span[2]);
            let error_at = match expected.last() {
                None => Some(0.0),
                Some(&(t, _, _)) if t < stop - 1e-6 => {
                    // next time the driver would have asked for
                    let mut next = if t == 0.0 && start != 0.0 { start } else { t + step };
                    if t == 0.0 && start == 0.0 {
                        next = step;
                    }
                    Some(next.min(stop))
                }
                _ => None,
            };
            Case { satnum, line1, line2, expected, error_at }
        })
        .collect()
}

/// SGP4 error codes at each case's `error_at`, in file order.
pub fn expected_errors(cases: &[Case], opsmode: OpsMode) -> Vec<(u32, f64, u8)> {
    let mut out = Vec::new();
    for c in cases {
        let Some(t) = c.error_at else { continue };
        let l2: String = c.line2.chars().take(69).collect();
        let el = parse_tle(&c.line1, &l2).unwrap();
        let mut sat = Satrec::new(&el, Gravity::wgs72(), opsmode);
        let code = match sat.propagate(t) {
            Ok(_) => 0,
            Err(e) => e,
        };
        out.push((c.satnum, t, code));
    }
    out
}

/// Propagate every reference row and report the position/velocity differences.
pub fn run(cases: &[Case], opsmode: OpsMode) -> Vec<Sample> {
    let mut out = Vec::new();
    for c in cases {
        // columns past 69 hold the start/stop/step of the test, not TLE data
        let l2: String = c.line2.chars().take(69).collect();
        let el = parse_tle(&c.line1, &l2).unwrap_or_else(|e| panic!("{}: {e}", c.satnum));
        assert_eq!(el.norad_id, c.satnum);
        let mut sat = Satrec::new(&el, Gravity::wgs72(), opsmode);
        for &(t, r_ref, v_ref) in &c.expected {
            let (r, v) = sat.propagate(t).unwrap_or_else(|e| panic!("{} at {t}: error {e}", c.satnum));
            let dr = ((r[0] - r_ref[0]).powi(2) + (r[1] - r_ref[1]).powi(2) + (r[2] - r_ref[2]).powi(2)).sqrt();
            let dv = ((v[0] - v_ref[0]).powi(2) + (v[1] - v_ref[1]).powi(2) + (v[2] - v_ref[2]).powi(2)).sqrt();
            out.push(Sample { satnum: c.satnum, tsince: t, dr_km: dr, dv_kms: dv, deep_space: sat.deep_space });
        }
    }
    out
}
