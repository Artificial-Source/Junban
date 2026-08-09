//! Ergonomic tag commands.

use serde_json::{Map, Value, json};

use crate::commands::{
    call_and_emit, call_and_emit_view, insert_opt_str, require_confirm, validate_uuid_arg,
};
use crate::error::CliError;
use crate::output::OutputMode;
use crate::render::HumanView;
use crate::session::Session;

pub async fn list(session: &mut Session, mode: OutputMode) -> Result<(), CliError> {
    // Tags live in the organization catalog snapshot; human mode shows tags only.
    call_and_emit_view(session, mode, "get_catalog", json!({}), HumanView::Tags).await
}

pub async fn add(
    session: &mut Session,
    mode: OutputMode,
    name: String,
    color: Option<String>,
) -> Result<(), CliError> {
    let mut map = Map::new();
    map.insert("name".into(), Value::String(name));
    map.insert(
        "color".into(),
        Value::String(color.unwrap_or_else(|| "#3b82f6".to_owned())),
    );
    call_and_emit(session, mode, "create_tag", Value::Object(map)).await
}

pub async fn edit(
    session: &mut Session,
    mode: OutputMode,
    id: &str,
    name: Option<String>,
    color: Option<String>,
) -> Result<(), CliError> {
    let id = validate_uuid_arg(id, "tag_id")?;
    let mut map = Map::new();
    map.insert("tag_id".into(), Value::String(id));
    insert_opt_str(&mut map, "name", name);
    insert_opt_str(&mut map, "color", color);
    call_and_emit(session, mode, "patch_tag", Value::Object(map)).await
}

pub async fn delete(
    session: &mut Session,
    mode: OutputMode,
    id: &str,
    confirm: bool,
) -> Result<(), CliError> {
    require_confirm(confirm, "delete")?;
    let id = validate_uuid_arg(id, "tag_id")?;
    call_and_emit(
        session,
        mode,
        "delete_tag",
        json!({ "tag_id": id, "confirm": "delete" }),
    )
    .await
}
