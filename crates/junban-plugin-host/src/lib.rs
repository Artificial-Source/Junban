#![forbid(unsafe_code)]

mod bindings;
mod generated_body_adapters;
mod runtime;
mod transfer_bounds;

use std::{
    io::{self, Read, Write},
    sync::{Arc, mpsc},
    time::Duration,
};

use junban_plugin_sdk::{
    AuthorityFence, ChildFrame, GUEST_STACK_BYTES, HOST_FRAME_BYTES_MAX, HOST_PROTOCOL_NAME,
    HOST_PROTOCOL_VERSION, HostFailureCode, ParentFrame, TYPESCRIPT_LINEAR_MEMORY_BYTES,
    decode_parent_frame, encode_child_frame, parent_body_len, validate_child_body,
    validate_parent_body,
};
use wasmtime::{Config, Engine, InstanceAllocationStrategy, ProfilingStrategy};

use runtime::{
    CallbackRouteError, CancelResult, InvokeRequest, LoadRequest, OutboundMessage, RuntimeCommand,
    SharedRuntimeStatus, StartError,
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
    let frame = decode_parent_frame(&encoded).map_err(|_| HostError::Input)?;
    let body_len = parent_body_len(&frame).map_err(|_| HostError::Input)?;
    let mut body = vec![0; body_len];
    read_exact_input(reader, &mut body)?;
    validate_parent_body(&frame, &body).map_err(|_| HostError::Input)?;
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

struct ProtocolState {
    host_session_id: Option<String>,
    load_attempted: bool,
    loaded: Option<LoadedAuthority>,
}

impl ProtocolState {
    fn new() -> Self {
        Self {
            host_session_id: None,
            load_attempted: false,
            loaded: None,
        }
    }

    fn session_matches(&self, fence: &AuthorityFence) -> bool {
        self.host_session_id
            .as_ref()
            .is_some_and(|session| session == &fence.host_session_id)
    }

    fn loaded_matches(&self, fence: &AuthorityFence, status: &SharedRuntimeStatus) -> bool {
        status.is_loaded()
            && self.loaded.as_ref().is_some_and(|loaded| {
                loaded.fence.same_activation(fence) && self.session_matches(fence)
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
        let (runtime_sender, runtime_receiver) = mpsc::sync_channel::<RuntimeCommand>(1);
        let status = Arc::new(SharedRuntimeStatus::default());

        let writer_handle = std::thread::Builder::new()
            .name("junban-plugin-writer".into())
            .spawn_scoped(scope, move || {
                while let Ok(message) = outbound_receiver.recv() {
                    write_child_message(writer, &message.frame, &message.body)?;
                }
                Ok::<(), HostError>(())
            })
            .map_err(|_| HostError::Runtime)?;

        let watchdog_status = status.clone();
        let watchdog_engine = engine.clone();
        let watchdog_handle = std::thread::Builder::new()
            .name("junban-plugin-watchdog".into())
            .spawn_scoped(scope, move || {
                watchdog_status.run_watchdog(&watchdog_engine);
            })
            .map_err(|_| HostError::Runtime)?;
        struct WatchdogShutdown(Arc<SharedRuntimeStatus>);
        impl Drop for WatchdogShutdown {
            fn drop(&mut self) {
                self.0.abort_active_and_wait();
                self.0.shutdown_watchdog();
            }
        }
        // Also releases the watchdog if a later scoped-thread spawn fails.
        let _watchdog_shutdown = WatchdogShutdown(status.clone());

        let runtime_status = status.clone();
        let runtime_outbound = outbound_sender.clone();
        let runtime_handle = std::thread::Builder::new()
            .name("junban-plugin-runtime".into())
            .stack_size(RUNTIME_THREAD_STACK_BYTES)
            .spawn_scoped(scope, move || {
                runtime::run_runtime(engine, runtime_receiver, runtime_outbound, runtime_status);
            })
            .map_err(|_| HostError::Runtime)?;

        let protocol_result = run_protocol_loop(reader, &runtime_sender, &outbound_sender, &status);

        status.abort_active_and_wait();
        let (shutdown_sender, shutdown_receiver) = mpsc::sync_channel(1);
        if runtime_sender
            .send(RuntimeCommand::Shutdown {
                reply: shutdown_sender,
            })
            .is_ok()
        {
            let _ = shutdown_receiver.recv();
        }
        drop(runtime_sender);
        runtime_handle.join().map_err(|_| HostError::Runtime)?;
        status.shutdown_watchdog();
        watchdog_handle.join().map_err(|_| HostError::Runtime)?;
        drop(outbound_sender);
        let writer_result = writer_handle.join().map_err(|_| HostError::Runtime)?;

        protocol_result?;
        writer_result
    })
}

fn run_protocol_loop(
    reader: &mut impl Read,
    runtime: &mpsc::SyncSender<RuntimeCommand>,
    outbound: &mpsc::SyncSender<OutboundMessage>,
    status: &SharedRuntimeStatus,
) -> Result<(), HostError> {
    let mut state = ProtocolState::new();
    while let Some(message) = read_parent_message(reader)? {
        let stop = handle_message(message, &mut state, runtime, outbound, status)?;
        if stop {
            return Ok(());
        }
    }
    Ok(())
}

fn handle_message(
    message: ParentMessage,
    state: &mut ProtocolState,
    runtime: &mpsc::SyncSender<RuntimeCommand>,
    outbound: &mpsc::SyncSender<OutboundMessage>,
    status: &SharedRuntimeStatus,
) -> Result<bool, HostError> {
    match message.frame {
        ParentFrame::Hello {
            protocol_name,
            protocol_version,
            host_session_id,
        } => {
            if state.host_session_id.is_some()
                || protocol_name != HOST_PROTOCOL_NAME
                || protocol_version != HOST_PROTOCOL_VERSION
            {
                return Err(HostError::Input);
            }
            state.host_session_id = Some(host_session_id.clone());
            send_frame(
                outbound,
                ChildFrame::Hello {
                    protocol_name: HOST_PROTOCOL_NAME.into(),
                    protocol_version: HOST_PROTOCOL_VERSION,
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
            if state.host_session_id.is_none() {
                return Err(HostError::Input);
            }
            if state.load_attempted {
                send_failed(outbound, fence, HostFailureCode::Unavailable)?;
                return Ok(false);
            }
            state.load_attempted = true;
            if !state.session_matches(&fence) {
                send_failed(outbound, fence, HostFailureCode::StaleAuthority)?;
                return Ok(false);
            }
            let loaded_authority = LoadedAuthority {
                fence: fence.clone(),
                permission_hash: permission_hash.clone(),
                import_export_fingerprint: import_export_fingerprint.clone(),
                limits: limits.clone(),
            };
            let (reply_sender, reply_receiver) = mpsc::sync_channel(1);
            runtime
                .send(RuntimeCommand::Load {
                    request: LoadRequest {
                        component: message.body,
                        import_export_fingerprint,
                        runtime_profile,
                        grants,
                        limits,
                    },
                    reply: reply_sender,
                })
                .map_err(|_| HostError::Runtime)?;
            match reply_receiver.recv().map_err(|_| HostError::Runtime)? {
                Ok(()) => {
                    let loaded_fingerprint = loaded_authority.import_export_fingerprint.clone();
                    state.loaded = Some(loaded_authority);
                    send_frame(
                        outbound,
                        ChildFrame::Loaded {
                            fence,
                            import_export_fingerprint: loaded_fingerprint,
                        },
                    )?;
                }
                Err(code) => send_failed(outbound, fence, code)?,
            }
        }
        ParentFrame::Invoke {
            fence,
            kind,
            mode,
            permission_hash,
            ..
        } => {
            if !state.loaded_matches(&fence, status) {
                send_failed(outbound, fence, HostFailureCode::StaleAuthority)?;
                return Ok(false);
            }
            let loaded = state.loaded.as_ref().expect("loaded authority disappeared");
            if permission_hash != loaded.permission_hash || mode != kind.mode() {
                send_failed(outbound, fence, HostFailureCode::PermissionDenied)?;
                return Ok(false);
            }
            let timeout =
                Duration::from_millis(u64::from(loaded.limits.invocation_timeout_ms(kind)));
            match status.start(fence.clone(), timeout) {
                Ok(()) => {
                    if runtime
                        .send(RuntimeCommand::Invoke(InvokeRequest {
                            fence: fence.clone(),
                            kind,
                            mode,
                            body: message.body,
                        }))
                        .is_err()
                    {
                        status.worker_stopped();
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
            let code = match status.route_callback(message) {
                Ok(()) => return Ok(false),
                Err(CallbackRouteError::Stale) => HostFailureCode::StaleAuthority,
                Err(CallbackRouteError::Wrong) => HostFailureCode::InvalidFrame,
            };
            send_failed(outbound, failure_fence, code)?;
        }
        ParentFrame::Cancel { fence } => {
            if !state.loaded_matches(&fence, status) {
                send_failed(outbound, fence, HostFailureCode::StaleAuthority)?;
            } else {
                match status.cancel_and_wait(&fence) {
                    CancelResult::Won => {}
                    CancelResult::Lost | CancelResult::Stale => {
                        send_failed(outbound, fence, HostFailureCode::StaleAuthority)?;
                    }
                    CancelResult::WorkerStopped => return Err(HostError::Runtime),
                }
            }
        }
        ParentFrame::Unload { fence } => {
            if !state.loaded_matches(&fence, status) {
                send_failed(outbound, fence, HostFailureCode::StaleAuthority)?;
            } else {
                status.cancel_active_and_wait();
                let (reply_sender, reply_receiver) = mpsc::sync_channel(1);
                runtime
                    .send(RuntimeCommand::Unload {
                        reply: reply_sender,
                    })
                    .map_err(|_| HostError::Runtime)?;
                reply_receiver.recv().map_err(|_| HostError::Runtime)?;
                state.loaded = None;
                send_frame(outbound, ChildFrame::Unloaded { fence })?;
            }
        }
        ParentFrame::Shutdown { host_session_id } => {
            if state.host_session_id.as_deref() != Some(host_session_id.as_str()) {
                return Err(HostError::Input);
            }
            status.cancel_active_and_wait();
            let (reply_sender, reply_receiver) = mpsc::sync_channel(1);
            runtime
                .send(RuntimeCommand::Shutdown {
                    reply: reply_sender,
                })
                .map_err(|_| HostError::Runtime)?;
            reply_receiver.recv().map_err(|_| HostError::Runtime)?;
            state.loaded = None;
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
