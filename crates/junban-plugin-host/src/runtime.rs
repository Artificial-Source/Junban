use std::sync::{Arc, Mutex, mpsc};

use junban_plugin_sdk::{
    AuthorityFence, CallbackFence, ChildFrame, HostCallKind, HostCallReply, HostCallRequest,
    HostFailureCode, InvocationKind, InvocationMode, InvocationOutcome, InvocationRequest,
    ParentFrame, Permission, RuntimeLimits, RuntimeProfile, SdkError, TypedChildMessage,
    decode_host_call_reply, decode_invocation_request, inspect_component_for_runtime,
    private_body_types as neutral, validate_callback_correlation, validate_host_call_authority,
};
use wasmtime::{Engine, Store, StoreLimits, StoreLimitsBuilder, component::Component};
use wasmtime::{component::HasData, component::HasSelf, component::Linker};
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};

use crate::{HostError, ParentMessage, bindings};

const WASI_STDERR_BYTES_MAX: usize = 32 * 1024;

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

#[derive(Default)]
struct RuntimeStatus {
    loaded: bool,
    active: Option<AuthorityFence>,
    pending: Option<PendingCallback>,
}

#[derive(Default)]
pub(crate) struct SharedRuntimeStatus {
    inner: Mutex<RuntimeStatus>,
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

impl SharedRuntimeStatus {
    pub fn mark_loaded(&self) {
        self.inner.lock().expect("runtime status poisoned").loaded = true;
    }

    pub fn mark_unloaded(&self) {
        let mut status = self.inner.lock().expect("runtime status poisoned");
        status.loaded = false;
        status.active = None;
        status.pending = None;
    }

    pub fn is_loaded(&self) -> bool {
        self.inner.lock().expect("runtime status poisoned").loaded
    }

    pub fn active(&self) -> Option<AuthorityFence> {
        self.inner
            .lock()
            .expect("runtime status poisoned")
            .active
            .clone()
    }

    pub fn start(&self, fence: AuthorityFence) -> Result<(), StartError> {
        let mut status = self.inner.lock().expect("runtime status poisoned");
        if !status.loaded {
            return Err(StartError::NotLoaded);
        }
        if status.active.is_some() {
            return Err(StartError::Busy);
        }
        status.active = Some(fence);
        Ok(())
    }

    pub fn finish(&self, fence: &AuthorityFence, keep_loaded: bool) {
        let mut status = self.inner.lock().expect("runtime status poisoned");
        if status
            .active
            .as_ref()
            .is_some_and(|active| active.exact_matches(fence))
        {
            status.active = None;
            status.pending = None;
        }
        if !keep_loaded {
            status.loaded = false;
        }
    }

    fn register_callback(&self, pending: PendingCallback) -> Result<(), HostError> {
        let mut status = self.inner.lock().expect("runtime status poisoned");
        let authority = pending.callback.authority();
        if status.pending.is_some()
            || !status
                .active
                .as_ref()
                .is_some_and(|active| active.exact_matches(&authority))
        {
            return Err(HostError::Runtime);
        }
        status.pending = Some(pending);
        Ok(())
    }

