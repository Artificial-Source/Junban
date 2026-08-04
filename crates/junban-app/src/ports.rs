//! Storage ports owned by the application layer.

use std::{future::Future, pin::Pin};

use jiff::Timestamp;
use junban_domain::{
    AiApprovalId, AiApprovalStatus, AiMemory, AiMemoryId, AiMessage, AiMessageContent, AiMessageId,
    AiMessageRole, AiMessageStatus, AiRunId, AiRunState, AiSecretKind, AiSecretMetadata, AiSession,
    AiSessionId, AiToolApproval, AiTurnId, AppSettings, ClaimedReminder, Comment, CommentBody,
    CommentId, EntityName, OperationId, Project, ProjectId, RelationKind, ReminderChannel,
    ReminderDeliveryLease, ReminderFailureCode, ReminderFenceTerm, ReminderOccurrence,
    SavedFilterId, SectionId, SettingsPatch, Tag, TagId, TagName, Task, TaskActivity, TaskDraft,
    TaskId, TaskQuery, TaskRelation, TemplateId, TimeBlockDraft, TimeBlockId, TimeSlotDraft,
    TimeSlotId, TransferApply, TransferFormat, TransferPreview,
};

use crate::{
    AiCredentialBindResult, AiCredentialBindingTarget, AiMemoryCursor, AiMemoryListPage,
    AiSecretBytes, AiSessionCursor, AiSessionListPage, BulkAction, CatalogSnapshot, CommentPatch,
    CommittedMutation, EventCatchUp, ExportFormat, MoveTarget, PluginRepository,
    PreparedAiResponse, ProjectDraft, ProjectListPage, ProjectPatch, ReorderScope,
    ReplanPastBlocksAction, ReplanPastBlocksPreview, RepositoryError,
    ReserveDailyAiResponseRequest, RewriteAiResponseRequest, SavedFilterDraft, SavedFilterPatch,
    SectionDraft, SectionPatch, StagedFile, TagDraft, TagListPage, TagPatch, TaskListAsOf,
    TaskListPage, TaskPatch, TemplateApply, TemplateDraft, TemplatePatch, TemporalContext,
    TimeBlockPatch, TimeBlockRangePatch, TimeSlotPatch, TimeblockingRangePage,
    TimeblockingRangeQuery,
};

pub type RepositoryFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, RepositoryError>> + Send + 'a>>;

/// Atomic event-stream identity and head revision read from `app_state`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncState {
    pub event_epoch: String,
    pub revision: u64,
}

