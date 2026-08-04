//! Validation-before-write use cases with post-commit event publication.

use std::sync::Arc;

use jiff::{Timestamp, Zoned, civil::Date, tz::TimeZone};
use junban_domain::{
    AiApprovalId, AiCredentialId, AiMemory, AiMemoryId, AiMessage, AiMessageId, AiRunId,
    AiRunState, AiSecretMetadata, AiSession, AiSessionId, AiToolApproval, AppSettings,
    ClaimedReminder, Comment, CommentBody, CommentId, DEFAULT_REMINDER_CLAIM_LIMIT,
    DEFAULT_REMINDER_CLAIM_SECS, DEFAULT_REMINDER_LEASE_SECS, DailyCapacityMinutes, EntityName,
    FilterQuery, HexColor, MAX_BULK_IDS, MAX_CALENDAR_TASKS, MAX_QUERY_PAGE_LIMIT,
    MAX_TIMEBLOCK_RANGE_ITEMS, MarkdownText, NudgeRuleKind, OperationId, ProjectId, RelationKind,
    ReminderChannel, ReminderDeliveryLease, ReminderFailureCode, ReminderFenceTerm,
    ReminderOccurrence, SavedFilterId, SectionId, SettingsPatch, TagId, TagName, Task,
    TaskActivity, TaskDraft, TaskId, TaskQuery, TaskRelation, TaskSort, TaskStatus, TaskTitle,
    TemplateId, TimeBlock, TimeBlockDraft, TimeBlockId, TimeSlot, TimeSlotDraft, TimeSlotId,
    TransferApply, TransferError, TransferFormat, TransferPreview, ValidationError, WeekStart,
    civil_occurrences_in_range, daily_plan_summary, dopamine_menu_task_ids, end_of_day_summary,
    evaluate_nudges, preview_transfer, select_eat_the_frog, stats_summary, task_jar_candidates,
    validate_calendar_date_range, validate_owner_lost_mark_limit, validate_preview_matches_apply,
    validate_reminder_claim_limit, validate_reminder_lease_secs, validate_stats_date_range,
    validate_timeblock_date_range, weekly_review_summary,
};

use crate::{
    AiCredentialBindResult, AiMemoryListPage, AiSessionListPage, AppError, BindAiCredentialRequest,
    BulkAction, CalendarTasksPage, CancelAiResponseRequest, CatalogSnapshot,
    ClearAiCredentialRequest, ClearAiSessionRequest, CollectedTasks, CommentPatch, CommittedEvent,
    CommittedMutation, CreateAiMemoryRequest, CreateAiSessionRequest, DailyPlanPage,
    DeleteAiMemoryRequest, DeleteAiSessionRequest, DopamineMenuPage, EatTheFrogPage, EndOfDayPage,
    EventCatchUp, ExportFormat, FinishAiResponseRequest, LinkAiSessionMemoryRequest,
    ListAiMemoriesRequest, ListAiMessagesRequest, ListAiSessionsRequest, MoveTarget, NudgesPage,
    PreparedAiResponse, ProjectDraft, ProjectPatch, ProposeAiApprovalRequest,
    RenameAiSessionRequest, ReorderScope, ReplanPastBlocksAction, ReplanPastBlocksPreview,
    Repository, RepositoryError, ReserveDailyAiResponseRequest, RewriteAiResponseRequest,
    SavedFilterDraft, SavedFilterPatch, SectionDraft, SectionPatch, SelectAiMemoriesRequest,
    SetAiApprovalStatusRequest, StagedFile, StatsPage, SyncState, TagDraft, TagPatch, TaskJarPage,
    TaskListAsOf, TaskListPage, TaskPatch, TemplateApply, TemplateDraft, TemplatePatch,
    TemporalContext, TemporalSettings, TimeBlockPatch, TimeBlockRangePatch, TimeSlotPatch,
    TimeblockingRangePage, TimeblockingRangeQuery, UpdateAiMemoryRequest, UpsertAiMessageRequest,
    UpsertAiRunStateRequest, WeeklyReviewPage,
};

/// Cursor page size used when collecting multi-page task reads.
pub const TASK_COLLECT_PAGE_SIZE: u32 = 100;

pub trait EventSink: Send + Sync + 'static {
    fn publish(&self, event: CommittedEvent);
}

/// Expand durable series owners into the inclusive civil window.
///
/// Persisted owner dates are returned once with owner metadata intact. Virtual
/// instances keep the owner typed id (mutations target the series owner) and set
/// `recurrence_parent_id` for stable UI identity via response `occurrence_key`.
fn expand_timeblocking_range(
    page: TimeblockingRangePage,
    from: Date,
    to: Date,
) -> Result<TimeblockingRangePage, AppError> {
    let blocks = expand_time_blocks(page.blocks, from, to)?;
    let slots = expand_time_slots(page.slots, from, to)?;
    let total = blocks.len().saturating_add(slots.len());
    if total > MAX_TIMEBLOCK_RANGE_ITEMS {
        return Err(AppError::ResultLimitExceeded);
    }
    Ok(TimeblockingRangePage {
        blocks,
        slots,
        revision: page.revision,
    })
}

fn expand_time_blocks(
    owners: Vec<TimeBlock>,
    from: Date,
    to: Date,
) -> Result<Vec<TimeBlock>, AppError> {
    let mut out = Vec::new();
    for owner in owners {
        match owner.recurrence_rule.as_ref() {
            None => {
                if owner.range.date >= from && owner.range.date <= to {
                    out.push(owner);
                }
            }
            Some(rule) => {
                let dates = civil_occurrences_in_range(rule, owner.range.date, from, to)?;
                for date in dates {
                    if date == owner.range.date {
                        out.push(owner.clone());
                    } else {
                        let mut instance = owner.clone();
                        instance.range.date = date;
                        instance.recurrence_parent_id = Some(owner.id);
                        out.push(instance);
                    }
                }
            }
        }
    }
    out.sort_by(|left, right| {
        (left.range.date, left.range.start, left.id.as_uuid()).cmp(&(
            right.range.date,
            right.range.start,
            right.id.as_uuid(),
        ))
    });
    Ok(out)
}

fn expand_time_slots(
    owners: Vec<TimeSlot>,
    from: Date,
    to: Date,
) -> Result<Vec<TimeSlot>, AppError> {
    let mut out = Vec::new();
    for owner in owners {
        match owner.recurrence_rule.as_ref() {
            None => {
                if owner.range.date >= from && owner.range.date <= to {
                    out.push(owner);
                }
            }
            Some(rule) => {
                let dates = civil_occurrences_in_range(rule, owner.range.date, from, to)?;
                for date in dates {
                    if date == owner.range.date {
                        out.push(owner.clone());
                    } else {
                        let mut instance = owner.clone();
                        instance.range.date = date;
                        instance.recurrence_parent_id = Some(owner.id);
                        out.push(instance);
                    }
                }
            }
        }
    }
    out.sort_by(|left, right| {
        (left.range.date, left.range.start, left.id.as_uuid()).cmp(&(
            right.range.date,
            right.range.start,
            right.id.as_uuid(),
        ))
    });
    Ok(out)
}

#[derive(Debug)]
pub struct JunbanService<R, E> {
    repository: Arc<R>,
    events: Arc<E>,
}

impl<R, E> Clone for JunbanService<R, E> {
    fn clone(&self) -> Self {
        Self {
            repository: Arc::clone(&self.repository),
            events: Arc::clone(&self.events),
        }
    }
}

