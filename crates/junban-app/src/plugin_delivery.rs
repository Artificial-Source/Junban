//! Runtime-local authority for one exact plugin invocation delivery.
//!
//! Delivery authority is deliberately not serializable or persisted. SQLite
//! stores only the final request hash derived from this authority.

use junban_domain::OperationId;
use junban_plugin_sdk::{
    InvocationKind, PluginId, SdkError, Sha256Digest, decode_invocation_request,
};

use crate::{
    CommittedEvent, PluginCursorPosition, PluginHookKind, PluginResyncSession, RepositoryError,
    plugin_resync_request_hash,
};

const DELIVERY_AUTHORITY_DOMAIN: &[u8] = b"junban.plugin.delivery-authority.v1\0";
const INVOCATION_REQUEST_DOMAIN: &[u8] = b"junban.plugin.invocation-request.v2\0";
const RETAINED_EVENT_PAYLOAD_DOMAIN: &[u8] = b"junban.plugin.retained-event-payload.v1\0";
const RETENTION_LOSS_HOST_SESSION_DOMAIN: &[u8] = b"junban.plugin.retention-loss-host-session.v1\0";
const RETENTION_LOSS_REQUEST_DOMAIN: &[u8] = b"junban.plugin.retention-loss-request.v1\0";
const INVALIDATING_EVENT_HOST_SESSION_DOMAIN: &[u8] =
    b"junban.plugin.invalidating-event-host-session.v1\0";
const INVALIDATING_EVENT_REQUEST_DOMAIN: &[u8] = b"junban.plugin.invalidating-event-request.v1\0";
const INVALIDATING_EVENT_REQUEST_TAG: u8 = 0x00;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PluginDeliveryMode {
    StartingResync,
    StartingCatchUp,
    Active,
}

impl PluginDeliveryMode {
    const fn tag(self) -> u8 {
        match self {
            Self::StartingResync => 0x00,
            Self::StartingCatchUp => 0x01,
            Self::Active => 0x02,
        }
    }

    const fn admits(self, hook: PluginHookKind) -> bool {
        matches!(
            (self, hook),
            (Self::StartingResync, PluginHookKind::Resync)
                | (Self::StartingCatchUp, PluginHookKind::HandleEvent)
                | (
                    Self::Active,
                    PluginHookKind::InvokeCommand
                        | PluginHookKind::HandleEvent
                        | PluginHookKind::HandleSurfaceAction
                )
        )
    }
}

/// Exact runtime/session generation and payload bound to one dispatch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginDeliveryAuthority {
    pub plugin_id: PluginId,
    pub package_generation: u64,
    pub activation_epoch: u64,
    pub host_session_id: OperationId,
    pub invocation_id: OperationId,
    pub payload_sha256: Sha256Digest,
    pub mode: PluginDeliveryMode,
}

impl PluginDeliveryAuthority {
    fn validate(&self) -> Result<(), RepositoryError> {
        if self.package_generation == 0 || self.activation_epoch == 0 {
            return Err(RepositoryError::Conflict);
        }
        Ok(())
    }

    /// Hash the frozen v1 delivery-authority framing.
    pub fn digest(&self) -> Result<Sha256Digest, RepositoryError> {
        self.validate()?;
        let mut material = Vec::with_capacity(256);
        material.extend_from_slice(DELIVERY_AUTHORITY_DOMAIN);
        put_u64_text(&mut material, self.plugin_id.as_str())?;
        material.extend_from_slice(&self.package_generation.to_be_bytes());
        material.extend_from_slice(&self.activation_epoch.to_be_bytes());
        put_u64_text(&mut material, &self.host_session_id.to_string())?;
        put_u64_text(&mut material, &self.invocation_id.to_string())?;
        material.extend_from_slice(&digest_bytes(&self.payload_sha256));
        material.push(self.mode.tag());
        Ok(Sha256Digest::of(&material))
    }
}

/// Durable identity and request hash against which storage verifies a delivery.
#[derive(Clone, Copy, Debug)]
pub struct PluginInvocationDeliveryCheck<'a> {
    pub operation_id: OperationId,
    pub plugin_id: &'a PluginId,
    pub package_generation: u64,
    pub activation_epoch: u64,
    pub hook: PluginHookKind,
    pub persisted_entry_id: &'a PluginId,
    pub stored_request_sha256: &'a Sha256Digest,
}

/// Exact retained source bound to one represented event delivery.
///
/// This parent-owned material is deliberately not serializable and is never
/// persisted inside the frozen [`PluginDeliveryAuthority`]. Storage reloads
/// the retained event and rechecks every field at each durable boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginRetainedEventSource {
    pub source_revision: u64,
    pub event_content_sha256: Sha256Digest,
    pub expected_cursor: PluginCursorPosition,
    pub next_cursor: PluginCursorPosition,
    private_body: Vec<u8>,
}

impl PluginRetainedEventSource {
    pub fn new(
        event: &CommittedEvent,
        expected_cursor: PluginCursorPosition,
        next_cursor: PluginCursorPosition,
        private_body: Vec<u8>,
    ) -> Result<Self, RepositoryError> {
        let source = Self {
            source_revision: event.revision,
            event_content_sha256: plugin_committed_event_content_hash(event)?,
            expected_cursor,
            next_cursor,
            private_body,
        };
        source.validate_position()?;
        Ok(source)
    }

