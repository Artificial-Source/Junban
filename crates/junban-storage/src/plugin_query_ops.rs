//! SQLite authority for ordinary plugin task/project/tag pages.

use std::time::{SystemTime, UNIX_EPOCH};

use junban_app::{
    PLUGIN_QUERY_REPLY_BYTES_MAX, PluginCatalogQuery, PluginQueryError, PluginTaskQuery,
    plugin_catalog_query_bytes, plugin_project_reply_bytes, plugin_project_view,
    plugin_tag_reply_bytes, plugin_tag_view, plugin_task_query_bytes, plugin_task_reply_bytes,
    plugin_task_view,
};
use junban_plugin_sdk::private_body_types::{
    Priority, ProjectPage, ProjectViewRecord, TagPage, TagView, TaskPage, TaskStatus, TaskView,
};
use rusqlite::{Connection, params_from_iter, types::Value};
use sha2::{Digest, Sha256};

use crate::{
    ai_secrets::{AiSecretStore, PluginQueryCursorKey},
    rows::{load_task_tag_ids, project_from_row, tag_from_row, task_from_row},
};

const QUERY_HASH_DOMAIN: &[u8] = b"junban.plugin.ordinary-query.v1\0";
const CURSOR_VERSION: u8 = 1;
const CURSOR_TTL_SECONDS: u64 = 300;
const CURSOR_ENVELOPE_BYTES: usize = 122;
const CURSOR_AUTHENTICATED_BYTES: usize = 90;
const CURSOR_MAC_BYTES: usize = 32;
const CURSOR_TEXT_BYTES: usize = 163;
const CURSOR_INPUT_BYTES_MAX: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QueryKind {
    Task,
    Project,
    Tag,
}

impl QueryKind {
    const fn byte(self) -> u8 {
        match self {
            Self::Task => 1,
            Self::Project => 2,
            Self::Tag => 3,
        }
    }

