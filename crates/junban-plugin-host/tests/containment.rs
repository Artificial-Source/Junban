use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use junban_plugin_sdk::{
    AuthorityFence, CallbackFence, Capability, ChildFrame, HOST_CALLBACK_BODY_BYTES_MAX,
    HOST_FRAME_BYTES_MAX, HOST_PROTOCOL_NAME, HOST_PROTOCOL_VERSION, HostCallKind, HostCallReply,
    HostCallRequest, HostFailureCode, InvocationOutcome, InvocationRequest, ParentFrame,
    Permission, PermissionScope, RuntimeLimits, RuntimeProfile, TypedParentMessage,
    UnscopedPermission, canonical_permission_hash, child_body_len, decode_child_frame,
    decode_host_call_request, decode_invocation_outcome, encode_parent_frame,
    inspect_component_for_runtime, private_body_types as body, validate_child_body,
};
use sha2::{Digest, Sha256};

const SESSION: &str = "00000000-0000-4000-8000-000000000001";
const RUST_COMPONENT: &[u8] =
    include_bytes!("../../junban-plugin-sdk/consumers/rust/rust-consumer.wasm");
const FRAME_TIMEOUT: Duration = Duration::from_secs(30);
const PROCESS_TIMEOUT: Duration = Duration::from_secs(30);

enum ReaderEvent {
    Message(ChildFrame, Vec<u8>),
    Eof,
    Error(String),
}

struct HostProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    frames: mpsc::Receiver<ReaderEvent>,
    stderr: mpsc::Receiver<Vec<u8>>,
    permission_hash: String,
    next_invocation: u64,
}

