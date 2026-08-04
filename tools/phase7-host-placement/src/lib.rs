//! TEMPORARY Phase 7 Wave 0 host-placement spike library.
//!
//! Not the product plugin SDK/host. Safe to delete after the placement ADR.

pub mod child_ipc;
pub mod protocol;
pub mod sha256;

#[cfg(feature = "wasmtime-runtime")]
pub mod runtime;

pub use protocol::{
    SPIKE_PROTOCOL_NAME, SPIKE_PROTOCOL_VERSION, SpikeCaps, SpikeIdentity, SpikeLimits,
};
pub use sha256::{sha256_bytes_hex, sha256_file_hex};
