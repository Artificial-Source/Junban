//! Pure parent-side plugin callback and effect authority.
//!
//! This module deliberately does not own the plugin process or server lifecycle.
//! Packet B composes these typed actions with the runtime actor; Packet C owns the
//! product lifecycle. All guest bodies cross this boundary through the SDK's
//! canonical codecs.

use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    pin::Pin,
    sync::Arc,
    time::Instant,
};

use jiff::{Timestamp, civil::Date};
use junban_app::{
    AdvancePluginCursorRequest, AppError, AuthorizedCommitPluginInvocationRequest,
    AuthorizedTransitionPluginInvocationRequest, CommitPluginInvocationRequest, InstalledPlugin,
    InstalledPluginProfile, PluginDeliveryMode, PluginDomainEffect, PluginInvocationDelivery,
    PluginInvocationState, PluginKvEntry, PluginKvPatch, PluginManifestEntry,
    PluginManifestEntrySelector, PluginSetting, RepositoryError, TemporalContext,
    TransitionPluginInvocationRequest, plugin_manifest_entry_authority,
};
use junban_domain::{
    ActualMinutes, DreadLevel, EntityName, EstimatedMinutes, HexColor, IconText, LocalDueTime,
    MarkdownText, MonthlyAnchorDay, OperationId, Priority, ProjectId, ProjectView, RecurrenceRule,
    SectionId, SortOrder, TagId, TagName, TaskDraft, TaskId, TaskTitle,
};
use junban_plugin_sdk::{
    CallbackFence, Capability, ChildFrame, HostCallKind, HostCallReply, HostCallRequest, HttpScope,
    InvocationKind, InvocationMode, InvocationOutcome, Permission, PermissionScope, PluginId,
    RuntimeManifest, Sha256Digest, SurfaceKind, canonical_permission_hash,
    decode_host_call_request, decode_invocation_outcome, decode_invocation_request,
    private_body_types as wit, validate_child_body, validate_host_call_authority,
};
use sha2::{Digest as _, Sha256};
use uuid::Uuid;

use crate::{
    diagnostics::redact_secrets,
    plugin_http::{DispatchingHttpPermit, PluginHttpTransport},
    sse::AppService,
};

pub const PLUGIN_KV_GET_KEYS_MAX: usize = 64;
pub const PLUGIN_KV_GET_REPLY_BYTES_MAX: usize = 64 * 1024;
pub const PLUGIN_KV_LIST_LIMIT_MAX: u8 = 64;
pub const PLUGIN_KV_LIST_REPLY_BYTES_MAX: usize = 256 * 1024;
pub const PLUGIN_KV_PATCH_OPERATIONS_MAX: usize = 64;
pub const PLUGIN_KV_PATCH_VALUE_BYTES_MAX: usize = 64 * 1024;
pub const PLUGIN_SETTINGS_MAX: usize = 64;
pub const PLUGIN_SETTINGS_BYTES_MAX: usize = 64 * 1024;
pub const PLUGIN_SERVICE_DATA_BYTES_MAX: usize = 64 * 1024;
pub const PLUGIN_LOG_INVOCATION_BYTES_MAX: usize =
    junban_plugin_sdk::GUEST_LOG_INVOCATION_BYTES_MAX as usize;
pub const PLUGIN_SERVICE_DEPTH_MAX: u8 = 8;

const PLUGIN_SERVICE_LIST_ELEMENTS_MAX: usize = 100;
const PLUGIN_SERVICE_STRING_BYTES_MAX: usize = 8 * 1024;

const EFFECT_ID_DOMAIN: &[u8] = b"junban.plugin.effect.v1\0";
const KV_CURSOR_DOMAIN: &[u8] = b"junban.plugin.invocation-kv-cursor.v1\0";

pub type PluginCallbackFuture<T> =
    Pin<Box<dyn Future<Output = Result<T, PluginCallbackError>> + Send + 'static>>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PluginCallbackError {
    InvalidBody,
    InvalidInput,
    PermissionDenied,
    StaleAuthority,
    CursorStale,
    Unavailable,
    OperationTooLarge,
}

