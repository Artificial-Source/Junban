//! Project, section, tag, template, and saved-filter operations.

use jiff::Timestamp;
use junban_app::{
    AffectedIds, CatalogSnapshot, CommittedMutation, EventType, ProjectDraft, ProjectPatch,
    RepositoryError, ResourceRef, ResourceSnapshot, ResyncScope, SavedFilterDraft,
    SavedFilterPatch, SectionDraft, SectionPatch, TagDraft, TagPatch, TemplateApply, TemplateDraft,
    TemplatePatch,
};
use junban_domain::{
    MAX_BULK_IDS, MarkdownText, OperationId, Project, ProjectId, SavedFilter, SavedFilterId,
    Section, SectionId, Tag, TagId, TagName, Task, TaskActivityAction, TaskId, TaskTitle, Template,
    TemplateId, ValidationError, validate_project_parent_chain,
};
use rusqlite::{Connection, params};
use serde::Serialize;

use crate::helpers::{constraint_conflict, validate_task_refs, validation};
use crate::ops_types::{Inverse, post_from_tasks, undo_pair};
use crate::rows::{
    ensure_project_exists, field_activity, insert_task, load_project, load_project_parent_edges,
    load_saved_filter, load_section, load_tag, load_task, load_template, normalize_tag_name,
    parse_sql, resolve_tag_names, storage_error, update_task_row, view_style_str,
};
use crate::tx::{MutationEffect, canonical_json, global_revision, mutate};

#[derive(Serialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Req<'a> {
    // Server-generated create IDs are intentionally excluded from canonical identity
    // so retries/replays reuse the stored response ID rather than the freshly minted one.
    CreateProject {
        draft: &'a ProjectDraft,
    },
    PatchProject {
        project_id: String,
        patch: &'a ProjectPatch,
    },
    DeleteProject {
        project_id: String,
    },
    CreateSection {
        draft: &'a SectionDraft,
    },
    PatchSection {
        section_id: String,
        patch: &'a SectionPatch,
    },
    DeleteSection {
        section_id: String,
    },
    CreateTag {
        draft: &'a TagDraft,
    },
    PatchTag {
        tag_id: String,
        patch: &'a TagPatch,
    },
    DeleteTag {
        tag_id: String,
    },
    CreateTemplate {
        draft: &'a TemplateDraft,
    },
    PatchTemplate {
        template_id: String,
        patch: &'a TemplatePatch,
    },
    DeleteTemplate {
        template_id: String,
    },
    ApplyTemplate {
        apply: &'a TemplateApply,
    },
    CreateSavedFilter {
        draft: &'a SavedFilterDraft,
    },
    PatchSavedFilter {
        filter_id: String,
        patch: &'a SavedFilterPatch,
    },
    DeleteSavedFilter {
        filter_id: String,
    },
}

fn catalog_effect(
    event_type: &'static str,
    primary: ResourceRef,
    snapshot: Option<ResourceSnapshot>,
    affected: AffectedIds,
    subject: (&str, String),
) -> MutationEffect {
    MutationEffect {
        event_type: EventType::new(event_type),
        primary: Some(primary),
        snapshot,
        affected,
        resync: ResyncScope::CATALOG,
        task_activity: Vec::new(),
        summary_subject: Some((subject.0.into(), subject.1)),
        undo: None,
        mark_undone: None,
    }
}

