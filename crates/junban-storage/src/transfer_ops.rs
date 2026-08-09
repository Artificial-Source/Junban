//! Import preview and atomic apply for transfer formats.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs::{self, File, OpenOptions},
    io::Write,
    path::Path,
};

use jiff::Timestamp;
use junban_app::{
    AffectedIds, CommittedMutation, EventType, ExportFormat, RepositoryError, ResyncScope,
    StagedFile,
};
use junban_domain::{
    EntityName, HexColor, MAX_BULK_IDS, OperationId, Project, ProjectId, SortOrder, Tag, TagId,
    TagName, Task, TaskActivityAction, TaskDraft, TaskId, TransferApply, TransferFormat,
    TransferPreview, draft_to_task_fields, preview_transfer,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

use crate::helpers::{validate_task_refs, validation};
use crate::ops_types::{Inverse, post_from_tasks, undo_pair};
use crate::rows::{
    field_activity, insert_task, load_project, load_tag, normalize_tag_name, storage_error,
    task_from_row,
};
use crate::tx::{MutationEffect, canonical_json, mutate};
use crate::{ensure_private_dir, set_private_file_permissions};

/// Default color for projects/tags created during import when none is provided.
const IMPORT_DEFAULT_COLOR: &str = "#6b7280";

#[derive(Serialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Req<'a> {
    ApplyImport {
        format: TransferFormat,
        fingerprint: &'a str,
        project_name_mapping: &'a [(String, String)],
        tag_name_mapping: &'a [(String, String)],
    },
}

pub(crate) fn preview_import(
    _connection: &Connection,
    format: TransferFormat,
    content: &str,
) -> Result<TransferPreview, RepositoryError> {
    preview_transfer(format, content).map_err(map_transfer)
}