impl HostProcess {
    fn spawn() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_junban-plugin-host"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let (frame_tx, frames) = mpsc::sync_channel(64);
        thread::spawn(move || {
            loop {
                match read_message(&mut stdout) {
                    Ok(Some(message)) => {
                        if frame_tx
                            .send(ReaderEvent::Message(message.0, message.1))
                            .is_err()
                        {
                            break;
                        }
                    }
                    Ok(None) => {
                        let _ = frame_tx.send(ReaderEvent::Eof);
                        break;
                    }
                    Err(error) => {
                        let _ = frame_tx.send(ReaderEvent::Error(error));
                        break;
                    }
                }
            }
        });
        let (stderr_tx, stderr_rx) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = stderr.read_to_end(&mut bytes);
            let _ = stderr_tx.send(bytes);
        });
        let grants = permissions();
        Self {
            child,
            stdin: Some(stdin),
            frames,
            stderr: stderr_rx,
            permission_hash: canonical_permission_hash(&grants).unwrap(),
            next_invocation: 2,
        }
    }

    fn hello(&mut self) {
        self.send(
            &ParentFrame::Hello {
                protocol_name: HOST_PROTOCOL_NAME.into(),
                protocol_version: HOST_PROTOCOL_VERSION,
                host_session_id: SESSION.into(),
            },
            &[],
        );
        assert_eq!(
            self.receive(),
            (
                ChildFrame::Hello {
                    protocol_name: HOST_PROTOCOL_NAME.into(),
                    protocol_version: HOST_PROTOCOL_VERSION,
                    host_session_id: SESSION.into(),
                },
                Vec::new(),
            )
        );
    }

    fn load(&mut self, component: &[u8], profile: RuntimeProfile) {
        let grants = permissions();
        let inspection = inspect_component_for_runtime(component, profile, &grants).unwrap();
        let load_fence = fence(1);
        self.send(
            &ParentFrame::Load {
                fence: load_fence.clone(),
                package_sha256: "1".repeat(64),
                component_sha256: sha256(component),
                import_export_fingerprint: inspection.import_export_fingerprint.clone(),
                runtime_profile: profile,
                component_size: component.len() as u64,
                grants,
                permission_hash: self.permission_hash.clone(),
                limits: RuntimeLimits::for_profile(profile),
            },
            component,
        );
        assert_eq!(
            self.receive(),
            (
                ChildFrame::Loaded {
                    fence: load_fence,
                    import_export_fingerprint: inspection.import_export_fingerprint,
                },
                Vec::new(),
            )
        );
    }

    fn send(&mut self, frame: &ParentFrame, body: &[u8]) {
        let bytes = encode_parent_frame(frame).unwrap();
        let stdin = self.stdin.as_mut().expect("child stdin remains open");
        stdin.write_all(&bytes).unwrap();
        stdin.write_all(body).unwrap();
        stdin.flush().unwrap();
    }

    fn send_typed(&mut self, message: TypedParentMessage) {
        let (frame, body) = message.into_parts();
        self.send(&frame, &body);
    }

    fn receive(&self) -> (ChildFrame, Vec<u8>) {
        match self.frames.recv_timeout(FRAME_TIMEOUT).unwrap() {
            ReaderEvent::Message(frame, body) => (frame, body),
            ReaderEvent::Eof => panic!("child closed stdout before the expected frame"),
            ReaderEvent::Error(error) => panic!("child output rejected: {error}"),
        }
    }

    fn receive_event(&self) -> ReaderEvent {
        self.frames.recv_timeout(FRAME_TIMEOUT).unwrap()
    }

    fn start(&mut self, request: InvocationRequest) -> AuthorityFence {
        let invocation = fence(self.next_invocation);
        self.next_invocation += 1;
        self.send_typed(
            request
                .into_parent_message(invocation.clone(), self.permission_hash.clone())
                .unwrap(),
        );
        invocation
    }

    fn command(&mut self, command_id: &str) -> AuthorityFence {
        self.start(InvocationRequest::invoke_command(
            None,
            body::CommandCall {
                command_id: command_id.into(),
                values: Vec::new(),
            },
        ))
    }

    fn spinning_event(&mut self) -> AuthorityFence {
        self.start(InvocationRequest::handle_event(
            None,
            body::EventEnvelope {
                event_epoch: "spin".into(),
                revision: 1,
                kind: body::EventKind::TaskDeleted,
                subject: body::EventSubject::DeletedTask("task".into()),
            },
        ))
    }

    fn service(&mut self) -> AuthorityFence {
        self.start(InvocationRequest::call_service(
            None,
            body::ServiceCall {
                plugin_id: "dependency".into(),
                service_id: "state".into(),
                values: Vec::new(),
            },
        ))
    }

    fn reply(&mut self, callback: CallbackFence, reply: HostCallReply) {
        self.send_typed(reply.into_parent_message(callback).unwrap());
    }

    fn cancel(&mut self, invocation: AuthorityFence) {
        self.send(&ParentFrame::Cancel { fence: invocation }, &[]);
    }

    fn shutdown(&mut self) -> Vec<u8> {
        self.send(
            &ParentFrame::Shutdown {
                host_session_id: SESSION.into(),
            },
            &[],
        );
        assert_eq!(
            self.receive(),
            (
                ChildFrame::ShutdownComplete {
                    host_session_id: SESSION.into(),
                },
                Vec::new(),
            )
        );
        self.close_and_wait(true)
    }

    fn close_and_wait(&mut self, expect_success: bool) -> Vec<u8> {
        self.stdin.take();
        let status = wait_for_exit(&mut self.child);
        assert_eq!(
            status.success(),
            expect_success,
            "unexpected child status {status}"
        );
        self.stderr.recv_timeout(PROCESS_TIMEOUT).unwrap()
    }

    fn write_malformed_frame(&mut self) {
        let stdin = self.stdin.as_mut().unwrap();
        stdin.write_all(&0_u32.to_be_bytes()).unwrap();
        stdin.flush().unwrap();
    }
}

impl Drop for HostProcess {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn wait_for_exit(child: &mut Child) -> ExitStatus {
    let deadline = Instant::now() + PROCESS_TIMEOUT;
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        assert!(
            Instant::now() < deadline,
            "child did not exit within safety timeout"
        );
        // This is only the test-process safety guard, never protocol correctness.
        thread::sleep(Duration::from_millis(10));
    }
}

