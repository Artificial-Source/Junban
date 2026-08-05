//! Typed canonical bodies for the private parent↔child protocol.
//!
//! These envelopes are not a guest ABI. `wit/plugin.wit` remains the only
//! public guest contract; the generated serde values here preserve that WIT
//! identity while the private protocol binds each body to one closed kind.

use std::io::Write;

use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::{
    AuthorityFence, CallbackFence, CapabilityReplyKind, ChildFrame, HostCallKind, InvocationKind,
    ParentFrame, SdkError,
    error::Result,
    private_body_types::{
        GuestActivateArgument, GuestActivateResult, GuestCallServiceArgument,
        GuestCallServiceResult, GuestDeactivateArgument, GuestDeactivateResult,
        GuestHandleEventArgument, GuestHandleEventResult, GuestHandleSurfaceActionArgument,
        GuestHandleSurfaceActionResult, GuestInvokeCommandArgument, GuestInvokeCommandResult,
        GuestRenderSurfaceArgument, GuestRenderSurfaceResult, GuestResyncArgument,
        GuestResyncResult, GuestValidateSettingsArgument, GuestValidateSettingsResult,
        HostClockMonotonicMsArguments, HostClockMonotonicMsResult, HostClockWallNowArguments,
        HostClockWallNowResult, HostHttpRequestArguments, HostHttpRequestResult,
        HostLogLogArguments, HostLogLogResult, HostProjectsQueryProjectsArguments,
        HostProjectsQueryProjectsResult, HostServicesCallServiceArguments,
        HostServicesCallServiceResult, HostSettingsGetSettingsArguments,
        HostSettingsGetSettingsResult, HostStorageGetKvArguments, HostStorageGetKvResult,
        HostStorageListKvArguments, HostStorageListKvResult, HostTagsQueryTagsArguments,
        HostTagsQueryTagsResult, HostTasksQueryTasksArguments, HostTasksQueryTasksResult, Id,
        InvocationContext, deserialize_present_option,
    },
    protocol::{
        HOST_CALLBACK_BODY_BYTES_MAX, HOST_OUTCOME_BODY_BYTES_MAX, HOST_REQUEST_BODY_BYTES_MAX,
        validate_child_frame, validate_parent_frame,
    },
    util::{hex, sha256},
};

/// One private invocation payload. Its option and unit argument are always
/// materialized in canonical JSON as `value-or-null` and explicit `null`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InvocationPayload<T> {
    #[serde(rename = "entry-id")]
    #[serde(deserialize_with = "deserialize_present_option")]
    entry_id: Option<Id>,
    #[serde(rename = "argument")]
    argument: T,
}

impl<T> InvocationPayload<T> {
    fn new(entry_id: Option<Id>, argument: T) -> Self {
        Self { entry_id, argument }
    }

    #[must_use]
    pub fn entry_id(&self) -> Option<&str> {
        self.entry_id.as_deref()
    }

    #[must_use]
    pub fn argument(&self) -> &T {
        &self.argument
    }

    #[must_use]
    pub fn into_parts(self) -> (Option<Id>, T) {
        (self.entry_id, self.argument)
    }
}

/// Exhaustive private request mapping for the nine guest exports.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "tag", content = "val", deny_unknown_fields)]
pub enum InvocationRequest {
    #[serde(rename = "activate")]
    Activate(InvocationPayload<GuestActivateArgument>),
    #[serde(rename = "deactivate")]
    Deactivate(InvocationPayload<GuestDeactivateArgument>),
    #[serde(rename = "invoke-command")]
    InvokeCommand(InvocationPayload<GuestInvokeCommandArgument>),
    #[serde(rename = "handle-event")]
    HandleEvent(Box<InvocationPayload<GuestHandleEventArgument>>),
    #[serde(rename = "render-surface")]
    RenderSurface(InvocationPayload<GuestRenderSurfaceArgument>),
    #[serde(rename = "handle-surface-action")]
    HandleSurfaceAction(InvocationPayload<GuestHandleSurfaceActionArgument>),
    #[serde(rename = "validate-settings")]
    ValidateSettings(InvocationPayload<GuestValidateSettingsArgument>),
    #[serde(rename = "resync")]
    Resync(InvocationPayload<GuestResyncArgument>),
    #[serde(rename = "call-service")]
    CallService(InvocationPayload<GuestCallServiceArgument>),
}

