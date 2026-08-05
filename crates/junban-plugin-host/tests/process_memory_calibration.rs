#![forbid(unsafe_code)]

use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::Path,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{Arc, Condvar, Mutex},
    thread,
    time::{Duration, Instant},
};

use junban_plugin_host::{
    WASMTIME_MEMORY_GUARD_BYTES, WASMTIME_MEMORY_RESERVATION_BYTES,
    WASMTIME_MEMORY_RESERVATION_FOR_GROWTH_BYTES,
};
use junban_plugin_sdk::{
    AuthorityFence, Capability, ChildFrame, HOST_FRAME_BYTES_MAX, HOST_PROTOCOL_NAME,
    HOST_PROTOCOL_VERSION, HostCallReply, HostCallRequest, InvocationOutcome, InvocationRequest,
    ParentFrame, Permission, PermissionScope, RuntimeLimits, RuntimeProfile, TypedParentMessage,
    UnscopedPermission, canonical_permission_hash, child_body_len, decode_child_frame,
    decode_host_call_request, decode_invocation_outcome, encode_parent_frame,
    inspect_component_for_runtime, private_body_types as body, validate_child_body,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

const SESSION: &str = "00000000-0000-4000-8000-000000000001";
const WARM_UP_RUNS: usize = 1;
const MEASURED_RUNS: usize = 5;
const PHASES: [&str; 6] = [
    "spawn",
    "hello",
    "compile_and_instantiate",
    "valid_max_working_set_barrier",
    "representative_invocation",
    "shutdown",
];
const RUST_BARRIER_BYTES: u64 = 48 * 1024 * 1024;
const TYPESCRIPT_BARRIER_BYTES: u64 = 64 * 1024 * 1024;
const RUST_COMPONENT: &[u8] =
    include_bytes!("../../junban-plugin-sdk/consumers/rust/rust-consumer.wasm");
const TYPESCRIPT_COMPONENT: &[u8] = include_bytes!(
    "../../junban-plugin-sdk/consumers/typescript/artifacts/typescript-consumer.wasm"
);

#[derive(Clone, Default, Serialize)]
struct MemoryMetrics {
    virtual_address_bytes: Option<u64>,
    rss_bytes: Option<u64>,
    peak_virtual_address_bytes: Option<u64>,
    peak_rss_bytes: Option<u64>,
    private_commit_bytes: Option<u64>,
    pagefile_bytes: Option<u64>,
    working_set_bytes: Option<u64>,
    peak_private_commit_bytes: Option<u64>,
    peak_pagefile_bytes: Option<u64>,
    peak_working_set_bytes: Option<u64>,
}

impl MemoryMetrics {
    fn include(&mut self, other: &Self) {
        include_max(&mut self.virtual_address_bytes, other.virtual_address_bytes);
        include_max(&mut self.rss_bytes, other.rss_bytes);
        include_max(
            &mut self.peak_virtual_address_bytes,
            other.peak_virtual_address_bytes,
        );
        include_max(&mut self.peak_rss_bytes, other.peak_rss_bytes);
        include_max(&mut self.private_commit_bytes, other.private_commit_bytes);
        include_max(&mut self.pagefile_bytes, other.pagefile_bytes);
        include_max(&mut self.working_set_bytes, other.working_set_bytes);
        include_max(
            &mut self.peak_private_commit_bytes,
            other.peak_private_commit_bytes,
        );
        include_max(&mut self.peak_pagefile_bytes, other.peak_pagefile_bytes);
        include_max(
            &mut self.peak_working_set_bytes,
            other.peak_working_set_bytes,
        );
    }
}

fn include_max(target: &mut Option<u64>, value: Option<u64>) {
    if let Some(value) = value {
        *target = Some(target.map_or(value, |current| current.max(value)));
    }
}

struct RawSample {
    elapsed_millis: u64,
    phase: String,
    metrics: MemoryMetrics,
}

#[derive(Serialize)]
struct PhaseMaximum {
    phase: String,
    sample_count: usize,
    metrics: MemoryMetrics,
}

#[derive(Serialize)]
struct RunRecord {
    sequence: usize,
    warm_up: bool,
    duration_millis: u64,
    sample_count: usize,
    phase_maxima: Vec<PhaseMaximum>,
    whole_run_maximum: MemoryMetrics,
}

#[derive(Serialize)]
struct ProfileRecord {
    profile: &'static str,
    component_sha256: String,
    guest_linear_memory_limit_bytes: u64,
    barrier_allocation_bytes: u64,
    warm_up: RunRecord,
    measured: Vec<RunRecord>,
}

#[derive(Serialize)]
struct EngineRecord {
    wasmtime: &'static str,
    memory_reservation_bytes: u64,
    memory_guard_bytes: u64,
    memory_reservation_for_growth_bytes: u64,
    explicit_bounds_checks_below_wasm32_address_space: bool,
}

#[derive(Serialize)]
struct ExecutableRecord {
    file_name: String,
    sha256: String,
}

#[derive(Serialize)]
struct Campaign {
    schema_version: u32,
    protocol: &'static str,
    status: &'static str,
    git_commit: String,
    git_tree_clean: bool,
    os: &'static str,
    architecture: &'static str,
    metric_authority: &'static str,
    executable: ExecutableRecord,
    engine: EngineRecord,
    profiles: Vec<ProfileRecord>,
}

struct SamplerState {
    phase: &'static str,
    generation: u64,
    samples_in_generation: usize,
    last_sampling_error: Option<String>,
    stop: bool,
}

struct SamplerControl {
    state: Mutex<SamplerState>,
    changed: Condvar,
}

impl SamplerControl {
    fn new() -> Self {
        Self {
            state: Mutex::new(SamplerState {
                phase: PHASES[0],
                generation: 0,
                samples_in_generation: 0,
                last_sampling_error: None,
                stop: false,
            }),
            changed: Condvar::new(),
        }
    }

    fn enter_and_sample(&self, phase: &'static str) {
        let generation = {
            let mut state = self.state.lock().unwrap();
            state.phase = phase;
            state.generation += 1;
            state.samples_in_generation = 0;
            state.last_sampling_error = None;
            self.changed.notify_all();
            state.generation
        };
        let deadline = Instant::now() + first_sample_deadline();
        let mut state = self.state.lock().unwrap();
        while state.generation == generation && state.samples_in_generation == 0 {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                panic!("{}", missing_phase_sample_message(&state));
            };
            let (next, timeout) = self.changed.wait_timeout(state, remaining).unwrap();
            state = next;
            if timeout.timed_out() {
                panic!("{}", missing_phase_sample_message(&state));
            }
        }
    }

    fn record_sampling_error(&self, generation: u64, error: String) {
        let mut state = self.state.lock().unwrap();
        if state.generation == generation {
            state.last_sampling_error = Some(error);
            self.changed.notify_all();
        }
    }

    fn stop(&self) {
        let mut state = self.state.lock().unwrap();
        state.stop = true;
        self.changed.notify_all();
    }
}

