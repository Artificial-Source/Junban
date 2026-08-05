//! Bounded HTTP request plans for catalog and operator commands.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::StreamExt;
use junban_server::MAX_BACKUP_BODY_BYTES;
use reqwest::{Body, Method, StatusCode, header};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::catalog::{
    BodyMode, ResponseMode, ToolDefinition, WrapperKind, empty_success_value, wrappers,
};
use crate::error::CliError;
use crate::session::Session;

/// Planned HTTP exchange produced from a catalog tool + JSON input.
#[derive(Debug, Clone)]
pub struct RequestPlan {
    pub method: Method,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub body: RequestBody,
    pub timeout: Duration,
    pub operation_id: Option<String>,
    pub never_retry: bool,
    pub response: PlannedResponse,
    pub post_success: Option<PostSuccessAction>,
}

#[derive(Debug, Clone)]
pub enum RequestBody {
    None,
    Json(Vec<u8>),
    File {
        path: PathBuf,
        content_length: u64,
        content_type: &'static str,
    },
}

#[derive(Debug, Clone)]
pub enum PlannedResponse {
    Json,
    Empty,
    Download { path: PathBuf, overwrite: bool },
}

#[derive(Debug, Clone)]
pub enum PostSuccessAction {
    /// Durably finalize `token` from the response at a resumable reserved path.
    WriteRotatedToken { path: PathBuf },
}

/// Result of executing a request plan.
#[derive(Debug, Clone)]
pub struct ExecutionResult {
    pub value: Value,
    pub status: u16,
    pub operation_id: Option<String>,
}

const TOKEN_ROTATION_PENDING_VERSION: u8 = 1;
const TOKEN_ROTATION_PENDING_SUFFIX: &str = ".junban-token-rotation.pending.json";

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PendingTokenRotation {
    version: u8,
    operation_id: String,
}

#[derive(Debug)]
enum RotationPreparation {
    Dispatch,
    AlreadyFinalized(ExecutionResult),
}

/// Build a request plan from a catalog tool and JSON object input.
pub fn plan_tool_call(tool: &ToolDefinition, input: Value) -> Result<RequestPlan, CliError> {
    let Value::Object(mut input) = input else {
        return Err(CliError::usage(
            "invalid_input_json",
            "tool input must be a JSON object",
        ));
    };

    let confirm_value = tool_confirm_value(tool);
    let wrapper_fields =
        wrappers::validate_wrapper_input(tool.execution.wrapper, confirm_value, &mut input)?;

    let execution = &tool.execution;
    let mut path = execution.path_template.to_owned();
    for name in execution.path_params {
        let raw = take_string_field(&mut input, name)?.ok_or_else(|| {
            CliError::usage(
                "missing_input_field",
                format!("missing required path parameter {name}"),
            )
        })?;
        if name.ends_with("_id") || *name == "source_operation_id" || *name == "credential_id" {
            wrappers::validate_uuid_str(&raw, name)?;
        }
        let placeholder = format!("{{{name}}}");
        if !path.contains(&placeholder) {
            return Err(CliError::runtime(
                "catalog_path_mismatch",
                format!("path template missing {{{name}}}"),
            ));
        }
        if raw.contains('/') || raw.contains('?') || raw.contains('#') {
            return Err(CliError::usage(
                "invalid_id",
                format!("{name} contains invalid path characters"),
            ));
        }
        path = path.replace(&placeholder, &raw);
    }

    let mut query = Vec::new();
    for name in execution.query_params {
        match input.remove(*name) {
            None | Some(Value::Null) => {}
            Some(Value::String(value)) => {
                if matches!(
                    *name,
                    "from" | "to" | "date" | "due_on" | "due_before" | "due_after"
                ) && !value.is_empty()
                    && value != "-"
                {
                    wrappers::validate_civil_date(&value, name)?;
                }
                query.push(((*name).to_owned(), value));
            }
            Some(Value::Bool(value)) => query.push(((*name).to_owned(), value.to_string())),
            Some(Value::Number(value)) => query.push(((*name).to_owned(), value.to_string())),
            Some(Value::Array(values)) => {
                for entry in values {
                    match entry {
                        Value::String(value) => query.push(((*name).to_owned(), value)),
                        Value::Bool(value) => query.push(((*name).to_owned(), value.to_string())),
                        Value::Number(value) => query.push(((*name).to_owned(), value.to_string())),
                        _ => {
                            return Err(CliError::usage(
                                "invalid_input_field",
                                format!("query array {name} entries must be primitives"),
                            ));
                        }
                    }
                }
            }
            Some(_) => {
                return Err(CliError::usage(
                    "invalid_input_field",
                    format!("query parameter {name} has unsupported JSON type"),
                ));
            }
        }
    }

    let body = match execution.body_mode {
        BodyMode::None => {
            reject_extra_fields(&input)?;
            RequestBody::None
        }
        BodyMode::Json => {
            if input.is_empty() {
                RequestBody::None
            } else {
                let bytes = serde_json::to_vec(&Value::Object(input))
                    .map_err(|error| CliError::runtime("input_encode_failed", error.to_string()))?;
                RequestBody::Json(bytes)
            }
        }
        BodyMode::OctetStreamFile => {
            reject_extra_fields(&input)?;
            let path = wrapper_fields.input_path.ok_or_else(|| {
                CliError::usage("missing_input_field", "missing required field input_path")
            })?;
            let content_length =
                wrappers::validate_upload_file(&path, MAX_BACKUP_BODY_BYTES as u64)?;
            RequestBody::File {
                path,
                content_length,
                content_type: "application/octet-stream",
            }
        }
    };

    let response = match execution.response_mode {
        ResponseMode::Json => PlannedResponse::Json,
        ResponseMode::Empty => PlannedResponse::Empty,
        ResponseMode::Download => {
            let path = wrapper_fields.output_path.ok_or_else(|| {
                CliError::usage("missing_input_field", "missing required field output_path")
            })?;
            PlannedResponse::Download {
                path,
                overwrite: wrapper_fields.overwrite,
            }
        }
    };

    let post_success = match execution.wrapper {
        Some(WrapperKind::RotateToken) => Some(PostSuccessAction::WriteRotatedToken {
            path: wrapper_fields.write_token.ok_or_else(|| {
                CliError::usage("missing_input_field", "missing required field write_token")
            })?,
        }),
        _ => None,
    };

    let operation_id = if execution.header_idempotency {
        Some(Uuid::now_v7().to_string())
    } else {
        None
    };

    let method = Method::from_bytes(execution.method.as_bytes()).map_err(|_| {
        CliError::runtime(
            "catalog_method_invalid",
            format!("invalid HTTP method {}", execution.method),
        )
    })?;

    Ok(RequestPlan {
        method,
        path,
        query,
        body,
        timeout: tool.timeout_class.duration(),
        operation_id,
        never_retry: execution.never_retry,
        response,
        post_success,
    })
}

