//! Ergonomic and generic CLI command handlers.

pub mod data;
pub mod plan;
pub mod project;
pub mod reminder;
pub mod server;
pub mod tag;
pub mod task;
pub mod tools;

use serde_json::{Map, Value, json};

use crate::catalog::wrappers;
use crate::error::CliError;
use crate::output::{self, OutputMode};
use crate::render::{self, HumanView};
use crate::session::Session;

/// Emit a catalog/tool JSON value for the selected output mode and human view.
pub fn emit_value_view(mode: OutputMode, value: &Value, view: HumanView) -> Result<(), CliError> {
    match mode {
        OutputMode::Json => output::write_json_success(value),
        OutputMode::Human => render::emit_human(value, view),
    }
}

/// Machine-oriented default used by generic `tool call`.
pub fn emit_value_default(mode: OutputMode, value: &Value) -> Result<(), CliError> {
    emit_value_view(mode, value, HumanView::PrettyJson)
}

/// Call a catalog tool and emit a concise human or strict JSON result.
pub async fn call_and_emit(
    session: &mut Session,
    mode: OutputMode,
    name: &str,
    input: Value,
) -> Result<(), CliError> {
    call_and_emit_view(session, mode, name, input, HumanView::Auto).await
}

/// Call a catalog tool with an explicit human-view hint.
pub async fn call_and_emit_view(
    session: &mut Session,
    mode: OutputMode,
    name: &str,
    input: Value,
    view: HumanView,
) -> Result<(), CliError> {
    let result = session.call_tool(name, input).await?;
    emit_value_view(mode, &result.value, view)
}

pub fn require_confirm(flag: bool, expected: &str) -> Result<(), CliError> {
    if flag {
        Ok(())
    } else {
        Err(CliError::usage(
            "confirmation_required",
            format!("destructive operation requires --confirm {expected}"),
        ))
    }
}

pub fn object_from_pairs(pairs: impl IntoIterator<Item = (String, Value)>) -> Value {
    let mut map = Map::new();
    for (key, value) in pairs {
        map.insert(key, value);
    }
    Value::Object(map)
}

pub fn insert_opt_str(map: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        map.insert(key.to_owned(), Value::String(value));
    }
}

pub fn insert_opt_bool(map: &mut Map<String, Value>, key: &str, value: Option<bool>) {
    if let Some(value) = value {
        map.insert(key.to_owned(), Value::Bool(value));
    }
}

pub fn insert_opt_u32(map: &mut Map<String, Value>, key: &str, value: Option<u32>) {
    if let Some(value) = value {
        map.insert(key.to_owned(), json!(value));
    }
}

pub fn validate_uuid_arg(raw: &str, field: &str) -> Result<String, CliError> {
    wrappers::validate_uuid_str(raw, field)?;
    Ok(raw.to_owned())
}

pub fn validate_date_arg(raw: &str, field: &str) -> Result<String, CliError> {
    wrappers::validate_civil_date(raw, field)?;
    Ok(raw.to_owned())
}

pub fn validate_instant_arg(raw: &str, field: &str) -> Result<String, CliError> {
    wrappers::validate_instant(raw, field)?;
    Ok(raw.to_owned())
}
