use std::{
    io::ErrorKind,
    net::{SocketAddr, TcpListener as StdTcpListener},
    path::{Component, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

mod tauri_paths;

use axum::{
    body::{to_bytes, Body},
    extract::{OriginalUri, Path, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Redirect, Response},
    routing::{any, get, post},
    Json, Router,
};
use mime_guess::from_path;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use socket2::{Domain, Protocol, Socket, Type};
use tauri::{AppHandle, Emitter, Manager, State as TauriState};
use tauri_paths::{
    config_path, db_path, desktop_markdown_path, desktop_plugin_dir, desktop_sidecar_entry_path,
    resource_dir,
};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{oneshot, watch},
    time::{sleep, timeout, Duration, Instant},
};
use uuid::Uuid;

const RUNTIME_SNIPPET: &str =
    r#"<script>window.__JUNBAN_RUNTIME__={mode:"remote-desktop"};</script>"#;
const DESKTOP_RUNTIME_INIT_SCRIPT: &str = r#"
window.__JUNBAN_RUNTIME_READY__ = window.__TAURI_INTERNALS__.invoke('desktop_runtime_descriptor')
  .then((runtime) => {
    window.__JUNBAN_RUNTIME__ = runtime;
    return runtime;
  });
"#;
const REMOTE_SESSION_COOKIE: &str = "junban_remote_session";
const REMOTE_LOGIN_MAX_FAILED_ATTEMPTS: u32 = 5;
const REMOTE_LOGIN_LOCKOUT_SECONDS: u64 = 60;
const DESKTOP_API_HOST: &str = "127.0.0.1";
const DESKTOP_BACKEND_START_ATTEMPTS: usize = 3;
const JUNBAN_BACKEND_SERVICE: &str = "junban-backend";
const DESKTOP_SIDECAR_NAME: &str = "junban-node";
const DESKTOP_RUNTIME_DESCRIPTOR_CHANGED_EVENT: &str = "junban:desktop-runtime-descriptor-changed";

#[derive(Clone)]
struct RemoteWebState {
    resource_dir: PathBuf,
    auth: Arc<Mutex<RemoteAuthState>>,
    desktop_backend: DesktopBackendManager,
    http_client: reqwest::Client,
}

#[derive(Default)]
struct RemoteAuthState {
    password_enabled: bool,
    password_hash: Option<String>,
    active_session_id: Option<String>,
    failed_login_attempts: u32,
    lockout_until: Option<Instant>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteServerStatus {
    available: bool,
    running: bool,
    port: Option<u16>,
    local_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteServerConfigResponse {
    port: u16,
    auto_start: bool,
    password_enabled: bool,
    has_password: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteSessionStatus {
    authorized: bool,
    requires_password: bool,
    session_locked: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RemoteServerConfigFile {
    port: u16,
    auto_start: bool,
    password_enabled: bool,
    password_hash: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteSessionLoginRequest {
    password: String,
}

struct RunningRemoteServer {
    port: u16,
    loopback_only: bool,
    shutdown: Vec<oneshot::Sender<()>>,
    stopped_rx: watch::Receiver<bool>,
    stopping: bool,
}

struct BoundRemoteServerListeners {
    listeners: Vec<TcpListener>,
    port: u16,
}

struct RunningDesktopBackend {
    child: CommandChild,
    port: u16,
}

struct DesktopBackendState {
    child: Option<CommandChild>,
    port: Option<u16>,
    runtime: JunbanRuntimeDescriptor,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DesktopApiRuntimeDescriptor {
    api_base: String,
    health_url: String,
    ready: bool,
    service: String,
    error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct JunbanRuntimeDescriptor {
    mode: String,
    desktop: Option<DesktopApiRuntimeDescriptor>,
}

#[derive(Deserialize)]
struct DesktopBackendHealthResponse {
    ok: bool,
    service: String,
}

#[derive(Default, Clone)]
struct RemoteServerManager {
    inner: Arc<Mutex<Option<RunningRemoteServer>>>,
}

#[derive(Default, Clone)]
struct DesktopBackendManager {
    inner: Arc<Mutex<DesktopBackendState>>,
}

impl Default for DesktopBackendState {
    fn default() -> Self {
        Self {
            child: None,
            port: None,
            runtime: default_runtime_descriptor(),
        }
    }
}

impl DesktopBackendManager {
    fn is_running(&self) -> Result<bool, String> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| "Failed to lock desktop backend state")?;
        Ok(guard.child.is_some())
    }

    fn runtime_descriptor(&self) -> Result<JunbanRuntimeDescriptor, String> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| "Failed to lock desktop backend state")?;
        Ok(guard.runtime.clone())
    }

    fn set_running(
        &self,
        port: u16,
        child: CommandChild,
    ) -> Result<JunbanRuntimeDescriptor, String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "Failed to lock desktop backend state")?;
        let runtime = build_desktop_runtime_descriptor(port);
        guard.port = Some(port);
        guard.runtime = runtime.clone();
        guard.child = Some(child);
        Ok(runtime)
    }

    fn record_startup_failure(
        &self,
        port: Option<u16>,
        error: impl Into<String>,
    ) -> Result<JunbanRuntimeDescriptor, String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "Failed to lock desktop backend state")?;
        let runtime = build_unready_desktop_runtime_descriptor(port, error.into());
        guard.port = port;
        guard.child = None;
        guard.runtime = runtime.clone();
        Ok(runtime)
    }

    fn mark_unready_if_port_matches(
        &self,
        port: u16,
        error: impl Into<String>,
    ) -> Result<Option<JunbanRuntimeDescriptor>, String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "Failed to lock desktop backend state")?;
        if guard.port == Some(port) {
            let runtime = build_unready_desktop_runtime_descriptor(Some(port), error.into());
            guard.child = None;
            guard.runtime = runtime.clone();
            return Ok(Some(runtime));
        }
        Ok(None)
    }
}

fn emit_runtime_descriptor_change(app: &AppHandle, runtime: &JunbanRuntimeDescriptor) {
    if let Err(err) = app.emit(DESKTOP_RUNTIME_DESCRIPTOR_CHANGED_EVENT, runtime) {
        eprintln!("[desktop-backend] Failed to emit runtime descriptor change: {err}");
    }
}

fn default_remote_config() -> RemoteServerConfigFile {
    RemoteServerConfigFile {
        port: 4823,
        auto_start: false,
        password_enabled: false,
        password_hash: None,
    }
}

fn build_status(port: Option<u16>, running: bool, loopback_only: bool) -> RemoteServerStatus {
    let local_host = if loopback_only {
        "127.0.0.1"
    } else {
        "localhost"
    };

    RemoteServerStatus {
        available: true,
        running,
        port,
        local_url: port.map(|value| format!("http://{local_host}:{value}")),
    }
}

