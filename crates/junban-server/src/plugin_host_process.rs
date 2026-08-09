//! Strict parent-side ownership of the private plugin-host child process.
//!
//! This module owns only process discovery, framed transport, handshake, load,
//! and deterministic teardown. Durable plugin state, admission, capabilities,
//! effects, and health remain outside this boundary.

#![allow(
    dead_code,
    reason = "the additive runtime-driver handoff intentionally has no production caller before the Slice 2C supervisor"
)]

use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, AtomicUsize, Ordering},
        mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

use junban_plugin_sdk::{
    AuthorityFence, COMMAND_TIMEOUT_MS, COMPILE_TIMEOUT_MS, ChildFrame,
    HOST_CALLBACK_BODY_BYTES_MAX, HOST_JUNBAN_VERSION, HOST_PROTOCOL_NAME, HOST_PROTOCOL_VERSION,
    HOST_RUNTIME_ENTRIES_MAX, HostFailureCode, ParentFrame, ParentMessage, Permission,
    RuntimeLimits, RuntimeProfile, Sha256Digest, canonical_permission_hash, child_body_len,
    read_child_body, read_child_frame, validate_child_hello, validate_parent_body,
    write_parent_message,
};
use thiserror::Error;
use uuid::Uuid;

const WRITER_CHANNEL_CAPACITY: usize = 1;
const READER_CHANNEL_CAPACITY: usize = 1;
const READER_CONTROL_CHANNEL_CAPACITY: usize = 1;
const WORKER_STATUS_CHANNEL_CAPACITY: usize = 3;
// Four command slots match the frozen process invocation ceiling. The driver
// drains them independently of reader waits; a fifth producer fails closed.
const RUNTIME_DRIVER_COMMAND_CAPACITY: usize = 4;
// Seven data slots bound a burst of bodyless headers and reserve the eighth for
// the post-reap terminal event. Staged authorization means at most one slot can
// own a body allocation while the reader is unable to advance to another body.
const RUNTIME_DRIVER_EVENT_CAPACITY: usize = 8;
const RUNTIME_DRIVER_DATA_EVENT_CAPACITY: usize = RUNTIME_DRIVER_EVENT_CAPACITY - 1;
// Wake notifications coalesce because every source remains in its own bounded
// channel until the sole driver drains it.
const RUNTIME_DRIVER_WAKE_CAPACITY: usize = 1;
// Four ordinary invocation bodies fit, but at most one maximum-sized callback
// reply can exist across the command queue and active writer. This prevents
// queue slots from multiplying the SDK's largest body allocation.
const RUNTIME_DRIVER_QUEUED_BODY_BYTES_MAX: usize = HOST_CALLBACK_BODY_BYTES_MAX;
const STDERR_BUFFER_BYTES: usize = 8 * 1024;
const CHILD_STATUS_POLL_INTERVAL: Duration = Duration::from_millis(10);
const PRODUCT_CONTROL_DEADLINE: Duration = Duration::from_millis(COMMAND_TIMEOUT_MS as u64);
const PRODUCT_COMPILE_LOAD_DEADLINE: Duration = Duration::from_millis(COMPILE_TIMEOUT_MS as u64);

/// Stable, redacted failures from the plugin-host process boundary.
#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum PluginHostProcessError {
    #[error("the current Junban executable could not be resolved")]
    CurrentExecutableUnavailable,
    #[error("the plugin host executable path must be absolute")]
    ExecutableNotAbsolute,
    #[error("the plugin host executable was not found next to Junban")]
    ExecutableMissing,
    #[error("plugin host executable links are not allowed")]
    ExecutableLinkRejected,
    #[error("the plugin host executable is not a strict regular file")]
    ExecutableNotRegular,
    #[error("the plugin host executable is not executable")]
    ExecutableNotExecutable,
    #[error("the plugin host process could not be started")]
    SpawnFailed,
    #[error("the plugin host handshake exceeded its control deadline")]
    HandshakeTimeout,
    #[error("the plugin host compile/load deadline expired")]
    CompileLoadTimeout,
    #[error("the plugin host control deadline expired")]
    ControlTimeout,
    #[error("the plugin host protocol was rejected")]
    ProtocolRejected,
    #[error("the plugin host transport failed")]
    TransportFailed,
    #[error("a plugin host transport worker failed")]
    WorkerFailed,
    #[error("the plugin host runtime driver exceeded its bounded pressure")]
    Backpressure,
    #[error("the plugin host runtime driver was forcibly closed")]
    ForcedClosed,
    #[error("the plugin host process is closed")]
    Closed,
    #[error("the plugin host already contains sixteen runtimes")]
    LoadLimit,
    #[error("the plugin host rejected a load ({0:?})")]
    LoadFailed(HostFailureCode),
    #[error("the plugin host process could not be reaped cleanly")]
    CleanupFailed,
}

/// One already-verified component selected by the future parent supervisor.
///
/// Only the component bytes required by the child are transferred. Package
/// paths and complete package bytes never enter this process owner.
#[derive(Debug)]
pub struct PluginHostLoad {
    pub fence: AuthorityFence,
    pub package_sha256: Sha256Digest,
    pub import_export_fingerprint: Sha256Digest,
    pub runtime_profile: RuntimeProfile,
    pub grants: Vec<Permission>,
    pub component: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProcessPhase {
    Handshake,
    Loading,
    Running,
    Closing,
    Closed,
}

#[derive(Clone, Copy)]
struct ProcessDeadlines {
    control: Duration,
    compile_load: Duration,
}

impl ProcessDeadlines {
    const PRODUCT: Self = Self {
        control: PRODUCT_CONTROL_DEADLINE,
        compile_load: PRODUCT_COMPILE_LOAD_DEADLINE,
    };
}

struct WriterCommand {
    message: ParentMessage,
    completed: SyncSender<Result<Instant, ()>>,
    #[cfg(test)]
    panic_for_test: bool,
}

enum ReaderControl {
    ReadBody,
    #[cfg(test)]
    PanicForTest,
}

enum ReaderEvent {
    Header(ChildFrame, Instant),
    Body(Vec<u8>, Instant),
    Eof(Instant),
    ProtocolFailure,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WorkerKind {
    Writer,
    Reader,
    Stderr,
}

/// Opaque authority to read the one SDK-bounded body following a runtime header.
///
/// The private field and lack of `Clone` make this a consume-on-authorization
/// capability for the later single supervisor actor.
#[derive(Eq, PartialEq)]
pub(crate) struct PendingPluginHostBodyToken(u64);

impl std::fmt::Debug for PendingPluginHostBodyToken {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("PendingPluginHostBodyToken(..)")
    }
}

/// Validated process events consumed by the later single supervisor actor.
#[derive(Debug, Eq, PartialEq)]
pub(crate) enum PluginHostRuntimeEvent {
    Header {
        frame: ChildFrame,
        pending_body: Option<PendingPluginHostBodyToken>,
    },
    Body {
        frame: ChildFrame,
        body: Vec<u8>,
    },
    /// Emitted only after the child is reaped and every transport worker joined.
    Closed(Result<(), PluginHostProcessError>),
}

// The sole terminal authority has only monotonic CAS transitions:
// Open -> GracefulInProgress -> GracefulCommitted, while every forced state
// may win from Open or GracefulInProgress and no committed state is rewritten.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
enum RuntimeDriverTerminalState {
    Open = 0,
    GracefulInProgress = 1,
    GracefulCommitted = 2,
    ForcedClosed = 3,
    ForcedPressure = 4,
    ForcedProtocol = 5,
    ForcedWorker = 6,
}

impl RuntimeDriverTerminalState {
    fn from_raw(raw: u8) -> Self {
        match raw {
            0 => Self::Open,
            1 => Self::GracefulInProgress,
            2 => Self::GracefulCommitted,
            3 => Self::ForcedClosed,
            4 => Self::ForcedPressure,
            5 => Self::ForcedProtocol,
            6 => Self::ForcedWorker,
            _ => Self::ForcedProtocol,
        }
    }

    const fn is_forced(self) -> bool {
        matches!(
            self,
            Self::ForcedClosed | Self::ForcedPressure | Self::ForcedProtocol | Self::ForcedWorker
        )
    }

    const fn error(self) -> Option<PluginHostProcessError> {
        match self {
            Self::ForcedClosed => Some(PluginHostProcessError::ForcedClosed),
            Self::ForcedPressure => Some(PluginHostProcessError::Backpressure),
            Self::ForcedProtocol => Some(PluginHostProcessError::ProtocolRejected),
            Self::ForcedWorker => Some(PluginHostProcessError::WorkerFailed),
            Self::Open | Self::GracefulInProgress | Self::GracefulCommitted => None,
        }
    }

