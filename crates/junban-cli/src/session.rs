//! Authenticated HTTP session over discovered or temporary local owners.

use std::path::PathBuf;
use std::time::Duration;

use junban_server::LocalApiOwner;
use reqwest::{Client, redirect::Policy};
use serde::de::DeserializeOwned;

use junban_server::{AutomationScope, PrincipalKindDto, PrincipalResponse};

use crate::discovery::{
    ExplicitTarget, HEALTH_PROBE_TIMEOUT, HealthPayload, OWNER_RETRY_ATTEMPTS, OWNER_RETRY_DELAY,
    RuntimeHint, TargetOptions, load_credential_file, load_operator_token,
    metadata_address_is_loopback, read_runtime_hint, validate_explicit_server,
};
use crate::error::CliError;
use crate::executor::map_error_envelope;

/// Live principal capabilities from the server authority (never from local credential metadata).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PrincipalCapabilities {
    pub kind: PrincipalKindDto,
    pub scopes: Vec<AutomationScope>,
}

impl PrincipalCapabilities {
    #[must_use]
    pub fn is_operator(&self) -> bool {
        matches!(self.kind, PrincipalKindDto::Operator)
    }

    #[must_use]
    pub fn has_scope(&self, scope: AutomationScope) -> bool {
        self.scopes.contains(&scope)
    }

    #[must_use]
    pub fn has_read(&self) -> bool {
        self.has_scope(AutomationScope::Read)
    }

    #[must_use]
    pub fn has_write(&self) -> bool {
        self.has_scope(AutomationScope::Write)
    }

    #[must_use]
    pub fn has_data(&self) -> bool {
        self.has_scope(AutomationScope::Data)
    }
}

/// How the session attached to an owner.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionMode {
    /// Attached to an already-running local owner via verified runtime metadata.
    Discovered,
    /// Started an in-process API-only owner for this process lifetime.
    TemporaryOwner,
    /// Explicit `--server` authority override with a credential file.
    Explicit,
}

/// Whether a failed exact POST is known to have stopped before registration.
pub(crate) enum ExactPostFailure {
    Local(CliError),
    Rejected(CliError),
    Ambiguous,
}

/// Shared CLI/MCP session. Holds at most one temporary owner.
pub struct Session {
    client: Client,
    base_url: String,
    /// Bearer loaded only after identity checks (or from an explicit credential file).
    bearer: Option<String>,
    instance_id: Option<String>,
    mode: SessionMode,
    local_owner: Option<LocalApiOwner>,
    /// Local profile path retained for one-shot reconnect after a discovered owner exits.
    /// Path only — never stores token or credential material.
    local_profile_dir: Option<PathBuf>,
    /// Captured Authorization headers are never exposed; tests use [`HeaderProbe`].
    #[cfg(test)]
    pub(crate) authorization_send_attempted: bool,
}

impl Session {
    /// Build a redirect-disabled HTTP client for loopback and system-root HTTPS.
    pub fn build_http_client() -> Result<Client, CliError> {
        Client::builder()
            .redirect(Policy::none())
            .timeout(Duration::from_secs(30))
            .connect_timeout(HEALTH_PROBE_TIMEOUT)
            .no_proxy()
            .build()
            .map_err(|error| CliError::runtime("http_client_build_failed", error.to_string()))
    }

    /// Connect using discovery, explicit target rules, or temporary ownership.
    pub async fn connect(options: TargetOptions) -> Result<Self, CliError> {
        let client = Self::build_http_client()?;
        if let Some(server) = options.server.as_deref() {
            return Self::connect_explicit(client, server, options.credential_file.as_deref())
                .await;
        }
        Self::connect_local(client, options).await
    }

    async fn connect_explicit(
        client: Client,
        server: &str,
        credential_file: Option<&std::path::Path>,
    ) -> Result<Self, CliError> {
        let ExplicitTarget { base_url } = validate_explicit_server(server)?;
        let credential_path = credential_file.ok_or_else(|| {
            CliError::usage(
                "credential_file_required",
                "explicit --server requires --credential-file or JUNBAN_CREDENTIAL_FILE",
            )
        })?;
        let bearer = load_credential_file(credential_path)?;
        // Probe health without credentials so redirects/cleartext mistakes cannot leak a bearer.
        let _ = probe_health(&client, &base_url).await?;
        Ok(Self {
            client,
            base_url,
            bearer: Some(bearer),
            instance_id: None,
            mode: SessionMode::Explicit,
            local_owner: None,
            local_profile_dir: None,
            #[cfg(test)]
            authorization_send_attempted: false,
        })
    }