    #[must_use]
    pub fn private_body(&self) -> &[u8] {
        &self.private_body
    }

    fn validate_position(&self) -> Result<(), RepositoryError> {
        if self.source_revision == 0
            || self.source_revision > i64::MAX as u64
            || self.expected_cursor.resync_required
            || self.next_cursor.resync_required
            || self.expected_cursor.event_epoch != self.next_cursor.event_epoch
            || self.next_cursor.revision != self.source_revision
            || self
                .expected_cursor
                .revision
                .checked_add(1)
                .is_none_or(|revision| revision != self.source_revision)
        {
            return Err(RepositoryError::Conflict);
        }
        Ok(())
    }

    fn verify_payload(
        &self,
        authority: &PluginDeliveryAuthority,
        persisted_entry_id: &PluginId,
    ) -> Result<(), RepositoryError> {
        self.validate_position()?;
        let request = decode_invocation_request(InvocationKind::HandleEvent, &self.private_body)
            .map_err(|_| RepositoryError::Conflict)?;
        let junban_plugin_sdk::InvocationRequest::HandleEvent(payload) = request else {
            return Err(RepositoryError::Conflict);
        };
        let event = payload.argument();
        if event.revision != self.source_revision
            || event.event_epoch != self.expected_cursor.event_epoch.as_str()
        {
            return Err(RepositoryError::Conflict);
        }
        let expected = plugin_retained_event_payload_hash(
            &self.event_content_sha256,
            persisted_entry_id.as_str(),
            &self.private_body,
        )?;
        if authority.payload_sha256 != expected {
            return Err(RepositoryError::Conflict);
        }
        Ok(())
    }
}

/// Authority and final hash carried unchanged through every durable stage.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginInvocationDelivery {
    pub authority: PluginDeliveryAuthority,
    pub persisted_entry_id: PluginId,
    pub request_sha256: Sha256Digest,
    pub retained_event_source: Option<PluginRetainedEventSource>,
}

impl PluginInvocationDelivery {
    /// Construct a non-event delivery. `HandleEvent` is rejected because its
    /// exact retained source must be supplied with [`Self::for_retained_event`].
    pub fn new(
        authority: PluginDeliveryAuthority,
        hook: PluginHookKind,
        persisted_entry_id: PluginId,
    ) -> Result<Self, RepositoryError> {
        Self::new_with_source(authority, hook, persisted_entry_id, None)
    }

    pub fn for_retained_event(
        authority: PluginDeliveryAuthority,
        persisted_entry_id: PluginId,
        source: PluginRetainedEventSource,
    ) -> Result<Self, RepositoryError> {
        Self::new_with_source(
            authority,
            PluginHookKind::HandleEvent,
            persisted_entry_id,
            Some(source),
        )
    }

    fn new_with_source(
        authority: PluginDeliveryAuthority,
        hook: PluginHookKind,
        persisted_entry_id: PluginId,
        retained_event_source: Option<PluginRetainedEventSource>,
    ) -> Result<Self, RepositoryError> {
        if !authority.mode.admits(hook) {
            return Err(RepositoryError::Conflict);
        }
        let request_sha256 =
            plugin_invocation_request_hash(hook, &persisted_entry_id, &authority.digest()?)?;
        let delivery = Self {
            authority,
            persisted_entry_id,
            request_sha256,
            retained_event_source,
        };
        delivery.verify_source(hook)?;
        Ok(delivery)
    }

    #[must_use]
    pub fn retained_event_source(&self) -> Option<&PluginRetainedEventSource> {
        self.retained_event_source.as_ref()
    }

    fn verify_source(&self, hook: PluginHookKind) -> Result<(), RepositoryError> {
        let event_delivery = hook == PluginHookKind::HandleEvent
            && matches!(
                self.authority.mode,
                PluginDeliveryMode::StartingCatchUp | PluginDeliveryMode::Active
            );
        if event_delivery != self.retained_event_source.is_some() {
            return Err(RepositoryError::Conflict);
        }
        if let Some(source) = &self.retained_event_source {
            source.verify_payload(&self.authority, &self.persisted_entry_id)?;
        }
        Ok(())
    }

    pub fn verify(&self, check: PluginInvocationDeliveryCheck<'_>) -> Result<(), RepositoryError> {
        self.verify_source(check.hook)?;
        if self.authority.invocation_id != check.operation_id
            || &self.authority.plugin_id != check.plugin_id
            || self.authority.package_generation != check.package_generation
            || self.authority.activation_epoch != check.activation_epoch
            || !self.authority.mode.admits(check.hook)
            || &self.persisted_entry_id != check.persisted_entry_id
            || &self.request_sha256 != check.stored_request_sha256
            || plugin_invocation_request_hash(
                check.hook,
                check.persisted_entry_id,
                &self.authority.digest()?,
            )? != self.request_sha256
        {
            return Err(RepositoryError::Conflict);
        }
        Ok(())
    }
}

/// Stable idempotency identity for an operator command or surface action.
///
/// It intentionally excludes runtime generation, activation epoch, host
/// session, invocation fence, and HTTP delivery identity. The payload digest is
/// over the exact canonical private body used to construct delivery authority.
#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct PluginOperatorRequestIdentity {
    pub operation_id: OperationId,
    pub plugin_id: PluginId,
    pub hook_kind: PluginHookKind,
    pub persisted_entry_id: PluginId,
    pub payload_sha256: Sha256Digest,
}

