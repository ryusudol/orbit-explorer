//! Uniform spatial hash for "all pairs closer than d" queries.
//!
//! Points are bucketed by integer cell (floor(x / cell)); a pair closer than
//! `cell` must sit in the same or an adjacent cell, so each point only checks
//! 27 cells instead of all N-1 others. Buckets are laid out with a counting
//! sort into one flat array, so a rebuild is two linear passes and no allocation.

use crate::frames::{v3, V3};

pub struct SpatialHash {
    cell: f64,
    inv_cell: f64,
    mask: usize,
    cells: Vec<[i32; 3]>,
    bucket_of: Vec<u32>,
    start: Vec<u32>,
    items: Vec<u32>,
}

#[inline]
fn hash(c: [i32; 3], mask: usize) -> usize {
    let h = (c[0] as u32).wrapping_mul(73_856_093) ^ (c[1] as u32).wrapping_mul(19_349_663) ^ (c[2] as u32).wrapping_mul(83_492_791);
    (h as usize) & mask
}

impl SpatialHash {
    pub fn new(cell: f64) -> Self {
        SpatialHash { cell, inv_cell: 1.0 / cell, mask: 0, cells: Vec::new(), bucket_of: Vec::new(), start: Vec::new(), items: Vec::new() }
    }

    pub fn cell_size(&self) -> f64 {
        self.cell
    }

    pub fn set_cell_size(&mut self, cell: f64) {
        self.cell = cell;
        self.inv_cell = 1.0 / cell;
    }

    /// Bucket every point with `active[i]`. `pos` is xyz-interleaved.
    pub fn build(&mut self, pos: &[f64], active: &[bool]) {
        let n = active.len();
        let n_active = active.iter().filter(|&&a| a).count().max(1);
        let size = (2 * n_active).next_power_of_two();
        self.mask = size - 1;
        self.cells.resize(n, [0; 3]);
        self.bucket_of.resize(n, u32::MAX);
        self.start.clear();
        self.start.resize(size + 1, 0);

        for i in 0..n {
            if !active[i] {
                self.bucket_of[i] = u32::MAX;
                continue;
            }
            let p = v3(pos, i);
            let c = [(p[0] * self.inv_cell).floor() as i32, (p[1] * self.inv_cell).floor() as i32, (p[2] * self.inv_cell).floor() as i32];
            self.cells[i] = c;
            let b = hash(c, self.mask);
            self.bucket_of[i] = b as u32;
            self.start[b + 1] += 1;
        }
        for b in 0..size {
            self.start[b + 1] += self.start[b];
        }
        self.items.clear();
        self.items.resize(self.start[size] as usize, 0);
        let mut fill: Vec<u32> = self.start[..size].to_vec();
        for i in 0..n {
            let b = self.bucket_of[i];
            if b != u32::MAX {
                let slot = &mut fill[b as usize];
                self.items[*slot as usize] = i as u32;
                *slot += 1;
            }
        }
    }

    /// Calls `f(i, j, dist2)` once for every unordered pair with |pi - pj| < radius.
    /// `radius` must not exceed the cell size.
    pub fn for_each_pair_within(&self, pos: &[f64], radius: f64, mut f: impl FnMut(u32, u32, f64)) {
        debug_assert!(radius <= self.cell * (1.0 + 1e-12));
        let r2 = radius * radius;
        for &i in &self.items {
            let iu = i as usize;
            let c = self.cells[iu];
            let p = v3(pos, iu);
            for dx in -1..=1 {
                for dy in -1..=1 {
                    for dz in -1..=1 {
                        let nc = [c[0] + dx, c[1] + dy, c[2] + dz];
                        let b = hash(nc, self.mask);
                        for &j in &self.items[self.start[b] as usize..self.start[b + 1] as usize] {
                            if j <= i || self.cells[j as usize] != nc {
                                continue;
                            }
                            let q = v3(pos, j as usize);
                            let d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
                            let d2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
                            if d2 < r2 {
                                f(i, j, d2);
                            }
                        }
                    }
                }
            }
        }
    }

    /// Calls `f(j, dist2)` for every bucketed point within `radius` of `p`.
    pub fn for_each_near(&self, pos: &[f64], p: V3, radius: f64, mut f: impl FnMut(u32, f64)) {
        let r2 = radius * radius;
        let reach = (radius * self.inv_cell).ceil() as i32;
        let c = [(p[0] * self.inv_cell).floor() as i32, (p[1] * self.inv_cell).floor() as i32, (p[2] * self.inv_cell).floor() as i32];
        for dx in -reach..=reach {
            for dy in -reach..=reach {
                for dz in -reach..=reach {
                    let nc = [c[0] + dx, c[1] + dy, c[2] + dz];
                    let b = hash(nc, self.mask);
                    for &j in &self.items[self.start[b] as usize..self.start[b + 1] as usize] {
                        if self.cells[j as usize] != nc {
                            continue;
                        }
                        let q = v3(pos, j as usize);
                        let d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
                        let d2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
                        if d2 < r2 {
                            f(j, d2);
                        }
                    }
                }
            }
        }
    }
}

/// Reference O(N^2) all-pairs search, used for validation and the benchmark.
pub fn brute_force_pairs(pos: &[f64], active: &[bool], radius: f64, mut f: impl FnMut(u32, u32, f64)) {
    let r2 = radius * radius;
    let n = active.len();
    for i in 0..n {
        if !active[i] {
            continue;
        }
        let (x, y, z) = (pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]);
        for j in (i + 1)..n {
            if !active[j] {
                continue;
            }
            let dx = pos[3 * j] - x;
            let dy = pos[3 * j + 1] - y;
            let dz = pos[3 * j + 2] - z;
            let d2 = dx * dx + dy * dy + dz * dz;
            if d2 < r2 {
                f(i as u32, j as u32, d2);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// xorshift so the test needs no dependencies
    fn rng(seed: &mut u64) -> f64 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        (*seed >> 11) as f64 / (1u64 << 53) as f64
    }

    #[test]
    fn grid_matches_brute_force() {
        let mut seed = 0x9E37_79B9_7F4A_7C15u64;
        let n = 4000;
        let mut pos = Vec::with_capacity(3 * n);
        for _ in 0..n {
            // points on a thin shell, like a LEO constellation
            let u = rng(&mut seed) * 2.0 - 1.0;
            let th = rng(&mut seed) * std::f64::consts::TAU;
            let r = 6900.0 + rng(&mut seed) * 50.0;
            let s = (1.0 - u * u).sqrt();
            pos.extend_from_slice(&[r * s * th.cos(), r * s * th.sin(), r * u]);
        }
        let active: Vec<bool> = (0..n).map(|i| i % 17 != 0).collect();
        for &radius in &[25.0, 150.0, 400.0] {
            let mut grid = SpatialHash::new(radius);
            grid.build(&pos, &active);
            let mut a = Vec::new();
            grid.for_each_pair_within(&pos, radius, |i, j, _| a.push((i.min(j), i.max(j))));
            let mut b = Vec::new();
            brute_force_pairs(&pos, &active, radius, |i, j, _| b.push((i, j)));
            a.sort_unstable();
            b.sort_unstable();
            assert_eq!(a, b, "radius {radius}");
            assert!(!b.is_empty());
        }
    }
}
