//! Process tests for concise human CLI rendering (P5-DOG-001).

use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

use junban_server::TOKEN_FILE;
use serde_json::Value;

fn unique_temp(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "junban-cli-human-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

/// 64-hex operator token. Randomized so fixtures cannot be grepped as constants.
fn random_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().as_simple(),
        uuid::Uuid::new_v4().as_simple()
    )
}

fn write_token(profile: &Path) -> String {
    let token = random_token();
    fs::create_dir_all(profile).unwrap();
    fs::write(profile.join(TOKEN_FILE), format!("{token}\n")).unwrap();
    token
}

fn junban() -> Command {
    Command::new(env!("CARGO_BIN_EXE_junban"))
}

/// Assert `haystack` does not contain `secret` without echoing either into panic text.
fn assert_no_secret(haystack: &str, secret: &str, where_: &str) {
    assert!(
        !haystack.contains(secret),
        "{where_} contained credential material"
    );
    assert!(
        !haystack.contains("Bearer "),
        "{where_} contained a bearer prefix"
    );
}

fn run_json(profile: &Path, token: &str, args: &[&str]) -> (i32, Value, String) {
    // Ordinary JSON commands must not echo credentials. Callers that intentionally
    // place secrets inside import payloads (to prove human redaction) use
    // `run_json_allowing_payload_secrets` instead.
    let (code, value, stderr) = run_json_allowing_payload_secrets(profile, args);
    let encoded = serde_json::to_string(&value).unwrap_or_default();
    assert_no_secret(&encoded, token, "json stdout");
    assert_no_secret(&stderr, token, "json stderr");
    (code, value, stderr)
}

fn run_json_allowing_payload_secrets(profile: &Path, args: &[&str]) -> (i32, Value, String) {
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
        "stdout must be one JSON value; stderr_len={}",
        stderr.len()
    );
    let value: Value = serde_json::from_str(trimmed).unwrap_or_else(|_| {
        panic!(
            "stdout JSON decode failed; stdout_len={} stderr_len={}",
            stdout.len(),
            stderr.len()
        )
    });
    (code, value, stderr)
}

fn run_human(profile: &Path, token: &str, args: &[&str]) -> (i32, String, String) {
    let output = junban()
        .args(["--data-dir", profile.to_str().unwrap()])
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("spawn junban");
    let stdout = String::from_utf8(output.stdout).unwrap();
    let stderr = String::from_utf8(output.stderr).unwrap();
    let code = output.status.code().unwrap_or(1);
    // Never format stdout/stderr/token into panic text — they may carry secrets.
    assert_no_secret(&stdout, token, "human stdout");
    assert_no_secret(&stderr, token, "human stderr");
    (code, stdout, stderr)
}

fn assert_bounded_human(stdout: &str) {
    let trimmed = stdout.trim_end_matches('\n');
    assert!(!trimmed.is_empty(), "expected human stdout");
    assert!(
        !trimmed.trim_start().starts_with('{'),
        "human output must not start with JSON object (len={})",
        trimmed.len()
    );
    assert!(
        !trimmed.contains("\"snapshot\""),
        "human output must not dump snapshot JSON (len={})",
        trimmed.len()
    );
    assert!(
        trimmed.len() < 4_096,
        "human output unexpectedly large ({} bytes)",
        trimmed.len()
    );
}

fn mutation_ids(value: &Value) -> (String, String, String) {
    let event = value
        .get("event")
        .unwrap_or_else(|| panic!("missing event: {value}"));
    let operation = event["operation_id"]
        .as_str()
        .expect("operation_id")
        .to_owned();
    let resource_id = event
        .pointer("/primary/id")
        .and_then(Value::as_str)
        .or_else(|| event.pointer("/snapshot/task/id").and_then(Value::as_str))
        .or_else(|| {
            event
                .pointer("/snapshot/project/id")
                .and_then(Value::as_str)
        })
        .or_else(|| event.pointer("/snapshot/tag/id").and_then(Value::as_str))
        .expect("resource id")
        .to_owned();
    let event_type = event["event_type"].as_str().expect("event_type").to_owned();
    (event_type, resource_id, operation)
}

