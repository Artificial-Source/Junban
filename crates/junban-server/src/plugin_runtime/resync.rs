//! Bounded runtime-local resync traversal and transcript driver.
//!
//! The driver owns no product lifecycle. It samples one durable resync session,
//! drives the mandatory page/flush/finalize protocol, and consumes its compact
//! transcript through the existing authorized finalization seam.

use std::{future::Future, pin::Pin, sync::Arc};

use jiff::Timestamp;
use junban_app::{
    AppError, FinalizePluginResyncOutcome, FinalizePluginResyncRequest, PluginCursorPosition,
    PluginDeliveryAuthority, PluginDeliveryMode, PluginEventCursor, PluginHookKind,
    PluginInvocationDelivery, PluginResyncPage, PluginResyncPageRequest, PluginResyncSession,
    PluginResyncTranscript, PluginSnapshotKind, RepositoryError, plugin_resync_payload_hash,
};
use junban_domain::OperationId;
use junban_plugin_sdk::{
    AuthorityFence, Capability, ChildFrame, InvocationKind, InvocationOutcome, InvocationRequest,
    ParentFrame, Permission, PluginId, canonical_permission_hash, decode_invocation_outcome,
    private_body_types::{
        FinalKvChoice, FinalizeResync, FlushStagedKv, FlushState, ResyncPage, ResyncPageOutcome,
        SnapshotPage, SnapshotRecords, WitResult,
    },
    validate_child_body,
};

use crate::sse::AppService;

pub type PluginResyncFuture<T> =
    Pin<Box<dyn Future<Output = Result<T, PluginResyncDriverError>> + Send + 'static>>;

pub trait PluginResyncPort: Send + Sync + 'static {
    fn begin(
        &self,
        plugin_id: PluginId,
        package_generation: u64,
        activation_epoch: u64,
        operation_id: OperationId,
    ) -> PluginResyncFuture<PluginResyncSession>;
    fn page(&self, request: PluginResyncPageRequest) -> PluginResyncFuture<PluginResyncPage>;
    fn finalize(
        &self,
        request: FinalizePluginResyncRequest,
    ) -> PluginResyncFuture<FinalizePluginResyncOutcome>;
}

impl PluginResyncPort for AppService {
    fn begin(
        &self,
        plugin_id: PluginId,
        package_generation: u64,
        activation_epoch: u64,
        operation_id: OperationId,
    ) -> PluginResyncFuture<PluginResyncSession> {
        let service = self.clone();
        Box::pin(async move {
            service
                .open_plugin_resync_session(
                    plugin_id,
                    package_generation,
                    activation_epoch,
                    operation_id,
                    Timestamp::now(),
                )
                .await
                .map_err(map_app_error)
        })
    }

    fn page(&self, request: PluginResyncPageRequest) -> PluginResyncFuture<PluginResyncPage> {
        let service = self.clone();
        Box::pin(async move {
            service
                .list_plugin_resync_page(request, Timestamp::now())
                .await
                .map_err(map_app_error)
        })
    }