pub(crate) fn list_catalog(connection: &Connection) -> Result<CatalogSnapshot, RepositoryError> {
    let revision = global_revision(connection)?;
    let tx = connection.unchecked_transaction().map_err(storage_error)?;
    let load_ids = |sql: &str| -> Result<Vec<String>, RepositoryError> {
        let mut statement = tx.prepare(sql).map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(storage_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(storage_error)
    };
    let mut projects = Vec::new();
    for id in load_ids("SELECT id FROM projects ORDER BY sort_order, id")? {
        projects.push(load_project(
            &tx,
            ProjectId::parse(&id).map_err(storage_error)?,
        )?);
    }
    let mut sections = Vec::new();
    for id in load_ids("SELECT id FROM sections ORDER BY sort_order, id")? {
        sections.push(load_section(
            &tx,
            SectionId::parse(&id).map_err(storage_error)?,
        )?);
    }
    let mut tags = Vec::new();
    for id in load_ids("SELECT id FROM tags ORDER BY name_normalized")? {
        tags.push(load_tag(&tx, TagId::parse(&id).map_err(storage_error)?)?);
    }
    let mut templates = Vec::new();
    for id in load_ids("SELECT id FROM templates ORDER BY sort_order, id")? {
        templates.push(load_template(
            &tx,
            TemplateId::parse(&id).map_err(storage_error)?,
        )?);
    }
    let mut saved_filters = Vec::new();
    for id in load_ids("SELECT id FROM saved_filters ORDER BY sort_order, id")? {
        saved_filters.push(load_saved_filter(
            &tx,
            SavedFilterId::parse(&id).map_err(storage_error)?,
        )?);
    }
    Ok(CatalogSnapshot {
        projects,
        sections,
        tags,
        templates,
        saved_filters,
        revision,
    })
}

pub(crate) fn create_project(
    c: &mut Connection,
    op: OperationId,
    project_id: ProjectId,
    draft: ProjectDraft,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::CreateProject { draft: &draft })?;
    mutate(c, op, request, now, move |tx, _| {
        if let Some(parent_id) = draft.parent_id {
            ensure_project_exists(tx, parent_id)?;
            let edges = load_project_parent_edges(tx)?;
            validate_project_parent_chain(project_id, Some(parent_id), &edges).map_err(|e| {
                if matches!(e, ValidationError::Cycle { .. }) {
                    RepositoryError::Conflict
                } else {
                    validation(e)
                }
            })?;
        }
        let project = Project {
            id: project_id,
            name: draft.name,
            color: draft.color,
            icon: draft.icon,
            parent_id: draft.parent_id,
            favorite: draft.favorite,
            archived: draft.archived,
            view: draft.view,
            sort_order: draft.sort_order,
            created_at: now,
            updated_at: now,
        };
        tx.execute(
            "INSERT INTO projects(id,name,color,icon,parent_id,favorite,archived,view_style,sort_order,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                project.id.to_string(),
                project.name.as_str(),
                project.color.as_str(),
                project.icon.as_ref().map(|i| i.as_str()),
                project.parent_id.map(|id| id.to_string()),
                i64::from(project.favorite),
                i64::from(project.archived),
                view_style_str(project.view),
                project.sort_order.get(),
                project.created_at.to_string(),
                project.updated_at.to_string(),
            ],
        )
        .map_err(constraint_conflict)?;
        Ok(catalog_effect(
            EventType::PROJECT_CREATED,
            ResourceRef::project(project.id),
            Some(ResourceSnapshot::Project {
                project: project.clone(),
            }),
            AffectedIds {
                project_ids: vec![project.id],
                ..AffectedIds::default()
            },
            ("project", project.id.to_string()),
        ))
    })
}

pub(crate) fn patch_project(
    c: &mut Connection,
    op: OperationId,
    project_id: ProjectId,
    patch: ProjectPatch,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::PatchProject {
        project_id: project_id.to_string(),
        patch: &patch,
    })?;
    mutate(c, op, request, now, move |tx, _| {
        let mut project = load_project(tx, project_id)?;
        if let Some(name) = patch.name {
            project.name = name;
        }
        if let Some(color) = patch.color {
            project.color = color;
        }
        if let Some(icon) = patch.icon {
            project.icon = icon;
        }
        if let Some(parent_id) = patch.parent_id {
            let edges = load_project_parent_edges(tx)?;
            validate_project_parent_chain(project_id, parent_id, &edges).map_err(|e| {
                if matches!(
                    e,
                    ValidationError::Cycle { .. } | ValidationError::Invalid { .. }
                ) {
                    RepositoryError::Conflict
                } else {
                    validation(e)
                }
            })?;
            if let Some(parent_id) = parent_id {
                ensure_project_exists(tx, parent_id)?;
            }
            project.parent_id = parent_id;
        }
        if let Some(favorite) = patch.favorite {
            project.favorite = favorite;
        }
        if let Some(archived) = patch.archived {
            project.archived = archived;
        }
        if let Some(view) = patch.view {
            project.view = view;
        }
        if let Some(sort_order) = patch.sort_order {
            project.sort_order = sort_order;
        }
        project.updated_at = now;
        tx.execute(
            "UPDATE projects SET name=?1,color=?2,icon=?3,parent_id=?4,favorite=?5,archived=?6,view_style=?7,sort_order=?8,updated_at=?9 WHERE id=?10",
            params![
                project.name.as_str(),
                project.color.as_str(),
                project.icon.as_ref().map(|i| i.as_str()),
                project.parent_id.map(|id| id.to_string()),
                i64::from(project.favorite),
                i64::from(project.archived),
                view_style_str(project.view),
                project.sort_order.get(),
                project.updated_at.to_string(),
                project.id.to_string(),
            ],
        )
        .map_err(storage_error)?;
        Ok(catalog_effect(
            EventType::PROJECT_UPDATED,
            ResourceRef::project(project.id),
            Some(ResourceSnapshot::Project {
                project: project.clone(),
            }),
            AffectedIds {
                project_ids: vec![project.id],
                ..AffectedIds::default()
            },
            ("project", project.id.to_string()),
        ))
    })
}