impl InvocationRequest {
    #[must_use]
    pub fn activate(entry_id: Option<Id>) -> Self {
        Self::Activate(InvocationPayload::new(entry_id, ()))
    }

    #[must_use]
    pub fn deactivate(entry_id: Option<Id>) -> Self {
        Self::Deactivate(InvocationPayload::new(entry_id, ()))
    }

    #[must_use]
    pub fn invoke_command(entry_id: Option<Id>, call: GuestInvokeCommandArgument) -> Self {
        Self::InvokeCommand(InvocationPayload::new(entry_id, call))
    }

    #[must_use]
    pub fn handle_event(entry_id: Option<Id>, event: GuestHandleEventArgument) -> Self {
        Self::HandleEvent(Box::new(InvocationPayload::new(entry_id, event)))
    }

    #[must_use]
    pub fn render_surface(entry_id: Option<Id>, request: GuestRenderSurfaceArgument) -> Self {
        Self::RenderSurface(InvocationPayload::new(entry_id, request))
    }

    #[must_use]
    pub fn handle_surface_action(
        entry_id: Option<Id>,
        action: GuestHandleSurfaceActionArgument,
    ) -> Self {
        Self::HandleSurfaceAction(InvocationPayload::new(entry_id, action))
    }

    #[must_use]
    pub fn validate_settings(entry_id: Option<Id>, values: GuestValidateSettingsArgument) -> Self {
        Self::ValidateSettings(InvocationPayload::new(entry_id, values))
    }

    #[must_use]
    pub fn resync(entry_id: Option<Id>, page: GuestResyncArgument) -> Self {
        Self::Resync(InvocationPayload::new(entry_id, page))
    }

    #[must_use]
    pub fn call_service(entry_id: Option<Id>, call: GuestCallServiceArgument) -> Self {
        Self::CallService(InvocationPayload::new(entry_id, call))
    }

    #[must_use]
    pub const fn kind(&self) -> InvocationKind {
        match self {
            Self::Activate(_) => InvocationKind::Activate,
            Self::Deactivate(_) => InvocationKind::Deactivate,
            Self::InvokeCommand(_) => InvocationKind::InvokeCommand,
            Self::HandleEvent(_) => InvocationKind::HandleEvent,
            Self::RenderSurface(_) => InvocationKind::RenderSurface,
            Self::HandleSurfaceAction(_) => InvocationKind::HandleSurfaceAction,
            Self::ValidateSettings(_) => InvocationKind::ValidateSettings,
            Self::Resync(_) => InvocationKind::Resync,
            Self::CallService(_) => InvocationKind::CallService,
        }
    }

    #[must_use]
    pub fn entry_id(&self) -> Option<&str> {
        match self {
            Self::Activate(payload) => payload.entry_id(),
            Self::Deactivate(payload) => payload.entry_id(),
            Self::InvokeCommand(payload) => payload.entry_id(),
            Self::HandleEvent(payload) => payload.entry_id(),
            Self::RenderSurface(payload) => payload.entry_id(),
            Self::HandleSurfaceAction(payload) => payload.entry_id(),
            Self::ValidateSettings(payload) => payload.entry_id(),
            Self::Resync(payload) => payload.entry_id(),
            Self::CallService(payload) => payload.entry_id(),
        }
    }