fn reject_extra_fields(input: &Map<String, Value>) -> Result<(), CliError> {
    if input.is_empty() {
        return Ok(());
    }
    let extras: Vec<_> = input.keys().cloned().collect();
    Err(CliError::usage(
        "unexpected_input_field",
        format!("unexpected fields: {}", extras.join(", ")),
    ))
}

fn tool_confirm_value(tool: &ToolDefinition) -> Option<&'static str> {
    match tool.execution.wrapper {
        Some(WrapperKind::RestoreUpload) => Some("restore"),
        Some(WrapperKind::RotateToken) => Some("rotate-token"),
        Some(WrapperKind::ConfirmOnly) => {
            if tool.name.starts_with("revoke_") {
                Some("revoke")
            } else if tool.name.starts_with("clear_") {
                Some("clear")
            } else {
                Some("delete")
            }
        }
        Some(WrapperKind::BulkTasks) => Some("delete"),
        _ => None,
    }
}

fn take_string_field(
    input: &mut Map<String, Value>,
    name: &str,
) -> Result<Option<String>, CliError> {
    match input.remove(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value)),
        Some(_) => Err(CliError::usage(
            "invalid_input_field",
            format!("{name} must be a string"),
        )),
    }
}

impl Session {
    /// Execute a catalog tool by name with a JSON object input.
    pub async fn call_tool(
        &mut self,
        name: &str,
        input: Value,
    ) -> Result<ExecutionResult, CliError> {
        let tool = crate::catalog::catalog()
            .get(name)
            .ok_or_else(|| CliError::usage("unknown_tool", format!("unknown tool '{name}'")))?;
        let plan = plan_tool_call(tool, input)?;
        self.execute_plan(plan).await
    }