    const fn for_error(error: PluginHostProcessError) -> Self {
        match error {
            PluginHostProcessError::Backpressure => Self::ForcedPressure,
            PluginHostProcessError::ProtocolRejected => Self::ForcedProtocol,
            PluginHostProcessError::WorkerFailed | PluginHostProcessError::CleanupFailed => {
                Self::ForcedWorker
            }
            _ => Self::ForcedClosed,
        }
    }
}

#[derive(Clone, Copy)]
struct RuntimeDriverTerminalTransition {
    state: RuntimeDriverTerminalState,
    won: bool,
}

struct RuntimeBodyReservation {
    shared: Arc<RuntimeDriverShared>,
    body_bytes: usize,
}

impl Drop for RuntimeBodyReservation {
    fn drop(&mut self) {
        self.shared.release_body_bytes(self.body_bytes);
    }
}

enum RuntimeDriverCommand {
    Send {
        message: Box<ParentMessage>,
        reservation: RuntimeBodyReservation,
        deadline: Instant,
    },
    AuthorizeBody {
        token: PendingPluginHostBodyToken,
        deadline: Instant,
    },
    Shutdown,
    #[cfg(test)]
    PanicDriverForTest,
    #[cfg(test)]
    PanicWriterForTest,
    #[cfg(test)]
    PanicReaderForTest,
}

struct RuntimeDriverShared {
    terminal_state: AtomicU8,
    admission: Mutex<()>,
    queued_body_bytes: AtomicUsize,
    queued_data_events: AtomicUsize,
}

impl RuntimeDriverShared {
    fn new() -> Self {
        Self {
            terminal_state: AtomicU8::new(RuntimeDriverTerminalState::Open as u8),
            admission: Mutex::new(()),
            queued_body_bytes: AtomicUsize::new(0),
            queued_data_events: AtomicUsize::new(0),
        }
    }

    fn terminal_state(&self) -> RuntimeDriverTerminalState {
        RuntimeDriverTerminalState::from_raw(self.terminal_state.load(Ordering::Acquire))
    }

    fn begin_graceful(&self) -> bool {
        self.terminal_state
            .compare_exchange(
                RuntimeDriverTerminalState::Open as u8,
                RuntimeDriverTerminalState::GracefulInProgress as u8,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    fn commit_graceful(&self) -> Result<(), RuntimeDriverTerminalState> {
        self.terminal_state
            .compare_exchange(
                RuntimeDriverTerminalState::GracefulInProgress as u8,
                RuntimeDriverTerminalState::GracefulCommitted as u8,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .map(|_| ())
            .map_err(RuntimeDriverTerminalState::from_raw)
    }

    fn force_terminal(
        &self,
        forced: RuntimeDriverTerminalState,
    ) -> RuntimeDriverTerminalTransition {
        debug_assert!(forced.is_forced());
        let mut observed = self.terminal_state.load(Ordering::Acquire);
        loop {
            let state = RuntimeDriverTerminalState::from_raw(observed);
            if !matches!(
                state,
                RuntimeDriverTerminalState::Open | RuntimeDriverTerminalState::GracefulInProgress
            ) {
                return RuntimeDriverTerminalTransition { state, won: false };
            }
            match self.terminal_state.compare_exchange_weak(
                observed,
                forced as u8,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    return RuntimeDriverTerminalTransition {
                        state: forced,
                        won: true,
                    };
                }
                Err(actual) => observed = actual,
            }
        }
    }

    fn reserve_body_bytes(self: &Arc<Self>, body_bytes: usize) -> Option<RuntimeBodyReservation> {
        let mut queued = self.queued_body_bytes.load(Ordering::Acquire);
        loop {
            let updated = queued.checked_add(body_bytes)?;
            if updated > RUNTIME_DRIVER_QUEUED_BODY_BYTES_MAX {
                return None;
            }
            match self.queued_body_bytes.compare_exchange_weak(
                queued,
                updated,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    return Some(RuntimeBodyReservation {
                        shared: self.clone(),
                        body_bytes,
                    });
                }
                Err(actual) => queued = actual,
            }
        }
    }

    fn release_body_bytes(&self, body_bytes: usize) {
        self.queued_body_bytes
            .fetch_sub(body_bytes, Ordering::AcqRel);
    }
}

/// Immediate, bounded command admission for one consumed runtime process.
pub(crate) struct PluginHostRuntimeDriverHandle {
    commands: Option<SyncSender<RuntimeDriverCommand>>,
    wake: SyncSender<()>,
    shared: Arc<RuntimeDriverShared>,
}

impl PluginHostRuntimeDriverHandle {
    /// Admit one exact SDK runtime message without waiting on child I/O.
    pub(crate) fn send(
        &self,
        message: ParentMessage,
        deadline: Instant,
    ) -> Result<(), PluginHostProcessError> {
        if !runtime_parent_frame_allowed(&message.frame)
            || validate_parent_body(&message.frame, &message.body).is_err()
        {
            self.shared
                .force_terminal(RuntimeDriverTerminalState::ForcedProtocol);
            signal_driver(&self.wake);
            return Err(PluginHostProcessError::ProtocolRejected);
        }

        let _admission = self
            .shared
            .admission
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.shared.terminal_state() != RuntimeDriverTerminalState::Open {
            return Err(PluginHostProcessError::Closed);
        }
        let Some(reservation) = self.shared.reserve_body_bytes(message.body.len()) else {
            self.shared
                .force_terminal(RuntimeDriverTerminalState::ForcedPressure);
            signal_driver(&self.wake);
            return Err(PluginHostProcessError::Backpressure);
        };
        self.enqueue_admitted(RuntimeDriverCommand::Send {
            message: Box::new(message),
            reservation,
            deadline,
        })
    }

    /// Consume the exact token emitted with a pending-body header.
    pub(crate) fn authorize_body(
        &self,
        token: PendingPluginHostBodyToken,
        deadline: Instant,
    ) -> Result<(), PluginHostProcessError> {
        self.enqueue_open(RuntimeDriverCommand::AuthorizeBody { token, deadline })
    }

    /// Admit the security-reviewed graceful process shutdown request.
    /// `Ok` confirms admission only; the terminal event reports its outcome.
    pub(crate) fn shutdown(&self) -> Result<(), PluginHostProcessError> {
        let _admission = self
            .shared
            .admission
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !self.shared.begin_graceful() {
            return Err(PluginHostProcessError::Closed);
        }
        self.enqueue_admitted(RuntimeDriverCommand::Shutdown)
    }

    /// Admit a forced kill/wait/reap request. Repeated requests are safe.
    /// `Ok` confirms admission only; the terminal event reports its outcome.
    pub(crate) fn fatal_close(&self) -> Result<(), PluginHostProcessError> {
        self.shared
            .force_terminal(RuntimeDriverTerminalState::ForcedClosed);
        signal_driver(&self.wake);
        Ok(())
    }

    fn enqueue_open(&self, command: RuntimeDriverCommand) -> Result<(), PluginHostProcessError> {
        let _admission = self
            .shared
            .admission
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.shared.terminal_state() != RuntimeDriverTerminalState::Open {
            return Err(PluginHostProcessError::Closed);
        }
        self.enqueue_admitted(command)
    }

    fn enqueue_admitted(
        &self,
        command: RuntimeDriverCommand,
    ) -> Result<(), PluginHostProcessError> {
        let Some(commands) = self.commands.as_ref() else {
            self.shared
                .force_terminal(RuntimeDriverTerminalState::ForcedClosed);
            signal_driver(&self.wake);
            return Err(PluginHostProcessError::Closed);
        };
        match commands.try_send(command) {
            Ok(()) => {
                signal_driver(&self.wake);
                Ok(())
            }
            Err(TrySendError::Full(_)) => {
                self.shared
                    .force_terminal(RuntimeDriverTerminalState::ForcedPressure);
                signal_driver(&self.wake);
                Err(PluginHostProcessError::Backpressure)
            }
            Err(TrySendError::Disconnected(_)) => {
                self.shared
                    .force_terminal(RuntimeDriverTerminalState::ForcedClosed);
                signal_driver(&self.wake);
                Err(PluginHostProcessError::Closed)
            }
        }
    }

    #[cfg(test)]
    fn panic_driver_for_test(&self) -> Result<(), PluginHostProcessError> {
        self.enqueue_open(RuntimeDriverCommand::PanicDriverForTest)
    }

    #[cfg(test)]
    fn panic_writer_for_test(&self) -> Result<(), PluginHostProcessError> {
        self.enqueue_open(RuntimeDriverCommand::PanicWriterForTest)
    }

