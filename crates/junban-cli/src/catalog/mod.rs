//! Deterministic versioned automation catalog shared by CLI and MCP.
//!
//! Catalog entries bind to checked OpenAPI operation IDs. Input schemas are
//! self-contained JSON Schema objects resolved from the OpenAPI document.
//! Operator-only recovery/security operations are included for CLI use and
//! filtered out of routine MCP tool lists by the MCP adapter (Wave 3).

pub mod openapi;
pub mod wrappers;

#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;

use junban_server::{AutomationScope, RouteAccess, classified_routes};
use serde::Serialize;
use serde_json::{Value, json};

use crate::error::CliError;

pub use openapi::OPENAPI_JSON;
pub use wrappers::{
    WRAPPER_OUTPUT_PATH, WRAPPER_WRITE_TOKEN, confirm_field_name, validate_wrapper_input,
};

/// Catalog format version consumed by `tools list` and later MCP `tools/list`.
pub const CATALOG_VERSION: u32 = 1;

/// Maximum JSON input bytes accepted by generic tool calls and ergonomic assemblers.
pub const MAX_TOOL_INPUT_BYTES: usize = 8 * 1024 * 1024;

/// Operations intentionally absent from the automation catalog.
const EXCLUDED_OPERATION_IDS: &[&str] = &[
    "health",
    "events",
    "reminder_events",
    // Internal principal discovery for CLI/MCP capability filtering — not an operator tool.
    "get_principal",
    // Reminder delivery control plane (operator process ownership, not user automation).
    "acquire_reminder_lease",
    "renew_reminder_lease",
    "release_reminder_lease",
    "claim_due_reminders",
    "settle_reminder_delivered",
    "settle_reminder_failed",
    "mark_owner_lost_reminders",
    // Phase 6 operator-only AI and voice APIs remain outside the frozen 87-tool catalog.
    "list_ai_providers",
    "get_ai_config",
    "put_ai_config",
    "delete_ai_config",
    "put_ai_credential",
    "delete_ai_credential",
    "discover_ai_provider_models",
    "list_ai_sessions",
    "create_ai_session",
    "get_ai_session",
    "patch_ai_session",
    "delete_ai_session",
    "list_ai_messages",
    "create_ai_response",
    "create_ai_daily_briefing",
    "edit_ai_response",
    "retry_ai_response",
    "regenerate_ai_response",
    "cancel_ai_run",
    "get_ai_approval",
    "approve_ai_approval",
    "reject_ai_approval",
    "clear_ai_session",
    "list_ai_memories",
    "create_ai_memory",
    "get_ai_memory",
    "patch_ai_memory",
    "delete_ai_memory",
    "create_voice_transcription",
    "create_voice_speech",
    // Raw automation secrets are accepted only by the reviewed `auth create
    // --write-token` ambiguity protocol, never by generic tool input.
    "create_automation_credential",
];

/// HTTP timeout class for a catalog entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TimeoutClass {
    /// Ordinary authenticated reads.
    ShortRead,
    /// Ordinary mutations and small POSTs.
    Mutation,
    /// Backup, restore, import, and export staging.
    StagedData,
}

impl TimeoutClass {
    #[must_use]
    pub const fn duration(self) -> std::time::Duration {
        match self {
            Self::ShortRead => std::time::Duration::from_secs(15),
            Self::Mutation => std::time::Duration::from_secs(30),
            Self::StagedData => std::time::Duration::from_secs(300),
        }
    }
}

/// Read versus mutation classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    Read,
    Mutation,
}

/// Required principal for the tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolAccess {
    Read,
    Write,
    Data,
    #[serde(rename = "operator")]
    OperatorOnly,
}

impl ToolAccess {
    #[must_use]
    pub fn from_route(access: RouteAccess) -> Option<Self> {
        match access {
            // Health stays excluded. Recovery status is public on the wire so the
            // recovery UI can poll, but the automation catalog treats it as operator.
            RouteAccess::Public => Some(Self::OperatorOnly),
            // Authenticated principal discovery is excluded from the catalog entirely.
            RouteAccess::Authenticated => None,
            RouteAccess::OperatorOnly => Some(Self::OperatorOnly),
            RouteAccess::Scope(AutomationScope::Read) => Some(Self::Read),
            RouteAccess::Scope(AutomationScope::Write) => Some(Self::Write),
            RouteAccess::Scope(AutomationScope::Data) => Some(Self::Data),
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Data => "data",
            Self::OperatorOnly => "operator",
        }
    }
}

