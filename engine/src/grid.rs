//! Uniform grid for "all pairs closer than d" queries.
//!
//! Points are bucketed by integer cell (floor(x / cell)); a pair closer than
//! `cell` must sit in the same or an adjacent cell. `build` gives every point a
//! key that packs its cell's (x, y, z), radix-sorts the points by it and copies
//! their positions into that order. Every occupied cell is then one contiguous
//! run, cells stack bottom to top within each (x, y) column, and columns are in
//! (x, y) order, so the pair search needs no lookups at all:
//!
//! - a cell's own points and those of the cell above it (z + 1) form one range;
//! - of the columns "ahead" of a column, (x, y+1) is the next column and
//!   (x+1, y-1..=y+1) are found by a pointer that only moves forward through the
//!   next slab of columns; in each, the cells at z-1..=z+1 are again one range,
//!   found by a sweep up the column.
//!
//! That covers the cell itself and 13 of its 26 neighbors, one of each opposite
//! pair, so every adjacent pair of cells, and every pair of points, is visited
//! exactly once.

use crate::frames::{v3, V3};

/// Cells are numbered from the lowest occupied one, up to this per axis. A cell
/// farther out is clamped onto the edge: that can merge cells, never separate
/// neighbors, so queries stay exact (if slower) even for absurd spreads.
const AXIS_MAX: i64 = (1 << 21) - 1;

/// One occupied cell: its height in the column, and `[start, end)` into the
/// cell-ordered arrays.
#[derive(Clone, Copy)]
struct Run {
    z: u32,
    start: u32,
    end: u32,
}

/// One occupied column: its runs are `runs[lo..hi]`, bottom to top.
#[derive(Clone, Copy)]
struct Column {
    x: u32,
    y: u32,
    lo: u32,
    hi: u32,
}

pub struct SpatialGrid {
    cell: f64,
    inv_cell: f64,
    /// the lowest occupied cell; cells are numbered from here
    origin: [i32; 3],
    /// bucketed points in cell order: original index and position
    ids: Vec<u32>,
    spos: Vec<V3>,
    runs: Vec<Run>,
    cols: Vec<Column>,
    // build scratch
    cell_of: Vec<[i32; 3]>,
    keys: Vec<u64>,
    tmp_keys: Vec<u64>,
    tmp_ids: Vec<u32>,
}

#[inline]
fn d2(p: V3, q: V3) -> f64 {
    let d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
}

/// Bits needed to hold `v`.
#[inline]
fn bits(v: u32) -> u32 {
    32 - v.leading_zeros()
}

/// Stable LSD radix sort of `keys` (and `ids` alongside) on their low `bits` bits.
fn radix_sort(keys: &mut Vec<u64>, ids: &mut Vec<u32>, bits: u32, tmp_keys: &mut Vec<u64>, tmp_ids: &mut Vec<u32>) {
    const DIGIT: u32 = 11;
    const MASK: u64 = (1 << DIGIT) - 1;
    let n = keys.len();
    tmp_keys.resize(n, 0);
    tmp_ids.resize(n, 0);
    let mut count = [0u32; 1 << DIGIT];
    let mut shift = 0;
    while shift < bits {
        count.fill(0);
        for &k in keys.iter() {
            count[((k >> shift) & MASK) as usize] += 1;
        }
        let mut sum = 0;
        for c in count.iter_mut() {
            let here = *c;
            *c = sum;
            sum += here;
        }
        for j in 0..n {
            let slot = &mut count[((keys[j] >> shift) & MASK) as usize];
            tmp_keys[*slot as usize] = keys[j];
            tmp_ids[*slot as usize] = ids[j];
            *slot += 1;
        }
        std::mem::swap(keys, tmp_keys);
        std::mem::swap(ids, tmp_ids);
        shift += DIGIT;
    }
}