fn load_task_ids_for_project(
    tx: &rusqlite::Transaction<'_>,
    project_id: ProjectId,
) -> Result<Vec<TaskId>, RepositoryError> {
    let mut statement = tx
        .prepare("SELECT id FROM tasks WHERE project_id = ?1 ORDER BY id")
        .map_err(storage_error)?;
    let rows = statement
        .query_map([project_id.to_string()], |row| {
            let id: String = row.get(0)?;
            parse_sql(id, TaskId::parse)
        })
        .map_err(storage_error)?;
    let mut ids = Vec::new();
    for row in rows {
        ids.push(row.map_err(storage_error)?);
        if ids.len() > MAX_BULK_IDS {
            return Err(RepositoryError::OperationTooLarge);
        }
    }
    Ok(ids)
}

fn load_task_ids_for_section(
    tx: &rusqlite::Transaction<'_>,
    section_id: SectionId,
) -> Result<Vec<TaskId>, RepositoryError> {
    let mut statement = tx
        .prepare("SELECT id FROM tasks WHERE section_id = ?1 ORDER BY id")
        .map_err(storage_error)?;
    let rows = statement
        .query_map([section_id.to_string()], |row| {
            let id: String = row.get(0)?;
            parse_sql(id, TaskId::parse)
        })
        .map_err(storage_error)?;
    let mut ids = Vec::new();
    for row in rows {
        ids.push(row.map_err(storage_error)?);
        if ids.len() > MAX_BULK_IDS {
            return Err(RepositoryError::OperationTooLarge);
        }
    }
    Ok(ids)
}

fn load_task_ids_for_tag(
    tx: &rusqlite::Transaction<'_>,
    tag_id: TagId,
) -> Result<Vec<TaskId>, RepositoryError> {
    let mut statement = tx
        .prepare("SELECT task_id FROM task_tags WHERE tag_id = ?1 ORDER BY task_id")
        .map_err(storage_error)?;
    let rows = statement
        .query_map([tag_id.to_string()], |row| {
            let id: String = row.get(0)?;
            parse_sql(id, TaskId::parse)
        })
        .map_err(storage_error)?;
    let mut ids = Vec::new();
    for row in rows {
        ids.push(row.map_err(storage_error)?);
        if ids.len() > MAX_BULK_IDS {
            return Err(RepositoryError::OperationTooLarge);
        }
    }
    Ok(ids)
}