    #[cfg(test)]
    fn panic_reader_for_test(&self) -> Result<(), PluginHostProcessError> {
        self.enqueue_open(RuntimeDriverCommand::PanicReaderForTest)
    }
}

impl Drop for PluginHostRuntimeDriverHandle {
    fn drop(&mut self) {
        let _admission = self
            .shared
            .admission
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.shared
            .force_terminal(RuntimeDriverTerminalState::ForcedClosed);
        self.commands.take();
        signal_driver(&self.wake);
    }
}

/// Bounded runtime event receiver and owner of the joined driver thread.
pub(crate) struct PluginHostRuntimeEvents {
    events: Receiver<PluginHostRuntimeEvent>,
    wake: SyncSender<()>,
    shared: Arc<RuntimeDriverShared>,
    driver_handle: Option<JoinHandle<()>>,
}

impl PluginHostRuntimeEvents {
    pub(crate) fn recv(&self) -> Result<PluginHostRuntimeEvent, mpsc::RecvError> {
        let event = self.events.recv()?;
        self.release_event_slot(&event);
        Ok(event)
    }

    pub(crate) fn recv_timeout(
        &self,
        timeout: Duration,
    ) -> Result<PluginHostRuntimeEvent, mpsc::RecvTimeoutError> {
        let event = self.events.recv_timeout(timeout)?;
        self.release_event_slot(&event);
        Ok(event)
    }

    fn release_event_slot(&self, event: &PluginHostRuntimeEvent) {
        if !matches!(event, PluginHostRuntimeEvent::Closed(_)) {
            self.shared
                .queued_data_events
                .fetch_sub(1, Ordering::AcqRel);
        }
    }
}

impl Drop for PluginHostRuntimeEvents {
    fn drop(&mut self) {
        self.shared
            .force_terminal(RuntimeDriverTerminalState::ForcedClosed);
        signal_driver(&self.wake);
        if let Some(handle) = self.driver_handle.take() {
            let _ = handle.join();
        }
    }
}

/// One connected plugin-host process and every pipe/worker needed to own it.
///
/// Product construction performs exact sibling discovery. The process is lazy
/// because no ordinary server state owns or constructs this value yet.
pub struct PluginHostProcess {
    child: Option<Child>,
    writer: Option<SyncSender<WriterCommand>>,
    reader_control: Option<SyncSender<ReaderControl>>,
    reader_events: Option<Receiver<ReaderEvent>>,
    worker_status: Option<Receiver<WorkerKind>>,
    writer_handle: Option<JoinHandle<()>>,
    reader_handle: Option<JoinHandle<()>>,
    stderr_handle: Option<JoinHandle<()>>,
    wake_sender: SyncSender<()>,
    wake_receiver: Option<Receiver<()>>,
    host_session_id: String,
    loaded: BTreeMap<String, AuthorityFence>,
    pending_body: Option<ChildFrame>,
    phase: ProcessPhase,
    deadlines: ProcessDeadlines,
}

impl PluginHostProcess {
    /// Discover and connect the exact product sibling plugin host.
    pub fn connect(host_session_id: Uuid) -> Result<Self, PluginHostProcessError> {
        let executable = discover_product_executable()?;
        Self::connect_validated(&executable, host_session_id, ProcessDeadlines::PRODUCT)
    }

    /// Load one already-verified component in caller-selected dependency order.
    ///
    /// A failed load is fatal to the singular child session. The seventeenth
    /// load is rejected locally before any header or component byte is written.
    pub fn load(&mut self, load: PluginHostLoad) -> Result<(), PluginHostProcessError> {
        if self.phase != ProcessPhase::Loading {
            return self.fail(PluginHostProcessError::Closed);
        }
        if self.loaded.len() >= HOST_RUNTIME_ENTRIES_MAX {
            return Err(PluginHostProcessError::LoadLimit);
        }
        if self.loaded.contains_key(&load.fence.plugin_id)
            || load.fence.host_session_id != self.host_session_id
        {
            return self.fail(PluginHostProcessError::ProtocolRejected);
        }

        let permission_hash = match canonical_permission_hash(&load.grants) {
            Some(hash) => hash,
            None => return self.fail(PluginHostProcessError::ProtocolRejected),
        };
        let component_size = match u64::try_from(load.component.len()) {
            Ok(size) => size,
            Err(_) => return self.fail(PluginHostProcessError::ProtocolRejected),
        };
        let expected_fence = load.fence.clone();
        let expected_fingerprint = load.import_export_fingerprint.to_string();
        let frame = ParentFrame::Load {
            fence: load.fence,
            package_sha256: load.package_sha256.into_string(),
            component_sha256: Sha256Digest::of(&load.component).into_string(),
            import_export_fingerprint: expected_fingerprint.clone(),
            runtime_profile: load.runtime_profile,
            component_size,
            grants: load.grants,
            permission_hash,
            limits: RuntimeLimits::for_profile(load.runtime_profile),
        };
        if validate_parent_body(&frame, &load.component).is_err() {
            return self.fail(PluginHostProcessError::ProtocolRejected);
        }

        // This deadline begins after local validation and before the writer can
        // emit the first byte of the Load header.
        let deadline = deadline_after(self.deadlines.compile_load);
        if let Err(error) = self.send_until(
            ParentMessage::new(frame, load.component),
            deadline,
            PluginHostProcessError::CompileLoadTimeout,
        ) {
            return self.fail(error);
        }
        let reply = match self.receive_header_until(
            deadline,
            PluginHostProcessError::CompileLoadTimeout,
            ReceiveContext::Load,
        ) {
            Ok(frame) => frame,
            Err(error) => return self.fail(error),
        };
        let result = match reply {
            ChildFrame::Loaded {
                fence,
                import_export_fingerprint,
            } if fence == expected_fence && import_export_fingerprint == expected_fingerprint => {
                self.loaded
                    .insert(expected_fence.plugin_id.clone(), expected_fence);
                Ok(())
            }
            ChildFrame::Failed { fence, code } if fence == expected_fence => {
                Err(PluginHostProcessError::LoadFailed(code))
            }
            _ => Err(PluginHostProcessError::ProtocolRejected),
        };
        match result {
            Ok(()) => Ok(()),
            Err(error) => self.fail(error),
        }
    }

    /// End dependency-order loading and expose the serialized runtime seam.
    pub fn finish_loading(&mut self) -> Result<(), PluginHostProcessError> {
        if self.phase != ProcessPhase::Loading {
            return self.fail(PluginHostProcessError::Closed);
        }
        self.phase = ProcessPhase::Running;
        Ok(())
    }

    /// Consume a loaded process into its sole wakeable runtime owner.
    ///
    /// The returned command handle performs bounded immediate admission. The
    /// event receiver owns the driver join handle, so dropping either side
    /// wakes cleanup and dropping the receiver cannot detach the owner thread.
    pub(crate) fn into_runtime_driver(
        mut self,
    ) -> Result<(PluginHostRuntimeDriverHandle, PluginHostRuntimeEvents), PluginHostProcessError>
    {
        if self.phase != ProcessPhase::Running {
            return self.fail(PluginHostProcessError::Closed);
        }
        let Some(wake_receiver) = self.wake_receiver.take() else {
            return self.fail(PluginHostProcessError::WorkerFailed);
        };
        let wake = self.wake_sender.clone();
        let (commands, command_receiver) = mpsc::sync_channel(RUNTIME_DRIVER_COMMAND_CAPACITY);
        let (event_sender, events) = mpsc::sync_channel(RUNTIME_DRIVER_EVENT_CAPACITY);
        let shared = Arc::new(RuntimeDriverShared::new());
        let driver_shared = shared.clone();
        let driver_handle = match std::thread::Builder::new()
            .name("junban-plugin-runtime-driver".into())
            .spawn(move || {
                run_runtime_driver(
                    self,
                    command_receiver,
                    event_sender,
                    wake_receiver,
                    driver_shared,
                );
            }) {
            Ok(handle) => handle,
            Err(_) => {
                shared.force_terminal(RuntimeDriverTerminalState::ForcedWorker);
                return Err(PluginHostProcessError::WorkerFailed);
            }
        };
        Ok((
            PluginHostRuntimeDriverHandle {
                commands: Some(commands),
                wake: wake.clone(),
                shared: shared.clone(),
            },
            PluginHostRuntimeEvents {
                events,
                wake,
                shared,
                driver_handle: Some(driver_handle),
            },
        ))
    }

