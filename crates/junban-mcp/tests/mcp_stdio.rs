//! Real stdio MCP protocol tests for Wave 3 tools/resources/prompts lifecycle.

use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use junban_server::{LocalApiOwner, TOKEN_FILE, mint_automation_token};
use serde_json::{Value, json};
use uuid::Uuid;

const LOCK_FILE: &str = "profile.lock";

fn unique_temp(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "junban-mcp-wave3-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn write_operator_token(profile: &Path) {
    fs::create_dir_all(profile).unwrap();
    fs::write(profile.join(TOKEN_FILE), format!("{}\n", "77".repeat(32))).unwrap();
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .worker_threads(2)
        .build()
        .unwrap()
}

fn operator_token(profile: &Path) -> String {
    fs::read_to_string(profile.join(TOKEN_FILE))
        .unwrap()
        .trim()
        .to_owned()
}

fn spawn_mcp_local(profile: &Path) -> (Child, ChildStdin, BufReader<ChildStdout>) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_junban-mcp"))
        .args(["--data-dir", profile.to_str().unwrap()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn junban-mcp");
    let stdin = child.stdin.take().expect("stdin");
    let stdout = child.stdout.take().expect("stdout");
    (child, stdin, BufReader::new(stdout))
}

fn spawn_mcp_explicit(
    profile: &Path,
    base_url: &str,
    credential_file: &Path,
) -> (Child, ChildStdin, BufReader<ChildStdout>) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_junban-mcp"))
        .args([
            "--data-dir",
            profile.to_str().unwrap(),
            "--server",
            base_url,
            "--credential-file",
            credential_file.to_str().unwrap(),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn explicit junban-mcp");
    let stdin = child.stdin.take().expect("stdin");
    let stdout = child.stdout.take().expect("stdout");
    (child, stdin, BufReader::new(stdout))
}

fn read_rpc_line(reader: &mut impl BufRead, deadline: Instant) -> Value {
    let mut line = String::new();
    loop {
        line.clear();
        if Instant::now() > deadline {
            panic!("timed out waiting for MCP stdout frame");
        }
        match reader.read_line(&mut line) {
            Ok(0) => panic!("MCP stdout closed before response"),
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                assert!(
                    !trimmed.contains("Bearer "),
                    "stdout must not contain bearer material: {trimmed}"
                );
                assert!(
                    !trimmed.contains(&"77".repeat(32)),
                    "stdout must not contain operator token"
                );
                assert!(
                    !trimmed.contains("jba_"),
                    "stdout must not contain automation token material"
                );
                return serde_json::from_str(trimmed).unwrap_or_else(|error| {
                    panic!("invalid MCP JSON line {trimmed:?}: {error}");
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => panic!("read MCP stdout: {error}"),
        }
    }
}

fn write_rpc(stdin: &mut impl Write, value: &Value) {
    writeln!(stdin, "{value}").unwrap();
    stdin.flush().unwrap();
}

fn initialize(stdin: &mut impl Write, reader: &mut impl BufRead, deadline: Instant) -> Value {
    write_rpc(
        stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": {"name": "junban-wave3-test", "version": "0.0.0"}
            }
        }),
    );
    let init = read_rpc_line(reader, deadline);
    assert_eq!(init["id"], 1);
    assert!(init.get("result").is_some(), "{init}");
    write_rpc(
        stdin,
        &json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        }),
    );
    init
}

fn rpc(
    stdin: &mut impl Write,
    reader: &mut impl BufRead,
    deadline: Instant,
    id: u64,
    method: &str,
    params: Value,
) -> Value {
    write_rpc(
        stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        }),
    );
    let response = read_rpc_line(reader, deadline);
    assert_eq!(response["id"], id, "{response}");
    response
}