    /// Construct the exact WIT context from the parent-owned fence and the
    /// body-owned entry identity. The context itself carries no authority.
    pub fn context(&self, fence: &AuthorityFence) -> Result<InvocationContext> {
        fence.validate()?;
        Ok(InvocationContext {
            plugin_id: fence.plugin_id.clone(),
            package_generation: fence.package_generation,
            activation_epoch: fence.activation_epoch,
            host_session_id: fence.host_session_id.clone(),
            invocation_id: fence.invocation_id.clone(),
            entry_id: self.entry_id().map(str::to_owned),
        })
    }

    /// Build one kind-derived invoke header and its immutable canonical body.
    pub fn into_parent_message(
        self,
        fence: AuthorityFence,
        permission_hash: String,
    ) -> Result<TypedParentMessage> {
        let kind = self.kind();
        let body = encode_canonical(&self, HOST_REQUEST_BODY_BYTES_MAX)?;
        let frame = ParentFrame::Invoke {
            fence,
            kind,
            mode: kind.mode(),
            permission_hash,
            request_sha256: hex(&sha256(&body)),
            request_size: body_size(&body)?,
        };
        validate_parent_frame(&frame)?;
        Ok(TypedParentMessage { frame, body })
    }
}

/// Exhaustive private mapping of every guest result branch. Guest `err` values
/// remain outcomes; traps and runtime failures use `ChildFrame::Failed`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "tag", content = "val", deny_unknown_fields)]
pub enum InvocationOutcome {
    #[serde(rename = "activate")]
    Activate(GuestActivateResult),
    #[serde(rename = "deactivate")]
    Deactivate(GuestDeactivateResult),
    #[serde(rename = "invoke-command")]
    InvokeCommand(GuestInvokeCommandResult),
    #[serde(rename = "handle-event")]
    HandleEvent(GuestHandleEventResult),
    #[serde(rename = "render-surface")]
    RenderSurface(GuestRenderSurfaceResult),
    #[serde(rename = "handle-surface-action")]
    HandleSurfaceAction(GuestHandleSurfaceActionResult),
    #[serde(rename = "validate-settings")]
    ValidateSettings(GuestValidateSettingsResult),
    #[serde(rename = "resync")]
    Resync(GuestResyncResult),
    #[serde(rename = "call-service")]
    CallService(GuestCallServiceResult),
}

impl InvocationOutcome {
    #[must_use]
    pub const fn kind(&self) -> InvocationKind {
        match self {
            Self::Activate(_) => InvocationKind::Activate,
            Self::Deactivate(_) => InvocationKind::Deactivate,
            Self::InvokeCommand(_) => InvocationKind::InvokeCommand,
            Self::HandleEvent(_) => InvocationKind::HandleEvent,
            Self::RenderSurface(_) => InvocationKind::RenderSurface,
            Self::HandleSurfaceAction(_) => InvocationKind::HandleSurfaceAction,
            Self::ValidateSettings(_) => InvocationKind::ValidateSettings,
            Self::Resync(_) => InvocationKind::Resync,
            Self::CallService(_) => InvocationKind::CallService,
        }
    }

    /// Build one kind-derived outcome header and canonical result body.
    pub fn into_child_message(self, fence: AuthorityFence) -> Result<TypedChildMessage> {
        let kind = self.kind();
        let body = encode_canonical(&self, HOST_OUTCOME_BODY_BYTES_MAX)?;
        let frame = ChildFrame::Outcome {
            fence,
            kind,
            outcome_sha256: hex(&sha256(&body)),
            outcome_size: body_size(&body)?,
        };
        validate_child_frame(&frame)?;
        Ok(TypedChildMessage { frame, body })
    }
}

