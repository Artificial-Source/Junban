//! TEMPORARY Phase 7 Wave 0 parent probe.
//!
//! Modes:
//! - `sdk`        — protocol/SDK types only (built with --no-default-features)
//! - `inprocess`  — lazy in-process Wasmtime stages over HTTP
//! - `child`      — on-demand child host over HTTP + stdio IPC
//!
//! Never opens SQLite, never reads an access token, never takes a profile lock.

use std::io::{BufReader, BufWriter};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use junban_phase7_host_placement::child_ipc::{
    HostRequest, HostResponse, Timings, read_frame, write_frame,
};
use junban_phase7_host_placement::protocol::{
    ComponentKind, SpikeIdentity, SpikeLimits, protocol_banner,
};
use junban_phase7_host_placement::sha256_file_hex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[cfg(feature = "wasmtime-runtime")]
use junban_phase7_host_placement::runtime::SpikeRuntime;

fn main() {
    if let Err(err) = run() {
        eprintln!("junban-p7-spike-probe error: {err}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args = Args::parse(std::env::args().skip(1))?;
    match args.mode.as_str() {
        "sdk" => run_sdk(&args),
        "inprocess" => run_inprocess(&args),
        "child" => run_child(&args),
        other => Err(format!("unknown mode {other:?}")),
    }
}

#[derive(Debug)]
struct Args {
    mode: String,
    bind: SocketAddr,
    component: Option<PathBuf>,
    component_kind: ComponentKind,
    host_bin: Option<PathBuf>,
    ready_file: Option<PathBuf>,
}

impl Args {
    fn parse(mut argv: impl Iterator<Item = String>) -> Result<Self, String> {
        let mut mode = None;
        let mut bind = "127.0.0.1:0".parse().unwrap();
        let mut component = None;
        let mut component_kind = ComponentKind::Rust;
        let mut host_bin = None;
        let mut ready_file = None;
        while let Some(arg) = argv.next() {
            match arg.as_str() {
                "--mode" => mode = Some(expect_val(&mut argv, "--mode")?),
                "--bind" => {
                    bind = expect_val(&mut argv, "--bind")?
                        .parse()
                        .map_err(|e| format!("bad --bind: {e}"))?;
                }
                "--component" => {
                    component = Some(PathBuf::from(expect_val(&mut argv, "--component")?))
                }
                "--component-kind" => {
                    component_kind = match expect_val(&mut argv, "--component-kind")?.as_str() {
                        "rust" => ComponentKind::Rust,
                        "typescript" | "ts" => ComponentKind::Typescript,
                        other => return Err(format!("bad --component-kind {other}")),
                    };
                }
                "--host-bin" => {
                    host_bin = Some(PathBuf::from(expect_val(&mut argv, "--host-bin")?))
                }
                "--ready-file" => {
                    ready_file = Some(PathBuf::from(expect_val(&mut argv, "--ready-file")?))
                }
                "--help" | "-h" => {
                    print_help();
                    std::process::exit(0);
                }
                other => return Err(format!("unknown arg {other}")),
            }
        }
        Ok(Self {
            mode: mode.ok_or("--mode required")?,
            bind,
            component,
            component_kind,
            host_bin,
            ready_file,
        })
    }
}

fn expect_val(argv: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    argv.next()
        .ok_or_else(|| format!("{flag} requires a value"))
}

fn print_help() {
    eprintln!(
        "Usage: junban-p7-spike-probe --mode sdk|inprocess|child [options]\n\
         \n\
         TEMPORARY Phase 7 Wave 0 host-placement probe.\n\
         Options:\n\
           --bind ADDR                 default 127.0.0.1:0\n\
           --component PATH            wasm component (inprocess/child)\n\
           --component-kind rust|typescript\n\
           --host-bin PATH             child host binary (child mode)\n\
           --ready-file PATH           write bound address JSON when listening\n"
    );
}

fn run_sdk(args: &Args) -> Result<(), String> {
    let state = ProbeState {
        mode: "sdk".into(),
        banner: protocol_banner(),
        #[cfg(feature = "wasmtime-runtime")]
        runtime: None,
        child: None,
        component: None,
        component_kind: args.component_kind,
        host_bin: None,
        limits: SpikeLimits::default(),
    };
    serve(args.bind, args.ready_file.as_deref(), state)
}

#[cfg(not(feature = "wasmtime-runtime"))]
fn run_inprocess(_args: &Args) -> Result<(), String> {
    Err("inprocess mode requires the wasmtime-runtime feature".into())
}

#[cfg(feature = "wasmtime-runtime")]
fn run_inprocess(args: &Args) -> Result<(), String> {
    let component = args
        .component
        .clone()
        .ok_or("--component required for inprocess mode")?;
    if !component.is_file() {
        return Err(format!("component not found: {}", component.display()));
    }
    let state = ProbeState {
        mode: "inprocess".into(),
        banner: protocol_banner(),
        runtime: Some(SpikeRuntime::new(
            SpikeLimits::default(),
            args.component_kind,
        )),
        child: None,
        component: Some(component),
        component_kind: args.component_kind,
        host_bin: None,
        limits: SpikeLimits::default(),
    };
    serve(args.bind, args.ready_file.as_deref(), state)
}

fn run_child(args: &Args) -> Result<(), String> {
    let component = args
        .component
        .clone()
        .ok_or("--component required for child mode")?;
    let host_bin = args
        .host_bin
        .clone()
        .ok_or("--host-bin required for child mode")?;
    if !component.is_file() {
        return Err(format!("component not found: {}", component.display()));
    }
    if !host_bin.is_file() {
        return Err(format!("host bin not found: {}", host_bin.display()));
    }
    let state = ProbeState {
        mode: "child".into(),
        banner: protocol_banner(),
        #[cfg(feature = "wasmtime-runtime")]
        runtime: None,
        child: None,
        component: Some(component),
        component_kind: args.component_kind,
        host_bin: Some(host_bin),
        limits: SpikeLimits::default(),
    };
    serve(args.bind, args.ready_file.as_deref(), state)
}

struct ProbeState {
    mode: String,
    banner: String,
    #[cfg(feature = "wasmtime-runtime")]
    runtime: Option<SpikeRuntime>,
    child: Option<ChildSession>,
    component: Option<PathBuf>,
    component_kind: ComponentKind,
    host_bin: Option<PathBuf>,
    limits: SpikeLimits,
}

struct ChildSession {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    pid: u32,
}

fn serve(bind: SocketAddr, ready_file: Option<&Path>, state: ProbeState) -> Result<(), String> {
    let listener = std::net::TcpListener::bind(bind).map_err(|e| e.to_string())?;
    listener.set_nonblocking(false).map_err(|e| e.to_string())?;
    let address = listener.local_addr().map_err(|e| e.to_string())?;
    let ready = json!({
        "address": address.to_string(),
        "pid": std::process::id(),
        "mode": state.mode,
        "banner": state.banner,
        "protocol": state.banner,
    });
    if let Some(path) = ready_file {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(path, format!("{ready}\n")).map_err(|e| e.to_string())?;
    } else {
        println!("{ready}");
    }

    let state = Mutex::new(state);
    for conn in listener.incoming() {
        let mut stream = match conn {
            Ok(s) => s,
            Err(err) => {
                eprintln!("accept error: {err}");
                continue;
            }
        };
        if let Err(err) = handle_http(&mut stream, &state) {
            let _ = write_http(
                &mut stream,
                500,
                "application/json",
                &json!({ "error": err }),
            );
        }
        let guard = state.lock().map_err(|e| e.to_string())?;
        if guard.mode == "__shutdown__" {
            break;
        }
    }
    Ok(())
}

fn handle_http(stream: &mut std::net::TcpStream, state: &Mutex<ProbeState>) -> Result<(), String> {
    use std::io::Read;

    // Read until header terminator, then exact Content-Length body bytes.
    let mut raw = Vec::with_capacity(8 * 1024);
    let mut chunk = [0_u8; 8 * 1024];
    let header_end = loop {
        let n = stream.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            if raw.is_empty() {
                return Ok(());
            }
            break None;
        }
        raw.extend_from_slice(&chunk[..n]);
        if let Some(pos) = find_header_end(&raw) {
            break Some(pos);
        }
        if raw.len() > 64 * 1024 {
            return Err("HTTP headers too large".into());
        }
    };
    let Some(header_end) = header_end else {
        return Err("incomplete HTTP headers".into());
    };
    let (header_bytes, initial_body) = raw.split_at(header_end);
    let headers = std::str::from_utf8(header_bytes).map_err(|e| e.to_string())?;
    let mut lines = headers.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");

    let mut content_length = 0_usize;
    for line in lines {
        let lower = line.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("content-length:") {
            content_length = value
                .trim()
                .parse()
                .map_err(|e| format!("bad content-length: {e}"))?;
        }
    }
    if content_length > 4 * 1024 * 1024 {
        return Err("HTTP body too large".into());
    }
    let mut body_bytes = initial_body.to_vec();
    while body_bytes.len() < content_length {
        let n = stream.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        body_bytes.extend_from_slice(&chunk[..n]);
    }
    if body_bytes.len() < content_length {
        return Err(format!(
            "incomplete HTTP body: got {} want {content_length}",
            body_bytes.len()
        ));
    }
    body_bytes.truncate(content_length);
    let body = std::str::from_utf8(&body_bytes).map_err(|e| e.to_string())?;

    match (method, path) {
        ("GET", "/health") => {
            let guard = state.lock().map_err(|e| e.to_string())?;
            write_http(
                stream,
                200,
                "application/json",
                &json!({
                    "ok": true,
                    "mode": guard.mode,
                    "banner": guard.banner,
                    "pid": std::process::id(),
                    "has_engine": has_engine(&guard),
                    "has_instance": has_instance(&guard),
                    "child_pid": guard.child.as_ref().map(|c| c.pid),
                }),
            )
        }
        ("GET", "/status") => {
            let guard = state.lock().map_err(|e| e.to_string())?;
            write_http(
                stream,
                200,
                "application/json",
                &json!({
                    "mode": guard.mode,
                    "banner": guard.banner,
                    "pid": std::process::id(),
                    "has_engine": has_engine(&guard),
                    "has_instance": has_instance(&guard),
                    "child_pid": guard.child.as_ref().map(|c| c.pid),
                    "component": guard.component.as_ref().map(|p| p.display().to_string()),
                    "component_kind": format!("{:?}", guard.component_kind).to_ascii_lowercase(),
                }),
            )
        }
        ("POST", "/stage") => {
            let stage: StageRequest =
                serde_json::from_str(if body.is_empty() { "{}" } else { body })
                    .map_err(|e| format!("bad stage json: {e}"))?;
            let response = dispatch_stage(state, stage)?;
            let value = serde_json::to_value(&response).map_err(|e| e.to_string())?;
            write_http(stream, 200, "application/json", &value)
        }
        ("POST", "/shutdown") => {
            let mut guard = state.lock().map_err(|e| e.to_string())?;
            shutdown_locked(&mut guard)?;
            guard.mode = "__shutdown__".into();
            write_http(stream, 200, "application/json", &json!({ "ok": true }))
        }
        _ => write_http(
            stream,
            404,
            "application/json",
            &json!({ "error": "not found" }),
        ),
    }
}

#[derive(Debug, Deserialize)]
struct StageRequest {
    stage: String,
    #[serde(default)]
    input: Option<u32>,
    #[serde(default)]
    iterations: Option<u32>,
    #[serde(default)]
    pages: Option<u32>,
}

#[derive(Debug, Serialize)]
struct StageResponse {
    ok: bool,
    stage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    timings_ms: Option<Timings>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_kind: Option<String>,
}

fn dispatch_stage(state: &Mutex<ProbeState>, req: StageRequest) -> Result<StageResponse, String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let stage = req.stage.clone();
    let result = match (guard.mode.as_str(), stage.as_str()) {
        (_, "noop" | "idle") => Ok(StageResponse {
            ok: true,
            stage,
            timings_ms: Some(Timings::default()),
            detail: Some(json!({
                "has_engine": has_engine(&guard),
                "has_instance": has_instance(&guard),
            })),
            error: None,
            error_kind: None,
        }),
        ("inprocess", name) => dispatch_inprocess(&mut guard, name, &req),
        ("child", name) => dispatch_child(&mut guard, name, &req),
        ("sdk", _) => Err("sdk mode only supports idle/noop/shutdown".into()),
        (mode, name) => Err(format!("stage {name} unsupported in mode {mode}")),
    };
    match result {
        Ok(resp) => Ok(resp),
        Err(err) => Ok(StageResponse {
            ok: false,
            stage: req.stage,
            timings_ms: None,
            detail: None,
            error: Some(err),
            error_kind: Some("stage_error".into()),
        }),
    }
}

