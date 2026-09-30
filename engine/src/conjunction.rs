//! Conjunction screening over the whole catalogue.
//!
//! Every `step` seconds all objects are propagated and bucketed in a spatial
//! hash. Two objects that pass within `threshold` of each other at time of
//! closest approach (TCA) are, at the nearest sample, at most
//! `threshold + v_rel_max * step / 2` apart, so that is the grid radius: the
//! sieve can never miss an encounter. Each surviving pair gets a linear TCA
//! estimate, and pairs whose estimate lands in this sample's window are refined
//! with SGP4 and Newton iterations on d/dt |r_rel|^2 = 0.

use crate::batch::Batch;
use crate::frames::{dot, norm, sub, v3};
use crate::grid::{brute_force_pairs, SpatialHash};
use std::collections::HashMap;

/// Upper bound on relative speed between two Earth-orbiting objects (km/s):
/// head-on LEO (2 x 7.8) plus margin for eccentric orbits at perigee.
pub const V_REL_MAX: f64 = 16.0;
/// Pairs slower than this (km/s) are docked vehicles or formations, not conjunctions.
pub const FORMATION_SPEED: f64 = 0.01;

#[derive(Clone, Copy, Debug)]
pub struct Event {
    pub a: u32,
    pub b: u32,
    pub tca_jd: f64,
    pub miss_km: f64,
    pub rel_speed_kms: f64,
}

#[derive(Default, Clone, Copy, Debug)]
pub struct Stats {
    pub steps: u32,
    pub candidate_pairs: u64,
    pub refined: u64,
    pub formation_pairs: u64,
}

pub struct Screener {
    pub batch: Batch,
    grid: SpatialHash,
    events: HashMap<u64, Event>,
    formations: HashMap<u64, ()>,
    pub stats: Stats,
    // window being screened
    jd0: f64,
    jd_end: f64,
    step_s: f64,
    total_steps: u32,
    threshold_km: f64,
}

impl Screener {
    pub fn new(batch: Batch) -> Screener {
        Screener {
            batch,
            grid: SpatialHash::new(100.0),
            events: HashMap::new(),
            formations: HashMap::new(),
            stats: Stats::default(),
            jd0: 0.0,
            jd_end: 0.0,
            step_s: 60.0,
            total_steps: 0,
            threshold_km: 5.0,
        }
    }

    /// Start screening `[jd0, jd0 + duration_min]`.
    pub fn begin(&mut self, jd0: f64, duration_min: f64, step_s: f64, threshold_km: f64) {
        self.jd0 = jd0;
        self.jd_end = jd0 + duration_min / 1440.0;
        self.step_s = step_s;
        self.threshold_km = threshold_km;
        self.total_steps = ((duration_min * 60.0) / step_s).ceil() as u32 + 1;
        self.events.clear();
        self.formations.clear();
        self.stats = Stats::default();
        self.grid.set_cell_size(threshold_km + V_REL_MAX * step_s * 0.5);
    }

    pub fn progress(&self) -> f64 {
        if self.total_steps == 0 {
            1.0
        } else {
            self.stats.steps as f64 / self.total_steps as f64
        }
    }

    /// Run up to `max_steps` more samples. Returns progress in 0..1.
    pub fn advance(&mut self, max_steps: u32) -> f64 {
        let end = (self.stats.steps + max_steps).min(self.total_steps);
        while self.stats.steps < end {
            let jd = self.jd0 + self.stats.steps as f64 * self.step_s / 86400.0;
            self.screen_sample(jd);
            self.stats.steps += 1;
        }
        self.progress()
    }

    fn screen_sample(&mut self, jd: f64) {
        self.batch.propagate(jd, false);
        self.grid.build(&self.batch.pos, &self.batch.ok);
        let half = self.step_s * 0.5;
        let reach = self.grid.cell_size();
        let threshold = self.threshold_km;

        let mut candidates: Vec<(u32, u32, f64)> = Vec::new();
        let pos = &self.batch.pos;
        let vel = &self.batch.vel;
        let mut n_pairs = 0u64;
        let formations = &mut self.formations;
        let mut n_form = 0u64;
        self.grid.for_each_pair_within(pos, reach, |i, j, _| {
            n_pairs += 1;
            let dr = sub(v3(pos, j as usize), v3(pos, i as usize));
            let dv = sub(v3(vel, j as usize), v3(vel, i as usize));
            let vv = dot(dv, dv);
            if vv < FORMATION_SPEED * FORMATION_SPEED {
                if norm(dr) < threshold && formations.insert(key(i, j), ()).is_none() {
                    n_form += 1;
                }
                return;
            }
            let tau = -dot(dr, dv) / vv;
            // Already inside the threshold at this sample: refine regardless of
            // where the linear TCA lands. For slow pairs the linear estimate is
            // ill-conditioned and could otherwise fall outside every window.
            if norm(dr) < threshold {
                candidates.push((i, j, jd + tau.clamp(-half, half) / 86400.0));
                return;
            }
            // closest approach belongs to a neighbouring sample; the 1 s overlap
            // covers linearisation error at window edges (duplicates merge by pair)
            if !(-half - 1.0..half + 1.0).contains(&tau) {
                return;
            }
            let miss = norm([dr[0] + dv[0] * tau, dr[1] + dv[1] * tau, dr[2] + dv[2] * tau]);
            // generous margin: relative motion is not exactly linear over +-step/2
            if miss < threshold * 2.0 + 1.0 {
                candidates.push((i, j, jd + tau / 86400.0));
            }
        });
        self.stats.candidate_pairs += n_pairs;
        self.stats.formation_pairs += n_form;

        for (i, j, tca_guess) in candidates {
            self.stats.refined += 1;
            if let Some(ev) = self.refine(i, j, tca_guess) {
                if ev.miss_km < threshold && (self.jd0..=self.jd_end).contains(&ev.tca_jd) {
                    let k = key(i, j);
                    let keep = self.events.get(&k).map_or(true, |old| ev.miss_km < old.miss_km);
                    if keep {
                        self.events.insert(k, ev);
                    }
                }
            }
        }
    }