fn create_scoped_credential(profile: &Path, scopes: &[&str], token_path: &Path) -> String {
    let rt = runtime();
    rt.block_on(async {
        let owner = LocalApiOwner::start(profile.to_path_buf())
            .await
            .expect("start owner for credential create");
        let id = create_scoped_credential_at(&owner.base_url(), profile, scopes, token_path).await;
        owner.shutdown().await;
        id
    })
}

async fn create_scoped_credential_at(
    base_url: &str,
    profile: &Path,
    scopes: &[&str],
    token_path: &Path,
) -> String {
    let host = base_url
        .trim_start_matches("http://")
        .trim_start_matches("https://");
    let id = Uuid::now_v7();
    let token = mint_automation_token(&id);
    let body = json!({
        "id": id.to_string(),
        "label": "mcp-agent",
        "scopes": scopes,
        "token": token,
    });
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let response = client
        .post(format!("{base_url}/api/v1/auth/credentials"))
        .header("Host", host)
        .header(
            "Authorization",
            format!("Bearer {}", operator_token(profile)),
        )
        .header("Idempotency-Key", Uuid::now_v7().to_string())
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .expect("create credential");
    assert!(
        response.status().is_success(),
        "create credential failed: {}",
        response.status()
    );
    // Never print the token; tests only keep it on disk for MCP --credential-file.
    fs::write(token_path, format!("{token}\n")).unwrap();
    id.to_string()
}

fn create_scoped_credential_on_url(
    base_url: &str,
    profile: &Path,
    scopes: &[&str],
    token_path: &Path,
) -> String {
    runtime().block_on(create_scoped_credential_at(
        base_url, profile, scopes, token_path,
    ))
}

fn revoke_credential(profile: &Path, base_url: &str, credential_id: &str) {
    let rt = runtime();
    rt.block_on(async {
        let host = base_url.trim_start_matches("http://");
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let response = client
            .delete(format!(
                "{base_url}/api/v1/auth/credentials/{credential_id}"
            ))
            .header("Host", host)
            .header(
                "Authorization",
                format!("Bearer {}", operator_token(profile)),
            )
            .send()
            .await
            .expect("revoke credential");
        assert!(
            response.status().is_success(),
            "revoke failed: {}",
            response.status()
        );
    });
}

