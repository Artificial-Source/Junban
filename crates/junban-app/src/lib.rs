//! Application use cases and persistence/event ports for Junban.
//!
//! Transport and SQLite details stay outside this crate. Storage implements
//! [`Repository`]; callers publish committed events only after a successful return.

mod error;
mod event;
mod ports;
mod requests;
mod service;

pub use error::{AppError, RepositoryError};
pub use event::{
    AffectedIds, CommittedEvent, CommittedMutation, EVENT_CATCHUP_MAX_BYTES,
    EVENT_CATCHUP_MAX_COUNT, EVENT_RETAIN_MAX_BYTES, EVENT_RETAIN_MAX_COUNT, EventCatchUp,
    EventType, ResourceRef, ResourceSnapshot, ResourceType, ResyncScope,
};
pub use ports::{Repository, RepositoryFuture};
pub use requests::{
    ACTIVITY_PAGE_DEFAULT, ACTIVITY_PAGE_MAX, BulkAction, BulkSchedule, BulkTagChange,
    CalendarTasksPage, CatalogSnapshot, ClaimRemindersRequest, CollectedTasks, CommentPatch,
    DailyPlanPage, DismissReminder, DopamineMenuPage, EatTheFrogPage, EndOfDayPage,
    MarkOwnerLostReminders, MoveTarget, NudgesPage, OrderAnchor, ProjectDraft, ProjectPatch,
    ReminderLeaseRequest, ReorderScope, ReplanPastBlocksAction, RescheduleReminder,
    SavedFilterDraft, SavedFilterPatch, SectionDraft, SectionPatch, SettleReminderDelivered,
    SettleReminderFailed, StatsPage, TagDraft, TagPatch, TaskJarPage, TaskListAsOf, TaskListPage,
    TaskPatch, TemplateApply, TemplateDraft, TemplatePatch, TemporalContext, TemporalSettings,
    TimeBlockPatch, TimeSlotPatch, TimeblockingRangePage, TimeblockingRangeQuery, WeeklyReviewPage,
};
pub use service::{EventSink, JunbanService, default_temporal_settings};

/// Backward-compatible alias used by the Phase 1 server surface during Phase 2 cutover.
pub type TaskService<R, E> = JunbanService<R, E>;