    fn finalize(
        &self,
        request: FinalizePluginResyncRequest,
    ) -> PluginResyncFuture<FinalizePluginResyncOutcome> {
        let service = self.clone();
        Box::pin(async move {
            service
                .finalize_plugin_resync(request, Timestamp::now())
                .await
                .map_err(map_app_error)
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PluginResyncLifecycle {
    Loaded,
    StartingResync,
    StartingCatchUp,
    ActivationBarrier,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PluginResyncDriverError {
    StaleAuthority,
    InvalidTraversal,
    InvalidOutcome,
    OperationTooLarge,
    Unavailable,
    RestartFreshHead,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginResyncInvocation {
    pub frame: ParentFrame,
    pub request: InvocationRequest,
    pub canonical_body: Vec<u8>,
    pub step_index: u32,
}

#[derive(Clone, Debug)]
enum PendingStep {
    Snapshot {
        page_request: Box<PluginResyncPageRequest>,
        page: Box<PluginResyncPage>,
        request_body: Vec<u8>,
    },
    Flush {
        request_body: Vec<u8>,
        request_index: u8,
    },
    Finalize {
        request_body: Vec<u8>,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DriverPhase {
    Snapshot(PluginSnapshotKind),
    Flush(u8),
    Finalize,
    ReadyToCommit,
    Consumed,
}

pub struct PluginResyncDriver {
    port: Arc<dyn PluginResyncPort>,
    delivery: PluginInvocationDelivery,
    permission_set_sha256: String,
    storage_granted: bool,
    session: PluginResyncSession,
    transcript: Option<PluginResyncTranscript>,
    lifecycle: PluginResyncLifecycle,
    phase: DriverPhase,
    after_id: Option<String>,
    pending: Option<PendingStep>,
    finalized_cursor: Option<PluginEventCursor>,
}

impl PluginResyncDriver {
    pub async fn begin(
        port: Arc<dyn PluginResyncPort>,
        plugin_id: PluginId,
        package_generation: u64,
        activation_epoch: u64,
        host_session_id: OperationId,
        operation_id: OperationId,
        grants: &[Permission],
    ) -> Result<Self, PluginResyncDriverError> {
        let permission_set_sha256 =
            canonical_permission_hash(grants).ok_or(PluginResyncDriverError::StaleAuthority)?;
        let storage_granted = grants
            .iter()
            .any(|grant| grant.capability == Capability::Storage);
        let session = port
            .begin(
                plugin_id.clone(),
                package_generation,
                activation_epoch,
                operation_id,
            )
            .await?;
        if session.plugin_id != plugin_id
            || session.package_generation != package_generation
            || session.activation_epoch != activation_epoch
            || session.operation_id != operation_id
        {
            return Err(PluginResyncDriverError::StaleAuthority);
        }
        let delivery = PluginInvocationDelivery::new(
            PluginDeliveryAuthority {
                plugin_id,
                package_generation,
                activation_epoch,
                host_session_id,
                invocation_id: operation_id,
                payload_sha256: plugin_resync_payload_hash(&session),
                mode: PluginDeliveryMode::StartingResync,
            },
            PluginHookKind::Resync,
            PluginId::parse("resync").map_err(|_| PluginResyncDriverError::Unavailable)?,
        )
        .map_err(map_repository_error)?;
        let transcript = PluginResyncTranscript::new(delivery.clone(), session.clone())
            .map_err(map_repository_error)?;
        Ok(Self {
            port,
            delivery,
            permission_set_sha256,
            storage_granted,
            session,
            transcript: Some(transcript),
            lifecycle: PluginResyncLifecycle::StartingResync,
            phase: DriverPhase::Snapshot(PluginSnapshotKind::Task),
            after_id: None,
            pending: None,
            finalized_cursor: None,
        })
    }

    #[must_use]
    pub const fn lifecycle(&self) -> PluginResyncLifecycle {
        self.lifecycle
    }

    #[must_use]
    pub fn session(&self) -> &PluginResyncSession {
        &self.session
    }

    #[must_use]
    pub fn delivery(&self) -> &PluginInvocationDelivery {
        &self.delivery
    }

    pub async fn next_invocation(
        &mut self,
    ) -> Result<PluginResyncInvocation, PluginResyncDriverError> {
        if self.pending.is_some() {
            return Err(PluginResyncDriverError::InvalidTraversal);
        }
        let step_index = self
            .transcript
            .as_ref()
            .ok_or(PluginResyncDriverError::RestartFreshHead)?
            .next_step_index();
        match self.phase {
            DriverPhase::Snapshot(kind) => {
                let page_request = PluginResyncPageRequest {
                    session: self.session.clone(),
                    kind,
                    after_id: self.after_id.clone(),
                };
                let page = self.port.page(page_request.clone()).await?;
                if page.operation_id != self.session.operation_id || page.kind != kind {
                    return Err(PluginResyncDriverError::StaleAuthority);
                }
                let request = snapshot_request(&self.session, &page, step_index)?;
                let (frame, body) = canonical_request_message(
                    &self.delivery,
                    &self.permission_set_sha256,
                    request.clone(),
                )?;
                self.pending = Some(PendingStep::Snapshot {
                    page_request: Box::new(page_request),
                    page: Box::new(page),
                    request_body: body.clone(),
                });
                Ok(PluginResyncInvocation {
                    frame,
                    request,
                    canonical_body: body,
                    step_index,
                })
            }
            DriverPhase::Flush(request_index) => {
                if request_index > 9 {
                    return Err(PluginResyncDriverError::InvalidTraversal);
                }
                let request = InvocationRequest::resync(
                    Some("resync".to_owned()),
                    ResyncPage::FlushStagedKv(FlushStagedKv {
                        session_id: self.session.operation_id.to_string(),
                        request_index,
                    }),
                );
                let (frame, body) = canonical_request_message(
                    &self.delivery,
                    &self.permission_set_sha256,
                    request.clone(),
                )?;
                self.pending = Some(PendingStep::Flush {
                    request_body: body.clone(),
                    request_index,
                });
                Ok(PluginResyncInvocation {
                    frame,
                    request,
                    canonical_body: body,
                    step_index,
                })
            }
            DriverPhase::Finalize => {
                let request = InvocationRequest::resync(
                    Some("resync".to_owned()),
                    ResyncPage::Finalize(FinalizeResync {
                        session_id: self.session.operation_id.to_string(),
                    }),
                );
                let (frame, body) = canonical_request_message(
                    &self.delivery,
                    &self.permission_set_sha256,
                    request.clone(),
                )?;
                self.pending = Some(PendingStep::Finalize {
                    request_body: body.clone(),
                });
                Ok(PluginResyncInvocation {
                    frame,
                    request,
                    canonical_body: body,
                    step_index,
                })
            }
            DriverPhase::ReadyToCommit | DriverPhase::Consumed => {
                Err(PluginResyncDriverError::InvalidTraversal)
            }
        }
    }

    pub fn accept_outcome(
        &mut self,
        frame: &ChildFrame,
        outcome_body: &[u8],
    ) -> Result<(), PluginResyncDriverError> {
        let expected = AuthorityFence {
            plugin_id: self.delivery.authority.plugin_id.to_string(),
            package_generation: self.delivery.authority.package_generation,
            activation_epoch: self.delivery.authority.activation_epoch,
            host_session_id: self.delivery.authority.host_session_id.to_string(),
            invocation_id: self.delivery.authority.invocation_id.to_string(),
        };
        let valid_frame = matches!(
            frame,
            ChildFrame::Outcome {
                fence,
                kind: InvocationKind::Resync,
                ..
            } if fence == &expected
        ) && validate_child_body(frame, outcome_body).is_ok();
        if !valid_frame {
            self.discard_runtime_material();
            return Err(PluginResyncDriverError::StaleAuthority);
        }
        let result = self.try_accept_outcome(outcome_body);
        if result.is_err() {
            self.discard_runtime_material();
        }
        result
    }

    fn try_accept_outcome(&mut self, outcome_body: &[u8]) -> Result<(), PluginResyncDriverError> {
        if self.pending.is_none() {
            return Err(PluginResyncDriverError::InvalidTraversal);
        }
        let outcome = decode_resync_outcome(outcome_body)?;
        if !self.storage_granted && resync_outcome_uses_storage(&outcome) {
            return Err(PluginResyncDriverError::InvalidOutcome);
        }
        let pending = self
            .pending
            .take()
            .ok_or(PluginResyncDriverError::InvalidTraversal)?;
        let transcript = self
            .transcript
            .as_mut()
            .ok_or(PluginResyncDriverError::RestartFreshHead)?;
        match (pending, outcome) {
            (
                PendingStep::Snapshot {
                    page_request,
                    page,
                    request_body,
                },
                ResyncPageOutcome::SnapshotAck(_),
            ) => {
                transcript
                    .record_snapshot(&page_request, &page, &request_body, outcome_body)
                    .map_err(map_repository_error)?;
                if page.exhausted {
                    self.after_id = None;
                    self.phase = match page.kind {
                        PluginSnapshotKind::Task => {
                            DriverPhase::Snapshot(PluginSnapshotKind::Project)
                        }
                        PluginSnapshotKind::Project => {
                            DriverPhase::Snapshot(PluginSnapshotKind::Tag)
                        }
                        PluginSnapshotKind::Tag => DriverPhase::Flush(0),
                    };
                } else {
                    self.after_id = page.next_after_id;
                }
                Ok(())
            }
            (
                PendingStep::Flush {
                    request_body,
                    request_index,
                },
                ResyncPageOutcome::FlushAck(ack),
            ) => {
                transcript
                    .record_flush(&request_body, outcome_body)
                    .map_err(map_repository_error)?;
                self.phase = match ack.state {
                    FlushState::Complete => DriverPhase::Finalize,
                    FlushState::More if request_index < 9 => DriverPhase::Flush(request_index + 1),
                    FlushState::More => return Err(PluginResyncDriverError::InvalidTraversal),
                };
                Ok(())
            }
            (PendingStep::Finalize { request_body }, ResyncPageOutcome::Finalized(_)) => {
                transcript
                    .record_finalize(&request_body, outcome_body)
                    .map_err(map_repository_error)?;
                self.phase = DriverPhase::ReadyToCommit;
                Ok(())
            }
            _ => Err(PluginResyncDriverError::InvalidOutcome),
        }
    }

    /// Consume the transcript into the exact one-transaction app/storage seam.
    fn authorized_finalization(
        &mut self,
    ) -> Result<FinalizePluginResyncRequest, PluginResyncDriverError> {
        if self.phase != DriverPhase::ReadyToCommit || self.pending.is_some() {
            return Err(PluginResyncDriverError::InvalidTraversal);
        }
        let transcript = self
            .transcript
            .take()
            .ok_or(PluginResyncDriverError::RestartFreshHead)?;
        let request = transcript
            .into_finalize_request()
            .map_err(map_repository_error)?;
        self.phase = DriverPhase::Consumed;
        Ok(request)
    }

    pub async fn finalize(
        &mut self,
    ) -> Result<FinalizePluginResyncOutcome, PluginResyncDriverError> {
        let request = self.authorized_finalization()?;
        match self.port.finalize(request).await {
            Ok(FinalizePluginResyncOutcome::Committed(cursor))
                if cursor.plugin_id == self.session.plugin_id
                    && cursor.event_epoch == self.session.snapshot_event_epoch
                    && cursor.revision == self.session.snapshot_revision
                    && !cursor.resync_required =>
            {
                self.finalized_cursor = Some(cursor.clone());
                self.lifecycle = PluginResyncLifecycle::StartingCatchUp;
                Ok(FinalizePluginResyncOutcome::Committed(cursor))
            }
            Ok(FinalizePluginResyncOutcome::Committed(_))
            | Ok(FinalizePluginResyncOutcome::RestartRequired) => {
                self.discard_runtime_material();
                Err(PluginResyncDriverError::RestartFreshHead)
            }
            Err(error) => {
                self.discard_runtime_material();
                Err(error)
            }
        }
    }

    /// Enter the activation barrier only after the caught-up cursor exact-matches
    /// the actor's sampled head and remains descended from the finalized head.
    pub fn enter_activation_barrier(
        &mut self,
        caught_up: &PluginEventCursor,
        sampled_head: &PluginCursorPosition,
    ) -> Result<(), PluginResyncDriverError> {
        let Some(finalized) = &self.finalized_cursor else {
            return Err(PluginResyncDriverError::InvalidTraversal);
        };
        if self.lifecycle != PluginResyncLifecycle::StartingCatchUp
            || caught_up.plugin_id != self.session.plugin_id
            || caught_up.resync_required
            || sampled_head.resync_required
            || caught_up.event_epoch != finalized.event_epoch
            || caught_up.revision < finalized.revision
            || caught_up.event_epoch != sampled_head.event_epoch
            || caught_up.revision != sampled_head.revision
        {
            return Err(PluginResyncDriverError::InvalidTraversal);
        }
        self.lifecycle = PluginResyncLifecycle::ActivationBarrier;
        Ok(())
    }

    /// Invalidating retained-tail authority discards all runtime-local material.
    /// A caller must sample a fresh head; no cursor advancement is exposed here.
    pub fn invalidate_retained_tail(&mut self) -> PluginResyncDriverError {
        self.discard_runtime_material();
        PluginResyncDriverError::RestartFreshHead
    }

    fn discard_runtime_material(&mut self) {
        self.pending = None;
        self.transcript = None;
        self.finalized_cursor = None;
        self.phase = DriverPhase::Consumed;
        self.lifecycle = PluginResyncLifecycle::Loaded;
    }
}

fn snapshot_request(
    session: &PluginResyncSession,
    page: &PluginResyncPage,
    page_index: u32,
) -> Result<InvocationRequest, PluginResyncDriverError> {
    let records = match page.kind {
        PluginSnapshotKind::Task => SnapshotRecords::Tasks(
            page.items
                .iter()
                .map(|item| match item {
                    junban_app::PluginSnapshotItem::Task(task) => {
                        junban_app::plugin_task_view(task, session.snapshot_revision)
                    }
                    _ => Err(junban_app::PluginQueryError::Unavailable),
                })
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| PluginResyncDriverError::StaleAuthority)?,
        ),
        PluginSnapshotKind::Project => SnapshotRecords::Projects(
            page.items
                .iter()
                .map(|item| match item {
                    junban_app::PluginSnapshotItem::Project(project) => {
                        junban_app::plugin_project_view(project, session.snapshot_revision)
                    }
                    _ => Err(junban_app::PluginQueryError::Unavailable),
                })
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| PluginResyncDriverError::StaleAuthority)?,
        ),
        PluginSnapshotKind::Tag => SnapshotRecords::Tags(
            page.items
                .iter()
                .map(|item| match item {
                    junban_app::PluginSnapshotItem::Tag(tag) => {
                        junban_app::plugin_tag_view(tag, session.snapshot_revision)
                    }
                    _ => Err(junban_app::PluginQueryError::Unavailable),
                })
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| PluginResyncDriverError::StaleAuthority)?,
        ),
    };
    Ok(InvocationRequest::resync(
        Some("resync".to_owned()),
        ResyncPage::Snapshot(SnapshotPage {
            session_id: session.operation_id.to_string(),
            event_epoch: session.snapshot_event_epoch.clone(),
            head_revision: session.snapshot_revision,
            kind: match page.kind {
                PluginSnapshotKind::Task => {
                    junban_plugin_sdk::private_body_types::ResourceKind::Task
                }
                PluginSnapshotKind::Project => {
                    junban_plugin_sdk::private_body_types::ResourceKind::Project
                }
                PluginSnapshotKind::Tag => junban_plugin_sdk::private_body_types::ResourceKind::Tag,
            },
            page_index,
            records,
            final_snapshot_page: page.kind == PluginSnapshotKind::Tag && page.exhausted,
        }),
    ))
}

fn canonical_request_message(
    delivery: &PluginInvocationDelivery,
    permission_set_sha256: &str,
    request: InvocationRequest,
) -> Result<(ParentFrame, Vec<u8>), PluginResyncDriverError> {
    let message = request
        .into_parent_message(
            AuthorityFence {
                plugin_id: delivery.authority.plugin_id.to_string(),
                package_generation: delivery.authority.package_generation,
                activation_epoch: delivery.authority.activation_epoch,
                host_session_id: delivery.authority.host_session_id.to_string(),
                invocation_id: delivery.authority.invocation_id.to_string(),
            },
            permission_set_sha256.to_owned(),
        )
        .map_err(|_| PluginResyncDriverError::OperationTooLarge)?;
    let (frame, body) = message.into_parts();
    if !matches!(
        frame,
        ParentFrame::Invoke {
            kind: InvocationKind::Resync,
            ..
        }
    ) {
        return Err(PluginResyncDriverError::InvalidTraversal);
    }
    Ok((frame, body))
}

fn resync_outcome_uses_storage(outcome: &ResyncPageOutcome) -> bool {
    match outcome {
        ResyncPageOutcome::SnapshotAck(ack) => ack
            .segment
            .as_ref()
            .is_some_and(|segment| !segment.operations.is_empty()),
        ResyncPageOutcome::FlushAck(ack) => ack
            .segment
            .as_ref()
            .is_some_and(|segment| !segment.operations.is_empty()),
        ResyncPageOutcome::Finalized(finalized) => {
            finalized.choice == FinalKvChoice::ReplaceKvWithStagedSegments
        }
    }
}

fn decode_resync_outcome(body: &[u8]) -> Result<ResyncPageOutcome, PluginResyncDriverError> {
    match decode_invocation_outcome(InvocationKind::Resync, body)
        .map_err(|_| PluginResyncDriverError::InvalidOutcome)?
    {
        InvocationOutcome::Resync(WitResult::Ok(outcome)) => Ok(outcome),
        _ => Err(PluginResyncDriverError::InvalidOutcome),
    }
}

pub(super) fn map_app_error(error: AppError) -> PluginResyncDriverError {
    match error {
        AppError::Conflict | AppError::NotFound => PluginResyncDriverError::StaleAuthority,
        AppError::OperationTooLarge => PluginResyncDriverError::OperationTooLarge,
        _ => PluginResyncDriverError::Unavailable,
    }
}

fn map_repository_error(error: RepositoryError) -> PluginResyncDriverError {
    match error {
        RepositoryError::Conflict => PluginResyncDriverError::InvalidTraversal,
        RepositoryError::OperationTooLarge => PluginResyncDriverError::OperationTooLarge,
        _ => PluginResyncDriverError::Unavailable,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use jiff::Timestamp;
    use junban_app::PluginSnapshotItem;
    use junban_domain::{Task, TaskId, TaskTitle};
    use junban_plugin_sdk::{
        Capability, PermissionScope, UnscopedPermission,
        private_body_types::{
            ByteList, FinalizedResync, FlushAck, KvOperation, KvSegment, KvSet, ResourceKind,
            SnapshotAck,
        },
    };

    fn operation(index: u64) -> OperationId {
        OperationId::parse(&format!("00000000-0000-4000-8000-{index:012}")).expect("operation")
    }

    #[derive(Clone)]
    struct FixturePort {
        session: PluginResyncSession,
        pages: Arc<Mutex<Vec<PluginSnapshotKind>>>,
        finalization: Arc<Mutex<Option<FinalizePluginResyncRequest>>>,
    }

    impl PluginResyncPort for FixturePort {
        fn begin(
            &self,
            _plugin_id: PluginId,
            _package_generation: u64,
            _activation_epoch: u64,
            _operation_id: OperationId,
        ) -> PluginResyncFuture<PluginResyncSession> {
            let session = self.session.clone();
            Box::pin(async move { Ok(session) })
        }

        fn page(&self, request: PluginResyncPageRequest) -> PluginResyncFuture<PluginResyncPage> {
            let mut pages = self.pages.lock().expect("pages");
            let first_task_page = request.kind == PluginSnapshotKind::Task
                && !pages.contains(&PluginSnapshotKind::Task);
            if first_task_page {
                assert_eq!(request.after_id, None);
            } else if request.kind == PluginSnapshotKind::Task {
                assert_eq!(
                    request.after_id.as_deref(),
                    Some("00000000-0000-4000-8000-000000000001")
                );
            }
            pages.push(request.kind);
            drop(pages);
            let (items, next_after_id, exhausted, material_bytes) = if first_task_page {
                let task = Task::new(
                    TaskId::parse("00000000-0000-4000-8000-000000000001").expect("task id"),
                    TaskTitle::new("Snapshot task").expect("task title"),
                    None,
                    "2026-01-01T00:00:00Z"
                        .parse::<Timestamp>()
                        .expect("timestamp"),
                    1,
                );
                (
                    vec![PluginSnapshotItem::Task(Box::new(task))],
                    Some("00000000-0000-4000-8000-000000000001".to_owned()),
                    false,
                    1,
                )
            } else {
                (Vec::new(), None, true, 0)
            };
            let page = PluginResyncPage {
                operation_id: request.session.operation_id,
                kind: request.kind,
                items,
                next_after_id,
                exhausted,
                material_bytes,
            };
            Box::pin(async move { Ok(page) })
        }

        fn finalize(
            &self,
            request: FinalizePluginResyncRequest,
        ) -> PluginResyncFuture<FinalizePluginResyncOutcome> {
            let cursor = PluginEventCursor {
                plugin_id: request.session.plugin_id.clone(),
                event_epoch: request.session.snapshot_event_epoch.clone(),
                revision: request.session.snapshot_revision,
                resync_required: false,
                updated_at: "2026-01-01T00:00:00Z"
                    .parse::<Timestamp>()
                    .expect("timestamp"),
            };
            *self.finalization.lock().expect("finalization") = Some(request);
            Box::pin(async move { Ok(FinalizePluginResyncOutcome::Committed(cursor)) })
        }
    }

    fn fixture() -> (Arc<FixturePort>, PluginResyncSession) {
        let session = PluginResyncSession {
            operation_id: operation(1),
            plugin_id: PluginId::parse("resync-plugin").expect("plugin id"),
            package_generation: 2,
            activation_epoch: 3,
            expected_cursor: PluginCursorPosition {
                event_epoch: "event-epoch".to_owned(),
                revision: 9,
                resync_required: true,
            },
            snapshot_event_epoch: "event-epoch".to_owned(),
            snapshot_revision: 12,
        };
        (
            Arc::new(FixturePort {
                session: session.clone(),
                pages: Arc::new(Mutex::new(Vec::new())),
                finalization: Arc::new(Mutex::new(None)),
            }),
            session,
        )
    }

    fn outcome_message(
        driver: &PluginResyncDriver,
        outcome: ResyncPageOutcome,
    ) -> (ChildFrame, Vec<u8>) {
        let message = InvocationOutcome::Resync(WitResult::Ok(outcome))
            .into_child_message(AuthorityFence {
                plugin_id: driver.delivery.authority.plugin_id.to_string(),
                package_generation: driver.delivery.authority.package_generation,
                activation_epoch: driver.delivery.authority.activation_epoch,
                host_session_id: driver.delivery.authority.host_session_id.to_string(),
                invocation_id: driver.delivery.authority.invocation_id.to_string(),
            })
            .expect("outcome message");
        message.into_parts()
    }

    fn resource(kind: PluginSnapshotKind) -> ResourceKind {
        match kind {
            PluginSnapshotKind::Task => ResourceKind::Task,
            PluginSnapshotKind::Project => ResourceKind::Project,
            PluginSnapshotKind::Tag => ResourceKind::Tag,
        }
    }

    fn storage_grant() -> Permission {
        Permission {
            capability: Capability::Storage,
            scope: PermissionScope::Unscoped(UnscopedPermission {}),
        }
    }

    async fn traverse_snapshots_without_kv_operations(
        driver: &mut PluginResyncDriver,
        session: &PluginResyncSession,
    ) {
        for (page_index, kind) in [
            PluginSnapshotKind::Task,
            PluginSnapshotKind::Task,
            PluginSnapshotKind::Project,
            PluginSnapshotKind::Tag,
        ]
        .into_iter()
        .enumerate()
        {
            let _invocation = driver.next_invocation().await.expect("snapshot");
            let (frame, body) = outcome_message(
                driver,
                ResyncPageOutcome::SnapshotAck(SnapshotAck {
                    session_id: session.operation_id.to_string(),
                    page_index: u32::try_from(page_index).expect("page index"),
                    kind: resource(kind),
                    segment: (page_index == 0).then_some(KvSegment {
                        operations: Vec::new(),
                    }),
                }),
            );
            driver
                .accept_outcome(&frame, &body)
                .expect("snapshot outcome");
        }
    }

    async fn complete_flush_without_segment(
        driver: &mut PluginResyncDriver,
        session: &PluginResyncSession,
    ) {
        let _flush = driver.next_invocation().await.expect("flush");
        let (frame, body) = outcome_message(
            driver,
            ResyncPageOutcome::FlushAck(FlushAck {
                session_id: session.operation_id.to_string(),
                request_index: 0,
                segment: None,
                state: FlushState::Complete,
            }),
        );
        driver.accept_outcome(&frame, &body).expect("flush outcome");
    }

    #[tokio::test]
    async fn plugin_resync_driver_traverses_task_project_tag_then_flush_and_finalize() {
        let (port, session) = fixture();
        let grants = [storage_grant()];
        let mut driver = PluginResyncDriver::begin(
            port.clone(),
            session.plugin_id.clone(),
            session.package_generation,
            session.activation_epoch,
            operation(2),
            session.operation_id,
            &grants,
        )
        .await
        .expect("driver");

        for (page_index, kind) in [
            PluginSnapshotKind::Task,
            PluginSnapshotKind::Task,
            PluginSnapshotKind::Project,
            PluginSnapshotKind::Tag,
        ]
        .into_iter()
        .enumerate()
        {
            let invocation = driver.next_invocation().await.expect("snapshot");
            assert!(matches!(
                invocation.request,
                InvocationRequest::Resync { .. }
            ));
            assert!(matches!(
                invocation.frame,
                ParentFrame::Invoke { permission_hash, .. }
                    if permission_hash == canonical_permission_hash(&grants).expect("permission hash")
            ));
            let (frame, body) = outcome_message(
                &driver,
                ResyncPageOutcome::SnapshotAck(SnapshotAck {
                    session_id: session.operation_id.to_string(),
                    page_index: u32::try_from(page_index).expect("page index"),
                    kind: resource(kind),
                    segment: None,
                }),
            );
            driver
                .accept_outcome(&frame, &body)
                .expect("snapshot outcome");
        }
        assert_eq!(
            *port.pages.lock().expect("pages"),
            vec![
                PluginSnapshotKind::Task,
                PluginSnapshotKind::Task,
                PluginSnapshotKind::Project,
                PluginSnapshotKind::Tag
            ]
        );

        let _flush = driver.next_invocation().await.expect("flush");
        let (frame, body) = outcome_message(
            &driver,
            ResyncPageOutcome::FlushAck(FlushAck {
                session_id: session.operation_id.to_string(),
                request_index: 0,
                segment: Some(KvSegment {
                    operations: vec![KvOperation::Set(KvSet {
                        key: "replacement".to_owned(),
                        value: ByteList::new(vec![1, 2, 3]).expect("replacement value"),
                    })],
                }),
                state: FlushState::Complete,
            }),
        );
        driver.accept_outcome(&frame, &body).expect("flush outcome");

        let _finalize = driver.next_invocation().await.expect("finalize");
        let (frame, body) = outcome_message(
            &driver,
            ResyncPageOutcome::Finalized(FinalizedResync {
                session_id: session.operation_id.to_string(),
                choice: FinalKvChoice::ReplaceKvWithStagedSegments,
            }),
        );
        driver
            .accept_outcome(&frame, &body)
            .expect("finalize outcome");
        let delivery = driver.delivery().clone();
        let outcome = driver.finalize().await.expect("final cursor CAS");
        let FinalizePluginResyncOutcome::Committed(cursor) = outcome else {
            panic!("expected committed resync");
        };
        assert_eq!(driver.lifecycle(), PluginResyncLifecycle::StartingCatchUp);
        assert_eq!(
            driver.enter_activation_barrier(
                &cursor,
                &PluginCursorPosition {
                    event_epoch: cursor.event_epoch.clone(),
                    revision: cursor.revision + 1,
                    resync_required: false,
                }
            ),
            Err(PluginResyncDriverError::InvalidTraversal)
        );
        let sampled_head = PluginCursorPosition::from(&cursor);
        driver
            .enter_activation_barrier(&cursor, &sampled_head)
            .expect("exact activation barrier");
        assert_eq!(driver.lifecycle(), PluginResyncLifecycle::ActivationBarrier);
        let request = port
            .finalization
            .lock()
            .expect("finalization")
            .clone()
            .expect("commit request");
        assert_eq!(request.session, session);
        assert_eq!(request.delivery, delivery);
        assert_eq!(request.transcript.snapshot_pages_by_kind(), [2, 1, 1]);
        assert_eq!(request.transcript.flush_requests(), 1);
        assert_eq!(request.transcript.finalize_count(), 1);
        assert_eq!(request.transcript.candidate_keys(), 1);
        assert_eq!(request.transcript.candidate_bytes(), 3);
        assert_eq!(
            request.transcript.replacement(),
            Some([("replacement".to_owned(), vec![1, 2, 3])].as_slice())
        );
        assert_ne!(
            request.transcript.transcript_sha256(),
            request.transcript.candidate_sha256()
        );
    }

    #[tokio::test]
    async fn plugin_resync_driver_without_storage_rejects_nonempty_segments() {
        let (port, session) = fixture();
        let mut driver = PluginResyncDriver::begin(
            port,
            session.plugin_id.clone(),
            session.package_generation,
            session.activation_epoch,
            operation(2),
            session.operation_id,
            &[],
        )
        .await
        .expect("driver");
        let _invocation = driver.next_invocation().await.expect("snapshot");
        let (frame, body) = outcome_message(
            &driver,
            ResyncPageOutcome::SnapshotAck(SnapshotAck {
                session_id: session.operation_id.to_string(),
                page_index: 0,
                kind: ResourceKind::Task,
                segment: Some(KvSegment {
                    operations: vec![KvOperation::Set(KvSet {
                        key: "unauthorized".to_owned(),
                        value: ByteList::new(vec![1]).expect("value"),
                    })],
                }),
            }),
        );
        assert_eq!(
            driver.accept_outcome(&frame, &body),
            Err(PluginResyncDriverError::InvalidOutcome)
        );
        assert_eq!(driver.lifecycle(), PluginResyncLifecycle::Loaded);

        let (port, session) = fixture();
        let mut driver = PluginResyncDriver::begin(
            port,
            session.plugin_id.clone(),
            session.package_generation,
            session.activation_epoch,
            operation(2),
            session.operation_id,
            &[],
        )
        .await
        .expect("driver");
        traverse_snapshots_without_kv_operations(&mut driver, &session).await;
        let _flush = driver.next_invocation().await.expect("flush");
        let (frame, body) = outcome_message(
            &driver,
            ResyncPageOutcome::FlushAck(FlushAck {
                session_id: session.operation_id.to_string(),
                request_index: 0,
                segment: Some(KvSegment {
                    operations: vec![KvOperation::Set(KvSet {
                        key: "unauthorized".to_owned(),
                        value: ByteList::new(vec![1]).expect("value"),
                    })],
                }),
                state: FlushState::Complete,
            }),
        );
        assert_eq!(
            driver.accept_outcome(&frame, &body),
            Err(PluginResyncDriverError::InvalidOutcome)
        );
        assert_eq!(driver.lifecycle(), PluginResyncLifecycle::Loaded);
    }

    #[tokio::test]
    async fn plugin_resync_driver_without_storage_rejects_replace() {
        let (port, session) = fixture();
        let mut driver = PluginResyncDriver::begin(
            port,
            session.plugin_id.clone(),
            session.package_generation,
            session.activation_epoch,
            operation(2),
            session.operation_id,
            &[],
        )
        .await
        .expect("driver");
        traverse_snapshots_without_kv_operations(&mut driver, &session).await;
        complete_flush_without_segment(&mut driver, &session).await;

        let _finalize = driver.next_invocation().await.expect("finalize");
        let (frame, body) = outcome_message(
            &driver,
            ResyncPageOutcome::Finalized(FinalizedResync {
                session_id: session.operation_id.to_string(),
                choice: FinalKvChoice::ReplaceKvWithStagedSegments,
            }),
        );
        assert_eq!(
            driver.accept_outcome(&frame, &body),
            Err(PluginResyncDriverError::InvalidOutcome)
        );
        assert_eq!(driver.lifecycle(), PluginResyncLifecycle::Loaded);
    }

    #[tokio::test]
    async fn plugin_resync_driver_without_storage_allows_empty_leave_traversal() {
        let (port, session) = fixture();
        let mut driver = PluginResyncDriver::begin(
            port.clone(),
            session.plugin_id.clone(),
            session.package_generation,
            session.activation_epoch,
            operation(2),
            session.operation_id,
            &[],
        )
        .await
        .expect("driver");
        traverse_snapshots_without_kv_operations(&mut driver, &session).await;
        complete_flush_without_segment(&mut driver, &session).await;

        let _finalize = driver.next_invocation().await.expect("finalize");
        let (frame, body) = outcome_message(
            &driver,
            ResyncPageOutcome::Finalized(FinalizedResync {
                session_id: session.operation_id.to_string(),
                choice: FinalKvChoice::LeaveKv,
            }),
        );
        driver.accept_outcome(&frame, &body).expect("leave outcome");
        assert!(matches!(
            driver.finalize().await,
            Ok(FinalizePluginResyncOutcome::Committed(_))
        ));
        let request = port
            .finalization
            .lock()
            .expect("finalization")
            .clone()
            .expect("commit request");
        assert_eq!(request.transcript.candidate_keys(), 0);
        assert_eq!(request.transcript.replacement(), None);
    }

    #[tokio::test]
    async fn plugin_resync_driver_rejects_cross_session_outcome_fences() {
        let (port, session) = fixture();
        let mut driver = PluginResyncDriver::begin(
            port,
            session.plugin_id.clone(),
            session.package_generation,
            session.activation_epoch,
            operation(2),
            session.operation_id,
            &[],
        )
        .await
        .expect("driver");
        let _invocation = driver.next_invocation().await.expect("snapshot");
        let (mut frame, body) = outcome_message(
            &driver,
            ResyncPageOutcome::SnapshotAck(SnapshotAck {
                session_id: session.operation_id.to_string(),
                page_index: 0,
                kind: ResourceKind::Task,
                segment: None,
            }),
        );
        let ChildFrame::Outcome { fence, .. } = &mut frame else {
            panic!("expected outcome frame");
        };
        fence.host_session_id = operation(99).to_string();
        assert_eq!(
            driver.accept_outcome(&frame, &body),
            Err(PluginResyncDriverError::StaleAuthority)
        );
        assert_eq!(driver.lifecycle(), PluginResyncLifecycle::Loaded);
    }

    #[tokio::test]
    async fn plugin_resync_driver_rejects_misordered_outcome_and_restarts_after_tail_invalidation()
    {
        let (port, session) = fixture();
        let mut driver = PluginResyncDriver::begin(
            port,
            session.plugin_id.clone(),
            session.package_generation,
            session.activation_epoch,
            operation(2),
            session.operation_id,
            &[],
        )
        .await
        .expect("driver");
        let _invocation = driver.next_invocation().await.expect("snapshot");
        let (frame, wrong) = outcome_message(
            &driver,
            ResyncPageOutcome::FlushAck(FlushAck {
                session_id: session.operation_id.to_string(),
                request_index: 0,
                segment: None,
                state: FlushState::Complete,
            }),
        );
        assert_eq!(
            driver.accept_outcome(&frame, &wrong),
            Err(PluginResyncDriverError::InvalidOutcome)
        );
        assert_eq!(
            driver.invalidate_retained_tail(),
            PluginResyncDriverError::RestartFreshHead
        );
        assert_eq!(driver.lifecycle(), PluginResyncLifecycle::Loaded);
        assert!(matches!(
            driver.next_invocation().await,
            Err(PluginResyncDriverError::InvalidTraversal)
                | Err(PluginResyncDriverError::RestartFreshHead)
        ));
    }
}
