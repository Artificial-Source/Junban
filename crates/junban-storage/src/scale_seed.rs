//! Development-only Phase 2 scale fixture seeder.
//!
//! Gated behind the `scale-bench` feature so release `junban-server` artifacts
//! never include this path. Seeds write SQLite rows directly (no mutation
//! receipts) before the measured server process starts.

use std::{
    fs,
    io::{self, Write},
    path::Path,
    time::Instant,
};

use jiff::civil::Date;
use rusqlite::{Connection, Transaction, params};
use serde::Serialize;
use thiserror::Error;

use crate::{DATABASE_FILE, ensure_private_dir, migration, rows::normalize_tag_name};

/// Protocol fixture sizes for the authoritative 10_000-task run.
pub const AUTHORITATIVE_TASK_COUNT: u32 = 10_000;
pub const PROJECT_COUNT: u32 = 10;
pub const SECTIONS_PER_PROJECT: u32 = 5;
pub const TAG_COUNT: u32 = 20;
/// Near-cap trees use root + (size - 1) children so closure length equals `size`.
pub const AUTHORITATIVE_NEAR_CAP_SIZE: u32 = 500;

const FIXED_NOW: &str = "2026-07-28T12:00:00Z";
const SEARCH_HIT_TOKEN: &str = "SCALEHITTOKEN";
const SEARCH_MISS_TOKEN: &str = "ZZZNOMATCHSCALE999";

#[derive(Debug, Error)]
pub enum SeedError {
    #[error("invalid seed configuration: {0}")]
    InvalidConfig(String),
    #[error("could not prepare profile: {0}")]
    Io(#[from] io::Error),
    #[error("could not open or seed database: {0}")]
    Database(String),
}

/// Deterministic ID namespaces so the harness can rebuild the same IDs.
#[repr(u8)]
#[derive(Debug, Clone, Copy)]
enum IdKind {
    Project = 1,
    Section = 2,
    Tag = 3,
    Task = 4,
    Comment = 5,
    Template = 6,
    SavedFilter = 7,
}

/// Stable UUID string from a kind/index pair. Version/variant bits are set so
/// ordinary UUID parsers accept the value.
#[must_use]
pub fn deterministic_id(kind: u8, index: u32) -> String {
    format!("{kind:02x}000000-0000-4000-8000-{index:012x}")
}

#[must_use]
pub fn project_id(index: u32) -> String {
    deterministic_id(IdKind::Project as u8, index)
}

#[must_use]
pub fn section_id(project_index: u32, section_index: u32) -> String {
    deterministic_id(
        IdKind::Section as u8,
        project_index * SECTIONS_PER_PROJECT + section_index,
    )
}

#[must_use]
pub fn tag_id(index: u32) -> String {
    deterministic_id(IdKind::Tag as u8, index)
}

#[must_use]
pub fn task_id(index: u32) -> String {
    deterministic_id(IdKind::Task as u8, index)
}

#[must_use]
pub fn comment_id(index: u32) -> String {
    deterministic_id(IdKind::Comment as u8, index)
}

#[must_use]
pub fn template_id(index: u32) -> String {
    deterministic_id(IdKind::Template as u8, index)
}

#[must_use]
pub fn saved_filter_id(index: u32) -> String {
    deterministic_id(IdKind::SavedFilter as u8, index)
}

/// Public knobs for the seeder binary and tests.
#[derive(Debug, Clone)]
pub struct SeedConfig {
    pub task_count: u32,
    /// Civil date used for today/overdue/upcoming fixture patterns.
    pub as_of_date: Date,
}

impl SeedConfig {
    pub fn new(task_count: u32, as_of_date: Date) -> Result<Self, SeedError> {
        if task_count == 0 {
            return Err(SeedError::InvalidConfig(
                "task_count must be greater than zero".into(),
            ));
        }
        // Need room for two near-cap trees (or tiny smoke trees) plus a reorder pool.
        if task_count < 40 {
            return Err(SeedError::InvalidConfig(
                "task_count must be at least 40 so near-cap and reorder pools fit".into(),
            ));
        }
        Ok(Self {
            task_count,
            as_of_date,
        })
    }

