//! Application use cases and persistence/event ports for Junban.
//!
//! Transport and SQLite details stay outside this crate. Storage implements
//! [`Repository`]; callers publish committed events only after a successful return.

mod ai;
mod artifact;
mod error;
mod event;
mod plugin;
mod ports;
mod requests;
mod service;

pub use ai::{
    AiCredentialBindResult, AiCredentialBindingTarget, AiMemoryCursor, AiMemoryListPage,
    AiMessageListPage, AiSecretBytes, AiSessionCursor, AiSessionListPage, BindAiCredentialRequest,
    CancelAiResponseRequest, ClearAiCredentialRequest, ClearAiSessionRequest,
    CreateAiMemoryRequest, CreateAiSessionRequest, DeleteAiMemoryRequest, DeleteAiSessionRequest,
    FinishAiResponseRequest, LinkAiSessionMemoryRequest, ListAiMemoriesRequest,
    ListAiMessagesRequest, ListAiSessionsRequest, PreparedAiResponse, ProposeAiApprovalRequest,
    RenameAiSessionRequest, ReserveDailyAiResponseRequest, RewriteAiResponseRequest,
    SelectAiMemoriesRequest, SetAiApprovalStatusRequest, UpdateAiMemoryRequest,
    UpsertAiMessageRequest, UpsertAiRunStateRequest,
};
pub use artifact::StagedFile;
pub use error::{AppError, RepositoryError};
pub use event::{
    AffectedIds, CommittedEvent, CommittedMutation, EVENT_CATCHUP_MAX_BYTES,
    EVENT_CATCHUP_MAX_COUNT, EVENT_RETAIN_MAX_BYTES, EVENT_RETAIN_MAX_COUNT, EventCatchUp,
    EventType, ResourceRef, ResourceSnapshot, ResourceType, ResyncScope,
};
pub use plugin::*;
pub use ports::{Repository, RepositoryFuture, SyncState};
pub use requests::{
    ACTIVITY_PAGE_DEFAULT, ACTIVITY_PAGE_MAX, AppSettings, BulkAction, BulkSchedule, BulkTagChange,
    CalendarTasksPage, CatalogSnapshot, ClaimRemindersRequest, CollectedTasks, CommentPatch,
    DailyPlanPage, DismissReminder, DopamineMenuPage, EatTheFrogPage, EndOfDayPage, ExportFormat,
    ImportApplyRequest, ImportPreviewRequest, MarkOwnerLostReminders, MoveTarget, NudgesPage,
    OrderAnchor, ProjectDraft, ProjectListPage, ProjectPatch, ReminderLeaseRequest, ReorderScope,
    ReplanPastBlocksAction, ReplanPastBlocksPreview, RescheduleReminder, SavedFilterDraft,
    SavedFilterPatch, SectionDraft, SectionPatch, SettingsPatch, SettleReminderDelivered,
    SettleReminderFailed, StatsPage, TagDraft, TagListPage, TagPatch, TaskJarPage, TaskListAsOf,
    TaskListPage, TaskPatch, TemplateApply, TemplateDraft, TemplatePatch, TemporalContext,
    TemporalSettings, TimeBlockPatch, TimeBlockRangePatch, TimeSlotPatch, TimeblockingRangePage,
    TimeblockingRangeQuery, TransferApply, TransferFormat, TransferPreview, WeeklyReviewPage,
};
pub use service::{EventSink, JunbanService, default_temporal_settings};

/// Backward-compatible alias used by the Phase 1 server surface during Phase 2 cutover.
pub type TaskService<R, E> = JunbanService<R, E>;