    /// Send one SDK-typed runtime/control message before the caller's deadline.
    /// Hello, Load, and Shutdown remain owned by dedicated process methods.
    pub fn send(
        &mut self,
        message: ParentMessage,
        deadline: Instant,
    ) -> Result<(), PluginHostProcessError> {
        if self.phase != ProcessPhase::Running
            || !runtime_parent_frame_allowed(&message.frame)
            || !self.parent_authority_matches(&message.frame)
            || validate_parent_body(&message.frame, &message.body).is_err()
        {
            return self.fail(PluginHostProcessError::ProtocolRejected);
        }
        if let Err(error) =
            self.send_until(message, deadline, PluginHostProcessError::ControlTimeout)
        {
            return self.fail(error);
        }
        Ok(())
    }

    /// Receive one validated child header without reading or allocating its body.
    ///
    /// The caller must validate invocation/callback correlation before invoking
    /// [`Self::receive_body`]. Session and loaded-activation fencing is enforced
    /// here before body authorization is possible.
    pub fn receive_header(
        &mut self,
        deadline: Instant,
    ) -> Result<ChildFrame, PluginHostProcessError> {
        if self.phase != ProcessPhase::Running {
            return self.fail(PluginHostProcessError::Closed);
        }
        let frame = match self.receive_header_until(
            deadline,
            PluginHostProcessError::ControlTimeout,
            ReceiveContext::Runtime,
        ) {
            Ok(frame) => frame,
            Err(error) => return self.fail(error),
        };
        if let ChildFrame::Unloaded { fence } = &frame {
            self.loaded.remove(&fence.plugin_id);
        }
        Ok(frame)
    }

    /// Authorize and receive the exact body for the previously returned header.
    pub fn receive_body(
        &mut self,
        expected: &ChildFrame,
        deadline: Instant,
    ) -> Result<Vec<u8>, PluginHostProcessError> {
        if self.phase != ProcessPhase::Running {
            return self.fail(PluginHostProcessError::Closed);
        }
        let Some(pending) = self.pending_body.as_ref() else {
            return if child_body_len(expected).ok() == Some(0) {
                Ok(Vec::new())
            } else {
                self.fail(PluginHostProcessError::ProtocolRejected)
            };
        };
        if pending != expected {
            return self.fail(PluginHostProcessError::ProtocolRejected);
        }
        let Some(control) = self.reader_control.as_ref() else {
            return self.fail(PluginHostProcessError::WorkerFailed);
        };
        match control.try_send(ReaderControl::ReadBody) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                return self.fail(PluginHostProcessError::WorkerFailed);
            }
        }
        let event = match recv_until(
            self.reader_events.as_ref(),
            deadline,
            PluginHostProcessError::ControlTimeout,
        ) {
            Ok(event) => event,
            Err(error) => return self.fail(error),
        };
        match event {
            ReaderEvent::Body(body, completed) if completed <= deadline => {
                self.pending_body = None;
                Ok(body)
            }
            ReaderEvent::Body(_, _) => self.fail(PluginHostProcessError::ControlTimeout),
            ReaderEvent::ProtocolFailure => self.fail(PluginHostProcessError::ProtocolRejected),
            ReaderEvent::Eof(_) => self.fail(PluginHostProcessError::TransportFailed),
            ReaderEvent::Header(_, _) => self.fail(PluginHostProcessError::WorkerFailed),
        }
    }

    /// Kill, wait, reap, and join every owned worker. Repeated calls are safe.
    pub fn fatal_close(&mut self) -> Result<(), PluginHostProcessError> {
        self.terminate(true)
    }

    /// Gracefully request child drain/shutdown under one total 1,000-ms product
    /// control deadline, then kill as a fallback. Repeated calls are safe.
    pub fn shutdown(&mut self) -> Result<(), PluginHostProcessError> {
        if self.phase == ProcessPhase::Closed {
            return Ok(());
        }
        if self.phase == ProcessPhase::Handshake || self.phase == ProcessPhase::Closing {
            return self.terminate(true);
        }
        if self.pending_body.is_some() {
            return self.fail(PluginHostProcessError::ProtocolRejected);
        }

        self.phase = ProcessPhase::Closing;
        let deadline = deadline_after(self.deadlines.control);
        let shutdown = ParentMessage::new(
            ParentFrame::Shutdown {
                host_session_id: self.host_session_id.clone(),
            },
            Vec::new(),
        );
        if let Err(error) =
            self.send_until(shutdown, deadline, PluginHostProcessError::ControlTimeout)
        {
            return self.fail(error);
        }
        let reply = match self.receive_header_until(
            deadline,
            PluginHostProcessError::ControlTimeout,
            ReceiveContext::Shutdown,
        ) {
            Ok(reply) => reply,
            Err(error) => return self.fail(error),
        };
        if !matches!(
            reply,
            ChildFrame::ShutdownComplete { ref host_session_id }
                if host_session_id == &self.host_session_id
        ) {
            return self.fail(PluginHostProcessError::ProtocolRejected);
        }

        // Closing stdin allows deterministic child exit. Exit, reap, and the
        // reader's exact clean EOF must all fit in this same control deadline.
        self.writer.take();
        let status = match self.wait_until(deadline) {
            Ok(Some(status)) => status,
            Ok(None) => {
                let error = match self.receive_shutdown_eof_until(deadline) {
                    Err(PluginHostProcessError::ProtocolRejected) => {
                        PluginHostProcessError::ProtocolRejected
                    }
                    Ok(()) | Err(_) => PluginHostProcessError::ControlTimeout,
                };
                return self.fail(error);
            }
            Err(()) => {
                let _ = self.receive_shutdown_eof_until(deadline);
                return self.fail(PluginHostProcessError::CleanupFailed);
            }
        };
        let waited = self
            .child
            .as_mut()
            .is_some_and(|child| child.wait().is_ok());
        let terminal = self.receive_shutdown_eof_until(deadline);
        if !waited {
            return self.fail(PluginHostProcessError::CleanupFailed);
        }
        if let Err(error) = terminal {
            return self.fail(error);
        }
        if !status.success() {
            return self.fail(PluginHostProcessError::TransportFailed);
        }
        self.finish_after_wait()
    }

    fn connect_validated(
        executable: &Path,
        host_session_id: Uuid,
        deadlines: ProcessDeadlines,
    ) -> Result<Self, PluginHostProcessError> {
        let (mut process, spawned_at) = Self::spawn(executable, host_session_id, deadlines)?;
        let deadline = spawned_at
            .checked_add(deadlines.control)
            .unwrap_or(spawned_at);
        let hello = ParentMessage::new(
            ParentFrame::Hello {
                protocol_name: HOST_PROTOCOL_NAME.into(),
                protocol_version: HOST_PROTOCOL_VERSION,
                junban_version: HOST_JUNBAN_VERSION.into(),
                host_session_id: process.host_session_id.clone(),
            },
            Vec::new(),
        );
        if let Err(error) =
            process.send_until(hello, deadline, PluginHostProcessError::HandshakeTimeout)
        {
            return process.fail(error);
        }
        let reply = match process.receive_header_until(
            deadline,
            PluginHostProcessError::HandshakeTimeout,
            ReceiveContext::Handshake,
        ) {
            Ok(frame) => frame,
            Err(error) => return process.fail(error),
        };
        if validate_child_hello(&reply, &process.host_session_id).is_err() {
            return process.fail(PluginHostProcessError::ProtocolRejected);
        }
        process.phase = ProcessPhase::Loading;
        Ok(process)
    }

    fn spawn(
        executable: &Path,
        host_session_id: Uuid,
        deadlines: ProcessDeadlines,
    ) -> Result<(Self, Instant), PluginHostProcessError> {
        let working_directory = executable
            .parent()
            .ok_or(PluginHostProcessError::ExecutableNotRegular)?;
        let mut command = Command::new(executable);
        command
            .env_clear()
            .current_dir(working_directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|_| PluginHostProcessError::SpawnFailed)?;
        // The handshake control deadline includes all parent worker setup after
        // the operating system reports a successful spawn.
        let spawned_at = Instant::now();
        let pipes = (child.stdin.take(), child.stdout.take(), child.stderr.take());
        let (Some(stdin), Some(stdout), Some(stderr)) = pipes else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(PluginHostProcessError::SpawnFailed);
        };

        let (writer, writer_commands) = mpsc::sync_channel(WRITER_CHANNEL_CAPACITY);
        let (reader_events_sender, reader_events) = mpsc::sync_channel(READER_CHANNEL_CAPACITY);
        let (reader_control, reader_controls) = mpsc::sync_channel(READER_CONTROL_CHANNEL_CAPACITY);
        let (worker_status_sender, worker_status) =
            mpsc::sync_channel(WORKER_STATUS_CHANNEL_CAPACITY);
        let (wake_sender, wake_receiver) = mpsc::sync_channel(RUNTIME_DRIVER_WAKE_CAPACITY);