#[test]
fn ergonomic_human_output_is_concise_and_json_unchanged() {
    let root = unique_temp("render");
    let profile = root.join("profile");
    let token = write_token(&profile);

    let (code, project_json, _) =
        run_json(&profile, &token, &["project", "add", "Automation Dogfood"]);
    assert_eq!(code, 0, "project add json failed");
    let (event_type, project_id, project_op) = mutation_ids(&project_json);
    assert!(project_json.pointer("/event/snapshot").is_some());

    let (code, project_human, _) =
        run_human(&profile, &token, &["project", "add", "Human Project"]);
    assert_eq!(code, 0, "project add human failed");
    assert_bounded_human(&project_human);
    assert_eq!(project_human.lines().count(), 1);
    assert!(project_human.contains("project.created") || project_human.contains(&event_type));
    assert!(project_human.contains("revision="));
    assert!(project_human.contains("operation="));
    let human_project_op = project_human
        .split_whitespace()
        .find_map(|part| part.strip_prefix("operation="))
        .expect("operation id on human mutation line");
    assert!(uuid::Uuid::parse_str(human_project_op).is_ok());

    let (code, task_json, _) = run_json(
        &profile,
        &token,
        &["task", "add", "Ship dogfood", "--due-date", "2030-01-15"],
    );
    assert_eq!(code, 0, "task add json failed");
    let (_, task_id, task_op) = mutation_ids(&task_json);
    assert_eq!(task_json["event"]["operation_id"], task_op);

    let (code, task_human, _) = run_human(
        &profile,
        &token,
        &["task", "add", "Human task", "--priority", "2"],
    );
    assert_eq!(code, 0, "task add human failed");
    assert_bounded_human(&task_human);
    assert_eq!(task_human.lines().count(), 1);
    assert!(task_human.contains("task.created") || task_human.contains("task="));
    assert!(task_human.contains("operation="));
    let human_task_id = task_human
        .split_whitespace()
        .find_map(|part| part.strip_prefix("task="))
        .expect("task id on human mutation line");
    assert!(uuid::Uuid::parse_str(human_task_id).is_ok());

    let (code, list_human, _) = run_human(&profile, &token, &["task", "list"]);
    assert_eq!(code, 0, "task list human failed");
    assert_bounded_human(&list_human);
    assert!(list_human.contains(&task_id) || list_human.contains(human_task_id));
    assert!(list_human.contains("Ship dogfood") || list_human.contains("Human task"));
    assert!(!list_human.contains("\"tasks\""));

    let (code, detail_human, _) = run_human(&profile, &token, &["task", "get", &task_id]);
    assert_eq!(code, 0, "task get human failed");
    assert_bounded_human(&detail_human);
    assert!(detail_human.contains(&task_id));
    assert!(detail_human.contains("Ship dogfood"));
    assert!(detail_human.contains("status:"));

    let (code, _, _) = run_json(&profile, &token, &["tag", "add", "dogfood"]);
    assert_eq!(code, 0);
    let (code, tag_list, _) = run_human(&profile, &token, &["tag", "list"]);
    assert_eq!(code, 0, "tag list failed");
    assert_bounded_human(&tag_list);
    assert!(tag_list.contains("dogfood"));
    assert!(!tag_list.contains("Automation Dogfood"));
    assert!(!tag_list.contains("templates"));
    assert!(!tag_list.contains("saved_filters"));

    let (code, project_list, _) = run_human(&profile, &token, &["project", "list"]);
    assert_eq!(code, 0, "project list failed");
    assert_bounded_human(&project_list);
    assert!(project_list.contains("Automation Dogfood") || project_list.contains("Human Project"));
    assert!(!project_list.contains("dogfood") || project_list.contains("projects"));
    assert!(!project_list.contains("templates"));
    assert!(!project_list.contains("saved_filters"));

    // Reminder list is empty until remind_at is set; still must stay concise.
    let (code, reminder_list, _) = run_human(
        &profile,
        &token,
        &["reminder", "list", "--task-id", &task_id],
    );
    assert_eq!(code, 0, "reminder list failed");
    assert_bounded_human(&reminder_list);
    assert!(
        reminder_list.contains("no reminders") || reminder_list.contains("reminders"),
        "reminder list missing expected summary"
    );

    let (code, plan_human, _) =
        run_human(&profile, &token, &["plan", "daily", "--date", "2030-01-15"]);
    assert_eq!(code, 0, "daily plan failed");
    assert_bounded_human(&plan_human);
    assert!(plan_human.contains("daily plan"));
    assert!(!plan_human.contains("focus_task_ids"));

    // P5-API-016: weekly reviews carry overdue_tasks and must not become a daily plan.
    let (code, _, _) = run_json(
        &profile,
        &token,
        &[
            "task",
            "add",
            "Overdue for weekly",
            "--due-date",
            "2029-12-01",
            "--priority",
            "1",
        ],
    );
    assert_eq!(code, 0);
    let (code, weekly_human, _) = run_human(
        &profile,
        &token,
        &["plan", "weekly", "--date", "2030-01-15"],
    );
    assert_eq!(code, 0, "weekly plan failed");
    assert_bounded_human(&weekly_human);
    assert!(
        weekly_human.contains("weekly review"),
        "expected weekly review header"
    );
    assert!(
        !weekly_human.contains("daily plan"),
        "weekly must not be misclassified as daily"
    );
    assert!(
        weekly_human.contains("created=")
            && weekly_human.contains("completed=")
            && weekly_human.contains("rate="),
        "weekly must show real metrics"
    );

    // P5-API-016: end-of-day must render its own sections, not fall through.
    let (code, eod_human, _) = run_human(
        &profile,
        &token,
        &["plan", "end-of-day", "--date", "2030-01-15"],
    );
    assert_eq!(code, 0, "end-of-day failed");
    assert_bounded_human(&eod_human);
    assert!(
        eod_human.contains("end of day"),
        "expected end of day header"
    );
    assert!(
        eod_human.contains("wins")
            || eod_human.contains("carry over")
            || eod_human.contains("tomorrow"),
        "end-of-day must show review sections"
    );
    assert!(!eod_human.contains("daily plan"));

    // P5-API-016: empty eat-the-frog omits task and must still identify the command.
    let (code, frog_json, _) = run_json(
        &profile,
        &token,
        &["plan", "eat-the-frog", "--date", "2030-01-15"],
    );
    assert_eq!(code, 0, "eat-the-frog json failed");
    assert!(
        frog_json.get("task").is_none() || frog_json.get("task").is_some_and(Value::is_null),
        "expected empty selection in json fixture"
    );
    let (code, frog_human, _) = run_human(
        &profile,
        &token,
        &["plan", "eat-the-frog", "--date", "2030-01-15"],
    );
    assert_eq!(code, 0, "eat-the-frog human failed");
    assert_bounded_human(&frog_human);
    assert!(
        frog_human.contains("eat-the-frog: (none)"),
        "empty eat-the-frog must report none plainly"
    );
    assert!(frog_human.contains("revision="));
    assert!(!frog_human.contains("daily plan"));

    // P5-API-017: checked Markdown import preview must surface completion-loss warnings.
    let markdown_path = root.join("checked.md");
    fs::write(&markdown_path, "- [x] Already finished work\n").unwrap();
    let (code, preview_json, _) = run_json(
        &profile,
        &token,
        &[
            "data",
            "import-preview",
            "--format",
            "markdown",
            "--file",
            markdown_path.to_str().unwrap(),
        ],
    );
    assert_eq!(code, 0, "import-preview json failed");
    assert_eq!(preview_json["format"], "markdown");
    assert!(
        preview_json["warnings"].as_array().is_some_and(|warnings| {
            warnings.iter().any(|warning| {
                warning["message"]
                    .as_str()
                    .is_some_and(|message| message.contains("completion is not transferred"))
            })
        }),
        "expected completion-loss warning in json"
    );
    let (code, preview_human, _) = run_human(
        &profile,
        &token,
        &[
            "data",
            "import-preview",
            "--format",
            "markdown",
            "--file",
            markdown_path.to_str().unwrap(),
        ],
    );
    assert_eq!(code, 0, "import-preview human failed");
    assert_bounded_human(&preview_human);
    assert!(preview_human.contains("import preview"));
    assert!(
        preview_human.contains(
            "checked checkbox imported as a pending task (completion is not transferred)"
        ),
        "human import preview must show completion-loss warning text"
    );
    assert!(
        preview_human.contains("L1") || preview_human.contains("line"),
        "warning must include production line number"
    );

    let export_path = root.join("tasks.json");
    let (code, export_human, _) = run_human(
        &profile,
        &token,
        &[
            "data",
            "export",
            "--format",
            "json",
            "--output",
            export_path.to_str().unwrap(),
        ],
    );
    assert_eq!(code, 0, "export human failed");
    assert_bounded_human(&export_human);
    assert!(export_human.contains("wrote "));
    assert!(export_human.contains("bytes)"));
    assert!(export_path.is_file());

    // Strict JSON remains one value and still carries the full mutation snapshot.
    let (code, again, _) = run_json(&profile, &token, &["project", "add", "Json Still Full"]);
    assert_eq!(code, 0, "project add json follow-up failed");
    assert!(again.pointer("/event/snapshot").is_some());
    assert!(again.pointer("/event/operation_id").is_some());
    assert_eq!(
        again["event"]["primary"]["resource_type"].as_str(),
        Some("project")
    );
    let _ = project_id;
    let _ = project_op;

    // Strict JSON error shape is unchanged.
    let (code, err, _) = run_json(&profile, &token, &["task", "delete", &task_id]);
    assert_ne!(code, 0);
    assert_eq!(err["error"]["code"], "confirmation_required");

    fs::remove_dir_all(root).unwrap();
}