    /// Newton iterations on f(t) = r_rel . v_rel = 0 using full SGP4 states.
    pub fn refine(&mut self, a: u32, b: u32, jd_guess: f64) -> Option<Event> {
        let mut jd = jd_guess;
        let mut last = None;
        for _ in 0..6 {
            let (ra, va) = self.batch.sats[a as usize].propagate_jd(jd).ok()?;
            let (rb, vb) = self.batch.sats[b as usize].propagate_jd(jd).ok()?;
            let dr = sub(rb, ra);
            let dv = sub(vb, va);
            let vv = dot(dv, dv);
            last = Some((norm(dr), vv.sqrt()));
            if vv == 0.0 {
                break;
            }
            let dt = -dot(dr, dv) / vv;
            jd += dt / 86400.0;
            if dt.abs() < 1e-4 {
                break;
            }
        }
        let (ra, _) = self.batch.sats[a as usize].propagate_jd(jd).ok()?;
        let (rb, _) = self.batch.sats[b as usize].propagate_jd(jd).ok()?;
        let (_, speed) = last?;
        Some(Event { a, b, tca_jd: jd, miss_km: norm(sub(rb, ra)), rel_speed_kms: speed })
    }

    /// Events sorted by miss distance.
    pub fn events(&self) -> Vec<Event> {
        let mut v: Vec<Event> = self.events.values().copied().collect();
        v.sort_by(|x, y| x.miss_km.total_cmp(&y.miss_km));
        v
    }

    /// Instantaneous proximity pairs at the last propagated state (grid).
    pub fn grid_pairs_now(&mut self, radius: f64) -> u64 {
        let mut grid = SpatialHash::new(radius);
        grid.build(&self.batch.pos, &self.batch.ok);
        let mut n = 0u64;
        grid.for_each_pair_within(&self.batch.pos, radius, |_, _, _| n += 1);
        n
    }

    /// Same query by checking all N(N-1)/2 pairs.
    pub fn brute_pairs_now(&self, radius: f64) -> u64 {
        let mut n = 0u64;
        brute_force_pairs(&self.batch.pos, &self.batch.ok, radius, |_, _, _| n += 1);
        n
    }
}

#[inline]
fn key(i: u32, j: u32) -> u64 {
    let (a, b) = if i < j { (i, j) } else { (j, i) };
    ((a as u64) << 32) | b as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sgp4::Elements;

    /// Two crossing shells at the same altitude with pseudo-random phasing,
    /// so plenty of close approaches happen at the plane crossings.
    fn crossing_shells() -> Batch {
        let mut seed = 12345u64;
        let mut rnd = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        let mut els = Vec::new();
        for (incl, planes, per) in [(53.0, 40, 30), (97.5, 20, 30)] {
            for p in 0..planes {
                for _ in 0..per {
                    els.push(Elements {
                        epoch_jd: 2460000.5,
                        mean_motion: 15.05 + rnd() * 0.02,
                        eccentricity: 0.0002,
                        inclination_deg: incl,
                        raan_deg: 360.0 * p as f64 / planes as f64,
                        mean_anomaly_deg: rnd() * 360.0,
                        ..Default::default()
                    });
                }
            }
        }
        Batch::from_elements(&els)
    }

    fn screen(step: f64) -> Vec<(u32, u32, f64)> {
        let mut s = Screener::new(crossing_shells());
        s.begin(2460000.5, 90.0, step, 5.0);
        s.advance(u32::MAX);
        let mut v: Vec<(u32, u32, f64)> = s.events().iter().map(|e| (e.a.min(e.b), e.a.max(e.b), e.miss_km)).collect();
        v.sort_by(|x, y| (x.0, x.1).cmp(&(y.0, y.1)));
        v
    }

    /// The sieve radius grows with the step, so a coarse step must find exactly
    /// the same encounters as a fine one - otherwise the sieve is leaking.
    #[test]
    fn screening_is_step_size_independent() {
        let fine = screen(10.0);
        let coarse = screen(60.0);
        assert!(fine.len() > 10, "test scenario too sparse: {} events", fine.len());
        assert_eq!(fine.len(), coarse.len(), "fine {} vs coarse {}", fine.len(), coarse.len());
        for (f, c) in fine.iter().zip(&coarse) {
            assert_eq!((f.0, f.1), (c.0, c.1));
            assert!((f.2 - c.2).abs() < 1e-3, "miss differs: {} vs {}", f.2, c.2);
        }
    }
}
