//! Centralized request principal and route authorization.
//!
//! Every authenticated HTTP method/path is classified here before body extraction
//! or maintenance admission. Unknown routes default to operator-only.

use axum::http::Method;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Issuable automation scopes. None implies another.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, ToSchema,
)]
#[serde(rename_all = "snake_case")]
#[schema(rename_all = "snake_case")]
pub enum AutomationScope {
    /// Ordinary task, catalog, reminder, planning, timeblock, settings, and sync reads.
    Read,
    /// Ordinary mutations and import operations.
    Write,
    /// Task export and complete backup creation.
    Data,
}

impl AutomationScope {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Data => "data",
        }
    }
}

impl std::fmt::Display for AutomationScope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for AutomationScope {
    type Err = &'static str;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "read" => Ok(Self::Read),
            "write" => Ok(Self::Write),
            "data" => Ok(Self::Data),
            _ => Err("scope must be read, write, or data"),
        }
    }
}

/// Immutable request principal resolved after Host/origin checks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Principal {
    Operator,
    Automation {
        id: String,
        scopes: std::collections::BTreeSet<AutomationScope>,
    },
}

impl Principal {
    #[must_use]
    pub fn is_operator(&self) -> bool {
        matches!(self, Self::Operator)
    }

    #[must_use]
    pub fn has_scope(&self, scope: AutomationScope) -> bool {
        match self {
            Self::Operator => true,
            Self::Automation { scopes, .. } => scopes.contains(&scope),
        }
    }
}

/// Route authorization class.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteAccess {
    /// Unauthenticated (health, recovery status reads that are intentionally open).
    Public,
    /// Any valid operator or automation bearer, regardless of issued scopes.
    Authenticated,
    /// Operator bearer only.
    OperatorOnly,
    /// Automation may proceed with the named scope; operator always may.
    Scope(AutomationScope),
}

/// One classified OpenAPI method/path used for drift tests and runtime matching.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClassifiedRoute {
    pub method: &'static str,
    pub path: &'static str,
    pub access: RouteAccess,
}

