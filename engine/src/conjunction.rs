//! Conjunction screening over the whole catalogue.
//!
//! Every `step` seconds all objects are propagated and bucketed in a spatial
//! hash. Two objects that pass within `threshold` of each other at time of
//! closest approach (TCA) are, at the nearest sample, at most
//! `threshold + v_rel * step / 2` apart, so a search radius built from a bound
//! on v_rel can never miss an encounter. Each surviving pair gets a linear TCA
//! estimate, and pairs whose estimate lands in this sample's window are refined
//! with SGP4 and Newton iterations on d/dt |r_rel|^2 = 0.
//!
//! The bound comes from each object's own top speed, its speed at perigee.
//! Almost everything never exceeds `V_SLOW`, so any two of those close at under
//! `V_REL_MAX` and the grid is sized for that. The few faster objects (transfer
//! orbits, Molniyas, eccentric debris) each search their own, wider radius:
//! a transfer-orbit rocket body at perigee meets a retrograde-ish LEO satellite
//! at ~17 km/s, which a single 16 km/s radius once let slip between samples.

use crate::batch::Batch;
use crate::frames::{dot, norm, sub, v3};
use crate::grid::{brute_force_pairs, SpatialHash};
use crate::sgp4::{Gravity, Satrec};
use std::collections::HashMap;

/// Top speed (km/s) of the objects the grid radius is sized for.
pub const V_SLOW: f64 = 8.0;
/// Relative speed bound between two objects that never exceed `V_SLOW` (km/s).
pub const V_REL_MAX: f64 = 2.0 * V_SLOW;
/// Headroom on the mean-element perigee speed for SGP4's periodic terms and drag.
const SPEED_MARGIN: f64 = 1.02;
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

/// Fastest the object can move (km/s): its speed at perigee, from vis-viva on the
/// mean elements, with margin. Records SGP4 rejected get escape speed at the surface.
pub fn top_speed(sat: &Satrec, grav: &Gravity) -> f64 {
    let a = sat.a * grav.radiusearthkm;
    let rp = a * (1.0 - sat.ecco);
    let v = (grav.mu * (2.0 / rp - 1.0 / a)).sqrt() * SPEED_MARGIN;
    if v.is_finite() && v > 0.0 {
        v
    } else {
        (2.0 * grav.mu / grav.radiusearthkm).sqrt()
    }
}