impl<R, E> JunbanService<R, E>
where
    R: Repository,
    E: EventSink,
{
    #[must_use]
    pub fn new(repository: Arc<R>, events: Arc<E>) -> Self {
        Self { repository, events }
    }

    pub async fn create_task(
        &self,
        operation_id: OperationId,
        draft: TaskDraft,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .create_task(operation_id, TaskId::new(), draft, Timestamp::now())
                .await,
        )
    }

    /// Phase 1-compatible create used by the existing hosted routes.
    pub async fn create_task_simple(
        &self,
        operation_id: OperationId,
        title: String,
        due_date: Option<Date>,
    ) -> Result<CommittedMutation, AppError> {
        let mut draft = TaskDraft::new(TaskTitle::new(title)?);
        draft.due_date = due_date;
        self.create_task(operation_id, draft).await
    }

    pub async fn get_task(&self, task_id: TaskId) -> Result<Task, AppError> {
        self.repository.get_task(task_id).await.map_err(Into::into)
    }

    pub async fn patch_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        patch: TaskPatch,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .patch_task(operation_id, task_id, patch, Timestamp::now())
                .await,
        )
    }

    /// Phase 1-compatible title/due replace.
    pub async fn replace_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        title: String,
        due_date: Option<Date>,
    ) -> Result<CommittedMutation, AppError> {
        let patch = TaskPatch {
            title: Some(TaskTitle::new(title)?),
            due_date: Some(due_date),
            due_time: Some(None),
            ..TaskPatch::default()
        };
        self.patch_task(operation_id, task_id, patch).await
    }

    pub async fn complete_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
    ) -> Result<CommittedMutation, AppError> {
        self.complete_task_with(operation_id, task_id, TemporalContext::sample_now())
            .await
    }

    /// Internal/test seam with an explicit sampled civil date/zone.
    pub async fn complete_task_with(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        temporal: TemporalContext,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .complete_task(operation_id, task_id, Timestamp::now(), temporal)
                .await,
        )
    }

    pub async fn uncomplete_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
    ) -> Result<CommittedMutation, AppError> {
        self.uncomplete_task_with(operation_id, task_id, TemporalContext::sample_now())
            .await
    }

    /// Internal/test seam with an explicit sampled civil date/zone.
    pub async fn uncomplete_task_with(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        temporal: TemporalContext,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .uncomplete_task(operation_id, task_id, Timestamp::now(), temporal)
                .await,
        )
    }

    pub async fn cancel_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .cancel_task(operation_id, task_id, Timestamp::now())
                .await,
        )
    }

    pub async fn reopen_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .reopen_task(operation_id, task_id, Timestamp::now())
                .await,
        )
    }

    pub async fn delete_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .delete_task(operation_id, task_id, Timestamp::now())
                .await,
        )
    }

    pub async fn move_task(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        target: MoveTarget,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .move_task(operation_id, task_id, target, Timestamp::now())
                .await,
        )
    }

    pub async fn reorder_tasks(
        &self,
        operation_id: OperationId,
        scope: ReorderScope,
        ordered_ids: Vec<TaskId>,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .reorder_tasks(operation_id, scope, ordered_ids, Timestamp::now())
                .await,
        )
    }

    pub async fn bulk_tasks(
        &self,
        operation_id: OperationId,
        task_ids: Vec<TaskId>,
        action: BulkAction,
    ) -> Result<CommittedMutation, AppError> {
        self.bulk_tasks_with(
            operation_id,
            task_ids,
            action,
            TemporalContext::sample_now(),
        )
        .await
    }

    /// Internal/test seam with an explicit sampled civil date/zone.
    pub async fn bulk_tasks_with(
        &self,
        operation_id: OperationId,
        task_ids: Vec<TaskId>,
        action: BulkAction,
        temporal: TemporalContext,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .bulk_tasks(operation_id, task_ids, action, Timestamp::now(), temporal)
                .await,
        )
    }

    pub async fn list_tasks(
        &self,
        query: TaskQuery,
        as_of: TaskListAsOf,
    ) -> Result<TaskListPage, AppError> {
        query.validate()?;
        self.repository
            .list_tasks(query, as_of)
            .await
            .map_err(Into::into)
    }

    /// Phase 1-compatible unfiltered list.
    pub async fn list_tasks_simple(&self) -> Result<TaskListPage, AppError> {
        let as_of = TaskListAsOf::from_zoned(&Zoned::now())?;
        self.list_tasks(TaskQuery::new().with_limit(100)?, as_of)
            .await
    }

    pub async fn list_catalog(&self) -> Result<CatalogSnapshot, AppError> {
        self.repository.list_catalog().await.map_err(Into::into)
    }

    /// Bounded project page (`limit` clamped into `1..=MAX_BULK_IDS`).
    pub async fn list_projects_bounded(
        &self,
        limit: u32,
    ) -> Result<crate::ProjectListPage, AppError> {
        let limit = limit.clamp(1, MAX_BULK_IDS as u32);
        self.repository
            .list_projects_bounded(limit)
            .await
            .map_err(Into::into)
    }

    /// Bounded tag page (`limit` clamped into `1..=MAX_BULK_IDS`).
    pub async fn list_tags_bounded(&self, limit: u32) -> Result<crate::TagListPage, AppError> {
        let limit = limit.clamp(1, MAX_BULK_IDS as u32);
        self.repository
            .list_tags_bounded(limit)
            .await
            .map_err(Into::into)
    }

    /// Exact project lookup by id.
    pub async fn get_project(
        &self,
        project_id: junban_domain::ProjectId,
    ) -> Result<junban_domain::Project, AppError> {
        self.repository
            .get_project(project_id)
            .await
            .map_err(Into::into)
    }

    /// Exact multi-project lookup by id (≤ [`MAX_BULK_IDS`] unique IDs).
    pub async fn get_projects_by_ids(
        &self,
        project_ids: Vec<ProjectId>,
    ) -> Result<crate::ProjectListPage, AppError> {
        if project_ids.len() > MAX_BULK_IDS {
            return Err(AppError::Validation(ValidationError::TooMany {
                field: "project_ids",
                count: project_ids.len(),
                max: MAX_BULK_IDS,
            }));
        }
        self.repository
            .get_projects_by_ids(project_ids)
            .await
            .map_err(Into::into)
    }

    /// Exact project lookup by name.
    pub async fn get_project_by_name(
        &self,
        name: junban_domain::EntityName,
    ) -> Result<junban_domain::Project, AppError> {
        self.repository
            .get_project_by_name(name)
            .await
            .map_err(Into::into)
    }

    /// Resolve tags by exact normalized names without loading the full catalog.
    pub async fn resolve_tags_by_names(
        &self,
        names: Vec<junban_domain::TagName>,
    ) -> Result<Vec<junban_domain::Tag>, AppError> {
        self.repository
            .resolve_tags_by_names(names)
            .await
            .map_err(Into::into)
    }

    pub async fn create_project(
        &self,
        operation_id: OperationId,
        draft: ProjectDraft,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .create_project(operation_id, ProjectId::new(), draft, Timestamp::now())
                .await,
        )
    }

    pub async fn patch_project(
        &self,
        operation_id: OperationId,
        project_id: ProjectId,
        patch: ProjectPatch,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .patch_project(operation_id, project_id, patch, Timestamp::now())
                .await,
        )
    }

    pub async fn delete_project(
        &self,
        operation_id: OperationId,
        project_id: ProjectId,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .delete_project(operation_id, project_id, Timestamp::now())
                .await,
        )
    }

    pub async fn create_section(
        &self,
        operation_id: OperationId,
        draft: SectionDraft,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .create_section(operation_id, SectionId::new(), draft, Timestamp::now())
                .await,
        )
    }

    pub async fn patch_section(
        &self,
        operation_id: OperationId,
        section_id: SectionId,
        patch: SectionPatch,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .patch_section(operation_id, section_id, patch, Timestamp::now())
                .await,
        )
    }

    pub async fn delete_section(
        &self,
        operation_id: OperationId,
        section_id: SectionId,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .delete_section(operation_id, section_id, Timestamp::now())
                .await,
        )
    }

    pub async fn create_tag(
        &self,
        operation_id: OperationId,
        draft: TagDraft,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .create_tag(operation_id, TagId::new(), draft, Timestamp::now())
                .await,
        )
    }

    pub async fn patch_tag(
        &self,
        operation_id: OperationId,
        tag_id: TagId,
        patch: TagPatch,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .patch_tag(operation_id, tag_id, patch, Timestamp::now())
                .await,
        )
    }

    pub async fn delete_tag(
        &self,
        operation_id: OperationId,
        tag_id: TagId,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .delete_tag(operation_id, tag_id, Timestamp::now())
                .await,
        )
    }

    pub async fn create_template(
        &self,
        operation_id: OperationId,
        draft: TemplateDraft,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .create_template(operation_id, TemplateId::new(), draft, Timestamp::now())
                .await,
        )
    }

    pub async fn patch_template(
        &self,
        operation_id: OperationId,
        template_id: TemplateId,
        patch: TemplatePatch,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .patch_template(operation_id, template_id, patch, Timestamp::now())
                .await,
        )
    }

    pub async fn delete_template(
        &self,
        operation_id: OperationId,
        template_id: TemplateId,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .delete_template(operation_id, template_id, Timestamp::now())
                .await,
        )
    }

    pub async fn apply_template(
        &self,
        operation_id: OperationId,
        apply: TemplateApply,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .apply_template(operation_id, TaskId::new(), apply, Timestamp::now())
                .await,
        )
    }

    pub async fn create_saved_filter(
        &self,
        operation_id: OperationId,
        draft: SavedFilterDraft,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .create_saved_filter(operation_id, SavedFilterId::new(), draft, Timestamp::now())
                .await,
        )
    }

    pub async fn patch_saved_filter(
        &self,
        operation_id: OperationId,
        filter_id: SavedFilterId,
        patch: SavedFilterPatch,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .patch_saved_filter(operation_id, filter_id, patch, Timestamp::now())
                .await,
        )
    }

    pub async fn delete_saved_filter(
        &self,
        operation_id: OperationId,
        filter_id: SavedFilterId,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .delete_saved_filter(operation_id, filter_id, Timestamp::now())
                .await,
        )
    }

    pub async fn create_comment(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        content: String,
    ) -> Result<CommittedMutation, AppError> {
        let content = CommentBody::new(content)?;
        self.commit(
            self.repository
                .create_comment(
                    operation_id,
                    CommentId::new(),
                    task_id,
                    content,
                    Timestamp::now(),
                )
                .await,
        )
    }

    pub async fn patch_comment(
        &self,
        operation_id: OperationId,
        comment_id: CommentId,
        content: String,
    ) -> Result<CommittedMutation, AppError> {
        let patch = CommentPatch {
            content: Some(CommentBody::new(content)?),
        };
        self.commit(
            self.repository
                .patch_comment(operation_id, comment_id, patch, Timestamp::now())
                .await,
        )
    }

    pub async fn delete_comment(
        &self,
        operation_id: OperationId,
        comment_id: CommentId,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .delete_comment(operation_id, comment_id, Timestamp::now())
                .await,
        )
    }

    pub async fn list_comments(&self, task_id: TaskId) -> Result<Vec<Comment>, AppError> {
        self.repository
            .list_comments(task_id)
            .await
            .map_err(Into::into)
    }

    pub async fn add_blocks_relation(
        &self,
        operation_id: OperationId,
        from_task_id: TaskId,
        to_task_id: TaskId,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .add_relation(
                    operation_id,
                    from_task_id,
                    to_task_id,
                    RelationKind::Blocks,
                    Timestamp::now(),
                )
                .await,
        )
    }

    pub async fn remove_blocks_relation(
        &self,
        operation_id: OperationId,
        from_task_id: TaskId,
        to_task_id: TaskId,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .remove_relation(
                    operation_id,
                    from_task_id,
                    to_task_id,
                    RelationKind::Blocks,
                    Timestamp::now(),
                )
                .await,
        )
    }

    pub async fn list_relations(&self, task_id: TaskId) -> Result<Vec<TaskRelation>, AppError> {
        self.repository
            .list_relations(task_id)
            .await
            .map_err(Into::into)
    }

    pub async fn list_task_activity(
        &self,
        task_id: TaskId,
        after_revision: Option<u64>,
        after_sequence: Option<u32>,
        limit: u32,
    ) -> Result<Vec<TaskActivity>, AppError> {
        if limit == 0 || limit > crate::ACTIVITY_PAGE_MAX {
            return Err(AppError::Validation(ValidationError::OutOfRange {
                field: "limit",
                min: 1,
                max: i64::from(crate::ACTIVITY_PAGE_MAX),
            }));
        }
        self.repository
            .list_task_activity(task_id, after_revision, after_sequence, limit)
            .await
            .map_err(Into::into)
    }

    pub async fn list_events(&self, since: u64) -> Result<EventCatchUp, AppError> {
        self.repository.list_events(since).await.map_err(Into::into)
    }

    pub async fn get_sync_state(&self) -> Result<SyncState, AppError> {
        self.repository.get_sync_state().await.map_err(Into::into)
    }

    pub async fn undo(
        &self,
        source_operation_id: OperationId,
        new_operation_id: OperationId,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .undo(source_operation_id, new_operation_id, Timestamp::now())
                .await,
        )
    }

    pub async fn list_task_reminders(
        &self,
        task_id: TaskId,
    ) -> Result<Vec<ReminderOccurrence>, AppError> {
        self.repository
            .list_task_reminders(task_id)
            .await
            .map_err(Into::into)
    }

    /// Set or replace the task reminder schedule (user mutation).
    pub async fn reschedule_reminder(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        remind_at: Timestamp,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .reschedule_reminder(operation_id, task_id, remind_at, Timestamp::now())
                .await,
        )
    }

    /// Alias for reschedule — snooze is the same durable schedule write.
    pub async fn snooze_reminder(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
        remind_at: Timestamp,
    ) -> Result<CommittedMutation, AppError> {
        self.reschedule_reminder(operation_id, task_id, remind_at)
            .await
    }

    /// Clear the task reminder schedule and cancel still-pending occurrences.
    pub async fn dismiss_reminder(
        &self,
        operation_id: OperationId,
        task_id: TaskId,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .dismiss_reminder(operation_id, task_id, Timestamp::now())
                .await,
        )
    }

    /// Control-plane lease acquire. No user revision/event is published.
    pub async fn acquire_reminder_lease(
        &self,
        lease_secs: Option<u64>,
    ) -> Result<ReminderDeliveryLease, AppError> {
        let lease_secs =
            validate_reminder_lease_secs(lease_secs.unwrap_or(DEFAULT_REMINDER_LEASE_SECS))?;
        self.repository
            .acquire_reminder_lease(Timestamp::now(), lease_secs)
            .await
            .map_err(Into::into)
    }

    pub async fn renew_reminder_lease(
        &self,
        fence_term: ReminderFenceTerm,
        lease_secs: Option<u64>,
    ) -> Result<ReminderDeliveryLease, AppError> {
        let lease_secs =
            validate_reminder_lease_secs(lease_secs.unwrap_or(DEFAULT_REMINDER_LEASE_SECS))?;
        self.repository
            .renew_reminder_lease(fence_term, Timestamp::now(), lease_secs)
            .await
            .map_err(Into::into)
    }

    pub async fn release_reminder_lease(
        &self,
        fence_term: ReminderFenceTerm,
    ) -> Result<(), AppError> {
        self.repository
            .release_reminder_lease(fence_term, Timestamp::now())
            .await
            .map_err(Into::into)
    }

    pub async fn claim_due_reminders(
        &self,
        fence_term: ReminderFenceTerm,
        limit: Option<u32>,
        claim_secs: Option<u64>,
    ) -> Result<Vec<ClaimedReminder>, AppError> {
        let limit = validate_reminder_claim_limit(limit.unwrap_or(DEFAULT_REMINDER_CLAIM_LIMIT))?;
        let claim_secs =
            validate_reminder_lease_secs(claim_secs.unwrap_or(DEFAULT_REMINDER_CLAIM_SECS))?;
        self.repository
            .claim_due_reminders(fence_term, Timestamp::now(), limit, claim_secs)
            .await
            .map_err(Into::into)
    }

    pub async fn settle_reminder_delivered(
        &self,
        fence_term: ReminderFenceTerm,
        task_id: TaskId,
        remind_at: Timestamp,
        claim_attempt: u32,
        channel: ReminderChannel,
    ) -> Result<(), AppError> {
        self.repository
            .settle_reminder_delivered(
                fence_term,
                task_id,
                remind_at,
                claim_attempt,
                channel,
                Timestamp::now(),
            )
            .await
            .map_err(Into::into)
    }

    pub async fn settle_reminder_failed(
        &self,
        fence_term: ReminderFenceTerm,
        task_id: TaskId,
        remind_at: Timestamp,
        claim_attempt: u32,
        error: ReminderFailureCode,
    ) -> Result<(), AppError> {
        self.repository
            .settle_reminder_failed(
                fence_term,
                task_id,
                remind_at,
                claim_attempt,
                error,
                Timestamp::now(),
            )
            .await
            .map_err(Into::into)
    }

    pub async fn mark_owner_lost_reminders(
        &self,
        fence_term: ReminderFenceTerm,
        limit: Option<u32>,
    ) -> Result<u32, AppError> {
        let limit = validate_owner_lost_mark_limit(limit.unwrap_or(DEFAULT_REMINDER_CLAIM_LIMIT))?;
        self.repository
            .mark_owner_lost_reminders(fence_term, Timestamp::now(), limit)
            .await
            .map_err(Into::into)
    }

    /// Control-plane wake query for the later reminder coordinator. No fan-out.
    pub async fn next_reminder_wake_at(&self) -> Result<Option<Timestamp>, AppError> {
        self.repository
            .next_reminder_wake_at()
            .await
            .map_err(Into::into)
    }

    pub async fn list_timeblocking_range(
        &self,
        from: Date,
        to: Date,
    ) -> Result<TimeblockingRangePage, AppError> {
        validate_timeblock_date_range(from, to)?;
        let page = self
            .repository
            .list_timeblocking_range(TimeblockingRangeQuery { from, to })
            .await?;
        expand_timeblocking_range(page, from, to)
    }

    pub async fn create_time_block(
        &self,
        operation_id: OperationId,
        draft: TimeBlockDraft,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .create_time_block(operation_id, TimeBlockId::new(), draft, Timestamp::now())
                .await,
        )
    }

    pub async fn patch_time_block(
        &self,
        operation_id: OperationId,
        block_id: TimeBlockId,
        patch: TimeBlockPatch,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .patch_time_block(operation_id, block_id, patch, Timestamp::now())
                .await,
        )
    }

    pub async fn delete_time_block(
        &self,
        operation_id: OperationId,
        block_id: TimeBlockId,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .delete_time_block(operation_id, block_id, Timestamp::now())
                .await,
        )
    }

    pub async fn create_time_slot(
        &self,
        operation_id: OperationId,
        draft: TimeSlotDraft,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .create_time_slot(operation_id, TimeSlotId::new(), draft, Timestamp::now())
                .await,
        )
    }

    pub async fn patch_time_slot(
        &self,
        operation_id: OperationId,
        slot_id: TimeSlotId,
        patch: TimeSlotPatch,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .patch_time_slot(operation_id, slot_id, patch, Timestamp::now())
                .await,
        )
    }

    pub async fn delete_time_slot(
        &self,
        operation_id: OperationId,
        slot_id: TimeSlotId,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .delete_time_slot(operation_id, slot_id, Timestamp::now())
                .await,
        )
    }

    pub async fn append_slot_task(
        &self,
        operation_id: OperationId,
        slot_id: TimeSlotId,
        task_id: TaskId,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .append_slot_task(operation_id, slot_id, task_id, Timestamp::now())
                .await,
        )
    }

    pub async fn remove_slot_task(
        &self,
        operation_id: OperationId,
        slot_id: TimeSlotId,
        task_id: TaskId,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .remove_slot_task(operation_id, slot_id, task_id, Timestamp::now())
                .await,
        )
    }

    pub async fn reorder_slot_tasks(
        &self,
        operation_id: OperationId,
        slot_id: TimeSlotId,
        ordered_ids: Vec<TaskId>,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .reorder_slot_tasks(operation_id, slot_id, ordered_ids, Timestamp::now())
                .await,
        )
    }

    pub async fn move_time_block(
        &self,
        operation_id: OperationId,
        block_id: TimeBlockId,
        range: TimeBlockRangePatch,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .set_time_block_range(operation_id, block_id, range, Timestamp::now())
                .await,
        )
    }

    pub async fn resize_time_block(
        &self,
        operation_id: OperationId,
        block_id: TimeBlockId,
        range: TimeBlockRangePatch,
    ) -> Result<CommittedMutation, AppError> {
        // Move and resize share one range-write implementation.
        self.move_time_block(operation_id, block_id, range).await
    }

    pub async fn preview_replan_past_blocks(&self) -> Result<ReplanPastBlocksPreview, AppError> {
        self.preview_replan_past_blocks_with(TemporalContext::sample_now())
            .await
    }

    /// Internal/test seam with an explicit sampled civil today.
    pub async fn preview_replan_past_blocks_with(
        &self,
        temporal: TemporalContext,
    ) -> Result<ReplanPastBlocksPreview, AppError> {
        self.repository
            .preview_replan_past_blocks(temporal)
            .await
            .map_err(Into::into)
    }

    pub async fn replan_past_blocks(
        &self,
        operation_id: OperationId,
        action: ReplanPastBlocksAction,
        expected_as_of_date: Date,
        expected_candidate_ids: Vec<TimeBlockId>,
    ) -> Result<CommittedMutation, AppError> {
        self.replan_past_blocks_with(
            operation_id,
            action,
            expected_as_of_date,
            expected_candidate_ids,
            TemporalContext::sample_now(),
        )
        .await
    }

    /// Internal/test seam with an explicit sampled civil today.
    pub async fn replan_past_blocks_with(
        &self,
        operation_id: OperationId,
        action: ReplanPastBlocksAction,
        expected_as_of_date: Date,
        expected_candidate_ids: Vec<TimeBlockId>,
        temporal: TemporalContext,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .replan_past_blocks(
                    operation_id,
                    action,
                    expected_as_of_date,
                    expected_candidate_ids,
                    Timestamp::now(),
                    temporal,
                )
                .await,
        )
    }

    /// Page through `list_tasks` at [`TASK_COLLECT_PAGE_SIZE`] under one sampled `as_of`.
    ///
    /// Stops cleanly when the final page is short. Fails with
    /// [`AppError::ResultLimitExceeded`] before returning when more than `cap`
    /// tasks match. Retries the whole collection once if page revisions drift;
    /// a second drift fails with [`AppError::Conflict`] so callers resync.
    pub async fn collect_task_query_pages(
        &self,
        base_query: TaskQuery,
        as_of: TaskListAsOf,
        cap: usize,
    ) -> Result<CollectedTasks, AppError> {
        match self
            .collect_task_query_pages_once(&base_query, as_of, cap)
            .await
        {
            Ok(collected) => Ok(collected),
            Err(AppError::Conflict) => {
                self.collect_task_query_pages_once(&base_query, as_of, cap)
                    .await
            }
            Err(error) => Err(error),
        }
    }

    async fn collect_task_query_pages_once(
        &self,
        base_query: &TaskQuery,
        as_of: TaskListAsOf,
        cap: usize,
    ) -> Result<CollectedTasks, AppError> {
        let page_size = TASK_COLLECT_PAGE_SIZE.min(MAX_QUERY_PAGE_LIMIT);
        let mut tasks = Vec::new();
        let mut cursor = None;
        let mut revision = None;

        loop {
            let mut query = base_query.clone();
            query.cursor = cursor.take();
            query.limit = Some(page_size);
            query.validate()?;

            let page = self
                .repository
                .list_tasks(query, as_of)
                .await
                .map_err(AppError::from)?;

            match revision {
                None => revision = Some(page.revision),
                Some(expected) if expected != page.revision => {
                    return Err(AppError::Conflict);
                }
                Some(_) => {}
            }

            if tasks.len().saturating_add(page.tasks.len()) > cap {
                return Err(AppError::ResultLimitExceeded);
            }
            tasks.extend(page.tasks);

            match page.next_cursor {
                None => break,
                Some(_) if tasks.len() == cap => {
                    // A non-empty next page would push the total over the cap.
                    return Err(AppError::ResultLimitExceeded);
                }
                Some(next) => cursor = Some(next),
            }
        }

        Ok(CollectedTasks {
            tasks,
            revision: revision.unwrap_or(0),
            as_of_date: as_of.as_of_date,
        })
    }

    async fn load_analysis_tasks(&self, as_of: TaskListAsOf) -> Result<CollectedTasks, AppError> {
        let page =
            self.repository
                .list_analysis_tasks(as_of)
                .await
                .map_err(|error| match error {
                    RepositoryError::OperationTooLarge => AppError::ResultLimitExceeded,
                    error => AppError::from(error),
                })?;
        Ok(CollectedTasks {
            tasks: page.tasks,
            revision: page.revision,
            as_of_date: as_of.as_of_date,
        })
    }

    /// Calendar range: tasks with civil `due_date` inside `[from, to]`.
    pub async fn calendar_tasks(
        &self,
        from: Date,
        to: Date,
        project_id: Option<ProjectId>,
        as_of: TaskListAsOf,
    ) -> Result<CalendarTasksPage, AppError> {
        validate_calendar_date_range(from, to)?;
        let mut query = TaskQuery::new();
        query.filter.due_after = Some(from);
        query.filter.due_before = Some(to);
        query.filter.statuses = vec![
            TaskStatus::Pending,
            TaskStatus::Completed,
            TaskStatus::Cancelled,
        ];
        if let Some(project_id) = project_id {
            query.filter.project_id = Some(Some(project_id));
        }
        query.sort = TaskSort::DueAsc;
        let collected = self
            .collect_task_query_pages(query, as_of, MAX_CALENDAR_TASKS)
            .await?;
        Ok(CalendarTasksPage {
            tasks: collected.tasks,
            revision: collected.revision,
        })
    }

    pub async fn get_settings(&self) -> Result<AppSettings, AppError> {
        self.repository.get_settings().await.map_err(AppError::from)
    }

    pub async fn patch_settings(
        &self,
        operation_id: OperationId,
        patch: SettingsPatch,
    ) -> Result<CommittedMutation, AppError> {
        patch.validate()?;
        self.commit(
            self.repository
                .patch_settings(operation_id, patch, Timestamp::now())
                .await,
        )
    }

    /// Parse transfer content into a fingerprint-bound import preview.
    pub async fn preview_import(
        &self,
        format: TransferFormat,
        content: String,
    ) -> Result<TransferPreview, AppError> {
        self.repository
            .preview_import(format, content)
            .await
            .map_err(AppError::from)
    }

    /// Apply a transfer import after re-validating the content fingerprint.
    pub async fn apply_import(
        &self,
        operation_id: OperationId,
        apply: TransferApply,
    ) -> Result<CommittedMutation, AppError> {
        let fresh = preview_transfer(apply.format, &apply.content).map_err(map_transfer_error)?;
        if fresh.content_fingerprint != apply.fingerprint
            || !validate_preview_matches_apply(&fresh, &apply)
        {
            return Err(AppError::Conflict);
        }
        self.commit(
            self.repository
                .apply_import(operation_id, apply, Timestamp::now())
                .await,
        )
    }

    /// Create a complete framed profile backup artifact on private staged disk.
    pub async fn create_backup(&self) -> Result<StagedFile, AppError> {
        self.repository
            .create_backup()
            .await
            .map_err(AppError::from)
    }

    /// Fully validate an uploaded backup and rotate its candidate epoch before maintenance.
    pub async fn prepare_restore(&self, upload: StagedFile) -> Result<StagedFile, AppError> {
        if upload.is_empty() {
            return Err(AppError::Validation(ValidationError::Empty {
                field: "backup",
            }));
        }
        self.repository
            .prepare_restore(upload)
            .await
            .map_err(AppError::from)
    }

    /// Cut over to a previously validated and epoch-rotated candidate.
    pub async fn restore_backup(&self, candidate: StagedFile) -> Result<(), AppError> {
        self.repository
            .restore_backup(candidate)
            .await
            .map_err(AppError::from)
    }

    // ── AI persistence (Wave 3a) ────────────────────────────────────────────

    pub async fn create_ai_session(
        &self,
        operation_id: OperationId,
        request: CreateAiSessionRequest,
    ) -> Result<CommittedMutation, AppError> {
        // Fresh ID per attempt; excluded from receipt request bytes so exact retries
        // replay the original committed resource even when this throwaway differs.
        self.commit(
            self.repository
                .create_ai_session(
                    operation_id,
                    AiSessionId::new(),
                    request.title,
                    Timestamp::now(),
                )
                .await,
        )
    }

    pub async fn rename_ai_session(
        &self,
        operation_id: OperationId,
        request: RenameAiSessionRequest,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .rename_ai_session(
                    operation_id,
                    request.session_id,
                    request.title,
                    Timestamp::now(),
                )
                .await,
        )
    }

    pub async fn delete_ai_session(
        &self,
        operation_id: OperationId,
        request: DeleteAiSessionRequest,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .delete_ai_session(operation_id, request.session_id, Timestamp::now())
                .await,
        )
    }

    pub async fn clear_ai_session(
        &self,
        operation_id: OperationId,
        request: ClearAiSessionRequest,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .clear_ai_session(operation_id, request.session_id, Timestamp::now())
                .await,
        )
    }

    pub async fn get_ai_session(&self, session_id: AiSessionId) -> Result<AiSession, AppError> {
        self.repository
            .get_ai_session(session_id)
            .await
            .map_err(AppError::from)
    }

    pub async fn list_ai_sessions(
        &self,
        request: ListAiSessionsRequest,
    ) -> Result<AiSessionListPage, AppError> {
        let limit = request.validated_limit()?;
        self.repository
            .list_ai_sessions(request.cursor, limit)
            .await
            .map_err(AppError::from)
    }

    pub async fn upsert_ai_message(
        &self,
        operation_id: OperationId,
        request: UpsertAiMessageRequest,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .upsert_ai_message(
                    operation_id,
                    request.message_id,
                    request.session_id,
                    request.turn_id,
                    request.role,
                    request.status,
                    request.content,
                    Timestamp::now(),
                )
                .await,
        )
    }

    pub async fn get_ai_message(&self, message_id: AiMessageId) -> Result<AiMessage, AppError> {
        self.repository
            .get_ai_message(message_id)
            .await
            .map_err(AppError::from)
    }

    pub async fn list_ai_messages(
        &self,
        request: ListAiMessagesRequest,
    ) -> Result<Vec<AiMessage>, AppError> {
        let limit = request.validated_limit()?;
        self.repository
            .list_ai_messages(request.session_id, request.after_sequence, limit)
            .await
            .map_err(AppError::from)
    }

    pub async fn create_ai_memory(
        &self,
        operation_id: OperationId,
        request: CreateAiMemoryRequest,
    ) -> Result<CommittedMutation, AppError> {
        // Fresh ID per attempt; excluded from receipt request bytes so exact retries
        // replay the original committed resource even when this throwaway differs.
        self.commit(
            self.repository
                .create_ai_memory(
                    operation_id,
                    AiMemoryId::new(),
                    request.content,
                    Timestamp::now(),
                )
                .await,
        )
    }

    pub async fn update_ai_memory(
        &self,
        operation_id: OperationId,
        request: UpdateAiMemoryRequest,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .update_ai_memory(
                    operation_id,
                    request.memory_id,
                    request.content,
                    Timestamp::now(),
                )
                .await,
        )
    }

    pub async fn delete_ai_memory(
        &self,
        operation_id: OperationId,
        request: DeleteAiMemoryRequest,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .delete_ai_memory(operation_id, request.memory_id, Timestamp::now())
                .await,
        )
    }

    pub async fn link_ai_session_memory(
        &self,
        operation_id: OperationId,
        request: LinkAiSessionMemoryRequest,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .link_ai_session_memory(
                    operation_id,
                    request.session_id,
                    request.memory_id,
                    Timestamp::now(),
                )
                .await,
        )
    }

    pub async fn get_ai_memory(&self, memory_id: AiMemoryId) -> Result<AiMemory, AppError> {
        self.repository
            .get_ai_memory(memory_id)
            .await
            .map_err(AppError::from)
    }

    pub async fn list_ai_memories(
        &self,
        request: ListAiMemoriesRequest,
    ) -> Result<AiMemoryListPage, AppError> {
        let limit = request.validated_limit()?;
        self.repository
            .list_ai_memories(request.cursor, limit)
            .await
            .map_err(AppError::from)
    }

    pub async fn select_ai_memories_for_context(
        &self,
        request: SelectAiMemoriesRequest,
    ) -> Result<Vec<AiMemory>, AppError> {
        let limit = request.validated_limit()?;
        self.repository
            .select_ai_memories_for_context(request.session_id, limit)
            .await
            .map_err(AppError::from)
    }

    pub async fn propose_ai_approval(
        &self,
        operation_id: OperationId,
        request: ProposeAiApprovalRequest,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .propose_ai_approval(
                    operation_id,
                    request.approval_id,
                    request.session_id,
                    request.turn_id,
                    request.run_id,
                    request.generation,
                    request.tool_name,
                    request.arguments_json,
                    request.assistant_content,
                    Timestamp::now(),
                )
                .await,
        )
    }

    pub async fn set_ai_approval_status(
        &self,
        operation_id: OperationId,
        request: SetAiApprovalStatusRequest,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .set_ai_approval_status(
                    operation_id,
                    request.approval_id,
                    request.status,
                    request.dispatch_operation_id.map(|id| id.to_string()),
                    request.assistant_content,
                    Timestamp::now(),
                )
                .await,
        )
    }

    pub async fn get_ai_approval(
        &self,
        approval_id: AiApprovalId,
    ) -> Result<AiToolApproval, AppError> {
        self.repository
            .get_ai_approval(approval_id)
            .await
            .map_err(AppError::from)
    }

    pub async fn list_dispatching_ai_approvals(&self) -> Result<Vec<AiToolApproval>, AppError> {
        self.repository
            .list_dispatching_ai_approvals()
            .await
            .map_err(AppError::from)
    }

    /// Replay trusted mutation receipt material without re-evaluating changed product state.
    pub async fn recover_operation_receipt(
        &self,
        operation_id: OperationId,
    ) -> Result<CommittedMutation, AppError> {
        self.repository
            .recover_operation_receipt(operation_id)
            .await
            .map_err(AppError::from)
    }

    pub async fn upsert_ai_run_state(
        &self,
        operation_id: OperationId,
        request: UpsertAiRunStateRequest,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .upsert_ai_run_state(operation_id, request.state, Timestamp::now())
                .await,
        )
    }

    pub async fn get_ai_run_state(&self, run_id: AiRunId) -> Result<AiRunState, AppError> {
        self.repository
            .get_ai_run_state(run_id)
            .await
            .map_err(AppError::from)
    }

    pub async fn get_ai_run_for_assistant(
        &self,
        assistant_message_id: AiMessageId,
    ) -> Result<AiRunState, AppError> {
        self.repository
            .get_ai_run_for_assistant(assistant_message_id)
            .await
            .map_err(AppError::from)
    }

    pub async fn ensure_ai_response_current(&self, run_id: AiRunId) -> Result<(), AppError> {
        self.repository
            .ensure_ai_response_current(run_id)
            .await
            .map_err(AppError::from)
    }

    pub async fn reserve_daily_ai_response(
        &self,
        operation_id: OperationId,
        request: ReserveDailyAiResponseRequest,
    ) -> Result<PreparedAiResponse, AppError> {
        let result = self
            .repository
            .reserve_daily_ai_response(operation_id, request, Timestamp::now())
            .await
            .map_err(AppError::from)?;
        if result.mutation.newly_committed {
            self.events.publish(result.mutation.event.clone());
        }
        Ok(result)
    }

    pub async fn rewrite_ai_response(
        &self,
        operation_id: OperationId,
        request: RewriteAiResponseRequest,
    ) -> Result<PreparedAiResponse, AppError> {
        let result = self
            .repository
            .rewrite_ai_response(operation_id, request, Timestamp::now())
            .await
            .map_err(AppError::from)?;
        if result.mutation.newly_committed {
            self.events.publish(result.mutation.event.clone());
        }
        Ok(result)
    }

    pub async fn cancel_ai_response(
        &self,
        operation_id: OperationId,
        request: CancelAiResponseRequest,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .cancel_ai_response(
                    operation_id,
                    request.assistant_message_id,
                    request.session_id,
                    request.turn_id,
                    request.run_id,
                    request.generation,
                    request.content,
                    Timestamp::now(),
                )
                .await,
        )
    }

    pub async fn finish_ai_response(
        &self,
        operation_id: OperationId,
        request: FinishAiResponseRequest,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .finish_ai_response(
                    operation_id,
                    request.assistant_message_id,
                    request.session_id,
                    request.turn_id,
                    request.run_id,
                    request.generation,
                    request.message_status,
                    request.content,
                    request.run_phase,
                    request.dispatch_operation_id.map(|id| id.to_string()),
                    Timestamp::now(),
                )
                .await,
        )
    }

    /// Read presence-only private credential metadata without publishing an event.
    pub async fn list_ai_secret_metadata(&self) -> Result<Vec<AiSecretMetadata>, AppError> {
        self.repository
            .list_ai_secret_metadata()
            .await
            .map_err(AppError::from)
    }

    /// Resolve private credential material transiently for provider endpoint construction.
    pub async fn resolve_ai_secret(
        &self,
        credential_id: AiCredentialId,
    ) -> Result<crate::AiSecretBytes, AppError> {
        self.repository
            .resolve_ai_secret(credential_id)
            .await
            .map_err(AppError::from)
    }

    pub async fn bind_ai_credential(
        &self,
        operation_id: OperationId,
        request: BindAiCredentialRequest,
    ) -> Result<AiCredentialBindResult, AppError> {
        let result = self
            .repository
            .bind_ai_credential(
                operation_id,
                request.target,
                request.kind,
                request.secret,
                Timestamp::now(),
            )
            .await
            .map_err(AppError::from)?;
        if result.mutation.newly_committed {
            self.events.publish(result.mutation.event.clone());
        }
        Ok(result)
    }

    pub async fn clear_ai_credential(
        &self,
        operation_id: OperationId,
        request: ClearAiCredentialRequest,
    ) -> Result<CommittedMutation, AppError> {
        self.commit(
            self.repository
                .clear_ai_credential_binding(operation_id, request.target, Timestamp::now())
                .await,
        )
    }

    /// Best-effort SQLite pager cache release through the profile repository worker.
    ///
    /// Operational reclaim only: no events, receipts, or durable mutation.
    pub async fn release_cached_memory(&self) -> Result<(), AppError> {
        self.repository
            .release_cached_memory()
            .await
            .map_err(AppError::from)
    }

    /// Serialize transferable tasks into a private staged file using bounded storage pages.
    pub async fn export_tasks(&self, format: ExportFormat) -> Result<StagedFile, AppError> {
        self.repository
            .create_export(format)
            .await
            .map_err(AppError::from)
    }

    /// Compatibility projection of persisted settings for Phase 3 temporal callers.
    ///
    /// Samples the current system IANA zone on each read; zone is not persisted.
    pub async fn temporal_settings_from_store(&self) -> Result<TemporalSettings, AppError> {
        let settings = self.get_settings().await?;
        let time_zone = Zoned::now()
            .time_zone()
            .iana_name()
            .unwrap_or("UTC")
            .to_owned();
        Ok(TemporalSettings::from_app_settings(&settings, time_zone))
    }

    pub async fn daily_plan(
        &self,
        date: Date,
        capacity: Option<DailyCapacityMinutes>,
        zone: &TimeZone,
    ) -> Result<DailyPlanPage, AppError> {
        let settings = self.get_settings().await?;
        let capacity = match capacity {
            Some(value) => Some(value),
            None => Some(DailyCapacityMinutes::new(
                settings.planning.capacity_minutes,
            )?),
        };
        let as_of = TaskListAsOf::for_local_date(date, zone)?;
        let collected = self.load_analysis_tasks(as_of).await?;
        let summary = daily_plan_summary(&collected.tasks, date, capacity);
        Ok(DailyPlanPage::from_summary(
            summary,
            &collected.tasks,
            collected.revision,
        ))
    }

    pub async fn end_of_day(
        &self,
        date: Date,
        capacity: Option<DailyCapacityMinutes>,
        zone: &TimeZone,
    ) -> Result<EndOfDayPage, AppError> {
        let settings = self.get_settings().await?;
        let capacity_minutes = match capacity {
            Some(value) => value.get(),
            None => settings.planning.capacity_minutes,
        };
        let as_of = TaskListAsOf::for_local_date(date, zone)?;
        let collected = self.load_analysis_tasks(as_of).await?;
        let summary = end_of_day_summary(&collected.tasks, date, zone);
        Ok(EndOfDayPage::from_summary(
            summary,
            &collected.tasks,
            capacity_minutes,
            collected.revision,
        ))
    }

    pub async fn weekly_review(
        &self,
        date: Date,
        week_start: Option<WeekStart>,
        zone: &TimeZone,
    ) -> Result<WeeklyReviewPage, AppError> {
        let settings = self.get_settings().await?;
        let week_start = week_start.unwrap_or(settings.date_time.week_start);
        let as_of = TaskListAsOf::for_local_date(date, zone)?;
        let collected = self.load_analysis_tasks(as_of).await?;
        let catalog = self.list_catalog().await?;
        if catalog.revision != collected.revision {
            // One snapshot pair only: retry analysis+catalog once on drift.
            let collected = self.load_analysis_tasks(as_of).await?;
            let catalog = self.list_catalog().await?;
            if catalog.revision != collected.revision {
                return Err(AppError::Conflict);
            }
            return Self::weekly_from_parts(collected, &catalog.projects, date, week_start, zone);
        }
        Self::weekly_from_parts(collected, &catalog.projects, date, week_start, zone)
    }

    /// AI/tool weekly review: bounded task snapshot + exact lookup of referenced projects only.
    ///
    /// Does not call `list_catalog`. When unique referenced project IDs exceed
    /// [`MAX_BULK_IDS`], the ID set is truncated deterministically and
    /// `projects_truncated` is set.
    pub async fn weekly_review_bounded(
        &self,
        date: Date,
        week_start: Option<WeekStart>,
        zone: &TimeZone,
    ) -> Result<(WeeklyReviewPage, bool), AppError> {
        let settings = self.get_settings().await?;
        let week_start = week_start.unwrap_or(settings.date_time.week_start);
        let as_of = TaskListAsOf::for_local_date(date, zone)?;
        let collected = self.load_analysis_tasks(as_of).await?;
        let (project_ids, projects_truncated) = referenced_project_ids(&collected.tasks);
        let projects_page = self.get_projects_by_ids(project_ids).await?;
        if projects_page.revision != collected.revision {
            let collected = self.load_analysis_tasks(as_of).await?;
            let (project_ids, projects_truncated) = referenced_project_ids(&collected.tasks);
            let projects_page = self.get_projects_by_ids(project_ids).await?;
            if projects_page.revision != collected.revision {
                return Err(AppError::Conflict);
            }
            let page = Self::weekly_from_parts(
                collected,
                &projects_page.projects,
                date,
                week_start,
                zone,
            )?;
            return Ok((page, projects_truncated));
        }
        let page =
            Self::weekly_from_parts(collected, &projects_page.projects, date, week_start, zone)?;
        Ok((page, projects_truncated))
    }

    fn weekly_from_parts(
        collected: CollectedTasks,
        projects: &[junban_domain::Project],
        date: Date,
        week_start: WeekStart,
        zone: &TimeZone,
    ) -> Result<WeeklyReviewPage, AppError> {
        let summary = weekly_review_summary(&collected.tasks, projects, date, week_start, zone)?;
        let top_accomplishment_tasks =
            tasks_for_ids(&collected.tasks, &summary.top_accomplishment_ids);
        let overdue_tasks = tasks_for_ids(&collected.tasks, &summary.overdue_task_ids);
        Ok(WeeklyReviewPage {
            summary,
            top_accomplishment_tasks,
            overdue_tasks,
            revision: collected.revision,
        })
    }

    pub async fn stats(
        &self,
        from: Date,
        to: Date,
        today: Date,
        zone: &TimeZone,
    ) -> Result<StatsPage, AppError> {
        validate_stats_date_range(from, to)?;
        let as_of = TaskListAsOf::for_local_date(today, zone)?;
        let collected = self.load_analysis_tasks(as_of).await?;
        let summary = stats_summary(&collected.tasks, from, to, today, zone)?;
        Ok(StatsPage {
            summary,
            revision: collected.revision,
        })
    }

    pub async fn nudges(
        &self,
        date: Date,
        capacity: Option<DailyCapacityMinutes>,
        zone: &TimeZone,
    ) -> Result<NudgesPage, AppError> {
        let settings = self.get_settings().await?;
        let as_of = TaskListAsOf::for_local_date(date, zone)?;
        let collected = self.load_analysis_tasks(as_of).await?;
        // Feature visibility is UI-owned; evaluation still uses persisted capacity/rules.
        let capacity = match capacity {
            Some(value) => value,
            None => DailyCapacityMinutes::new(settings.planning.capacity_minutes)?,
        };
        let enabled: Vec<NudgeRuleKind> = settings
            .planning
            .nudge_rules
            .iter()
            .filter(|rule| rule.enabled)
            .map(|rule| rule.kind)
            .collect();
        let stale_after_days = settings
            .planning
            .nudge_rules
            .iter()
            .find(|rule| rule.kind == NudgeRuleKind::StaleTask)
            .and_then(|rule| rule.threshold);
        let facts = evaluate_nudges(
            &collected.tasks,
            date,
            capacity,
            zone,
            &enabled,
            stale_after_days,
        );
        let mut ids = Vec::new();
        for rule in &facts.rules {
            for id in &rule.task_ids {
                if !ids.contains(id) {
                    ids.push(*id);
                }
            }
        }
        let tasks = tasks_for_ids(&collected.tasks, &ids);
        Ok(NudgesPage {
            facts,
            tasks,
            revision: collected.revision,
        })
    }

    /// Static Phase 3-compatible defaults derived from [`AppSettings`].
    #[must_use]
    pub fn temporal_settings(zone: &TimeZone) -> TemporalSettings {
        default_temporal_settings(zone)
    }

    pub async fn eat_the_frog(
        &self,
        date: Date,
        zone: &TimeZone,
    ) -> Result<EatTheFrogPage, AppError> {
        // Feature visibility is UI-owned; always compute the selection from analysis tasks.
        let as_of = TaskListAsOf::for_local_date(date, zone)?;
        let collected = self.load_analysis_tasks(as_of).await?;
        let task = select_eat_the_frog(&collected.tasks)
            .and_then(|id| collected.tasks.iter().find(|task| task.id == id).cloned());
        Ok(EatTheFrogPage {
            task,
            revision: collected.revision,
        })
    }

    pub async fn task_jar(&self, date: Date, zone: &TimeZone) -> Result<TaskJarPage, AppError> {
        // Feature visibility is UI-owned; always compute candidates from analysis tasks.
        let as_of = TaskListAsOf::for_local_date(date, zone)?;
        let collected = self.load_analysis_tasks(as_of).await?;
        let task_ids = task_jar_candidates(&collected.tasks, date);
        let tasks = tasks_for_ids(&collected.tasks, &task_ids);
        Ok(TaskJarPage {
            task_ids,
            tasks,
            revision: collected.revision,
        })
    }

    pub async fn dopamine_menu(
        &self,
        date: Date,
        zone: &TimeZone,
    ) -> Result<DopamineMenuPage, AppError> {
        let as_of = TaskListAsOf::for_local_date(date, zone)?;
        let collected = self.load_analysis_tasks(as_of).await?;
        let task_ids = dopamine_menu_task_ids(&collected.tasks);
        let tasks = tasks_for_ids(&collected.tasks, &task_ids);
        Ok(DopamineMenuPage {
            task_ids,
            tasks,
            revision: collected.revision,
        })
    }

    pub async fn publish_plugin_package(
        &self,
        bytes: Vec<u8>,
    ) -> Result<crate::PluginPackageAuthority, AppError> {
        if bytes.len() > junban_plugin_sdk::PACKAGE_BYTES_MAX {
            return Err(AppError::OperationTooLarge);
        }
        self.repository
            .publish_plugin_package(bytes)
            .await
            .map_err(AppError::from)
    }

    pub async fn reconcile_plugin_packages(
        &self,
        now: Timestamp,
    ) -> Result<crate::PluginPackageReconciliation, AppError> {
        self.repository
            .reconcile_plugin_packages(now)
            .await
            .map_err(AppError::from)
    }

    pub async fn get_installed_plugin_profile(
        &self,
    ) -> Result<crate::InstalledPluginProfile, AppError> {
        self.repository
            .get_installed_plugin_profile()
            .await
            .map_err(AppError::from)
    }

    pub async fn get_installed_plugin(
        &self,
        plugin_id: junban_plugin_sdk::PluginId,
    ) -> Result<crate::InstalledPlugin, AppError> {
        self.repository
            .get_installed_plugin(plugin_id)
            .await
            .map_err(AppError::from)
    }

    pub async fn install_plugin(
        &self,
        operation_id: OperationId,
        request: crate::InstallPluginRequest,
        now: Timestamp,
    ) -> Result<crate::PluginMutationOutcome, AppError> {
        let outcome = self
            .repository
            .install_plugin(operation_id, request, now)
            .await
            .map_err(AppError::from)?;
        self.publish_plugin_outcome(&outcome);
        Ok(outcome)
    }

    pub async fn uninstall_plugin(
        &self,
        operation_id: OperationId,
        plugin_id: junban_plugin_sdk::PluginId,
        now: Timestamp,
    ) -> Result<crate::PluginMutationOutcome, AppError> {
        let outcome = self
            .repository
            .uninstall_plugin(operation_id, plugin_id, now)
            .await
            .map_err(AppError::from)?;
        self.publish_plugin_outcome(&outcome);
        Ok(outcome)
    }

    pub async fn set_plugin_desired_enabled(
        &self,
        operation_id: OperationId,
        plugin_id: junban_plugin_sdk::PluginId,
        enabled: bool,
        now: Timestamp,
    ) -> Result<crate::PluginMutationOutcome, AppError> {
        let outcome = self
            .repository
            .set_plugin_desired_enabled(operation_id, plugin_id, enabled, now)
            .await
            .map_err(AppError::from)?;
        self.publish_plugin_outcome(&outcome);
        Ok(outcome)
    }

    pub async fn retry_plugin(
        &self,
        operation_id: OperationId,
        plugin_id: junban_plugin_sdk::PluginId,
        now: Timestamp,
    ) -> Result<CommittedMutation, AppError> {
        let result = self
            .repository
            .retry_plugin(operation_id, plugin_id, now)
            .await;
        self.commit(result)
    }

    pub async fn list_publisher_trust(&self) -> Result<Vec<crate::PublisherTrust>, AppError> {
        self.repository
            .list_publisher_trust()
            .await
            .map_err(AppError::from)
    }

    pub async fn trust_publisher(
        &self,
        operation_id: OperationId,
        request: crate::TrustPublisherRequest,
        now: Timestamp,
    ) -> Result<CommittedMutation, AppError> {
        let result = self
            .repository
            .trust_publisher(operation_id, request, now)
            .await;
        self.commit(result)
    }

    pub async fn revoke_publisher(
        &self,
        operation_id: OperationId,
        key_id: junban_plugin_sdk::Sha256Digest,
        now: Timestamp,
    ) -> Result<CommittedMutation, AppError> {
        let result = self
            .repository
            .revoke_publisher(operation_id, key_id, now)
            .await;
        self.commit(result)
    }

    pub async fn get_community_plugin_policy(
        &self,
    ) -> Result<crate::CommunityPluginPolicy, AppError> {
        self.repository
            .get_community_plugin_policy()
            .await
            .map_err(AppError::from)
    }

    pub async fn set_community_plugin_policy(
        &self,
        operation_id: OperationId,
        enabled: bool,
        now: Timestamp,
    ) -> Result<CommittedMutation, AppError> {
        let result = self
            .repository
            .set_community_plugin_policy(operation_id, enabled, now)
            .await;
        self.commit(result)
    }

    pub async fn list_plugin_grants(
        &self,
        plugin_id: junban_plugin_sdk::PluginId,
    ) -> Result<Vec<crate::PluginGrant>, AppError> {
        self.repository
            .list_plugin_grants(plugin_id)
            .await
            .map_err(AppError::from)
    }

    pub async fn replace_plugin_grants(
        &self,
        operation_id: OperationId,
        request: crate::ReplacePluginGrantsRequest,
        now: Timestamp,
    ) -> Result<CommittedMutation, AppError> {
        let result = self
            .repository
            .replace_plugin_grants(operation_id, request, now)
            .await;
        self.commit(result)
    }

    pub async fn revoke_plugin_grants(
        &self,
        operation_id: OperationId,
        request: crate::RevokePluginGrantsRequest,
        now: Timestamp,
    ) -> Result<CommittedMutation, AppError> {
        let result = self
            .repository
            .revoke_plugin_grants(operation_id, request, now)
            .await;
        self.commit(result)
    }

    pub async fn list_plugin_settings(
        &self,
        plugin_id: junban_plugin_sdk::PluginId,
    ) -> Result<Vec<crate::PluginSetting>, AppError> {
        self.repository
            .list_plugin_settings(plugin_id)
            .await
            .map_err(AppError::from)
    }

    pub async fn set_plugin_setting(
        &self,
        operation_id: OperationId,
        request: crate::SetPluginSettingRequest,
        now: Timestamp,
    ) -> Result<CommittedMutation, AppError> {
        let result = self
            .repository
            .set_plugin_setting(operation_id, request, now)
            .await;
        self.commit(result)
    }

    pub async fn delete_plugin_setting(
        &self,
        operation_id: OperationId,
        request: crate::DeletePluginSettingRequest,
        now: Timestamp,
    ) -> Result<CommittedMutation, AppError> {
        let result = self
            .repository
            .delete_plugin_setting(operation_id, request, now)
            .await;
        self.commit(result)
    }

    pub async fn list_plugin_kv(
        &self,
        plugin_id: junban_plugin_sdk::PluginId,
    ) -> Result<Vec<crate::PluginKvEntry>, AppError> {
        self.repository
            .list_plugin_kv(plugin_id)
            .await
            .map_err(AppError::from)
    }

    pub async fn patch_plugin_kv(
        &self,
        plugin_id: junban_plugin_sdk::PluginId,
        package_generation: u64,
        activation_epoch: u64,
        patch: crate::PluginKvPatch,
        now: Timestamp,
    ) -> Result<Vec<crate::PluginKvEntry>, AppError> {
        self.repository
            .patch_plugin_kv(plugin_id, package_generation, activation_epoch, patch, now)
            .await
            .map_err(AppError::from)
    }

    pub async fn get_plugin_cursor(
        &self,
        plugin_id: junban_plugin_sdk::PluginId,
    ) -> Result<crate::PluginEventCursor, AppError> {
        self.repository
            .get_plugin_cursor(plugin_id)
            .await
            .map_err(AppError::from)
    }

    pub async fn begin_plugin_resync(
        &self,
        plugin_id: junban_plugin_sdk::PluginId,
        package_generation: u64,
        activation_epoch: u64,
        operation_id: OperationId,
        now: Timestamp,
    ) -> Result<crate::PluginResyncSession, AppError> {
        self.repository
            .begin_plugin_resync(
                crate::BeginPluginResyncRequest {
                    operation_id,
                    plugin_id,
                    package_generation,
                    activation_epoch,
                },
                now,
            )
            .await
            .map_err(AppError::from)
    }

    pub async fn list_plugin_resync_page(
        &self,
        request: crate::PluginResyncPageRequest,
        now: Timestamp,
    ) -> Result<crate::PluginResyncPage, AppError> {
        self.repository
            .list_plugin_resync_page(request, now)
            .await
            .map_err(AppError::from)
    }

    pub async fn advance_plugin_cursor(
        &self,
        request: crate::AdvancePluginCursorRequest,
        now: Timestamp,
    ) -> Result<crate::PluginEventCursor, AppError> {
        self.repository
            .advance_plugin_cursor(request, now)
            .await
            .map_err(AppError::from)
    }

    pub async fn reserve_plugin_invocation(
        &self,
        request: crate::ReservePluginInvocationRequest,
        now: Timestamp,
    ) -> Result<crate::ReservedPluginInvocation, AppError> {
        self.repository
            .reserve_plugin_invocation(request, now)
            .await
            .map_err(AppError::from)
    }

    pub async fn transition_plugin_invocation(
        &self,
        request: crate::TransitionPluginInvocationRequest,
        now: Timestamp,
    ) -> Result<crate::PluginInvocation, AppError> {
        self.repository
            .transition_plugin_invocation(request, now)
            .await
            .map_err(AppError::from)
    }

    pub async fn list_plugin_invocations(&self) -> Result<Vec<crate::PluginInvocation>, AppError> {
        self.repository
            .list_plugin_invocations()
            .await
            .map_err(AppError::from)
    }

    pub async fn complete_plugin_invocation(
        &self,
        operation_id: OperationId,
        plugin_id: junban_plugin_sdk::PluginId,
        package_generation: u64,
        activation_epoch: u64,
    ) -> Result<(), AppError> {
        self.repository
            .complete_plugin_invocation(
                operation_id,
                plugin_id,
                package_generation,
                activation_epoch,
            )
            .await
            .map_err(AppError::from)
    }

    pub async fn commit_plugin_invocation(
        &self,
        request: crate::CommitPluginInvocationRequest,
        now: Timestamp,
    ) -> Result<crate::CommittedPluginInvocation, AppError> {
        let committed = self
            .repository
            .commit_plugin_invocation(request, now)
            .await
            .map_err(AppError::from)?;
        if let Some(mutation) = &committed.mutation
            && mutation.newly_committed
        {
            self.events.publish(mutation.event.clone());
        }
        Ok(committed)
    }

    pub async fn update_plugin_bookkeeping(
        &self,
        update: crate::PluginBookkeepingUpdate,
        now: Timestamp,
    ) -> Result<crate::InstalledPlugin, AppError> {
        self.repository
            .update_plugin_bookkeeping(update, now)
            .await
            .map_err(AppError::from)
    }

    fn publish_plugin_outcome(&self, outcome: &crate::PluginMutationOutcome) {
        if let Some(mutation) = outcome.committed()
            && mutation.newly_committed
        {
            self.events.publish(mutation.event.clone());
        }
    }

    fn commit(
        &self,
        result: Result<CommittedMutation, RepositoryError>,
    ) -> Result<CommittedMutation, AppError> {
        let mutation = result.map_err(AppError::from)?;
        // Receipt replays must not republish; only freshly committed mutations fan out.
        if mutation.newly_committed {
            self.events.publish(mutation.event.clone());
        }
        Ok(mutation)
    }
}