/// MCP-oriented safety annotations (also useful for CLI confirmations).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SafetyAnnotations {
    pub read_only: bool,
    pub destructive: bool,
    pub idempotent: bool,
}

/// How the HTTP adapter interprets success bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponseMode {
    /// Decode JSON (or empty object for 204).
    Json,
    /// Stream binary/text body to an output path from the tool input.
    Download,
    /// No response body expected.
    Empty,
}

/// Wire body shape for the bound OpenAPI operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyMode {
    None,
    Json,
    /// Raw octet-stream upload from a local file path in the tool input.
    OctetStreamFile,
}

/// Tool-specific input wrapper kinds layered on OpenAPI inputs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WrapperKind {
    /// Requires `output_path` (export/backup downloads).
    DownloadPath,
    /// Requires `input_path` + confirmation (restore).
    RestoreUpload,
    /// Requires `write_token` + confirmation (operator token rotation).
    RotateToken,
    /// Requires confirmation value only (clear diagnostics, deletes via ergonomic path).
    ConfirmOnly,
    /// Requires confirmation only when the nested bulk action is delete.
    BulkTasks,
}

/// Typed execution mapping for one catalog entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionMapping {
    pub operation_id: &'static str,
    pub method: &'static str,
    pub path_template: &'static str,
    pub path_params: &'static [&'static str],
    pub query_params: &'static [&'static str],
    pub header_idempotency: bool,
    pub body_mode: BodyMode,
    pub response_mode: ResponseMode,
    pub wrapper: Option<WrapperKind>,
    /// Never automatically retry this mutation (restore).
    pub never_retry: bool,
}

/// One discoverable catalog tool.
#[derive(Debug, Clone, Serialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub output_schema: Value,
    pub access: ToolAccess,
    pub kind: ToolKind,
    pub timeout_class: TimeoutClass,
    pub safety: SafetyAnnotations,
    #[serde(skip)]
    pub execution: ExecutionMapping,
}

/// Complete versioned catalog.
#[derive(Debug, Clone, Serialize)]
pub struct ToolCatalog {
    pub version: u32,
    pub tools: Vec<ToolDefinition>,
}

impl ToolCatalog {
    /// Deterministic JSON document for `tools list --json` and MCP.
    pub fn to_json_value(&self) -> Value {
        serde_json::to_value(self).expect("catalog is always serializable")
    }

    /// Deterministic JSON bytes (compact, sorted object keys via BTree-backed build).
    pub fn to_json_bytes(&self) -> Vec<u8> {
        let mut bytes = serde_json::to_vec(&self.to_json_value()).expect("catalog json");
        bytes.push(b'\n');
        bytes
    }

    #[must_use]
    pub fn get(&self, name: &str) -> Option<&ToolDefinition> {
        self.tools.iter().find(|tool| tool.name == name)
    }

    #[must_use]
    pub fn names(&self) -> Vec<&str> {
        self.tools.iter().map(|tool| tool.name.as_str()).collect()
    }

    /// Filter by required access scope label (`read`, `write`, `data`, `operator`).
    #[must_use]
    pub fn filter_scope(&self, scope: Option<&str>) -> Vec<&ToolDefinition> {
        match scope {
            None => self.tools.iter().collect(),
            Some(scope) => self
                .tools
                .iter()
                .filter(|tool| tool.access.as_str() == scope)
                .collect(),
        }
    }
}

/// Process-wide catalog built once from the checked OpenAPI artifact.
pub fn catalog() -> &'static ToolCatalog {
    static CATALOG: LazyLock<ToolCatalog> = LazyLock::new(|| {
        build_catalog().unwrap_or_else(|error| {
            panic!("automation catalog failed to build: {error}");
        })
    });
    &CATALOG
}

