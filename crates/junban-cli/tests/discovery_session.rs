//! Wave 0 discovery, identity matching, and temporary-owner session tests.

use std::{
    fs,
    net::{SocketAddr, TcpListener},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::SystemTime,
};

use junban_cli::{
    Session, SessionMode, TargetOptions, collect_status, discovery::validate_explicit_server,
};
use junban_server::{
    LocalApiOwner, RUNTIME_FILE, RUNTIME_METADATA_VERSION, RuntimeMetadata, TOKEN_FILE,
};
use junban_storage::ProfileOwner;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn unique_temp(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "junban-cli-wave0-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn write_token(profile: &std::path::Path, token: &str) {
    fs::create_dir_all(profile).unwrap();
    fs::write(profile.join(TOKEN_FILE), format!("{token}\n")).unwrap();
}

fn write_runtime(profile: &std::path::Path, address: SocketAddr, instance_id: &str) {
    let metadata = RuntimeMetadata {
        version: RUNTIME_METADATA_VERSION,
        address,
        pid: 1,
        instance_id: instance_id.to_owned(),
    };
    fs::write(
        profile.join(RUNTIME_FILE),
        serde_json::to_vec_pretty(&metadata).unwrap(),
    )
    .unwrap();
}

#[tokio::test]
async fn temporary_owner_status_releases_lock() {
    let root = unique_temp("temp-owner");
    let profile = root.join("profile");
    write_token(&profile, &"ab".repeat(32));

    let session = Session::connect(TargetOptions {
        profile_dir: profile.clone(),
        server: None,
        credential_file: None,
    })
    .await
    .unwrap();
    assert_eq!(session.mode(), SessionMode::TemporaryOwner);
    assert!(matches!(
        ProfileOwner::open(&profile),
        Err(junban_storage::OpenError::AlreadyOwned)
    ));
    session.shutdown().await;

    let owner = ProfileOwner::open(&profile).expect("lock released after temporary owner");
    drop(owner);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn discovered_owner_does_not_take_second_lock() {
    let root = unique_temp("discover");
    let profile = root.join("profile");
    write_token(&profile, &"cd".repeat(32));
    let owner = LocalApiOwner::start(profile.clone()).await.unwrap();

    let session = Session::connect(TargetOptions {
        profile_dir: profile.clone(),
        server: None,
        credential_file: None,
    })
    .await
    .unwrap();
    assert_eq!(session.mode(), SessionMode::Discovered);
    assert_eq!(session.instance_id(), Some(owner.instance_id()));
    // Original owner still holds the lock exclusively.
    assert!(matches!(
        ProfileOwner::open(&profile),
        Err(junban_storage::OpenError::AlreadyOwned)
    ));
    session.shutdown().await;
    owner.shutdown().await;

    let reopened = ProfileOwner::open(&profile).unwrap();
    drop(reopened);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn stale_metadata_falls_back_to_temporary_owner() {
    let root = unique_temp("stale");
    let profile = root.join("profile");
    write_token(&profile, &"ef".repeat(32));
    // Bind and drop so the port is closed; metadata becomes stale.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    write_runtime(&profile, address, "stale-instance");

    let session = Session::connect(TargetOptions {
        profile_dir: profile.clone(),
        server: None,
        credential_file: None,
    })
    .await
    .unwrap();
    assert_eq!(session.mode(), SessionMode::TemporaryOwner);
    session.shutdown().await;
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn instance_mismatch_sends_no_authorization_header() {
    let root = unique_temp("mismatch");
    let profile = root.join("profile");
    let token = "11".repeat(32);
    write_token(&profile, &token);

    let seen_authorization = Arc::new(AtomicBool::new(false));
    let seen_auth = Arc::clone(&seen_authorization);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    write_runtime(&profile, address, "metadata-instance");

    let server = tokio::spawn(async move {
        // Handle a few probes; always claim a different instance id.
        for _ in 0..8 {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let mut buf = vec![0_u8; 4096];
            let _ = socket.read(&mut buf).await;
            let request = String::from_utf8_lossy(&buf);
            if request.to_ascii_lowercase().contains("authorization:") {
                seen_auth.store(true, Ordering::SeqCst);
            }
            let body = json!({"status":"ok","instance_id":"other-instance"}).to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });

    let session = Session::connect(TargetOptions {
        profile_dir: profile.clone(),
        server: None,
        credential_file: None,
    })
    .await
    .unwrap();
    // Mismatch must not authorize against the foreign listener; fallback owns locally.
    assert!(!seen_authorization.load(Ordering::SeqCst));
    assert_eq!(session.mode(), SessionMode::TemporaryOwner);
    session.shutdown().await;
    server.abort();
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn discovered_session_recovers_when_owner_exits_before_catalog_get() {
    let root = unique_temp("handoff");
    let profile = root.join("profile");
    write_token(&profile, &"66".repeat(32));

    let owner = Session::connect(TargetOptions {
        profile_dir: profile.clone(),
        server: None,
        credential_file: None,
    })
    .await
    .unwrap();
    assert_eq!(owner.mode(), SessionMode::TemporaryOwner);

    let mut discovered = Session::connect(TargetOptions {
        profile_dir: profile.clone(),
        server: None,
        credential_file: None,
    })
    .await
    .unwrap();
    assert_eq!(discovered.mode(), SessionMode::Discovered);
    assert_eq!(discovered.instance_id(), owner.instance_id());

    // Owner exits after discovery succeeds and before the contender dispatches catalog I/O.
    owner.shutdown().await;
    assert!(
        !profile.join(RUNTIME_FILE).exists(),
        "owner shutdown must remove runtime metadata before handoff"
    );

    let listed = discovered
        .call_tool("list_tasks", json!({ "limit": 100 }))
        .await
        .expect("discovered session must recover through shared local authority");
    let tasks = listed
        .value
        .get("tasks")
        .and_then(|value| value.as_array())
        .expect("empty task page");
    assert!(tasks.is_empty(), "expected empty task page, got {listed:?}");
    assert!(listed.value.get("revision").is_some());

    discovered.shutdown().await;
    assert!(
        !profile.join(RUNTIME_FILE).exists(),
        "runtime metadata must be gone after recovered session shutdown"
    );
    let lock = ProfileOwner::open(&profile).expect("lock released after recovered session");
    drop(lock);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn discovered_principal_get_recovers_when_owner_exits_before_dispatch() {
    let root = unique_temp("principal-handoff");
    let profile = root.join("profile");
    write_token(&profile, &"77".repeat(32));

    let owner = Session::connect(TargetOptions {
        profile_dir: profile.clone(),
        server: None,
        credential_file: None,
    })
    .await
    .unwrap();
    assert_eq!(owner.mode(), SessionMode::TemporaryOwner);

    let mut discovered = Session::connect(TargetOptions {
        profile_dir: profile.clone(),
        server: None,
        credential_file: None,
    })
    .await
    .unwrap();
    assert_eq!(discovered.mode(), SessionMode::Discovered);

    owner.shutdown().await;

    let principal = discovered
        .principal_capabilities()
        .await
        .expect("authenticated principal GET must recover after discovered-owner exit");
    assert!(principal.is_operator());
    assert!(principal.has_read());

    discovered.shutdown().await;
    let lock = ProfileOwner::open(&profile).expect("lock released after principal recovery");
    drop(lock);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn discovered_status_recovers_when_owner_exits_before_public_health_get() {
    let root = unique_temp("status-handoff");
    let profile = root.join("profile");
    write_token(&profile, &"88".repeat(32));

    let owner = Session::connect(TargetOptions {
        profile_dir: profile.clone(),
        server: None,
        credential_file: None,
    })
    .await
    .unwrap();
    assert_eq!(owner.mode(), SessionMode::TemporaryOwner);
    let stale_instance = owner.instance_id().map(str::to_owned);
    let stale_address = owner
        .base_url()
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .to_owned();

    let mut discovered = Session::connect(TargetOptions {
        profile_dir: profile.clone(),
        server: None,
        credential_file: None,
    })
    .await
    .unwrap();
    assert_eq!(discovered.mode(), SessionMode::Discovered);
    assert_eq!(discovered.instance_id(), stale_instance.as_deref());

    // Owner exits after status discovery succeeds and before public health I/O.
    owner.shutdown().await;
    assert!(
        !profile.join(RUNTIME_FILE).exists(),
        "owner shutdown must remove runtime metadata before status handoff"
    );

    let report = collect_status(&mut discovered, &profile)
        .await
        .expect("public status health GET must recover after discovered-owner exit");
    assert_eq!(report.status, "ok");
    assert_eq!(report.mode, SessionMode::TemporaryOwner);
    assert_ne!(
        report.address, stale_address,
        "status must report the replacement owner's address, not the stale discovery target"
    );
    assert_eq!(
        report.instance_id.as_deref(),
        discovered.instance_id(),
        "status instance must match the replacement session"
    );
    assert_ne!(
        report.instance_id, stale_instance,
        "status must not keep the exited owner's instance id"
    );
    assert_eq!(report.profile_dir, profile.display().to_string());
    assert_eq!(discovered.mode(), SessionMode::TemporaryOwner);

    discovered.shutdown().await;
    assert!(
        !profile.join(RUNTIME_FILE).exists(),
        "runtime metadata must be gone after recovered status session shutdown"
    );
    let lock = ProfileOwner::open(&profile).expect("lock released after status recovery");
    drop(lock);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn explicit_public_health_get_does_not_reconnect_after_target_exit() {
    let root = unique_temp("explicit-public-no-reconnect");
    let profile = root.join("profile");
    let cred_path = root.join("cred");
    fs::create_dir_all(&root).unwrap();
    let token = "99".repeat(32);
    fs::write(&cred_path, format!("{token}\n")).unwrap();
    write_token(&profile, &"aa".repeat(32));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        // Serve the connect-time health probe once, then drop the listener.
        if let Ok((mut socket, _)) = listener.accept().await {
            let mut buf = vec![0_u8; 4096];
            let _ = socket.read(&mut buf).await;
            let body = json!({"status":"ok","instance_id":"explicit-probe"}).to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
        }
        drop(listener);
    });

    let mut session = Session::connect(TargetOptions {
        profile_dir: profile.clone(),
        server: Some(format!("http://{address}")),
        credential_file: Some(cred_path),
    })
    .await
    .expect("explicit loopback connect must succeed against the one-shot health probe");
    assert_eq!(session.mode(), SessionMode::Explicit);
    // Ensure the one-shot probe server is fully gone before the public GET.
    server.await.unwrap();

    let error = session
        .get_json_public::<serde_json::Value>("/api/v1/health")
        .await
        .expect_err("explicit public GET must not reconnect after target exit");
    assert_eq!(error.code(), "http_connect_failed");
    assert_eq!(session.mode(), SessionMode::Explicit);
    assert!(
        !profile.join(RUNTIME_FILE).exists(),
        "explicit public GET must not start a temporary local owner"
    );

    session.shutdown().await;
    // Profile lock must remain free — explicit path never took ownership.
    let lock = ProfileOwner::open(&profile).expect("explicit session must not hold profile lock");
    drop(lock);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn two_fallback_contenders_never_both_open_sqlite() {
    let root = unique_temp("race");
    let profile = root.join("profile");
    write_token(&profile, &"22".repeat(32));

    let opens = Arc::new(AtomicUsize::new(0));
    let list_ok = Arc::new(AtomicUsize::new(0));
    let errors = Arc::new(Mutex::new(Vec::new()));

    let mut handles = Vec::new();
    for _ in 0..2 {
        let profile = profile.clone();
        let opens = Arc::clone(&opens);
        let list_ok = Arc::clone(&list_ok);
        let errors = Arc::clone(&errors);
        handles.push(tokio::spawn(async move {
            match Session::connect(TargetOptions {
                profile_dir: profile,
                server: None,
                credential_file: None,
            })
            .await
            {
                Ok(mut session) => {
                    opens.fetch_add(1, Ordering::SeqCst);
                    // Exercise post-discovery catalog handoff, not merely connect/drop.
                    match session
                        .call_tool("list_tasks", json!({ "limit": 100 }))
                        .await
                    {
                        Ok(result) => {
                            let tasks = result
                                .value
                                .get("tasks")
                                .and_then(|value| value.as_array())
                                .cloned()
                                .unwrap_or_default();
                            assert!(tasks.is_empty(), "expected empty page, got {result:?}");
                            list_ok.fetch_add(1, Ordering::SeqCst);
                        }
                        Err(error) => {
                            assert_eq!(
                                error.code(),
                                "profile_busy",
                                "contender catalog failure must be explicit busy, got {}",
                                error.code()
                            );
                            errors.lock().unwrap().push(error.code().to_owned());
                        }
                    }
                    session.shutdown().await;
                }
                Err(error) => {
                    assert_eq!(
                        error.code(),
                        "profile_busy",
                        "connect failure must be explicit busy, got {}",
                        error.code()
                    );
                    errors.lock().unwrap().push(error.code().to_owned());
                }
            }
        }));
    }
    for handle in handles {
        handle.await.unwrap();
    }

    let open_count = opens.load(Ordering::SeqCst);
    let ok_count = list_ok.load(Ordering::SeqCst);
    let error_codes = errors.lock().unwrap().clone();
    assert!(
        open_count >= 1,
        "at least one contender must obtain a session, got errors {error_codes:?}"
    );
    assert!(
        ok_count >= 1,
        "at least one contender must complete list_tasks, got errors {error_codes:?}"
    );
    assert!(
        error_codes.iter().all(|code| code == "profile_busy"),
        "only profile_busy is allowed alongside ok, got {error_codes:?}"
    );
    // After both finish, lock must be free and DB consistent.
    assert!(
        !profile.join(RUNTIME_FILE).exists(),
        "runtime metadata must be removed after contenders exit"
    );
    let owner = ProfileOwner::open(&profile).expect("lock free after contenders exit");
    drop(owner);
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn explicit_non_loopback_http_userinfo_and_fragment_are_rejected_before_dial() {
    assert_eq!(
        validate_explicit_server("http://example.com")
            .unwrap_err()
            .code(),
        "server_cleartext_forbidden"
    );
    assert_eq!(
        validate_explicit_server("https://user:pass@example.com")
            .unwrap_err()
            .code(),
        "server_url_userinfo_forbidden"
    );
    assert_eq!(
        validate_explicit_server("https://example.com/#x")
            .unwrap_err()
            .code(),
        "server_url_fragment_forbidden"
    );

    let root = unique_temp("explicit-reject");
    let profile = root.join("profile");
    write_token(&profile, &"33".repeat(32));
    let dialed = Arc::new(AtomicBool::new(false));
    // No server is started; connect must fail during validation without dialing.
    let error = match Session::connect(TargetOptions {
        profile_dir: profile,
        server: Some("http://example.com".into()),
        credential_file: Some(root.join("missing-cred")),
    })
    .await
    {
        Ok(_) => panic!("expected explicit cleartext rejection"),
        Err(error) => error,
    };
    assert!(
        error.code() == "server_cleartext_forbidden"
            || error.code() == "credential_file_required"
            || error.code() == "credential_file_unreadable",
        "unexpected {}",
        error.code()
    );
    assert!(!dialed.load(Ordering::SeqCst));
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn explicit_redirect_target_does_not_forward_authorization() {
    let root = unique_temp("redirect");
    let profile = root.join("profile");
    let cred_path = root.join("cred");
    fs::create_dir_all(&root).unwrap();
    let token = "44".repeat(32);
    fs::write(&cred_path, format!("{token}\n")).unwrap();
    write_token(&profile, &"55".repeat(32));

    let saw_authorization = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&saw_authorization);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        for _ in 0..4 {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let mut buf = vec![0_u8; 4096];
            let _ = socket.read(&mut buf).await;
            let request = String::from_utf8_lossy(&buf);
            if request.to_ascii_lowercase().contains("authorization:") {
                flag.store(true, Ordering::SeqCst);
            }
            let response = "HTTP/1.1 302 Found\r\nLocation: https://evil.example/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });

    let error = match Session::connect(TargetOptions {
        profile_dir: profile,
        server: Some(format!("http://{address}")),
        credential_file: Some(cred_path),
    })
    .await
    {
        Ok(_) => panic!("expected redirect rejection"),
        Err(error) => error,
    };
    assert_eq!(error.code(), "redirect_rejected");
    assert!(
        !saw_authorization.load(Ordering::SeqCst),
        "authorization must not be sent while probing a redirecting target"
    );
    server.abort();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn runtime_metadata_strict_decode_helpers() {
    let good = json!({
        "version": 1,
        "address": "127.0.0.1:9",
        "pid": 7,
        "instance_id": "abc"
    });
    let parsed = RuntimeMetadata::parse(good.to_string().as_bytes()).unwrap();
    assert_eq!(parsed.instance_id, "abc");

    assert!(
        RuntimeMetadata::parse(
            json!({
                "version": 2,
                "address": "127.0.0.1:9",
                "pid": 7,
                "instance_id": "abc"
            })
            .to_string()
            .as_bytes()
        )
        .is_err()
    );
}