        let mut process = Self {
            child: Some(child),
            writer: Some(writer),
            reader_control: Some(reader_control),
            reader_events: Some(reader_events),
            worker_status: Some(worker_status),
            writer_handle: None,
            reader_handle: None,
            stderr_handle: None,
            wake_sender: wake_sender.clone(),
            wake_receiver: Some(wake_receiver),
            host_session_id: host_session_id.hyphenated().to_string(),
            loaded: BTreeMap::new(),
            pending_body: None,
            phase: ProcessPhase::Handshake,
            deadlines,
        };

        let status = worker_status_sender.clone();
        let wake = wake_sender.clone();
        process.writer_handle = match std::thread::Builder::new()
            .name("junban-plugin-parent-writer".into())
            .spawn(move || run_writer(stdin, writer_commands, status, wake))
        {
            Ok(handle) => Some(handle),
            Err(_) => return process.fail(PluginHostProcessError::SpawnFailed),
        };
        let status = worker_status_sender.clone();
        let wake = wake_sender.clone();
        process.reader_handle = match std::thread::Builder::new()
            .name("junban-plugin-parent-reader".into())
            .spawn(move || {
                run_reader(stdout, reader_events_sender, reader_controls, status, wake);
            }) {
            Ok(handle) => Some(handle),
            Err(_) => return process.fail(PluginHostProcessError::SpawnFailed),
        };
        process.stderr_handle = match std::thread::Builder::new()
            .name("junban-plugin-parent-stderr".into())
            .spawn(move || drain_stderr(stderr, worker_status_sender, wake_sender))
        {
            Ok(handle) => Some(handle),
            Err(_) => return process.fail(PluginHostProcessError::SpawnFailed),
        };
        Ok((process, spawned_at))
    }

    fn send_until(
        &mut self,
        message: ParentMessage,
        deadline: Instant,
        timeout_error: PluginHostProcessError,
    ) -> Result<(), PluginHostProcessError> {
        let completion = self.begin_send(message)?;
        let result = recv_until(Some(&completion), deadline, timeout_error)?;
        match result {
            Ok(completed) if completed <= deadline => Ok(()),
            Ok(_) => Err(timeout_error),
            Err(()) => Err(PluginHostProcessError::TransportFailed),
        }
    }

    fn begin_send(
        &mut self,
        message: ParentMessage,
    ) -> Result<Receiver<Result<Instant, ()>>, PluginHostProcessError> {
        self.check_worker_health()?;
        validate_parent_body(&message.frame, &message.body)
            .map_err(|_| PluginHostProcessError::ProtocolRejected)?;
        let (completed, completion) = mpsc::sync_channel(1);
        let command = WriterCommand {
            message,
            completed,
            #[cfg(test)]
            panic_for_test: false,
        };
        let Some(writer) = self.writer.as_ref() else {
            return Err(PluginHostProcessError::WorkerFailed);
        };
        match writer.try_send(command) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                return Err(PluginHostProcessError::WorkerFailed);
            }
        }
        Ok(completion)
    }

    #[cfg(test)]
    fn begin_writer_panic(&mut self) -> Result<(), PluginHostProcessError> {
        let (completed, _completion) = mpsc::sync_channel(1);
        let Some(writer) = self.writer.as_ref() else {
            return Err(PluginHostProcessError::WorkerFailed);
        };
        writer
            .try_send(WriterCommand {
                message: ParentMessage::new(
                    ParentFrame::Shutdown {
                        host_session_id: self.host_session_id.clone(),
                    },
                    Vec::new(),
                ),
                completed,
                panic_for_test: true,
            })
            .map_err(|_| PluginHostProcessError::WorkerFailed)
    }

    fn receive_header_until(
        &mut self,
        deadline: Instant,
        timeout_error: PluginHostProcessError,
        context: ReceiveContext,
    ) -> Result<ChildFrame, PluginHostProcessError> {
        if self.pending_body.is_some() {
            return Err(PluginHostProcessError::ProtocolRejected);
        }
        let event = recv_until(self.reader_events.as_ref(), deadline, timeout_error)?;
        match event {
            ReaderEvent::Header(frame, completed) => {
                if completed > deadline || !self.child_frame_allowed(&frame, context) {
                    return Err(if completed > deadline {
                        timeout_error
                    } else {
                        PluginHostProcessError::ProtocolRejected
                    });
                }
                if child_body_len(&frame).map_err(|_| PluginHostProcessError::ProtocolRejected)? > 0
                {
                    self.pending_body = Some(frame.clone());
                }
                Ok(frame)
            }
            ReaderEvent::Body(_, _) => Err(PluginHostProcessError::WorkerFailed),
            ReaderEvent::Eof(_) => Err(PluginHostProcessError::TransportFailed),
            ReaderEvent::ProtocolFailure => Err(PluginHostProcessError::ProtocolRejected),
        }
    }

    fn receive_shutdown_eof_until(
        &mut self,
        deadline: Instant,
    ) -> Result<(), PluginHostProcessError> {
        let event = recv_until(
            self.reader_events.as_ref(),
            deadline,
            PluginHostProcessError::ControlTimeout,
        )?;
        validate_shutdown_terminal_event(event, deadline)
    }

    fn child_frame_allowed(&self, frame: &ChildFrame, context: ReceiveContext) -> bool {
        if child_frame_session(frame) != self.host_session_id {
            return false;
        }
        match context {
            ReceiveContext::Handshake => matches!(frame, ChildFrame::Hello { .. }),
            ReceiveContext::Load => {
                matches!(frame, ChildFrame::Loaded { .. } | ChildFrame::Failed { .. })
            }
            ReceiveContext::Runtime => {
                runtime_child_frame_allowed(frame) && self.child_authority_matches(frame)
            }
            ReceiveContext::Shutdown => matches!(frame, ChildFrame::ShutdownComplete { .. }),
        }
    }

    fn parent_authority_matches(&self, frame: &ParentFrame) -> bool {
        let authority = match frame {
            ParentFrame::Invoke { fence, .. }
            | ParentFrame::Cancel { fence }
            | ParentFrame::Unload { fence } => fence,
            ParentFrame::CapabilityReply { callback, .. } => {
                return self
                    .loaded
                    .get(&callback.plugin_id)
                    .is_some_and(|loaded| loaded.same_activation(&callback.authority()));
            }
            ParentFrame::Hello { .. } | ParentFrame::Load { .. } | ParentFrame::Shutdown { .. } => {
                return false;
            }
        };
        self.loaded
            .get(&authority.plugin_id)
            .is_some_and(|loaded| loaded.same_activation(authority))
    }

    fn child_authority_matches(&self, frame: &ChildFrame) -> bool {
        let authority = match frame {
            ChildFrame::CapabilityRequest { callback, .. } => callback.authority(),
            ChildFrame::Outcome { fence, .. }
            | ChildFrame::Cancelled { fence }
            | ChildFrame::Failed { fence, .. }
            | ChildFrame::Unloaded { fence } => fence.clone(),
            ChildFrame::Hello { .. }
            | ChildFrame::Loaded { .. }
            | ChildFrame::ShutdownComplete { .. } => return false,
        };
        self.loaded
            .get(&authority.plugin_id)
            .is_some_and(|loaded| loaded.same_activation(&authority))
    }

    fn check_worker_health(&mut self) -> Result<(), PluginHostProcessError> {
        let Some(status) = self.worker_status.as_ref() else {
            return Err(PluginHostProcessError::WorkerFailed);
        };
        match status.try_recv() {
            Ok(_) | Err(TryRecvError::Disconnected) => {
                return Err(PluginHostProcessError::WorkerFailed);
            }
            Err(TryRecvError::Empty) => {}
        }
        if self
            .writer_handle
            .as_ref()
            .is_none_or(JoinHandle::is_finished)
            || self
                .reader_handle
                .as_ref()
                .is_none_or(JoinHandle::is_finished)
            || self
                .stderr_handle
                .as_ref()
                .is_none_or(JoinHandle::is_finished)
        {
            return Err(PluginHostProcessError::WorkerFailed);
        }
        Ok(())
    }

    fn wait_until(&mut self, deadline: Instant) -> Result<Option<ExitStatus>, ()> {
        let Some(child) = self.child.as_mut() else {
            return Ok(None);
        };
        wait_for_child_status_until(
            deadline,
            Instant::now,
            || child.try_wait(),
            std::thread::sleep,
        )
    }

    fn terminate(&mut self, kill: bool) -> Result<(), PluginHostProcessError> {
        if self.phase == ProcessPhase::Closed {
            return Ok(());
        }
        self.phase = ProcessPhase::Closing;
        self.reader_control.take();
        self.writer.take();
        self.reader_events.take();
        self.worker_status.take();

        let mut clean = true;
        if let Some(child) = self.child.as_mut() {
            if kill {
                match child.kill() {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::InvalidInput => {}
                    Err(_) => clean = false,
                }
            }
            if child.wait().is_err() {
                clean = false;
            }
        }
        self.child.take();
        clean &= join_worker(&mut self.writer_handle);
        clean &= join_worker(&mut self.reader_handle);
        clean &= join_worker(&mut self.stderr_handle);
        self.pending_body = None;
        self.phase = ProcessPhase::Closed;

        if clean {
            Ok(())
        } else {
            Err(PluginHostProcessError::CleanupFailed)
        }
    }

    fn finish_after_wait(&mut self) -> Result<(), PluginHostProcessError> {
        self.child.take();
        self.reader_control.take();
        self.writer.take();
        self.reader_events.take();
        self.worker_status.take();
        let clean = join_worker(&mut self.writer_handle)
            & join_worker(&mut self.reader_handle)
            & join_worker(&mut self.stderr_handle);
        self.pending_body = None;
        self.phase = ProcessPhase::Closed;
        if clean {
            Ok(())
        } else {
            Err(PluginHostProcessError::CleanupFailed)
        }
    }

    fn fail<T>(&mut self, error: PluginHostProcessError) -> Result<T, PluginHostProcessError> {
        match self.terminate(true) {
            Ok(()) => Err(error),
            Err(cleanup) => Err(cleanup),
        }
    }

    #[cfg(test)]
    fn process_id(&self) -> Option<u32> {
        self.child.as_ref().map(Child::id)
    }

    /// The sole non-product explicit executable-path constructor.
    #[cfg(test)]
    fn connect_for_test(
        executable: &Path,
        host_session_id: Uuid,
        deadlines: ProcessDeadlines,
    ) -> Result<Self, PluginHostProcessError> {
        validate_explicit_executable(executable)?;
        Self::connect_validated(executable, host_session_id, deadlines)
    }
}

