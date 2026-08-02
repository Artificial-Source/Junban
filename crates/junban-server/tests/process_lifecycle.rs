#![cfg(unix)]

use std::{
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime},
};

use jiff::Timestamp;
use junban_app::Repository;
use junban_domain::{OperationId, TaskDraft, TaskId, TaskTitle, sha256_hex};
use junban_server::{RUNTIME_FILE, RuntimeMetadata, TOKEN_FILE, TOKEN_ROTATION_RECEIPT_FILE};
use junban_storage::{OpenError, ProfileOwner, RECOVERY_REQUIRED_FILE, RecoveryOwner};

#[test]
fn sigint_removes_metadata_closes_listener_and_releases_profile() {
    assert_graceful_shutdown("INT");
}

#[test]
fn sigterm_removes_metadata_closes_listener_and_releases_profile() {
    assert_graceful_shutdown("TERM");
}

#[test]
fn pending_token_rotation_is_reconciled_before_process_accepts_traffic() {
    let root = unique_temp_root("token-reconcile");
    let profile = root.join("profile");
    let web = root.join("web");
    fs::create_dir_all(&web).unwrap();
    fs::write(web.join("index.html"), "<main>Junban</main>").unwrap();
    let owner = ProfileOwner::open(&profile).unwrap();
    drop(owner);

    let old_token = "11".repeat(32);
    let issued_token = "22".repeat(32);
    let operation_id = "70000000-0000-7000-8000-000000000001";
    fs::write(profile.join(TOKEN_FILE), format!("{old_token}\n")).unwrap();
    fs::write(
        profile.join(TOKEN_ROTATION_RECEIPT_FILE),
        serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "operation_id": operation_id,
            "previous_token_sha256": sha256_hex(old_token.as_bytes()),
            "issued_token": issued_token,
            "new_token_sha256": sha256_hex(issued_token.as_bytes()),
        }))
        .unwrap(),
    )
    .unwrap();

    let mut child = spawn_server(&profile, &web);
    let runtime_path = profile.join(RUNTIME_FILE);
    wait_until(
        || runtime_path.exists(),
        "runtime metadata was not created after token reconciliation",
    );
    let metadata: RuntimeMetadata =
        serde_json::from_str(&fs::read_to_string(&runtime_path).unwrap()).unwrap();
    assert_eq!(
        fs::read_to_string(profile.join(TOKEN_FILE)).unwrap().trim(),
        issued_token
    );
    let old_denied = http_get(metadata.address, "/api/v1/profile", Some(&old_token));
    assert!(
        old_denied.starts_with("HTTP/1.1 401 Unauthorized"),
        "{old_denied}"
    );
    let new_accepted = http_get(metadata.address, "/api/v1/profile", Some(&issued_token));
    assert!(
        new_accepted.starts_with("HTTP/1.1 200 OK"),
        "{new_accepted}"
    );
    let exact_retry = http_post(
        metadata.address,
        "/api/v1/auth/rotate",
        &old_token,
        operation_id,
    );
    assert!(exact_retry.starts_with("HTTP/1.1 200 OK"), "{exact_retry}");
    assert!(exact_retry.contains(&issued_token), "{exact_retry}");

    send_signal("TERM", child.id());
    wait_for_exit(&mut child, "TERM");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn catastrophic_marker_for_openable_database_survives_restart_into_recovery_only_process() {
    let root = unique_temp_root("catastrophic-restart");
    let profile = root.join("profile");
    let web = root.join("web");
    fs::create_dir_all(&web).unwrap();
    fs::write(web.join("index.html"), "<main>Recovery</main>").unwrap();
    let owner = ProfileOwner::open(&profile).unwrap();
    drop(owner);
    let marker_path = profile.join(RECOVERY_REQUIRED_FILE);
    fs::write(
        &marker_path,
        b"{\"version\":1,\"reason\":\"catastrophic_restore\"}\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&marker_path, fs::Permissions::from_mode(0o600)).unwrap();
    }

    let mut child = spawn_server(&profile, &web);
    let runtime_path = profile.join(RUNTIME_FILE);
    wait_until(
        || runtime_path.exists(),
        "recovery runtime metadata was not created for catastrophic marker",
    );
    let metadata: RuntimeMetadata =
        serde_json::from_str(&fs::read_to_string(&runtime_path).unwrap()).unwrap();
    let token = fs::read_to_string(profile.join(TOKEN_FILE)).unwrap();
    let health = http_get(metadata.address, "/api/v1/health", Some(token.trim()));
    assert!(health.starts_with("HTTP/1.1 200 OK"), "{health}");
    assert!(health.contains("\"status\":\"recovery\""), "{health}");
    let tasks = http_get(metadata.address, "/api/v1/tasks", Some(token.trim()));
    assert!(
        tasks.starts_with("HTTP/1.1 503 Service Unavailable"),
        "{tasks}"
    );
    assert!(marker_path.exists());
    assert!(matches!(
        RecoveryOwner::open(&profile),
        Err(OpenError::AlreadyOwned)
    ));

    send_signal("TERM", child.id());
    wait_for_exit(&mut child, "TERM");
    assert!(marker_path.exists(), "startup must not clear catastrophe");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn interrupted_recovery_cutover_is_reconciled_before_process_can_open_sqlite() {
    let root = unique_temp_root("cutover-reopen");
    let profile = root.join("profile");
    let web = root.join("web");
    fs::create_dir_all(&web).unwrap();
    fs::write(web.join("index.html"), "<main>Recovery</main>").unwrap();

    let owner = ProfileOwner::open(&profile).unwrap();
    let repository = owner.repository();
    let task_id = TaskId::new();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let candidate = runtime.block_on(async {
        repository
            .create_task(
                OperationId::parse("70000000-0000-7000-8000-000000000099").unwrap(),
                task_id,
                TaskDraft::new(TaskTitle::new("cutover survives process restart").unwrap()),
                Timestamp::now(),
            )
            .await
            .unwrap();
        let backup = repository.create_backup().await.unwrap();
        repository.prepare_restore(backup).await.unwrap()
    });
    drop(repository);
    drop(owner);

    let staged_name = ".junban.sqlite3.recovery-new";
    let staged = profile.join(staged_name);
    fs::copy(candidate.path(), &staged).unwrap();
    let candidate_bytes = fs::read(&staged).unwrap();
    let connection = rusqlite::Connection::open(&staged).unwrap();
    let event_epoch: String = connection
        .query_row(
            "SELECT event_epoch FROM app_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    drop(connection);
    let rollback_relative = "backups/pre-recovery/process-reopen";
    let rollback = profile.join(rollback_relative);
    fs::create_dir_all(&rollback).unwrap();
    fs::rename(
        profile.join("junban.sqlite3"),
        rollback.join("junban.sqlite3"),
    )
    .unwrap();
    fs::write(
        profile.join("recovery-cutover.json"),
        serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "candidate_file": staged_name,
            "rollback_dir": rollback_relative,
            "candidate_len": candidate_bytes.len(),
            "candidate_sha256": sha256_hex(&candidate_bytes),
            "schema_version": 5,
            "event_epoch": event_epoch,
        }))
        .unwrap(),
    )
    .unwrap();

    let mut child = spawn_server(&profile, &web);
    let runtime_path = profile.join(RUNTIME_FILE);
    wait_until(
        || runtime_path.exists(),
        "recovery runtime metadata was not created after cutover reconciliation",
    );
    assert!(!profile.join("recovery-cutover.json").exists());
    assert!(profile.join("junban.sqlite3").exists());
    let metadata: RuntimeMetadata =
        serde_json::from_str(&fs::read_to_string(&runtime_path).unwrap()).unwrap();
    let token = fs::read_to_string(profile.join(TOKEN_FILE)).unwrap();
    let health = http_get(metadata.address, "/api/v1/health", Some(token.trim()));
    assert!(health.contains("\"status\":\"recovery\""), "{health}");

    send_signal("TERM", child.id());
    wait_for_exit(&mut child, "TERM");
    let reopened = ProfileOwner::open(&profile).unwrap();
    let reopened_repo = reopened.repository();
    let task = runtime.block_on(reopened_repo.get_task(task_id)).unwrap();
    assert_eq!(task.title.as_str(), "cutover survives process restart");
    drop(reopened_repo);
    drop(reopened);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn corrupt_database_starts_lock_retaining_recovery_only_process() {
    let root = unique_temp_root("recovery");
    let profile = root.join("profile");
    let web = root.join("web");
    fs::create_dir_all(&profile).unwrap();
    fs::create_dir_all(&web).unwrap();
    fs::write(profile.join("junban.sqlite3"), b"not a sqlite database").unwrap();
    fs::write(web.join("index.html"), "<main>Recovery</main>").unwrap();

    let mut child = spawn_server(&profile, &web);
    let runtime_path = profile.join(RUNTIME_FILE);
    wait_until(
        || runtime_path.exists(),
        "recovery runtime metadata was not created",
    );
    let metadata: RuntimeMetadata =
        serde_json::from_str(&fs::read_to_string(&runtime_path).unwrap()).unwrap();
    let token = fs::read_to_string(profile.join(TOKEN_FILE)).unwrap();

    let health = http_get(metadata.address, "/api/v1/health", Some(token.trim()));
    assert!(health.starts_with("HTTP/1.1 200 OK"), "{health}");
    assert!(health.contains("\"status\":\"recovery\""), "{health}");
    let tasks = http_get(metadata.address, "/api/v1/tasks", Some(token.trim()));
    assert!(
        tasks.starts_with("HTTP/1.1 503 Service Unavailable"),
        "{tasks}"
    );
    assert!(matches!(
        RecoveryOwner::open(&profile),
        Err(OpenError::AlreadyOwned)
    ));

    send_signal("TERM", child.id());
    wait_for_exit(&mut child, "TERM");
    wait_until(
        || !runtime_path.exists(),
        "recovery runtime metadata remained",
    );
    let recovery = RecoveryOwner::open(&profile).expect("recovery lock should be released");
    drop(recovery);
    fs::remove_dir_all(root).unwrap();
}