    /// Execute a bounded request plan with at most one safe reconciliation retry.
    pub async fn execute_plan(
        &mut self,
        mut plan: RequestPlan,
    ) -> Result<ExecutionResult, CliError> {
        if matches!(
            plan.post_success,
            Some(PostSuccessAction::WriteRotatedToken { .. })
        ) {
            match prepare_token_rotation(&mut plan)? {
                RotationPreparation::Dispatch => {}
                RotationPreparation::AlreadyFinalized(result) => return Ok(result),
            }
        }

        let attempts = if plan.never_retry { 1 } else { 2 };
        let mut last_ambiguous = None;
        let mut connect_reconnect_used = false;
        let mut attempt = 0;
        while attempt < attempts {
            match self.execute_plan_once(&plan).await {
                Ok(result) => return Ok(result),
                Err(PlanFailure::Rejected(error)) => {
                    cleanup_rejected_rotation(&plan);
                    return Err(error);
                }
                Err(PlanFailure::ConnectFailed(error)) => {
                    // Definitive pre-dispatch connect failure on a discovered local owner:
                    // one bounded rediscovery/ownership handoff, then the same RequestPlan.
                    if !connect_reconnect_used && self.can_reconnect_discovered_connect() {
                        connect_reconnect_used = true;
                        self.reconnect_local_after_discovered_connect_failure()
                            .await?;
                        continue;
                    }
                    return Err(error);
                }
                Err(PlanFailure::Local(error)) => return Err(error),
                Err(PlanFailure::Ambiguous(error)) => {
                    attempt += 1;
                    if attempt >= attempts {
                        if plan.never_retry {
                            return Err(restore_outcome_unknown());
                        }
                        if plan.post_success.is_some() {
                            return Err(token_rotation_outcome_unknown());
                        }
                        return Err(error);
                    }
                    last_ambiguous = Some(error);
                }
            }
        }
        Err(last_ambiguous
            .unwrap_or_else(|| CliError::runtime("http_ambiguous", "request outcome is unknown")))
    }

    async fn execute_plan_once(
        &mut self,
        plan: &RequestPlan,
    ) -> Result<ExecutionResult, PlanFailure> {
        let bearer = self.bearer_str().map_err(PlanFailure::Local)?;
        let url =
            build_url(self.base_url(), &plan.path, &plan.query).map_err(PlanFailure::Local)?;
        let host = host_header_for(self.base_url()).map_err(PlanFailure::Local)?;

        let mut builder = self
            .client()
            .request(plan.method.clone(), url)
            .header("Host", host)
            .header("Authorization", format!("Bearer {bearer}"))
            .timeout(plan.timeout);

        if let Some(operation_id) = &plan.operation_id {
            builder = builder.header("Idempotency-Key", operation_id);
        }

        builder = match &plan.body {
            RequestBody::None => builder,
            RequestBody::Json(bytes) => builder
                .header(header::CONTENT_TYPE, "application/json")
                .body(bytes.clone()),
            RequestBody::File {
                path,
                content_length,
                content_type,
            } => {
                let file = tokio::fs::File::open(path).await.map_err(|error| {
                    PlanFailure::Local(CliError::usage(
                        "upload_file_unreadable",
                        format!("could not open {}: {error}", path.display()),
                    ))
                })?;
                builder
                    .header(header::CONTENT_TYPE, *content_type)
                    .header(header::CONTENT_LENGTH, *content_length)
                    .body(Body::from(file))
            }
        };

        #[cfg(test)]
        {
            self.mark_authorization_attempted();
        }

        let response = builder
            .send()
            .await
            .map_err(|error| classify_send_failure(error, plan))?;

        if response.status().is_redirection() {
            return Err(PlanFailure::Ambiguous(CliError::runtime(
                "redirect_rejected",
                format!("refusing to follow HTTP redirect from {}", response.url()),
            )));
        }

        let status = response.status();
        match &plan.response {
            PlannedResponse::Download { path, overwrite } => {
                if !status.is_success() {
                    let bytes = response.bytes().await.map_err(|_| {
                        PlanFailure::Ambiguous(CliError::runtime(
                            "http_body_failed",
                            "failed to read error body",
                        ))
                    })?;
                    return Err(classify_error_status(
                        status,
                        &bytes,
                        plan.method.as_str(),
                        &plan.path,
                        plan.never_retry,
                    ));
                }
                stream_download(response, path, *overwrite)
                    .await
                    .map_err(PlanFailure::Local)?;
                let bytes_written = tokio::fs::metadata(path)
                    .await
                    .map(|meta| meta.len())
                    .unwrap_or(0);
                Ok(ExecutionResult {
                    value: json!({
                        "output_path": path.display().to_string(),
                        "bytes_written": bytes_written,
                    }),
                    status: status.as_u16(),
                    operation_id: plan.operation_id.clone(),
                })
            }
            PlannedResponse::Json | PlannedResponse::Empty => {
                let bytes = response.bytes().await.map_err(|_| {
                    PlanFailure::Ambiguous(CliError::runtime(
                        "http_body_failed",
                        "failed to read response body",
                    ))
                })?;
                if status.is_server_error() {
                    return Err(PlanFailure::Ambiguous(map_error_envelope(
                        status,
                        &bytes,
                        plan.method.as_str(),
                        &plan.path,
                    )));
                }
                if !status.is_success() {
                    return Err(PlanFailure::Rejected(map_error_envelope(
                        status,
                        &bytes,
                        plan.method.as_str(),
                        &plan.path,
                    )));
                }
                if matches!(plan.response, PlannedResponse::Empty)
                    || status == StatusCode::NO_CONTENT
                    || bytes.is_empty()
                {
                    return Ok(ExecutionResult {
                        value: empty_success_value(),
                        status: status.as_u16(),
                        operation_id: plan.operation_id.clone(),
                    });
                }
                let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
                    PlanFailure::Ambiguous(CliError::runtime(
                        "http_decode_failed",
                        "response JSON decode failed",
                    ))
                })?;
                if let Some(PostSuccessAction::WriteRotatedToken { path }) = &plan.post_success {
                    let token = value
                        .get("token")
                        .and_then(Value::as_str)
                        .ok_or_else(|| PlanFailure::Ambiguous(token_rotation_outcome_unknown()))?;
                    finalize_token_rotation(path, token)
                        .map_err(|_| PlanFailure::Ambiguous(token_rotation_outcome_unknown()))?;
                    return Ok(ExecutionResult {
                        value: json!({ "token_path": path.display().to_string() }),
                        status: status.as_u16(),
                        operation_id: plan.operation_id.clone(),
                    });
                }
                Ok(ExecutionResult {
                    value,
                    status: status.as_u16(),
                    operation_id: plan.operation_id.clone(),
                })
            }
        }
    }
}