pub(crate) fn delete_project(
    c: &mut Connection,
    op: OperationId,
    project_id: ProjectId,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::DeleteProject {
        project_id: project_id.to_string(),
    })?;
    mutate(c, op, request, now, move |tx, revision| {
        let project = load_project(tx, project_id)?;
        let task_ids = load_task_ids_for_project(tx, project_id)?;
        let mut section_ids = Vec::new();
        {
            let mut statement = tx
                .prepare("SELECT id FROM sections WHERE project_id = ?1")
                .map_err(storage_error)?;
            let rows = statement
                .query_map([project_id.to_string()], |row| {
                    let id: String = row.get(0)?;
                    parse_sql(id, SectionId::parse)
                })
                .map_err(storage_error)?;
            for row in rows {
                section_ids.push(row.map_err(storage_error)?);
            }
        }

        let mut activity = Vec::new();
        let mut seq = 0u32;
        for task_id in &task_ids {
            let before = load_task(tx, *task_id)?;
            let mut after = before.clone();
            after.project_id = None;
            after.section_id = None;
            after.updated_at = now;
            after.revision = revision;
            update_task_row(tx, &after)?;
            if before.project_id != after.project_id {
                activity.push(field_activity(
                    revision,
                    seq,
                    op,
                    after.id,
                    TaskActivityAction::Updated,
                    Some("project_id"),
                    before.project_id.map(|id| id.to_string()),
                    None,
                    now,
                ));
                seq = seq.saturating_add(1);
            }
            if before.section_id != after.section_id {
                activity.push(field_activity(
                    revision,
                    seq,
                    op,
                    after.id,
                    TaskActivityAction::Updated,
                    Some("section_id"),
                    before.section_id.map(|id| id.to_string()),
                    None,
                    now,
                ));
                seq = seq.saturating_add(1);
            }
        }

        // Child projects become roots under the deleted project's former parent.
        tx.execute(
            "UPDATE projects SET parent_id = ?1, updated_at = ?2 WHERE parent_id = ?3",
            params![
                project.parent_id.map(|id| id.to_string()),
                now.to_string(),
                project_id.to_string()
            ],
        )
        .map_err(storage_error)?;
        tx.execute(
            "DELETE FROM projects WHERE id = ?1",
            [project_id.to_string()],
        )
        .map_err(storage_error)?;
        Ok(MutationEffect {
            event_type: EventType::new(EventType::PROJECT_DELETED),
            primary: Some(ResourceRef::project(project_id)),
            snapshot: None,
            affected: AffectedIds {
                project_ids: vec![project_id],
                section_ids,
                task_ids,
                ..AffectedIds::default()
            },
            resync: ResyncScope::BOTH,
            task_activity: activity,
            summary_subject: Some(("project".into(), project_id.to_string())),
            undo: None,
            mark_undone: None,
        })
    })
}

pub(crate) fn create_section(
    c: &mut Connection,
    op: OperationId,
    section_id: SectionId,
    draft: SectionDraft,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::CreateSection { draft: &draft })?;
    mutate(c, op, request, now, move |tx, _| {
        ensure_project_exists(tx, draft.project_id)?;
        let section = Section {
            id: section_id,
            project_id: draft.project_id,
            name: draft.name,
            collapsed: draft.collapsed,
            sort_order: draft.sort_order,
            created_at: now,
            updated_at: now,
        };
        tx.execute(
            "INSERT INTO sections(id,project_id,name,collapsed,sort_order,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                section.id.to_string(),
                section.project_id.to_string(),
                section.name.as_str(),
                i64::from(section.collapsed),
                section.sort_order.get(),
                section.created_at.to_string(),
                section.updated_at.to_string(),
            ],
        )
        .map_err(constraint_conflict)?;
        Ok(catalog_effect(
            EventType::SECTION_CREATED,
            ResourceRef::section(section.id),
            Some(ResourceSnapshot::Section {
                section: section.clone(),
            }),
            AffectedIds {
                section_ids: vec![section.id],
                project_ids: vec![section.project_id],
                ..AffectedIds::default()
            },
            ("section", section.id.to_string()),
        ))
    })
}

pub(crate) fn patch_section(
    c: &mut Connection,
    op: OperationId,
    section_id: SectionId,
    patch: SectionPatch,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::PatchSection {
        section_id: section_id.to_string(),
        patch: &patch,
    })?;
    mutate(c, op, request, now, move |tx, _| {
        let mut section = load_section(tx, section_id)?;
        if let Some(name) = patch.name {
            section.name = name;
        }
        if let Some(collapsed) = patch.collapsed {
            section.collapsed = collapsed;
        }
        if let Some(sort_order) = patch.sort_order {
            section.sort_order = sort_order;
        }
        section.updated_at = now;
        tx.execute(
            "UPDATE sections SET name=?1, collapsed=?2, sort_order=?3, updated_at=?4 WHERE id=?5",
            params![
                section.name.as_str(),
                i64::from(section.collapsed),
                section.sort_order.get(),
                section.updated_at.to_string(),
                section.id.to_string(),
            ],
        )
        .map_err(storage_error)?;
        Ok(catalog_effect(
            EventType::SECTION_UPDATED,
            ResourceRef::section(section.id),
            Some(ResourceSnapshot::Section {
                section: section.clone(),
            }),
            AffectedIds {
                section_ids: vec![section.id],
                ..AffectedIds::default()
            },
            ("section", section.id.to_string()),
        ))
    })
}