/// Points [a0, a1) against [b0, b1), or among themselves and the points just
/// after them when `b0 == a0` (the ranges then overlap). About a quarter of the
/// points checked are hits, so a branch per point would mispredict constantly:
/// hits are gathered into `hits` without branching and reported afterward.
#[inline(always)]
fn scan(spos: &[V3], r2: f64, a0: usize, a1: usize, b0: usize, b1: usize, hits: &mut Vec<(u32, f64)>, f: &mut impl FnMut(u32, u32, f64)) {
    let same = a0 == b0;
    if hits.len() < b1 - b0 {
        hits.resize(b1 - b0, (0, 0.0));
    }
    for a in a0..a1 {
        let p = spos[a];
        let from = if same { a + 1 } else { b0 };
        let mut n = 0;
        for (b, q) in spos[from..b1].iter().enumerate() {
            let e = d2(p, *q);
            hits[n] = ((from + b) as u32, e);
            n += (e < r2) as usize;
        }
        for &(b, e) in &hits[..n] {
            f(a as u32, b, e);
        }
    }
}

impl SpatialGrid {
    pub fn new(cell: f64) -> Self {
        SpatialGrid {
            cell,
            inv_cell: 1.0 / cell,
            origin: [0; 3],
            ids: Vec::new(),
            spos: Vec::new(),
            runs: Vec::new(),
            cols: Vec::new(),
            cell_of: Vec::new(),
            keys: Vec::new(),
            tmp_keys: Vec::new(),
            tmp_ids: Vec::new(),
        }
    }

    pub fn cell_size(&self) -> f64 {
        self.cell
    }

    pub fn set_cell_size(&mut self, cell: f64) {
        self.cell = cell;
        self.inv_cell = 1.0 / cell;
    }

    #[inline]
    fn cell_at(&self, p: V3) -> [i32; 3] {
        [(p[0] * self.inv_cell).floor() as i32, (p[1] * self.inv_cell).floor() as i32, (p[2] * self.inv_cell).floor() as i32]
    }

    /// A cell's number along each axis, counted from `origin` and clamped.
    #[inline]
    fn local(&self, c: [i32; 3]) -> [u32; 3] {
        let l = |k: usize| (c[k] as i64 - self.origin[k] as i64).clamp(0, AXIS_MAX) as u32;
        [l(0), l(1), l(2)]
    }

    /// Bucket every point with `active[i]`. `pos` is xyz-interleaved; the grid
    /// keeps its own copy, so later queries don't need it.
    pub fn build(&mut self, pos: &[f64], active: &[bool]) {
        let n = active.len();
        self.cell_of.resize(n, [0; 3]);
        let (mut lo, mut hi) = ([i32::MAX; 3], [i32::MIN; 3]);
        for i in (0..n).filter(|&i| active[i]) {
            let c = self.cell_at(v3(pos, i));
            self.cell_of[i] = c;
            for k in 0..3 {
                lo[k] = lo[k].min(c[k]);
                hi[k] = hi[k].max(c[k]);
            }
        }
        self.origin = lo;

        // key = x | y | z, each field just wide enough for this build's spread
        let top = self.local(hi);
        let (by, bz) = (bits(top[1]), bits(top[2]));
        self.keys.clear();
        self.ids.clear();
        for i in (0..n).filter(|&i| active[i]) {
            let [x, y, z] = self.local(self.cell_of[i]);
            self.keys.push((x as u64) << (by + bz) | (y as u64) << bz | z as u64);
            self.ids.push(i as u32);
        }
        radix_sort(&mut self.keys, &mut self.ids, bits(top[0]) + by + bz, &mut self.tmp_keys, &mut self.tmp_ids);

        // split into columns and runs
        self.runs.clear();
        self.cols.clear();
        self.spos.clear();
        let (ymask, zmask) = ((1u64 << by) - 1, (1u64 << bz) - 1);
        for k in 0..self.keys.len() {
            let key = self.keys[k];
            if k == 0 || key != self.keys[k - 1] {
                let (x, y, z) = ((key >> (by + bz)) as u32, ((key >> bz) & ymask) as u32, (key & zmask) as u32);
                let col = self.cols.last().map(|c| (c.x, c.y));
                if col != Some((x, y)) {
                    let at = self.runs.len() as u32;
                    self.cols.push(Column { x, y, lo: at, hi: at });
                }
                self.runs.push(Run { z, start: k as u32, end: k as u32 });
                self.cols.last_mut().unwrap().hi += 1;
            }
            self.runs.last_mut().unwrap().end += 1;
            self.spos.push(v3(pos, self.ids[k] as usize));
        }
    }

