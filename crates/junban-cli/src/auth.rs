//! Operator credential management commands.

use std::{fs, path::Path};

use jiff::Timestamp;
use junban_server::{
    AutomationScope, mint_automation_token, validate_credential_label, validate_scope_list,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::CliError;
use crate::output::{self, OutputMode};
use crate::session::{ExactPostFailure, Session};

/// Result of a successful credential create (never includes the raw token).
#[derive(Debug, Clone, Serialize)]
pub struct CreateCredentialReport {
    pub id: String,
    pub label: String,
    pub scopes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    pub created_at: String,
    pub token_path: String,
}

/// One listed credential.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListedCredential {
    pub id: String,
    pub label: String,
    pub scopes: Vec<AutomationScope>,
    pub created_at: Timestamp,
    #[serde(default)]
    pub expires_at: Option<Timestamp>,
}

#[derive(Debug, Deserialize)]
struct CredentialListResponse {
    credentials: Vec<ListedCredential>,
}

#[derive(Debug, Deserialize)]
struct CredentialDto {
    id: String,
    label: String,
    scopes: Vec<AutomationScope>,
    created_at: Timestamp,
    #[serde(default)]
    expires_at: Option<Timestamp>,
}

/// Create a credential: write the private token file first, then call the server.
pub async fn create_credential(
    session: &mut Session,
    label: &str,
    scopes: &[AutomationScope],
    write_token: &Path,
    expires_at: Option<Timestamp>,
) -> Result<CreateCredentialReport, CliError> {
    // Canonicalize every server-validated field before creating the only durable
    // copy of the secret. The exact canonical material is reused for reconciliation.
    let label = validate_credential_label(label)
        .map_err(|message| CliError::usage("invalid_credential_label", message))?;
    let scopes = validate_scope_list(scopes)
        .map_err(|message| CliError::usage("invalid_credential_scopes", message))?;
    if expires_at.is_some_and(|value| value <= Timestamp::now()) {
        return Err(CliError::usage(
            "invalid_credential_expiry",
            "expires-at must be in the future",
        ));
    }

    let id = Uuid::now_v7();
    let id_string = id.to_string();
    let token = mint_automation_token(&id);
    // Durably write the one-time secret before the server can register its hash.
    write_token_file_exclusive(write_token, &token)?;

    let body = serde_json::to_vec(&serde_json::json!({
        "id": &id_string,
        "label": &label,
        "scopes": &scopes,
        "expires_at": expires_at,
        "token": &token,
    }))
    .map_err(|error| {
        let _ = fs::remove_file(write_token);
        CliError::runtime("credential_request_encode_failed", error.to_string())
    })?;
    drop(token);
    let operation_id = Uuid::now_v7().to_string();

    for attempt in 0..2 {
        let response = session
            .post_json_authenticated_exact::<CredentialDto>(
                "/api/v1/auth/credentials",
                &body,
                &operation_id,
            )
            .await;
        match response {
            Ok(response)
                if response.id == id_string
                    && response.label == label
                    && response.scopes == scopes
                    && response.expires_at == expires_at =>
            {
                return Ok(CreateCredentialReport {
                    id: response.id,
                    label: response.label,
                    scopes: response.scopes.iter().map(ToString::to_string).collect(),
                    expires_at: response.expires_at.map(|value| value.to_string()),
                    created_at: response.created_at.to_string(),
                    token_path: write_token.display().to_string(),
                });
            }
            Err(ExactPostFailure::Local(error)) if attempt == 0 => {
                // No request was sent, so no server can hold this credential.
                let _ = fs::remove_file(write_token);
                return Err(error);
            }
            Err(ExactPostFailure::Rejected(error)) if attempt == 0 => {
                // A complete rejection proves this request did not register, but retain
                // the file: deletion after any server exchange is intentionally avoided.
                return Err(error);
            }
            Ok(_) | Err(_) if attempt == 0 => continue,
            Ok(_) | Err(_) => break,
        }
    }

    Err(CliError::runtime(
        "credential_create_outcome_unknown",
        format!(
            "credential creation outcome is unknown; token file {} was retained. List credentials and revoke id {} if it was registered",
            write_token.display(),
            id_string
        ),
    ))
}

/// List automation credentials (metadata only).
pub async fn list_credentials(session: &mut Session) -> Result<Vec<ListedCredential>, CliError> {
    let response = session
        .get_json_authenticated::<CredentialListResponse>("/api/v1/auth/credentials")
        .await?;
    Ok(response.credentials)
}

