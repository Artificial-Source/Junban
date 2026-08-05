//! Tool-specific input wrappers layered on OpenAPI operation inputs.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use super::WrapperKind;
use crate::error::CliError;

pub const WRAPPER_OUTPUT_PATH: &str = "output_path";
pub const WRAPPER_INPUT_PATH: &str = "input_path";
pub const WRAPPER_WRITE_TOKEN: &str = "write_token";
pub const WRAPPER_CONFIRM: &str = "confirm";
pub const WRAPPER_OVERWRITE: &str = "overwrite";

/// Expected confirmation token for a wrapper, when applicable.
pub fn confirm_field_name() -> &'static str {
    WRAPPER_CONFIRM
}

/// Extend a resolved OpenAPI input schema with wrapper-only fields.
pub fn apply_wrapper_to_schema(
    schema: &mut Value,
    wrapper: Option<WrapperKind>,
    confirm_value: Option<&str>,
) -> Result<(), String> {
    let Some(wrapper) = wrapper else {
        return Ok(());
    };
    let obj = schema
        .as_object_mut()
        .ok_or_else(|| "wrapper requires object input schema".to_owned())?;
    if !obj.contains_key("properties") {
        obj.insert("properties".to_owned(), json!({}));
    }
    if !obj.contains_key("required") {
        obj.insert("required".to_owned(), json!([]));
    }

    match wrapper {
        WrapperKind::DownloadPath => {
            insert_prop(
                obj,
                WRAPPER_OUTPUT_PATH,
                json!({
                    "type": "string",
                    "description": "Local filesystem path that receives the downloaded bytes. Refuses overwrite unless overwrite=true."
                }),
            )?;
            insert_prop(
                obj,
                WRAPPER_OVERWRITE,
                json!({
                    "type": "boolean",
                    "description": "When true, replace an existing output_path. Default false."
                }),
            )?;
            push_required_field(obj, WRAPPER_OUTPUT_PATH)?;
        }
        WrapperKind::RestoreUpload => {
            insert_prop(
                obj,
                WRAPPER_INPUT_PATH,
                json!({
                    "type": "string",
                    "description": "Local .junban-backup file to upload for restore."
                }),
            )?;
            insert_prop(
                obj,
                WRAPPER_CONFIRM,
                json!({
                    "type": "string",
                    "description": "Must equal \"restore\" to proceed."
                }),
            )?;
            push_required_field(obj, WRAPPER_INPUT_PATH)?;
            push_required_field(obj, WRAPPER_CONFIRM)?;
        }
        WrapperKind::RotateToken => {
            insert_prop(
                obj,
                WRAPPER_WRITE_TOKEN,
                json!({
                    "type": "string",
                    "description": "Private path that receives the rotated operator token. Never overwrites."
                }),
            )?;
            insert_prop(
                obj,
                WRAPPER_CONFIRM,
                json!({
                    "type": "string",
                    "description": "Must equal \"rotate-token\" to proceed."
                }),
            )?;
            push_required_field(obj, WRAPPER_WRITE_TOKEN)?;
            push_required_field(obj, WRAPPER_CONFIRM)?;
        }
        WrapperKind::ConfirmOnly => {
            let expected = confirm_value.ok_or_else(|| {
                "ConfirmOnly wrapper requires an expected confirmation value".to_owned()
            })?;
            insert_prop(
                obj,
                WRAPPER_CONFIRM,
                json!({
                    "type": "string",
                    "description": format!("Must equal \"{expected}\" to proceed.")
                }),
            )?;
            push_required_field(obj, WRAPPER_CONFIRM)?;
        }
        WrapperKind::BulkTasks => {
            insert_prop(
                obj,
                WRAPPER_CONFIRM,
                json!({
                    "type": "string",
                    "description": "Required and must equal \"delete\" only when action.type is delete."
                }),
            )?;
            obj.insert(
                "allOf".to_owned(),
                json!([{
                    "if": {
                        "properties": {
                            "action": {
                                "type": "object",
                                "properties": { "type": { "const": "delete" } },
                                "required": ["type"]
                            }
                        },
                        "required": ["action"]
                    },
                    "then": {
                        "properties": { "confirm": { "const": "delete" } },
                        "required": ["confirm"]
                    }
                }]),
            );
        }
    }
    if let Some(required) = obj.get_mut("required").and_then(Value::as_array_mut) {
        required.sort_by(|left, right| {
            left.as_str()
                .unwrap_or_default()
                .cmp(right.as_str().unwrap_or_default())
        });
    }
    Ok(())
}