impl PluginOperatorRequestIdentity {
    pub fn new(
        operation_id: OperationId,
        plugin_id: PluginId,
        hook_kind: PluginHookKind,
        persisted_entry_id: PluginId,
        payload_sha256: Sha256Digest,
    ) -> Result<Self, RepositoryError> {
        let identity = Self {
            operation_id,
            plugin_id,
            hook_kind,
            persisted_entry_id,
            payload_sha256,
        };
        identity.validate()?;
        Ok(identity)
    }

    pub fn from_canonical_private_body(
        operation_id: OperationId,
        plugin_id: PluginId,
        hook_kind: PluginHookKind,
        persisted_entry_id: PluginId,
        body_entry_id: &str,
        private_body: &[u8],
    ) -> Result<Self, RepositoryError> {
        let kind = match hook_kind {
            PluginHookKind::InvokeCommand => InvocationKind::InvokeCommand,
            PluginHookKind::HandleSurfaceAction => InvocationKind::HandleSurfaceAction,
            _ => return Err(RepositoryError::Conflict),
        };
        let payload_sha256 =
            plugin_canonical_invocation_body_hash(kind, Some(body_entry_id), private_body)
                .map_err(|_| RepositoryError::Conflict)?;
        Self::new(
            operation_id,
            plugin_id,
            hook_kind,
            persisted_entry_id,
            payload_sha256,
        )
    }

    pub fn validate(&self) -> Result<(), RepositoryError> {
        if !matches!(
            self.hook_kind,
            PluginHookKind::InvokeCommand | PluginHookKind::HandleSurfaceAction
        ) {
            return Err(RepositoryError::Conflict);
        }
        Ok(())
    }
}

/// Fresh runtime fence for one SQLite-proven retained-event gap.
///
/// The raw host-session UUID is intentionally nonserializable and is redacted
/// from debug output. Trusted server composition must still exact-match it to
/// the actor's current session before calling the application service; SQLite
/// cannot authenticate which process currently owns that runtime identity.
#[derive(Clone, Eq, PartialEq)]
pub struct PluginCursorRetentionLossAuthority {
    pub plugin_id: PluginId,
    pub package_generation: u64,
    pub activation_epoch: u64,
    pub host_session_id: OperationId,
    pub mode: PluginDeliveryMode,
}

impl std::fmt::Debug for PluginCursorRetentionLossAuthority {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PluginCursorRetentionLossAuthority")
            .field("plugin_id", &self.plugin_id)
            .field("package_generation", &self.package_generation)
            .field("activation_epoch", &self.activation_epoch)
            .field("host_session_id", &"<redacted>")
            .field("mode", &self.mode)
            .finish()
    }
}

impl PluginCursorRetentionLossAuthority {
    #[must_use]
    pub fn host_session_sha256(&self) -> Sha256Digest {
        let mut material = Vec::with_capacity(RETENTION_LOSS_HOST_SESSION_DOMAIN.len() + 16);
        material.extend_from_slice(RETENTION_LOSS_HOST_SESSION_DOMAIN);
        material.extend_from_slice(self.host_session_id.as_uuid().as_bytes());
        Sha256Digest::of(&material)
    }
}

/// One nonserialized request to enter a fresh resync after actual retention loss.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarkPluginRetentionLossRequest {
    pub operation_id: OperationId,
    pub authority: PluginCursorRetentionLossAuthority,
    pub expected_cursor: PluginCursorPosition,
}

impl MarkPluginRetentionLossRequest {
    pub fn validate(&self) -> Result<(), RepositoryError> {
        validate_retention_loss_digest_fields(
            self.authority.package_generation,
            self.authority.activation_epoch,
            self.authority.mode,
            &self.expected_cursor,
        )
    }

    pub fn digest(&self) -> Result<Sha256Digest, RepositoryError> {
        plugin_retention_loss_request_digest(
            self.operation_id,
            &self.authority.plugin_id,
            self.authority.package_generation,
            self.authority.activation_epoch,
            &self.authority.host_session_sha256(),
            self.authority.mode,
            &self.expected_cursor,
        )
    }
}

/// Rebuild the complete retention-loss request digest from receipt-safe fields.
///
/// Storage uses this to validate historical receipts without recovering or
/// persisting the raw process-local host-session UUID.
pub fn plugin_retention_loss_request_digest(
    operation_id: OperationId,
    plugin_id: &PluginId,
    package_generation: u64,
    activation_epoch: u64,
    host_session_sha256: &Sha256Digest,
    mode: PluginDeliveryMode,
    expected_cursor: &PluginCursorPosition,
) -> Result<Sha256Digest, RepositoryError> {
    validate_retention_loss_digest_fields(
        package_generation,
        activation_epoch,
        mode,
        expected_cursor,
    )?;
    let mut material = Vec::with_capacity(
        RETENTION_LOSS_REQUEST_DOMAIN.len()
            + 16
            + 8
            + plugin_id.as_str().len()
            + 8
            + 8
            + 32
            + 1
            + 8
            + expected_cursor.event_epoch.len()
            + 8
            + 1,
    );
    material.extend_from_slice(RETENTION_LOSS_REQUEST_DOMAIN);
    material.extend_from_slice(operation_id.as_uuid().as_bytes());
    put_u64_text(&mut material, plugin_id.as_str())?;
    material.extend_from_slice(&package_generation.to_be_bytes());
    material.extend_from_slice(&activation_epoch.to_be_bytes());
    material.extend_from_slice(&digest_bytes(host_session_sha256));
    material.push(mode.tag());
    put_u64_text(&mut material, &expected_cursor.event_epoch)?;
    material.extend_from_slice(&expected_cursor.revision.to_be_bytes());
    material.push(u8::from(expected_cursor.resync_required));
    Ok(Sha256Digest::of(&material))
}