fn token_rotation_pending_path(path: &Path) -> Result<PathBuf, CliError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let mut name = path
        .file_name()
        .ok_or_else(|| {
            CliError::usage(
                "invalid_input_field",
                "write_token must name a destination file",
            )
        })?
        .to_os_string();
    name.push(TOKEN_ROTATION_PENDING_SUFFIX);
    Ok(parent.join(name))
}

fn prepare_token_rotation(plan: &mut RequestPlan) -> Result<RotationPreparation, CliError> {
    let Some(PostSuccessAction::WriteRotatedToken { path }) = &plan.post_success else {
        return Ok(RotationPreparation::Dispatch);
    };
    crate::auth::prepare_private_output_parent(path)?;
    let pending_path = token_rotation_pending_path(path)?;

    match fs::read(&pending_path) {
        Ok(bytes) => {
            let pending: PendingTokenRotation = serde_json::from_slice(&bytes).map_err(|_| {
                CliError::runtime(
                    "token_rotation_state_invalid",
                    "token rotation pending state is invalid; inspect the destination and pending file before retrying",
                )
            })?;
            if pending.version != TOKEN_ROTATION_PENDING_VERSION
                || Uuid::parse_str(&pending.operation_id).is_err()
            {
                return Err(CliError::runtime(
                    "token_rotation_state_invalid",
                    "token rotation pending state has an unsupported version or operation id",
                ));
            }
            let metadata = fs::symlink_metadata(path).map_err(|_| {
                CliError::runtime(
                    "token_rotation_state_invalid",
                    "token rotation destination is missing while pending state exists",
                )
            })?;
            if !metadata.file_type().is_file() {
                return Err(CliError::runtime(
                    "token_rotation_state_invalid",
                    "token rotation destination is not a regular reserved file",
                ));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if metadata.permissions().mode() & 0o077 != 0 {
                    return Err(CliError::runtime(
                        "token_rotation_state_invalid",
                        "token rotation destination is not owner-private",
                    ));
                }
            }
            plan.operation_id = Some(pending.operation_id.clone());
            if metadata.len() > 0 {
                junban_storage::remove_private_file_durable(&pending_path)
                    .map_err(|_| token_rotation_outcome_unknown())?;
                return Ok(RotationPreparation::AlreadyFinalized(ExecutionResult {
                    value: json!({ "token_path": path.display().to_string() }),
                    status: StatusCode::OK.as_u16(),
                    operation_id: Some(pending.operation_id),
                }));
            }
            Ok(RotationPreparation::Dispatch)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if fs::symlink_metadata(path).is_ok() {
                return Err(CliError::usage(
                    "token_path_exists",
                    "refusing to rotate into an existing destination without matching pending state",
                ));
            }
            let operation_id = plan.operation_id.clone().ok_or_else(|| {
                CliError::runtime(
                    "catalog_operation_id_missing",
                    "token rotation requires an operation id",
                )
            })?;
            let reserved = junban_storage::create_owner_private_file(path).map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    CliError::usage(
                        "token_path_exists",
                        "refusing to rotate into an existing destination",
                    )
                } else {
                    CliError::runtime(
                        "token_rotation_reserve_failed",
                        "could not reserve an owner-private token destination",
                    )
                }
            })?;
            if reserved.sync_all().is_err() {
                drop(reserved);
                let _ = fs::remove_file(path);
                return Err(CliError::runtime(
                    "token_rotation_reserve_failed",
                    "could not sync the reserved token destination",
                ));
            }
            drop(reserved);
            let pending = PendingTokenRotation {
                version: TOKEN_ROTATION_PENDING_VERSION,
                operation_id,
            };
            let mut bytes = serde_json::to_vec(&pending).map_err(|_| {
                CliError::runtime(
                    "token_rotation_state_failed",
                    "could not encode token rotation pending state",
                )
            })?;
            bytes.push(b'\n');
            if junban_storage::atomic_publish_private_bytes(&pending_path, &bytes, false).is_err() {
                let _ = junban_storage::remove_private_file_durable(path);
                return Err(CliError::runtime(
                    "token_rotation_state_failed",
                    "could not durably persist token rotation pending state",
                ));
            }
            Ok(RotationPreparation::Dispatch)
        }
        Err(_) => Err(CliError::runtime(
            "token_rotation_state_invalid",
            "could not read token rotation pending state",
        )),
    }
}