fn read_message(stdout: &mut impl Read) -> Result<Option<(ChildFrame, Vec<u8>)>, String> {
    let mut length = [0_u8; 4];
    let mut filled = 0;
    while filled < length.len() {
        match stdout.read(&mut length[filled..]) {
            Ok(0) if filled == 0 => return Ok(None),
            Ok(0) => return Err("truncated child frame length".into()),
            Ok(read) => filled += read,
            Err(error) => return Err(format!("child frame read failed: {error}")),
        }
    }
    let length = usize::try_from(u32::from_be_bytes(length)).unwrap();
    if length == 0 || length > HOST_FRAME_BYTES_MAX {
        return Err("invalid child frame length".into());
    }
    let mut encoded = vec![0; 4 + length];
    encoded[..4].copy_from_slice(&u32::try_from(length).unwrap().to_be_bytes());
    stdout
        .read_exact(&mut encoded[4..])
        .map_err(|_| "truncated child frame".to_owned())?;
    let frame = decode_child_frame(&encoded).map_err(|_| "invalid child frame".to_owned())?;
    let mut body = vec![0; child_body_len(&frame).map_err(|_| "invalid child body".to_owned())?];
    stdout
        .read_exact(&mut body)
        .map_err(|_| "truncated child body".to_owned())?;
    validate_child_body(&frame, &body).map_err(|_| "invalid child body".to_owned())?;
    Ok(Some((frame, body)))
}

fn permissions() -> Vec<Permission> {
    [
        Capability::Logging,
        Capability::Settings,
        Capability::Storage,
        Capability::TasksRead,
    ]
    .into_iter()
    .map(|capability| Permission {
        capability,
        scope: PermissionScope::Unscoped(UnscopedPermission {}),
    })
    .collect()
}

