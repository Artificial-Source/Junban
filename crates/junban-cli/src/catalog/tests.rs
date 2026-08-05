//! Catalog inventory, determinism, and OpenAPI alignment invariants.

use std::collections::BTreeSet;

use junban_server::{RouteAccess, classified_routes};
use serde_json::Value;

use super::{EXCLUDED_OPERATION_IDS, ToolAccess, ToolCatalog, build_catalog, catalog, openapi};

#[test]
fn catalog_builds_with_expected_inventory_and_no_leakage() {
    let built = build_catalog().expect("catalog must build");
    assert_eq!(built.version, 1);
    assert!(!built.tools.is_empty());

    let names: BTreeSet<&str> = built.tools.iter().map(|tool| tool.name.as_str()).collect();
    for excluded in EXCLUDED_OPERATION_IDS {
        assert!(
            !names.contains(excluded),
            "excluded operation {excluded} leaked into catalog"
        );
    }
    // Delivery control plane and SSE must stay out.
    for forbidden in [
        "acquire_reminder_lease",
        "claim_due_reminders",
        "settle_reminder_delivered",
        "events",
        "reminder_events",
        "health",
    ] {
        assert!(!names.contains(forbidden));
    }

    // High-frequency domains must be present.
    for required in [
        "list_tasks",
        "create_task",
        "complete_task",
        "delete_task",
        "bulk_tasks",
        "undo_operation",
        "get_catalog",
        "create_project",
        "create_tag",
        "list_task_reminders",
        "reschedule_reminder",
        "dismiss_reminder",
        "planning_daily",
        "planning_end_of_day",
        "planning_weekly",
        "calendar_tasks",
        "stats",
        "nudges",
        "motivation_eat_the_frog",
        "motivation_task_jar",
        "motivation_dopamine_menu",
        "list_time_blocks",
        "create_time_block",
        "get_settings",
        "patch_settings",
        "preview_import",
        "apply_import",
        "export_tasks",
        "create_backup",
        "restore_backup",
        "rotate_token",
        "get_diagnostics",
        "clear_diagnostics",
        "get_maintenance_status",
        "get_recovery_status",
    ] {
        assert!(
            names.contains(required),
            "required catalog tool {required} missing"
        );
    }
}

#[test]
fn catalog_json_bytes_are_deterministic() {
    let first = catalog().to_json_bytes();
    let second = build_catalog().unwrap().to_json_bytes();
    assert_eq!(first, second);
    // Tools are sorted by name.
    let names = catalog().names();
    let mut sorted = names.clone();
    sorted.sort_unstable();
    assert_eq!(names, sorted);
}

#[test]
fn catalog_schemas_are_self_contained_objects_without_refs() {
    for tool in &catalog().tools {
        assert_eq!(
            tool.input_schema.get("type").and_then(Value::as_str),
            Some("object"),
            "{} input schema must be object",
            tool.name
        );
        assert!(
            !contains_ref(&tool.input_schema),
            "{} input schema still contains $ref",
            tool.name
        );
        assert!(
            !contains_ref(&tool.output_schema),
            "{} output schema still contains $ref",
            tool.name
        );
        assert!(
            tool.output_schema.is_object(),
            "{} output schema is missing",
            tool.name
        );
        assert!(
            !tool.name.is_empty() && !tool.description.is_empty(),
            "tool metadata incomplete"
        );
    }
}

#[test]
fn catalog_route_scopes_match_server_classification() {
    let route_access: std::collections::BTreeMap<(&str, &str), RouteAccess> = classified_routes()
        .iter()
        .map(|route| ((route.method, route.path), route.access))
        .collect();
    for tool in &catalog().tools {
        let key = (tool.execution.method, tool.execution.path_template);
        let access = route_access
            .get(&key)
            .copied()
            .unwrap_or_else(|| panic!("missing classification for {}", tool.name));
        let expected = ToolAccess::from_route(access).expect("mappable access");
        assert_eq!(tool.access, expected, "scope mismatch for {}", tool.name);
    }
}

#[test]
fn every_non_excluded_openapi_operation_is_catalogued() {
    let doc = openapi::parse_openapi().unwrap();
    let ops = openapi::iter_operations(&doc, EXCLUDED_OPERATION_IDS).unwrap();
    let names: BTreeSet<&str> = catalog()
        .tools
        .iter()
        .map(|tool| tool.name.as_str())
        .collect();
    let mut missing = Vec::new();
    for op in ops {
        if !names.contains(op.operation_id.as_str()) {
            missing.push(op.operation_id);
        }
    }
    assert!(
        missing.is_empty(),
        "OpenAPI operations missing from catalog: {missing:?}"
    );
}

#[test]
fn catalog_has_no_duplicate_names_or_operation_ids() {
    let mut names = BTreeSet::new();
    let mut ops = BTreeSet::new();
    for tool in &catalog().tools {
        assert!(
            names.insert(tool.name.clone()),
            "duplicate name {}",
            tool.name
        );
        assert!(
            ops.insert(tool.execution.operation_id),
            "duplicate operation {}",
            tool.execution.operation_id
        );
    }
}

