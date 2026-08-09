//! Authorized MCP tool listing and call helpers over the shared catalog.

use std::sync::{Arc, OnceLock};

use junban_cli::{
    CliError, ExecutionResult, PrincipalCapabilities, RequestPlan, Session, ToolAccess,
    ToolDefinition, catalog, plan_tool_call,
};
use junban_server::AutomationScope;
use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool, ToolAnnotations};
use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

/// MCP argument ceiling (stricter than the generic CLI 8 MiB bound).
pub const MAX_MCP_ARGUMENT_BYTES: usize = 2 * 1024 * 1024;
/// MCP success-result ceiling for the complete serialized `CallToolResult` wire body.
pub const MAX_MCP_RESULT_BYTES: usize = 2 * 1024 * 1024;

/// One static MCP tool body derived from the shared catalog.
///
/// Schemas are owned once behind `Arc`. Authorization is intentionally **not**
/// stored here — every list/call still consults the live principal scopes.
#[derive(Debug, Clone)]
struct CachedMcpTool {
    access: ToolAccess,
    tool: Tool,
}

/// Process-wide MCP tool bodies in deterministic catalog order.
///
/// Built once so `tools/list` only scope-filters and cheap-clones Arc-backed
/// `Tool` values instead of deep-cloning every JSON schema on each request.
fn cached_mcp_tools() -> &'static [CachedMcpTool] {
    static CACHE: OnceLock<Vec<CachedMcpTool>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            catalog()
                .tools
                .iter()
                .map(|definition| {
                    let tool = build_mcp_tool(definition).unwrap_or_else(|message| {
                        panic!(
                            "static MCP tool cache failed for '{}': {message}",
                            definition.name
                        )
                    });
                    CachedMcpTool {
                        access: definition.access,
                        tool,
                    }
                })
                .collect()
        })
        .as_slice()
}

/// Disk-staged long operations that may emit start/completion progress notifications.
///
/// Imports are bounded in-memory requests and must not claim staged progress.
pub fn is_staged_data_tool(name: &str) -> bool {
    matches!(name, "export_tasks" | "create_backup")
}

#[must_use]
pub fn access_is_authorized(access: ToolAccess, capabilities: &PrincipalCapabilities) -> bool {
    match access {
        ToolAccess::OperatorOnly => false,
        ToolAccess::Read => capabilities.has_scope(AutomationScope::Read),
        ToolAccess::Write => capabilities.has_scope(AutomationScope::Write),
        ToolAccess::Data => capabilities.has_scope(AutomationScope::Data),
    }
}

#[must_use]
pub fn tool_is_authorized(tool: &ToolDefinition, capabilities: &PrincipalCapabilities) -> bool {
    access_is_authorized(tool.access, capabilities)
}

#[must_use]
pub fn authorized_tools(capabilities: &PrincipalCapabilities) -> Vec<&'static ToolDefinition> {
    catalog()
        .tools
        .iter()
        .filter(|tool| tool_is_authorized(tool, capabilities))
        .collect()
}

/// Authorized MCP tools for `tools/list`.
///
/// Uses the static cache so repeated lists reuse the same schema `Arc`s and only
/// perform live scope filtering plus cheap `Tool` clones. Catalog order is kept.
#[must_use]
pub fn list_authorized_mcp_tools(capabilities: &PrincipalCapabilities) -> Vec<Tool> {
    cached_mcp_tools()
        .iter()
        .filter(|entry| access_is_authorized(entry.access, capabilities))
        .map(|entry| entry.tool.clone())
        .collect()
}

/// Clone the cached MCP `Tool` for a catalog definition (Arc schema identity).
pub fn to_mcp_tool(tool: &ToolDefinition) -> Result<Tool, String> {
    cached_mcp_tools()
        .iter()
        .find(|entry| entry.tool.name.as_ref() == tool.name)
        .map(|entry| entry.tool.clone())
        .ok_or_else(|| format!("tool '{}' missing from static MCP tool cache", tool.name))
}

/// Build one MCP tool body, deep-cloning schemas into Arc-backed maps once.
fn build_mcp_tool(tool: &ToolDefinition) -> Result<Tool, String> {
    let input = schema_object(&tool.input_schema)
        .ok_or_else(|| format!("tool '{}' input schema is not an object", tool.name))?;
    let output = schema_object(&tool.output_schema)
        .ok_or_else(|| format!("tool '{}' output schema is not an object", tool.name))?;
    Ok(
        Tool::new(tool.name.clone(), tool.description.clone(), input)
            .with_raw_output_schema(output)
            .with_annotations(ToolAnnotations::from_raw(
                None,
                Some(tool.safety.read_only),
                Some(tool.safety.destructive),
                Some(tool.safety.idempotent),
                Some(false),
            )),
    )
}

