//! Ordinary plugin task and catalog query authority.
//!
//! These contracts are deliberately separate from the browser/API task query and
//! from plugin resync. A continuation is opaque to the application layer; SQLite
//! owns its authenticated snapshot and keyset semantics.

use std::{future::Future, pin::Pin};

use jiff::civil::Date;
use junban_domain::{ProjectId, SectionId, TagId, TaskId};
use junban_plugin_sdk::{
    CallbackFence, HostCallReply, HostCallRequest,
    private_body_types::{
        CatalogQuery, ProjectPage, ProjectViewRecord, TagPage, TagView, TaskPage, TaskQuery,
        TaskStatus, TaskView, WitResult,
    },
};
use thiserror::Error;

use crate::plugin_event;

pub const PLUGIN_QUERY_LIMIT_MAX: u16 = 100;
pub const PLUGIN_QUERY_CURSOR_BYTES_MAX: usize = 512;
pub const PLUGIN_QUERY_REPLY_BYTES_MAX: usize = 256 * 1024;
const PLUGIN_TASK_TAG_IDS_MAX: usize = 16;
const PLUGIN_TASK_STATUSES_MAX: usize = 3;
const PLUGIN_TASK_PRIORITIES_MAX: usize = 4;
const PLUGIN_TASK_SEARCH_CHARS_MAX: usize = 10_000;

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum PluginQueryError {
    #[error("ordinary plugin query input is invalid")]
    InvalidInput,
    #[error("ordinary plugin query cursor is stale")]
    CursorStale,
    #[error("ordinary plugin query is unavailable")]
    Unavailable,
    #[error("ordinary plugin query result is too large")]
    OperationTooLarge,
}

/// Validated and normalized ordinary-plugin task query sent to storage.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginTaskQuery {
    request: TaskQuery,
    cursor: Option<String>,
}

impl PluginTaskQuery {
    pub fn normalize(mut request: TaskQuery) -> Result<Self, PluginQueryError> {
        if request.limit == 0 || request.limit > PLUGIN_QUERY_LIMIT_MAX {
            return Err(PluginQueryError::InvalidInput);
        }
        if request.tag_ids.len() > PLUGIN_TASK_TAG_IDS_MAX
            || request.statuses.len() > PLUGIN_TASK_STATUSES_MAX
            || request.priorities.len() > PLUGIN_TASK_PRIORITIES_MAX
        {
            return Err(PluginQueryError::InvalidInput);
        }
        validate_optional_id(&request.task_id, TaskId::parse)?;
        validate_optional_id(&request.project_id, ProjectId::parse)?;
        validate_optional_id(&request.section_id, SectionId::parse)?;
        validate_optional_id(&request.parent_id, TaskId::parse)?;
        for id in &request.tag_ids {
            validate_id(id, TagId::parse)?;
        }
        let due_from = request.due_from.as_deref().map(parse_date).transpose()?;
        let due_before = request.due_before.as_deref().map(parse_date).transpose()?;
        if due_from
            .zip(due_before)
            .is_some_and(|(from, before)| from >= before)
        {
            return Err(PluginQueryError::InvalidInput);
        }
        if request.search.as_ref().is_some_and(|search| {
            search.is_empty() || search.chars().count() > PLUGIN_TASK_SEARCH_CHARS_MAX
        }) {
            return Err(PluginQueryError::InvalidInput);
        }
        validate_cursor_input(request.cursor.as_deref())?;

        request.tag_ids.sort_unstable();
        request.tag_ids.dedup();
        request.statuses.sort_by_key(|status| match status {
            TaskStatus::Pending => 0_u8,
            TaskStatus::Completed => 1,
            TaskStatus::Cancelled => 2,
        });
        request.statuses.dedup();
        request.priorities.sort_by_key(|priority| match priority {
            junban_plugin_sdk::private_body_types::Priority::P1 => 1_u8,
            junban_plugin_sdk::private_body_types::Priority::P2 => 2,
            junban_plugin_sdk::private_body_types::Priority::P3 => 3,
            junban_plugin_sdk::private_body_types::Priority::P4 => 4,
        });
        request.priorities.dedup();
        let cursor = request.cursor.take();
        Ok(Self { request, cursor })
    }

    #[must_use]
    pub fn canonical_request(&self) -> &TaskQuery {
        &self.request
    }

    #[must_use]
    pub fn cursor(&self) -> Option<&str> {
        self.cursor.as_deref()
    }

    #[must_use]
    pub const fn limit(&self) -> u16 {
        self.request.limit
    }
}

