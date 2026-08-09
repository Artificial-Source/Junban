use std::{
    cell::Cell,
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant, SystemTime},
};

use junban_plugin_sdk::{
    ChildFrame, HOST_FRAME_BYTES_MAX, HostCallReply, HostCallRequest, InvocationOutcome,
    InvocationRequest, ParentFrame, ParentMessage, RuntimeProfile, canonical_permission_hash,
    encode_child_frame,
    private_body_types::{NamedSetting, SettingValue, WitResult},
    read_parent_message, write_child_message, write_parent_message,
};

use super::*;

const SESSION: &str = "00000000-0000-4000-8000-000000000001";
const OTHER_SESSION: &str = "00000000-0000-4000-8000-000000000099";

fn session() -> Uuid {
    Uuid::parse_str(SESSION).unwrap()
}

fn test_deadlines() -> ProcessDeadlines {
    ProcessDeadlines {
        control: Duration::from_millis(500),
        compile_load: Duration::from_millis(500),
    }
}

fn fence(index: usize) -> AuthorityFence {
    AuthorityFence {
        plugin_id: format!("plugin-{index:02}"),
        package_generation: 7,
        activation_epoch: 9,
        host_session_id: SESSION.into(),
        invocation_id: format!("00000000-0000-4000-8000-{index:012}"),
    }
}

fn hello(session: &str) -> ChildFrame {
    ChildFrame::Hello {
        protocol_name: HOST_PROTOCOL_NAME.into(),
        protocol_version: HOST_PROTOCOL_VERSION,
        junban_version: HOST_JUNBAN_VERSION.into(),
        host_session_id: session.into(),
    }
}

fn wire(frame: &ChildFrame) -> Vec<u8> {
    encode_child_frame(frame).unwrap()
}

fn child_wire(frame: &ChildFrame, body: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::new();
    write_child_message(&mut bytes, frame, body).unwrap();
    bytes
}

fn shell_write(bytes: &[u8]) -> String {
    let escaped = bytes
        .iter()
        .map(|byte| format!("\\{:03o}", byte))
        .collect::<String>();
    format!("printf '{escaped}'\n")
}

fn parent_wire(frame: ParentFrame) -> Vec<u8> {
    parent_message_wire(&ParentMessage::new(frame, Vec::new()))
}

fn parent_message_wire(message: &ParentMessage) -> Vec<u8> {
    let mut bytes = Vec::new();
    write_parent_message(&mut bytes, &message.frame, &message.body).unwrap();
    bytes
}

#[cfg(unix)]
fn synchronized_shutdown_script(terminal: &[u8], tail: &str) -> String {
    let parent_hello = parent_wire(ParentFrame::Hello {
        protocol_name: HOST_PROTOCOL_NAME.into(),
        protocol_version: HOST_PROTOCOL_VERSION,
        junban_version: HOST_JUNBAN_VERSION.into(),
        host_session_id: SESSION.into(),
    });
    let parent_shutdown = parent_wire(ParentFrame::Shutdown {
        host_session_id: SESSION.into(),
    });
    format!(
        "{}/bin/dd if=/dev/stdin of=hello.bin bs=1 count={} 2>/dev/null\n/bin/dd if=/dev/stdin of=shutdown.bin bs=1 count={} 2>/dev/null\n{}{tail}",
        shell_write(&wire(&hello(SESSION))),
        parent_hello.len(),
        parent_shutdown.len(),
        shell_write(terminal),
    )
}

#[cfg(unix)]
fn paused_shutdown_fixture(label: &str) -> (Fixture, PathBuf, PathBuf) {
    let parent_hello = parent_wire(ParentFrame::Hello {
        protocol_name: HOST_PROTOCOL_NAME.into(),
        protocol_version: HOST_PROTOCOL_VERSION,
        junban_version: HOST_JUNBAN_VERSION.into(),
        host_session_id: SESSION.into(),
    });
    let parent_before_shutdown =
        parent_hello.len() + parent_message_wire(&load_message(0, vec![b'a'])).len();
    let parent_shutdown = parent_wire(ParentFrame::Shutdown {
        host_session_id: SESSION.into(),
    });
    let acknowledgement = wire(&ChildFrame::ShutdownComplete {
        host_session_id: SESSION.into(),
    });
    let fixture = Fixture::new(
        label,
        &format!(
            "{}/bin/dd if=/dev/stdin of=before-shutdown.bin bs=1 count={} 2>/dev/null\n/bin/dd if=/dev/stdin of=shutdown.bin bs=1 count={} 2>/dev/null\nprintf x > shutdown-entered\n/bin/dd if=shutdown-release of=/dev/null bs=1 count=1 2>/dev/null\n{}exit 0\n",
            shell_write(&loaded_output(1)),
            parent_before_shutdown,
            parent_shutdown.len(),
            shell_write(&acknowledgement),
        ),
    );
    let entered = fixture.root.join("shutdown-entered");
    let release = fixture.root.join("shutdown-release");
    for fifo in [&entered, &release] {
        assert!(Command::new("mkfifo").arg(fifo).status().unwrap().success());
    }
    (fixture, entered, release)
}

#[cfg(unix)]
fn wait_for_paused_shutdown(entered: &Path) {
    assert_eq!(fs::read(entered).unwrap(), b"x");
}

#[cfg(unix)]
fn release_paused_shutdown(release: &Path) {
    fs::write(release, b"x").unwrap();
}

#[cfg(unix)]
static PROCESS_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(unix)]
fn process_test_guard() -> std::sync::MutexGuard<'static, ()> {
    PROCESS_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(unix)]
struct Fixture {
    root: PathBuf,
    executable: PathBuf,
}

#[cfg(unix)]
impl Fixture {
    fn new(label: &str, body: &str) -> Self {
        use std::os::unix::fs::PermissionsExt;

        let root = unique_root(label);
        fs::create_dir_all(&root).unwrap();
        let executable = root.join(format!("fixture{}", std::env::consts::EXE_SUFFIX));
        fs::write(&executable, format!("#!/bin/sh\n{body}")).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        Self { root, executable }
    }

    fn capture(&self) -> PathBuf {
        self.root.join("capture.bin")
    }
}

#[cfg(unix)]
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn unique_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "junban-plugin-parent-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn load(index: usize, component: Vec<u8>) -> PluginHostLoad {
    PluginHostLoad {
        fence: fence(index),
        package_sha256: Sha256Digest::parse("1".repeat(64)).unwrap(),
        import_export_fingerprint: Sha256Digest::parse("2".repeat(64)).unwrap(),
        runtime_profile: RuntimeProfile::Typescript,
        grants: Vec::new(),
        component,
    }
}

fn load_message(index: usize, component: Vec<u8>) -> ParentMessage {
    let frame = ParentFrame::Load {
        fence: fence(index),
        package_sha256: "1".repeat(64),
        component_sha256: Sha256Digest::of(&component).into_string(),
        import_export_fingerprint: "2".repeat(64),
        runtime_profile: RuntimeProfile::Typescript,
        component_size: component.len() as u64,
        grants: Vec::new(),
        permission_hash: canonical_permission_hash(&[]).unwrap(),
        limits: RuntimeLimits::for_profile(RuntimeProfile::Typescript),
    };
    ParentMessage::new(frame, component)
}

fn invocation_fence(index: usize, invocation: usize) -> AuthorityFence {
    AuthorityFence {
        invocation_id: format!("00000000-0000-4000-8001-{invocation:012}"),
        ..fence(index)
    }
}

fn invocation_message(index: usize, invocation: usize) -> ParentMessage {
    let message = InvocationRequest::activate(None)
        .into_parent_message(
            invocation_fence(index, invocation),
            canonical_permission_hash(&[]).unwrap(),
        )
        .unwrap();
    let (frame, body) = message.into_parts();
    ParentMessage::new(frame, body)
}

fn cancel_message(index: usize, invocation: usize) -> ParentMessage {
    ParentMessage::new(
        ParentFrame::Cancel {
            fence: invocation_fence(index, invocation),
        },
        Vec::new(),
    )
}

fn large_capability_reply(invocation: usize) -> ParentMessage {
    let callback = junban_plugin_sdk::CallbackFence {
        plugin_id: fence(0).plugin_id,
        package_generation: 7,
        activation_epoch: 9,
        host_session_id: SESSION.into(),
        invocation_id: invocation_fence(0, invocation).invocation_id,
        callback_id: 1,
    };
    let reply = HostCallReply::GetSettings(WitResult::Ok(vec![NamedSetting {
        id: "large".into(),
        value: SettingValue::Text("x".repeat(2 * 1024 * 1024)),
    }]))
    .into_parent_message(callback)
    .unwrap();
    let (frame, body) = reply.into_parts();
    ParentMessage::new(frame, body)
}

