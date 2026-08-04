//! TEMPORARY Phase 7 Wave 0 child plugin-host process.
//!
//! Speaks length-prefixed JSON on stdio. Receives no profile path, access token,
//! or SQLite URL. Owns no profile lock.

use std::io::{self, BufReader, BufWriter};
use std::path::PathBuf;

use junban_phase7_host_placement::child_ipc::{
    HostRequest, HostResponse, Timings, read_frame, validate_hello, write_frame,
};
use junban_phase7_host_placement::runtime::SpikeRuntime;
use serde_json::json;

fn main() {
    if let Err(err) = run() {
        // Best-effort final error frame if stdout is still usable.
        let mut stdout = BufWriter::new(io::stdout().lock());
        let _ = write_frame(
            &mut stdout,
            &HostResponse::Err {
                kind: "host_fatal".into(),
                message: err,
                timings_ms: Timings::default(),
            },
        );
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());

    let mut runtime: Option<SpikeRuntime> = None;
    let mut expected_component_sha256: Option<String> = None;
    let mut greeted = false;

    loop {
        let request: HostRequest = read_frame(&mut reader).map_err(|e| e.to_string())?;
        let response = match request {
            HostRequest::Hello {
                protocol_name,
                protocol_version,
                identity,
                limits: req_limits,
            } => {
                validate_hello(&protocol_name, protocol_version).map_err(|e| e.to_string())?;
                // Reject any accidental sensitive fields encoded in session id.
                let sid = identity.session_id.to_ascii_lowercase();
                if sid.contains("token") || sid.contains("sqlite") {
                    return Err("hello identity looks sensitive".into());
                }
                if identity.component_sha256.len() != 64
                    || !identity
                        .component_sha256
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit())
                {
                    return Err("hello component_sha256 must be 64 lowercase hex chars".into());
                }
                let kind = identity.component_kind;
                runtime = Some(SpikeRuntime::new(req_limits, kind));
                expected_component_sha256 = Some(identity.component_sha256.to_ascii_lowercase());
                greeted = true;
                HostResponse::Ok {
                    timings_ms: Timings::default(),
                    detail: Some(json!({
                        "session_id": identity.session_id,
                        "component_sha256": identity.component_sha256,
                        "component_kind": format!("{kind:?}").to_ascii_lowercase(),
                    })),
                }
            }
            HostRequest::LoadComponent {
                component_path: path,
            } => {
                ensure_greeted(greeted)?;
                let expected = expected_component_sha256
                    .as_ref()
                    .ok_or("hello identity missing component hash")?
                    .clone();
                let path = PathBuf::from(path);
                if !path.is_file() {
                    fail("load", format!("component missing: {}", path.display()))
                } else {
                    // Path must not look like a Junban profile root.
                    let display = path.display().to_string();
                    if display.contains("access-token") || display.ends_with("junban.sqlite3") {
                        return Err("refusing profile-looking component path".into());
                    }
                    // Read once into memory; hash and retain exact bytes. Never reopen
                    // the path at compile/instantiate time (TOCTOU-closed).
                    let rt = runtime.as_mut().ok_or("runtime missing")?;
                    match rt.load_component_path(&path, &expected) {
                        Ok(actual) => HostResponse::Ok {
                            timings_ms: Timings::default(),
                            detail: Some(json!({
                                "loaded_bytes_retained": true,
                                "component_sha256_matched": true,
                                "component_sha256": actual,
                                "has_pending_bytes": rt.has_pending_bytes(),
                                "has_component": rt.has_component(),
                            })),
                        },
                        Err(err) => fail("load", err.to_string()),
                    }
                }
            }
            HostRequest::Instantiate => {
                let rt = runtime.as_mut().ok_or("runtime missing")?;
                match block_on(async {
                    if !rt.has_engine() {
                        rt.create_engine().map_err(|e| e.to_string())?;
                    }
                    // Compile retained exact bytes only on first need; later
                    // reinstantiations reuse the compiled Component.
                    let compile = rt.ensure_compiled().map_err(|e| e.to_string())?;
                    let inst = rt.instantiate().await.map_err(|e| e.to_string())?;
                    Ok::<_, String>((compile, inst))
                }) {
                    Ok((compile, inst)) => HostResponse::Ok {
                        timings_ms: Timings {
                            engine_create_ms: compile.engine_create_ms,
                            compile_ms: compile.compile_ms,
                            instantiate_ms: inst.instantiate_ms,
                            total_ms: Some(
                                compile.total_ms.unwrap_or(0.0) + inst.total_ms.unwrap_or(0.0),
                            ),
                            ..Timings::default()
                        },
                        detail: Some(json!({
                            "has_instance": true,
                            "has_component": true,
                            "has_pending_bytes": rt.has_pending_bytes(),
                        })),
                    },
                    Err(message) => fail("instantiate", message),
                }
            }
            HostRequest::Ping { input } => {
                let rt = runtime.as_mut().ok_or("runtime missing")?;
                match block_on(rt.ping(input)) {
                    Ok((output, timings)) => HostResponse::Ok {
                        timings_ms: timings,
                        detail: Some(json!({ "output": output })),
                    },
                    Err(err) => fail("ping", err.to_string()),
                }
            }
            HostRequest::WarmPing { input, iterations } => {
                let rt = runtime.as_mut().ok_or("runtime missing")?;
                match block_on(rt.warm_ping(input, iterations)) {
                    Ok((output, timings)) => HostResponse::Ok {
                        timings_ms: timings,
                        detail: Some(json!({ "output": output, "iterations": iterations })),
                    },
                    Err(err) => fail("warm_ping", err.to_string()),
                }
            }
            HostRequest::ForceTrap => {
                let rt = runtime.as_mut().ok_or("runtime missing")?;
                match block_on(rt.force_trap()) {
                    Ok(timings) => HostResponse::Ok {
                        timings_ms: timings,
                        detail: Some(json!({ "trapped": true, "survived": true })),
                    },
                    Err(err) => fail("force_trap", err.to_string()),
                }
            }
            HostRequest::CpuLoop => {
                let rt = runtime.as_mut().ok_or("runtime missing")?;
                match block_on(rt.cpu_loop()) {
                    Ok(timings) => HostResponse::Ok {
                        timings_ms: timings,
                        detail: Some(json!({ "interrupted": true, "survived": true })),
                    },
                    Err(err) => fail("cpu_loop", err.to_string()),
                }
            }
            HostRequest::GrowMemory { pages } => {
                let rt = runtime.as_mut().ok_or("runtime missing")?;
                match block_on(rt.grow_memory(pages)) {
                    Ok((bytes, timings)) => HostResponse::Ok {
                        timings_ms: timings,
                        detail: Some(json!({ "bytes": bytes, "limited": false })),
                    },
                    Err(err) => HostResponse::Err {
                        kind: "memory_limit".into(),
                        message: err.to_string(),
                        timings_ms: Timings::default(),
                    },
                }
            }
            HostRequest::Sleep { ms } => {
                // Bound sleep so a runaway parent cannot hang the child forever.
                let ms = ms.min(10_000);
                std::thread::sleep(std::time::Duration::from_millis(ms));
                HostResponse::Ok {
                    timings_ms: Timings {
                        total_ms: Some(ms as f64),
                        ..Timings::default()
                    },
                    detail: Some(json!({ "slept_ms": ms })),
                }
            }
            HostRequest::DropInstance => {
                let rt = runtime.as_mut().ok_or("runtime missing")?;
                let timings = rt.drop_instance();
                HostResponse::Ok {
                    timings_ms: timings,
                    detail: Some(json!({ "has_instance": false })),
                }
            }
            HostRequest::DropEngine => {
                let rt = runtime.as_mut().ok_or("runtime missing")?;
                let timings = rt.drop_engine();
                HostResponse::Ok {
                    timings_ms: timings,
                    detail: Some(json!({ "has_engine": false })),
                }
            }
            HostRequest::Shutdown => {
                if let Some(rt) = runtime.as_mut() {
                    rt.drop_engine();
                }
                write_frame(
                    &mut writer,
                    &HostResponse::Ok {
                        timings_ms: Timings::default(),
                        detail: Some(json!({ "shutdown": true })),
                    },
                )
                .map_err(|e| e.to_string())?;
                return Ok(());
            }
        };
        write_frame(&mut writer, &response).map_err(|e| e.to_string())?;
    }
}

fn ensure_greeted(greeted: bool) -> Result<(), String> {
    if greeted {
        Ok(())
    } else {
        Err("hello required first".into())
    }
}

fn fail(kind: &str, message: String) -> HostResponse {
    HostResponse::Err {
        kind: kind.into(),
        message,
        timings_ms: Timings::default(),
    }
}

fn block_on<F, T, E>(fut: F) -> Result<T, E>
where
    F: std::future::Future<Output = Result<T, E>>,
{
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    rt.block_on(fut)
}