fn tasks_for_ids(tasks: &[Task], ids: &[TaskId]) -> Vec<Task> {
    ids.iter()
        .filter_map(|id| tasks.iter().find(|task| task.id == *id).cloned())
        .collect()
}

/// Unique project IDs referenced by tasks, sorted by UUID, capped at [`MAX_BULK_IDS`].
fn referenced_project_ids(tasks: &[Task]) -> (Vec<ProjectId>, bool) {
    let mut ids = tasks
        .iter()
        .filter_map(|task| task.project_id)
        .collect::<Vec<_>>();
    ids.sort_by_key(|id| id.as_uuid());
    ids.dedup();
    let truncated = ids.len() > MAX_BULK_IDS;
    if truncated {
        ids.truncate(MAX_BULK_IDS);
    }
    (ids, truncated)
}

fn map_transfer_error(error: TransferError) -> AppError {
    match error {
        TransferError::ValidationError(error) => AppError::Validation(error),
        TransferError::UnsupportedFormat => AppError::Validation(ValidationError::Invalid {
            field: "format",
            reason: "unsupported transfer format",
        }),
        TransferError::ParseError { .. } => AppError::Validation(ValidationError::Invalid {
            field: "content",
            reason: "invalid transfer content",
        }),
    }
}

/// Phase 3-compatible temporal defaults derived from [`AppSettings`].
///
/// Uses the caller-supplied zone name for the response projection only.
#[must_use]
pub fn default_temporal_settings(zone: &TimeZone) -> TemporalSettings {
    TemporalSettings::from_app_settings(
        &AppSettings::default_settings(),
        zone.iana_name().unwrap_or("UTC"),
    )
}

