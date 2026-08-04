//! Private plugin-host stdio protocol authority.
//!
//! Each message starts with a canonical JSON header framed by its u32be byte
//! length. Header bytes remain capped at 256 KiB. Exactly one unencoded raw body
//! immediately follows a `Load` header (component bytes), an `Invoke` header
//! (request bytes), or an `Outcome` header (outcome bytes). The corresponding
//! header size determines the body boundary; the body has no second prefix.
//! Every other frame has a zero-byte body. Receivers must read and validate the
//! exact body before reading the next header.

use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{
    error::{Result, SdkError},
    util::{decode_hex_32, is_canonical_id, sha256},
};

pub const HOST_PROTOCOL_VERSION: u16 = 1;
pub const HOST_FRAME_BYTES_MAX: usize = 256 * 1024;
pub const HOST_COMPONENT_BODY_BYTES_MAX: usize = crate::package::COMPONENT_BYTES_MAX;
pub const HOST_REQUEST_BODY_BYTES_MAX: usize = 256 * 1024;
pub const HOST_OUTCOME_BODY_BYTES_MAX: usize = 256 * 1024;
pub const HOST_PROTOCOL_NAME: &str = "junban-plugin-host-v1";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorityFence {
    pub plugin_id: String,
    pub package_generation: u64,
    pub activation_epoch: u64,
    pub host_session_id: String,
    pub invocation_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InvocationKind {
    Activate,
    Deactivate,
    InvokeCommand,
    HandleEvent,
    RenderSurface,
    HandleSurfaceAction,
    ValidateSettings,
    Resync,
    CallService,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ParentFrame {
    Hello {
        protocol_version: u16,
        host_session_id: String,
    },
    Load {
        fence: AuthorityFence,
        package_sha256: String,
        component_sha256: String,
        runtime_profile: crate::manifest::RuntimeProfile,
        component_size: u64,
    },
    Invoke {
        fence: AuthorityFence,
        kind: InvocationKind,
        request_sha256: String,
        request_size: u32,
    },
    Cancel {
        fence: AuthorityFence,
    },
    Unload {
        fence: AuthorityFence,
    },
    Shutdown {
        host_session_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ChildFrame {
    Hello {
        protocol_version: u16,
        host_session_id: String,
    },
    Loaded {
        fence: AuthorityFence,
        import_export_fingerprint: String,
    },
    Outcome {
        fence: AuthorityFence,
        outcome_sha256: String,
        outcome_size: u32,
    },
    Failed {
        fence: Option<AuthorityFence>,
        code: HostFailureCode,
    },
    Unloaded {
        fence: AuthorityFence,
    },
    ShutdownComplete {
        host_session_id: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HostFailureCode {
    InvalidFrame,
    StaleAuthority,
    InvalidPackage,
    InvalidComponent,
    PermissionDenied,
    ResourceLimit,
    Timeout,
    Cancelled,
    GuestError,
    Unavailable,
    Internal,
}

impl AuthorityFence {
    pub fn validate(&self) -> Result<()> {
        if !is_canonical_id(&self.plugin_id) {
            return Err(SdkError::Protocol { field: "plugin_id" });
        }
        if self.package_generation == 0 {
            return Err(SdkError::Protocol {
                field: "package_generation",
            });
        }
        validate_uuid(&self.host_session_id, "host_session_id")?;
        validate_uuid(&self.invocation_id, "invocation_id")?;
        Ok(())
    }

    #[must_use]
    pub fn exact_matches(&self, current: &Self) -> bool {
        self == current
    }
}

fn encode_frame<T: Serialize>(frame: &T) -> Result<Vec<u8>> {
    let payload = serde_json::to_vec(frame).map_err(|_| SdkError::Protocol { field: "json" })?;
    if payload.is_empty() || payload.len() > HOST_FRAME_BYTES_MAX {
        return Err(SdkError::Protocol { field: "length" });
    }
    let mut encoded = Vec::with_capacity(4 + payload.len());
    encoded.extend_from_slice(
        &u32::try_from(payload.len())
            .map_err(|_| SdkError::Protocol { field: "length" })?
            .to_be_bytes(),
    );
    encoded.extend_from_slice(&payload);
    Ok(encoded)
}

fn decode_frame<T: DeserializeOwned + Serialize>(bytes: &[u8]) -> Result<T> {
    if bytes.len() < 4 {
        return Err(SdkError::Protocol { field: "truncated" });
    }
    let payload_len = usize::try_from(u32::from_be_bytes(
        bytes[..4]
            .try_into()
            .map_err(|_| SdkError::Protocol { field: "truncated" })?,
    ))
    .map_err(|_| SdkError::Protocol { field: "length" })?;
    if payload_len == 0 || payload_len > HOST_FRAME_BYTES_MAX {
        return Err(SdkError::Protocol { field: "length" });
    }
    let expected = 4_usize
        .checked_add(payload_len)
        .ok_or(SdkError::Protocol { field: "length" })?;
    if bytes.len() != expected {
        return Err(SdkError::Protocol { field: "length" });
    }
    let value: T =
        serde_json::from_slice(&bytes[4..]).map_err(|_| SdkError::Protocol { field: "json" })?;
    if serde_json::to_vec(&value).map_err(|_| SdkError::Protocol { field: "json" })? != bytes[4..] {
        return Err(SdkError::Protocol {
            field: "canonical json",
        });
    }
    Ok(value)
}

pub fn encode_parent_frame(frame: &ParentFrame) -> Result<Vec<u8>> {
    validate_parent_frame(frame)?;
    encode_frame(frame)
}

pub fn encode_child_frame(frame: &ChildFrame) -> Result<Vec<u8>> {
    validate_child_frame(frame)?;
    encode_frame(frame)
}

pub fn decode_parent_frame(bytes: &[u8]) -> Result<ParentFrame> {
    let frame = decode_frame(bytes)?;
    validate_parent_frame(&frame)?;
    Ok(frame)
}

pub fn decode_child_frame(bytes: &[u8]) -> Result<ChildFrame> {
    let frame = decode_frame(bytes)?;
    validate_child_frame(&frame)?;
    Ok(frame)
}

pub fn validate_parent_frame(frame: &ParentFrame) -> Result<()> {
    match frame {
        ParentFrame::Hello {
            protocol_version,
            host_session_id,
        } => {
            validate_version(*protocol_version)?;
            validate_uuid(host_session_id, "host_session_id")
        }
        ParentFrame::Load {
            fence,
            package_sha256,
            component_sha256,
            component_size,
            ..
        } => {
            fence.validate()?;
            decode_hex_32(package_sha256, "package_sha256")?;
            decode_hex_32(component_sha256, "component_sha256")?;
            if *component_size == 0 || *component_size > HOST_COMPONENT_BODY_BYTES_MAX as u64 {
                return Err(SdkError::Protocol {
                    field: "component_size",
                });
            }
            Ok(())
        }
        ParentFrame::Invoke {
            fence,
            request_sha256,
            request_size,
            ..
        } => {
            fence.validate()?;
            decode_hex_32(request_sha256, "request_sha256")?;
            if *request_size == 0
                || usize::try_from(*request_size).unwrap_or(usize::MAX)
                    > HOST_REQUEST_BODY_BYTES_MAX
            {
                return Err(SdkError::Protocol {
                    field: "request_size",
                });
            }
            Ok(())
        }
        ParentFrame::Cancel { fence } | ParentFrame::Unload { fence } => fence.validate(),
        ParentFrame::Shutdown { host_session_id } => {
            validate_uuid(host_session_id, "host_session_id")
        }
    }
}

pub fn validate_child_frame(frame: &ChildFrame) -> Result<()> {
    match frame {
        ChildFrame::Hello {
            protocol_version,
            host_session_id,
        } => {
            validate_version(*protocol_version)?;
            validate_uuid(host_session_id, "host_session_id")
        }
        ChildFrame::Loaded {
            fence,
            import_export_fingerprint,
        } => {
            fence.validate()?;
            decode_hex_32(import_export_fingerprint, "import_export_fingerprint")?;
            Ok(())
        }
        ChildFrame::Outcome {
            fence,
            outcome_sha256,
            outcome_size,
        } => {
            fence.validate()?;
            decode_hex_32(outcome_sha256, "outcome_sha256")?;
            if *outcome_size == 0
                || usize::try_from(*outcome_size).unwrap_or(usize::MAX)
                    > HOST_OUTCOME_BODY_BYTES_MAX
            {
                return Err(SdkError::Protocol {
                    field: "outcome_size",
                });
            }
            Ok(())
        }
        ChildFrame::Failed { fence, .. } => fence.as_ref().map_or(Ok(()), AuthorityFence::validate),
        ChildFrame::Unloaded { fence } => fence.validate(),
        ChildFrame::ShutdownComplete { host_session_id } => {
            validate_uuid(host_session_id, "host_session_id")
        }
    }
}

/// Return the exact raw body length required immediately after a parent header.
pub fn parent_body_len(frame: &ParentFrame) -> Result<usize> {
    validate_parent_frame(frame)?;
    match frame {
        ParentFrame::Load { component_size, .. } => {
            usize::try_from(*component_size).map_err(|_| SdkError::Protocol {
                field: "component_size",
            })
        }
        ParentFrame::Invoke { request_size, .. } => {
            usize::try_from(*request_size).map_err(|_| SdkError::Protocol {
                field: "request_size",
            })
        }
        ParentFrame::Hello { .. }
        | ParentFrame::Cancel { .. }
        | ParentFrame::Unload { .. }
        | ParentFrame::Shutdown { .. } => Ok(0),
    }
}

/// Return the exact raw body length required immediately after a child header.
pub fn child_body_len(frame: &ChildFrame) -> Result<usize> {
    validate_child_frame(frame)?;
    match frame {
        ChildFrame::Outcome { outcome_size, .. } => {
            usize::try_from(*outcome_size).map_err(|_| SdkError::Protocol {
                field: "outcome_size",
            })
        }
        ChildFrame::Hello { .. }
        | ChildFrame::Loaded { .. }
        | ChildFrame::Failed { .. }
        | ChildFrame::Unloaded { .. }
        | ChildFrame::ShutdownComplete { .. } => Ok(0),
    }
}

/// Validate a caller-owned parent body without copying or encoding it.
pub fn validate_parent_body(frame: &ParentFrame, body: &[u8]) -> Result<()> {
    let expected_len = parent_body_len(frame)?;
    let expected_hash = match frame {
        ParentFrame::Load {
            component_sha256, ..
        } => Some((component_sha256.as_str(), "component_sha256")),
        ParentFrame::Invoke { request_sha256, .. } => {
            Some((request_sha256.as_str(), "request_sha256"))
        }
        ParentFrame::Hello { .. }
        | ParentFrame::Cancel { .. }
        | ParentFrame::Unload { .. }
        | ParentFrame::Shutdown { .. } => None,
    };
    validate_body(expected_len, expected_hash, body)
}

/// Validate a caller-owned child body without copying or encoding it.
pub fn validate_child_body(frame: &ChildFrame, body: &[u8]) -> Result<()> {
    let expected_len = child_body_len(frame)?;
    let expected_hash = match frame {
        ChildFrame::Outcome { outcome_sha256, .. } => {
            Some((outcome_sha256.as_str(), "outcome_sha256"))
        }
        ChildFrame::Hello { .. }
        | ChildFrame::Loaded { .. }
        | ChildFrame::Failed { .. }
        | ChildFrame::Unloaded { .. }
        | ChildFrame::ShutdownComplete { .. } => None,
    };
    validate_body(expected_len, expected_hash, body)
}

fn validate_body(
    expected_len: usize,
    expected_hash: Option<(&str, &'static str)>,
    body: &[u8],
) -> Result<()> {
    if body.len() != expected_len {
        return Err(SdkError::Protocol {
            field: "body length",
        });
    }
    if let Some((encoded_hash, field)) = expected_hash
        && decode_hex_32(encoded_hash, field)? != sha256(body)
    {
        return Err(SdkError::Protocol { field: "body hash" });
    }
    Ok(())
}

fn validate_version(version: u16) -> Result<()> {
    if version == HOST_PROTOCOL_VERSION {
        Ok(())
    } else {
        Err(SdkError::Protocol { field: "version" })
    }
}

fn validate_uuid(value: &str, field: &'static str) -> Result<()> {
    let parsed = uuid::Uuid::parse_str(value).map_err(|_| SdkError::Protocol { field })?;
    if parsed.hyphenated().to_string() != value {
        return Err(SdkError::Protocol { field });
    }
    Ok(())
}