impl Drop for PluginHostProcess {
    fn drop(&mut self) {
        let _ = self.terminate(true);
    }
}

struct PendingWriterCompletion {
    completion: Receiver<Result<Instant, ()>>,
    deadline: Instant,
    _reservation: RuntimeBodyReservation,
}

enum RuntimeBodyState {
    None,
    AwaitingAuthorization {
        frame: ChildFrame,
        token: u64,
    },
    Reading {
        frame: ChildFrame,
        deadline: Instant,
    },
}

struct GracefulRuntimeShutdown;

enum RuntimeDriverCommandOutcome {
    Continue,
    GracefulShutdown,
}

fn run_runtime_driver(
    mut process: PluginHostProcess,
    commands: Receiver<RuntimeDriverCommand>,
    events: SyncSender<PluginHostRuntimeEvent>,
    wake: Receiver<()>,
    shared: Arc<RuntimeDriverShared>,
) {
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        runtime_driver_loop(&mut process, &commands, &events, &wake, &shared)
    }));
    let mut result = match outcome {
        Ok(Ok(GracefulRuntimeShutdown)) => Ok(()),
        Ok(Err(error)) => {
            let transition = shared.force_terminal(RuntimeDriverTerminalState::for_error(error));
            Err(resolve_terminal_error(transition, error))
        }
        Err(_) => {
            let transition = shared.force_terminal(RuntimeDriverTerminalState::ForcedWorker);
            forced_close(
                &mut process,
                resolve_terminal_error(transition, PluginHostProcessError::WorkerFailed),
            )
        }
    };
    if process.phase != ProcessPhase::Closed {
        let transition = shared.force_terminal(RuntimeDriverTerminalState::ForcedClosed);
        let cause = result.map_or_else(
            |error| resolve_terminal_error(transition, error),
            |()| {
                transition
                    .state
                    .error()
                    .unwrap_or(PluginHostProcessError::ForcedClosed)
            },
        );
        result = forced_close(&mut process, cause);
    }

    // Terminal state closes admission. Taking this tiny lock waits out any
    // producer already inside its nonblocking try-send critical section; then
    // receiver drop releases every queued body reservation before publication.
    let admission = shared
        .admission
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    drop(commands);
    drop(admission);
    debug_assert_eq!(shared.queued_body_bytes.load(Ordering::Acquire), 0);

    // One channel slot is reserved for this post-reap terminal event. During
    // receiver Drop the channel remains connected until this driver is joined,
    // so consumer loss also publishes its non-graceful cause before teardown.
    let _ = events.try_send(PluginHostRuntimeEvent::Closed(result));
}

fn runtime_driver_loop(
    process: &mut PluginHostProcess,
    commands: &Receiver<RuntimeDriverCommand>,
    events: &SyncSender<PluginHostRuntimeEvent>,
    wake: &Receiver<()>,
    shared: &RuntimeDriverShared,
) -> Result<GracefulRuntimeShutdown, PluginHostProcessError> {
    let mut writer_completion: Option<PendingWriterCompletion> = None;
    let mut body_state = RuntimeBodyState::None;
    let mut next_body_token = 1_u64;

    loop {
        match shared.terminal_state() {
            RuntimeDriverTerminalState::Open | RuntimeDriverTerminalState::GracefulInProgress => {}
            RuntimeDriverTerminalState::GracefulCommitted => {
                return Ok(GracefulRuntimeShutdown);
            }
            forced => {
                return forced_close(
                    process,
                    forced
                        .error()
                        .unwrap_or(PluginHostProcessError::ProtocolRejected),
                );
            }
        }

        if let Some(pending) = writer_completion.as_ref() {
            let completion = match pending.completion.try_recv() {
                Ok(Ok(completed)) if completed <= pending.deadline => Some(Ok(())),
                Ok(Ok(_)) => Some(Err(PluginHostProcessError::ControlTimeout)),
                Ok(Err(())) => Some(Err(PluginHostProcessError::TransportFailed)),
                Err(TryRecvError::Disconnected) => Some(Err(PluginHostProcessError::WorkerFailed)),
                Err(TryRecvError::Empty) if Instant::now() >= pending.deadline => {
                    Some(Err(PluginHostProcessError::ControlTimeout))
                }
                Err(TryRecvError::Empty) => None,
            };
            if let Some(completion) = completion {
                writer_completion = None;
                match completion {
                    Ok(()) => continue,
                    Err(error) => return process.fail(error),
                }
            }
        }

        if let RuntimeBodyState::Reading { deadline, .. } = &body_state
            && Instant::now() >= *deadline
        {
            return process.fail(PluginHostProcessError::ControlTimeout);
        }

        match process
            .reader_events
            .as_ref()
            .ok_or(PluginHostProcessError::WorkerFailed)?
            .try_recv()
        {
            Ok(event) => {
                handle_runtime_reader_event(
                    process,
                    event,
                    events,
                    shared,
                    &mut body_state,
                    &mut next_body_token,
                )?;
                continue;
            }
            Err(TryRecvError::Disconnected) => {
                return process.fail(PluginHostProcessError::WorkerFailed);
            }
            Err(TryRecvError::Empty) => {}
        }

        match process
            .worker_status
            .as_ref()
            .ok_or(PluginHostProcessError::WorkerFailed)?
            .try_recv()
        {
            Ok(_) | Err(TryRecvError::Disconnected) => {
                return process.fail(PluginHostProcessError::WorkerFailed);
            }
            Err(TryRecvError::Empty) => {}
        }

        if writer_completion.is_none() {
            match commands.try_recv() {
                Ok(command) => {
                    match handle_runtime_driver_command(
                        process,
                        command,
                        shared,
                        &mut writer_completion,
                        &mut body_state,
                    )? {
                        RuntimeDriverCommandOutcome::Continue => continue,
                        RuntimeDriverCommandOutcome::GracefulShutdown => {
                            return Ok(GracefulRuntimeShutdown);
                        }
                    }
                }
                Err(TryRecvError::Disconnected) => {
                    return process.fail(PluginHostProcessError::Closed);
                }
                Err(TryRecvError::Empty) => {}
            }
        }

        let deadline = driver_wait_deadline(writer_completion.as_ref(), &body_state);
        let wake_result = match deadline {
            Some(deadline) => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    continue;
                }
                wake.recv_timeout(remaining)
            }
            None => wake
                .recv()
                .map_err(|_| mpsc::RecvTimeoutError::Disconnected),
        };
        match wake_result {
            Ok(()) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return process.fail(PluginHostProcessError::WorkerFailed);
            }
        }
    }
}