#[cfg(not(feature = "wasmtime-runtime"))]
fn dispatch_inprocess(
    _guard: &mut ProbeState,
    _name: &str,
    _req: &StageRequest,
) -> Result<StageResponse, String> {
    Err("wasmtime-runtime feature disabled".into())
}

#[cfg(feature = "wasmtime-runtime")]
fn dispatch_inprocess(
    guard: &mut ProbeState,
    name: &str,
    req: &StageRequest,
) -> Result<StageResponse, String> {
    let rt = guard.runtime.as_mut().ok_or("inprocess runtime missing")?;
    let component = guard
        .component
        .as_ref()
        .ok_or("component path missing")?
        .clone();

    // Tiny single-threaded runtime for async wasmtime calls.
    let run = block_on(async {
        match name {
            "create_engine" => {
                let timings = rt.create_engine().map_err(|e| e.to_string())?;
                ok_stage(name, timings, json!({ "has_engine": true }))
            }
            "compile" | "compile_component" => {
                let timings = rt
                    .compile_component(&component)
                    .map_err(|e| e.to_string())?;
                ok_stage(
                    name,
                    timings,
                    json!({ "component": component.display().to_string() }),
                )
            }
            "instantiate" => {
                let timings = rt.instantiate().await.map_err(|e| e.to_string())?;
                ok_stage(name, timings, json!({ "has_instance": true }))
            }
            "ping" | "first_ping" => {
                let input = req.input.unwrap_or(1);
                let (out, timings) = rt.ping(input).await.map_err(|e| e.to_string())?;
                ok_stage(name, timings, json!({ "output": out }))
            }
            "warm_ping" => {
                let input = req.input.unwrap_or(1);
                let iterations = req.iterations.unwrap_or(100);
                let (out, timings) = rt
                    .warm_ping(input, iterations)
                    .await
                    .map_err(|e| e.to_string())?;
                ok_stage(
                    name,
                    timings,
                    json!({ "output": out, "iterations": iterations }),
                )
            }
            "trap" | "force_trap" => {
                let timings = rt.force_trap().await.map_err(|e| e.to_string())?;
                ok_stage(
                    name,
                    timings,
                    json!({ "survived": true, "instance_dropped": true }),
                )
            }
            "cpu_loop" => {
                let timings = rt.cpu_loop().await.map_err(|e| e.to_string())?;
                ok_stage(
                    name,
                    timings,
                    json!({ "survived": true, "interrupted": true }),
                )
            }
            "grow_memory" => {
                let pages = req.pages.unwrap_or(64);
                match rt.grow_memory(pages).await {
                    Ok((bytes, timings)) => ok_stage(
                        name,
                        timings,
                        json!({ "bytes": bytes, "pages_requested": pages, "limited": false }),
                    ),
                    Err(err) => {
                        // Expected when hitting StoreLimits — host must survive.
                        ok_stage(
                            name,
                            Timings::default(),
                            json!({
                                "pages_requested": pages,
                                "limited": true,
                                "error": err.to_string(),
                                "survived": true,
                            }),
                        )
                    }
                }
            }
            "drop_instance" => {
                let timings = rt.drop_instance();
                ok_stage(name, timings, json!({ "has_instance": false }))
            }
            "drop_engine" | "disable" => {
                let timings = rt.drop_engine();
                ok_stage(name, timings, json!({ "has_engine": false }))
            }
            other => Err(format!("unknown inprocess stage {other}")),
        }
    })?;
    Ok(run)
}

