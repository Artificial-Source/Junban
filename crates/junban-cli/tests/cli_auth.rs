//! Process-level CLI credential management tests.

use std::{
    fs,
    path::PathBuf,
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use junban_server::TOKEN_FILE;
use junban_storage::ProfileOwner;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn unique_temp(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "junban-cli-auth-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn write_operator_token(profile: &std::path::Path) {
    fs::create_dir_all(profile).unwrap();
    fs::write(profile.join(TOKEN_FILE), format!("{}\n", "66".repeat(32))).unwrap();
}

fn junban() -> Command {
    Command::new(env!("CARGO_BIN_EXE_junban"))
}

async fn read_http_request(socket: &mut tokio::net::TcpStream) -> Vec<u8> {
    let mut request = Vec::new();
    let mut buffer = [0_u8; 1024];
    let header_end = loop {
        let read = socket.read(&mut buffer).await.unwrap();
        assert!(read > 0, "connection closed before request headers");
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
        assert!(read > 0, "connection closed before request body");
        request.extend_from_slice(&buffer[..read]);
    }
    request
}

fn request_body(request: &[u8]) -> &[u8] {
    let header_end = request
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .unwrap()
        + 4;
    &request[header_end..]
}

fn idempotency_key(request: &[u8]) -> String {
    String::from_utf8_lossy(request)
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("idempotency-key")
                .then(|| value.trim().to_owned())
        })
        .unwrap()
}

