#![forbid(unsafe_code)]

mod bindings;
mod generated_body_adapters;
mod runtime;
mod transfer_bounds;

use std::{
    collections::BTreeMap,
    io::{self, Read, Write},
    sync::{Arc, mpsc},
    thread::JoinHandle,
    time::Duration,
};

use junban_plugin_sdk::{
    AuthorityFence, ChildFrame, GUEST_STACK_BYTES, HOST_FRAME_BYTES_MAX, HOST_JUNBAN_VERSION,
    HOST_PROTOCOL_NAME, HOST_PROTOCOL_VERSION, HOST_RUNTIME_ENTRIES_MAX, HostFailureCode,
    ParentFrame, TYPESCRIPT_LINEAR_MEMORY_BYTES, decode_parent_frame, encode_child_frame,
    parent_body_len, validate_child_body, validate_parent_body,
};
use wasmtime::{Config, Engine, InstanceAllocationStrategy, ProfilingStrategy};

use runtime::{
    CallbackRouteError, CancelResult, InvokeRequest, LoadRequest, OutboundMessage, RuntimeCommand,
    SharedInvocationAdmission, SharedRuntimeStatus, StartError,
};

const RUNTIME_THREAD_STACK_BYTES: usize = 4 * 1024 * 1024;
const OUTBOUND_CHANNEL_CAPACITY: usize = 8;

/// One reservation matches the largest frozen one-memory guest profile. Wasmtime
/// emits explicit bounds checks when this is below the 4-GiB wasm32 address space.
pub const WASMTIME_MEMORY_RESERVATION_BYTES: u64 = TYPESCRIPT_LINEAR_MEMORY_BYTES;
pub const WASMTIME_MEMORY_GUARD_BYTES: u64 = 0;
pub const WASMTIME_MEMORY_RESERVATION_FOR_GROWTH_BYTES: u64 = 0;
const _: () = assert!(WASMTIME_MEMORY_RESERVATION_BYTES < 4 * 1024 * 1024 * 1024);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostError {
    Engine,
    Input,
    Output,
    Runtime,
}

impl std::fmt::Display for HostError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Engine => "runtime initialization failed",
            Self::Input => "protocol input rejected",
            Self::Output => "protocol output failed",
            Self::Runtime => "runtime worker failed",
        })
    }
}

impl std::error::Error for HostError {}

#[derive(Debug)]
pub struct ParentMessage {
    pub frame: ParentFrame,
    pub body: Vec<u8>,
}

impl ParentMessage {
    #[must_use]
    pub fn new(frame: ParentFrame, body: Vec<u8>) -> Self {
        Self { frame, body }
    }
}

pub fn read_parent_message(reader: &mut impl Read) -> Result<Option<ParentMessage>, HostError> {
    let Some(frame) = read_parent_header(reader)? else {
        return Ok(None);
    };
    let body = read_parent_body(reader, &frame)?;
    match &frame {
        ParentFrame::Invoke { kind, .. } => {
            junban_plugin_sdk::decode_invocation_request(*kind, &body)
                .map_err(|_| HostError::Input)?;
        }
        ParentFrame::CapabilityReply { kind, result, .. } => {
            junban_plugin_sdk::decode_host_call_reply(*kind, *result, &body)
                .map_err(|_| HostError::Input)?;
        }
        _ => {}
    }
    Ok(Some(ParentMessage::new(frame, body)))
}

fn read_parent_header(reader: &mut impl Read) -> Result<Option<ParentFrame>, HostError> {
    let Some(prefix) = read_prefix(reader)? else {
        return Ok(None);
    };
    let header_len = u32::from_be_bytes(prefix) as usize;
    if header_len == 0 || header_len > HOST_FRAME_BYTES_MAX {
        return Err(HostError::Input);
    }
    let encoded_len = 4_usize.checked_add(header_len).ok_or(HostError::Input)?;
    let mut encoded = vec![0; encoded_len];
    encoded[..4].copy_from_slice(&prefix);
    read_exact_input(reader, &mut encoded[4..])?;
    decode_parent_frame(&encoded)
        .map(Some)
        .map_err(|_| HostError::Input)
}

fn read_parent_body(reader: &mut impl Read, frame: &ParentFrame) -> Result<Vec<u8>, HostError> {
    let body_len = parent_body_len(frame).map_err(|_| HostError::Input)?;
    let mut body = vec![0; body_len];
    read_exact_input(reader, &mut body)?;
    validate_parent_body(frame, &body).map_err(|_| HostError::Input)?;
    Ok(body)
}