pub(crate) fn delete_section(
    c: &mut Connection,
    op: OperationId,
    section_id: SectionId,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::DeleteSection {
        section_id: section_id.to_string(),
    })?;
    mutate(c, op, request, now, move |tx, revision| {
        let section = load_section(tx, section_id)?;
        let task_ids = load_task_ids_for_section(tx, section_id)?;
        let mut activity = Vec::new();
        for (index, task_id) in task_ids.iter().enumerate() {
            let before = load_task(tx, *task_id)?;
            let mut after = before.clone();
            after.section_id = None;
            after.updated_at = now;
            after.revision = revision;
            update_task_row(tx, &after)?;
            activity.push(field_activity(
                revision,
                u32::try_from(index).unwrap_or(u32::MAX),
                op,
                after.id,
                TaskActivityAction::Updated,
                Some("section_id"),
                before.section_id.map(|id| id.to_string()),
                None,
                now,
            ));
        }
        tx.execute(
            "DELETE FROM sections WHERE id = ?1",
            [section_id.to_string()],
        )
        .map_err(storage_error)?;
        Ok(MutationEffect {
            event_type: EventType::new(EventType::SECTION_DELETED),
            primary: Some(ResourceRef::section(section_id)),
            snapshot: None,
            affected: AffectedIds {
                section_ids: vec![section_id],
                project_ids: vec![section.project_id],
                task_ids,
                ..AffectedIds::default()
            },
            resync: ResyncScope::BOTH,
            task_activity: activity,
            summary_subject: Some(("section".into(), section_id.to_string())),
            undo: None,
            mark_undone: None,
        })
    })
}

pub(crate) fn create_tag(
    c: &mut Connection,
    op: OperationId,
    tag_id: TagId,
    draft: TagDraft,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::CreateTag { draft: &draft })?;
    mutate(c, op, request, now, move |tx, _| {
        let tag = Tag {
            id: tag_id,
            name: draft.name,
            color: draft.color,
            created_at: now,
            updated_at: now,
        };
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
        .map_err(constraint_conflict)?;
        Ok(catalog_effect(
            EventType::TAG_CREATED,
            ResourceRef::tag(tag.id),
            Some(ResourceSnapshot::Tag { tag: tag.clone() }),
            AffectedIds {
                tag_ids: vec![tag.id],
                ..AffectedIds::default()
            },
            ("tag", tag.id.to_string()),
        ))
    })
}

pub(crate) fn patch_tag(
    c: &mut Connection,
    op: OperationId,
    tag_id: TagId,
    patch: TagPatch,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::PatchTag {
        tag_id: tag_id.to_string(),
        patch: &patch,
    })?;
    mutate(c, op, request, now, move |tx, _| {
        let mut tag = load_tag(tx, tag_id)?;
        if let Some(name) = patch.name {
            tag.name = name;
        }
        if let Some(color) = patch.color {
            tag.color = color;
        }
        tag.updated_at = now;
        tx.execute(
            "UPDATE tags SET name=?1, name_normalized=?2, color=?3, updated_at=?4 WHERE id=?5",
            params![
                tag.name.as_str(),
                normalize_tag_name(tag.name.as_str()),
                tag.color.as_str(),
                tag.updated_at.to_string(),
                tag.id.to_string(),
            ],
        )
        .map_err(constraint_conflict)?;
        Ok(catalog_effect(
            EventType::TAG_UPDATED,
            ResourceRef::tag(tag.id),
            Some(ResourceSnapshot::Tag { tag: tag.clone() }),
            AffectedIds {
                tag_ids: vec![tag.id],
                ..AffectedIds::default()
            },
            ("tag", tag.id.to_string()),
        ))
    })
}