struct HostProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: ChildStdout,
    permission_hash: String,
    next_invocation: u64,
}

impl HostProcess {
    fn spawn(executable: &Path) -> Self {
        let mut child = Command::new(executable)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let grants = permissions();
        Self {
            child,
            stdin: Some(stdin),
            stdout,
            permission_hash: canonical_permission_hash(&grants).unwrap(),
            next_invocation: 2,
        }
    }

    fn send(&mut self, frame: &ParentFrame, body: &[u8]) {
        let stdin = self.stdin.as_mut().expect("child stdin remains open");
        stdin
            .write_all(&encode_parent_frame(frame).unwrap())
            .unwrap();
        stdin.write_all(body).unwrap();
        stdin.flush().unwrap();
    }

    fn send_typed(&mut self, message: TypedParentMessage) {
        let (frame, body) = message.into_parts();
        self.send(&frame, &body);
    }

    fn receive(&mut self) -> (ChildFrame, Vec<u8>) {
        let mut prefix = [0_u8; 4];
        self.stdout.read_exact(&mut prefix).unwrap();
        let header_len = u32::from_be_bytes(prefix) as usize;
        assert!((1..=HOST_FRAME_BYTES_MAX).contains(&header_len));
        let mut encoded = vec![0; 4 + header_len];
        encoded[..4].copy_from_slice(&prefix);
        self.stdout.read_exact(&mut encoded[4..]).unwrap();
        let frame = decode_child_frame(&encoded).unwrap();
        let mut body = vec![0; child_body_len(&frame).unwrap()];
        self.stdout.read_exact(&mut body).unwrap();
        validate_child_body(&frame, &body).unwrap();
        (frame, body)
    }