fn driver_wait_deadline(
    writer: Option<&PendingWriterCompletion>,
    body: &RuntimeBodyState,
) -> Option<Instant> {
    let writer = writer.map(|pending| pending.deadline);
    let body = match body {
        RuntimeBodyState::Reading { deadline, .. } => Some(*deadline),
        RuntimeBodyState::None | RuntimeBodyState::AwaitingAuthorization { .. } => None,
    };
    match (writer, body) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (Some(deadline), None) | (None, Some(deadline)) => Some(deadline),
        (None, None) => None,
    }
}

fn handle_runtime_driver_command(
    process: &mut PluginHostProcess,
    command: RuntimeDriverCommand,
    shared: &RuntimeDriverShared,
    writer_completion: &mut Option<PendingWriterCompletion>,
    body_state: &mut RuntimeBodyState,
) -> Result<RuntimeDriverCommandOutcome, PluginHostProcessError> {
    match command {
        RuntimeDriverCommand::Send {
            message,
            reservation,
            deadline,
        } => {
            if process.phase != ProcessPhase::Running
                || !runtime_parent_frame_allowed(&message.frame)
                || !process.parent_authority_matches(&message.frame)
                || validate_parent_body(&message.frame, &message.body).is_err()
            {
                return process.fail(PluginHostProcessError::ProtocolRejected);
            }
            let completion = match process.begin_send(*message) {
                Ok(completion) => completion,
                Err(error) => return process.fail(error),
            };
            *writer_completion = Some(PendingWriterCompletion {
                completion,
                deadline,
                _reservation: reservation,
            });
        }
        RuntimeDriverCommand::AuthorizeBody { token, deadline } => {
            let RuntimeBodyState::AwaitingAuthorization {
                frame,
                token: expected,
            } = body_state
            else {
                return process.fail(PluginHostProcessError::ProtocolRejected);
            };
            if token.0 != *expected || Instant::now() >= deadline {
                return process.fail(if token.0 == *expected {
                    PluginHostProcessError::ControlTimeout
                } else {
                    PluginHostProcessError::ProtocolRejected
                });
            }
            let Some(control) = process.reader_control.as_ref() else {
                return process.fail(PluginHostProcessError::WorkerFailed);
            };
            match control.try_send(ReaderControl::ReadBody) {
                Ok(()) => {}
                Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                    return process.fail(PluginHostProcessError::WorkerFailed);
                }
            }
            *body_state = RuntimeBodyState::Reading {
                frame: frame.clone(),
                deadline,
            };
        }
        RuntimeDriverCommand::Shutdown => {
            let state = shared.terminal_state();
            if state != RuntimeDriverTerminalState::GracefulInProgress {
                return Err(state
                    .error()
                    .unwrap_or(PluginHostProcessError::ForcedClosed));
            }
            process.shutdown()?;
            return match shared.commit_graceful() {
                Ok(()) => Ok(RuntimeDriverCommandOutcome::GracefulShutdown),
                Err(winner) => Err(winner
                    .error()
                    .unwrap_or(PluginHostProcessError::ForcedClosed)),
            };
        }
        #[cfg(test)]
        RuntimeDriverCommand::PanicDriverForTest => panic!("deterministic driver panic"),
        #[cfg(test)]
        RuntimeDriverCommand::PanicWriterForTest => {
            if let Err(error) = process.begin_writer_panic() {
                return process.fail(error);
            }
        }
        #[cfg(test)]
        RuntimeDriverCommand::PanicReaderForTest => {
            let Some(control) = process.reader_control.as_ref() else {
                return process.fail(PluginHostProcessError::WorkerFailed);
            };
            if control.try_send(ReaderControl::PanicForTest).is_err() {
                return process.fail(PluginHostProcessError::WorkerFailed);
            }
        }
    }
    Ok(RuntimeDriverCommandOutcome::Continue)
}

fn forced_close<T>(
    process: &mut PluginHostProcess,
    cause: PluginHostProcessError,
) -> Result<T, PluginHostProcessError> {
    match process.fatal_close() {
        Ok(()) => Err(cause),
        Err(cleanup) => Err(cleanup),
    }
}

fn resolve_terminal_error(
    transition: RuntimeDriverTerminalTransition,
    fallback: PluginHostProcessError,
) -> PluginHostProcessError {
    if fallback == PluginHostProcessError::CleanupFailed || transition.won {
        fallback
    } else {
        transition.state.error().unwrap_or(fallback)
    }
}

fn handle_runtime_reader_event(
    process: &mut PluginHostProcess,
    event: ReaderEvent,
    events: &SyncSender<PluginHostRuntimeEvent>,
    shared: &RuntimeDriverShared,
    body_state: &mut RuntimeBodyState,
    next_body_token: &mut u64,
) -> Result<(), PluginHostProcessError> {
    match event {
        ReaderEvent::Header(frame, _) => {
            if !matches!(body_state, RuntimeBodyState::None)
                || process.pending_body.is_some()
                || !process.child_frame_allowed(&frame, ReceiveContext::Runtime)
            {
                return process.fail(PluginHostProcessError::ProtocolRejected);
            }
            if let ChildFrame::Unloaded { fence } = &frame {
                process.loaded.remove(&fence.plugin_id);
            }
            let body_len = match child_body_len(&frame) {
                Ok(body_len) => body_len,
                Err(_) => return process.fail(PluginHostProcessError::ProtocolRejected),
            };
            let pending_body = if body_len == 0 {
                None
            } else {
                let token = *next_body_token;
                *next_body_token = match next_body_token.checked_add(1) {
                    Some(next) => next,
                    None => return process.fail(PluginHostProcessError::ProtocolRejected),
                };
                process.pending_body = Some(frame.clone());
                *body_state = RuntimeBodyState::AwaitingAuthorization {
                    frame: frame.clone(),
                    token,
                };
                Some(PendingPluginHostBodyToken(token))
            };
            publish_runtime_event(
                events,
                shared,
                PluginHostRuntimeEvent::Header {
                    frame,
                    pending_body,
                },
            )
            .or_else(|error| process.fail(error))
        }
        ReaderEvent::Body(body, completed) => {
            let RuntimeBodyState::Reading { frame, deadline } = body_state else {
                return process.fail(PluginHostProcessError::WorkerFailed);
            };
            if completed > *deadline || process.pending_body.as_ref() != Some(frame) {
                return process.fail(if completed > *deadline {
                    PluginHostProcessError::ControlTimeout
                } else {
                    PluginHostProcessError::ProtocolRejected
                });
            }
            let frame = frame.clone();
            process.pending_body = None;
            *body_state = RuntimeBodyState::None;
            publish_runtime_event(events, shared, PluginHostRuntimeEvent::Body { frame, body })
                .or_else(|error| process.fail(error))
        }
        ReaderEvent::Eof(_) => process.fail(PluginHostProcessError::TransportFailed),
        ReaderEvent::ProtocolFailure => process.fail(PluginHostProcessError::ProtocolRejected),
    }
}

fn publish_runtime_event(
    events: &SyncSender<PluginHostRuntimeEvent>,
    shared: &RuntimeDriverShared,
    event: PluginHostRuntimeEvent,
) -> Result<(), PluginHostProcessError> {
    let mut queued = shared.queued_data_events.load(Ordering::Acquire);
    loop {
        if queued >= RUNTIME_DRIVER_DATA_EVENT_CAPACITY {
            return Err(PluginHostProcessError::Backpressure);
        }
        match shared.queued_data_events.compare_exchange_weak(
            queued,
            queued + 1,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => break,
            Err(actual) => queued = actual,
        }
    }
    match events.try_send(event) {
        Ok(()) => Ok(()),
        Err(TrySendError::Full(_)) => {
            shared.queued_data_events.fetch_sub(1, Ordering::AcqRel);
            Err(PluginHostProcessError::Backpressure)
        }
        Err(TrySendError::Disconnected(_)) => {
            shared.queued_data_events.fetch_sub(1, Ordering::AcqRel);
            Err(PluginHostProcessError::Closed)
        }
    }
}

fn signal_driver(wake: &SyncSender<()>) {
    match wake.try_send(()) {
        Ok(()) | Err(TrySendError::Full(())) | Err(TrySendError::Disconnected(())) => {}
    }
}

#[derive(Clone, Copy)]
enum ReceiveContext {
    Handshake,
    Load,
    Runtime,
    Shutdown,
}

struct WorkerExitNotifier {
    kind: WorkerKind,
    status: SyncSender<WorkerKind>,
    wake: SyncSender<()>,
}

impl Drop for WorkerExitNotifier {
    fn drop(&mut self) {
        let _ = self.status.send(self.kind);
        signal_driver(&self.wake);
    }
}

