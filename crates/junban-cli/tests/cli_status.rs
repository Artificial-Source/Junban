//! Process-level CLI status and JSON stdout purity tests.

use std::{
    fs,
    path::PathBuf,
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

use junban_server::TOKEN_FILE;
use junban_storage::ProfileOwner;
use serde_json::Value;

fn unique_temp(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "junban-cli-bin-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn write_token(profile: &std::path::Path) {
    fs::create_dir_all(profile).unwrap();
    fs::write(profile.join(TOKEN_FILE), format!("{}\n", "66".repeat(32))).unwrap();
}

#[test]
fn json_status_emits_exactly_one_json_value_and_releases_lock() {
    let root = unique_temp("json-status");
    let profile = root.join("profile");
    write_token(&profile);

    let output = Command::new(env!("CARGO_BIN_EXE_junban"))
        .args(["--json", "--data-dir", profile.to_str().unwrap(), "status"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("spawn junban");

    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    let trimmed = stdout.trim_end_matches('\n');
    assert!(
        !trimmed.contains('\n'),
        "stdout must be one JSON value, got {stdout:?}"
    );
    let value: Value = serde_json::from_str(trimmed).expect("stdout JSON");
    assert_eq!(value["status"], "ok");
    assert_eq!(value["mode"], "temporary_owner");
    assert!(value.get("instance_id").is_some());

    // stderr may contain tracing but must not be required empty; lock must release.
    let owner = ProfileOwner::open(&profile).expect("lock released after CLI exit");
    drop(owner);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn json_error_is_one_json_value_with_nonzero_exit() {
    let root = unique_temp("json-error");
    let profile = root.join("profile");
    fs::create_dir_all(&profile).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_junban"))
        .args([
            "--json",
            "--data-dir",
            profile.to_str().unwrap(),
            "--server",
            "http://example.com",
            "status",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("spawn junban");

    assert!(!output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    let trimmed = stdout.trim_end_matches('\n');
    assert!(
        !trimmed.contains('\n'),
        "error stdout must be one JSON value, got {stdout:?}"
    );
    let value: Value = serde_json::from_str(trimmed).expect("error JSON");
    assert_eq!(value["error"]["code"], "server_cleartext_forbidden");
    fs::remove_dir_all(root).unwrap();
}