/// Exhaustive private mapping of every host import argument list.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "tag", content = "val", deny_unknown_fields)]
pub enum HostCallRequest {
    #[serde(rename = "query-tasks")]
    QueryTasks(HostTasksQueryTasksArguments),
    #[serde(rename = "query-projects")]
    QueryProjects(HostProjectsQueryProjectsArguments),
    #[serde(rename = "query-tags")]
    QueryTags(HostTagsQueryTagsArguments),
    #[serde(rename = "get-settings")]
    GetSettings(HostSettingsGetSettingsArguments),
    #[serde(rename = "get-kv")]
    GetKv(HostStorageGetKvArguments),
    #[serde(rename = "list-kv")]
    ListKv(HostStorageListKvArguments),
    #[serde(rename = "wall-now")]
    WallNow(HostClockWallNowArguments),
    #[serde(rename = "monotonic-ms")]
    MonotonicMs(HostClockMonotonicMsArguments),
    #[serde(rename = "http-request")]
    HttpRequest(HostHttpRequestArguments),
    #[serde(rename = "log")]
    Log(HostLogLogArguments),
    #[serde(rename = "call-service")]
    CallService(HostServicesCallServiceArguments),
}

impl HostCallRequest {
    #[must_use]
    pub const fn kind(&self) -> HostCallKind {
        match self {
            Self::QueryTasks(_) => HostCallKind::QueryTasks,
            Self::QueryProjects(_) => HostCallKind::QueryProjects,
            Self::QueryTags(_) => HostCallKind::QueryTags,
            Self::GetSettings(_) => HostCallKind::GetSettings,
            Self::GetKv(_) => HostCallKind::GetKv,
            Self::ListKv(_) => HostCallKind::ListKv,
            Self::WallNow(_) => HostCallKind::WallNow,
            Self::MonotonicMs(_) => HostCallKind::MonotonicMs,
            Self::HttpRequest(_) => HostCallKind::HttpRequest,
            Self::Log(_) => HostCallKind::Log,
            Self::CallService(_) => HostCallKind::CallService,
        }
    }

    /// Build one kind-derived callback request and canonical argument body.
    pub fn into_child_message(self, callback: CallbackFence) -> Result<TypedChildMessage> {
        let kind = self.kind();
        let body = encode_canonical(&self, HOST_CALLBACK_BODY_BYTES_MAX)?;
        let frame = ChildFrame::CapabilityRequest {
            callback,
            kind,
            request_sha256: hex(&sha256(&body)),
            request_size: body_size(&body)?,
        };
        validate_child_frame(&frame)?;
        Ok(TypedChildMessage { frame, body })
    }
}

/// Exhaustive private mapping of host successes, allowed typed errors, and
/// bodyless cancellation. Clock and log have no constructible error branch.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "tag", content = "val", deny_unknown_fields)]
pub enum HostCallReply {
    #[serde(rename = "query-tasks")]
    QueryTasks(HostTasksQueryTasksResult),
    #[serde(rename = "query-projects")]
    QueryProjects(HostProjectsQueryProjectsResult),
    #[serde(rename = "query-tags")]
    QueryTags(HostTagsQueryTagsResult),
    #[serde(rename = "get-settings")]
    GetSettings(HostSettingsGetSettingsResult),
    #[serde(rename = "get-kv")]
    GetKv(HostStorageGetKvResult),
    #[serde(rename = "list-kv")]
    ListKv(HostStorageListKvResult),
    #[serde(rename = "wall-now")]
    WallNow(HostClockWallNowResult),
    #[serde(rename = "monotonic-ms")]
    MonotonicMs(HostClockMonotonicMsResult),
    #[serde(rename = "http-request")]
    HttpRequest(HostHttpRequestResult),
    #[serde(rename = "log")]
    Log(HostLogLogResult),
    #[serde(rename = "call-service")]
    CallService(HostServicesCallServiceResult),
    #[serde(skip)]
    Cancelled(HostCallKind),
}