/// Revoke a credential by id (idempotent).
pub async fn revoke_credential(session: &mut Session, id: &str) -> Result<(), CliError> {
    let uuid = Uuid::parse_str(id)
        .map_err(|_| CliError::usage("invalid_credential_id", "credential id must be a UUID"))?;
    session
        .delete_authenticated(&format!("/api/v1/auth/credentials/{uuid}"))
        .await
}

pub fn emit_create(mode: OutputMode, report: &CreateCredentialReport) -> Result<(), CliError> {
    match mode {
        OutputMode::Json => output::write_json_success(report),
        OutputMode::Human => {
            output::write_human_line(&format!("created credential {}", report.id))?;
            output::write_human_line(&format!("label: {}", report.label))?;
            output::write_human_line(&format!("scopes: {}", report.scopes.join(",")))?;
            if let Some(expires_at) = &report.expires_at {
                output::write_human_line(&format!("expires_at: {expires_at}"))?;
            }
            output::write_human_line(&format!("token_path: {}", report.token_path))?;
            Ok(())
        }
    }
}

pub fn emit_list(mode: OutputMode, credentials: &[ListedCredential]) -> Result<(), CliError> {
    match mode {
        OutputMode::Json => output::write_json_success(&serde_json::json!({
            "credentials": credentials,
        })),
        OutputMode::Human => {
            if credentials.is_empty() {
                output::write_human_line("no automation credentials")?;
                return Ok(());
            }
            for credential in credentials {
                let scopes = credential
                    .scopes
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join(",");
                let expiry = credential
                    .expires_at
                    .map(|value| format!(" expires={value}"))
                    .unwrap_or_default();
                output::write_human_line(&format!(
                    "{}  {}  scopes={scopes}{expiry}",
                    credential.id, credential.label
                ))?;
            }
            Ok(())
        }
    }
}

pub fn emit_revoke(mode: OutputMode, id: &str) -> Result<(), CliError> {
    match mode {
        OutputMode::Json => output::write_json_success(&serde_json::json!({
            "revoked": id,
        })),
        OutputMode::Human => output::write_human_line(&format!("revoked credential {id}")),
    }
}

fn write_token_file_exclusive(path: &Path, token: &str) -> Result<(), CliError> {
    write_token_file_exclusive_pub(path, token)
}

/// Write a one-time secret to an exclusive owner-private path (shared with token rotation).
pub(crate) fn write_token_file_exclusive_pub(path: &Path, token: &str) -> Result<(), CliError> {
    write_token_file_exclusive_with(path, token, junban_storage::protect_file_owner_only)
}

fn write_token_file_exclusive_with(
    path: &Path,
    token: &str,
    protect: impl FnOnce(&fs::File) -> std::io::Result<()>,
) -> Result<(), CliError> {
    // create_new is the authority against overwrite races.
    use std::fs::OpenOptions;
    use std::io::Write;

    prepare_private_output_parent(path)?;
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::{Foundation::GENERIC_WRITE, Storage::FileSystem::WRITE_DAC};
        options.access_mode(GENERIC_WRITE | WRITE_DAC);
    }
    let mut file = options.open(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            CliError::usage(
                "token_path_exists",
                format!("refusing to overwrite existing path {}", path.display()),
            )
        } else {
            CliError::runtime(
                "token_path_write_failed",
                format!("could not write {}: {error}", path.display()),
            )
        }
    })?;
    if let Err(error) = protect(&file) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(CliError::runtime(
            "token_path_privacy_failed",
            format!("could not protect {}: {error}", path.display()),
        ));
    }
    if let Err(error) = file
        .write_all(token.as_bytes())
        .and_then(|()| file.write_all(b"\n"))
    {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(CliError::runtime(
            "token_path_write_failed",
            format!("could not write {}: {error}", path.display()),
        ));
    }
    if let Err(error) = file.sync_all() {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(CliError::runtime(
            "token_path_sync_failed",
            format!("could not sync {}: {error}", path.display()),
        ));
    }
    drop(file);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| {
            let _ = fs::remove_file(path);
            CliError::runtime(
                "token_path_chmod_failed",
                format!("could not set permissions on {}: {error}", path.display()),
            )
        })?;
    }
    Ok(())
}