    fn from_byte(value: u8) -> Result<Self, PluginQueryError> {
        match value {
            1 => Ok(Self::Task),
            2 => Ok(Self::Project),
            3 => Ok(Self::Tag),
            _ => Err(PluginQueryError::InvalidInput),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct CursorAuthority {
    revision: u64,
    event_epoch: String,
    last_id: String,
}

/// Lazy per-profile query key authority. A rotation retains exactly one prior
/// key for at most one cursor TTL, so already-issued pages can finish while a
/// second rotation and process restart both fail closed.
#[derive(Debug, Default)]
pub(crate) struct PluginQueryKeyring {
    active: Option<PluginQueryCursorKey>,
    previous: Option<(PluginQueryCursorKey, u64)>,
}

impl PluginQueryKeyring {
    fn refresh(&mut self, profile_dir: &std::path::Path, now: u64) -> Result<(), PluginQueryError> {
        let loaded = AiSecretStore::load_or_create(profile_dir)
            .map_err(|_| PluginQueryError::Unavailable)?
            .plugin_query_cursor_key()
            .map_err(|_| PluginQueryError::Unavailable)?;
        if let Some(active) = &self.active {
            if active
                .has_same_key(&loaded)
                .map_err(|_| PluginQueryError::Unavailable)?
            {
                self.previous = self.previous.take().filter(|(_, expires)| now < *expires);
                return Ok(());
            }
            let previous_expires = now
                .checked_add(CURSOR_TTL_SECONDS)
                .ok_or(PluginQueryError::InvalidInput)?;
            self.previous = self.active.take().map(|active| (active, previous_expires));
        }
        self.active = Some(loaded);
        Ok(())
    }

    fn sign(&self, envelope: &[u8]) -> Result<[u8; 32], PluginQueryError> {
        self.active
            .as_ref()
            .ok_or(PluginQueryError::Unavailable)?
            .mac(envelope)
            .map_err(|_| PluginQueryError::Unavailable)
    }

    fn verify(&self, envelope: &[u8], expected: &[u8], now: u64) -> Result<bool, PluginQueryError> {
        let active = self.active.as_ref().ok_or(PluginQueryError::Unavailable)?;
        if active
            .verify(envelope, expected)
            .map_err(|_| PluginQueryError::Unavailable)?
        {
            return Ok(true);
        }
        if let Some((previous, expires)) = &self.previous
            && now < *expires
        {
            return previous
                .verify(envelope, expected)
                .map_err(|_| PluginQueryError::Unavailable);
        }
        Ok(false)
    }
}

pub(crate) fn query_tasks(
    connection: &Connection,
    profile_dir: &std::path::Path,
    keys: &mut PluginQueryKeyring,
    query: PluginTaskQuery,
) -> Result<TaskPage, PluginQueryError> {
    let now = unix_now()?;
    keys.refresh(profile_dir, now)?;
    query_tasks_at(connection, keys, query, now)
}

pub(crate) fn query_projects(
    connection: &Connection,
    profile_dir: &std::path::Path,
    keys: &mut PluginQueryKeyring,
    query: PluginCatalogQuery,
) -> Result<ProjectPage, PluginQueryError> {
    let now = unix_now()?;
    keys.refresh(profile_dir, now)?;
    query_projects_at(connection, keys, query, now)
}

pub(crate) fn query_tags(
    connection: &Connection,
    profile_dir: &std::path::Path,
    keys: &mut PluginQueryKeyring,
    query: PluginCatalogQuery,
) -> Result<TagPage, PluginQueryError> {
    let now = unix_now()?;
    keys.refresh(profile_dir, now)?;
    query_tags_at(connection, keys, query, now)
}

fn unix_now() -> Result<u64, PluginQueryError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| PluginQueryError::Unavailable)
}

fn query_tasks_at(
    connection: &Connection,
    keys: &PluginQueryKeyring,
    query: PluginTaskQuery,
    now: u64,
) -> Result<TaskPage, PluginQueryError> {
    query_tasks_at_with_after_sample(connection, keys, query, now, || {})
}

fn query_tasks_at_with_after_sample(
    connection: &Connection,
    keys: &PluginQueryKeyring,
    query: PluginTaskQuery,
    now: u64,
    after_sample: impl FnOnce(),
) -> Result<TaskPage, PluginQueryError> {
    let query_hash = normalized_query_hash(QueryKind::Task, &plugin_task_query_bytes(&query)?)?;
    let cursor = query
        .cursor()
        .map(|cursor| decode_cursor(keys, cursor, QueryKind::Task, query_hash, now))
        .transpose()?;

    let tx = connection
        .unchecked_transaction()
        .map_err(|_| PluginQueryError::Unavailable)?;
    let (revision, event_epoch) = read_state(&tx)?;
    after_sample();
    require_snapshot(cursor.as_ref(), revision, &event_epoch)?;
    let after_id = cursor.as_ref().map(|cursor| cursor.last_id.as_str());
    let candidates = select_tasks(&tx, &query, after_id, revision)?;
    let page = build_task_page(
        keys,
        candidates,
        revision,
        &event_epoch,
        query_hash,
        query.limit(),
        now,
        PLUGIN_QUERY_REPLY_BYTES_MAX,
    )?;
    tx.commit().map_err(|_| PluginQueryError::Unavailable)?;
    Ok(page)
}

fn query_projects_at(
    connection: &Connection,
    keys: &PluginQueryKeyring,
    query: PluginCatalogQuery,
    now: u64,
) -> Result<ProjectPage, PluginQueryError> {
    let query_hash = normalized_query_hash(
        QueryKind::Project,
        &plugin_catalog_query_bytes(&query, true)?,
    )?;
    let cursor = query
        .cursor()
        .map(|cursor| decode_cursor(keys, cursor, QueryKind::Project, query_hash, now))
        .transpose()?;
    let tx = connection
        .unchecked_transaction()
        .map_err(|_| PluginQueryError::Unavailable)?;
    let (revision, event_epoch) = read_state(&tx)?;
    require_snapshot(cursor.as_ref(), revision, &event_epoch)?;
    let candidates = select_projects(
        &tx,
        cursor.as_ref().map(|cursor| cursor.last_id.as_str()),
        query.limit(),
        revision,
    )?;
    let page = build_project_page(
        keys,
        candidates,
        revision,
        &event_epoch,
        query_hash,
        query.limit(),
        now,
        PLUGIN_QUERY_REPLY_BYTES_MAX,
    )?;
    tx.commit().map_err(|_| PluginQueryError::Unavailable)?;
    Ok(page)
}

fn query_tags_at(
    connection: &Connection,
    keys: &PluginQueryKeyring,
    query: PluginCatalogQuery,
    now: u64,
) -> Result<TagPage, PluginQueryError> {
    let query_hash =
        normalized_query_hash(QueryKind::Tag, &plugin_catalog_query_bytes(&query, false)?)?;
    let cursor = query
        .cursor()
        .map(|cursor| decode_cursor(keys, cursor, QueryKind::Tag, query_hash, now))
        .transpose()?;
    let tx = connection
        .unchecked_transaction()
        .map_err(|_| PluginQueryError::Unavailable)?;
    let (revision, event_epoch) = read_state(&tx)?;
    require_snapshot(cursor.as_ref(), revision, &event_epoch)?;
    let candidates = select_tags(
        &tx,
        cursor.as_ref().map(|cursor| cursor.last_id.as_str()),
        query.limit(),
        revision,
    )?;
    let page = build_tag_page(
        keys,
        candidates,
        revision,
        &event_epoch,
        query_hash,
        query.limit(),
        now,
        PLUGIN_QUERY_REPLY_BYTES_MAX,
    )?;
    tx.commit().map_err(|_| PluginQueryError::Unavailable)?;
    Ok(page)
}

fn read_state(connection: &Connection) -> Result<(u64, String), PluginQueryError> {
    let (revision, event_epoch): (i64, String) = connection
        .query_row(
            "SELECT global_revision, event_epoch FROM app_state WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| PluginQueryError::Unavailable)?;
    let revision = u64::try_from(revision).map_err(|_| PluginQueryError::Unavailable)?;
    canonical_uuid_bytes(&event_epoch).map_err(|_| PluginQueryError::Unavailable)?;
    Ok((revision, event_epoch))
}

fn require_snapshot(
    cursor: Option<&CursorAuthority>,
    revision: u64,
    event_epoch: &str,
) -> Result<(), PluginQueryError> {
    if cursor.is_some_and(|cursor| cursor.revision != revision || cursor.event_epoch != event_epoch)
    {
        Err(PluginQueryError::CursorStale)
    } else {
        Ok(())
    }
}

fn select_tasks(
    connection: &Connection,
    query: &PluginTaskQuery,
    after_id: Option<&str>,
    revision: u64,
) -> Result<Vec<TaskView>, PluginQueryError> {
    let request = query.canonical_request();
    let mut sql = String::from(
        "SELECT t.id, t.title, t.description, t.due_date, t.due_time, t.due_timezone, t.deadline,
                t.status, t.priority, t.dread, t.estimated_minutes, t.actual_minutes,
                t.project_id, t.section_id, t.parent_id, t.sort_order, t.recurrence_rule, t.someday,
                t.completed_at, t.cancelled_at, t.created_at, t.updated_at, t.revision,
                t.remind_at, t.recurrence_anchor_day, t.recurrence_source_id, t.completion_operation_id
         FROM tasks t WHERE 1 = 1",
    );
    let mut binds = Vec::<Value>::new();

    if let Some(value) = &request.task_id {
        sql.push_str(" AND t.id = ");
        push_text_bind(&mut sql, &mut binds, value.clone());
    }
    if let Some(value) = &request.project_id {
        sql.push_str(" AND t.project_id = ");
        push_text_bind(&mut sql, &mut binds, value.clone());
    }
    if let Some(value) = &request.section_id {
        sql.push_str(" AND t.section_id = ");
        push_text_bind(&mut sql, &mut binds, value.clone());
    }
    if let Some(value) = &request.parent_id {
        sql.push_str(" AND t.parent_id = ");
        push_text_bind(&mut sql, &mut binds, value.clone());
    }
    for tag_id in &request.tag_ids {
        sql.push_str(
            " AND EXISTS (SELECT 1 FROM task_tags tt WHERE tt.task_id = t.id AND tt.tag_id = ",
        );
        push_text_bind(&mut sql, &mut binds, tag_id.clone());
        sql.push(')');
    }
    if !request.statuses.is_empty() {
        sql.push_str(" AND t.status IN (");
        for (index, status) in request.statuses.iter().enumerate() {
            if index != 0 {
                sql.push(',');
            }
            push_text_bind(
                &mut sql,
                &mut binds,
                match status {
                    TaskStatus::Pending => "pending",
                    TaskStatus::Completed => "completed",
                    TaskStatus::Cancelled => "cancelled",
                }
                .to_owned(),
            );
        }
        sql.push(')');
    }
    if !request.priorities.is_empty() {
        sql.push_str(" AND t.priority IN (");
        for (index, priority) in request.priorities.iter().enumerate() {
            if index != 0 {
                sql.push(',');
            }
            binds.push(Value::Integer(match priority {
                Priority::P1 => 1,
                Priority::P2 => 2,
                Priority::P3 => 3,
                Priority::P4 => 4,
            }));
            sql.push('?');
        }
        sql.push(')');
    }
    if let Some(value) = &request.due_from {
        sql.push_str(" AND t.due_date >= ");
        push_text_bind(&mut sql, &mut binds, value.clone());
    }
    if let Some(value) = &request.due_before {
        sql.push_str(" AND t.due_date < ");
        push_text_bind(&mut sql, &mut binds, value.clone());
    }
    if let Some(value) = &request.search {
        sql.push_str(" AND (instr(t.title, ");
        push_text_bind(&mut sql, &mut binds, value.clone());
        sql.push_str(") > 0 OR instr(t.description, ");
        push_text_bind(&mut sql, &mut binds, value.clone());
        sql.push_str(") > 0)");
    }
    if let Some(after_id) = after_id {
        sql.push_str(" AND t.id > ");
        push_text_bind(&mut sql, &mut binds, after_id.to_owned());
        sql.push_str(" COLLATE BINARY");
    }
    sql.push_str(" ORDER BY t.id COLLATE BINARY ASC LIMIT ?");
    binds.push(Value::Integer(i64::from(query.limit()) + 1));

    let mut statement = connection
        .prepare(&sql)
        .map_err(|_| PluginQueryError::Unavailable)?;
    let rows = statement
        .query_map(params_from_iter(binds), task_from_row)
        .map_err(|_| PluginQueryError::Unavailable)?;
    let mut tasks = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| PluginQueryError::Unavailable)?;
    for task in &mut tasks {
        task.tag_ids =
            load_task_tag_ids(connection, task.id).map_err(|_| PluginQueryError::Unavailable)?;
    }
    tasks
        .iter()
        .map(|task| plugin_task_view(task, revision))
        .collect()
}

fn select_projects(
    connection: &Connection,
    after_id: Option<&str>,
    limit: u16,
    revision: u64,
) -> Result<Vec<ProjectViewRecord>, PluginQueryError> {
    let mut statement = connection
        .prepare(
            "SELECT id, name, color, icon, parent_id, favorite, archived, view_style,
                    sort_order, created_at, updated_at
             FROM projects
             WHERE (?1 IS NULL OR id > ?1 COLLATE BINARY)
             ORDER BY id COLLATE BINARY ASC
             LIMIT ?2",
        )
        .map_err(|_| PluginQueryError::Unavailable)?;
    let rows = statement
        .query_map(
            rusqlite::params![after_id, i64::from(limit) + 1],
            project_from_row,
        )
        .map_err(|_| PluginQueryError::Unavailable)?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|_| PluginQueryError::Unavailable)?
        .iter()
        .map(|project| plugin_project_view(project, revision))
        .collect()
}

