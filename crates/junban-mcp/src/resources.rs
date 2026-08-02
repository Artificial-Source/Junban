//! Bounded read-only MCP resources over shared Session/catalog reads.

use junban_cli::{CliError, Session};
use serde_json::{Value, json};
use uuid::Uuid;

/// Maximum serialized resource JSON bytes returned to MCP hosts.
pub const MAX_RESOURCE_BYTES: usize = 2 * 1024 * 1024;

/// Static resource URIs listed when the principal has read scope.
pub const STATIC_RESOURCES: &[(&str, &str)] = &[
    ("junban://profile", "Profile revision summary"),
    ("junban://sync", "Sync epoch and revision snapshot"),
    ("junban://today", "Today task list"),
    ("junban://projects", "Projects list"),
    ("junban://tags", "Tags list"),
    ("junban://settings", "Typed application settings"),
];

/// Resource templates listed when the principal has read scope.
pub const RESOURCE_TEMPLATES: &[(&str, &str, &str)] = &[
    ("junban://tasks/{task_id}", "task", "Exact-ID task snapshot"),
    (
        "junban://projects/{project_id}",
        "project",
        "Exact-ID project with its sections",
    ),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResourceTarget {
    Profile,
    Sync,
    Today,
    Projects,
    Tags,
    Settings,
    Task { task_id: String },
    Project { project_id: String },
}

/// Strict URI parse: scheme `junban`, no query/fragment/userinfo, exact path forms.
pub fn parse_resource_uri(uri: &str) -> Result<ResourceTarget, ResourceUriError> {
    if uri.contains('?') || uri.contains('#') {
        return Err(ResourceUriError::Invalid);
    }
    let Some(rest) = uri.strip_prefix("junban://") else {
        return Err(ResourceUriError::Invalid);
    };
    if rest.is_empty() || rest.starts_with('/') {
        return Err(ResourceUriError::Invalid);
    }
    // Reject authority-style leftovers (userinfo/host confusion).
    if rest.contains('@') {
        return Err(ResourceUriError::Invalid);
    }
    match rest {
        "profile" => Ok(ResourceTarget::Profile),
        "sync" => Ok(ResourceTarget::Sync),
        "today" => Ok(ResourceTarget::Today),
        "projects" => Ok(ResourceTarget::Projects),
        "tags" => Ok(ResourceTarget::Tags),
        "settings" => Ok(ResourceTarget::Settings),
        other => {
            if let Some(task_id) = other.strip_prefix("tasks/") {
                if task_id.contains('/') || task_id.is_empty() {
                    return Err(ResourceUriError::Invalid);
                }
                validate_uuid(task_id)?;
                return Ok(ResourceTarget::Task {
                    task_id: task_id.to_owned(),
                });
            }
            if let Some(project_id) = other.strip_prefix("projects/") {
                if project_id.contains('/') || project_id.is_empty() {
                    return Err(ResourceUriError::Invalid);
                }
                validate_uuid(project_id)?;
                return Ok(ResourceTarget::Project {
                    project_id: project_id.to_owned(),
                });
            }
            Err(ResourceUriError::Invalid)
        }
    }
}

fn validate_uuid(raw: &str) -> Result<(), ResourceUriError> {
    Uuid::parse_str(raw)
        .map(|_| ())
        .map_err(|_| ResourceUriError::Invalid)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceUriError {
    Invalid,
}

pub async fn read_resource(
    session: &mut Session,
    target: ResourceTarget,
) -> Result<Value, CliError> {
    match target {
        ResourceTarget::Profile => session
            .call_tool("get_profile", json!({}))
            .await
            .map(|r| r.value),
        ResourceTarget::Sync => session
            .call_tool("get_sync_state", json!({}))
            .await
            .map(|r| r.value),
        ResourceTarget::Today => session
            .call_tool("list_tasks", json!({ "view": "today" }))
            .await
            .map(|r| r.value),
        ResourceTarget::Projects => {
            let catalog_value = session.call_tool("get_catalog", json!({})).await?.value;
            Ok(json!({
                "projects": catalog_value.get("projects").cloned().unwrap_or_else(|| json!([])),
                "revision": catalog_value.get("revision").cloned().unwrap_or(json!(0)),
            }))
        }
        ResourceTarget::Tags => {
            let catalog_value = session.call_tool("get_catalog", json!({})).await?.value;
            Ok(json!({
                "tags": catalog_value.get("tags").cloned().unwrap_or_else(|| json!([])),
                "revision": catalog_value.get("revision").cloned().unwrap_or(json!(0)),
            }))
        }
        ResourceTarget::Settings => session
            .call_tool("get_settings", json!({}))
            .await
            .map(|r| r.value),
        ResourceTarget::Task { task_id } => session
            .call_tool("get_task", json!({ "task_id": task_id }))
            .await
            .map(|r| r.value),
        ResourceTarget::Project { project_id } => {
            let catalog_value = session.call_tool("get_catalog", json!({})).await?.value;
            let projects = catalog_value
                .get("projects")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let project = projects
                .into_iter()
                .find(|entry| entry.get("id").and_then(Value::as_str) == Some(project_id.as_str()))
                .ok_or_else(|| {
                    CliError::runtime("not_found", format!("project '{project_id}' not found"))
                })?;
            let sections = catalog_value
                .get("sections")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|section| {
                    section.get("project_id").and_then(Value::as_str) == Some(project_id.as_str())
                })
                .cloned()
                .collect::<Vec<_>>();
            Ok(json!({
                "project": project,
                "sections": sections,
            }))
        }
    }
}

pub fn encode_resource_bytes(value: &Value) -> Result<String, CliError> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| CliError::runtime("resource_encode_failed", error.to_string()))?;
    if bytes.len() > MAX_RESOURCE_BYTES {
        return Err(CliError::runtime(
            "resource_too_large",
            format!(
                "resource content exceeds {MAX_RESOURCE_BYTES} bytes (got {})",
                bytes.len()
            ),
        ));
    }
    String::from_utf8(bytes)
        .map_err(|error| CliError::runtime("resource_encode_failed", error.to_string()))
}