impl HostCallReply {
    #[must_use]
    pub const fn kind(&self) -> HostCallKind {
        match self {
            Self::QueryTasks(_) => HostCallKind::QueryTasks,
            Self::QueryProjects(_) => HostCallKind::QueryProjects,
            Self::QueryTags(_) => HostCallKind::QueryTags,
            Self::GetSettings(_) => HostCallKind::GetSettings,
            Self::GetKv(_) => HostCallKind::GetKv,
            Self::ListKv(_) => HostCallKind::ListKv,
            Self::WallNow(_) => HostCallKind::WallNow,
            Self::MonotonicMs(_) => HostCallKind::MonotonicMs,
            Self::HttpRequest(_) => HostCallKind::HttpRequest,
            Self::Log(_) => HostCallKind::Log,
            Self::CallService(_) => HostCallKind::CallService,
            Self::Cancelled(kind) => *kind,
        }
    }

    #[must_use]
    pub const fn branch(&self) -> CapabilityReplyKind {
        use crate::private_body_types::WitResult;

        match self {
            Self::QueryTasks(WitResult::Ok(_))
            | Self::QueryProjects(WitResult::Ok(_))
            | Self::QueryTags(WitResult::Ok(_))
            | Self::GetSettings(WitResult::Ok(_))
            | Self::GetKv(WitResult::Ok(_))
            | Self::ListKv(WitResult::Ok(_))
            | Self::HttpRequest(WitResult::Ok(_))
            | Self::CallService(WitResult::Ok(_))
            | Self::WallNow(_)
            | Self::MonotonicMs(_)
            | Self::Log(_) => CapabilityReplyKind::Success,
            Self::QueryTasks(WitResult::Err(_))
            | Self::QueryProjects(WitResult::Err(_))
            | Self::QueryTags(WitResult::Err(_))
            | Self::GetSettings(WitResult::Err(_))
            | Self::GetKv(WitResult::Err(_))
            | Self::ListKv(WitResult::Err(_))
            | Self::HttpRequest(WitResult::Err(_))
            | Self::CallService(WitResult::Err(_)) => CapabilityReplyKind::Error,
            Self::Cancelled(_) => CapabilityReplyKind::Cancelled,
        }
    }

    /// Build one kind/branch-derived callback reply. Cancellation is the sole
    /// callback reply with an empty body and binds the SHA-256 of empty bytes.
    pub fn into_parent_message(self, callback: CallbackFence) -> Result<TypedParentMessage> {
        let kind = self.kind();
        let result = self.branch();
        let body = if result == CapabilityReplyKind::Cancelled {
            Vec::new()
        } else {
            encode_canonical(&self, HOST_CALLBACK_BODY_BYTES_MAX)?
        };
        let frame = ParentFrame::CapabilityReply {
            callback,
            kind,
            result,
            response_sha256: hex(&sha256(&body)),
            response_size: body_size(&body)?,
        };
        validate_parent_frame(&frame)?;
        Ok(TypedParentMessage { frame, body })
    }
}

/// A typed constructor's inseparable parent header/body pair.
#[derive(Debug, Eq, PartialEq)]
pub struct TypedParentMessage {
    frame: ParentFrame,
    body: Vec<u8>,
}

impl TypedParentMessage {
    #[must_use]
    pub fn frame(&self) -> &ParentFrame {
        &self.frame
    }

    #[must_use]
    pub fn body(&self) -> &[u8] {
        &self.body
    }

    #[must_use]
    pub fn into_parts(self) -> (ParentFrame, Vec<u8>) {
        (self.frame, self.body)
    }
}

/// A typed constructor's inseparable child header/body pair.
#[derive(Debug, Eq, PartialEq)]
pub struct TypedChildMessage {
    frame: ChildFrame,
    body: Vec<u8>,
}

impl TypedChildMessage {
    #[must_use]
    pub fn frame(&self) -> &ChildFrame {
        &self.frame
    }

    #[must_use]
    pub fn body(&self) -> &[u8] {
        &self.body
    }

    #[must_use]
    pub fn into_parts(self) -> (ChildFrame, Vec<u8>) {
        (self.frame, self.body)
    }
}