/// Fallible builder used by tests and the lazy catalog initializer.
pub fn build_catalog() -> Result<ToolCatalog, String> {
    let doc = openapi::parse_openapi()?;
    let mut tools = Vec::new();
    let mut seen_names = BTreeSet::new();
    let mut seen_operation_ids = BTreeSet::new();
    let mut openapi_ops: BTreeMap<String, openapi::OpenApiOperation> = BTreeMap::new();

    for operation in openapi::iter_operations(&doc, EXCLUDED_OPERATION_IDS)? {
        if !seen_operation_ids.insert(operation.operation_id.clone()) {
            return Err(format!(
                "duplicate OpenAPI operationId '{}'",
                operation.operation_id
            ));
        }
        openapi_ops.insert(operation.operation_id.clone(), operation);
    }

    // Build route access index from the server classification table.
    let mut route_access: BTreeMap<(&'static str, &'static str), RouteAccess> = BTreeMap::new();
    for route in classified_routes() {
        route_access.insert((route.method, route.path), route.access);
    }

    for (operation_id, operation) in &openapi_ops {
        let access = route_access
            .get(&(operation.method.as_str(), operation.path.as_str()))
            .copied()
            .ok_or_else(|| {
                format!(
                    "OpenAPI operation '{operation_id}' {} {} lacks route classification",
                    operation.method, operation.path
                )
            })?;
        let tool_access = ToolAccess::from_route(access).ok_or_else(|| {
            format!("OpenAPI operation '{operation_id}' has no catalog access mapping")
        })?;

        let meta = inventory_meta(operation_id)
            .ok_or_else(|| format!("approved operation '{operation_id}' lacks catalog metadata"))?;

        let mut input_schema = openapi::build_input_schema(&doc, operation, meta.wrapper)?;
        wrappers::apply_wrapper_to_schema(&mut input_schema, meta.wrapper, meta.confirm_value)?;
        if !matches!(input_schema.get("type"), Some(Value::String(kind)) if kind == "object") {
            return Err(format!(
                "tool input schema for '{operation_id}' must be a JSON object schema"
            ));
        }

        let output_schema =
            openapi::build_output_schema(&doc, operation, meta.response_mode, meta.wrapper)?;

        if !seen_names.insert(operation_id.clone()) {
            return Err(format!("duplicate catalog tool name '{operation_id}'"));
        }

        let path_params = openapi::path_param_names(operation);
        let query_params = openapi::query_param_names(operation);
        // Leak static slices once per process for ExecutionMapping &'static fields.
        let path_params_static = leak_str_slice(path_params);
        let query_params_static = leak_str_slice(query_params);
        let operation_id_static: &'static str = Box::leak(operation_id.clone().into_boxed_str());
        let method_static: &'static str = Box::leak(operation.method.clone().into_boxed_str());
        let path_static: &'static str = Box::leak(operation.path.clone().into_boxed_str());

        tools.push(ToolDefinition {
            name: operation_id.clone(),
            description: meta.description.to_owned(),
            input_schema,
            output_schema,
            access: tool_access,
            kind: meta.kind,
            timeout_class: meta.timeout_class,
            safety: SafetyAnnotations {
                read_only: meta.kind == ToolKind::Read,
                destructive: meta.destructive,
                idempotent: meta.idempotent,
            },
            execution: ExecutionMapping {
                operation_id: operation_id_static,
                method: method_static,
                path_template: path_static,
                path_params: path_params_static,
                query_params: query_params_static,
                header_idempotency: operation.requires_idempotency,
                body_mode: meta.body_mode,
                response_mode: meta.response_mode,
                wrapper: meta.wrapper,
                never_retry: meta.never_retry,
            },
        });
    }

    tools.sort_by(|left, right| left.name.cmp(&right.name));

    // Every non-excluded OpenAPI operation must be classified and present.
    let catalog_ids: BTreeSet<&str> = tools.iter().map(|tool| tool.name.as_str()).collect();
    for operation_id in openapi_ops.keys() {
        if !catalog_ids.contains(operation_id.as_str()) {
            return Err(format!(
                "approved OpenAPI operation '{operation_id}' missing from catalog"
            ));
        }
    }

    // Fail if classification table references an unknown non-excluded operation path
    // that still appears in OpenAPI under a different id — covered by route match above.

    // Fail closed on excluded leakage.
    for excluded in EXCLUDED_OPERATION_IDS {
        if catalog_ids.contains(excluded) {
            return Err(format!(
                "excluded operation '{excluded}' must not appear in the catalog"
            ));
        }
    }

    Ok(ToolCatalog {
        version: CATALOG_VERSION,
        tools,
    })
}