fn remote_server_bind_addrs(password_enabled: bool, port: u16) -> Vec<SocketAddr> {
    if password_enabled {
        vec![
            SocketAddr::from(([0, 0, 0, 0], port)),
            SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 0], port)),
        ]
    } else {
        vec![SocketAddr::from(([127, 0, 0, 1], port))]
    }
}

fn bind_remote_listener(
    bind_addr: SocketAddr,
    ipv6_only: bool,
) -> Result<TcpListener, std::io::Error> {
    let domain = if bind_addr.is_ipv6() {
        Domain::IPV6
    } else {
        Domain::IPV4
    };
    let socket = Socket::new(domain, Type::STREAM, Some(Protocol::TCP))?;

    #[cfg(unix)]
    socket.set_reuse_address(true)?;

    if bind_addr.is_ipv6() {
        socket.set_only_v6(ipv6_only)?;
    }

    socket.bind(&bind_addr.into())?;
    socket.listen(1024)?;

    let listener: StdTcpListener = socket.into();
    listener.set_nonblocking(true)?;

    TcpListener::from_std(listener)
}

fn format_remote_listener_bind_error(bind_addr: SocketAddr, err: &std::io::Error) -> String {
    if err.kind() == ErrorKind::AddrInUse {
        return format!(
            "Port {} is already in use. Choose another remote access port.",
            bind_addr.port()
        );
    }

    format!("Failed to bind remote listener {bind_addr}: {err}")
}

fn is_optional_ipv6_bind_failure(err: &std::io::Error) -> bool {
    matches!(
        err.kind(),
        ErrorKind::AddrNotAvailable | ErrorKind::Unsupported
    ) || matches!(err.raw_os_error(), Some(47 | 49 | 97 | 99 | 10047 | 10049))
}

fn bind_remote_server_listeners(
    password_enabled: bool,
    port: u16,
) -> Result<BoundRemoteServerListeners, String> {
    let bind_addrs = remote_server_bind_addrs(password_enabled, port);

    if !password_enabled {
        let listener = bind_remote_listener(bind_addrs[0], false)
            .map_err(|err| format_remote_listener_bind_error(bind_addrs[0], &err))?;
        let actual_port = listener
            .local_addr()
            .map_err(|err| format!("Failed to read remote server address: {err}"))?
            .port();
        return Ok(BoundRemoteServerListeners {
            listeners: vec![listener],
            port: actual_port,
        });
    }

    let ipv4_listener = bind_remote_listener(bind_addrs[0], false)
        .map_err(|err| format_remote_listener_bind_error(bind_addrs[0], &err))?;
    let actual_port = ipv4_listener
        .local_addr()
        .map_err(|err| format!("Failed to read remote server address: {err}"))?
        .port();
    let mut listeners = vec![ipv4_listener];
    let ipv6_bind_addr = SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 0], actual_port));

    match bind_remote_listener(ipv6_bind_addr, true) {
        Ok(listener) => listeners.push(listener),
        Err(err) if is_optional_ipv6_bind_failure(&err) => {}
        Err(err) => return Err(format_remote_listener_bind_error(ipv6_bind_addr, &err)),
    }

    Ok(BoundRemoteServerListeners {
        listeners,
        port: actual_port,
    })
}

fn should_redirect_remote_path_to_root(relative_path: &PathBuf) -> bool {
    relative_path == &PathBuf::from("quick-capture")
}