fn finalize_token_rotation(path: &Path, token: &str) -> std::io::Result<()> {
    finalize_token_rotation_with(path, token, |destination, contents| {
        junban_storage::atomic_publish_private_bytes(destination, contents, true)
    })
}

fn finalize_token_rotation_with(
    path: &Path,
    token: &str,
    publish: impl FnOnce(&Path, &[u8]) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let mut contents = token.as_bytes().to_vec();
    contents.push(b'\n');
    publish(path, &contents)?;
    junban_storage::remove_private_file_durable(
        &token_rotation_pending_path(path)
            .map_err(|error| std::io::Error::other(error.to_string()))?,
    )
}

fn cleanup_rejected_rotation(plan: &RequestPlan) {
    let Some(PostSuccessAction::WriteRotatedToken { path }) = &plan.post_success else {
        return;
    };
    if fs::metadata(path).is_ok_and(|metadata| metadata.is_file() && metadata.len() == 0) {
        let _ = fs::remove_file(path);
    }
    if let Ok(pending) = token_rotation_pending_path(path) {
        let _ = junban_storage::remove_private_file_durable(&pending);
    }
}

fn token_rotation_outcome_unknown() -> CliError {
    CliError::runtime(
        "token_rotation_outcome_unknown",
        "token rotation outcome is unknown; the reserved destination and pending state were retained. Rerun the same command with the same destination to resume",
    )
}

fn restore_outcome_unknown() -> CliError {
    CliError::runtime(
        "restore_outcome_unknown",
        "restore outcome is unknown; do not retry automatically. Restart Junban, then check maintenance/recovery status before deciding whether to restore again",
    )
}

enum PlanFailure {
    Local(CliError),
    /// Definitive failure to establish a TCP connection before any request bytes were sent.
    ConnectFailed(CliError),
    Rejected(CliError),
    Ambiguous(CliError),
}

fn classify_send_failure(error: reqwest::Error, plan: &RequestPlan) -> PlanFailure {
    let connect_failed = is_definitive_connect_failure(error.is_connect(), error.is_timeout());
    let mapped = map_transport_error(error);
    if connect_failed && !plan.never_retry {
        // Safe to hand off: no connection means the request was not accepted.
        // Restore (`never_retry`) stays non-retried even on connect failure.
        PlanFailure::ConnectFailed(mapped)
    } else if plan.never_retry || plan.operation_id.is_some() {
        // Once `send` begins, a streamed restore may have been consumed and applied
        // even when no response arrives. Idempotent writes with an operation id are
        // ambiguous on non-connect transport failures and must not auto-replay here.
        PlanFailure::Ambiguous(mapped)
    } else {
        PlanFailure::Local(mapped)
    }
}

fn is_definitive_connect_failure(is_connect: bool, is_timeout: bool) -> bool {
    is_connect && !is_timeout
}

fn classify_error_status(
    status: StatusCode,
    bytes: &[u8],
    method: &str,
    path: &str,
    never_retry: bool,
) -> PlanFailure {
    let error = map_error_envelope(status, bytes, method, path);
    if status.is_server_error() && !never_retry {
        PlanFailure::Ambiguous(error)
    } else {
        PlanFailure::Rejected(error)
    }
}

