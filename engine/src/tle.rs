//! Two-line element parsing (fixed columns, following the reference `twoline2rv`).

use crate::sgp4::Elements;
use crate::time::tle_epoch_to_jd;

fn field(line: &str, a: usize, b: usize) -> Result<&str, String> {
    line.get(a..b).ok_or_else(|| format!("line too short for columns {a}..{b}: {line:?}"))
}

fn float(s: &str) -> Result<f64, String> {
    let t = s.trim();
    if t.is_empty() {
        return Ok(0.0);
    }
    t.parse::<f64>().map_err(|e| format!("bad number {s:?}: {e}"))
}

/// Parses an "assumed decimal point" field such as ` 28098-4` into 0.28098e-4.
fn implied_decimal(mantissa_sign_and_digits: &str, exponent: &str) -> Result<f64, String> {
    let m = mantissa_sign_and_digits;
    let (sign, digits) = match m.chars().next() {
        Some('-') => (-1.0, &m[1..]),
        Some('+') | Some(' ') => (1.0, &m[1..]),
        _ => (1.0, m),
    };
    let digits = digits.trim();
    if digits.is_empty() {
        return Ok(0.0);
    }
    let mantissa: f64 = format!("0.{}", digits.replace(' ', "0")).parse().map_err(|e| format!("bad mantissa {m:?}: {e}"))?;
    let exp: i32 = exponent.trim().replace('+', "").parse().unwrap_or(0);
    Ok(sign * mantissa * 10f64.powi(exp))
}

/// Alpha-5 catalogue numbers: A0000 = 100000 (letters I and O are skipped).
fn satnum(s: &str) -> Result<u32, String> {
    let s = s.trim();
    let first = s.chars().next().ok_or("empty catalogue number")?;
    if first.is_ascii_alphabetic() {
        let letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
        let idx = letters.find(first.to_ascii_uppercase()).ok_or("bad alpha-5 letter")? as u32;
        let rest: u32 = s[1..].parse().map_err(|_| "bad alpha-5 digits")?;
        Ok((idx + 10) * 10000 + rest)
    } else {
        s.parse().map_err(|_| format!("bad catalogue number {s:?}"))
    }
}

pub fn parse_tle(line1: &str, line2: &str) -> Result<Elements, String> {
    let l1 = line1.trim_end();
    let l2 = line2.trim_end();
    if !l1.starts_with("1 ") || !l2.starts_with("2 ") {
        return Err("TLE lines must start with '1 ' and '2 '".into());
    }
    let id1 = satnum(field(l1, 2, 7)?)?;
    let id2 = satnum(field(l2, 2, 7)?)?;
    if id1 != id2 {
        return Err(format!("catalogue numbers differ: {id1} vs {id2}"));
    }
    let two_digit_year: u32 = field(l1, 18, 20)?.trim().parse().map_err(|_| "bad epoch year")?;
    let epoch_days = float(field(l1, 20, 32)?)?;
    let ndot = float(field(l1, 33, 43)?)?;
    let nddot = implied_decimal(field(l1, 44, 50)?, field(l1, 50, 52)?)?;
    let bstar = implied_decimal(field(l1, 53, 59)?, field(l1, 59, 61)?)?;

    let inclination_deg = float(field(l2, 8, 16)?)?;
    let raan_deg = float(field(l2, 17, 25)?)?;
    let eccentricity = format!("0.{}", field(l2, 26, 33)?.replace(' ', "0")).parse::<f64>().map_err(|e| e.to_string())?;
    let arg_perigee_deg = float(field(l2, 34, 42)?)?;
    let mean_anomaly_deg = float(field(l2, 43, 51)?)?;
    let mean_motion = float(field(l2, 52, 63)?)?;

    Ok(Elements {
        norad_id: id1,
        epoch_jd: tle_epoch_to_jd(two_digit_year, epoch_days),
        mean_motion,
        eccentricity,
        inclination_deg,
        raan_deg,
        arg_perigee_deg,
        mean_anomaly_deg,
        bstar,
        ndot,
        nddot,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_iss_style_tle() {
        let l1 = "1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753";
        let l2 = "2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667";
        let e = parse_tle(l1, l2).unwrap();
        assert_eq!(e.norad_id, 5);
        assert!((e.bstar - 0.28098e-4).abs() < 1e-15);
        assert!((e.eccentricity - 0.1859667).abs() < 1e-15);
        assert!((e.mean_motion - 10.82419157).abs() < 1e-12);
        assert!((e.inclination_deg - 34.2682).abs() < 1e-12);
    }

    #[test]
    fn alpha5() {
        assert_eq!(satnum("A0000").unwrap(), 100000);
        assert_eq!(satnum("Z9999").unwrap(), 339999);
        assert_eq!(satnum("12345").unwrap(), 12345);
    }
}