    async fn connect_local(client: Client, options: TargetOptions) -> Result<Self, CliError> {
        let attachment = attach_local(&client, &options.profile_dir).await?;
        Ok(Self::from_local_attachment(
            client,
            options.profile_dir,
            attachment,
        ))
    }

    fn from_local_attachment(
        client: Client,
        profile_dir: PathBuf,
        attachment: LocalAttachment,
    ) -> Self {
        Self {
            client,
            base_url: attachment.base_url,
            bearer: Some(attachment.bearer),
            instance_id: Some(attachment.instance_id),
            mode: attachment.mode,
            local_owner: attachment.local_owner,
            local_profile_dir: Some(profile_dir),
            #[cfg(test)]
            authorization_send_attempted: false,
        }
    }

    /// Discovered local sessions may reconnect once after a definitive connect failure.
    pub(crate) fn can_reconnect_discovered_connect(&self) -> bool {
        matches!(self.mode, SessionMode::Discovered) && self.local_profile_dir.is_some()
    }

    /// Re-attach through verified discovery or exclusive temporary ownership.
    ///
    /// Clears any prior bearer before network use and reloads the operator token only after
    /// instance-matched verification. Used when a discovered owner exits before the first
    /// public or authenticated request is dispatched (`reqwest` connect failure).
    pub(crate) async fn reconnect_local_after_discovered_connect_failure(
        &mut self,
    ) -> Result<(), CliError> {
        if !self.can_reconnect_discovered_connect() {
            return Err(CliError::runtime(
                "session_reconnect_unavailable",
                "local reconnect is only available for discovered local sessions",
            ));
        }
        let profile_dir = self.local_profile_dir.clone().ok_or_else(|| {
            CliError::runtime(
                "session_reconnect_unavailable",
                "local reconnect requires a retained profile target",
            )
        })?;
        // Discovered sessions never hold a temporary owner; drop secrets before rediscovery.
        debug_assert!(self.local_owner.is_none());
        self.bearer = None;
        self.instance_id = None;

        let attachment = attach_local(&self.client, &profile_dir).await?;
        self.base_url = attachment.base_url;
        self.bearer = Some(attachment.bearer);
        self.instance_id = Some(attachment.instance_id);
        self.mode = attachment.mode;
        self.local_owner = attachment.local_owner;
        self.local_profile_dir = Some(profile_dir);
        Ok(())
    }

    /// On definitive connect failure for a discovered local session, reconnect once.
    ///
    /// Returns `Ok(())` so the caller can retry the same request against the replacement
    /// session. Explicit remote targets, temporary owners, timeouts, body/decode/status
    /// errors, and non-connect transport failures are returned unchanged.
    async fn retry_after_discovered_connect_failure(
        &mut self,
        error: CliError,
    ) -> Result<(), CliError> {
        if error.code() != "http_connect_failed" || !self.can_reconnect_discovered_connect() {
            return Err(error);
        }
        self.reconnect_local_after_discovered_connect_failure()
            .await
    }

    #[must_use]
    pub fn mode(&self) -> SessionMode {
        self.mode
    }

    #[must_use]
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    #[must_use]
    pub fn instance_id(&self) -> Option<&str> {
        self.instance_id.as_deref()
    }

    pub(crate) fn client(&self) -> &Client {
        &self.client
    }

    pub(crate) fn bearer_str(&self) -> Result<&str, CliError> {
        self.bearer.as_deref().ok_or_else(|| {
            CliError::auth(
                "authorization_unavailable",
                "session has no bearer credential",
            )
        })
    }

    #[cfg(test)]
    pub(crate) fn mark_authorization_attempted(&mut self) {
        self.authorization_send_attempted = true;
    }