pub(crate) fn apply_import(
    connection: &mut Connection,
    operation_id: OperationId,
    apply: TransferApply,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::ApplyImport {
        format: apply.format,
        fingerprint: &apply.fingerprint,
        project_name_mapping: &apply.project_name_mapping,
        tag_name_mapping: &apply.tag_name_mapping,
    })?;
    // Content is intentionally excluded from the canonical receipt request so exact
    // retries with the same operation id and fingerprint replay without re-hashing
    // multi-megabyte payloads into the receipt key. The fingerprint binds content.
    mutate(
        connection,
        operation_id,
        request,
        now,
        move |tx, revision| {
            let preview = preview_transfer(apply.format, &apply.content).map_err(map_transfer)?;
            if preview.content_fingerprint != apply.fingerprint {
                return Err(RepositoryError::Conflict);
            }
            if preview.drafts.len() > MAX_BULK_IDS {
                return Err(RepositoryError::OperationTooLarge);
            }

            let project_map = mapping_table(&apply.project_name_mapping);
            let tag_map = mapping_table(&apply.tag_name_mapping);

            let mut project_ids_by_name: HashMap<String, ProjectId> = HashMap::new();
            let mut created_projects = Vec::new();
            for original in &preview.project_names {
                let resolved = project_map
                    .get(original.as_str())
                    .map(String::as_str)
                    .unwrap_or(original.as_str());
                let (id, created) = ensure_project_named(tx, resolved, now)?;
                project_ids_by_name.insert(original.clone(), id);
                // Also index by resolved name so drafts that already carry the mapped name work.
                project_ids_by_name.insert(resolved.to_owned(), id);
                if created {
                    created_projects.push(load_project(tx, id)?);
                }
            }

            let mut tag_ids_by_name: HashMap<String, TagId> = HashMap::new();
            let mut created_tags = Vec::new();
            for original in &preview.tag_names {
                let resolved = tag_map
                    .get(original.as_str())
                    .map(String::as_str)
                    .unwrap_or(original.as_str());
                let (id, created) = ensure_tag_named(tx, resolved, now)?;
                tag_ids_by_name.insert(original.clone(), id);
                tag_ids_by_name.insert(resolved.to_owned(), id);
                if created {
                    created_tags.push(load_tag(tx, id)?);
                }
            }

            let mut created_tasks = Vec::with_capacity(preview.drafts.len());
            let mut activity = Vec::with_capacity(preview.drafts.len());
            for (index, draft) in preview.drafts.iter().enumerate() {
                let (title, description, priority, due_date) =
                    draft_to_task_fields(draft).map_err(map_transfer)?;
                let project_id = draft
                    .project_name
                    .as_ref()
                    .map(|name| name.trim())
                    .filter(|name| !name.is_empty())
                    .and_then(|name| {
                        let resolved = project_map.get(name).map(String::as_str).unwrap_or(name);
                        project_ids_by_name
                            .get(name)
                            .or_else(|| project_ids_by_name.get(resolved))
                            .copied()
                    });
                let mut tag_ids = Vec::new();
                for name in &draft.tag_names {
                    let trimmed = name.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let resolved = tag_map.get(trimmed).map(String::as_str).unwrap_or(trimmed);
                    if let Some(id) = tag_ids_by_name
                        .get(trimmed)
                        .or_else(|| tag_ids_by_name.get(resolved))
                        .copied()
                        && !tag_ids.contains(&id)
                    {
                        tag_ids.push(id);
                    }
                }

                let mut task_draft = TaskDraft::new(title);
                task_draft.description = description;
                task_draft.priority = priority;
                task_draft.due_date = due_date;
                task_draft.project_id = project_id;
                task_draft.tag_ids = tag_ids;
                task_draft.sort_order = SortOrder::new(i64::try_from(index).unwrap_or(i64::MAX));

                let task_id = TaskId::new();
                let task =
                    Task::from_draft(task_id, task_draft, now, revision).map_err(validation)?;
                validate_task_refs(tx, &task)?;
                insert_task(tx, &task)?;
                activity.push(field_activity(
                    revision,
                    u32::try_from(index).unwrap_or(0),
                    operation_id,
                    task.id,
                    TaskActivityAction::Created,
                    Some("import"),
                    None,
                    Some(apply.format.as_str().to_owned()),
                    now,
                ));
                created_tasks.push(task);
            }

            if created_tasks.len() > MAX_BULK_IDS {
                return Err(RepositoryError::OperationTooLarge);
            }

            let task_ids: Vec<TaskId> = created_tasks.iter().map(|task| task.id).collect();
            let mut post = post_from_tasks(created_tasks);
            for project in &created_projects {
                post.projects
                    .insert(project.id.to_string(), project.clone());
            }
            for tag in &created_tags {
                post.tags.insert(tag.id.to_string(), tag.clone());
            }
            let undo = undo_pair(
                &Inverse::DeleteImport {
                    task_ids: task_ids.clone(),
                    projects: created_projects.clone(),
                    tags: created_tags.clone(),
                },
                &post,
            )?;
            let created_project_ids = created_projects.iter().map(|item| item.id).collect();
            let created_tag_ids = created_tags.iter().map(|item| item.id).collect();

            Ok(MutationEffect {
                event_type: EventType::new(EventType::IMPORT_APPLIED),
                primary: None,
                snapshot: None,
                affected: AffectedIds {
                    task_ids,
                    project_ids: created_project_ids,
                    tag_ids: created_tag_ids,
                    ..AffectedIds::default()
                },
                resync: ResyncScope::BOTH,
                task_activity: activity,
                summary_subject: Some(("import".into(), apply.fingerprint.clone())),
                undo: Some(undo),
                mark_undone: None,
                uncomplete_outcome: None,
            })
        },
    )
}

const EXPORT_PAGE_SIZE: usize = 128;

/// Serialize the complete transferable task set into a cleanup-owning staged file.
pub(crate) fn create_export(
    connection: &Connection,
    profile_dir: &Path,
    format: ExportFormat,
) -> Result<StagedFile, RepositoryError> {
    let transfer_dir = profile_dir.join("transfers");
    ensure_private_dir(&transfer_dir).map_err(storage_error)?;
    let extension = match format {
        ExportFormat::Json => "json",
        ExportFormat::Csv => "csv",
        ExportFormat::Markdown => "md",
    };
    let path = transfer_dir.join(format!(".export-{}.{}", TaskId::new().as_uuid(), extension));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(storage_error)?;
    if let Err(error) = set_private_file_permissions(&path) {
        let _ = fs::remove_file(&path);
        return Err(storage_error(error));
    }

    let result = match format {
        ExportFormat::Json => write_json_export(connection, &mut file),
        ExportFormat::Csv => write_csv_export(connection, &mut file),
        ExportFormat::Markdown => write_markdown_export(connection, &mut file),
    }
    .map(|_| ())
    .and_then(|()| file.sync_all().map_err(storage_error));
    if let Err(error) = result {
        let _ = fs::remove_file(&path);
        return Err(error);
    }
    let len = file.metadata().map_err(storage_error)?.len();
    Ok(StagedFile::new(path, len))
}