fn validate_retention_loss_digest_fields(
    package_generation: u64,
    activation_epoch: u64,
    mode: PluginDeliveryMode,
    expected_cursor: &PluginCursorPosition,
) -> Result<(), RepositoryError> {
    if package_generation == 0
        || package_generation > i64::MAX as u64
        || activation_epoch == 0
        || activation_epoch > i64::MAX as u64
        || !matches!(
            mode,
            PluginDeliveryMode::StartingCatchUp | PluginDeliveryMode::Active
        )
        || expected_cursor.revision > i64::MAX as u64
        || expected_cursor.resync_required
    {
        return Err(RepositoryError::Conflict);
    }
    Ok(())
}

/// Fresh runtime fence for one exact retained event that requires a new resync.
#[derive(Clone, Eq, PartialEq)]
pub struct PluginInvalidatingEventAuthority {
    pub plugin_id: PluginId,
    pub package_generation: u64,
    pub activation_epoch: u64,
    pub host_session_id: OperationId,
    pub mode: PluginDeliveryMode,
}

impl std::fmt::Debug for PluginInvalidatingEventAuthority {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PluginInvalidatingEventAuthority")
            .field("plugin_id", &self.plugin_id)
            .field("package_generation", &self.package_generation)
            .field("activation_epoch", &self.activation_epoch)
            .field("host_session_id", &"<redacted>")
            .field("mode", &self.mode)
            .finish()
    }
}

impl PluginInvalidatingEventAuthority {
    #[must_use]
    pub fn host_session_sha256(&self) -> Sha256Digest {
        let mut material = Vec::with_capacity(INVALIDATING_EVENT_HOST_SESSION_DOMAIN.len() + 16);
        material.extend_from_slice(INVALIDATING_EVENT_HOST_SESSION_DOMAIN);
        material.extend_from_slice(self.host_session_id.as_uuid().as_bytes());
        Sha256Digest::of(&material)
    }
}

/// One nonserialized request to restart at a fresh resync for the exact next
/// retained event. Storage reloads and reclassifies that event before mutation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarkPluginInvalidatingEventRequest {
    pub operation_id: OperationId,
    pub authority: PluginInvalidatingEventAuthority,
    pub expected_cursor: PluginCursorPosition,
    pub source_revision: u64,
    pub event_content_sha256: Sha256Digest,
}

impl MarkPluginInvalidatingEventRequest {
    pub fn validate(&self) -> Result<(), RepositoryError> {
        validate_invalidating_event_digest_fields(
            self.authority.package_generation,
            self.authority.activation_epoch,
            self.authority.mode,
            &self.expected_cursor,
            self.source_revision,
        )
    }

    pub fn digest(&self) -> Result<Sha256Digest, RepositoryError> {
        plugin_invalidating_event_request_digest(
            self.operation_id,
            &self.authority.plugin_id,
            self.authority.package_generation,
            self.authority.activation_epoch,
            &self.authority.host_session_sha256(),
            self.authority.mode,
            &self.expected_cursor,
            self.source_revision,
            &self.event_content_sha256,
        )
    }
}

/// Rebuild the complete invalidating-event digest from receipt-safe fields.
// Keeping every framed authority field explicit makes receipt validation auditable.
#[allow(clippy::too_many_arguments)]
pub fn plugin_invalidating_event_request_digest(
    operation_id: OperationId,
    plugin_id: &PluginId,
    package_generation: u64,
    activation_epoch: u64,
    host_session_sha256: &Sha256Digest,
    mode: PluginDeliveryMode,
    expected_cursor: &PluginCursorPosition,
    source_revision: u64,
    event_content_sha256: &Sha256Digest,
) -> Result<Sha256Digest, RepositoryError> {
    validate_invalidating_event_digest_fields(
        package_generation,
        activation_epoch,
        mode,
        expected_cursor,
        source_revision,
    )?;
    let mut material = Vec::with_capacity(
        INVALIDATING_EVENT_REQUEST_DOMAIN.len()
            + 1
            + 16
            + 8
            + plugin_id.as_str().len()
            + 8
            + 8
            + 32
            + 1
            + 8
            + expected_cursor.event_epoch.len()
            + 8
            + 1
            + 8
            + 32,
    );
    material.extend_from_slice(INVALIDATING_EVENT_REQUEST_DOMAIN);
    material.push(INVALIDATING_EVENT_REQUEST_TAG);
    material.extend_from_slice(operation_id.as_uuid().as_bytes());
    put_u64_text(&mut material, plugin_id.as_str())?;
    material.extend_from_slice(&package_generation.to_be_bytes());
    material.extend_from_slice(&activation_epoch.to_be_bytes());
    material.extend_from_slice(&digest_bytes(host_session_sha256));
    material.push(mode.tag());
    put_u64_text(&mut material, &expected_cursor.event_epoch)?;
    material.extend_from_slice(&expected_cursor.revision.to_be_bytes());
    material.push(u8::from(expected_cursor.resync_required));
    material.extend_from_slice(&source_revision.to_be_bytes());
    material.extend_from_slice(&digest_bytes(event_content_sha256));
    Ok(Sha256Digest::of(&material))
}