    fn invoke(&mut self, request: InvocationRequest) -> AuthorityFence {
        let fence = fence(self.next_invocation);
        self.next_invocation += 1;
        self.send_typed(
            request
                .into_parent_message(fence.clone(), self.permission_hash.clone())
                .unwrap(),
        );
        fence
    }
}

impl Drop for HostProcess {
    fn drop(&mut self) {
        self.stdin.take();
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn fence(invocation: u64) -> AuthorityFence {
    AuthorityFence {
        plugin_id: "calibration-plugin".into(),
        package_generation: 7,
        activation_epoch: 9,
        host_session_id: SESSION.into(),
        invocation_id: format!("00000000-0000-4000-8000-{invocation:012x}"),
    }
}

fn permissions() -> Vec<Permission> {
    [
        Capability::Logging,
        Capability::Settings,
        Capability::Storage,
        Capability::TasksRead,
    ]
    .into_iter()
    .map(|capability| Permission {
        capability,
        scope: PermissionScope::Unscoped(UnscopedPermission {}),
    })
    .collect()
}

fn profile_name(profile: RuntimeProfile) -> &'static str {
    match profile {
        RuntimeProfile::Rust => "rust",
        RuntimeProfile::Typescript => "typescript",
    }
}

fn component(profile: RuntimeProfile) -> &'static [u8] {
    match profile {
        RuntimeProfile::Rust => RUST_COMPONENT,
        RuntimeProfile::Typescript => TYPESCRIPT_COMPONENT,
    }
}

fn expect_outcome(message: (ChildFrame, Vec<u8>)) -> InvocationOutcome {
    let ChildFrame::Outcome { kind, .. } = message.0 else {
        panic!("expected invocation outcome, got {:?}", message.0);
    };
    decode_invocation_outcome(kind, &message.1).unwrap()
}

fn run_once(
    executable: &Path,
    profile: RuntimeProfile,
    sequence: usize,
    warm_up: bool,
) -> RunRecord {
    let bytes = component(profile);
    let grants = permissions();
    let inspection = inspect_component_for_runtime(bytes, profile, &grants).unwrap();
    let mut host = HostProcess::spawn(executable);
    let pid = host.child.id();
    let control = Arc::new(SamplerControl::new());
    let samples = Arc::new(Mutex::new(Vec::new()));
    let sampler = {
        let control = control.clone();
        let samples = samples.clone();
        thread::spawn(move || sample_child(pid, control, samples))
    };

    control.enter_and_sample("spawn");
    control.enter_and_sample("hello");
    host.send(
        &ParentFrame::Hello {
            protocol_name: HOST_PROTOCOL_NAME.into(),
            protocol_version: HOST_PROTOCOL_VERSION,
            host_session_id: SESSION.into(),
        },
        &[],
    );
    assert!(matches!(host.receive().0, ChildFrame::Hello { .. }));

    control.enter_and_sample("compile_and_instantiate");
    let load_fence = fence(1);
    host.send(
        &ParentFrame::Load {
            fence: load_fence.clone(),
            package_sha256: "1".repeat(64),
            component_sha256: sha256(bytes),
            import_export_fingerprint: inspection.import_export_fingerprint.clone(),
            runtime_profile: profile,
            component_size: bytes.len() as u64,
            grants,
            permission_hash: host.permission_hash.clone(),
            limits: RuntimeLimits::for_profile(profile),
        },
        bytes,
    );
    assert_eq!(
        host.receive(),
        (
            ChildFrame::Loaded {
                fence: load_fence,
                import_export_fingerprint: inspection.import_export_fingerprint,
            },
            Vec::new(),
        )
    );

    control.enter_and_sample("valid_max_working_set_barrier");
    let barrier = host.invoke(InvocationRequest::invoke_command(
        Some("calibration".into()),
        body::CommandCall {
            command_id: "memory-calibration-barrier".into(),
            values: Vec::new(),
        },
    ));
    let (frame, callback_body) = host.receive();
    let ChildFrame::CapabilityRequest { callback, kind, .. } = frame else {
        panic!("calibration guest did not reach its held callback barrier");
    };
    assert_eq!(callback.authority(), barrier);
    assert!(matches!(
        decode_host_call_request(kind, &callback_body).unwrap(),
        HostCallRequest::GetSettings(())
    ));
    // Reset the checkpoint only after the guest has touched and retained its
    // allocation. The callback is intentionally held for this one sample.
    control.enter_and_sample("valid_max_working_set_barrier");
    host.send_typed(
        HostCallReply::GetSettings(body::WitResult::Ok(Vec::new()))
            .into_parent_message(callback)
            .unwrap(),
    );
    assert!(matches!(
        expect_outcome(host.receive()),
        InvocationOutcome::InvokeCommand(body::WitResult::Ok(_))
    ));

    control.enter_and_sample("representative_invocation");
    host.invoke(InvocationRequest::call_service(
        Some("calibration".into()),
        body::ServiceCall {
            plugin_id: "dependency".into(),
            service_id: "state".into(),
            values: Vec::new(),
        },
    ));
    assert!(matches!(
        expect_outcome(host.receive()),
        InvocationOutcome::CallService(body::WitResult::Ok(_))
    ));

    control.enter_and_sample("shutdown");
    host.send(
        &ParentFrame::Shutdown {
            host_session_id: SESSION.into(),
        },
        &[],
    );
    assert!(matches!(
        host.receive().0,
        ChildFrame::ShutdownComplete { .. }
    ));
    control.stop();
    host.stdin.take();
    assert!(host.child.wait().unwrap().success());
    let mut stderr = Vec::new();
    host.child
        .stderr
        .take()
        .unwrap()
        .read_to_end(&mut stderr)
        .unwrap();
    assert!(stderr.is_empty(), "child diagnostics were not empty");
    sampler.join().unwrap();

    let samples = std::mem::take(&mut *samples.lock().unwrap());
    let mut phase_metrics = BTreeMap::<&str, (usize, MemoryMetrics)>::new();
    let mut whole_run_maximum = MemoryMetrics::default();
    for sample in &samples {
        whole_run_maximum.include(&sample.metrics);
        let entry = phase_metrics
            .entry(sample.phase.as_str())
            .or_insert_with(|| (0, MemoryMetrics::default()));
        entry.0 += 1;
        entry.1.include(&sample.metrics);
    }
    let phase_maxima = PHASES
        .into_iter()
        .map(|phase| {
            let (sample_count, metrics) = phase_metrics
                .remove(phase)
                .unwrap_or_else(|| panic!("missing child sample for {phase}"));
            PhaseMaximum {
                phase: phase.into(),
                sample_count,
                metrics,
            }
        })
        .collect();
    assert!(phase_metrics.is_empty(), "unexpected calibration phase");

    RunRecord {
        sequence,
        warm_up,
        duration_millis: samples.last().map_or(0, |sample| sample.elapsed_millis),
        sample_count: samples.len(),
        phase_maxima,
        whole_run_maximum,
    }
}