    /// Perform an unauthenticated GET (used by status health).
    ///
    /// Discovered local sessions get one bounded reconnect on definitive connect failure,
    /// matching authenticated GET/catalog handoff. Explicit targets never reconnect.
    pub async fn get_json_public<T: DeserializeOwned>(
        &mut self,
        path: &str,
    ) -> Result<T, CliError> {
        match self.get_json_public_once(path).await {
            Ok(value) => Ok(value),
            Err(error) => {
                self.retry_after_discovered_connect_failure(error).await?;
                self.get_json_public_once(path).await
            }
        }
    }

    async fn get_json_public_once<T: DeserializeOwned>(&self, path: &str) -> Result<T, CliError> {
        let url = join_url(&self.base_url, path);
        let response = self
            .client
            .get(&url)
            .header("Host", host_header_for(&self.base_url)?)
            .send()
            .await
            .map_err(|error| map_transport_error(error, false))?;
        reject_redirect(&response)?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| CliError::runtime("http_body_failed", error.to_string()))?;
        if !status.is_success() {
            return Err(CliError::runtime(
                "http_status",
                format!("GET {path} failed with status {status}"),
            ));
        }
        serde_json::from_slice(&bytes)
            .map_err(|error| CliError::runtime("http_decode_failed", error.to_string()))
    }

    /// Authenticated GET used by catalog and operator commands.
    pub async fn get_json_authenticated<T: DeserializeOwned>(
        &mut self,
        path: &str,
    ) -> Result<T, CliError> {
        let bytes = self
            .authenticated_exchange(reqwest::Method::GET, path, None::<&()>)
            .await?;
        serde_json::from_slice(&bytes)
            .map_err(|error| CliError::runtime("http_decode_failed", error.to_string()))
    }

    /// Fetch live principal kind and exact scope names from server authority.
    ///
    /// MCP and CLI must not trust local credential-file metadata for filtering.
    pub async fn principal_capabilities(&mut self) -> Result<PrincipalCapabilities, CliError> {
        let response: PrincipalResponse = self
            .get_json_authenticated("/api/v1/auth/principal")
            .await?;
        Ok(PrincipalCapabilities {
            kind: response.kind,
            scopes: response.scopes,
        })
    }

    /// Authenticated JSON POST with a fresh operation id (safe to retry with the same id).
    pub async fn post_json_authenticated<T: DeserializeOwned>(
        &mut self,
        path: &str,
        body: &impl serde::Serialize,
    ) -> Result<T, CliError> {
        let bytes = self
            .authenticated_exchange(reqwest::Method::POST, path, Some(body))
            .await?;
        serde_json::from_slice(&bytes)
            .map_err(|error| CliError::runtime("http_decode_failed", error.to_string()))
    }

    /// Authenticated JSON POST whose serialized bytes and operation id are caller-owned.
    ///
    /// Credential creation uses this to replay one exact request after an ambiguous
    /// transport, body, decode, or response-validation outcome.
    pub(crate) async fn post_json_authenticated_exact<T: DeserializeOwned>(
        &mut self,
        path: &str,
        body: &[u8],
        operation_id: &str,
    ) -> Result<T, ExactPostFailure> {
        match self
            .post_json_authenticated_exact_once(path, body, operation_id)
            .await
        {
            Err(ExactPostFailure::Local(error)) => {
                self.retry_after_discovered_connect_failure(error)
                    .await
                    .map_err(ExactPostFailure::Local)?;
                self.post_json_authenticated_exact_once(path, body, operation_id)
                    .await
            }
            other => other,
        }
    }

    async fn post_json_authenticated_exact_once<T: DeserializeOwned>(
        &mut self,
        path: &str,
        body: &[u8],
        operation_id: &str,
    ) -> Result<T, ExactPostFailure> {
        let bearer = self.bearer.as_deref().ok_or_else(|| {
            ExactPostFailure::Local(CliError::auth(
                "authorization_unavailable",
                "session has no bearer credential",
            ))
        })?;
        let url = join_url(&self.base_url, path);
        let host = host_header_for(&self.base_url).map_err(ExactPostFailure::Local)?;
        let request = self
            .client
            .post(&url)
            .header("Host", host)
            .header("Authorization", format!("Bearer {bearer}"))
            .header("Idempotency-Key", operation_id)
            .header("Content-Type", "application/json")
            .body(body.to_vec())
            .build()
            .map_err(|error| {
                ExactPostFailure::Local(CliError::runtime(
                    "http_request_build_failed",
                    error.to_string(),
                ))
            })?;
        #[cfg(test)]
        {
            self.authorization_send_attempted = true;
        }
        let response = self.client.execute(request).await.map_err(|error| {
            if error.is_connect() {
                ExactPostFailure::Local(map_transport_error(error, true))
            } else {
                ExactPostFailure::Ambiguous
            }
        })?;
        if response.status().is_redirection() {
            return Err(ExactPostFailure::Ambiguous);
        }
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|_| ExactPostFailure::Ambiguous)?;
        if status.is_server_error() {
            return Err(ExactPostFailure::Ambiguous);
        }
        if !status.is_success() {
            return Err(ExactPostFailure::Rejected(map_error_envelope(
                status, &bytes, "POST", path,
            )));
        }
        serde_json::from_slice(&bytes).map_err(|_| ExactPostFailure::Ambiguous)
    }

    /// Authenticated DELETE with empty body.
    pub async fn delete_authenticated(&mut self, path: &str) -> Result<(), CliError> {
        let _ = self
            .authenticated_exchange(reqwest::Method::DELETE, path, None::<&()>)
            .await?;
        Ok(())
    }

    async fn authenticated_exchange(
        &mut self,
        method: reqwest::Method,
        path: &str,
        body: Option<&impl serde::Serialize>,
    ) -> Result<Vec<u8>, CliError> {
        match self
            .authenticated_exchange_once(method.clone(), path, body)
            .await
        {
            Ok(bytes) => Ok(bytes),
            Err(error) => {
                self.retry_after_discovered_connect_failure(error).await?;
                self.authenticated_exchange_once(method, path, body).await
            }
        }
    }

    async fn authenticated_exchange_once(
        &mut self,
        method: reqwest::Method,
        path: &str,
        body: Option<&impl serde::Serialize>,
    ) -> Result<Vec<u8>, CliError> {
        let bearer = self.bearer_str()?.to_owned();
        #[cfg(test)]
        {
            self.mark_authorization_attempted();
        }
        let url = join_url(&self.base_url, path);
        let mut builder = self
            .client
            .request(method.clone(), &url)
            .header("Host", host_header_for(&self.base_url)?)
            .header("Authorization", format!("Bearer {bearer}"));
        // Credential admin and similar operator routes do not require Idempotency-Key.
        // Catalog mutations go through RequestPlan, which sets the header from OpenAPI.
        if method != reqwest::Method::GET && method != reqwest::Method::DELETE && body.is_some() {
            builder = builder.header("Idempotency-Key", uuid::Uuid::now_v7().to_string());
        }
        if let Some(body) = body {
            builder = builder
                .header("Content-Type", "application/json")
                .json(body);
        }
        let response = builder
            .send()
            .await
            .map_err(|error| map_transport_error(error, true))?;
        reject_redirect(&response)?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| CliError::runtime("http_body_failed", error.to_string()))?
            .to_vec();
        if status.is_success() {
            return Ok(bytes);
        }
        Err(map_error_envelope(status, &bytes, method.as_str(), path))
    }

    /// Release a temporary owner if this session started one.
    pub async fn shutdown(mut self) {
        if let Some(owner) = self.local_owner.take() {
            owner.shutdown().await;
        }
    }
}

