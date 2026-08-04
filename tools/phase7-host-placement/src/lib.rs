//! TEMPORARY Phase 7 Wave 0 host-placement spike library.
//!
//! Not the product plugin SDK/host. Safe to delete after the placement ADR.

pub mod child_ipc;
pub mod imports;
pub mod protocol;
pub mod sha256;

#[cfg(feature = "wasmtime-runtime")]
pub mod runtime;

pub use imports::{
    MAX_COMPONENT_BYTES, RUST_BASELINE_IMPORTS, imports_match_exact, inspect_component_imports,
    rust_baseline_ok, typescript_pure_ok,
};
pub use protocol::{
    SPIKE_PROTOCOL_NAME, SPIKE_PROTOCOL_VERSION, SpikeCaps, SpikeIdentity, SpikeLimits,
};
pub use sha256::{sha256_bytes_hex, sha256_file_hex};