/// Kill and reap a child session. Never leaves an owned session wedged in the parent.
fn reap_child_session(mut session: ChildSession) {
    let _ = session.child.kill();
    let _ = session.child.wait();
}

/// Single child request path: take session ownership, write/read, restore only on
/// successful non-shutdown response. Any write/read EOF/error kills, reaps, and
/// clears so a later spawn cannot wedge on a dead session.
fn child_exchange(
    guard: &mut ProbeState,
    request: &HostRequest,
) -> Result<(HostResponse, Option<u32>, Option<bool>), String> {
    let mut session = guard.child.take().ok_or("child not spawned")?;
    let pid = session.pid;
    if let Err(err) = write_frame(&mut session.stdin, request) {
        reap_child_session(session);
        return Err(format!(
            "child write failed (session cleared pid={pid}): {err}"
        ));
    }
    match read_frame::<_, HostResponse>(&mut session.stdout) {
        Ok(resp) => {
            if matches!(request, HostRequest::Shutdown) {
                // Graceful shutdown: wait for clean exit; do not restore session.
                let wait_result = session.child.wait();
                let status = match wait_result {
                    Ok(status) => status,
                    Err(err) => {
                        let _ = session.child.kill();
                        let _ = session.child.wait();
                        return Err(err.to_string());
                    }
                };
                std::thread::sleep(Duration::from_millis(20));
                if path_exists(&format!("/proc/{pid}")) {
                    return Err(format!("child pid {pid} still alive after shutdown"));
                }
                Ok((resp, Some(pid), Some(status.success())))
            } else {
                guard.child = Some(session);
                Ok((resp, Some(pid), None))
            }
        }
        Err(err) => {
            reap_child_session(session);
            std::thread::sleep(Duration::from_millis(20));
            Err(format!(
                "child read failed (session cleared pid={pid}): {err}"
            ))
        }
    }
}

