//! Verified local-owner discovery and explicit target validation.

use std::{
    fs,
    net::IpAddr,
    path::{Path, PathBuf},
    time::Duration,
};

use junban_server::{
    RUNTIME_FILE, RuntimeMetadata, RuntimeMetadataError, default_profile_dir, read_runtime_metadata,
};
use serde::Deserialize;
use url::Url;

use crate::error::CliError;

/// Short unauthenticated health probe timeout used before any bearer is sent.
pub const HEALTH_PROBE_TIMEOUT: Duration = Duration::from_millis(400);
/// Bounded backoff while another process holds the profile lock.
pub const OWNER_RETRY_ATTEMPTS: u32 = 20;
pub const OWNER_RETRY_DELAY: Duration = Duration::from_millis(50);

/// Shared target selection inputs for CLI and MCP.
#[derive(Debug, Clone)]
pub struct TargetOptions {
    pub profile_dir: PathBuf,
    pub server: Option<String>,
    pub credential_file: Option<PathBuf>,
}

impl TargetOptions {
    /// Resolve profile path defaults without inventing a second profile scheme.
    #[must_use]
    pub fn with_defaults(
        profile_dir: Option<PathBuf>,
        server: Option<String>,
        credential_file: Option<PathBuf>,
    ) -> Self {
        Self {
            profile_dir: profile_dir.unwrap_or_else(default_profile_dir),
            server,
            credential_file: credential_file
                .or_else(|| std::env::var_os("JUNBAN_CREDENTIAL_FILE").map(PathBuf::from)),
        }
    }
}

/// Validated explicit server authority.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExplicitTarget {
    pub base_url: String,
}

/// Outcome of reading local runtime metadata without contacting the network.
#[derive(Debug, Clone)]
pub enum RuntimeHint {
    Missing,
    Invalid(String),
    Present(RuntimeMetadata),
}

/// Strict health payload used only for instance matching.
#[derive(Debug, Deserialize)]
pub struct HealthPayload {
    pub status: String,
    pub instance_id: String,
}

/// Best-effort local runtime hint. Never deletes or repairs metadata.
pub fn read_runtime_hint(profile_dir: &Path) -> RuntimeHint {
    match read_runtime_metadata(profile_dir) {
        Ok(None) => RuntimeHint::Missing,
        Ok(Some(Ok(metadata))) => RuntimeHint::Present(metadata),
        Ok(Some(Err(error))) => RuntimeHint::Invalid(error.to_string()),
        Err(error) => RuntimeHint::Invalid(error.to_string()),
    }
}

/// Validate an explicit `--server` URL before any network dial.
pub fn validate_explicit_server(raw: &str) -> Result<ExplicitTarget, CliError> {
    let url = Url::parse(raw).map_err(|error| {
        CliError::usage(
            "invalid_server_url",
            format!("invalid --server URL: {error}"),
        )
    })?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(CliError::usage(
            "server_url_userinfo_forbidden",
            "--server must not include URL userinfo",
        ));
    }
    if url.fragment().is_some() {
        return Err(CliError::usage(
            "server_url_fragment_forbidden",
            "--server must not include a URL fragment",
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| CliError::usage("invalid_server_url", "--server URL must include a host"))?;
    let is_loopback = host_is_loopback(host);
    match url.scheme() {
        "https" => {}
        "http" if is_loopback => {}
        "http" => {
            return Err(CliError::usage(
                "server_cleartext_forbidden",
                "non-loopback --server targets require https",
            ));
        }
        other => {
            return Err(CliError::usage(
                "invalid_server_url",
                format!("unsupported --server scheme '{other}'"),
            ));
        }
    }
    // Normalize to origin + path without trailing ambiguity; keep path if provided.
    let mut base = url.clone();
    base.set_query(None);
    base.set_fragment(None);
    let mut base_url = base.to_string();
    if base_url.ends_with('/') {
        base_url.pop();
    }
    Ok(ExplicitTarget { base_url })
}

/// True when automatic discovery may use this metadata address.
#[must_use]
pub fn metadata_address_is_loopback(metadata: &RuntimeMetadata) -> bool {
    metadata.address.ip().is_loopback()
}

/// Load a credential bearer from an explicit private file path.
pub fn load_credential_file(path: &Path) -> Result<String, CliError> {
    let raw = fs::read_to_string(path).map_err(|error| {
        CliError::auth(
            "credential_file_unreadable",
            format!("could not read credential file {}: {error}", path.display()),
        )
    })?;
    let token = raw.trim();
    if token.is_empty() {
        return Err(CliError::auth(
            "credential_file_empty",
            "credential file is empty",
        ));
    }
    Ok(token.to_owned())
}

/// Load the local operator token only after instance-matched discovery succeeds.
pub fn load_operator_token(profile_dir: &Path) -> Result<String, CliError> {
    let path = profile_dir.join(junban_server::TOKEN_FILE);
    let raw = fs::read_to_string(&path).map_err(|error| {
        CliError::auth(
            "operator_token_unreadable",
            format!("could not read operator token {}: {error}", path.display()),
        )
    })?;
    let token = raw.trim();
    if token.len() < 64 {
        return Err(CliError::auth(
            "operator_token_invalid",
            "operator token is missing or too short",
        ));
    }
    Ok(token.to_owned())
}

#[must_use]
pub fn runtime_metadata_path(profile_dir: &Path) -> PathBuf {
    profile_dir.join(RUNTIME_FILE)
}

#[must_use]
pub fn describe_metadata_error(error: &RuntimeMetadataError) -> String {
    error.to_string()
}

fn host_is_loopback(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::{host_is_loopback, validate_explicit_server};

    #[test]
    fn rejects_userinfo_fragment_and_cleartext_remote() {
        assert_eq!(
            validate_explicit_server("https://user:pass@example.com/api")
                .unwrap_err()
                .code(),
            "server_url_userinfo_forbidden"
        );
        assert_eq!(
            validate_explicit_server("https://example.com/api#frag")
                .unwrap_err()
                .code(),
            "server_url_fragment_forbidden"
        );
        assert_eq!(
            validate_explicit_server("http://example.com")
                .unwrap_err()
                .code(),
            "server_cleartext_forbidden"
        );
        assert!(validate_explicit_server("http://127.0.0.1:4219").is_ok());
        assert!(validate_explicit_server("https://example.com").is_ok());
    }

    #[test]
    fn localhost_is_loopback() {
        assert!(host_is_loopback("localhost"));
        assert!(host_is_loopback("127.0.0.1"));
        assert!(!host_is_loopback("example.com"));
    }
}