pub(crate) fn prepare_private_output_parent(path: &Path) -> Result<(), CliError> {
    let Some(parent) = path.parent().filter(|path| !path.as_os_str().is_empty()) else {
        return Ok(());
    };
    match fs::metadata(parent) {
        Ok(metadata) if metadata.is_dir() => return Ok(()),
        Ok(_) => {
            return Err(CliError::runtime(
                "token_path_parent_failed",
                format!("token parent {} is not a directory", parent.display()),
            ));
        }
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            return Err(CliError::runtime(
                "token_path_parent_failed",
                format!("could not inspect parent {}: {error}", parent.display()),
            ));
        }
        Err(_) => {}
    }

    let mut missing = Vec::new();
    let mut cursor = parent;
    loop {
        if cursor.as_os_str().is_empty() {
            break; // relative paths are rooted at the existing current directory
        }
        match fs::metadata(cursor) {
            Ok(metadata) if metadata.is_dir() => break,
            Ok(_) => {
                return Err(CliError::runtime(
                    "token_path_parent_failed",
                    format!(
                        "token parent ancestor {} is not a directory",
                        cursor.display()
                    ),
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(cursor.to_path_buf());
                cursor = cursor.parent().ok_or_else(|| {
                    CliError::runtime(
                        "token_path_parent_failed",
                        "token path has no existing directory ancestor",
                    )
                })?;
            }
            Err(error) => {
                return Err(CliError::runtime(
                    "token_path_parent_failed",
                    format!("could not inspect parent {}: {error}", cursor.display()),
                ));
            }
        }
    }

    for directory in missing.iter().rev() {
        match create_private_token_directory(directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if !fs::metadata(directory).is_ok_and(|metadata| metadata.is_dir()) {
                    return Err(CliError::runtime(
                        "token_path_parent_failed",
                        format!("token parent {} is not a directory", directory.display()),
                    ));
                }
            }
            Err(error) => {
                return Err(CliError::runtime(
                    "token_path_parent_failed",
                    format!("could not create parent {}: {error}", directory.display()),
                ));
            }
        }
    }
    Ok(())
}

fn create_private_token_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700).create(path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        fs::DirBuilder::new().create(path)
    }
}

/// Parse `--scope` CLI values.
pub fn parse_scope(raw: &str) -> Result<AutomationScope, String> {
    raw.parse().map_err(str::to_owned)
}

/// Parse optional `--expires-at` instant.
pub fn parse_expires_at(raw: &str) -> Result<Timestamp, String> {
    raw.parse::<Timestamp>()
        .map_err(|error| format!("invalid expires-at instant: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "junban-auth-unit-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn privacy_failure_is_before_secret_write_and_removes_empty_file() {
        let root = temp_root("privacy-failure");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("credential.token");
        let error = write_token_file_exclusive_with(&path, "not-logged-secret", |file| {
            assert_eq!(file.metadata().unwrap().len(), 0);
            Err(std::io::Error::other("injected ACL failure"))
        })
        .unwrap_err();
        assert_eq!(error.code(), "token_path_privacy_failed");
        assert!(!path.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn existing_parent_modes_are_never_changed_on_success_or_failure() {
        use std::os::unix::fs::PermissionsExt;

        for (index, mode) in [0o755, 0o2775].into_iter().enumerate() {
            let root = temp_root(&format!("parent-mode-{index}"));
            fs::create_dir_all(&root).unwrap();
            fs::set_permissions(&root, fs::Permissions::from_mode(mode)).unwrap();

            let success = root.join("success.token");
            write_token_file_exclusive(&success, "not-logged-secret").unwrap();
            assert_eq!(
                fs::metadata(&root).unwrap().permissions().mode() & 0o7777,
                mode
            );

            let failure = root.join("failure.token");
            let error = write_token_file_exclusive_with(&failure, "not-logged-secret", |_| {
                Err(std::io::Error::other("injected privacy failure"))
            })
            .unwrap_err();
            assert_eq!(error.code(), "token_path_privacy_failed");
            assert_eq!(
                fs::metadata(&root).unwrap().permissions().mode() & 0o7777,
                mode
            );

            fs::remove_dir_all(root).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn newly_created_destination_parent_is_private() {
        use std::os::unix::fs::PermissionsExt;

        let root = temp_root("new-parent");
        fs::create_dir_all(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        let parent = root.join("intermediate").join("private");
        let path = parent.join("credential.token");
        write_token_file_exclusive(&path, "not-logged-secret").unwrap();

        assert_eq!(
            fs::metadata(root.join("intermediate"))
                .unwrap()
                .permissions()
                .mode()
                & 0o7777,
            0o700
        );
        assert_eq!(
            fs::metadata(&parent).unwrap().permissions().mode() & 0o7777,
            0o700
        );
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o7777,
            0o600
        );
        assert_eq!(
            fs::metadata(&root).unwrap().permissions().mode() & 0o7777,
            0o755
        );
        fs::remove_dir_all(root).unwrap();
    }
}