fn loaded_output(count: usize) -> Vec<u8> {
    let mut output = wire(&hello(SESSION));
    for index in 0..count {
        output.extend_from_slice(&wire(&ChildFrame::Loaded {
            fence: fence(index),
            import_export_fingerprint: "2".repeat(64),
        }));
    }
    output
}

#[cfg(unix)]
fn connect_loaded_driver(
    fixture: &Fixture,
    count: usize,
) -> (PluginHostRuntimeDriverHandle, PluginHostRuntimeEvents, u32) {
    let mut process =
        PluginHostProcess::connect_for_test(&fixture.executable, session(), test_deadlines())
            .unwrap();
    for index in 0..count {
        process.load(load(index, vec![b'a' + index as u8])).unwrap();
    }
    process.finish_loading().unwrap();
    let pid = process.process_id().unwrap();
    let (driver, events) = process.into_runtime_driver().unwrap();
    (driver, events, pid)
}

fn runtime_header(
    events: &PluginHostRuntimeEvents,
) -> (ChildFrame, Option<PendingPluginHostBodyToken>) {
    match events.recv_timeout(Duration::from_secs(1)).unwrap() {
        PluginHostRuntimeEvent::Header {
            frame,
            pending_body,
        } => (frame, pending_body),
        event => panic!("expected runtime header, got {event:?}"),
    }
}

#[cfg(unix)]
fn assert_process_absent(pid: u32) {
    let status = Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert!(
        !status.success(),
        "child {pid} remained after owner teardown"
    );
}

#[test]
fn product_deadlines_and_channel_bounds_are_exact() {
    assert_eq!(PRODUCT_CONTROL_DEADLINE, Duration::from_millis(1_000));
    assert_eq!(PRODUCT_COMPILE_LOAD_DEADLINE, Duration::from_secs(10));
    assert_eq!(WRITER_CHANNEL_CAPACITY, 1);
    assert_eq!(READER_CHANNEL_CAPACITY, 1);
    assert_eq!(READER_CONTROL_CHANNEL_CAPACITY, 1);
    assert_eq!(WORKER_STATUS_CHANNEL_CAPACITY, 3);
    assert_eq!(RUNTIME_DRIVER_COMMAND_CAPACITY, 4);
    assert_eq!(RUNTIME_DRIVER_EVENT_CAPACITY, 8);
    assert_eq!(RUNTIME_DRIVER_DATA_EVENT_CAPACITY, 7);
    assert_eq!(RUNTIME_DRIVER_WAKE_CAPACITY, 1);
    assert_eq!(
        RUNTIME_DRIVER_QUEUED_BODY_BYTES_MAX,
        HOST_CALLBACK_BODY_BYTES_MAX
    );
    assert_eq!(STDERR_BUFFER_BYTES, 8 * 1024);
    assert_eq!(CHILD_STATUS_POLL_INTERVAL, Duration::from_millis(10));
}

#[test]
fn child_status_polling_rejects_expiry_and_has_a_bounded_sleeping_cadence() {
    let started = Instant::now();
    let elapsed = Cell::new(Duration::ZERO);
    let polls = Cell::new(0_u32);
    let sleeps = Cell::new(0_u32);
    let result = wait_for_child_status_until::<()>(
        started + PRODUCT_CONTROL_DEADLINE,
        || started + elapsed.get(),
        || {
            polls.set(polls.get() + 1);
            Ok(None)
        },
        |duration| {
            assert!(!duration.is_zero());
            assert!(duration <= CHILD_STATUS_POLL_INTERVAL);
            sleeps.set(sleeps.get() + 1);
            elapsed.set(elapsed.get() + duration);
        },
    )
    .unwrap();
    assert_eq!(result, None);
    assert_eq!(polls.get(), 100);
    assert_eq!(sleeps.get(), 100);

    let elapsed = Cell::new(PRODUCT_CONTROL_DEADLINE - Duration::from_nanos(1));
    let polls = Cell::new(0_u32);
    let late = wait_for_child_status_until(
        started + PRODUCT_CONTROL_DEADLINE,
        || started + elapsed.get(),
        || {
            polls.set(polls.get() + 1);
            elapsed.set(PRODUCT_CONTROL_DEADLINE);
            Ok(Some(()))
        },
        |_| unreachable!("a status was returned"),
    )
    .unwrap();
    assert_eq!(late, None);
    assert_eq!(polls.get(), 1);

    let polls = Cell::new(0_u32);
    let expired = wait_for_child_status_until::<()>(
        started + PRODUCT_CONTROL_DEADLINE,
        || started + PRODUCT_CONTROL_DEADLINE,
        || {
            polls.set(polls.get() + 1);
            Ok(Some(()))
        },
        |_| unreachable!("an expired deadline cannot sleep"),
    )
    .unwrap();
    assert_eq!(expired, None);
    assert_eq!(polls.get(), 0);
}

#[test]
fn shutdown_eof_observation_is_strictly_inside_the_control_deadline() {
    let deadline = deadline_after(Duration::from_secs(1));
    assert_eq!(
        validate_shutdown_terminal_event(
            ReaderEvent::Eof(deadline - Duration::from_nanos(1)),
            deadline,
        ),
        Ok(())
    );
    assert_eq!(
        validate_shutdown_terminal_event(ReaderEvent::Eof(deadline), deadline),
        Err(PluginHostProcessError::ControlTimeout)
    );
}