    #[must_use]
    pub fn near_cap_size(&self) -> u32 {
        if self.task_count >= AUTHORITATIVE_TASK_COUNT {
            AUTHORITATIVE_NEAR_CAP_SIZE
        } else {
            // Quick/smoke: keep two small closures without starving the rest.
            (self.task_count / 10).clamp(10, 50)
        }
    }

    #[must_use]
    pub fn complete_tree_root_index(&self) -> u32 {
        0
    }

    #[must_use]
    pub fn delete_tree_root_index(&self) -> u32 {
        self.near_cap_size()
    }

    #[must_use]
    pub fn regular_start_index(&self) -> u32 {
        self.near_cap_size() * 2
    }

    #[must_use]
    pub fn reorder_pool_start(&self) -> u32 {
        // Final 25 slots are an exclusive sibling scope for reorder batches.
        self.task_count.saturating_sub(25)
    }

    /// Project reserved exclusively for the 25-task reorder sibling pool.
    #[must_use]
    pub fn reorder_project_index() -> u32 {
        PROJECT_COUNT - 1
    }

    /// Section reserved exclusively for the 25-task reorder sibling pool.
    #[must_use]
    pub fn reorder_section_index() -> u32 {
        SECTIONS_PER_PROJECT - 1
    }
}

/// Machine-readable summary written next to the database for the harness.
#[derive(Debug, Clone, Serialize)]
pub struct SeedManifest {
    pub protocol: &'static str,
    pub task_count: u32,
    pub as_of_date: String,
    pub seed_duration_ms: f64,
    pub project_ids: Vec<String>,
    pub section_ids: Vec<String>,
    pub tag_ids: Vec<String>,
    pub complete_tree_root_id: String,
    pub delete_tree_root_id: String,
    pub near_cap_size: u32,
    pub reorder_task_ids: Vec<String>,
    pub bulk_task_ids: Vec<String>,
    pub patch_task_ids: Vec<String>,
    pub project_view_project_id: String,
    pub project_view_section_id: String,
    pub reorder_project_id: String,
    pub reorder_section_id: String,
    pub filter_tag_id: String,
    pub filter_priority: u8,
    pub due_after: String,
    pub due_before: String,
    pub search_hit: &'static str,
    pub search_miss: &'static str,
    pub sqlite_path: String,
}

/// Seed `profile_dir` with a deterministic Phase 2 scale fixture and write
/// `scale-seed-manifest.json` beside the database.
pub fn seed_phase2_scale(
    profile_dir: impl AsRef<Path>,
    config: &SeedConfig,
) -> Result<SeedManifest, SeedError> {
    let profile_dir = profile_dir.as_ref();
    ensure_private_dir(profile_dir).map_err(SeedError::Io)?;
    let database_path = profile_dir.join(DATABASE_FILE);
    if database_path.exists() {
        return Err(SeedError::InvalidConfig(format!(
            "refusing to seed non-empty database path {}",
            database_path.display()
        )));
    }

    let started = Instant::now();
    let mut connection = open_seed_connection(&database_path)?;
    let manifest = {
        let tx = connection
            .transaction()
            .map_err(|e| SeedError::Database(e.to_string()))?;
        let built = insert_fixture(&tx, config)?;
        tx.commit()
            .map_err(|e| SeedError::Database(e.to_string()))?;
        built
    };
    // Checkpoint WAL so the subsequent server open sees a compact main DB.
    connection
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .map_err(|e| SeedError::Database(e.to_string()))?;
    drop(connection);

    let seed_duration_ms = started.elapsed().as_secs_f64() * 1000.0;
    let mut manifest = manifest;
    manifest.seed_duration_ms = seed_duration_ms;
    manifest.sqlite_path = database_path.display().to_string();

    let manifest_path = profile_dir.join("scale-seed-manifest.json");
    write_manifest(&manifest_path, &manifest)?;
    Ok(manifest)
}

fn open_seed_connection(path: &Path) -> Result<Connection, SeedError> {
    let mut connection = Connection::open(path).map_err(|e| SeedError::Database(e.to_string()))?;
    connection
        .busy_timeout(std::time::Duration::from_millis(2_500))
        .map_err(|e| SeedError::Database(e.to_string()))?;
    connection
        .pragma_update(None, "foreign_keys", true)
        .map_err(|e| SeedError::Database(e.to_string()))?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| SeedError::Database(e.to_string()))?;
    connection
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| SeedError::Database(e.to_string()))?;
    connection
        .pragma_update(None, "wal_autocheckpoint", crate::WAL_AUTOCHECKPOINT_PAGES)
        .map_err(|e| SeedError::Database(e.to_string()))?;
    connection
        .pragma_update(
            None,
            "journal_size_limit",
            crate::WAL_AUTOCHECKPOINT_PAGES * 4096,
        )
        .map_err(|e| SeedError::Database(e.to_string()))?;
    let profile_dir = path.parent().ok_or_else(|| {
        SeedError::Database(format!(
            "database path '{}' has no parent profile directory",
            path.display()
        ))
    })?;
    migration::migrate(&mut connection, profile_dir)
        .map_err(|e| SeedError::Database(e.to_string()))?;
    Ok(connection)
}