pub fn write_child_message(
    writer: &mut impl Write,
    frame: &ChildFrame,
    body: &[u8],
) -> Result<(), HostError> {
    validate_child_body(frame, body).map_err(|_| HostError::Output)?;
    let encoded = encode_child_frame(frame).map_err(|_| HostError::Output)?;
    writer.write_all(&encoded).map_err(|_| HostError::Output)?;
    writer.write_all(body).map_err(|_| HostError::Output)?;
    writer.flush().map_err(|_| HostError::Output)
}

fn read_prefix(reader: &mut impl Read) -> Result<Option<[u8; 4]>, HostError> {
    let mut prefix = [0; 4];
    loop {
        match reader.read(&mut prefix[..1]) {
            Ok(0) => return Ok(None),
            Ok(1) => break,
            Ok(_) => return Err(HostError::Input),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return Err(HostError::Input),
        }
    }
    read_exact_input(reader, &mut prefix[1..])?;
    Ok(Some(prefix))
}

fn read_exact_input(reader: &mut impl Read, bytes: &mut [u8]) -> Result<(), HostError> {
    reader.read_exact(bytes).map_err(|_| HostError::Input)
}

#[derive(Clone)]
struct LoadedAuthority {
    fence: AuthorityFence,
    permission_hash: String,
    import_export_fingerprint: String,
    limits: junban_plugin_sdk::RuntimeLimits,
}

struct RuntimeEntry {
    authority: LoadedAuthority,
    status: Arc<SharedRuntimeStatus>,
    runtime: Option<mpsc::SyncSender<RuntimeCommand>>,
    runtime_handle: Option<JoinHandle<()>>,
    watchdog_handle: Option<JoinHandle<()>>,
}

impl RuntimeEntry {
    fn load(
        engine: &Engine,
        admission: Arc<SharedInvocationAdmission>,
        authority: LoadedAuthority,
        request: LoadRequest,
        outbound: mpsc::SyncSender<OutboundMessage>,
    ) -> Result<Result<Self, HostFailureCode>, HostError> {
        let status = Arc::new(SharedRuntimeStatus::new(
            authority.fence.plugin_id.clone(),
            admission,
        ));
        let watchdog_status = status.clone();
        let watchdog_engine = engine.clone();
        let watchdog_handle = std::thread::Builder::new()
            .name(format!(
                "junban-plugin-watchdog-{}",
                authority.fence.plugin_id
            ))
            .spawn(move || watchdog_status.run_watchdog(&watchdog_engine))
            .map_err(|_| HostError::Runtime)?;

        let (runtime, commands) = mpsc::sync_channel(1);
        let runtime_status = status.clone();
        let runtime_engine = engine.clone();
        let runtime_handle = match std::thread::Builder::new()
            .name(format!(
                "junban-plugin-runtime-{}",
                authority.fence.plugin_id
            ))
            .stack_size(RUNTIME_THREAD_STACK_BYTES)
            .spawn(move || {
                runtime::run_runtime(runtime_engine, commands, outbound, runtime_status);
            }) {
            Ok(handle) => handle,
            Err(_) => {
                status.shutdown_watchdog();
                let _ = watchdog_handle.join();
                return Err(HostError::Runtime);
            }
        };

        let mut entry = Self {
            authority,
            status,
            runtime: Some(runtime),
            runtime_handle: Some(runtime_handle),
            watchdog_handle: Some(watchdog_handle),
        };
        let (reply, loaded) = mpsc::sync_channel(1);
        if entry
            .runtime
            .as_ref()
            .expect("runtime sender disappeared")
            .send(RuntimeCommand::Load { request, reply })
            .is_err()
        {
            let _ = entry.stop(true);
            return Err(HostError::Runtime);
        }
        match loaded.recv() {
            Ok(Ok(())) => Ok(Ok(entry)),
            Ok(Err(code)) => {
                entry.stop(true)?;
                Ok(Err(code))
            }
            Err(_) => {
                let _ = entry.stop(true);
                Err(HostError::Runtime)
            }
        }
    }