/// Single profile store. Implemented by the SQLite worker owner only.
pub trait Repository: PluginRepository + Send + Sync + 'static {
    fn create_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        draft: TaskDraft,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn get_task(&self, task_id: TaskId) -> RepositoryFuture<'_, Task>;

    fn patch_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        patch: TaskPatch,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn complete_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        now: Timestamp,
        temporal: TemporalContext,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn uncomplete_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        now: Timestamp,
        temporal: TemporalContext,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn cancel_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn reopen_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn delete_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn move_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        target: MoveTarget,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn reorder_tasks(
        &self,
        operation_id: OperationId,
        scope: ReorderScope,
        ordered_ids: Vec<TaskId>,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn bulk_tasks(
        &self,
        operation_id: OperationId,
        task_ids: Vec<TaskId>,
        action: BulkAction,
        now: Timestamp,
        temporal: TemporalContext,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn list_tasks(
        &self,
        query: TaskQuery,
        as_of: TaskListAsOf,
    ) -> RepositoryFuture<'_, TaskListPage>;

    /// One bounded, consistent task snapshot for server-side temporal analysis.
    fn list_analysis_tasks(&self, as_of: TaskListAsOf) -> RepositoryFuture<'_, TaskListPage>;

    fn list_catalog(&self) -> RepositoryFuture<'_, CatalogSnapshot>;

    /// Bounded project list ordered by `sort_order`, id. `limit` is `1..=MAX_BULK_IDS`.
    fn list_projects_bounded(&self, limit: u32) -> RepositoryFuture<'_, ProjectListPage>;

    /// Bounded tag list ordered by `name_normalized`. `limit` is `1..=MAX_BULK_IDS`.
    fn list_tags_bounded(&self, limit: u32) -> RepositoryFuture<'_, TagListPage>;

    /// Exact project lookup by primary key.
    fn get_project(&self, project_id: ProjectId) -> RepositoryFuture<'_, Project>;

    /// Exact multi-project lookup by primary key.
    ///
    /// Accepts at most [`junban_domain::MAX_BULK_IDS`] unique IDs. Missing IDs are
    /// omitted. Results are ordered by `sort_order`, id and share one revision.
    fn get_projects_by_ids(
        &self,
        project_ids: Vec<ProjectId>,
    ) -> RepositoryFuture<'_, ProjectListPage>;

    /// Exact project lookup by name (first `sort_order`, id match).
    fn get_project_by_name(&self, name: EntityName) -> RepositoryFuture<'_, Project>;

    /// Resolve existing tags by exact normalized names. Missing names are `NotFound`.
    fn resolve_tags_by_names(&self, names: Vec<TagName>) -> RepositoryFuture<'_, Vec<Tag>>;

    fn create_project(
        &self,
        operation_id: OperationId,
        project_id: ProjectId,
        draft: ProjectDraft,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn patch_project(
        &self,
        operation_id: OperationId,
        project_id: ProjectId,
        patch: ProjectPatch,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn delete_project(
        &self,
        operation_id: OperationId,
        project_id: ProjectId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn create_section(
        &self,
        operation_id: OperationId,
        section_id: SectionId,
        draft: SectionDraft,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn patch_section(
        &self,
        operation_id: OperationId,
        section_id: SectionId,
        patch: SectionPatch,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn delete_section(
        &self,
        operation_id: OperationId,
        section_id: SectionId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn create_tag(
        &self,
        operation_id: OperationId,
        tag_id: TagId,
        draft: TagDraft,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn patch_tag(
        &self,
        operation_id: OperationId,
        tag_id: TagId,
        patch: TagPatch,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn delete_tag(
        &self,
        operation_id: OperationId,
        tag_id: TagId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn create_template(
        &self,
        operation_id: OperationId,
        template_id: TemplateId,
        draft: TemplateDraft,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn patch_template(
        &self,
        operation_id: OperationId,
        template_id: TemplateId,
        patch: TemplatePatch,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn delete_template(
        &self,
        operation_id: OperationId,
        template_id: TemplateId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn apply_template(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        apply: TemplateApply,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn create_saved_filter(
        &self,
        operation_id: OperationId,
        filter_id: SavedFilterId,
        draft: SavedFilterDraft,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn patch_saved_filter(
        &self,
        operation_id: OperationId,
        filter_id: SavedFilterId,
        patch: SavedFilterPatch,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn delete_saved_filter(
        &self,
        operation_id: OperationId,
        filter_id: SavedFilterId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn create_comment(
        &self,
        operation_id: OperationId,
        comment_id: CommentId,
        task_id: TaskId,
        content: CommentBody,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn patch_comment(
        &self,
        operation_id: OperationId,
        comment_id: CommentId,
        patch: CommentPatch,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn delete_comment(
        &self,
        operation_id: OperationId,
        comment_id: CommentId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn list_comments(&self, task_id: TaskId) -> RepositoryFuture<'_, Vec<Comment>>;

    fn add_relation(
        &self,
        operation_id: OperationId,
        from_task_id: TaskId,
        to_task_id: TaskId,
        kind: RelationKind,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn remove_relation(
        &self,
        operation_id: OperationId,
        from_task_id: TaskId,
        to_task_id: TaskId,
        kind: RelationKind,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn list_relations(&self, task_id: TaskId) -> RepositoryFuture<'_, Vec<TaskRelation>>;

    fn list_task_activity(
        &self,
        task_id: TaskId,
        after_revision: Option<u64>,
        after_sequence: Option<u32>,
        limit: u32,
    ) -> RepositoryFuture<'_, Vec<TaskActivity>>;

    fn list_events(&self, since: u64) -> RepositoryFuture<'_, EventCatchUp>;

    /// Read the durable event epoch and global revision in one `app_state` query.
    fn get_sync_state(&self) -> RepositoryFuture<'_, SyncState>;

    fn undo(
        &self,
        source_operation_id: OperationId,
        new_operation_id: OperationId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    /// List durable reminder occurrences for one task (all states).
    fn list_task_reminders(&self, task_id: TaskId)
    -> RepositoryFuture<'_, Vec<ReminderOccurrence>>;

    /// User mutation: set `remind_at` and reconcile the pending occurrence.
    fn reschedule_reminder(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        remind_at: Timestamp,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    /// User mutation: clear `remind_at` and cancel still-pending occurrences.
    fn dismiss_reminder(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    /// Control-plane: acquire the global delivery lease when absent or expired.
    fn acquire_reminder_lease(
        &self,
        now: Timestamp,
        lease_secs: u64,
    ) -> RepositoryFuture<'_, ReminderDeliveryLease>;

    /// Control-plane: renew the lease for the exact current fence term.
    fn renew_reminder_lease(
        &self,
        fence_term: ReminderFenceTerm,
        now: Timestamp,
        lease_secs: u64,
    ) -> RepositoryFuture<'_, ReminderDeliveryLease>;

    /// Control-plane: release the lease for the exact current fence term.
    fn release_reminder_lease(
        &self,
        fence_term: ReminderFenceTerm,
        now: Timestamp,
    ) -> RepositoryFuture<'_, ()>;

    /// Control-plane: claim due pending occurrences under the current lease term.
    fn claim_due_reminders(
        &self,
        fence_term: ReminderFenceTerm,
        now: Timestamp,
        limit: u32,
        claim_secs: u64,
    ) -> RepositoryFuture<'_, Vec<ClaimedReminder>>;

    /// Control-plane: settle a claim as delivered with the exact claim term+attempt.
    fn settle_reminder_delivered(
        &self,
        fence_term: ReminderFenceTerm,
        task_id: TaskId,
        remind_at: Timestamp,
        claim_attempt: u32,
        channel: ReminderChannel,
        now: Timestamp,
    ) -> RepositoryFuture<'_, ()>;

    /// Control-plane: settle a claim as failed with the exact claim term+attempt.
    fn settle_reminder_failed(
        &self,
        fence_term: ReminderFenceTerm,
        task_id: TaskId,
        remind_at: Timestamp,
        claim_attempt: u32,
        error: ReminderFailureCode,
        now: Timestamp,
    ) -> RepositoryFuture<'_, ()>;

    /// Control-plane: mark expired claimed rows failed/owner_lost under the new owner term.
    fn mark_owner_lost_reminders(
        &self,
        fence_term: ReminderFenceTerm,
        now: Timestamp,
        limit: u32,
    ) -> RepositoryFuture<'_, u32>;

    /// Control-plane: earliest meaningful wake instant for the reminder coordinator.
    ///
    /// Returns the minimum among pending eligibility (`max(remind_at, next_attempt_at)`),
    /// claimed `claim_expires_at`, and the current lease expiry. No revision/event/receipt.
    fn next_reminder_wake_at(&self) -> RepositoryFuture<'_, Option<Timestamp>>;

    /// Bounded inclusive range of series-owner blocks and slots.
    fn list_timeblocking_range(
        &self,
        query: TimeblockingRangeQuery,
    ) -> RepositoryFuture<'_, TimeblockingRangePage>;

    fn create_time_block(
        &self,
        operation_id: OperationId,
        block_id: TimeBlockId,
        draft: TimeBlockDraft,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn patch_time_block(
        &self,
        operation_id: OperationId,
        block_id: TimeBlockId,
        patch: TimeBlockPatch,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn delete_time_block(
        &self,
        operation_id: OperationId,
        block_id: TimeBlockId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn create_time_slot(
        &self,
        operation_id: OperationId,
        slot_id: TimeSlotId,
        draft: TimeSlotDraft,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn patch_time_slot(
        &self,
        operation_id: OperationId,
        slot_id: TimeSlotId,
        patch: TimeSlotPatch,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn delete_time_slot(
        &self,
        operation_id: OperationId,
        slot_id: TimeSlotId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn append_slot_task(
        &self,
        operation_id: OperationId,
        slot_id: TimeSlotId,
        task_id: TaskId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn remove_slot_task(
        &self,
        operation_id: OperationId,
        slot_id: TimeSlotId,
        task_id: TaskId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn reorder_slot_tasks(
        &self,
        operation_id: OperationId,
        slot_id: TimeSlotId,
        ordered_ids: Vec<TaskId>,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    /// Move or resize share the same range write path.
    fn set_time_block_range(
        &self,
        operation_id: OperationId,
        block_id: TimeBlockId,
        range: TimeBlockRangePatch,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn preview_replan_past_blocks(
        &self,
        temporal: TemporalContext,
    ) -> RepositoryFuture<'_, ReplanPastBlocksPreview>;

    fn replan_past_blocks(
        &self,
        operation_id: OperationId,
        action: ReplanPastBlocksAction,
        expected_as_of_date: jiff::civil::Date,
        expected_candidate_ids: Vec<TimeBlockId>,
        now: Timestamp,
        temporal: TemporalContext,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    /// Read the persisted settings aggregate.
    fn get_settings(&self) -> RepositoryFuture<'_, AppSettings>;

    /// Patch settings in one transaction and emit `settings.updated`.
    fn patch_settings(
        &self,
        operation_id: OperationId,
        patch: SettingsPatch,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    /// Parse transfer content into a fingerprint-bound import preview.
    fn preview_import(
        &self,
        format: TransferFormat,
        content: String,
    ) -> RepositoryFuture<'_, TransferPreview>;

    /// Apply a previously previewed import in one transaction.
    fn apply_import(
        &self,
        operation_id: OperationId,
        apply: TransferApply,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    /// Serialize transferable tasks into a private staged file using bounded pages.
    fn create_export(&self, format: ExportFormat) -> RepositoryFuture<'_, StagedFile>;

    /// Create a complete framed `.junban-backup` in a private staged file.
    fn create_backup(&self) -> RepositoryFuture<'_, StagedFile>;

    /// Fully validate an uploaded envelope and prepare its rotated SQLite candidate.
    fn prepare_restore(&self, upload: StagedFile) -> RepositoryFuture<'_, StagedFile>;

    /// Apply a previously validated and epoch-rotated SQLite candidate.
    fn restore_backup(&self, candidate: StagedFile) -> RepositoryFuture<'_, ()>;

    // ── AI persistence (Wave 3a) ────────────────────────────────────────────

    fn create_ai_session(
        &self,
        operation_id: OperationId,
        session_id: AiSessionId,
        title: String,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn rename_ai_session(
        &self,
        operation_id: OperationId,
        session_id: AiSessionId,
        title: String,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn delete_ai_session(
        &self,
        operation_id: OperationId,
        session_id: AiSessionId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn clear_ai_session(
        &self,
        operation_id: OperationId,
        session_id: AiSessionId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn get_ai_session(&self, session_id: AiSessionId) -> RepositoryFuture<'_, AiSession>;

    fn list_ai_sessions(
        &self,
        cursor: Option<AiSessionCursor>,
        limit: u32,
    ) -> RepositoryFuture<'_, AiSessionListPage>;

    #[allow(clippy::too_many_arguments)]
    fn upsert_ai_message(
        &self,
        operation_id: OperationId,
        message_id: AiMessageId,
        session_id: AiSessionId,
        turn_id: AiTurnId,
        role: AiMessageRole,
        status: AiMessageStatus,
        content: AiMessageContent,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn get_ai_message(&self, message_id: AiMessageId) -> RepositoryFuture<'_, AiMessage>;

    fn list_ai_messages(
        &self,
        session_id: AiSessionId,
        after_sequence: Option<u32>,
        limit: u32,
    ) -> RepositoryFuture<'_, Vec<AiMessage>>;

    fn create_ai_memory(
        &self,
        operation_id: OperationId,
        memory_id: AiMemoryId,
        content: String,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn update_ai_memory(
        &self,
        operation_id: OperationId,
        memory_id: AiMemoryId,
        content: String,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn delete_ai_memory(
        &self,
        operation_id: OperationId,
        memory_id: AiMemoryId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn link_ai_session_memory(
        &self,
        operation_id: OperationId,
        session_id: AiSessionId,
        memory_id: AiMemoryId,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn get_ai_memory(&self, memory_id: AiMemoryId) -> RepositoryFuture<'_, AiMemory>;

    fn list_ai_memories(
        &self,
        cursor: Option<AiMemoryCursor>,
        limit: u32,
    ) -> RepositoryFuture<'_, AiMemoryListPage>;

    fn select_ai_memories_for_context(
        &self,
        session_id: Option<AiSessionId>,
        limit: u32,
    ) -> RepositoryFuture<'_, Vec<AiMemory>>;

    #[allow(clippy::too_many_arguments)]
    fn propose_ai_approval(
        &self,
        operation_id: OperationId,
        approval_id: AiApprovalId,
        session_id: AiSessionId,
        turn_id: AiTurnId,
        run_id: AiRunId,
        generation: u64,
        tool_name: String,
        arguments_json: String,
        assistant_content: junban_domain::AiMessageContent,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn set_ai_approval_status(
        &self,
        operation_id: OperationId,
        approval_id: AiApprovalId,
        status: AiApprovalStatus,
        dispatch_operation_id: Option<String>,
        assistant_content: Option<junban_domain::AiMessageContent>,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn get_ai_approval(&self, approval_id: AiApprovalId) -> RepositoryFuture<'_, AiToolApproval>;

    /// Bounded exact consumed-approval rows whose run is durably dispatching.
    fn list_dispatching_ai_approvals(&self) -> RepositoryFuture<'_, Vec<AiToolApproval>>;

    /// Trusted recovery-only lookup of a committed mutation by its server-owned operation ID.
    ///
    /// This deliberately does not accept caller request bytes and must never be exposed through
    /// an HTTP, CLI, MCP, provider, or plugin surface.
    fn recover_operation_receipt(
        &self,
        operation_id: OperationId,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn upsert_ai_run_state(
        &self,
        operation_id: OperationId,
        state: AiRunState,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    fn get_ai_run_state(&self, run_id: AiRunId) -> RepositoryFuture<'_, AiRunState>;

    fn get_ai_run_for_assistant(
        &self,
        assistant_message_id: AiMessageId,
    ) -> RepositoryFuture<'_, AiRunState>;

    /// Fail closed when a run was tombstoned by a later history rewrite.
    fn ensure_ai_response_current(&self, run_id: AiRunId) -> RepositoryFuture<'_, ()>;

    fn reserve_daily_ai_response(
        &self,
        operation_id: OperationId,
        request: ReserveDailyAiResponseRequest,
        now: Timestamp,
    ) -> RepositoryFuture<'_, PreparedAiResponse>;

    fn rewrite_ai_response(
        &self,
        operation_id: OperationId,
        request: RewriteAiResponseRequest,
        now: Timestamp,
    ) -> RepositoryFuture<'_, PreparedAiResponse>;

    #[allow(clippy::too_many_arguments)]
    fn cancel_ai_response(
        &self,
        operation_id: OperationId,
        assistant_message_id: AiMessageId,
        session_id: AiSessionId,
        turn_id: AiTurnId,
        run_id: AiRunId,
        generation: u64,
        content: AiMessageContent,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    #[allow(clippy::too_many_arguments)]
    fn finish_ai_response(
        &self,
        operation_id: OperationId,
        assistant_message_id: AiMessageId,
        session_id: AiSessionId,
        turn_id: AiTurnId,
        run_id: AiRunId,
        generation: u64,
        message_status: AiMessageStatus,
        content: AiMessageContent,
        run_phase: junban_domain::AiRunPhase,
        dispatch_operation_id: Option<String>,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    /// Presence-only private credential inventory. Reads publish no event.
    fn list_ai_secret_metadata(&self) -> RepositoryFuture<'_, Vec<AiSecretMetadata>>;

    /// Resolve one confirmed private credential transiently. Missing/stale IDs fail closed.
    fn resolve_ai_secret(
        &self,
        credential_id: junban_domain::AiCredentialId,
    ) -> RepositoryFuture<'_, AiSecretBytes>;

    fn bind_ai_credential(
        &self,
        operation_id: OperationId,
        target: AiCredentialBindingTarget,
        kind: AiSecretKind,
        secret: Option<AiSecretBytes>,
        now: Timestamp,
    ) -> RepositoryFuture<'_, AiCredentialBindResult>;

    fn clear_ai_credential_binding(
        &self,
        operation_id: OperationId,
        target: AiCredentialBindingTarget,
        now: Timestamp,
    ) -> RepositoryFuture<'_, CommittedMutation>;

    /// Best-effort release of SQLite connection page cache / heap retained by the pager.
    ///
    /// Production storage overrides this to run `PRAGMA shrink_memory` on the single
    /// profile worker and, on Linux, advise DONTNEED for clean pages of the live main
    /// database and WAL files. It must not mutate durable data, advance revision, open
    /// another connection, or checkpoint/truncate the WAL. Default is a no-op so test
    /// doubles need not implement it.
    fn release_cached_memory(&self) -> RepositoryFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
}