    fn remove_callback(&self, callback: &CallbackFence) {
        let mut status = self.inner.lock().expect("runtime status poisoned");
        if status
            .pending
            .as_ref()
            .is_some_and(|pending| pending.callback.exact_matches(callback))
        {
            status.pending = None;
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

        let mut status = self.inner.lock().expect("runtime status poisoned");
        let Some(pending) = status.pending.as_ref() else {
            return Err(CallbackRouteError::Stale);
        };
        let Some(active) = status.active.as_ref() else {
            return Err(CallbackRouteError::Stale);
        };
        if validate_callback_correlation(active, pending.callback.callback_id, callback).is_err() {
            return Err(CallbackRouteError::Stale);
        }
        if pending.callback != *callback || pending.kind != *kind {
            return Err(CallbackRouteError::Wrong);
        }
        let reply = decode_host_call_reply(*kind, *result, &message.body)
            .map_err(|_| CallbackRouteError::Wrong)?;
        let pending = status.pending.take().expect("pending callback disappeared");
        drop(status);
        pending
            .reply
            .send(reply)
            .map_err(|_| CallbackRouteError::Stale)
    }

    pub fn cancel_pending_for_eof(&self) {
        let pending = self
            .inner
            .lock()
            .expect("runtime status poisoned")
            .pending
            .take();
        if let Some(pending) = pending {
            let _ = pending.reply.send(HostCallReply::Cancelled(pending.kind));
        }
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
                let keep_loaded = result.is_ok();
                status.finish(&fence, keep_loaded);
                if !keep_loaded {
                    loaded = None;
                }
                let message = match result {
                    Ok(message) => OutboundMessage::typed(message),
                    Err(code) => OutboundMessage::frame(ChildFrame::Failed { fence, code }),
                };
                let _ = outbound.send(message);
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
}

struct StoreState {
    limits: StoreLimits,
    table: wasmtime::component::ResourceTable,
    wasi: WasiCtx,
    bridge: CallbackBridge,
    grants: Vec<Permission>,
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
    ) -> wasmtime::Result<HostCallReply> {
        let kind = request.kind();
        validate_host_call_authority(kind, invocation.mode, &invocation.grants)
            .map_err(|_| wasmtime::Error::msg("capability call denied"))?;
        let callback_id = invocation.next_callback_id;
        invocation.next_callback_id = callback_id
            .checked_add(1)
            .ok_or_else(|| wasmtime::Error::msg("callback limit exceeded"))?;
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
            .map_err(|_| wasmtime::Error::msg("capability request rejected"))?;
        let (reply_sender, reply_receiver) = mpsc::sync_channel(1);
        self.status
            .register_callback(PendingCallback {
                callback: callback.clone(),
                kind,
                reply: reply_sender,
            })
            .map_err(|_| wasmtime::Error::msg("capability callback unavailable"))?;
        if self.outbound.send(OutboundMessage::typed(message)).is_err() {
            self.status.remove_callback(&callback);
            return Err(wasmtime::Error::msg("capability transport unavailable"));
        }
        reply_receiver
            .recv()
            .map_err(|_| wasmtime::Error::msg("capability reply unavailable"))
    }
}

impl StoreState {
    fn callback(&mut self, request: HostCallRequest) -> wasmtime::Result<HostCallReply> {
        let bridge = self.bridge.clone();
        let invocation = self
            .invocation
            .as_mut()
            .ok_or_else(|| wasmtime::Error::msg("capability call outside invocation"))?;
        bridge.call(invocation, request)
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
            .map_err(|_| wasmtime::Error::msg("capability argument rejected"))?;
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
            .map_err(|_| wasmtime::Error::msg("capability argument rejected"))?;
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
            .map_err(|_| wasmtime::Error::msg("capability argument rejected"))?;
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
            .map_err(|_| wasmtime::Error::msg("capability argument rejected"))?;
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
        let level = level
            .try_into()
            .map_err(|_| wasmtime::Error::msg("capability argument rejected"))?;
        let fields = fields
            .into_iter()
            .map(TryInto::try_into)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| wasmtime::Error::msg("capability argument rejected"))?;
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
            .map_err(|_| wasmtime::Error::msg("capability argument rejected"))?;
        match self.callback(HostCallRequest::CallService(call))? {
            HostCallReply::CallService(neutral::WitResult::Ok(data)) => Ok(Ok(data.into())),
            HostCallReply::CallService(neutral::WitResult::Err(error)) => Ok(Err(error.into())),
            HostCallReply::Cancelled(HostCallKind::CallService) => Ok(Err(cancelled_host_error())),
            _ => Err(wasmtime::Error::msg("capability reply kind mismatch")),
        }
    }
}

struct LoadedRuntime {
    _component: Component,
    store: Store<StoreState>,
    bindings: bindings::Runtime,
    limits: RuntimeLimits,
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

        let stderr = wasmtime_wasi::p2::pipe::MemoryOutputPipe::new(WASI_STDERR_BYTES_MAX);
        let mut wasi = WasiCtxBuilder::new();
        wasi.stderr(stderr);
        let store_limits = StoreLimitsBuilder::new()
            .memory_size(
                usize::try_from(request.limits.linear_memory_bytes)
                    .map_err(|_| HostFailureCode::ResourceLimit)?,
            )
            .table_elements(
                usize::try_from(request.limits.table_elements)
                    .map_err(|_| HostFailureCode::ResourceLimit)?,
            )
            .memories(usize::from(request.limits.memories))
            .tables(usize::from(request.limits.tables))
            .instances(usize::from(request.limits.instances))
            .trap_on_grow_failure(true)
            .build();
        let mut store = Store::new(
            engine,
            StoreState {
                limits: store_limits,
                table: wasmtime::component::ResourceTable::new(),
                wasi: wasi.build(),
                bridge: CallbackBridge { outbound, status },
                grants: request.grants,
                invocation: None,
            },
        );
        store.limiter(|state| &mut state.limits);
        store
            .set_fuel(request.limits.fuel)
            .map_err(|_| HostFailureCode::Internal)?;
        store.set_epoch_deadline(1);
        let runtime = bindings::Runtime::instantiate(&mut store, &component, &linker)
            .map_err(|_| HostFailureCode::ResourceLimit)?;
        Ok(Self {
            _component: component,
            store,
            bindings: runtime,
            limits: request.limits,
        })
    }

