//! Ergonomic task commands.

use serde_json::{Map, Value, json};

use crate::commands::{
    call_and_emit, insert_opt_str, insert_opt_u32, require_confirm, validate_date_arg,
    validate_instant_arg, validate_uuid_arg,
};
use crate::error::CliError;
use crate::output::OutputMode;
use crate::session::Session;

#[allow(clippy::too_many_arguments)]
pub async fn list(
    session: &mut Session,
    mode: OutputMode,
    view: Option<String>,
    search: Option<String>,
    status: Option<String>,
    project_id: Option<String>,
    tag_id: Option<String>,
    limit: Option<u32>,
) -> Result<(), CliError> {
    let mut map = Map::new();
    insert_opt_str(&mut map, "view", view);
    insert_opt_str(&mut map, "search", search);
    insert_opt_str(&mut map, "status", status);
    if let Some(project_id) = project_id {
        if project_id != "-" {
            validate_uuid_arg(&project_id, "project_id")?;
        }
        map.insert("project_id".into(), Value::String(project_id));
    }
    if let Some(tag_id) = tag_id {
        validate_uuid_arg(&tag_id, "tag_id")?;
        map.insert("tag_id".into(), Value::String(tag_id));
    }
    insert_opt_u32(&mut map, "limit", limit);
    call_and_emit(session, mode, "list_tasks", Value::Object(map)).await
}

pub async fn get(session: &mut Session, mode: OutputMode, id: &str) -> Result<(), CliError> {
    let id = validate_uuid_arg(id, "task_id")?;
    call_and_emit(session, mode, "get_task", json!({ "task_id": id })).await
}

pub async fn add(
    session: &mut Session,
    mode: OutputMode,
    title: String,
    description: Option<String>,
    project_id: Option<String>,
    due_date: Option<String>,
    priority: Option<u8>,
) -> Result<(), CliError> {
    let mut map = Map::new();
    map.insert("title".into(), Value::String(title));
    insert_opt_str(&mut map, "description", description);
    if let Some(project_id) = project_id {
        validate_uuid_arg(&project_id, "project_id")?;
        map.insert("project_id".into(), Value::String(project_id));
    }
    if let Some(due_date) = due_date {
        let due_date = validate_date_arg(&due_date, "due_date")?;
        map.insert("due_date".into(), Value::String(due_date));
    }
    if let Some(priority) = priority {
        map.insert("priority".into(), json!(priority));
    }
    call_and_emit(session, mode, "create_task", Value::Object(map)).await
}

pub async fn edit(
    session: &mut Session,
    mode: OutputMode,
    id: &str,
    title: Option<String>,
    description: Option<String>,
    due_date: Option<String>,
    priority: Option<u8>,
) -> Result<(), CliError> {
    let id = validate_uuid_arg(id, "task_id")?;
    let mut map = Map::new();
    map.insert("task_id".into(), Value::String(id));
    insert_opt_str(&mut map, "title", title);
    insert_opt_str(&mut map, "description", description);
    if let Some(due_date) = due_date {
        if due_date.is_empty() {
            map.insert("due_date".into(), Value::Null);
        } else {
            let due_date = validate_date_arg(&due_date, "due_date")?;
            map.insert("due_date".into(), Value::String(due_date));
        }
    }
    if let Some(priority) = priority {
        map.insert("priority".into(), json!(priority));
    }
    call_and_emit(session, mode, "patch_task", Value::Object(map)).await
}

pub async fn status_action(
    session: &mut Session,
    mode: OutputMode,
    tool: &str,
    id: &str,
) -> Result<(), CliError> {
    let id = validate_uuid_arg(id, "task_id")?;
    call_and_emit(session, mode, tool, json!({ "task_id": id })).await
}

pub async fn delete(
    session: &mut Session,
    mode: OutputMode,
    id: &str,
    confirm: bool,
) -> Result<(), CliError> {
    require_confirm(confirm, "delete")?;
    let id = validate_uuid_arg(id, "task_id")?;
    call_and_emit(
        session,
        mode,
        "delete_task",
        json!({ "task_id": id, "confirm": "delete" }),
    )
    .await
}

pub async fn bulk(
    session: &mut Session,
    mode: OutputMode,
    action: String,
    task_ids: Vec<String>,
    confirm: bool,
) -> Result<(), CliError> {
    if task_ids.is_empty() {
        return Err(CliError::usage(
            "missing_task_ids",
            "bulk requires at least one --id",
        ));
    }
    let mut ids = Vec::new();
    for id in task_ids {
        ids.push(validate_uuid_arg(&id, "task_id")?);
    }
    let destructive = matches!(action.as_str(), "delete");
    if destructive {
        require_confirm(confirm, "delete")?;
    }
    let action_value = match action.as_str() {
        "complete" | "uncomplete" | "cancel" | "reopen" | "delete" => {
            json!({ "type": action })
        }
        other => {
            return Err(CliError::usage(
                "invalid_bulk_action",
                format!(
                    "unsupported bulk action '{other}' (use complete, uncomplete, cancel, reopen, delete)"
                ),
            ));
        }
    };
    let mut input = json!({
        "task_ids": ids,
        "action": action_value,
    });
    if destructive {
        input
            .as_object_mut()
            .unwrap()
            .insert("confirm".into(), Value::String("delete".into()));
    }
    call_and_emit(session, mode, "bulk_tasks", input).await
}

pub async fn undo(
    session: &mut Session,
    mode: OutputMode,
    operation_id: &str,
) -> Result<(), CliError> {
    let operation_id = validate_uuid_arg(operation_id, "source_operation_id")?;
    call_and_emit(
        session,
        mode,
        "undo_operation",
        json!({ "source_operation_id": operation_id }),
    )
    .await
}

#[allow(dead_code)]
pub async fn edit_deadline(
    session: &mut Session,
    mode: OutputMode,
    id: &str,
    deadline: &str,
) -> Result<(), CliError> {
    let id = validate_uuid_arg(id, "task_id")?;
    let deadline = validate_instant_arg(deadline, "deadline")?;
    call_and_emit(
        session,
        mode,
        "patch_task",
        json!({ "task_id": id, "deadline": deadline }),
    )
    .await
}