fn insert_prop(obj: &mut Map<String, Value>, name: &str, schema: Value) -> Result<(), String> {
    let properties = obj
        .get_mut("properties")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "schema properties must be an object".to_owned())?;
    properties.insert(name.to_owned(), schema);
    Ok(())
}

fn push_required_field(obj: &mut Map<String, Value>, name: &str) -> Result<(), String> {
    let required = obj
        .get_mut("required")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "schema required must be an array".to_owned())?;
    push_required(required, name);
    Ok(())
}

fn push_required(required: &mut Vec<Value>, name: &str) {
    let value = Value::String(name.to_owned());
    if !required.contains(&value) {
        required.push(value);
    }
}

/// Validated wrapper fields extracted from tool input before HTTP planning.
#[derive(Debug, Clone, Default)]
pub struct WrapperFields {
    pub output_path: Option<PathBuf>,
    pub overwrite: bool,
    pub input_path: Option<PathBuf>,
    pub write_token: Option<PathBuf>,
    pub confirm: Option<String>,
}

/// Validate and strip wrapper-only fields from the tool input object.
pub fn validate_wrapper_input(
    wrapper: Option<WrapperKind>,
    confirm_value: Option<&str>,
    input: &mut Map<String, Value>,
) -> Result<WrapperFields, CliError> {
    let mut fields = WrapperFields::default();
    let Some(wrapper) = wrapper else {
        // Reject unknown wrapper keys if present without a wrapper.
        for key in [
            WRAPPER_OUTPUT_PATH,
            WRAPPER_INPUT_PATH,
            WRAPPER_WRITE_TOKEN,
            WRAPPER_CONFIRM,
            WRAPPER_OVERWRITE,
        ] {
            if input.contains_key(key) {
                return Err(CliError::usage(
                    "unexpected_input_field",
                    format!("field '{key}' is not valid for this tool"),
                ));
            }
        }
        return Ok(fields);
    };

    match wrapper {
        WrapperKind::DownloadPath => {
            fields.output_path = Some(require_path_field(input, WRAPPER_OUTPUT_PATH)?);
            fields.overwrite = match input.remove(WRAPPER_OVERWRITE) {
                None => false,
                Some(Value::Bool(value)) => value,
                Some(_) => {
                    return Err(CliError::usage(
                        "invalid_input_field",
                        "overwrite must be a boolean",
                    ));
                }
            };
        }
        WrapperKind::RestoreUpload => {
            fields.input_path = Some(require_path_field(input, WRAPPER_INPUT_PATH)?);
            fields.confirm = take_optional_string_field(input, WRAPPER_CONFIRM)?;
            expect_confirm(fields.confirm.as_deref(), confirm_value.or(Some("restore")))?;
        }
        WrapperKind::RotateToken => {
            fields.write_token = Some(require_path_field(input, WRAPPER_WRITE_TOKEN)?);
            fields.confirm = take_optional_string_field(input, WRAPPER_CONFIRM)?;
            expect_confirm(
                fields.confirm.as_deref(),
                confirm_value.or(Some("rotate-token")),
            )?;
        }
        WrapperKind::ConfirmOnly => {
            fields.confirm = take_optional_string_field(input, WRAPPER_CONFIRM)?;
            expect_confirm(fields.confirm.as_deref(), confirm_value)?;
        }
        WrapperKind::BulkTasks => {
            fields.confirm = take_optional_string_field(input, WRAPPER_CONFIRM)?;
            let action = input
                .get("action")
                .and_then(Value::as_object)
                .and_then(|action| action.get("type"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    CliError::usage("invalid_input_field", "bulk action.type must be a string")
                })?;
            if action == "delete" {
                expect_confirm(fields.confirm.as_deref(), confirm_value.or(Some("delete")))?;
            } else if fields.confirm.is_some() {
                return Err(CliError::usage(
                    "unexpected_input_field",
                    "confirm is valid only for bulk delete",
                ));
            }
        }
    }
    Ok(fields)
}

