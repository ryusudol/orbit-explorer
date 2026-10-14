//! wasm-bindgen surface. Bulk outputs stay in WASM memory; JS reads them
//! through `*_ptr()` views over `memory.buffer` instead of copying per call.

use crate::batch::Batch;
use crate::conjunction;
use crate::coverage::coverage_grid;
use crate::frames::{ecef_to_geodetic, ecef_to_teme, geodetic_to_ecef, teme_to_ecef, v3};
use crate::isl::{self, IslConfig, IslGraph, Terminal};
use crate::sgp4::gstime;
use crate::sun::{illumination as illum, sun_position};
use std::f64::consts::PI;
use wasm_bindgen::prelude::*;

const DEG: f64 = PI / 180.0;

#[wasm_bindgen]
pub fn gmst(jd: f64) -> f64 {
    gstime(jd)
}

/// Sun position in TEME (~ mean-of-date), km.
#[wasm_bindgen]
pub fn sun_position_teme(jd: f64) -> Vec<f64> {
    sun_position(jd).to_vec()
}

/// [lat_deg, lon_deg, alt_km] of a TEME position at `jd`.
#[wasm_bindgen]
pub fn teme_to_geodetic(x: f64, y: f64, z: f64, jd: f64) -> Vec<f64> {
    let (lat, lon, h) = ecef_to_geodetic(teme_to_ecef([x, y, z], gstime(jd)));
    vec![lat / DEG, lon / DEG, h]
}

/// TEME position (km) of a geodetic point at `jd`.
#[wasm_bindgen]
pub fn geodetic_to_teme(lat_deg: f64, lon_deg: f64, alt_km: f64, jd: f64) -> Vec<f64> {
    ecef_to_teme(geodetic_to_ecef(lat_deg * DEG, lon_deg * DEG, alt_km), gstime(jd)).to_vec()
}

#[wasm_bindgen]
pub fn illumination(x: f64, y: f64, z: f64, jd: f64) -> f64 {
    illum([x, y, z], sun_position(jd))
}

// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct Propagator {
    batch: Batch,
}

#[wasm_bindgen]
impl Propagator {
    /// `packed`: 8 f64 per object, see `batch::ELEMENT_STRIDE`.
    #[wasm_bindgen(constructor)]
    pub fn new(packed: &[f64]) -> Propagator {
        Propagator { batch: Batch::from_packed(packed) }
    }

    pub fn len(&self) -> usize {
        self.batch.len()
    }

    /// Propagate every object to `jd` (with eclipse state). Returns the number that succeeded.
    pub fn propagate(&mut self, jd: f64) -> u32 {
        self.batch.propagate(jd, true) as u32
    }

    pub fn pos_ptr(&self) -> *const f64 {
        self.batch.pos.as_ptr()
    }
    pub fn vel_ptr(&self) -> *const f64 {
        self.batch.vel.as_ptr()
    }
    pub fn status_ptr(&self) -> *const u8 {
        self.batch.status.as_ptr()
    }
    pub fn illum_ptr(&self) -> *const u8 {
        self.batch.illum.as_ptr()
    }

    /// `[x, y, z, vx, vy, vz]` in TEME, or an empty array on SGP4 error.
    pub fn state_at(&mut self, idx: usize, jd: f64) -> Vec<f64> {
        match self.batch.sats[idx].propagate_jd(jd) {
            Ok((r, v)) => vec![r[0], r[1], r[2], v[0], v[1], v[2]],
            Err(_) => Vec::new(),
        }
    }

    /// TEME positions at each of `jds`; NaN where SGP4 fails.
    pub fn track(&mut self, idx: usize, jds: &[f64]) -> Vec<f64> {
        let mut out = Vec::with_capacity(3 * jds.len());
        let sat = &mut self.batch.sats[idx];
        for &jd in jds {
            match sat.propagate_jd(jd) {
                Ok((r, _)) => out.extend_from_slice(&r),
                Err(_) => out.extend_from_slice(&[f64::NAN; 3]),
            }
        }
        out
    }

    /// Distance (km) between objects `a` and `b` at `n` times over [jd0, jd1].
    pub fn range_series(&mut self, a: usize, b: usize, jd0: f64, jd1: f64, n: usize) -> Vec<f64> {
        let mut out = Vec::with_capacity(n);
        for k in 0..n {
            let jd = jd0 + (jd1 - jd0) * k as f64 / (n.max(2) - 1) as f64;
            let ra = self.batch.sats[a].propagate_jd(jd);
            let rb = self.batch.sats[b].propagate_jd(jd);
            out.push(match (ra, rb) {
                (Ok((ra, _)), Ok((rb, _))) => crate::frames::dist(ra, rb),
                _ => f64::NAN,
            });
        }
        out
    }

    /// `[a_km, ecc, incl_deg, period_min, perigee_alt_km, apogee_alt_km, deep_space]` from the epoch elements.
    pub fn info(&self, idx: usize) -> Vec<f64> {
        let s = &self.batch.sats[idx];
        let re = s.radius_earth_km();
        let a = s.semi_major_axis_km();
        let period = 2.0 * PI / s.no_unkozai;
        vec![a, s.ecco, s.inclo / DEG, period, s.altp * re, s.alta * re, if s.deep_space { 1.0 } else { 0.0 }]
    }
}

// ---------------------------------------------------------------------------