    /// Original indices of the bucketed points, in cell order. Position `k` here is
    /// the "slot" that `for_each_slot_pair_within` reports.
    pub fn order(&self) -> &[u32] {
        &self.ids
    }

    /// Positions in slot order.
    pub fn positions(&self) -> &[V3] {
        &self.spos
    }

    /// Calls `f(i, j, dist2)` once for every unordered pair with |pi - pj| < radius,
    /// with `i < j`. `radius` must not exceed the cell size.
    pub fn for_each_pair_within(&self, radius: f64, mut f: impl FnMut(u32, u32, f64)) {
        let ids = &self.ids;
        self.for_each_slot_pair_within(radius, |a, b, d2| {
            let (i, j) = (ids[a as usize], ids[b as usize]);
            if i < j {
                f(i, j, d2)
            } else {
                f(j, i, d2)
            }
        });
    }

    /// Like `for_each_pair_within`, but reports slots (see `order`), in no
    /// particular order within the pair, so callers can keep per-point data in
    /// slot order and read it sequentially too.
    pub fn for_each_slot_pair_within(&self, radius: f64, mut f: impl FnMut(u32, u32, f64)) {
        debug_assert!(radius <= self.cell * (1.0 + 1e-12));
        let r2 = radius * radius;
        let (runs, cols, spos) = (&self.runs, &self.cols, &self.spos);
        // each cell of column `a` against the cells at z-1..=z+1 in column `b`, swept upward
        let mut hits = Vec::new();
        let columns = |a: Column, b: Column, hits: &mut Vec<(u32, f64)>, f: &mut _| {
            let (mut w, end) = (b.lo as usize, b.hi as usize);
            for ra in &runs[a.lo as usize..a.hi as usize] {
                while w < end && runs[w].z + 1 < ra.z {
                    w += 1;
                }
                let mut e = w;
                while e < end && runs[e].z <= ra.z + 1 {
                    e += 1;
                }
                if e > w {
                    scan(spos, r2, ra.start as usize, ra.end as usize, runs[w].start as usize, runs[e - 1].end as usize, hits, f);
                }
            }
        };
        let mut s0 = 0;
        while s0 < cols.len() {
            // slab x is cols[s0..s1]; the next slab, if it is x + 1, cols[s1..n1]
            let x = cols[s0].x;
            let slab = |at: usize, x: u32| at + cols[at..].iter().take_while(|c| c.x == x).count();
            let s1 = slab(s0, x);
            let n1 = slab(s1, x + 1);
            let mut p = s1;
            for ci in s0..s1 {
                let c = cols[ci];
                // within the column: each cell with itself and the cell above it
                for k in c.lo as usize..c.hi as usize {
                    let r = runs[k];
                    let top = if k + 1 < c.hi as usize && runs[k + 1].z == r.z + 1 { runs[k + 1].end } else { r.end };
                    scan(spos, r2, r.start as usize, r.end as usize, r.start as usize, top as usize, &mut hits, &mut f);
                }
                // column (x, y+1)
                if ci + 1 < s1 && cols[ci + 1].y == c.y + 1 {
                    columns(c, cols[ci + 1], &mut hits, &mut f);
                }
                // columns (x+1, y-1..=y+1)
                while p < n1 && cols[p].y + 1 < c.y {
                    p += 1;
                }
                let mut q = p;
                while q < n1 && cols[q].y <= c.y + 1 {
                    columns(c, cols[q], &mut hits, &mut f);
                    q += 1;
                }
            }
            s0 = s1;
        }
    }

