//! Ergonomic reminder commands.

use serde_json::json;

use crate::commands::{call_and_emit, validate_instant_arg, validate_uuid_arg};
use crate::error::CliError;
use crate::output::OutputMode;
use crate::session::Session;

pub async fn list(session: &mut Session, mode: OutputMode, task_id: &str) -> Result<(), CliError> {
    let task_id = validate_uuid_arg(task_id, "task_id")?;
    call_and_emit(
        session,
        mode,
        "list_task_reminders",
        json!({ "task_id": task_id }),
    )
    .await
}

pub async fn snooze(
    session: &mut Session,
    mode: OutputMode,
    task_id: &str,
    remind_at: &str,
) -> Result<(), CliError> {
    let task_id = validate_uuid_arg(task_id, "task_id")?;
    let remind_at = validate_instant_arg(remind_at, "remind_at")?;
    call_and_emit(
        session,
        mode,
        "reschedule_reminder",
        json!({ "task_id": task_id, "remind_at": remind_at }),
    )
    .await
}

pub async fn dismiss(
    session: &mut Session,
    mode: OutputMode,
    task_id: &str,
) -> Result<(), CliError> {
    let task_id = validate_uuid_arg(task_id, "task_id")?;
    call_and_emit(
        session,
        mode,
        "dismiss_reminder",
        json!({ "task_id": task_id }),
    )
    .await
}