async fn stream_download(
    response: reqwest::Response,
    path: &Path,
    overwrite: bool,
) -> Result<(), CliError> {
    if path.exists() && !overwrite {
        return Err(CliError::usage(
            "output_exists",
            "refusing to overwrite an existing output path (pass overwrite=true)",
        ));
    }
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        tokio::fs::create_dir_all(parent).await.map_err(|_| {
            CliError::runtime(
                "output_parent_failed",
                "could not create the output parent directory",
            )
        })?;
    }

    // The std helper opens with 0600 on Unix and WRITE_DAC + a protected
    // owner-only DACL on Windows before any response bytes are consumed.
    let (file, temp_path) = junban_storage::create_private_artifact_temp(path).map_err(|_| {
        CliError::runtime(
            "output_temp_failed",
            "could not create an owner-private temporary download",
        )
    })?;
    let cleanup = TempPath(temp_path.clone());
    let mut file = tokio::fs::File::from_std(file);

    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk
            .map_err(|_| CliError::runtime("download_stream_failed", "download stream failed"))?;
        file.write_all(&chunk)
            .await
            .map_err(|_| CliError::runtime("download_write_failed", "could not write download"))?;
    }
    file.flush()
        .await
        .map_err(|_| CliError::runtime("download_flush_failed", "could not flush download"))?;
    file.sync_all()
        .await
        .map_err(|_| CliError::runtime("download_sync_failed", "could not sync download"))?;
    drop(file);

    junban_storage::publish_private_artifact(&temp_path, path, overwrite).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists && !overwrite {
            CliError::usage(
                "output_exists",
                "output path appeared before publication; existing bytes were preserved",
            )
        } else {
            CliError::runtime(
                "output_finalize_failed",
                "could not atomically finalize the download; existing bytes were preserved",
            )
        }
    })?;
    cleanup.defuse();
    Ok(())
}

struct TempPath(PathBuf);

impl TempPath {
    fn defuse(self) {
        std::mem::forget(self);
    }
}

impl Drop for TempPath {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn build_url(base: &str, path: &str, query: &[(String, String)]) -> Result<String, CliError> {
    let mut url = url::Url::parse(&format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    ))
    .map_err(|error| CliError::runtime("invalid_request_url", error.to_string()))?;
    if !query.is_empty() {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in query {
            pairs.append_pair(key, value);
        }
    }
    Ok(url.to_string())
}

fn host_header_for(base_url: &str) -> Result<String, CliError> {
    let url = url::Url::parse(base_url)
        .map_err(|error| CliError::runtime("invalid_base_url", error.to_string()))?;
    let host = url
        .host_str()
        .ok_or_else(|| CliError::runtime("invalid_base_url", "base URL missing host"))?;
    Ok(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    })
}

fn map_transport_error(error: reqwest::Error) -> CliError {
    if error.is_timeout() {
        CliError::runtime("http_timeout", "HTTP request timed out")
    } else if error.is_connect() {
        CliError::runtime("http_connect_failed", "HTTP connect failed")
    } else {
        CliError::runtime("http_transport_failed", "HTTP transport failed")
    }
}

#[derive(Debug, Deserialize)]
struct ServerErrorEnvelope {
    error: ServerErrorBody,
    #[serde(default)]
    request_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ServerErrorBody {
    code: String,
    message: String,
    #[serde(default)]
    retryable: Option<bool>,
    #[serde(default)]
    fields: Option<BTreeMap<String, String>>,
}

pub(crate) fn map_error_envelope(
    status: StatusCode,
    bytes: &[u8],
    method: &str,
    path: &str,
) -> CliError {
    if let Ok(envelope) = serde_json::from_slice::<ServerErrorEnvelope>(bytes) {
        let code = leak_stable_code(&envelope.error.code);
        let message = envelope.error.message;
        let details = envelope.error.fields.map(|fields| {
            let mut map = serde_json::Map::new();
            for (key, value) in fields {
                map.insert(key, Value::String(value));
            }
            Value::Object(map)
        });
        let base = match status {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => CliError::auth(code, message),
            StatusCode::CONFLICT => CliError::runtime(code, message),
            StatusCode::UNPROCESSABLE_ENTITY | StatusCode::BAD_REQUEST => {
                CliError::usage(code, message)
            }
            StatusCode::NOT_FOUND => CliError::runtime(code, message),
            _ => CliError::runtime(code, message),
        };
        return base.with_server_fields(envelope.request_id, envelope.error.retryable, details);
    }
    match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => CliError::auth(
            "authentication_failed",
            format!("{method} {path} was rejected with status {status}"),
        ),
        _ => CliError::runtime(
            "http_status",
            format!("{method} {path} failed with status {status}"),
        ),
    }
}

