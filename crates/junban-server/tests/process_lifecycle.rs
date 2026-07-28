#![cfg(unix)]

use std::{
    fs,
    io::{Read, Write},
    net::TcpStream,
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime},
};

use junban_server::{RUNTIME_FILE, RuntimeMetadata, TOKEN_FILE};
use junban_storage::ProfileOwner;

#[test]
fn graceful_process_shutdown_removes_metadata_and_releases_profile() {
    let root = std::env::temp_dir().join(format!(
        "junban-process-test-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let profile = root.join("profile");
    let web = root.join("web");
    fs::create_dir_all(&web).unwrap();
    fs::write(web.join("index.html"), "<main>Junban</main>").unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_junban-server"))
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
        .unwrap();

    let runtime_path = profile.join(RUNTIME_FILE);
    wait_for_file(&runtime_path);
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

    let status = Command::new("kill")
        .args(["-INT", &child.id().to_string()])
        .status()
        .unwrap();
    assert!(status.success());
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            panic!("server did not stop after SIGINT");
        }
        thread::sleep(Duration::from_millis(25));
    }

    assert!(!runtime_path.exists());
    let owner = ProfileOwner::open(&profile).expect("profile lock should be released");
    drop(owner);
    fs::remove_dir_all(root).unwrap();
}

fn assert_health(address: std::net::SocketAddr) {
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

fn wait_for_file(path: &Path) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !path.exists() {
        assert!(
            Instant::now() < deadline,
            "{} was not created",
            path.display()
        );
        thread::sleep(Duration::from_millis(25));
    }
}