/// Laser-link network over a constellation subset, plus coverage.
#[wasm_bindgen]
pub struct Network {
    batch: Batch,
    graph: IslGraph,
    cfg: IslConfig,
    jd: f64,
    edges_flat: Vec<u32>,
    coverage: Vec<u16>,
}

#[wasm_bindgen]
impl Network {
    #[wasm_bindgen(constructor)]
    pub fn new(packed: &[f64]) -> Network {
        Network { batch: Batch::from_packed(packed), graph: IslGraph::default(), cfg: IslConfig::default(), jd: 0.0, edges_flat: Vec::new(), coverage: Vec::new() }
    }

    /// Propagate the constellation to `jd` and rebuild the link graph. Returns the edge count.
    pub fn update(&mut self, jd: f64) -> u32 {
        self.jd = jd;
        self.batch.propagate(jd, false);
        self.graph = isl::build(&self.batch, &self.cfg);
        self.edges_flat.clear();
        for e in &self.graph.edges {
            self.edges_flat.extend_from_slice(e);
        }
        self.graph.edges.len() as u32
    }

    pub fn edges_ptr(&self) -> *const u32 {
        self.edges_flat.as_ptr()
    }
    pub fn edges_len(&self) -> usize {
        self.edges_flat.len()
    }

    /// Satellites that carry links (belong to a recognized shell).
    pub fn linked_count(&self) -> u32 {
        self.graph.shell_of.iter().filter(|&&s| s >= 0).count() as u32
    }

    /// `[incl_deg, alt_km, satellites, planes]` per shell, flattened.
    pub fn shells(&self) -> Vec<f64> {
        self.graph.shells.iter().flat_map(|s| [s.inclination_deg, s.altitude_km, s.satellites as f64, s.planes as f64]).collect()
    }

    /// `[total_km, uplink_km, downlink_km, hops, idx...]`, or empty when unreachable.
    pub fn route(&self, src_lat: f64, src_lon: f64, dst_lat: f64, dst_lon: f64, min_elev_deg: f64) -> Vec<f64> {
        let g = gstime(self.jd);
        let src = Terminal::new(src_lat, src_lon, g);
        let dst = Terminal::new(dst_lat, dst_lon, g);
        match isl::route(&self.graph, &self.batch, &src, &dst, min_elev_deg) {
            Some(r) => {
                let mut out = vec![r.total_km, r.uplink_km, r.downlink_km, r.path.len() as f64];
                out.extend(r.path.iter().map(|&i| i as f64));
                out
            }
            None => Vec::new(),
        }
    }

    /// Visible-satellite count per cell (u16, row-major, south to north) at the last update.
    pub fn compute_coverage(&mut self, nlat: usize, nlon: usize, min_elev_deg: f64) -> *const u16 {
        let g = gstime(self.jd);
        let b = &self.batch;
        let shells = &self.graph.shell_of;
        let iter = (0..b.len()).filter(|&i| b.ok[i] && shells[i] >= 0).map(|i| teme_to_ecef(v3(&b.pos, i), g));
        coverage_grid(iter, nlat, nlon, min_elev_deg * DEG, &mut self.coverage);
        self.coverage.as_ptr()
    }
}

// ---------------------------------------------------------------------------

#[wasm_bindgen]
pub struct Screener {
    inner: conjunction::Screener,
}

#[wasm_bindgen]
impl Screener {
    #[wasm_bindgen(constructor)]
    pub fn new(packed: &[f64]) -> Screener {
        Screener { inner: conjunction::Screener::new(Batch::from_packed(packed)) }
    }

    pub fn begin(&mut self, jd0: f64, duration_min: f64, step_s: f64, threshold_km: f64) {
        self.inner.begin(jd0, duration_min, step_s, threshold_km);
    }

    /// Screen part `part` of `parts` of the window (see `conjunction::Screener::begin_part`).
    pub fn begin_part(&mut self, jd0: f64, duration_min: f64, step_s: f64, threshold_km: f64, part: u32, parts: u32) {
        self.inner.begin_part(jd0, duration_min, step_s, threshold_km, part, parts);
    }

    /// Run up to `max_steps` samples; returns progress 0..1.
    pub fn advance(&mut self, max_steps: u32) -> f64 {
        self.inner.advance(max_steps)
    }

    /// `[a, b, tca_jd, miss_km, rel_speed_kms]` per event, closest first.
    pub fn events(&self) -> Vec<f64> {
        self.inner.events().iter().flat_map(|e| [e.a as f64, e.b as f64, e.tca_jd, e.miss_km, e.rel_speed_kms]).collect()
    }

    /// `[steps, candidate_pairs, refined, formation_pairs]`
    pub fn stats(&self) -> Vec<f64> {
        let s = self.inner.stats;
        vec![s.steps as f64, s.candidate_pairs as f64, s.refined as f64, s.formation_pairs as f64]
    }

    // --- single-instant benchmark hooks (timed from JS) ---

    pub fn propagate_all(&mut self, jd: f64) -> u32 {
        self.inner.batch.propagate(jd, false) as u32
    }

    pub fn grid_pairs(&mut self, radius_km: f64) -> f64 {
        self.inner.grid_pairs_now(radius_km) as f64
    }

    pub fn brute_pairs(&self, radius_km: f64) -> f64 {
        self.inner.brute_pairs_now(radius_km) as f64
    }

    pub fn active_count(&self) -> u32 {
        self.inner.batch.ok.iter().filter(|&&o| o).count() as u32
    }
}