fn sanitize_relative_path(requested: &str) -> Option<PathBuf> {
    let mut clean = PathBuf::new();
    for component in PathBuf::from(requested).components() {
        match component {
            Component::Normal(segment) => clean.push(segment),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(clean)
}

fn config_response(config: &RemoteServerConfigFile) -> RemoteServerConfigResponse {
    RemoteServerConfigResponse {
        port: config.port,
        auto_start: config.auto_start,
        password_enabled: config.password_enabled,
        has_password: config.password_hash.is_some(),
    }
}

fn desktop_api_base(port: u16) -> String {
    format!("http://{DESKTOP_API_HOST}:{port}/api")
}

fn desktop_health_url(port: u16) -> String {
    format!("{}/health", desktop_api_base(port))
}

fn default_runtime_descriptor() -> JunbanRuntimeDescriptor {
    JunbanRuntimeDescriptor {
        mode: "default".into(),
        desktop: None,
    }
}

fn build_desktop_runtime_descriptor(port: u16) -> JunbanRuntimeDescriptor {
    JunbanRuntimeDescriptor {
        mode: "default".into(),
        desktop: Some(DesktopApiRuntimeDescriptor {
            api_base: desktop_api_base(port),
            health_url: desktop_health_url(port),
            ready: true,
            service: JUNBAN_BACKEND_SERVICE.into(),
            error: None,
        }),
    }
}

fn build_unready_desktop_runtime_descriptor(
    port: Option<u16>,
    error: impl Into<String>,
) -> JunbanRuntimeDescriptor {
    JunbanRuntimeDescriptor {
        mode: "default".into(),
        desktop: Some(DesktopApiRuntimeDescriptor {
            api_base: port.map(desktop_api_base).unwrap_or_default(),
            health_url: port.map(desktop_health_url).unwrap_or_default(),
            ready: false,
            service: JUNBAN_BACKEND_SERVICE.into(),
            error: Some(error.into()),
        }),
    }
}

fn should_skip_proxy_request_header(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection"
            | "content-length"
            | "cookie"
            | "host"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn should_skip_proxy_response_header(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection"
            | "content-length"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn build_remote_api_proxy_target(
    runtime: &JunbanRuntimeDescriptor,
    path_and_query: &str,
) -> Result<String, String> {
    let desktop = runtime.desktop.as_ref().ok_or_else(|| {
        "Desktop backend runtime descriptor is missing the local API base.".to_string()
    })?;

    if !desktop.ready {
        return Err(desktop
            .error
            .clone()
            .unwrap_or_else(|| "Desktop backend is not ready for remote API access.".into()));
    }

    if desktop.api_base.trim().is_empty() {
        return Err("Desktop backend runtime descriptor is missing the local API base.".into());
    }

    let base = desktop.api_base.trim_end_matches('/');
    let suffix = path_and_query
        .strip_prefix("/api")
        .unwrap_or(path_and_query);

    Ok(format!("{base}{suffix}"))
}

fn ensure_remote_access_backend_ready(runtime: &JunbanRuntimeDescriptor) -> Result<(), String> {
    let desktop = runtime
        .desktop
        .as_ref()
        .ok_or_else(|| "Desktop backend sidecar is not ready for remote access.".to_string())?;

    if !desktop.ready {
        return Err(desktop
            .error
            .clone()
            .unwrap_or_else(|| "Desktop backend sidecar is not ready for remote access.".into()));
    }

    if desktop.api_base.trim().is_empty() {
        return Err("Desktop backend runtime descriptor is missing the local API base.".into());
    }

    Ok(())
}

fn reserve_desktop_port() -> Result<u16, String> {
    let listener = StdTcpListener::bind((DESKTOP_API_HOST, 0))
        .map_err(|err| format!("Failed to reserve desktop backend port: {err}"))?;
    let port = listener
        .local_addr()
        .map_err(|err| format!("Failed to read reserved desktop backend port: {err}"))?
        .port();
    drop(listener);
    Ok(port)
}

fn is_expected_desktop_backend_response(response: &str) -> bool {
    let status_ok = response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200");
    let Some((_, body)) = response.split_once("\r\n\r\n") else {
        return false;
    };

    if !status_ok {
        return false;
    }

    serde_json::from_str::<DesktopBackendHealthResponse>(body.trim())
        .map(|payload| payload.ok && payload.service == JUNBAN_BACKEND_SERVICE)
        .unwrap_or(false)
}

async fn wait_for_desktop_backend(port: u16) -> Result<(), String> {
    let started = Instant::now();
    let timeout_after = Duration::from_secs(12);
    let health_url = desktop_health_url(port);
    let mut last_error: Option<String> = None;

    loop {
        if started.elapsed() >= timeout_after {
            return Err(format!(
                "Timed out waiting for desktop backend on {health_url}{}",
                last_error
                    .as_deref()
                    .map(|err| format!(": {err}"))
                    .unwrap_or_default()
            ));
        }

        match TcpStream::connect((DESKTOP_API_HOST, port)).await {
            Ok(mut stream) => {
                let request = format!(
                    "GET /api/health HTTP/1.1\r\nHost: {DESKTOP_API_HOST}:{port}\r\nConnection: close\r\n\r\n"
                );

                if stream.write_all(request.as_bytes()).await.is_ok() {
                    let mut buffer = Vec::new();
                    if let Ok(Ok(_)) =
                        timeout(Duration::from_millis(750), stream.read_to_end(&mut buffer)).await
                    {
                        let response = String::from_utf8_lossy(&buffer).to_string();
                        if is_expected_desktop_backend_response(&response) {
                            return Ok(());
                        }

                        last_error = Some("health endpoint did not identify Junban backend".into());
                    } else {
                        last_error = Some("health endpoint did not finish responding".into());
                    }
                } else {
                    last_error = Some("failed to write readiness probe to backend socket".into());
                }
            }
            Err(err) => {
                last_error = Some(err.to_string());
            }
        }

        sleep(Duration::from_millis(150)).await;
    }
}

async fn spawn_desktop_backend(
    app: &AppHandle,
    manager: DesktopBackendManager,
    port: u16,
) -> Result<RunningDesktopBackend, String> {
    let entry_path = desktop_sidecar_entry_path(app)?;
    if !entry_path.exists() {
        return Err(format!(
            "Missing bundled desktop backend entrypoint: {}",
            entry_path.display()
        ));
    }

    let working_dir = entry_path
        .parent()
        .ok_or_else(|| "Invalid desktop backend entrypoint path".to_string())?
        .to_path_buf();
    let db_path = db_path(app)?;
    let plugin_dir = desktop_plugin_dir(app)?;
    let markdown_path = desktop_markdown_path(app)?;

    fs::create_dir_all(&plugin_dir)
        .await
        .map_err(|err| format!("Failed to prepare desktop plugin directory: {err}"))?;
    fs::create_dir_all(&markdown_path)
        .await
        .map_err(|err| format!("Failed to prepare desktop markdown directory: {err}"))?;

    let (mut rx, child) = app
        .shell()
        .sidecar(DESKTOP_SIDECAR_NAME)
        .map_err(|err| format!("Failed to configure desktop backend sidecar: {err}"))?
        .arg(&entry_path)
        .current_dir(&working_dir)
        .env("API_HOST", DESKTOP_API_HOST)
        .env("API_PORT", port.to_string())
        .env("DB_PATH", db_path)
        .env("MARKDOWN_PATH", markdown_path)
        .env("PLUGIN_DIR", plugin_dir)
        .env("STORAGE_MODE", "sqlite")
        .spawn()
        .map_err(|err| format!("Failed to start desktop backend sidecar: {err}"))?;

    let manager_for_events = manager.clone();
    let app_for_events = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stderr(line) => {
                    eprintln!("[desktop-backend] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Error(err) => {
                    eprintln!("[desktop-backend] command error: {err}");
                    if let Ok(Some(runtime)) = manager_for_events.mark_unready_if_port_matches(
                        port,
                        format!("Desktop backend command error: {err}"),
                    ) {
                        emit_runtime_descriptor_change(&app_for_events, &runtime);
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let message = format!(
                        "Desktop backend exited with code {:?} signal {:?}",
                        payload.code, payload.signal
                    );
                    if payload.code != Some(0) {
                        eprintln!("[desktop-backend] {message}");
                    }
                    if let Ok(Some(runtime)) =
                        manager_for_events.mark_unready_if_port_matches(port, message)
                    {
                        emit_runtime_descriptor_change(&app_for_events, &runtime);
                    }
                }
                _ => {}
            }
        }
    });

    if let Err(err) = wait_for_desktop_backend(port).await {
        let _ = child.kill();
        return Err(err);
    }

    Ok(RunningDesktopBackend { child, port })
}

async fn start_desktop_backend_internal(
    app: AppHandle,
    manager: DesktopBackendManager,
) -> Result<(), String> {
    if manager.is_running()? {
        return Ok(());
    }

    let mut last_error: Option<String> = None;
    let mut last_port: Option<u16> = None;

    for _attempt in 0..DESKTOP_BACKEND_START_ATTEMPTS {
        let port = match reserve_desktop_port() {
            Ok(port) => port,
            Err(err) => {
                if let Ok(runtime) = manager.record_startup_failure(None, err.clone()) {
                    emit_runtime_descriptor_change(&app, &runtime);
                }
                return Err(err);
            }
        };
        last_port = Some(port);

        match spawn_desktop_backend(&app, manager.clone(), port).await {
            Ok(running) => {
                let runtime = manager.set_running(running.port, running.child)?;
                emit_runtime_descriptor_change(&app, &runtime);
                return Ok(());
            }
            Err(err) => {
                last_error = Some(err);
            }
        }
    }

    let error = last_error.unwrap_or_else(|| "Failed to start desktop backend sidecar".into());
    if let Ok(runtime) = manager.record_startup_failure(last_port, error.clone()) {
        emit_runtime_descriptor_change(&app, &runtime);
    }
    Err(error)
}

async fn load_remote_config(app: &AppHandle) -> Result<RemoteServerConfigFile, String> {
    let path = config_path(app)?;
    match fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|err| format!("Failed to parse remote access config: {err}")),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(default_remote_config()),
        Err(err) => Err(format!("Failed to read remote access config: {err}")),
    }
}