fn write_json_export(connection: &Connection, writer: &mut File) -> Result<usize, RepositoryError> {
    writer
        .write_all(b"{\n  \"format\": \"junban_tasks\",\n  \"projects\": [")
        .map_err(storage_error)?;
    write_used_names(
        connection,
        writer,
        "SELECT DISTINCT p.name FROM projects p JOIN tasks t ON t.project_id = p.id ORDER BY p.name",
    )?;
    writer
        .write_all(b"\n  ],\n  \"tags\": [")
        .map_err(storage_error)?;
    write_used_names(
        connection,
        writer,
        "SELECT DISTINCT g.name FROM tags g JOIN task_tags tt ON tt.tag_id = g.id ORDER BY g.name",
    )?;
    writer
        .write_all(b"\n  ],\n  \"tasks\": [")
        .map_err(storage_error)?;

    let mut first = true;
    let pages = for_each_task_page(connection, |tasks, project_names, tag_names| {
        for task in tasks {
            if first {
                first = false;
            } else {
                writer.write_all(b",").map_err(storage_error)?;
            }
            writer.write_all(b"\n    ").map_err(storage_error)?;
            let entry = json_task_entry(task, project_names, tag_names);
            serde_json::to_writer(&mut *writer, &entry).map_err(storage_error)?;
        }
        Ok(())
    })?;
    writer
        .write_all(b"\n  ],\n  \"version\": 1\n}\n")
        .map_err(storage_error)?;
    Ok(pages)
}

fn write_used_names(
    connection: &Connection,
    writer: &mut File,
    sql: &str,
) -> Result<(), RepositoryError> {
    let mut statement = connection.prepare(sql).map_err(storage_error)?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(storage_error)?;
    let mut first = true;
    for name in names {
        if first {
            first = false;
        } else {
            writer.write_all(b",").map_err(storage_error)?;
        }
        writer.write_all(b"\n    ").map_err(storage_error)?;
        serde_json::to_writer(
            &mut *writer,
            &serde_json::json!({ "name": name.map_err(storage_error)? }),
        )
        .map_err(storage_error)?;
    }
    Ok(())
}

fn json_task_entry(
    task: &Task,
    project_names: &BTreeMap<ProjectId, String>,
    tag_names: &BTreeMap<TagId, String>,
) -> serde_json::Value {
    let mut entry = serde_json::Map::new();
    entry.insert(
        "title".into(),
        serde_json::Value::String(task.title.as_str().to_owned()),
    );
    if !task.description.is_empty() {
        entry.insert(
            "description".into(),
            serde_json::Value::String(task.description.as_str().to_owned()),
        );
    }
    if let Some(priority) = task.priority {
        entry.insert(
            "priority".into(),
            serde_json::Value::Number(priority.get().into()),
        );
    }
    if let Some(due) = task.due_date {
        entry.insert(
            "due_date".into(),
            serde_json::Value::String(due.to_string()),
        );
    }
    if let Some(name) = task.project_id.and_then(|id| project_names.get(&id)) {
        entry.insert("project".into(), serde_json::Value::String(name.clone()));
    }
    let names = task
        .tag_ids
        .iter()
        .filter_map(|id| tag_names.get(id).cloned())
        .map(serde_json::Value::String)
        .collect::<Vec<_>>();
    if !names.is_empty() {
        entry.insert("tags".into(), serde_json::Value::Array(names));
    }
    serde_json::Value::Object(entry)
}

fn write_csv_export(connection: &Connection, writer: &mut File) -> Result<usize, RepositoryError> {
    writer
        .write_all(b"title,description,priority,due_date,project,tags\n")
        .map_err(storage_error)?;
    for_each_task_page(connection, |tasks, project_names, tag_names| {
        for task in tasks {
            let priority = task
                .priority
                .map(|value| value.get().to_string())
                .unwrap_or_default();
            let due = task
                .due_date
                .map(|value| value.to_string())
                .unwrap_or_default();
            let project = task
                .project_id
                .and_then(|id| project_names.get(&id))
                .map(String::as_str)
                .unwrap_or_default();
            let tags = task
                .tag_ids
                .iter()
                .filter_map(|id| tag_names.get(id).map(String::as_str))
                .collect::<Vec<_>>()
                .join(",");
            write_csv_row(
                writer,
                &[
                    task.title.as_str(),
                    task.description.as_str(),
                    &priority,
                    &due,
                    project,
                    &tags,
                ],
            )?;
        }
        Ok(())
    })
}