fn select_tags(
    connection: &Connection,
    after_id: Option<&str>,
    limit: u16,
    revision: u64,
) -> Result<Vec<TagView>, PluginQueryError> {
    let mut statement = connection
        .prepare(
            "SELECT id, name, color, created_at, updated_at
             FROM tags
             WHERE (?1 IS NULL OR id > ?1 COLLATE BINARY)
             ORDER BY id COLLATE BINARY ASC
             LIMIT ?2",
        )
        .map_err(|_| PluginQueryError::Unavailable)?;
    let rows = statement
        .query_map(
            rusqlite::params![after_id, i64::from(limit) + 1],
            tag_from_row,
        )
        .map_err(|_| PluginQueryError::Unavailable)?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|_| PluginQueryError::Unavailable)?
        .iter()
        .map(|tag| plugin_tag_view(tag, revision))
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn build_task_page(
    keys: &PluginQueryKeyring,
    candidates: Vec<TaskView>,
    revision: u64,
    event_epoch: &str,
    query_hash: [u8; 32],
    limit: u16,
    now: u64,
    maximum: usize,
) -> Result<TaskPage, PluginQueryError> {
    let mut items = Vec::new();
    for candidate in candidates.iter().take(usize::from(limit)) {
        items.push(candidate.clone());
        let has_more = candidates.len() > items.len();
        let next_cursor = next_cursor(
            keys,
            QueryKind::Task,
            revision,
            event_epoch,
            query_hash,
            items.last().map(|item| item.id.as_str()),
            has_more,
            now,
        )?;
        let page = TaskPage {
            items: items.clone(),
            next_cursor,
            revision,
        };
        if plugin_task_reply_bytes(page)?.len() > maximum {
            items.pop();
            if items.is_empty() {
                return Err(PluginQueryError::OperationTooLarge);
            }
            break;
        }
    }
    let has_more = candidates.len() > items.len();
    let next_cursor = next_cursor(
        keys,
        QueryKind::Task,
        revision,
        event_epoch,
        query_hash,
        items.last().map(|item| item.id.as_str()),
        has_more,
        now,
    )?;
    let page = TaskPage {
        items,
        next_cursor,
        revision,
    };
    if plugin_task_reply_bytes(page.clone())?.len() > maximum {
        return Err(PluginQueryError::OperationTooLarge);
    }
    Ok(page)
}