async fn save_remote_config(
    app: &AppHandle,
    config: &RemoteServerConfigFile,
) -> Result<(), String> {
    let path = config_path(app)?;
    let Some(parent) = path.parent() else {
        return Err("Invalid remote access config path".into());
    };

    fs::create_dir_all(parent)
        .await
        .map_err(|err| format!("Failed to prepare remote access config directory: {err}"))?;
    let bytes = serde_json::to_vec_pretty(config)
        .map_err(|err| format!("Failed to serialize remote access config: {err}"))?;
    fs::write(path, bytes)
        .await
        .map_err(|err| format!("Failed to write remote access config: {err}"))
}

async fn read_static_file(path: PathBuf) -> Option<Vec<u8>> {
    fs::read(path).await.ok()
}

fn hash_password(password: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(password.as_bytes());
    let digest = hasher.finalize();
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn parse_session_cookie(headers: &HeaderMap) -> Option<String> {
    let raw_cookie = headers.get(header::COOKIE)?.to_str().ok()?;
    raw_cookie.split(';').map(str::trim).find_map(|cookie| {
        cookie
            .strip_prefix(&format!("{REMOTE_SESSION_COOKIE}="))
            .map(str::to_string)
    })
}

fn session_cookie_header(session_id: &str) -> Option<HeaderValue> {
    HeaderValue::from_str(&format!(
        "{REMOTE_SESSION_COOKIE}={session_id}; Path=/; HttpOnly; SameSite=Lax"
    ))
    .ok()
}

#[derive(Debug, PartialEq, Eq)]
struct ParsedOriginComponents {
    scheme: String,
    host: String,
    port: Option<u16>,
}

fn parse_host_header_components(value: &str) -> Option<(String, Option<u16>)> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    let parsed = reqwest::Url::parse(&format!("http://{trimmed}")).ok()?;
    if parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return None;
    }

    Some((parsed.host_str()?.to_ascii_lowercase(), parsed.port()))
}

fn parse_origin_header_components(value: &str) -> Option<ParsedOriginComponents> {
    let parsed = reqwest::Url::parse(value.trim()).ok()?;
    Some(ParsedOriginComponents {
        scheme: parsed.scheme().to_ascii_lowercase(),
        host: parsed.host_str()?.to_ascii_lowercase(),
        port: parsed.port(),
    })
}

fn is_same_origin_remote_post(headers: &HeaderMap) -> bool {
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_host_header_components);
    let Some((host_name, host_port)) = host else {
        return false;
    };

    if let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    {
        if let Some(parsed_origin) = parse_origin_header_components(origin) {
            return matches!(parsed_origin.scheme.as_str(), "http" | "https")
                && parsed_origin.host == host_name
                && parsed_origin.port == host_port;
        }
        return false;
    }

    if let Some(referer) = headers
        .get(header::REFERER)
        .and_then(|value| value.to_str().ok())
    {
        if let Some(parsed_origin) = parse_origin_header_components(referer) {
            return matches!(parsed_origin.scheme.as_str(), "http" | "https")
                && parsed_origin.host == host_name
                && parsed_origin.port == host_port;
        }
    }

    false
}

fn build_session_status(auth: &RemoteAuthState, session_id: Option<&str>) -> RemoteSessionStatus {
    let matches_current = auth
        .active_session_id
        .as_deref()
        .zip(session_id)
        .is_some_and(|(active, incoming)| active == incoming);

    RemoteSessionStatus {
        authorized: matches_current,
        requires_password: auth.password_enabled,
        session_locked: auth.active_session_id.is_some() && !matches_current,
    }
}

fn build_json_response<T: Serialize>(payload: &T, set_cookie: Option<HeaderValue>) -> Response {
    let mut response = Json(payload).into_response();
    if let Some(cookie) = set_cookie {
        response.headers_mut().insert(header::SET_COOKIE, cookie);
    }
    response
}

fn authorize_remote_session(
    auth: &mut RemoteAuthState,
) -> (RemoteSessionStatus, Option<HeaderValue>) {
    let new_session_id = Uuid::new_v4().to_string();
    auth.active_session_id = Some(new_session_id.clone());
    auth.failed_login_attempts = 0;
    auth.lockout_until = None;
    let cookie = session_cookie_header(&new_session_id);
    (build_session_status(auth, Some(&new_session_id)), cookie)
}

fn active_login_lockout_duration(auth: &mut RemoteAuthState, now: Instant) -> Option<Duration> {
    let Some(lockout_until) = auth.lockout_until else {
        return None;
    };

    if now >= lockout_until {
        auth.lockout_until = None;
        auth.failed_login_attempts = 0;
        return None;
    }

    Some(lockout_until.saturating_duration_since(now))
}

fn register_failed_login_attempt(auth: &mut RemoteAuthState, now: Instant) -> Option<Duration> {
    auth.failed_login_attempts = auth.failed_login_attempts.saturating_add(1);
    if auth.failed_login_attempts < REMOTE_LOGIN_MAX_FAILED_ATTEMPTS {
        return None;
    }

    auth.failed_login_attempts = 0;
    let lockout = Duration::from_secs(REMOTE_LOGIN_LOCKOUT_SECONDS);
    auth.lockout_until = Some(now + lockout);
    Some(lockout)
}

fn build_login_lockout_response(retry_after: Duration) -> Response {
    let mut response = (
        StatusCode::TOO_MANY_REQUESTS,
        "Too many failed password attempts. Try again later.",
    )
        .into_response();
    let retry_seconds = retry_after.as_secs().max(1).to_string();
    if let Ok(value) = HeaderValue::from_str(&retry_seconds) {
        response.headers_mut().insert(header::RETRY_AFTER, value);
    }
    response
}

fn read_remote_session_status(auth: &RemoteAuthState, headers: &HeaderMap) -> RemoteSessionStatus {
    let session_cookie = parse_session_cookie(headers);
    build_session_status(auth, session_cookie.as_deref())
}

fn is_remote_request_authorized(state: &RemoteWebState, headers: &HeaderMap) -> bool {
    let session_cookie = parse_session_cookie(headers);
    let Ok(auth) = state.auth.lock() else {
        return false;
    };

    auth.active_session_id
        .as_deref()
        .zip(session_cookie.as_deref())
        .is_some_and(|(active, incoming)| active == incoming)
}