/// Validated ordinary-plugin project/tag catalog query sent to storage.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluginCatalogQuery {
    request: CatalogQuery,
    cursor: Option<String>,
}

impl PluginCatalogQuery {
    pub fn normalize(mut request: CatalogQuery) -> Result<Self, PluginQueryError> {
        if request.limit == 0 || request.limit > PLUGIN_QUERY_LIMIT_MAX {
            return Err(PluginQueryError::InvalidInput);
        }
        validate_cursor_input(request.cursor.as_deref())?;
        let cursor = request.cursor.take();
        Ok(Self { request, cursor })
    }

    #[must_use]
    pub fn canonical_request(&self) -> &CatalogQuery {
        &self.request
    }

    #[must_use]
    pub fn cursor(&self) -> Option<&str> {
        self.cursor.as_deref()
    }

    #[must_use]
    pub const fn limit(&self) -> u16 {
        self.request.limit
    }
}

pub type PluginTaskQueryPage = TaskPage;
pub type PluginProjectQueryPage = ProjectPage;
pub type PluginTagQueryPage = TagPage;

pub type PluginQueryFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, PluginQueryError>> + Send + 'a>>;

/// Storage-only port for ordinary plugin reads. Each implementation call owns
/// exactly one complete page transaction.
pub trait PluginQueryRepository: Send + Sync + 'static {
    fn query_plugin_tasks(
        &self,
        _query: PluginTaskQuery,
    ) -> PluginQueryFuture<'_, PluginTaskQueryPage> {
        Box::pin(async { Err(PluginQueryError::Unavailable) })
    }

    fn query_plugin_projects(
        &self,
        _query: PluginCatalogQuery,
    ) -> PluginQueryFuture<'_, PluginProjectQueryPage> {
        Box::pin(async { Err(PluginQueryError::Unavailable) })
    }

    fn query_plugin_tags(
        &self,
        _query: PluginCatalogQuery,
    ) -> PluginQueryFuture<'_, PluginTagQueryPage> {
        Box::pin(async { Err(PluginQueryError::Unavailable) })
    }
}

fn validate_cursor_input(cursor: Option<&str>) -> Result<(), PluginQueryError> {
    if cursor.is_some_and(|cursor| cursor.len() > PLUGIN_QUERY_CURSOR_BYTES_MAX) {
        Err(PluginQueryError::InvalidInput)
    } else {
        Ok(())
    }
}

fn validate_optional_id<T, E>(
    value: &Option<String>,
    parse: impl Fn(&str) -> Result<T, E> + Copy,
) -> Result<(), PluginQueryError>
where
    T: ToString,
{
    if let Some(value) = value {
        validate_id(value, parse)?;
    }
    Ok(())
}

fn validate_id<T, E>(
    value: &str,
    parse: impl FnOnce(&str) -> Result<T, E>,
) -> Result<(), PluginQueryError>
where
    T: ToString,
{
    let parsed = parse(value).map_err(|_| PluginQueryError::InvalidInput)?;
    if parsed.to_string() != value {
        return Err(PluginQueryError::InvalidInput);
    }
    Ok(())
}

fn parse_date(value: &str) -> Result<Date, PluginQueryError> {
    let parsed = value
        .parse::<Date>()
        .map_err(|_| PluginQueryError::InvalidInput)?;
    if parsed.to_string() != value {
        return Err(PluginQueryError::InvalidInput);
    }
    Ok(parsed)
}

fn codec_fence() -> CallbackFence {
    CallbackFence {
        plugin_id: "ordinary-query".to_owned(),
        package_generation: 1,
        activation_epoch: 1,
        host_session_id: "00000000-0000-0000-0000-000000000000".to_owned(),
        invocation_id: "00000000-0000-0000-0000-000000000000".to_owned(),
        callback_id: 1,
    }
}

/// Canonical normalized SDK request bytes used by the query hash.
#[doc(hidden)]
pub fn plugin_task_query_bytes(query: &PluginTaskQuery) -> Result<Vec<u8>, PluginQueryError> {
    HostCallRequest::QueryTasks(query.request.clone())
        .into_child_message(codec_fence())
        .map(|message| message.into_parts().1)
        .map_err(|_| PluginQueryError::InvalidInput)
}

/// Canonical normalized SDK catalog request bytes used by the query hash.
#[doc(hidden)]
pub fn plugin_catalog_query_bytes(
    query: &PluginCatalogQuery,
    projects: bool,
) -> Result<Vec<u8>, PluginQueryError> {
    let request = if projects {
        HostCallRequest::QueryProjects(query.request.clone())
    } else {
        HostCallRequest::QueryTags(query.request.clone())
    };
    request
        .into_child_message(codec_fence())
        .map(|message| message.into_parts().1)
        .map_err(|_| PluginQueryError::InvalidInput)
}