fn wait_for_runtime(profile: &Path) -> String {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if let Ok(raw) = fs::read_to_string(profile.join("runtime.json"))
            && let Ok(runtime) = serde_json::from_str::<Value>(&raw)
            && let Some(address) = runtime["address"].as_str()
        {
            return format!("http://{address}");
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    panic!("runtime.json not published");
}

fn drain_stdout(mut reader: BufReader<ChildStdout>) {
    std::thread::spawn(move || {
        let mut sink = String::new();
        let _ = reader.read_to_string(&mut sink);
    });
}

fn tool_names(response: &Value) -> Vec<String> {
    response["result"]["tools"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|tool| tool["name"].as_str().map(str::to_owned))
        .collect()
}

fn assert_no_operator_tools(names: &[String]) {
    for forbidden in [
        "rotate_token",
        "restore_backup",
        "list_automation_credentials",
        "revoke_automation_credential",
        "get_diagnostics",
        "clear_diagnostics",
        "get_allowed_hosts",
        "put_allowed_hosts",
        "get_maintenance_status",
        "get_recovery_status",
        "junban_status",
        "get_principal",
    ] {
        assert!(
            !names.iter().any(|name| name == forbidden),
            "operator/internal tool leaked: {forbidden}; names={names:?}"
        );
    }
}

fn extract_task_id(call: &Value) -> String {
    let created = &call["result"]["structuredContent"];
    let candidates = [
        created.pointer("/event/primary/id").and_then(Value::as_str),
        created
            .pointer("/event/snapshot/task/id")
            .and_then(Value::as_str),
        created.pointer("/event/entity_id").and_then(Value::as_str),
        created.pointer("/task/id").and_then(Value::as_str),
        created
            .pointer("/event/affected/task_ids/0")
            .and_then(Value::as_str),
    ];
    for candidate in candidates.into_iter().flatten() {
        if uuid::Uuid::parse_str(candidate).is_ok() {
            return candidate.to_owned();
        }
    }
    panic!("missing task id in {call}");
}

#[test]
fn initialize_capabilities_tools_resources_prompts_and_eof_cleanup() {
    let root = unique_temp("full");
    let profile = root.join("profile");
    write_operator_token(&profile);

    let (mut child, mut stdin, mut reader) = spawn_mcp_local(&profile);
    let deadline = Instant::now() + Duration::from_secs(45);
    let init = initialize(&mut stdin, &mut reader, deadline);
    let caps = &init["result"]["capabilities"];
    assert!(caps.get("tools").is_some(), "{init}");
    assert!(caps.get("resources").is_some(), "{init}");
    assert!(caps.get("prompts").is_some(), "{init}");

    let tools = rpc(
        &mut stdin,
        &mut reader,
        deadline,
        2,
        "tools/list",
        json!({}),
    );
    let names = tool_names(&tools);
    assert!(names.contains(&"list_tasks".to_owned()), "{names:?}");
    assert!(names.contains(&"create_task".to_owned()), "{names:?}");
    assert!(names.contains(&"create_backup".to_owned()), "{names:?}");
    assert_no_operator_tools(&names);

    let create_task = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == "create_task")
        .unwrap();
    assert!(create_task.get("inputSchema").is_some());
    assert!(create_task.get("outputSchema").is_some());
    assert_eq!(create_task["annotations"]["openWorldHint"], false);
    assert_eq!(create_task["annotations"]["readOnlyHint"], false);

    let call = rpc(
        &mut stdin,
        &mut reader,
        deadline,
        3,
        "tools/call",
        json!({
            "name": "create_task",
            "arguments": {"title": "Wave 3 MCP task"}
        }),
    );
    assert_eq!(call["result"]["isError"], false, "{call}");
    assert!(call["result"]["structuredContent"].is_object());
    let task_id = extract_task_id(&call);

    let unknown = rpc(
        &mut stdin,
        &mut reader,
        deadline,
        4,
        "tools/call",
        json!({
            "name": "rotate_token",
            "arguments": {"write_token": "/tmp/x", "confirm": "rotate-token"}
        }),
    );
    assert!(unknown.get("error").is_some(), "{unknown}");
    assert_eq!(unknown["error"]["code"], -32602);

    let resources = rpc(
        &mut stdin,
        &mut reader,
        deadline,
        5,
        "resources/list",
        json!({}),
    );
    let uris: Vec<_> = resources["result"]["resources"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|resource| resource["uri"].as_str().map(str::to_owned))
        .collect();
    for expected in [
        "junban://profile",
        "junban://sync",
        "junban://today",
        "junban://projects",
        "junban://tags",
        "junban://settings",
    ] {
        assert!(uris.iter().any(|uri| uri == expected), "{uris:?}");
    }
    assert!(!uris.iter().any(|uri| uri == "junban://status"));

    let templates = rpc(
        &mut stdin,
        &mut reader,
        deadline,
        6,
        "resources/templates/list",
        json!({}),
    );
    let template_uris: Vec<_> = templates["result"]["resourceTemplates"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|item| item["uriTemplate"].as_str().map(str::to_owned))
        .collect();
    assert!(
        template_uris
            .iter()
            .any(|uri| uri == "junban://tasks/{task_id}")
    );
    assert!(
        template_uris
            .iter()
            .any(|uri| uri == "junban://projects/{project_id}")
    );

    let read_profile = rpc(
        &mut stdin,
        &mut reader,
        deadline,
        7,
        "resources/read",
        json!({"uri": "junban://profile"}),
    );
    assert!(
        read_profile["result"]["contents"].is_array(),
        "{read_profile}"
    );

    let read_task = rpc(
        &mut stdin,
        &mut reader,
        deadline,
        8,
        "resources/read",
        json!({"uri": format!("junban://tasks/{task_id}")}),
    );
    assert!(read_task["result"]["contents"].is_array(), "{read_task}");

    let bad_uri = rpc(
        &mut stdin,
        &mut reader,
        deadline,
        9,
        "resources/read",
        json!({"uri": "junban://profile?x=1"}),
    );
    assert!(bad_uri.get("error").is_some(), "{bad_uri}");

    let prompts = rpc(
        &mut stdin,
        &mut reader,
        deadline,
        10,
        "prompts/list",
        json!({}),
    );
    let prompt_names: Vec<_> = prompts["result"]["prompts"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|prompt| prompt["name"].as_str().map(str::to_owned))
        .collect();
    for expected in ["plan-my-day", "triage-inbox", "weekly-review"] {
        assert!(prompt_names.iter().any(|name| name == expected));
    }

    let plan = rpc(
        &mut stdin,
        &mut reader,
        deadline,
        11,
        "prompts/get",
        json!({
            "name": "plan-my-day",
            "arguments": {"date": "2030-01-15"}
        }),
    );
    assert!(plan["result"]["messages"].is_array(), "{plan}");
    let plan_text = plan["result"]["messages"][0]["content"]["text"]
        .as_str()
        .or_else(|| plan["result"]["messages"][0]["content"].as_str())
        .unwrap_or_default();
    assert!(
        plan_text.contains("2030-01-15") && plan_text.contains("day_tasks"),
        "selected date must appear in plan-my-day backing context: {plan_text}"
    );

    let bad_prompt_args = rpc(
        &mut stdin,
        &mut reader,
        deadline,
        12,
        "prompts/get",
        json!({
            "name": "plan-my-day",
            "arguments": {"nope": "1"}
        }),
    );
    assert!(bad_prompt_args.get("error").is_some(), "{bad_prompt_args}");

    let impossible_date = rpc(
        &mut stdin,
        &mut reader,
        deadline,
        13,
        "prompts/get",
        json!({
            "name": "plan-my-day",
            "arguments": {"date": "2030-02-31"}
        }),
    );
    assert!(
        impossible_date.get("error").is_some(),
        "invalid calendar date must reject: {impossible_date}"
    );

    let weekly = rpc(
        &mut stdin,
        &mut reader,
        deadline,
        14,
        "prompts/get",
        json!({
            "name": "weekly-review",
            "arguments": {"date": "2030-01-15"}
        }),
    );
    assert!(weekly["result"]["messages"].is_array(), "{weekly}");
    let weekly_text = weekly["result"]["messages"][0]["content"]["text"]
        .as_str()
        .or_else(|| weekly["result"]["messages"][0]["content"].as_str())
        .unwrap_or_default();
    assert!(
        weekly_text.contains("week_start") && weekly_text.contains("week_end"),
        "weekly-review context must include planning week bounds: {weekly_text}"
    );

    let tool_error = rpc(
        &mut stdin,
        &mut reader,
        deadline,
        15,
        "tools/call",
        json!({
            "name": "create_task",
            "arguments": {}
        }),
    );
    assert_eq!(tool_error["result"]["isError"], true, "{tool_error}");
    assert!(tool_error["result"]["structuredContent"]["error"].is_object());

    drop(stdin);
    let status = child.wait().expect("wait");
    assert!(status.success(), "mcp exit {status}");
    assert_lock_acquirable(&profile);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn read_only_and_write_only_credentials_filter_tools_and_prompts() {
    let root = unique_temp("scopes");
    let profile = root.join("profile");
    write_operator_token(&profile);

    let read_token_path = root.join("read.token");
    let write_token_path = root.join("write.token");
    // Mint both credentials under one owner. Repeated owner churn is not part of
    // this scope-filter contract and can introduce an unrelated lock race under
    // a heavily parallel workspace test run.
    runtime().block_on(async {
        let owner = LocalApiOwner::start(profile.clone())
            .await
            .expect("start owner for credential create");
        let base_url = owner.base_url();
        let _read_id =
            create_scoped_credential_at(&base_url, &profile, &["read"], &read_token_path).await;
        let _write_id =
            create_scoped_credential_at(&base_url, &profile, &["write"], &write_token_path).await;
        owner.shutdown().await;
    });

    let (mut holder_child, holder_stdin, holder_reader) = spawn_mcp_local(&profile);
    let deadline = Instant::now() + Duration::from_secs(45);
    // Initialize holder so the temporary owner stays warm.
    let mut holder_stdin = holder_stdin;
    let mut holder_reader = holder_reader;
    let _ = initialize(&mut holder_stdin, &mut holder_reader, deadline);
    drain_stdout(holder_reader);
    let base_url = wait_for_runtime(&profile);

    let (mut read_child, mut read_stdin, mut read_reader) =
        spawn_mcp_explicit(&profile, &base_url, &read_token_path);
    let _ = initialize(&mut read_stdin, &mut read_reader, deadline);
    let read_tools = rpc(
        &mut read_stdin,
        &mut read_reader,
        deadline,
        2,
        "tools/list",
        json!({}),
    );
    let read_names = tool_names(&read_tools);
    assert!(
        read_names.contains(&"list_tasks".to_owned()),
        "{read_names:?}"
    );
    assert!(
        !read_names.contains(&"create_task".to_owned()),
        "{read_names:?}"
    );
    assert!(
        !read_names.contains(&"create_backup".to_owned()),
        "{read_names:?}"
    );
    assert_no_operator_tools(&read_names);
    let read_prompts = rpc(
        &mut read_stdin,
        &mut read_reader,
        deadline,
        3,
        "prompts/list",
        json!({}),
    );
    let read_prompt_names: Vec<_> = read_prompts["result"]["prompts"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|prompt| prompt["name"].as_str().map(str::to_owned))
        .collect();
    assert!(read_prompt_names.contains(&"plan-my-day".to_owned()));
    assert!(read_prompt_names.contains(&"triage-inbox".to_owned()));
    assert!(read_prompt_names.contains(&"weekly-review".to_owned()));

    let (mut write_child, mut write_stdin, mut write_reader) =
        spawn_mcp_explicit(&profile, &base_url, &write_token_path);
    let _ = initialize(&mut write_stdin, &mut write_reader, deadline);
    let write_tools = rpc(
        &mut write_stdin,
        &mut write_reader,
        deadline,
        2,
        "tools/list",
        json!({}),
    );
    let write_names = tool_names(&write_tools);
    assert!(
        write_names.contains(&"create_task".to_owned()),
        "{write_names:?}"
    );
    assert!(
        !write_names.contains(&"list_tasks".to_owned()),
        "{write_names:?}"
    );
    assert!(
        !write_names.contains(&"create_backup".to_owned()),
        "{write_names:?}"
    );
    assert_no_operator_tools(&write_names);
    let write_resources = rpc(
        &mut write_stdin,
        &mut write_reader,
        deadline,
        3,
        "resources/list",
        json!({}),
    );
    assert_eq!(
        write_resources["result"]["resources"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    let write_prompts = rpc(
        &mut write_stdin,
        &mut write_reader,
        deadline,
        4,
        "prompts/list",
        json!({}),
    );
    assert_eq!(
        write_prompts["result"]["prompts"].as_array().unwrap().len(),
        0
    );

    // Data-only credential: export/backup tools, no read/write tools/resources/prompts.
    let data_token_path = root.join("data.token");
    let _data_id =
        create_scoped_credential_on_url(&base_url, &profile, &["data"], &data_token_path);
    let (mut data_child, mut data_stdin, mut data_reader) =
        spawn_mcp_explicit(&profile, &base_url, &data_token_path);
    let _ = initialize(&mut data_stdin, &mut data_reader, deadline);
    let data_tools = rpc(
        &mut data_stdin,
        &mut data_reader,
        deadline,
        2,
        "tools/list",
        json!({}),
    );
    let data_names = tool_names(&data_tools);
    assert!(
        data_names.contains(&"export_tasks".to_owned()),
        "{data_names:?}"
    );
    assert!(
        data_names.contains(&"create_backup".to_owned()),
        "{data_names:?}"
    );
    assert!(
        !data_names.contains(&"list_tasks".to_owned()),
        "{data_names:?}"
    );
    assert!(
        !data_names.contains(&"create_task".to_owned()),
        "{data_names:?}"
    );
    assert_no_operator_tools(&data_names);
    let data_resources = rpc(
        &mut data_stdin,
        &mut data_reader,
        deadline,
        3,
        "resources/list",
        json!({}),
    );
    assert_eq!(
        data_resources["result"]["resources"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    let data_prompts = rpc(
        &mut data_stdin,
        &mut data_reader,
        deadline,
        4,
        "prompts/list",
        json!({}),
    );
    assert_eq!(
        data_prompts["result"]["prompts"].as_array().unwrap().len(),
        0
    );

    drop(read_stdin);
    drop(write_stdin);
    drop(data_stdin);
    drop(holder_stdin);
    let _ = read_child.wait();
    let _ = write_child.wait();
    let _ = data_child.wait();
    let _ = holder_child.kill();
    let _ = holder_child.wait();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn staged_backup_emits_start_and_completion_progress() {
    let root = unique_temp("progress");
    let profile = root.join("profile");
    write_operator_token(&profile);
    let backup_path = root.join("profile.junban-backup");

    let (mut child, mut stdin, mut reader) = spawn_mcp_local(&profile);
    let deadline = Instant::now() + Duration::from_secs(45);
    let _ = initialize(&mut stdin, &mut reader, deadline);

    write_rpc(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 40,
            "method": "tools/call",
            "params": {
                "name": "create_backup",
                "arguments": {
                    "output_path": backup_path.to_str().unwrap()
                },
                "_meta": {"progressToken": "backup-progress"}
            }
        }),
    );

    let mut saw_start = false;
    let mut saw_complete = false;
    let mut saw_result = false;
    while Instant::now() < deadline && !(saw_result && saw_start && saw_complete) {
        let frame = read_rpc_line(&mut reader, deadline);
        if frame.get("id") == Some(&json!(40)) {
            assert_eq!(frame["result"]["isError"], false, "{frame}");
            assert!(frame["result"]["structuredContent"].is_object());
            saw_result = true;
            continue;
        }
        if frame.get("method") == Some(&json!("notifications/progress")) {
            let params = &frame["params"];
            assert_eq!(params["progressToken"], "backup-progress");
            let progress = params["progress"].as_f64().unwrap_or(-1.0);
            if (progress - 0.0).abs() < f64::EPSILON {
                saw_start = true;
            }
            if (progress - 1.0).abs() < f64::EPSILON {
                saw_complete = true;
            }
        }
    }
    assert!(saw_start, "missing start progress notification");
    assert!(saw_complete, "missing completion progress notification");
    assert!(saw_result, "missing create_backup result");
    assert!(backup_path.exists(), "backup artifact missing");

    drop(stdin);
    let status = child.wait().expect("wait");
    assert!(status.success(), "mcp exit {status}");
    fs::remove_dir_all(root).unwrap();
}

/// P5-API-015: invalid staged tools must not emit start progress after local validation fails.
#[test]
fn invalid_staged_tools_emit_zero_progress_frames() {
    let root = unique_temp("progress-invalid");
    let profile = root.join("profile");
    write_operator_token(&profile);

    let (mut child, mut stdin, mut reader) = spawn_mcp_local(&profile);
    let deadline = Instant::now() + Duration::from_secs(45);
    let _ = initialize(&mut stdin, &mut reader, deadline);

    write_rpc(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 41,
            "method": "tools/call",
            "params": {
                "name": "create_backup",
                "arguments": {},
                "_meta": {"progressToken": "backup-invalid"}
            }
        }),
    );
    write_rpc(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 42,
            "method": "tools/call",
            "params": {
                "name": "export_tasks",
                "arguments": {"format": "json"},
                "_meta": {"progressToken": "export-invalid"}
            }
        }),
    );

    let mut saw_backup = false;
    let mut saw_export = false;
    let mut progress_frames = 0usize;
    while Instant::now() < deadline && !(saw_backup && saw_export) {
        let frame = read_rpc_line(&mut reader, deadline);
        if frame.get("method") == Some(&json!("notifications/progress")) {
            progress_frames += 1;
            continue;
        }
        if frame.get("id") == Some(&json!(41)) {
            assert_eq!(frame["result"]["isError"], true, "{frame}");
            assert_eq!(
                frame["result"]["structuredContent"]["error"]["code"], "missing_input_field",
                "{frame}"
            );
            saw_backup = true;
            continue;
        }
        if frame.get("id") == Some(&json!(42)) {
            assert_eq!(frame["result"]["isError"], true, "{frame}");
            assert_eq!(
                frame["result"]["structuredContent"]["error"]["code"], "missing_input_field",
                "{frame}"
            );
            saw_export = true;
        }
    }
    assert!(saw_backup, "missing invalid create_backup result");
    assert!(saw_export, "missing invalid export_tasks result");
    assert_eq!(
        progress_frames, 0,
        "invalid staged tools must emit zero progress frames"
    );

    drop(stdin);
    let status = child.wait().expect("wait");
    assert!(status.success(), "mcp exit {status}");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn revocation_fail_closes_live_session() {
    let root = unique_temp("revoke");
    let profile = root.join("profile");
    write_operator_token(&profile);
    let token_path = root.join("agent.token");
    let credential_id = create_scoped_credential(&profile, &["read", "write"], &token_path);

    let (mut holder_child, mut holder_stdin, mut holder_reader) = spawn_mcp_local(&profile);
    let deadline = Instant::now() + Duration::from_secs(45);
    let _ = initialize(&mut holder_stdin, &mut holder_reader, deadline);
    drain_stdout(holder_reader);
    let base_url = wait_for_runtime(&profile);

    let (mut child, mut stdin, mut reader) = spawn_mcp_explicit(&profile, &base_url, &token_path);
    let _ = initialize(&mut stdin, &mut reader, deadline);
    let listed = rpc(
        &mut stdin,
        &mut reader,
        deadline,
        2,
        "tools/list",
        json!({}),
    );
    assert!(!tool_names(&listed).is_empty());

    revoke_credential(&profile, &base_url, &credential_id);

    let after = rpc(
        &mut stdin,
        &mut reader,
        deadline,
        3,
        "tools/list",
        json!({}),
    );
    let failed = after.get("error").is_some()
        || after["result"]["tools"]
            .as_array()
            .map(|tools| tools.is_empty())
            .unwrap_or(true);
    assert!(failed, "expected fail-closed list after revoke: {after}");

    let call = rpc(
        &mut stdin,
        &mut reader,
        deadline,
        4,
        "tools/call",
        json!({"name": "list_tasks", "arguments": {}}),
    );
    let call_failed = call.get("error").is_some()
        || call["result"]["isError"] == true
        || call["result"]["structuredContent"]["error"].is_object();
    assert!(
        call_failed,
        "expected fail-closed call after revoke: {call}"
    );

    drop(stdin);
    drop(holder_stdin);
    let _ = child.wait();
    let _ = holder_child.kill();
    let _ = holder_child.wait();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn cancellation_keeps_stdout_protocol_only() {
    let root = unique_temp("cancel");
    let profile = root.join("profile");
    write_operator_token(&profile);
    let (mut child, mut stdin, mut reader) = spawn_mcp_local(&profile);
    let deadline = Instant::now() + Duration::from_secs(30);
    let _ = initialize(&mut stdin, &mut reader, deadline);

    write_rpc(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 99,
            "method": "tools/call",
            "params": {
                "name": "list_tasks",
                "arguments": {},
                "_meta": {"progressToken": "cancel-test"}
            }
        }),
    );
    write_rpc(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "method": "notifications/cancelled",
            "params": {"requestId": 99, "reason": "test"}
        }),
    );

    // Follow with a fresh request so we can bound the wait without blocking forever
    // if the cancelled call suppresses its response.
    write_rpc(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 100,
            "method": "tools/list",
            "params": {}
        }),
    );

    let mut saw_list = false;
    let drain_deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < drain_deadline && !saw_list {
        let value = read_rpc_line(&mut reader, drain_deadline);
        assert_eq!(value["jsonrpc"], "2.0");
        assert!(!value.to_string().contains(&"77".repeat(32)));
        assert!(!value.to_string().contains("Bearer "));
        if value["id"] == 100 {
            saw_list = true;
            assert!(
                value.get("result").is_some() || value.get("error").is_some(),
                "{value}"
            );
        }
    }
    assert!(saw_list, "expected tools/list response after cancellation");

    drop(stdin);
    let status = child.wait().expect("wait");
    assert!(status.success(), "mcp exit {status}");
    assert_lock_acquirable(&profile);
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn sigterm_releases_owner_lock() {
    let root = unique_temp("sigterm");
    let profile = root.join("profile");
    write_operator_token(&profile);

    let mut child = Command::new(env!("CARGO_BIN_EXE_junban-mcp"))
        .args(["--data-dir", profile.to_str().unwrap()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let stdin = child.stdin.take().unwrap();
    let _ = wait_for_runtime(&profile);

    let pid = child.id();
    let status = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status()
        .unwrap();
    assert!(status.success());
    drop(stdin);
    let _ = child.wait();

    let reopen_deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if try_lock_once(&profile) {
            break;
        }
        assert!(
            Instant::now() < reopen_deadline,
            "lock not released after SIGTERM"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn abrupt_kill_releases_owner_lock() {
    let root = unique_temp("kill");
    let profile = root.join("profile");
    write_operator_token(&profile);

    let mut child = Command::new(env!("CARGO_BIN_EXE_junban-mcp"))
        .args(["--data-dir", profile.to_str().unwrap()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let stdin = child.stdin.take().unwrap();
    let _ = wait_for_runtime(&profile);

    let pid = child.id();
    let kill_status = Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()
        .unwrap();
    assert!(kill_status.success());
    drop(stdin);
    let _ = child.wait();

    let reopen_deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if try_lock_once(&profile) {
            break;
        }
        assert!(
            Instant::now() < reopen_deadline,
            "lock not released after kill"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
    fs::remove_dir_all(root).unwrap();
}

fn assert_lock_acquirable(profile: &Path) {
    #[cfg(unix)]
    {
        assert!(try_lock_once(profile), "lock should be free");
    }
    #[cfg(not(unix))]
    {
        assert!(
            !profile.join("runtime.json").exists(),
            "runtime metadata must be removed on EOF"
        );
    }
}

#[cfg(unix)]
fn try_lock_once(profile: &Path) -> bool {
    use fs4::FileExt;
    use std::fs::OpenOptions;
    use std::os::unix::fs::OpenOptionsExt;
    let lock_path = profile.join(LOCK_FILE);
    let Ok(file) = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(&lock_path)
    else {
        return false;
    };
    match FileExt::try_lock(&file) {
        Ok(()) => {
            let _ = FileExt::unlock(&file);
            true
        }
        Err(_) => false,
    }
}