fn fence(invocation: u64) -> AuthorityFence {
    AuthorityFence {
        plugin_id: "test-plugin".into(),
        package_generation: 7,
        activation_epoch: 9,
        host_session_id: SESSION.into(),
        invocation_id: format!("00000000-0000-4000-8000-{invocation:012x}"),
    }
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn expect_capability(frame: ChildFrame, bytes: &[u8]) -> (CallbackFence, HostCallRequest) {
    let ChildFrame::CapabilityRequest { callback, kind, .. } = frame else {
        panic!("expected capability request, got {frame:?}");
    };
    (callback, decode_host_call_request(kind, bytes).unwrap())
}

fn expect_outcome(frame: ChildFrame, bytes: &[u8]) -> InvocationOutcome {
    let ChildFrame::Outcome { kind, .. } = frame else {
        panic!("expected invocation outcome, got {frame:?}");
    };
    decode_invocation_outcome(kind, bytes).unwrap()
}

fn expect_failure(message: (ChildFrame, Vec<u8>), fence: AuthorityFence, code: HostFailureCode) {
    assert_eq!(message, (ChildFrame::Failed { fence, code }, Vec::new()));
}

fn reply_query(host: &mut HostProcess) {
    let (frame, bytes) = host.receive();
    let (callback, request) = expect_capability(frame, &bytes);
    assert!(matches!(request, HostCallRequest::QueryTasks(_)));
    host.reply(
        callback,
        HostCallReply::QueryTasks(body::WitResult::Ok(body::TaskPage {
            items: Vec::new(),
            next_cursor: None,
            revision: 1,
        })),
    );
}

fn expect_service(host: &mut HostProcess, activation_count: i64) {
    let (frame, bytes) = host.receive();
    assert_eq!(
        expect_outcome(frame, &bytes),
        InvocationOutcome::CallService(body::WitResult::Ok(body::ServiceData {
            values: vec![body::NamedValue {
                name: "activation-count".into(),
                value: body::DataValue::Scalar(body::ScalarValue::IntegerValue(activation_count)),
            }],
        }))
    );
}

fn activate(host: &mut HostProcess) {
    host.start(InvocationRequest::activate(None));
    let (frame, bytes) = host.receive();
    let (settings, request) = expect_capability(frame, &bytes);
    assert_eq!(request, HostCallRequest::GetSettings(()));
    host.reply(
        settings,
        HostCallReply::GetSettings(body::WitResult::Ok(Vec::new())),
    );

    let (frame, bytes) = host.receive();
    let (get_kv, request) = expect_capability(frame, &bytes);
    assert!(matches!(request, HostCallRequest::GetKv(_)));
    host.reply(
        get_kv,
        HostCallReply::GetKv(body::WitResult::Ok(Vec::new())),
    );

    let (frame, bytes) = host.receive();
    let (list_kv, request) = expect_capability(frame, &bytes);
    assert!(matches!(request, HostCallRequest::ListKv(_)));
    host.reply(
        list_kv,
        HostCallReply::ListKv(body::WitResult::Ok(body::KvPage {
            entries: Vec::new(),
            next_cursor: None,
        })),
    );

    let (frame, bytes) = host.receive();
    let (log, request) = expect_capability(frame, &bytes);
    assert!(matches!(request, HostCallRequest::Log(_)));
    host.reply(log, HostCallReply::Log(()));

    let (frame, bytes) = host.receive();
    assert_eq!(
        expect_outcome(frame, &bytes),
        InvocationOutcome::Activate(body::WitResult::Ok(()))
    );
}

#[test]
fn maximum_valid_import_reaches_callback_and_returns_normally() {
    let mut host = HostProcess::spawn();
    host.hello();
    host.load(RUST_COMPONENT, RuntimeProfile::Rust);

    host.command("hostcall-valid-import");
    let (frame, bytes) = host.receive();
    let (callback, request) = expect_capability(frame, &bytes);
    let HostCallRequest::QueryTasks(query) = &request else {
        panic!("expected boundary task query, got {request:?}");
    };
    assert_eq!(query.search.as_ref().map(String::len), Some(8 * 1024));
    host.reply(
        callback,
        HostCallReply::QueryTasks(body::WitResult::Ok(body::TaskPage {
            items: Vec::new(),
            next_cursor: None,
            revision: 1,
        })),
    );
    let (frame, bytes) = host.receive();
    assert_eq!(
        expect_outcome(frame, &bytes),
        InvocationOutcome::InvokeCommand(body::WitResult::Ok(body::PluginOutcome { effect: None }))
    );

    // Debug serde/validation of a near-4-MiB callback exceeds the frozen
    // one-second product deadline on slower builders. The optimized campaign is
    // the authoritative large-transfer evidence; the semantic maximum above
    // remains in every test profile.
    #[cfg(not(debug_assertions))]
    {
        host.command("hostcall-near-bound-import");
        let (frame, bytes) = host.receive();
        let (callback, request) = expect_capability(frame, &bytes);
        let HostCallRequest::QueryTasks(query) = request else {
            panic!("expected near-bound task query");
        };
        assert_eq!(
            query.search.map(|search| search.len()),
            Some(4 * 1024 * 1024 - 4 * 1024)
        );
        host.reply(
            callback,
            HostCallReply::QueryTasks(body::WitResult::Ok(body::TaskPage {
                items: Vec::new(),
                next_cursor: None,
                revision: 1,
            })),
        );
        let (frame, bytes) = host.receive();
        assert_eq!(
            expect_outcome(frame, &bytes),
            InvocationOutcome::InvokeCommand(body::WitResult::Ok(body::PluginOutcome {
                effect: None,
            }))
        );
    }

    assert!(host.shutdown().is_empty());
}

#[test]
fn oversized_import_is_rejected_before_callback_and_replaces_rust_store() {
    let mut host = HostProcess::spawn();
    host.hello();
    host.load(RUST_COMPONENT, RuntimeProfile::Rust);

    // Without explicit Store hostcall fuel this canonical list would lift and
    // its compact request would fit the later callback-body authority. Keep
    // this control coupled to the retained guest cardinality so omission of
    // `set_hostcall_fuel` cannot pass via a later protocol-size rejection.
    let control = HostCallRequest::QueryTasks(body::TaskQuery {
        task_id: None,
        project_id: None,
        section_id: None,
        parent_id: None,
        tag_ids: vec![String::new(); 558_081],
        statuses: Vec::new(),
        priorities: Vec::new(),
        due_from: None,
        due_before: None,
        search: None,
        cursor: None,
        limit: 1,
    })
    .into_child_message(CallbackFence {
        plugin_id: "test-plugin".into(),
        package_generation: 7,
        activation_epoch: 9,
        host_session_id: SESSION.into(),
        invocation_id: "00000000-0000-4000-8000-000000000099".into(),
        callback_id: 1,
    })
    .unwrap();
    assert!(control.body().len() < HOST_CALLBACK_BODY_BYTES_MAX);

    let hostile = host.command("hostcall-oversized-import");
    expect_failure(host.receive(), hostile, HostFailureCode::ResourceLimit);

    host.service();
    expect_service(&mut host, 0);
    assert!(host.shutdown().is_empty());
}

#[test]
fn wall_timeout_interrupts_cpu_and_callback_waits_and_replaces_failed_store() {
    let mut host = HostProcess::spawn();
    host.hello();
    host.load(RUST_COMPONENT, RuntimeProfile::Rust);

    activate(&mut host);
    host.service();
    expect_service(&mut host, 1);

    let spin = host.command("spin");
    expect_failure(host.receive(), spin, HostFailureCode::Timeout);
    host.service();
    expect_service(&mut host, 0);

    let wall_spin = host.spinning_event();
    expect_failure(host.receive(), wall_spin, HostFailureCode::Timeout);
    host.service();
    expect_service(&mut host, 0);

    let blocked = host.command("normal");
    let (frame, bytes) = host.receive();
    let (late_callback, request) = expect_capability(frame, &bytes);
    assert!(matches!(request, HostCallRequest::QueryTasks(_)));
    expect_failure(host.receive(), blocked, HostFailureCode::Timeout);
    host.reply(
        late_callback.clone(),
        HostCallReply::QueryTasks(body::WitResult::Ok(body::TaskPage {
            items: Vec::new(),
            next_cursor: None,
            revision: 1,
        })),
    );
    expect_failure(
        host.receive(),
        late_callback.authority(),
        HostFailureCode::StaleAuthority,
    );

    host.service();
    expect_service(&mut host, 0);
    assert!(host.shutdown().is_empty());
}

#[test]
fn hostile_guest_limits_are_stable_and_do_not_leak_guest_diagnostics() {
    let mut host = HostProcess::spawn();
    host.hello();
    host.load(RUST_COMPONENT, RuntimeProfile::Rust);

    for (command, expected) in [
        ("trap", HostFailureCode::GuestError),
        ("fuel", HostFailureCode::ResourceLimit),
        ("memory-grow", HostFailureCode::ResourceLimit),
        ("stack", HostFailureCode::ResourceLimit),
        ("host-resources", HostFailureCode::ResourceLimit),
        ("stderr", HostFailureCode::ResourceLimit),
        ("oversized-output", HostFailureCode::ResourceLimit),
        ("log-message", HostFailureCode::ResourceLimit),
        ("log-fields", HostFailureCode::ResourceLimit),
    ] {
        let invocation = host.command(command);
        expect_failure(host.receive(), invocation, expected);
        host.service();
        expect_service(&mut host, 0);
    }

    let total = host.command("log-total");
    let mut accepted_logs = 0;
    loop {
        let (frame, bytes) = host.receive();
        match frame {
            ChildFrame::CapabilityRequest { callback, kind, .. } => {
                assert_eq!(kind, HostCallKind::Log);
                assert!(matches!(
                    decode_host_call_request(kind, &bytes).unwrap(),
                    HostCallRequest::Log(_)
                ));
                accepted_logs += 1;
                host.reply(callback, HostCallReply::Log(()));
            }
            ChildFrame::Failed { fence, code } => {
                assert_eq!(fence, total);
                assert_eq!(code, HostFailureCode::ResourceLimit);
                assert!((1..=8).contains(&accepted_logs));
                break;
            }
            other => panic!("unexpected log-limit frame {other:?}"),
        }
    }

    host.command("bulk-memory");
    reply_query(&mut host);
    let (frame, bytes) = host.receive();
    assert_eq!(
        expect_outcome(frame, &bytes),
        InvocationOutcome::InvokeCommand(body::WitResult::Ok(body::PluginOutcome { effect: None }))
    );

    let stderr = host.shutdown();
    let all_protocol_bytes = format!("{stderr:?}");
    assert!(!all_protocol_bytes.contains("retained hostile trap marker"));
    assert!(stderr.is_empty(), "guest stderr crossed the child boundary");
}

#[test]
fn cancel_unload_shutdown_and_finish_races_drain_active_invocations() {
    let mut host = HostProcess::spawn();
    host.hello();
    host.load(RUST_COMPONENT, RuntimeProfile::Rust);

    let blocked = host.command("normal");
    let (frame, bytes) = host.receive();
    let (late_callback, _) = expect_capability(frame, &bytes);
    host.cancel(blocked.clone());
    assert_eq!(
        host.receive(),
        (
            ChildFrame::Cancelled {
                fence: blocked.clone()
            },
            Vec::new()
        )
    );
    host.reply(
        late_callback.clone(),
        HostCallReply::QueryTasks(body::WitResult::Ok(body::TaskPage {
            items: Vec::new(),
            next_cursor: None,
            revision: 1,
        })),
    );
    expect_failure(
        host.receive(),
        late_callback.authority(),
        HostFailureCode::StaleAuthority,
    );
    host.cancel(blocked.clone());
    expect_failure(host.receive(), blocked, HostFailureCode::StaleAuthority);

    let cpu = host.command("spin");
    host.cancel(cpu.clone());
    assert_eq!(
        host.receive(),
        (ChildFrame::Cancelled { fence: cpu }, Vec::new())
    );

    for _ in 0..12 {
        let service = host.service();
        host.cancel(service.clone());
        let first = host.receive();
        match first.0 {
            ChildFrame::Cancelled { fence } => assert_eq!(fence, service),
            ChildFrame::Outcome { fence, kind, .. } => {
                assert_eq!(fence, service);
                assert_eq!(kind, junban_plugin_sdk::InvocationKind::CallService);
                expect_failure(host.receive(), service, HostFailureCode::StaleAuthority);
            }
            other => panic!("unexpected finish/cancel race frame {other:?}"),
        }
    }

    let active = host.command("spin");
    let unload = fence(host.next_invocation);
    host.next_invocation += 1;
    host.send(
        &ParentFrame::Unload {
            fence: unload.clone(),
        },
        &[],
    );
    assert_eq!(
        host.receive(),
        (ChildFrame::Cancelled { fence: active }, Vec::new())
    );
    assert_eq!(
        host.receive(),
        (
            ChildFrame::Unloaded {
                fence: unload.clone()
            },
            Vec::new()
        )
    );
    let stale = host.service();
    expect_failure(host.receive(), stale, HostFailureCode::StaleAuthority);
    assert!(host.shutdown().is_empty());

    let mut shutdown_host = HostProcess::spawn();
    shutdown_host.hello();
    shutdown_host.load(RUST_COMPONENT, RuntimeProfile::Rust);
    let active = shutdown_host.command("spin");
    shutdown_host.send(
        &ParentFrame::Shutdown {
            host_session_id: SESSION.into(),
        },
        &[],
    );
    assert_eq!(
        shutdown_host.receive(),
        (ChildFrame::Cancelled { fence: active }, Vec::new())
    );
    assert_eq!(
        shutdown_host.receive(),
        (
            ChildFrame::ShutdownComplete {
                host_session_id: SESSION.into(),
            },
            Vec::new(),
        )
    );
    assert!(shutdown_host.close_and_wait(true).is_empty());
}

#[test]
fn eof_and_malformed_input_abort_active_callbacks_without_orphans() {
    let mut eof_host = HostProcess::spawn();
    eof_host.hello();
    eof_host.load(RUST_COMPONENT, RuntimeProfile::Rust);
    eof_host.command("normal");
    let (frame, bytes) = eof_host.receive();
    assert!(matches!(
        expect_capability(frame, &bytes).1,
        HostCallRequest::QueryTasks(_)
    ));
    let stderr = eof_host.close_and_wait(true);
    assert!(stderr.is_empty());
    assert!(matches!(eof_host.receive_event(), ReaderEvent::Eof));

    let mut cpu_eof = HostProcess::spawn();
    cpu_eof.hello();
    cpu_eof.load(RUST_COMPONENT, RuntimeProfile::Rust);
    cpu_eof.command("spin");
    let stderr = cpu_eof.close_and_wait(true);
    assert!(stderr.is_empty());

    let mut malformed = HostProcess::spawn();
    malformed.hello();
    malformed.load(RUST_COMPONENT, RuntimeProfile::Rust);
    malformed.command("normal");
    let (frame, bytes) = malformed.receive();
    assert!(matches!(
        expect_capability(frame, &bytes).1,
        HostCallRequest::QueryTasks(_)
    ));
    malformed.write_malformed_frame();
    let stderr = malformed.close_and_wait(false);
    let stderr = String::from_utf8(stderr).unwrap();
    assert!(stderr.contains("junban-plugin-host: protocol input rejected"));
    assert!(!stderr.contains("retained hostile trap marker"));
    assert!(matches!(malformed.receive_event(), ReaderEvent::Eof));

    let mut killed = HostProcess::spawn();
    killed.hello();
    killed.load(RUST_COMPONENT, RuntimeProfile::Rust);
    killed.command("normal");
    let (frame, bytes) = killed.receive();
    assert!(matches!(
        expect_capability(frame, &bytes).1,
        HostCallRequest::QueryTasks(_)
    ));
    killed.child.kill().unwrap();
    assert!(killed.close_and_wait(false).is_empty());
    assert!(matches!(killed.receive_event(), ReaderEvent::Eof));
}

#[test]
fn forbidden_wasi_authorities_are_rejected_before_compilation_or_execution() {
    let original_fingerprint =
        inspect_component_for_runtime(RUST_COMPONENT, RuntimeProfile::Rust, &permissions())
            .unwrap()
            .import_export_fingerprint;

    for (allowed, forbidden) in [
        ("wasi:cli/stderr", "wasi:filesystem"),
        ("wasi:cli/stderr", "wasi:http/types"),
        ("wasi:cli/stderr", "wasi:random/rng"),
        ("wasi:cli/stderr", "wasi:clocks/now"),
        ("wasi:cli/environment", "wasi:sockets/network"),
    ] {
        let mut host = HostProcess::spawn();
        host.hello();
        assert_eq!(allowed.len(), forbidden.len());
        let mut component = RUST_COMPONENT.to_vec();
        let replacements =
            replace_all_equal(&mut component, allowed.as_bytes(), forbidden.as_bytes());
        assert!(replacements > 0);
        assert!(
            inspect_component_for_runtime(&component, RuntimeProfile::Rust, &permissions(),)
                .is_err(),
            "forbidden import unexpectedly passed structural admission",
        );
        let load = fence(host.next_invocation);
        host.next_invocation += 1;
        host.send(
            &ParentFrame::Load {
                fence: load.clone(),
                package_sha256: "1".repeat(64),
                component_sha256: sha256(&component),
                import_export_fingerprint: original_fingerprint.clone(),
                runtime_profile: RuntimeProfile::Rust,
                component_size: component.len() as u64,
                grants: permissions(),
                permission_hash: host.permission_hash.clone(),
                limits: RuntimeLimits::for_profile(RuntimeProfile::Rust),
            },
            &component,
        );
        expect_failure(host.receive(), load, HostFailureCode::InvalidComponent);
        assert!(host.shutdown().is_empty());
    }
}

fn replace_all_equal(bytes: &mut [u8], before: &[u8], after: &[u8]) -> usize {
    assert_eq!(before.len(), after.len());
    let mut replacements = 0;
    let mut cursor = 0;
    while let Some(offset) = bytes[cursor..]
        .windows(before.len())
        .position(|window| window == before)
    {
        let start = cursor + offset;
        bytes[start..start + after.len()].copy_from_slice(after);
        cursor = start + after.len();
        replacements += 1;
    }
    replacements
}
