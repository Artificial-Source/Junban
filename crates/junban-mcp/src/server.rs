//! Persistent stdio MCP adapter over the shared CLI session and catalog.

use std::path::PathBuf;
use std::sync::Arc;

use junban_cli::{CliError, PrincipalCapabilities, Session, TargetOptions, catalog};
use rmcp::{
    ErrorData as McpError, RoleServer, ServerHandler, ServiceExt,
    model::{
        CallToolRequestParams, CallToolResponse, GetPromptRequestParams, GetPromptResponse,
        GetPromptResult, ListPromptsResult, ListResourceTemplatesResult, ListResourcesResult,
        ListToolsResult, PaginatedRequestParams, ProgressNotificationParam,
        ReadResourceRequestParams, ReadResourceResponse, ReadResourceResult, Resource,
        ResourceContents, ResourceTemplate, ServerCapabilities, ServerInfo,
    },
    service::RequestContext,
    transport::stdio,
};
use tokio::sync::{Mutex, Notify};
use tokio_util::sync::CancellationToken;
use tracing::warn;

use crate::prompts::{self, PromptKind};
use crate::resources::{self, ResourceUriError};
use crate::tools::{
    CallOutcome, cli_error_to_tool_result, decode_arguments, execute_authorized_plan,
    is_staged_data_tool, list_authorized_mcp_tools, plan_authorized_tool, tool_is_authorized,
};

/// Optional test seam that holds principal discovery until released.
///
/// Used to prove cancellation covers the live principal path and lock waiters
/// without waiting for a delayed HTTP response.
#[derive(Debug, Default)]
pub struct PrincipalDiscoveryHold {
    state: Mutex<HoldState>,
    entered: Notify,
    release: Notify,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum HoldState {
    #[default]
    Idle,
    Waiting,
    Released,
}

impl PrincipalDiscoveryHold {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Wait until a handler has entered the hold point.
    pub async fn wait_entered(&self) {
        loop {
            {
                let state = self.state.lock().await;
                if matches!(*state, HoldState::Waiting | HoldState::Released) {
                    return;
                }
            }
            self.entered.notified().await;
        }
    }

    /// Allow a held principal discovery to continue.
    pub async fn release(&self) {
        {
            let mut state = self.state.lock().await;
            *state = HoldState::Released;
        }
        self.release.notify_waiters();
    }

    async fn hold_until_released(&self, cancel: &CancellationToken) -> Result<(), CallOutcome> {
        {
            let mut state = self.state.lock().await;
            *state = HoldState::Waiting;
        }
        self.entered.notify_waiters();
        loop {
            {
                let state = self.state.lock().await;
                if matches!(*state, HoldState::Released) {
                    return Ok(());
                }
            }
            tokio::select! {
                biased;
                () = cancel.cancelled() => return Err(CallOutcome::Cancelled),
                () = self.release.notified() => {}
            }
        }
    }
}

/// Testable MCP handler bound to one CLI session.
#[derive(Clone)]
pub struct JunbanMcpServer {
    session: Arc<Mutex<Option<Session>>>,
    /// Profile directory retained for diagnostics only; never logged with secrets.
    #[allow(dead_code)]
    profile_dir: PathBuf,
    /// Optional controlled seam for cancellation regressions.
    principal_hold: Option<Arc<PrincipalDiscoveryHold>>,
}

impl JunbanMcpServer {
    pub fn new(session: Session, profile_dir: PathBuf) -> Self {
        Self {
            session: Arc::new(Mutex::new(Some(session))),
            profile_dir,
            principal_hold: None,
        }
    }

    /// Install a principal-discovery hold used only by focused cancellation tests.
    #[must_use]
    pub fn with_principal_hold(mut self, hold: Arc<PrincipalDiscoveryHold>) -> Self {
        self.principal_hold = Some(hold);
        self
    }

    /// Cancelable session critical section covering lock wait + work.
    async fn with_session<T>(
        &self,
        cancel: &CancellationToken,
        work: impl AsyncFnOnce(&mut Session) -> T,
    ) -> Result<T, SessionAccess> {
        let mut guard = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(SessionAccess::Cancelled),
            guard = self.session.lock() => guard,
        };
        let session = guard.as_mut().ok_or(SessionAccess::Closed)?;
        tokio::select! {
            biased;
            () = cancel.cancelled() => Err(SessionAccess::Cancelled),
            result = work(session) => Ok(result),
        }
    }