/// Exact canonical SDK successful-reply bytes used by the page ceiling.
#[doc(hidden)]
pub fn plugin_task_reply_bytes(page: TaskPage) -> Result<Vec<u8>, PluginQueryError> {
    reply_bytes(HostCallReply::QueryTasks(WitResult::Ok(page)))
}

#[doc(hidden)]
pub fn plugin_project_reply_bytes(page: ProjectPage) -> Result<Vec<u8>, PluginQueryError> {
    reply_bytes(HostCallReply::QueryProjects(WitResult::Ok(page)))
}

#[doc(hidden)]
pub fn plugin_tag_reply_bytes(page: TagPage) -> Result<Vec<u8>, PluginQueryError> {
    reply_bytes(HostCallReply::QueryTags(WitResult::Ok(page)))
}

fn reply_bytes(reply: HostCallReply) -> Result<Vec<u8>, PluginQueryError> {
    reply
        .into_parent_message(codec_fence())
        .map(|message| message.into_parts().1)
        .map_err(|_| PluginQueryError::OperationTooLarge)
}

#[doc(hidden)]
pub fn plugin_task_view(
    task: &junban_domain::Task,
    revision: u64,
) -> Result<TaskView, PluginQueryError> {
    plugin_event::task_view(task, revision).map_err(|_| PluginQueryError::Unavailable)
}

#[doc(hidden)]
pub fn plugin_project_view(
    project: &junban_domain::Project,
    revision: u64,
) -> Result<ProjectViewRecord, PluginQueryError> {
    plugin_event::project_view(project, revision).map_err(|_| PluginQueryError::Unavailable)
}

#[doc(hidden)]
pub fn plugin_tag_view(
    tag: &junban_domain::Tag,
    revision: u64,
) -> Result<TagView, PluginQueryError> {
    plugin_event::tag_view(tag, revision).map_err(|_| PluginQueryError::Unavailable)
}

#[cfg(test)]
mod tests {
    use super::*;
    use junban_plugin_sdk::private_body_types::Priority;

    fn query() -> TaskQuery {
        TaskQuery {
            task_id: None,
            project_id: None,
            section_id: None,
            parent_id: None,
            tag_ids: Vec::new(),
            statuses: Vec::new(),
            priorities: Vec::new(),
            due_from: None,
            due_before: None,
            search: None,
            cursor: None,
            limit: 10,
        }
    }

    #[test]
    fn task_query_normalizes_sets_after_enforcing_input_ceilings() {
        let mut request = query();
        request.tag_ids = vec![
            "00000000-0000-0000-0000-000000000002".into(),
            "00000000-0000-0000-0000-000000000001".into(),
            "00000000-0000-0000-0000-000000000002".into(),
        ];
        request.statuses = vec![
            TaskStatus::Cancelled,
            TaskStatus::Pending,
            TaskStatus::Pending,
        ];
        request.priorities = vec![Priority::P4, Priority::P1, Priority::P4];
        let normalized = PluginTaskQuery::normalize(request).unwrap();
        assert_eq!(
            normalized.canonical_request().tag_ids,
            [
                "00000000-0000-0000-0000-000000000001",
                "00000000-0000-0000-0000-000000000002"
            ]
        );
        assert_eq!(
            normalized.canonical_request().statuses,
            [TaskStatus::Pending, TaskStatus::Cancelled]
        );
        assert_eq!(
            normalized.canonical_request().priorities,
            [Priority::P1, Priority::P4]
        );

        let mut full_duplicates = query();
        full_duplicates.tag_ids = vec!["00000000-0000-0000-0000-000000000000".into(); 16];
        assert_eq!(
            PluginTaskQuery::normalize(full_duplicates)
                .unwrap()
                .canonical_request()
                .tag_ids
                .len(),
            1
        );
        let mut too_many = query();
        too_many.tag_ids = vec!["00000000-0000-0000-0000-000000000000".into(); 17];
        assert_eq!(
            PluginTaskQuery::normalize(too_many),
            Err(PluginQueryError::InvalidInput)
        );
        let mut too_many_statuses = query();
        too_many_statuses.statuses = vec![TaskStatus::Pending; 4];
        assert_eq!(
            PluginTaskQuery::normalize(too_many_statuses),
            Err(PluginQueryError::InvalidInput)
        );
        let mut too_many_priorities = query();
        too_many_priorities.priorities = vec![Priority::P1; 5];
        assert_eq!(
            PluginTaskQuery::normalize(too_many_priorities),
            Err(PluginQueryError::InvalidInput)
        );
    }