fn write_manifest(path: &Path, manifest: &SeedManifest) -> Result<(), SeedError> {
    let body =
        serde_json::to_vec_pretty(manifest).map_err(|e| SeedError::Database(e.to_string()))?;
    let mut file = fs::File::create(path)?;
    file.write_all(&body)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}

fn insert_fixture(tx: &Transaction<'_>, config: &SeedConfig) -> Result<SeedManifest, SeedError> {
    let now = FIXED_NOW;
    let as_of = config.as_of_date;
    let near_cap = config.near_cap_size();
    let complete_root = config.complete_tree_root_index();
    let delete_root = config.delete_tree_root_index();
    let regular_start = config.regular_start_index();
    let reorder_start = config.reorder_pool_start();

    if regular_start >= reorder_start {
        return Err(SeedError::InvalidConfig(
            "task_count too small for near-cap trees plus reorder pool".into(),
        ));
    }

    let mut project_ids = Vec::with_capacity(PROJECT_COUNT as usize);
    let mut section_ids = Vec::with_capacity((PROJECT_COUNT * SECTIONS_PER_PROJECT) as usize);
    for p in 0..PROJECT_COUNT {
        let id = project_id(p);
        tx.execute(
            "INSERT INTO projects(
                id, name, color, icon, parent_id, favorite, archived, view_style,
                sort_order, created_at, updated_at
             ) VALUES (?1, ?2, ?3, NULL, NULL, 0, 0, 'list', ?4, ?5, ?5)",
            params![
                id,
                format!("Scale Project {p:02}"),
                format!("#{:02X}{:02X}{:02X}", 0x20 + p, 0x60, 0xA0),
                i64::from(p),
                now,
            ],
        )
        .map_err(|e| SeedError::Database(e.to_string()))?;
        project_ids.push(id);
        for s in 0..SECTIONS_PER_PROJECT {
            let sid = section_id(p, s);
            tx.execute(
                "INSERT INTO sections(
                    id, project_id, name, collapsed, sort_order, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, 0, ?4, ?5, ?5)",
                params![
                    sid,
                    project_id(p),
                    format!("Section {p:02}.{s}"),
                    i64::from(s),
                    now,
                ],
            )
            .map_err(|e| SeedError::Database(e.to_string()))?;
            section_ids.push(sid);
        }
    }

    let mut tag_ids = Vec::with_capacity(TAG_COUNT as usize);
    for t in 0..TAG_COUNT {
        let id = tag_id(t);
        let name = format!("scale-tag-{t:02}");
        tx.execute(
            "INSERT INTO tags(id, name, name_normalized, color, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![
                id,
                name,
                normalize_tag_name(&name),
                format!("#{:02X}8040", 0x30 + t),
                now,
            ],
        )
        .map_err(|e| SeedError::Database(e.to_string()))?;
        tag_ids.push(id);
    }

    // Templates + saved filters (representative, not 1:1 with tasks).
    for i in 0..3 {
        tx.execute(
            "INSERT INTO templates(
                id, name, title, description, priority, project_id, recurrence_rule,
                sort_order, created_at, updated_at
             ) VALUES (?1, ?2, ?3, '', ?4, ?5, NULL, ?6, ?7, ?7)",
            params![
                template_id(i),
                format!("Scale Template {i}"),
                format!("Template title {i}"),
                2_i64,
                project_id(i % PROJECT_COUNT),
                i64::from(i),
                now,
            ],
        )
        .map_err(|e| SeedError::Database(e.to_string()))?;
        tx.execute(
            "INSERT INTO saved_filters(
                id, name, query, color, sort_order, created_at, updated_at
             ) VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?5)",
            params![
                saved_filter_id(i),
                format!("Scale Filter {i}"),
                format!("priority:{} tag:scale-tag-{:02}", (i % 4) + 1, i),
                i64::from(i),
                now,
            ],
        )
        .map_err(|e| SeedError::Database(e.to_string()))?;
    }

    let task_stmt = "
        INSERT INTO tasks(
            id, title, description, due_date, due_time, due_timezone, deadline,
            status, priority, dread, estimated_minutes, actual_minutes,
            project_id, section_id, parent_id, sort_order, recurrence_rule, someday,
            completed_at, created_at, updated_at, revision
        ) VALUES (
            ?1, ?2, ?3, ?4, NULL, NULL, NULL,
            ?5, ?6, ?7, ?8, NULL,
            ?9, ?10, ?11, ?12, ?13, ?14,
            ?15, ?16, ?16, 1
        )";

    // Near-cap complete tree: all pending so cascade complete hits the ceiling.
    let complete_project = &project_ids[(complete_root as usize) % project_ids.len()];
    let complete_section = &section_ids[(complete_root as usize) % section_ids.len()];
    insert_tree(
        tx,
        task_stmt,
        now,
        &TreeSpec {
            root_index: complete_root,
            size: near_cap,
            label: "complete-tree",
            project: complete_project,
            section: complete_section,
            as_of,
        },
    )?;
    // Near-cap delete tree: pending + a comment/relation for closure undo coverage.
    let delete_project = &project_ids[(delete_root as usize) % project_ids.len()];
    let delete_section = &section_ids[(delete_root as usize) % section_ids.len()];
    insert_tree(
        tx,
        task_stmt,
        now,
        &TreeSpec {
            root_index: delete_root,
            size: near_cap,
            label: "delete-tree",
            project: delete_project,
            section: delete_section,
            as_of,
        },
    )?;
    tx.execute(
        "INSERT INTO comments(id, task_id, content, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)",
        params![
            comment_id(0),
            task_id(delete_root),
            "scale delete-tree root comment",
            now,
        ],
    )
    .map_err(|e| SeedError::Database(e.to_string()))?;
    if near_cap > 1 {
        tx.execute(
            "INSERT INTO task_relations(from_task_id, to_task_id, kind)
             VALUES (?1, ?2, 'blocks')",
            params![task_id(delete_root), task_id(delete_root + 1)],
        )
        .map_err(|e| SeedError::Database(e.to_string()))?;
    }

    // Regular + exclusive reorder sibling pool (exactly 25 roots in one scope).
    let reorder_project = project_id(SeedConfig::reorder_project_index());
    let reorder_section = section_id(
        SeedConfig::reorder_project_index(),
        SeedConfig::reorder_section_index(),
    );
    let mut comment_seq = 1_u32;
    for index in regular_start..config.task_count {
        let in_reorder_pool = index >= reorder_start;
        let (project, section, parent, sort_order) = if in_reorder_pool {
            (
                Some(reorder_project.clone()),
                Some(reorder_section.clone()),
                None,
                i64::from(index - reorder_start),
            )
        } else {
            place_regular_task(index, regular_start, &project_ids, &section_ids)
        };

        let pattern = index % 20;
        let (status, completed_at, someday, due_date, priority, title_extra) = match pattern {
            0 => (
                "completed",
                Some(now.to_owned()),
                0_i64,
                Some(shift_date(as_of, -3)),
                Some(1_i64),
                "",
            ),
            1 => (
                "cancelled",
                None,
                0,
                Some(shift_date(as_of, -1)),
                Some(4),
                "",
            ),
            2 => ("pending", None, 1, None, Some(3), ""),
            3 => ("pending", None, 0, Some(as_of.to_string()), Some(1), ""),
            4 => ("pending", None, 0, Some(shift_date(as_of, 1)), Some(2), ""),
            5 => ("pending", None, 0, Some(shift_date(as_of, -2)), Some(2), ""),
            6 => ("pending", None, 0, Some(shift_date(as_of, 7)), Some(3), ""),
            7 if index % 200 == 7 => (
                "pending",
                None,
                0,
                Some(as_of.to_string()),
                Some(1),
                SEARCH_HIT_TOKEN,
            ),
            _ => (
                "pending",
                None,
                0,
                if pattern % 2 == 0 {
                    Some(shift_date(as_of, i32::try_from(pattern).unwrap_or(0) - 5))
                } else {
                    None
                },
                Some(i64::from((index % 4) + 1)),
                "",
            ),
        };

        let title = if title_extra.is_empty() {
            format!("scale-task-{index:05}")
        } else {
            format!("scale-task-{index:05}-{title_extra}")
        };
        let description = if index % 17 == 0 {
            format!("Description body for scale task {index} with {SEARCH_HIT_TOKEN} marker")
        } else {
            String::new()
        };
        let recurrence = if index % 111 == 0 {
            Some("weekly")
        } else {
            None
        };
        let dread = if index % 13 == 0 {
            Some(i64::from((index % 5) + 1))
        } else {
            None
        };
        let estimated = if index % 19 == 0 {
            Some(i64::from(15 + (index % 120)))
        } else {
            None
        };

        tx.execute(
            task_stmt,
            params![
                task_id(index),
                title,
                description,
                due_date,
                status,
                priority,
                dread,
                estimated,
                project,
                section,
                parent,
                sort_order,
                recurrence,
                someday,
                completed_at,
                now,
            ],
        )
        .map_err(|e| SeedError::Database(e.to_string()))?;

        // ~15% of tasks get one tag; a smaller set gets two for AND filters.
        if index % 7 == 0 {
            let t0 = tag_id(index % TAG_COUNT);
            insert_task_tag(tx, &task_id(index), &t0)?;
            if index % 21 == 0 {
                let t1 = tag_id((index + 3) % TAG_COUNT);
                if t1 != t0 {
                    insert_task_tag(tx, &task_id(index), &t1)?;
                }
            }
        }

        // Sparse comments on regular tasks.
        if index % 97 == 0 {
            tx.execute(
                "INSERT INTO comments(id, task_id, content, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)",
                params![
                    comment_id(comment_seq),
                    task_id(index),
                    format!("comment on task {index}"),
                    now,
                ],
            )
            .map_err(|e| SeedError::Database(e.to_string()))?;
            comment_seq += 1;
        }

        // Sparse relations between consecutive regular pending roots.
        if index > regular_start && index % 131 == 0 && parent.is_none() {
            let _ = tx.execute(
                "INSERT INTO task_relations(from_task_id, to_task_id, kind)
                 VALUES (?1, ?2, 'blocks')",
                params![task_id(index - 1), task_id(index)],
            );
        }
    }

    // 5% subtasks among regular non-reorder tasks (parent = previous root-ish task).
    // Already assigned via place_regular_task when index % 20 == 11.

    let reorder_task_ids: Vec<String> = (reorder_start..config.task_count).map(task_id).collect();
    debug_assert_eq!(reorder_task_ids.len(), 25);
    let bulk_task_ids: Vec<String> = (regular_start..reorder_start)
        .filter(|i| i % 20 != 0 && i % 20 != 1) // skip completed/cancelled patterns
        .take(25)
        .map(task_id)
        .collect();
    // Enough IDs for 50 patches + 50 complete pairs in the authoritative run.
    let patch_task_ids: Vec<String> = (regular_start..reorder_start)
        .filter(|i| i % 20 == 3 || i % 20 == 4 || i % 20 == 8 || i % 20 == 9 || i % 20 == 10)
        .take(120)
        .map(task_id)
        .collect();

    let due_after = shift_date(as_of, -7);
    let due_before = shift_date(as_of, 7);

    Ok(SeedManifest {
        protocol: "junban-phase2-scale-v1",
        task_count: config.task_count,
        as_of_date: as_of.to_string(),
        seed_duration_ms: 0.0,
        project_ids,
        section_ids,
        tag_ids: tag_ids.clone(),
        complete_tree_root_id: task_id(complete_root),
        delete_tree_root_id: task_id(delete_root),
        near_cap_size: near_cap,
        reorder_task_ids,
        bulk_task_ids,
        patch_task_ids,
        project_view_project_id: project_id(1),
        project_view_section_id: section_id(1, 0),
        reorder_project_id: reorder_project,
        reorder_section_id: reorder_section,
        filter_tag_id: tag_id(0),
        filter_priority: 1,
        due_after,
        due_before,
        search_hit: SEARCH_HIT_TOKEN,
        search_miss: SEARCH_MISS_TOKEN,
        sqlite_path: String::new(),
    })
}