fn leak_stable_code(code: &str) -> &'static str {
    match code {
        "authentication_required" => "authentication_required",
        "auth_rate_limited" => "auth_rate_limited",
        "operator_required" => "operator_required",
        "insufficient_scope" => "insufficient_scope",
        "credential_conflict" => "credential_conflict",
        "credential_bound_exceeded" => "credential_bound_exceeded",
        "credential_persist_failed" => "credential_persist_failed",
        "validation_error" => "validation_error",
        "invalid_json" => "invalid_json",
        "body_too_large" => "body_too_large",
        "not_found" => "not_found",
        "conflict" => "conflict",
        "restart_required" => "restart_required",
        "maintenance_active" => "maintenance_active",
        "staged_artifact_conflict" => "staged_artifact_conflict",
        "profile_busy" => "profile_busy",
        other => Box::leak(other.to_owned().into_boxed_str()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{catalog, parse_input_arg};
    use serde_json::json;

    #[test]
    fn connect_timeout_is_not_a_definitive_pre_dispatch_failure() {
        assert!(is_definitive_connect_failure(true, false));
        assert!(!is_definitive_connect_failure(true, true));
        assert!(!is_definitive_connect_failure(false, false));
        assert!(!is_definitive_connect_failure(false, true));
    }

    #[test]
    fn plans_list_tasks_query_and_get_method() {
        let tool = catalog().get("list_tasks").unwrap();
        let plan = plan_tool_call(
            tool,
            json!({
                "view": "today",
                "limit": 10
            }),
        )
        .unwrap();
        assert_eq!(plan.method, Method::GET);
        assert_eq!(plan.path, "/api/v1/tasks");
        assert!(plan.query.iter().any(|(k, v)| k == "view" && v == "today"));
        assert!(plan.query.iter().any(|(k, v)| k == "limit" && v == "10"));
        assert!(matches!(plan.body, RequestBody::None));
        assert!(plan.operation_id.is_none());
    }

    #[test]
    fn plans_create_task_json_body_with_operation_id() {
        let tool = catalog().get("create_task").unwrap();
        let plan = plan_tool_call(tool, json!({ "title": "Ship wave 2" })).unwrap();
        assert_eq!(plan.method, Method::POST);
        assert_eq!(plan.path, "/api/v1/tasks");
        match plan.body {
            RequestBody::Json(bytes) => {
                let value: Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(value["title"], "Ship wave 2");
            }
            other => panic!("expected json body, got {other:?}"),
        }
        assert!(plan.operation_id.is_some());
        assert!(!plan.never_retry);
    }

    #[test]
    fn restore_never_retries_and_requires_confirm() {
        let tool = catalog().get("restore_backup").unwrap();
        let err =
            plan_tool_call(tool, json!({ "input_path": "/tmp/nope.junban-backup" })).unwrap_err();
        assert_eq!(err.code(), "confirmation_required");

        let err = plan_tool_call(
            tool,
            json!({
                "input_path": "/tmp/definitely-missing-junban-backup-file",
                "confirm": "restore"
            }),
        )
        .unwrap_err();
        assert_eq!(err.code(), "upload_file_unreadable");
        assert!(tool.execution.never_retry);
    }

    #[test]
    fn download_requires_output_path() {
        let tool = catalog().get("create_backup").unwrap();
        let err = plan_tool_call(tool, json!({})).unwrap_err();
        assert_eq!(err.code(), "missing_input_field");
        let plan = plan_tool_call(
            tool,
            json!({ "output_path": "/tmp/junban-wave2-test.junban-backup" }),
        )
        .unwrap();
        assert!(matches!(plan.response, PlannedResponse::Download { .. }));
    }

    #[test]
    fn rejects_non_uuid_path_ids() {
        let tool = catalog().get("get_task").unwrap();
        let err = plan_tool_call(tool, json!({ "task_id": "not-a-uuid" })).unwrap_err();
        assert_eq!(err.code(), "invalid_id");
    }

    #[test]
    fn parse_input_inline_and_rejects_non_object() {
        let value = parse_input_arg(r#"{"title":"x"}"#).unwrap();
        assert_eq!(value["title"], "x");
        assert_eq!(
            parse_input_arg("[1]").unwrap_err().code(),
            "invalid_input_json"
        );
    }

    #[test]
    fn delete_task_requires_confirm_value() {
        let tool = catalog().get("delete_task").unwrap();
        let id = uuid::Uuid::now_v7().to_string();
        let err = plan_tool_call(tool, json!({ "task_id": id })).unwrap_err();
        assert_eq!(err.code(), "confirmation_required");
    }

    #[test]
    fn bulk_delete_conditionally_requires_and_strips_confirmation() {
        let tool = catalog().get("bulk_tasks").unwrap();
        let id = Uuid::now_v7().to_string();
        let missing = plan_tool_call(
            tool,
            json!({ "task_ids": [&id], "action": { "type": "delete" } }),
        )
        .unwrap_err();
        assert_eq!(missing.code(), "confirmation_required");
        let wrong = plan_tool_call(
            tool,
            json!({
                "task_ids": [&id],
                "action": { "type": "delete" },
                "confirm": "yes"
            }),
        )
        .unwrap_err();
        assert_eq!(wrong.code(), "confirmation_required");

        let plan = plan_tool_call(
            tool,
            json!({
                "task_ids": [&id],
                "action": { "type": "delete" },
                "confirm": "delete"
            }),
        )
        .unwrap();
        let RequestBody::Json(bytes) = plan.body else {
            panic!("bulk requires JSON body")
        };
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(body.get("confirm").is_none());

        let irrelevant = plan_tool_call(
            tool,
            json!({
                "task_ids": [&id],
                "action": { "type": "complete" },
                "confirm": "delete"
            }),
        )
        .unwrap_err();
        assert_eq!(irrelevant.code(), "unexpected_input_field");
        plan_tool_call(
            tool,
            json!({ "task_ids": [&id], "action": { "type": "complete" } }),
        )
        .unwrap();
    }

    fn rotation_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "junban-rotation-unit-{label}-{}-{}",
            std::process::id(),
            Uuid::now_v7()
        ))
    }

    fn rotation_plan(path: &Path) -> RequestPlan {
        plan_tool_call(
            catalog().get("rotate_token").unwrap(),
            json!({
                "write_token": path.display().to_string(),
                "confirm": "rotate-token"
            }),
        )
        .unwrap()
    }

    #[test]
    fn token_rotation_reservation_resumes_exact_operation_and_rejects_unrelated_target() {
        let path = rotation_path("resume");
        let mut first = rotation_plan(&path);
        assert!(matches!(
            prepare_token_rotation(&mut first).unwrap(),
            RotationPreparation::Dispatch
        ));
        let operation_id = first.operation_id.clone().unwrap();
        assert_eq!(fs::metadata(&path).unwrap().len(), 0);

        let mut resumed = rotation_plan(&path);
        assert!(matches!(
            prepare_token_rotation(&mut resumed).unwrap(),
            RotationPreparation::Dispatch
        ));
        assert_eq!(resumed.operation_id.as_deref(), Some(operation_id.as_str()));

        fs::remove_file(token_rotation_pending_path(&path).unwrap()).unwrap();
        let error = prepare_token_rotation(&mut rotation_plan(&path)).unwrap_err();
        assert_eq!(error.code(), "token_path_exists");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn token_rotation_write_failure_retains_strict_resumable_state() {
        let path = rotation_path("write-failure");
        let mut plan = rotation_plan(&path);
        prepare_token_rotation(&mut plan).unwrap();
        let operation_id = plan.operation_id.clone();
        let error = finalize_token_rotation_with(&path, "not-logged-token", |_, _| {
            Err(std::io::Error::other("injected token write failure"))
        })
        .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::Other);
        assert_eq!(fs::metadata(&path).unwrap().len(), 0);
        assert!(token_rotation_pending_path(&path).unwrap().is_file());

        let mut resumed = rotation_plan(&path);
        prepare_token_rotation(&mut resumed).unwrap();
        assert_eq!(resumed.operation_id, operation_id);
        cleanup_rejected_rotation(&resumed);
        assert!(!path.exists());
    }

    #[test]
    fn token_rotation_corrupt_or_unknown_state_fails_closed() {
        let path = rotation_path("corrupt");
        let mut plan = rotation_plan(&path);
        prepare_token_rotation(&mut plan).unwrap();
        let pending = token_rotation_pending_path(&path).unwrap();
        fs::write(
            &pending,
            br#"{"version":2,"operation_id":"bad","extra":true}"#,
        )
        .unwrap();
        let error = prepare_token_rotation(&mut rotation_plan(&path)).unwrap_err();
        assert_eq!(error.code(), "token_rotation_state_invalid");
        assert_eq!(fs::metadata(&path).unwrap().len(), 0);
        fs::remove_file(pending).unwrap();
        fs::remove_file(path).unwrap();
    }
}