    async fn current_capabilities(
        &self,
        cancel: &CancellationToken,
    ) -> Result<PrincipalCapabilities, SessionAccess> {
        let hold = self.principal_hold.clone();
        let work_cancel = cancel.clone();
        self.with_session(cancel, async move |session| {
            if let Some(hold) = hold.as_ref() {
                hold.hold_until_released(&work_cancel).await?;
            }
            session
                .principal_capabilities()
                .await
                .map_err(SessionAccess::Cli)
        })
        .await?
    }

    /// Gracefully release a temporary owner when the stdio session ends.
    pub async fn shutdown(self) {
        if let Some(session) = self.session.lock().await.take() {
            session.shutdown().await;
        }
    }
}

#[derive(Debug)]
enum SessionAccess {
    Cancelled,
    Closed,
    Cli(CliError),
}

impl From<CallOutcome> for SessionAccess {
    fn from(value: CallOutcome) -> Self {
        match value {
            CallOutcome::Cancelled => Self::Cancelled,
        }
    }
}

impl ServerHandler for JunbanMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .enable_prompts()
                .build(),
        )
        .with_instructions(
            "Junban MCP server. Tools, resources, and prompts are filtered by the live principal scopes from the server. Prefer resources for reads, exact UUIDs for mutations, and never request or echo bearer tokens.",
        )
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        let capabilities = match self.current_capabilities(&context.ct).await {
            Ok(capabilities) => capabilities,
            Err(SessionAccess::Cancelled) => {
                return Err(McpError::internal_error("request cancelled", None));
            }
            Err(error) => return Err(session_access_to_mcp_error(error)),
        };
        // Live principal scopes only; tool bodies/schemas come from the static cache.
        Ok(ListToolsResult::with_all_items(list_authorized_mcp_tools(
            &capabilities,
        )))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let name = request.name.as_ref();
        let tool = catalog()
            .get(name)
            .ok_or_else(|| McpError::invalid_params(format!("unknown tool '{name}'"), None))?;

        let capabilities = match self.current_capabilities(&context.ct).await {
            Ok(capabilities) => capabilities,
            Err(SessionAccess::Cancelled) => {
                return Err(McpError::internal_error("request cancelled", None));
            }
            Err(error) => return Err(session_access_to_mcp_error(error)),
        };
        if !tool_is_authorized(tool, &capabilities) {
            // Do not distinguish operator-only / out-of-scope / unknown names.
            return Err(McpError::invalid_params(
                format!("unknown tool '{name}'"),
                None,
            ));
        }

        let input = decode_arguments(request.arguments.as_ref())
            .map_err(|error| McpError::invalid_params(error.to_string(), None))?;

        // Local planning/wrapper/path validation must complete before staged progress.
        // One plan owns the mutation operation id; execute it once without re-planning.
        let plan = match plan_authorized_tool(name, input) {
            Ok(plan) => plan,
            Err(error) => return Ok(cli_error_to_tool_result(&error).into()),
        };

        let progress_token = context.meta.get_progress_token();
        if is_staged_data_tool(name)
            && let Some(token) = progress_token.clone()
        {
            let _ = context
                .peer
                .notify_progress(
                    ProgressNotificationParam::new(token, 0.0)
                        .with_total(1.0)
                        .with_message(format!("starting {name}")),
                )
                .await;
        }

        let work_cancel = context.ct.clone();
        let result = match self
            .with_session(&context.ct, async move |session| {
                execute_authorized_plan(session, plan, &work_cancel).await
            })
            .await
        {
            Ok(Ok(result)) => result,
            Ok(Err(CallOutcome::Cancelled)) | Err(SessionAccess::Cancelled) => {
                return Err(McpError::internal_error("request cancelled", None));
            }
            Err(error) => return Err(session_access_to_mcp_error(error)),
        };

        if is_staged_data_tool(name)
            && result.is_error != Some(true)
            && let Some(token) = progress_token
        {
            let _ = context
                .peer
                .notify_progress(
                    ProgressNotificationParam::new(token, 1.0)
                        .with_total(1.0)
                        .with_message(format!("completed {name}")),
                )
                .await;
        }

        Ok(result.into())
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, McpError> {
        let capabilities = match self.current_capabilities(&context.ct).await {
            Ok(capabilities) => capabilities,
            Err(SessionAccess::Cancelled) => {
                return Err(McpError::internal_error("request cancelled", None));
            }
            Err(error) => return Err(session_access_to_mcp_error(error)),
        };
        if !capabilities.has_read() {
            return Ok(ListResourcesResult::with_all_items(vec![]));
        }
        let resources = resources::STATIC_RESOURCES
            .iter()
            .map(|(uri, description)| {
                Resource::new(*uri, *description)
                    .with_description(*description)
                    .with_mime_type("application/json")
            })
            .collect();
        Ok(ListResourcesResult::with_all_items(resources))
    }

    async fn list_resource_templates(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListResourceTemplatesResult, McpError> {
        let capabilities = match self.current_capabilities(&context.ct).await {
            Ok(capabilities) => capabilities,
            Err(SessionAccess::Cancelled) => {
                return Err(McpError::internal_error("request cancelled", None));
            }
            Err(error) => return Err(session_access_to_mcp_error(error)),
        };
        if !capabilities.has_read() {
            return Ok(ListResourceTemplatesResult::with_all_items(vec![]));
        }
        let templates = resources::RESOURCE_TEMPLATES
            .iter()
            .map(|(uri, name, description)| {
                ResourceTemplate::new(*uri, *name)
                    .with_description(*description)
                    .with_mime_type("application/json")
            })
            .collect();
        Ok(ListResourceTemplatesResult::with_all_items(templates))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, McpError> {
        let capabilities = match self.current_capabilities(&context.ct).await {
            Ok(capabilities) => capabilities,
            Err(SessionAccess::Cancelled) => {
                return Err(McpError::internal_error("request cancelled", None));
            }
            Err(error) => return Err(session_access_to_mcp_error(error)),
        };
        if !capabilities.has_read() {
            return Err(McpError::invalid_params(
                "read scope is required for resources",
                None,
            ));
        }

        let target = match resources::parse_resource_uri(&request.uri) {
            Ok(target) => target,
            Err(ResourceUriError::Invalid) => {
                return Err(McpError::invalid_params(
                    format!("invalid resource URI '{}'", request.uri),
                    None,
                ));
            }
        };

        let uri = request.uri.clone();
        let work_cancel = context.ct.clone();
        let body = match self
            .with_session(&context.ct, async move |session| {
                tokio::select! {
                    biased;
                    () = work_cancel.cancelled() => Err(SessionAccess::Cancelled),
                    result = resources::read_resource(session, target) => match result {
                        Ok(value) => resources::encode_resource_bytes(&value)
                            .map_err(SessionAccess::Cli),
                        Err(error) => Err(SessionAccess::Cli(error)),
                    }
                }
            })
            .await
        {
            Ok(Ok(body)) => body,
            Ok(Err(SessionAccess::Cancelled)) | Err(SessionAccess::Cancelled) => {
                return Err(McpError::internal_error("request cancelled", None));
            }
            Ok(Err(SessionAccess::Cli(error))) if error.code() == "not_found" => {
                return Err(McpError::resource_not_found(error.to_string(), None));
            }
            Ok(Err(error)) | Err(error) => return Err(session_access_to_mcp_error(error)),
        };

        Ok(ReadResourceResult::new(vec![
            ResourceContents::text(body, uri).with_mime_type("application/json"),
        ])
        .into())
    }

    async fn list_prompts(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListPromptsResult, McpError> {
        let capabilities = match self.current_capabilities(&context.ct).await {
            Ok(capabilities) => capabilities,
            Err(SessionAccess::Cancelled) => {
                return Err(McpError::internal_error("request cancelled", None));
            }
            Err(error) => return Err(session_access_to_mcp_error(error)),
        };
        Ok(ListPromptsResult::with_all_items(
            prompts::list_prompt_defs(&capabilities),
        ))
    }

    async fn get_prompt(
        &self,
        request: GetPromptRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<GetPromptResponse, McpError> {
        let kind = PromptKind::from_name(&request.name).ok_or_else(|| {
            McpError::invalid_params(format!("unknown prompt '{}'", request.name), None)
        })?;
        let capabilities = match self.current_capabilities(&context.ct).await {
            Ok(capabilities) => capabilities,
            Err(SessionAccess::Cancelled) => {
                return Err(McpError::internal_error("request cancelled", None));
            }
            Err(error) => return Err(session_access_to_mcp_error(error)),
        };
        if !kind.is_authorized(&capabilities) {
            return Err(McpError::invalid_params(
                format!("unknown prompt '{}'", request.name),
                None,
            ));
        }

        let args = prompts::parse_prompt_arguments(kind, request.arguments.as_ref())
            .map_err(|error| McpError::invalid_params(error.to_string(), None))?;

        let work_cancel = context.ct.clone();
        let messages = match self
            .with_session(&context.ct, async move |session| {
                tokio::select! {
                    biased;
                    () = work_cancel.cancelled() => Err(SessionAccess::Cancelled),
                    result = prompts::build_prompt(session, kind, args) => {
                        result.map_err(SessionAccess::Cli)
                    }
                }
            })
            .await
        {
            Ok(Ok(messages)) => messages,
            Ok(Err(SessionAccess::Cancelled)) | Err(SessionAccess::Cancelled) => {
                return Err(McpError::internal_error("request cancelled", None));
            }
            Ok(Err(error)) | Err(error) => return Err(session_access_to_mcp_error(error)),
        };

        Ok(GetPromptResult::new(messages)
            .with_description(kind.description())
            .into())
    }
}

fn session_access_to_mcp_error(error: SessionAccess) -> McpError {
    match error {
        SessionAccess::Cancelled => McpError::internal_error("request cancelled", None),
        SessionAccess::Closed => {
            McpError::internal_error("MCP session has already shut down", None)
        }
        SessionAccess::Cli(error) => cli_error_to_mcp_error(error),
    }
}

fn cli_error_to_mcp_error(error: CliError) -> McpError {
    // Never put raw tokens into protocol errors; CliError messages are already secret-safe.
    match error {
        CliError::Auth { .. } => McpError::invalid_request(error.to_string(), None),
        CliError::Usage { .. } => McpError::invalid_params(error.to_string(), None),
        CliError::Busy { .. } | CliError::Runtime { .. } => {
            McpError::internal_error(error.to_string(), None)
        }
    }
}

/// Connect a session and serve MCP on stdio until EOF or signal cancellation.
pub async fn serve_stdio(options: TargetOptions) -> Result<(), Box<dyn std::error::Error>> {
    let profile_dir = options.profile_dir.clone();
    let session = Session::connect(options).await?;
    let server = JunbanMcpServer::new(session, profile_dir);
    let ct = CancellationToken::new();
    spawn_signal_handler(ct.clone());
    let running = server.clone().serve_with_ct(stdio(), ct).await?;
    let _ = running.waiting().await;
    server.shutdown().await;
    Ok(())
}

fn spawn_signal_handler(ct: CancellationToken) {
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{SignalKind, signal};
            let mut sigterm = match signal(SignalKind::terminate()) {
                Ok(signal) => signal,
                Err(error) => {
                    warn!("failed to install SIGTERM handler: {error}");
                    return;
                }
            };
            let mut sigint = match signal(SignalKind::interrupt()) {
                Ok(signal) => signal,
                Err(error) => {
                    warn!("failed to install SIGINT handler: {error}");
                    return;
                }
            };
            tokio::select! {
                _ = sigterm.recv() => {}
                _ = sigint.recv() => {}
            }
        }
        #[cfg(not(unix))]
        {
            if tokio::signal::ctrl_c().await.is_err() {
                return;
            }
        }
        ct.cancel();
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::cli_error_to_tool_result;
    use junban_cli::ToolAccess;
    use junban_server::{LocalApiOwner, TOKEN_FILE};
    use serde_json::json;
    use std::time::{Duration, Instant};
    use tokio::time::timeout;

    fn write_operator_token(profile: &std::path::Path) {
        std::fs::create_dir_all(profile).unwrap();
        std::fs::write(profile.join(TOKEN_FILE), format!("{}\n", "77".repeat(32))).unwrap();
    }

    #[test]
    fn structured_tool_errors_use_cli_json() {
        let error = CliError::auth(
            "authentication_required",
            "a valid bearer token is required",
        );
        let result = cli_error_to_tool_result(&error);
        assert_eq!(result.is_error, Some(true));
        let structured = result.structured_content.unwrap();
        assert_eq!(structured["error"]["code"], "authentication_required");
        assert!(!structured.to_string().contains("Bearer"));
    }

    #[test]
    fn catalog_has_no_operator_tools_in_routine_filter_path() {
        let operator_count = catalog()
            .tools
            .iter()
            .filter(|tool| tool.access == ToolAccess::OperatorOnly)
            .count();
        assert!(operator_count > 0);
        // Smoke: staged data classification stays narrow.
        assert!(is_staged_data_tool("create_backup"));
        assert!(is_staged_data_tool("export_tasks"));
        assert!(!is_staged_data_tool("preview_import"));
        assert!(!is_staged_data_tool("apply_import"));
        assert!(!is_staged_data_tool("create_task"));
        let _ = json!({});
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_during_principal_discovery_releases_promptly() {
        let root = std::env::temp_dir().join(format!(
            "junban-mcp-cancel-principal-{}-{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        let profile = root.join("profile");
        write_operator_token(&profile);

        let owner = LocalApiOwner::start(profile.clone())
            .await
            .expect("start owner");
        let session = Session::connect(TargetOptions {
            profile_dir: profile.clone(),
            server: Some(owner.base_url()),
            credential_file: Some(profile.join(TOKEN_FILE)),
        })
        .await
        .expect("connect session");

        let hold = Arc::new(PrincipalDiscoveryHold::new());
        let server =
            JunbanMcpServer::new(session, profile.clone()).with_principal_hold(hold.clone());

        let cancel = CancellationToken::new();
        let cancel_worker = cancel.clone();
        let server_worker = server.clone();
        let worker =
            tokio::spawn(async move { server_worker.current_capabilities(&cancel_worker).await });

        timeout(Duration::from_secs(2), hold.wait_entered())
            .await
            .expect("principal hold should be entered");

        // Queue a second caller behind the held principal discovery / session mutex.
        let queued_cancel = CancellationToken::new();
        let queued_token = queued_cancel.clone();
        let queued_server = server.clone();
        let queued =
            tokio::spawn(async move { queued_server.current_capabilities(&queued_token).await });
        // Allow the queued task to reach the mutex wait.
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(20)).await;

        let started = Instant::now();
        queued_cancel.cancel();
        let queued_result = timeout(Duration::from_millis(200), queued)
            .await
            .expect("queued cancellation must not wait on delayed principal")
            .expect("queued task join");
        assert!(matches!(queued_result, Err(SessionAccess::Cancelled)));
        assert!(
            started.elapsed() < Duration::from_millis(200),
            "queued cancel took {:?}",
            started.elapsed()
        );

        cancel.cancel();
        let held_result = timeout(Duration::from_millis(200), worker)
            .await
            .expect("held principal cancel must complete promptly")
            .expect("held task join");
        assert!(matches!(held_result, Err(SessionAccess::Cancelled)));

        // Following request after cancel must not wait for the never-released hold.
        let follow = timeout(
            Duration::from_millis(500),
            server.current_capabilities(&CancellationToken::new()),
        )
        .await;
        // The hold is still armed; install a fresh server path without hold for follow-up.
        drop(follow);
        let session = Session::connect(TargetOptions {
            profile_dir: profile.clone(),
            server: Some(owner.base_url()),
            credential_file: Some(profile.join(TOKEN_FILE)),
        })
        .await
        .expect("reconnect");
        let follow_server = JunbanMcpServer::new(session, profile.clone());
        let follow_caps = timeout(
            Duration::from_secs(2),
            follow_server.current_capabilities(&CancellationToken::new()),
        )
        .await
        .expect("follow-up principal must complete without delayed hold")
        .expect("follow-up capabilities");
        assert!(follow_caps.has_read() || follow_caps.is_operator());

        let shutdown_started = Instant::now();
        timeout(Duration::from_secs(2), server.shutdown())
            .await
            .expect("shutdown must not wait on delayed principal");
        timeout(Duration::from_secs(2), follow_server.shutdown())
            .await
            .expect("follow-up shutdown");
        assert!(
            shutdown_started.elapsed() < Duration::from_secs(2),
            "shutdown took {:?}",
            shutdown_started.elapsed()
        );

        owner.shutdown().await;
        let _ = std::fs::remove_dir_all(root);
    }
}
