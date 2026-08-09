//! Stable CLI/MCP error codes and exit status mapping.

use std::io;

use serde::Serialize;
use serde_json::Value;
use thiserror::Error;

use junban_server::LocalApiOwnerError;

/// Process exit codes used by the `junban` binary.
pub const EXIT_SUCCESS: i32 = 0;
pub const EXIT_USAGE: i32 = 2;
pub const EXIT_RUNTIME: i32 = 1;
pub const EXIT_BUSY: i32 = 3;
pub const EXIT_AUTH: i32 = 4;

/// Stable machine-readable CLI error.
#[derive(Debug, Error)]
pub enum CliError {
    #[error("{message}")]
    Usage {
        code: &'static str,
        message: String,
        request_id: Option<String>,
        retryable: Option<bool>,
        details: Option<Value>,
    },
    #[error("{message}")]
    Runtime {
        code: &'static str,
        message: String,
        request_id: Option<String>,
        retryable: Option<bool>,
        details: Option<Value>,
    },
    #[error("{message}")]
    Busy {
        code: &'static str,
        message: String,
        request_id: Option<String>,
        retryable: Option<bool>,
        details: Option<Value>,
    },
    #[error("{message}")]
    Auth {
        code: &'static str,
        message: String,
        request_id: Option<String>,
        retryable: Option<bool>,
        details: Option<Value>,
    },
}

impl CliError {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Usage { code, .. }
            | Self::Runtime { code, .. }
            | Self::Busy { code, .. }
            | Self::Auth { code, .. } => code,
        }
    }

    #[must_use]
    pub fn exit_code(&self) -> i32 {
        match self {
            Self::Usage { .. } => EXIT_USAGE,
            Self::Runtime { .. } => EXIT_RUNTIME,
            Self::Busy { .. } => EXIT_BUSY,
            Self::Auth { .. } => EXIT_AUTH,
        }
    }

    #[must_use]
    pub fn request_id(&self) -> Option<&str> {
        match self {
            Self::Usage { request_id, .. }
            | Self::Runtime { request_id, .. }
            | Self::Busy { request_id, .. }
            | Self::Auth { request_id, .. } => request_id.as_deref(),
        }
    }

    #[must_use]
    pub fn retryable(&self) -> Option<bool> {
        match self {
            Self::Usage { retryable, .. }
            | Self::Runtime { retryable, .. }
            | Self::Busy { retryable, .. }
            | Self::Auth { retryable, .. } => *retryable,
        }
    }

    #[must_use]
    pub fn details(&self) -> Option<&Value> {
        match self {
            Self::Usage { details, .. }
            | Self::Runtime { details, .. }
            | Self::Busy { details, .. }
            | Self::Auth { details, .. } => details.as_ref(),
        }
    }

    #[must_use]
    pub fn usage(code: &'static str, message: impl Into<String>) -> Self {
        Self::Usage {
            code,
            message: message.into(),
            request_id: None,
            retryable: Some(false),
            details: None,
        }
    }

    #[must_use]
    pub fn runtime(code: &'static str, message: impl Into<String>) -> Self {
        Self::Runtime {
            code,
            message: message.into(),
            request_id: None,
            retryable: None,
            details: None,
        }
    }

    #[must_use]
    pub fn busy(code: &'static str, message: impl Into<String>) -> Self {
        Self::Busy {
            code,
            message: message.into(),
            request_id: None,
            retryable: Some(true),
            details: None,
        }
    }

    #[must_use]
    pub fn auth(code: &'static str, message: impl Into<String>) -> Self {
        Self::Auth {
            code,
            message: message.into(),
            request_id: None,
            retryable: Some(false),
            details: None,
        }
    }

    #[must_use]
    pub fn with_server_fields(
        mut self,
        request_id: Option<String>,
        retryable: Option<bool>,
        details: Option<Value>,
    ) -> Self {
        match &mut self {
            Self::Usage {
                request_id: slot_id,
                retryable: slot_retry,
                details: slot_details,
                ..
            }
            | Self::Runtime {
                request_id: slot_id,
                retryable: slot_retry,
                details: slot_details,
                ..
            }
            | Self::Busy {
                request_id: slot_id,
                retryable: slot_retry,
                details: slot_details,
                ..
            }
            | Self::Auth {
                request_id: slot_id,
                retryable: slot_retry,
                details: slot_details,
                ..
            } => {
                *slot_id = request_id;
                *slot_retry = retryable;
                *slot_details = details;
            }
        }
        self
    }

    #[must_use]
    pub fn to_json(&self) -> ErrorJson {
        ErrorJson {
            error: ErrorBodyJson {
                code: self.code().to_owned(),
                message: self.to_string(),
                request_id: self.request_id().map(str::to_owned),
                retryable: self.retryable(),
                details: self.details().cloned(),
            },
        }
    }
}

impl From<io::Error> for CliError {
    fn from(error: io::Error) -> Self {
        Self::runtime("io_error", error.to_string())
    }
}

impl From<LocalApiOwnerError> for CliError {
    fn from(error: LocalApiOwnerError) -> Self {
        match error {
            LocalApiOwnerError::AlreadyOwned => Self::busy(
                "profile_busy",
                "profile is already owned and no matching runtime is reachable",
            ),
            LocalApiOwnerError::RecoveryRequired(message) => {
                Self::runtime("recovery_required", message)
            }
            LocalApiOwnerError::Io(error) => error.into(),
            LocalApiOwnerError::Database(message) => Self::runtime("database_error", message),
        }
    }
}

/// Single JSON error document written to stdout in `--json` mode.
#[derive(Debug, Serialize)]
pub struct ErrorJson {
    pub error: ErrorBodyJson,
}

#[derive(Debug, Serialize)]
pub struct ErrorBodyJson {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}