struct TreeSpec<'a> {
    root_index: u32,
    size: u32,
    label: &'a str,
    project: &'a str,
    section: &'a str,
    as_of: Date,
}

fn insert_tree(
    tx: &Transaction<'_>,
    task_stmt: &str,
    now: &str,
    spec: &TreeSpec<'_>,
) -> Result<(), SeedError> {
    let project = spec.project;
    let section = spec.section;
    let root_index = spec.root_index;
    let size = spec.size;
    let label = spec.label;
    let as_of = spec.as_of;
    let root = task_id(root_index);
    tx.execute(
        task_stmt,
        params![
            root,
            format!("scale-{label}-root"),
            format!("{label} root"),
            as_of.to_string(),
            "pending",
            1_i64,
            None::<i64>,
            None::<i64>,
            project,
            section,
            None::<String>,
            0_i64,
            None::<String>,
            0_i64,
            None::<String>,
            now,
        ],
    )
    .map_err(|e| SeedError::Database(e.to_string()))?;

    for offset in 1..size {
        let index = root_index + offset;
        tx.execute(
            task_stmt,
            params![
                task_id(index),
                format!("scale-{label}-child-{offset:04}"),
                "",
                as_of.to_string(),
                "pending",
                2_i64,
                None::<i64>,
                None::<i64>,
                project,
                section,
                root.clone(),
                i64::from(offset),
                None::<String>,
                0_i64,
                None::<String>,
                now,
            ],
        )
        .map_err(|e| SeedError::Database(e.to_string()))?;
    }
    Ok(())
}

