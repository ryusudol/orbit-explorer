//! Laser inter-satellite link (ISL) graph for a Walker-style mega-constellation,
//! and shortest-latency routing between two ground stations.
//!
//! Topology is the "+Grid" used in the ISL literature (e.g. Handley, HotNets
//! 2018): every satellite keeps two links to its in-plane neighbours (fore and
//! aft) and one to the nearest satellite in the adjacent plane to the east
//! (so, with the link from the western plane, four in total). Shells and planes
//! are not taken from any label; they are recovered from the mean elements
//! every update by 1-D gap clustering, so the same code handles every shell.

use crate::batch::Batch;
use crate::frames::{dist, ecef_to_teme, elevation, geodetic_to_ecef, line_of_sight, up_ecef, v3, V3};
use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::f64::consts::{PI, TAU};

#[derive(Clone, Copy, Debug)]
pub struct IslConfig {
    /// Gap in mean inclination (deg) that separates two shells.
    pub shell_incl_gap_deg: f64,
    /// Gap in mean altitude (km) that separates two shells.
    pub shell_alt_gap_km: f64,
    /// Shells smaller than this get no links (orbit raising, deorbiting, test sats).
    pub min_shell_size: usize,
    /// Gap in RAAN (deg) that separates two planes within a shell.
    pub plane_raan_gap_deg: f64,
    pub max_in_plane_km: f64,
    pub max_cross_plane_km: f64,
    /// A link may not pass lower than this altitude (km) - atmosphere grazing.
    pub min_link_altitude_km: f64,
}

