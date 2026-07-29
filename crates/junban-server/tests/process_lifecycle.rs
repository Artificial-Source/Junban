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

use junban_server::{RUNTIME_FILE, RuntimeMetadata, TOKEN_FILE};
use junban_storage::ProfileOwner;

#[test]
fn sigint_removes_metadata_closes_listener_and_releases_profile() {
    assert_graceful_shutdown("INT");
}

#[test]
fn sigterm_removes_metadata_closes_listener_and_releases_profile() {
    assert_graceful_shutdown("TERM");
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

    send_signal(signal, child.id());
    wait_for_exit(&mut child, signal);

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
    let mut stream = TcpStream::connect(address).unwrap();
    write!(
        stream,
        "GET /api/v1/health HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
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
