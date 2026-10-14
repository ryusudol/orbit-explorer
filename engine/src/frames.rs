//! Reference frames: TEME (SGP4 output) -> ECEF (Earth-fixed) -> geodetic (WGS-84).
//!
//! TEME -> ECEF is a single rotation by Greenwich mean sidereal time about +Z.
//! Polar motion (< 15 m) is ignored, and UT1 is taken as UTC.

pub type V3 = [f64; 3];

pub const WGS84_A: f64 = 6378.137;
pub const WGS84_F: f64 = 1.0 / 298.257223563;
pub const WGS84_E2: f64 = WGS84_F * (2.0 - WGS84_F);
/// Earth rotation rate, rad/s (IERS, consistent with IAU-82 GMST).
pub const OMEGA_EARTH: f64 = 7.292115146706979e-5;
/// Speed of light in vacuum, km/s.
pub const C_KM_S: f64 = 299_792.458;

#[inline]
pub fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
#[inline]
pub fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
#[inline]
pub fn scale(a: V3, s: f64) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
#[inline]
pub fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
#[inline]
pub fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
#[inline]
pub fn norm(a: V3) -> f64 {
    dot(a, a).sqrt()
}
#[inline]
pub fn dist(a: V3, b: V3) -> f64 {
    norm(sub(a, b))
}
#[inline]
pub fn v3(s: &[f64], i: usize) -> V3 {
    [s[3 * i], s[3 * i + 1], s[3 * i + 2]]
}

/// Rotate a TEME vector into the Earth-fixed (pseudo-Earth-fixed) frame.
#[inline]
pub fn teme_to_ecef(r: V3, gmst: f64) -> V3 {
    let (s, c) = gmst.sin_cos();
    [c * r[0] + s * r[1], -s * r[0] + c * r[1], r[2]]
}

#[inline]
pub fn ecef_to_teme(r: V3, gmst: f64) -> V3 {
    let (s, c) = gmst.sin_cos();
    [c * r[0] - s * r[1], s * r[0] + c * r[1], r[2]]
}

/// Earth-fixed velocity, removing the frame rotation (v_ecef = R v_teme - w x r_ecef).
pub fn teme_to_ecef_velocity(r_teme: V3, v_teme: V3, gmst: f64) -> V3 {
    let r = teme_to_ecef(r_teme, gmst);
    let v = teme_to_ecef(v_teme, gmst);
    [v[0] + OMEGA_EARTH * r[1], v[1] - OMEGA_EARTH * r[0], v[2]]
}

/// ECEF (km) -> geodetic latitude, longitude (radians) and height (km) on WGS-84.
pub fn ecef_to_geodetic(r: V3) -> (f64, f64, f64) {
    let p = (r[0] * r[0] + r[1] * r[1]).sqrt();
    let lon = r[1].atan2(r[0]);
    let mut lat = r[2].atan2(p * (1.0 - WGS84_E2));
    let mut n = WGS84_A;
    for _ in 0..6 {
        let s = lat.sin();
        n = WGS84_A / (1.0 - WGS84_E2 * s * s).sqrt();
        let h = p * lat.cos() + (r[2] + WGS84_E2 * n * s) * s - n;
        lat = r[2].atan2(p * (1.0 - WGS84_E2 * n / (n + h)));
    }
    let s = lat.sin();
    let h = p * lat.cos() + (r[2] + WGS84_E2 * n * s) * s - n;
    (lat, lon, h)
}

pub fn geodetic_to_ecef(lat: f64, lon: f64, h: f64) -> V3 {
    let (sl, cl) = lat.sin_cos();
    let (so, co) = lon.sin_cos();
    let n = WGS84_A / (1.0 - WGS84_E2 * sl * sl).sqrt();
    [(n + h) * cl * co, (n + h) * cl * so, (n * (1.0 - WGS84_E2) + h) * sl]
}

/// Local "up" (ellipsoid normal) in ECEF.
pub fn up_ecef(lat: f64, lon: f64) -> V3 {
    let (sl, cl) = lat.sin_cos();
    let (so, co) = lon.sin_cos();
    [cl * co, cl * so, sl]
}

/// Azimuth (from north, clockwise), elevation (radians) and range (km) of an
/// Earth-fixed target seen from a station at geodetic (lat, lon, h).
pub fn look_angles(lat: f64, lon: f64, h: f64, target_ecef: V3) -> (f64, f64, f64) {
    let site = geodetic_to_ecef(lat, lon, h);
    let rho = sub(target_ecef, site);
    let (sl, cl) = lat.sin_cos();
    let (so, co) = lon.sin_cos();
    let east = [-so, co, 0.0];
    let north = [-sl * co, -sl * so, cl];
    let up = [cl * co, cl * so, sl];
    let e = dot(rho, east);
    let n = dot(rho, north);
    let u = dot(rho, up);
    let range = norm(rho);
    // atan2 keeps full precision near the zenith, where asin(u / range) does not
    let el = u.atan2((e * e + n * n).sqrt());
    let mut az = e.atan2(n);
    if az < 0.0 {
        az += 2.0 * std::f64::consts::PI;
    }
    (az, el, range)
}

/// Elevation of `target` above the horizon plane at `site` with local `up`.
#[inline]
pub fn elevation(site: V3, up: V3, target: V3) -> f64 {
    let rho = sub(target, site);
    (dot(rho, up) / norm(rho)).asin()
}

/// True when the straight segment a-b stays above `radius` km from Earth's center.
pub fn line_of_sight(a: V3, b: V3, radius: f64) -> bool {
    let d = sub(b, a);
    let dd = dot(d, d);
    if dd == 0.0 {
        return norm(a) > radius;
    }
    let t = (-dot(a, d) / dd).clamp(0.0, 1.0);
    let closest = add(a, scale(d, t));
    norm(closest) > radius
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    #[test]
    fn geodetic_roundtrip() {
        for &(lat, lon, h) in &[(0.0, 0.0, 0.0), (51.5, -0.12, 0.05), (-33.9, 151.2, 550.0), (89.9, 10.0, 35786.0), (-89.99, -170.0, 1.0)] {
            let r = geodetic_to_ecef(lat * PI / 180.0, lon * PI / 180.0, h);
            let (la, lo, hh) = ecef_to_geodetic(r);
            assert!((la * 180.0 / PI - lat).abs() < 1e-9, "lat {lat}");
            assert!((lo * 180.0 / PI - lon).abs() < 1e-9, "lon {lon}");
            assert!((hh - h).abs() < 1e-6, "h {h} vs {hh}");
        }
    }

    #[test]
    fn zenith_is_ninety_degrees() {
        let (lat, lon) = (0.7, -1.2);
        let up = up_ecef(lat, lon);
        let site = geodetic_to_ecef(lat, lon, 0.0);
        let target = add(site, scale(up, 550.0));
        let (_, el, range) = look_angles(lat, lon, 0.0, target);
        assert!((el - PI / 2.0).abs() < 1e-9);
        assert!((range - 550.0).abs() < 1e-9);
    }

    #[test]
    fn teme_ecef_inverse() {
        let r = [7000.0, -1234.5, 42.0];
        let back = ecef_to_teme(teme_to_ecef(r, 1.234), 1.234);
        assert!(dist(r, back) < 1e-9);
    }

    #[test]
    fn los_blocked_through_earth() {
        assert!(!line_of_sight([7000.0, 0.0, 0.0], [-7000.0, 0.0, 0.0], 6458.0));
        assert!(line_of_sight([6928.0, 0.0, 0.0], [6928.0 * 0.95, 6928.0 * 0.31, 0.0], 6458.0));
    }
}