/// RAII-style helper: always shut down a temporary owner even when the command fails.
pub async fn with_session<T, F>(options: TargetOptions, work: F) -> Result<T, CliError>
where
    F: for<'a> AsyncFnOnce(&'a mut Session) -> Result<T, CliError>,
{
    let mut session = Session::connect(options).await?;
    let result = work(&mut session).await;
    session.shutdown().await;
    result
}

/// Verified local attachment produced by discovery or temporary ownership.
struct LocalAttachment {
    base_url: String,
    bearer: String,
    instance_id: String,
    mode: SessionMode,
    local_owner: Option<LocalApiOwner>,
}

/// Discover an existing owner or take exclusive temporary ownership.
async fn attach_local(
    client: &Client,
    profile_dir: &std::path::Path,
) -> Result<LocalAttachment, CliError> {
    let mut last_busy = false;
    for attempt in 0..OWNER_RETRY_ATTEMPTS {
        if let Some(attachment) = try_discover_local(client, profile_dir).await? {
            return Ok(attachment);
        }

        match LocalApiOwner::start(profile_dir.to_path_buf()).await {
            Ok(owner) => {
                let base_url = owner.base_url();
                let instance_id = owner.instance_id().to_owned();
                let health = probe_health(client, &base_url).await?;
                if health.instance_id != instance_id {
                    owner.shutdown().await;
                    return Err(CliError::runtime(
                        "instance_mismatch",
                        "temporary owner health instance_id did not match runtime metadata",
                    ));
                }
                // Load operator token only after instance-matched verification.
                let bearer = load_operator_token(profile_dir)?;
                return Ok(LocalAttachment {
                    base_url,
                    bearer,
                    instance_id,
                    mode: SessionMode::TemporaryOwner,
                    local_owner: Some(owner),
                });
            }
            Err(junban_server::LocalApiOwnerError::AlreadyOwned) => {
                last_busy = true;
                if attempt + 1 < OWNER_RETRY_ATTEMPTS {
                    tokio::time::sleep(OWNER_RETRY_DELAY).await;
                    continue;
                }
            }
            Err(error) => return Err(error.into()),
        }
    }
    if last_busy {
        return Err(CliError::busy(
            "profile_busy",
            "profile is already owned and no matching runtime became reachable",
        ));
    }
    Err(CliError::runtime(
        "session_connect_failed",
        "could not discover or start a local owner",
    ))
}