pub(crate) fn delete_tag(
    c: &mut Connection,
    op: OperationId,
    tag_id: TagId,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::DeleteTag {
        tag_id: tag_id.to_string(),
    })?;
    mutate(c, op, request, now, move |tx, revision| {
        let _ = load_tag(tx, tag_id)?;
        let task_ids = load_task_ids_for_tag(tx, tag_id)?;
        let mut activity = Vec::new();
        for (index, task_id) in task_ids.iter().enumerate() {
            let before = load_task(tx, *task_id)?;
            let mut after = before.clone();
            after.tag_ids.retain(|id| *id != tag_id);
            after.updated_at = now;
            after.revision = revision;
            update_task_row(tx, &after)?;
            activity.push(field_activity(
                revision,
                u32::try_from(index).unwrap_or(u32::MAX),
                op,
                after.id,
                TaskActivityAction::Updated,
                Some("tag_ids"),
                serde_json::to_string(&before.tag_ids).ok(),
                serde_json::to_string(&after.tag_ids).ok(),
                now,
            ));
        }
        tx.execute("DELETE FROM tags WHERE id = ?1", [tag_id.to_string()])
            .map_err(storage_error)?;
        Ok(MutationEffect {
            event_type: EventType::new(EventType::TAG_DELETED),
            primary: Some(ResourceRef::tag(tag_id)),
            snapshot: None,
            affected: AffectedIds {
                tag_ids: vec![tag_id],
                task_ids,
                ..AffectedIds::default()
            },
            resync: ResyncScope::BOTH,
            task_activity: activity,
            summary_subject: Some(("tag".into(), tag_id.to_string())),
            undo: None,
            mark_undone: None,
        })
    })
}

fn write_template_tags(
    tx: &rusqlite::Transaction<'_>,
    template_id: TemplateId,
    tag_names: &[TagName],
) -> Result<(), RepositoryError> {
    tx.execute(
        "DELETE FROM template_tags WHERE template_id = ?1",
        [template_id.to_string()],
    )
    .map_err(storage_error)?;
    for tag_id in resolve_tag_names(tx, tag_names)? {
        tx.execute(
            "INSERT INTO template_tags(template_id, tag_id) VALUES (?1, ?2)",
            params![template_id.to_string(), tag_id.to_string()],
        )
        .map_err(constraint_conflict)?;
    }
    Ok(())
}

pub(crate) fn create_template(
    c: &mut Connection,
    op: OperationId,
    template_id: TemplateId,
    draft: TemplateDraft,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::CreateTemplate { draft: &draft })?;
    mutate(c, op, request, now, move |tx, _| {
        if let Some(project_id) = draft.project_id {
            ensure_project_exists(tx, project_id)?;
        }
        tx.execute(
            "INSERT INTO templates(id,name,title,description,priority,project_id,recurrence_rule,sort_order,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                template_id.to_string(),
                draft.name.as_str(),
                draft.title.as_str(),
                draft.description.as_str(),
                draft.priority.map(|p| p.get()),
                draft.project_id.map(|id| id.to_string()),
                draft.recurrence_rule.as_ref().map(|r| r.as_str()),
                draft.sort_order.get(),
                now.to_string(),
                now.to_string(),
            ],
        )
        .map_err(constraint_conflict)?;
        write_template_tags(tx, template_id, &draft.tag_names)?;
        let template = load_template(tx, template_id)?;
        Ok(catalog_effect(
            EventType::TEMPLATE_CREATED,
            ResourceRef::template(template.id),
            Some(ResourceSnapshot::Template {
                template: template.clone(),
            }),
            AffectedIds {
                template_ids: vec![template.id],
                ..AffectedIds::default()
            },
            ("template", template.id.to_string()),
        ))
    })
}