    /// Calls `f(j, dist2)` for every bucketed point within `radius` of `p`.
    pub fn for_each_near(&self, p: V3, radius: f64, mut f: impl FnMut(u32, f64)) {
        let r2 = radius * radius;
        // only the cells the sphere's bounding box touches
        let lo = self.local(self.cell_at([p[0] - radius, p[1] - radius, p[2] - radius]));
        let hi = self.local(self.cell_at([p[0] + radius, p[1] + radius, p[2] + radius]));
        let cols = &self.cols;
        for x in lo[0]..=hi[0] {
            let mut ci = cols.partition_point(|c| (c.x, c.y) < (x, lo[1]));
            while ci < cols.len() && cols[ci].x == x && cols[ci].y <= hi[1] {
                let c = cols[ci];
                for r in self.runs[c.lo as usize..c.hi as usize].iter().filter(|r| (lo[2]..=hi[2]).contains(&r.z)) {
                    for k in r.start as usize..r.end as usize {
                        let e = d2(p, self.spos[k]);
                        if e < r2 {
                            f(self.ids[k], e);
                        }
                    }
                }
                ci += 1;
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
            let mut grid = SpatialGrid::new(radius);
            grid.build(&pos, &active);
            let mut a = Vec::new();
            grid.for_each_pair_within(radius, |i, j, _| {
                assert!(i < j);
                a.push((i, j))
            });
            let mut b = Vec::new();
            brute_force_pairs(&pos, &active, radius, |i, j, _| b.push((i, j)));
            a.sort_unstable();
            b.sort_unstable();
            assert_eq!(a, b, "radius {radius}");
            assert!(!b.is_empty());

            // neighborhood queries reaching past the adjacent cells
            for k in (0..n).step_by(97) {
                let p = v3(&pos, k);
                let mut near = Vec::new();
                grid.for_each_near(p, 2.5 * radius, |j, _| near.push(j));
                near.sort_unstable();
                let r2 = 6.25 * radius * radius;
                let want: Vec<u32> = (0..n as u32).filter(|&j| active[j as usize] && d2(p, v3(&pos, j as usize)) < r2).collect();
                assert_eq!(near, want, "near {k}, radius {radius}");
            }
        }
    }

    /// Cells more than 2^21 from the lowest one are clamped onto the edge. That may
    /// merge cells, but must never separate neighbors: clusters millions of cells
    /// apart still give exactly the brute-force pairs.
    #[test]
    fn clamped_far_cells_stay_exact() {
        let mut seed = 0x2545_F491_4F6C_DD1Du64;
        let cell = 1.0;
        let mut pos = Vec::new();
        // tight clusters at the origin and ~3e6 to 9e6 cells away along each axis
        for c in [[0.0, 0.0, 0.0], [3.1e6, 0.0, 0.0], [0.0, -4.2e6, 0.0], [0.0, 0.0, 9.3e6], [3.1e6, 3.1e6, 3.1e6]] {
            for _ in 0..300 {
                for k in 0..3 {
                    pos.push(c[k] + (rng(&mut seed) - 0.5) * 6.0);
                }
            }
        }
        let n = pos.len() / 3;
        let active = vec![true; n];
        let mut grid = SpatialGrid::new(cell);
        grid.build(&pos, &active);
        let mut a = Vec::new();
        grid.for_each_pair_within(cell, |i, j, _| a.push((i, j)));
        let mut b = Vec::new();
        brute_force_pairs(&pos, &active, cell, |i, j, _| b.push((i, j)));
        a.sort_unstable();
        b.sort_unstable();
        assert!(!b.is_empty());
        assert_eq!(a, b);
        for k in (0..n).step_by(37) {
            let p = v3(&pos, k);
            let mut near = Vec::new();
            grid.for_each_near(p, 2.0, |j, _| near.push(j));
            near.sort_unstable();
            let want: Vec<u32> = (0..n as u32).filter(|&j| d2(p, v3(&pos, j as usize)) < 4.0).collect();
            assert_eq!(near, want, "near {k}");
        }
    }
}