fn write_csv_row(writer: &mut File, fields: &[&str]) -> Result<(), RepositoryError> {
    for (index, field) in fields.iter().enumerate() {
        if index > 0 {
            writer.write_all(b",").map_err(storage_error)?;
        }
        let quote = field.contains([',', '"', '\n', '\r']);
        if quote {
            writer.write_all(b"\"").map_err(storage_error)?;
            writer
                .write_all(field.replace('"', "\"\"").as_bytes())
                .map_err(storage_error)?;
            writer.write_all(b"\"").map_err(storage_error)?;
        } else {
            writer.write_all(field.as_bytes()).map_err(storage_error)?;
        }
    }
    writer.write_all(b"\n").map_err(storage_error)
}

fn write_markdown_export(
    connection: &Connection,
    writer: &mut File,
) -> Result<usize, RepositoryError> {
    for_each_task_page(connection, |tasks, _, _| {
        for task in tasks {
            let mark = match task.status {
                junban_domain::TaskStatus::Completed => "x",
                junban_domain::TaskStatus::Pending | junban_domain::TaskStatus::Cancelled => " ",
            };
            writeln!(writer, "- [{mark}] {}", task.title.as_str()).map_err(storage_error)?;
            if !task.description.is_empty() {
                for line in task.description.as_str().lines() {
                    writeln!(writer, "  {line}").map_err(storage_error)?;
                }
            }
        }
        Ok(())
    })
}

fn for_each_task_page(
    connection: &Connection,
    mut visit: impl FnMut(
        &[Task],
        &BTreeMap<ProjectId, String>,
        &BTreeMap<TagId, String>,
    ) -> Result<(), RepositoryError>,
) -> Result<usize, RepositoryError> {
    let mut offset = 0usize;
    let mut pages = 0usize;
    loop {
        let mut tasks = load_task_page(connection, offset)?;
        if tasks.is_empty() {
            return Ok(pages);
        }
        pages += 1;
        let project_names = load_page_project_names(connection, &tasks)?;
        let tag_names = load_page_tag_data(connection, &mut tasks)?;
        visit(&tasks, &project_names, &tag_names)?;
        offset += tasks.len();
        if tasks.len() < EXPORT_PAGE_SIZE {
            return Ok(pages);
        }
    }
}

fn load_task_page(connection: &Connection, offset: usize) -> Result<Vec<Task>, RepositoryError> {
    let mut statement = connection
        .prepare(
            "SELECT id, title, description, due_date, due_time, due_timezone, deadline,
                    status, priority, dread, estimated_minutes, actual_minutes,
                    project_id, section_id, parent_id, sort_order, recurrence_rule, someday,
                    completed_at, cancelled_at, created_at, updated_at, revision,
                    remind_at, recurrence_anchor_day, recurrence_source_id, completion_operation_id
             FROM tasks ORDER BY sort_order, id LIMIT ?1 OFFSET ?2",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map(
            params![
                EXPORT_PAGE_SIZE as i64,
                i64::try_from(offset).unwrap_or(i64::MAX)
            ],
            task_from_row,
        )
        .map_err(storage_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)
}

fn load_page_project_names(
    connection: &Connection,
    tasks: &[Task],
) -> Result<BTreeMap<ProjectId, String>, RepositoryError> {
    let ids = tasks
        .iter()
        .filter_map(|task| task.project_id)
        .collect::<BTreeSet<_>>();
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let placeholders = vec!["?"; ids.len()].join(",");
    let sql = format!("SELECT id, name FROM projects WHERE id IN ({placeholders})");
    let values = ids.iter().map(ToString::to_string).collect::<Vec<_>>();
    let mut statement = connection.prepare(&sql).map_err(storage_error)?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(&values), |row| {
            let id: String = row.get(0)?;
            let name: String = row.get(1)?;
            Ok((
                ProjectId::parse(&id).map_err(crate::rows::invalid_sql)?,
                name,
            ))
        })
        .map_err(storage_error)?;
    rows.collect::<Result<BTreeMap<_, _>, _>>()
        .map_err(storage_error)
}