fn validate_invalidating_event_digest_fields(
    package_generation: u64,
    activation_epoch: u64,
    mode: PluginDeliveryMode,
    expected_cursor: &PluginCursorPosition,
    source_revision: u64,
) -> Result<(), RepositoryError> {
    validate_retention_loss_digest_fields(
        package_generation,
        activation_epoch,
        mode,
        expected_cursor,
    )?;
    if source_revision == 0
        || source_revision > i64::MAX as u64
        || expected_cursor
            .revision
            .checked_add(1)
            .is_none_or(|next| next != source_revision)
    {
        return Err(RepositoryError::Conflict);
    }
    Ok(())
}

/// Runtime classification presented to the verified cursor-only skip path.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PluginRetainedEventClassification {
    Represented,
    Irrelevant,
    Invalidating,
}

/// Fresh runtime fence for one cursor-only retained-event decision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginCursorSkipAuthority {
    pub plugin_id: PluginId,
    pub package_generation: u64,
    pub activation_epoch: u64,
    pub host_session_id: OperationId,
    pub mode: PluginDeliveryMode,
}

/// One nonserialized request to skip exactly one verified irrelevant event.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedPluginCursorSkipRequest {
    pub authority: PluginCursorSkipAuthority,
    pub source_revision: u64,
    pub event_content_sha256: Sha256Digest,
    pub expected_cursor: PluginCursorPosition,
    pub next_cursor: PluginCursorPosition,
    pub classification: PluginRetainedEventClassification,
}

impl VerifiedPluginCursorSkipRequest {
    pub fn validate(&self) -> Result<(), RepositoryError> {
        if self.authority.package_generation == 0
            || self.authority.activation_epoch == 0
            || !matches!(
                self.authority.mode,
                PluginDeliveryMode::StartingCatchUp | PluginDeliveryMode::Active
            )
            || self.classification != PluginRetainedEventClassification::Irrelevant
            || self.source_revision == 0
            || self.source_revision > i64::MAX as u64
            || self.expected_cursor.resync_required
            || self.next_cursor.resync_required
            || self.expected_cursor.event_epoch != self.next_cursor.event_epoch
            || self.next_cursor.revision != self.source_revision
            || self
                .expected_cursor
                .revision
                .checked_add(1)
                .is_none_or(|revision| revision != self.source_revision)
        {
            return Err(RepositoryError::Conflict);
        }
        Ok(())
    }
}

/// Decode an exact closed private invocation body and hash its canonical bytes.
pub fn plugin_canonical_invocation_body_hash(
    kind: InvocationKind,
    expected_entry_id: Option<&str>,
    body: &[u8],
) -> Result<Sha256Digest, SdkError> {
    let request = decode_invocation_request(kind, body)?;
    if request.entry_id() != expected_entry_id {
        return Err(SdkError::Protocol {
            field: "body entry id",
        });
    }
    Ok(Sha256Digest::of(body))
}

/// Canonical content identity of one typed retained event envelope.
pub fn plugin_committed_event_content_hash(
    event: &CommittedEvent,
) -> Result<Sha256Digest, RepositoryError> {
    let bytes =
        serde_json::to_vec(event).map_err(|error| RepositoryError::Storage(error.to_string()))?;
    Ok(Sha256Digest::of(&bytes))
}

/// Bind one retained event's canonical content and exact private event body.
pub fn plugin_retained_event_payload_hash(
    event_content_sha256: &Sha256Digest,
    expected_entry_id: &str,
    private_body: &[u8],
) -> Result<Sha256Digest, RepositoryError> {
    plugin_canonical_invocation_body_hash(
        InvocationKind::HandleEvent,
        Some(expected_entry_id),
        private_body,
    )
    .map_err(|_| RepositoryError::Conflict)?;
    let body_len = u32::try_from(private_body.len()).map_err(|_| RepositoryError::Conflict)?;
    let mut material =
        Vec::with_capacity(RETAINED_EVENT_PAYLOAD_DOMAIN.len() + 32 + 4 + private_body.len());
    material.extend_from_slice(RETAINED_EVENT_PAYLOAD_DOMAIN);
    material.extend_from_slice(&digest_bytes(event_content_sha256));
    material.extend_from_slice(&body_len.to_be_bytes());
    material.extend_from_slice(private_body);
    Ok(Sha256Digest::of(&material))
}

/// Existing resync-session request identity used as the delivery payload digest.
#[must_use]
pub fn plugin_resync_payload_hash(session: &PluginResyncSession) -> Sha256Digest {
    plugin_resync_request_hash(session)
}

