//! Length-prefixed JSON parent↔child IPC for the Wave 0 spike.
//!
//! Frames never carry profile paths, access tokens, or SQLite URLs. The child
//! owns no profile lock.

use std::io::{Read, Write};

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use thiserror::Error;

use crate::protocol::{SPIKE_PROTOCOL_NAME, SPIKE_PROTOCOL_VERSION, SpikeIdentity, SpikeLimits};

/// Hard cap on one IPC frame (request or response body).
/// Matches the frozen Phase 7 plugin-output ceiling (256 KiB), not a larger
/// temporary spike allowance.
pub const MAX_FRAME_BYTES: usize = 256 * 1024;

#[derive(Debug, Error)]
pub enum IpcError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("frame too large: {size} > {max}")]
    FrameTooLarge { size: usize, max: usize },
    #[error("invalid frame length")]
    InvalidLength,
    #[error("protocol mismatch: {0}")]
    Protocol(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum HostRequest {
    Hello {
        protocol_name: String,
        protocol_version: u32,
        identity: SpikeIdentity,
        limits: SpikeLimits,
    },
    LoadComponent {
        /// Absolute path readable by the child. Never a profile/token path.
        component_path: String,
    },
    Instantiate,
    Ping {
        input: u32,
    },
    WarmPing {
        input: u32,
        iterations: u32,
    },
    ForceTrap,
    CpuLoop,
    GrowMemory {
        pages: u32,
    },
    /// Host-side sleep used only for in-flight crash probes (parent blocked on reply).
    Sleep {
        ms: u64,
    },
    DropInstance,
    DropEngine,
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum HostResponse {
    Ok {
        timings_ms: Timings,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<serde_json::Value>,
    },
    Err {
        kind: String,
        message: String,
        #[serde(default)]
        timings_ms: Timings,
    },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Timings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_create_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compile_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instantiate_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_call_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warm_call_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminate_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_ms: Option<f64>,
}

impl HostRequest {
    pub fn hello(identity: SpikeIdentity, limits: SpikeLimits) -> Self {
        Self::Hello {
            protocol_name: SPIKE_PROTOCOL_NAME.to_owned(),
            protocol_version: SPIKE_PROTOCOL_VERSION,
            identity,
            limits,
        }
    }
}

pub fn write_frame<W: Write, T: Serialize>(writer: &mut W, value: &T) -> Result<(), IpcError> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(IpcError::FrameTooLarge {
            size: bytes.len(),
            max: MAX_FRAME_BYTES,
        });
    }
    let len = u32::try_from(bytes.len()).map_err(|_| IpcError::InvalidLength)?;
    writer.write_all(&len.to_le_bytes())?;
    writer.write_all(&bytes)?;
    writer.flush()?;
    Ok(())
}

pub fn read_frame<R: Read, T: DeserializeOwned>(reader: &mut R) -> Result<T, IpcError> {
    let mut len_buf = [0_u8; 4];
    reader.read_exact(&mut len_buf)?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > MAX_FRAME_BYTES {
        return Err(IpcError::FrameTooLarge {
            size: len,
            max: MAX_FRAME_BYTES,
        });
    }
    let mut buf = vec![0_u8; len];
    reader.read_exact(&mut buf)?;
    Ok(serde_json::from_slice(&buf)?)
}

pub fn validate_hello(protocol_name: &str, protocol_version: u32) -> Result<(), IpcError> {
    if protocol_name != SPIKE_PROTOCOL_NAME {
        return Err(IpcError::Protocol(format!(
            "name {protocol_name:?} != {SPIKE_PROTOCOL_NAME:?}"
        )));
    }
    if protocol_version != SPIKE_PROTOCOL_VERSION {
        return Err(IpcError::Protocol(format!(
            "version {protocol_version} != {SPIKE_PROTOCOL_VERSION}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::ComponentKind;
    use std::io::Cursor;

    #[test]
    fn round_trip_frame() {
        let req = HostRequest::Ping { input: 7 };
        let mut buf = Vec::new();
        write_frame(&mut buf, &req).unwrap();
        let mut cursor = Cursor::new(buf);
        let decoded: HostRequest = read_frame(&mut cursor).unwrap();
        match decoded {
            HostRequest::Ping { input } => assert_eq!(input, 7),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn hello_identity_has_no_token_fields() {
        let raw = serde_json::to_string(&HostRequest::hello(
            SpikeIdentity {
                session_id: "s1".into(),
                component_sha256: "abc".into(),
                component_kind: ComponentKind::Rust,
            },
            SpikeLimits::default(),
        ))
        .unwrap();
        assert!(!raw.contains("token"));
        assert!(!raw.contains("sqlite"));
        assert!(!raw.contains("data_dir"));
        assert!(!raw.contains("profile"));
    }

    #[test]
    fn frame_cap_rejects_oversized_payload() {
        let huge = serde_json::json!({ "blob": "x".repeat(MAX_FRAME_BYTES) });
        let mut buf = Vec::new();
        let err = write_frame(&mut buf, &huge).expect_err("oversized frame");
        match err {
            IpcError::FrameTooLarge { size, max } => {
                assert!(size > max);
                assert_eq!(max, MAX_FRAME_BYTES);
            }
            other => panic!("unexpected {other:?}"),
        }
    }
}