fn sample_child(pid: u32, control: Arc<SamplerControl>, samples: Arc<Mutex<Vec<RawSample>>>) {
    let started = Instant::now();
    loop {
        let (phase, generation, stop) = {
            let state = control.state.lock().unwrap();
            (state.phase, state.generation, state.stop)
        };
        if stop {
            return;
        }
        match sample_process(pid) {
            Ok(metrics) => {
                samples.lock().unwrap().push(RawSample {
                    elapsed_millis: started.elapsed().as_millis() as u64,
                    phase: phase.into(),
                    metrics,
                });
                let mut state = control.state.lock().unwrap();
                if state.generation == generation {
                    state.samples_in_generation += 1;
                    control.changed.notify_all();
                }
            }
            Err(error) => control.record_sampling_error(generation, error),
        }
        let state = control.state.lock().unwrap();
        if state.stop {
            return;
        }
        let _ = control
            .changed
            .wait_timeout(state, sampling_interval())
            .unwrap();
    }
}

fn missing_phase_sample_message(state: &SamplerState) -> String {
    match &state.last_sampling_error {
        Some(error) => format!(
            "child sampler produced no phase sample for {}: {error}",
            state.phase
        ),
        None => format!("child sampler produced no phase sample for {}", state.phase),
    }
}

fn first_sample_deadline() -> Duration {
    if cfg!(target_os = "windows") {
        // A cold GitHub Windows runner may take longer than five seconds to
        // start its first PowerShell process. Later sampling remains paced.
        Duration::from_secs(30)
    } else {
        Duration::from_secs(5)
    }
}

fn sampling_interval() -> Duration {
    if cfg!(target_os = "windows") {
        Duration::from_millis(25)
    } else {
        Duration::from_millis(10)
    }
}

