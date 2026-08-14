#![cfg(windows)]

use std::{
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime},
};

use junban_server::{RUNTIME_FILE, RuntimeMetadata};
use junban_storage::ProfileOwner;
use windows_sys::Win32::System::{
    Console::{CTRL_BREAK_EVENT, GenerateConsoleCtrlEvent},
    Threading::CREATE_NEW_PROCESS_GROUP,
};

const TIMEOUT: Duration = Duration::from_secs(20);

#[test]
fn ctrl_break_gracefully_releases_server_resources() {
    let root = unique_temp_root();
    let profile = root.join("profile");
    let web = root.join("web");
    fs::create_dir_all(&web).unwrap();
    fs::write(web.join("index.html"), "<main>Junban</main>").unwrap();

    let child = Command::new(env!("CARGO_BIN_EXE_junban-server"))
        .args([
            "--bind",
            "127.0.0.1:0",
            "--data-dir",
            profile.to_str().unwrap(),
            "--web-dir",
            web.to_str().unwrap(),
        ])
        .creation_flags(CREATE_NEW_PROCESS_GROUP)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut child = ChildGuard(child);

    let runtime_path = profile.join(RUNTIME_FILE);
    let metadata = wait_for_runtime(&runtime_path, child.0.id());
    wait_until(
        || server_is_healthy(metadata.address),
        "server did not become healthy",
    );

    // SAFETY: the child was created as a new console process group whose ID is
    // its process ID, and CTRL_BREAK_EVENT supports targeted process groups.
    #[allow(unsafe_code)]
    let generated = unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, child.0.id()) };
    assert_ne!(generated, 0, "could not send targeted Ctrl-Break event");

    let status = wait_for_exit(&mut child.0);
    assert!(
        status.success(),
        "server exited unsuccessfully after Ctrl-Break: {status}"
    );
    wait_until(
        || !runtime_path.exists(),
        "runtime metadata remained after Ctrl-Break",
    );

    let listener =
        TcpListener::bind(metadata.address).expect("listener address should be released");
    let owner = ProfileOwner::open(&profile).expect("profile lock should be released");
    drop(owner);
    drop(listener);
    fs::remove_dir_all(root).unwrap();
}

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

fn wait_for_runtime(path: &Path, expected_pid: u32) -> RuntimeMetadata {
    let mut metadata = None;
    wait_until(
        || {
            metadata = fs::read_to_string(path)
                .ok()
                .and_then(|raw| serde_json::from_str::<RuntimeMetadata>(&raw).ok())
                .filter(|value| value.pid == expected_pid);
            metadata.is_some()
        },
        "runtime metadata was not published",
    );
    metadata.unwrap()
}

fn wait_for_exit(child: &mut Child) -> std::process::ExitStatus {
    let mut status = None;
    wait_until(
        || {
            status = child.try_wait().expect("failed waiting for server");
            status.is_some()
        },
        "server did not stop after Ctrl-Break",
    );
    status.unwrap()
}

fn server_is_healthy(address: SocketAddr) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(250)) else {
        return false;
    };
    let timeout = Some(Duration::from_millis(500));
    if stream.set_read_timeout(timeout).is_err() || stream.set_write_timeout(timeout).is_err() {
        return false;
    }
    if write!(
        stream,
        "GET /api/v1/health HTTP/1.1\r\nHost: {address}\r\nConnection: keep-alive\r\n\r\n"
    )
    .is_err()
    {
        return false;
    }
    let mut response = [0_u8; 1024];
    let Ok(read) = stream.read(&mut response) else {
        return false;
    };
    response[..read].starts_with(b"HTTP/1.1 200 OK")
}

fn wait_until(mut predicate: impl FnMut() -> bool, failure: &str) {
    let deadline = Instant::now() + TIMEOUT;
    while Instant::now() < deadline {
        if predicate() {
            return;
        }
        thread::sleep(Duration::from_millis(25));
    }
    panic!("{failure}");
}

fn unique_temp_root() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "junban-windows-ctrl-break-{}-{nonce}",
        std::process::id()
    ))
}