    fn stop(&mut self, abort_active: bool) -> Result<(), HostError> {
        if abort_active {
            self.status.abort_active_and_wait();
        } else {
            self.status.cancel_active_and_wait();
        }

        let runtime_clean = if let Some(runtime) = self.runtime.take() {
            let (reply, stopped) = mpsc::sync_channel(1);
            runtime
                .send(RuntimeCommand::Shutdown { reply })
                .is_ok_and(|()| stopped.recv().is_ok())
        } else {
            true
        };
        let runtime_joined = self
            .runtime_handle
            .take()
            .is_none_or(|handle| handle.join().is_ok());
        self.status.shutdown_watchdog();
        let watchdog_joined = self
            .watchdog_handle
            .take()
            .is_none_or(|handle| handle.join().is_ok());
        if runtime_clean && runtime_joined && watchdog_joined {
            Ok(())
        } else {
            Err(HostError::Runtime)
        }
    }
}

impl Drop for RuntimeEntry {
    fn drop(&mut self) {
        let _ = self.stop(true);
    }
}

struct RuntimeCoordinator {
    engine: Engine,
    admission: Arc<SharedInvocationAdmission>,
    entries: BTreeMap<String, RuntimeEntry>,
}

impl RuntimeCoordinator {
    fn new(engine: Engine) -> Self {
        Self {
            engine,
            admission: Arc::new(SharedInvocationAdmission::default()),
            entries: BTreeMap::new(),
        }
    }

    fn abort_all(&mut self) -> Result<(), HostError> {
        self.stop_all(true)
    }

    fn stop_all(&mut self, abort_active: bool) -> Result<(), HostError> {
        let entries = std::mem::take(&mut self.entries);
        let mut failed = false;
        for (_, mut entry) in entries {
            failed |= entry.stop(abort_active).is_err();
        }
        if failed {
            Err(HostError::Runtime)
        } else {
            Ok(())
        }
    }
}

struct ProtocolState {
    host_session_id: Option<String>,
    coordinator: RuntimeCoordinator,
}

impl ProtocolState {
    fn new(engine: Engine) -> Self {
        Self {
            host_session_id: None,
            coordinator: RuntimeCoordinator::new(engine),
        }
    }

    fn session_matches(&self, fence: &AuthorityFence) -> bool {
        self.host_session_id
            .as_ref()
            .is_some_and(|session| session == &fence.host_session_id)
    }

    fn loaded_matches(&self, fence: &AuthorityFence) -> bool {
        self.coordinator
            .entries
            .get(&fence.plugin_id)
            .is_some_and(|entry| {
                entry.status.is_loaded()
                    && entry.authority.fence.same_activation(fence)
                    && self.session_matches(fence)
            })
    }
}

pub fn run_child(
    reader: &mut impl Read,
    writer: &mut (impl Write + Send),
) -> Result<(), HostError> {
    let mut config = Config::new();
    config
        .wasm_component_model(true)
        .wasm_component_model_gc(false)
        .async_support(false)
        .consume_fuel(true)
        .epoch_interruption(true)
        .allocation_strategy(InstanceAllocationStrategy::OnDemand)
        .memory_reservation(WASMTIME_MEMORY_RESERVATION_BYTES)
        .memory_guard_size(WASMTIME_MEMORY_GUARD_BYTES)
        .memory_reservation_for_growth(WASMTIME_MEMORY_RESERVATION_FOR_GROWTH_BYTES)
        .profiler(ProfilingStrategy::None)
        .max_wasm_stack(usize::try_from(GUEST_STACK_BYTES).map_err(|_| HostError::Engine)?);
    let engine = Engine::new(&config).map_err(|_| HostError::Engine)?;

    std::thread::scope(|scope| {
        let (outbound_sender, outbound_receiver) =
            mpsc::sync_channel::<OutboundMessage>(OUTBOUND_CHANNEL_CAPACITY);
        let writer_handle = std::thread::Builder::new()
            .name("junban-plugin-writer".into())
            .spawn_scoped(scope, move || {
                while let Ok(message) = outbound_receiver.recv() {
                    write_child_message(writer, &message.frame, &message.body)?;
                }
                Ok::<(), HostError>(())
            })
            .map_err(|_| HostError::Runtime)?;

        let mut state = ProtocolState::new(engine);
        let protocol_result = run_protocol_loop(reader, &outbound_sender, &mut state);
        let cleanup_result = state.coordinator.abort_all();
        drop(outbound_sender);
        let writer_result = writer_handle.join().map_err(|_| HostError::Runtime)?;

        protocol_result?;
        cleanup_result?;
        writer_result
    })
}