#[cfg(target_os = "linux")]
fn sample_process(pid: u32) -> Result<MemoryMetrics, String> {
    let status =
        fs::read_to_string(format!("/proc/{pid}/status")).map_err(|error| error.to_string())?;
    let value = |name: &str| -> Result<u64, String> {
        let line = status
            .lines()
            .find(|line| line.starts_with(name))
            .ok_or_else(|| format!("missing {name}"))?;
        let kib = line
            .split_whitespace()
            .nth(1)
            .ok_or_else(|| format!("invalid {name}"))?
            .parse::<u64>()
            .map_err(|error| error.to_string())?;
        kib.checked_mul(1024)
            .ok_or_else(|| format!("overflow in {name}"))
    };
    Ok(MemoryMetrics {
        virtual_address_bytes: Some(value("VmSize:")?),
        rss_bytes: Some(value("VmRSS:")?),
        peak_virtual_address_bytes: Some(value("VmPeak:")?),
        peak_rss_bytes: Some(value("VmHWM:")?),
        ..MemoryMetrics::default()
    })
}

#[cfg(target_os = "macos")]
fn sample_process(pid: u32) -> Result<MemoryMetrics, String> {
    let output = Command::new("ps")
        .args(["-o", "vsz=", "-o", "rss=", "-p", &pid.to_string()])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("ps failed".into());
    }
    let text = String::from_utf8(output.stdout).map_err(|error| error.to_string())?;
    let mut fields = text.split_whitespace();
    let virtual_kib = fields
        .next()
        .ok_or("missing virtual size")?
        .parse::<u64>()
        .map_err(|error| error.to_string())?;
    let rss_kib = fields
        .next()
        .ok_or("missing rss")?
        .parse::<u64>()
        .map_err(|error| error.to_string())?;
    Ok(MemoryMetrics {
        virtual_address_bytes: virtual_kib.checked_mul(1024),
        rss_bytes: rss_kib.checked_mul(1024),
        ..MemoryMetrics::default()
    })
}