fn leak_str_slice(values: Vec<String>) -> &'static [&'static str] {
    let leaked: Vec<&'static str> = values
        .into_iter()
        .map(|value| Box::leak(value.into_boxed_str()) as &'static str)
        .collect();
    Box::leak(leaked.into_boxed_slice())
}

struct InventoryMeta {
    description: &'static str,
    kind: ToolKind,
    timeout_class: TimeoutClass,
    destructive: bool,
    idempotent: bool,
    body_mode: BodyMode,
    response_mode: ResponseMode,
    wrapper: Option<WrapperKind>,
    never_retry: bool,
    confirm_value: Option<&'static str>,
}

/// Per-operation catalog metadata. Keys are OpenAPI operation IDs.
fn inventory_meta(operation_id: &str) -> Option<InventoryMeta> {
    use BodyMode::{Json as JsonBody, None as NoBody, OctetStreamFile};
    use ResponseMode::{Download, Empty, Json as JsonResp};
    use TimeoutClass::{Mutation, ShortRead, StagedData};
    use ToolKind::{Mutation as Mut, Read};
    use WrapperKind::{BulkTasks, ConfirmOnly, DownloadPath, RestoreUpload, RotateToken};

    let read = |description: &'static str| InventoryMeta {
        description,
        kind: Read,
        timeout_class: ShortRead,
        destructive: false,
        idempotent: true,
        body_mode: NoBody,
        response_mode: JsonResp,
        wrapper: None,
        never_retry: false,
        confirm_value: None,
    };
    let mutation = |description: &'static str, destructive: bool, idempotent: bool| InventoryMeta {
        description,
        kind: Mut,
        timeout_class: Mutation,
        destructive,
        idempotent,
        body_mode: JsonBody,
        response_mode: JsonResp,
        wrapper: None,
        never_retry: false,
        confirm_value: None,
    };
    let mutation_no_body =
        |description: &'static str, destructive: bool, idempotent: bool| InventoryMeta {
            description,
            kind: Mut,
            timeout_class: Mutation,
            destructive,
            idempotent,
            body_mode: NoBody,
            response_mode: JsonResp,
            wrapper: None,
            never_retry: false,
            confirm_value: None,
        };

    Some(match operation_id {
        // Tasks
        "list_tasks" => read("List tasks with optional view, filters, sort, and cursor"),
        "get_task" => read("Get one task by exact ID"),
        "create_task" => mutation("Create a task", false, false),
        "patch_task" => mutation("Patch a task by exact ID", false, false),
        "complete_task" => mutation_no_body("Mark a task complete", false, false),
        "uncomplete_task" => {
            mutation_no_body("Reverse a task completion when possible", false, false)
        }
        "cancel_task" => mutation_no_body("Cancel a task", false, false),
        "reopen_task" => mutation_no_body("Reopen a cancelled task", false, false),
        "delete_task" => InventoryMeta {
            description: "Delete a task by exact ID",
            kind: Mut,
            timeout_class: Mutation,
            destructive: true,
            idempotent: false,
            body_mode: NoBody,
            response_mode: JsonResp,
            wrapper: Some(ConfirmOnly),
            never_retry: false,
            confirm_value: Some("delete"),
        },
        "move_task" => mutation(
            "Move a task to another project, section, or parent",
            false,
            false,
        ),
        "reorder_tasks" => mutation("Reorder tasks within a scope", false, false),
        "bulk_tasks" => InventoryMeta {
            description: "Apply one bulk action to many tasks",
            kind: Mut,
            timeout_class: Mutation,
            destructive: true,
            idempotent: false,
            body_mode: JsonBody,
            response_mode: JsonResp,
            wrapper: Some(BulkTasks),
            never_retry: false,
            confirm_value: Some("delete"),
        },
        "undo_operation" => {
            mutation_no_body("Undo a prior mutation by source operation ID", false, false)
        }

        // Organization / catalog
        "get_catalog" => read("List projects, sections, tags, templates, and saved filters"),
        "create_project" => mutation("Create a project", false, false),
        "patch_project" => mutation("Patch a project by exact ID", false, false),
        "delete_project" => InventoryMeta {
            description: "Delete a project by exact ID",
            kind: Mut,
            timeout_class: Mutation,
            destructive: true,
            idempotent: false,
            body_mode: NoBody,
            response_mode: JsonResp,
            wrapper: Some(ConfirmOnly),
            confirm_value: Some("delete"),
            never_retry: false,
        },
        "create_section" => mutation("Create a section", false, false),
        "patch_section" => mutation("Patch a section by exact ID", false, false),
        "delete_section" => InventoryMeta {
            description: "Delete a section by exact ID",
            kind: Mut,
            timeout_class: Mutation,
            destructive: true,
            idempotent: false,
            body_mode: NoBody,
            response_mode: JsonResp,
            wrapper: Some(ConfirmOnly),
            confirm_value: Some("delete"),
            never_retry: false,
        },
        "create_tag" => mutation("Create a tag", false, false),
        "patch_tag" => mutation("Patch a tag by exact ID", false, false),
        "delete_tag" => InventoryMeta {
            description: "Delete a tag by exact ID",
            kind: Mut,
            timeout_class: Mutation,
            destructive: true,
            idempotent: false,
            body_mode: NoBody,
            response_mode: JsonResp,
            wrapper: Some(ConfirmOnly),
            confirm_value: Some("delete"),
            never_retry: false,
        },
        "create_template" => mutation("Create a task template", false, false),
        "patch_template" => mutation("Patch a template by exact ID", false, false),
        "delete_template" => InventoryMeta {
            description: "Delete a template by exact ID",
            kind: Mut,
            timeout_class: Mutation,
            destructive: true,
            idempotent: false,
            body_mode: NoBody,
            response_mode: JsonResp,
            wrapper: Some(ConfirmOnly),
            confirm_value: Some("delete"),
            never_retry: false,
        },
        "apply_template" => mutation("Apply a template to create tasks", false, false),
        "create_saved_filter" => mutation("Create a saved filter", false, false),
        "patch_saved_filter" => mutation("Patch a saved filter by exact ID", false, false),
        "delete_saved_filter" => InventoryMeta {
            description: "Delete a saved filter by exact ID",
            kind: Mut,
            timeout_class: Mutation,
            destructive: true,
            idempotent: false,
            body_mode: NoBody,
            response_mode: JsonResp,
            wrapper: Some(ConfirmOnly),
            confirm_value: Some("delete"),
            never_retry: false,
        },
        "list_comments" => read("List comments on a task"),
        "create_comment" => mutation("Create a comment on a task", false, false),
        "patch_comment" => mutation("Patch a comment by exact ID", false, false),
        "delete_comment" => InventoryMeta {
            description: "Delete a comment by exact ID",
            kind: Mut,
            timeout_class: Mutation,
            destructive: true,
            idempotent: false,
            body_mode: NoBody,
            response_mode: JsonResp,
            wrapper: Some(ConfirmOnly),
            confirm_value: Some("delete"),
            never_retry: false,
        },
        "list_relations" => read("List directed relations for a task"),
        "add_relation" => mutation("Add a blocks relation between tasks", false, false),
        "remove_relation" => {
            mutation_no_body("Remove a blocks relation between tasks", false, false)
        }
        "list_task_activity" => read("List activity for a task"),

        // Capture / parsing
        "parse_quick_entry" => InventoryMeta {
            body_mode: JsonBody,
            ..read("Parse natural-language quick entry text")
        },
        "parse_filter" => InventoryMeta {
            body_mode: JsonBody,
            ..read("Parse a filter expression")
        },
        "parse_text_import" => InventoryMeta {
            body_mode: JsonBody,
            ..read("Parse freeform text import drafts")
        },

        // Reminders (user-facing only)
        "list_task_reminders" => read("List reminders for a task"),
        "reschedule_reminder" => mutation(
            "Reschedule (snooze) the active reminder on a task",
            false,
            false,
        ),
        "dismiss_reminder" => {
            mutation_no_body("Dismiss the active reminder on a task", false, false)
        }

        // Planning / motivation
        "planning_daily" => read("Build the daily plan for a civil date"),
        "planning_end_of_day" => read("Build the end-of-day review for a civil date"),
        "planning_weekly" => read("Build the weekly review for a civil date"),
        "calendar_tasks" => read("List calendar tasks in an inclusive civil date range"),
        "stats" => read("Compute completion stats for an inclusive civil date range"),
        "nudges" => read("Compute planning nudges for a civil date"),
        "motivation_eat_the_frog" => read("Pick the Eat-the-Frog task for a civil date"),
        "motivation_task_jar" => read("Sample Task Jar candidates for a civil date"),
        "motivation_dopamine_menu" => read("List Dopamine Menu tasks for a civil date"),

        // Timeblocking
        "list_time_blocks" => read("List time blocks in a civil date range"),
        "create_time_block" => mutation("Create a time block", false, false),
        "patch_time_block" => mutation("Patch a time block by exact ID", false, false),
        "delete_time_block" => InventoryMeta {
            description: "Delete a time block by exact ID",
            kind: Mut,
            timeout_class: Mutation,
            destructive: true,
            idempotent: false,
            body_mode: NoBody,
            response_mode: JsonResp,
            wrapper: Some(ConfirmOnly),
            confirm_value: Some("delete"),
            never_retry: false,
        },
        "move_time_block" => mutation("Move a time block", false, false),
        "resize_time_block" => mutation("Resize a time block", false, false),
        "preview_replan_time_blocks" => read("Preview a time-block replan"),
        "replan_time_blocks" => mutation("Apply a time-block replan", false, false),
        "list_time_slots" => read("List time slots in a civil date range"),
        "create_time_slot" => mutation("Create a time slot", false, false),
        "patch_time_slot" => mutation("Patch a time slot by exact ID", false, false),
        "delete_time_slot" => InventoryMeta {
            description: "Delete a time slot by exact ID",
            kind: Mut,
            timeout_class: Mutation,
            destructive: true,
            idempotent: false,
            body_mode: NoBody,
            response_mode: JsonResp,
            wrapper: Some(ConfirmOnly),
            confirm_value: Some("delete"),
            never_retry: false,
        },
        "append_time_slot_task" => mutation("Append a task to a time slot", false, false),
        "replace_time_slot_tasks" => mutation("Replace time-slot task membership", false, false),
        "remove_time_slot_task" => mutation_no_body("Remove a task from a time slot", false, false),

        // Settings / sync / profile
        "get_settings" => read("Get typed application settings"),
        "patch_settings" => mutation("Patch typed application settings", false, false),
        "get_temporal_settings" => read("Get temporal settings used by planning clocks"),
        "get_sync_state" => read("Get sync revision state"),
        "get_profile" => read("Get profile summary metadata"),

        // Data plane
        "preview_import" => InventoryMeta {
            description: "Preview a JSON, CSV, or Markdown import without writing",
            kind: Read,
            timeout_class: StagedData,
            destructive: false,
            idempotent: true,
            body_mode: JsonBody,
            response_mode: JsonResp,
            wrapper: None,
            never_retry: false,
            confirm_value: None,
        },
        "apply_import" => InventoryMeta {
            description: "Apply a previously previewed import by fingerprint",
            kind: Mut,
            timeout_class: StagedData,
            destructive: false,
            idempotent: false,
            body_mode: JsonBody,
            response_mode: JsonResp,
            wrapper: None,
            never_retry: false,
            confirm_value: None,
        },
        "export_tasks" => InventoryMeta {
            description: "Export tasks as JSON, CSV, or Markdown to a local file",
            kind: Mut,
            timeout_class: StagedData,
            destructive: true,
            idempotent: false,
            body_mode: NoBody,
            response_mode: Download,
            wrapper: Some(DownloadPath),
            never_retry: false,
            confirm_value: None,
        },
        "create_backup" => InventoryMeta {
            description: "Create a complete .junban-backup artifact at a local path",
            kind: Mut,
            timeout_class: StagedData,
            destructive: true,
            idempotent: false,
            body_mode: NoBody,
            response_mode: Download,
            wrapper: Some(DownloadPath),
            never_retry: false,
            confirm_value: None,
        },
        "restore_backup" => InventoryMeta {
            description: "Restore a complete backup (operator only; requires restart)",
            kind: Mut,
            timeout_class: StagedData,
            destructive: true,
            idempotent: false,
            body_mode: OctetStreamFile,
            response_mode: JsonResp,
            wrapper: Some(RestoreUpload),
            never_retry: true,
            confirm_value: Some("restore"),
        },

        // Operator / hosted
        "list_automation_credentials" => {
            read("List automation credential metadata (operator only)")
        }
        "create_automation_credential" => mutation(
            "Create an automation credential from a client-generated secret (operator only)",
            false,
            false,
        ),
        "revoke_automation_credential" => InventoryMeta {
            description: "Revoke an automation credential by ID (operator only)",
            kind: Mut,
            timeout_class: Mutation,
            destructive: true,
            idempotent: true,
            body_mode: NoBody,
            response_mode: Empty,
            wrapper: Some(ConfirmOnly),
            never_retry: false,
            confirm_value: Some("revoke"),
        },
        "rotate_token" => InventoryMeta {
            description: "Rotate the operator access token (operator only)",
            kind: Mut,
            timeout_class: Mutation,
            destructive: true,
            idempotent: false,
            body_mode: NoBody,
            response_mode: JsonResp,
            wrapper: Some(RotateToken),
            never_retry: false,
            confirm_value: Some("rotate-token"),
        },
        "get_allowed_hosts" => read("Get the persisted Host allowlist (operator only)"),
        "put_allowed_hosts" => mutation(
            "Replace the persisted Host allowlist (operator only)",
            false,
            true,
        ),
        "get_diagnostics" => read("Read the diagnostic ring buffer (operator only)"),
        "clear_diagnostics" => InventoryMeta {
            description: "Clear the diagnostic ring buffer (operator only)",
            kind: Mut,
            timeout_class: Mutation,
            destructive: true,
            idempotent: true,
            body_mode: NoBody,
            response_mode: Empty,
            wrapper: Some(ConfirmOnly),
            never_retry: false,
            confirm_value: Some("clear"),
        },
        "get_maintenance_status" => {
            read("Get maintenance and restart-required status (operator only)")
        }
        "get_recovery_status" => read("Get recovery-mode status"),

        _ => return None,
    })
}