#[test]
fn download_and_restore_wrappers_expose_path_fields() {
    let export = catalog().get("export_tasks").unwrap();
    assert!(
        export
            .input_schema
            .pointer("/properties/output_path")
            .is_some()
    );
    let restore = catalog().get("restore_backup").unwrap();
    assert!(
        restore
            .input_schema
            .pointer("/properties/input_path")
            .is_some()
    );
    assert!(
        restore
            .input_schema
            .pointer("/properties/confirm")
            .is_some()
    );
}

fn contains_ref(value: &Value) -> bool {
    match value {
        Value::Object(map) => {
            if map.contains_key("$ref") {
                return true;
            }
            map.values().any(contains_ref)
        }
        Value::Array(items) => items.iter().any(contains_ref),
        _ => false,
    }
}

#[test]
fn catalog_count_is_stable_snapshot() {
    // OpenAPI ops minus excluded health/principal/SSE/delivery/AI/voice/raw-secret ops = 87.
    let catalog = catalog();
    assert_eq!(
        catalog.tools.len(),
        87,
        "unexpected catalog size {}; names={:?}",
        catalog.tools.len(),
        catalog.names()
    );
    assert!(
        !catalog.names().contains(&"get_principal"),
        "principal discovery must stay out of the shared operator tool catalog"
    );
    for operation in ["create_voice_transcription", "create_voice_speech"] {
        assert!(
            !catalog.names().contains(&operation),
            "cloud voice must stay out of the frozen automation catalog"
        );
    }
    let _ = ToolCatalog {
        version: catalog.version,
        tools: catalog.tools.clone(),
    };
}

#[test]
fn output_schemas_match_actual_wrapped_results() {
    let task = catalog().get("get_task").unwrap();
    assert!(
        task.output_schema.pointer("/properties/title").is_some(),
        "representative DTO schema must be resolved"
    );

    for name in ["export_tasks", "create_backup"] {
        let schema = &catalog().get(name).unwrap().output_schema;
        assert_eq!(
            openapi::object_property_names(schema),
            ["bytes_written", "output_path"]
        );
        assert_eq!(schema["additionalProperties"], false);
    }

    let rotation = &catalog().get("rotate_token").unwrap().output_schema;
    assert!(rotation.pointer("/properties/token").is_none());
    assert!(rotation.pointer("/properties/token_path").is_some());
    assert_eq!(rotation["additionalProperties"], false);

    for name in ["revoke_automation_credential", "clear_diagnostics"] {
        let schema = &catalog().get(name).unwrap().output_schema;
        assert_eq!(
            schema,
            &serde_json::json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            })
        );
    }
}

#[test]
fn raw_credential_create_is_exactly_excluded_and_inputs_have_no_raw_secret_fields() {
    assert!(EXCLUDED_OPERATION_IDS.contains(&"create_automation_credential"));
    assert!(catalog().get("create_automation_credential").is_none());
    assert!(catalog().get("list_automation_credentials").is_some());
    assert!(catalog().get("revoke_automation_credential").is_some());

    fn inspect(value: &Value, path: &mut Vec<String>, violations: &mut Vec<String>) {
        match value {
            Value::Object(map) => {
                if let Some(properties) = map.get("properties").and_then(Value::as_object) {
                    for name in properties.keys() {
                        if matches!(name.as_str(), "token" | "secret" | "bearer" | "password") {
                            violations.push(format!("{}.{name}", path.join(".")));
                        }
                    }
                }
                for (name, child) in map {
                    path.push(name.clone());
                    inspect(child, path, violations);
                    path.pop();
                }
            }
            Value::Array(values) => {
                for child in values {
                    inspect(child, path, violations);
                }
            }
            _ => {}
        }
    }

    let mut violations = Vec::new();
    for tool in &catalog().tools {
        inspect(
            &tool.input_schema,
            &mut vec![tool.name.clone()],
            &mut violations,
        );
    }
    assert!(violations.is_empty(), "raw secret inputs: {violations:?}");
}

#[test]
fn pure_posts_and_local_downloads_have_exact_safety_metadata() {
    for name in [
        "parse_quick_entry",
        "parse_filter",
        "parse_text_import",
        "preview_import",
    ] {
        let tool = catalog().get(name).unwrap();
        assert_eq!(tool.kind, super::ToolKind::Read, "{name}");
        assert!(tool.safety.read_only, "{name}");
        assert!(tool.safety.idempotent, "{name}");
        assert!(!tool.safety.destructive, "{name}");
    }
    for name in ["export_tasks", "create_backup"] {
        let tool = catalog().get(name).unwrap();
        assert_eq!(tool.kind, super::ToolKind::Mutation, "{name}");
        assert!(!tool.safety.read_only, "{name}");
        assert!(!tool.safety.idempotent, "{name}");
        assert!(tool.safety.destructive, "{name}");
        assert_eq!(tool.execution.method, "GET");
        assert_eq!(tool.access, ToolAccess::Data);
    }
}

