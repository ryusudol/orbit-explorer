//! Kessler engine: the physics core of the orbital digital twin.
//!
//! Everything here is written from first principles - no orbital mechanics
//! crates. `satellite.js` and the `sgp4` crate appear only in tests, as
//! independent references.

pub mod batch;
pub mod conjunction;
pub mod coverage;
pub mod frames;
pub mod grid;
pub mod isl;
pub mod sgp4;
pub mod sun;
pub mod time;
pub mod tle;

#[cfg(target_arch = "wasm32")]
mod wasm;

#[cfg(not(target_arch = "wasm32"))]
pub mod verification;