fn place_regular_task(
    index: u32,
    regular_start: u32,
    project_ids: &[String],
    section_ids: &[String],
) -> (Option<String>, Option<String>, Option<String>, i64) {
    let local = index - regular_start;
    // ~10% inbox (no project).
    if local.is_multiple_of(10) {
        return (None, None, None, i64::from(local));
    }
    // Keep the exclusive reorder scope empty outside the dedicated pool.
    let usable_projects = PROJECT_COUNT - 1;
    let usable_sections = SECTIONS_PER_PROJECT; // all sections on non-reorder projects
    let project_index = local % usable_projects;
    let section_index = (local / usable_projects) % usable_sections;
    // Never place regular tasks into the reorder-only section of the last project.
    let project = project_ids[project_index as usize].clone();
    let section =
        section_ids[(project_index * SECTIONS_PER_PROJECT + section_index) as usize].clone();

    // About 5% of tasks become subtasks: attach every 20th regular task to the
    // previous task when that previous task is a root in the same placement.
    if local % 20 == 11 && local > 0 {
        let parent_index = index - 1;
        return (
            Some(project),
            Some(section),
            Some(task_id(parent_index)),
            i64::from(local),
        );
    }
    (Some(project), Some(section), None, i64::from(local))
}

fn insert_task_tag(tx: &Transaction<'_>, task: &str, tag: &str) -> Result<(), SeedError> {
    tx.execute(
        "INSERT INTO task_tags(task_id, tag_id) VALUES (?1, ?2)",
        params![task, tag],
    )
    .map_err(|e| SeedError::Database(e.to_string()))?;
    Ok(())
}