#[allow(clippy::too_many_arguments)]
fn build_project_page(
    keys: &PluginQueryKeyring,
    candidates: Vec<ProjectViewRecord>,
    revision: u64,
    event_epoch: &str,
    query_hash: [u8; 32],
    limit: u16,
    now: u64,
    maximum: usize,
) -> Result<ProjectPage, PluginQueryError> {
    let mut items = Vec::new();
    for candidate in candidates.iter().take(usize::from(limit)) {
        items.push(candidate.clone());
        let page = ProjectPage {
            next_cursor: next_cursor(
                keys,
                QueryKind::Project,
                revision,
                event_epoch,
                query_hash,
                items.last().map(|item| item.id.as_str()),
                candidates.len() > items.len(),
                now,
            )?,
            items: items.clone(),
            revision,
        };
        if plugin_project_reply_bytes(page)?.len() > maximum {
            items.pop();
            if items.is_empty() {
                return Err(PluginQueryError::OperationTooLarge);
            }
            break;
        }
    }
    let page = ProjectPage {
        next_cursor: next_cursor(
            keys,
            QueryKind::Project,
            revision,
            event_epoch,
            query_hash,
            items.last().map(|item| item.id.as_str()),
            candidates.len() > items.len(),
            now,
        )?,
        items,
        revision,
    };
    if plugin_project_reply_bytes(page.clone())?.len() > maximum {
        return Err(PluginQueryError::OperationTooLarge);
    }
    Ok(page)
}