/// Decode and exact-match one invocation request body to its header kind.
pub fn decode_invocation_request(kind: InvocationKind, body: &[u8]) -> Result<InvocationRequest> {
    let request: InvocationRequest = decode_canonical(body, HOST_REQUEST_BODY_BYTES_MAX)?;
    if request.kind() != kind {
        return Err(SdkError::Protocol { field: "body kind" });
    }
    Ok(request)
}

/// Decode and exact-match one guest outcome body to its header kind.
pub fn decode_invocation_outcome(kind: InvocationKind, body: &[u8]) -> Result<InvocationOutcome> {
    let outcome: InvocationOutcome = decode_canonical(body, HOST_OUTCOME_BODY_BYTES_MAX)?;
    if outcome.kind() != kind {
        return Err(SdkError::Protocol { field: "body kind" });
    }
    Ok(outcome)
}

/// Decode and exact-match one host-call request body to its header kind.
pub fn decode_host_call_request(kind: HostCallKind, body: &[u8]) -> Result<HostCallRequest> {
    let request: HostCallRequest = decode_canonical(body, HOST_CALLBACK_BODY_BYTES_MAX)?;
    if request.kind() != kind {
        return Err(SdkError::Protocol { field: "body kind" });
    }
    Ok(request)
}

/// Decode and exact-match one callback reply to its header kind and branch.
pub fn decode_host_call_reply(
    kind: HostCallKind,
    branch: CapabilityReplyKind,
    body: &[u8],
) -> Result<HostCallReply> {
    if branch == CapabilityReplyKind::Cancelled {
        if !body.is_empty() {
            return Err(SdkError::Protocol {
                field: "cancelled response body",
            });
        }
        return Ok(HostCallReply::Cancelled(kind));
    }
    let reply: HostCallReply = decode_canonical(body, HOST_CALLBACK_BODY_BYTES_MAX)?;
    if reply.kind() != kind {
        return Err(SdkError::Protocol { field: "body kind" });
    }
    if reply.branch() != branch {
        return Err(SdkError::Protocol {
            field: "body branch",
        });
    }
    Ok(reply)
}

fn encode_canonical<T: Serialize>(value: &T, maximum: usize) -> Result<Vec<u8>> {
    let mut writer = BoundedWriter::new(maximum);
    if serde_json::to_writer(&mut writer, value).is_err() {
        return Err(SdkError::Protocol {
            field: if writer.exceeded {
                "body length"
            } else {
                "body json"
            },
        });
    }
    if writer.bytes.is_empty() {
        return Err(SdkError::Protocol {
            field: "body length",
        });
    }
    Ok(writer.bytes)
}

fn decode_canonical<T>(body: &[u8], maximum: usize) -> Result<T>
where
    T: DeserializeOwned + Serialize,
{
    if body.is_empty() || body.len() > maximum {
        return Err(SdkError::Protocol {
            field: "body length",
        });
    }
    let value =
        serde_json::from_slice(body).map_err(|_| SdkError::Protocol { field: "body json" })?;
    if encode_canonical(&value, maximum)? != body {
        return Err(SdkError::Protocol {
            field: "canonical body",
        });
    }
    Ok(value)
}

fn body_size(body: &[u8]) -> Result<u32> {
    u32::try_from(body.len()).map_err(|_| SdkError::Protocol {
        field: "body length",
    })
}

struct BoundedWriter {
    bytes: Vec<u8>,
    maximum: usize,
    exceeded: bool,
}

impl BoundedWriter {
    fn new(maximum: usize) -> Self {
        Self {
            bytes: Vec::with_capacity(1024.min(maximum)),
            maximum,
            exceeded: false,
        }
    }
}

impl Write for BoundedWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let Some(next) = self.bytes.len().checked_add(buffer.len()) else {
            self.exceeded = true;
            return Err(std::io::Error::other("private body length overflow"));
        };
        if next > self.maximum {
            self.exceeded = true;
            return Err(std::io::Error::other("private body limit exceeded"));
        }
        self.bytes.extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