// Re-export constructors used by tests without forcing callers to import domain pieces.
#[allow(dead_code)]
pub fn project_draft(name: &str, color: &str) -> Result<ProjectDraft, ValidationError> {
    Ok(ProjectDraft {
        name: EntityName::new(name)?,
        color: HexColor::new(color)?,
        icon: None,
        parent_id: None,
        favorite: false,
        archived: false,
        view: Default::default(),
        sort_order: Default::default(),
    })
}

#[allow(dead_code)]
pub fn tag_draft(name: &str, color: &str) -> Result<TagDraft, ValidationError> {
    Ok(TagDraft {
        name: TagName::new(name)?,
        color: HexColor::new(color)?,
    })
}

#[allow(dead_code)]
pub fn filter_draft(name: &str, query: &str) -> Result<SavedFilterDraft, ValidationError> {
    Ok(SavedFilterDraft {
        name: EntityName::new(name)?,
        query: FilterQuery::new(query)?,
        color: None,
        sort_order: Default::default(),
    })
}

#[allow(dead_code)]
pub fn empty_markdown() -> MarkdownText {
    MarkdownText::empty()
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::{AffectedIds, EventCatchUp, EventType, ResourceRef, ResourceSnapshot, ResyncScope};
    use junban_domain::{CivilTimeRange, TaskStatus};
    use uuid::Uuid;

    struct FakeRepository {
        result: Mutex<Result<CommittedMutation, RepositoryError>>,
        calls: Mutex<Vec<&'static str>>,
        /// When set, `list_tasks` pops pages in order (for collect-helper tests).
        list_pages: Mutex<Vec<TaskListPage>>,
        timeblocking_page: Mutex<TimeblockingRangePage>,
        projects_by_ids: Mutex<crate::ProjectListPage>,
    }

    impl FakeRepository {
        fn new(result: Result<CommittedMutation, RepositoryError>) -> Self {
            Self {
                result: Mutex::new(result),
                calls: Mutex::new(Vec::new()),
                list_pages: Mutex::new(Vec::new()),
                timeblocking_page: Mutex::new(TimeblockingRangePage {
                    blocks: Vec::new(),
                    slots: Vec::new(),
                    revision: 0,
                }),
                projects_by_ids: Mutex::new(crate::ProjectListPage {
                    projects: Vec::new(),
                    revision: 0,
                    truncated: false,
                }),
            }
        }

        fn with_list_pages(pages: Vec<TaskListPage>) -> Self {
            Self {
                result: Mutex::new(Err(RepositoryError::Storage("unused".into()))),
                calls: Mutex::new(Vec::new()),
                list_pages: Mutex::new(pages),
                timeblocking_page: Mutex::new(TimeblockingRangePage {
                    blocks: Vec::new(),
                    slots: Vec::new(),
                    revision: 0,
                }),
                projects_by_ids: Mutex::new(crate::ProjectListPage {
                    projects: Vec::new(),
                    revision: 0,
                    truncated: false,
                }),
            }
        }

        fn with_timeblocking_page(page: TimeblockingRangePage) -> Self {
            Self {
                result: Mutex::new(Err(RepositoryError::Storage("unused".into()))),
                calls: Mutex::new(Vec::new()),
                list_pages: Mutex::new(Vec::new()),
                timeblocking_page: Mutex::new(page),
                projects_by_ids: Mutex::new(crate::ProjectListPage {
                    projects: Vec::new(),
                    revision: 0,
                    truncated: false,
                }),
            }
        }

        fn response(&self, call: &'static str) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.calls.lock().unwrap().push(call);
            let result = self.result.lock().unwrap().clone();
            Box::pin(async move { result })
        }
    }

    impl crate::PluginRepository for FakeRepository {
        fn retry_plugin(
            &self,
            _: OperationId,
            _: junban_plugin_sdk::PluginId,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("plugin-retry")
        }

        fn commit_plugin_invocation(
            &self,
            _: crate::CommitPluginInvocationRequest,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, crate::CommittedPluginInvocation> {
            self.calls.lock().unwrap().push("plugin-commit");
            let result = self.result.lock().unwrap().clone().map(|mutation| {
                crate::CommittedPluginInvocation {
                    mutation: Some(mutation),
                    cursor: None,
                }
            });
            Box::pin(async move { result })
        }
    }

    impl Repository for FakeRepository {
        fn create_task(
            &self,
            _: OperationId,
            _: TaskId,
            _: TaskDraft,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("create")
        }
        fn get_task(&self, _: TaskId) -> crate::RepositoryFuture<'_, Task> {
            self.calls.lock().unwrap().push("get");
            Box::pin(async { Err(RepositoryError::NotFound) })
        }
        fn patch_task(
            &self,
            _: OperationId,
            _: TaskId,
            _: TaskPatch,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("patch")
        }
        fn complete_task(
            &self,
            _: OperationId,
            _: TaskId,
            _: Timestamp,
            _: TemporalContext,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("complete")
        }
        fn uncomplete_task(
            &self,
            _: OperationId,
            _: TaskId,
            _: Timestamp,
            _: TemporalContext,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("uncomplete")
        }
        fn cancel_task(
            &self,
            _: OperationId,
            _: TaskId,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("cancel")
        }
        fn reopen_task(
            &self,
            _: OperationId,
            _: TaskId,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("reopen")
        }
        fn delete_task(
            &self,
            _: OperationId,
            _: TaskId,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("delete")
        }
        fn move_task(
            &self,
            _: OperationId,
            _: TaskId,
            _: MoveTarget,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("move")
        }
        fn reorder_tasks(
            &self,
            _: OperationId,
            _: ReorderScope,
            _: Vec<TaskId>,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("reorder")
        }
        fn bulk_tasks(
            &self,
            _: OperationId,
            _: Vec<TaskId>,
            _: BulkAction,
            _: Timestamp,
            _: TemporalContext,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("bulk")
        }
        fn list_tasks(
            &self,
            _: TaskQuery,
            _: TaskListAsOf,
        ) -> crate::RepositoryFuture<'_, TaskListPage> {
            self.calls.lock().unwrap().push("list");
            let page = {
                let mut pages = self.list_pages.lock().unwrap();
                if pages.is_empty() {
                    None
                } else {
                    Some(pages.remove(0))
                }
            };
            Box::pin(async move {
                Ok(page.unwrap_or(TaskListPage {
                    tasks: Vec::new(),
                    revision: 0,
                    as_of_date: "2026-07-28".parse().unwrap(),
                    next_cursor: None,
                }))
            })
        }
        fn list_analysis_tasks(
            &self,
            _: TaskListAsOf,
        ) -> crate::RepositoryFuture<'_, TaskListPage> {
            self.calls.lock().unwrap().push("analysis");
            let page = {
                let mut pages = self.list_pages.lock().unwrap();
                if pages.is_empty() {
                    None
                } else {
                    Some(pages.remove(0))
                }
            };
            Box::pin(async move {
                Ok(page.unwrap_or(TaskListPage {
                    tasks: Vec::new(),
                    revision: 0,
                    as_of_date: "2026-07-28".parse().unwrap(),
                    next_cursor: None,
                }))
            })
        }
        fn list_catalog(&self) -> crate::RepositoryFuture<'_, CatalogSnapshot> {
            self.calls.lock().unwrap().push("list_catalog");
            Box::pin(async {
                Ok(CatalogSnapshot {
                    projects: Vec::new(),
                    sections: Vec::new(),
                    tags: Vec::new(),
                    templates: Vec::new(),
                    saved_filters: Vec::new(),
                    revision: 0,
                })
            })
        }
        fn list_projects_bounded(
            &self,
            _: u32,
        ) -> crate::RepositoryFuture<'_, crate::ProjectListPage> {
            unimplemented!()
        }
        fn list_tags_bounded(&self, _: u32) -> crate::RepositoryFuture<'_, crate::TagListPage> {
            unimplemented!()
        }
        fn get_project(&self, _: ProjectId) -> crate::RepositoryFuture<'_, junban_domain::Project> {
            unimplemented!()
        }
        fn get_projects_by_ids(
            &self,
            _: Vec<ProjectId>,
        ) -> crate::RepositoryFuture<'_, crate::ProjectListPage> {
            self.calls.lock().unwrap().push("get_projects_by_ids");
            let page = self.projects_by_ids.lock().unwrap().clone();
            Box::pin(async move { Ok(page) })
        }
        fn get_project_by_name(
            &self,
            _: junban_domain::EntityName,
        ) -> crate::RepositoryFuture<'_, junban_domain::Project> {
            unimplemented!()
        }
        fn resolve_tags_by_names(
            &self,
            _: Vec<junban_domain::TagName>,
        ) -> crate::RepositoryFuture<'_, Vec<junban_domain::Tag>> {
            unimplemented!()
        }
        fn create_project(
            &self,
            _: OperationId,
            _: ProjectId,
            _: ProjectDraft,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("create_project")
        }
        fn patch_project(
            &self,
            _: OperationId,
            _: ProjectId,
            _: ProjectPatch,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("patch_project")
        }
        fn delete_project(
            &self,
            _: OperationId,
            _: ProjectId,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("delete_project")
        }
        fn create_section(
            &self,
            _: OperationId,
            _: SectionId,
            _: SectionDraft,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("create_section")
        }
        fn patch_section(
            &self,
            _: OperationId,
            _: SectionId,
            _: SectionPatch,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("patch_section")
        }
        fn delete_section(
            &self,
            _: OperationId,
            _: SectionId,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("delete_section")
        }
        fn create_tag(
            &self,
            _: OperationId,
            _: TagId,
            _: TagDraft,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("create_tag")
        }
        fn patch_tag(
            &self,
            _: OperationId,
            _: TagId,
            _: TagPatch,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("patch_tag")
        }
        fn delete_tag(
            &self,
            _: OperationId,
            _: TagId,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("delete_tag")
        }
        fn create_template(
            &self,
            _: OperationId,
            _: TemplateId,
            _: TemplateDraft,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("create_template")
        }
        fn patch_template(
            &self,
            _: OperationId,
            _: TemplateId,
            _: TemplatePatch,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("patch_template")
        }
        fn delete_template(
            &self,
            _: OperationId,
            _: TemplateId,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("delete_template")
        }
        fn apply_template(
            &self,
            _: OperationId,
            _: TaskId,
            _: TemplateApply,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("apply_template")
        }
        fn create_saved_filter(
            &self,
            _: OperationId,
            _: SavedFilterId,
            _: SavedFilterDraft,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("create_filter")
        }
        fn patch_saved_filter(
            &self,
            _: OperationId,
            _: SavedFilterId,
            _: SavedFilterPatch,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("patch_filter")
        }
        fn delete_saved_filter(
            &self,
            _: OperationId,
            _: SavedFilterId,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("delete_filter")
        }
        fn create_comment(
            &self,
            _: OperationId,
            _: CommentId,
            _: TaskId,
            _: CommentBody,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("create_comment")
        }
        fn patch_comment(
            &self,
            _: OperationId,
            _: CommentId,
            _: CommentPatch,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("patch_comment")
        }
        fn delete_comment(
            &self,
            _: OperationId,
            _: CommentId,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("delete_comment")
        }
        fn list_comments(&self, _: TaskId) -> crate::RepositoryFuture<'_, Vec<Comment>> {
            Box::pin(async { Ok(Vec::new()) })
        }
        fn add_relation(
            &self,
            _: OperationId,
            _: TaskId,
            _: TaskId,
            _: RelationKind,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("add_relation")
        }
        fn remove_relation(
            &self,
            _: OperationId,
            _: TaskId,
            _: TaskId,
            _: RelationKind,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("remove_relation")
        }
        fn list_relations(&self, _: TaskId) -> crate::RepositoryFuture<'_, Vec<TaskRelation>> {
            Box::pin(async { Ok(Vec::new()) })
        }
        fn list_task_activity(
            &self,
            _: TaskId,
            _: Option<u64>,
            _: Option<u32>,
            _: u32,
        ) -> crate::RepositoryFuture<'_, Vec<TaskActivity>> {
            Box::pin(async { Ok(Vec::new()) })
        }
        fn list_events(&self, _: u64) -> crate::RepositoryFuture<'_, EventCatchUp> {
            self.calls.lock().unwrap().push("events");
            Box::pin(async {
                Ok(EventCatchUp::Page {
                    events: Vec::new(),
                    has_more: false,
                    latest_revision: 0,
                })
            })
        }
        fn get_sync_state(&self) -> crate::RepositoryFuture<'_, crate::SyncState> {
            self.calls.lock().unwrap().push("get_sync_state");
            Box::pin(async {
                Ok(crate::SyncState {
                    event_epoch: "test-event-epoch".to_owned(),
                    revision: 0,
                })
            })
        }
        fn undo(
            &self,
            _: OperationId,
            _: OperationId,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("undo")
        }
        fn list_task_reminders(
            &self,
            _: TaskId,
        ) -> crate::RepositoryFuture<'_, Vec<ReminderOccurrence>> {
            self.calls.lock().unwrap().push("list_task_reminders");
            Box::pin(async { Ok(Vec::new()) })
        }
        fn reschedule_reminder(
            &self,
            _: OperationId,
            _: TaskId,
            _: Timestamp,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("reschedule_reminder")
        }
        fn dismiss_reminder(
            &self,
            _: OperationId,
            _: TaskId,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("dismiss_reminder")
        }
        fn acquire_reminder_lease(
            &self,
            _: Timestamp,
            _: u64,
        ) -> crate::RepositoryFuture<'_, ReminderDeliveryLease> {
            self.calls.lock().unwrap().push("acquire_reminder_lease");
            Box::pin(async { Err(RepositoryError::Storage("fake lease".into())) })
        }
        fn renew_reminder_lease(
            &self,
            _: ReminderFenceTerm,
            _: Timestamp,
            _: u64,
        ) -> crate::RepositoryFuture<'_, ReminderDeliveryLease> {
            unimplemented!()
        }
        fn release_reminder_lease(
            &self,
            _: ReminderFenceTerm,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, ()> {
            unimplemented!()
        }
        fn claim_due_reminders(
            &self,
            _: ReminderFenceTerm,
            _: Timestamp,
            _: u32,
            _: u64,
        ) -> crate::RepositoryFuture<'_, Vec<ClaimedReminder>> {
            unimplemented!()
        }
        fn settle_reminder_delivered(
            &self,
            _: ReminderFenceTerm,
            _: TaskId,
            _: Timestamp,
            _: u32,
            _: ReminderChannel,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, ()> {
            unimplemented!()
        }
        fn settle_reminder_failed(
            &self,
            _: ReminderFenceTerm,
            _: TaskId,
            _: Timestamp,
            _: u32,
            _: ReminderFailureCode,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, ()> {
            unimplemented!()
        }
        fn mark_owner_lost_reminders(
            &self,
            _: ReminderFenceTerm,
            _: Timestamp,
            _: u32,
        ) -> crate::RepositoryFuture<'_, u32> {
            unimplemented!()
        }
        fn next_reminder_wake_at(&self) -> crate::RepositoryFuture<'_, Option<Timestamp>> {
            self.calls.lock().unwrap().push("next_reminder_wake_at");
            Box::pin(async { Ok(None) })
        }
        fn list_timeblocking_range(
            &self,
            _: TimeblockingRangeQuery,
        ) -> crate::RepositoryFuture<'_, TimeblockingRangePage> {
            self.calls.lock().unwrap().push("list_timeblocking_range");
            let page = self.timeblocking_page.lock().unwrap().clone();
            Box::pin(async move { Ok(page) })
        }
        fn create_time_block(
            &self,
            _: OperationId,
            _: TimeBlockId,
            _: TimeBlockDraft,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("create_time_block")
        }
        fn patch_time_block(
            &self,
            _: OperationId,
            _: TimeBlockId,
            _: TimeBlockPatch,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("patch_time_block")
        }
        fn delete_time_block(
            &self,
            _: OperationId,
            _: TimeBlockId,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("delete_time_block")
        }
        fn create_time_slot(
            &self,
            _: OperationId,
            _: TimeSlotId,
            _: TimeSlotDraft,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("create_time_slot")
        }
        fn patch_time_slot(
            &self,
            _: OperationId,
            _: TimeSlotId,
            _: TimeSlotPatch,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("patch_time_slot")
        }
        fn delete_time_slot(
            &self,
            _: OperationId,
            _: TimeSlotId,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("delete_time_slot")
        }
        fn append_slot_task(
            &self,
            _: OperationId,
            _: TimeSlotId,
            _: TaskId,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("append_slot_task")
        }
        fn remove_slot_task(
            &self,
            _: OperationId,
            _: TimeSlotId,
            _: TaskId,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("remove_slot_task")
        }
        fn reorder_slot_tasks(
            &self,
            _: OperationId,
            _: TimeSlotId,
            _: Vec<TaskId>,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("reorder_slot_tasks")
        }
        fn set_time_block_range(
            &self,
            _: OperationId,
            _: TimeBlockId,
            _: TimeBlockRangePatch,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("set_time_block_range")
        }
        fn preview_replan_past_blocks(
            &self,
            temporal: TemporalContext,
        ) -> crate::RepositoryFuture<'_, ReplanPastBlocksPreview> {
            Box::pin(async move {
                Ok(ReplanPastBlocksPreview {
                    as_of_date: temporal.sampled_completion_date,
                    candidate_ids: Vec::new(),
                    blocks: Vec::new(),
                })
            })
        }
        fn replan_past_blocks(
            &self,
            _: OperationId,
            _: ReplanPastBlocksAction,
            _: Date,
            _: Vec<TimeBlockId>,
            _: Timestamp,
            _: TemporalContext,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("replan_past_blocks")
        }
        fn get_settings(&self) -> crate::RepositoryFuture<'_, AppSettings> {
            self.calls.lock().unwrap().push("get_settings");
            Box::pin(async { Ok(AppSettings::default_settings()) })
        }
        fn patch_settings(
            &self,
            _: OperationId,
            _: SettingsPatch,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("patch_settings")
        }
        fn preview_import(
            &self,
            _: TransferFormat,
            _: String,
        ) -> crate::RepositoryFuture<'_, TransferPreview> {
            self.calls.lock().unwrap().push("preview_import");
            Box::pin(async {
                Err(RepositoryError::Storage(
                    "preview_import unused in unit fake".into(),
                ))
            })
        }
        fn apply_import(
            &self,
            _: OperationId,
            _: TransferApply,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("apply_import")
        }
        fn create_export(&self, _: ExportFormat) -> crate::RepositoryFuture<'_, StagedFile> {
            self.calls.lock().unwrap().push("create_export");
            Box::pin(async {
                Err(RepositoryError::Storage(
                    "create_export unused in unit fake".into(),
                ))
            })
        }
        fn create_backup(&self) -> crate::RepositoryFuture<'_, StagedFile> {
            self.calls.lock().unwrap().push("create_backup");
            Box::pin(async {
                Err(RepositoryError::Storage(
                    "create_backup unused in unit fake".into(),
                ))
            })
        }
        fn prepare_restore(&self, _: StagedFile) -> crate::RepositoryFuture<'_, StagedFile> {
            self.calls.lock().unwrap().push("prepare_restore");
            Box::pin(async {
                Err(RepositoryError::Storage(
                    "prepare_restore unused in unit fake".into(),
                ))
            })
        }
        fn restore_backup(&self, _: StagedFile) -> crate::RepositoryFuture<'_, ()> {
            self.calls.lock().unwrap().push("restore_backup");
            Box::pin(async {
                Err(RepositoryError::Storage(
                    "restore_backup unused in unit fake".into(),
                ))
            })
        }
        fn create_ai_session(
            &self,
            _: OperationId,
            _: AiSessionId,
            _: String,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("create_ai_session")
        }
        fn rename_ai_session(
            &self,
            _: OperationId,
            _: AiSessionId,
            _: String,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("rename_ai_session")
        }
        fn delete_ai_session(
            &self,
            _: OperationId,
            _: AiSessionId,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("delete_ai_session")
        }
        fn clear_ai_session(
            &self,
            _: OperationId,
            _: AiSessionId,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("clear_ai_session")
        }
        fn get_ai_session(&self, _: AiSessionId) -> crate::RepositoryFuture<'_, AiSession> {
            self.calls.lock().unwrap().push("get_ai_session");
            Box::pin(async { Err(RepositoryError::NotFound) })
        }
        fn list_ai_sessions(
            &self,
            _: Option<crate::AiSessionCursor>,
            _: u32,
        ) -> crate::RepositoryFuture<'_, AiSessionListPage> {
            self.calls.lock().unwrap().push("list_ai_sessions");
            Box::pin(async {
                Ok(AiSessionListPage {
                    sessions: Vec::new(),
                    next_cursor: None,
                })
            })
        }
        fn upsert_ai_message(
            &self,
            _: OperationId,
            _: junban_domain::AiMessageId,
            _: AiSessionId,
            _: junban_domain::AiTurnId,
            _: junban_domain::AiMessageRole,
            _: junban_domain::AiMessageStatus,
            _: junban_domain::AiMessageContent,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("upsert_ai_message")
        }
        fn get_ai_message(
            &self,
            _: junban_domain::AiMessageId,
        ) -> crate::RepositoryFuture<'_, AiMessage> {
            self.calls.lock().unwrap().push("get_ai_message");
            Box::pin(async { Err(RepositoryError::NotFound) })
        }

        fn list_ai_messages(
            &self,
            _: AiSessionId,
            _: Option<u32>,
            _: u32,
        ) -> crate::RepositoryFuture<'_, Vec<AiMessage>> {
            self.calls.lock().unwrap().push("list_ai_messages");
            Box::pin(async { Ok(Vec::new()) })
        }
        fn create_ai_memory(
            &self,
            _: OperationId,
            _: AiMemoryId,
            _: String,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("create_ai_memory")
        }
        fn update_ai_memory(
            &self,
            _: OperationId,
            _: AiMemoryId,
            _: String,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("update_ai_memory")
        }
        fn delete_ai_memory(
            &self,
            _: OperationId,
            _: AiMemoryId,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("delete_ai_memory")
        }
        fn link_ai_session_memory(
            &self,
            _: OperationId,
            _: AiSessionId,
            _: AiMemoryId,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("link_ai_session_memory")
        }
        fn get_ai_memory(&self, _: AiMemoryId) -> crate::RepositoryFuture<'_, AiMemory> {
            self.calls.lock().unwrap().push("get_ai_memory");
            Box::pin(async { Err(RepositoryError::NotFound) })
        }
        fn list_ai_memories(
            &self,
            _: Option<crate::AiMemoryCursor>,
            _: u32,
        ) -> crate::RepositoryFuture<'_, AiMemoryListPage> {
            self.calls.lock().unwrap().push("list_ai_memories");
            Box::pin(async {
                Ok(AiMemoryListPage {
                    memories: Vec::new(),
                    next_cursor: None,
                })
            })
        }
        fn select_ai_memories_for_context(
            &self,
            _: Option<AiSessionId>,
            _: u32,
        ) -> crate::RepositoryFuture<'_, Vec<AiMemory>> {
            self.calls
                .lock()
                .unwrap()
                .push("select_ai_memories_for_context");
            Box::pin(async { Ok(Vec::new()) })
        }
        fn propose_ai_approval(
            &self,
            _: OperationId,
            _: AiApprovalId,
            _: AiSessionId,
            _: junban_domain::AiTurnId,
            _: AiRunId,
            _: u64,
            _: String,
            _: String,
            _: junban_domain::AiMessageContent,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("propose_ai_approval")
        }
        fn set_ai_approval_status(
            &self,
            _: OperationId,
            _: AiApprovalId,
            _: junban_domain::AiApprovalStatus,
            _: Option<String>,
            _: Option<junban_domain::AiMessageContent>,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("set_ai_approval_status")
        }
        fn get_ai_approval(&self, _: AiApprovalId) -> crate::RepositoryFuture<'_, AiToolApproval> {
            self.calls.lock().unwrap().push("get_ai_approval");
            Box::pin(async { Err(RepositoryError::NotFound) })
        }
        fn list_dispatching_ai_approvals(
            &self,
        ) -> crate::RepositoryFuture<'_, Vec<AiToolApproval>> {
            self.calls
                .lock()
                .unwrap()
                .push("list_dispatching_ai_approvals");
            Box::pin(async { Ok(Vec::new()) })
        }
        fn recover_operation_receipt(
            &self,
            _: OperationId,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.calls.lock().unwrap().push("recover_operation_receipt");
            Box::pin(async { Err(RepositoryError::NotFound) })
        }
        fn upsert_ai_run_state(
            &self,
            _: OperationId,
            _: AiRunState,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("upsert_ai_run_state")
        }
        fn get_ai_run_state(&self, _: AiRunId) -> crate::RepositoryFuture<'_, AiRunState> {
            self.calls.lock().unwrap().push("get_ai_run_state");
            Box::pin(async { Err(RepositoryError::NotFound) })
        }
        fn get_ai_run_for_assistant(
            &self,
            _: AiMessageId,
        ) -> crate::RepositoryFuture<'_, AiRunState> {
            Box::pin(async { Err(RepositoryError::NotFound) })
        }
        fn ensure_ai_response_current(&self, _: AiRunId) -> crate::RepositoryFuture<'_, ()> {
            self.calls
                .lock()
                .unwrap()
                .push("ensure_ai_response_current");
            Box::pin(async { Ok(()) })
        }
        fn reserve_daily_ai_response(
            &self,
            _: OperationId,
            _: ReserveDailyAiResponseRequest,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, PreparedAiResponse> {
            Box::pin(async { Err(RepositoryError::NotFound) })
        }
        fn rewrite_ai_response(
            &self,
            _: OperationId,
            _: RewriteAiResponseRequest,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, PreparedAiResponse> {
            Box::pin(async { Err(RepositoryError::NotFound) })
        }
        fn cancel_ai_response(
            &self,
            _: OperationId,
            _: junban_domain::AiMessageId,
            _: AiSessionId,
            _: junban_domain::AiTurnId,
            _: AiRunId,
            _: u64,
            _: junban_domain::AiMessageContent,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("cancel_ai_response")
        }
        fn finish_ai_response(
            &self,
            _: OperationId,
            _: junban_domain::AiMessageId,
            _: AiSessionId,
            _: junban_domain::AiTurnId,
            _: AiRunId,
            _: u64,
            _: junban_domain::AiMessageStatus,
            _: junban_domain::AiMessageContent,
            _: junban_domain::AiRunPhase,
            _: Option<String>,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("finish_ai_response")
        }
        fn list_ai_secret_metadata(
            &self,
        ) -> crate::RepositoryFuture<'_, Vec<junban_domain::AiSecretMetadata>> {
            self.calls.lock().unwrap().push("list_ai_secret_metadata");
            Box::pin(async { Ok(Vec::new()) })
        }

        fn resolve_ai_secret(
            &self,
            _: junban_domain::AiCredentialId,
        ) -> crate::RepositoryFuture<'_, crate::AiSecretBytes> {
            self.calls.lock().unwrap().push("resolve_ai_secret");
            Box::pin(async { Err(RepositoryError::NotFound) })
        }

        fn bind_ai_credential(
            &self,
            _: OperationId,
            _: crate::AiCredentialBindingTarget,
            _: junban_domain::AiSecretKind,
            _: Option<crate::AiSecretBytes>,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, AiCredentialBindResult> {
            self.calls.lock().unwrap().push("bind_ai_credential");
            let mutation = self.result.lock().unwrap().clone();
            Box::pin(async move {
                mutation.map(|mutation| AiCredentialBindResult {
                    mutation,
                    credential_id: None,
                })
            })
        }
        fn clear_ai_credential_binding(
            &self,
            _: OperationId,
            _: crate::AiCredentialBindingTarget,
            _: Timestamp,
        ) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.response("clear_ai_credential_binding")
        }
    }

    #[derive(Default)]
    struct RecordingSink(Mutex<Vec<CommittedEvent>>);

    impl EventSink for RecordingSink {
        fn publish(&self, event: CommittedEvent) {
            self.0.lock().unwrap().push(event);
        }
    }

    fn operation_id() -> OperationId {
        OperationId::parse(&Uuid::new_v4().to_string()).unwrap()
    }

    fn mutation() -> CommittedMutation {
        mutation_with_flag(true)
    }

    fn mutation_with_flag(newly_committed: bool) -> CommittedMutation {
        let now: Timestamp = "2026-07-28T12:00:00Z".parse().unwrap();
        let task = Task::new(TaskId::new(), TaskTitle::new("Task").unwrap(), None, now, 1);
        CommittedMutation {
            event: CommittedEvent {
                revision: 1,
                operation_id: operation_id(),
                event_type: EventType::new(EventType::TASK_CREATED),
                occurred_at: now,
                primary: Some(ResourceRef::task(task.id)),
                snapshot: Some(ResourceSnapshot::task(task)),
                affected: AffectedIds::default(),
                resync: ResyncScope::NONE,
            },
            uncomplete_outcome: None,
            newly_committed,
        }
    }

    #[tokio::test]
    async fn create_validates_then_publishes_the_committed_event() {
        let expected = mutation();
        let repository = Arc::new(FakeRepository::new(Ok(expected.clone())));
        let sink = Arc::new(RecordingSink::default());
        let service = JunbanService::new(Arc::clone(&repository), Arc::clone(&sink));

        let actual = service
            .create_task_simple(operation_id(), "Task".to_owned(), None)
            .await
            .unwrap();

        assert_eq!(actual, expected);
        assert_eq!(*repository.calls.lock().unwrap(), vec!["create"]);
        assert_eq!(*sink.0.lock().unwrap(), vec![expected.event]);
    }

    #[tokio::test]
    async fn invalid_title_never_reaches_storage_or_event_sink() {
        let repository = Arc::new(FakeRepository::new(Ok(mutation())));
        let sink = Arc::new(RecordingSink::default());
        let service = JunbanService::new(Arc::clone(&repository), Arc::clone(&sink));

        assert_eq!(
            service
                .create_task_simple(operation_id(), "  ".to_owned(), None)
                .await,
            Err(AppError::Validation(ValidationError::EmptyTitle))
        );
        assert!(repository.calls.lock().unwrap().is_empty());
        assert!(sink.0.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn mutations_use_repository_and_publish() {
        let repository = Arc::new(FakeRepository::new(Ok(mutation())));
        let sink = Arc::new(RecordingSink::default());
        let service = JunbanService::new(Arc::clone(&repository), Arc::clone(&sink));
        let id = TaskId::new();

        service
            .replace_task(operation_id(), id, "Changed".to_owned(), None)
            .await
            .unwrap();
        service.complete_task(operation_id(), id).await.unwrap();
        service.uncomplete_task(operation_id(), id).await.unwrap();
        service.delete_task(operation_id(), id).await.unwrap();

        assert_eq!(
            *repository.calls.lock().unwrap(),
            vec!["patch", "complete", "uncomplete", "delete"]
        );
        assert_eq!(sink.0.lock().unwrap().len(), 4);
    }

    #[tokio::test]
    async fn plugin_mutations_publish_only_fresh_commits() {
        let expected = mutation();
        let repository = Arc::new(FakeRepository::new(Ok(expected.clone())));
        let sink = Arc::new(RecordingSink::default());
        let service = JunbanService::new(Arc::clone(&repository), Arc::clone(&sink));

        assert_eq!(
            service
                .retry_plugin(
                    OperationId::new(),
                    junban_plugin_sdk::PluginId::parse("test-plugin").unwrap(),
                    Timestamp::constant(1_700_000_000, 0),
                )
                .await
                .unwrap(),
            expected
        );
        assert_eq!(
            repository.calls.lock().unwrap().as_slice(),
            &["plugin-retry"]
        );
        assert_eq!(sink.0.lock().unwrap().len(), 1);

        *repository.result.lock().unwrap() = Ok(mutation_with_flag(false));
        service
            .retry_plugin(
                OperationId::new(),
                junban_plugin_sdk::PluginId::parse("test-plugin").unwrap(),
                Timestamp::constant(1_700_000_001, 0),
            )
            .await
            .unwrap();
        assert_eq!(sink.0.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn plugin_invocation_commits_publish_only_fresh_events() {
        let expected = mutation();
        let repository = Arc::new(FakeRepository::new(Ok(expected.clone())));
        let sink = Arc::new(RecordingSink::default());
        let service = JunbanService::new(Arc::clone(&repository), Arc::clone(&sink));
        let plugin_id = junban_plugin_sdk::PluginId::parse("test-plugin").unwrap();
        let request = crate::CommitPluginInvocationRequest {
            invocation_operation_id: OperationId::new(),
            plugin_id,
            package_generation: 1,
            activation_epoch: 0,
            child_operation_id: None,
            domain_effect: None,
            kv_patch: None,
            cursor: None,
            resync_session: None,
            resync_kv: None,
        };

        let committed = service
            .commit_plugin_invocation(request.clone(), Timestamp::constant(1_700_000_000, 0))
            .await
            .unwrap();
        assert_eq!(committed.mutation, Some(expected.clone()));
        assert_eq!(sink.0.lock().unwrap().as_slice(), &[expected.event]);

        *repository.result.lock().unwrap() = Ok(mutation_with_flag(false));
        service
            .commit_plugin_invocation(request, Timestamp::constant(1_700_000_001, 0))
            .await
            .unwrap();
        assert_eq!(sink.0.lock().unwrap().len(), 1);
        assert_eq!(
            repository.calls.lock().unwrap().as_slice(),
            &["plugin-commit", "plugin-commit"]
        );
    }

    #[tokio::test]
    async fn reads_use_repository_without_publishing() {
        let repository = Arc::new(FakeRepository::new(Ok(mutation())));
        let sink = Arc::new(RecordingSink::default());
        let service = JunbanService::new(Arc::clone(&repository), Arc::clone(&sink));

        assert_eq!(service.list_tasks_simple().await.unwrap().revision, 0);
        assert_eq!(
            service.list_events(12).await.unwrap(),
            EventCatchUp::Page {
                events: Vec::new(),
                has_more: false,
                latest_revision: 0,
            }
        );
        assert_eq!(*repository.calls.lock().unwrap(), vec!["list", "events"]);
        assert!(sink.0.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn receipt_replays_do_not_republish_events() {
        let expected = mutation_with_flag(false);
        let repository = Arc::new(FakeRepository::new(Ok(expected.clone())));
        let sink = Arc::new(RecordingSink::default());
        let service = JunbanService::new(repository, Arc::clone(&sink));

        let actual = service
            .create_task_simple(operation_id(), "Task".to_owned(), None)
            .await
            .unwrap();

        assert_eq!(actual, expected);
        assert!(!actual.newly_committed);
        assert!(sink.0.lock().unwrap().is_empty());
    }

    #[test]
    fn committed_mutation_serialization_omits_replay_flag() {
        let mutation = mutation_with_flag(true);
        let json = serde_json::to_string(&mutation).unwrap();
        assert!(!json.contains("newly_committed"));
        let replay: CommittedMutation = serde_json::from_str(&json).unwrap();
        assert!(!replay.newly_committed);
        assert_eq!(replay.event, mutation.event);
    }

    #[tokio::test]
    async fn repository_failures_map_without_publishing() {
        for (repository_error, app_error) in [
            (RepositoryError::NotFound, AppError::NotFound),
            (RepositoryError::Conflict, AppError::Conflict),
            (
                RepositoryError::IdempotencyMismatch,
                AppError::IdempotencyMismatch,
            ),
            (
                RepositoryError::OperationTooLarge,
                AppError::OperationTooLarge,
            ),
            (
                RepositoryError::Storage("disk full".to_owned()),
                AppError::Storage,
            ),
        ] {
            let repository = Arc::new(FakeRepository::new(Err(repository_error)));
            let sink = Arc::new(RecordingSink::default());
            let service = JunbanService::new(repository, Arc::clone(&sink));
            assert_eq!(
                service.complete_task(operation_id(), TaskId::new()).await,
                Err(app_error)
            );
            assert!(sink.0.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn task_fixture_starts_pending() {
        assert_eq!(mutation().task().unwrap().status, TaskStatus::Pending);
    }

    fn sample_task(title: &str, revision: u64) -> Task {
        let now: Timestamp = "2026-07-28T12:00:00Z".parse().unwrap();
        Task::new(
            TaskId::new(),
            TaskTitle::new(title).unwrap(),
            None,
            now,
            revision,
        )
    }

    fn list_page(
        tasks: Vec<Task>,
        revision: u64,
        next_cursor: Option<junban_domain::TaskCursor>,
    ) -> TaskListPage {
        TaskListPage {
            tasks,
            revision,
            as_of_date: "2026-07-28".parse().unwrap(),
            next_cursor,
        }
    }

    fn as_of() -> TaskListAsOf {
        TaskListAsOf::for_local_date("2026-07-28".parse().unwrap(), &TimeZone::UTC).unwrap()
    }

    #[tokio::test]
    async fn analysis_snapshot_preserves_stats_with_one_repository_call() {
        let today = "2026-07-28".parse().unwrap();
        let mut overdue = sample_task("overdue", 9);
        overdue.due_date = Some("2026-07-26".parse().unwrap());
        let mut completed = sample_task("completed", 8);
        completed.status = TaskStatus::Completed;
        completed.completed_at = Some("2026-07-27T12:00:00Z".parse().unwrap());

        let tasks = vec![completed, overdue];
        let repository = Arc::new(FakeRepository::with_list_pages(vec![list_page(
            tasks.clone(),
            9,
            None,
        )]));
        let service = JunbanService::new(repository.clone(), Arc::new(RecordingSink::default()));

        let page = service
            .stats("2026-07-26".parse().unwrap(), today, today, &TimeZone::UTC)
            .await
            .unwrap();

        assert_eq!(
            page.summary,
            stats_summary(
                &tasks,
                "2026-07-26".parse().unwrap(),
                today,
                today,
                &TimeZone::UTC
            )
            .unwrap()
        );
        assert_eq!(page.revision, 9);
        assert_eq!(*repository.calls.lock().unwrap(), vec!["analysis"]);
    }

    #[tokio::test]
    async fn analysis_snapshot_preserves_nudge_order_and_tags_with_one_repository_call() {
        let tag_a = TagId::new();
        let tag_b = TagId::new();
        let mut earlier = sample_task("earlier", 9);
        earlier.due_date = Some("2026-07-26".parse().unwrap());
        earlier.tag_ids = vec![tag_a];
        let mut later = sample_task("later", 9);
        later.due_date = Some("2026-07-27".parse().unwrap());
        later.tag_ids = vec![tag_b];
        let tasks = vec![later.clone(), earlier.clone()];
        let expected_facts = evaluate_nudges(
            &tasks,
            "2026-07-28".parse().unwrap(),
            DailyCapacityMinutes::DEFAULT,
            &TimeZone::UTC,
            &[],
            None,
        );
        let repository = Arc::new(FakeRepository::with_list_pages(vec![list_page(
            tasks, 9, None,
        )]));
        let service = JunbanService::new(repository.clone(), Arc::new(RecordingSink::default()));

        let page = service
            .nudges("2026-07-28".parse().unwrap(), None, &TimeZone::UTC)
            .await
            .unwrap();

        assert_eq!(page.revision, 9);
        assert_eq!(page.facts, expected_facts);
        assert_eq!(
            page.tasks.iter().map(|task| task.id).collect::<Vec<_>>(),
            vec![earlier.id, later.id]
        );
        assert_eq!(page.tasks[0].tag_ids, vec![tag_a]);
        assert_eq!(page.tasks[1].tag_ids, vec![tag_b]);
        assert_eq!(
            *repository.calls.lock().unwrap(),
            vec!["get_settings", "analysis"]
        );
    }

    #[tokio::test]
    async fn collect_pages_stops_on_short_final_page() {
        let t1 = sample_task("a", 1);
        let t2 = sample_task("b", 1);
        let t3 = sample_task("c", 1);
        let cursor = junban_domain::TaskCursor {
            sort_value: "1".into(),
            task_id: t1.id,
        };
        let repository = Arc::new(FakeRepository::with_list_pages(vec![
            list_page(vec![t1.clone(), t2.clone()], 3, Some(cursor)),
            list_page(vec![t3.clone()], 3, None),
        ]));
        let service = JunbanService::new(repository, Arc::new(RecordingSink::default()));

        let collected = service
            .collect_task_query_pages(TaskQuery::new(), as_of(), 100)
            .await
            .unwrap();

        assert_eq!(collected.revision, 3);
        assert_eq!(collected.tasks.len(), 3);
        assert_eq!(
            collected
                .tasks
                .iter()
                .map(|t| t.title.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "b", "c"]
        );
    }

    #[tokio::test]
    async fn collect_pages_rejects_when_cap_exceeded() {
        let tasks: Vec<Task> = (0..5).map(|i| sample_task(&format!("t{i}"), 1)).collect();
        let cursor = junban_domain::TaskCursor {
            sort_value: "0".into(),
            task_id: tasks[0].id,
        };
        // Cap 3: first page of 2 + second page of 2 => 4 > 3.
        let repository = Arc::new(FakeRepository::with_list_pages(vec![
            list_page(tasks[0..2].to_vec(), 1, Some(cursor)),
            list_page(tasks[2..4].to_vec(), 1, None),
        ]));
        let service = JunbanService::new(repository, Arc::new(RecordingSink::default()));

        assert_eq!(
            service
                .collect_task_query_pages(TaskQuery::new(), as_of(), 3)
                .await,
            Err(AppError::ResultLimitExceeded)
        );
    }

    #[tokio::test]
    async fn collect_pages_retries_once_on_revision_drift() {
        let t1 = sample_task("first", 1);
        let t2 = sample_task("stable", 5);
        let cursor = junban_domain::TaskCursor {
            sort_value: "1".into(),
            task_id: t1.id,
        };
        // Attempt 1: page1 rev=1, page2 rev=2 => Conflict, retry.
        // Attempt 2: single consistent page rev=5.
        let repository = Arc::new(FakeRepository::with_list_pages(vec![
            list_page(vec![t1], 1, Some(cursor)),
            list_page(vec![sample_task("drift", 2)], 2, None),
            list_page(vec![t2.clone()], 5, None),
        ]));
        let service = JunbanService::new(repository, Arc::new(RecordingSink::default()));

        let collected = service
            .collect_task_query_pages(TaskQuery::new(), as_of(), 100)
            .await
            .unwrap();
        assert_eq!(collected.revision, 5);
        assert_eq!(collected.tasks.len(), 1);
        assert_eq!(collected.tasks[0].title.as_str(), "stable");
    }

    #[tokio::test]
    async fn collect_pages_fails_when_revision_keeps_drifting() {
        let cursor = junban_domain::TaskCursor {
            sort_value: "1".into(),
            task_id: TaskId::new(),
        };
        let repository = Arc::new(FakeRepository::with_list_pages(vec![
            // first attempt
            list_page(vec![sample_task("a", 1)], 1, Some(cursor.clone())),
            list_page(vec![sample_task("b", 2)], 2, None),
            // retry also drifts
            list_page(vec![sample_task("c", 3)], 3, Some(cursor)),
            list_page(vec![sample_task("d", 4)], 4, None),
        ]));
        let service = JunbanService::new(repository, Arc::new(RecordingSink::default()));

        assert_eq!(
            service
                .collect_task_query_pages(TaskQuery::new(), as_of(), 100)
                .await,
            Err(AppError::Conflict)
        );
    }

    fn sample_block(title: &str, date: Date, start_h: i8, rule: Option<&str>) -> TimeBlock {
        let now: Timestamp = "2026-07-28T12:00:00Z".parse().unwrap();
        let mut draft = TimeBlockDraft::new(
            EntityName::new(title).unwrap(),
            CivilTimeRange::new(
                date,
                jiff::civil::Time::constant(start_h, 0, 0, 0),
                jiff::civil::Time::constant(start_h + 1, 0, 0, 0),
                junban_domain::TimeZoneName::new("UTC").unwrap(),
            )
            .unwrap(),
        );
        draft.recurrence_rule = rule.map(|raw| junban_domain::RecurrenceRule::new(raw).unwrap());
        TimeBlock::from_draft(TimeBlockId::new(), draft, now, 1)
    }

    fn sample_slot(title: &str, date: Date, start_h: i8, rule: Option<&str>) -> TimeSlot {
        let now: Timestamp = "2026-07-28T12:00:00Z".parse().unwrap();
        let mut draft = TimeSlotDraft::new(
            EntityName::new(title).unwrap(),
            CivilTimeRange::new(
                date,
                jiff::civil::Time::constant(start_h, 0, 0, 0),
                jiff::civil::Time::constant(start_h + 2, 0, 0, 0),
                junban_domain::TimeZoneName::new("UTC").unwrap(),
            )
            .unwrap(),
        );
        draft.recurrence_rule = rule.map(|raw| junban_domain::RecurrenceRule::new(raw).unwrap());
        TimeSlot::from_draft(TimeSlotId::new(), draft, now, 1)
    }

    #[tokio::test]
    async fn list_timeblocking_expands_recurring_owners_and_sorts() {
        let ordinary = sample_block("Ordinary", date(2026, 3, 9), 11, None);
        let ordinary_id = ordinary.id;
        // Owner is before the window; only virtual instances should appear.
        let early_daily = sample_block("Daily", date(2026, 3, 1), 9, Some("daily"));
        let owner_id = early_daily.id;
        let weekly = sample_block("Weekly", date(2026, 3, 8), 8, Some("weekly"));
        let weekly_id = weekly.id;
        let slot = sample_slot("Slot series", date(2026, 3, 8), 14, Some("daily"));
        let slot_id = slot.id;

        let repository = Arc::new(FakeRepository::with_timeblocking_page(
            TimeblockingRangePage {
                blocks: vec![early_daily, weekly, ordinary],
                slots: vec![slot],
                revision: 7,
            },
        ));
        let service = JunbanService::new(repository, Arc::new(RecordingSink::default()));

        let page = service
            .list_timeblocking_range(date(2026, 3, 8), date(2026, 3, 10))
            .await
            .unwrap();

        assert_eq!(page.revision, 7);
        assert_eq!(
            page.blocks
                .iter()
                .map(|block| {
                    (
                        block.id,
                        block.range.date,
                        block.recurrence_parent_id,
                        block.title.as_str().to_owned(),
                    )
                })
                .collect::<Vec<_>>(),
            vec![
                (weekly_id, date(2026, 3, 8), None, "Weekly".into()),
                (owner_id, date(2026, 3, 8), Some(owner_id), "Daily".into()),
                (owner_id, date(2026, 3, 9), Some(owner_id), "Daily".into()),
                (ordinary_id, date(2026, 3, 9), None, "Ordinary".into()),
                (owner_id, date(2026, 3, 10), Some(owner_id), "Daily".into()),
            ]
        );
        // Weekly owner date is inside the window and returned once without parent id.
        assert!(page.blocks.iter().any(|block| {
            block.id == weekly_id
                && block.range.date == date(2026, 3, 8)
                && block.recurrence_parent_id.is_none()
                && block.recurrence_rule.is_some()
        }));
        assert_eq!(page.slots.len(), 3);
        assert!(page.slots.iter().all(|slot| slot.id == slot_id));
        assert_eq!(page.slots[0].range.date, date(2026, 3, 8));
        assert!(page.slots[0].recurrence_parent_id.is_none());
        assert_eq!(page.slots[1].recurrence_parent_id, Some(slot_id));
        assert_eq!(page.slots[2].recurrence_parent_id, Some(slot_id));

        // Sorted by date, then start, then id.
        let block_keys: Vec<_> = page
            .blocks
            .iter()
            .map(|block| (block.range.date, block.range.start, block.id.as_uuid()))
            .collect();
        let mut sorted = block_keys.clone();
        sorted.sort();
        assert_eq!(block_keys, sorted);
    }

    #[tokio::test]
    async fn list_timeblocking_rejects_expanded_result_over_limit() {
        let mut blocks = Vec::new();
        for index in 0..(MAX_TIMEBLOCK_RANGE_ITEMS + 1) {
            blocks.push(sample_block(
                &format!("b{index}"),
                date(2026, 3, 8),
                9,
                None,
            ));
        }
        let repository = Arc::new(FakeRepository::with_timeblocking_page(
            TimeblockingRangePage {
                blocks,
                slots: Vec::new(),
                revision: 1,
            },
        ));
        let service = JunbanService::new(repository, Arc::new(RecordingSink::default()));
        assert_eq!(
            service
                .list_timeblocking_range(date(2026, 3, 8), date(2026, 3, 8))
                .await,
            Err(AppError::ResultLimitExceeded)
        );
    }

    #[tokio::test]
    async fn ai_session_create_publishes_once_and_replay_does_not() {
        let repository = Arc::new(FakeRepository::new(Ok(mutation_with_flag(true))));
        let sink = Arc::new(RecordingSink::default());
        let service = JunbanService::new(repository.clone(), Arc::clone(&sink));
        let first = service
            .create_ai_session(
                operation_id(),
                CreateAiSessionRequest {
                    title: "Planning".into(),
                },
            )
            .await
            .unwrap();
        assert!(first.newly_committed);
        assert_eq!(sink.0.lock().unwrap().len(), 1);

        *repository.result.lock().unwrap() = Ok(mutation_with_flag(false));
        let replay = service
            .create_ai_session(
                operation_id(),
                CreateAiSessionRequest {
                    title: "Planning".into(),
                },
            )
            .await
            .unwrap();
        assert!(!replay.newly_committed);
        assert_eq!(sink.0.lock().unwrap().len(), 1);
        assert_eq!(
            repository.calls.lock().unwrap().as_slice(),
            ["create_ai_session", "create_ai_session"]
        );
    }

    #[tokio::test]
    async fn ai_credential_bind_publishes_settings_event_once_on_fresh_commit() {
        let repository = Arc::new(FakeRepository::new(Ok(mutation_with_flag(true))));
        let sink = Arc::new(RecordingSink::default());
        let service = JunbanService::new(repository.clone(), Arc::clone(&sink));
        let result = service
            .bind_ai_credential(
                operation_id(),
                BindAiCredentialRequest {
                    target: crate::AiCredentialBindingTarget::AiProvider,
                    kind: junban_domain::AiSecretKind::ApiKey,
                    secret: Some(crate::AiSecretBytes::new("unit-test-secret-marker").unwrap()),
                },
            )
            .await
            .unwrap();
        assert!(result.mutation.newly_committed);
        assert_eq!(sink.0.lock().unwrap().len(), 1);

        *repository.result.lock().unwrap() = Ok(mutation_with_flag(false));
        let replay = service
            .bind_ai_credential(
                operation_id(),
                BindAiCredentialRequest {
                    target: crate::AiCredentialBindingTarget::AiProvider,
                    kind: junban_domain::AiSecretKind::ApiKey,
                    secret: Some(crate::AiSecretBytes::new("unit-test-secret-marker").unwrap()),
                },
            )
            .await
            .unwrap();
        assert!(!replay.mutation.newly_committed);
        assert_eq!(sink.0.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn weekly_review_bounded_uses_projects_by_ids_not_list_catalog() {
        let now: Timestamp = "2026-08-02T12:00:00Z".parse().unwrap();
        let project_a = ProjectId::new();
        let project_b = ProjectId::new();
        let mut task_a = sample_task("A", 3);
        task_a.project_id = Some(project_a);
        let mut task_b = sample_task("B", 3);
        task_b.project_id = Some(project_b);
        let mut task_none = sample_task("C", 3);
        task_none.project_id = None;

        let repository = Arc::new(FakeRepository::with_list_pages(vec![list_page(
            vec![task_a, task_b, task_none],
            3,
            None,
        )]));
        *repository.projects_by_ids.lock().unwrap() = crate::ProjectListPage {
            projects: vec![
                junban_domain::Project::new(
                    project_a,
                    EntityName::new("Alpha").unwrap(),
                    HexColor::new("#112233").unwrap(),
                    now,
                ),
                junban_domain::Project::new(
                    project_b,
                    EntityName::new("Beta").unwrap(),
                    HexColor::new("#223344").unwrap(),
                    now,
                ),
            ],
            revision: 3,
            truncated: false,
        };

        let sink = Arc::new(RecordingSink::default());
        let service = JunbanService::new(Arc::clone(&repository), sink);
        let zone = TimeZone::UTC;
        let (page, truncated) = service
            .weekly_review_bounded(date(2026, 8, 2), None, &zone)
            .await
            .unwrap();

        assert!(!truncated);
        assert_eq!(page.revision, 3);
        let calls = repository.calls.lock().unwrap().clone();
        assert!(
            calls.contains(&"get_projects_by_ids"),
            "expected get_projects_by_ids in {calls:?}"
        );
        assert!(
            !calls.contains(&"list_catalog"),
            "weekly_review_bounded must not call list_catalog: {calls:?}"
        );
    }

    #[test]
    fn referenced_project_ids_are_unique_sorted_and_bounded() {
        let mut tasks = Vec::new();
        for index in 0..(MAX_BULK_IDS + 25) {
            let mut task = sample_task(&format!("t{index}"), 1);
            // Deterministic UUID payload via repeated construction is fine; uniqueness comes
            // from ProjectId::new(). Force duplicates for the first ids to exercise dedupe.
            task.project_id = Some(if index < 10 {
                // ten tasks share one project id via fixed parse
                ProjectId::parse("00112233-4455-6677-8899-aabbccddeeff").unwrap()
            } else {
                ProjectId::new()
            });
            tasks.push(task);
        }
        let (ids, truncated) = referenced_project_ids(&tasks);
        assert!(truncated);
        assert_eq!(ids.len(), MAX_BULK_IDS);
        let mut sorted = ids.clone();
        sorted.sort_by_key(|id| id.as_uuid());
        assert_eq!(ids, sorted);
        let unique = ids.iter().collect::<std::collections::BTreeSet<_>>();
        assert_eq!(unique.len(), ids.len());
    }

    fn date(year: i16, month: i8, day: i8) -> Date {
        jiff::civil::date(year, month, day)
    }
}
