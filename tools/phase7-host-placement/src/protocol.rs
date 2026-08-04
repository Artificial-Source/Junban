//! SDK/protocol-only types for the Wave 0 spike.
//!
//! Intentionally free of Wasmtime, SQLite, tokens, and profile paths so a
//! protocol-only binary can be linked and measured without constructing an engine.

use serde::{Deserialize, Serialize};

/// Stable spike protocol name (not a product ABI).
pub const SPIKE_PROTOCOL_NAME: &str = "junban-phase7-host-placement-spike-v1";

/// Spike protocol version carried on every parent↔child frame.
pub const SPIKE_PROTOCOL_VERSION: u32 = 1;

/// Preliminary resource ceilings mirrored from the Phase 7 context map.
/// Wave 0 may tighten these; it must not silently raise them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpikeLimits {
    pub rust_memory_pages: u32,
    pub typescript_memory_pages: u32,
    pub epoch_deadline_ms: u64,
    pub invoke_wall_ms: u64,
}

impl Default for SpikeLimits {
    fn default() -> Self {
        Self {
            // 64 MiB Rust / 128 MiB TypeScript preliminary linear-memory profiles.
            rust_memory_pages: 1024,
            typescript_memory_pages: 2048,
            // Enforced by the explicit cpu_loop epoch ticker probe only.
            // Ordinary ping/warm/trap calls are not wrapped in a separate wall
            // deadline in this spike; product Wave 2 must enforce both.
            epoch_deadline_ms: 250,
            invoke_wall_ms: 1_000,
        }
    }
}

/// Capability bits the spike host may enable. Default is deny-all beyond the
/// minimal WASI baseline required to instantiate the guest toolchain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct SpikeCaps {
    pub allow_filesystem: bool,
    pub allow_sockets: bool,
    pub allow_env: bool,
}

/// Identity stamped on child sessions. Contains no profile path or token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpikeIdentity {
    pub session_id: String,
    pub component_sha256: String,
    pub component_kind: ComponentKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComponentKind {
    Rust,
    Typescript,
}

/// Ensure the protocol constants are retained in SDK-only binaries so linkage
/// cost is real rather than fully GCd away by LTO.
#[used]
static PROTOCOL_MARKER: [u8; 16] = *b"JUNBANP7SPIKEV1\0";

/// Compile-time proof used by the SDK-only probe.
pub fn protocol_banner() -> String {
    format!("{SPIKE_PROTOCOL_NAME}/v{SPIKE_PROTOCOL_VERSION}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_banner_is_stable() {
        assert_eq!(
            protocol_banner(),
            "junban-phase7-host-placement-spike-v1/v1"
        );
        assert!(!SpikeCaps::default().allow_filesystem);
        assert_eq!(SpikeLimits::default().rust_memory_pages, 1024);
    }
}