fn dispatch_child(
    guard: &mut ProbeState,
    name: &str,
    req: &StageRequest,
) -> Result<StageResponse, String> {
    match name {
        "spawn" | "spawn_child" => {
            if guard.child.is_some() {
                return Err("child already spawned".into());
            }
            let started = Instant::now();
            let host_bin = guard.host_bin.as_ref().ok_or("host_bin missing")?.clone();
            let component = guard.component.as_ref().ok_or("component missing")?.clone();
            let component_sha = sha256_file_hex(&component)?;
            let mut child = Command::new(&host_bin)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                // Explicitly scrub environment that could leak operator material.
                .env_clear()
                .env("PATH", "/usr/bin:/bin")
                .env("RUST_BACKTRACE", "0")
                .spawn()
                .map_err(|e| format!("spawn host: {e}"))?;
            let pid = child.id();
            let stdin = child.stdin.take().ok_or("child stdin missing")?;
            let stdout = child.stdout.take().ok_or("child stdout missing")?;
            let session = ChildSession {
                child,
                stdin: BufWriter::new(stdin),
                stdout: BufReader::new(stdout),
                pid,
            };
            let identity = SpikeIdentity {
                session_id: format!("p7-spike-{pid}"),
                component_sha256: component_sha,
                component_kind: guard.component_kind,
            };
            // Prove the child command line carries no profile/token material.
            let cmdline = std::fs::read_to_string(format!("/proc/{pid}/cmdline"))
                .unwrap_or_default()
                .replace('\0', " ");
            if cmdline.contains("sqlite")
                || cmdline.contains("token")
                || cmdline.contains("data-dir")
            {
                reap_child_session(session);
                return Err(format!(
                    "child cmdline leaked sensitive material: {cmdline}"
                ));
            }
            // Park session then run hello/load through the shared exchange helper so
            // spawn-time IPC failures clear the same way as later stages.
            guard.child = Some(session);
            let hello = HostRequest::hello(identity, guard.limits);
            child_exchange(guard, &hello).and_then(|(resp, _, _)| {
                ensure_ok(&resp)?;
                Ok(())
            })?;
            let load = HostRequest::LoadComponent {
                component_path: component.display().to_string(),
            };
            child_exchange(guard, &load).and_then(|(resp, _, _)| {
                ensure_ok(&resp)?;
                Ok(())
            })?;
            let elapsed = started.elapsed().as_secs_f64() * 1000.0;
            ok_stage(
                name,
                Timings {
                    total_ms: Some(elapsed),
                    ..Timings::default()
                },
                json!({ "child_pid": pid, "cmdline": cmdline }),
            )
        }
        "child_idle" | "idle_child" => {
            let child = guard.child.as_mut().ok_or("child not spawned")?;
            if !path_exists(&format!("/proc/{}", child.pid)) {
                // Dead child discovered at idle check: clear so spawn can recover.
                if let Some(session) = guard.child.take() {
                    reap_child_session(session);
                }
                return Err("child process missing (session cleared)".into());
            }
            ok_stage(
                name,
                Timings::default(),
                json!({ "child_pid": child.pid, "alive": true }),
            )
        }
        // Active in-flight crash: prestart killer, then Sleep via the same
        // child_exchange helper ordinary stages use. Passing this proves EOF on
        // generic IPC clears the session for a later spawn.
        "crash_child_inflight" | "kill_child_inflight" | "kill_child" | "child_kill" => {
            let pid = guard.child.as_ref().ok_or("child not spawned")?.pid;
            let kill_delay_ms = 40_u64;
            let bound_ms = 2_000_u64;
            let killer = std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(kill_delay_ms));
                let _ = Command::new("/bin/kill")
                    .args(["-KILL", &pid.to_string()])
                    .status();
            });
            let started = Instant::now();
            let request = HostRequest::Sleep { ms: 5_000 };
            let exchange_result = child_exchange(guard, &request);
            let _ = killer.join();
            let elapsed = started.elapsed();
            if elapsed > Duration::from_millis(bound_ms) {
                if let Some(session) = guard.child.take() {
                    reap_child_session(session);
                }
                return Err(format!(
                    "in-flight crash wait exceeded {bound_ms}ms bound (elapsed {}ms)",
                    elapsed.as_millis()
                ));
            }
            if path_exists(&format!("/proc/{pid}")) {
                if let Some(session) = guard.child.take() {
                    reap_child_session(session);
                }
                return Err(format!("child pid {pid} still alive after in-flight kill"));
            }
            // Generic path must leave session cleared and surface IPC failure.
            if guard.child.is_some() {
                if let Some(session) = guard.child.take() {
                    reap_child_session(session);
                }
                return Err("child session still present after in-flight crash".into());
            }
            let ipc_error = match exchange_result {
                Ok(_resp) => {
                    return Err(
                        "in-flight crash expected IPC failure after kill via child_exchange, got success"
                            .into(),
                    );
                }
                Err(msg) => msg,
            };
            ok_stage(
                name,
                Timings {
                    total_ms: Some(elapsed.as_secs_f64() * 1000.0),
                    terminate_ms: Some(elapsed.as_secs_f64() * 1000.0),
                    ..Timings::default()
                },
                json!({
                    "killed_pid": pid,
                    "in_flight": true,
                    "via_child_exchange": true,
                    "ipc_error": ipc_error,
                    "wait_ok": true,
                    "cleaned": true,
                    "session_cleared": true,
                    "parent_survived": true,
                    "bound_ms": bound_ms,
                    "kill_delay_ms": kill_delay_ms,
                }),
            )
        }
        other => {
            let request = match other {
                "instantiate" => HostRequest::Instantiate,
                "ping" | "first_ping" => HostRequest::Ping {
                    input: req.input.unwrap_or(1),
                },
                "warm_ping" => HostRequest::WarmPing {
                    input: req.input.unwrap_or(1),
                    iterations: req.iterations.unwrap_or(100),
                },
                "trap" | "force_trap" => HostRequest::ForceTrap,
                "cpu_loop" => HostRequest::CpuLoop,
                "grow_memory" => HostRequest::GrowMemory {
                    pages: req.pages.unwrap_or(64),
                },
                "drop_instance" => HostRequest::DropInstance,
                "drop_engine" | "disable" => HostRequest::DropEngine,
                "shutdown_child" | "child_shutdown" => HostRequest::Shutdown,
                _ => return Err(format!("unknown child stage {other}")),
            };
            let (resp, pid, exit_ok) = child_exchange(guard, &request)?;
            if matches!(request, HostRequest::Shutdown) {
                return ok_stage(
                    name,
                    Timings::default(),
                    json!({
                        "exit_ok": exit_ok.unwrap_or(false),
                        "child_pid": pid,
                        "cleaned": true,
                    }),
                );
            }
            match resp {
                HostResponse::Ok { timings_ms, detail } => {
                    ok_stage(name, timings_ms, detail.unwrap_or(json!({})))
                }
                HostResponse::Err {
                    kind,
                    message,
                    timings_ms,
                } => {
                    // Hostile stages may return Err while parent survives.
                    if matches!(other, "trap" | "force_trap" | "cpu_loop" | "grow_memory") {
                        ok_stage(
                            name,
                            timings_ms,
                            json!({
                                "survived": true,
                                "child_error_kind": kind,
                                "child_error": message,
                                "limited_or_trapped": true,
                            }),
                        )
                    } else {
                        Err(format!("{kind}: {message}"))
                    }
                }
            }
        }
    }
}