    fn invoke(&mut self, request: InvokeRequest) -> Result<TypedChildMessage, HostFailureCode> {
        let invocation = decode_invocation_request(request.kind, &request.body)
            .map_err(|_| HostFailureCode::InvalidFrame)?;
        let context = invocation
            .context(&request.fence)
            .map_err(|_| HostFailureCode::InvalidFrame)?;
        self.store
            .set_fuel(self.limits.fuel)
            .map_err(|_| HostFailureCode::Internal)?;
        self.store.set_epoch_deadline(1);
        let grants = self.store.data().grants.clone();
        self.store.data_mut().invocation = Some(InvocationState {
            fence: request.fence.clone(),
            mode: request.mode,
            grants,
            next_callback_id: 1,
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
                    .map_err(|_| HostFailureCode::GuestError)?;
                Ok(InvocationOutcome::Activate(binding_unit_result(result)?))
            }
            InvocationRequest::Deactivate(payload) => {
                let (_, ()) = payload.into_parts();
                let result = guest
                    .call_deactivate(&mut self.store, &context)
                    .map_err(|_| HostFailureCode::GuestError)?;
                Ok(InvocationOutcome::Deactivate(binding_unit_result(result)?))
            }
            InvocationRequest::InvokeCommand(payload) => {
                let (_, argument) = payload.into_parts();
                let result = guest
                    .call_invoke_command(&mut self.store, &context, &argument.into())
                    .map_err(|_| HostFailureCode::GuestError)?;
                Ok(InvocationOutcome::InvokeCommand(binding_result(result)?))
            }
            InvocationRequest::HandleEvent(payload) => {
                let (_, argument) = payload.into_parts();
                let result = guest
                    .call_handle_event(&mut self.store, &context, &argument.into())
                    .map_err(|_| HostFailureCode::GuestError)?;
                Ok(InvocationOutcome::HandleEvent(binding_result(result)?))
            }
            InvocationRequest::RenderSurface(payload) => {
                let (_, argument) = payload.into_parts();
                let result = guest
                    .call_render_surface(&mut self.store, &context, &argument.into())
                    .map_err(|_| HostFailureCode::GuestError)?;
                Ok(InvocationOutcome::RenderSurface(binding_result(result)?))
            }
            InvocationRequest::HandleSurfaceAction(payload) => {
                let (_, argument) = payload.into_parts();
                let result = guest
                    .call_handle_surface_action(&mut self.store, &context, &argument.into())
                    .map_err(|_| HostFailureCode::GuestError)?;
                Ok(InvocationOutcome::HandleSurfaceAction(binding_result(
                    result,
                )?))
            }
            InvocationRequest::ValidateSettings(payload) => {
                let (_, argument) = payload.into_parts();
                let result = guest
                    .call_validate_settings(&mut self.store, &context, &argument.into())
                    .map_err(|_| HostFailureCode::GuestError)?;
                Ok(InvocationOutcome::ValidateSettings(binding_result_vec(
                    result,
                )?))
            }
            InvocationRequest::Resync(payload) => {
                let (_, argument) = payload.into_parts();
                let result = guest
                    .call_resync(&mut self.store, &context, &argument.into())
                    .map_err(|_| HostFailureCode::GuestError)?;
                Ok(InvocationOutcome::Resync(binding_result(result)?))
            }
            InvocationRequest::CallService(payload) => {
                let (_, argument) = payload.into_parts();
                let result = guest
                    .call_call_service(&mut self.store, &context, &argument.into())
                    .map_err(|_| HostFailureCode::GuestError)?;
                Ok(InvocationOutcome::CallService(binding_result(result)?))
            }
        }
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
