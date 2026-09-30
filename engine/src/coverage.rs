//! Coverage map: how many satellites each lat/lon cell sees above a minimum
//! elevation. Instead of testing every cell against every satellite, each
//! satellite stamps its visibility cap onto the grid.
//!
//! For a satellite at geocentric radius r, the ground cap that sees it above
//! elevation e has Earth-central half-angle
//!     lambda = acos(R cos(e) / r) - e
//! and a cell is inside when the angle between the cell centre and the
//! sub-satellite point is below lambda.

use crate::frames::{norm, V3};
use std::f64::consts::{FRAC_PI_2, PI};

/// Mean Earth radius (km) - the cap geometry is spherical.
pub const R_MEAN: f64 = 6371.0;

pub fn cap_half_angle(r: f64, min_elev: f64) -> f64 {
    ((R_MEAN * min_elev.cos() / r).clamp(-1.0, 1.0)).acos() - min_elev
}

/// Row-major grid (row 0 = southernmost), `nlat` x `nlon` cells, longitudes from -180.
pub fn coverage_grid(sats_ecef: impl Iterator<Item = V3>, nlat: usize, nlon: usize, min_elev_rad: f64, out: &mut Vec<u16>) {
    out.clear();
    out.resize(nlat * nlon, 0);
    let dlat = PI / nlat as f64;
    let dlon = 2.0 * PI / nlon as f64;
    // cell-centre unit vectors are separable: precompute sin/cos per row and column
    let rows: Vec<(f64, f64)> = (0..nlat).map(|i| (-FRAC_PI_2 + (i as f64 + 0.5) * dlat).sin_cos()).collect();
    let cols: Vec<(f64, f64)> = (0..nlon).map(|j| (-PI + (j as f64 + 0.5) * dlon).sin_cos()).collect();

    for p in sats_ecef {
        let r = norm(p);
        if r <= R_MEAN + 100.0 {
            continue;
        }
        let lambda = cap_half_angle(r, min_elev_rad);
        if lambda <= 0.0 {
            continue;
        }
        let cos_l = lambda.cos();
        let s = [p[0] / r, p[1] / r, p[2] / r];
        let lat = s[2].asin();
        let lon = s[1].atan2(s[0]);

        let i0 = (((lat - lambda + FRAC_PI_2) / dlat).floor().max(0.0)) as usize;
        let i1 = ((((lat + lambda + FRAC_PI_2) / dlat).ceil()) as usize).min(nlat);
        let polar = lat.abs() + lambda >= FRAC_PI_2;
        let half_width = if polar { PI } else { (lambda.sin() / lat.cos()).clamp(-1.0, 1.0).asin() + dlon };
        let span = ((half_width / dlon).ceil() as i64).min(nlon as i64 / 2);
        let jc = ((lon + PI) / dlon).floor() as i64;

        for i in i0..i1 {
            let (sin_lat, cos_lat) = rows[i];
            let row = &mut out[i * nlon..(i + 1) * nlon];
            let (lo, hi) = if polar { (0, nlon as i64 - 1) } else { (jc - span, jc + span) };
            for jj in lo..=hi {
                let j = jj.rem_euclid(nlon as i64) as usize;
                let (sin_lon, cos_lon) = cols[j];
                let d = cos_lat * cos_lon * s[0] + cos_lat * sin_lon * s[1] + sin_lat * s[2];
                if d >= cos_l {
                    row[j] = row[j].saturating_add(1);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cap_matches_textbook_value() {
        // 550 km, 25 deg elevation -> ~8.4 deg central angle (~940 km ground radius)
        let lam = cap_half_angle(R_MEAN + 550.0, 25f64.to_radians());
        assert!((lam.to_degrees() - 8.43).abs() < 0.05, "{}", lam.to_degrees());
    }

    #[test]
    fn stamp_matches_brute_force() {
        let nlat = 90;
        let nlon = 180;
        let min_el = 25f64.to_radians();
        let sats: Vec<V3> = vec![[6921.0, 0.0, 0.0], [0.0, 0.0, 6921.0], [3000.0, -4000.0, 5000.0], [-6000.0, 100.0, -3500.0]];
        let mut fast = Vec::new();
        coverage_grid(sats.iter().copied(), nlat, nlon, min_el, &mut fast);
        for i in 0..nlat {
            for j in 0..nlon {
                let lat = -FRAC_PI_2 + (i as f64 + 0.5) * PI / nlat as f64;
                let lon = -PI + (j as f64 + 0.5) * 2.0 * PI / nlon as f64;
                let c = [lat.cos() * lon.cos(), lat.cos() * lon.sin(), lat.sin()];
                let mut count = 0;
                for p in &sats {
                    let r = norm(*p);
                    let lam = cap_half_angle(r, min_el);
                    let d = (c[0] * p[0] + c[1] * p[1] + c[2] * p[2]) / r;
                    if d >= lam.cos() {
                        count += 1;
                    }
                }
                assert_eq!(fast[i * nlon + j], count, "cell {i},{j}");
            }
        }
    }
}