    #[test]
    fn task_query_validates_exact_ids_dates_search_limit_and_cursor() {
        for id in [
            "00000000-0000-0000-0000-000000000000",
            "00000000-0000-0000-0000-000000000001",
            "00000000-0000-0000-e000-000000000001",
            "00000000-0000-f000-8000-000000000001",
        ] {
            let mut request = query();
            request.task_id = Some(id.into());
            PluginTaskQuery::normalize(request).unwrap();
        }
        for mutate in [
            |request: &mut TaskQuery| request.task_id = Some("NOT-A-UUID".into()),
            |request: &mut TaskQuery| request.due_from = Some("2026-1-01".into()),
            |request: &mut TaskQuery| request.search = Some(String::new()),
            |request: &mut TaskQuery| request.limit = 0,
            |request: &mut TaskQuery| request.cursor = Some("x".repeat(513)),
        ] {
            let mut request = query();
            mutate(&mut request);
            assert_eq!(
                PluginTaskQuery::normalize(request),
                Err(PluginQueryError::InvalidInput)
            );
        }
        let mut reversed = query();
        reversed.due_from = Some("2026-01-02".into());
        reversed.due_before = Some("2026-01-02".into());
        assert_eq!(
            PluginTaskQuery::normalize(reversed),
            Err(PluginQueryError::InvalidInput)
        );
        let mut scalar_boundary = query();
        scalar_boundary.search = Some("é".repeat(10_000));
        PluginTaskQuery::normalize(scalar_boundary).unwrap();
        let mut scalar_overflow = query();
        scalar_overflow.search = Some("é".repeat(10_001));
        assert_eq!(
            PluginTaskQuery::normalize(scalar_overflow),
            Err(PluginQueryError::InvalidInput)
        );
        let mut cursor_boundary = query();
        cursor_boundary.cursor = Some("x".repeat(512));
        PluginTaskQuery::normalize(cursor_boundary).unwrap();
    }

    #[test]
    fn canonical_query_bytes_exclude_cursor_and_change_with_every_semantic_field() {
        let base = PluginTaskQuery::normalize(query()).unwrap();
        let base_bytes = plugin_task_query_bytes(&base).unwrap();
        let mut with_cursor = query();
        with_cursor.cursor = Some("opaque".into());
        assert_eq!(
            plugin_task_query_bytes(&PluginTaskQuery::normalize(with_cursor).unwrap()).unwrap(),
            base_bytes
        );
        let mut changed_requests = Vec::new();
        let mut changed = query();
        changed.limit = 11;
        changed_requests.push(changed);
        let mut changed = query();
        changed.task_id = Some("00000000-0000-0000-0000-000000000001".into());
        changed_requests.push(changed);
        let mut changed = query();
        changed.project_id = Some("00000000-0000-0000-0000-000000000001".into());
        changed_requests.push(changed);
        let mut changed = query();
        changed.section_id = Some("00000000-0000-0000-0000-000000000001".into());
        changed_requests.push(changed);
        let mut changed = query();
        changed.parent_id = Some("00000000-0000-0000-0000-000000000001".into());
        changed_requests.push(changed);
        let mut changed = query();
        changed.tag_ids = vec!["00000000-0000-0000-0000-000000000001".into()];
        changed_requests.push(changed);
        let mut changed = query();
        changed.statuses = vec![TaskStatus::Pending];
        changed_requests.push(changed);
        let mut changed = query();
        changed.priorities = vec![Priority::P1];
        changed_requests.push(changed);
        let mut changed = query();
        changed.due_from = Some("2026-01-01".into());
        changed_requests.push(changed);
        let mut changed = query();
        changed.due_before = Some("2026-01-02".into());
        changed_requests.push(changed);
        let mut changed = query();
        changed.search = Some("needle".into());
        changed_requests.push(changed);
        for changed in changed_requests {
            assert_ne!(
                plugin_task_query_bytes(&PluginTaskQuery::normalize(changed).unwrap()).unwrap(),
                base_bytes
            );
        }
        assert_eq!(
            String::from_utf8(base_bytes).unwrap(),
            r#"{"tag":"query-tasks","val":{"task-id":null,"project-id":null,"section-id":null,"parent-id":null,"tag-ids":[],"statuses":[],"priorities":[],"due-from":null,"due-before":null,"search":null,"cursor":null,"limit":10}}"#
        );
    }
}
