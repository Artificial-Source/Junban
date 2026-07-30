//! Validation-before-write use cases with post-commit event publication.

use std::sync::Arc;

use jiff::{Timestamp, Zoned, civil::Date};
use junban_domain::{
    ClaimedReminder, Comment, CommentBody, CommentId, DEFAULT_REMINDER_CLAIM_LIMIT,
    DEFAULT_REMINDER_CLAIM_SECS, DEFAULT_REMINDER_LEASE_SECS, EntityName, FilterQuery, HexColor,
    MarkdownText, OperationId, ProjectId, RelationKind, ReminderChannel, ReminderDeliveryLease,
    ReminderFailureCode, ReminderFenceTerm, ReminderOccurrence, SavedFilterId, SectionId, TagId,
    TagName, Task, TaskActivity, TaskDraft, TaskId, TaskQuery, TaskRelation, TaskTitle, TemplateId,
    ValidationError, validate_owner_lost_mark_limit, validate_reminder_claim_limit,
    validate_reminder_lease_secs,
};

use crate::{
    AppError, BulkAction, CatalogSnapshot, CommentPatch, CommittedEvent, CommittedMutation,
    EventCatchUp, MoveTarget, ProjectDraft, ProjectPatch, ReorderScope, Repository,
    RepositoryError, SavedFilterDraft, SavedFilterPatch, SectionDraft, SectionPatch, TagDraft,
    TagPatch, TaskListAsOf, TaskListPage, TaskPatch, TemplateApply, TemplateDraft, TemplatePatch,
    TemporalContext,
};

pub trait EventSink: Send + Sync + 'static {
    fn publish(&self, event: CommittedEvent);
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
    use junban_domain::TaskStatus;
    use uuid::Uuid;

    struct FakeRepository {
        result: Mutex<Result<CommittedMutation, RepositoryError>>,
        calls: Mutex<Vec<&'static str>>,
    }

    impl FakeRepository {
        fn new(result: Result<CommittedMutation, RepositoryError>) -> Self {
            Self {
                result: Mutex::new(result),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn response(&self, call: &'static str) -> crate::RepositoryFuture<'_, CommittedMutation> {
            self.calls.lock().unwrap().push(call);
            let result = self.result.lock().unwrap().clone();
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
            Box::pin(async {
                Ok(TaskListPage {
                    tasks: Vec::new(),
                    revision: 0,
                    as_of_date: "2026-07-28".parse().unwrap(),
                    next_cursor: None,
                })
            })
        }
        fn list_catalog(&self) -> crate::RepositoryFuture<'_, CatalogSnapshot> {
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
}