/// Hash the exact final v2 invocation request framing persisted in schema v7.
pub fn plugin_invocation_request_hash(
    hook: PluginHookKind,
    persisted_entry_id: &PluginId,
    delivery_authority_sha256: &Sha256Digest,
) -> Result<Sha256Digest, RepositoryError> {
    let entry_len =
        u64::try_from(persisted_entry_id.as_str().len()).map_err(|_| RepositoryError::Conflict)?;
    let mut material = Vec::with_capacity(
        INVOCATION_REQUEST_DOMAIN.len() + 1 + 8 + persisted_entry_id.as_str().len() + 32,
    );
    material.extend_from_slice(INVOCATION_REQUEST_DOMAIN);
    material.push(match hook {
        PluginHookKind::InvokeCommand => 0x00,
        PluginHookKind::HandleEvent => 0x01,
        PluginHookKind::HandleSurfaceAction => 0x02,
        PluginHookKind::Resync => 0x03,
    });
    material.extend_from_slice(&entry_len.to_be_bytes());
    material.extend_from_slice(persisted_entry_id.as_str().as_bytes());
    material.extend_from_slice(&digest_bytes(delivery_authority_sha256));
    Ok(Sha256Digest::of(&material))
}

fn put_u64_text(material: &mut Vec<u8>, value: &str) -> Result<(), RepositoryError> {
    let len = u64::try_from(value.len()).map_err(|_| RepositoryError::Conflict)?;
    material.extend_from_slice(&len.to_be_bytes());
    material.extend_from_slice(value.as_bytes());
    Ok(())
}

fn digest_bytes(digest: &Sha256Digest) -> [u8; 32] {
    fn nibble(byte: u8) -> u8 {
        match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            _ => unreachable!("Sha256Digest guarantees canonical lowercase hex"),
        }
    }

    let encoded = digest.as_str().as_bytes();
    let mut bytes = [0_u8; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = (nibble(encoded[index * 2]) << 4) | nibble(encoded[index * 2 + 1]);
    }
    bytes
}

#[cfg(test)]
mod tests {
    use jiff::Timestamp;
    use junban_domain::OperationId;
    use junban_plugin_sdk::{InvocationKind, PluginId, Sha256Digest};

    use super::*;
    use crate::{AffectedIds, EventType, ResyncScope};

    fn operation(value: &str) -> OperationId {
        OperationId::parse(value).unwrap()
    }

    fn authority(mode: PluginDeliveryMode) -> PluginDeliveryAuthority {
        PluginDeliveryAuthority {
            plugin_id: PluginId::parse("delivery-test").unwrap(),
            package_generation: 7,
            activation_epoch: 11,
            host_session_id: operation("70000000-0000-7000-8000-000000000001"),
            invocation_id: operation("70000000-0000-7000-8000-000000000002"),
            payload_sha256: Sha256Digest::of(b"payload"),
            mode,
        }
    }

    fn retention_loss_request() -> MarkPluginRetentionLossRequest {
        MarkPluginRetentionLossRequest {
            operation_id: operation("70000000-0000-7000-8000-000000000010"),
            authority: PluginCursorRetentionLossAuthority {
                plugin_id: PluginId::parse("retention-test").unwrap(),
                package_generation: 7,
                activation_epoch: 11,
                host_session_id: operation("70000000-0000-7000-8000-000000000011"),
                mode: PluginDeliveryMode::Active,
            },
            expected_cursor: PluginCursorPosition {
                event_epoch: "70000000-0000-7000-8000-000000000012".to_owned(),
                revision: 19,
                resync_required: false,
            },
        }
    }

    fn invalidating_event_request() -> MarkPluginInvalidatingEventRequest {
        MarkPluginInvalidatingEventRequest {
            operation_id: operation("70000000-0000-7000-8000-000000000020"),
            authority: PluginInvalidatingEventAuthority {
                plugin_id: PluginId::parse("invalidating-test").unwrap(),
                package_generation: 7,
                activation_epoch: 11,
                host_session_id: operation("70000000-0000-7000-8000-000000000021"),
                mode: PluginDeliveryMode::StartingCatchUp,
            },
            expected_cursor: PluginCursorPosition {
                event_epoch: "70000000-0000-7000-8000-000000000022".to_owned(),
                revision: 19,
                resync_required: false,
            },
            source_revision: 20,
            event_content_sha256: Sha256Digest::of(b"invalidating retained event"),
        }
    }

    #[test]
    fn retention_loss_authority_validates_and_redacts_the_runtime_session() {
        let request = retention_loss_request();
        request.validate().unwrap();
        assert!(!format!("{request:?}").contains(&request.authority.host_session_id.to_string()));

        let mut invalid = request.clone();
        invalid.authority.mode = PluginDeliveryMode::StartingResync;
        assert_eq!(invalid.validate().unwrap_err(), RepositoryError::Conflict);
        let mut invalid = request.clone();
        invalid.authority.package_generation = 0;
        assert_eq!(invalid.validate().unwrap_err(), RepositoryError::Conflict);
        let mut invalid = request.clone();
        invalid.authority.activation_epoch = 0;
        assert_eq!(invalid.validate().unwrap_err(), RepositoryError::Conflict);
        let mut invalid = request.clone();
        invalid.authority.activation_epoch = i64::MAX as u64 + 1;
        assert_eq!(invalid.validate().unwrap_err(), RepositoryError::Conflict);
        let mut invalid = request.clone();
        invalid.expected_cursor.revision = i64::MAX as u64 + 1;
        assert_eq!(invalid.validate().unwrap_err(), RepositoryError::Conflict);
        let mut invalid = request.clone();
        invalid.expected_cursor.resync_required = true;
        assert_eq!(invalid.validate().unwrap_err(), RepositoryError::Conflict);
    }