#[cfg(unix)]
#[test]
fn discovery_resolves_only_the_exact_current_executable_sibling() {
    use std::os::unix::fs::PermissionsExt;

    let root = unique_root("discovery");
    fs::create_dir_all(&root).unwrap();
    let current = root.join("junban-server");
    fs::write(&current, b"server").unwrap();
    let alternative = root.join("junban-plugin-host-alternative");
    fs::write(&alternative, b"alternative").unwrap();
    fs::set_permissions(&alternative, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(
        discover_product_executable_from(&current),
        Err(PluginHostProcessError::ExecutableMissing)
    );

    let expected = root.join(format!(
        "junban-plugin-host{}",
        std::env::consts::EXE_SUFFIX
    ));
    fs::write(&expected, b"host").unwrap();
    fs::set_permissions(&expected, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(
        discover_product_executable_from(&current).unwrap(),
        expected
    );
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn executable_validation_rejects_relative_missing_directory_symlink_and_non_executable() {
    use std::os::unix::fs::{PermissionsExt, symlink};

    assert_eq!(
        validate_explicit_executable(Path::new("relative-host")),
        Err(PluginHostProcessError::ExecutableNotAbsolute)
    );
    let root = unique_root("path-matrix");
    fs::create_dir_all(&root).unwrap();
    assert_eq!(
        validate_explicit_executable(&root.join("missing")),
        Err(PluginHostProcessError::ExecutableMissing)
    );
    assert_eq!(
        validate_explicit_executable(&root),
        Err(PluginHostProcessError::ExecutableNotRegular)
    );
    let plain = root.join("plain");
    fs::write(&plain, b"plain").unwrap();
    fs::set_permissions(&plain, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(
        validate_explicit_executable(&plain),
        Err(PluginHostProcessError::ExecutableNotExecutable)
    );
    fs::set_permissions(&plain, fs::Permissions::from_mode(0o700)).unwrap();
    let link = root.join("link");
    symlink(&plain, &link).unwrap();
    assert_eq!(
        validate_explicit_executable(&link),
        Err(PluginHostProcessError::ExecutableLinkRejected)
    );
    assert_eq!(validate_explicit_executable(&plain), Ok(()));
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn exact_hello_uses_controlled_cwd_and_drop_kills_waits_and_joins() {
    let _guard = process_test_guard();
    let cwd_capture = "cwd.txt";
    let fixture = Fixture::new(
        "hello-drop",
        &format!(
            "pwd > {cwd_capture}\n{}exec /bin/cat >/dev/null\n",
            shell_write(&wire(&hello(SESSION)))
        ),
    );
    let process =
        PluginHostProcess::connect_for_test(&fixture.executable, session(), test_deadlines())
            .unwrap();
    let pid = process.process_id().unwrap();
    assert_eq!(
        fs::read_to_string(fixture.root.join(cwd_capture))
            .unwrap()
            .trim(),
        fixture.root.display().to_string()
    );
    drop(process);
    assert_process_absent(pid);
}

#[cfg(unix)]
#[test]
fn hello_timeout_sends_only_parent_hello_then_kills_and_reaps() {
    let _guard = process_test_guard();
    let fixture = Fixture::new("hello-timeout", "exec 3>&1\nexec /bin/cat > capture.bin\n");
    let result = PluginHostProcess::connect_for_test(
        &fixture.executable,
        session(),
        ProcessDeadlines {
            control: Duration::from_millis(100),
            compile_load: Duration::from_millis(100),
        },
    );
    assert!(matches!(
        result,
        Err(PluginHostProcessError::HandshakeTimeout)
    ));
    let captured = fs::read(fixture.capture()).unwrap();
    let message = read_parent_message(&mut Cursor::new(&captured))
        .unwrap()
        .unwrap();
    assert!(matches!(message.frame, ParentFrame::Hello { .. }));
    assert!(message.body.is_empty());
    assert_eq!(
        read_parent_message(&mut Cursor::new(&captured[captured.len()..])).unwrap(),
        None
    );
}

#[cfg(unix)]
#[test]
fn wrong_hello_wrong_type_partial_oversize_and_eof_fail_closed() {
    let _guard = process_test_guard();
    let cases = [
        (
            "wrong-session",
            shell_write(&wire(&hello(OTHER_SESSION))),
            "exec /bin/sleep 30\n",
            PluginHostProcessError::ProtocolRejected,
        ),
        (
            "wrong-type",
            shell_write(&wire(&ChildFrame::ShutdownComplete {
                host_session_id: SESSION.into(),
            })),
            "exec /bin/sleep 30\n",
            PluginHostProcessError::ProtocolRejected,
        ),
        (
            "partial",
            shell_write(&[0, 0, 0]),
            "exec 1>&-\nexec /bin/sleep 30\n",
            PluginHostProcessError::ProtocolRejected,
        ),
        (
            "oversize",
            shell_write(
                &u32::try_from(HOST_FRAME_BYTES_MAX + 1)
                    .unwrap()
                    .to_be_bytes(),
            ),
            "exec /bin/sleep 30\n",
            PluginHostProcessError::ProtocolRejected,
        ),
        (
            "eof",
            String::new(),
            "exit 0\n",
            PluginHostProcessError::TransportFailed,
        ),
    ];
    for (label, output, tail, expected) in cases {
        let fixture = Fixture::new(label, &format!("{output}{tail}"));
        let result =
            PluginHostProcess::connect_for_test(&fixture.executable, session(), test_deadlines());
        assert!(
            matches!(result, Err(error) if error == expected),
            "unexpected {label} result"
        );
    }
}

#[cfg(unix)]
#[test]
fn sixteen_sequential_loads_succeed_and_seventeenth_is_rejected_before_write() {
    let _guard = process_test_guard();
    let mut output = wire(&hello(SESSION));
    for index in 0..HOST_RUNTIME_ENTRIES_MAX {
        output.extend_from_slice(&wire(&ChildFrame::Loaded {
            fence: fence(index),
            import_export_fingerprint: "2".repeat(64),
        }));
    }
    output.extend_from_slice(&wire(&ChildFrame::ShutdownComplete {
        host_session_id: SESSION.into(),
    }));
    let fixture = Fixture::new(
        "sixteen-loads",
        &format!("{}exec /bin/cat > capture.bin\n", shell_write(&output)),
    );
    let mut process =
        PluginHostProcess::connect_for_test(&fixture.executable, session(), test_deadlines())
            .unwrap();
    for index in 0..HOST_RUNTIME_ENTRIES_MAX {
        process
            .load(load(index, vec![u8::try_from(index + 1).unwrap()]))
            .unwrap();
    }
    assert_eq!(
        process.load(load(99, b"seventeenth-component".to_vec())),
        Err(PluginHostProcessError::LoadLimit)
    );
    process.shutdown().unwrap();
    process.shutdown().unwrap();

    let captured = fs::read(fixture.capture()).unwrap();
    assert!(
        !captured
            .windows(b"seventeenth-component".len())
            .any(|window| window == b"seventeenth-component")
    );
    let mut cursor = Cursor::new(captured);
    let mut messages = Vec::new();
    while let Some(message) = read_parent_message(&mut cursor).unwrap() {
        messages.push(message);
    }
    assert_eq!(messages.len(), HOST_RUNTIME_ENTRIES_MAX + 2);
    assert!(matches!(messages[0].frame, ParentFrame::Hello { .. }));
    assert!(matches!(
        messages.last().unwrap().frame,
        ParentFrame::Shutdown { .. }
    ));
}

#[cfg(unix)]
#[test]
fn load_failure_and_wrong_loaded_identity_are_session_fatal() {
    let _guard = process_test_guard();
    for (label, reply, expected) in [
        (
            "load-failed",
            ChildFrame::Failed {
                fence: fence(0),
                code: HostFailureCode::InvalidComponent,
            },
            PluginHostProcessError::LoadFailed(HostFailureCode::InvalidComponent),
        ),
        (
            "wrong-loaded",
            ChildFrame::Loaded {
                fence: fence(1),
                import_export_fingerprint: "2".repeat(64),
            },
            PluginHostProcessError::ProtocolRejected,
        ),
    ] {
        let mut output = wire(&hello(SESSION));
        output.extend_from_slice(&wire(&reply));
        let fixture = Fixture::new(
            label,
            &format!("{}exec /bin/cat >/dev/null\n", shell_write(&output)),
        );
        let mut process =
            PluginHostProcess::connect_for_test(&fixture.executable, session(), test_deadlines())
                .unwrap();
        let pid = process.process_id().unwrap();
        assert_eq!(process.load(load(0, b"component".to_vec())), Err(expected));
        assert_process_absent(pid);
    }
}

#[cfg(unix)]
#[test]
fn compile_timeout_starts_before_load_bytes_and_kills_without_a_correctness_sleep() {
    let _guard = process_test_guard();
    let fixture = Fixture::new(
        "compile-timeout",
        &format!(
            "{}exec 3>&1\nexec /bin/cat > capture.bin\n",
            shell_write(&wire(&hello(SESSION)))
        ),
    );
    let mut process = PluginHostProcess::connect_for_test(
        &fixture.executable,
        session(),
        ProcessDeadlines {
            control: Duration::from_millis(500),
            compile_load: Duration::from_millis(75),
        },
    )
    .unwrap();
    let pid = process.process_id().unwrap();
    let started = Instant::now();
    assert_eq!(
        process.load(load(0, b"compile-timeout-component".to_vec())),
        Err(PluginHostProcessError::CompileLoadTimeout)
    );
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_process_absent(pid);
    let captured = fs::read(fixture.capture()).unwrap();
    assert!(
        captured
            .windows(b"compile-timeout-component".len())
            .any(|window| window == b"compile-timeout-component")
    );
}

#[cfg(unix)]
#[test]
fn runtime_header_is_authorized_before_partial_or_stale_body_allocation() {
    let _guard = process_test_guard();
    let loaded = ChildFrame::Loaded {
        fence: fence(0),
        import_export_fingerprint: "2".repeat(64),
    };
    let callback = junban_plugin_sdk::CallbackFence {
        plugin_id: fence(0).plugin_id,
        package_generation: 7,
        activation_epoch: 9,
        host_session_id: SESSION.into(),
        invocation_id: "00000000-0000-4000-8000-000000000500".into(),
        callback_id: 1,
    };
    let request = ChildFrame::CapabilityRequest {
        callback,
        kind: junban_plugin_sdk::HostCallKind::GetSettings,
        request_sha256: Sha256Digest::of(b"abc").into_string(),
        request_size: 3,
    };
    let mut output = wire(&hello(SESSION));
    output.extend_from_slice(&wire(&loaded));
    output.extend_from_slice(&wire(&request));
    let fixture = Fixture::new(
        "partial-body",
        &format!("{}printf 'a'\nexec /bin/sleep 30\n", shell_write(&output)),
    );
    let mut process = PluginHostProcess::connect_for_test(
        &fixture.executable,
        session(),
        ProcessDeadlines {
            control: Duration::from_millis(100),
            compile_load: Duration::from_millis(500),
        },
    )
    .unwrap();
    process.load(load(0, b"component".to_vec())).unwrap();
    process.finish_loading().unwrap();
    let header = process
        .receive_header(deadline_after(Duration::from_millis(100)))
        .unwrap();
    assert_eq!(header, request);
    assert_eq!(
        process.receive_body(&header, deadline_after(Duration::from_millis(100))),
        Err(PluginHostProcessError::ControlTimeout)
    );
}

#[cfg(unix)]
#[test]
fn malformed_body_wrong_runtime_session_and_extra_hello_are_fatal() {
    let _guard = process_test_guard();
    let loaded = ChildFrame::Loaded {
        fence: fence(0),
        import_export_fingerprint: "2".repeat(64),
    };
    let stale_callback = junban_plugin_sdk::CallbackFence {
        plugin_id: fence(0).plugin_id,
        package_generation: 7,
        activation_epoch: 9,
        host_session_id: OTHER_SESSION.into(),
        invocation_id: "00000000-0000-4000-8000-000000000501".into(),
        callback_id: 1,
    };
    let stale = ChildFrame::CapabilityRequest {
        callback: stale_callback,
        kind: junban_plugin_sdk::HostCallKind::GetSettings,
        request_sha256: Sha256Digest::of(b"abc").into_string(),
        request_size: 3,
    };
    for (label, frame, body, body_error) in [
        (
            "malformed-body",
            {
                let mut callback =
                    if let ChildFrame::CapabilityRequest { callback, .. } = stale.clone() {
                        callback
                    } else {
                        unreachable!()
                    };
                callback.host_session_id = SESSION.into();
                ChildFrame::CapabilityRequest {
                    callback,
                    kind: junban_plugin_sdk::HostCallKind::GetSettings,
                    request_sha256: Sha256Digest::of(b"abc").into_string(),
                    request_size: 3,
                }
            },
            b"bad".as_slice(),
            true,
        ),
        ("stale-session", stale, b"".as_slice(), false),
        ("extra-hello", hello(SESSION), b"".as_slice(), false),
    ] {
        let mut output = wire(&hello(SESSION));
        output.extend_from_slice(&wire(&loaded));
        output.extend_from_slice(&wire(&frame));
        output.extend_from_slice(body);
        let fixture = Fixture::new(
            label,
            &format!("{}exec /bin/sleep 30\n", shell_write(&output)),
        );
        let mut process =
            PluginHostProcess::connect_for_test(&fixture.executable, session(), test_deadlines())
                .unwrap();
        process.load(load(0, b"component".to_vec())).unwrap();
        process.finish_loading().unwrap();
        let received = process.receive_header(deadline_after(Duration::from_millis(200)));
        if body_error {
            let header = received.unwrap();
            assert_eq!(
                process.receive_body(&header, deadline_after(Duration::from_millis(200))),
                Err(PluginHostProcessError::ProtocolRejected)
            );
        } else {
            assert_eq!(received, Err(PluginHostProcessError::ProtocolRejected));
        }
    }
}

#[cfg(unix)]
#[test]
fn shutdown_accepts_only_timely_ack_exit_and_clean_reader_eof() {
    let _guard = process_test_guard();
    let acknowledgement = wire(&ChildFrame::ShutdownComplete {
        host_session_id: SESSION.into(),
    });
    let fixture = Fixture::new(
        "shutdown-clean-eof",
        &synchronized_shutdown_script(&acknowledgement, "exit 0\n"),
    );
    let mut process =
        PluginHostProcess::connect_for_test(&fixture.executable, session(), test_deadlines())
            .unwrap();
    process.finish_loading().unwrap();
    let pid = process.process_id().unwrap();
    process.shutdown().unwrap();
    process.shutdown().unwrap();
    assert_process_absent(pid);

    let mut hello_capture = Cursor::new(fs::read(fixture.root.join("hello.bin")).unwrap());
    assert!(matches!(
        read_parent_message(&mut hello_capture)
            .unwrap()
            .unwrap()
            .frame,
        ParentFrame::Hello { .. }
    ));
    assert_eq!(read_parent_message(&mut hello_capture).unwrap(), None);
    let mut shutdown_capture = Cursor::new(fs::read(fixture.root.join("shutdown.bin")).unwrap());
    assert!(matches!(
        read_parent_message(&mut shutdown_capture)
            .unwrap()
            .unwrap()
            .frame,
        ParentFrame::Shutdown { .. }
    ));
    assert_eq!(read_parent_message(&mut shutdown_capture).unwrap(), None);
}

#[cfg(unix)]
#[test]
fn shutdown_timeout_after_ack_kills_reaps_and_closes_repeatedly() {
    let _guard = process_test_guard();
    let acknowledgement = wire(&ChildFrame::ShutdownComplete {
        host_session_id: SESSION.into(),
    });
    let fixture = Fixture::new(
        "shutdown-late-exit",
        &synchronized_shutdown_script(&acknowledgement, "exec /bin/sleep 30\n"),
    );
    let mut process = PluginHostProcess::connect_for_test(
        &fixture.executable,
        session(),
        ProcessDeadlines {
            control: Duration::from_millis(250),
            compile_load: Duration::from_millis(500),
        },
    )
    .unwrap();
    process.finish_loading().unwrap();
    let pid = process.process_id().unwrap();
    assert_eq!(
        process.shutdown(),
        Err(PluginHostProcessError::ControlTimeout)
    );
    assert_process_absent(pid);
    process.shutdown().unwrap();
}

#[cfg(unix)]
#[test]
fn shutdown_rejects_every_post_ack_protocol_byte_and_reaps() {
    let _guard = process_test_guard();
    let acknowledgement = ChildFrame::ShutdownComplete {
        host_session_id: SESSION.into(),
    };
    let mut duplicate = wire(&acknowledgement);
    duplicate.extend_from_slice(&wire(&acknowledgement));

    let callback = junban_plugin_sdk::CallbackFence {
        plugin_id: "plugin-00".into(),
        package_generation: 7,
        activation_epoch: 9,
        host_session_id: SESSION.into(),
        invocation_id: "00000000-0000-4000-8000-000000000500".into(),
        callback_id: 1,
    };
    let extra_body_header = ChildFrame::CapabilityRequest {
        callback,
        kind: junban_plugin_sdk::HostCallKind::GetSettings,
        request_sha256: Sha256Digest::of(b"abc").into_string(),
        request_size: 3,
    };
    let mut header_and_body = wire(&acknowledgement);
    header_and_body.extend_from_slice(&wire(&extra_body_header));
    header_and_body.extend_from_slice(b"abc");

    let mut malformed = wire(&acknowledgement);
    malformed.extend_from_slice(&[0, 0, 0, 1, b'{']);
    let mut truncated = wire(&acknowledgement);
    truncated.extend_from_slice(&[0, 0, 0]);
    let mut oversized = wire(&acknowledgement);
    oversized.extend_from_slice(
        &u32::try_from(HOST_FRAME_BYTES_MAX + 1)
            .unwrap()
            .to_be_bytes(),
    );

    for (label, terminal) in [
        ("shutdown-duplicate-ack", duplicate),
        ("shutdown-extra-header-body", header_and_body),
        ("shutdown-malformed", malformed),
        ("shutdown-truncated", truncated),
        ("shutdown-oversized", oversized),
    ] {
        let fixture = Fixture::new(label, &synchronized_shutdown_script(&terminal, "exit 0\n"));
        let mut process =
            PluginHostProcess::connect_for_test(&fixture.executable, session(), test_deadlines())
                .unwrap();
        process.finish_loading().unwrap();
        let pid = process.process_id().unwrap();
        assert_eq!(
            process.shutdown(),
            Err(PluginHostProcessError::ProtocolRejected),
            "unexpected {label} result"
        );
        assert_process_absent(pid);
        process.shutdown().unwrap();
    }
}

#[cfg(unix)]
#[test]
fn raw_stderr_flood_is_drained_boundedly_and_never_enters_errors() {
    let _guard = process_test_guard();
    let mut output = wire(&hello(SESSION));
    output.extend_from_slice(&wire(&ChildFrame::ShutdownComplete {
        host_session_id: SESSION.into(),
    }));
    let fixture = Fixture::new(
        "stderr-flood",
        &format!(
            "{}i=0\nwhile [ \"$i\" -lt 4096 ]; do printf 'untrusted-stderr-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' >&2; i=$((i + 1)); done\nexec /bin/cat >/dev/null\n",
            shell_write(&output)
        ),
    );
    let mut process = PluginHostProcess::connect_for_test(
        &fixture.executable,
        session(),
        ProcessDeadlines {
            control: PRODUCT_CONTROL_DEADLINE,
            compile_load: Duration::from_millis(500),
        },
    )
    .unwrap();
    process.finish_loading().unwrap();
    process.shutdown().unwrap();
    process.shutdown().unwrap();
}

// Runtime-driver adaptation coverage exercises process transport and cleanup
// only; it neither implements supervisor admission nor interprets outcomes.

#[cfg(unix)]
#[test]
fn runtime_driver_success_terminal_is_reserved_for_graceful_shutdown() {
    let _guard = process_test_guard();
    let acknowledgement = wire(&ChildFrame::ShutdownComplete {
        host_session_id: SESSION.into(),
    });
    let fixture = Fixture::new(
        "driver-graceful-shutdown",
        &synchronized_shutdown_script(&acknowledgement, "exit 0\n"),
    );
    let (driver, events, pid) = connect_loaded_driver(&fixture, 0);
    let shared = driver.shared.clone();
    driver.shutdown().unwrap();
    assert_eq!(
        events.recv_timeout(Duration::from_secs(1)).unwrap(),
        PluginHostRuntimeEvent::Closed(Ok(()))
    );
    driver.fatal_close().unwrap();
    assert_eq!(
        shared.terminal_state(),
        RuntimeDriverTerminalState::GracefulCommitted
    );
    assert_eq!(
        events.recv_timeout(Duration::from_secs(1)),
        Err(mpsc::RecvTimeoutError::Disconnected)
    );
    assert_process_absent(pid);
}

#[cfg(unix)]
#[test]
fn runtime_driver_fatal_wins_paused_graceful_and_closes_late_admission() {
    let _guard = process_test_guard();
    let (fixture, entered, release) = paused_shutdown_fixture("driver-shutdown-fatal-race");
    let (driver, events, pid) = connect_loaded_driver(&fixture, 1);
    let shared = driver.shared.clone();

    driver.shutdown().unwrap();
    wait_for_paused_shutdown(&entered);
    let late_send = driver.send(
        large_capability_reply(940),
        deadline_after(Duration::from_secs(1)),
    );
    let late_body = driver.authorize_body(
        PendingPluginHostBodyToken(1),
        deadline_after(Duration::from_secs(1)),
    );
    let late_shutdown = driver.shutdown();
    driver.fatal_close().unwrap();
    driver.fatal_close().unwrap();
    release_paused_shutdown(&release);

    assert_eq!(late_send, Err(PluginHostProcessError::Closed));
    assert_eq!(late_body, Err(PluginHostProcessError::Closed));
    assert_eq!(late_shutdown, Err(PluginHostProcessError::Closed));
    assert_eq!(
        events.recv_timeout(Duration::from_secs(1)).unwrap(),
        PluginHostRuntimeEvent::Closed(Err(PluginHostProcessError::ForcedClosed))
    );
    assert_eq!(shared.queued_body_bytes.load(Ordering::Acquire), 0);
    assert_process_absent(pid);
}

#[cfg(unix)]
#[test]
fn runtime_driver_handle_drop_wins_paused_graceful_shutdown() {
    let _guard = process_test_guard();
    let (fixture, entered, release) = paused_shutdown_fixture("driver-shutdown-handle-drop-race");
    let (driver, events, pid) = connect_loaded_driver(&fixture, 1);
    let shared = driver.shared.clone();

    driver.shutdown().unwrap();
    wait_for_paused_shutdown(&entered);
    drop(driver);
    release_paused_shutdown(&release);

    assert_eq!(
        events.recv_timeout(Duration::from_secs(1)).unwrap(),
        PluginHostRuntimeEvent::Closed(Err(PluginHostProcessError::ForcedClosed))
    );
    assert_eq!(shared.queued_body_bytes.load(Ordering::Acquire), 0);
    assert_process_absent(pid);
}

#[cfg(unix)]
#[test]
fn runtime_driver_protocol_violation_wins_paused_graceful_shutdown() {
    let _guard = process_test_guard();
    let (fixture, entered, release) = paused_shutdown_fixture("driver-shutdown-protocol-race");
    let (driver, events, pid) = connect_loaded_driver(&fixture, 1);
    let shared = driver.shared.clone();

    driver.shutdown().unwrap();
    wait_for_paused_shutdown(&entered);
    let violation = driver.send(
        ParentMessage::new(
            ParentFrame::Hello {
                protocol_name: HOST_PROTOCOL_NAME.into(),
                protocol_version: HOST_PROTOCOL_VERSION,
                junban_version: HOST_JUNBAN_VERSION.into(),
                host_session_id: SESSION.into(),
            },
            Vec::new(),
        ),
        deadline_after(Duration::from_secs(1)),
    );
    release_paused_shutdown(&release);

    assert_eq!(violation, Err(PluginHostProcessError::ProtocolRejected));
    assert_eq!(
        events.recv_timeout(Duration::from_secs(1)).unwrap(),
        PluginHostRuntimeEvent::Closed(Err(PluginHostProcessError::ProtocolRejected))
    );
    assert_eq!(shared.queued_body_bytes.load(Ordering::Acquire), 0);
    assert_process_absent(pid);
}

#[cfg(unix)]
#[test]
fn runtime_driver_pressure_wins_paused_graceful_shutdown() {
    let _guard = process_test_guard();
    let (fixture, entered, release) = paused_shutdown_fixture("driver-shutdown-pressure-race");
    let (driver, events, pid) = connect_loaded_driver(&fixture, 1);
    let shared = driver.shared.clone();

    driver.shutdown().unwrap();
    wait_for_paused_shutdown(&entered);
    shared.force_terminal(RuntimeDriverTerminalState::ForcedPressure);
    signal_driver(&driver.wake);
    release_paused_shutdown(&release);

    assert_eq!(
        events.recv_timeout(Duration::from_secs(1)).unwrap(),
        PluginHostRuntimeEvent::Closed(Err(PluginHostProcessError::Backpressure))
    );
    assert_eq!(shared.queued_body_bytes.load(Ordering::Acquire), 0);
    assert_process_absent(pid);
}

#[cfg(unix)]
#[test]
fn runtime_driver_event_drop_wins_paused_graceful_without_an_orphan() {
    let _guard = process_test_guard();
    let (fixture, entered, release) = paused_shutdown_fixture("driver-shutdown-event-drop-race");
    let (driver, events, pid) = connect_loaded_driver(&fixture, 1);
    let shared = events.shared.clone();

    driver.shutdown().unwrap();
    wait_for_paused_shutdown(&entered);
    let dropper = std::thread::spawn(move || drop(events));
    release_paused_shutdown(&release);
    dropper.join().unwrap();

    assert_eq!(
        shared.terminal_state(),
        RuntimeDriverTerminalState::ForcedClosed
    );
    assert_eq!(shared.queued_body_bytes.load(Ordering::Acquire), 0);
    assert_process_absent(pid);
    driver.fatal_close().unwrap();
}

#[cfg(unix)]
#[test]
fn runtime_driver_wakes_for_four_sends_and_preserves_interleaved_typed_events() {
    let _guard = process_test_guard();
    let invocation_fences = [
        invocation_fence(0, 100),
        invocation_fence(1, 101),
        invocation_fence(2, 102),
        invocation_fence(3, 103),
    ];
    let cancelled = ChildFrame::Cancelled {
        fence: invocation_fences[0].clone(),
    };
    let outcome = InvocationOutcome::Activate(WitResult::Ok(()))
        .into_child_message(invocation_fences[1].clone())
        .unwrap();
    let (outcome_frame, outcome_body) = outcome.into_parts();
    let callback_fence = junban_plugin_sdk::CallbackFence {
        plugin_id: invocation_fences[2].plugin_id.clone(),
        package_generation: invocation_fences[2].package_generation,
        activation_epoch: invocation_fences[2].activation_epoch,
        host_session_id: invocation_fences[2].host_session_id.clone(),
        invocation_id: invocation_fences[2].invocation_id.clone(),
        callback_id: 1,
    };
    let callback = HostCallRequest::MonotonicMs(())
        .into_child_message(callback_fence)
        .unwrap();
    let (callback_frame, callback_body) = callback.into_parts();
    let failed = ChildFrame::Failed {
        fence: invocation_fences[3].clone(),
        code: HostFailureCode::GuestError,
    };

    let mut output = loaded_output(4);
    output.extend_from_slice(&wire(&cancelled));
    output.extend_from_slice(&child_wire(&outcome_frame, &outcome_body));
    output.extend_from_slice(&child_wire(&callback_frame, &callback_body));
    output.extend_from_slice(&wire(&failed));
    let invocation_messages = [100, 101, 102, 103]
        .into_iter()
        .enumerate()
        .map(|(index, invocation)| invocation_message(index, invocation))
        .collect::<Vec<_>>();
    let parent_bytes = parent_wire(ParentFrame::Hello {
        protocol_name: HOST_PROTOCOL_NAME.into(),
        protocol_version: HOST_PROTOCOL_VERSION,
        junban_version: HOST_JUNBAN_VERSION.into(),
        host_session_id: SESSION.into(),
    })
    .len()
        + (0..4)
            .map(|index| parent_message_wire(&load_message(index, vec![b'a' + index as u8])).len())
            .sum::<usize>()
        + invocation_messages
            .iter()
            .map(|message| parent_message_wire(message).len())
            .sum::<usize>()
        + parent_wire(ParentFrame::Shutdown {
            host_session_id: SESSION.into(),
        })
        .len();
    let shutdown = wire(&ChildFrame::ShutdownComplete {
        host_session_id: SESSION.into(),
    });
    let fixture = Fixture::new(
        "driver-four-interleaved",
        &format!(
            "{}/bin/dd if=/dev/stdin of=capture.bin bs=1 count={} 2>/dev/null\n{}exit 0\n",
            shell_write(&output),
            parent_bytes,
            shell_write(&shutdown),
        ),
    );
    let (driver, events, pid) = connect_loaded_driver(&fixture, 4);

    let started = Instant::now();
    for message in invocation_messages {
        driver
            .send(message, deadline_after(Duration::from_secs(1)))
            .unwrap();
    }

    let (frame, token) = runtime_header(&events);
    assert_eq!(frame, cancelled);
    assert!(token.is_none());

    let (frame, token) = runtime_header(&events);
    assert_eq!(frame, outcome_frame);
    driver
        .authorize_body(
            token.expect("outcome body token"),
            deadline_after(Duration::from_secs(1)),
        )
        .unwrap();
    assert_eq!(
        events.recv_timeout(Duration::from_secs(1)).unwrap(),
        PluginHostRuntimeEvent::Body {
            frame: outcome_frame,
            body: outcome_body,
        }
    );

    let (frame, token) = runtime_header(&events);
    assert_eq!(frame, callback_frame);
    driver
        .authorize_body(
            token.expect("callback body token"),
            deadline_after(Duration::from_secs(1)),
        )
        .unwrap();
    assert_eq!(
        events.recv_timeout(Duration::from_secs(1)).unwrap(),
        PluginHostRuntimeEvent::Body {
            frame: callback_frame,
            body: callback_body,
        }
    );

    let (frame, token) = runtime_header(&events);
    assert_eq!(frame, failed);
    assert!(token.is_none());
    assert!(started.elapsed() < Duration::from_secs(1));

    driver.shutdown().unwrap();
    assert_eq!(
        events.recv_timeout(Duration::from_secs(1)).unwrap(),
        PluginHostRuntimeEvent::Closed(Ok(()))
    );
    assert_process_absent(pid);

    let mut cursor = Cursor::new(fs::read(fixture.capture()).unwrap());
    let mut invokes = Vec::new();
    while let Some(message) = read_parent_message(&mut cursor).unwrap() {
        if let ParentFrame::Invoke { fence, .. } = message.frame {
            invokes.push(fence.invocation_id);
        }
    }
    assert_eq!(
        invokes,
        invocation_fences
            .iter()
            .map(|fence| fence.invocation_id.clone())
            .collect::<Vec<_>>()
    );
}

#[cfg(unix)]
#[test]
fn runtime_driver_stages_body_and_sends_while_unread_and_stalled() {
    let _guard = process_test_guard();
    let callback_fence = junban_plugin_sdk::CallbackFence {
        plugin_id: fence(0).plugin_id,
        package_generation: 7,
        activation_epoch: 9,
        host_session_id: SESSION.into(),
        invocation_id: invocation_fence(0, 700).invocation_id,
        callback_id: 1,
    };
    let callback = HostCallRequest::MonotonicMs(())
        .into_child_message(callback_fence)
        .unwrap();
    let (callback_frame, callback_body) = callback.into_parts();
    assert!(callback_body.len() > 1);

    let invoke = invocation_message(0, 701);
    let cancel = cancel_message(0, 702);
    let parent_bytes = parent_wire(ParentFrame::Hello {
        protocol_name: HOST_PROTOCOL_NAME.into(),
        protocol_version: HOST_PROTOCOL_VERSION,
        junban_version: HOST_JUNBAN_VERSION.into(),
        host_session_id: SESSION.into(),
    })
    .len()
        + parent_message_wire(&load_message(0, vec![b'a'])).len()
        + parent_message_wire(&invoke).len()
        + parent_message_wire(&cancel).len();

    let mut headers = loaded_output(1);
    headers.extend_from_slice(&wire(&callback_frame));
    let fixture = Fixture::new(
        "driver-staged-stall",
        &format!(
            "{}{}/bin/dd if=/dev/stdin of=capture.bin bs=1 count={} 2>/dev/null\n{}exec /bin/sleep 30\n",
            shell_write(&headers),
            shell_write(&callback_body[..1]),
            parent_bytes,
            shell_write(&callback_body[1..]),
        ),
    );
    let (driver, events, pid) = connect_loaded_driver(&fixture, 1);
    let (frame, token) = runtime_header(&events);
    assert_eq!(frame, callback_frame);

    // Command order is deterministic: the invocation is written while the
    // body is unauthorized, then authorization starts the blocked read, and
    // the cancel write lets the fixture release the remaining body bytes.
    driver
        .send(invoke, deadline_after(Duration::from_secs(1)))
        .unwrap();
    driver
        .authorize_body(
            token.expect("callback body token"),
            deadline_after(Duration::from_secs(1)),
        )
        .unwrap();
    driver
        .send(cancel, deadline_after(Duration::from_secs(1)))
        .unwrap();
    assert_eq!(
        events.recv_timeout(Duration::from_secs(1)).unwrap(),
        PluginHostRuntimeEvent::Body {
            frame: callback_frame,
            body: callback_body,
        }
    );

    driver.fatal_close().unwrap();
    driver.fatal_close().unwrap();
    assert_eq!(
        events.recv_timeout(Duration::from_secs(1)).unwrap(),
        PluginHostRuntimeEvent::Closed(Err(PluginHostProcessError::ForcedClosed))
    );
    assert_process_absent(pid);

    let mut cursor = Cursor::new(fs::read(fixture.capture()).unwrap());
    let mut runtime_frames = Vec::new();
    while let Some(message) = read_parent_message(&mut cursor).unwrap() {
        if matches!(
            message.frame,
            ParentFrame::Invoke { .. } | ParentFrame::Cancel { .. }
        ) {
            runtime_frames.push(message.frame);
        }
    }
    assert!(matches!(runtime_frames[0], ParentFrame::Invoke { .. }));
    assert!(matches!(runtime_frames[1], ParentFrame::Cancel { .. }));
}

#[cfg(unix)]
#[test]
fn runtime_driver_wrong_duplicate_and_stale_body_tokens_fail_closed() {
    let _guard = process_test_guard();
    for (label, duplicate) in [
        ("driver-wrong-token", false),
        ("driver-duplicate-token", true),
    ] {
        let callback_fence = junban_plugin_sdk::CallbackFence {
            plugin_id: fence(0).plugin_id,
            package_generation: 7,
            activation_epoch: 9,
            host_session_id: SESSION.into(),
            invocation_id: invocation_fence(0, 710).invocation_id,
            callback_id: 1,
        };
        let callback = HostCallRequest::MonotonicMs(())
            .into_child_message(callback_fence)
            .unwrap();
        let (callback_frame, callback_body) = callback.into_parts();
        let mut output = loaded_output(1);
        output.extend_from_slice(&child_wire(&callback_frame, &callback_body));
        let fixture = Fixture::new(
            label,
            &format!("{}exec /bin/sleep 30\n", shell_write(&output)),
        );
        let (driver, events, pid) = connect_loaded_driver(&fixture, 1);
        let (_, token) = runtime_header(&events);
        let token = token.expect("callback body token");
        let repeated = PendingPluginHostBodyToken(token.0);
        if duplicate {
            driver
                .authorize_body(token, deadline_after(Duration::from_secs(1)))
                .unwrap();
            assert!(matches!(
                events.recv_timeout(Duration::from_secs(1)).unwrap(),
                PluginHostRuntimeEvent::Body { .. }
            ));
            driver
                .authorize_body(repeated, deadline_after(Duration::from_secs(1)))
                .unwrap();
        } else {
            driver
                .authorize_body(
                    PendingPluginHostBodyToken(token.0 + 1),
                    deadline_after(Duration::from_secs(1)),
                )
                .unwrap();
        }
        assert_eq!(
            events.recv_timeout(Duration::from_secs(1)).unwrap(),
            PluginHostRuntimeEvent::Closed(Err(PluginHostProcessError::ProtocolRejected)),
            "unexpected {label} terminal"
        );
        assert_process_absent(pid);
    }
}

#[cfg(unix)]
#[test]
fn runtime_driver_rejects_stale_session_and_nonruntime_type_before_publication() {
    let _guard = process_test_guard();
    let stale = ChildFrame::Cancelled {
        fence: AuthorityFence {
            host_session_id: OTHER_SESSION.into(),
            ..invocation_fence(0, 720)
        },
    };
    for (label, frame) in [
        ("driver-stale-session", stale),
        ("driver-extra-hello", hello(SESSION)),
    ] {
        let mut output = loaded_output(1);
        output.extend_from_slice(&wire(&frame));
        let fixture = Fixture::new(
            label,
            &format!("{}exec /bin/sleep 30\n", shell_write(&output)),
        );
        let (_driver, events, pid) = connect_loaded_driver(&fixture, 1);
        assert_eq!(
            events.recv_timeout(Duration::from_secs(1)).unwrap(),
            PluginHostRuntimeEvent::Closed(Err(PluginHostProcessError::ProtocolRejected))
        );
        assert_process_absent(pid);
    }
}

#[cfg(unix)]
#[test]
fn runtime_driver_event_pressure_reserves_one_post_reap_terminal_slot() {
    let _guard = process_test_guard();
    let mut output = loaded_output(1);
    for invocation in 800..800 + RUNTIME_DRIVER_EVENT_CAPACITY {
        output.extend_from_slice(&wire(&ChildFrame::Cancelled {
            fence: invocation_fence(0, invocation),
        }));
    }
    let fixture = Fixture::new(
        "driver-event-pressure",
        &format!("{}exec /bin/sleep 30\n", shell_write(&output)),
    );
    let (_driver, mut events, pid) = connect_loaded_driver(&fixture, 1);
    events.driver_handle.take().unwrap().join().unwrap();

    for _ in 0..RUNTIME_DRIVER_DATA_EVENT_CAPACITY {
        assert!(matches!(
            events.recv_timeout(Duration::from_secs(1)).unwrap(),
            PluginHostRuntimeEvent::Header {
                pending_body: None,
                ..
            }
        ));
    }
    assert_eq!(
        events.recv_timeout(Duration::from_secs(1)).unwrap(),
        PluginHostRuntimeEvent::Closed(Err(PluginHostProcessError::Backpressure))
    );
    assert_process_absent(pid);
}

#[cfg(unix)]
#[test]
fn runtime_driver_command_disconnect_fatal_repeat_and_event_drop_never_orphan() {
    let _guard = process_test_guard();
    let fixture = Fixture::new(
        "driver-command-disconnect",
        &format!(
            "{}exec /bin/sleep 30\n",
            shell_write(&wire(&hello(SESSION)))
        ),
    );
    let (driver, events, pid) = connect_loaded_driver(&fixture, 0);
    drop(driver);
    assert_eq!(
        events.recv_timeout(Duration::from_secs(1)).unwrap(),
        PluginHostRuntimeEvent::Closed(Err(PluginHostProcessError::ForcedClosed))
    );
    assert_eq!(
        events.recv_timeout(Duration::from_secs(1)),
        Err(mpsc::RecvTimeoutError::Disconnected)
    );
    assert_process_absent(pid);

    let fixture = Fixture::new(
        "driver-event-drop",
        &format!(
            "{}exec /bin/sleep 30\n",
            shell_write(&wire(&hello(SESSION)))
        ),
    );
    let (driver, events, pid) = connect_loaded_driver(&fixture, 0);
    drop(events);
    assert_process_absent(pid);
    driver.fatal_close().unwrap();
}

#[cfg(unix)]
#[test]
fn runtime_driver_writer_reader_driver_panic_and_reader_loss_reap() {
    let _guard = process_test_guard();
    for (label, panic_kind, expected) in [
        (
            "driver-panic",
            "driver",
            PluginHostProcessError::WorkerFailed,
        ),
        (
            "driver-writer-panic",
            "writer",
            PluginHostProcessError::CleanupFailed,
        ),
    ] {
        let fixture = Fixture::new(
            label,
            &format!(
                "{}exec /bin/sleep 30\n",
                shell_write(&wire(&hello(SESSION)))
            ),
        );
        let (driver, events, pid) = connect_loaded_driver(&fixture, 0);
        match panic_kind {
            "driver" => driver.panic_driver_for_test().unwrap(),
            "writer" => driver.panic_writer_for_test().unwrap(),
            _ => unreachable!(),
        }
        assert_eq!(
            events.recv_timeout(Duration::from_secs(1)).unwrap(),
            PluginHostRuntimeEvent::Closed(Err(expected)),
            "unexpected {label} terminal"
        );
        assert_process_absent(pid);
    }

    let callback_fence = junban_plugin_sdk::CallbackFence {
        plugin_id: fence(0).plugin_id,
        package_generation: 7,
        activation_epoch: 9,
        host_session_id: SESSION.into(),
        invocation_id: invocation_fence(0, 900).invocation_id,
        callback_id: 1,
    };
    let callback = HostCallRequest::MonotonicMs(())
        .into_child_message(callback_fence)
        .unwrap();
    let (callback_frame, _) = callback.into_parts();
    let mut output = loaded_output(1);
    output.extend_from_slice(&wire(&callback_frame));
    let fixture = Fixture::new(
        "driver-reader-panic",
        &format!("{}exec /bin/sleep 30\n", shell_write(&output)),
    );
    let (driver, events, pid) = connect_loaded_driver(&fixture, 1);
    let _ = runtime_header(&events);
    driver.panic_reader_for_test().unwrap();
    assert_eq!(
        events.recv_timeout(Duration::from_secs(1)).unwrap(),
        PluginHostRuntimeEvent::Closed(Err(PluginHostProcessError::CleanupFailed))
    );
    assert_process_absent(pid);

    let fixture = Fixture::new(
        "driver-reader-loss",
        &format!("{}exit 0\n", shell_write(&wire(&hello(SESSION)))),
    );
    let (_driver, events, pid) = connect_loaded_driver(&fixture, 0);
    assert!(matches!(
        events.recv_timeout(Duration::from_secs(1)).unwrap(),
        PluginHostRuntimeEvent::Closed(Err(
            PluginHostProcessError::TransportFailed | PluginHostProcessError::WorkerFailed
        ))
    ));
    assert_process_absent(pid);
}

#[cfg(unix)]
#[test]
fn runtime_driver_body_timeout_and_body_validation_are_fatal_before_publication() {
    let _guard = process_test_guard();
    for (label, body_mode, expected) in [
        (
            "driver-body-timeout",
            "partial",
            PluginHostProcessError::ControlTimeout,
        ),
        (
            "driver-body-hash",
            "tampered",
            PluginHostProcessError::ProtocolRejected,
        ),
    ] {
        let callback_fence = junban_plugin_sdk::CallbackFence {
            plugin_id: fence(0).plugin_id,
            package_generation: 7,
            activation_epoch: 9,
            host_session_id: SESSION.into(),
            invocation_id: invocation_fence(0, 910).invocation_id,
            callback_id: 1,
        };
        let callback = HostCallRequest::MonotonicMs(())
            .into_child_message(callback_fence)
            .unwrap();
        let (callback_frame, mut callback_body) = callback.into_parts();
        let mut output = loaded_output(1);
        output.extend_from_slice(&wire(&callback_frame));
        if body_mode == "partial" {
            output.extend_from_slice(&callback_body[..1]);
        } else {
            callback_body[0] ^= 1;
            output.extend_from_slice(&callback_body);
        }
        let fixture = Fixture::new(
            label,
            &format!("{}exec /bin/sleep 30\n", shell_write(&output)),
        );
        let (driver, events, pid) = connect_loaded_driver(&fixture, 1);
        let (_, token) = runtime_header(&events);
        driver
            .authorize_body(
                token.expect("callback body token"),
                deadline_after(Duration::from_millis(50)),
            )
            .unwrap();
        assert_eq!(
            events.recv_timeout(Duration::from_secs(1)).unwrap(),
            PluginHostRuntimeEvent::Closed(Err(expected)),
            "unexpected {label} terminal"
        );
        assert_process_absent(pid);
    }
}

#[cfg(unix)]
#[test]
fn runtime_driver_explicit_fatal_during_blocked_body_and_writer_is_non_graceful() {
    let _guard = process_test_guard();

    let callback_fence = junban_plugin_sdk::CallbackFence {
        plugin_id: fence(0).plugin_id,
        package_generation: 7,
        activation_epoch: 9,
        host_session_id: SESSION.into(),
        invocation_id: invocation_fence(0, 930).invocation_id,
        callback_id: 1,
    };
    let callback = HostCallRequest::MonotonicMs(())
        .into_child_message(callback_fence)
        .unwrap();
    let (callback_frame, callback_body) = callback.into_parts();
    let mut output = loaded_output(1);
    output.extend_from_slice(&wire(&callback_frame));
    output.extend_from_slice(&callback_body[..1]);
    let fixture = Fixture::new(
        "driver-fatal-blocked-body",
        &format!("{}exec /bin/sleep 30\n", shell_write(&output)),
    );
    let (driver, events, pid) = connect_loaded_driver(&fixture, 1);
    let shared = driver.shared.clone();
    let (_, token) = runtime_header(&events);
    assert!(token.is_some());
    driver.fatal_close().unwrap();
    driver.fatal_close().unwrap();
    assert_eq!(
        events.recv_timeout(Duration::from_secs(1)).unwrap(),
        PluginHostRuntimeEvent::Closed(Err(PluginHostProcessError::ForcedClosed))
    );
    assert_eq!(shared.queued_body_bytes.load(Ordering::Acquire), 0);
    assert_process_absent(pid);

    let reply = large_capability_reply(931);
    let parent_prefix = parent_wire(ParentFrame::Hello {
        protocol_name: HOST_PROTOCOL_NAME.into(),
        protocol_version: HOST_PROTOCOL_VERSION,
        junban_version: HOST_JUNBAN_VERSION.into(),
        host_session_id: SESSION.into(),
    })
    .len()
        + parent_message_wire(&load_message(0, vec![b'a'])).len()
        + 64 * 1024;
    assert!(parent_message_wire(&reply).len() > 64 * 1024);
    let writer_started = wire(&ChildFrame::Cancelled {
        fence: invocation_fence(0, 931),
    });
    let fixture = Fixture::new(
        "driver-fatal-stalled-writer",
        &format!(
            "{}/bin/dd if=/dev/stdin of=/dev/null bs=1 count={} 2>/dev/null\n{}exec /bin/sleep 30\n",
            shell_write(&loaded_output(1)),
            parent_prefix,
            shell_write(&writer_started),
        ),
    );
    let (driver, events, pid) = connect_loaded_driver(&fixture, 1);
    let shared = driver.shared.clone();
    driver
        .send(reply, deadline_after(Duration::from_secs(2)))
        .unwrap();
    let (frame, pending_body) = runtime_header(&events);
    assert!(matches!(frame, ChildFrame::Cancelled { .. }));
    assert!(pending_body.is_none());
    driver.fatal_close().unwrap();
    driver.fatal_close().unwrap();
    assert_eq!(
        events.recv_timeout(Duration::from_secs(1)).unwrap(),
        PluginHostRuntimeEvent::Closed(Err(PluginHostProcessError::ForcedClosed))
    );
    assert_eq!(shared.queued_body_bytes.load(Ordering::Acquire), 0);
    assert_process_absent(pid);
}

#[cfg(unix)]
#[test]
fn runtime_driver_writer_completion_uses_the_command_deadline() {
    let _guard = process_test_guard();
    let fixture = Fixture::new(
        "driver-writer-deadline",
        &format!("{}exec /bin/sleep 30\n", shell_write(&loaded_output(1))),
    );
    let (driver, events, pid) = connect_loaded_driver(&fixture, 1);
    let deadline = deadline_after(Duration::from_millis(50));
    driver.send(large_capability_reply(920), deadline).unwrap();
    assert_eq!(
        events.recv_timeout(Duration::from_secs(1)).unwrap(),
        PluginHostRuntimeEvent::Closed(Err(PluginHostProcessError::ControlTimeout))
    );
    assert!(Instant::now() >= deadline);
    assert_process_absent(pid);
}

#[test]
fn runtime_driver_command_producer_pressure_is_immediate_and_fail_closed() {
    let (commands, _receiver) = mpsc::sync_channel(RUNTIME_DRIVER_COMMAND_CAPACITY);
    let (wake, _wake_receiver) = mpsc::sync_channel(RUNTIME_DRIVER_WAKE_CAPACITY);
    let shared = Arc::new(RuntimeDriverShared::new());
    let driver = PluginHostRuntimeDriverHandle {
        commands: Some(commands),
        wake,
        shared: shared.clone(),
    };
    for _ in 0..RUNTIME_DRIVER_COMMAND_CAPACITY {
        driver.panic_driver_for_test().unwrap();
    }
    assert_eq!(
        driver.panic_driver_for_test(),
        Err(PluginHostProcessError::Backpressure)
    );
    assert_eq!(
        shared.terminal_state(),
        RuntimeDriverTerminalState::ForcedPressure
    );
}

#[cfg(unix)]
#[test]
fn writer_reader_fatal_close_and_shutdown_timeout_reap_without_orphans() {
    let _guard = process_test_guard();
    for (label, tail, operation) in [
        (
            "writer-loss",
            "IFS= read -r ignored\nexec 0<&-\nexec /bin/sleep 30\n",
            "send",
        ),
        (
            "reader-loss",
            "IFS= read -r ignored\nexec 1>&-\nexec /bin/sleep 30\n",
            "receive",
        ),
        (
            "shutdown-timeout",
            "IFS= read -r ignored\nexec 3>&1\nexec /bin/cat >/dev/null\n",
            "shutdown",
        ),
        (
            "fatal-close",
            "IFS= read -r ignored\nexec /bin/cat >/dev/null\n",
            "fatal",
        ),
    ] {
        let mut output = wire(&hello(SESSION));
        output.extend_from_slice(&wire(&ChildFrame::Loaded {
            fence: fence(0),
            import_export_fingerprint: "2".repeat(64),
        }));
        let tail = if operation == "send" {
            let closed = ChildFrame::Cancelled {
                fence: AuthorityFence {
                    invocation_id: "00000000-0000-4000-8000-000000000778".into(),
                    ..fence(0)
                },
            };
            format!(
                "IFS= read -r ignored\nexec 0<&-\n{}exec /bin/sleep 30\n",
                shell_write(&wire(&closed))
            )
        } else {
            tail.to_owned()
        };
        let fixture = Fixture::new(label, &format!("{}{tail}", shell_write(&output)));
        let mut process = PluginHostProcess::connect_for_test(
            &fixture.executable,
            session(),
            ProcessDeadlines {
                control: Duration::from_millis(100),
                compile_load: Duration::from_millis(500),
            },
        )
        .unwrap();
        process.load(load(0, b"\n".to_vec())).unwrap();
        process.finish_loading().unwrap();
        let pid = process.process_id().unwrap();
        match operation {
            "send" => {
                assert!(matches!(
                    process.receive_header(deadline_after(Duration::from_millis(200))),
                    Ok(ChildFrame::Cancelled { .. })
                ));
                let frame = ParentFrame::Cancel {
                    fence: AuthorityFence {
                        invocation_id: "00000000-0000-4000-8000-000000000777".into(),
                        ..fence(0)
                    },
                };
                assert!(
                    process
                        .send(
                            ParentMessage::new(frame, Vec::new()),
                            deadline_after(Duration::from_millis(200)),
                        )
                        .is_err()
                );
            }
            "receive" => assert!(
                process
                    .receive_header(deadline_after(Duration::from_millis(200)))
                    .is_err()
            ),
            "shutdown" => assert_eq!(
                process.shutdown(),
                Err(PluginHostProcessError::ControlTimeout)
            ),
            "fatal" => {
                process.fatal_close().unwrap();
                process.fatal_close().unwrap();
            }
            _ => unreachable!(),
        }
        assert_process_absent(pid);
    }
}