pub(crate) fn patch_template(
    c: &mut Connection,
    op: OperationId,
    template_id: TemplateId,
    patch: TemplatePatch,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::PatchTemplate {
        template_id: template_id.to_string(),
        patch: &patch,
    })?;
    mutate(c, op, request, now, move |tx, _| {
        let mut template = load_template(tx, template_id)?;
        if let Some(name) = patch.name {
            template.name = name;
        }
        if let Some(title) = patch.title {
            template.title = title;
        }
        if let Some(description) = patch.description {
            template.description = description;
        }
        if let Some(priority) = patch.priority {
            template.priority = priority;
        }
        if let Some(tag_names) = patch.tag_names {
            template.tag_names = tag_names;
        }
        if let Some(project_id) = patch.project_id {
            if let Some(project_id) = project_id {
                ensure_project_exists(tx, project_id)?;
            }
            template.project_id = project_id;
        }
        if let Some(rule) = patch.recurrence_rule {
            template.recurrence_rule = rule;
        }
        if let Some(sort_order) = patch.sort_order {
            template.sort_order = sort_order;
        }
        template.updated_at = now;
        tx.execute(
            "UPDATE templates SET name=?1,title=?2,description=?3,priority=?4,project_id=?5,recurrence_rule=?6,sort_order=?7,updated_at=?8 WHERE id=?9",
            params![
                template.name.as_str(),
                template.title.as_str(),
                template.description.as_str(),
                template.priority.map(|p| p.get()),
                template.project_id.map(|id| id.to_string()),
                template.recurrence_rule.as_ref().map(|r| r.as_str()),
                template.sort_order.get(),
                template.updated_at.to_string(),
                template.id.to_string(),
            ],
        )
        .map_err(storage_error)?;
        write_template_tags(tx, template.id, &template.tag_names)?;
        let template = load_template(tx, template.id)?;
        Ok(catalog_effect(
            EventType::TEMPLATE_UPDATED,
            ResourceRef::template(template.id),
            Some(ResourceSnapshot::Template {
                template: template.clone(),
            }),
            AffectedIds {
                template_ids: vec![template.id],
                ..AffectedIds::default()
            },
            ("template", template.id.to_string()),
        ))
    })
}

pub(crate) fn delete_template(
    c: &mut Connection,
    op: OperationId,
    template_id: TemplateId,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::DeleteTemplate {
        template_id: template_id.to_string(),
    })?;
    mutate(c, op, request, now, move |tx, _| {
        let _ = load_template(tx, template_id)?;
        tx.execute(
            "DELETE FROM templates WHERE id = ?1",
            [template_id.to_string()],
        )
        .map_err(storage_error)?;
        Ok(MutationEffect {
            event_type: EventType::new(EventType::TEMPLATE_DELETED),
            primary: Some(ResourceRef::template(template_id)),
            snapshot: None,
            affected: AffectedIds {
                template_ids: vec![template_id],
                ..AffectedIds::default()
            },
            resync: ResyncScope::CATALOG,
            task_activity: Vec::new(),
            summary_subject: Some(("template".into(), template_id.to_string())),
            undo: None,
            mark_undone: None,
        })
    })
}

pub(crate) fn apply_template(
    c: &mut Connection,
    op: OperationId,
    task_id: TaskId,
    apply: TemplateApply,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::ApplyTemplate { apply: &apply })?;
    mutate(c, op, request, now, move |tx, revision| {
        let template = load_template(tx, apply.template_id)?;
        let vars: Vec<(&str, &str)> = apply
            .variables
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        let title = TaskTitle::new(Template::substitute(template.title.as_str(), &vars))
            .map_err(validation)?;
        let description =
            MarkdownText::new(Template::substitute(template.description.as_str(), &vars))
                .map_err(validation)?;
        let mut draft = template.draft_after_substitution(title, description);
        draft.tag_ids = resolve_tag_names(tx, &template.tag_names)?;
        let task = Task::from_draft(task_id, draft, now, revision).map_err(validation)?;
        validate_task_refs(tx, &task)?;
        insert_task(tx, &task)?;
        let activity = vec![field_activity(
            revision,
            0,
            op,
            task.id,
            TaskActivityAction::Created,
            Some("template_id"),
            None,
            Some(template.id.to_string()),
            now,
        )];
        let undo = undo_pair(
            &Inverse::DeleteTasks {
                task_ids: vec![task.id],
            },
            &post_from_tasks([task.clone()]),
        )?;
        Ok(MutationEffect {
            event_type: EventType::new(EventType::TEMPLATE_APPLIED),
            primary: Some(ResourceRef::task(task.id)),
            snapshot: Some(ResourceSnapshot::task(task.clone())),
            affected: AffectedIds {
                task_ids: vec![task.id],
                template_ids: vec![template.id],
                ..AffectedIds::default()
            },
            resync: ResyncScope::NONE,
            task_activity: activity,
            summary_subject: Some(("task".into(), task.id.to_string())),
            undo: Some(undo),
            mark_undone: None,
        })
    })
}