    #[test]
    fn retention_loss_request_digest_binds_every_field_with_frozen_framing() {
        let request = retention_loss_request();
        assert_eq!(
            request.authority.host_session_sha256().as_str(),
            "862073604fa26db438db93d79f6bfeb711785b194b1364c325a8043d04c581ff"
        );
        let digest = request.digest().unwrap();
        assert_eq!(
            digest.as_str(),
            "71668b1818798631b3ec7c5f219b83c745ce437c27ffcf1010dee4c28007c2a1"
        );
        assert_eq!(
            plugin_retention_loss_request_digest(
                request.operation_id,
                &request.authority.plugin_id,
                request.authority.package_generation,
                request.authority.activation_epoch,
                &request.authority.host_session_sha256(),
                request.authority.mode,
                &request.expected_cursor,
            )
            .unwrap(),
            digest
        );

        let mutations: [fn(&mut MarkPluginRetentionLossRequest); 8] = [
            |value| value.operation_id = OperationId::new(),
            |value| value.authority.plugin_id = PluginId::parse("changed").unwrap(),
            |value| value.authority.package_generation += 1,
            |value| value.authority.activation_epoch += 1,
            |value| value.authority.host_session_id = OperationId::new(),
            |value| value.authority.mode = PluginDeliveryMode::StartingCatchUp,
            |value| value.expected_cursor.event_epoch.push_str("-changed"),
            |value| value.expected_cursor.revision += 1,
        ];
        for mutate in mutations {
            let mut changed = request.clone();
            mutate(&mut changed);
            assert_ne!(changed.digest().unwrap(), digest);
        }
    }

    #[test]
    fn invalidating_event_digest_has_frozen_redacted_framing_and_binds_every_field() {
        let request = invalidating_event_request();
        request.validate().unwrap();
        assert!(!format!("{request:?}").contains(&request.authority.host_session_id.to_string()));
        assert_eq!(
            request.authority.host_session_sha256().as_str(),
            "13023e2e0720729de8919cd28d99b34b385bd6dff3a289759767b84ee1058c38"
        );
        let digest = request.digest().unwrap();
        assert_eq!(
            digest.as_str(),
            "bd051cda10a65d40d42ca6e80c56c4413e90d98c50046e167e7a0dd27e9df531"
        );
        assert_eq!(
            plugin_invalidating_event_request_digest(
                request.operation_id,
                &request.authority.plugin_id,
                request.authority.package_generation,
                request.authority.activation_epoch,
                &request.authority.host_session_sha256(),
                request.authority.mode,
                &request.expected_cursor,
                request.source_revision,
                &request.event_content_sha256,
            )
            .unwrap(),
            digest
        );

        let mutations: [fn(&mut MarkPluginInvalidatingEventRequest); 10] = [
            |value| value.operation_id = OperationId::new(),
            |value| value.authority.plugin_id = PluginId::parse("changed").unwrap(),
            |value| value.authority.package_generation += 1,
            |value| value.authority.activation_epoch += 1,
            |value| value.authority.host_session_id = OperationId::new(),
            |value| value.authority.mode = PluginDeliveryMode::Active,
            |value| value.expected_cursor.event_epoch.push_str("-changed"),
            |value| {
                value.expected_cursor.revision -= 1;
                value.source_revision -= 1;
            },
            |value| {
                value.source_revision += 1;
                value.expected_cursor.revision += 1;
            },
            |value| value.event_content_sha256 = Sha256Digest::of(b"changed"),
        ];
        for mutate in mutations {
            let mut changed = request.clone();
            mutate(&mut changed);
            assert_ne!(changed.digest().unwrap(), digest);
        }

        let invalid_mutations: [fn(&mut MarkPluginInvalidatingEventRequest); 3] = [
            |value| value.authority.mode = PluginDeliveryMode::StartingResync,
            |value| value.expected_cursor.resync_required = true,
            |value| value.source_revision = value.expected_cursor.revision + 2,
        ];
        for mutate in invalid_mutations {
            let mut invalid = request.clone();
            mutate(&mut invalid);
            assert_eq!(invalid.validate(), Err(RepositoryError::Conflict));
        }
    }