#[cfg(target_os = "windows")]
fn sample_process(pid: u32) -> Result<MemoryMetrics, String> {
    let script = format!(
        "$p=Get-Process -Id {pid} -ErrorAction Stop; Write-Output ($p.PrivateMemorySize64.ToString()+' '+$p.PagedMemorySize64.ToString()+' '+$p.WorkingSet64.ToString()+' '+$p.VirtualMemorySize64.ToString()+' '+$p.PeakPagedMemorySize64.ToString()+' '+$p.PeakWorkingSet64.ToString()+' '+$p.PeakVirtualMemorySize64.ToString())"
    );
    let output = Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &script,
        ])
        .output()
        .map_err(|error| error.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !output.status.success() {
        return Err(format!(
            "Get-Process failed with status {}: stderr={:?}; stdout={:?}",
            output.status,
            stderr.trim(),
            stdout.trim()
        ));
    }
    let values = stdout
        .split_whitespace()
        .map(|value| value.parse::<u64>().map_err(|error| error.to_string()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            format!(
                "Get-Process returned invalid metrics: {error}; stderr={:?}; stdout={:?}",
                stderr.trim(),
                stdout.trim()
            )
        })?;
    if values.len() != 7 {
        return Err(format!(
            "Get-Process returned {} metrics, expected 7: stderr={:?}; stdout={:?}",
            values.len(),
            stderr.trim(),
            stdout.trim()
        ));
    }
    Ok(MemoryMetrics {
        private_commit_bytes: Some(values[0]),
        pagefile_bytes: Some(values[1]),
        working_set_bytes: Some(values[2]),
        virtual_address_bytes: Some(values[3]),
        peak_pagefile_bytes: Some(values[4]),
        peak_working_set_bytes: Some(values[5]),
        peak_virtual_address_bytes: Some(values[6]),
        ..MemoryMetrics::default()
    })
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn sample_process(_pid: u32) -> Result<MemoryMetrics, String> {
    Err("unsupported calibration platform".into())
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn file_sha256(path: &Path) -> String {
    sha256(&fs::read(path).unwrap())
}

fn git_output(arguments: &[&str]) -> String {
    let output = Command::new("git").args(arguments).output().unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap().trim().into()
}

fn git_tree_clean() -> bool {
    let output = Command::new("git")
        .args(["status", "--porcelain", "--untracked-files=no"])
        .output()
        .unwrap();
    assert!(output.status.success());
    output.stdout.is_empty()
}

#[cfg(debug_assertions)]
fn assert_release_build() {
    panic!("calibration must use cargo test --release");
}

#[cfg(not(debug_assertions))]
fn assert_release_build() {}

#[test]
fn sampler_retains_current_generation_error() {
    let control = SamplerControl::new();
    control.record_sampling_error(0, "Get-Process failed with status exit code: 1".into());
    let state = control.state.lock().unwrap();
    assert_eq!(
        state.last_sampling_error.as_deref(),
        Some("Get-Process failed with status exit code: 1")
    );
    assert_eq!(
        missing_phase_sample_message(&state),
        "child sampler produced no phase sample for spawn: Get-Process failed with status exit code: 1"
    );
    drop(state);

    control.record_sampling_error(1, "stale sampling error".into());
    assert_eq!(
        control.state.lock().unwrap().last_sampling_error.as_deref(),
        Some("Get-Process failed with status exit code: 1")
    );
}

#[test]
fn first_sample_deadline_matches_platform_startup_cost() {
    #[cfg(target_os = "windows")]
    assert_eq!(first_sample_deadline(), Duration::from_secs(30));
    #[cfg(not(target_os = "windows"))]
    assert_eq!(first_sample_deadline(), Duration::from_secs(5));
}

#[test]
#[ignore = "opt-in release-only cross-platform process-memory calibration"]
fn calibration_campaign() {
    assert_eq!(
        std::env::var("JUNBAN_PLUGIN_MEMORY_CALIBRATION").as_deref(),
        Ok("1"),
        "set JUNBAN_PLUGIN_MEMORY_CALIBRATION=1 explicitly"
    );
    assert_release_build();
    let output_path = std::env::var("JUNBAN_PLUGIN_MEMORY_CALIBRATION_OUTPUT")
        .expect("set the calibration JSON output path");
    let executable = Path::new(env!("CARGO_BIN_EXE_junban-plugin-host"));
    assert!(executable.is_absolute());
    assert!(
        git_tree_clean(),
        "calibration requires a clean tracked tree"
    );

    let mut profiles = Vec::new();
    for profile in [RuntimeProfile::Rust, RuntimeProfile::Typescript] {
        let warm_up = run_once(executable, profile, 0, true);
        let measured = (1..=MEASURED_RUNS)
            .map(|sequence| run_once(executable, profile, sequence, false))
            .collect();
        let limits = RuntimeLimits::for_profile(profile);
        profiles.push(ProfileRecord {
            profile: profile_name(profile),
            component_sha256: sha256(component(profile)),
            guest_linear_memory_limit_bytes: limits.linear_memory_bytes,
            barrier_allocation_bytes: match profile {
                RuntimeProfile::Rust => RUST_BARRIER_BYTES,
                RuntimeProfile::Typescript => TYPESCRIPT_BARRIER_BYTES,
            },
            warm_up,
            measured,
        });
    }
    assert_eq!(WARM_UP_RUNS, 1);

    assert!(
        git_tree_clean(),
        "tracked tree changed during the calibration"
    );
    let campaign = Campaign {
        schema_version: 1,
        protocol: "junban-phase7-process-memory-calibration-v1",
        status: "single-machine/platform preliminary calibration only; no process cap or acceptance claim",
        git_commit: git_output(&["rev-parse", "HEAD"]),
        git_tree_clean: true,
        os: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        metric_authority: if cfg!(target_os = "windows") {
            "Get-Process exact child: private commit/pagefile/working set/virtual size"
        } else if cfg!(target_os = "macos") {
            "ps exact child: virtual address size/RSS"
        } else {
            "/proc exact child: virtual address size/RSS and kernel peaks"
        },
        executable: ExecutableRecord {
            file_name: executable.file_name().unwrap().to_string_lossy().into(),
            sha256: file_sha256(executable),
        },
        engine: EngineRecord {
            wasmtime: "36.0.13",
            memory_reservation_bytes: WASMTIME_MEMORY_RESERVATION_BYTES,
            memory_guard_bytes: WASMTIME_MEMORY_GUARD_BYTES,
            memory_reservation_for_growth_bytes: WASMTIME_MEMORY_RESERVATION_FOR_GROWTH_BYTES,
            explicit_bounds_checks_below_wasm32_address_space: true,
        },
        profiles,
    };
    let output_path = Path::new(&output_path);
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let bytes = serde_json::to_vec_pretty(&campaign).unwrap();
    fs::write(output_path, [bytes, b"\n".to_vec()].concat()).unwrap();
}