fn run_writer(
    mut stdin: impl Write,
    commands: Receiver<WriterCommand>,
    worker_status: SyncSender<WorkerKind>,
    wake: SyncSender<()>,
) {
    let _exit = WorkerExitNotifier {
        kind: WorkerKind::Writer,
        status: worker_status,
        wake: wake.clone(),
    };
    while let Ok(command) = commands.recv() {
        #[cfg(test)]
        if command.panic_for_test {
            panic!("deterministic writer panic");
        }
        let result =
            write_parent_message(&mut stdin, &command.message.frame, &command.message.body)
                .map(|()| Instant::now())
                .map_err(|_| ());
        let failed = result.is_err() || command.completed.send(result).is_err();
        signal_driver(&wake);
        if failed {
            break;
        }
    }
}

fn send_reader_event(
    events: &SyncSender<ReaderEvent>,
    wake: &SyncSender<()>,
    event: ReaderEvent,
) -> bool {
    if events.send(event).is_err() {
        return false;
    }
    signal_driver(wake);
    true
}

fn run_reader(
    mut stdout: impl Read,
    events: SyncSender<ReaderEvent>,
    controls: Receiver<ReaderControl>,
    worker_status: SyncSender<WorkerKind>,
    wake: SyncSender<()>,
) {
    let _exit = WorkerExitNotifier {
        kind: WorkerKind::Reader,
        status: worker_status,
        wake: wake.clone(),
    };
    loop {
        let frame = match read_child_frame(&mut stdout) {
            Ok(Some(frame)) => frame,
            Ok(None) => {
                let _ = send_reader_event(&events, &wake, ReaderEvent::Eof(Instant::now()));
                break;
            }
            Err(_) => {
                let _ = send_reader_event(&events, &wake, ReaderEvent::ProtocolFailure);
                break;
            }
        };
        let body_len = match child_body_len(&frame) {
            Ok(body_len) => body_len,
            Err(_) => {
                let _ = send_reader_event(&events, &wake, ReaderEvent::ProtocolFailure);
                break;
            }
        };
        if !send_reader_event(
            &events,
            &wake,
            ReaderEvent::Header(frame.clone(), Instant::now()),
        ) {
            break;
        }
        if body_len == 0 {
            continue;
        }
        match controls.recv() {
            Ok(ReaderControl::ReadBody) => {}
            #[cfg(test)]
            Ok(ReaderControl::PanicForTest) => panic!("deterministic reader panic"),
            Err(_) => break,
        }
        match read_child_body(&mut stdout, &frame) {
            Ok(body) => {
                if !send_reader_event(&events, &wake, ReaderEvent::Body(body, Instant::now())) {
                    break;
                }
            }
            Err(_) => {
                let _ = send_reader_event(&events, &wake, ReaderEvent::ProtocolFailure);
                break;
            }
        }
    }
}

fn drain_stderr(
    mut stderr: impl Read,
    worker_status: SyncSender<WorkerKind>,
    wake: SyncSender<()>,
) {
    let _exit = WorkerExitNotifier {
        kind: WorkerKind::Stderr,
        status: worker_status,
        wake,
    };
    let mut buffer = [0_u8; STDERR_BUFFER_BYTES];
    loop {
        match stderr.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
    }
}

fn validate_shutdown_terminal_event(
    event: ReaderEvent,
    deadline: Instant,
) -> Result<(), PluginHostProcessError> {
    match event {
        ReaderEvent::Eof(observed) if observed < deadline => Ok(()),
        ReaderEvent::Eof(_) => Err(PluginHostProcessError::ControlTimeout),
        ReaderEvent::Header(_, _) | ReaderEvent::Body(_, _) | ReaderEvent::ProtocolFailure => {
            Err(PluginHostProcessError::ProtocolRejected)
        }
    }
}

fn wait_for_child_status_until<T>(
    deadline: Instant,
    mut now: impl FnMut() -> Instant,
    mut poll: impl FnMut() -> std::io::Result<Option<T>>,
    mut sleep: impl FnMut(Duration),
) -> Result<Option<T>, ()> {
    loop {
        if now() >= deadline {
            return Ok(None);
        }
        let status = poll().map_err(|_| ())?;
        let observed_at = now();
        if observed_at >= deadline {
            return Ok(None);
        }
        if status.is_some() {
            return Ok(status);
        }
        sleep(CHILD_STATUS_POLL_INTERVAL.min(deadline.duration_since(observed_at)));
    }
}

fn recv_until<T>(
    receiver: Option<&Receiver<T>>,
    deadline: Instant,
    timeout_error: PluginHostProcessError,
) -> Result<T, PluginHostProcessError> {
    let receiver = receiver.ok_or(PluginHostProcessError::WorkerFailed)?;
    match receiver.try_recv() {
        Ok(value) => return Ok(value),
        Err(TryRecvError::Disconnected) => return Err(PluginHostProcessError::WorkerFailed),
        Err(TryRecvError::Empty) => {}
    }
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(timeout_error);
    }
    receiver
        .recv_timeout(remaining)
        .map_err(|error| match error {
            mpsc::RecvTimeoutError::Timeout => timeout_error,
            mpsc::RecvTimeoutError::Disconnected => PluginHostProcessError::WorkerFailed,
        })
}

fn join_worker(handle: &mut Option<JoinHandle<()>>) -> bool {
    handle.take().is_none_or(|handle| handle.join().is_ok())
}

fn deadline_after(duration: Duration) -> Instant {
    let now = Instant::now();
    now.checked_add(duration).unwrap_or(now)
}

fn runtime_parent_frame_allowed(frame: &ParentFrame) -> bool {
    matches!(
        frame,
        ParentFrame::Invoke { .. }
            | ParentFrame::CapabilityReply { .. }
            | ParentFrame::Cancel { .. }
            | ParentFrame::Unload { .. }
    )
}

fn runtime_child_frame_allowed(frame: &ChildFrame) -> bool {
    matches!(
        frame,
        ChildFrame::CapabilityRequest { .. }
            | ChildFrame::Outcome { .. }
            | ChildFrame::Cancelled { .. }
            | ChildFrame::Failed { .. }
            | ChildFrame::Unloaded { .. }
    )
}

fn child_frame_session(frame: &ChildFrame) -> &str {
    match frame {
        ChildFrame::Hello {
            host_session_id, ..
        }
        | ChildFrame::ShutdownComplete { host_session_id } => host_session_id,
        ChildFrame::Loaded { fence, .. }
        | ChildFrame::Outcome { fence, .. }
        | ChildFrame::Cancelled { fence }
        | ChildFrame::Failed { fence, .. }
        | ChildFrame::Unloaded { fence } => &fence.host_session_id,
        ChildFrame::CapabilityRequest { callback, .. } => &callback.host_session_id,
    }
}

fn discover_product_executable() -> Result<PathBuf, PluginHostProcessError> {
    let current = std::env::current_exe()
        .map_err(|_| PluginHostProcessError::CurrentExecutableUnavailable)?;
    discover_product_executable_from(&current)
}

fn discover_product_executable_from(
    current_executable: &Path,
) -> Result<PathBuf, PluginHostProcessError> {
    if !current_executable.is_absolute() {
        return Err(PluginHostProcessError::CurrentExecutableUnavailable);
    }
    let directory = current_executable
        .parent()
        .ok_or(PluginHostProcessError::CurrentExecutableUnavailable)?;
    let candidate = directory.join(format!(
        "junban-plugin-host{}",
        std::env::consts::EXE_SUFFIX
    ));
    validate_executable_metadata(&candidate)?;
    Ok(candidate)
}

#[cfg(test)]
fn validate_explicit_executable(path: &Path) -> Result<(), PluginHostProcessError> {
    if !path.is_absolute() {
        return Err(PluginHostProcessError::ExecutableNotAbsolute);
    }
    validate_executable_metadata(path)
}

fn validate_executable_metadata(path: &Path) -> Result<(), PluginHostProcessError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            PluginHostProcessError::ExecutableMissing
        } else {
            PluginHostProcessError::ExecutableNotRegular
        }
    })?;
    if metadata.file_type().is_symlink() || metadata_is_reparse_point(&metadata) {
        return Err(PluginHostProcessError::ExecutableLinkRejected);
    }
    if !metadata.file_type().is_file() {
        return Err(PluginHostProcessError::ExecutableNotRegular);
    }
    if !metadata_is_executable(&metadata) {
        return Err(PluginHostProcessError::ExecutableNotExecutable);
    }
    Ok(())
}

#[cfg(windows)]
fn metadata_is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(unix)]
fn metadata_is_executable(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;

    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn metadata_is_executable(_metadata: &fs::Metadata) -> bool {
    true
}

#[cfg(test)]
mod tests;