#[allow(clippy::too_many_arguments)]
fn build_tag_page(
    keys: &PluginQueryKeyring,
    candidates: Vec<TagView>,
    revision: u64,
    event_epoch: &str,
    query_hash: [u8; 32],
    limit: u16,
    now: u64,
    maximum: usize,
) -> Result<TagPage, PluginQueryError> {
    let mut items = Vec::new();
    for candidate in candidates.iter().take(usize::from(limit)) {
        items.push(candidate.clone());
        let page = TagPage {
            next_cursor: next_cursor(
                keys,
                QueryKind::Tag,
                revision,
                event_epoch,
                query_hash,
                items.last().map(|item| item.id.as_str()),
                candidates.len() > items.len(),
                now,
            )?,
            items: items.clone(),
            revision,
        };
        if plugin_tag_reply_bytes(page)?.len() > maximum {
            items.pop();
            if items.is_empty() {
                return Err(PluginQueryError::OperationTooLarge);
            }
            break;
        }
    }
    let page = TagPage {
        next_cursor: next_cursor(
            keys,
            QueryKind::Tag,
            revision,
            event_epoch,
            query_hash,
            items.last().map(|item| item.id.as_str()),
            candidates.len() > items.len(),
            now,
        )?,
        items,
        revision,
    };
    if plugin_tag_reply_bytes(page.clone())?.len() > maximum {
        return Err(PluginQueryError::OperationTooLarge);
    }
    Ok(page)
}