fn shift_date(base: Date, days: i32) -> String {
    use jiff::ToSpan;
    match base.checked_add(days.days()) {
        Ok(date) => date.to_string(),
        Err(_) => base.to_string(),
    }
}

/// Count tasks in an already-seeded profile database (tests / harness checks).
pub fn count_tasks(profile_dir: impl AsRef<Path>) -> Result<u32, SeedError> {
    let path = profile_dir.as_ref().join(DATABASE_FILE);
    let connection = Connection::open(path).map_err(|e| SeedError::Database(e.to_string()))?;
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))
        .map_err(|e| SeedError::Database(e.to_string()))?;
    u32::try_from(count).map_err(|e| SeedError::Database(e.to_string()))
}

/// Resolve the default civil "today" for seeding from the host clock.
pub fn host_as_of_date() -> Result<Date, SeedError> {
    Ok(jiff::Zoned::now().date())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_profile() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("junban-scale-seed-{nanos}"));
        let _ = fs::remove_dir_all(&path);
        path
    }

    #[test]
    fn deterministic_ids_are_stable() {
        assert_eq!(task_id(42), "04000000-0000-4000-8000-00000000002a");
        assert_eq!(project_id(0), "01000000-0000-4000-8000-000000000000");
        assert_eq!(section_id(1, 2), section_id(1, 2));
        assert_ne!(section_id(1, 2), section_id(1, 3));
    }

    #[test]
    fn seed_config_rejects_tiny_counts() {
        let date = "2026-07-28".parse::<Date>().unwrap();
        assert!(SeedConfig::new(0, date).is_err());
        assert!(SeedConfig::new(10, date).is_err());
        assert!(SeedConfig::new(40, date).is_ok());
    }

    #[test]
    fn seeder_is_deterministic_and_counts_tasks() {
        let date = "2026-07-28".parse::<Date>().unwrap();
        let config = SeedConfig::new(80, date).unwrap();
        let a = temp_profile();
        let b = temp_profile();
        let ma = seed_phase2_scale(&a, &config).unwrap();
        let mb = seed_phase2_scale(&b, &config).unwrap();
        assert_eq!(ma.task_count, 80);
        assert_eq!(count_tasks(&a).unwrap(), 80);
        assert_eq!(count_tasks(&b).unwrap(), 80);
        assert_eq!(ma.complete_tree_root_id, mb.complete_tree_root_id);
        assert_eq!(ma.delete_tree_root_id, mb.delete_tree_root_id);
        assert_eq!(ma.reorder_task_ids, mb.reorder_task_ids);
        assert_eq!(ma.project_ids.len(), PROJECT_COUNT as usize);
        assert_eq!(
            ma.section_ids.len(),
            (PROJECT_COUNT * SECTIONS_PER_PROJECT) as usize
        );
        assert_eq!(ma.near_cap_size, config.near_cap_size());
        // Manifest is written for the harness.
        assert!(a.join("scale-seed-manifest.json").is_file());
        // Second seed into the same profile must refuse.
        assert!(seed_phase2_scale(&a, &config).is_err());
        let _ = fs::remove_dir_all(&a);
        let _ = fs::remove_dir_all(&b);
    }

    #[test]
    fn authoritative_layout_fits_near_cap_trees() {
        let date = "2026-07-28".parse::<Date>().unwrap();
        let config = SeedConfig::new(AUTHORITATIVE_TASK_COUNT, date).unwrap();
        assert_eq!(config.near_cap_size(), AUTHORITATIVE_NEAR_CAP_SIZE);
        assert_eq!(config.regular_start_index(), 1_000);
        assert!(config.reorder_pool_start() > config.regular_start_index());
    }
}
