//! Generic catalog discovery and invocation.

use serde_json::Value;

use crate::catalog::{catalog, human_tool_line, parse_input_arg};
use crate::commands::emit_value_default;
use crate::error::CliError;
use crate::output::{self, OutputMode};
use crate::session::Session;

pub async fn tools_list(mode: OutputMode, scope: Option<&str>) -> Result<(), CliError> {
    if let Some(scope) = scope {
        match scope {
            "read" | "write" | "data" | "operator" => {}
            _ => {
                return Err(CliError::usage(
                    "invalid_scope_filter",
                    "scope filter must be read, write, data, or operator",
                ));
            }
        }
    }
    let catalog = catalog();
    let tools = catalog.filter_scope(scope);
    match mode {
        OutputMode::Json => {
            let doc = serde_json::json!({
                "version": catalog.version,
                "tools": tools,
            });
            output::write_json_success(&doc)
        }
        OutputMode::Human => {
            if tools.is_empty() {
                output::write_human_line("no tools")?;
                return Ok(());
            }
            for tool in tools {
                output::write_human_line(&human_tool_line(tool))?;
            }
            Ok(())
        }
    }
}

pub async fn tool_call(
    session: &mut Session,
    mode: OutputMode,
    name: &str,
    input: &str,
    output_path: Option<&str>,
) -> Result<(), CliError> {
    let mut value = parse_input_arg(input)?;
    if let Some(output_path) = output_path {
        let obj = value.as_object_mut().ok_or_else(|| {
            CliError::usage("invalid_input_json", "tool input must be a JSON object")
        })?;
        obj.insert(
            "output_path".to_owned(),
            Value::String(output_path.to_owned()),
        );
    }
    let result = session.call_tool(name, value).await?;
    emit_value_default(mode, &result.value)
}