#[allow(clippy::too_many_arguments)]
fn next_cursor(
    keys: &PluginQueryKeyring,
    kind: QueryKind,
    revision: u64,
    event_epoch: &str,
    query_hash: [u8; 32],
    last_id: Option<&str>,
    has_more: bool,
    now: u64,
) -> Result<Option<String>, PluginQueryError> {
    if !has_more {
        return Ok(None);
    }
    let last_id = last_id.ok_or(PluginQueryError::OperationTooLarge)?;
    encode_cursor(keys, kind, now, revision, event_epoch, query_hash, last_id).map(Some)
}

fn normalized_query_hash(kind: QueryKind, bytes: &[u8]) -> Result<[u8; 32], PluginQueryError> {
    let length = u32::try_from(bytes.len()).map_err(|_| PluginQueryError::InvalidInput)?;
    let mut hash = Sha256::new();
    hash.update(QUERY_HASH_DOMAIN);
    hash.update([kind.byte()]);
    hash.update(length.to_be_bytes());
    hash.update(bytes);
    Ok(hash.finalize().into())
}

fn encode_cursor(
    keys: &PluginQueryKeyring,
    kind: QueryKind,
    issued_at: u64,
    revision: u64,
    event_epoch: &str,
    query_hash: [u8; 32],
    last_id: &str,
) -> Result<String, PluginQueryError> {
    if revision > i64::MAX as u64 {
        return Err(PluginQueryError::InvalidInput);
    }
    let expires_at = issued_at
        .checked_add(CURSOR_TTL_SECONDS)
        .ok_or(PluginQueryError::InvalidInput)?;
    let event_epoch = canonical_uuid_bytes(event_epoch)?;
    let last_id = canonical_uuid_bytes(last_id)?;
    let mut envelope = [0_u8; CURSOR_ENVELOPE_BYTES];
    envelope[0] = CURSOR_VERSION;
    envelope[1] = kind.byte();
    envelope[2..10].copy_from_slice(&issued_at.to_be_bytes());
    envelope[10..18].copy_from_slice(&expires_at.to_be_bytes());
    envelope[18..26].copy_from_slice(&revision.to_be_bytes());
    envelope[26..42].copy_from_slice(&event_epoch);
    envelope[42..74].copy_from_slice(&query_hash);
    envelope[74..90].copy_from_slice(&last_id);
    let mac = keys.sign(&envelope[..CURSOR_AUTHENTICATED_BYTES])?;
    envelope[CURSOR_AUTHENTICATED_BYTES..].copy_from_slice(&mac);
    let encoded = base64url_encode(&envelope);
    if encoded.len() != CURSOR_TEXT_BYTES {
        return Err(PluginQueryError::Unavailable);
    }
    Ok(encoded)
}

fn decode_cursor(
    keys: &PluginQueryKeyring,
    encoded: &str,
    expected_kind: QueryKind,
    expected_query_hash: [u8; 32],
    now: u64,
) -> Result<CursorAuthority, PluginQueryError> {
    if encoded.len() > CURSOR_INPUT_BYTES_MAX || encoded.len() != CURSOR_TEXT_BYTES {
        return Err(PluginQueryError::InvalidInput);
    }
    let decoded = base64url_decode(encoded)?;
    if decoded.len() != CURSOR_ENVELOPE_BYTES || base64url_encode(&decoded) != encoded {
        return Err(PluginQueryError::InvalidInput);
    }
    if !keys.verify(
        &decoded[..CURSOR_AUTHENTICATED_BYTES],
        &decoded[CURSOR_AUTHENTICATED_BYTES..CURSOR_AUTHENTICATED_BYTES + CURSOR_MAC_BYTES],
        now,
    )? {
        return Err(PluginQueryError::InvalidInput);
    }
    if decoded[0] != CURSOR_VERSION
        || QueryKind::from_byte(decoded[1])? != expected_kind
        || decoded[42..74] != expected_query_hash
    {
        return Err(PluginQueryError::InvalidInput);
    }
    let issued_at = read_u64(&decoded[2..10])?;
    let expires_at = read_u64(&decoded[10..18])?;
    let revision = read_u64(&decoded[18..26])?;
    if revision > i64::MAX as u64 || issued_at.checked_add(CURSOR_TTL_SECONDS) != Some(expires_at) {
        return Err(PluginQueryError::InvalidInput);
    }
    if now < issued_at || now >= expires_at {
        return Err(PluginQueryError::CursorStale);
    }
    let event_epoch = canonical_uuid_string(&decoded[26..42])?;
    let last_id = canonical_uuid_string(&decoded[74..90])?;
    Ok(CursorAuthority {
        revision,
        event_epoch,
        last_id,
    })
}

