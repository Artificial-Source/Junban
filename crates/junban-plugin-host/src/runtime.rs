use std::{
    sync::{Arc, Condvar, Mutex, mpsc},
    time::{Duration, Instant},
};

use junban_plugin_sdk::{
    AuthorityFence, CallbackFence, ChildFrame, HostCallKind, HostCallReply, HostCallRequest,
    HostFailureCode, InvocationKind, InvocationMode, InvocationOutcome, InvocationRequest,
    ParentFrame, Permission, RuntimeLimits, RuntimeProfile, SdkError, TypedChildMessage,
    decode_host_call_reply, decode_invocation_request, inspect_component_for_runtime,
    private_body_types as neutral, validate_callback_correlation, validate_host_call_authority,
};
use wasmtime::{
    Engine, ResourceLimiter, Store, StoreLimits, StoreLimitsBuilder, Trap, component::Component,
};
use wasmtime::{component::HasData, component::HasSelf, component::Linker};
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};

use crate::{HostError, ParentMessage, bindings, transfer_bounds::HOSTCALL_TRANSFER_FUEL};

pub(crate) struct OutboundMessage {
    pub frame: ChildFrame,
    pub body: Vec<u8>,
}

impl OutboundMessage {
    pub fn frame(frame: ChildFrame) -> Self {
        Self {
            frame,
            body: Vec::new(),
        }
    }

    fn typed(message: TypedChildMessage) -> Self {
        let (frame, body) = message.into_parts();
        Self { frame, body }
    }
}