async fn write_health(socket: &mut tokio::net::TcpStream) {
    let body = r#"{"status":"ok","instance_id":"fake-auth"}"#;
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    socket.write_all(response.as_bytes()).await.unwrap();
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn assert_owner_only_protected_dacl(path: &std::path::Path) {
    use std::{mem, os::windows::io::AsRawHandle, ptr};
    use windows_sys::Win32::{
        Foundation::{ERROR_SUCCESS, LocalFree},
        Security::{
            ACCESS_ALLOWED_ACE, ACL, ACL_SIZE_INFORMATION, AclSizeInformation,
            Authorization::{GetSecurityInfo, SE_FILE_OBJECT},
            DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetAclInformation,
            GetSecurityDescriptorControl, INHERITED_ACE, OWNER_SECURITY_INFORMATION,
            PSECURITY_DESCRIPTOR, PSID, SE_DACL_PROTECTED,
        },
        Storage::FileSystem::FILE_ALL_ACCESS,
    };

    let file = fs::File::open(path).unwrap();
    let mut owner: PSID = ptr::null_mut();
    let mut dacl: *mut ACL = ptr::null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
    // SAFETY: all output pointers are valid for this live file handle.
    let status = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            &mut dacl,
            ptr::null_mut(),
            &mut descriptor,
        )
    };
    assert_eq!(status, ERROR_SUCCESS);
    assert!(!owner.is_null());
    assert!(!dacl.is_null());

    let mut control = 0_u16;
    let mut revision = 0_u32;
    // SAFETY: descriptor remains allocated until LocalFree below.
    assert_ne!(
        unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) },
        0
    );
    let mut info = ACL_SIZE_INFORMATION::default();
    // SAFETY: dacl is valid and info has the documented size.
    assert_ne!(
        unsafe {
            GetAclInformation(
                dacl,
                (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
                mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        },
        0
    );
    assert_eq!(info.AceCount, 1);
    let mut ace = ptr::null_mut();
    // SAFETY: the ACL reports exactly one ACE, so index zero is valid.
    assert_ne!(unsafe { GetAce(dacl, 0, &mut ace) }, 0);
    let ace = ace.cast::<ACCESS_ALLOWED_ACE>();
    // SAFETY: the sole ACE was verified as present and is an ACCESS_ALLOWED_ACE.
    let header = unsafe { (*ace).Header };
    assert_eq!(header.AceType, 0); // ACCESS_ALLOWED_ACE_TYPE
    assert_eq!(header.AceFlags & INHERITED_ACE as u8, 0);
    // SAFETY: `ace` points to the complete ACCESS_ALLOWED_ACE returned above.
    assert_eq!(unsafe { (*ace).Mask }, FILE_ALL_ACCESS);
    // SAFETY: SidStart begins the variable-width SID carried by this ACE.
    let ace_owner = unsafe { ptr::addr_of_mut!((*ace).SidStart).cast() };
    assert_ne!(unsafe { EqualSid(owner, ace_owner) }, 0);
    assert_ne!(control & SE_DACL_PROTECTED, 0);

    // SAFETY: GetSecurityInfo returned this LocalAlloc-backed descriptor.
    let _ = unsafe { LocalFree(descriptor) };
}

#[test]
fn auth_create_list_revoke_round_trip_keeps_token_off_stdout() {
    let root = unique_temp("round-trip");
    let profile = root.join("profile");
    write_operator_token(&profile);
    let token_path = root.join("agent.token");

    let create = junban()
        .args([
            "--json",
            "--data-dir",
            profile.to_str().unwrap(),
            "auth",
            "create",
            "--name",
            "  agent  ",
            "--scope",
            "read",
            "--scope",
            "write",
            "--write-token",
            token_path.to_str().unwrap(),
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("spawn create");
    assert!(
        create.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&create.stderr)
    );
    let stdout = String::from_utf8(create.stdout).unwrap();
    let stderr = String::from_utf8(create.stderr).unwrap();
    let report: Value = serde_json::from_str(stdout.trim()).unwrap();
    let id = report["id"].as_str().unwrap().to_owned();
    let token = fs::read_to_string(&token_path).unwrap();
    let token = token.trim().to_owned();
    assert!(!token.is_empty());
    #[cfg(windows)]
    assert_owner_only_protected_dacl(&token_path);
    assert!(!stdout.contains(&token));
    assert!(!stderr.contains(&token));
    assert!(!stdout.contains("jba_"));
    assert_eq!(report["token_path"], token_path.to_str().unwrap());
    assert_eq!(report["label"], "agent");
    assert!(report.get("token").is_none());

    // No overwrite.
    let overwrite = junban()
        .args([
            "--json",
            "--data-dir",
            profile.to_str().unwrap(),
            "auth",
            "create",
            "--name",
            "agent2",
            "--scope",
            "read",
            "--write-token",
            token_path.to_str().unwrap(),
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert!(!overwrite.status.success());
    let overwrite_out = String::from_utf8_lossy(&overwrite.stdout);
    let overwrite_err = String::from_utf8_lossy(&overwrite.stderr);
    assert!(!overwrite_out.contains(&token));
    assert!(!overwrite_err.contains(&token));
    assert_eq!(fs::read_to_string(&token_path).unwrap().trim(), token);

    let list = junban()
        .args([
            "--json",
            "--data-dir",
            profile.to_str().unwrap(),
            "auth",
            "list",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert!(list.status.success());
    let list_out = String::from_utf8(list.stdout).unwrap();
    assert!(!list_out.contains(&token));
    let listed: Value = serde_json::from_str(list_out.trim()).unwrap();
    assert_eq!(listed["credentials"].as_array().unwrap().len(), 1);
    assert_eq!(listed["credentials"][0]["id"], id);

    let revoke = junban()
        .args([
            "--json",
            "--data-dir",
            profile.to_str().unwrap(),
            "auth",
            "revoke",
            &id,
            "--confirm",
            "revoke",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert!(
        revoke.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&revoke.stderr)
    );
    let revoke_out = String::from_utf8(revoke.stdout).unwrap();
    assert!(!revoke_out.contains(&token));

    let list_after = junban()
        .args([
            "--json",
            "--data-dir",
            profile.to_str().unwrap(),
            "auth",
            "list",
        ])
        .output()
        .unwrap();
    let listed_after: Value =
        serde_json::from_str(String::from_utf8(list_after.stdout).unwrap().trim()).unwrap();
    assert!(listed_after["credentials"].as_array().unwrap().is_empty());

    // Lock released.
    let owner = ProfileOwner::open(&profile).unwrap();
    drop(owner);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn auth_create_validates_expiry_before_creating_token_file() {
    let root = unique_temp("cleanup");
    let profile = root.join("profile");
    write_operator_token(&profile);
    // A past expiry is rejected locally before the secret file or server request exists.
    let token_path = root.join("doomed.token");
    let create = junban()
        .args([
            "--json",
            "--data-dir",
            profile.to_str().unwrap(),
            "auth",
            "create",
            "--name",
            "agent",
            "--scope",
            "read",
            "--write-token",
            token_path.to_str().unwrap(),
            "--expires-at",
            "2000-01-01T00:00:00Z",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    assert!(!create.status.success());
    let stdout = String::from_utf8_lossy(&create.stdout);
    let stderr = String::from_utf8_lossy(&create.stderr);
    assert!(
        !token_path.exists(),
        "local validation must precede token-file creation"
    );
    assert!(!stdout.contains("jba_"));
    assert!(!stderr.contains("jba_"));
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn committed_truncated_response_reconciles_exact_request_and_keeps_token_file() {
    use junban_cli::auth::create_credential;
    use junban_cli::{Session, TargetOptions};
    use junban_server::AutomationScope;

    let root = unique_temp("reconcile");
    fs::create_dir_all(&root).unwrap();
    let credential_file = root.join("operator.token");
    fs::write(&credential_file, "operator-for-fake-server\n").unwrap();
    let output = root.join("automation.token");
    let requests = Arc::new(Mutex::new(Vec::<(Vec<u8>, String)>::new()));
    let captured = Arc::clone(&requests);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();

    let server = tokio::spawn(async move {
        let (mut health, _) = listener.accept().await.unwrap();
        let _ = read_http_request(&mut health).await;
        write_health(&mut health).await;

        let (mut first, _) = listener.accept().await.unwrap();
        let first_request = read_http_request(&mut first).await;
        captured.lock().unwrap().push((
            request_body(&first_request).to_vec(),
            idempotency_key(&first_request),
        ));
        // Registration is considered committed, but the success body is truncated.
        first
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 999\r\nConnection: close\r\n\r\n{\"id\":",
            )
            .await
            .unwrap();
        drop(first);

        let (mut retry, _) = listener.accept().await.unwrap();
        let retry_request = read_http_request(&mut retry).await;
        let retry_body = request_body(&retry_request).to_vec();
        captured
            .lock()
            .unwrap()
            .push((retry_body.clone(), idempotency_key(&retry_request)));
        let body: Value = serde_json::from_slice(&retry_body).unwrap();
        let response_body = serde_json::json!({
            "id": body["id"],
            "label": body["label"],
            "created_at": "2026-08-01T00:00:00Z",
            "expires_at": body["expires_at"],
            "scopes": body["scopes"],
        })
        .to_string();
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}",
            response_body.len()
        );
        retry.write_all(response.as_bytes()).await.unwrap();
    });

    let mut session = Session::connect(TargetOptions {
        profile_dir: root.join("unused-profile"),
        server: Some(format!("http://{address}")),
        credential_file: Some(credential_file),
    })
    .await
    .unwrap();
    let report = create_credential(
        &mut session,
        "  reconciled  ",
        &[AutomationScope::Read],
        &output,
        None,
    )
    .await
    .unwrap();
    assert_eq!(report.label, "reconciled");
    assert!(output.is_file());
    server.await.unwrap();
    {
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0], requests[1],
            "reconciliation must be byte-exact"
        );
    }
    session.shutdown().await;
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn repeated_ambiguity_retains_secret_and_reports_possible_live_id() {
    use junban_cli::auth::create_credential;
    use junban_cli::{Session, TargetOptions};
    use junban_server::AutomationScope;

    let root = unique_temp("unknown");
    fs::create_dir_all(&root).unwrap();
    let credential_file = root.join("operator.token");
    fs::write(&credential_file, "operator-for-fake-server\n").unwrap();
    let output = root.join("automation.token");
    let requests = Arc::new(Mutex::new(Vec::<(Vec<u8>, String)>::new()));
    let captured = Arc::clone(&requests);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();

    let server = tokio::spawn(async move {
        let (mut health, _) = listener.accept().await.unwrap();
        let _ = read_http_request(&mut health).await;
        write_health(&mut health).await;
        for _ in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            captured
                .lock()
                .unwrap()
                .push((request_body(&request).to_vec(), idempotency_key(&request)));
            // A server may commit and lose the connection before any response bytes.
            drop(socket);
        }
    });

    let mut session = Session::connect(TargetOptions {
        profile_dir: root.join("unused-profile"),
        server: Some(format!("http://{address}")),
        credential_file: Some(credential_file),
    })
    .await
    .unwrap();
    let error = create_credential(
        &mut session,
        "unknown",
        &[AutomationScope::Write],
        &output,
        None,
    )
    .await
    .unwrap_err();
    server.await.unwrap();
    assert_eq!(error.code(), "credential_create_outcome_unknown");
    assert!(
        output.is_file(),
        "ambiguous outcome must retain the only secret"
    );
    {
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0], requests[1], "bounded retry must be exact");
        let body: Value = serde_json::from_slice(&requests[0].0).unwrap();
        let id = body["id"].as_str().unwrap();
        let message = error.to_string();
        assert!(message.contains(id));
        assert!(message.contains("retained"));
    }
    session.shutdown().await;
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn explicit_server_uses_credential_file_not_operator_token() {
    use junban_cli::auth::{create_credential, list_credentials};
    use junban_cli::{Session, SessionMode, TargetOptions};
    use junban_server::AutomationScope;

    let root = unique_temp("explicit");
    let profile = root.join("profile");
    write_operator_token(&profile);
    let operator_token_path = profile.join(TOKEN_FILE);
    let owner = junban_server::LocalApiOwner::start(&profile)
        .await
        .expect("start owner");
    let base = owner.base_url();

    let mut session = Session::connect(TargetOptions {
        profile_dir: profile.clone(),
        server: Some(base.clone()),
        credential_file: Some(operator_token_path.clone()),
    })
    .await
    .expect("explicit session");
    assert_eq!(session.mode(), SessionMode::Explicit);

    let token_path = root.join("auto.token");
    let created = create_credential(
        &mut session,
        "remote-agent",
        &[AutomationScope::Read],
        &token_path,
        None,
    )
    .await
    .expect("create over explicit server");
    assert!(token_path.is_file());
    let secret = fs::read_to_string(&token_path).unwrap();
    assert!(!created.id.is_empty());
    assert!(!format!("{created:?}").contains(secret.trim()));

    let listed = list_credentials(&mut session).await.unwrap();
    assert_eq!(listed.len(), 1);
    session.shutdown().await;

    // Automation credential cannot administer credentials.
    let mut auto_session = Session::connect(TargetOptions {
        profile_dir: profile.clone(),
        server: Some(base),
        credential_file: Some(token_path.clone()),
    })
    .await
    .expect("automation explicit session");
    let denied = list_credentials(&mut auto_session).await;
    assert!(denied.is_err());
    let err = denied.unwrap_err().to_string();
    assert!(!err.contains(secret.trim()));
    auto_session.shutdown().await;

    owner.shutdown().await;
    fs::remove_dir_all(root).unwrap();
}