    #[test]
    fn canonical_private_bodies_cover_lifecycle_event_resync_and_service() {
        let bodies = [
            (
                InvocationKind::Activate,
                None,
                br#"{"tag":"activate","val":{"entry-id":null,"argument":null}}"#.as_slice(),
            ),
            (
                InvocationKind::HandleEvent,
                Some("event"),
                br#"{"tag":"handle-event","val":{"entry-id":"event","argument":{"event-epoch":"epoch","revision":7,"kind":"task-deleted","subject":{"tag":"deleted-task","val":"task-1"}}}}"#,
            ),
            (
                InvocationKind::Resync,
                Some("resync"),
                br#"{"tag":"resync","val":{"entry-id":"resync","argument":{"tag":"finalize","val":{"session-id":"session"}}}}"#,
            ),
            (
                InvocationKind::CallService,
                Some("service"),
                br#"{"tag":"call-service","val":{"entry-id":"service","argument":{"plugin-id":"dependency","service-id":"service","values":[]}}}"#,
            ),
        ];
        for (kind, expected_entry_id, body) in bodies {
            assert_eq!(
                plugin_canonical_invocation_body_hash(kind, expected_entry_id, body).unwrap(),
                Sha256Digest::of(body)
            );
        }
        let noncanonical = br#"{ "tag":"activate","val":{"entry-id":null,"argument":null}}"#;
        assert!(
            plugin_canonical_invocation_body_hash(InvocationKind::Activate, None, noncanonical)
                .is_err()
        );
        assert!(
            plugin_canonical_invocation_body_hash(
                InvocationKind::HandleEvent,
                Some("changed"),
                bodies[1].2,
            )
            .is_err()
        );
        assert!(
            plugin_canonical_invocation_body_hash(
                InvocationKind::Resync,
                Some("event"),
                bodies[1].2,
            )
            .is_err()
        );
    }

    #[test]
    fn delivery_payload_authority_and_final_request_hash_have_frozen_goldens() {
        let delivery = PluginInvocationDelivery::new(
            authority(PluginDeliveryMode::Active),
            PluginHookKind::InvokeCommand,
            PluginId::parse("run").unwrap(),
        )
        .unwrap();
        assert_eq!(
            delivery.authority.digest().unwrap().as_str(),
            "5d9dc033b5d7560300c54f63eea7407a06a84d9e677501c33762810e1f054da2"
        );
        assert_eq!(
            delivery.request_sha256.as_str(),
            "33f7022a26faea482cadc653de3727ace1d258c8eca930e20ca42791ba098be6"
        );

        let body = br#"{"tag":"handle-event","val":{"entry-id":"event","argument":{"event-epoch":"epoch","revision":7,"kind":"task-deleted","subject":{"tag":"deleted-task","val":"task-1"}}}}"#;
        let event = CommittedEvent {
            revision: 7,
            operation_id: operation("70000000-0000-7000-8000-000000000003"),
            event_type: EventType::new("task.deleted"),
            occurred_at: Timestamp::constant(1_800_000_000, 0),
            primary: None,
            snapshot: None,
            affected: AffectedIds::default(),
            resync: ResyncScope::TASKS,
        };
        let event_hash = plugin_committed_event_content_hash(&event).unwrap();
        assert_eq!(
            event_hash.as_str(),
            "42498920871534ff96a0e4b84fc43b8e30d2dc1d174588319dd34dded2271bfa"
        );
        assert_eq!(
            plugin_retained_event_payload_hash(&event_hash, "event", body)
                .unwrap()
                .as_str(),
            "48b0801f8275904836db68931060d52f17590dc72d557f93b8bde3636ea201be"
        );
    }

    #[test]
    fn every_delivery_input_and_mode_mismatch_fails_closed() {
        let operation_id = operation("70000000-0000-7000-8000-000000000002");
        let plugin_id = PluginId::parse("delivery-test").unwrap();
        let entry_id = PluginId::parse("run").unwrap();
        let delivery = PluginInvocationDelivery::new(
            authority(PluginDeliveryMode::Active),
            PluginHookKind::InvokeCommand,
            entry_id.clone(),
        )
        .unwrap();
        let check = |hook| PluginInvocationDeliveryCheck {
            operation_id,
            plugin_id: &plugin_id,
            package_generation: 7,
            activation_epoch: 11,
            hook,
            persisted_entry_id: &entry_id,
            stored_request_sha256: &delivery.request_sha256,
        };
        delivery
            .verify(check(PluginHookKind::InvokeCommand))
            .unwrap();

        let mutations: [fn(&mut PluginInvocationDelivery); 9] = [
            |value| value.authority.plugin_id = PluginId::parse("changed").unwrap(),
            |value| value.authority.package_generation += 1,
            |value| value.authority.activation_epoch += 1,
            |value| value.authority.host_session_id = OperationId::new(),
            |value| value.authority.invocation_id = OperationId::new(),
            |value| value.authority.payload_sha256 = Sha256Digest::of(b"changed"),
            |value| value.authority.mode = PluginDeliveryMode::StartingCatchUp,
            |value| value.persisted_entry_id = PluginId::parse("changed").unwrap(),
            |value| value.request_sha256 = Sha256Digest::of(b"changed"),
        ];
        for mutate in mutations {
            let mut changed = delivery.clone();
            mutate(&mut changed);
            assert!(
                changed
                    .verify(check(PluginHookKind::InvokeCommand))
                    .is_err()
            );
        }
        assert!(
            delivery
                .verify(check(PluginHookKind::HandleSurfaceAction))
                .is_err()
        );
        assert!(
            PluginInvocationDelivery::new(
                authority(PluginDeliveryMode::StartingResync),
                PluginHookKind::HandleEvent,
                PluginId::parse("event").unwrap(),
            )
            .is_err()
        );
        assert!(
            PluginInvocationDelivery::new(
                authority(PluginDeliveryMode::StartingCatchUp),
                PluginHookKind::Resync,
                PluginId::parse("resync").unwrap(),
            )
            .is_err()
        );
    }
}