pub(crate) fn create_saved_filter(
    c: &mut Connection,
    op: OperationId,
    filter_id: SavedFilterId,
    draft: SavedFilterDraft,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::CreateSavedFilter { draft: &draft })?;
    mutate(c, op, request, now, move |tx, _| {
        let filter = SavedFilter {
            id: filter_id,
            name: draft.name,
            query: draft.query,
            color: draft.color,
            sort_order: draft.sort_order,
            created_at: now,
            updated_at: now,
        };
        tx.execute(
            "INSERT INTO saved_filters(id,name,query,color,sort_order,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                filter.id.to_string(),
                filter.name.as_str(),
                filter.query.as_str(),
                filter.color.as_ref().map(|c| c.as_str()),
                filter.sort_order.get(),
                filter.created_at.to_string(),
                filter.updated_at.to_string(),
            ],
        )
        .map_err(constraint_conflict)?;
        Ok(catalog_effect(
            EventType::SAVED_FILTER_CREATED,
            ResourceRef::saved_filter(filter.id),
            Some(ResourceSnapshot::SavedFilter {
                saved_filter: filter.clone(),
            }),
            AffectedIds {
                saved_filter_ids: vec![filter.id],
                ..AffectedIds::default()
            },
            ("saved_filter", filter.id.to_string()),
        ))
    })
}

pub(crate) fn patch_saved_filter(
    c: &mut Connection,
    op: OperationId,
    filter_id: SavedFilterId,
    patch: SavedFilterPatch,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::PatchSavedFilter {
        filter_id: filter_id.to_string(),
        patch: &patch,
    })?;
    mutate(c, op, request, now, move |tx, _| {
        let mut filter = load_saved_filter(tx, filter_id)?;
        if let Some(name) = patch.name {
            filter.name = name;
        }
        if let Some(query) = patch.query {
            filter.query = query;
        }
        if let Some(color) = patch.color {
            filter.color = color;
        }
        if let Some(sort_order) = patch.sort_order {
            filter.sort_order = sort_order;
        }
        filter.updated_at = now;
        tx.execute(
            "UPDATE saved_filters SET name=?1, query=?2, color=?3, sort_order=?4, updated_at=?5 WHERE id=?6",
            params![
                filter.name.as_str(),
                filter.query.as_str(),
                filter.color.as_ref().map(|c| c.as_str()),
                filter.sort_order.get(),
                filter.updated_at.to_string(),
                filter.id.to_string(),
            ],
        )
        .map_err(storage_error)?;
        Ok(catalog_effect(
            EventType::SAVED_FILTER_UPDATED,
            ResourceRef::saved_filter(filter.id),
            Some(ResourceSnapshot::SavedFilter {
                saved_filter: filter.clone(),
            }),
            AffectedIds {
                saved_filter_ids: vec![filter.id],
                ..AffectedIds::default()
            },
            ("saved_filter", filter.id.to_string()),
        ))
    })
}

pub(crate) fn delete_saved_filter(
    c: &mut Connection,
    op: OperationId,
    filter_id: SavedFilterId,
    now: Timestamp,
) -> Result<CommittedMutation, RepositoryError> {
    let request = canonical_json(&Req::DeleteSavedFilter {
        filter_id: filter_id.to_string(),
    })?;
    mutate(c, op, request, now, move |tx, _| {
        let _ = load_saved_filter(tx, filter_id)?;
        tx.execute(
            "DELETE FROM saved_filters WHERE id = ?1",
            [filter_id.to_string()],
        )
        .map_err(storage_error)?;
        Ok(MutationEffect {
            event_type: EventType::new(EventType::SAVED_FILTER_DELETED),
            primary: Some(ResourceRef::saved_filter(filter_id)),
            snapshot: None,
            affected: AffectedIds {
                saved_filter_ids: vec![filter_id],
                ..AffectedIds::default()
            },
            resync: ResyncScope::CATALOG,
            task_activity: Vec::new(),
            summary_subject: Some(("saved_filter".into(), filter_id.to_string())),
            undo: None,
            mark_undone: None,
        })
    })
}
