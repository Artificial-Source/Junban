//! Shipped Rust reference plugin for deterministic event automation.

wit_bindgen::generate!({
    path: "wit",
    world: "reference-automation",
    generate_all,
    generate_unused_types: true,
});

use exports::junban::plugin::guest::Guest;
use junban::plugin::types::*;

struct Component;

fn plugin_error(code: ErrorCode, field: &str, message: &str) -> PluginError {
    PluginError {
        code,
        field: Some(field.into()),
        message: message.into(),
    }
}

fn completion_target(kind: EventKind, subject: &EventSubject) -> Option<&str> {
    match (kind, subject) {
        (EventKind::TaskCreated, EventSubject::Task(task)) => Some(task.id.as_str()),
        _ => None,
    }
}

impl Guest for Component {
    fn activate(_context: InvocationContext) -> Result<(), PluginError> {
        Ok(())
    }

    fn deactivate(_context: InvocationContext) -> Result<(), PluginError> {
        Ok(())
    }

    fn invoke_command(
        _context: InvocationContext,
        _call: CommandCall,
    ) -> Result<PluginOutcome, PluginError> {
        Err(plugin_error(
            ErrorCode::InvalidInput,
            "command-id",
            "This plugin declares no commands.",
        ))
    }

    fn handle_event(
        _context: InvocationContext,
        event: EventEnvelope,
    ) -> Result<PluginOutcome, PluginError> {
        let effect = completion_target(event.kind, &event.subject).map(|task_id| {
            PluginEffect::DomainMutation(DomainMutation::CompleteTask(task_id.into()))
        });
        Ok(PluginOutcome { effect })
    }

    fn render_surface(
        _context: InvocationContext,
        _request: SurfaceRequest,
    ) -> Result<Surface, PluginError> {
        Err(plugin_error(
            ErrorCode::NotFound,
            "surface-id",
            "This plugin declares no surfaces.",
        ))
    }

    fn handle_surface_action(
        _context: InvocationContext,
        _action: SurfaceAction,
    ) -> Result<PluginOutcome, PluginError> {
        Err(plugin_error(
            ErrorCode::InvalidInput,
            "action-id",
            "This plugin declares no surface actions.",
        ))
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
        Err(plugin_error(
            ErrorCode::NotFound,
            "service-id",
            "This plugin declares no services.",
        ))
    }
}

export!(Component);

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str) -> TaskView {
        TaskView {
            id: id.into(),
            title: "New task".into(),
            description: String::new(),
            status: TaskStatus::Pending,
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
            created_at: "2030-01-02T03:04:05Z".into(),
            updated_at: "2030-01-02T03:04:05Z".into(),
            revision: 1,
        }
    }

    #[test]
    fn only_task_created_with_a_task_subject_is_completed() {
        let subject = EventSubject::Task(task("task-1"));
        assert_eq!(
            completion_target(EventKind::TaskCreated, &subject),
            Some("task-1")
        );
        assert_eq!(completion_target(EventKind::TaskUpdated, &subject), None);
        assert_eq!(
            completion_target(
                EventKind::TaskCreated,
                &EventSubject::DeletedTask("task-1".into())
            ),
            None
        );
    }
}
