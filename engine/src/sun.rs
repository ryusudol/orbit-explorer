//! Sun position and Earth-shadow (eclipse) geometry.

use crate::frames::{dot, norm, sub, V3};
use std::f64::consts::PI;

pub const AU_KM: f64 = 149_597_870.7;
pub const SUN_RADIUS_KM: f64 = 695_700.0;
/// Earth radius used for shadow geometry (equatorial, WGS-84).
pub const EARTH_SHADOW_RADIUS_KM: f64 = 6378.137;

const DEG: f64 = PI / 180.0;

/// Geocentric Sun vector in km, mean equator & equinox of date.
///
/// Low-precision series from the Astronomical Almanac (Vallado, Algorithm 29),
/// good to ~0.01 deg over 1950-2050. The difference between this frame and
/// TEME (nutation) is < 20 arcsec, far below what eclipse shading can resolve.
pub fn sun_position(jd: f64) -> V3 {
    let t = (jd - 2451545.0) / 36525.0;
    let mean_long = (280.460 + 36000.771 * t).rem_euclid(360.0);
    let mean_anom = ((357.5291092 + 35999.05034 * t).rem_euclid(360.0)) * DEG;
    let ecl_long = (mean_long + 1.914666471 * mean_anom.sin() + 0.019994643 * (2.0 * mean_anom).sin()) * DEG;
    let obliquity = (23.439291 - 0.0130042 * t) * DEG;
    let r_au = 1.000140612 - 0.016708617 * mean_anom.cos() - 0.000139589 * (2.0 * mean_anom).cos();
    let r = r_au * AU_KM;
    [r * ecl_long.cos(), r * obliquity.cos() * ecl_long.sin(), r * obliquity.sin() * ecl_long.sin()]
}

/// Right ascension and declination of the Sun (radians).
pub fn sun_ra_dec(jd: f64) -> (f64, f64) {
    let s = sun_position(jd);
    let ra = s[1].atan2(s[0]).rem_euclid(2.0 * PI);
    let dec = (s[2] / norm(s)).asin();
    (ra, dec)
}

/// Fraction of the solar disc visible from `r_sat` (1 = full sun, 0 = umbra).
///
/// Conical shadow: compare the apparent angular radii of Earth and Sun seen
/// from the satellite with the angle between their centers. The penumbra is
/// interpolated linearly across its angular width.
pub fn illumination(r_sat: V3, r_sun: V3) -> f64 {
    let d_earth = norm(r_sat);
    if d_earth <= EARTH_SHADOW_RADIUS_KM {
        return 0.0;
    }
    let to_sun = sub(r_sun, r_sat);
    let d_sun = norm(to_sun);
    let theta_e = (EARTH_SHADOW_RADIUS_KM / d_earth).asin();
    let theta_s = (SUN_RADIUS_KM / d_sun).asin();
    // angle between the directions to Earth's center (-r_sat) and to the Sun
    let c = (-dot(r_sat, to_sun) / (d_earth * d_sun)).clamp(-1.0, 1.0);
    let theta = c.acos();
    if theta >= theta_e + theta_s {
        1.0
    } else if theta <= theta_e - theta_s {
        0.0
    } else {
        ((theta - (theta_e - theta_s)) / (2.0 * theta_s)).clamp(0.0, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frames::{geodetic_to_ecef, look_angles, teme_to_ecef};
    use crate::sgp4::gstime;
    use crate::time::jday;

    /// Meeus, Astronomical Algorithms, Example 25.a (1992 Oct 13.0 TD).
    #[test]
    fn meeus_example_25a() {
        let jd = 2448908.5;
        let (ra, dec) = sun_ra_dec(jd);
        let ra_ref = 198.38083; // 13h13m31.4s
        let dec_ref = -7.78507; // -7 deg 47' 06"
        assert!((ra / DEG - ra_ref).abs() < 0.02, "ra {}", ra / DEG);
        assert!((dec / DEG - dec_ref).abs() < 0.02, "dec {}", dec / DEG);
        let r_au = norm(sun_position(jd)) / AU_KM;
        assert!((r_au - 0.99760775).abs() < 2e-4, "r {r_au}");
    }

    fn sun_elevation_deg(jd: f64, lat: f64, lon: f64) -> f64 {
        let sun_ecef = teme_to_ecef(sun_position(jd), gstime(jd));
        let (_, el, _) = look_angles(lat * DEG, lon * DEG, 0.0, sun_ecef);
        el / DEG
    }

    /// First sunrise (upper limb at the horizon with standard refraction,
    /// elevation = -0.833 deg) after `jd0`, found by scanning then bisecting.
    fn sunrise(jd0: f64, lat: f64, lon: f64) -> f64 {
        let f = |jd: f64| sun_elevation_deg(jd, lat, lon) + 0.833;
        let step = 1.0 / 1440.0;
        let mut a = jd0;
        while !(f(a) < 0.0 && f(a + step) >= 0.0) {
            a += step;
        }
        let mut b = a + step;
        for _ in 0..40 {
            let m = 0.5 * (a + b);
            if f(m) < 0.0 {
                a = m;
            } else {
                b = m;
            }
        }
        0.5 * (a + b)
    }

    fn utc(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> f64 {
        let (j, f) = jday(y, mo, d, h, mi, 0.0);
        j + f
    }

    /// Published sunrise times (USNO / timeanddate, minute precision).
    #[test]
    fn sunrise_matches_published_tables() {
        let cases = [
            // London (51.5074 N, 0.1278 W): 21 Jun 04:43 BST, 21 Dec 08:04 GMT
            (51.5074, -0.1278, (2025, 6, 21), utc(2025, 6, 21, 3, 43)),
            (51.5074, -0.1278, (2025, 12, 21), utc(2025, 12, 21, 8, 4)),
            // New York (40.7128 N, 74.0060 W): 21 Jun 05:25 EDT, 21 Dec 07:17 EST
            (40.7128, -74.0060, (2025, 6, 21), utc(2025, 6, 21, 9, 25)),
            (40.7128, -74.0060, (2025, 12, 21), utc(2025, 12, 21, 12, 17)),
        ];
        for (lat, lon, (y, m, d), expected) in cases {
            let start = utc(y, m, d, 0, 0);
            let got = sunrise(start, lat, lon);
            let err_min = (got - expected) * 1440.0;
            assert!(err_min.abs() < 2.0, "sunrise at ({lat},{lon}) {y}-{m}-{d}: off by {err_min:.2} min");
        }
    }

    #[test]
    fn shadow_behind_earth() {
        let sun = [AU_KM, 0.0, 0.0];
        assert_eq!(illumination([-7000.0, 0.0, 0.0], sun), 0.0);
        assert_eq!(illumination([7000.0, 0.0, 0.0], sun), 1.0);
        assert_eq!(illumination([0.0, 7000.0, 0.0], sun), 1.0);
        // grazing the shadow edge -> penumbra
        let edge = [-7000.0, EARTH_SHADOW_RADIUS_KM + 2.0, 0.0];
        let f = illumination(edge, sun);
        assert!(f > 0.0 && f < 1.0, "penumbra {f}");
        let _ = geodetic_to_ecef(0.0, 0.0, 0.0);
    }
}