async fn serve_index(state: &RemoteWebState) -> Response {
    let index_path = state.resource_dir.join("dist").join("index.html");
    match fs::read_to_string(index_path).await {
        Ok(html) => {
            let injected = if html.contains("</head>") {
                html.replace("</head>", &format!("{RUNTIME_SNIPPET}</head>"))
            } else {
                format!("{RUNTIME_SNIPPET}{html}")
            };
            (
                [(
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("text/html; charset=utf-8"),
                )],
                injected,
            )
                .into_response()
        }
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Missing bundled frontend assets",
        )
            .into_response(),
    }
}

async fn serve_asset_file(full_path: PathBuf) -> Response {
    match read_static_file(full_path.clone()).await {
        Some(bytes) => {
            let mime = from_path(full_path).first_or_octet_stream();
            (
                [(
                    header::CONTENT_TYPE,
                    HeaderValue::from_str(mime.as_ref())
                        .unwrap_or(HeaderValue::from_static("application/octet-stream")),
                )],
                bytes,
            )
                .into_response()
        }
        None => (StatusCode::NOT_FOUND, "Not found").into_response(),
    }
}

async fn serve_app_root(State(state): State<RemoteWebState>) -> Response {
    serve_index(&state).await
}

async fn serve_app_path(
    Path(requested_path): Path<String>,
    State(state): State<RemoteWebState>,
) -> Response {
    let Some(relative_path) = sanitize_relative_path(&requested_path) else {
        return (StatusCode::BAD_REQUEST, "Invalid path").into_response();
    };

    if should_redirect_remote_path_to_root(&relative_path) {
        return Redirect::to("/").into_response();
    }

    let wants_asset = relative_path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.contains('.'));

    if !wants_asset {
        return serve_index(&state).await;
    }

    let full_path = state.resource_dir.join("dist").join(relative_path);
    serve_asset_file(full_path).await
}

async fn remote_health() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

async fn remote_session_status(
    State(state): State<RemoteWebState>,
    headers: HeaderMap,
) -> Response {
    let Ok(auth) = state.auth.lock() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to lock remote session state",
        )
            .into_response();
    };

    let status = read_remote_session_status(&auth, &headers);
    build_json_response(&status, None)
}

async fn remote_session_claim(State(state): State<RemoteWebState>, headers: HeaderMap) -> Response {
    if !is_same_origin_remote_post(&headers) {
        return (
            StatusCode::FORBIDDEN,
            "Remote session action requires same-origin browser requests",
        )
            .into_response();
    }

    let Ok(mut auth) = state.auth.lock() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to lock remote session state",
        )
            .into_response();
    };

    let current_cookie = parse_session_cookie(&headers);
    if let Some(active_session_id) = auth.active_session_id.as_deref() {
        if current_cookie.as_deref() == Some(active_session_id) {
            let status = build_session_status(&auth, current_cookie.as_deref());
            return build_json_response(&status, None);
        }
        return (
            StatusCode::CONFLICT,
            "Another remote browser session is already connected",
        )
            .into_response();
    }

    if auth.password_enabled {
        return (
            StatusCode::UNAUTHORIZED,
            "Remote access requires a password",
        )
            .into_response();
    }

    let (status, set_cookie) = authorize_remote_session(&mut auth);
    build_json_response(&status, set_cookie)
}

async fn remote_session_login(
    State(state): State<RemoteWebState>,
    headers: HeaderMap,
    Json(payload): Json<RemoteSessionLoginRequest>,
) -> Response {
    if !is_same_origin_remote_post(&headers) {
        return (
            StatusCode::FORBIDDEN,
            "Remote session action requires same-origin browser requests",
        )
            .into_response();
    }

    let Ok(mut auth) = state.auth.lock() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to lock remote session state",
        )
            .into_response();
    };

    let current_cookie = parse_session_cookie(&headers);
    if let Some(active_session_id) = auth.active_session_id.as_deref() {
        if current_cookie.as_deref() == Some(active_session_id) {
            let status = build_session_status(&auth, current_cookie.as_deref());
            return build_json_response(&status, None);
        }
        return (
            StatusCode::CONFLICT,
            "Another remote browser session is already connected",
        )
            .into_response();
    }

    if !auth.password_enabled {
        let (status, set_cookie) = authorize_remote_session(&mut auth);
        return build_json_response(&status, set_cookie);
    }

    let Some(expected_hash) = auth.password_hash.clone() else {
        return (
            StatusCode::UNAUTHORIZED,
            "Password protection is not configured",
        )
            .into_response();
    };

    let now = Instant::now();
    if let Some(retry_after) = active_login_lockout_duration(&mut auth, now) {
        return build_login_lockout_response(retry_after);
    }

    if hash_password(payload.password.trim()) != expected_hash {
        if let Some(retry_after) = register_failed_login_attempt(&mut auth, now) {
            return build_login_lockout_response(retry_after);
        }
        return (StatusCode::UNAUTHORIZED, "Incorrect password").into_response();
    }

    let (status, set_cookie) = authorize_remote_session(&mut auth);
    build_json_response(&status, set_cookie)
}

async fn proxy_remote_api(
    State(state): State<RemoteWebState>,
    original_uri: OriginalUri,
    method: Method,
    headers: HeaderMap,
    body: Body,
) -> Response {
    if !is_remote_request_authorized(&state, &headers) {
        return (StatusCode::UNAUTHORIZED, "Remote session is not authorized").into_response();
    }

    let runtime = match state.desktop_backend.runtime_descriptor() {
        Ok(runtime) => runtime,
        Err(err) => return (StatusCode::INTERNAL_SERVER_ERROR, err).into_response(),
    };

    let path_and_query = original_uri
        .0
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or_else(|| original_uri.0.path());

    let target_url = match build_remote_api_proxy_target(&runtime, path_and_query) {
        Ok(target_url) => target_url,
        Err(err) => return (StatusCode::SERVICE_UNAVAILABLE, err).into_response(),
    };

    let body_bytes = match to_bytes(body, usize::MAX).await {
        Ok(bytes) => bytes,
        Err(_) => return (StatusCode::BAD_REQUEST, "Invalid request body").into_response(),
    };

    let mut upstream_request = state.http_client.request(method, target_url);
    for (name, value) in headers.iter() {
        if should_skip_proxy_request_header(name) {
            continue;
        }
        upstream_request = upstream_request.header(name, value.clone());
    }

    let upstream_response = match upstream_request.body(body_bytes).send().await {
        Ok(response) => response,
        Err(err) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("Failed to reach desktop backend: {err}"),
            )
                .into_response()
        }
    };

    let status = upstream_response.status();
    let response_headers = upstream_response.headers().clone();
    let mut response = Response::new(Body::from_stream(upstream_response.bytes_stream()));
    *response.status_mut() = status;

    for (name, value) in response_headers.iter() {
        if should_skip_proxy_response_header(name) {
            continue;
        }
        response.headers_mut().insert(name, value.clone());
    }

    response
}