/// Ensure resource tools remain in the shared catalog.
#[cfg(test)]
mod tests {
    use super::*;
    use junban_cli::catalog;

    #[test]
    fn parses_static_and_template_uris() {
        assert_eq!(
            parse_resource_uri("junban://profile").unwrap(),
            ResourceTarget::Profile
        );
        assert_eq!(
            parse_resource_uri("junban://today").unwrap(),
            ResourceTarget::Today
        );
        let id = "01900000-0000-7000-8000-000000000001";
        assert_eq!(
            parse_resource_uri(&format!("junban://tasks/{id}")).unwrap(),
            ResourceTarget::Task {
                task_id: id.to_owned()
            }
        );
        assert_eq!(
            parse_resource_uri(&format!("junban://projects/{id}")).unwrap(),
            ResourceTarget::Project {
                project_id: id.to_owned()
            }
        );
    }

    #[test]
    fn rejects_queries_fragments_and_trailing_segments() {
        assert!(parse_resource_uri("junban://profile?x=1").is_err());
        assert!(parse_resource_uri("junban://profile#frag").is_err());
        assert!(parse_resource_uri("junban://tasks/not-a-uuid").is_err());
        assert!(
            parse_resource_uri("junban://tasks/01900000-0000-7000-8000-000000000001/extra")
                .is_err()
        );
        assert!(parse_resource_uri("junban://projects/").is_err());
        assert!(parse_resource_uri("http://example").is_err());
    }

    #[test]
    fn resource_backing_tools_exist() {
        for name in [
            "get_profile",
            "get_sync_state",
            "list_tasks",
            "get_catalog",
            "get_settings",
            "get_task",
        ] {
            assert!(catalog().get(name).is_some(), "missing catalog tool {name}");
        }
    }
}