fn read_u64(bytes: &[u8]) -> Result<u64, PluginQueryError> {
    let bytes: [u8; 8] = bytes
        .try_into()
        .map_err(|_| PluginQueryError::InvalidInput)?;
    Ok(u64::from_be_bytes(bytes))
}

fn canonical_uuid_bytes(value: &str) -> Result<[u8; 16], PluginQueryError> {
    if value.len() != 36 {
        return Err(PluginQueryError::InvalidInput);
    }
    let bytes = value.as_bytes();
    if bytes[8] != b'-' || bytes[13] != b'-' || bytes[18] != b'-' || bytes[23] != b'-' {
        return Err(PluginQueryError::InvalidInput);
    }
    let mut decoded = [0_u8; 16];
    let mut source = 0;
    for target in &mut decoded {
        while matches!(source, 8 | 13 | 18 | 23) {
            source += 1;
        }
        let high = hex_nibble(bytes[source])?;
        let low = hex_nibble(bytes[source + 1])?;
        *target = (high << 4) | low;
        source += 2;
    }
    if canonical_uuid_string(&decoded)? != value {
        return Err(PluginQueryError::InvalidInput);
    }
    Ok(decoded)
}

fn canonical_uuid_string(bytes: &[u8]) -> Result<String, PluginQueryError> {
    let bytes: &[u8; 16] = bytes
        .try_into()
        .map_err(|_| PluginQueryError::InvalidInput)?;
    let mut output = String::with_capacity(36);
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 4 | 6 | 8 | 10) {
            output.push('-');
        }
        output.push(hex_digit(byte >> 4));
        output.push(hex_digit(byte & 0x0f));
    }
    Ok(output)
}

fn hex_nibble(byte: u8) -> Result<u8, PluginQueryError> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        _ => Err(PluginQueryError::InvalidInput),
    }
}

fn hex_digit(value: u8) -> char {
    char::from(if value < 10 {
        b'0' + value
    } else {
        b'a' + value - 10
    })
}

fn base64url_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut output = String::with_capacity(bytes.len().saturating_mul(4).div_ceil(3));
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        output.push(char::from(ALPHABET[usize::from(first >> 2)]));
        output.push(char::from(
            ALPHABET[usize::from(((first & 0x03) << 4) | (second >> 4))],
        ));
        if chunk.len() > 1 {
            output.push(char::from(
                ALPHABET[usize::from(((second & 0x0f) << 2) | (third >> 6))],
            ));
        }
        if chunk.len() > 2 {
            output.push(char::from(ALPHABET[usize::from(third & 0x3f)]));
        }
    }
    output
}

fn base64url_decode(value: &str) -> Result<Vec<u8>, PluginQueryError> {
    if value.contains('=') || value.len() % 4 == 1 {
        return Err(PluginQueryError::InvalidInput);
    }
    let mut output = Vec::with_capacity(value.len().saturating_mul(3) / 4);
    for chunk in value.as_bytes().chunks(4) {
        let a = base64_value(chunk[0])?;
        let b = base64_value(chunk[1])?;
        output.push((a << 2) | (b >> 4));
        if chunk.len() > 2 {
            let c = base64_value(chunk[2])?;
            output.push((b << 4) | (c >> 2));
            if chunk.len() > 3 {
                let d = base64_value(chunk[3])?;
                output.push((c << 6) | d);
            }
        }
    }
    Ok(output)
}

fn base64_value(byte: u8) -> Result<u8, PluginQueryError> {
    match byte {
        b'A'..=b'Z' => Ok(byte - b'A'),
        b'a'..=b'z' => Ok(byte - b'a' + 26),
        b'0'..=b'9' => Ok(byte - b'0' + 52),
        b'-' => Ok(62),
        b'_' => Ok(63),
        _ => Err(PluginQueryError::InvalidInput),
    }
}

fn push_text_bind(sql: &mut String, binds: &mut Vec<Value>, value: String) {
    binds.push(Value::Text(value));
    sql.push('?');
}

#[cfg(test)]
#[path = "plugin_query_tests.rs"]
mod tests;
