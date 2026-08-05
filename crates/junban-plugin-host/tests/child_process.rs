use std::{
    io::Write,
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};

use junban_plugin_sdk::{
    AuthorityFence, ChildFrame, HOST_PROTOCOL_NAME, HOST_PROTOCOL_VERSION, HostFailureCode,
    InvocationRequest, ParentFrame, RuntimeLimits, RuntimeProfile, canonical_permission_hash,
    child_body_len, decode_child_frame, encode_parent_frame,
};
use sha2::{Digest, Sha256};

const SESSION: &str = "00000000-0000-4000-8000-000000000001";
const INVOCATION: &str = "00000000-0000-4000-8000-000000000002";

fn tiny_component() -> Vec<u8> {
    let mut component = Vec::with_capacity(8);
    component.extend_from_slice(b"\0asm");
    component.extend_from_slice(&[0x0d, 0x00, 0x01, 0x00]);
    component
}

fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn fence() -> AuthorityFence {
    AuthorityFence {
        plugin_id: "process-plugin".into(),
        package_generation: 7,
        activation_epoch: 9,
        host_session_id: SESSION.into(),
        invocation_id: INVOCATION.into(),
    }
}

fn hello() -> ParentFrame {
    ParentFrame::Hello {
        protocol_name: HOST_PROTOCOL_NAME.into(),
        protocol_version: HOST_PROTOCOL_VERSION,
        host_session_id: SESSION.into(),
    }
}

fn load(component: &[u8]) -> ParentFrame {
    ParentFrame::Load {
        fence: fence(),
        package_sha256: "1".repeat(64),
        component_sha256: hash(component),
        import_export_fingerprint: "2".repeat(64),
        runtime_profile: RuntimeProfile::Typescript,
        component_size: component.len() as u64,
        grants: Vec::new(),
        permission_hash: canonical_permission_hash(&[]).unwrap(),
        limits: RuntimeLimits::for_profile(RuntimeProfile::Typescript),
    }
}

fn append(bytes: &mut Vec<u8>, frame: &ParentFrame, body: &[u8]) {
    bytes.extend_from_slice(&encode_parent_frame(frame).unwrap());
    bytes.extend_from_slice(body);
}

fn run(input: &[u8]) -> Output {
    let executable = std::path::Path::new(env!("CARGO_BIN_EXE_junban-plugin-host"));
    assert!(executable.is_absolute());
    let mut child = Command::new(executable)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if child.try_wait().unwrap().is_some() {
            return child.wait_with_output().unwrap();
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("plugin host did not exit before the process-test deadline");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn child_frames(mut bytes: &[u8]) -> Vec<ChildFrame> {
    let mut frames = Vec::new();
    while !bytes.is_empty() {
        assert!(bytes.len() >= 4, "truncated child frame");
        let header_len = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
        let end = 4 + header_len;
        assert!(end <= bytes.len(), "truncated child header");
        let frame = decode_child_frame(&bytes[..end]).unwrap();
        let body_len = child_body_len(&frame).unwrap();
        assert!(end + body_len <= bytes.len(), "truncated child body");
        frames.push(frame);
        bytes = &bytes[end + body_len..];
    }
    frames
}

#[test]
fn process_loads_one_component_fences_calls_and_shuts_down_cleanly() {
    let component = tiny_component();
    let mut input = Vec::new();
    append(&mut input, &hello(), &[]);
    append(&mut input, &load(&component), &component);
    append(&mut input, &load(&component), &component);
    let mut cross_identity = load(&component);
    if let ParentFrame::Load { fence, .. } = &mut cross_identity {
        fence.plugin_id = "other-plugin".into();
    }
    append(&mut input, &cross_identity, &component);

    let mut stale = fence();
    stale.activation_epoch += 1;
    append(&mut input, &ParentFrame::Cancel { fence: stale }, &[]);

    let mut invocation = fence();
    invocation.invocation_id = "00000000-0000-4000-8000-000000000003".into();
    let request_message = InvocationRequest::activate(None)
        .into_parent_message(invocation.clone(), canonical_permission_hash(&[]).unwrap())
        .unwrap();
    let (invoke, request) = request_message.into_parts();
    append(&mut input, &invoke, &request);
    append(
        &mut input,
        &ParentFrame::Cancel {
            fence: invocation.clone(),
        },
        &[],
    );
    append(
        &mut input,
        &ParentFrame::Shutdown {
            host_session_id: SESSION.into(),
        },
        &[],
    );

    let output = run(&input);
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let frames = child_frames(&output.stdout);
    assert_eq!(frames.len(), 8);
    assert!(matches!(frames[0], ChildFrame::Hello { .. }));
    assert!(matches!(frames[1], ChildFrame::Loaded { .. }));
    for frame in &frames[2..5] {
        assert!(matches!(
            frame,
            ChildFrame::Failed {
                code: HostFailureCode::StaleAuthority,
                ..
            }
        ));
    }
    assert_eq!(
        frames[5],
        ChildFrame::Failed {
            fence: invocation.clone(),
            code: HostFailureCode::Unavailable,
        }
    );
    assert_eq!(
        frames[6],
        ChildFrame::Failed {
            fence: invocation,
            code: HostFailureCode::Unavailable,
        }
    );
    assert!(matches!(frames[7], ChildFrame::ShutdownComplete { .. }));
}

#[test]
fn process_rejects_calls_before_load_and_component_compile_failure() {
    let request_message = InvocationRequest::activate(None)
        .into_parent_message(fence(), canonical_permission_hash(&[]).unwrap())
        .unwrap();
    let (invoke, request) = request_message.into_parts();
    let core_module = b"\0asm\x01\0\0\0";
    let mut input = Vec::new();
    append(&mut input, &hello(), &[]);
    append(&mut input, &invoke, &request);
    append(&mut input, &load(core_module), core_module);
    append(
        &mut input,
        &ParentFrame::Shutdown {
            host_session_id: SESSION.into(),
        },
        &[],
    );

    let output = run(&input);
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let frames = child_frames(&output.stdout);
    assert!(matches!(
        frames[1],
        ChildFrame::Failed {
            code: HostFailureCode::StaleAuthority,
            ..
        }
    ));
    assert!(matches!(
        frames[2],
        ChildFrame::Failed {
            code: HostFailureCode::InvalidComponent,
            ..
        }
    ));
    assert!(matches!(frames[3], ChildFrame::ShutdownComplete { .. }));
}

#[test]
fn process_stdout_is_protocol_only_and_errors_are_bounded_and_redacted() {
    let marker = "guest-secret-arbitrary-text";
    let payload = format!(
        "{{\"type\":\"hello\",\"protocol_name\":\"{marker}\",\"protocol_version\":1,\"host_session_id\":\"{SESSION}\"}}"
    );
    let mut input = (payload.len() as u32).to_be_bytes().to_vec();
    input.extend_from_slice(payload.as_bytes());
    let output = run(&input);
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(output.stderr.len() <= 128);
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(!stderr.contains(marker));
    assert_eq!(stderr, "junban-plugin-host: protocol input rejected\n");
}

#[test]
fn process_clean_eof_has_no_output() {
    let output = run(&[]);
    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
}