fn assert_graceful_shutdown(signal: &str) {
    let root = unique_temp_root(signal);
    let profile = root.join("profile");
    let web = root.join("web");
    fs::create_dir_all(&web).unwrap();
    fs::write(web.join("index.html"), "<main>Junban</main>").unwrap();

    let mut child = spawn_server(&profile, &web);
    let runtime_path = profile.join(RUNTIME_FILE);
    wait_until(
        || runtime_path.exists(),
        &format!("{} was not created", runtime_path.display()),
    );

    let metadata_text = fs::read_to_string(&runtime_path).unwrap();
    let token_path = profile.join(TOKEN_FILE);
    let token = fs::read_to_string(&token_path).unwrap();
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        fs::metadata(&runtime_path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(&token_path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let metadata: RuntimeMetadata = serde_json::from_str(&metadata_text).unwrap();
    assert!(metadata.address.ip().is_loopback());
    assert_ne!(metadata.address.port(), 0);
    assert!(!metadata_text.contains(token.trim()));
    assert_health(metadata.address);

    // An idle authenticated SSE stream must not pin the process across shutdown.
    let event_epoch = get_event_epoch(metadata.address, token.trim());
    let sse = open_sse_stream(metadata.address, token.trim(), &event_epoch);

    send_signal(signal, child.id());
    wait_for_exit(&mut child, signal);
    drop(sse);

    wait_until(
        || !runtime_path.exists(),
        &format!("runtime metadata still present after {signal}"),
    );
    wait_until(
        || !listener_accepts(metadata.address),
        &format!("listener still accepting connections after {signal}"),
    );

    let owner = ProfileOwner::open(&profile).expect("profile lock should be released");
    drop(owner);
    fs::remove_dir_all(root).unwrap();
}

fn spawn_server(profile: &Path, web: &Path) -> Child {
    Command::new(env!("CARGO_BIN_EXE_junban-server"))
        .args([
            "--bind",
            "127.0.0.1:0",
            "--data-dir",
            profile.to_str().unwrap(),
            "--web-dir",
            web.to_str().unwrap(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

fn send_signal(signal: &str, pid: u32) {
    let status = Command::new("kill")
        .args([format!("-{signal}"), pid.to_string()])
        .status()
        .unwrap();
    assert!(
        status.success(),
        "kill -{signal} {pid} failed with {status}"
    );
}

fn wait_for_exit(child: &mut Child, signal: &str) {
    wait_until(
        || match child.try_wait() {
            Ok(Some(status)) => {
                assert!(
                    status.success(),
                    "server exited unsuccessfully after {signal}: {status}"
                );
                true
            }
            Ok(None) => false,
            Err(error) => panic!("failed waiting for server after {signal}: {error}"),
        },
        &format!("server did not stop after {signal}"),
    );
}

fn assert_health(address: SocketAddr) {
    let response = http_get(address, "/api/v1/health", None);
    assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
}

fn http_get(address: SocketAddr, path: &str, token: Option<&str>) -> String {
    let mut stream = TcpStream::connect(address).unwrap();
    let authorization = token
        .map(|token| format!("Authorization: Bearer {token}\r\n"))
        .unwrap_or_default();
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: {address}\r\n{authorization}Connection: close\r\n\r\n"
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
}

fn http_post(address: SocketAddr, path: &str, token: &str, operation_id: &str) -> String {
    let mut stream = TcpStream::connect(address).unwrap();
    write!(
        stream,
        "POST {path} HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {token}\r\nIdempotency-Key: {operation_id}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
}

fn get_event_epoch(address: SocketAddr, token: &str) -> String {
    let mut stream = TcpStream::connect(address).unwrap();
    write!(
        stream,
        "GET /api/v1/sync-state HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
    let body = response.split("\r\n\r\n").nth(1).unwrap();
    let body: serde_json::Value = serde_json::from_str(body).unwrap();
    body["event_epoch"].as_str().unwrap().to_owned()
}

fn open_sse_stream(address: SocketAddr, token: &str, event_epoch: &str) -> TcpStream {
    let mut stream = TcpStream::connect(address).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    write!(
        stream,
        "GET /api/v1/events?event_epoch={event_epoch}&since=0 HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {token}\r\nAccept: text/event-stream\r\nLast-Event-ID: 0\r\n\r\n"
    )
    .unwrap();

    let mut header_bytes = Vec::new();
    let mut buffer = [0_u8; 1];
    loop {
        let read = stream.read(&mut buffer).unwrap();
        assert_ne!(read, 0, "SSE response closed before headers finished");
        header_bytes.push(buffer[0]);
        if header_bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        assert!(
            header_bytes.len() < 8 * 1024,
            "SSE response headers exceeded 8 KiB"
        );
    }
    let headers = String::from_utf8(header_bytes).unwrap();
    assert!(
        headers.starts_with("HTTP/1.1 200 OK"),
        "expected SSE 200, got: {headers}"
    );
    stream
}

fn listener_accepts(address: SocketAddr) -> bool {
    TcpStream::connect_timeout(&address, Duration::from_millis(100)).is_ok()
}

fn unique_temp_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "junban-process-test-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn wait_until(mut condition: impl FnMut() -> bool, failure_message: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if condition() {
            return;
        }
        assert!(Instant::now() < deadline, "{failure_message}");
        thread::sleep(Duration::from_millis(25));
    }
}