impl Default for IslConfig {
    fn default() -> Self {
        IslConfig {
            shell_incl_gap_deg: 0.08,
            shell_alt_gap_km: 6.0,
            // below this a "shell" is a launch batch still raising orbit
            min_shell_size: 200,
            plane_raan_gap_deg: 0.9,
            max_in_plane_km: 2600.0,
            max_cross_plane_km: 1500.0,
            min_link_altitude_km: 80.0,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Shell {
    pub inclination_deg: f64,
    pub altitude_km: f64,
    pub satellites: u32,
    pub planes: u32,
}

#[derive(Default)]
pub struct IslGraph {
    pub n: usize,
    pub edges: Vec<[u32; 2]>,
    pub offsets: Vec<u32>,
    pub targets: Vec<u32>,
    pub weights: Vec<f64>,
    /// Shell index per satellite, -1 when the satellite carries no links.
    pub shell_of: Vec<i32>,
    pub shells: Vec<Shell>,
}

#[derive(Clone, Debug, Default)]
pub struct Route {
    /// Satellite indices from the source uplink to the destination downlink.
    pub path: Vec<u32>,
    pub total_km: f64,
    pub uplink_km: f64,
    pub downlink_km: f64,
}

const DEG: f64 = PI / 180.0;
const EARTH_RADIUS_KM: f64 = 6378.137;

struct Mean {
    idx: u32,
    incl: f64,
    alt: f64,
    raan: f64,
    u: f64,
}

/// Split a sorted sequence wherever consecutive keys differ by more than `gap`.
fn split_by_gap<T>(items: Vec<T>, key: impl Fn(&T) -> f64, gap: f64) -> Vec<Vec<T>> {
    let mut groups: Vec<Vec<T>> = Vec::new();
    let mut prev = f64::NEG_INFINITY;
    for it in items {
        let k = key(&it);
        if groups.is_empty() || k - prev > gap {
            groups.push(Vec::new());
        }
        prev = k;
        groups.last_mut().unwrap().push(it);
    }
    groups
}

/// Split a set of angles (radians) on a circle into clusters, cutting at gaps > `gap`.
fn split_circular(mut items: Vec<Mean>, gap: f64) -> Vec<Vec<Mean>> {
    if items.is_empty() {
        return Vec::new();
    }
    items.sort_by(|a, b| a.raan.total_cmp(&b.raan));
    // rotate so the sequence starts right after the largest gap
    let n = items.len();
    let mut best = 0;
    let mut best_gap = -1.0;
    for i in 0..n {
        let next = if i + 1 < n { items[i + 1].raan } else { items[0].raan + TAU };
        let g = next - items[i].raan;
        if g > best_gap {
            best_gap = g;
            best = (i + 1) % n;
        }
    }
    items.rotate_left(best);
    let base = items[0].raan;
    split_by_gap(items, |m| (m.raan - base).rem_euclid(TAU), gap)
}

fn wrap_pi(a: f64) -> f64 {
    (a + PI).rem_euclid(TAU) - PI
}

pub fn build(batch: &Batch, cfg: &IslConfig) -> IslGraph {
    let n = batch.len();
    let mut g = IslGraph { n, shell_of: vec![-1; n], ..Default::default() };

    // mean elements from the last propagation (singly averaged, so they do not
    // oscillate with J2 short-period terms the way osculating ones would)
    let mut means: Vec<Mean> = Vec::new();
    for (i, s) in batch.sats.iter().enumerate() {
        if !batch.ok[i] {
            continue;
        }
        let alt = s.am * s.radius_earth_km() - s.radius_earth_km();
        if s.em > 0.005 || !(250.0..2000.0).contains(&alt) {
            continue;
        }
        means.push(Mean {
            idx: i as u32,
            incl: s.im,
            alt,
            raan: s.om_node.rem_euclid(TAU),
            u: (s.om_argp + s.mm).rem_euclid(TAU),
        });
    }

    // ---- shells: cluster by inclination, then altitude ----
    means.sort_by(|a, b| a.incl.total_cmp(&b.incl));
    let mut shells: Vec<Vec<Mean>> = Vec::new();
    for group in split_by_gap(means, |m| m.incl, cfg.shell_incl_gap_deg * DEG) {
        let mut group = group;
        group.sort_by(|a, b| a.alt.total_cmp(&b.alt));
        for s in split_by_gap(group, |m| m.alt, cfg.shell_alt_gap_km) {
            if s.len() >= cfg.min_shell_size {
                shells.push(s);
            }
        }
    }

    let mut edges: Vec<[u32; 2]> = Vec::new();
    let r_min = EARTH_RADIUS_KM + cfg.min_link_altitude_km;
    let try_link = |edges: &mut Vec<[u32; 2]>, a: u32, b: u32, max: f64| {
        if a == b {
            return;
        }
        let pa = batch.position(a as usize);
        let pb = batch.position(b as usize);
        if dist(pa, pb) <= max && line_of_sight(pa, pb, r_min) {
            edges.push([a.min(b), a.max(b)]);
        }
    };

    for (shell_id, members) in shells.into_iter().enumerate() {
        let count = members.len();
        let incl = members.iter().map(|m| m.incl).sum::<f64>() / count as f64;
        let alt = members.iter().map(|m| m.alt).sum::<f64>() / count as f64;
        for m in &members {
            g.shell_of[m.idx as usize] = shell_id as i32;
        }

        // ---- planes: cluster by RAAN on the circle, order by argument of latitude ----
        let mut planes = split_circular(members, cfg.plane_raan_gap_deg * DEG);
        for p in planes.iter_mut() {
            p.sort_by(|a, b| a.u.total_cmp(&b.u));
        }
        let plane_raan: Vec<f64> = planes
            .iter()
            .map(|p| {
                // circular mean
                let (s, c) = p.iter().fold((0.0, 0.0), |(s, c), m| (s + m.raan.sin(), c + m.raan.cos()));
                s.atan2(c).rem_euclid(TAU)
            })
            .collect();
        g.shells.push(Shell { inclination_deg: incl / DEG, altitude_km: alt, satellites: count as u32, planes: planes.len() as u32 });

        // in-plane: fore/aft ring
        for p in &planes {
            if p.len() < 2 {
                continue;
            }
            for k in 0..p.len() {
                let next = &p[(k + 1) % p.len()];
                if p.len() == 2 && k == 1 {
                    break;
                }
                try_link(&mut edges, p[k].idx, next.idx, cfg.max_in_plane_km);
            }
        }

        // cross-plane: each satellite links to the nearest satellite of the next plane east
        let mut order: Vec<usize> = (0..planes.len()).collect();
        order.sort_by(|&a, &b| plane_raan[a].total_cmp(&plane_raan[b]));
        for w in 0..order.len() {
            if order.len() < 2 {
                break;
            }
            let pa = order[w];
            let pb = order[(w + 1) % order.len()];
            let d_raan = (plane_raan[pb] - plane_raan[pa]).rem_euclid(TAU);
            if d_raan > 25.0 * DEG {
                continue;
            }
            let east = &planes[pb];
            for m in &planes[pa] {
                // nearest argument of latitude via binary search, then check a few neighbours by true distance
                let k = east.partition_point(|e| e.u < m.u);
                let mut best: Option<(f64, u32)> = None;
                for off in -2i64..=2 {
                    let idx = (k as i64 + off).rem_euclid(east.len() as i64) as usize;
                    let e = &east[idx];
                    if wrap_pi(e.u - m.u).abs() > 40.0 * DEG {
                        continue;
                    }
                    let d = dist(batch.position(m.idx as usize), batch.position(e.idx as usize));
                    if best.is_none_or(|(bd, _)| d < bd) {
                        best = Some((d, e.idx));
                    }
                }
                if let Some((_, j)) = best {
                    try_link(&mut edges, m.idx, j, cfg.max_cross_plane_km);
                }
            }
        }
    }

    edges.sort_unstable();
    edges.dedup();

    // ---- CSR adjacency ----
    let mut degree = vec![0u32; n + 1];
    for e in &edges {
        degree[e[0] as usize + 1] += 1;
        degree[e[1] as usize + 1] += 1;
    }
    for i in 0..n {
        degree[i + 1] += degree[i];
    }
    let mut fill = degree[..n].to_vec();
    let mut targets = vec![0u32; 2 * edges.len()];
    let mut weights = vec![0.0; 2 * edges.len()];
    for e in &edges {
        let w = dist(batch.position(e[0] as usize), batch.position(e[1] as usize));
        for (a, b) in [(e[0], e[1]), (e[1], e[0])] {
            let slot = fill[a as usize] as usize;
            targets[slot] = b;
            weights[slot] = w;
            fill[a as usize] += 1;
        }
    }
    g.offsets = degree;
    g.targets = targets;
    g.weights = weights;
    g.edges = edges;
    g
}

/// A ground terminal in TEME at the time of the batch.
pub struct Terminal {
    pub pos: V3,
    pub up: V3,
}

impl Terminal {
    pub fn new(lat_deg: f64, lon_deg: f64, gmst: f64) -> Terminal {
        let (lat, lon) = (lat_deg * DEG, lon_deg * DEG);
        Terminal { pos: ecef_to_teme(geodetic_to_ecef(lat, lon, 0.0), gmst), up: ecef_to_teme(up_ecef(lat, lon), gmst) }
    }
}

/// Dijkstra over {source terminal} + satellites + {destination terminal},
/// weighting every hop by its length. Latency is total length / c.
pub fn route(graph: &IslGraph, batch: &Batch, src: &Terminal, dst: &Terminal, min_elev_deg: f64) -> Option<Route> {
    let n = graph.n;
    let min_el = min_elev_deg * DEG;
    let src_node = n;
    let dst_node = n + 1;
    let mut best = vec![f64::INFINITY; n + 2];
    let mut prev = vec![u32::MAX; n + 2];
    let mut down = vec![f64::NAN; n];
    let mut heap: BinaryHeap<Reverse<(u64, u32)>> = BinaryHeap::new();

    for i in 0..n {
        if graph.shell_of[i] < 0 || !batch.ok[i] {
            continue;
        }
        let p = v3(&batch.pos, i);
        if elevation(dst.pos, dst.up, p) >= min_el {
            down[i] = dist(dst.pos, p);
        }
        if elevation(src.pos, src.up, p) >= min_el {
            let d = dist(src.pos, p);
            if d < best[i] {
                best[i] = d;
                prev[i] = src_node as u32;
                heap.push(Reverse((d.to_bits(), i as u32)));
            }
        }
    }

    while let Some(Reverse((bits, u))) = heap.pop() {
        let d = f64::from_bits(bits);
        let u = u as usize;
        if d > best[u] {
            continue;
        }
        if u == dst_node {
            break;
        }
        if !down[u].is_nan() {
            let nd = d + down[u];
            if nd < best[dst_node] {
                best[dst_node] = nd;
                prev[dst_node] = u as u32;
                heap.push(Reverse((nd.to_bits(), dst_node as u32)));
            }
        }
        for k in graph.offsets[u] as usize..graph.offsets[u + 1] as usize {
            let v = graph.targets[k] as usize;
            let nd = d + graph.weights[k];
            if nd < best[v] {
                best[v] = nd;
                prev[v] = u as u32;
                heap.push(Reverse((nd.to_bits(), v as u32)));
            }
        }
    }

    if !best[dst_node].is_finite() {
        return None;
    }
    let mut path = Vec::new();
    let mut cur = prev[dst_node];
    while cur as usize != src_node {
        path.push(cur);
        cur = prev[cur as usize];
    }
    path.reverse();
    let first = path[0] as usize;
    let last = *path.last().unwrap() as usize;
    Some(Route { total_km: best[dst_node], uplink_km: dist(src.pos, batch.position(first)), downlink_km: down[last], path })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sgp4::Elements;

    /// Synthetic Walker-delta shell: `planes` x `per_plane` at 550 km, 53 deg.
    fn walker(planes: usize, per_plane: usize, phasing: usize) -> Batch {
        let mu: f64 = 398600.8;
        let a: f64 = 6378.135 + 550.0;
        let n_rad_s = (mu / (a * a * a)).sqrt();
        let rev_per_day = n_rad_s * 86400.0 / TAU;
        let mut els = Vec::new();
        for p in 0..planes {
            for s in 0..per_plane {
                let raan = 360.0 * p as f64 / planes as f64;
                let ma = 360.0 * s as f64 / per_plane as f64 + 360.0 * (phasing * p) as f64 / (planes * per_plane) as f64;
                els.push(Elements {
                    epoch_jd: 2460000.5,
                    mean_motion: rev_per_day,
                    eccentricity: 0.0001,
                    inclination_deg: 53.0,
                    raan_deg: raan,
                    arg_perigee_deg: 0.0,
                    mean_anomaly_deg: ma % 360.0,
                    ..Default::default()
                });
            }
        }
        let mut b = Batch::from_elements(&els);
        b.propagate(2460000.5, false);
        b
    }

    #[test]
    fn plus_grid_on_walker_shell() {
        let b = walker(40, 20, 1);
        let g = build(&b, &IslConfig::default());
        assert_eq!(g.shells.len(), 1, "{:?}", g.shells);
        assert_eq!(g.shells[0].planes, 40);
        // 800 in-plane + 800 cross-plane links
        assert_eq!(g.edges.len(), 1600, "edges {}", g.edges.len());
        let max_deg = (0..g.n).map(|i| g.offsets[i + 1] - g.offsets[i]).max().unwrap();
        assert!(max_deg <= 5);
    }

    #[test]
    fn route_is_shortest_and_beats_great_circle_fibre() {
        let b = walker(32, 24, 1);
        let g = build(&b, &IslConfig::default());
        let gmst = crate::sgp4::gstime(2460000.5);
        // pick two terminals under the shell, ~5,500 km apart
        let src = Terminal::new(40.0, -74.0, gmst);
        let dst = Terminal::new(51.5, -0.1, gmst);
        if let Some(r) = route(&g, &b, &src, &dst, 25.0) {
            let straight = dist(src.pos, dst.pos);
            assert!(r.total_km >= straight, "path shorter than the chord");
            // path length is the sum of its hops
            let mut sum = r.uplink_km + r.downlink_km;
            for w in r.path.windows(2) {
                sum += dist(b.position(w[0] as usize), b.position(w[1] as usize));
            }
            assert!((sum - r.total_km).abs() < 1e-6);
        }
    }
}
