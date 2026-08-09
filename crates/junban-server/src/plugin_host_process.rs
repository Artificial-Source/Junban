//! Strict parent-side ownership of the private plugin-host child process.
//!
//! This module owns only process discovery, framed transport, handshake, load,
//! and deterministic teardown. Durable plugin state, admission, capabilities,
//! effects, and health remain outside this boundary.

use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError},
    thread::JoinHandle,
    time::{Duration, Instant},
};

use junban_plugin_sdk::{
    AuthorityFence, COMMAND_TIMEOUT_MS, COMPILE_TIMEOUT_MS, ChildFrame, HOST_JUNBAN_VERSION,
    HOST_PROTOCOL_NAME, HOST_PROTOCOL_VERSION, HOST_RUNTIME_ENTRIES_MAX, HostFailureCode,
    ParentFrame, ParentMessage, Permission, RuntimeLimits, RuntimeProfile, Sha256Digest,
    canonical_permission_hash, child_body_len, read_child_body, read_child_frame,
    validate_child_hello, validate_parent_body, write_parent_message,
};
use thiserror::Error;
use uuid::Uuid;

const WRITER_CHANNEL_CAPACITY: usize = 1;
const READER_CHANNEL_CAPACITY: usize = 1;
const READER_CONTROL_CHANNEL_CAPACITY: usize = 1;
const WORKER_STATUS_CHANNEL_CAPACITY: usize = 3;
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
}

enum ReaderControl {
    ReadBody,
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

        let mut process = Self {
            child: Some(child),
            writer: Some(writer),
            reader_control: Some(reader_control),
            reader_events: Some(reader_events),
            worker_status: Some(worker_status),
            writer_handle: None,
            reader_handle: None,
            stderr_handle: None,
            host_session_id: host_session_id.hyphenated().to_string(),
            loaded: BTreeMap::new(),
            pending_body: None,
            phase: ProcessPhase::Handshake,
            deadlines,
        };

        let status = worker_status_sender.clone();
        process.writer_handle = match std::thread::Builder::new()
            .name("junban-plugin-parent-writer".into())
            .spawn(move || run_writer(stdin, writer_commands, status))
        {
            Ok(handle) => Some(handle),
            Err(_) => return process.fail(PluginHostProcessError::SpawnFailed),
        };
        let status = worker_status_sender.clone();
        process.reader_handle = match std::thread::Builder::new()
            .name("junban-plugin-parent-reader".into())
            .spawn(move || run_reader(stdout, reader_events_sender, reader_controls, status))
        {
            Ok(handle) => Some(handle),
            Err(_) => return process.fail(PluginHostProcessError::SpawnFailed),
        };
        process.stderr_handle = match std::thread::Builder::new()
            .name("junban-plugin-parent-stderr".into())
            .spawn(move || drain_stderr(stderr, worker_status_sender))
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
        self.check_worker_health()?;
        validate_parent_body(&message.frame, &message.body)
            .map_err(|_| PluginHostProcessError::ProtocolRejected)?;
        let (completed, completion) = mpsc::sync_channel(1);
        let command = WriterCommand { message, completed };
        let Some(writer) = self.writer.as_ref() else {
            return Err(PluginHostProcessError::WorkerFailed);
        };
        match writer.try_send(command) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                return Err(PluginHostProcessError::WorkerFailed);
            }
        }
        let result = recv_until(Some(&completion), deadline, timeout_error)?;
        match result {
            Ok(completed) if completed <= deadline => Ok(()),
            Ok(_) => Err(timeout_error),
            Err(()) => Err(PluginHostProcessError::TransportFailed),
        }
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

#[derive(Clone, Copy)]
enum ReceiveContext {
    Handshake,
    Load,
    Runtime,
    Shutdown,
}

fn run_writer(
    mut stdin: impl Write,
    commands: Receiver<WriterCommand>,
    worker_status: SyncSender<WorkerKind>,
) {
    while let Ok(command) = commands.recv() {
        let result =
            write_parent_message(&mut stdin, &command.message.frame, &command.message.body)
                .map(|()| Instant::now())
                .map_err(|_| ());
        let failed = result.is_err() || command.completed.send(result).is_err();
        if failed {
            break;
        }
    }
    let _ = worker_status.send(WorkerKind::Writer);
}

fn run_reader(
    mut stdout: impl Read,
    events: SyncSender<ReaderEvent>,
    controls: Receiver<ReaderControl>,
    worker_status: SyncSender<WorkerKind>,
) {
    loop {
        let frame = match read_child_frame(&mut stdout) {
            Ok(Some(frame)) => frame,
            Ok(None) => {
                let _ = events.send(ReaderEvent::Eof(Instant::now()));
                break;
            }
            Err(_) => {
                let _ = events.send(ReaderEvent::ProtocolFailure);
                break;
            }
        };
        let body_len = match child_body_len(&frame) {
            Ok(body_len) => body_len,
            Err(_) => {
                let _ = events.send(ReaderEvent::ProtocolFailure);
                break;
            }
        };
        if events
            .send(ReaderEvent::Header(frame.clone(), Instant::now()))
            .is_err()
        {
            break;
        }
        if body_len == 0 {
            continue;
        }
        if !matches!(controls.recv(), Ok(ReaderControl::ReadBody)) {
            break;
        }
        match read_child_body(&mut stdout, &frame) {
            Ok(body) => {
                if events
                    .send(ReaderEvent::Body(body, Instant::now()))
                    .is_err()
                {
                    break;
                }
            }
            Err(_) => {
                let _ = events.send(ReaderEvent::ProtocolFailure);
                break;
            }
        }
    }
    let _ = worker_status.send(WorkerKind::Reader);
}

fn drain_stderr(mut stderr: impl Read, worker_status: SyncSender<WorkerKind>) {
    let mut buffer = [0_u8; STDERR_BUFFER_BYTES];
    loop {
        match stderr.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
    }
    let _ = worker_status.send(WorkerKind::Stderr);
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
