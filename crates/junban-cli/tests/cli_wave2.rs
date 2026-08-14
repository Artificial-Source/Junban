//! Process-level Wave 2 CLI catalog and ergonomic command tests.

use std::{
    fs,
    net::TcpListener as StdTcpListener,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use junban_server::{LocalApiOwner, TOKEN_FILE};
use junban_storage::ProfileOwner;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn unique_temp(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "junban-cli-wave2-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn write_token(profile: &Path) {
    fs::create_dir_all(profile).unwrap();
    fs::write(profile.join(TOKEN_FILE), format!("{}\n", "77".repeat(32))).unwrap();
}

fn junban() -> Command {
    Command::new(env!("CARGO_BIN_EXE_junban"))
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .worker_threads(2)
        .build()
        .unwrap()
}

fn run_json(profile: &Path, args: &[&str]) -> (i32, Value, String) {
    let output = junban()
        .args(["--json", "--data-dir", profile.to_str().unwrap()])
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("spawn junban");
    let stdout = String::from_utf8(output.stdout).unwrap();
    let stderr = String::from_utf8(output.stderr).unwrap();
    let code = output.status.code().unwrap_or(1);
    let trimmed = stdout.trim_end_matches('\n');
    assert!(
        !trimmed.contains('\n'),
        "stdout must be one JSON value, got {stdout:?}; stderr={stderr}"
    );
    let value: Value = serde_json::from_str(trimmed).unwrap_or_else(|error| {
        panic!("stdout JSON decode failed: {error}; stdout={stdout:?}; stderr={stderr}")
    });
    let dumped = format!("{value}");
    assert!(!dumped.contains("Bearer "));
    assert!(!dumped.contains(&"77".repeat(32)));
    (code, value, stderr)
}

async fn read_http_request(socket: &mut tokio::net::TcpStream) -> Vec<u8> {
    let mut request = Vec::new();
    let mut buffer = [0_u8; 4096];
    let header_end = loop {
        let read = socket.read(&mut buffer).await.unwrap();
        assert!(read > 0, "connection closed before headers");
        request.extend_from_slice(&buffer[..read]);
        if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let headers = String::from_utf8_lossy(&request[..header_end]);
    let content_len = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    while request.len() < header_end + content_len {
        let read = socket.read(&mut buffer).await.unwrap();
        assert!(read > 0, "connection closed before body");
        request.extend_from_slice(&buffer[..read]);
    }
    request
}

async fn write_json_response(socket: &mut tokio::net::TcpStream, body: &str) {
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    socket.write_all(response.as_bytes()).await.unwrap();
}

async fn accept_health(listener: &tokio::net::TcpListener) {
    let (mut socket, _) = listener.accept().await.unwrap();
    let request = read_http_request(&mut socket).await;
    assert!(String::from_utf8_lossy(&request).starts_with("GET /api/v1/health "));
    assert!(!String::from_utf8_lossy(&request).contains("Authorization:"));
    write_json_response(&mut socket, r#"{"status":"ok","instance_id":"fake"}"#).await;
}

fn explicit_command(server: &str, credential: &Path) -> Command {
    let mut command = junban();
    command.args([
        "--json",
        "--server",
        server,
        "--credential-file",
        credential.to_str().unwrap(),
    ]);
    command
}

fn fake_listener() -> (StdTcpListener, String) {
    let listener = StdTcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let server = format!("http://{}", listener.local_addr().unwrap());
    (listener, server)
}

fn extract_task_id(created: &Value, profile: &Path) -> String {
    let candidates = [
        created.pointer("/event/entity_id").and_then(Value::as_str),
        created.pointer("/event/task_id").and_then(Value::as_str),
        created
            .pointer("/event/payload/task/id")
            .and_then(Value::as_str),
        created
            .pointer("/event/snapshot/task/id")
            .and_then(Value::as_str),
        created
            .pointer("/event/summary/task_id")
            .and_then(Value::as_str),
        created.pointer("/task/id").and_then(Value::as_str),
    ];
    for candidate in candidates.into_iter().flatten() {
        if uuid::Uuid::parse_str(candidate).is_ok() {
            return candidate.to_owned();
        }
    }
    let (code, listed, _) = run_json(profile, &["task", "list", "--search", "Wave2 task"]);
    assert_eq!(code, 0, "list failed: {listed}");
    listed["tasks"][0]["id"]
        .as_str()
        .expect("task id present")
        .to_owned()
}

#[test]
fn tools_list_json_is_versioned_and_deterministic() {
    let root = unique_temp("tools-list");
    let profile = root.join("profile");
    write_token(&profile);

    let (code_a, value_a, _) = run_json(&profile, &["tools", "list"]);
    let (code_b, value_b, _) = run_json(&profile, &["tools", "list"]);
    assert_eq!(code_a, 0);
    assert_eq!(code_b, 0);
    assert_eq!(value_a["version"], 1);
    assert_eq!(value_a["tools"].as_array().unwrap().len(), 87);
    assert_eq!(value_a, value_b);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn task_project_tag_export_backup_round_trip_on_temporary_owner() {
    let root = unique_temp("task-roundtrip");
    let profile = root.join("profile");
    write_token(&profile);

    let (code, created, _) = run_json(
        &profile,
        &["task", "add", "Wave2 task", "--due-date", "2030-01-15"],
    );
    assert_eq!(code, 0, "create failed: {created}");
    let task_id = extract_task_id(&created, &profile);

    let (code, got, _) = run_json(&profile, &["task", "get", &task_id]);
    assert_eq!(code, 0, "get failed: {got}");
    let title = got
        .pointer("/task/title")
        .or_else(|| got.get("title"))
        .cloned()
        .unwrap_or(Value::Null);
    assert_eq!(title, "Wave2 task");

    let (code, _, _) = run_json(&profile, &["task", "complete", &task_id]);
    assert_eq!(code, 0);
    let (code, _, _) = run_json(&profile, &["task", "uncomplete", &task_id]);
    assert_eq!(code, 0);

    let (code, project, _) = run_json(&profile, &["project", "add", "Wave2 Project"]);
    assert_eq!(code, 0, "project add failed: {project}");

    let (code, tag, _) = run_json(&profile, &["tag", "add", "wave2"]);
    assert_eq!(code, 0, "tag add failed: {tag}");

    let (code, settings, _) =
        run_json(&profile, &["tool", "call", "get_settings", "--input", "{}"]);
    assert_eq!(code, 0, "settings failed: {settings}");

    let (code, plan, _) = run_json(&profile, &["plan", "daily"]);
    assert_eq!(code, 0, "daily plan failed: {plan}");

    let export_path = root.join("tasks.json");
    let (code, exported, _) = run_json(
        &profile,
        &[
            "data",
            "export",
            "--format",
            "json",
            "--output",
            export_path.to_str().unwrap(),
        ],
    );
    assert_eq!(code, 0, "export failed: {exported}");
    assert!(export_path.is_file());
    assert!(fs::metadata(&export_path).unwrap().len() > 0);

    let backup_path = root.join("profile.junban-backup");
    let (code, backup, _) = run_json(
        &profile,
        &["data", "backup", "--output", backup_path.to_str().unwrap()],
    );
    assert_eq!(code, 0, "backup failed: {backup}");
    assert!(backup_path.is_file());

    let (code, err, _) = run_json(&profile, &["task", "delete", &task_id]);
    assert_ne!(code, 0);
    assert_eq!(err["error"]["code"], "confirmation_required");

    let (code, _, _) = run_json(
        &profile,
        &["task", "delete", &task_id, "--confirm", "delete"],
    );
    assert_eq!(code, 0);

    let (code, created, _) = run_json(&profile, &["task", "add", "Bulk generic"]);
    assert_eq!(code, 0);
    let generic_id = extract_task_id(&created, &profile);
    let missing = format!(r#"{{"task_ids":["{generic_id}"],"action":{{"type":"delete"}}}}"#);
    let (code, error, _) = run_json(
        &profile,
        &["tool", "call", "bulk_tasks", "--input", &missing],
    );
    assert_ne!(code, 0);
    assert_eq!(error["error"]["code"], "confirmation_required");
    let confirmed = format!(
        r#"{{"task_ids":["{generic_id}"],"action":{{"type":"delete"}},"confirm":"delete"}}"#
    );
    let (code, _, _) = run_json(
        &profile,
        &["tool", "call", "bulk_tasks", "--input", &confirmed],
    );
    assert_eq!(code, 0);

    let (code, created, _) = run_json(&profile, &["task", "add", "Bulk human"]);
    assert_eq!(code, 0);
    let human_id = extract_task_id(&created, &profile);
    let (code, _, _) = run_json(
        &profile,
        &[
            "task",
            "bulk",
            "--action",
            "delete",
            "--id",
            &human_id,
            "--confirm",
            "delete",
        ],
    );
    assert_eq!(code, 0);

    let owner = ProfileOwner::open(&profile).expect("lock released");
    drop(owner);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn discovered_owner_task_list_keeps_single_lock() {
    let root = unique_temp("discovered-list");
    let profile = root.join("profile");
    write_token(&profile);
    // Keep the runtime alive for the owner's serve task.
    let rt = runtime();
    let owner = rt.block_on(LocalApiOwner::start(profile.clone())).unwrap();
    // Wait until the owner accepts health probes before spawning the CLI process.
    rt.block_on(async {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let url = format!("{}/api/v1/health", owner.base_url());
        let host = owner.base_url().trim_start_matches("http://").to_owned();
        for _ in 0..50 {
            if let Ok(response) = client.get(&url).header("Host", &host).send().await
                && response.status().is_success()
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("owner health never became ready");
    });

    let (code, listed, _) = run_json(&profile, &["task", "list"]);
    assert_eq!(code, 0, "list failed: {listed}");

    assert!(matches!(
        ProfileOwner::open(&profile),
        Err(junban_storage::OpenError::AlreadyOwned)
    ));
    rt.block_on(owner.shutdown());
    drop(rt);
    let reopened = ProfileOwner::open(&profile).unwrap();
    drop(reopened);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn malformed_input_and_dates_fail_closed() {
    let root = unique_temp("bad-input");
    let profile = root.join("profile");
    write_token(&profile);

    let (code, err, _) = run_json(
        &profile,
        &["tool", "call", "create_task", "--input", "[1,2,3]"],
    );
    assert_ne!(code, 0);
    assert_eq!(err["error"]["code"], "invalid_input_json");

    let (code, err, _) = run_json(
        &profile,
        &[
            "tool",
            "call",
            "get_task",
            "--input",
            r#"{"task_id":"nope"}"#,
        ],
    );
    assert_ne!(code, 0);
    assert_eq!(err["error"]["code"], "invalid_id");

    let (code, err, _) = run_json(&profile, &["task", "add", "x", "--due-date", "15-01-2030"]);
    assert_ne!(code, 0);
    assert_eq!(err["error"]["code"], "invalid_date");

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn at_file_input_works_for_tool_call() {
    let root = unique_temp("at-file");
    let profile = root.join("profile");
    write_token(&profile);
    let input_path = root.join("create.json");
    fs::write(&input_path, r#"{"title":"From file"}"#).unwrap();

    let (code, created, _) = run_json(
        &profile,
        &[
            "tool",
            "call",
            "create_task",
            "--input",
            &format!("@{}", input_path.display()),
        ],
    );
    assert_eq!(code, 0, "create via @file failed: {created}");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn json_intent_turns_clap_failures_into_one_redacted_json_error() {
    let cases: &[&[&str]] = &[
        &["--json", "unknown-command", "inline-secret-value"],
        &["unknown-command", "--json"],
        &["task", "list", "--limit", "not-a-number", "--json"],
        &["status", "--data-dir", "--json"],
    ];
    for args in cases {
        let output = junban()
            .args(*args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2), "args={args:?}");
        assert!(output.stderr.is_empty(), "args={args:?}");
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert_eq!(stdout.lines().count(), 1, "args={args:?}");
        let value: Value = serde_json::from_str(stdout.trim()).unwrap();
        assert_eq!(value["error"]["code"], "argument_parse_failed");
        assert!(!stdout.contains("inline-secret-value"));
        assert!(!stdout.contains("not-a-number"));
    }

    let help = junban().arg("--help").output().unwrap();
    assert!(help.status.success());
    assert!(String::from_utf8_lossy(&help.stdout).contains("Usage:"));
    let human_error = junban().arg("unknown-command").output().unwrap();
    assert!(!human_error.status.success());
    assert!(human_error.stdout.is_empty());
    assert!(String::from_utf8_lossy(&human_error.stderr).contains("Usage:"));
}

#[test]
fn restore_requires_confirm_and_never_prints_binary() {
    let root = unique_temp("restore-confirm");
    let profile = root.join("profile");
    write_token(&profile);
    let fake = root.join("missing.junban-backup");

    let (code, err, _) = run_json(
        &profile,
        &["data", "restore", "--input", fake.to_str().unwrap()],
    );
    assert_ne!(code, 0);
    assert_eq!(err["error"]["code"], "confirmation_required");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn rotation_existing_target_fails_before_authorized_request() {
    let root = unique_temp("rotation-existing");
    fs::create_dir_all(&root).unwrap();
    let credential = root.join("operator.token");
    fs::write(&credential, "previous-bearer\n").unwrap();
    let destination = root.join("rotated.token");
    fs::write(&destination, b"unrelated").unwrap();
    let (listener, server) = fake_listener();
    let server_thread = thread::spawn(move || {
        runtime().block_on(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            accept_health(&listener).await;
            assert!(
                tokio::time::timeout(Duration::from_millis(300), listener.accept())
                    .await
                    .is_err(),
                "an authorized rotation request was sent"
            );
        });
    });

    let output = explicit_command(&server, &credential)
        .args([
            "server",
            "rotate-token",
            "--write-token",
            destination.to_str().unwrap(),
            "--confirm",
            "rotate-token",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stderr.is_empty());
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["error"]["code"], "token_path_exists");
    assert_eq!(fs::read(&destination).unwrap(), b"unrelated");
    server_thread.join().unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn rotation_commit_drop_then_separate_process_resumes_exact_receipt() {
    let root = unique_temp("rotation-resume");
    fs::create_dir_all(&root).unwrap();
    let credential = root.join("operator.token");
    fs::write(&credential, "previous-bearer\n").unwrap();
    let destination = root.join("rotated.token");
    let (listener, server) = fake_listener();
    let server_thread = thread::spawn(move || {
        runtime().block_on(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            let mut keys = Vec::new();
            for _ in 0..2 {
                if keys.is_empty() {
                    accept_health(&listener).await;
                }
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = read_http_request(&mut socket).await;
                let text = String::from_utf8_lossy(&request);
                assert!(text.starts_with("POST /api/v1/auth/rotate "));
                assert!(
                    text.to_ascii_lowercase()
                        .contains("authorization: bearer previous-bearer")
                );
                let key = text
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("idempotency-key")
                            .then(|| value.trim().to_owned())
                    })
                    .unwrap();
                keys.push(key);
                // Commit is modeled by remembering the receipt, then dropping both
                // response attempts from the first CLI process.
                drop(socket);
            }
            accept_health(&listener).await;
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            let text = String::from_utf8_lossy(&request);
            let key = text
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("idempotency-key")
                        .then(|| value.trim().to_owned())
                })
                .unwrap();
            assert_eq!(keys, vec![key.clone(), key]);
            write_json_response(&mut socket, r#"{"token":"exact-receipt-token"}"#).await;
        });
    });

    let generic_input = format!(
        r#"{{"write_token":"{}","confirm":"rotate-token"}}"#,
        destination.display()
    );
    let first = explicit_command(&server, &credential)
        .args(["tool", "call", "rotate_token", "--input", &generic_input])
        .output()
        .unwrap();
    assert!(!first.status.success());
    let first_json: Value = serde_json::from_slice(&first.stdout).unwrap();
    assert_eq!(
        first_json["error"]["code"],
        "token_rotation_outcome_unknown"
    );
    assert_eq!(fs::metadata(&destination).unwrap().len(), 0);

    let second = explicit_command(&server, &credential)
        .args([
            "server",
            "rotate-token",
            "--write-token",
            destination.to_str().unwrap(),
            "--confirm",
            "rotate-token",
        ])
        .output()
        .unwrap();
    assert!(
        second.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&second.stderr)
    );
    let result: Value = serde_json::from_slice(&second.stdout).unwrap();
    assert_eq!(result["token_path"], destination.to_str().unwrap());
    assert!(result.get("token").is_none());
    assert_eq!(
        fs::read_to_string(&destination).unwrap(),
        "exact-receipt-token\n"
    );
    assert!(
        !root
            .join("rotated.token.junban-token-rotation.pending.json")
            .exists()
    );
    server_thread.join().unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn restore_body_drop_is_one_request_and_reports_outcome_unknown() {
    let root = unique_temp("restore-unknown");
    fs::create_dir_all(&root).unwrap();
    let credential = root.join("operator.token");
    fs::write(&credential, "operator-bearer\n").unwrap();
    let backup = root.join("input.junban-backup");
    fs::write(&backup, b"fake-but-nonempty-upload").unwrap();
    let (listener, server) = fake_listener();
    let server_thread = thread::spawn(move || {
        runtime().block_on(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            accept_health(&listener).await;
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            let text = String::from_utf8_lossy(&request);
            assert!(text.starts_with("POST /api/v1/backup/restore "));
            assert!(text.ends_with("fake-but-nonempty-upload"));
            drop(socket);
            assert!(
                tokio::time::timeout(Duration::from_millis(300), listener.accept())
                    .await
                    .is_err(),
                "restore was retried"
            );
        });
    });

    let output = explicit_command(&server, &credential)
        .args([
            "data",
            "restore",
            "--input",
            backup.to_str().unwrap(),
            "--confirm",
            "restore",
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stderr.is_empty());
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["error"]["code"], "restore_outcome_unknown");
    let message = value["error"]["message"].as_str().unwrap();
    assert!(message.contains("Restart Junban"));
    assert!(message.contains("maintenance/recovery status"));
    server_thread.join().unwrap();
    fs::remove_dir_all(root).unwrap();
}
