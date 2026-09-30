//! Time scales. The engine works in UTC Julian dates and treats UT1 = UTC
//! (|UT1-UTC| < 0.9 s, i.e. < 0.4 km of Earth rotation at the equator).

pub const JD_UNIX_EPOCH: f64 = 2440587.5;
pub const MS_PER_DAY: f64 = 86_400_000.0;

/// Julian date split into whole-day and fractional parts (Vallado `jday`).
pub fn jday(year: i32, mon: u32, day: u32, hr: u32, minute: u32, sec: f64) -> (f64, f64) {
    let year = year as f64;
    let mon = mon as f64;
    let jd = 367.0 * year - ((7.0 * (year + ((mon + 9.0) / 12.0).floor())) * 0.25).floor()
        + (275.0 * mon / 9.0).floor()
        + day as f64
        + 1721013.5;
    let mut jd_frac = (sec + minute as f64 * 60.0 + hr as f64 * 3600.0) / 86400.0;
    let mut jd = jd;
    if jd_frac.abs() > 1.0 {
        let dtt = jd_frac.floor();
        jd += dtt;
        jd_frac -= dtt;
    }
    (jd, jd_frac)
}

pub fn unix_ms_to_jd(ms: f64) -> f64 {
    ms / MS_PER_DAY + JD_UNIX_EPOCH
}

pub fn jd_to_unix_ms(jd: f64) -> f64 {
    (jd - JD_UNIX_EPOCH) * MS_PER_DAY
}

/// Julian date of a TLE epoch given as two-digit year + fractional day of year.
pub fn tle_epoch_to_jd(two_digit_year: u32, day_of_year: f64) -> f64 {
    // Years 57..99 are 1957..1999, 00..56 are 2000..2056 (the TLE convention).
    let year = if two_digit_year < 57 { 2000 + two_digit_year as i32 } else { 1900 + two_digit_year as i32 };
    let (jd, frac) = jday(year, 1, 1, 0, 0, 0.0);
    jd + frac + day_of_year - 1.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn j2000_epoch() {
        let (jd, frac) = jday(2000, 1, 1, 12, 0, 0.0);
        assert_eq!(jd + frac, 2451545.0);
    }

    #[test]
    fn unix_roundtrip() {
        let jd = unix_ms_to_jd(0.0);
        assert_eq!(jd, 2440587.5);
        assert!((jd_to_unix_ms(2451545.0) - 946_728_000_000.0).abs() < 1e-3);
    }

    #[test]
    fn tle_epoch() {
        // 00179.78495062 -> 2000-06-27 18:50:19.73 UTC
        let jd = tle_epoch_to_jd(0, 179.78495062);
        let (j, f) = jday(2000, 6, 27, 18, 50, 19.733568);
        assert!((jd - (j + f)).abs() < 1e-8);
    }
}