enum HeaderDisposition {
    Accept,
    SessionFatal(AuthorityFence, HostFailureCode),
}

fn run_protocol_loop(
    reader: &mut impl Read,
    outbound: &mpsc::SyncSender<OutboundMessage>,
    state: &mut ProtocolState,
) -> Result<(), HostError> {
    while let Some(frame) = read_parent_header(reader)? {
        match check_header_before_body(&frame, state)? {
            HeaderDisposition::Accept => {}
            HeaderDisposition::SessionFatal(fence, code) => {
                send_failed(outbound, fence, code)?;
                return Ok(());
            }
        }
        let body = read_parent_body(reader, &frame)?;
        if handle_message(ParentMessage::new(frame, body), state, outbound)? {
            return Ok(());
        }
    }
    Ok(())
}

fn check_header_before_body(
    frame: &ParentFrame,
    state: &ProtocolState,
) -> Result<HeaderDisposition, HostError> {
    if state
        .coordinator
        .entries
        .values()
        .any(|entry| entry.status.worker_stopped_unexpectedly())
    {
        return Err(HostError::Runtime);
    }

    let Some(session) = state.host_session_id.as_deref() else {
        return if matches!(frame, ParentFrame::Hello { .. }) {
            Ok(HeaderDisposition::Accept)
        } else {
            Err(HostError::Input)
        };
    };

    let fence = match frame {
        ParentFrame::Hello { .. } => return Err(HostError::Input),
        ParentFrame::Load { fence, .. }
        | ParentFrame::Invoke { fence, .. }
        | ParentFrame::Cancel { fence }
        | ParentFrame::Unload { fence } => Some(fence.clone()),
        ParentFrame::CapabilityReply { callback, .. } => Some(callback.authority()),
        ParentFrame::Shutdown { host_session_id } => {
            return if host_session_id == session {
                Ok(HeaderDisposition::Accept)
            } else {
                Err(HostError::Input)
            };
        }
    };
    let fence = fence.expect("authority-bearing frame disappeared");
    if fence.host_session_id != session {
        return Ok(HeaderDisposition::SessionFatal(
            fence,
            HostFailureCode::StaleAuthority,
        ));
    }
    if let Some(entry) = state.coordinator.entries.get(&fence.plugin_id) {
        if !entry.authority.fence.same_activation(&fence) {
            return Ok(HeaderDisposition::SessionFatal(
                fence,
                HostFailureCode::StaleAuthority,
            ));
        }
        if matches!(frame, ParentFrame::Load { .. }) {
            return Ok(HeaderDisposition::SessionFatal(
                fence,
                HostFailureCode::Unavailable,
            ));
        }
    } else if matches!(frame, ParentFrame::Load { .. }) {
        if state.coordinator.entries.len() >= HOST_RUNTIME_ENTRIES_MAX {
            return Ok(HeaderDisposition::SessionFatal(
                fence,
                HostFailureCode::ResourceLimit,
            ));
        }
    } else {
        return Ok(HeaderDisposition::SessionFatal(
            fence,
            HostFailureCode::StaleAuthority,
        ));
    }
    Ok(HeaderDisposition::Accept)
}