/// Parse tool input JSON from a CLI `--input` value (`@file` or inline JSON).
pub fn parse_input_arg(raw: &str) -> Result<Value, CliError> {
    let bytes = if let Some(path) = raw.strip_prefix('@') {
        if path.is_empty() {
            return Err(CliError::usage(
                "invalid_input",
                "@file input path must not be empty",
            ));
        }
        let path = std::path::Path::new(path);
        let meta = std::fs::metadata(path).map_err(|error| {
            CliError::usage(
                "input_file_unreadable",
                format!("could not read input file {}: {error}", path.display()),
            )
        })?;
        if meta.len() as usize > MAX_TOOL_INPUT_BYTES {
            return Err(CliError::usage(
                "input_too_large",
                format!("input file exceeds {MAX_TOOL_INPUT_BYTES} bytes"),
            ));
        }
        std::fs::read(path).map_err(|error| {
            CliError::usage(
                "input_file_unreadable",
                format!("could not read input file {}: {error}", path.display()),
            )
        })?
    } else {
        if raw.len() > MAX_TOOL_INPUT_BYTES {
            return Err(CliError::usage(
                "input_too_large",
                format!("input JSON exceeds {MAX_TOOL_INPUT_BYTES} bytes"),
            ));
        }
        raw.as_bytes().to_vec()
    };
    let value: Value = serde_json::from_slice(&bytes).map_err(|error| {
        CliError::usage(
            "invalid_input_json",
            format!("input is not valid JSON: {error}"),
        )
    })?;
    if !value.is_object() {
        return Err(CliError::usage(
            "invalid_input_json",
            "tool input must be a JSON object",
        ));
    }
    Ok(value)
}

/// Human-readable one-line summary for tools list.
pub fn human_tool_line(tool: &ToolDefinition) -> String {
    format!(
        "{:<36} {:<8} {} {}",
        tool.name,
        tool.access.as_str(),
        if tool.safety.destructive {
            "destructive"
        } else if tool.safety.read_only {
            "read"
        } else {
            "mutation"
        },
        tool.description
    )
}

/// Stable empty JSON object used when a 204 succeeds.
#[must_use]
pub fn empty_success_value() -> Value {
    json!({})
}