impl PluginCallbackError {
    pub(crate) fn host(self) -> wit::HostError {
        let (code, message) = match self {
            Self::InvalidBody | Self::InvalidInput => (
                wit::ErrorCode::InvalidInput,
                "plugin callback input is invalid",
            ),
            Self::OperationTooLarge => (
                wit::ErrorCode::Internal,
                "plugin callback operation is too large",
            ),
            Self::PermissionDenied => (
                wit::ErrorCode::PermissionDenied,
                "plugin callback is not permitted",
            ),
            Self::StaleAuthority | Self::CursorStale => (
                wit::ErrorCode::CursorStale,
                "plugin callback authority is stale",
            ),
            Self::Unavailable => (
                wit::ErrorCode::Unavailable,
                "plugin callback is unavailable",
            ),
        };
        wit::HostError {
            code,
            field: None,
            message: message.to_owned(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginLiveAuthority {
    pub plugin: InstalledPlugin,
    pub grants: Vec<Permission>,
    pub profile: InstalledPluginProfile,
}

pub trait PluginCallbackPort: Send + Sync + 'static {
    fn authority(&self, plugin_id: PluginId) -> PluginCallbackFuture<PluginLiveAuthority>;
    fn query_tasks(&self, request: wit::TaskQuery) -> PluginCallbackFuture<wit::TaskPage>;
    fn query_projects(&self, request: wit::CatalogQuery) -> PluginCallbackFuture<wit::ProjectPage>;
    fn query_tags(&self, request: wit::CatalogQuery) -> PluginCallbackFuture<wit::TagPage>;
    fn settings(&self, plugin_id: PluginId) -> PluginCallbackFuture<Vec<PluginSetting>>;
    fn kv(&self, plugin_id: PluginId) -> PluginCallbackFuture<Vec<PluginKvEntry>>;
    fn transition_invocation(
        &self,
        request: AuthorizedTransitionPluginInvocationRequest,
    ) -> PluginCallbackFuture<()>;
}

impl PluginCallbackPort for AppService {
    fn authority(&self, plugin_id: PluginId) -> PluginCallbackFuture<PluginLiveAuthority> {
        let service = self.clone();
        Box::pin(async move {
            let profile = service
                .get_installed_plugin_profile()
                .await
                .map_err(map_app_error)?;
            let plugin = profile
                .plugins
                .iter()
                .find(|plugin| plugin.plugin_id == plugin_id)
                .cloned()
                .ok_or(PluginCallbackError::StaleAuthority)?;
            let grants = service
                .list_plugin_grants(plugin_id)
                .await
                .map_err(map_app_error)?
                .into_iter()
                .map(|grant| grant.permission)
                .collect();
            Ok(PluginLiveAuthority {
                plugin,
                grants,
                profile,
            })
        })
    }

    fn query_tasks(&self, request: wit::TaskQuery) -> PluginCallbackFuture<wit::TaskPage> {
        let service = self.clone();
        Box::pin(async move {
            service
                .query_plugin_tasks(request)
                .await
                .map_err(map_query_error)
        })
    }

    fn query_projects(&self, request: wit::CatalogQuery) -> PluginCallbackFuture<wit::ProjectPage> {
        let service = self.clone();
        Box::pin(async move {
            service
                .query_plugin_projects(request)
                .await
                .map_err(map_query_error)
        })
    }

    fn query_tags(&self, request: wit::CatalogQuery) -> PluginCallbackFuture<wit::TagPage> {
        let service = self.clone();
        Box::pin(async move {
            service
                .query_plugin_tags(request)
                .await
                .map_err(map_query_error)
        })
    }

    fn settings(&self, plugin_id: PluginId) -> PluginCallbackFuture<Vec<PluginSetting>> {
        let service = self.clone();
        Box::pin(async move {
            service
                .list_plugin_settings(plugin_id)
                .await
                .map_err(map_app_error)
        })
    }

    fn kv(&self, plugin_id: PluginId) -> PluginCallbackFuture<Vec<PluginKvEntry>> {
        let service = self.clone();
        Box::pin(async move {
            service
                .list_plugin_kv(plugin_id)
                .await
                .map_err(map_app_error)
        })
    }

    fn transition_invocation(
        &self,
        request: AuthorizedTransitionPluginInvocationRequest,
    ) -> PluginCallbackFuture<()> {
        let service = self.clone();
        Box::pin(async move {
            service
                .transition_authorized_plugin_invocation(request, Timestamp::now())
                .await
                .map_err(map_app_error)?;
            Ok(())
        })
    }
}

pub trait PluginCallbackHttp: Send + Sync + 'static {
    fn send(
        &self,
        grant: HttpScope,
        request: wit::HttpRequest,
        delivery_id: String,
    ) -> Pin<Box<dyn Future<Output = Result<wit::HttpResponse, wit::HttpError>> + Send + 'static>>;
}

impl PluginCallbackHttp for PluginHttpTransport {
    fn send(
        &self,
        grant: HttpScope,
        request: wit::HttpRequest,
        delivery_id: String,
    ) -> Pin<Box<dyn Future<Output = Result<wit::HttpResponse, wit::HttpError>> + Send + 'static>>
    {
        Box::pin(async move {
            let mut permit = DispatchingHttpPermit::after_durable_transition();
            PluginHttpTransport::new()
                .request(&mut permit, &grant, request, &delivery_id)
                .await
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum PluginInvocationAuthority {
    Durable {
        delivery: PluginInvocationDelivery,
        entry: PluginManifestEntry,
        plugin: InstalledPlugin,
        grants: Vec<Permission>,
    },
    Transient(PluginTransientInvocationAuthority),
}

/// Server-private authority for exports that intentionally have no durable
/// invocation row. The runtime actor is the only production constructor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PluginTransientInvocationAuthority {
    plugin: InstalledPlugin,
    host_session_id: OperationId,
    invocation_id: OperationId,
    call: PluginTransientCall,
    grants: Vec<Permission>,
    permission_set_sha256: Sha256Digest,
    request_sha256: Sha256Digest,
    canonical_request_body: Box<[u8]>,
    ancestors: Vec<PluginId>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum PluginTransientCall {
    Activate,
    Deactivate,
    RenderSurface {
        surface_id: PluginId,
    },
    ValidateSettings,
    CallService {
        service_id: PluginId,
        parent_callback: CallbackFence,
    },
}

impl PluginTransientCall {
    const fn kind(&self) -> InvocationKind {
        match self {
            Self::Activate => InvocationKind::Activate,
            Self::Deactivate => InvocationKind::Deactivate,
            Self::RenderSurface { .. } => InvocationKind::RenderSurface,
            Self::ValidateSettings => InvocationKind::ValidateSettings,
            Self::CallService { .. } => InvocationKind::CallService,
        }
    }
}

impl PluginTransientInvocationAuthority {
    pub(crate) fn new(
        plugin: InstalledPlugin,
        host_session_id: OperationId,
        invocation_id: OperationId,
        call: PluginTransientCall,
        grants: Vec<Permission>,
        canonical_request_body: Vec<u8>,
        ancestors: Vec<PluginId>,
    ) -> Result<Self, PluginCallbackError> {
        let permission_set_sha256 = Sha256Digest::parse(
            canonical_permission_hash(&grants).ok_or(PluginCallbackError::StaleAuthority)?,
        )
        .map_err(|_| PluginCallbackError::StaleAuthority)?;
        let authority = Self {
            plugin,
            host_session_id,
            invocation_id,
            call,
            grants,
            permission_set_sha256,
            request_sha256: Sha256Digest::of(&canonical_request_body),
            canonical_request_body: canonical_request_body.into_boxed_slice(),
            ancestors,
        };
        validate_transient_authority(&authority)?;
        Ok(authority)
    }

    pub(crate) fn canonical_request_body(&self) -> &[u8] {
        &self.canonical_request_body
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginCallbackAuthority {
    invocation: PluginInvocationAuthority,
    callback: CallbackFence,
}

impl PluginCallbackAuthority {
    pub(crate) fn durable(
        delivery: PluginInvocationDelivery,
        entry: PluginManifestEntry,
        plugin: InstalledPlugin,
        grants: Vec<Permission>,
        callback: CallbackFence,
    ) -> Self {
        Self {
            invocation: PluginInvocationAuthority::Durable {
                delivery,
                entry,
                plugin,
                grants,
            },
            callback,
        }
    }

    pub(crate) fn transient(
        authority: PluginTransientInvocationAuthority,
        callback: CallbackFence,
    ) -> Self {
        Self {
            invocation: PluginInvocationAuthority::Transient(authority),
            callback,
        }
    }

    fn plugin(&self) -> &InstalledPlugin {
        match &self.invocation {
            PluginInvocationAuthority::Durable { plugin, .. } => plugin,
            PluginInvocationAuthority::Transient(authority) => &authority.plugin,
        }
    }

    fn grants(&self) -> &[Permission] {
        match &self.invocation {
            PluginInvocationAuthority::Durable { grants, .. } => grants,
            PluginInvocationAuthority::Transient(authority) => &authority.grants,
        }
    }

    fn delivery(&self) -> Option<&PluginInvocationDelivery> {
        match &self.invocation {
            PluginInvocationAuthority::Durable { delivery, .. } => Some(delivery),
            PluginInvocationAuthority::Transient(_) => None,
        }
    }

    fn durable_entry(&self) -> Option<&PluginManifestEntry> {
        match &self.invocation {
            PluginInvocationAuthority::Durable { entry, .. } => Some(entry),
            PluginInvocationAuthority::Transient(_) => None,
        }
    }

    fn transient_authority(&self) -> Option<&PluginTransientInvocationAuthority> {
        match &self.invocation {
            PluginInvocationAuthority::Durable { .. } => None,
            PluginInvocationAuthority::Transient(authority) => Some(authority),
        }
    }

    pub(crate) fn kind(&self) -> InvocationKind {
        match &self.invocation {
            PluginInvocationAuthority::Durable { entry, .. } => match durable_hook(entry) {
                junban_app::PluginHookKind::InvokeCommand => InvocationKind::InvokeCommand,
                junban_app::PluginHookKind::HandleEvent => InvocationKind::HandleEvent,
                junban_app::PluginHookKind::HandleSurfaceAction => {
                    InvocationKind::HandleSurfaceAction
                }
                junban_app::PluginHookKind::Resync => InvocationKind::Resync,
            },
            PluginInvocationAuthority::Transient(authority) => authority.call.kind(),
        }
    }

    fn mode(&self) -> InvocationMode {
        self.kind().mode()
    }

    fn ancestors(&self) -> &[PluginId] {
        self.transient_authority()
            .map_or(&[], |authority| authority.ancestors.as_slice())
    }

    fn service_depth(&self) -> u8 {
        u8::try_from(self.ancestors().len()).unwrap_or(u8::MAX)
    }

    pub(crate) fn callback(&self) -> &CallbackFence {
        &self.callback
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginLogRecord {
    pub level: wit::LogLevel,
    pub message: String,
    pub fields: Vec<wit::LogField>,
}

#[derive(Clone)]
struct RetainedHttp {
    process_lost: bool,
    durable_transitioned: bool,
    may_be_ambiguous: bool,
}

pub struct PluginInvocationCallbackState {
    authority: PluginCallbackAuthority,
    wall_now: Timestamp,
    effect_temporal: TemporalContext,
    monotonic_origin: Instant,
    http: Option<RetainedHttp>,
    logs: Vec<PluginLogRecord>,
    log_bytes: usize,
    kv_snapshot: Option<BTreeMap<String, Vec<u8>>>,
    kv_cursors: BTreeMap<String, String>,
    next_kv_cursor: u32,
    next_callback_id: u32,
}

impl PluginInvocationCallbackState {
    pub fn new(authority: PluginCallbackAuthority) -> Result<Self, PluginCallbackError> {
        Self::new_at(
            authority,
            Timestamp::now(),
            TemporalContext::sample_now(),
            Instant::now(),
        )
    }

    pub fn new_at(
        authority: PluginCallbackAuthority,
        wall_now: Timestamp,
        effect_temporal: TemporalContext,
        monotonic_origin: Instant,
    ) -> Result<Self, PluginCallbackError> {
        validate_static_authority(&authority)?;
        let next_callback_id = authority.callback.callback_id;
        Ok(Self {
            authority,
            wall_now,
            effect_temporal,
            monotonic_origin,
            http: None,
            logs: Vec::new(),
            log_bytes: 0,
            kv_snapshot: None,
            kv_cursors: BTreeMap::new(),
            next_kv_cursor: 0,
            next_callback_id,
        })
    }

    #[must_use]
    pub fn authority(&self) -> &PluginCallbackAuthority {
        &self.authority
    }

    pub(crate) fn next_callback_id(&self) -> u32 {
        self.next_callback_id
    }

    #[must_use]
    pub fn http_consumed(&self) -> bool {
        self.http
            .as_ref()
            .is_some_and(|retained| retained.durable_transitioned)
    }

    #[must_use]
    pub(crate) fn http_may_be_ambiguous(&self) -> bool {
        self.http
            .as_ref()
            .is_some_and(|retained| retained.may_be_ambiguous)
    }

    #[must_use]
    pub fn logs(&self) -> &[PluginLogRecord] {
        &self.logs
    }

    pub fn mark_process_lost(&mut self) {
        if let Some(retained) = &mut self.http {
            retained.process_lost = true;
            retained.may_be_ambiguous |= retained.durable_transitioned;
        }
    }

    fn verify_live(&self, live: &PluginLiveAuthority) -> Result<(), PluginCallbackError> {
        let expected = self.authority.plugin();
        let current = &live.plugin;
        if current != expected
            || canonical_grants(&live.grants) != canonical_grants(self.authority.grants())
        {
            return Err(PluginCallbackError::StaleAuthority);
        }
        validate_static_authority(&self.authority)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatedPluginServiceCall {
    pub callback: CallbackFence,
    pub caller_plugin_id: PluginId,
    pub target_plugin_id: PluginId,
    pub target_package_generation: u64,
    pub target_activation_epoch: u64,
    pub service_id: PluginId,
    pub call: wit::ServiceCall,
    pub ancestry: Vec<PluginId>,
    pub service_depth: u8,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EncodedPluginCallbackReply {
    pub reply: HostCallReply,
    pub frame: junban_plugin_sdk::ParentFrame,
    pub canonical_body: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginCallbackDispatch {
    Reply(EncodedPluginCallbackReply),
    CallService(ValidatedPluginServiceCall),
}

enum PendingPluginCallbackDispatch {
    Reply(HostCallReply),
    CallService(Box<ValidatedPluginServiceCall>),
}

pub struct PluginCallbackAdapter {
    port: Arc<dyn PluginCallbackPort>,
    http: Arc<dyn PluginCallbackHttp>,
}

impl PluginCallbackAdapter {
    #[must_use]
    pub fn new(port: Arc<dyn PluginCallbackPort>, http: Arc<dyn PluginCallbackHttp>) -> Self {
        Self { port, http }
    }

    /// Validate one exact child frame/body pair, decode its canonical SDK body,
    /// and route it to exactly one typed path.
    pub async fn dispatch_message(
        &self,
        state: &mut PluginInvocationCallbackState,
        frame: &ChildFrame,
        body: &[u8],
    ) -> Result<PluginCallbackDispatch, PluginCallbackError> {
        let (callback, request) = Self::admit_message(state, frame, body)?;
        self.dispatch(state, callback, request).await
    }

    pub(crate) fn cancel_message(
        &self,
        state: &mut PluginInvocationCallbackState,
        frame: &ChildFrame,
        body: &[u8],
    ) -> Result<PluginCallbackDispatch, PluginCallbackError> {
        let (callback, request) = Self::admit_message(state, frame, body)?;
        let reply = HostCallReply::Cancelled(request.kind());
        let (frame, canonical_body) = Self::encode_reply(callback, reply.clone())?;
        Ok(PluginCallbackDispatch::Reply(EncodedPluginCallbackReply {
            reply,
            frame,
            canonical_body,
        }))
    }

    fn admit_message(
        state: &mut PluginInvocationCallbackState,
        frame: &ChildFrame,
        body: &[u8],
    ) -> Result<(CallbackFence, HostCallRequest), PluginCallbackError> {
        let (callback, kind) = match frame {
            ChildFrame::CapabilityRequest { callback, kind, .. } => (callback, *kind),
            _ => return Err(PluginCallbackError::InvalidBody),
        };
        let expected = &state.authority.callback;
        if callback.plugin_id != expected.plugin_id
            || callback.package_generation != expected.package_generation
            || callback.activation_epoch != expected.activation_epoch
            || callback.host_session_id != expected.host_session_id
            || callback.invocation_id != expected.invocation_id
            || callback.callback_id != state.next_callback_id
        {
            return Err(PluginCallbackError::StaleAuthority);
        }
        validate_child_body(frame, body).map_err(|_| PluginCallbackError::InvalidBody)?;
        let request =
            decode_host_call_request(kind, body).map_err(|_| PluginCallbackError::InvalidBody)?;
        state.next_callback_id = state
            .next_callback_id
            .checked_add(1)
            .ok_or(PluginCallbackError::OperationTooLarge)?;
        Ok((callback.clone(), request))
    }

    async fn dispatch(
        &self,
        state: &mut PluginInvocationCallbackState,
        callback: CallbackFence,
        request: HostCallRequest,
    ) -> Result<PluginCallbackDispatch, PluginCallbackError> {
        let actor_owned_deactivation = state.authority.kind() == InvocationKind::Deactivate;
        let live = if actor_owned_deactivation {
            validate_static_authority(&state.authority)?;
            None
        } else {
            let live = self
                .port
                .authority(state.authority.plugin().plugin_id.clone())
                .await?;
            state.verify_live(&live)?;
            Some(live)
        };
        authorize_request(state, &request)?;

        let dispatch = match request {
            HostCallRequest::QueryTasks(query) => {
                let page = self.port.query_tasks(query).await;
                PendingPluginCallbackDispatch::Reply(HostCallReply::QueryTasks(map_wit(page)))
            }
            HostCallRequest::QueryProjects(query) => {
                let page = self.port.query_projects(query).await;
                PendingPluginCallbackDispatch::Reply(HostCallReply::QueryProjects(map_wit(page)))
            }
            HostCallRequest::QueryTags(query) => {
                let page = self.port.query_tags(query).await;
                PendingPluginCallbackDispatch::Reply(HostCallReply::QueryTags(map_wit(page)))
            }
            HostCallRequest::GetSettings(()) => {
                let settings = self
                    .port
                    .settings(state.authority.plugin().plugin_id.clone())
                    .await
                    .and_then(|values| merge_settings(&state.authority.plugin().manifest, values));
                PendingPluginCallbackDispatch::Reply(HostCallReply::GetSettings(map_wit(settings)))
            }
            HostCallRequest::GetKv(keys) => {
                ensure_kv_snapshot(self.port.as_ref(), state).await?;
                let result = get_kv(state, keys);
                PendingPluginCallbackDispatch::Reply(HostCallReply::GetKv(map_wit(result)))
            }
            HostCallRequest::ListKv(arguments) => {
                ensure_kv_snapshot(self.port.as_ref(), state).await?;
                let result = list_kv(state, arguments);
                PendingPluginCallbackDispatch::Reply(HostCallReply::ListKv(map_wit(result)))
            }
            HostCallRequest::WallNow(()) => PendingPluginCallbackDispatch::Reply(
                HostCallReply::WallNow(state.wall_now.to_string()),
            ),
            HostCallRequest::MonotonicMs(()) => {
                let elapsed = state.monotonic_origin.elapsed().as_millis();
                PendingPluginCallbackDispatch::Reply(HostCallReply::MonotonicMs(
                    u64::try_from(elapsed).unwrap_or(u64::MAX),
                ))
            }
            HostCallRequest::Log(log) => {
                retain_log(state, log)?;
                PendingPluginCallbackDispatch::Reply(HostCallReply::Log(()))
            }
            HostCallRequest::HttpRequest(request) => {
                let reply = self.http(state, request).await;
                PendingPluginCallbackDispatch::Reply(HostCallReply::HttpRequest(reply))
            }
            HostCallRequest::CallService(call) => {
                PendingPluginCallbackDispatch::CallService(Box::new(validate_service_call(
                    state,
                    callback.clone(),
                    &live
                        .as_ref()
                        .ok_or(PluginCallbackError::StaleAuthority)?
                        .profile,
                    call,
                )?))
            }
        };

        let current = if actor_owned_deactivation {
            validate_static_authority(&state.authority)?;
            None
        } else {
            let current = self
                .port
                .authority(state.authority.plugin().plugin_id.clone())
                .await?;
            state.verify_live(&current)?;
            Some(current)
        };
        if let PendingPluginCallbackDispatch::CallService(action) = &dispatch {
            let current_action = validate_service_call(
                state,
                action.callback.clone(),
                &current
                    .as_ref()
                    .ok_or(PluginCallbackError::StaleAuthority)?
                    .profile,
                action.call.clone(),
            )?;
            if current_action != **action {
                return Err(PluginCallbackError::StaleAuthority);
            }
        }
        match dispatch {
            PendingPluginCallbackDispatch::Reply(reply) => {
                let (frame, canonical_body) = Self::encode_reply(callback, reply.clone())?;
                if matches!(&reply, HostCallReply::GetSettings(wit::WitResult::Ok(_)))
                    && canonical_body.len() > PLUGIN_SETTINGS_BYTES_MAX
                {
                    return Err(PluginCallbackError::OperationTooLarge);
                }
                Ok(PluginCallbackDispatch::Reply(EncodedPluginCallbackReply {
                    reply,
                    frame,
                    canonical_body,
                }))
            }
            PendingPluginCallbackDispatch::CallService(call) => {
                Ok(PluginCallbackDispatch::CallService(*call))
            }
        }
    }

    async fn http(
        &self,
        state: &mut PluginInvocationCallbackState,
        request: wit::HttpRequest,
    ) -> wit::WitResult<wit::HttpResponse, wit::HttpError> {
        if state.http.is_some() {
            return wit::WitResult::Err(http_denied("plugin HTTP callback was already consumed"));
        }
        let Some(delivery) = state.authority.delivery().cloned() else {
            return wit::WitResult::Err(http_denied("plugin HTTP requires durable authority"));
        };
        let Some(scope) = http_scope(state.authority.grants()).cloned() else {
            return wit::WitResult::Err(http_denied("plugin HTTP scope is unavailable"));
        };

        state.http = Some(RetainedHttp {
            process_lost: false,
            durable_transitioned: false,
            may_be_ambiguous: false,
        });
        let delivery_id = derive_delivery_id(&delivery);
        if self
            .port
            .transition_invocation(http_transition(
                &delivery,
                PluginInvocationState::Reserved,
                PluginInvocationState::DispatchingHttp,
            ))
            .await
            .is_err()
        {
            return wit::WitResult::Err(http_denied("plugin HTTP durable transition failed"));
        }
        state
            .http
            .as_mut()
            .expect("HTTP callback retains consume-once state")
            .durable_transitioned = true;
        let authority_current = self
            .port
            .authority(state.authority.plugin().plugin_id.clone())
            .await
            .and_then(|live| state.verify_live(&live));
        if authority_current.is_err() {
            return wit::WitResult::Err(http_denied(
                "plugin HTTP authority changed before dispatch",
            ));
        }

        // Clones go to the first transport attempt so these original values stay
        // immutable for the one host-owned resend while this callback is pending.
        let first_error = match self
            .http
            .send(scope.clone(), request.clone(), delivery_id.clone())
            .await
        {
            Ok(response) => return wit::WitResult::Ok(response),
            Err(error) => error,
        };
        if first_error.delivery != wit::DeliveryState::MayHaveBeenSent {
            return wit::WitResult::Err(first_error);
        }
        state
            .http
            .as_mut()
            .expect("HTTP callback retains consume-once state")
            .may_be_ambiguous = true;
        if self
            .port
            .transition_invocation(http_transition(
                &delivery,
                PluginInvocationState::DispatchingHttp,
                PluginInvocationState::AmbiguousHttp,
            ))
            .await
            .is_err()
            || state
                .http
                .as_ref()
                .is_some_and(|retained| retained.process_lost)
        {
            return wit::WitResult::Err(first_error);
        }

        let authority_current = self
            .port
            .authority(state.authority.plugin().plugin_id.clone())
            .await
            .and_then(|live| state.verify_live(&live));
        if authority_current.is_err()
            || self
                .port
                .transition_invocation(http_transition(
                    &delivery,
                    PluginInvocationState::AmbiguousHttp,
                    PluginInvocationState::DispatchingHttp,
                ))
                .await
                .is_err()
        {
            return wit::WitResult::Err(first_error);
        }
        state
            .http
            .as_mut()
            .expect("HTTP callback retains consume-once state")
            .may_be_ambiguous = false;
        match self.http.send(scope, request, delivery_id).await {
            Ok(response) => wit::WitResult::Ok(response),
            Err(error) => {
                // A not-sent retry cannot erase the first attempt's ambiguity.
                let retained_error = if error.delivery == wit::DeliveryState::NotSent {
                    first_error
                } else {
                    error
                };
                if retained_error.delivery == wit::DeliveryState::MayHaveBeenSent {
                    state
                        .http
                        .as_mut()
                        .expect("HTTP callback retains consume-once state")
                        .may_be_ambiguous = true;
                    let _ = self
                        .port
                        .transition_invocation(http_transition(
                            &delivery,
                            PluginInvocationState::DispatchingHttp,
                            PluginInvocationState::AmbiguousHttp,
                        ))
                        .await;
                }
                wit::WitResult::Err(retained_error)
            }
        }
    }

    /// Encode a reply only through the SDK's canonical reply constructor.
    pub fn encode_reply(
        callback: CallbackFence,
        reply: HostCallReply,
    ) -> Result<(junban_plugin_sdk::ParentFrame, Vec<u8>), PluginCallbackError> {
        reply
            .into_parent_message(callback)
            .map(junban_plugin_sdk::TypedParentMessage::into_parts)
            .map_err(|_| PluginCallbackError::OperationTooLarge)
    }
}

fn durable_hook(entry: &PluginManifestEntry) -> junban_app::PluginHookKind {
    match entry {
        PluginManifestEntry::Command { .. } => junban_app::PluginHookKind::InvokeCommand,
        PluginManifestEntry::Event { .. } => junban_app::PluginHookKind::HandleEvent,
        PluginManifestEntry::SurfaceAction { .. } => {
            junban_app::PluginHookKind::HandleSurfaceAction
        }
        PluginManifestEntry::Resync => junban_app::PluginHookKind::Resync,
    }
}

fn validate_static_authority(
    authority: &PluginCallbackAuthority,
) -> Result<(), PluginCallbackError> {
    let callback = &authority.callback;
    let plugin = authority.plugin();
    let grants = authority.grants();
    if callback.callback_id != 1
        || callback.plugin_id != plugin.plugin_id.as_str()
        || callback.package_generation != plugin.package_generation
        || callback.activation_epoch != plugin.activation_epoch
        || callback.validate().is_err()
    {
        return Err(PluginCallbackError::StaleAuthority);
    }

    match &authority.invocation {
        PluginInvocationAuthority::Durable {
            delivery, entry, ..
        } => {
            let durable = &delivery.authority;
            let hook = durable_hook(entry);
            let delivery_mode_matches = match durable.mode {
                PluginDeliveryMode::StartingResync => hook == junban_app::PluginHookKind::Resync,
                PluginDeliveryMode::StartingCatchUp => {
                    hook == junban_app::PluginHookKind::HandleEvent
                }
                PluginDeliveryMode::Active => hook != junban_app::PluginHookKind::Resync,
            };
            if !delivery_mode_matches
                || callback.host_session_id != durable.host_session_id.to_string()
                || callback.invocation_id != durable.invocation_id.to_string()
                || callback.plugin_id != durable.plugin_id.as_str()
                || durable.package_generation != plugin.package_generation
                || durable.activation_epoch != plugin.activation_epoch
            {
                return Err(PluginCallbackError::StaleAuthority);
            }
            let manifest_entry = plugin_manifest_entry_authority(
                &plugin.manifest,
                hook,
                PluginManifestEntrySelector::Requested(entry),
            )
            .ok_or(PluginCallbackError::StaleAuthority)?;
            if manifest_entry.persisted_id != delivery.persisted_entry_id {
                return Err(PluginCallbackError::StaleAuthority);
            }
        }
        PluginInvocationAuthority::Transient(transient) => {
            validate_transient_authority(transient)?;
            if callback.host_session_id != transient.host_session_id.to_string()
                || callback.invocation_id != transient.invocation_id.to_string()
            {
                return Err(PluginCallbackError::StaleAuthority);
            }
        }
    }

    let granted: BTreeSet<_> = grants.iter().map(|grant| grant.capability).collect();
    let reported: BTreeSet<_> = plugin.granted_capabilities.iter().copied().collect();
    if granted != reported
        || granted.len() != grants.len()
        || reported.len() != plugin.granted_capabilities.len()
        || canonical_permission_hash(grants).is_none()
    {
        return Err(PluginCallbackError::StaleAuthority);
    }
    Ok(())
}

fn validate_transient_authority(
    authority: &PluginTransientInvocationAuthority,
) -> Result<(), PluginCallbackError> {
    let kind = authority.call.kind();
    let request = decode_invocation_request(kind, &authority.canonical_request_body)
        .map_err(|_| PluginCallbackError::InvalidBody)?;
    let expected_permission_hash = Sha256Digest::parse(
        canonical_permission_hash(&authority.grants).ok_or(PluginCallbackError::StaleAuthority)?,
    )
    .map_err(|_| PluginCallbackError::StaleAuthority)?;
    let unique_ancestors =
        authority.ancestors.iter().collect::<BTreeSet<_>>().len() == authority.ancestors.len();
    if authority.request_sha256 != Sha256Digest::of(&authority.canonical_request_body)
        || authority.permission_set_sha256 != expected_permission_hash
        || authority.host_session_id == authority.invocation_id
        || !unique_ancestors
        || authority.ancestors.contains(&authority.plugin.plugin_id)
        || authority.ancestors.len() > usize::from(PLUGIN_SERVICE_DEPTH_MAX)
    {
        return Err(PluginCallbackError::StaleAuthority);
    }

    let plugin = &authority.plugin;
    let admitted = plugin.desired_enabled && plugin.dependencies_satisfied;
    let matches = match (&authority.call, request) {
        (
            PluginTransientCall::Activate,
            junban_plugin_sdk::InvocationRequest::Activate(payload),
        ) => {
            admitted
                && plugin.runtime_state == junban_app::PluginRuntimeState::Starting
                && payload.entry_id().is_none()
                && authority.ancestors.is_empty()
        }
        (
            PluginTransientCall::Deactivate,
            junban_plugin_sdk::InvocationRequest::Deactivate(payload),
        ) => {
            admitted
                && matches!(
                    plugin.runtime_state,
                    junban_app::PluginRuntimeState::Starting
                        | junban_app::PluginRuntimeState::Active
                )
                && payload.entry_id().is_none()
                && authority.ancestors.is_empty()
        }
        (
            PluginTransientCall::RenderSurface { surface_id },
            junban_plugin_sdk::InvocationRequest::RenderSurface(payload),
        ) => {
            let required = plugin
                .manifest
                .surfaces
                .iter()
                .find(|surface| surface.id == surface_id.as_str())
                .map(|surface| match surface.kind {
                    SurfaceKind::View => Capability::UiView,
                    SurfaceKind::Panel => Capability::UiPanel,
                    SurfaceKind::Status => Capability::UiStatus,
                });
            admitted
                && plugin.runtime_state == junban_app::PluginRuntimeState::Active
                && payload.entry_id() == Some(surface_id.as_str())
                && payload.argument().surface_id == surface_id.as_str()
                && required.is_some_and(|required| has_grant(&authority.grants, required))
                && authority.ancestors.is_empty()
        }
        (
            PluginTransientCall::ValidateSettings,
            junban_plugin_sdk::InvocationRequest::ValidateSettings(payload),
        ) => {
            admitted
                && plugin.runtime_state == junban_app::PluginRuntimeState::Active
                && payload.entry_id().is_none()
                && has_grant(&authority.grants, Capability::Settings)
                && valid_candidate_settings(&plugin.manifest, &payload.argument().values)
                && authority.ancestors.is_empty()
        }
        (
            PluginTransientCall::CallService {
                service_id,
                parent_callback,
            },
            junban_plugin_sdk::InvocationRequest::CallService(payload),
        ) => {
            let declaration = plugin
                .manifest
                .services
                .iter()
                .find(|service| service.id == service_id.as_str());
            admitted
                && plugin.runtime_state == junban_app::PluginRuntimeState::Active
                && payload.entry_id() == Some(service_id.as_str())
                && payload.argument().plugin_id == plugin.plugin_id.as_str()
                && payload.argument().service_id == service_id.as_str()
                && declaration.is_some_and(|declaration| {
                    validate_named_values(&payload.argument().values, &declaration.request).is_ok()
                })
                && has_grant(&authority.grants, Capability::ServicesProvide)
                && !authority.ancestors.is_empty()
                && parent_callback.validate().is_ok()
        }
        _ => false,
    };
    if matches {
        Ok(())
    } else {
        Err(PluginCallbackError::StaleAuthority)
    }
}

fn valid_candidate_settings(manifest: &RuntimeManifest, values: &[wit::NamedSetting]) -> bool {
    if values.len() != manifest.settings.len()
        || values.windows(2).any(|pair| pair[0].id >= pair[1].id)
    {
        return false;
    }
    values.iter().all(|candidate| {
        let Some(declaration) = manifest
            .settings
            .iter()
            .find(|declaration| declaration.id == candidate.id)
        else {
            return false;
        };
        use junban_plugin_sdk::SettingSchema as S;
        match (&declaration.schema, &candidate.value) {
            (
                S::Text {
                    min_bytes,
                    max_bytes,
                    ..
                },
                wit::SettingValue::Text(value),
            ) => value.len() >= usize::from(*min_bytes) && value.len() <= usize::from(*max_bytes),
            (S::Integer { min, max, step, .. }, wit::SettingValue::Integer(value)) => {
                *step > 0
                    && value >= min
                    && value <= max
                    && (i128::from(*value) - i128::from(*min)) % i128::from(*step) == 0
            }
            (S::Boolean { .. }, wit::SettingValue::Boolean(_)) => true,
            (S::Select { options, .. }, wit::SettingValue::OptionId(value)) => {
                options.iter().any(|option| option.id == *value)
            }
            _ => false,
        }
    })
}

fn authorize_request(
    state: &PluginInvocationCallbackState,
    request: &HostCallRequest,
) -> Result<(), PluginCallbackError> {
    let kind = request.kind();
    validate_host_call_authority(kind, state.authority.mode(), state.authority.grants())
        .map_err(|_| PluginCallbackError::PermissionDenied)?;
    if kind == HostCallKind::HttpRequest
        && !state
            .authority
            .delivery()
            .is_some_and(|delivery| delivery.authority.mode == PluginDeliveryMode::Active)
    {
        return Err(PluginCallbackError::PermissionDenied);
    }
    Ok(())
}

fn has_grant(grants: &[Permission], capability: Capability) -> bool {
    grants.iter().any(|grant| grant.capability == capability)
}

fn http_scope(grants: &[Permission]) -> Option<&HttpScope> {
    grants.iter().find_map(|grant| {
        if grant.capability == Capability::Http {
            match &grant.scope {
                PermissionScope::Http(scope) => Some(scope),
                _ => None,
            }
        } else {
            None
        }
    })
}

fn canonical_grants(grants: &[Permission]) -> Vec<Permission> {
    let mut grants = grants.to_vec();
    grants.sort_by_key(|grant| grant.capability);
    grants
}

async fn ensure_kv_snapshot(
    port: &dyn PluginCallbackPort,
    state: &mut PluginInvocationCallbackState,
) -> Result<(), PluginCallbackError> {
    if state.kv_snapshot.is_some() {
        return Ok(());
    }
    let entries = port.kv(state.authority.plugin().plugin_id.clone()).await?;
    let mut map = BTreeMap::new();
    let mut bytes = 0_usize;
    for entry in entries {
        if !valid_kv_key(&entry.key)
            || entry.value.len() > junban_app::PLUGIN_KV_VALUE_BYTES_MAX
            || map.insert(entry.key, entry.value.clone()).is_some()
        {
            return Err(PluginCallbackError::StaleAuthority);
        }
        bytes = bytes
            .checked_add(entry.value.len())
            .ok_or(PluginCallbackError::OperationTooLarge)?;
    }
    if map.len() > junban_app::PLUGIN_KV_KEYS_MAX || bytes > junban_app::PLUGIN_KV_BYTES_MAX {
        return Err(PluginCallbackError::OperationTooLarge);
    }
    state.kv_snapshot = Some(map);
    Ok(())
}

fn get_kv(
    state: &PluginInvocationCallbackState,
    keys: Vec<String>,
) -> Result<Vec<wit::KvEntry>, PluginCallbackError> {
    if keys.len() > PLUGIN_KV_GET_KEYS_MAX
        || keys.iter().any(|key| !valid_kv_key(key))
        || keys.iter().collect::<BTreeSet<_>>().len() != keys.len()
    {
        return Err(PluginCallbackError::InvalidInput);
    }
    let snapshot = state
        .kv_snapshot
        .as_ref()
        .ok_or(PluginCallbackError::Unavailable)?;
    let mut bytes = 0_usize;
    let mut entries = Vec::new();
    for key in keys {
        if let Some(value) = snapshot.get(&key) {
            bytes = bytes
                .checked_add(value.len())
                .ok_or(PluginCallbackError::OperationTooLarge)?;
            if bytes > PLUGIN_KV_GET_REPLY_BYTES_MAX {
                return Err(PluginCallbackError::OperationTooLarge);
            }
            entries.push(wit::KvEntry {
                key,
                value: wit::ByteList::new(value.clone())
                    .map_err(|_| PluginCallbackError::OperationTooLarge)?,
            });
        }
    }
    Ok(entries)
}

fn list_kv(
    state: &mut PluginInvocationCallbackState,
    arguments: wit::HostStorageListKvArguments,
) -> Result<wit::KvPage, PluginCallbackError> {
    if arguments.limit == 0 || arguments.limit > PLUGIN_KV_LIST_LIMIT_MAX {
        return Err(PluginCallbackError::InvalidInput);
    }
    let after = match arguments.cursor {
        Some(cursor) => state
            .kv_cursors
            .get(&cursor)
            .cloned()
            .ok_or(PluginCallbackError::InvalidInput)?,
        None => String::new(),
    };
    let snapshot = state
        .kv_snapshot
        .as_ref()
        .ok_or(PluginCallbackError::Unavailable)?;
    let mut entries = Vec::new();
    let mut bytes = 0_usize;
    let limit = usize::from(arguments.limit);
    for (key, value) in
        snapshot.range((std::ops::Bound::Excluded(after), std::ops::Bound::Unbounded))
    {
        if entries.len() == limit {
            break;
        }
        bytes = bytes
            .checked_add(key.len())
            .and_then(|count| count.checked_add(value.len()))
            .ok_or(PluginCallbackError::OperationTooLarge)?;
        if bytes > PLUGIN_KV_LIST_REPLY_BYTES_MAX {
            return Err(PluginCallbackError::OperationTooLarge);
        }
        entries.push(wit::KvEntry {
            key: key.clone(),
            value: wit::ByteList::new(value.clone())
                .map_err(|_| PluginCallbackError::OperationTooLarge)?,
        });
    }
    let next_cursor = entries.last().and_then(|last| {
        snapshot
            .range((
                std::ops::Bound::Excluded(last.key.clone()),
                std::ops::Bound::Unbounded,
            ))
            .next()
            .map(|_| last.key.clone())
    });
    let next_cursor = next_cursor
        .map(|last_key| {
            if state.kv_cursors.len() >= junban_app::PLUGIN_KV_KEYS_MAX {
                return Err(PluginCallbackError::OperationTooLarge);
            }
            state.next_kv_cursor = state
                .next_kv_cursor
                .checked_add(1)
                .ok_or(PluginCallbackError::OperationTooLarge)?;
            let cursor = derive_kv_cursor(state, &last_key, state.next_kv_cursor);
            state.kv_cursors.insert(cursor.clone(), last_key);
            Ok(cursor)
        })
        .transpose()?;
    Ok(wit::KvPage {
        entries,
        next_cursor,
    })
}

fn derive_kv_cursor(state: &PluginInvocationCallbackState, last_key: &str, index: u32) -> String {
    let mut material = Vec::new();
    material.extend_from_slice(KV_CURSOR_DOMAIN);
    material.extend_from_slice(state.authority.callback.host_session_id.as_bytes());
    material.extend_from_slice(state.authority.callback.invocation_id.as_bytes());
    material.extend_from_slice(&index.to_be_bytes());
    material.extend_from_slice(last_key.as_bytes());
    Sha256Digest::of(&material).into_string()
}

fn merge_settings(
    manifest: &RuntimeManifest,
    persisted: Vec<PluginSetting>,
) -> Result<Vec<wit::NamedSetting>, PluginCallbackError> {
    let mut persisted_values = BTreeMap::new();
    for setting in persisted {
        if persisted_values
            .insert(setting.key.to_string(), setting.value)
            .is_some()
        {
            return Err(PluginCallbackError::StaleAuthority);
        }
    }
    let persisted = persisted_values;
    if manifest.settings.len() > PLUGIN_SETTINGS_MAX
        || persisted.len() > manifest.settings.len()
        || persisted
            .keys()
            .any(|key| !manifest.settings.iter().any(|setting| setting.id == *key))
    {
        return Err(PluginCallbackError::StaleAuthority);
    }
    let values: Vec<_> = manifest
        .settings
        .iter()
        .map(|declaration| {
            let value = match persisted.get(&declaration.id) {
                Some(value) => {
                    manifest
                        .validate_persisted_setting(&declaration.id, value)
                        .map_err(|_| PluginCallbackError::StaleAuthority)?;
                    value.clone()
                }
                None => setting_default(&declaration.schema),
            };
            Ok(wit::NamedSetting {
                id: declaration.id.clone(),
                value: setting_value(value, &declaration.schema),
            })
        })
        .collect::<Result<_, PluginCallbackError>>()?;
    let bytes = values
        .iter()
        .try_fold(0_usize, |total, setting: &wit::NamedSetting| {
            total
                .checked_add(setting.id.len())
                .and_then(|total| total.checked_add(setting_value_bytes(&setting.value)))
                .ok_or(PluginCallbackError::OperationTooLarge)
        })?;
    if bytes > PLUGIN_SETTINGS_BYTES_MAX {
        return Err(PluginCallbackError::OperationTooLarge);
    }
    Ok(values)
}

fn setting_default(schema: &junban_plugin_sdk::SettingSchema) -> junban_plugin_sdk::SettingValue {
    use junban_plugin_sdk::{SettingSchema as S, SettingValue as V};
    match schema {
        S::Text { default, .. } | S::Select { default, .. } => V::Text(default.clone()),
        S::Integer { default, .. } => V::Integer(*default),
        S::Boolean { default } => V::Boolean(*default),
    }
}

fn setting_value(
    value: junban_plugin_sdk::SettingValue,
    schema: &junban_plugin_sdk::SettingSchema,
) -> wit::SettingValue {
    match (value, schema) {
        (
            junban_plugin_sdk::SettingValue::Text(value),
            junban_plugin_sdk::SettingSchema::Select { .. },
        ) => wit::SettingValue::OptionId(value),
        (junban_plugin_sdk::SettingValue::Text(value), _) => wit::SettingValue::Text(value),
        (junban_plugin_sdk::SettingValue::Integer(value), _) => wit::SettingValue::Integer(value),
        (junban_plugin_sdk::SettingValue::Boolean(value), _) => wit::SettingValue::Boolean(value),
    }
}

fn setting_value_bytes(value: &wit::SettingValue) -> usize {
    match value {
        wit::SettingValue::Text(value) | wit::SettingValue::OptionId(value) => value.len(),
        wit::SettingValue::Integer(_) => size_of::<i64>(),
        wit::SettingValue::Boolean(_) => 1,
    }
}

fn retain_log(
    state: &mut PluginInvocationCallbackState,
    mut log: wit::HostLogLogArguments,
) -> Result<(), PluginCallbackError> {
    if log.message.len() > usize::from(junban_plugin_sdk::GUEST_LOG_MESSAGE_BYTES_MAX)
        || log.fields.len() > usize::from(junban_plugin_sdk::GUEST_LOG_FIELDS_MAX)
        || log
            .fields
            .windows(2)
            .any(|pair| pair[0].name >= pair[1].name)
        || log.fields.iter().any(|field| {
            PluginId::parse(field.name.clone()).is_err() || !valid_scalar_value(&field.value)
        })
    {
        return Err(PluginCallbackError::InvalidInput);
    }
    log.message = redact_secrets(&log.message, "");
    for field in &mut log.fields {
        redact_scalar(&mut field.value);
    }
    let size = serde_json::to_vec(&log)
        .map_err(|_| PluginCallbackError::InvalidInput)?
        .len();
    let projected = state
        .log_bytes
        .checked_add(size)
        .ok_or(PluginCallbackError::OperationTooLarge)?;
    if projected <= PLUGIN_LOG_INVOCATION_BYTES_MAX {
        state.log_bytes = projected;
        state.logs.push(PluginLogRecord {
            level: log.level,
            message: log.message,
            fields: log.fields,
        });
    }
    Ok(())
}

fn valid_scalar_value(value: &wit::ScalarValue) -> bool {
    match value {
        wit::ScalarValue::StringValue(_)
        | wit::ScalarValue::IntegerValue(_)
        | wit::ScalarValue::BooleanValue(_) => true,
        wit::ScalarValue::DateValue(value) => canonical_date(value),
        wit::ScalarValue::TimestampValue(value) => canonical_timestamp(value),
        wit::ScalarValue::TaskId(value) => canonical_typed_id(value, TaskId::parse),
        wit::ScalarValue::ProjectId(value) => canonical_typed_id(value, ProjectId::parse),
        wit::ScalarValue::TagId(value) => canonical_typed_id(value, TagId::parse),
        wit::ScalarValue::PluginId(value) | wit::ScalarValue::OptionId(value) => {
            PluginId::parse(value).is_ok()
        }
    }
}

fn redact_scalar(value: &mut wit::ScalarValue) {
    match value {
        wit::ScalarValue::StringValue(value)
        | wit::ScalarValue::DateValue(value)
        | wit::ScalarValue::TimestampValue(value)
        | wit::ScalarValue::TaskId(value)
        | wit::ScalarValue::ProjectId(value)
        | wit::ScalarValue::TagId(value)
        | wit::ScalarValue::PluginId(value)
        | wit::ScalarValue::OptionId(value) => *value = redact_secrets(value, ""),
        wit::ScalarValue::IntegerValue(_) | wit::ScalarValue::BooleanValue(_) => {}
    }
}

fn validate_service_call(
    state: &PluginInvocationCallbackState,
    callback: CallbackFence,
    profile: &InstalledPluginProfile,
    call: wit::ServiceCall,
) -> Result<ValidatedPluginServiceCall, PluginCallbackError> {
    if state.authority.service_depth() >= PLUGIN_SERVICE_DEPTH_MAX {
        return Err(PluginCallbackError::InvalidInput);
    }
    let caller = state.authority.plugin();
    let target_id =
        PluginId::parse(call.plugin_id.clone()).map_err(|_| PluginCallbackError::Unavailable)?;
    let service_id =
        PluginId::parse(call.service_id.clone()).map_err(|_| PluginCallbackError::Unavailable)?;
    if target_id == caller.plugin_id || state.authority.ancestors().contains(&target_id) {
        return Err(PluginCallbackError::PermissionDenied);
    }
    let dependency = caller
        .manifest
        .dependencies
        .iter()
        .find(|dependency| {
            dependency.id == call.plugin_id && dependency.services.contains(&call.service_id)
        })
        .ok_or(PluginCallbackError::Unavailable)?;
    let allowed = state.authority.grants().iter().any(|grant| {
        grant.capability == Capability::ServicesConsume
            && matches!(&grant.scope, PermissionScope::Services(scope)
                if scope.services.iter().any(|service|
                    service.plugin_id == call.plugin_id && service.service_id == call.service_id))
    });
    if !allowed {
        return Err(PluginCallbackError::PermissionDenied);
    }
    let target = profile
        .plugins
        .iter()
        .find(|plugin| plugin.plugin_id == target_id)
        .ok_or(PluginCallbackError::Unavailable)?;
    if !target.desired_enabled
        || target.runtime_state != junban_app::PluginRuntimeState::Active
        || !target.dependencies_satisfied
        || !target
            .granted_capabilities
            .contains(&Capability::ServicesProvide)
        || !junban_plugin_sdk::version_matches(&dependency.requirement, &target.version)
            .unwrap_or(false)
    {
        return Err(PluginCallbackError::Unavailable);
    }
    let declaration = target
        .manifest
        .services
        .iter()
        .find(|service| service.id == call.service_id)
        .ok_or(PluginCallbackError::Unavailable)?;
    validate_named_values(&call.values, &declaration.request)?;
    let mut ancestry = state.authority.ancestors().to_vec();
    if ancestry.last() != Some(&caller.plugin_id) {
        ancestry.push(caller.plugin_id.clone());
    }
    Ok(ValidatedPluginServiceCall {
        callback,
        caller_plugin_id: caller.plugin_id.clone(),
        target_plugin_id: target.plugin_id.clone(),
        target_package_generation: target.package_generation,
        target_activation_epoch: target.activation_epoch,
        service_id,
        call,
        ancestry,
        service_depth: state.authority.service_depth() + 1,
    })
}

pub fn validate_service_response(
    target: &InstalledPlugin,
    service_id: &PluginId,
    data: &wit::ServiceData,
) -> Result<(), PluginCallbackError> {
    if !target.desired_enabled
        || target.runtime_state != junban_app::PluginRuntimeState::Active
        || !target.dependencies_satisfied
        || !target
            .granted_capabilities
            .contains(&Capability::ServicesProvide)
    {
        return Err(PluginCallbackError::StaleAuthority);
    }
    let declaration = target
        .manifest
        .services
        .iter()
        .find(|service| service.id == service_id.as_str())
        .ok_or(PluginCallbackError::Unavailable)?;
    validate_named_values(&data.values, &declaration.response)
}

fn validate_named_values(
    values: &[wit::NamedValue],
    fields: &[junban_plugin_sdk::ServiceField],
) -> Result<(), PluginCallbackError> {
    if service_data_bytes(values) > PLUGIN_SERVICE_DATA_BYTES_MAX
        || serde_json::to_vec(values)
            .map_err(|_| PluginCallbackError::InvalidInput)?
            .len()
            > PLUGIN_SERVICE_DATA_BYTES_MAX
    {
        return Err(PluginCallbackError::OperationTooLarge);
    }
    if values.windows(2).any(|pair| pair[0].name >= pair[1].name) {
        return Err(PluginCallbackError::InvalidInput);
    }
    for field in fields {
        let value = values.iter().find(|value| value.name == field.id);
        if field.required && value.is_none() {
            return Err(PluginCallbackError::InvalidInput);
        }
        if let Some(value) = value {
            validate_data_value(&value.value, field.kind)?;
        }
    }
    if values
        .iter()
        .any(|value| !fields.iter().any(|field| field.id == value.name))
    {
        return Err(PluginCallbackError::InvalidInput);
    }
    Ok(())
}

fn service_data_bytes(values: &[wit::NamedValue]) -> usize {
    values.iter().fold(0_usize, |total, value| {
        total
            .saturating_add(value.name.len())
            .saturating_add(data_value_bytes(&value.value))
    })
}

fn data_value_bytes(value: &wit::DataValue) -> usize {
    use wit::{DataValue as V, ScalarValue as S};
    match value {
        V::Scalar(value) => match value {
            S::StringValue(value)
            | S::DateValue(value)
            | S::TimestampValue(value)
            | S::TaskId(value)
            | S::ProjectId(value)
            | S::TagId(value)
            | S::PluginId(value)
            | S::OptionId(value) => value.len(),
            S::IntegerValue(_) => size_of::<i64>(),
            S::BooleanValue(_) => 1,
        },
        V::StringList(values)
        | V::DateList(values)
        | V::TimestampList(values)
        | V::TaskIdList(values)
        | V::ProjectIdList(values)
        | V::TagIdList(values)
        | V::PluginIdList(values)
        | V::OptionIdList(values) => values.iter().map(String::len).sum(),
        V::IntegerList(values) => values.len().saturating_mul(size_of::<i64>()),
        V::BooleanList(values) => values.len(),
    }
}

fn validate_data_value(
    value: &wit::DataValue,
    kind: junban_plugin_sdk::DataKind,
) -> Result<(), PluginCallbackError> {
    use junban_plugin_sdk::DataKind as K;
    use wit::{DataValue as V, ScalarValue as S};

    if !service_value_within_element_bounds(value) {
        return Err(PluginCallbackError::OperationTooLarge);
    }
    let valid = match (value, kind) {
        (V::Scalar(S::StringValue(_)), K::String)
        | (V::Scalar(S::IntegerValue(_)), K::Integer)
        | (V::Scalar(S::BooleanValue(_)), K::Boolean)
        | (V::StringList(_), K::StringList)
        | (V::IntegerList(_), K::IntegerList)
        | (V::BooleanList(_), K::BooleanList) => true,
        (V::Scalar(S::DateValue(value)), K::Date) => canonical_date(value),
        (V::Scalar(S::TimestampValue(value)), K::Timestamp) => canonical_timestamp(value),
        (V::Scalar(S::TaskId(value)), K::TaskId) => canonical_typed_id(value, TaskId::parse),
        (V::Scalar(S::ProjectId(value)), K::ProjectId) => {
            canonical_typed_id(value, ProjectId::parse)
        }
        (V::Scalar(S::TagId(value)), K::TagId) => canonical_typed_id(value, TagId::parse),
        (V::Scalar(S::PluginId(value)), K::PluginId)
        | (V::Scalar(S::OptionId(value)), K::OptionId) => PluginId::parse(value).is_ok(),
        (V::DateList(values), K::DateList) => values.iter().all(|value| canonical_date(value)),
        (V::TimestampList(values), K::TimestampList) => {
            values.iter().all(|value| canonical_timestamp(value))
        }
        (V::TaskIdList(values), K::TaskIdList) => values
            .iter()
            .all(|value| canonical_typed_id(value, TaskId::parse)),
        (V::ProjectIdList(values), K::ProjectIdList) => values
            .iter()
            .all(|value| canonical_typed_id(value, ProjectId::parse)),
        (V::TagIdList(values), K::TagIdList) => values
            .iter()
            .all(|value| canonical_typed_id(value, TagId::parse)),
        (V::PluginIdList(values), K::PluginIdList) | (V::OptionIdList(values), K::OptionIdList) => {
            values.iter().all(|value| PluginId::parse(value).is_ok())
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(PluginCallbackError::InvalidInput)
    }
}

fn service_value_within_element_bounds(value: &wit::DataValue) -> bool {
    use wit::{DataValue as V, ScalarValue as S};

    match value {
        V::Scalar(
            S::StringValue(value)
            | S::DateValue(value)
            | S::TimestampValue(value)
            | S::TaskId(value)
            | S::ProjectId(value)
            | S::TagId(value)
            | S::PluginId(value)
            | S::OptionId(value),
        ) => value.len() <= PLUGIN_SERVICE_STRING_BYTES_MAX,
        V::Scalar(S::IntegerValue(_) | S::BooleanValue(_)) => true,
        V::StringList(values)
        | V::DateList(values)
        | V::TimestampList(values)
        | V::TaskIdList(values)
        | V::ProjectIdList(values)
        | V::TagIdList(values)
        | V::PluginIdList(values)
        | V::OptionIdList(values) => {
            values.len() <= PLUGIN_SERVICE_LIST_ELEMENTS_MAX
                && values
                    .iter()
                    .all(|value| value.len() <= PLUGIN_SERVICE_STRING_BYTES_MAX)
        }
        V::IntegerList(values) => values.len() <= PLUGIN_SERVICE_LIST_ELEMENTS_MAX,
        V::BooleanList(values) => values.len() <= PLUGIN_SERVICE_LIST_ELEMENTS_MAX,
    }
}

fn canonical_date(value: &str) -> bool {
    value
        .parse::<Date>()
        .is_ok_and(|parsed| parsed.to_string() == value)
}

fn canonical_timestamp(value: &str) -> bool {
    value
        .parse::<Timestamp>()
        .is_ok_and(|parsed| parsed.to_string() == value)
}

fn canonical_typed_id<T: ToString>(
    value: &str,
    parse: impl Fn(&str) -> Result<T, junban_domain::ValidationError>,
) -> bool {
    parse(value).is_ok_and(|parsed| parsed.to_string() == value)
}

/// Validate an exact guest outcome frame/body and translate one successful
/// effect into the existing authorized atomic commit seam. Packet B adds the
/// exact retained-event cursor before commit.
pub fn adapt_plugin_effect_message(
    state: &PluginInvocationCallbackState,
    frame: &ChildFrame,
    body: &[u8],
    cursor: Option<AdvancePluginCursorRequest>,
) -> Result<AuthorizedCommitPluginInvocationRequest, PluginCallbackError> {
    let expected = junban_plugin_sdk::AuthorityFence {
        plugin_id: state.authority.callback.plugin_id.clone(),
        package_generation: state.authority.callback.package_generation,
        activation_epoch: state.authority.callback.activation_epoch,
        host_session_id: state.authority.callback.host_session_id.clone(),
        invocation_id: state.authority.callback.invocation_id.clone(),
    };
    let kind = state.authority.kind();
    if !matches!(frame, ChildFrame::Outcome { fence, kind: frame_kind, .. }
        if fence == &expected && *frame_kind == kind)
    {
        return Err(PluginCallbackError::StaleAuthority);
    }
    validate_child_body(frame, body).map_err(|_| PluginCallbackError::InvalidBody)?;
    let outcome =
        decode_invocation_outcome(kind, body).map_err(|_| PluginCallbackError::InvalidBody)?;
    adapt_decoded_plugin_effect(state, &outcome, body, cursor)
}

fn adapt_decoded_plugin_effect(
    state: &PluginInvocationCallbackState,
    outcome: &InvocationOutcome,
    canonical_body: &[u8],
    cursor: Option<AdvancePluginCursorRequest>,
) -> Result<AuthorizedCommitPluginInvocationRequest, PluginCallbackError> {
    validate_static_authority(&state.authority)?;
    let delivery = state
        .authority
        .delivery()
        .ok_or(PluginCallbackError::PermissionDenied)?;
    if state.authority.mode() != InvocationMode::Effect {
        return Err(PluginCallbackError::PermissionDenied);
    }
    let effect = match (state.authority.kind(), outcome) {
        (
            InvocationKind::InvokeCommand,
            InvocationOutcome::InvokeCommand(wit::WitResult::Ok(outcome)),
        )
        | (
            InvocationKind::HandleEvent,
            InvocationOutcome::HandleEvent(wit::WitResult::Ok(outcome)),
        )
        | (
            InvocationKind::HandleSurfaceAction,
            InvocationOutcome::HandleSurfaceAction(wit::WitResult::Ok(outcome)),
        ) => outcome.effect.clone(),
        _ => return Err(PluginCallbackError::InvalidInput),
    };
    if effect.is_some()
        && (state.http.is_some() || delivery.authority.mode != PluginDeliveryMode::Active)
    {
        return Err(PluginCallbackError::PermissionDenied);
    }
    let mut request = CommitPluginInvocationRequest {
        invocation_operation_id: delivery.authority.invocation_id,
        plugin_id: delivery.authority.plugin_id.clone(),
        package_generation: delivery.authority.package_generation,
        activation_epoch: delivery.authority.activation_epoch,
        outcome: junban_app::PluginInvocationPublicOutcome::Completed,
        child_operation_id: None,
        domain_effect: None,
        kv_patch: None,
        resync_kv: None,
        cursor,
        resync_session: None,
    };
    if let Some(effect) = effect {
        let child = derive_effect_operation(&state.authority, canonical_body)?;
        match effect {
            wit::PluginEffect::DomainMutation(mutation) => {
                let domain = convert_domain_mutation(mutation, child, &state.effect_temporal)?;
                if !has_grant(state.authority.grants(), domain.required_capability()) {
                    return Err(PluginCallbackError::PermissionDenied);
                }
                request.child_operation_id = Some(child);
                request.domain_effect = Some(domain);
            }
            wit::PluginEffect::KvPatch(patch) => {
                if !has_grant(state.authority.grants(), Capability::Storage) {
                    return Err(PluginCallbackError::PermissionDenied);
                }
                request.kv_patch = Some(convert_kv_patch(patch)?);
            }
        }
    }
    Ok(AuthorizedCommitPluginInvocationRequest {
        request,
        delivery: delivery.clone(),
    })
}

#[cfg(test)]
fn adapt_plugin_effect(
    state: &PluginInvocationCallbackState,
    outcome: &InvocationOutcome,
    cursor: Option<AdvancePluginCursorRequest>,
) -> Result<AuthorizedCommitPluginInvocationRequest, PluginCallbackError> {
    let canonical = canonical_outcome_body(&state.authority, outcome.clone())?;
    adapt_decoded_plugin_effect(state, outcome, &canonical, cursor)
}

#[cfg(test)]
fn canonical_outcome_body(
    authority: &PluginCallbackAuthority,
    outcome: InvocationOutcome,
) -> Result<Vec<u8>, PluginCallbackError> {
    outcome
        .into_child_message(junban_plugin_sdk::AuthorityFence {
            plugin_id: authority.callback.plugin_id.clone(),
            package_generation: authority.callback.package_generation,
            activation_epoch: authority.callback.activation_epoch,
            host_session_id: authority.callback.host_session_id.clone(),
            invocation_id: authority.callback.invocation_id.clone(),
        })
        .map(junban_plugin_sdk::TypedChildMessage::into_parts)
        .map(|(_, body)| body)
        .map_err(|_| PluginCallbackError::OperationTooLarge)
}

fn derive_effect_operation(
    authority: &PluginCallbackAuthority,
    effect: &[u8],
) -> Result<OperationId, PluginCallbackError> {
    let delivery_sha256 = authority
        .delivery()
        .ok_or(PluginCallbackError::PermissionDenied)?
        .authority
        .digest()
        .map_err(|_| PluginCallbackError::StaleAuthority)?;
    let mut material = Vec::new();
    material.extend_from_slice(EFFECT_ID_DOMAIN);
    put_bytes(&mut material, delivery_sha256.as_str().as_bytes());
    put_bytes(&mut material, effect);
    OperationId::parse(&uuid_from_hash(material).to_string())
        .map_err(|_| PluginCallbackError::Unavailable)
}

fn derive_entity_id(operation: OperationId, label: &[u8]) -> String {
    let mut material = Vec::new();
    material.extend_from_slice(EFFECT_ID_DOMAIN);
    material.extend_from_slice(operation.as_uuid().as_bytes());
    put_bytes(&mut material, label);
    uuid_from_hash(material).to_string()
}

fn uuid_from_hash(material: Vec<u8>) -> Uuid {
    let digest = Sha256::digest(material);
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

fn put_bytes(material: &mut Vec<u8>, bytes: &[u8]) {
    material.extend_from_slice(&u32::try_from(bytes.len()).unwrap_or(u32::MAX).to_be_bytes());
    material.extend_from_slice(bytes);
}

fn convert_domain_mutation(
    mutation: wit::DomainMutation,
    operation: OperationId,
    temporal: &TemporalContext,
) -> Result<PluginDomainEffect, PluginCallbackError> {
    use wit::DomainMutation as M;
    Ok(match mutation {
        M::CreateTask(value) => {
            let task_id = TaskId::parse(&derive_entity_id(operation, b"task"))
                .map_err(|_| PluginCallbackError::InvalidInput)?;
            PluginDomainEffect::CreateTask {
                task_id,
                draft: convert_task_draft(value, task_id)?,
            }
        }
        M::PatchTask(value) => PluginDomainEffect::PatchTask {
            task_id: parse_task(&value.task_id)?,
            patch: convert_task_patch(value.patch)?,
        },
        M::CompleteTask(id) => PluginDomainEffect::CompleteTask {
            task_id: parse_task(&id)?,
            temporal: temporal.clone(),
        },
        M::UncompleteTask(id) => PluginDomainEffect::UncompleteTask {
            task_id: parse_task(&id)?,
            temporal: temporal.clone(),
        },
        M::CancelTask(id) => PluginDomainEffect::CancelTask {
            task_id: parse_task(&id)?,
        },
        M::ReopenTask(id) => PluginDomainEffect::ReopenTask {
            task_id: parse_task(&id)?,
        },
        M::DeleteTask(id) => PluginDomainEffect::DeleteTask {
            task_id: parse_task(&id)?,
        },
        M::BulkTasks(value) => {
            if value.task_ids.is_empty() {
                return Err(PluginCallbackError::InvalidInput);
            }
            PluginDomainEffect::BulkTasks {
                task_ids: parse_unique_ids(&value.task_ids, TaskId::parse)?,
                action: convert_bulk_action(value.action)?,
                temporal: temporal.clone(),
            }
        }
        M::CreateProject(draft) => PluginDomainEffect::CreateProject {
            project_id: ProjectId::parse(&derive_entity_id(operation, b"project"))
                .map_err(|_| PluginCallbackError::InvalidInput)?,
            draft: convert_project_draft(draft)?,
        },
        M::PatchProject(value) => PluginDomainEffect::PatchProject {
            project_id: parse_project(&value.project_id)?,
            patch: convert_project_patch(value.patch)?,
        },
        M::DeleteProject(id) => PluginDomainEffect::DeleteProject {
            project_id: parse_project(&id)?,
        },
        M::CreateTag(draft) => PluginDomainEffect::CreateTag {
            tag_id: TagId::parse(&derive_entity_id(operation, b"tag"))
                .map_err(|_| PluginCallbackError::InvalidInput)?,
            draft: convert_tag_draft(draft)?,
        },
        M::PatchTag(value) => PluginDomainEffect::PatchTag {
            tag_id: parse_tag(&value.tag_id)?,
            patch: convert_tag_patch(value.patch)?,
        },
        M::DeleteTag(id) => PluginDomainEffect::DeleteTag {
            tag_id: parse_tag(&id)?,
        },
    })
}

fn convert_task_draft(
    value: wit::TaskDraft,
    task_id: TaskId,
) -> Result<TaskDraft, PluginCallbackError> {
    let draft = TaskDraft {
        title: TaskTitle::new(value.title).map_err(invalid)?,
        description: MarkdownText::new(value.description).map_err(invalid)?,
        priority: value.priority.map(convert_priority).transpose()?,
        due_date: value.due_date.map(parse_date).transpose()?,
        due_time: value.due_time.map(convert_due_time).transpose()?,
        deadline: value.deadline.map(parse_timestamp).transpose()?,
        someday: value.someday,
        estimated_minutes: value
            .estimated_minutes
            .map(|v| EstimatedMinutes::new(v).map_err(invalid))
            .transpose()?,
        actual_minutes: value
            .actual_minutes
            .map(|v| ActualMinutes::new(v).map_err(invalid))
            .transpose()?,
        dread: value
            .dread
            .map(|v| DreadLevel::new(v).map_err(invalid))
            .transpose()?,
        project_id: value.project_id.as_deref().map(parse_project).transpose()?,
        section_id: value.section_id.as_deref().map(parse_section).transpose()?,
        parent_id: value.parent_id.as_deref().map(parse_task).transpose()?,
        tag_ids: parse_unique_ids(&value.tag_ids, TagId::parse)?,
        sort_order: SortOrder::new(value.sort_order),
        recurrence_rule: value
            .recurrence_rule
            .map(|v| RecurrenceRule::new(v).map_err(invalid))
            .transpose()?,
        remind_at: value.remind_at.map(parse_timestamp).transpose()?,
        recurrence_anchor_day: value
            .recurrence_anchor_day
            .map(|v| MonthlyAnchorDay::new(v).map_err(invalid))
            .transpose()?,
    };
    // Reuse the domain entity constructor for cross-field draft validation.
    junban_domain::Task::from_draft(task_id, draft.clone(), Timestamp::constant(0, 0), 1)
        .map_err(invalid)?;
    Ok(draft)
}

fn convert_task_patch(value: wit::TaskPatch) -> Result<junban_app::TaskPatch, PluginCallbackError> {
    Ok(junban_app::TaskPatch {
        title: string_change(value.title, |v| TaskTitle::new(v).map_err(invalid))?,
        description: string_change(value.description, |v| MarkdownText::new(v).map_err(invalid))?,
        priority: optional_change(value.priority, convert_priority)?,
        due_date: optional_change(value.due_date, parse_date)?,
        due_time: optional_change(value.due_time, convert_due_time)?,
        deadline: optional_change(value.deadline, parse_timestamp)?,
        someday: bool_change(value.someday),
        estimated_minutes: optional_change(value.estimated_minutes, |v| {
            EstimatedMinutes::new(v).map_err(invalid)
        })?,
        actual_minutes: optional_change(value.actual_minutes, |v| {
            ActualMinutes::new(v).map_err(invalid)
        })?,
        dread: optional_change(value.dread, |v| DreadLevel::new(v).map_err(invalid))?,
        project_id: optional_change(value.project_id, |v| parse_project(&v))?,
        section_id: optional_change(value.section_id, |v| parse_section(&v))?,
        parent_id: optional_change(value.parent_id, |v| parse_task(&v))?,
        tag_ids: match value.tag_ids {
            wit::IdListChange::Unchanged(()) => None,
            wit::IdListChange::Replace(ids) => Some(parse_unique_ids(&ids, TagId::parse)?),
        },
        sort_order: match value.sort_order {
            wit::S64Change::Unchanged(()) => None,
            wit::S64Change::Set(v) => Some(SortOrder::new(v)),
        },
        recurrence_rule: optional_change(value.recurrence_rule, |v| {
            RecurrenceRule::new(v).map_err(invalid)
        })?,
        remind_at: optional_change(value.remind_at, parse_timestamp)?,
        recurrence_anchor_day: optional_change(value.recurrence_anchor_day, |v| {
            MonthlyAnchorDay::new(v).map_err(invalid)
        })?,
    })
}

fn convert_project_draft(
    value: wit::ProjectDraft,
) -> Result<junban_app::ProjectDraft, PluginCallbackError> {
    Ok(junban_app::ProjectDraft {
        name: EntityName::new(value.name).map_err(invalid)?,
        color: HexColor::new(value.color).map_err(invalid)?,
        icon: value
            .icon
            .map(|v| IconText::new(v).map_err(invalid))
            .transpose()?,
        parent_id: value.parent_id.as_deref().map(parse_project).transpose()?,
        favorite: value.favorite,
        archived: value.archived,
        view: convert_view(value.view),
        sort_order: SortOrder::new(value.sort_order),
    })
}

fn convert_project_patch(
    value: wit::ProjectPatch,
) -> Result<junban_app::ProjectPatch, PluginCallbackError> {
    Ok(junban_app::ProjectPatch {
        name: string_change(value.name, |v| EntityName::new(v).map_err(invalid))?,
        color: string_change(value.color, |v| HexColor::new(v).map_err(invalid))?,
        icon: optional_change(value.icon, |v| IconText::new(v).map_err(invalid))?,
        parent_id: optional_change(value.parent_id, |v| parse_project(&v))?,
        favorite: bool_change(value.favorite),
        archived: bool_change(value.archived),
        view: match value.view {
            wit::ProjectViewChange::Unchanged(()) => None,
            wit::ProjectViewChange::Set(v) => Some(convert_view(v)),
        },
        sort_order: match value.sort_order {
            wit::S64Change::Unchanged(()) => None,
            wit::S64Change::Set(v) => Some(SortOrder::new(v)),
        },
    })
}

fn convert_tag_draft(value: wit::TagDraft) -> Result<junban_app::TagDraft, PluginCallbackError> {
    Ok(junban_app::TagDraft {
        name: TagName::new(value.name).map_err(invalid)?,
        color: HexColor::new(value.color).map_err(invalid)?,
    })
}

fn convert_tag_patch(value: wit::TagPatch) -> Result<junban_app::TagPatch, PluginCallbackError> {
    Ok(junban_app::TagPatch {
        name: string_change(value.name, |v| TagName::new(v).map_err(invalid))?,
        color: string_change(value.color, |v| HexColor::new(v).map_err(invalid))?,
    })
}

fn convert_bulk_action(
    value: wit::BulkAction,
) -> Result<junban_app::BulkAction, PluginCallbackError> {
    use wit::BulkAction as A;
    Ok(match value {
        A::Complete(()) => junban_app::BulkAction::Complete,
        A::Uncomplete(()) => junban_app::BulkAction::Uncomplete,
        A::Cancel(()) => junban_app::BulkAction::Cancel,
        A::Reopen(()) => junban_app::BulkAction::Reopen,
        A::Delete(()) => junban_app::BulkAction::Delete,
        A::Move(value) => junban_app::BulkAction::Move {
            target: junban_app::MoveTarget {
                project_id: optional_change(value.project_id, |v| parse_project(&v))?,
                section_id: optional_change(value.section_id, |v| parse_section(&v))?,
                parent_id: optional_change(value.parent_id, |v| parse_task(&v))?,
                order: junban_app::OrderAnchor::Keep,
            },
        },
        A::Tag(value) => {
            let add = parse_unique_ids(&value.add, TagId::parse)?;
            let remove = parse_unique_ids(&value.remove, TagId::parse)?;
            let removed: BTreeSet<_> = remove.iter().copied().collect();
            if add.iter().any(|tag_id| removed.contains(tag_id)) {
                return Err(PluginCallbackError::InvalidInput);
            }
            junban_app::BulkAction::Tag {
                change: junban_app::BulkTagChange { add, remove },
            }
        }
        A::Schedule(value) => junban_app::BulkAction::Schedule {
            schedule: junban_app::BulkSchedule {
                due_date: optional_change(value.due_date, parse_date)?,
                due_time: optional_change(value.due_time, convert_due_time)?,
                deadline: optional_change(value.deadline, parse_timestamp)?,
                someday: bool_change(value.someday),
            },
        },
        A::Priority(value) => junban_app::BulkAction::Priority {
            priority: match value {
                wit::BulkPriority::Clear(()) => None,
                wit::BulkPriority::Set(v) => Some(convert_priority(v)?),
            },
        },
    })
}

fn convert_kv_patch(value: wit::KvPatch) -> Result<PluginKvPatch, PluginCallbackError> {
    if value.operations.is_empty() {
        return Err(PluginCallbackError::InvalidInput);
    }
    if value.operations.len() > PLUGIN_KV_PATCH_OPERATIONS_MAX {
        return Err(PluginCallbackError::OperationTooLarge);
    }
    let mut set = Vec::new();
    let mut delete = Vec::new();
    let mut prior_key: Option<String> = None;
    let mut value_bytes = 0_usize;
    for operation in value.operations {
        let key = match &operation {
            wit::KvOperation::Set(value) => &value.key,
            wit::KvOperation::Delete(key) => key,
        };
        if !valid_kv_key(key) || prior_key.as_ref().is_some_and(|prior| prior >= key) {
            return Err(PluginCallbackError::InvalidInput);
        }
        prior_key = Some(key.clone());
        match operation {
            wit::KvOperation::Set(value) => {
                let bytes = value.value.into_vec();
                value_bytes = value_bytes
                    .checked_add(bytes.len())
                    .ok_or(PluginCallbackError::OperationTooLarge)?;
                if bytes.len() > junban_app::PLUGIN_KV_VALUE_BYTES_MAX
                    || value_bytes > PLUGIN_KV_PATCH_VALUE_BYTES_MAX
                {
                    return Err(PluginCallbackError::OperationTooLarge);
                }
                set.push((value.key, bytes));
            }
            wit::KvOperation::Delete(key) => delete.push(key),
        }
    }
    Ok(PluginKvPatch { set, delete })
}

fn parse_unique_ids<T>(
    values: &[String],
    parse: impl Fn(&str) -> Result<T, junban_domain::ValidationError>,
) -> Result<Vec<T>, PluginCallbackError>
where
    T: Copy + Ord + ToString,
{
    if values.len() > junban_domain::MAX_BULK_IDS {
        return Err(PluginCallbackError::OperationTooLarge);
    }
    let parsed = values
        .iter()
        .map(|value| {
            let parsed = parse(value).map_err(invalid)?;
            if parsed.to_string() != *value {
                return Err(PluginCallbackError::InvalidInput);
            }
            Ok(parsed)
        })
        .collect::<Result<Vec<_>, _>>()?;
    if parsed.iter().copied().collect::<BTreeSet<_>>().len() != parsed.len() {
        return Err(PluginCallbackError::InvalidInput);
    }
    Ok(parsed)
}

fn string_change<T>(
    value: wit::StringChange,
    convert: impl FnOnce(String) -> Result<T, PluginCallbackError>,
) -> Result<Option<T>, PluginCallbackError> {
    match value {
        wit::StringChange::Unchanged(()) => Ok(None),
        wit::StringChange::Set(v) => convert(v).map(Some),
    }
}

trait OptionalChange {
    type Value;

    fn into_option(self) -> Option<Option<Self::Value>>;
}
macro_rules! optional_change_impl {
    ($type:ty, $value:ty) => {
        impl OptionalChange for $type {
            type Value = $value;

            fn into_option(self) -> Option<Option<Self::Value>> {
                match self {
                    Self::Unchanged(()) => None,
                    Self::Clear(()) => Some(None),
                    Self::Set(value) => Some(Some(value)),
                }
            }
        }
    };
}
optional_change_impl!(wit::OptionalStringChange, String);
optional_change_impl!(wit::OptionalIdChange, String);
optional_change_impl!(wit::OptionalDateChange, String);
optional_change_impl!(wit::OptionalTimestampChange, String);
optional_change_impl!(wit::OptionalLocalDueTimeChange, wit::LocalDueTime);
optional_change_impl!(wit::OptionalU32Change, u32);
optional_change_impl!(wit::OptionalU8Change, u8);
optional_change_impl!(wit::OptionalPriorityChange, wit::Priority);

fn optional_change<S, T>(
    value: S,
    convert: impl Fn(S::Value) -> Result<T, PluginCallbackError>,
) -> Result<Option<Option<T>>, PluginCallbackError>
where
    S: OptionalChange,
{
    value
        .into_option()
        .map(|value| value.map(&convert).transpose())
        .transpose()
}

fn bool_change(value: wit::BoolChange) -> Option<bool> {
    match value {
        wit::BoolChange::Unchanged(()) => None,
        wit::BoolChange::Set(v) => Some(v),
    }
}

fn convert_priority(value: wit::Priority) -> Result<Priority, PluginCallbackError> {
    Priority::new(match value {
        wit::Priority::P1 => 1,
        wit::Priority::P2 => 2,
        wit::Priority::P3 => 3,
        wit::Priority::P4 => 4,
    })
    .map_err(invalid)
}

fn convert_view(value: wit::ProjectView) -> ProjectView {
    match value {
        wit::ProjectView::List => ProjectView::List,
        wit::ProjectView::Board => ProjectView::Board,
        wit::ProjectView::Calendar => ProjectView::Calendar,
    }
}

fn convert_due_time(value: wit::LocalDueTime) -> Result<LocalDueTime, PluginCallbackError> {
    LocalDueTime::parse(&value.time, &value.time_zone).map_err(invalid)
}
fn parse_date(value: String) -> Result<Date, PluginCallbackError> {
    let parsed = value
        .parse::<Date>()
        .map_err(|_| PluginCallbackError::InvalidInput)?;
    if parsed.to_string() != value {
        return Err(PluginCallbackError::InvalidInput);
    }
    Ok(parsed)
}
fn parse_timestamp(value: String) -> Result<Timestamp, PluginCallbackError> {
    let parsed = value
        .parse::<Timestamp>()
        .map_err(|_| PluginCallbackError::InvalidInput)?;
    if parsed.to_string() != value {
        return Err(PluginCallbackError::InvalidInput);
    }
    Ok(parsed)
}
fn parse_task(value: &str) -> Result<TaskId, PluginCallbackError> {
    parse_canonical_id(value, TaskId::parse)
}
fn parse_project(value: &str) -> Result<ProjectId, PluginCallbackError> {
    parse_canonical_id(value, ProjectId::parse)
}
fn parse_section(value: &str) -> Result<SectionId, PluginCallbackError> {
    parse_canonical_id(value, SectionId::parse)
}
fn parse_tag(value: &str) -> Result<TagId, PluginCallbackError> {
    parse_canonical_id(value, TagId::parse)
}
fn parse_canonical_id<T: ToString>(
    value: &str,
    parse: impl Fn(&str) -> Result<T, junban_domain::ValidationError>,
) -> Result<T, PluginCallbackError> {
    let parsed = parse(value).map_err(invalid)?;
    if parsed.to_string() != value {
        return Err(PluginCallbackError::InvalidInput);
    }
    Ok(parsed)
}
fn invalid(_: junban_domain::ValidationError) -> PluginCallbackError {
    PluginCallbackError::InvalidInput
}

fn valid_kv_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.chars().any(|character| {
            character.is_control()
                || matches!(character, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
}

fn http_transition(
    delivery: &PluginInvocationDelivery,
    expected_state: PluginInvocationState,
    next_state: PluginInvocationState,
) -> AuthorizedTransitionPluginInvocationRequest {
    AuthorizedTransitionPluginInvocationRequest {
        request: TransitionPluginInvocationRequest {
            operation_id: delivery.authority.invocation_id,
            plugin_id: delivery.authority.plugin_id.clone(),
            package_generation: delivery.authority.package_generation,
            activation_epoch: delivery.authority.activation_epoch,
            expected_state,
            next_state,
        },
        delivery: delivery.clone(),
    }
}

fn derive_delivery_id(delivery: &PluginInvocationDelivery) -> String {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"junban.plugin.http-delivery.v1\0");
    bytes.extend_from_slice(delivery.authority.invocation_id.as_uuid().as_bytes());
    bytes.extend_from_slice(delivery.authority.plugin_id.as_str().as_bytes());
    Sha256Digest::of(&bytes).into_string()
}

fn http_denied(message: &str) -> wit::HttpError {
    wit::HttpError {
        code: wit::HttpErrorCode::PermissionDenied,
        delivery: wit::DeliveryState::NotSent,
        retryable: false,
        message: message.to_owned(),
    }
}

fn map_wit<T>(result: Result<T, PluginCallbackError>) -> wit::WitResult<T, wit::HostError> {
    match result {
        Ok(value) => wit::WitResult::Ok(value),
        Err(error) => wit::WitResult::Err(error.host()),
    }
}

fn map_app_error(error: AppError) -> PluginCallbackError {
    match error {
        AppError::NotFound => PluginCallbackError::StaleAuthority,
        AppError::Conflict => PluginCallbackError::StaleAuthority,
        AppError::OperationTooLarge => PluginCallbackError::OperationTooLarge,
        _ => PluginCallbackError::Unavailable,
    }
}

fn map_query_error(error: junban_app::PluginQueryError) -> PluginCallbackError {
    match error {
        junban_app::PluginQueryError::InvalidInput => PluginCallbackError::InvalidInput,
        junban_app::PluginQueryError::CursorStale => PluginCallbackError::CursorStale,
        junban_app::PluginQueryError::Unavailable => PluginCallbackError::Unavailable,
        junban_app::PluginQueryError::OperationTooLarge => PluginCallbackError::OperationTooLarge,
    }
}

impl From<RepositoryError> for PluginCallbackError {
    fn from(error: RepositoryError) -> Self {
        match error {
            RepositoryError::Conflict => Self::StaleAuthority,
            RepositoryError::OperationTooLarge => Self::OperationTooLarge,
            _ => Self::Unavailable,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        sync::{
            Mutex,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
    };

    use super::*;
    use junban_app::{
        CommunityPluginPolicy, PluginDeliveryAuthority, PluginHookKind, PluginRuntimeState,
    };
    use junban_plugin_sdk::{
        CommandDeclaration, DataKind, Dependency, HttpMethod as ManifestHttpMethod, HttpOrigin,
        InvocationRequest, Publisher, RuntimeProfile, ServiceConsumeScope, ServiceDeclaration,
        ServiceField, ServiceReference, UnscopedPermission, WitAuthority,
        private_body_types::{PluginOutcome, WitResult},
    };

    fn timestamp(raw: &str) -> Timestamp {
        raw.parse().expect("timestamp")
    }

    fn operation(index: u64) -> OperationId {
        OperationId::parse(&format!("00000000-0000-4000-8000-{index:012}")).expect("operation")
    }

    fn permission(capability: Capability) -> Permission {
        Permission {
            capability,
            scope: PermissionScope::Unscoped(UnscopedPermission {}),
        }
    }

    fn plugin(capabilities: &[Capability]) -> InstalledPlugin {
        let component_sha256 = Sha256Digest::of(b"component");
        let manifest = RuntimeManifest {
            schema_version: junban_plugin_sdk::MANIFEST_SCHEMA_VERSION,
            id: "callback-plugin".to_owned(),
            name: "Callback Plugin".to_owned(),
            description: "fixture".to_owned(),
            version: "1.0.0".to_owned(),
            publisher: Publisher {
                id: "fixture-publisher".to_owned(),
                name: "Fixture Publisher".to_owned(),
                key_id: "1".repeat(64),
            },
            license: "MIT".to_owned(),
            junban_compatibility: "^0.1.0".to_owned(),
            wit: WitAuthority {
                package: "junban:plugin".to_owned(),
                world: "plugin".to_owned(),
                version: "0.1.0".to_owned(),
            },
            runtime_profile: RuntimeProfile::Rust,
            component_sha256: component_sha256.to_string(),
            permissions: capabilities.iter().copied().map(permission).collect(),
            dependencies: Vec::new(),
            commands: vec![CommandDeclaration {
                id: "command".to_owned(),
                title: "Command".to_owned(),
                description: "fixture".to_owned(),
                icon: None,
                inputs: Vec::new(),
            }],
            subscriptions: Vec::new(),
            surfaces: Vec::new(),
            settings: Vec::new(),
            services: Vec::new(),
        };
        InstalledPlugin {
            plugin_id: PluginId::parse("callback-plugin").expect("plugin id"),
            manifest,
            version: "1.0.0".to_owned(),
            package_sha256: Sha256Digest::of(b"package"),
            component_sha256,
            publisher_key_id: Sha256Digest::parse("1".repeat(64)).expect("digest"),
            package_generation: 3,
            activation_epoch: 5,
            desired_enabled: true,
            runtime_state: PluginRuntimeState::Active,
            granted_capabilities: capabilities.to_vec(),
            dependencies_satisfied: true,
            failure_count: 0,
            last_error_code: None,
            next_retry_at: None,
            installed_at: timestamp("2026-01-01T00:00:00Z"),
            updated_at: timestamp("2026-01-01T00:00:00Z"),
        }
    }

    fn callback_state(capabilities: &[Capability]) -> PluginInvocationCallbackState {
        callback_state_with_grants(capabilities.iter().copied().map(permission).collect())
    }

    fn callback_state_with_grants(grants: Vec<Permission>) -> PluginInvocationCallbackState {
        let capabilities: Vec<_> = grants.iter().map(|grant| grant.capability).collect();
        let mut plugin = plugin(&capabilities);
        plugin.manifest.permissions.clone_from(&grants);
        let invocation_id = operation(7);
        let host_session_id = operation(8);
        let entry = PluginManifestEntry::Command {
            command_id: PluginId::parse("command").expect("command id"),
        };
        let delivery = PluginInvocationDelivery::new(
            PluginDeliveryAuthority {
                plugin_id: plugin.plugin_id.clone(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                host_session_id,
                invocation_id,
                payload_sha256: Sha256Digest::of(b"request"),
                mode: PluginDeliveryMode::Active,
            },
            PluginHookKind::InvokeCommand,
            PluginId::parse("command").expect("persisted entry id"),
        )
        .expect("delivery");
        PluginInvocationCallbackState::new(PluginCallbackAuthority::durable(
            delivery,
            entry,
            plugin.clone(),
            grants,
            CallbackFence {
                plugin_id: plugin.plugin_id.to_string(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                host_session_id: host_session_id.to_string(),
                invocation_id: invocation_id.to_string(),
                callback_id: 1,
            },
        ))
        .expect("callback state")
    }

    fn authority_plugin_mut(state: &mut PluginInvocationCallbackState) -> &mut InstalledPlugin {
        match &mut state.authority.invocation {
            PluginInvocationAuthority::Durable { plugin, .. }
            | PluginInvocationAuthority::Transient(PluginTransientInvocationAuthority {
                plugin,
                ..
            }) => plugin,
        }
    }

    fn as_service_callback_state(
        state: &PluginInvocationCallbackState,
        ancestors: Vec<PluginId>,
    ) -> PluginInvocationCallbackState {
        let mut plugin = state.authority.plugin().clone();
        let provide = permission(Capability::ServicesProvide);
        plugin.manifest.permissions.push(provide.clone());
        plugin
            .granted_capabilities
            .push(Capability::ServicesProvide);
        plugin.manifest.services = vec![ServiceDeclaration {
            id: "provider".to_owned(),
            title: "Provider".to_owned(),
            request: Vec::new(),
            response: Vec::new(),
        }];
        let mut grants = state.authority.grants().to_vec();
        grants.push(provide);
        let invocation_id = operation(70);
        let host_session_id = operation(71);
        let parent_callback = CallbackFence {
            plugin_id: ancestors
                .last()
                .map_or_else(|| "root-plugin".to_owned(), ToString::to_string),
            package_generation: 1,
            activation_epoch: 1,
            host_session_id: operation(72).to_string(),
            invocation_id: operation(73).to_string(),
            callback_id: 1,
        };
        let request = InvocationRequest::call_service(
            Some("provider".to_owned()),
            wit::ServiceCall {
                plugin_id: plugin.plugin_id.to_string(),
                service_id: "provider".to_owned(),
                values: Vec::new(),
            },
        );
        let body = serde_json::to_vec(&request).expect("service request");
        let authority = PluginTransientInvocationAuthority::new(
            plugin.clone(),
            host_session_id,
            invocation_id,
            PluginTransientCall::CallService {
                service_id: PluginId::parse("provider").expect("service id"),
                parent_callback,
            },
            grants,
            body,
            ancestors,
        )
        .expect("service authority");
        PluginInvocationCallbackState::new(PluginCallbackAuthority::transient(
            authority,
            CallbackFence {
                plugin_id: plugin.plugin_id.to_string(),
                package_generation: plugin.package_generation,
                activation_epoch: plugin.activation_epoch,
                host_session_id: host_session_id.to_string(),
                invocation_id: invocation_id.to_string(),
                callback_id: 1,
            },
        ))
        .expect("service callback state")
    }

    fn task_draft(title: &str) -> wit::TaskDraft {
        wit::TaskDraft {
            title: title.to_owned(),
            description: String::new(),
            priority: None,
            due_date: None,
            due_time: None,
            deadline: None,
            someday: false,
            estimated_minutes: None,
            actual_minutes: None,
            dread: None,
            project_id: None,
            section_id: None,
            parent_id: None,
            tag_ids: Vec::new(),
            sort_order: 0,
            recurrence_rule: None,
            remind_at: None,
            recurrence_anchor_day: None,
        }
    }

    fn create_task_outcome(title: &str) -> InvocationOutcome {
        InvocationOutcome::InvokeCommand(WitResult::Ok(PluginOutcome {
            effect: Some(wit::PluginEffect::DomainMutation(
                wit::DomainMutation::CreateTask(task_draft(title)),
            )),
        }))
    }

    #[test]
    fn plugin_callback_authority_rejects_cross_session_and_missing_grants() {
        let mut state = callback_state(&[Capability::TasksWrite]);
        state.authority.callback.host_session_id = operation(99).to_string();
        assert_eq!(
            validate_static_authority(state.authority()),
            Err(PluginCallbackError::StaleAuthority)
        );

        let state = callback_state(&[Capability::TasksWrite]);
        assert_eq!(
            authorize_request(
                &state,
                &HostCallRequest::QueryTasks(wit::TaskQuery {
                    task_id: None,
                    project_id: None,
                    section_id: None,
                    parent_id: None,
                    tag_ids: Vec::new(),
                    statuses: Vec::new(),
                    priorities: Vec::new(),
                    due_from: None,
                    due_before: None,
                    search: None,
                    cursor: None,
                    limit: 1,
                })
            ),
            Err(PluginCallbackError::PermissionDenied)
        );

        let (_, port, _) = fixture_adapter(&state, Vec::new(), false);
        let mut live = port.live.clone();
        assert_eq!(state.verify_live(&live), Ok(()));
        live.plugin.dependencies_satisfied = false;
        assert_eq!(
            state.verify_live(&live),
            Err(PluginCallbackError::StaleAuthority)
        );
    }

    #[test]
    fn plugin_callback_enforces_the_complete_sdk_mode_matrix() {
        let grants = vec![
            Permission {
                capability: Capability::Http,
                scope: PermissionScope::Http(HttpScope {
                    origins: vec![HttpOrigin("https://example.com".to_owned())],
                    methods: vec![ManifestHttpMethod::Get],
                }),
            },
            permission(Capability::Logging),
            permission(Capability::ProjectsRead),
            Permission {
                capability: Capability::ServicesConsume,
                scope: PermissionScope::Services(junban_plugin_sdk::ServiceConsumeScope {
                    services: vec![junban_plugin_sdk::ServiceReference {
                        plugin_id: "target-plugin".to_owned(),
                        service_id: "service".to_owned(),
                    }],
                }),
            },
            permission(Capability::Settings),
            permission(Capability::Storage),
            permission(Capability::TagsRead),
            permission(Capability::TasksRead),
        ];
        let requests = vec![
            HostCallRequest::QueryTasks(wit::TaskQuery {
                task_id: None,
                project_id: None,
                section_id: None,
                parent_id: None,
                tag_ids: Vec::new(),
                statuses: Vec::new(),
                priorities: Vec::new(),
                due_from: None,
                due_before: None,
                search: None,
                cursor: None,
                limit: 1,
            }),
            HostCallRequest::QueryProjects(wit::CatalogQuery {
                cursor: None,
                limit: 1,
            }),
            HostCallRequest::QueryTags(wit::CatalogQuery {
                cursor: None,
                limit: 1,
            }),
            HostCallRequest::GetSettings(()),
            HostCallRequest::GetKv(Vec::new()),
            HostCallRequest::ListKv(wit::HostStorageListKvArguments {
                cursor: None,
                limit: 1,
            }),
            HostCallRequest::WallNow(()),
            HostCallRequest::MonotonicMs(()),
            http_request(),
            HostCallRequest::Log(wit::HostLogLogArguments {
                level: wit::LogLevel::Info,
                message: String::new(),
                fields: Vec::new(),
            }),
            HostCallRequest::CallService(wit::ServiceCall {
                plugin_id: "target-plugin".to_owned(),
                service_id: "service".to_owned(),
                values: Vec::new(),
            }),
        ];
        for mode in [
            InvocationMode::Lifecycle,
            InvocationMode::Effect,
            InvocationMode::Render,
            InvocationMode::ValidateSettings,
            InvocationMode::Resync,
            InvocationMode::Service,
        ] {
            for request in &requests {
                assert_eq!(
                    validate_host_call_authority(request.kind(), mode, &grants).is_ok(),
                    request.kind().allowed_in(mode),
                    "mode {mode:?}, callback {:?}",
                    request.kind()
                );
            }
        }
    }

    #[tokio::test]
    async fn plugin_callback_rejects_cross_session_child_frames_before_app_access() {
        let mut state = callback_state(&[Capability::TasksRead]);
        let request = HostCallRequest::QueryTasks(wit::TaskQuery {
            task_id: None,
            project_id: None,
            section_id: None,
            parent_id: None,
            tag_ids: Vec::new(),
            statuses: Vec::new(),
            priorities: Vec::new(),
            due_from: None,
            due_before: None,
            search: None,
            cursor: None,
            limit: 1,
        });
        let (mut frame, body) = callback_message(&state, request);
        let ChildFrame::CapabilityRequest { callback, .. } = &mut frame else {
            panic!("expected capability frame");
        };
        callback.host_session_id = operation(99).to_string();
        let (adapter, port, _) = fixture_adapter(&state, Vec::new(), false);
        assert_eq!(
            adapter.dispatch_message(&mut state, &frame, &body).await,
            Err(PluginCallbackError::StaleAuthority)
        );
        assert_eq!(port.authority_reads.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn plugin_callback_kv_snapshot_cursors_are_bounded_and_invocation_local() {
        let mut state = callback_state(&[Capability::Storage]);
        state.kv_snapshot = Some(BTreeMap::from([
            ("a".to_owned(), vec![1]),
            ("b".to_owned(), vec![2]),
        ]));
        let first = list_kv(
            &mut state,
            wit::HostStorageListKvArguments {
                cursor: None,
                limit: 1,
            },
        )
        .expect("first page");
        let cursor = first.next_cursor.expect("cursor");
        assert_eq!(first.entries[0].key, "a");
        let second = list_kv(
            &mut state,
            wit::HostStorageListKvArguments {
                cursor: Some(cursor.clone()),
                limit: 1,
            },
        )
        .expect("second page");
        assert_eq!(second.entries[0].key, "b");

        let mut other = callback_state(&[Capability::Storage]);
        other.kv_snapshot = state.kv_snapshot.clone();
        assert_eq!(
            list_kv(
                &mut other,
                wit::HostStorageListKvArguments {
                    cursor: Some(cursor),
                    limit: 1,
                }
            ),
            Err(PluginCallbackError::InvalidInput)
        );
    }

    #[test]
    fn plugin_callback_logs_are_redacted_and_capped() {
        let mut state = callback_state(&[Capability::Logging]);
        retain_log(
            &mut state,
            wit::HostLogLogArguments {
                level: wit::LogLevel::Info,
                message: "Authorization: Bearer top-secret?token=hidden".to_owned(),
                fields: Vec::new(),
            },
        )
        .expect("log");
        assert!(!state.logs()[0].message.contains("top-secret"));
        assert!(!state.logs()[0].message.contains("hidden"));
    }

    #[test]
    fn plugin_effect_identity_is_deterministic_and_validates_domain_input() {
        let state = callback_state(&[Capability::TasksWrite]);
        let first =
            adapt_plugin_effect(&state, &create_task_outcome("Task"), None).expect("first effect");
        let second =
            adapt_plugin_effect(&state, &create_task_outcome("Task"), None).expect("second effect");
        assert_eq!(
            first.request.child_operation_id,
            second.request.child_operation_id
        );
        let first_task_id = match first.request.domain_effect {
            Some(PluginDomainEffect::CreateTask { task_id, .. }) => task_id,
            _ => panic!("expected create task"),
        };
        let second_task_id = match second.request.domain_effect {
            Some(PluginDomainEffect::CreateTask { task_id, .. }) => task_id,
            _ => panic!("expected create task"),
        };
        assert_eq!(first_task_id, second_task_id);
        assert!(matches!(
            adapt_plugin_effect(&state, &create_task_outcome("  "), None),
            Err(PluginCallbackError::InvalidInput)
        ));
    }

    fn unchanged_task_patch() -> wit::TaskPatch {
        wit::TaskPatch {
            title: wit::StringChange::Unchanged(()),
            description: wit::StringChange::Unchanged(()),
            priority: wit::OptionalPriorityChange::Unchanged(()),
            due_date: wit::OptionalDateChange::Unchanged(()),
            due_time: wit::OptionalLocalDueTimeChange::Unchanged(()),
            deadline: wit::OptionalTimestampChange::Unchanged(()),
            someday: wit::BoolChange::Unchanged(()),
            estimated_minutes: wit::OptionalU32Change::Unchanged(()),
            actual_minutes: wit::OptionalU32Change::Unchanged(()),
            dread: wit::OptionalU8Change::Unchanged(()),
            project_id: wit::OptionalIdChange::Unchanged(()),
            section_id: wit::OptionalIdChange::Unchanged(()),
            parent_id: wit::OptionalIdChange::Unchanged(()),
            tag_ids: wit::IdListChange::Unchanged(()),
            sort_order: wit::S64Change::Unchanged(()),
            recurrence_rule: wit::OptionalStringChange::Unchanged(()),
            remind_at: wit::OptionalTimestampChange::Unchanged(()),
            recurrence_anchor_day: wit::OptionalU8Change::Unchanged(()),
        }
    }

    fn unchanged_project_patch() -> wit::ProjectPatch {
        wit::ProjectPatch {
            name: wit::StringChange::Unchanged(()),
            color: wit::StringChange::Unchanged(()),
            icon: wit::OptionalStringChange::Unchanged(()),
            parent_id: wit::OptionalIdChange::Unchanged(()),
            favorite: wit::BoolChange::Unchanged(()),
            archived: wit::BoolChange::Unchanged(()),
            view: wit::ProjectViewChange::Unchanged(()),
            sort_order: wit::S64Change::Unchanged(()),
        }
    }

    #[test]
    fn plugin_effect_rejects_noncanonical_uuid_date_and_timestamp_text() {
        let temporal = TemporalContext::sample_now();
        let canonical_uuid = "abcdefab-cdef-4abc-8def-abcdefabcdef".to_owned();

        let mut signed_year = task_draft("Task");
        signed_year.due_date = Some("+002026-01-01".to_owned());
        let mut lowercase_timestamp = task_draft("Task");
        lowercase_timestamp.deadline = Some("2026-01-01t00:00:00z".to_owned());
        let mut braced_section = task_draft("Task");
        braced_section.section_id = Some(format!("{{{canonical_uuid}}}"));

        let mut offset_patch = unchanged_task_patch();
        offset_patch.remind_at =
            wit::OptionalTimestampChange::Set("2026-01-01T01:00:00+01:00".to_owned());
        let noncanonical = vec![
            wit::DomainMutation::CompleteTask(canonical_uuid.to_uppercase()),
            wit::DomainMutation::PatchProject(wit::PatchProject {
                project_id: canonical_uuid.replace('-', ""),
                patch: unchanged_project_patch(),
            }),
            wit::DomainMutation::CreateTask(braced_section),
            wit::DomainMutation::DeleteTag(format!("urn:uuid:{canonical_uuid}")),
            wit::DomainMutation::BulkTasks(wit::BulkTasks {
                task_ids: vec![canonical_uuid.to_uppercase()],
                action: wit::BulkAction::Complete(()),
            }),
            wit::DomainMutation::CreateTask(signed_year),
            wit::DomainMutation::CreateTask(lowercase_timestamp),
            wit::DomainMutation::PatchTask(wit::PatchTask {
                task_id: canonical_uuid.clone(),
                patch: offset_patch,
            }),
            wit::DomainMutation::BulkTasks(wit::BulkTasks {
                task_ids: vec![canonical_uuid.clone()],
                action: wit::BulkAction::Schedule(wit::BulkSchedule {
                    due_date: wit::OptionalDateChange::Unchanged(()),
                    due_time: wit::OptionalLocalDueTimeChange::Unchanged(()),
                    deadline: wit::OptionalTimestampChange::Set(
                        "2026-01-01T00:00:00.000Z".to_owned(),
                    ),
                    someday: wit::BoolChange::Unchanged(()),
                }),
            }),
        ];
        for (index, mutation) in noncanonical.into_iter().enumerate() {
            assert!(
                matches!(
                    convert_domain_mutation(
                        mutation,
                        operation(100 + u64::try_from(index).expect("effect index")),
                        &temporal,
                    ),
                    Err(PluginCallbackError::InvalidInput)
                ),
                "noncanonical effect {index}"
            );
        }

        let mut canonical = task_draft("Task");
        canonical.due_date = Some("2026-01-01".to_owned());
        canonical.deadline = Some("2026-01-01T00:00:00Z".to_owned());
        assert!(
            convert_domain_mutation(
                wit::DomainMutation::CreateTask(canonical),
                operation(200),
                &temporal,
            )
            .is_ok()
        );
        assert!(
            convert_domain_mutation(
                wit::DomainMutation::CompleteTask(canonical_uuid),
                operation(201),
                &temporal,
            )
            .is_ok()
        );
    }

    #[test]
    fn plugin_effect_adapter_covers_every_frozen_domain_mutation_family() {
        let task = operation(20).to_string();
        let project = operation(21).to_string();
        let tag = operation(22).to_string();
        let effects = vec![
            wit::DomainMutation::CreateTask(match create_task_outcome("Task") {
                InvocationOutcome::InvokeCommand(WitResult::Ok(PluginOutcome {
                    effect:
                        Some(wit::PluginEffect::DomainMutation(wit::DomainMutation::CreateTask(draft))),
                })) => draft,
                _ => unreachable!(),
            }),
            wit::DomainMutation::PatchTask(wit::PatchTask {
                task_id: task.clone(),
                patch: unchanged_task_patch(),
            }),
            wit::DomainMutation::CompleteTask(task.clone()),
            wit::DomainMutation::UncompleteTask(task.clone()),
            wit::DomainMutation::CancelTask(task.clone()),
            wit::DomainMutation::ReopenTask(task.clone()),
            wit::DomainMutation::DeleteTask(task.clone()),
            wit::DomainMutation::BulkTasks(wit::BulkTasks {
                task_ids: vec![task.clone()],
                action: wit::BulkAction::Cancel(()),
            }),
            wit::DomainMutation::CreateProject(wit::ProjectDraft {
                name: "Project".to_owned(),
                color: "#112233".to_owned(),
                icon: None,
                parent_id: None,
                favorite: false,
                archived: false,
                view: wit::ProjectView::List,
                sort_order: 0,
            }),
            wit::DomainMutation::PatchProject(wit::PatchProject {
                project_id: project.clone(),
                patch: unchanged_project_patch(),
            }),
            wit::DomainMutation::DeleteProject(project),
            wit::DomainMutation::CreateTag(wit::TagDraft {
                name: "tag".to_owned(),
                color: "#445566".to_owned(),
            }),
            wit::DomainMutation::PatchTag(wit::PatchTag {
                tag_id: tag.clone(),
                patch: wit::TagPatch {
                    name: wit::StringChange::Unchanged(()),
                    color: wit::StringChange::Unchanged(()),
                },
            }),
            wit::DomainMutation::DeleteTag(tag),
        ];
        let temporal = TemporalContext::sample_now();
        for (index, effect) in effects.into_iter().enumerate() {
            assert!(
                convert_domain_mutation(
                    effect,
                    operation(100 + u64::try_from(index).expect("effect index")),
                    &temporal,
                )
                .is_ok(),
                "effect family {index}"
            );
        }
    }

    #[test]
    fn plugin_effect_kv_patch_requires_bounded_sorted_unique_operations() {
        let patch = convert_kv_patch(wit::KvPatch {
            operations: vec![
                wit::KvOperation::Set(wit::KvSet {
                    key: "a".to_owned(),
                    value: wit::ByteList::new(vec![1]).expect("value"),
                }),
                wit::KvOperation::Set(wit::KvSet {
                    key: "b".to_owned(),
                    value: wit::ByteList::new(vec![2]).expect("value"),
                }),
            ],
        })
        .expect("KV patch");
        assert_eq!(patch.set[0].0, "a");
        assert_eq!(patch.set[1].0, "b");
        for operations in [
            vec![
                wit::KvOperation::Delete("a".to_owned()),
                wit::KvOperation::Delete("a".to_owned()),
            ],
            vec![
                wit::KvOperation::Delete("b".to_owned()),
                wit::KvOperation::Delete("a".to_owned()),
            ],
            Vec::new(),
        ] {
            assert_eq!(
                convert_kv_patch(wit::KvPatch { operations }),
                Err(PluginCallbackError::InvalidInput)
            );
        }
    }

    #[test]
    fn plugin_effect_message_requires_the_exact_outcome_fence_and_body() {
        let state = callback_state(&[Capability::TasksWrite]);
        let outcome = create_task_outcome("Task");
        let (mut frame, body) = outcome
            .into_child_message(junban_plugin_sdk::AuthorityFence {
                plugin_id: state.authority.callback.plugin_id.clone(),
                package_generation: state.authority.callback.package_generation,
                activation_epoch: state.authority.callback.activation_epoch,
                host_session_id: state.authority.callback.host_session_id.clone(),
                invocation_id: state.authority.callback.invocation_id.clone(),
            })
            .expect("outcome message")
            .into_parts();
        assert!(adapt_plugin_effect_message(&state, &frame, &body, None).is_ok());
        let ChildFrame::Outcome { fence, .. } = &mut frame else {
            panic!("expected outcome frame");
        };
        fence.host_session_id = operation(99).to_string();
        assert!(matches!(
            adapt_plugin_effect_message(&state, &frame, &body, None),
            Err(PluginCallbackError::StaleAuthority)
        ));
    }

    #[test]
    fn plugin_effect_is_rejected_after_http_consumption_or_outside_effect_mode() {
        let mut state = callback_state_with_grants(vec![
            Permission {
                capability: Capability::Http,
                scope: PermissionScope::Http(HttpScope {
                    origins: vec![HttpOrigin("https://example.com".to_owned())],
                    methods: vec![ManifestHttpMethod::Get],
                }),
            },
            permission(Capability::TasksWrite),
        ]);
        state.http = Some(RetainedHttp {
            process_lost: false,
            durable_transitioned: true,
            may_be_ambiguous: false,
        });
        assert!(matches!(
            adapt_plugin_effect(&state, &create_task_outcome("Task"), None),
            Err(PluginCallbackError::PermissionDenied)
        ));
        assert!(
            adapt_plugin_effect(
                &state,
                &InvocationOutcome::InvokeCommand(WitResult::Ok(PluginOutcome { effect: None })),
                None,
            )
            .is_ok()
        );
    }

    struct FixturePort {
        live: PluginLiveAuthority,
        stale_on_second_read: bool,
        authority_reads: AtomicUsize,
        fail_transitions: AtomicBool,
        transitions: Mutex<Vec<(PluginInvocationState, PluginInvocationState)>>,
    }

    impl PluginCallbackPort for FixturePort {
        fn authority(&self, _plugin_id: PluginId) -> PluginCallbackFuture<PluginLiveAuthority> {
            let mut live = self.live.clone();
            let read = self.authority_reads.fetch_add(1, Ordering::SeqCst);
            if self.stale_on_second_read && read > 0 {
                live.plugin.activation_epoch += 1;
            }
            Box::pin(async move { Ok(live) })
        }

        fn query_tasks(&self, _request: wit::TaskQuery) -> PluginCallbackFuture<wit::TaskPage> {
            Box::pin(async {
                Ok(wit::TaskPage {
                    items: Vec::new(),
                    next_cursor: None,
                    revision: 1,
                })
            })
        }

        fn query_projects(
            &self,
            _request: wit::CatalogQuery,
        ) -> PluginCallbackFuture<wit::ProjectPage> {
            Box::pin(async {
                Ok(wit::ProjectPage {
                    items: Vec::new(),
                    next_cursor: None,
                    revision: 1,
                })
            })
        }

        fn query_tags(&self, _request: wit::CatalogQuery) -> PluginCallbackFuture<wit::TagPage> {
            Box::pin(async {
                Ok(wit::TagPage {
                    items: Vec::new(),
                    next_cursor: None,
                    revision: 1,
                })
            })
        }

        fn settings(&self, _plugin_id: PluginId) -> PluginCallbackFuture<Vec<PluginSetting>> {
            Box::pin(async { Ok(Vec::new()) })
        }

        fn kv(&self, _plugin_id: PluginId) -> PluginCallbackFuture<Vec<PluginKvEntry>> {
            Box::pin(async { Ok(Vec::new()) })
        }

        fn transition_invocation(
            &self,
            request: AuthorizedTransitionPluginInvocationRequest,
        ) -> PluginCallbackFuture<()> {
            self.transitions
                .lock()
                .expect("transitions")
                .push((request.request.expected_state, request.request.next_state));
            let fail = self.fail_transitions.load(Ordering::SeqCst);
            Box::pin(async move {
                if fail {
                    Err(PluginCallbackError::Unavailable)
                } else {
                    Ok(())
                }
            })
        }
    }

    struct FixtureHttp {
        outcomes: Mutex<VecDeque<Result<wit::HttpResponse, wit::HttpError>>>,
        sends: AtomicUsize,
        sent: Mutex<Vec<(HttpScope, wit::HttpRequest, String)>>,
    }

    impl PluginCallbackHttp for FixtureHttp {
        fn send(
            &self,
            grant: HttpScope,
            request: wit::HttpRequest,
            delivery_id: String,
        ) -> Pin<Box<dyn Future<Output = Result<wit::HttpResponse, wit::HttpError>> + Send + 'static>>
        {
            self.sends.fetch_add(1, Ordering::SeqCst);
            self.sent
                .lock()
                .expect("sent HTTP requests")
                .push((grant, request, delivery_id));
            let result = self
                .outcomes
                .lock()
                .expect("HTTP outcomes")
                .pop_front()
                .expect("fixture outcome");
            Box::pin(async move { result })
        }
    }

    fn fixture_adapter(
        state: &PluginInvocationCallbackState,
        outcomes: Vec<Result<wit::HttpResponse, wit::HttpError>>,
        stale_on_second_read: bool,
    ) -> (PluginCallbackAdapter, Arc<FixturePort>, Arc<FixtureHttp>) {
        let plugin = state.authority.plugin().clone();
        let port = Arc::new(FixturePort {
            live: PluginLiveAuthority {
                profile: InstalledPluginProfile {
                    plugins: vec![plugin.clone()],
                    activation_order: vec![plugin.plugin_id.clone()],
                    community_policy: CommunityPluginPolicy {
                        community_registry_enabled: false,
                        updated_at: timestamp("2026-01-01T00:00:00Z"),
                    },
                },
                plugin,
                grants: state.authority.grants().to_vec(),
            },
            stale_on_second_read,
            authority_reads: AtomicUsize::new(0),
            fail_transitions: AtomicBool::new(false),
            transitions: Mutex::new(Vec::new()),
        });
        let http = Arc::new(FixtureHttp {
            outcomes: Mutex::new(outcomes.into()),
            sends: AtomicUsize::new(0),
            sent: Mutex::new(Vec::new()),
        });
        (
            PluginCallbackAdapter::new(port.clone(), http.clone()),
            port,
            http,
        )
    }

    fn http_state() -> PluginInvocationCallbackState {
        callback_state_with_grants(vec![Permission {
            capability: Capability::Http,
            scope: PermissionScope::Http(HttpScope {
                origins: vec![HttpOrigin("https://example.com".to_owned())],
                methods: vec![ManifestHttpMethod::Get],
            }),
        }])
    }

    fn http_request() -> HostCallRequest {
        HostCallRequest::HttpRequest(wit::HttpRequest {
            method: wit::HttpMethod::Get,
            origin: "https://example.com".to_owned(),
            path_and_query: "/resource".to_owned(),
            headers: Vec::new(),
            body: wit::ByteList::new(Vec::new()).expect("empty body"),
        })
    }

    fn callback_message(
        state: &PluginInvocationCallbackState,
        request: HostCallRequest,
    ) -> (ChildFrame, Vec<u8>) {
        let mut callback = state.authority.callback.clone();
        callback.callback_id = state.next_callback_id;
        request
            .into_child_message(callback)
            .expect("callback body")
            .into_parts()
    }

    fn success_response() -> wit::HttpResponse {
        wit::HttpResponse {
            status: 200,
            headers: Vec::new(),
            body: wit::ByteList::new(Vec::new()).expect("empty body"),
            truncated: false,
        }
    }

    fn ambiguous_error() -> wit::HttpError {
        wit::HttpError {
            code: wit::HttpErrorCode::DeliveryAmbiguous,
            delivery: wit::DeliveryState::MayHaveBeenSent,
            retryable: false,
            message: "delivery is ambiguous".to_owned(),
        }
    }

    #[tokio::test]
    async fn plugin_callback_http_is_consume_once_after_success() {
        let mut state = http_state();
        let request = http_request();
        let (frame, body) = callback_message(&state, request.clone());
        let (adapter, port, http) = fixture_adapter(&state, vec![Ok(success_response())], false);
        let first = adapter
            .dispatch_message(&mut state, &frame, &body)
            .await
            .expect("first callback");
        let PluginCallbackDispatch::Reply(encoded) = first else {
            panic!("expected encoded callback reply");
        };
        let junban_plugin_sdk::ParentFrame::CapabilityReply { kind, result, .. } = encoded.frame
        else {
            panic!("expected capability reply frame");
        };
        assert!(matches!(
            &encoded.reply,
            HostCallReply::HttpRequest(WitResult::Ok(_))
        ));
        assert_eq!(
            junban_plugin_sdk::decode_host_call_reply(kind, result, &encoded.canonical_body)
                .expect("decode callback reply"),
            encoded.reply
        );
        let (second_frame, second_body) = callback_message(&state, request);
        assert!(matches!(
            adapter
                .dispatch_message(&mut state, &second_frame, &second_body)
                .await,
            Ok(PluginCallbackDispatch::Reply(EncodedPluginCallbackReply {
                reply: HostCallReply::HttpRequest(WitResult::Err(_)),
                ..
            }))
        ));
        assert_eq!(http.sends.load(Ordering::SeqCst), 1);
        assert_eq!(
            *port.transitions.lock().expect("transitions"),
            vec![(
                PluginInvocationState::Reserved,
                PluginInvocationState::DispatchingHttp
            )]
        );
    }

    #[tokio::test]
    async fn plugin_callback_http_transition_failure_is_consumed_but_not_durably_dispatched() {
        let mut state = http_state();
        let request = http_request();
        let (frame, body) = callback_message(&state, request.clone());
        let (adapter, port, http) = fixture_adapter(&state, Vec::new(), false);
        port.fail_transitions.store(true, Ordering::SeqCst);

        assert!(matches!(
            adapter.dispatch_message(&mut state, &frame, &body).await,
            Ok(PluginCallbackDispatch::Reply(EncodedPluginCallbackReply {
                reply: HostCallReply::HttpRequest(WitResult::Err(_)),
                ..
            }))
        ));
        assert!(!state.http_consumed());
        assert!(state.http.is_some());
        assert_eq!(http.sends.load(Ordering::SeqCst), 0);

        let (second_frame, second_body) = callback_message(&state, request);
        assert!(matches!(
            adapter
                .dispatch_message(&mut state, &second_frame, &second_body)
                .await,
            Ok(PluginCallbackDispatch::Reply(EncodedPluginCallbackReply {
                reply: HostCallReply::HttpRequest(WitResult::Err(_)),
                ..
            }))
        ));
        assert_eq!(port.transitions.lock().expect("transitions").len(), 1);
        assert_eq!(http.sends.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn plugin_callback_http_owns_one_internal_same_process_ambiguous_resend() {
        let mut state = http_state();
        let request = http_request();
        let (frame, body) = callback_message(&state, request.clone());
        let (adapter, port, http) = fixture_adapter(
            &state,
            vec![Err(ambiguous_error()), Ok(success_response())],
            false,
        );
        let first = adapter.dispatch_message(&mut state, &frame, &body).await;
        assert!(matches!(
            first,
            Ok(PluginCallbackDispatch::Reply(EncodedPluginCallbackReply {
                reply: HostCallReply::HttpRequest(WitResult::Ok(_)),
                ..
            }))
        ));
        assert_eq!(http.sends.load(Ordering::SeqCst), 2);
        {
            let sent = http.sent.lock().expect("sent HTTP requests");
            assert_eq!(sent.len(), 2);
            assert_eq!(sent[0], sent[1]);
        }

        for later_request in [
            request.clone(),
            HostCallRequest::HttpRequest(wit::HttpRequest {
                path_and_query: "/different".to_owned(),
                ..match request.clone() {
                    HostCallRequest::HttpRequest(request) => request,
                    _ => unreachable!(),
                }
            }),
        ] {
            let (later_frame, later_body) = callback_message(&state, later_request);
            assert!(matches!(
                adapter
                    .dispatch_message(&mut state, &later_frame, &later_body)
                    .await,
                Ok(PluginCallbackDispatch::Reply(EncodedPluginCallbackReply {
                    reply: HostCallReply::HttpRequest(WitResult::Err(_)),
                    ..
                }))
            ));
            assert_eq!(http.sends.load(Ordering::SeqCst), 2);
        }
        assert_eq!(
            *port.transitions.lock().expect("transitions"),
            vec![
                (
                    PluginInvocationState::Reserved,
                    PluginInvocationState::DispatchingHttp
                ),
                (
                    PluginInvocationState::DispatchingHttp,
                    PluginInvocationState::AmbiguousHttp
                ),
                (
                    PluginInvocationState::AmbiguousHttp,
                    PluginInvocationState::DispatchingHttp
                ),
            ]
        );
    }

    #[tokio::test]
    async fn plugin_callback_http_internal_resend_is_bounded_and_preserves_initial_ambiguity() {
        let mut state = http_state();
        let request = http_request();
        let (frame, body) = callback_message(&state, request.clone());
        let mut retry_error = ambiguous_error();
        retry_error.code = wit::HttpErrorCode::Unavailable;
        retry_error.delivery = wit::DeliveryState::NotSent;
        retry_error.message = "retry was not sent".to_owned();
        let (adapter, port, http) = fixture_adapter(
            &state,
            vec![Err(ambiguous_error()), Err(retry_error)],
            false,
        );
        assert!(matches!(
            adapter.dispatch_message(&mut state, &frame, &body).await,
            Ok(PluginCallbackDispatch::Reply(EncodedPluginCallbackReply {
                reply: HostCallReply::HttpRequest(WitResult::Err(wit::HttpError {
                    delivery: wit::DeliveryState::MayHaveBeenSent,
                    ..
                })),
                ..
            }))
        ));
        assert_eq!(http.sends.load(Ordering::SeqCst), 2);

        let (second_frame, second_body) = callback_message(&state, request);
        assert!(matches!(
            adapter
                .dispatch_message(&mut state, &second_frame, &second_body)
                .await,
            Ok(PluginCallbackDispatch::Reply(EncodedPluginCallbackReply {
                reply: HostCallReply::HttpRequest(WitResult::Err(_)),
                ..
            }))
        ));
        assert_eq!(http.sends.load(Ordering::SeqCst), 2);
        assert_eq!(
            *port.transitions.lock().expect("transitions"),
            vec![
                (
                    PluginInvocationState::Reserved,
                    PluginInvocationState::DispatchingHttp
                ),
                (
                    PluginInvocationState::DispatchingHttp,
                    PluginInvocationState::AmbiguousHttp
                ),
                (
                    PluginInvocationState::AmbiguousHttp,
                    PluginInvocationState::DispatchingHttp
                ),
                (
                    PluginInvocationState::DispatchingHttp,
                    PluginInvocationState::AmbiguousHttp
                ),
            ]
        );
    }

    #[tokio::test]
    async fn plugin_callback_rejects_authority_that_changes_mid_query() {
        let mut state = callback_state(&[Capability::TasksRead]);
        let request = HostCallRequest::QueryTasks(wit::TaskQuery {
            task_id: None,
            project_id: None,
            section_id: None,
            parent_id: None,
            tag_ids: Vec::new(),
            statuses: Vec::new(),
            priorities: Vec::new(),
            due_from: None,
            due_before: None,
            search: None,
            cursor: None,
            limit: 1,
        });
        let (frame, body) = callback_message(&state, request);
        let (adapter, _, _) = fixture_adapter(&state, Vec::new(), true);
        assert_eq!(
            adapter.dispatch_message(&mut state, &frame, &body).await,
            Err(PluginCallbackError::StaleAuthority)
        );
    }

    fn service_boundary_fixture(
        kind: DataKind,
    ) -> (
        PluginInvocationCallbackState,
        InstalledPlugin,
        InstalledPluginProfile,
    ) {
        let grant = Permission {
            capability: Capability::ServicesConsume,
            scope: PermissionScope::Services(ServiceConsumeScope {
                services: vec![ServiceReference {
                    plugin_id: "target-plugin".to_owned(),
                    service_id: "lookup".to_owned(),
                }],
            }),
        };
        let mut state = callback_state_with_grants(vec![grant]);
        authority_plugin_mut(&mut state).manifest.dependencies = vec![Dependency {
            id: "target-plugin".to_owned(),
            requirement: "^1.0.0".to_owned(),
            services: vec!["lookup".to_owned()],
        }];
        let mut target = plugin(&[Capability::ServicesProvide]);
        target.plugin_id = PluginId::parse("target-plugin").expect("target id");
        target.manifest.id = target.plugin_id.to_string();
        target.manifest.name = "Target".to_owned();
        let field = ServiceField {
            id: "value".to_owned(),
            kind,
            required: true,
        };
        target.manifest.services = vec![ServiceDeclaration {
            id: "lookup".to_owned(),
            title: "Lookup".to_owned(),
            request: vec![field.clone()],
            response: vec![field],
        }];
        let caller = state.authority.plugin().clone();
        let profile = InstalledPluginProfile {
            plugins: vec![caller.clone(), target.clone()],
            activation_order: vec![target.plugin_id.clone(), caller.plugin_id.clone()],
            community_policy: CommunityPluginPolicy {
                community_registry_enabled: false,
                updated_at: timestamp("2026-01-01T00:00:00Z"),
            },
        };
        (state, target, profile)
    }

    fn validate_service_request_value(
        state: &PluginInvocationCallbackState,
        profile: &InstalledPluginProfile,
        value: wit::DataValue,
    ) -> Result<ValidatedPluginServiceCall, PluginCallbackError> {
        validate_service_call(
            state,
            state.authority.callback.clone(),
            profile,
            wit::ServiceCall {
                plugin_id: "target-plugin".to_owned(),
                service_id: "lookup".to_owned(),
                values: vec![wit::NamedValue {
                    name: "value".to_owned(),
                    value,
                }],
            },
        )
    }

    fn validate_service_response_value(
        target: &InstalledPlugin,
        value: wit::DataValue,
    ) -> Result<(), PluginCallbackError> {
        validate_service_response(
            target,
            &PluginId::parse("lookup").expect("service id"),
            &wit::ServiceData {
                values: vec![wit::NamedValue {
                    name: "value".to_owned(),
                    value,
                }],
            },
        )
    }

    fn service_list_values(count: usize) -> Vec<(DataKind, wit::DataValue)> {
        let uuid = operation(30).to_string();
        vec![
            (
                DataKind::StringList,
                wit::DataValue::StringList(vec!["value".to_owned(); count]),
            ),
            (
                DataKind::IntegerList,
                wit::DataValue::IntegerList(vec![1; count]),
            ),
            (
                DataKind::BooleanList,
                wit::DataValue::BooleanList(vec![true; count]),
            ),
            (
                DataKind::DateList,
                wit::DataValue::DateList(vec!["2026-01-01".to_owned(); count]),
            ),
            (
                DataKind::TimestampList,
                wit::DataValue::TimestampList(vec!["2026-01-01T00:00:00Z".to_owned(); count]),
            ),
            (
                DataKind::TaskIdList,
                wit::DataValue::TaskIdList(vec![uuid.clone(); count]),
            ),
            (
                DataKind::ProjectIdList,
                wit::DataValue::ProjectIdList(vec![uuid.clone(); count]),
            ),
            (
                DataKind::TagIdList,
                wit::DataValue::TagIdList(vec![uuid; count]),
            ),
            (
                DataKind::PluginIdList,
                wit::DataValue::PluginIdList(vec!["plugin".to_owned(); count]),
            ),
            (
                DataKind::OptionIdList,
                wit::DataValue::OptionIdList(vec!["option".to_owned(); count]),
            ),
        ]
    }

    #[test]
    fn plugin_callback_service_request_enforces_list_and_utf8_string_boundaries() {
        for (kind, value) in service_list_values(100) {
            let (state, _, profile) = service_boundary_fixture(kind);
            assert!(validate_service_request_value(&state, &profile, value).is_ok());
        }
        for (kind, value) in service_list_values(101) {
            let (state, _, profile) = service_boundary_fixture(kind);
            assert_eq!(
                validate_service_request_value(&state, &profile, value),
                Err(PluginCallbackError::OperationTooLarge)
            );
        }

        let accepted = "é".repeat(4 * 1024);
        let rejected = format!("{accepted}a");
        assert_eq!(accepted.len(), 8 * 1024);
        assert_eq!(rejected.len(), 8 * 1024 + 1);

        let (state, _, profile) = service_boundary_fixture(DataKind::String);
        assert!(
            validate_service_request_value(
                &state,
                &profile,
                wit::DataValue::Scalar(wit::ScalarValue::StringValue(accepted.clone())),
            )
            .is_ok()
        );
        assert_eq!(
            validate_service_request_value(
                &state,
                &profile,
                wit::DataValue::Scalar(wit::ScalarValue::StringValue(rejected.clone())),
            ),
            Err(PluginCallbackError::OperationTooLarge)
        );

        let (state, _, profile) = service_boundary_fixture(DataKind::StringList);
        assert!(
            validate_service_request_value(
                &state,
                &profile,
                wit::DataValue::StringList(vec![accepted]),
            )
            .is_ok()
        );
        assert_eq!(
            validate_service_request_value(
                &state,
                &profile,
                wit::DataValue::StringList(vec![rejected]),
            ),
            Err(PluginCallbackError::OperationTooLarge)
        );
    }

    #[test]
    fn plugin_callback_service_response_enforces_list_and_utf8_string_boundaries() {
        for (kind, value) in service_list_values(100) {
            let (_, target, _) = service_boundary_fixture(kind);
            assert!(validate_service_response_value(&target, value).is_ok());
        }
        for (kind, value) in service_list_values(101) {
            let (_, target, _) = service_boundary_fixture(kind);
            assert_eq!(
                validate_service_response_value(&target, value),
                Err(PluginCallbackError::OperationTooLarge)
            );
        }

        let accepted = "é".repeat(4 * 1024);
        let rejected = format!("{accepted}a");
        assert_eq!(accepted.len(), 8 * 1024);
        assert_eq!(rejected.len(), 8 * 1024 + 1);

        let (_, target, _) = service_boundary_fixture(DataKind::String);
        assert!(
            validate_service_response_value(
                &target,
                wit::DataValue::Scalar(wit::ScalarValue::StringValue(accepted.clone())),
            )
            .is_ok()
        );
        assert_eq!(
            validate_service_response_value(
                &target,
                wit::DataValue::Scalar(wit::ScalarValue::StringValue(rejected.clone())),
            ),
            Err(PluginCallbackError::OperationTooLarge)
        );

        let (_, target, _) = service_boundary_fixture(DataKind::StringList);
        assert!(
            validate_service_response_value(&target, wit::DataValue::StringList(vec![accepted]),)
                .is_ok()
        );
        assert_eq!(
            validate_service_response_value(&target, wit::DataValue::StringList(vec![rejected]),),
            Err(PluginCallbackError::OperationTooLarge)
        );
    }

    #[test]
    fn plugin_callback_service_call_validates_dependency_scope_schema_depth_and_cycles() {
        let grant = Permission {
            capability: Capability::ServicesConsume,
            scope: PermissionScope::Services(ServiceConsumeScope {
                services: vec![ServiceReference {
                    plugin_id: "target-plugin".to_owned(),
                    service_id: "lookup".to_owned(),
                }],
            }),
        };
        let mut state = callback_state_with_grants(vec![grant]);
        authority_plugin_mut(&mut state).manifest.dependencies = vec![Dependency {
            id: "target-plugin".to_owned(),
            requirement: "^1.0.0".to_owned(),
            services: vec!["lookup".to_owned()],
        }];
        let mut target = plugin(&[Capability::ServicesProvide]);
        target.plugin_id = PluginId::parse("target-plugin").expect("target id");
        target.manifest.id = target.plugin_id.to_string();
        target.manifest.name = "Target".to_owned();
        target.manifest.services = vec![ServiceDeclaration {
            id: "lookup".to_owned(),
            title: "Lookup".to_owned(),
            request: vec![ServiceField {
                id: "query".to_owned(),
                kind: DataKind::String,
                required: true,
            }],
            response: vec![ServiceField {
                id: "found".to_owned(),
                kind: DataKind::Boolean,
                required: true,
            }],
        }];
        let caller = state.authority.plugin().clone();
        let profile = InstalledPluginProfile {
            plugins: vec![caller.clone(), target.clone()],
            activation_order: vec![target.plugin_id.clone(), caller.plugin_id.clone()],
            community_policy: CommunityPluginPolicy {
                community_registry_enabled: false,
                updated_at: timestamp("2026-01-01T00:00:00Z"),
            },
        };
        let call = wit::ServiceCall {
            plugin_id: target.plugin_id.to_string(),
            service_id: "lookup".to_owned(),
            values: vec![wit::NamedValue {
                name: "query".to_owned(),
                value: wit::DataValue::Scalar(wit::ScalarValue::StringValue("term".to_owned())),
            }],
        };
        let validated = validate_service_call(
            &state,
            state.authority.callback.clone(),
            &profile,
            call.clone(),
        )
        .expect("validated service call");
        assert_eq!(validated.target_plugin_id, target.plugin_id);
        assert_eq!(validated.service_depth, 1);
        assert!(
            validate_service_response(
                &target,
                &PluginId::parse("lookup").expect("service id"),
                &wit::ServiceData {
                    values: vec![wit::NamedValue {
                        name: "found".to_owned(),
                        value: wit::DataValue::Scalar(wit::ScalarValue::BooleanValue(true)),
                    }],
                }
            )
            .is_ok()
        );

        let cycle_state = as_service_callback_state(&state, vec![target.plugin_id.clone()]);
        let mut cycle_profile = profile.clone();
        cycle_profile.plugins[0] = cycle_state.authority.plugin().clone();
        assert_eq!(
            validate_service_call(
                &cycle_state,
                cycle_state.authority.callback.clone(),
                &cycle_profile,
                call.clone()
            ),
            Err(PluginCallbackError::PermissionDenied)
        );
        let ancestors = (0..PLUGIN_SERVICE_DEPTH_MAX)
            .map(|index| PluginId::parse(format!("ancestor-{index}")).expect("ancestor id"))
            .collect();
        let depth_state = as_service_callback_state(&state, ancestors);
        let mut depth_profile = profile;
        depth_profile.plugins[0] = depth_state.authority.plugin().clone();
        assert_eq!(
            validate_service_call(
                &depth_state,
                depth_state.authority.callback.clone(),
                &depth_profile,
                call
            ),
            Err(PluginCallbackError::InvalidInput)
        );
    }

    #[test]
    fn plugin_callback_profile_fixture_is_self_consistent() {
        let plugin = plugin(&[Capability::TasksWrite]);
        let profile = InstalledPluginProfile {
            plugins: vec![plugin.clone()],
            activation_order: vec![plugin.plugin_id.clone()],
            community_policy: CommunityPluginPolicy {
                community_registry_enabled: false,
                updated_at: timestamp("2026-01-01T00:00:00Z"),
            },
        };
        assert_eq!(profile.plugins[0], plugin);
    }
}