fn load_page_tag_data(
    connection: &Connection,
    tasks: &mut [Task],
) -> Result<BTreeMap<TagId, String>, RepositoryError> {
    if tasks.is_empty() {
        return Ok(BTreeMap::new());
    }
    let placeholders = vec!["?"; tasks.len()].join(",");
    let sql = format!(
        "SELECT tt.task_id, tt.tag_id, g.name
         FROM task_tags tt JOIN tags g ON g.id = tt.tag_id
         WHERE tt.task_id IN ({placeholders}) ORDER BY tt.task_id, tt.rowid"
    );
    let values = tasks
        .iter()
        .map(|task| task.id.to_string())
        .collect::<Vec<_>>();
    let mut statement = connection.prepare(&sql).map_err(storage_error)?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(&values), |row| {
            let task_id: String = row.get(0)?;
            let tag_id: String = row.get(1)?;
            let name: String = row.get(2)?;
            Ok((
                TaskId::parse(&task_id).map_err(crate::rows::invalid_sql)?,
                TagId::parse(&tag_id).map_err(crate::rows::invalid_sql)?,
                name,
            ))
        })
        .map_err(storage_error)?;
    let mut names = BTreeMap::new();
    let mut tags_by_task: HashMap<TaskId, Vec<TagId>> = HashMap::new();
    for row in rows {
        let (task_id, tag_id, name) = row.map_err(storage_error)?;
        tags_by_task.entry(task_id).or_default().push(tag_id);
        names.insert(tag_id, name);
    }
    for task in tasks {
        task.tag_ids = tags_by_task.remove(&task.id).unwrap_or_default();
    }
    Ok(names)
}

fn mapping_table(pairs: &[(String, String)]) -> HashMap<String, String> {
    let mut map = HashMap::with_capacity(pairs.len());
    for (from, to) in pairs {
        let from = from.trim();
        let to = to.trim();
        if !from.is_empty() && !to.is_empty() {
            map.insert(from.to_owned(), to.to_owned());
        }
    }
    map
}