fn ensure_ok(resp: &HostResponse) -> Result<(), String> {
    match resp {
        HostResponse::Ok { .. } => Ok(()),
        HostResponse::Err { kind, message, .. } => Err(format!("{kind}: {message}")),
    }
}

fn ok_stage(stage: &str, timings: Timings, detail: Value) -> Result<StageResponse, String> {
    Ok(StageResponse {
        ok: true,
        stage: stage.to_owned(),
        timings_ms: Some(timings),
        detail: Some(detail),
        error: None,
        error_kind: None,
    })
}

fn shutdown_locked(guard: &mut ProbeState) -> Result<(), String> {
    if let Some(mut child) = guard.child.take() {
        let _ = write_frame(&mut child.stdin, &HostRequest::Shutdown);
        let _ = child.child.wait();
    }
    #[cfg(feature = "wasmtime-runtime")]
    if let Some(rt) = guard.runtime.as_mut() {
        rt.drop_engine();
    }
    Ok(())
}

fn has_engine(guard: &ProbeState) -> bool {
    #[cfg(feature = "wasmtime-runtime")]
    {
        guard.runtime.as_ref().is_some_and(|r| r.has_engine())
    }
    #[cfg(not(feature = "wasmtime-runtime"))]
    {
        let _ = guard;
        false
    }
}

fn has_instance(guard: &ProbeState) -> bool {
    #[cfg(feature = "wasmtime-runtime")]
    {
        guard.runtime.as_ref().is_some_and(|r| r.has_instance())
    }
    #[cfg(not(feature = "wasmtime-runtime"))]
    {
        let _ = guard;
        false
    }
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|pos| pos + 4)
}

fn write_http(
    stream: &mut std::net::TcpStream,
    status: u16,
    content_type: &str,
    body: &Value,
) -> Result<(), String> {
    use std::io::Write;
    let payload = serde_json::to_vec(body).map_err(|e| e.to_string())?;
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        _ => "Error",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        payload.len()
    );
    stream
        .write_all(header.as_bytes())
        .map_err(|e| e.to_string())?;
    stream.write_all(&payload).map_err(|e| e.to_string())?;
    Ok(())
}

fn path_exists(path: &str) -> bool {
    Path::new(path).exists()
}

#[cfg(feature = "wasmtime-runtime")]
fn block_on<F, T>(fut: F) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    rt.block_on(fut)
}