fn expect_confirm(actual: Option<&str>, expected: Option<&str>) -> Result<(), CliError> {
    let expected = expected.ok_or_else(|| {
        CliError::runtime(
            "catalog_confirm_missing",
            "catalog entry is missing a confirmation value",
        )
    })?;
    match actual {
        Some(value) if value == expected => Ok(()),
        Some(_) => Err(CliError::usage(
            "confirmation_required",
            format!("destructive operation requires confirm={expected}"),
        )),
        None => Err(CliError::usage(
            "confirmation_required",
            format!("destructive operation requires confirm={expected}"),
        )),
    }
}

fn require_string_field(input: &mut Map<String, Value>, field: &str) -> Result<String, CliError> {
    match take_optional_string_field(input, field)? {
        Some(value) => Ok(value),
        None => Err(CliError::usage(
            "missing_input_field",
            format!("missing required field {field}"),
        )),
    }
}

fn take_optional_string_field(
    input: &mut Map<String, Value>,
    field: &str,
) -> Result<Option<String>, CliError> {
    match input.remove(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.is_empty() => Ok(Some(value)),
        Some(Value::String(_)) => Err(CliError::usage(
            "invalid_input_field",
            format!("{field} must not be empty"),
        )),
        Some(_) => Err(CliError::usage(
            "invalid_input_field",
            format!("{field} must be a string"),
        )),
    }
}

fn require_path_field(input: &mut Map<String, Value>, field: &str) -> Result<PathBuf, CliError> {
    let raw = require_string_field(input, field)?;
    let path = PathBuf::from(&raw);
    if path.as_os_str().is_empty() {
        return Err(CliError::usage(
            "invalid_input_field",
            format!("{field} must not be empty"),
        ));
    }
    // Reject NUL and refuse to treat the path as a URL.
    if raw.contains('\0') || raw.contains("://") {
        return Err(CliError::usage(
            "invalid_input_field",
            format!("{field} must be a local filesystem path"),
        ));
    }
    Ok(path)
}

/// Validate an exact UUID string (any UUID version).
pub fn validate_uuid_str(raw: &str, field: &str) -> Result<(), CliError> {
    uuid::Uuid::parse_str(raw)
        .map_err(|_| CliError::usage("invalid_id", format!("{field} must be an exact UUID")))?;
    Ok(())
}

/// Validate a civil date `YYYY-MM-DD`.
pub fn validate_civil_date(raw: &str, field: &str) -> Result<(), CliError> {
    jiff::civil::Date::strptime("%Y-%m-%d", raw).map_err(|_| {
        CliError::usage(
            "invalid_date",
            format!("{field} must be a civil date in YYYY-MM-DD form"),
        )
    })?;
    Ok(())
}

/// Validate an instant with offset or Z.
pub fn validate_instant(raw: &str, field: &str) -> Result<(), CliError> {
    raw.parse::<jiff::Timestamp>().map_err(|_| {
        CliError::usage(
            "invalid_instant",
            format!("{field} must be an RFC 3339 instant with offset or Z"),
        )
    })?;
    Ok(())
}

/// Ensure a local file exists, is a regular file, and is within `max_bytes`.
pub fn validate_upload_file(path: &Path, max_bytes: u64) -> Result<u64, CliError> {
    let meta = std::fs::metadata(path).map_err(|error| {
        CliError::usage(
            "upload_file_unreadable",
            format!("could not read {}: {error}", path.display()),
        )
    })?;
    if !meta.is_file() {
        return Err(CliError::usage(
            "upload_file_invalid",
            format!("{} is not a regular file", path.display()),
        ));
    }
    let len = meta.len();
    if len == 0 {
        return Err(CliError::usage(
            "upload_file_empty",
            format!("{} is empty", path.display()),
        ));
    }
    if len > max_bytes {
        return Err(CliError::usage(
            "upload_file_too_large",
            format!(
                "{} is {len} bytes; maximum allowed is {max_bytes}",
                path.display()
            ),
        ));
    }
    Ok(len)
}