fn ensure_project_named(
    tx: &Connection,
    name: &str,
    now: Timestamp,
) -> Result<(ProjectId, bool), RepositoryError> {
    let existing: Option<String> = tx
        .query_row(
            "SELECT id FROM projects WHERE lower(name) = lower(?1) LIMIT 1",
            [name],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    if let Some(id) = existing {
        return Ok((ProjectId::parse(&id).map_err(storage_error)?, false));
    }
    let entity_name = EntityName::new(name.to_owned()).map_err(validation)?;
    let color = HexColor::new(IMPORT_DEFAULT_COLOR.to_owned()).map_err(validation)?;
    let project = Project::new(ProjectId::new(), entity_name, color, now);
    tx.execute(
        "INSERT INTO projects(id,name,color,icon,parent_id,favorite,archived,view_style,sort_order,created_at,updated_at)
         VALUES (?1,?2,?3,NULL,NULL,0,0,'list',?4,?5,?6)",
        params![
            project.id.to_string(),
            project.name.as_str(),
            project.color.as_str(),
            project.sort_order.get(),
            project.created_at.to_string(),
            project.updated_at.to_string(),
        ],
    )
    .map_err(storage_error)?;
    Ok((project.id, true))
}

fn ensure_tag_named(
    tx: &Connection,
    name: &str,
    now: Timestamp,
) -> Result<(TagId, bool), RepositoryError> {
    let normalized = normalize_tag_name(name);
    let existing: Option<String> = tx
        .query_row(
            "SELECT id FROM tags WHERE name_normalized = ?1",
            [normalized.as_str()],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    if let Some(id) = existing {
        return Ok((TagId::parse(&id).map_err(storage_error)?, false));
    }
    let tag_name = TagName::new(name.to_owned()).map_err(validation)?;
    let color = HexColor::new(IMPORT_DEFAULT_COLOR.to_owned()).map_err(validation)?;
    let tag = Tag::new(TagId::new(), tag_name, color, now);
    tx.execute(
        "INSERT INTO tags(id,name,name_normalized,color,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6)",
        params![
            tag.id.to_string(),
            tag.name.as_str(),
            normalize_tag_name(tag.name.as_str()),
            tag.color.as_str(),
            tag.created_at.to_string(),
            tag.updated_at.to_string(),
        ],
    )
    .map_err(storage_error)?;
    Ok((tag.id, true))
}

fn map_transfer(error: junban_domain::TransferError) -> RepositoryError {
    match error {
        junban_domain::TransferError::ValidationError(error) => RepositoryError::Validation(error),
        junban_domain::TransferError::UnsupportedFormat => {
            RepositoryError::Validation(junban_domain::ValidationError::Invalid {
                field: "format",
                reason: "unsupported transfer format",
            })
        }
        junban_domain::TransferError::ParseError { .. } => {
            RepositoryError::Validation(junban_domain::ValidationError::Invalid {
                field: "content",
                reason: "invalid transfer content",
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ProfileOwner;
    use junban_app::Repository;
    use junban_domain::{OperationId, TaskTitle, content_fingerprint};
    use std::{
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    struct TempDir(PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn repository() -> (TempDir, ProfileOwner, crate::SqliteRepository) {
        let path = std::env::temp_dir().join(format!(
            "junban-transfer-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let owner = ProfileOwner::open(&path).unwrap();
        let repository = owner.repository();
        (TempDir(path), owner, repository)
    }

    fn operation_id() -> OperationId {
        OperationId::parse(&uuid::Uuid::new_v4().to_string()).unwrap()
    }

    fn apply(content: String) -> TransferApply {
        TransferApply {
            format: TransferFormat::Json,
            fingerprint: content_fingerprint(&content),
            content,
            project_name_mapping: Vec::new(),
            tag_name_mapping: Vec::new(),
        }
    }

    #[tokio::test]
    async fn import_undo_removes_only_import_owned_catalog_resources() {
        let (_dir, _owner, repo) = repository();
        let content = r#"{"tasks":[{"title":"Imported","project":"Imported Project","tags":["Imported Tag"]}]}"#.to_owned();
        let imported = repo
            .apply_import(operation_id(), apply(content), Timestamp::now())
            .await
            .unwrap();
        let task_id = imported.event.affected.task_ids[0];
        assert_eq!(repo.list_catalog().await.unwrap().projects.len(), 1);
        assert_eq!(repo.list_catalog().await.unwrap().tags.len(), 1);

        repo.undo(
            imported.event.operation_id,
            operation_id(),
            Timestamp::now(),
        )
        .await
        .unwrap();
        assert!(matches!(
            repo.get_task(task_id).await,
            Err(RepositoryError::NotFound)
        ));
        let catalog = repo.list_catalog().await.unwrap();
        assert!(catalog.projects.is_empty());
        assert!(catalog.tags.is_empty());
    }

    #[tokio::test]
    async fn import_undo_rejects_reused_catalog_resource_without_partial_deletion() {
        let (_dir, _owner, repo) = repository();
        let content = r#"{"tasks":[{"title":"Imported","project":"Shared"}]}"#.to_owned();
        let imported = repo
            .apply_import(operation_id(), apply(content), Timestamp::now())
            .await
            .unwrap();
        let imported_task_id = imported.event.affected.task_ids[0];
        let project_id = imported.event.affected.project_ids[0];
        let mut draft = TaskDraft::new(TaskTitle::new("Later task").unwrap());
        draft.project_id = Some(project_id);
        let later_id = TaskId::new();
        repo.create_task(operation_id(), later_id, draft, Timestamp::now())
            .await
            .unwrap();

        let error = repo
            .undo(
                imported.event.operation_id,
                operation_id(),
                Timestamp::now(),
            )
            .await
            .unwrap_err();
        assert!(matches!(error, RepositoryError::Conflict));
        assert!(repo.get_task(imported_task_id).await.is_ok());
        assert!(repo.get_task(later_id).await.is_ok());
        assert_eq!(repo.list_catalog().await.unwrap().projects.len(), 1);
    }

    #[tokio::test]
    async fn import_late_catalog_validation_failure_is_atomic() {
        let (_dir, _owner, repo) = repository();
        let invalid_name = "z".repeat(300);
        let content = format!(
            r#"{{"tasks":[{{"title":"First","project":"A valid project"}},{{"title":"Second","project":"{invalid_name}"}}]}}"#
        );
        let error = repo
            .apply_import(operation_id(), apply(content), Timestamp::now())
            .await
            .unwrap_err();
        assert!(matches!(error, RepositoryError::Validation(_)));
        let catalog = repo.list_catalog().await.unwrap();
        assert!(catalog.projects.is_empty());
    }
}