/// Exhaustive classification of every current OpenAPI operation plus control-plane
/// exclusions that are intentionally absent from the public contract.
///
/// Paths use OpenAPI template form (`{param}`). Runtime matching is segment-aware.
pub fn classified_routes() -> &'static [ClassifiedRoute] {
    &[
        // Public (unauthenticated)
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/health",
            access: RouteAccess::Public,
        },
        // Intentionally unauthenticated so the recovery UI can poll without a token.
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/recovery/status",
            access: RouteAccess::Public,
        },
        // Any authenticated principal may discover its own kind and scope names.
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/auth/principal",
            access: RouteAccess::Authenticated,
        },
        // Operator-only hosted security / recovery / control plane
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/auth/rotate",
            access: RouteAccess::OperatorOnly,
        },
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/auth/credentials",
            access: RouteAccess::OperatorOnly,
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/auth/credentials",
            access: RouteAccess::OperatorOnly,
        },
        ClassifiedRoute {
            method: "DELETE",
            path: "/api/v1/auth/credentials/{credential_id}",
            access: RouteAccess::OperatorOnly,
        },
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/hosts",
            access: RouteAccess::OperatorOnly,
        },
        ClassifiedRoute {
            method: "PUT",
            path: "/api/v1/hosts",
            access: RouteAccess::OperatorOnly,
        },
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/diagnostics",
            access: RouteAccess::OperatorOnly,
        },
        ClassifiedRoute {
            method: "DELETE",
            path: "/api/v1/diagnostics",
            access: RouteAccess::OperatorOnly,
        },
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/maintenance/status",
            access: RouteAccess::OperatorOnly,
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/backup/restore",
            access: RouteAccess::OperatorOnly,
        },
        // Reminder delivery control plane — operator only
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/reminders/lease",
            access: RouteAccess::OperatorOnly,
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/reminders/lease/renew",
            access: RouteAccess::OperatorOnly,
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/reminders/lease/release",
            access: RouteAccess::OperatorOnly,
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/reminders/claim",
            access: RouteAccess::OperatorOnly,
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/reminders/settle/delivered",
            access: RouteAccess::OperatorOnly,
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/reminders/settle/failed",
            access: RouteAccess::OperatorOnly,
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/reminders/owner-lost",
            access: RouteAccess::OperatorOnly,
        },
        // Data scope
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/backup",
            access: RouteAccess::Scope(AutomationScope::Data),
        },
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/exports/tasks",
            access: RouteAccess::Scope(AutomationScope::Data),
        },
        // Read scope
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/profile",
            access: RouteAccess::Scope(AutomationScope::Read),
        },
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/sync-state",
            access: RouteAccess::Scope(AutomationScope::Read),
        },
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/tasks",
            access: RouteAccess::Scope(AutomationScope::Read),
        },
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/tasks/{task_id}",
            access: RouteAccess::Scope(AutomationScope::Read),
        },
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/tasks/{task_id}/comments",
            access: RouteAccess::Scope(AutomationScope::Read),
        },
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/tasks/{task_id}/relations",
            access: RouteAccess::Scope(AutomationScope::Read),
        },
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/tasks/{task_id}/activity",
            access: RouteAccess::Scope(AutomationScope::Read),
        },
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/tasks/{task_id}/reminders",
            access: RouteAccess::Scope(AutomationScope::Read),
        },
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/reminders/events",
            access: RouteAccess::Scope(AutomationScope::Read),
        },
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/catalog",
            access: RouteAccess::Scope(AutomationScope::Read),
        },
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/time-blocks",
            access: RouteAccess::Scope(AutomationScope::Read),
        },
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/time-blocks/replan/preview",
            access: RouteAccess::Scope(AutomationScope::Read),
        },
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/time-slots",
            access: RouteAccess::Scope(AutomationScope::Read),
        },
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/calendar/tasks",
            access: RouteAccess::Scope(AutomationScope::Read),
        },
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/planning/daily",
            access: RouteAccess::Scope(AutomationScope::Read),
        },
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/planning/end-of-day",
            access: RouteAccess::Scope(AutomationScope::Read),
        },
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/planning/weekly",
            access: RouteAccess::Scope(AutomationScope::Read),
        },
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/stats",
            access: RouteAccess::Scope(AutomationScope::Read),
        },
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/nudges",
            access: RouteAccess::Scope(AutomationScope::Read),
        },
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/settings",
            access: RouteAccess::Scope(AutomationScope::Read),
        },
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/settings/temporal",
            access: RouteAccess::Scope(AutomationScope::Read),
        },
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/motivation/eat-the-frog",
            access: RouteAccess::Scope(AutomationScope::Read),
        },
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/motivation/task-jar",
            access: RouteAccess::Scope(AutomationScope::Read),
        },
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/motivation/dopamine-menu",
            access: RouteAccess::Scope(AutomationScope::Read),
        },
        ClassifiedRoute {
            method: "GET",
            path: "/api/v1/events",
            access: RouteAccess::Scope(AutomationScope::Read),
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/parse/quick-entry",
            access: RouteAccess::Scope(AutomationScope::Read),
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/parse/filter",
            access: RouteAccess::Scope(AutomationScope::Read),
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/parse/text-import",
            access: RouteAccess::Scope(AutomationScope::Read),
        },
        // Write scope
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/tasks",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/tasks/actions",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/tasks/reorder",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "PATCH",
            path: "/api/v1/tasks/{task_id}",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "DELETE",
            path: "/api/v1/tasks/{task_id}",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/tasks/{task_id}/complete",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/tasks/{task_id}/uncomplete",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/tasks/{task_id}/cancel",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/tasks/{task_id}/reopen",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/tasks/{task_id}/move",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/tasks/{task_id}/comments",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/tasks/{task_id}/relations",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "DELETE",
            path: "/api/v1/tasks/{task_id}/relations/{to_task_id}",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/tasks/{task_id}/reminders/reschedule",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/tasks/{task_id}/reminders/dismiss",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/projects",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "PATCH",
            path: "/api/v1/projects/{project_id}",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "DELETE",
            path: "/api/v1/projects/{project_id}",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/sections",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "PATCH",
            path: "/api/v1/sections/{section_id}",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "DELETE",
            path: "/api/v1/sections/{section_id}",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/tags",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "PATCH",
            path: "/api/v1/tags/{tag_id}",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "DELETE",
            path: "/api/v1/tags/{tag_id}",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/templates",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/templates/apply",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "PATCH",
            path: "/api/v1/templates/{template_id}",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "DELETE",
            path: "/api/v1/templates/{template_id}",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/saved_filters",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "PATCH",
            path: "/api/v1/saved_filters/{filter_id}",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "DELETE",
            path: "/api/v1/saved_filters/{filter_id}",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "PATCH",
            path: "/api/v1/comments/{comment_id}",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "DELETE",
            path: "/api/v1/comments/{comment_id}",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/operations/{source_operation_id}/undo",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/time-blocks",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/time-blocks/replan",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "PATCH",
            path: "/api/v1/time-blocks/{time_block_id}",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "DELETE",
            path: "/api/v1/time-blocks/{time_block_id}",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/time-blocks/{time_block_id}/move",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/time-blocks/{time_block_id}/resize",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/time-slots",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "PATCH",
            path: "/api/v1/time-slots/{time_slot_id}",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "DELETE",
            path: "/api/v1/time-slots/{time_slot_id}",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/time-slots/{time_slot_id}/tasks",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "PUT",
            path: "/api/v1/time-slots/{time_slot_id}/tasks",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "DELETE",
            path: "/api/v1/time-slots/{time_slot_id}/tasks/{task_id}",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "PATCH",
            path: "/api/v1/settings",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/imports/preview",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
        ClassifiedRoute {
            method: "POST",
            path: "/api/v1/imports/apply",
            access: RouteAccess::Scope(AutomationScope::Write),
        },
    ]
}

