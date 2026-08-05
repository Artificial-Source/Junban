//! Build-only Rust 1.93 `wasm32-wasip2` consumer for the public SDK WIT.

// Regenerated with exact `wit-bindgen-cli 0.51.0`; the ordinary build compiles
// this checked-in output rather than trusting an opaque component fixture.
include!("../generated/rust_consumer.rs");

use exports::junban::plugin::guest::Guest;
use junban::plugin::types::*;

struct Component;

fn no_effect() -> PluginOutcome {
    PluginOutcome { effect: None }
}

/// Exact `TaskDraft::new` defaults before parent/domain validation.
fn new_task_draft(title: String) -> TaskDraft {
    TaskDraft {
        title,
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

/// Keep all named unchanged/clear/set and bulk clear/set representations live.
fn exercise_change_variants() {
    let due = LocalDueTime {
        time: "09:30:00".into(),
        time_zone: "Europe/London".into(),
    };
    let _ = [StringChange::Unchanged, StringChange::Set(String::new())];
    let _ = [BoolChange::Unchanged, BoolChange::Set(false)];
    let _ = [S64Change::Unchanged, S64Change::Set(0)];
    let _ = [
        ProjectViewChange::Unchanged,
        ProjectViewChange::Set(ProjectView::Calendar),
    ];
    let _ = [
        OptionalStringChange::Unchanged,
        OptionalStringChange::Clear,
        OptionalStringChange::Set(String::new()),
    ];
    let _ = [
        OptionalIdChange::Unchanged,
        OptionalIdChange::Clear,
        OptionalIdChange::Set("id".into()),
    ];
    let _ = [
        OptionalDateChange::Unchanged,
        OptionalDateChange::Clear,
        OptionalDateChange::Set("2026-08-04".into()),
    ];
    let _ = [
        OptionalTimestampChange::Unchanged,
        OptionalTimestampChange::Clear,
        OptionalTimestampChange::Set("2026-08-04T00:00:00Z".into()),
    ];
    let _ = [
        OptionalLocalDueTimeChange::Unchanged,
        OptionalLocalDueTimeChange::Clear,
        OptionalLocalDueTimeChange::Set(due),
    ];
    let _ = [
        OptionalU32Change::Unchanged,
        OptionalU32Change::Clear,
        OptionalU32Change::Set(1),
    ];
    let _ = [
        OptionalU8Change::Unchanged,
        OptionalU8Change::Clear,
        OptionalU8Change::Set(1),
    ];
    let _ = [
        OptionalPriorityChange::Unchanged,
        OptionalPriorityChange::Clear,
        OptionalPriorityChange::Set(Priority::P1),
    ];
    let _ = [IdListChange::Unchanged, IdListChange::Replace(Vec::new())];
    let _ = [BulkPriority::Clear, BulkPriority::Set(Priority::P4)];
    let _ = [ProjectView::List, ProjectView::Board, ProjectView::Calendar];
    let _ = [Priority::P1, Priority::P2, Priority::P3, Priority::P4];
    let _ = new_task_draft("task".into());
}

impl Guest for Component {
    fn activate(_context: InvocationContext) -> Result<(), PluginError> {
        exercise_change_variants();
        let _ = junban::plugin::host_settings::get_settings();
        let _ = junban::plugin::host_storage::get_kv(&[]);
        let _ = junban::plugin::host_storage::list_kv(None, 1);
        junban::plugin::host_log::log(LogLevel::Debug, "consumer", &[]);
        Ok(())
    }
    fn deactivate(_context: InvocationContext) -> Result<(), PluginError> {
        Ok(())
    }
    fn invoke_command(
        _context: InvocationContext,
        _call: CommandCall,
    ) -> Result<PluginOutcome, PluginError> {
        let _ = junban::plugin::host_tasks::query_tasks(&TaskQuery {
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
        Ok(no_effect())
    }
    fn handle_event(
        _context: InvocationContext,
        _event: EventEnvelope,
    ) -> Result<PluginOutcome, PluginError> {
        Ok(no_effect())
    }
    fn render_surface(
        _context: InvocationContext,
        request: SurfaceRequest,
    ) -> Result<Surface, PluginError> {
        Ok(Surface {
            surface_id: request.surface_id,
            root_index: 0,
            nodes: vec![UiNode {
                id: "root".into(),
                parent_index: None,
                content: UiContent::Stack(LayoutProps {
                    gap: 0,
                    align: UiAlign::Start,
                }),
            }],
        })
    }
    fn handle_surface_action(
        _context: InvocationContext,
        _action: SurfaceAction,
    ) -> Result<PluginOutcome, PluginError> {
        Ok(no_effect())
    }
    fn validate_settings(
        _context: InvocationContext,
        _values: SettingValues,
    ) -> Result<Vec<ValidationIssue>, PluginError> {
        Ok(Vec::new())
    }
    fn resync(
        _context: InvocationContext,
        page: ResyncPage,
    ) -> Result<ResyncPageOutcome, PluginError> {
        Ok(match page {
            ResyncPage::Snapshot(page) => ResyncPageOutcome::SnapshotAck(SnapshotAck {
                session_id: page.session_id,
                page_index: page.page_index,
                kind: page.kind,
                segment: None,
            }),
            ResyncPage::FlushStagedKv(page) => ResyncPageOutcome::FlushAck(FlushAck {
                session_id: page.session_id,
                request_index: page.request_index,
                segment: None,
                state: FlushState::Complete,
            }),
            ResyncPage::Finalize(page) => ResyncPageOutcome::Finalized(FinalizedResync {
                session_id: page.session_id,
                choice: FinalKvChoice::LeaveKv,
            }),
        })
    }
    fn call_service(
        _context: InvocationContext,
        _call: ServiceCall,
    ) -> Result<ServiceData, PluginError> {
        Ok(ServiceData { values: Vec::new() })
    }
}

export!(Component);