async fn try_discover_local(
    client: &Client,
    profile_dir: &std::path::Path,
) -> Result<Option<LocalAttachment>, CliError> {
    let RuntimeHint::Present(metadata) = read_runtime_hint(profile_dir) else {
        return Ok(None);
    };
    if !metadata_address_is_loopback(&metadata) {
        // Automatic discovery never leaves loopback; ignore non-loopback hints.
        return Ok(None);
    }
    let base_url = format!("http://{}", metadata.address);
    let health = match probe_health(client, &base_url).await {
        Ok(health) => health,
        Err(_) => return Ok(None), // stale pid/port: ignore and fall through
    };
    if health.instance_id != metadata.instance_id {
        // Do not load or send the operator token to a mismatched process.
        return Ok(None);
    }
    // Load operator token only after instance-matched verification.
    let bearer = load_operator_token(profile_dir)?;
    Ok(Some(LocalAttachment {
        base_url,
        bearer,
        instance_id: metadata.instance_id,
        mode: SessionMode::Discovered,
        local_owner: None,
    }))
}

pub async fn probe_health(client: &Client, base_url: &str) -> Result<HealthPayload, CliError> {
    let url = join_url(base_url, "/api/v1/health");
    let response = client
        .get(&url)
        .header("Host", host_header_for(base_url)?)
        .timeout(HEALTH_PROBE_TIMEOUT)
        .send()
        .await
        .map_err(|error| map_transport_error(error, false))?;
    reject_redirect(&response)?;
    if !response.status().is_success() {
        return Err(CliError::runtime(
            "health_failed",
            format!("health probe failed with status {}", response.status()),
        ));
    }
    response
        .json::<HealthPayload>()
        .await
        .map_err(|error| CliError::runtime("health_decode_failed", error.to_string()))
}

fn reject_redirect(response: &reqwest::Response) -> Result<(), CliError> {
    if response.status().is_redirection() {
        return Err(CliError::runtime(
            "redirect_rejected",
            format!("refusing to follow HTTP redirect from {}", response.url()),
        ));
    }
    Ok(())
}

fn join_url(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
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

fn map_transport_error(error: reqwest::Error, authorization_attached: bool) -> CliError {
    // Transport failures after attaching Authorization still did not follow redirects.
    // Never format the Authorization header or bearer into the error message.
    let _ = authorization_attached;
    if error.is_timeout() {
        CliError::runtime("http_timeout", "HTTP request timed out")
    } else if error.is_connect() {
        CliError::runtime("http_connect_failed", "HTTP connect failed")
    } else {
        CliError::runtime("http_transport_failed", "HTTP transport failed")
    }
}