struct PendingCallback {
    callback: CallbackFence,
    kind: HostCallKind,
    reply: mpsc::SyncSender<HostCallReply>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StopReason {
    Timeout,
    Cancelled,
    Aborted,
}

struct ActiveInvocation {
    fence: AuthorityFence,
    deadline: Instant,
    stop: Option<StopReason>,
    epoch_advanced: bool,
    completing: bool,
}

#[derive(Default)]
struct RuntimeStatus {
    loaded: bool,
    worker_stopped: bool,
    active: Option<ActiveInvocation>,
    pending: Option<PendingCallback>,
    watchdog_shutdown: bool,
}

#[derive(Default)]
pub(crate) struct SharedRuntimeStatus {
    inner: Mutex<RuntimeStatus>,
    changed: Condvar,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum StartError {
    NotLoaded,
    Busy,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CallbackRouteError {
    Stale,
    Wrong,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CancelResult {
    Won,
    Lost,
    Stale,
    WorkerStopped,
}

impl SharedRuntimeStatus {
    fn lock(&self) -> std::sync::MutexGuard<'_, RuntimeStatus> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn mark_loaded(&self) {
        self.lock().loaded = true;
    }

    pub fn mark_unloaded(&self) {
        let pending = {
            let mut status = self.lock();
            status.loaded = false;
            status.active = None;
            let pending = status.pending.take();
            self.changed.notify_all();
            pending
        };
        cancel_pending(pending);
    }

    pub fn is_loaded(&self) -> bool {
        self.lock().loaded
    }

    pub fn start(&self, fence: AuthorityFence, timeout: Duration) -> Result<(), StartError> {
        let mut status = self.lock();
        if !status.loaded {
            return Err(StartError::NotLoaded);
        }
        if status.active.is_some() {
            return Err(StartError::Busy);
        }
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or(StartError::Busy)?;
        status.active = Some(ActiveInvocation {
            fence,
            deadline,
            stop: None,
            epoch_advanced: false,
            completing: false,
        });
        self.changed.notify_all();
        Ok(())
    }

    /// Linearize an exact cancel against natural completion. The winning
    /// cancel waits until the runtime owner has dropped the active Store; a
    /// timeout that won first remains authoritative.
    pub fn cancel_and_wait(&self, fence: &AuthorityFence) -> CancelResult {
        let mut status = self.lock();
        let Some(active) = status.active.as_mut() else {
            return CancelResult::Stale;
        };
        if !active.fence.exact_matches(fence) {
            return CancelResult::Stale;
        }
        let won = if active.stop.is_none() && !active.completing {
            active.stop = Some(StopReason::Cancelled);
            self.changed.notify_all();
            true
        } else {
            false
        };
        while status
            .active
            .as_ref()
            .is_some_and(|active| active.fence.exact_matches(fence))
        {
            status = self
                .changed
                .wait(status)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
        if status.worker_stopped {
            CancelResult::WorkerStopped
        } else if won {
            CancelResult::Won
        } else {
            CancelResult::Lost
        }
    }

    /// Stop whichever invocation belongs to the loaded activation and wait for
    /// Store destruction. Used by unload and shutdown before their own ack.
    pub fn cancel_active_and_wait(&self) {
        let mut status = self.lock();
        let Some(fence) = status.active.as_ref().map(|active| active.fence.clone()) else {
            return;
        };
        if let Some(active) = status.active.as_mut()
            && active.stop.is_none()
            && !active.completing
        {
            active.stop = Some(StopReason::Cancelled);
            self.changed.notify_all();
        }
        while status
            .active
            .as_ref()
            .is_some_and(|active| active.fence.exact_matches(&fence))
        {
            status = self
                .changed
                .wait(status)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }

    /// Fatal input/EOF has no peer to consume a terminal frame. Interrupt and
    /// drain silently so all scoped child threads can join without emitting a
    /// fabricated result after the protocol stream ended.
    pub fn abort_active_and_wait(&self) {
        let mut status = self.lock();
        let Some(fence) = status.active.as_ref().map(|active| active.fence.clone()) else {
            return;
        };
        if let Some(active) = status.active.as_mut() {
            active.stop = Some(StopReason::Aborted);
            self.changed.notify_all();
        }
        while status
            .active
            .as_ref()
            .is_some_and(|active| active.fence.exact_matches(&fence))
        {
            status = self
                .changed
                .wait(status)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
    }

    /// Linearize natural completion against controls. Successful Stores are
    /// retained and their terminal is enqueued under the control lock. A
    /// failed/stopped Store can take nontrivial time to drop, so completion is
    /// frozen first, destruction happens without the lock, and only then is
    /// the terminal enqueued and `active` cleared.
    fn complete(
        &self,
        fence: &AuthorityFence,
        result: Result<TypedChildMessage, HostFailureCode>,
        outbound: &mpsc::SyncSender<OutboundMessage>,
        discard_failed_store: impl FnOnce(),
    ) {
        let mut status = self.lock();
        let Some(active) = status.active.as_ref() else {
            return;
        };
        if !active.fence.exact_matches(fence) {
            return;
        }
        if active.stop.is_none() && Instant::now() >= active.deadline {
            status
                .active
                .as_mut()
                .expect("active invocation disappeared")
                .stop = Some(StopReason::Timeout);
        }

        let result = match (
            status
                .active
                .as_ref()
                .expect("active invocation disappeared")
                .stop,
            result,
        ) {
            (None, Ok(message)) => {
                if outbound.try_send(OutboundMessage::typed(message)).is_ok() {
                    status.active = None;
                    let pending = status.pending.take();
                    self.changed.notify_all();
                    drop(status);
                    cancel_pending(pending);
                    return;
                }

                // A terminal that cannot reserve bounded writer capacity is a
                // transport failure, not a successful retained invocation.
                // Destroy the Store and fail this activation closed without
                // blocking watchdog/control ownership on the writer.
                status
                    .active
                    .as_mut()
                    .expect("active invocation disappeared")
                    .completing = true;
                status.loaded = false;
                self.changed.notify_all();
                drop(status);
                discard_failed_store();
                let pending = {
                    let mut status = self.lock();
                    if status
                        .active
                        .as_ref()
                        .is_some_and(|active| active.fence.exact_matches(fence))
                    {
                        status.active = None;
                    }
                    let pending = status.pending.take();
                    self.changed.notify_all();
                    pending
                };
                cancel_pending(pending);
                return;
            }
            (_, result) => result,
        };

        status
            .active
            .as_mut()
            .expect("active invocation disappeared")
            .completing = true;
        self.changed.notify_all();
        drop(status);

        discard_failed_store();

        let pending = {
            let mut status = self.lock();
            let Some(active) = status.active.as_ref() else {
                return;
            };
            if !active.fence.exact_matches(fence) {
                return;
            }
            let message = match (active.stop, result) {
                (Some(StopReason::Timeout), _) => {
                    Some(OutboundMessage::frame(ChildFrame::Failed {
                        fence: fence.clone(),
                        code: HostFailureCode::Timeout,
                    }))
                }
                (Some(StopReason::Cancelled), _) => {
                    Some(OutboundMessage::frame(ChildFrame::Cancelled {
                        fence: fence.clone(),
                    }))
                }
                (Some(StopReason::Aborted), _) => None,
                (None, Err(code)) => Some(OutboundMessage::frame(ChildFrame::Failed {
                    fence: fence.clone(),
                    code,
                })),
                (None, Ok(_)) => unreachable!("successful Store was selected for destruction"),
            };
            if message.is_some_and(|message| outbound.try_send(message).is_err()) {
                status.loaded = false;
            }
            status.active = None;
            let pending = status.pending.take();
            self.changed.notify_all();
            pending
        };
        cancel_pending(pending);
    }

    fn register_callback(
        &self,
        pending: PendingCallback,
        message: OutboundMessage,
        outbound: &mpsc::SyncSender<OutboundMessage>,
    ) -> Result<(), HostError> {
        let mut status = self.lock();
        let authority = pending.callback.authority();
        if status.pending.is_some()
            || !status.active.as_ref().is_some_and(|active| {
                active.fence.exact_matches(&authority)
                    && active.stop.is_none()
                    && !active.completing
            })
        {
            return Err(HostError::Runtime);
        }
        status.pending = Some(pending);
        match outbound.try_send(message) {
            Ok(()) => {
                self.changed.notify_all();
                Ok(())
            }
            Err(_) => {
                status.pending = None;
                self.changed.notify_all();
                Err(HostError::Runtime)
            }
        }
    }

    pub fn route_callback(&self, message: ParentMessage) -> Result<(), CallbackRouteError> {
        let ParentFrame::CapabilityReply {
            callback,
            kind,
            result,
            ..
        } = &message.frame
        else {
            return Err(CallbackRouteError::Wrong);
        };

        let mut status = self.lock();
        let Some(pending) = status.pending.as_ref() else {
            return Err(CallbackRouteError::Stale);
        };
        let Some(active) = status.active.as_ref() else {
            return Err(CallbackRouteError::Stale);
        };
        if active.stop.is_some()
            || validate_callback_correlation(&active.fence, pending.callback.callback_id, callback)
                .is_err()
        {
            return Err(CallbackRouteError::Stale);
        }
        if pending.callback != *callback || pending.kind != *kind {
            return Err(CallbackRouteError::Wrong);
        }
        let reply = decode_host_call_reply(*kind, *result, &message.body)
            .map_err(|_| CallbackRouteError::Wrong)?;
        let pending = status.pending.take().expect("pending callback disappeared");
        self.changed.notify_all();
        drop(status);
        pending
            .reply
            .send(reply)
            .map_err(|_| CallbackRouteError::Stale)
    }

    /// The only owner that advances the Engine epoch. It sleeps on a condition
    /// variable while idle, wakes for control requests, and advances once for
    /// an active deadline/cancel before returning to the idle state.
    pub fn run_watchdog(&self, engine: &Engine) {
        loop {
            let pending = {
                let mut status = self.lock();
                loop {
                    if status.watchdog_shutdown {
                        return;
                    }
                    let Some(active) = status.active.as_mut() else {
                        status = self
                            .changed
                            .wait(status)
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        continue;
                    };
                    if active.completing {
                        status = self
                            .changed
                            .wait(status)
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        continue;
                    }
                    if active.stop.is_none() {
                        let now = Instant::now();
                        if now >= active.deadline {
                            active.stop = Some(StopReason::Timeout);
                            continue;
                        }
                        let duration = active.deadline.saturating_duration_since(now);
                        let (next, _) = self
                            .changed
                            .wait_timeout(status, duration)
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        status = next;
                        continue;
                    }
                    if active.epoch_advanced {
                        status = self
                            .changed
                            .wait(status)
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        continue;
                    }
                    active.epoch_advanced = true;
                    let pending = status.pending.take();
                    // Advance before releasing the authority lock so an old
                    // stop can never interrupt a newly admitted invocation.
                    engine.increment_epoch();
                    break pending;
                }
            };
            cancel_pending(pending);
        }
    }

    pub fn shutdown_watchdog(&self) {
        let mut status = self.lock();
        status.watchdog_shutdown = true;
        self.changed.notify_all();
    }

    pub fn worker_stopped(&self) {
        let pending = {
            let mut status = self.lock();
            status.loaded = false;
            status.worker_stopped = true;
            status.active = None;
            let pending = status.pending.take();
            self.changed.notify_all();
            pending
        };
        cancel_pending(pending);
    }
}

fn cancel_pending(pending: Option<PendingCallback>) {
    if let Some(pending) = pending {
        let _ = pending.reply.send(HostCallReply::Cancelled(pending.kind));
    }
}

pub(crate) struct LoadRequest {
    pub component: Vec<u8>,
    pub import_export_fingerprint: String,
    pub runtime_profile: RuntimeProfile,
    pub grants: Vec<Permission>,
    pub limits: RuntimeLimits,
}

pub(crate) struct InvokeRequest {
    pub fence: AuthorityFence,
    pub kind: InvocationKind,
    pub mode: InvocationMode,
    pub body: Vec<u8>,
}

pub(crate) enum RuntimeCommand {
    Load {
        request: LoadRequest,
        reply: mpsc::SyncSender<Result<(), HostFailureCode>>,
    },
    Invoke(InvokeRequest),
    Unload {
        reply: mpsc::SyncSender<()>,
    },
    Shutdown {
        reply: mpsc::SyncSender<()>,
    },
}

pub(crate) fn run_runtime(
    engine: Engine,
    commands: mpsc::Receiver<RuntimeCommand>,
    outbound: mpsc::SyncSender<OutboundMessage>,
    status: Arc<SharedRuntimeStatus>,
) {
    struct WorkerGuard(Arc<SharedRuntimeStatus>);
    impl Drop for WorkerGuard {
        fn drop(&mut self) {
            self.0.worker_stopped();
        }
    }

    let _guard = WorkerGuard(status.clone());
    let mut loaded = None;
    while let Ok(command) = commands.recv() {
        match command {
            RuntimeCommand::Load { request, reply } => {
                let result =
                    LoadedRuntime::load(&engine, request, outbound.clone(), status.clone());
                if result.is_ok() {
                    status.mark_loaded();
                }
                let result = result.map(|runtime| {
                    loaded = Some(runtime);
                });
                let _ = reply.send(result);
            }
            RuntimeCommand::Invoke(request) => {
                let fence = request.fence.clone();
                let result = loaded
                    .as_mut()
                    .ok_or(HostFailureCode::StaleAuthority)
                    .and_then(|runtime| runtime.invoke(request));
                status.complete(&fence, result, &outbound, || {
                    if let Some(runtime) = loaded.as_mut() {
                        runtime.discard_instance();
                    }
                });
            }
            RuntimeCommand::Unload { reply } => {
                loaded = None;
                status.mark_unloaded();
                let _ = reply.send(());
            }
            RuntimeCommand::Shutdown { reply } => {
                drop(loaded.take());
                status.mark_unloaded();
                let _ = reply.send(());
                break;
            }
        }
    }
}

struct InvocationState {
    fence: AuthorityFence,
    mode: InvocationMode,
    grants: Vec<Permission>,
    next_callback_id: u32,
    log_bytes: usize,
    host_failure: Option<HostFailureCode>,
}

struct RuntimeLimiter {
    inner: StoreLimits,
    resource_failure: bool,
}

impl RuntimeLimiter {
    fn reset(&mut self) {
        self.resource_failure = false;
    }

    fn record(&mut self, result: &wasmtime::Result<bool>) {
        if !matches!(result, Ok(true)) {
            self.resource_failure = true;
        }
    }
}

impl ResourceLimiter for RuntimeLimiter {
    fn memory_growing(
        &mut self,
        current: usize,
        desired: usize,
        maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        let result = self.inner.memory_growing(current, desired, maximum);
        self.record(&result);
        result
    }

    fn memory_grow_failed(&mut self, error: wasmtime::Error) -> wasmtime::Result<()> {
        self.resource_failure = true;
        self.inner.memory_grow_failed(error)
    }

    fn table_growing(
        &mut self,
        current: usize,
        desired: usize,
        maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        let result = self.inner.table_growing(current, desired, maximum);
        self.record(&result);
        result
    }

    fn table_grow_failed(&mut self, error: wasmtime::Error) -> wasmtime::Result<()> {
        self.resource_failure = true;
        self.inner.table_grow_failed(error)
    }

    fn instances(&self) -> usize {
        self.inner.instances()
    }

    fn tables(&self) -> usize {
        self.inner.tables()
    }

    fn memories(&self) -> usize {
        self.inner.memories()
    }
}

struct StoreState {
    limiter: RuntimeLimiter,
    table: wasmtime::component::ResourceTable,
    wasi: WasiCtx,
    stderr: wasmtime_wasi::p2::pipe::MemoryOutputPipe,
    bridge: CallbackBridge,
    grants: Vec<Permission>,
    runtime_limits: RuntimeLimits,
    invocation: Option<InvocationState>,
}

impl WasiView for StoreState {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

struct HasWasi;
impl HasData for HasWasi {
    type Data<'a> = WasiCtxView<'a>;
}

struct HasIo;
impl HasData for HasIo {
    type Data<'a> = &'a mut wasmtime::component::ResourceTable;
}

#[derive(Clone)]
struct CallbackBridge {
    outbound: mpsc::SyncSender<OutboundMessage>,
    status: Arc<SharedRuntimeStatus>,
}

impl CallbackBridge {
    fn call(
        &self,
        invocation: &mut InvocationState,
        request: HostCallRequest,
        log_bytes_max: usize,
    ) -> Result<HostCallReply, HostFailureCode> {
        let kind = request.kind();
        validate_host_call_authority(kind, invocation.mode, &invocation.grants)
            .map_err(|_| HostFailureCode::PermissionDenied)?;
        let callback_id = invocation.next_callback_id;
        invocation.next_callback_id = callback_id
            .checked_add(1)
            .ok_or(HostFailureCode::ResourceLimit)?;
        let callback = CallbackFence {
            plugin_id: invocation.fence.plugin_id.clone(),
            package_generation: invocation.fence.package_generation,
            activation_epoch: invocation.fence.activation_epoch,
            host_session_id: invocation.fence.host_session_id.clone(),
            invocation_id: invocation.fence.invocation_id.clone(),
            callback_id,
        };
        let message = request
            .into_child_message(callback.clone())
            .map_err(|_| HostFailureCode::ResourceLimit)?;
        let message = OutboundMessage::typed(message);
        if kind == HostCallKind::Log {
            invocation.log_bytes = invocation
                .log_bytes
                .checked_add(message.body.len())
                .ok_or(HostFailureCode::ResourceLimit)?;
            if invocation.log_bytes > log_bytes_max {
                return Err(HostFailureCode::ResourceLimit);
            }
        }
        let (reply_sender, reply_receiver) = mpsc::sync_channel(1);
        self.status
            .register_callback(
                PendingCallback {
                    callback: callback.clone(),
                    kind,
                    reply: reply_sender,
                },
                message,
                &self.outbound,
            )
            .map_err(|_| HostFailureCode::Unavailable)?;
        reply_receiver
            .recv()
            .map_err(|_| HostFailureCode::Unavailable)
    }
}

impl StoreState {
    fn failure(&mut self, code: HostFailureCode) -> wasmtime::Error {
        if let Some(invocation) = self.invocation.as_mut() {
            invocation.host_failure = Some(code);
        }
        wasmtime::Error::msg("guest host call rejected")
    }

    fn callback(&mut self, request: HostCallRequest) -> wasmtime::Result<HostCallReply> {
        let bridge = self.bridge.clone();
        let log_bytes_max = usize::try_from(self.runtime_limits.guest_log_invocation_bytes)
            .map_err(|_| self.failure(HostFailureCode::Internal))?;
        let invocation = self
            .invocation
            .as_mut()
            .ok_or_else(|| wasmtime::Error::msg("capability call outside invocation"))?;
        match bridge.call(invocation, request, log_bytes_max) {
            Ok(reply) => Ok(reply),
            Err(code) => Err(self.failure(code)),
        }
    }
}

fn cancelled_host_error() -> bindings::junban::plugin::types::HostError {
    neutral::HostError {
        code: neutral::ErrorCode::Cancelled,
        field: None,
        message: "capability call cancelled".into(),
    }
    .into()
}

impl bindings::junban::plugin::types::Host for StoreState {}

impl bindings::junban::plugin::host_tasks::Host for StoreState {
    fn query_tasks(
        &mut self,
        query: bindings::junban::plugin::types::TaskQuery,
    ) -> wasmtime::Result<
        Result<
            bindings::junban::plugin::types::TaskPage,
            bindings::junban::plugin::types::HostError,
        >,
    > {
        let query = query
            .try_into()
            .map_err(|_| self.failure(HostFailureCode::ResourceLimit))?;
        match self.callback(HostCallRequest::QueryTasks(query))? {
            HostCallReply::QueryTasks(neutral::WitResult::Ok(page)) => Ok(Ok(page.into())),
            HostCallReply::QueryTasks(neutral::WitResult::Err(error)) => Ok(Err(error.into())),
            HostCallReply::Cancelled(HostCallKind::QueryTasks) => Ok(Err(cancelled_host_error())),
            _ => Err(wasmtime::Error::msg("capability reply kind mismatch")),
        }
    }
}

impl bindings::junban::plugin::host_projects::Host for StoreState {
    fn query_projects(
        &mut self,
        query: bindings::junban::plugin::types::CatalogQuery,
    ) -> wasmtime::Result<
        Result<
            bindings::junban::plugin::types::ProjectPage,
            bindings::junban::plugin::types::HostError,
        >,
    > {
        let query = query
            .try_into()
            .map_err(|_| self.failure(HostFailureCode::ResourceLimit))?;
        match self.callback(HostCallRequest::QueryProjects(query))? {
            HostCallReply::QueryProjects(neutral::WitResult::Ok(page)) => Ok(Ok(page.into())),
            HostCallReply::QueryProjects(neutral::WitResult::Err(error)) => Ok(Err(error.into())),
            HostCallReply::Cancelled(HostCallKind::QueryProjects) => {
                Ok(Err(cancelled_host_error()))
            }
            _ => Err(wasmtime::Error::msg("capability reply kind mismatch")),
        }
    }
}

impl bindings::junban::plugin::host_tags::Host for StoreState {
    fn query_tags(
        &mut self,
        query: bindings::junban::plugin::types::CatalogQuery,
    ) -> wasmtime::Result<
        Result<
            bindings::junban::plugin::types::TagPage,
            bindings::junban::plugin::types::HostError,
        >,
    > {
        let query = query
            .try_into()
            .map_err(|_| self.failure(HostFailureCode::ResourceLimit))?;
        match self.callback(HostCallRequest::QueryTags(query))? {
            HostCallReply::QueryTags(neutral::WitResult::Ok(page)) => Ok(Ok(page.into())),
            HostCallReply::QueryTags(neutral::WitResult::Err(error)) => Ok(Err(error.into())),
            HostCallReply::Cancelled(HostCallKind::QueryTags) => Ok(Err(cancelled_host_error())),
            _ => Err(wasmtime::Error::msg("capability reply kind mismatch")),
        }
    }
}

impl bindings::junban::plugin::host_settings::Host for StoreState {
    fn get_settings(
        &mut self,
    ) -> wasmtime::Result<
        Result<
            Vec<bindings::junban::plugin::types::NamedSetting>,
            bindings::junban::plugin::types::HostError,
        >,
    > {
        match self.callback(HostCallRequest::GetSettings(()))? {
            HostCallReply::GetSettings(neutral::WitResult::Ok(settings)) => {
                Ok(Ok(settings.into_iter().map(Into::into).collect()))
            }
            HostCallReply::GetSettings(neutral::WitResult::Err(error)) => Ok(Err(error.into())),
            HostCallReply::Cancelled(HostCallKind::GetSettings) => Ok(Err(cancelled_host_error())),
            _ => Err(wasmtime::Error::msg("capability reply kind mismatch")),
        }
    }
}

impl bindings::junban::plugin::host_storage::Host for StoreState {
    fn get_kv(
        &mut self,
        keys: Vec<String>,
    ) -> wasmtime::Result<
        Result<
            Vec<bindings::junban::plugin::types::KvEntry>,
            bindings::junban::plugin::types::HostError,
        >,
    > {
        match self.callback(HostCallRequest::GetKv(keys))? {
            HostCallReply::GetKv(neutral::WitResult::Ok(entries)) => {
                Ok(Ok(entries.into_iter().map(Into::into).collect()))
            }
            HostCallReply::GetKv(neutral::WitResult::Err(error)) => Ok(Err(error.into())),
            HostCallReply::Cancelled(HostCallKind::GetKv) => Ok(Err(cancelled_host_error())),
            _ => Err(wasmtime::Error::msg("capability reply kind mismatch")),
        }
    }

    fn list_kv(
        &mut self,
        cursor: Option<String>,
        limit: u8,
    ) -> wasmtime::Result<
        Result<bindings::junban::plugin::types::KvPage, bindings::junban::plugin::types::HostError>,
    > {
        match self.callback(HostCallRequest::ListKv(
            neutral::HostStorageListKvArguments { cursor, limit },
        ))? {
            HostCallReply::ListKv(neutral::WitResult::Ok(page)) => Ok(Ok(page.into())),
            HostCallReply::ListKv(neutral::WitResult::Err(error)) => Ok(Err(error.into())),
            HostCallReply::Cancelled(HostCallKind::ListKv) => Ok(Err(cancelled_host_error())),
            _ => Err(wasmtime::Error::msg("capability reply kind mismatch")),
        }
    }
}

impl bindings::junban::plugin::host_clock::Host for StoreState {
    fn wall_now(&mut self) -> wasmtime::Result<String> {
        match self.callback(HostCallRequest::WallNow(()))? {
            HostCallReply::WallNow(timestamp) => Ok(timestamp),
            HostCallReply::Cancelled(HostCallKind::WallNow) => {
                Err(wasmtime::Error::msg("capability call cancelled"))
            }
            _ => Err(wasmtime::Error::msg("capability reply kind mismatch")),
        }
    }

    fn monotonic_ms(&mut self) -> wasmtime::Result<u64> {
        match self.callback(HostCallRequest::MonotonicMs(()))? {
            HostCallReply::MonotonicMs(milliseconds) => Ok(milliseconds),
            HostCallReply::Cancelled(HostCallKind::MonotonicMs) => {
                Err(wasmtime::Error::msg("capability call cancelled"))
            }
            _ => Err(wasmtime::Error::msg("capability reply kind mismatch")),
        }
    }
}

impl bindings::junban::plugin::host_http::Host for StoreState {
    fn request(
        &mut self,
        request: bindings::junban::plugin::types::HttpRequest,
    ) -> wasmtime::Result<
        Result<
            bindings::junban::plugin::types::HttpResponse,
            bindings::junban::plugin::types::HttpError,
        >,
    > {
        let request = request
            .try_into()
            .map_err(|_| self.failure(HostFailureCode::ResourceLimit))?;
        match self.callback(HostCallRequest::HttpRequest(request))? {
            HostCallReply::HttpRequest(neutral::WitResult::Ok(response)) => Ok(Ok(response.into())),
            HostCallReply::HttpRequest(neutral::WitResult::Err(error)) => Ok(Err(error.into())),
            HostCallReply::Cancelled(HostCallKind::HttpRequest) => Ok(Err(neutral::HttpError {
                code: neutral::HttpErrorCode::Unavailable,
                delivery: neutral::DeliveryState::NotSent,
                retryable: false,
                message: "capability call cancelled".into(),
            }
            .into())),
            _ => Err(wasmtime::Error::msg("capability reply kind mismatch")),
        }
    }
}

impl bindings::junban::plugin::host_log::Host for StoreState {
    fn log(
        &mut self,
        level: bindings::junban::plugin::types::LogLevel,
        message: String,
        fields: Vec<bindings::junban::plugin::types::LogField>,
    ) -> wasmtime::Result<()> {
        if message.len() > usize::from(self.runtime_limits.guest_log_message_bytes)
            || fields.len() > usize::from(self.runtime_limits.guest_log_fields)
        {
            return Err(self.failure(HostFailureCode::ResourceLimit));
        }
        let level = level
            .try_into()
            .map_err(|_| self.failure(HostFailureCode::ResourceLimit))?;
        let fields = fields
            .into_iter()
            .map(TryInto::try_into)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| self.failure(HostFailureCode::ResourceLimit))?;
        match self.callback(HostCallRequest::Log(neutral::HostLogLogArguments {
            level,
            message,
            fields,
        }))? {
            HostCallReply::Log(()) => Ok(()),
            HostCallReply::Cancelled(HostCallKind::Log) => {
                Err(wasmtime::Error::msg("capability call cancelled"))
            }
            _ => Err(wasmtime::Error::msg("capability reply kind mismatch")),
        }
    }
}

impl bindings::junban::plugin::host_services::Host for StoreState {
    fn call_service(
        &mut self,
        call: bindings::junban::plugin::types::ServiceCall,
    ) -> wasmtime::Result<
        Result<
            bindings::junban::plugin::types::ServiceData,
            bindings::junban::plugin::types::HostError,
        >,
    > {
        let call = call
            .try_into()
            .map_err(|_| self.failure(HostFailureCode::ResourceLimit))?;
        match self.callback(HostCallRequest::CallService(call))? {
            HostCallReply::CallService(neutral::WitResult::Ok(data)) => Ok(Ok(data.into())),
            HostCallReply::CallService(neutral::WitResult::Err(error)) => Ok(Err(error.into())),
            HostCallReply::Cancelled(HostCallKind::CallService) => Ok(Err(cancelled_host_error())),
            _ => Err(wasmtime::Error::msg("capability reply kind mismatch")),
        }
    }
}

struct RuntimeInstance {
    store: Store<StoreState>,
    bindings: bindings::Runtime,
}

struct LoadedRuntime {
    engine: Engine,
    component: Component,
    linker: Linker<StoreState>,
    limits: RuntimeLimits,
    grants: Vec<Permission>,
    bridge: CallbackBridge,
    instance: Option<RuntimeInstance>,
}

impl LoadedRuntime {
    fn load(
        engine: &Engine,
        request: LoadRequest,
        outbound: mpsc::SyncSender<OutboundMessage>,
        status: Arc<SharedRuntimeStatus>,
    ) -> Result<Self, HostFailureCode> {
        let inspection = inspect_component_for_runtime(
            &request.component,
            request.runtime_profile,
            &request.grants,
        )
        .map_err(|error| match error {
            SdkError::Permission => HostFailureCode::PermissionDenied,
            _ => HostFailureCode::InvalidComponent,
        })?;
        if inspection.import_export_fingerprint != request.import_export_fingerprint {
            return Err(HostFailureCode::InvalidComponent);
        }

        let component = Component::new(engine, &request.component)
            .map_err(|_| HostFailureCode::InvalidComponent)?;
        let mut linker = Linker::new(engine);
        add_actual_imports(&mut linker, &inspection.imports)
            .map_err(|_| HostFailureCode::InvalidComponent)?;

        let mut runtime = Self {
            engine: engine.clone(),
            component,
            linker,
            limits: request.limits,
            grants: request.grants,
            bridge: CallbackBridge { outbound, status },
            instance: None,
        };
        runtime.instance = Some(runtime.instantiate()?);
        Ok(runtime)
    }

    fn instantiate(&self) -> Result<RuntimeInstance, HostFailureCode> {
        let stderr_capacity = usize::try_from(self.limits.wasi_stderr_bytes)
            .map_err(|_| HostFailureCode::ResourceLimit)?;
        let stderr = wasmtime_wasi::p2::pipe::MemoryOutputPipe::new(stderr_capacity);
        let mut wasi = WasiCtxBuilder::new();
        wasi.stderr(stderr.clone());
        let store_limits = StoreLimitsBuilder::new()
            .memory_size(
                usize::try_from(self.limits.linear_memory_bytes)
                    .map_err(|_| HostFailureCode::ResourceLimit)?,
            )
            .table_elements(
                usize::try_from(self.limits.table_elements)
                    .map_err(|_| HostFailureCode::ResourceLimit)?,
            )
            .memories(usize::from(self.limits.memories))
            .tables(usize::from(self.limits.tables))
            .instances(usize::from(self.limits.instances))
            .trap_on_grow_failure(true)
            .build();
        let mut table = wasmtime::component::ResourceTable::new();
        table.set_max_capacity(usize::from(self.limits.host_resources));
        let mut store = Store::new(
            &self.engine,
            StoreState {
                limiter: RuntimeLimiter {
                    inner: store_limits,
                    resource_failure: false,
                },
                table,
                wasi: wasi.build(),
                stderr,
                bridge: self.bridge.clone(),
                grants: self.grants.clone(),
                runtime_limits: self.limits.clone(),
                invocation: None,
            },
        );
        store.limiter(|state| &mut state.limiter);
        store.set_hostcall_fuel(HOSTCALL_TRANSFER_FUEL);
        assert_eq!(store.hostcall_fuel(), HOSTCALL_TRANSFER_FUEL);
        store
            .set_fuel(self.limits.fuel)
            .map_err(|_| HostFailureCode::Internal)?;
        store.set_epoch_deadline(1);
        let bindings = bindings::Runtime::instantiate(&mut store, &self.component, &self.linker)
            .map_err(|_| HostFailureCode::ResourceLimit)?;
        Ok(RuntimeInstance { store, bindings })
    }

    fn invoke(&mut self, request: InvokeRequest) -> Result<TypedChildMessage, HostFailureCode> {
        if self.instance.is_none() {
            self.instance = Some(self.instantiate()?);
        }
        self.instance
            .as_mut()
            .expect("runtime instance disappeared")
            .invoke(request, &self.limits)
    }

    fn discard_instance(&mut self) {
        self.instance = None;
    }
}

impl RuntimeInstance {
    fn invoke(
        &mut self,
        request: InvokeRequest,
        limits: &RuntimeLimits,
    ) -> Result<TypedChildMessage, HostFailureCode> {
        let invocation = decode_invocation_request(request.kind, &request.body)
            .map_err(|_| HostFailureCode::InvalidFrame)?;
        let context = invocation
            .context(&request.fence)
            .map_err(|_| HostFailureCode::InvalidFrame)?;
        self.store
            .set_fuel(limits.fuel)
            .map_err(|_| HostFailureCode::Internal)?;
        self.store.set_epoch_deadline(1);
        self.store.data_mut().limiter.reset();
        let grants = self.store.data().grants.clone();
        self.store.data_mut().invocation = Some(InvocationState {
            fence: request.fence.clone(),
            mode: request.mode,
            grants,
            next_callback_id: 1,
            log_bytes: 0,
            host_failure: None,
        });
        let result = self.invoke_inner(invocation, context);
        self.store.data_mut().invocation = None;
        result?
            .into_child_message(request.fence)
            .map_err(|_| HostFailureCode::ResourceLimit)
    }

    fn invoke_inner(
        &mut self,
        request: InvocationRequest,
        context: neutral::InvocationContext,
    ) -> Result<InvocationOutcome, HostFailureCode> {
        let context = context.into();
        let guest = self.bindings.junban_plugin_guest();
        match request {
            InvocationRequest::Activate(payload) => {
                let (_, ()) = payload.into_parts();
                let result = guest
                    .call_activate(&mut self.store, &context)
                    .map_err(|error| classify_wasmtime_failure(&self.store, &error))?;
                Ok(InvocationOutcome::Activate(binding_unit_result(result)?))
            }
            InvocationRequest::Deactivate(payload) => {
                let (_, ()) = payload.into_parts();
                let result = guest
                    .call_deactivate(&mut self.store, &context)
                    .map_err(|error| classify_wasmtime_failure(&self.store, &error))?;
                Ok(InvocationOutcome::Deactivate(binding_unit_result(result)?))
            }
            InvocationRequest::InvokeCommand(payload) => {
                let (_, argument) = payload.into_parts();
                let result = guest
                    .call_invoke_command(&mut self.store, &context, &argument.into())
                    .map_err(|error| classify_wasmtime_failure(&self.store, &error))?;
                Ok(InvocationOutcome::InvokeCommand(binding_result(result)?))
            }
            InvocationRequest::HandleEvent(payload) => {
                let (_, argument) = payload.into_parts();
                let result = guest
                    .call_handle_event(&mut self.store, &context, &argument.into())
                    .map_err(|error| classify_wasmtime_failure(&self.store, &error))?;
                Ok(InvocationOutcome::HandleEvent(binding_result(result)?))
            }
            InvocationRequest::RenderSurface(payload) => {
                let (_, argument) = payload.into_parts();
                let result = guest
                    .call_render_surface(&mut self.store, &context, &argument.into())
                    .map_err(|error| classify_wasmtime_failure(&self.store, &error))?;
                Ok(InvocationOutcome::RenderSurface(binding_result(result)?))
            }
            InvocationRequest::HandleSurfaceAction(payload) => {
                let (_, argument) = payload.into_parts();
                let result = guest
                    .call_handle_surface_action(&mut self.store, &context, &argument.into())
                    .map_err(|error| classify_wasmtime_failure(&self.store, &error))?;
                Ok(InvocationOutcome::HandleSurfaceAction(binding_result(
                    result,
                )?))
            }
            InvocationRequest::ValidateSettings(payload) => {
                let (_, argument) = payload.into_parts();
                let result = guest
                    .call_validate_settings(&mut self.store, &context, &argument.into())
                    .map_err(|error| classify_wasmtime_failure(&self.store, &error))?;
                Ok(InvocationOutcome::ValidateSettings(binding_result_vec(
                    result,
                )?))
            }
            InvocationRequest::Resync(payload) => {
                let (_, argument) = payload.into_parts();
                let result = guest
                    .call_resync(&mut self.store, &context, &argument.into())
                    .map_err(|error| classify_wasmtime_failure(&self.store, &error))?;
                Ok(InvocationOutcome::Resync(binding_result(result)?))
            }
            InvocationRequest::CallService(payload) => {
                let (_, argument) = payload.into_parts();
                let result = guest
                    .call_call_service(&mut self.store, &context, &argument.into())
                    .map_err(|error| classify_wasmtime_failure(&self.store, &error))?;
                Ok(InvocationOutcome::CallService(binding_result(result)?))
            }
        }
    }
}

const HOSTCALL_FUEL_EXHAUSTED: &str = "too much data is being copied between the host and the guest: fuel allocated for hostcalls has been exhausted";

fn classify_wasmtime_failure(
    store: &Store<StoreState>,
    error: &wasmtime::Error,
) -> HostFailureCode {
    let state = store.data();
    if let Some(code) = state
        .invocation
        .as_ref()
        .and_then(|invocation| invocation.host_failure)
    {
        return code;
    }
    if state.limiter.resource_failure
        || error
            .chain()
            .any(|cause| cause.to_string() == HOSTCALL_FUEL_EXHAUSTED)
        || error
            .downcast_ref::<wasmtime::component::ResourceTableError>()
            .is_some_and(|error| {
                matches!(
                    error,
                    wasmtime::component::ResourceTableError::Full
                        | wasmtime::component::ResourceTableError::HasChildren
                )
            })
        || state.stderr.contents().len()
            >= usize::try_from(state.runtime_limits.wasi_stderr_bytes).unwrap_or(usize::MAX)
    {
        return HostFailureCode::ResourceLimit;
    }
    match error.downcast_ref::<Trap>() {
        Some(
            Trap::StackOverflow
            | Trap::MemoryOutOfBounds
            | Trap::TableOutOfBounds
            | Trap::AllocationTooLarge
            | Trap::OutOfFuel,
        ) => HostFailureCode::ResourceLimit,
        Some(Trap::Interrupt) => HostFailureCode::Cancelled,
        _ => HostFailureCode::GuestError,
    }
}

fn binding_unit_result(
    result: Result<(), bindings::junban::plugin::types::PluginError>,
) -> Result<neutral::WitResult<(), neutral::PluginError>, HostFailureCode> {
    match result {
        Ok(()) => Ok(neutral::WitResult::Ok(())),
        Err(error) => Ok(neutral::WitResult::Err(
            error
                .try_into()
                .map_err(|_| HostFailureCode::ResourceLimit)?,
        )),
    }
}

fn binding_result<T, N>(
    result: Result<T, bindings::junban::plugin::types::PluginError>,
) -> Result<neutral::WitResult<N, neutral::PluginError>, HostFailureCode>
where
    T: TryInto<N>,
{
    match result {
        Ok(value) => Ok(neutral::WitResult::Ok(
            value
                .try_into()
                .map_err(|_| HostFailureCode::ResourceLimit)?,
        )),
        Err(error) => Ok(neutral::WitResult::Err(
            error
                .try_into()
                .map_err(|_| HostFailureCode::ResourceLimit)?,
        )),
    }
}

fn binding_result_vec<T, N>(
    result: Result<Vec<T>, bindings::junban::plugin::types::PluginError>,
) -> Result<neutral::WitResult<Vec<N>, neutral::PluginError>, HostFailureCode>
where
    T: TryInto<N>,
{
    match result {
        Ok(values) => Ok(neutral::WitResult::Ok(
            values
                .into_iter()
                .map(TryInto::try_into)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| HostFailureCode::ResourceLimit)?,
        )),
        Err(error) => Ok(neutral::WitResult::Err(
            error
                .try_into()
                .map_err(|_| HostFailureCode::ResourceLimit)?,
        )),
    }
}

fn add_actual_imports(linker: &mut Linker<StoreState>, imports: &[String]) -> wasmtime::Result<()> {
    use crate::bindings::junban::plugin;
    use wasmtime_wasi::p2::bindings as wasi_bindings;

    for import in imports {
        match import.as_str() {
            "junban:plugin/types@0.1.0" => {
                plugin::types::add_to_linker::<StoreState, HasSelf<StoreState>>(linker, |state| {
                    state
                })?;
            }
            "junban:plugin/host-tasks@0.1.0" => {
                plugin::host_tasks::add_to_linker::<StoreState, HasSelf<StoreState>>(
                    linker,
                    |state| state,
                )?;
            }
            "junban:plugin/host-projects@0.1.0" => {
                plugin::host_projects::add_to_linker::<StoreState, HasSelf<StoreState>>(
                    linker,
                    |state| state,
                )?;
            }
            "junban:plugin/host-tags@0.1.0" => {
                plugin::host_tags::add_to_linker::<StoreState, HasSelf<StoreState>>(
                    linker,
                    |state| state,
                )?;
            }
            "junban:plugin/host-settings@0.1.0" => {
                plugin::host_settings::add_to_linker::<StoreState, HasSelf<StoreState>>(
                    linker,
                    |state| state,
                )?;
            }
            "junban:plugin/host-storage@0.1.0" => {
                plugin::host_storage::add_to_linker::<StoreState, HasSelf<StoreState>>(
                    linker,
                    |state| state,
                )?;
            }
            "junban:plugin/host-clock@0.1.0" => {
                plugin::host_clock::add_to_linker::<StoreState, HasSelf<StoreState>>(
                    linker,
                    |state| state,
                )?;
            }
            "junban:plugin/host-http@0.1.0" => {
                plugin::host_http::add_to_linker::<StoreState, HasSelf<StoreState>>(
                    linker,
                    |state| state,
                )?;
            }
            "junban:plugin/host-log@0.1.0" => {
                plugin::host_log::add_to_linker::<StoreState, HasSelf<StoreState>>(
                    linker,
                    |state| state,
                )?;
            }
            "junban:plugin/host-services@0.1.0" => {
                plugin::host_services::add_to_linker::<StoreState, HasSelf<StoreState>>(
                    linker,
                    |state| state,
                )?;
            }
            "wasi:cli/environment@0.2.6" => {
                wasi_bindings::cli::environment::add_to_linker::<StoreState, HasWasi>(
                    linker,
                    StoreState::ctx,
                )?;
            }
            "wasi:cli/exit@0.2.6" => {
                let options = wasi_bindings::cli::exit::LinkOptions::default();
                wasi_bindings::cli::exit::add_to_linker::<StoreState, HasWasi>(
                    linker,
                    &options,
                    StoreState::ctx,
                )?;
            }
            "wasi:cli/stderr@0.2.6" => {
                wasi_bindings::cli::stderr::add_to_linker::<StoreState, HasWasi>(
                    linker,
                    StoreState::ctx,
                )?;
            }
            "wasi:io/error@0.2.6" => {
                wasi_bindings::io::error::add_to_linker::<StoreState, HasIo>(linker, |state| {
                    &mut state.table
                })?;
            }
            "wasi:io/streams@0.2.6" => {
                wasi_bindings::sync::io::streams::add_to_linker::<StoreState, HasIo>(
                    linker,
                    |state| &mut state.table,
                )?;
            }
            _ => return Err(wasmtime::Error::msg("component import rejected")),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{cell::Cell, sync::mpsc, time::Duration};

    use junban_plugin_sdk::{
        AuthorityFence, CallbackFence, ChildFrame, HOST_CALL_KINDS, HostCallKind,
        InvocationOutcome, private_body_types as neutral,
    };
    use wasmtime::{Config, Engine, component::Linker};

    use super::{
        OutboundMessage, PendingCallback, SharedRuntimeStatus, StoreState, add_actual_imports,
    };

    fn fence() -> AuthorityFence {
        AuthorityFence {
            plugin_id: "test-plugin".into(),
            package_generation: 7,
            activation_epoch: 9,
            host_session_id: "00000000-0000-4000-8000-000000000001".into(),
            invocation_id: "00000000-0000-4000-8000-000000000002".into(),
        }
    }

    #[test]
    fn selective_linker_covers_all_generated_host_import_adapters() {
        const INTERFACES: &[&str] = &[
            "junban:plugin/host-tasks@0.1.0",
            "junban:plugin/host-projects@0.1.0",
            "junban:plugin/host-tags@0.1.0",
            "junban:plugin/host-settings@0.1.0",
            "junban:plugin/host-storage@0.1.0",
            "junban:plugin/host-clock@0.1.0",
            "junban:plugin/host-http@0.1.0",
            "junban:plugin/host-log@0.1.0",
            "junban:plugin/host-services@0.1.0",
        ];
        assert_eq!(HOST_CALL_KINDS.len(), 11);

        let mut config = Config::new();
        config.wasm_component_model(true);
        let engine = Engine::new(&config).unwrap();
        let mut linker = Linker::<StoreState>::new(&engine);
        let imports = INTERFACES
            .iter()
            .map(|interface| (*interface).to_owned())
            .collect::<Vec<_>>();
        add_actual_imports(&mut linker, &imports).unwrap();
    }

    #[test]
    fn full_writer_queue_rejects_callback_and_discards_unpublished_success() {
        let status = SharedRuntimeStatus::default();
        status.mark_loaded();
        let fence = fence();
        status.start(fence.clone(), Duration::from_secs(1)).unwrap();

        let (outbound, _receiver) = mpsc::sync_channel(1);
        outbound
            .send(OutboundMessage::frame(ChildFrame::Failed {
                fence: fence.clone(),
                code: junban_plugin_sdk::HostFailureCode::Unavailable,
            }))
            .unwrap();
        let (reply, _reply_receiver) = mpsc::sync_channel(1);
        let callback = CallbackFence {
            plugin_id: fence.plugin_id.clone(),
            package_generation: fence.package_generation,
            activation_epoch: fence.activation_epoch,
            host_session_id: fence.host_session_id.clone(),
            invocation_id: fence.invocation_id.clone(),
            callback_id: 1,
        };
        assert!(
            status
                .register_callback(
                    PendingCallback {
                        callback,
                        kind: HostCallKind::Log,
                        reply,
                    },
                    OutboundMessage::frame(ChildFrame::Failed {
                        fence: fence.clone(),
                        code: junban_plugin_sdk::HostFailureCode::Unavailable,
                    }),
                    &outbound,
                )
                .is_err()
        );
        assert!(status.lock().pending.is_none());

        let outcome = InvocationOutcome::Activate(neutral::WitResult::Ok(()))
            .into_child_message(fence.clone())
            .unwrap();
        let discarded = Cell::new(false);
        status.complete(&fence, Ok(outcome), &outbound, || discarded.set(true));

        assert!(discarded.get());
        assert!(!status.is_loaded());
        assert!(status.lock().active.is_none());
    }
}