fn handle_message(
    message: ParentMessage,
    state: &mut ProtocolState,
    outbound: &mpsc::SyncSender<OutboundMessage>,
) -> Result<bool, HostError> {
    let ParentMessage { frame, body } = message;
    match frame {
        ParentFrame::Hello {
            protocol_name,
            protocol_version,
            junban_version,
            host_session_id,
        } => {
            if state.host_session_id.is_some()
                || protocol_name != HOST_PROTOCOL_NAME
                || protocol_version != HOST_PROTOCOL_VERSION
                || junban_version != HOST_JUNBAN_VERSION
            {
                return Err(HostError::Input);
            }
            state.host_session_id = Some(host_session_id.clone());
            send_frame(
                outbound,
                ChildFrame::Hello {
                    protocol_name: HOST_PROTOCOL_NAME.into(),
                    protocol_version: HOST_PROTOCOL_VERSION,
                    junban_version: HOST_JUNBAN_VERSION.into(),
                    host_session_id,
                },
            )?;
        }
        ParentFrame::Load {
            fence,
            import_export_fingerprint,
            runtime_profile,
            grants,
            permission_hash,
            limits,
            ..
        } => {
            if state.coordinator.entries.contains_key(&fence.plugin_id) {
                send_failed(outbound, fence, HostFailureCode::Unavailable)?;
                return Ok(true);
            }
            if state.coordinator.entries.len() >= HOST_RUNTIME_ENTRIES_MAX {
                send_failed(outbound, fence, HostFailureCode::ResourceLimit)?;
                return Ok(true);
            }
            let authority = LoadedAuthority {
                fence: fence.clone(),
                permission_hash: permission_hash.clone(),
                import_export_fingerprint: import_export_fingerprint.clone(),
                limits: limits.clone(),
            };
            let request = LoadRequest {
                component: body,
                import_export_fingerprint,
                runtime_profile,
                grants,
                limits,
            };
            match RuntimeEntry::load(
                &state.coordinator.engine,
                state.coordinator.admission.clone(),
                authority,
                request,
                outbound.clone(),
            )? {
                Ok(entry) => {
                    let loaded_fingerprint = entry.authority.import_export_fingerprint.clone();
                    state
                        .coordinator
                        .entries
                        .insert(fence.plugin_id.clone(), entry);
                    send_frame(
                        outbound,
                        ChildFrame::Loaded {
                            fence,
                            import_export_fingerprint: loaded_fingerprint,
                        },
                    )?;
                }
                Err(code) => {
                    send_failed(outbound, fence, code)?;
                    return Ok(true);
                }
            }
        }
        ParentFrame::Invoke {
            fence,
            kind,
            mode,
            permission_hash,
            ..
        } => {
            if !state.loaded_matches(&fence) {
                send_failed(outbound, fence, HostFailureCode::StaleAuthority)?;
                return Ok(false);
            }
            let entry = state
                .coordinator
                .entries
                .get(&fence.plugin_id)
                .expect("loaded runtime entry disappeared");
            if permission_hash != entry.authority.permission_hash || mode != kind.mode() {
                send_failed(outbound, fence, HostFailureCode::PermissionDenied)?;
                return Ok(false);
            }
            let timeout = Duration::from_millis(u64::from(
                entry.authority.limits.invocation_timeout_ms(kind),
            ));
            match entry.status.start(fence.clone(), timeout) {
                Ok(()) => {
                    if entry
                        .runtime
                        .as_ref()
                        .expect("runtime sender disappeared")
                        .send(RuntimeCommand::Invoke(InvokeRequest {
                            fence: fence.clone(),
                            kind,
                            mode,
                            body,
                        }))
                        .is_err()
                    {
                        entry.status.worker_stopped();
                        return Err(HostError::Runtime);
                    }
                }
                Err(StartError::Busy) => {
                    send_failed(outbound, fence, HostFailureCode::ResourceLimit)?;
                }
                Err(StartError::NotLoaded) => {
                    send_failed(outbound, fence, HostFailureCode::StaleAuthority)?;
                }
            }
        }
        ParentFrame::CapabilityReply { ref callback, .. } => {
            let failure_fence = callback.authority();
            let Some(entry) = state.coordinator.entries.get(&callback.plugin_id) else {
                send_failed(outbound, failure_fence, HostFailureCode::StaleAuthority)?;
                return Ok(false);
            };
            let code = match entry.status.route_callback(ParentMessage::new(frame, body)) {
                Ok(()) => return Ok(false),
                Err(CallbackRouteError::Stale) => HostFailureCode::StaleAuthority,
                Err(CallbackRouteError::Wrong) => HostFailureCode::InvalidFrame,
            };
            send_failed(outbound, failure_fence, code)?;
        }
        ParentFrame::Cancel { fence } => {
            if !state.loaded_matches(&fence) {
                send_failed(outbound, fence, HostFailureCode::StaleAuthority)?;
            } else {
                let entry = state
                    .coordinator
                    .entries
                    .get(&fence.plugin_id)
                    .expect("loaded runtime entry disappeared");
                match entry.status.cancel_and_wait(&fence) {
                    CancelResult::Won => {}
                    CancelResult::Lost | CancelResult::Stale => {
                        send_failed(outbound, fence, HostFailureCode::StaleAuthority)?;
                    }
                    CancelResult::WorkerStopped => return Err(HostError::Runtime),
                }
            }
        }
        ParentFrame::Unload { fence } => {
            if !state.loaded_matches(&fence) {
                send_failed(outbound, fence, HostFailureCode::StaleAuthority)?;
            } else {
                let mut entry = state
                    .coordinator
                    .entries
                    .remove(&fence.plugin_id)
                    .expect("loaded runtime entry disappeared");
                entry.stop(false)?;
                send_frame(outbound, ChildFrame::Unloaded { fence })?;
            }
        }
        ParentFrame::Shutdown { host_session_id } => {
            state.coordinator.stop_all(false)?;
            send_frame(outbound, ChildFrame::ShutdownComplete { host_session_id })?;
            return Ok(true);
        }
    }
    Ok(false)
}