pub struct Screener {
    pub batch: Batch,
    grid: SpatialHash,
    /// per object: top speed (km/s), and whether it can exceed `V_SLOW`
    top_speed: Vec<f64>,
    fast: Vec<bool>,
    /// the fast objects, and the fastest top speed of all
    fast_list: Vec<u32>,
    v_top: f64,
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
        let grav = Gravity::wgs72();
        let top_speed: Vec<f64> = batch.sats.iter().map(|s| top_speed(s, &grav)).collect();
        let fast: Vec<bool> = top_speed.iter().map(|&v| v > V_SLOW).collect();
        let fast_list = (0..fast.len() as u32).filter(|&i| fast[i as usize]).collect();
        let v_top = top_speed.iter().copied().fold(V_SLOW, f64::max);
        Screener {
            batch,
            grid: SpatialHash::new(100.0),
            top_speed,
            fast,
            fast_list,
            v_top,
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
        let ok = &self.batch.ok;
        let fast = &self.fast;
        let mut n_pairs = 0u64;
        let formations = &mut self.formations;
        let mut n_form = 0u64;
        let mut consider = |i: u32, j: u32| {
            n_pairs += 1;
            match sample_pair(pos, vel, i, j, half, threshold) {
                Sampled::Formation => {
                    if formations.insert(key(i, j), ()).is_none() {
                        n_form += 1;
                    }
                }
                Sampled::Candidate(tau) => candidates.push((i, j, jd + tau / 86400.0)),
                Sampled::Skip => {}
            }
        };
        // pairs of objects that never exceed V_SLOW: the grid's own radius bounds them
        self.grid.for_each_pair_within(pos, reach, |i, j, _| {
            if !fast[i as usize] && !fast[j as usize] {
                consider(i, j);
            }
        });
        // a fast object can close on anything at up to its top speed plus the fastest
        // object's, so it searches that wider radius; fast-fast pairs are taken once
        for &f in &self.fast_list {
            if !ok[f as usize] {
                continue;
            }
            let radius = threshold + (self.top_speed[f as usize] + self.v_top) * half;
            self.grid.for_each_near(pos, v3(pos, f as usize), radius, |j, _| {
                if j != f && !(fast[j as usize] && j < f) {
                    consider(f.min(j), f.max(j));
                }
            });
        }
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

/// What one pair at one sample contributes.
enum Sampled {
    Skip,
    /// moving together under `FORMATION_SPEED`, inside the threshold
    Formation,
    /// worth refining, from this offset (s) to the linear TCA estimate
    Candidate(f64),
}

#[inline]
fn sample_pair(pos: &[f64], vel: &[f64], i: u32, j: u32, half: f64, threshold: f64) -> Sampled {
    let dr = sub(v3(pos, j as usize), v3(pos, i as usize));
    let dv = sub(v3(vel, j as usize), v3(vel, i as usize));
    let vv = dot(dv, dv);
    if vv < FORMATION_SPEED * FORMATION_SPEED {
        return if norm(dr) < threshold { Sampled::Formation } else { Sampled::Skip };
    }
    let tau = -dot(dr, dv) / vv;
    // Already inside the threshold at this sample: refine regardless of
    // where the linear TCA lands. For slow pairs the linear estimate is
    // ill-conditioned and could otherwise fall outside every window.
    if norm(dr) < threshold {
        return Sampled::Candidate(tau.clamp(-half, half));
    }
    // closest approach belongs to a neighbouring sample; the 1 s overlap
    // covers linearisation error at window edges (duplicates merge by pair)
    if !(-half - 1.0..half + 1.0).contains(&tau) {
        return Sampled::Skip;
    }
    let miss = norm([dr[0] + dv[0] * tau, dr[1] + dv[1] * tau, dr[2] + dv[2] * tau]);
    // generous margin: relative motion is not exactly linear over +-step/2
    if miss < threshold * 2.0 + 1.0 {
        Sampled::Candidate(tau)
    } else {
        Sampled::Skip
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

    /// A transfer-orbit object at perigee meets a near-retrograde LEO satellite head
    /// on at ~18 km/s, closest approach midway between two 120 s samples. The pair
    /// is then farther apart at both samples than the 16 km/s grid radius reaches,
    /// so only the fast object's own radius can find it.
    #[test]
    fn fast_eccentric_objects_are_not_missed() {
        let mu = Gravity::wgs72().mu;
        let n_rev_day = |a: f64| (mu / (a * a * a)).sqrt() * 86400.0 / std::f64::consts::TAU;
        let (rp, ra) = (6378.135 + 300.0, 42164.0);
        let gto = Elements {
            epoch_jd: 2460000.5,
            mean_motion: n_rev_day((rp + ra) / 2.0),
            eccentricity: (ra - rp) / (ra + rp),
            inclination_deg: 1.0,
            ..Default::default()
        };
        let leo = Elements { epoch_jd: 2460000.5, mean_motion: n_rev_day(rp), eccentricity: 0.0001, inclination_deg: 179.0, ..Default::default() };
        let (threshold, step) = (20.0, 120.0);
        let screen = |jd0: f64, step: f64| {
            let mut s = Screener::new(Batch::from_elements(&[gto, leo]));
            s.begin(jd0, 4.0, step, threshold);
            s.advance(u32::MAX);
            (s.events(), s.fast.clone())
        };
        // both reach the ascending node near the epoch
        let (fine, fast) = screen(2460000.5 - 2.0 / 1440.0, 1.0);
        assert_eq!(fast, vec![true, false], "only the transfer orbit exceeds V_SLOW");
        assert_eq!(fine.len(), 1, "the head-on pass is inside the threshold");
        assert!(fine[0].rel_speed_kms > V_REL_MAX, "{} km/s", fine[0].rel_speed_kms);
        // coarse samples half a step either side of the closest approach
        let tca = fine[0].tca_jd;
        let (coarse, _) = screen(tca - step / 2.0 / 86400.0, step);
        assert_eq!(coarse.len(), 1, "a 120 s step must find it too");
        assert!((fine[0].miss_km - coarse[0].miss_km).abs() < 1e-3);

        // and the case is a real test: at both coarse samples the pair sits outside
        // the radius that bounds slow pairs
        let mut b = Batch::from_elements(&[gto, leo]);
        for t in [-step / 2.0, step / 2.0] {
            b.propagate(tca + t / 86400.0, false);
            let d = norm(sub(b.position(1), b.position(0)));
            assert!(d > threshold + V_REL_MAX * step / 2.0, "only {d:.0} km apart at {t} s");
        }
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