#[test]
fn operator_label_serializes_and_filters_exactly() {
    let tool = catalog().get("rotate_token").unwrap();
    assert_eq!(serde_json::to_value(tool).unwrap()["access"], "operator");
    let filtered = catalog().filter_scope(Some("operator"));
    assert!(!filtered.is_empty());
    assert!(
        filtered
            .iter()
            .all(|tool| serde_json::to_value(tool).unwrap()["access"] == "operator")
    );
}

/// P5-API-013: OpenAPI, shared catalog, and MCP tools/list schemas agree on required
/// range/date constraints for list_tasks, calendar_tasks, and stats.
#[test]
fn openapi_catalog_required_range_and_date_constraints_agree() {
    let doc = openapi::parse_openapi().unwrap();

    let list_tasks = openapi_operation(&doc, "list_tasks");
    let priority = openapi_query_schema(list_tasks, "priority");
    assert_eq!(priority["minimum"], 1, "{priority}");
    assert_eq!(priority["maximum"], 4, "{priority}");
    let limit = openapi_query_schema(list_tasks, "limit");
    assert_eq!(limit["minimum"], 1, "{limit}");
    assert_eq!(limit["maximum"], 100, "{limit}");
    for date_field in ["due_on", "due_before", "due_after"] {
        let schema = openapi_query_schema(list_tasks, date_field);
        assert_eq!(schema["format"], "date", "{date_field}: {schema}");
    }

    for op_name in ["calendar_tasks", "stats"] {
        let operation = openapi_operation(&doc, op_name);
        for field in ["from", "to"] {
            let param = openapi_query_param(operation, field);
            assert_eq!(param["required"], true, "{op_name}.{field}: {param}");
            assert_eq!(
                param["schema"]["format"], "date",
                "{op_name}.{field}: {param}"
            );
        }
    }

    // Shared catalog embeds the same constraints into tool input schemas.
    let catalog_list = &catalog().get("list_tasks").unwrap().input_schema;
    assert_eq!(catalog_list["properties"]["priority"]["minimum"], 1);
    assert_eq!(catalog_list["properties"]["priority"]["maximum"], 4);
    assert_eq!(catalog_list["properties"]["limit"]["minimum"], 1);
    assert_eq!(catalog_list["properties"]["limit"]["maximum"], 100);
    for date_field in ["due_on", "due_before", "due_after"] {
        assert_eq!(
            catalog_list["properties"][date_field]["format"], "date",
            "catalog list_tasks.{date_field}"
        );
    }

    for name in ["calendar_tasks", "stats"] {
        let schema = &catalog().get(name).unwrap().input_schema;
        let required = schema["required"]
            .as_array()
            .expect("required array")
            .iter()
            .filter_map(Value::as_str)
            .collect::<BTreeSet<_>>();
        assert!(
            required.contains("from") && required.contains("to"),
            "{name} required={required:?}"
        );
        assert_eq!(schema["properties"]["from"]["format"], "date");
        assert_eq!(schema["properties"]["to"]["format"], "date");
    }

    // MCP tools/list reuses catalog schemas byte-for-byte on these fields.
    for name in ["list_tasks", "calendar_tasks", "stats"] {
        let tool = catalog().get(name).unwrap();
        let input = tool.input_schema.as_object().expect("object input schema");
        if name == "list_tasks" {
            assert_eq!(input["properties"]["priority"]["minimum"], 1);
            assert_eq!(input["properties"]["priority"]["maximum"], 4);
            assert_eq!(input["properties"]["limit"]["minimum"], 1);
            assert_eq!(input["properties"]["limit"]["maximum"], 100);
        } else {
            let required = input["required"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(Value::as_str)
                .collect::<BTreeSet<_>>();
            assert!(required.contains("from") && required.contains("to"));
            assert_eq!(input["properties"]["from"]["format"], "date");
            assert_eq!(input["properties"]["to"]["format"], "date");
        }
    }
}

fn openapi_operation<'a>(doc: &'a Value, operation_id: &str) -> &'a Value {
    let paths = doc.get("paths").and_then(Value::as_object).expect("paths");
    for path_item in paths.values() {
        let Some(path_obj) = path_item.as_object() else {
            continue;
        };
        for operation in path_obj.values() {
            if operation.get("operationId").and_then(Value::as_str) == Some(operation_id) {
                return operation;
            }
        }
    }
    panic!("missing OpenAPI operation {operation_id}");
}

fn openapi_query_param<'a>(operation: &'a Value, name: &str) -> &'a Value {
    let params = operation
        .get("parameters")
        .and_then(Value::as_array)
        .expect("parameters");
    for param in params {
        if param.get("name").and_then(Value::as_str) == Some(name)
            && param.get("in").and_then(Value::as_str) == Some("query")
        {
            return param;
        }
    }
    panic!("missing query parameter {name}");
}

fn openapi_query_schema<'a>(operation: &'a Value, name: &str) -> &'a Value {
    openapi_query_param(operation, name)
        .get("schema")
        .expect("parameter schema")
}