async fn start_remote_server_internal(
    app: AppHandle,
    manager: Arc<Mutex<Option<RunningRemoteServer>>>,
    port: u16,
) -> Result<RemoteServerStatus, String> {
    if port == 0 {
        return Err("Port must be between 1 and 65535".into());
    }

    {
        let guard = manager
            .lock()
            .map_err(|_| "Failed to lock remote server state")?;
        if let Some(server) = guard.as_ref() {
            if server.port == port {
                return Ok(build_status(Some(port), true, server.loopback_only));
            }
            return Err("Remote server is already running on another port. Stop it first.".into());
        }
    }

    let desktop_backend = DesktopBackendManager {
        inner: app.state::<DesktopBackendManager>().inner.clone(),
    };
    let runtime = desktop_backend.runtime_descriptor()?;
    ensure_remote_access_backend_ready(&runtime)?;

    let config = load_remote_config(&app).await?;
    let state = RemoteWebState {
        resource_dir: resource_dir(&app)?,
        auth: Arc::new(Mutex::new(RemoteAuthState {
            password_enabled: config.password_enabled,
            password_hash: config.password_hash,
            active_session_id: None,
            failed_login_attempts: 0,
            lockout_until: None,
        })),
        desktop_backend,
        http_client: reqwest::Client::new(),
    };

    let bound_listeners = bind_remote_server_listeners(config.password_enabled, port)?;
    let actual_port = bound_listeners.port;

    let router = Router::new()
        .route("/", get(serve_app_root))
        .route("/_junban/health", get(remote_health))
        .route("/_junban/session", get(remote_session_status))
        .route("/_junban/session/claim", post(remote_session_claim))
        .route("/_junban/session/login", post(remote_session_login))
        .route("/api", any(proxy_remote_api))
        .route("/api/{*path}", any(proxy_remote_api))
        .route("/{*path}", get(serve_app_path))
        .with_state(state);

    let (stopped_tx, stopped_rx) = watch::channel(false);
    let remaining_listeners = Arc::new(AtomicUsize::new(bound_listeners.listeners.len()));
    let manager_inner = manager.clone();
    let mut shutdown = Vec::with_capacity(bound_listeners.listeners.len());
    for listener in bound_listeners.listeners {
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        shutdown.push(shutdown_tx);
        let remaining_listeners = remaining_listeners.clone();
        let manager_inner = manager_inner.clone();
        let stopped_tx = stopped_tx.clone();
        let router = router.clone();
        tauri::async_runtime::spawn(async move {
            let result = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await;

            if result.is_err() {
                eprintln!("remote server exited unexpectedly");
            }

            if remaining_listeners.fetch_sub(1, Ordering::AcqRel) == 1 {
                let _ = stopped_tx.send(true);

                if let Ok(mut guard) = manager_inner.lock() {
                    if guard
                        .as_ref()
                        .is_some_and(|server| server.port == actual_port)
                    {
                        *guard = None;
                    }
                }
            }
        });
    }

    let mut guard = manager
        .lock()
        .map_err(|_| "Failed to lock remote server state")?;
    *guard = Some(RunningRemoteServer {
        port: actual_port,
        loopback_only: !config.password_enabled,
        shutdown,
        stopped_rx,
        stopping: false,
    });

    Ok(build_status(
        Some(actual_port),
        true,
        !config.password_enabled,
    ))
}

#[tauri::command]
fn desktop_runtime_descriptor(
    manager: TauriState<DesktopBackendManager>,
) -> Result<JunbanRuntimeDescriptor, String> {
    manager.runtime_descriptor()
}

#[tauri::command]
fn remote_server_status(manager: TauriState<RemoteServerManager>) -> RemoteServerStatus {
    let guard = manager
        .inner
        .lock()
        .expect("remote server manager lock poisoned");
    match guard.as_ref() {
        Some(server) => build_status(Some(server.port), true, server.loopback_only),
        None => build_status(None, false, false),
    }
}

#[tauri::command]
async fn remote_server_get_config(app: AppHandle) -> Result<RemoteServerConfigResponse, String> {
    Ok(config_response(&load_remote_config(&app).await?))
}

#[tauri::command]
async fn remote_server_update_config(
    app: AppHandle,
    port: u16,
    auto_start: bool,
    password_enabled: bool,
    password: Option<String>,
) -> Result<RemoteServerConfigResponse, String> {
    if port == 0 {
        return Err("Port must be between 1 and 65535".into());
    }

    let mut config = load_remote_config(&app).await?;
    config.port = port;
    config.auto_start = auto_start;
    config.password_enabled = password_enabled;

    if password_enabled {
        if let Some(next_password) = password
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            config.password_hash = Some(hash_password(next_password));
        } else if config.password_hash.is_none() {
            return Err("Set a password before enabling password protection".into());
        }
    } else {
        config.password_hash = None;
    }

    save_remote_config(&app, &config).await?;
    Ok(config_response(&config))
}

#[tauri::command]
async fn remote_server_start(
    app: AppHandle,
    manager: TauriState<'_, RemoteServerManager>,
    port: u16,
) -> Result<RemoteServerStatus, String> {
    start_remote_server_internal(app, manager.inner.clone(), port).await
}

#[tauri::command]
async fn remote_server_stop(
    manager: TauriState<'_, RemoteServerManager>,
) -> Result<RemoteServerStatus, String> {
    let (shutdown, mut stopped_rx): (Vec<oneshot::Sender<()>>, watch::Receiver<bool>) = {
        let mut guard = manager
            .inner
            .lock()
            .map_err(|_| "Failed to lock remote server state")?;

        let Some(server) = guard.as_mut() else {
            return Ok(build_status(None, false, false));
        };

        let shutdown = if server.stopping {
            Vec::new()
        } else {
            server.stopping = true;
            std::mem::take(&mut server.shutdown)
        };

        (shutdown, server.stopped_rx.clone())
    };

    for shutdown in shutdown {
        let _ = shutdown.send(());
    }

    timeout(Duration::from_secs(10), async {
        while !*stopped_rx.borrow() {
            stopped_rx
                .changed()
                .await
                .map_err(|_| "Remote server shutdown channel closed unexpectedly".to_string())?;
        }

        Ok::<(), String>(())
    })
    .await
    .map_err(|_| "Timed out waiting for remote access to stop".to_string())??;

    Ok(build_status(None, false, false))
}