fn schema_object(value: &Value) -> Option<Arc<JsonObject>> {
    value.as_object().map(|object| Arc::new(object.clone()))
}

/// Decode and bound MCP tool arguments after JSON-RPC parse.
pub fn decode_arguments(arguments: Option<&Map<String, Value>>) -> Result<Value, CliError> {
    let value = match arguments {
        None => Value::Object(Map::new()),
        Some(map) => Value::Object(map.clone()),
    };
    let encoded = serde_json::to_vec(&value)
        .map_err(|error| CliError::usage("invalid_arguments", error.to_string()))?;
    if encoded.len() > MAX_MCP_ARGUMENT_BYTES {
        return Err(CliError::usage(
            "arguments_too_large",
            format!(
                "tool arguments exceed {MAX_MCP_ARGUMENT_BYTES} bytes (got {})",
                encoded.len()
            ),
        ));
    }
    Ok(value)
}

/// Plan a catalog tool call after local wrapper/path validation.
///
/// Planning is pure and must run before staged progress so invalid inputs never
/// emit a start notification. The returned plan already owns any mutation
/// operation id, so callers must execute it once without re-planning.
pub fn plan_authorized_tool(name: &str, input: Value) -> Result<RequestPlan, CliError> {
    let tool = catalog()
        .get(name)
        .ok_or_else(|| CliError::usage("unknown_tool", format!("unknown tool '{name}'")))?;
    plan_tool_call(tool, input)
}

/// Reject oversized complete MCP tool-result wire bodies.
pub fn ensure_call_tool_result_within_bound(result: &CallToolResult) -> Result<(), CliError> {
    let encoded = serde_json::to_vec(result)
        .map_err(|error| CliError::runtime("result_encode_failed", error.to_string()))?;
    if encoded.len() > MAX_MCP_RESULT_BYTES {
        return Err(CliError::runtime(
            "result_too_large",
            format!(
                "tool result exceeds {MAX_MCP_RESULT_BYTES} bytes (got {})",
                encoded.len()
            ),
        ));
    }
    Ok(())
}

pub fn cli_error_to_tool_result(error: &CliError) -> CallToolResult {
    let payload = serde_json::to_value(error.to_json()).unwrap_or_else(|_| {
        serde_json::json!({
            "error": {
                "code": "internal_error",
                "message": "failed to encode tool error"
            }
        })
    });
    // Errors are intentionally small; still fail closed if encoding ever balloons.
    let result = CallToolResult::structured_error(payload);
    match ensure_call_tool_result_within_bound(&result) {
        Ok(()) => result,
        Err(bound_error) => {
            let fallback = serde_json::json!({
                "error": {
                    "code": bound_error.code(),
                    "message": bound_error.to_string(),
                }
            });
            CallToolResult::structured_error(fallback)
        }
    }
}

pub fn success_result(value: Value) -> CallToolResult {
    let result = CallToolResult::structured(value);
    match ensure_call_tool_result_within_bound(&result) {
        Ok(()) => result,
        Err(error) => cli_error_to_tool_result(&error),
    }
}

fn execution_to_tool_result(result: Result<ExecutionResult, CliError>) -> CallToolResult {
    match result {
        Ok(execution) => success_result(execution.value),
        Err(error) => cli_error_to_tool_result(&error),
    }
}

/// Execute a pre-validated plan while honoring request cancellation.
///
/// Cancellation drops the in-flight future. If a mutation HTTP request was already
/// admitted server-side, the outcome is unknown to the client; server idempotency
/// remains authoritative.
pub async fn execute_authorized_plan(
    session: &mut Session,
    plan: RequestPlan,
    cancel: &CancellationToken,
) -> Result<CallToolResult, CallOutcome> {
    tokio::select! {
        biased;
        () = cancel.cancelled() => Err(CallOutcome::Cancelled),
        result = session.execute_plan(plan) => Ok(execution_to_tool_result(result)),
    }
}

#[derive(Debug)]
pub enum CallOutcome {
    Cancelled,
}

