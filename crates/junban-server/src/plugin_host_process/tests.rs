use std::{
    fs,
    io::Cursor,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant, SystemTime},
};

use junban_plugin_sdk::{
    ChildFrame, HOST_FRAME_BYTES_MAX, ParentFrame, RuntimeProfile, encode_child_frame,
    read_parent_message,
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

fn shell_write(bytes: &[u8]) -> String {
    let escaped = bytes
        .iter()
        .map(|byte| format!("\\{:03o}", byte))
        .collect::<String>();
    format!("printf '{escaped}'\n")
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
    assert_eq!(STDERR_BUFFER_BYTES, 8 * 1024);
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