pub fn run() {
    tauri::Builder::default()
        .append_invoke_initialization_script(DESKTOP_RUNTIME_INIT_SCRIPT)
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .manage(DesktopBackendManager::default())
        .manage(RemoteServerManager::default())
        .invoke_handler(tauri::generate_handler![
            desktop_runtime_descriptor,
            remote_server_status,
            remote_server_get_config,
            remote_server_update_config,
            remote_server_start,
            remote_server_stop
        ])
        .setup(|app| {
            if !tauri::is_dev() {
                let manager = DesktopBackendManager {
                    inner: app.state::<DesktopBackendManager>().inner.clone(),
                };
                if let Err(err) = tauri::async_runtime::block_on(start_desktop_backend_internal(
                    app.handle().clone(),
                    manager,
                )) {
                    eprintln!("[desktop-backend] startup failed: {err}");
                }
            }

            let handle = app.handle().clone();
            let manager = app.state::<RemoteServerManager>().inner.clone();
            tauri::async_runtime::spawn(async move {
                match load_remote_config(&handle).await {
                    Ok(config) if config.auto_start => {
                        if let Err(err) =
                            start_remote_server_internal(handle, manager, config.port).await
                        {
                            eprintln!("[remote-access] auto-start failed: {err}");
                        }
                    }
                    _ => {}
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Failed to build Junban.")
        .run(|_app, _event| {});
}

#[cfg(test)]
mod tests {
    use std::{net::SocketAddr, path::PathBuf};

    use super::{
        active_login_lockout_duration, authorize_remote_session, bind_remote_server_listeners,
        build_desktop_runtime_descriptor, build_remote_api_proxy_target, build_session_status,
        build_status, build_unready_desktop_runtime_descriptor, default_remote_config,
        ensure_remote_access_backend_ready, is_expected_desktop_backend_response,
        is_same_origin_remote_post, parse_session_cookie, read_remote_session_status,
        register_failed_login_attempt, remote_server_bind_addrs, should_redirect_remote_path_to_root,
        RemoteAuthState, JUNBAN_BACKEND_SERVICE,
    };
    use axum::http::{header, HeaderMap, HeaderValue};
    use std::io;
    use tokio::time::{Duration, Instant};

    fn session_cookie_headers(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(value).expect("cookie header should be valid"),
        );
        headers
    }

    fn remote_post_headers(host: &str, origin: Option<&str>, referer: Option<&str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::HOST,
            HeaderValue::from_str(host).expect("host header should be valid"),
        );
        if let Some(value) = origin {
            headers.insert(
                header::ORIGIN,
                HeaderValue::from_str(value).expect("origin header should be valid"),
            );
        }
        if let Some(value) = referer {
            headers.insert(
                header::REFERER,
                HeaderValue::from_str(value).expect("referer header should be valid"),
            );
        }
        headers
    }

    #[test]
    fn accepts_junban_health_contract() {
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{{\"ok\":true,\"service\":\"{}\"}}",
            JUNBAN_BACKEND_SERVICE
        );

        assert!(is_expected_desktop_backend_response(&response));
    }

    #[test]
    fn rejects_generic_http_200_responses() {
        let response = "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\nok";

        assert!(!is_expected_desktop_backend_response(response));
    }

    #[test]
    fn runtime_descriptor_carries_actual_api_base() {
        let runtime = build_desktop_runtime_descriptor(53123);
        let desktop = runtime.desktop.expect("desktop descriptor should exist");

        assert_eq!(runtime.mode, "default");
        assert_eq!(desktop.api_base, "http://127.0.0.1:53123/api");
        assert_eq!(desktop.health_url, "http://127.0.0.1:53123/api/health");
        assert!(desktop.ready);
        assert_eq!(desktop.error, None);
    }

    #[test]
    fn failed_runtime_descriptor_stays_in_default_mode_with_error() {
        let runtime = build_unready_desktop_runtime_descriptor(Some(53123), "boom");
        let desktop = runtime.desktop.expect("desktop descriptor should exist");

        assert_eq!(runtime.mode, "default");
        assert_eq!(desktop.api_base, "http://127.0.0.1:53123/api");
        assert_eq!(desktop.health_url, "http://127.0.0.1:53123/api/health");
        assert!(!desktop.ready);
        assert_eq!(desktop.error.as_deref(), Some("boom"));
    }

    #[test]
    fn remote_api_proxy_uses_sidecar_api_base() {
        let runtime = build_desktop_runtime_descriptor(53123);

        let target = build_remote_api_proxy_target(&runtime, "/api/tasks?status=pending")
            .expect("proxy target should resolve");

        assert_eq!(target, "http://127.0.0.1:53123/api/tasks?status=pending");
    }

    #[test]
    fn remote_api_proxy_rejects_unready_backend_runtime() {
        let runtime = build_unready_desktop_runtime_descriptor(Some(53123), "backend unavailable");

        let error = build_remote_api_proxy_target(&runtime, "/api/tasks")
            .expect_err("unready runtime should not proxy requests");

        assert_eq!(error, "backend unavailable");
    }

    #[test]
    fn default_remote_access_port_does_not_conflict_with_dev_api_port() {
        let config = default_remote_config();

        assert_eq!(config.port, 4823);
    }

    #[test]
    fn passwordless_remote_access_advertises_only_ipv4_loopback_bind() {
        assert_eq!(
            remote_server_bind_addrs(false, 4822),
            vec![SocketAddr::from(([127, 0, 0, 1], 4822))]
        );
    }

    #[test]
    fn password_protected_remote_access_advertises_ipv4_and_ipv6_binds() {
        assert_eq!(
            remote_server_bind_addrs(true, 4822),
            vec![
                SocketAddr::from(([0, 0, 0, 0], 4822)),
                SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, 0], 4822)),
            ]
        );
    }

    #[tokio::test]
    async fn passwordless_bind_keeps_remote_access_on_ipv4_loopback_only() {
        let bound = bind_remote_server_listeners(false, 0)
            .expect("passwordless remote access should bind loopback");

        assert_eq!(bound.listeners.len(), 1);
        let listener_addr = bound.listeners[0]
            .local_addr()
            .expect("listener address should resolve");
        assert!(listener_addr.is_ipv4());
        assert_eq!(listener_addr.ip().to_string(), "127.0.0.1");
    }

    #[tokio::test]
    async fn occupied_remote_access_port_reports_actionable_error() {
        let occupied = std::net::TcpListener::bind("127.0.0.1:0")
            .expect("test should reserve a loopback port");
        let occupied_port = occupied
            .local_addr()
            .expect("reserved listener address should resolve")
            .port();

        let error = match bind_remote_server_listeners(false, occupied_port) {
            Ok(_) => panic!("occupied port should fail to bind"),
            Err(error) => error,
        };

        assert_eq!(
            error,
            format!("Port {occupied_port} is already in use. Choose another remote access port.")
        );
    }

    #[tokio::test]
    async fn password_protected_bind_adds_ipv6_listener_when_supported() {
        let ipv6_supported = std::net::TcpListener::bind("[::1]:0").is_ok();
        let bound = bind_remote_server_listeners(true, 0)
            .expect("password-protected remote access should bind listeners");

        assert!(bound.listeners.iter().any(|listener| {
            listener
                .local_addr()
                .map(|addr| addr.is_ipv4())
                .unwrap_or(false)
        }));

        if ipv6_supported {
            assert!(bound.listeners.iter().any(|listener| {
                listener
                    .local_addr()
                    .map(|addr| addr.is_ipv6())
                    .unwrap_or(false)
            }));
        } else {
            assert!(bound.listeners.iter().all(|listener| {
                listener
                    .local_addr()
                    .map(|addr| addr.is_ipv4())
                    .unwrap_or(false)
            }));
        }

        let ports: Result<Vec<u16>, io::Error> = bound
            .listeners
            .iter()
            .map(|listener| listener.local_addr().map(|addr| addr.port()))
            .collect();
        let ports = ports.expect("listener ports should resolve");
        assert!(ports.iter().all(|value| *value == bound.port));
    }

    #[test]
    fn passwordless_remote_status_advertises_loopback_ip() {
        let status = build_status(Some(4822), true, true);

        assert_eq!(status.local_url.as_deref(), Some("http://127.0.0.1:4822"));
    }

    #[test]
    fn password_protected_remote_status_keeps_localhost_url() {
        let status = build_status(Some(4822), true, false);

        assert_eq!(status.local_url.as_deref(), Some("http://localhost:4822"));
    }

    #[test]
    fn remote_quick_capture_path_redirects_to_root() {
        assert!(should_redirect_remote_path_to_root(&PathBuf::from(
            "quick-capture"
        )));
        assert!(!should_redirect_remote_path_to_root(&PathBuf::from(
            "assets/app.js"
        )));
        assert!(!should_redirect_remote_path_to_root(&PathBuf::from(
            "inbox"
        )));
    }

    #[test]
    fn remote_access_requires_ready_desktop_backend_runtime() {
        let error = ensure_remote_access_backend_ready(&build_unready_desktop_runtime_descriptor(
            Some(53123),
            "backend unavailable",
        ))
        .expect_err("unready backend should block remote access startup");

        assert_eq!(error, "backend unavailable");
    }

    #[test]
    fn session_status_read_is_read_only_for_passwordless_remote_access() {
        let auth = RemoteAuthState::default();
        let headers = HeaderMap::new();

        let status = read_remote_session_status(&auth, &headers);

        assert!(!status.authorized);
        assert!(!status.requires_password);
        assert!(!status.session_locked);
        assert!(auth.active_session_id.is_none());
    }

    #[test]
    fn explicit_passwordless_claim_sets_active_session() {
        let mut auth = RemoteAuthState::default();

        let (status, set_cookie) = authorize_remote_session(&mut auth);

        assert!(status.authorized);
        assert!(!status.requires_password);
        assert!(!status.session_locked);
        assert!(auth.active_session_id.is_some());
        assert!(set_cookie.is_some());
    }

    #[test]
    fn session_status_reflects_existing_authorized_cookie_without_mutation() {
        let auth = RemoteAuthState {
            password_enabled: false,
            password_hash: None,
            active_session_id: Some("session-123".into()),
            failed_login_attempts: 0,
            lockout_until: None,
        };
        let headers = session_cookie_headers("junban_remote_session=session-123");

        let status = read_remote_session_status(&auth, &headers);

        assert!(status.authorized);
        assert!(!status.session_locked);
        assert_eq!(auth.active_session_id.as_deref(), Some("session-123"));
        assert_eq!(
            parse_session_cookie(&headers).as_deref(),
            Some("session-123")
        );
        let rebuilt = build_session_status(&auth, Some("session-123"));
        assert!(rebuilt.authorized);
    }

    #[test]
    fn accepts_same_origin_posts_by_origin_header() {
        let headers = remote_post_headers("100.64.0.1:4822", Some("http://100.64.0.1:4822"), None);

        assert!(is_same_origin_remote_post(&headers));
    }

    #[test]
    fn accepts_same_origin_posts_by_referer_when_origin_missing() {
        let headers = remote_post_headers(
            "localhost:4822",
            None,
            Some("http://localhost:4822/settings/remote"),
        );

        assert!(is_same_origin_remote_post(&headers));
    }

    #[test]
    fn accepts_same_origin_posts_by_origin_header_with_ipv6_host() {
        let headers = remote_post_headers(
            "[2001:db8::10]:4822",
            Some("http://[2001:db8::10]:4822"),
            None,
        );

        assert!(is_same_origin_remote_post(&headers));
    }

    #[test]
    fn accepts_same_origin_posts_by_referer_with_ipv6_host() {
        let headers = remote_post_headers(
            "[2001:db8::10]:4822",
            None,
            Some("http://[2001:db8::10]:4822/settings/remote"),
        );

        assert!(is_same_origin_remote_post(&headers));
    }

    #[test]
    fn rejects_cross_site_remote_posts() {
        let headers = remote_post_headers("localhost:4822", Some("https://evil.example"), None);

        assert!(!is_same_origin_remote_post(&headers));
    }

    #[test]
    fn rejects_remote_posts_without_origin_or_referer() {
        let headers = remote_post_headers("localhost:4822", None, None);

        assert!(!is_same_origin_remote_post(&headers));
    }

    #[test]
    fn login_lockout_starts_after_repeated_failed_attempts() {
        let mut auth = RemoteAuthState {
            password_enabled: true,
            password_hash: Some("hash".into()),
            active_session_id: None,
            failed_login_attempts: 0,
            lockout_until: None,
        };
        let now = Instant::now();

        for _ in 0..4 {
            assert!(register_failed_login_attempt(&mut auth, now).is_none());
        }

        let lockout = register_failed_login_attempt(&mut auth, now)
            .expect("fifth failure should enable lockout");
        assert_eq!(lockout, Duration::from_secs(60));
        assert_eq!(auth.failed_login_attempts, 0);
        assert!(auth.lockout_until.is_some());
    }

    #[test]
    fn lockout_expires_and_clears_failed_attempt_tracking() {
        let now = Instant::now();
        let mut auth = RemoteAuthState {
            password_enabled: true,
            password_hash: Some("hash".into()),
            active_session_id: None,
            failed_login_attempts: 2,
            lockout_until: Some(now + Duration::from_secs(2)),
        };

        assert!(active_login_lockout_duration(&mut auth, now).is_some());
        assert!(active_login_lockout_duration(&mut auth, now + Duration::from_secs(3)).is_none());
        assert_eq!(auth.failed_login_attempts, 0);
        assert!(auth.lockout_until.is_none());
    }
}
