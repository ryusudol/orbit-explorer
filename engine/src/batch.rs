//! A batch of objects propagated together into flat, xyz-interleaved buffers
//! that JS can view directly from WASM memory.

use crate::frames::v3;
use crate::sgp4::{Elements, Gravity, OpsMode, Satrec};
use crate::sun::{illumination, sun_position};

/// Packed element layout shared with the snapshot decoder in the web app:
/// `[epoch_jd, mean_motion_rev_per_day, ecc, incl_deg, raan_deg, argp_deg, mean_anom_deg, bstar]`
pub const ELEMENT_STRIDE: usize = 8;

pub fn elements_from_packed(packed: &[f64]) -> Vec<Elements> {
    packed
        .chunks_exact(ELEMENT_STRIDE)
        .map(|e| Elements {
            norad_id: 0,
            epoch_jd: e[0],
            mean_motion: e[1],
            eccentricity: e[2],
            inclination_deg: e[3],
            raan_deg: e[4],
            arg_perigee_deg: e[5],
            mean_anomaly_deg: e[6],
            bstar: e[7],
            ndot: 0.0,
            nddot: 0.0,
        })
        .collect()
}

pub struct Batch {
    pub sats: Vec<Satrec>,
    /// TEME position, km
    pub pos: Vec<f64>,
    /// TEME velocity, km/s
    pub vel: Vec<f64>,
    /// 0 = ok, otherwise the SGP4 error code
    pub status: Vec<u8>,
    /// Sunlit fraction 0..255
    pub illum: Vec<u8>,
    pub ok: Vec<bool>,
}

impl Batch {
    pub fn from_elements(elements: &[Elements]) -> Batch {
        let grav = Gravity::wgs72();
        let sats: Vec<Satrec> = elements.iter().map(|e| Satrec::new(e, grav, OpsMode::Improved)).collect();
        let n = sats.len();
        Batch { sats, pos: vec![0.0; 3 * n], vel: vec![0.0; 3 * n], status: vec![0; n], illum: vec![0; n], ok: vec![false; n] }
    }

    pub fn from_packed(packed: &[f64]) -> Batch {
        Batch::from_elements(&elements_from_packed(packed))
    }

    pub fn len(&self) -> usize {
        self.sats.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sats.is_empty()
    }

    /// Propagate every object to `jd`. Returns how many succeeded.
    pub fn propagate(&mut self, jd: f64, with_illumination: bool) -> usize {
        let sun = if with_illumination { sun_position(jd) } else { [0.0; 3] };
        let mut good = 0;
        for (i, sat) in self.sats.iter_mut().enumerate() {
            match sat.propagate_jd(jd) {
                Ok((r, v)) => {
                    self.pos[3 * i..3 * i + 3].copy_from_slice(&r);
                    self.vel[3 * i..3 * i + 3].copy_from_slice(&v);
                    self.status[i] = 0;
                    self.ok[i] = true;
                    if with_illumination {
                        self.illum[i] = (illumination(r, sun) * 255.0).round() as u8;
                    }
                    good += 1;
                }
                Err(code) => {
                    self.pos[3 * i..3 * i + 3].fill(0.0);
                    self.vel[3 * i..3 * i + 3].fill(0.0);
                    self.status[i] = code;
                    self.ok[i] = false;
                }
            }
        }
        good
    }

    #[inline]
    pub fn position(&self, i: usize) -> [f64; 3] {
        v3(&self.pos, i)
    }

    #[inline]
    pub fn velocity(&self, i: usize) -> [f64; 3] {
        v3(&self.vel, i)
    }
}