fn send_frame(
    outbound: &mpsc::SyncSender<OutboundMessage>,
    frame: ChildFrame,
) -> Result<(), HostError> {
    outbound
        .send(OutboundMessage::frame(frame))
        .map_err(|_| HostError::Output)
}

fn send_failed(
    outbound: &mpsc::SyncSender<OutboundMessage>,
    fence: AuthorityFence,
    code: HostFailureCode,
) -> Result<(), HostError> {
    send_frame(outbound, ChildFrame::Failed { fence, code })
}

#[cfg(test)]
mod tests {
    use super::*;
    use junban_plugin_sdk::{
        CallbackFence, CapabilityReplyKind, HostCallKind, ParentFrame, RuntimeLimits,
        RuntimeProfile, canonical_permission_hash, encode_parent_frame,
    };
    use std::io::Cursor;

    fn fence(invocation: &str) -> AuthorityFence {
        AuthorityFence {
            plugin_id: "test-plugin".into(),
            package_generation: 4,
            activation_epoch: 8,
            host_session_id: "00000000-0000-4000-8000-000000000001".into(),
            invocation_id: invocation.into(),
        }
    }

    #[test]
    fn engine_memory_tuning_matches_the_largest_one_memory_profile() {
        assert_eq!(
            WASMTIME_MEMORY_RESERVATION_BYTES,
            RuntimeLimits::for_profile(RuntimeProfile::Typescript).linear_memory_bytes
        );
        assert_eq!(WASMTIME_MEMORY_RESERVATION_BYTES, 128 * 1024 * 1024);
        assert_eq!(WASMTIME_MEMORY_GUARD_BYTES, 0);
        assert_eq!(WASMTIME_MEMORY_RESERVATION_FOR_GROWTH_BYTES, 0);
    }

    #[test]
    fn message_codec_consumes_exact_raw_bodies() {
        let component = b"component";
        let frame = ParentFrame::Load {
            fence: fence("00000000-0000-4000-8000-000000000002"),
            package_sha256: "1".repeat(64),
            component_sha256: "6985ca1f4daa5a584a28eae043a239cb96689af1337ea13afb63e00c2bf512fa"
                .into(),
            import_export_fingerprint: "2".repeat(64),
            runtime_profile: RuntimeProfile::Typescript,
            component_size: component.len() as u64,
            grants: Vec::new(),
            permission_hash: canonical_permission_hash(&[]).unwrap(),
            limits: RuntimeLimits::for_profile(RuntimeProfile::Typescript),
        };
        let mut bytes = encode_parent_frame(&frame).unwrap();
        bytes.extend_from_slice(component);
        let message = read_parent_message(&mut Cursor::new(bytes))
            .unwrap()
            .unwrap();
        assert_eq!(message.frame, frame);
        assert_eq!(message.body, component);
    }

    #[test]
    fn message_codec_rejects_truncated_and_noncanonical_callback_bodies() {
        let callback = CallbackFence {
            plugin_id: "test-plugin".into(),
            package_generation: 4,
            activation_epoch: 8,
            host_session_id: "00000000-0000-4000-8000-000000000001".into(),
            invocation_id: "00000000-0000-4000-8000-000000000002".into(),
            callback_id: 1,
        };
        let frame = ParentFrame::CapabilityReply {
            callback,
            kind: HostCallKind::Log,
            result: CapabilityReplyKind::Success,
            response_sha256: "2f05d4b689d270cafb02285f35f44866f7dc8a2d368a3f9d1124373eeab31fb1"
                .into(),
            response_size: 3,
        };
        let mut bytes = encode_parent_frame(&frame).unwrap();
        bytes.extend_from_slice(b"bad");
        assert!(matches!(
            read_parent_message(&mut Cursor::new(bytes)),
            Err(HostError::Input)
        ));
    }
}
