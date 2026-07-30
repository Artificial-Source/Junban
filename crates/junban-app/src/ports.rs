//! Storage ports owned by the application layer.

use std::{future::Future, pin::Pin};

use jiff::Timestamp;
use junban_domain::{
    ClaimedReminder, Comment, CommentBody, CommentId, OperationId, ProjectId, RelationKind,
    ReminderChannel, ReminderDeliveryLease, ReminderFailureCode, ReminderFenceTerm,
    ReminderOccurrence, SavedFilterId, SectionId, TagId, Task, TaskActivity, TaskDraft, TaskId,
    TaskQuery, TaskRelation, TemplateId,
};

use crate::{
    BulkAction, CatalogSnapshot, CommentPatch, CommittedMutation, EventCatchUp, MoveTarget,
    ProjectDraft, ProjectPatch, ReorderScope, RepositoryError, SavedFilterDraft, SavedFilterPatch,
    SectionDraft, SectionPatch, TagDraft, TagPatch, TaskListAsOf, TaskListPage, TaskPatch,
    TemplateApply, TemplateDraft, TemplatePatch, TemporalContext,
};

pub type RepositoryFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, RepositoryError>> + Send + 'a>>;

/// Single profile store. Implemented by the SQLite worker owner only.
pub trait Repository: Send + Sync + 'static {
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

    fn list_catalog(&self) -> RepositoryFuture<'_, CatalogSnapshot>;

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
}