/// P5-API-017: human import-preview must not echo attacker-controlled warning
/// payloads (active access token as format label, multiline injection).
///
/// Panic/assert messages intentionally omit stdout/stderr/token contents.
#[test]
fn import_preview_human_redacts_token_and_line_injection_in_warnings() {
    let root = unique_temp("import-warn-redact");
    let profile = root.join("profile");
    let token = write_token(&profile);

    // Active profile token embedded as the unrecognized JSON format label.
    let token_label_path = root.join("token-label.json");
    let token_label_body = serde_json::json!({
        "format": token,
        "version": 1,
        "tasks": [{ "title": "Safe title" }]
    });
    fs::write(
        &token_label_path,
        serde_json::to_vec(&token_label_body).unwrap(),
    )
    .unwrap();

    // JSON may retain raw parser text (including payload-derived fragments); only
    // human rendering is required to redact. Do not secret-scan this JSON stdout.
    let (code, preview_json, _) = run_json_allowing_payload_secrets(
        &profile,
        &[
            "data",
            "import-preview",
            "--format",
            "json",
            "--file",
            token_label_path.to_str().unwrap(),
        ],
    );
    assert_eq!(code, 0, "token-label import-preview json failed");
    // Strict JSON still carries the raw parser warning (machine surface).
    assert!(
        preview_json["warnings"].as_array().is_some_and(|warnings| {
            warnings.iter().any(|warning| {
                warning["message"].as_str().is_some_and(|message| {
                    message.starts_with("unrecognized transfer format label")
                })
            })
        }),
        "json must retain unrecognized-format warning category"
    );

    let (code, preview_human, _) = run_human(
        &profile,
        &token,
        &[
            "data",
            "import-preview",
            "--format",
            "json",
            "--file",
            token_label_path.to_str().unwrap(),
        ],
    );
    assert_eq!(code, 0, "token-label import-preview human failed");
    assert_bounded_human(&preview_human);
    // run_human already asserts token absence; also require fixed guidance.
    assert!(
        preview_human.contains("unrecognized transfer format label (details redacted)"),
        "human warning must keep category with redacted details"
    );
    let warning_rows: Vec<_> = preview_human
        .lines()
        .filter(|line| line.trim_start().starts_with('L') && line.contains("redacted"))
        .collect();
    assert_eq!(
        warning_rows.len(),
        1,
        "token-label case must render exactly one warning row"
    );

    // Multiline injected format label must not create a physical injected line.
    let injected_marker = "INJECTED_PHYSICAL_LINE_SHOULD_NOT_APPEAR";
    let multiline_path = root.join("multiline-label.json");
    let multiline_label = format!("evil-label\n{injected_marker}");
    let multiline_body = serde_json::json!({
        "format": multiline_label,
        "version": 1,
        "tasks": [{ "title": "Another title" }]
    });
    fs::write(
        &multiline_path,
        serde_json::to_vec(&multiline_body).unwrap(),
    )
    .unwrap();

    let (code, multi_human, _) = run_human(
        &profile,
        &token,
        &[
            "data",
            "import-preview",
            "--format",
            "json",
            "--file",
            multiline_path.to_str().unwrap(),
        ],
    );
    assert_eq!(code, 0, "multiline-label import-preview human failed");
    assert_bounded_human(&multi_human);
    assert!(
        !multi_human.contains(injected_marker),
        "human stdout must not contain injected marker text"
    );
    assert!(
        multi_human.contains("unrecognized transfer format label (details redacted)"),
        "multiline case must keep fixed unrecognized-format guidance"
    );
    let multi_warning_rows: Vec<_> = multi_human
        .lines()
        .filter(|line| line.trim_start().starts_with('L') && line.contains("redacted"))
        .collect();
    assert_eq!(
        multi_warning_rows.len(),
        1,
        "multiline case must render exactly one warning row"
    );
    // No bare injected marker as its own physical line.
    assert!(
        multi_human
            .lines()
            .all(|line| line.trim() != injected_marker),
        "injected marker must not appear as its own stdout line"
    );

    fs::remove_dir_all(root).unwrap();
}