/// Build a human-readable text block for hosts that ignore structuredContent.
#[allow(dead_code)]
pub fn text_block(text: impl Into<String>) -> ContentBlock {
    ContentBlock::text(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use junban_server::PrincipalKindDto;
    use serde_json::json;

    fn caps(scopes: &[AutomationScope]) -> PrincipalCapabilities {
        PrincipalCapabilities {
            kind: PrincipalKindDto::Automation,
            scopes: scopes.to_vec(),
        }
    }

    #[test]
    fn operator_tools_never_authorize() {
        let operator = catalog()
            .tools
            .iter()
            .find(|tool| tool.access == ToolAccess::OperatorOnly)
            .expect("operator tool");
        let full = PrincipalCapabilities {
            kind: PrincipalKindDto::Operator,
            scopes: vec![
                AutomationScope::Read,
                AutomationScope::Write,
                AutomationScope::Data,
            ],
        };
        assert!(!tool_is_authorized(operator, &full));
        assert!(!tool_is_authorized(
            operator,
            &caps(&[AutomationScope::Read])
        ));
    }

    #[test]
    fn scope_filtering_is_exact() {
        let read_tools = authorized_tools(&caps(&[AutomationScope::Read]));
        assert!(!read_tools.is_empty());
        assert!(
            read_tools
                .iter()
                .all(|tool| tool.access == ToolAccess::Read)
        );
        let write_tools = authorized_tools(&caps(&[AutomationScope::Write]));
        assert!(
            write_tools
                .iter()
                .all(|tool| tool.access == ToolAccess::Write)
        );
        assert!(!write_tools.iter().any(|tool| tool.name == "list_tasks"));
        assert!(write_tools.iter().any(|tool| tool.name == "create_task"));

        let data_tools = authorized_tools(&caps(&[AutomationScope::Data]));
        assert!(data_tools.iter().any(|tool| tool.name == "export_tasks"));
        assert!(data_tools.iter().any(|tool| tool.name == "create_backup"));
        assert!(!data_tools.iter().any(|tool| tool.name == "list_tasks"));
        assert!(!data_tools.iter().any(|tool| tool.name == "create_task"));
        assert!(
            data_tools
                .iter()
                .all(|tool| tool.access == ToolAccess::Data)
        );
    }

    #[test]
    fn staged_progress_is_limited_to_disk_exports_and_backups() {
        assert!(is_staged_data_tool("export_tasks"));
        assert!(is_staged_data_tool("create_backup"));
        assert!(!is_staged_data_tool("preview_import"));
        assert!(!is_staged_data_tool("apply_import"));
        assert!(!is_staged_data_tool("create_task"));
    }

    #[test]
    fn mcp_tool_schema_parity_with_catalog() {
        let tool = catalog().get("create_task").expect("create_task");
        let mcp = to_mcp_tool(tool).expect("mcp tool");
        assert_eq!(mcp.name.as_ref(), "create_task");
        assert_eq!(
            mcp.input_schema.as_ref(),
            tool.input_schema.as_object().unwrap()
        );
        assert_eq!(
            mcp.output_schema.as_ref().unwrap().as_ref(),
            tool.output_schema.as_object().unwrap()
        );
        let annotations = mcp.annotations.as_ref().unwrap();
        assert_eq!(annotations.read_only_hint, Some(false));
        assert_eq!(annotations.destructive_hint, Some(false));
        assert_eq!(annotations.idempotent_hint, Some(false));
        assert_eq!(annotations.open_world_hint, Some(false));
    }

    #[test]
    fn cached_mcp_tool_schemas_reuse_arc_identity() {
        let tool = catalog().get("create_task").expect("create_task");
        let first = to_mcp_tool(tool).expect("first");
        let second = to_mcp_tool(tool).expect("second");
        assert!(
            Arc::ptr_eq(&first.input_schema, &second.input_schema),
            "repeated to_mcp_tool must reuse the cached input schema Arc"
        );
        assert!(
            Arc::ptr_eq(
                first.output_schema.as_ref().unwrap(),
                second.output_schema.as_ref().unwrap()
            ),
            "repeated to_mcp_tool must reuse the cached output schema Arc"
        );

        // list_authorized_mcp_tools must clone the same Arc-backed bodies.
        let listed = list_authorized_mcp_tools(&caps(&[
            AutomationScope::Read,
            AutomationScope::Write,
            AutomationScope::Data,
        ]));
        let listed_create = listed
            .iter()
            .find(|entry| entry.name.as_ref() == "create_task")
            .expect("create_task in authorized list");
        assert!(Arc::ptr_eq(
            &first.input_schema,
            &listed_create.input_schema
        ));
        assert!(Arc::ptr_eq(
            first.output_schema.as_ref().unwrap(),
            listed_create.output_schema.as_ref().unwrap()
        ));

        // A second full list still shares schema identity with the first clone.
        let listed_again = list_authorized_mcp_tools(&caps(&[
            AutomationScope::Read,
            AutomationScope::Write,
            AutomationScope::Data,
        ]));
        let again_create = listed_again
            .iter()
            .find(|entry| entry.name.as_ref() == "create_task")
            .expect("create_task again");
        assert!(Arc::ptr_eq(
            &listed_create.input_schema,
            &again_create.input_schema
        ));
        assert!(Arc::ptr_eq(
            listed_create.output_schema.as_ref().unwrap(),
            again_create.output_schema.as_ref().unwrap()
        ));
    }

    #[test]
    fn list_authorized_mcp_tools_preserves_catalog_order_and_live_scopes() {
        let read_only = list_authorized_mcp_tools(&caps(&[AutomationScope::Read]));
        assert!(!read_only.is_empty());
        assert!(read_only.iter().all(|tool| {
            let def = catalog().get(tool.name.as_ref()).expect("catalog tool");
            def.access == ToolAccess::Read
        }));

        // Exact catalog relative order among authorized tools.
        let expected_names: Vec<&str> = authorized_tools(&caps(&[AutomationScope::Read]))
            .into_iter()
            .map(|tool| tool.name.as_str())
            .collect();
        let listed_names: Vec<&str> = read_only.iter().map(|tool| tool.name.as_ref()).collect();
        assert_eq!(listed_names, expected_names);

        let write_only = list_authorized_mcp_tools(&caps(&[AutomationScope::Write]));
        assert!(
            write_only
                .iter()
                .any(|tool| tool.name.as_ref() == "create_task")
        );
        assert!(
            !write_only
                .iter()
                .any(|tool| tool.name.as_ref() == "list_tasks")
        );

        let data_only = list_authorized_mcp_tools(&caps(&[AutomationScope::Data]));
        assert!(
            data_only
                .iter()
                .any(|tool| tool.name.as_ref() == "export_tasks")
        );
        assert!(
            !data_only
                .iter()
                .any(|tool| tool.name.as_ref() == "create_task")
        );

        // Operator-only catalog entries never appear regardless of scopes.
        let full = list_authorized_mcp_tools(&caps(&[
            AutomationScope::Read,
            AutomationScope::Write,
            AutomationScope::Data,
        ]));
        for tool in &full {
            let def = catalog().get(tool.name.as_ref()).expect("catalog tool");
            assert_ne!(def.access, ToolAccess::OperatorOnly);
        }
        assert_eq!(
            full.len(),
            authorized_tools(&caps(&[
                AutomationScope::Read,
                AutomationScope::Write,
                AutomationScope::Data,
            ]))
            .len()
        );

        // Cache covers every catalog entry exactly once in catalog order.
        let cache = cached_mcp_tools();
        assert_eq!(cache.len(), catalog().tools.len());
        for (cached, definition) in cache.iter().zip(catalog().tools.iter()) {
            assert_eq!(cached.tool.name.as_ref(), definition.name);
            assert_eq!(cached.access, definition.access);
            assert_eq!(
                cached.tool.input_schema.as_ref(),
                definition.input_schema.as_object().unwrap()
            );
            assert_eq!(
                cached.tool.output_schema.as_ref().unwrap().as_ref(),
                definition.output_schema.as_object().unwrap()
            );
        }
    }

    #[test]
    fn argument_bound_rejects_oversized_payload() {
        let oversized = "x".repeat(MAX_MCP_ARGUMENT_BYTES + 1);
        let mut map = Map::new();
        map.insert("title".into(), json!(oversized));
        let error = decode_arguments(Some(&map)).unwrap_err();
        assert_eq!(error.code(), "arguments_too_large");
    }

    #[test]
    fn complete_call_tool_result_bound_rejects_duplicated_near_limit_payload() {
        // Logical Value under 2 MiB can still serialize above the ceiling once
        // structuredContent is duplicated into text content.
        let logical_target = (MAX_MCP_RESULT_BYTES * 11) / 20; // ~1.1 MiB
        let oversized = json!({ "blob": "x".repeat(logical_target) });
        let logical_len = serde_json::to_vec(&oversized).unwrap().len();
        assert!(
            logical_len < MAX_MCP_RESULT_BYTES,
            "logical payload should be under the ceiling: {logical_len}"
        );

        let built = CallToolResult::structured(oversized.clone());
        let wire_len = serde_json::to_vec(&built).unwrap().len();
        assert!(
            wire_len > MAX_MCP_RESULT_BYTES,
            "duplicated structured result should exceed ceiling: {wire_len}"
        );
        let error = ensure_call_tool_result_within_bound(&built).unwrap_err();
        assert_eq!(error.code(), "result_too_large");

        let result = success_result(oversized);
        assert_eq!(result.is_error, Some(true));
        assert_eq!(
            result.structured_content.as_ref().unwrap()["error"]["code"],
            "result_too_large"
        );
        let error_wire = serde_json::to_vec(&result).unwrap().len();
        assert!(
            error_wire <= MAX_MCP_RESULT_BYTES,
            "result_too_large error must itself fit: {error_wire}"
        );
    }

    #[test]
    fn complete_call_tool_result_bound_accepts_near_boundary_success() {
        // Binary search a payload whose complete CallToolResult is just under 2 MiB.
        let mut lo = 0usize;
        let mut hi = MAX_MCP_RESULT_BYTES;
        let mut best = None;
        while lo <= hi {
            let mid = (lo + hi) / 2;
            let value = json!({ "blob": "x".repeat(mid) });
            let result = CallToolResult::structured(value);
            let len = serde_json::to_vec(&result).unwrap().len();
            if len <= MAX_MCP_RESULT_BYTES {
                best = Some((mid, result, len));
                lo = mid + 1;
            } else if mid == 0 {
                break;
            } else {
                hi = mid - 1;
            }
        }
        let (size, raw, wire_len) = best.expect("should find a near-boundary success payload");
        assert!(
            wire_len <= MAX_MCP_RESULT_BYTES,
            "near-boundary wire length {wire_len}"
        );
        assert!(
            MAX_MCP_RESULT_BYTES - wire_len < 256 * 1024,
            "expected near-boundary sample, got slack {} for payload {size}",
            MAX_MCP_RESULT_BYTES - wire_len
        );
        ensure_call_tool_result_within_bound(&raw).unwrap();
        let accepted = success_result(json!({ "blob": "x".repeat(size) }));
        assert_eq!(accepted.is_error, Some(false));
        let accepted_len = serde_json::to_vec(&accepted).unwrap().len();
        assert!(accepted_len <= MAX_MCP_RESULT_BYTES);
    }

    #[test]
    fn result_bound_accepts_small_payload() {
        let result = success_result(json!({"ok": true}));
        assert_eq!(result.is_error, Some(false));
        ensure_call_tool_result_within_bound(&result).unwrap();
    }

    #[test]
    fn invalid_staged_tool_plan_fails_before_dispatch() {
        let error = plan_authorized_tool("create_backup", json!({})).unwrap_err();
        assert_eq!(error.code(), "missing_input_field");
        let export_error =
            plan_authorized_tool("export_tasks", json!({"format": "json"})).unwrap_err();
        assert_eq!(export_error.code(), "missing_input_field");
    }

    #[test]
    fn mcp_tools_list_schemas_preserve_required_range_and_date_constraints() {
        for name in ["list_tasks", "calendar_tasks", "stats"] {
            let tool = catalog().get(name).expect(name);
            let mcp = to_mcp_tool(tool).expect("mcp tool");
            let input = mcp.input_schema.as_ref();
            if name == "list_tasks" {
                assert_eq!(input["properties"]["priority"]["minimum"], 1);
                assert_eq!(input["properties"]["priority"]["maximum"], 4);
                assert_eq!(input["properties"]["limit"]["minimum"], 1);
                assert_eq!(input["properties"]["limit"]["maximum"], 100);
                for field in ["due_on", "due_before", "due_after"] {
                    assert_eq!(input["properties"][field]["format"], "date", "{field}");
                }
            } else {
                let required = input["required"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>();
                assert!(required.contains(&"from"), "{name}: {required:?}");
                assert!(required.contains(&"to"), "{name}: {required:?}");
                assert_eq!(input["properties"]["from"]["format"], "date");
                assert_eq!(input["properties"]["to"]["format"], "date");
            }
        }
    }
}