/// Classify a live request method and path. Unknown authenticated API routes are operator-only.
#[must_use]
pub fn classify_request(method: &Method, path: &str) -> RouteAccess {
    // Strip query string if present (axum path() usually excludes it).
    let path = path.split('?').next().unwrap_or(path);
    if !path.starts_with("/api/") {
        // Static assets and non-API routes need no principal.
        return RouteAccess::Public;
    }
    // Paths with any public method stay public for every method so Axum can return 405
    // for wrong verbs without demanding a bearer first.
    if classified_routes()
        .iter()
        .any(|route| matches!(route.access, RouteAccess::Public) && path_matches(route.path, path))
    {
        return RouteAccess::Public;
    }
    for route in classified_routes() {
        if route.method == method.as_str() && path_matches(route.path, path) {
            return route.access;
        }
    }
    // Unknown / new API routes default fail-closed to operator-only.
    RouteAccess::OperatorOnly
}

/// Authorize a principal against a route class.
#[must_use]
pub fn authorize(principal: &Principal, access: RouteAccess) -> AuthorizationDecision {
    match access {
        RouteAccess::Public => AuthorizationDecision::Allow,
        // Caller already resolved a valid principal; scopes are intentionally ignored.
        RouteAccess::Authenticated => AuthorizationDecision::Allow,
        RouteAccess::OperatorOnly => {
            if principal.is_operator() {
                AuthorizationDecision::Allow
            } else {
                AuthorizationDecision::DenyOperatorOnly
            }
        }
        RouteAccess::Scope(scope) => {
            if principal.has_scope(scope) {
                AuthorizationDecision::Allow
            } else {
                AuthorizationDecision::DenyScope(scope)
            }
        }
    }
}

/// Result of route authorization (no secrets).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthorizationDecision {
    Allow,
    DenyOperatorOnly,
    DenyScope(AutomationScope),
}

fn path_matches(template: &str, path: &str) -> bool {
    let mut template_parts = template.split('/').filter(|part| !part.is_empty());
    let mut path_parts = path.split('/').filter(|part| !part.is_empty());
    loop {
        match (template_parts.next(), path_parts.next()) {
            (None, None) => return true,
            (Some(template_part), Some(path_part)) => {
                let is_param = template_part.starts_with('{') && template_part.ends_with('}');
                if !is_param && template_part != path_part {
                    return false;
                }
            }
            _ => return false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Method;
    use std::collections::BTreeSet;

    #[test]
    fn unknown_api_route_is_operator_only() {
        assert_eq!(
            classify_request(&Method::GET, "/api/v1/future-surface"),
            RouteAccess::OperatorOnly
        );
    }

    #[test]
    fn scopes_do_not_imply_each_other() {
        let read_only = Principal::Automation {
            id: "x".into(),
            scopes: BTreeSet::from([AutomationScope::Read]),
        };
        assert!(matches!(
            authorize(&read_only, RouteAccess::Scope(AutomationScope::Write)),
            AuthorizationDecision::DenyScope(AutomationScope::Write)
        ));
        assert!(matches!(
            authorize(&read_only, RouteAccess::Scope(AutomationScope::Data)),
            AuthorizationDecision::DenyScope(AutomationScope::Data)
        ));
        assert!(matches!(
            authorize(&read_only, RouteAccess::OperatorOnly),
            AuthorizationDecision::DenyOperatorOnly
        ));
        assert!(matches!(
            authorize(&read_only, RouteAccess::Scope(AutomationScope::Read)),
            AuthorizationDecision::Allow
        ));
        assert!(matches!(
            authorize(&read_only, RouteAccess::Authenticated),
            AuthorizationDecision::Allow
        ));
        let write_only = Principal::Automation {
            id: "y".into(),
            scopes: BTreeSet::from([AutomationScope::Write]),
        };
        assert!(matches!(
            authorize(&write_only, RouteAccess::Authenticated),
            AuthorizationDecision::Allow
        ));
        assert!(matches!(
            authorize(&write_only, RouteAccess::Scope(AutomationScope::Read)),
            AuthorizationDecision::DenyScope(AutomationScope::Read)
        ));
    }

    #[test]
    fn path_templates_match_segments() {
        assert!(path_matches(
            "/api/v1/tasks/{task_id}/comments",
            "/api/v1/tasks/0190/comments"
        ));
        assert!(!path_matches(
            "/api/v1/tasks/{task_id}",
            "/api/v1/tasks/0190/comments"
        ));
    }

    #[test]
    fn classified_routes_have_unique_method_path_pairs() {
        let mut seen = BTreeSet::new();
        for route in classified_routes() {
            assert!(
                seen.insert((route.method, route.path)),
                "duplicate classification for {} {}",
                route.method,
                route.path
            );
        }
    }
}
